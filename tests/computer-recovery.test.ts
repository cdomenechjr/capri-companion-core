import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {CapriBrowser} from '../src/server/browser';
import {HostTools} from '../src/server/host-agency';
import {TaskAccess} from '../src/server/access';
import {NoSideEffectError,NoSideEffectPause} from '../src/server/policy';
import {defaults} from '../src/shared';
import {Store} from '../src/server/store';

// Exercise real browser/host guards with in-memory transports only. These fakes
// never launch a browser, inspect the OS, open a profile, or contact a provider.
class Element {
 name='Continue';connected=true;effects=0;onEvaluate?:()=>Promise<void>;
 async evaluate(fn:any){await this.onEvaluate?.();return fn({tagName:'BUTTON',innerText:this.name,isConnected:this.connected,offsetWidth:20,offsetHeight:20,getClientRects:()=>[{}],getAttribute:()=>null});}
 async click(){this.effects++;}
 async fill(){this.effects++;}
 async selectOption(){this.effects++;}
 async setInputFiles(){this.effects++;}
}
class Page extends EventEmitter {
 element=new Element();frame={};currentUrl='http://127.0.0.1/fixture';navigations=0;fronts=0;saves=0;
 onFront?:()=>Promise<void>;onTitle?:()=>Promise<void>;onDownload?:()=>Promise<void>;
 mainFrame(){return this.frame;}
 url(){return this.currentUrl;}
 async title(){await this.onTitle?.();return 'Fake page';}
 async $$(){return [this.element];}
 locator(){return {innerText:async()=>this.element.effects?'Saved':'Ready'};}
 async bringToFront(){this.fronts++;await this.onFront?.();}
 navigate(url=this.currentUrl){this.currentUrl=url;this.emit('framenavigated',this.frame);}
 async goto(url:string){this.navigations++;this.navigate(url);}
 async close(){this.emit('close');}
 async waitForEvent(){await this.onDownload?.();return {saveAs:async()=>{this.saves++;},failure:async()=>null};}
}
function attach(browser:CapriBrowser){
 const page=new Page();const other=new Page();
 // Registration is the production event boundary; fake only Playwright objects.
 const register=(p:Page)=>(browser as any).register(p);
 register(page);register(other);
 const context={close:async()=>{page.emit('close');other.emit('close');},newPage:async()=>{const p=new Page();register(p);return p;}};
 browser.context=context as any;
 return {browser,page,other,context};
}
function transport(approve=async()=>true,filePath=async(input:string)=>input){return attach(new CapriBrowser('unused-fake-browser',approve,filePath,true));}
const signal=()=>new AbortController().signal;
async function inspect(b:CapriBrowser,id=1){const result=await b.run({action:'inspect',tabId:id},signal());assert.ok('elements' in result);return result;}
async function click(b:CapriBrowser,ref:string,id=1){const result=await b.run({action:'click',tabId:id,ref},signal());assert.ok('elements' in result);return result;}
function inspectError(e:unknown){assert.ok(e instanceof NoSideEffectError);assert.match(e.message,/inspect.*again/i);return true;}

for(const navigation of ['new document','reload','same document'] as const)test('browser rejects refs after '+navigation+' and recovers with fresh inspection',async()=>{
 const {browser,page}=transport();
 try{
  const old=(await inspect(browser)).elements[0].ref;
  page.navigate(navigation==='new document'?'http://127.0.0.1/next':navigation==='same document'?page.url()+'#section':page.url());
  // Keep the old handle connected to prove rejection comes from the observation
  // boundary, including reloads and same-document navigation with live handles.
  await assert.rejects(click(browser,old),inspectError);assert.equal(page.element.effects,0);
  const fresh=(await inspect(browser)).elements[0].ref;assert.notEqual(fresh,old);
  await assert.rejects(click(browser,old),inspectError);
  assert.equal((await click(browser,fresh)).text,'Saved');assert.equal(page.element.effects,1);
 }finally{await browser.close();}
});

for(const action of ['click','upload','download'] as const)test('browser '+action+' rechecks refs after approval navigation',async()=>{
 let page!:Page;const f=transport(async()=>{page.navigate();return true;});page=f.page;page.element.name='Delete';
 try{
  const ref=(await inspect(f.browser)).elements[0].ref;
  await assert.rejects(f.browser.run({action,tabId:1,ref,path:path.join(os.tmpdir(),'capri-unused-download.tmp')},signal()),inspectError);
  assert.equal(page.element.effects,0);assert.equal(page.saves,0);
 }finally{await f.browser.close();}
});

