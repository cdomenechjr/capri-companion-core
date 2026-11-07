import {chromium,BrowserContext,Page,ElementHandle} from 'playwright-core';
import {existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {CapriError,NoSideEffectError,NoSideEffectPause,publicUrl} from './policy';
import {TaskPaused} from '../agency';

const sensitive=/\b(?:send|post|publish|purchase|buy|pay|checkout|delete|remove|transfer|subscribe|submit order|confirm order)\b/i;
export class CapriBrowser {
 context?:BrowserContext;pages=new Map<number,Page>();private next=1;private refs=new Map<string,ElementHandle>();private sequence=0;private refTab=0;
 constructor(private directory:string,private approve:(summary:string,details:any,signal:AbortSignal)=>Promise<boolean>,private filePath:(input:string,write:boolean)=>Promise<string>,private testOnly=false){}
 available(){return process.platform==='win32'&&[path.join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),path.join(process.env.ProgramFiles||'C:\\Program Files','Microsoft/Edge/Application/msedge.exe')].some(existsSync);}
 async open(){if(this.context)return this.context;await mkdir(this.directory,{recursive:true});const context=await chromium.launchPersistentContext(this.directory,{channel:'msedge',headless:false,acceptDownloads:true,viewport:null,args:['--no-first-run']});this.context=context;context.setDefaultTimeout(10000);context.on('page',p=>this.register(p));context.on('close',()=>{if(this.context!==context)return;this.context=undefined;this.pages.clear();this.invalidateRefs();});for(const p of context.pages())this.register(p);
  await context.route('**/*',async route=>{try{const u=new URL(route.request().url());if(this.testOnly&&u.hostname==='127.0.0.1'){await route.continue();return;}await publicUrl(u.href);await route.continue();}catch{await route.abort();}});return context;}
 // Navigation invalidates the observation even on reload or a same-URL commit.
 private invalidateRefs(id?:number){if(id!==undefined&&this.refTab!==id)return;this.refs.clear();this.refTab=0;++this.sequence;}
 private register(p:Page){if([...this.pages.values()].includes(p))return;const id=this.next++;this.pages.set(id,p);p.on('close',()=>{this.pages.delete(id);this.invalidateRefs(id);});p.on('framenavigated',frame=>{if(frame===p.mainFrame())this.invalidateRefs(id);});}
 private reference(id:number,ref:string,page:Page,expected?:ElementHandle){if(this.pages.get(id)!==page)throw new CapriError('Tab changed. List tabs and inspect the target again.');if(this.refTab!==id)throw new CapriError('Element reference belongs to a different or changed tab. Inspect this tab again.');const el=this.refs.get(ref);if(!el||expected&&el!==expected)throw new CapriError('Stale element reference. Inspect the tab again.');return el;}
 // Publish refs only when the entire inspection still belongs to this epoch.
 async snapshot(id:number){const page=this.pages.get(id);if(!page)throw new CapriError('Tab closed. List tabs again.');this.invalidateRefs();this.refTab=id;const epoch=this.sequence;const refs=new Map<string,ElementHandle>();const elements:any[]=[];
  const assertFresh=()=>{if(this.sequence!==epoch||this.refTab!==id||this.pages.get(id)!==page)throw new CapriError('Page changed during inspection. Inspect the tab again.');};
  try{for(const handle of (await page.$$('a,button,input:not([type=password]):not([type=hidden]),textarea,select,[role=button]')).slice(0,180)){const info=await handle.evaluate((el:any)=>({tag:el.tagName,role:el.getAttribute('role'),name:(el.getAttribute('aria-label')||el.innerText||el.getAttribute('placeholder')||el.getAttribute('name')||'').slice(0,180),type:el.getAttribute('type'),visible:!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length)}));if(info.visible){const ref=epoch+':'+elements.length;refs.set(ref,handle);elements.push({ref,...info});}}
   const text=await page.locator('body').innerText().catch(()=>'');const title=await page.title();assertFresh();this.refs=refs;return {tabId:id,url:page.url(),title,text:text.slice(0,18000),elements,untrusted:true};
  }catch(e){assertFresh();this.invalidateRefs(id);throw e;}}
 async run(args:any,signal:AbortSignal){signal.throwIfAborted();await this.open();const abort=()=>{void this.close();};let dispatched=false;signal.addEventListener('abort',abort,{once:true});try{
  signal.throwIfAborted();if(!['tabs','navigate','newTab','inspect','close','back','scroll','fill','select','upload','click','download'].includes(args.action))throw new NoSideEffectError('Unsupported browser operation.');
  if(args.action==='tabs')return {tabs:await Promise.all([...this.pages].map(async([id,p])=>({id,title:await p.title(),url:p.url()})))};
  if(args.action==='navigate'||args.action==='newTab'){const u=new URL(args.url);if(!(this.testOnly&&u.hostname==='127.0.0.1'))await publicUrl(u.href);signal.throwIfAborted();dispatched=true;const page=args.action==='newTab'?await this.context!.newPage():this.pages.get(args.tabId)||[...this.pages.values()][0]||await this.context!.newPage();signal.throwIfAborted();this.invalidateRefs([...this.pages].find(([,p])=>p===page)?.[0]);await page.goto(u.href,{waitUntil:'domcontentloaded',timeout:30000});signal.throwIfAborted();return await this.snapshot([...this.pages].find(([,p])=>p===page)![0]);}
  const page=this.pages.get(args.tabId);if(!page)throw new CapriError('Choose an open tab. List tabs and inspect the target again.');await page.bringToFront();signal.throwIfAborted();
  if(args.action==='inspect')return await this.snapshot(args.tabId);
  if(args.action==='close'){signal.throwIfAborted();this.invalidateRefs(args.tabId);dispatched=true;await page.close();return {closed:true};}
  if(args.action==='back'){signal.throwIfAborted();this.invalidateRefs(args.tabId);dispatched=true;await page.goBack({waitUntil:'domcontentloaded'});}
  else if(args.action==='scroll'){signal.throwIfAborted();dispatched=true;await page.mouse.wheel(0,Math.max(-3000,Math.min(3000,Number(args.amount)||600)));}
  else {const el=this.reference(args.tabId,args.ref,page);const beforeInput=()=>{signal.throwIfAborted();this.reference(args.tabId,args.ref,page,el);};const detail=await el.evaluate((e:any)=>({name:e.innerText||e.getAttribute('aria-label')||'',type:e.getAttribute('type'),tag:e.tagName,connected:e.isConnected})).catch(()=>{beforeInput();throw new CapriError('Element inspection failed. Inspect the tab again.');});beforeInput();if(detail.connected===false)throw new CapriError('Stale element reference. Inspect the tab again.');if(detail.type==='password')throw new CapriError('Enter passwords manually in the browser.');
   if(args.action==='fill'){if(detail.type==='file')throw new CapriError('Use upload for file inputs.');beforeInput();dispatched=true;await el.fill(String(args.text||''));}
   else if(args.action==='select'){beforeInput();dispatched=true;await el.selectOption(String(args.text));}
   else if(args.action==='upload'){const input=await this.filePath(args.path,false);if(!await this.approve('Upload this file to the selected website?',{path:input,url:page.url()},signal))throw new CapriError('Upload declined.');beforeInput();dispatched=true;await el.setInputFiles(input);}
   else if(args.action==='click'||args.action==='download'){if(sensitive.test(detail.name)&&!await this.approve('Confirm this website action?',{url:page.url(),control:detail.name},signal))throw new CapriError('Website action declined.');if(args.action==='download'){const destination=await this.filePath(args.path,true);if(existsSync(destination)&&!await this.approve('Replace this downloaded file?',{path:destination,url:page.url()},signal))throw new CapriError('Download replacement declined.');beforeInput();dispatched=true;const [download]=await Promise.all([page.waitForEvent('download',{timeout:30000}),el.click()]);signal.throwIfAborted();await download.saveAs(destination);return {path:destination,verified:!await download.failure()};}beforeInput();dispatched=true;await el.click();}
   else throw new CapriError('Unsupported browser operation.');}
  signal.throwIfAborted();return await this.snapshot(args.tabId);
 }catch(e:any){
  // Only this invocation's validation/approval phase establishes provenance.
  // snapshot() and the same helpers also run after input: never brand them globally.
  if(signal.aborted){abort();throw e;}if(dispatched)throw e;
  if(e instanceof TaskPaused)throw new NoSideEffectPause(e.message);
  throw new NoSideEffectError(e?.message||'Browser validation failed.',e?.status||400);
 }finally{signal.removeEventListener('abort',abort);}}
 async close(){const context=this.context;this.context=undefined;this.pages.clear();this.invalidateRefs();await context?.close().catch(()=>{});}
}