test('browser rechecks refs after asynchronous upload path validation',async()=>{
 let page!:Page;const f=transport(async()=>true,async input=>{page.navigate();return input;});page=f.page;
 try{const ref=(await inspect(f.browser)).elements[0].ref;await assert.rejects(f.browser.run({action:'upload',tabId:1,ref,path:'fake.txt'},signal()),inspectError);assert.equal(page.element.effects,0);}
 finally{await f.browser.close();}
});

for(const close of ['external','tool'] as const)test(close+' tab closure invalidates refs while another tab remains usable',async()=>{
 const {browser,page}=transport();
 try{
  const old=(await inspect(browser)).elements[0].ref;
  if(close==='external')await page.close();else assert.deepEqual(await browser.run({action:'close',tabId:1},signal()),{closed:true});
  assert.equal(browser.pages.has(1),false);assert.equal((browser as any).refs.size,0);
  await assert.rejects(click(browser,old),inspectError);assert.equal(page.element.effects,0);
  const fresh=(await inspect(browser,2)).elements[0].ref;
  assert.equal((await click(browser,fresh,2)).text,'Saved');
 }finally{await browser.close();}
});

test('closing an unrelated tab preserves the inspected target',async()=>{
 const {browser,other}=transport();
 try{const ref=(await inspect(browser)).elements[0].ref;await other.close();assert.equal((await click(browser,ref)).text,'Saved');}
 finally{await browser.close();}
});

test('navigation during inspection cannot publish mixed-page refs',async()=>{
 const {browser,page}=transport();
 try{
  page.onTitle=async()=>{page.onTitle=undefined;page.navigate();};
  await assert.rejects(inspect(browser),inspectError);assert.equal((browser as any).refs.size,0);
  const ref=(await inspect(browser)).elements[0].ref;
  assert.equal((await click(browser,ref)).text,'Saved');assert.equal(page.element.effects,1);
 }finally{await browser.close();}
});

test('detached browser elements give inspection guidance before input',async()=>{
 const {browser,page}=transport();
 try{const ref=(await inspect(browser)).elements[0].ref;page.element.connected=false;await assert.rejects(click(browser,ref),inspectError);assert.equal(page.element.effects,0);}
 finally{await browser.close();}
});

test('navigation destroying element evaluation still returns inspection guidance',async()=>{
 const {browser,page}=transport();
 try{
  const ref=(await inspect(browser)).elements[0].ref;
  page.element.onEvaluate=async()=>{page.navigate();throw Error('Execution context destroyed');};
  await assert.rejects(click(browser,ref),inspectError);assert.equal(page.element.effects,0);
  page.element.onEvaluate=undefined;
  assert.equal((await click(browser,(await inspect(browser)).elements[0].ref)).text,'Saved');
 }finally{await browser.close();}
});

test('cancellation while opening the browser cannot focus or submit afterward',async()=>{
 const {browser,page,context}=transport();const controller=new AbortController();
 browser.open=async()=>{controller.abort();return context as any;};
 try{await assert.rejects(browser.run({action:'close',tabId:1},controller.signal),{name:'AbortError'});assert.equal(page.fronts,0);assert.equal(browser.context,undefined);}
 finally{await browser.close();}
});

test('cancellation during tab creation prevents subsequent navigation',async()=>{
 const {browser,context}=transport();const controller=new AbortController();const created=new Page();
 context.newPage=async()=>{controller.abort();return created;};
 try{await assert.rejects(browser.run({action:'newTab',url:'http://127.0.0.1/next'},controller.signal),{name:'AbortError'});assert.equal(created.navigations,0);}
 finally{await browser.close();}
});

for(const action of ['click','fill','select','upload','download'] as const)test('browser '+action+' never submits after cancellation in preflight',async()=>{
 const controller=new AbortController();const {browser,page}=transport();
 try{
  const ref=(await inspect(browser)).elements[0].ref;
  page.element.onEvaluate=async()=>{controller.abort();};
  await assert.rejects(browser.run({action,tabId:1,ref,text:'draft',path:'fake.txt'},controller.signal),{name:'AbortError'});
  assert.equal(page.element.effects,0);assert.equal(page.saves,0);
 }finally{await browser.close();}
});

test('cancellation after download dispatch prevents saving and retains uncertain provenance',async()=>{
 const controller=new AbortController();const {browser,page}=transport();
 try{
  const ref=(await inspect(browser)).elements[0].ref;page.onDownload=async()=>{await Promise.resolve();controller.abort();};
  await assert.rejects(browser.run({action:'download',tabId:1,ref,path:'fake.txt'},controller.signal),e=>{assert.ok(!(e instanceof NoSideEffectError));return true;});
  assert.equal(page.element.effects,1);assert.equal(page.saves,0);
 }finally{await browser.close();}
});

function hostFixture(mode:'full'|'scoped'='full',approve=async()=>true){
 let processId=22,inputs=0,onInspect:(()=>void)|undefined;
 const host=new HostTools({file:path.join(os.tmpdir(),'capri-unused-host','profile')} as Store,async()=>({...defaults,roots:[os.tmpdir()]}),approve,async(action,args)=>{
  if(action==='inspect'){onInspect?.();return {processId,lastInputTick:1,elements:[{id:'continue',name:'Continue'}]};}
  if(action==='activity')return {lastInputTick:1};
  assert.equal(args.expectedProcessId,processId);inputs++;return {performed:true};
 },{access:new TaskAccess(mode)});
 return {host,get inputs(){return inputs;},set processId(value:number){processId=value;},set onInspect(value:(()=>void)|undefined){onInspect=value;}};
}

for(const mode of ['scoped','full'] as const)test(mode+' desktop grants reject changed window owners and permit fresh targets',async()=>{
 const f=hostFixture(mode);const {host}=f;
 try{
  host.begin('task','Use the fake window');await host.run('inspect_desktop',{windowId:3},signal(),'task');f.processId=23;
  await assert.rejects(host.run('desktop_input',{windowId:3,action:'invoke',elementId:'continue'},signal(),'task'),inspectError);assert.equal(f.inputs,0);
  await host.run('inspect_desktop',{windowId:3},signal(),'task');
  await assert.rejects(host.run('desktop_input',{windowId:3,action:'invoke',elementId:'old'},signal(),'task'),inspectError);
  await host.run('desktop_input',{windowId:3,action:'invoke',elementId:'continue'},signal(),'task');assert.equal(f.inputs,1);
 }finally{host.close();}
});

for(const taskId of [undefined,'task'])test('desktop cancellation after inspection blocks dispatch '+(taskId?'with task grant':'without task grant'),async()=>{
 const f=hostFixture();const controller=new AbortController();
 try{
  if(taskId){f.host.begin(taskId,'Use the fake window');await f.host.run('inspect_desktop',{windowId:3},signal(),taskId);}
  f.onInspect=()=>controller.abort();
  await assert.rejects(f.host.run('desktop_input',{windowId:3,action:'invoke',elementId:'continue'},controller.signal,taskId),{name:'AbortError'});assert.equal(f.inputs,0);
 }finally{f.host.close();}
});

for(const mode of ['scoped','full'] as const)test(mode+' browser grants revoked during website review prevent dispatch',async()=>{
 let host!:HostTools,revoking=false;const f=hostFixture(mode,async()=>{if(revoking)host.access.revoke('task');return true;});host=f.host;
 const {browser,page}=attach(host.browser);
 try{
  host.begin('task','Use the fake browser');
  const ref=(await host.run('browser_action',{action:'inspect',tabId:1},signal(),'task')).elements[0].ref;
  revoking=true;page.element.name='Delete';
  await assert.rejects(host.run('browser_action',{action:'click',tabId:1,ref},signal(),'task'),NoSideEffectPause);assert.equal(page.element.effects,0);
  host.begin('task','Resume');revoking=false;
  const fresh=(await host.run('browser_action',{action:'inspect',tabId:1},signal(),'task')).elements[0].ref;
  await host.run('browser_action',{action:'click',tabId:1,ref:fresh},signal(),'task');assert.equal(page.element.effects,1);
 }finally{host.close();await browser.close();}
});

test('browser task revocation during initial scoped review prevents transport dispatch',async()=>{
 let host!:HostTools;const f=hostFixture('scoped',async()=>{host.access.revoke('task');return true;});host=f.host;let dispatches=0;
 host.browser.run=async()=>{dispatches++;return {} as any;};
 try{host.begin('task','Use the fake browser');await assert.rejects(host.run('browser_action',{action:'inspect',tabId:1},signal(),'task'),NoSideEffectPause);assert.equal(dispatches,0);}
 finally{host.close();}
});
