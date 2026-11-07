import {readFile,stat,realpath} from 'node:fs/promises';
import {openSync,closeSync,fstatSync,readSync,writeSync,ftruncateSync,fsyncSync,lstatSync,realpathSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from './store';
import {Settings} from '../shared';
import {allowedPath,NoSideEffectError,NoSideEffectPause} from './policy';
import {TaskAccess,routineCommand} from './access';
import {TaskPaused} from '../agency';
import {CapriBrowser} from './browser';
import {createArtifact} from './artifacts';
import {GameTools,discoverGames} from './games';
import {capabilities} from './capabilities';
import {commandProcess} from './commands';
import {LegacyHostTools,Approval,Native} from './host-legacy';
import {observeSkillProof,observeFileWrite,observeFileWriteEffect,registerSkillFileReader,registerSkillFileAbsenceReader,readSkillFile,readSkillFileAbsence,currentSkillDispatch,skillCopyTargets,skillHashTarget,skillFileFollowup,assertSkillDispatch,type FileWriteReceipt} from '../extensions/skill-verification';
type Options={directory?:string;access?:TaskAccess;onProgress?:(event:any)=>void;workspaceRoots?:(taskId:string)=>readonly string[];
 /** Trusted test transport; never supplied through tool arguments or settings. */
 command?:typeof commandProcess};
export class HostTools {
 access:TaskAccess;browser:CapriBrowser;games:GameTools;private tail:Promise<any>=Promise.resolve();private windows=new Set<string>();private lastInput?:number;private observed=new Map<string,number>();private browserTask?:string;private operations=new Set<AbortController>();
 constructor(private store:Store,private settings:()=>Promise<Settings>,private approve:Approval,private native:Native,private options:Options={}){
  registerSkillFileReader(store,async(input,taskId,signal)=>{
   const grant=this.access.require(taskId);this.access.assertActive(taskId,signal);const target=await this.filePath(input,false,taskId);
   const info=lstatSync(target);if(!info.isFile()||info.nlink!==1||info.size>64*1024*1024||realpathSync.native(target).toLowerCase()!==target.toLowerCase())throw Error('File read-back is unavailable for this size or type.');
   const fd=openSync(target,'r');let bytes:Buffer;try{
    const opened=fstatSync(fd);if(opened.ino!==info.ino||opened.dev!==info.dev||opened.size!==info.size||opened.nlink!==1)throw Error('File changed before read-back.');
    bytes=Buffer.alloc(opened.size);let offset=0;while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)throw Error('File changed during read-back.');offset+=count;}
    const after=fstatSync(fd);if(opened.size!==after.size||opened.mtimeMs!==after.mtimeMs)throw Error('File changed during read-back.');
   }finally{closeSync(fd);}
   if(await this.filePath(input,false,taskId)!==target||this.access.get(taskId)!==grant)throw Error('File or grant changed during read-back.');
   const final=lstatSync(target);if(final.ino!==info.ino||final.dev!==info.dev||final.size!==info.size||final.mtimeMs!==info.mtimeMs||final.nlink!==1||final.isSymbolicLink())throw Error('File changed after read-back.');
   this.access.assertActive(taskId,signal);return {path:target,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  });
  registerSkillFileAbsenceReader(store,async(input,taskId,signal)=>{
   const grant=this.access.require(taskId);this.access.assertActive(taskId,signal);const target=await this.filePath(input,true,taskId);
   const assertAbsent=()=>{try{lstatSync(target);throw Error('The file is still present.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}};assertAbsent();
   if(await this.filePath(input,true,taskId)!==target||this.access.get(taskId)!==grant)throw Error('The file or grant changed.');
   assertAbsent();this.access.assertActive(taskId,signal);return target;
  });
  this.access=options.access||new TaskAccess();const directory=options.directory||path.join(path.dirname(store.file),'agency');this.games=new GameTools(store,path.join(directory,'game-backups'));this.browser=new CapriBrowser(path.join(directory,'browser'),(summary,details,signal)=>this.access.review(this.browserTask,async()=>{const approved=await approve(summary,details,signal);this.assertBeforeDispatch(this.browserTask,signal);return approved;}),async(input,write)=>{const target=await this.filePath(input,write,this.browserTask);if(write){try{await stat(target);await this.games.backup(target);}catch(e:any){if(e.code!=='ENOENT')throw e;}}return target;});
 }
 async require(summary:string,args:any,signal:AbortSignal,taskId?:string){return this.access.review(taskId,async()=>{if(!await this.approve(summary,args,signal))throw new NoSideEffectError('You declined this action.',403);await assertSkillDispatch();signal.throwIfAborted();});}
 private async canonicalWorkspaceRoots(taskId?:string){
  const grant=this.access.get(taskId);if(!taskId||!grant)return [];
  const roots=await Promise.all((this.options.workspaceRoots?.(taskId)??[]).map(root=>realpath(root)));
  if(this.access.get(taskId)!==grant)throw new NoSideEffectError('This task no longer owns its workspace.',403);
  return roots;
 }
 async filePath(input:string,write=false,taskId?:string){
  const grant=this.access.get(taskId),s=await this.settings();
  // allowedPath resolves Windows short TEMP names and junction spelling. Compare
  // task roots in that same physical namespace, retaining their trusted owner.
  const taskRoots=await this.canonicalWorkspaceRoots(taskId);
  let roots=[...s.roots,...taskRoots];if(grant?.mode==='full'){const candidate=path.resolve(s.roots[0]||process.cwd(),input);roots=[path.parse(candidate).root];input=candidate;}
  const resolved=await allowedPath(roots,input,write);
  if(taskId&&(!grant||this.access.get(taskId)!==grant))throw new NoSideEffectError('This task no longer owns its workspace.',403);
  const stagedRoot=taskRoots.find(root=>{const relative=path.relative(root.toLowerCase(),resolved.toLowerCase());return !relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);});
  // Only the protected profile ancestor of an explicitly staged task root is
  // exempt. Private state names inside the snapshot remain forbidden.
  const protectedPath=stagedRoot?path.relative(stagedRoot,resolved):resolved;
  if(/(?:^|[\\/])(?:private\.config|browser|capri-companion|\.codex|Login Data|Cookies|Local State|SAM)(?:[\\/]|$)/i.test(protectedPath))throw new NoSideEffectError('Protected application state is outside computer file tools.',403);
  if(stagedRoot&&/(?:^|[\\/])(?:\.[^\\/]+|private\.config|credentials|secrets)(?:[\\/.]|$)/i.test(protectedPath))throw new NoSideEffectError('Private configuration is excluded from delegated snapshots.',403);
  return resolved;
 }
 run(name:string,args:any,signal:AbortSignal,taskId?:string):Promise<any>{const owned=new AbortController();this.operations.add(owned);const combined=AbortSignal.any([signal,owned.signal]);const work=this.tail.then(async()=>{
  const grant=this.access.get(taskId);
  // Observe prior absence separately from a backup row containing null. A lost
  // backup or a legacy creation marker alone cannot attest the pre-write state.
  let prior:{path:string;state:'absent'|'present';sha256?:string}|undefined;
  if(name==='write_file'&&taskId)try{
   this.access.assertActive(taskId,combined);const target=await this.filePath(args.path,true,taskId);
   try{lstatSync(target);const file=await readSkillFile(this.store,target,taskId,combined);prior={path:target,state:'present',sha256:file.sha256};}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')prior={path:target,state:'absent'};}
  }catch{/* Optional provenance cannot grant or reject a direct write. */}
  let result=await this.execute(name,args,combined,taskId);
  // An outcome witness is optional. Failure to read it must not rebrand an
  // already returned effect as a trusted pre-dispatch rejection or invite replay.
  try{if(taskId&&taskId===currentSkillDispatch()?.taskId&&(currentSkillDispatch()?.bindings.length||name==='write_file')){this.access.assertActive(taskId,combined);if(this.access.get(taskId)!==grant)throw new TaskPaused('Task authorization changed after dispatch.');
   await assertSkillDispatch();
   if(name==='create_artifact'){
    const row=await this.store.get('artifact',result.id),file=await readSkillFile(this.store,result.path,taskId,combined);
    if(row?.taskId===taskId&&row.path===file.path&&row.sha256===file.sha256&&row.bytes===file.bytes)observeSkillProof(name,'artifact-readback',{rowId:row.id,...file});
   }else if(name==='write_file'){
    const row=await this.store.get('backup',result.backupId),file=await readSkillFile(this.store,result.path,taskId,combined);
    if(file.sha256===createHash('sha256').update(args.content).digest('hex'))observeFileWrite(file);
    result={...result,backupStatus:'unconfirmed',restoreLimitation:'The prior-state backup could not be verified. Do not rely on restore_file for this write.'};
    if(row?.path===file.path&&row.afterHash===file.sha256&&prior?.path===file.path&&
      (prior.state==='absent'?row.before===null:typeof row.before==='string'&&createHash('sha256').update(row.before).digest('hex')===prior.sha256)){
     observeSkillProof(name,'file-backup',{backupId:row.id,...file,priorState:prior.state,...(prior.sha256?{priorSha256:prior.sha256}:{})});
     result={...result,backupStatus:prior.state==='absent'?'new-file':'restorable',restoreLimitation:prior.state==='absent'?'No prior file existed. This creation record has no prior bytes; restore_file cannot remove the new file. Remove it manually if needed.':undefined};
    }
   }else if(name==='browser_read'&&typeof result?.url==='string')observeSkillProof(name,'source-citations',{urls:[result.url]});
   this.access.assertActive(taskId,combined);
  }}catch{/* No receipt: the task verifier reports incomplete proof and preserves the actual result. */}return result;
 }).finally(()=>this.operations.delete(owned));this.tail=work.catch(()=>{});return work;}
 /** Trusted exact-review writer. This is deliberately not a model tool. The
  * expected preimage is checked after queued work and backup persistence, at
  * the final synchronous write boundary; Stop revokes the owned operation. */
 writeReviewedText(input:string,content:string,expectedBefore:string|undefined,signal:AbortSignal,taskId:string):Promise<{path:string;backupId:string;verified:true}>{
  const owned=new AbortController();this.operations.add(owned);const combined=AbortSignal.any([signal,owned.signal]);
  const work=this.tail.then(async()=>{
   this.assertBeforeDispatch(taskId,combined);if(Buffer.byteLength(content,'utf8')>128000||content.includes('\0')||!/^\.(?:txt|md|json|csv|tsv|xml|yaml|yml|toml|ini|cfg|log|html|css|js|ts|jsx|tsx|py|cs|cpp|c|h|kt|java|sql|save)$/i.test(path.extname(input)))throw new NoSideEffectError('Use the manual handoff for this file type or size.');
   const target=await this.filePath(input,true,taskId);this.assertBeforeDispatch(taskId,combined);
   const read=(fd:number)=>{const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1||info.size>128000)throw new NoSideEffectError('The reviewed file is not a bounded private regular file.');const bytes=Buffer.alloc(info.size);if(readSync(fd,bytes,0,bytes.length,0)!==bytes.length)throw new NoSideEffectError('The reviewed file changed.');const text=bytes.toString('utf8');if(!Buffer.from(text,'utf8').equals(bytes))throw new NoSideEffectError('Use the manual handoff for binary files.');return {info,text,hash:createHash('sha256').update(bytes).digest('hex')};};
   let before:string|null=null;try{const fd=openSync(target,'r');try{const observed=read(fd);if(observed.hash!==expectedBefore)throw new NoSideEffectError('The original file changed after review.');before=observed.text;}finally{closeSync(fd);}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||expectedBefore!==undefined)throw error;}
   const afterHash=createHash('sha256').update(content).digest('hex'),backup=await this.store.put('backup',{path:target,before,afterHash});this.assertBeforeDispatch(taskId,combined);
   if(await this.filePath(input,true,taskId)!==target)throw new NoSideEffectError('The reviewed target changed.');this.assertBeforeDispatch(taskId,combined);
   await mkdir(path.dirname(target),{recursive:true});this.assertBeforeDispatch(taskId,combined);
   if(realpathSync.native(path.dirname(target)).toLowerCase()!==path.dirname(target).toLowerCase())throw new NoSideEffectError('The reviewed parent changed.');
   const fd=openSync(target,expectedBefore===undefined?'wx+':'r+');try{
    const current=read(fd),entry=lstatSync(target);if(realpathSync.native(target).toLowerCase()!==target.toLowerCase()||entry.isSymbolicLink()||entry.ino!==current.info.ino||entry.dev!==current.info.dev||expectedBefore!==undefined&&current.hash!==expectedBefore)throw new NoSideEffectError('The original file changed at the write boundary.');
    this.assertBeforeDispatch(taskId,combined);const bytes=Buffer.from(content,'utf8');let offset=0;while(offset<bytes.length){const written=writeSync(fd,bytes,offset,bytes.length-offset,offset);if(!written)throw Error('The reviewed write did not finish.');offset+=written;}ftruncateSync(fd,bytes.length);fsyncSync(fd);
    const observed=read(fd),final=lstatSync(target);if(observed.hash!==afterHash||final.ino!==observed.info.ino||final.dev!==observed.info.dev)throw Error('The reviewed write could not be verified.');return {path:target,backupId:backup.id,verified:true as const};
   }finally{closeSync(fd);}
  }).finally(()=>this.operations.delete(owned));this.tail=work.catch(()=>{});return work;
 }
 private assertBeforeDispatch(taskId:string|undefined,signal:AbortSignal){
  try{this.access.assertActive(taskId,signal);}catch(e){
   if(e instanceof TaskPaused&&!signal.aborted)throw new NoSideEffectPause(e.message);
   throw e;
  }
 }
 private async execute(name:string,args:any,signal:AbortSignal,taskId?:string):Promise<any>{
  await assertSkillDispatch();signal.throwIfAborted();if(taskId)this.assertBeforeDispatch(taskId,signal);const settings=await this.settings();const grant=this.access.get(taskId);const review=(summary:string,details:any)=>this.require(summary,details,signal,taskId);
  if(name==='capabilities')return {capabilities:capabilities(this.browser.available(),(await discoverGames()).filter(g=>g.adapter!=='discover').map(g=>g.title)),taskWorkspaces:taskId&&grant?(this.options.workspaceRoots?.(taskId)??[]).map(root=>({path:root,kind:'isolated-agent-snapshot',verification:'Run the requested build/tests through existing granted host tools.'})):[]};
  if(name==='inspect_desktop'){if(args.windowId&&!grant)await review('Share this window with the AI?',args);if(args.windowId&&grant?.mode==='scoped'&&!this.windows.has(taskId+':'+args.windowId)){await review('Allow this task to inspect and control this window?',{windowId:args.windowId,request:grant.request});this.windows.add(taskId+':'+args.windowId);}const result=await this.native(args.windowId?'inspect':'windows',args,signal) as any;if(args.windowId){if(this.lastInput!==undefined&&result.lastInputTick!==undefined&&this.lastInput!==result.lastInputTick)throw new NoSideEffectPause('You took over the computer. Resume when ready.');this.lastInput=result.lastInputTick;this.observed.set(taskId+':'+args.windowId,result.processId);}return result;}
  if(name==='desktop_input'){
   if(!Number.isSafeInteger(args.windowId)||!['click','type','key','invoke','scroll','drag','window'].includes(args.action))throw new NoSideEffectError('Invalid desktop action.');
   if(!grant||grant.mode==='scoped'&&!this.windows.has(taskId+':'+args.windowId)){await review('Allow this task to use this window?',{...args,request:grant?.request});if(grant)this.windows.add(taskId+':'+args.windowId);}
   const before=await this.native('inspect',{windowId:args.windowId},signal) as any;const owner=this.observed.get(taskId+':'+args.windowId);if(grant&&(owner===undefined||owner!==before.processId))throw new NoSideEffectError('Inspect the window again before input; its owner may have changed.');if(before.passwordFocused)throw new NoSideEffectPause('Enter credentials manually, then resume.');if(this.lastInput!==undefined&&before.lastInputTick!==undefined&&before.lastInputTick!==this.lastInput)throw new NoSideEffectPause('You took over the computer. Resume when ready.');
   const element=args.elementId?before.elements?.find((e:any)=>e.id===args.elementId):args.action==='click'||args.action==='drag'?before.elements?.filter((e:any)=>!e.offscreen&&e.width>0&&e.height>0&&args.x>=e.x&&args.y>=e.y&&args.x<e.x+e.width&&args.y<e.y+e.height).sort((a:any,b:any)=>a.width*a.height-b.width*b.height)[0]:undefined;if(args.elementId&&!element)throw new NoSideEffectError('Stale accessibility element. Inspect again.');if(element&&/\b(?:send|post|publish|buy|pay|delete|remove|transfer|install)\b/i.test(element.name))await review('Confirm this application action?',{control:element.name,window:before.title});if(grant&&args.action==='key'&&['ENTER','DELETE'].includes(String(args.text).toUpperCase()))await review('Confirm this keyboard submission or deletion?',{...args,window:before.title});
   this.assertBeforeDispatch(taskId,signal);const performed=await this.native(args.action,{...args,expectedProcessId:before.processId},signal);signal.throwIfAborted();const after=await this.native('inspect',{windowId:args.windowId},signal) as any;this.lastInput=after.lastInputTick;return {performed,after,verified:false,verification:'Input was delivered. Compare returned state with the requested outcome before claiming completion.'};
  }
  if(name==='run_command'){
   if(!args.target||typeof args.command!=='string'||args.command.length>8000)throw new NoSideEffectError('An exact command and target are required.');
   const cwd=await this.filePath(args.cwd||settings.roots[0],false,taskId);
   const staged=(await this.canonicalWorkspaceRoots(taskId)).some(root=>{const relative=path.relative(root.toLowerCase(),cwd.toLowerCase());return !relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);});
   if(!grant||!routineCommand(args.command)||staged)await review(staged?'Run this command against the untrusted delegated snapshot?':'Run this command against the stated target?',args);
   const copying=taskId&&currentSkillDispatch()?.bindings.some(binding=>binding.requiredChecks.includes('file-sha256'))?skillCopyTargets(args.command):undefined;
   const hashing=taskId&&currentSkillDispatch()?.bindings.some(binding=>binding.skillId==='download-inspection'&&binding.requiredChecks.includes('file-sha256'))?skillHashTarget(args.command):undefined;
   let source:Awaited<ReturnType<typeof readSkillFile>>|undefined,destination:string|undefined,inspected:Awaited<ReturnType<typeof readSkillFile>>|undefined;
   // Optional verification cannot reject an otherwise authorized command. The
   // normal command/grant/Stop guards below still decide dispatch authority.
   try{
    if(copying){source=await readSkillFile(this.store,path.resolve(cwd,copying.source),taskId!,signal);destination=await this.filePath(path.resolve(cwd,copying.destination),true,taskId);}
    if(hashing)inspected=await readSkillFile(this.store,path.resolve(cwd,hashing),taskId!,signal);
   }catch{source=undefined;destination=undefined;inspected=undefined;}
   // Only fixed literal file operations can reconcile direct writes. Observe
   // the exact preimage and expected result; exit zero or printed hashes alone
   // cannot establish a later effect on an earlier saved output.
   const followup=skillFileFollowup(args.command);let previous:FileWriteReceipt|undefined,followupTarget:string|undefined;
   try{if(taskId&&followup){
    const file=await readSkillFile(this.store,path.resolve(cwd,followup.source),taskId,signal);
    previous=currentSkillDispatch()?.fileWrite?.receipts?.findLast(receipt=>receipt.path===file.path);
    if(!previous||previous.effect?.operation==='remove'||previous.sha256!==file.sha256||previous.bytes!==file.bytes)throw Error('Unmatched preimage.');
    if(followup.operation==='move')followupTarget=await readSkillFileAbsence(this.store,path.resolve(cwd,followup.destination),taskId,signal);
   }}catch{previous=undefined;followupTarget=undefined;}
   await assertSkillDispatch();this.assertBeforeDispatch(taskId,signal);
   const result=await (this.options.command??commandProcess)('powershell.exe',['-NoProfile','-NonInteractive','-Command',args.command],cwd,signal,120000);
   if(!signal.aborted&&taskId&&this.access.get(taskId)===grant&&taskId===currentSkillDispatch()?.taskId)observeSkillProof(name,'command-exit-status',{command:args.command,target:args.target,cwd,code:result.code});
   try{if(source&&destination&&result.code===0){
    const original=await readSkillFile(this.store,source.path,taskId!,signal),copy=await readSkillFile(this.store,destination,taskId!,signal);
    if(original.sha256===source.sha256&&copy.sha256===source.sha256&&copy.bytes===source.bytes&&copy.path!==source.path)
     observeSkillProof(name,'file-sha256',{source:source.path,destination:copy.path,sha256:source.sha256,bytes:source.bytes});
   }}catch{/* Keep the actual command exit receipt; absent file proof never verifies a copy. */}
   try{if(inspected&&result.code===0){const file=await readSkillFile(this.store,inspected.path,taskId!,signal);
    if(file.sha256===inspected.sha256&&file.bytes===inspected.bytes)observeSkillProof(name,'file-sha256',{target:file.path,sha256:file.sha256,bytes:file.bytes});
   }}catch{/* A printed hash never substitutes for the fixed granted read-back. */}
   try{if(taskId&&previous&&followup&&result.code===0){
    this.access.assertActive(taskId,signal);if(this.access.get(taskId)!==grant)throw Error('Grant changed.');await assertSkillDispatch();
    if(followup.operation==='remove'){
     if(await readSkillFileAbsence(this.store,previous.path,taskId,signal)===previous.path){await assertSkillDispatch();observeFileWriteEffect(previous,'remove',previous);}
    }else{const file=await readSkillFile(this.store,followupTarget??previous.path,taskId,signal);
     if(followup.operation==='move'){
      if(file.sha256!==previous.sha256||file.bytes!==previous.bytes||await readSkillFileAbsence(this.store,previous.path,taskId,signal)!==previous.path)throw Error('Move not observed.');
     }else if(![Buffer.from(followup.content),Buffer.from('\ufeff'+followup.content)].some(bytes=>bytes.length===file.bytes&&createHash('sha256').update(bytes).digest('hex')===file.sha256))throw Error('Modification not observed.');
     await assertSkillDispatch();observeFileWriteEffect(previous,followup.operation,file);
    }
   }}catch{/* Preserve the original write. Unsupported or unreadable follow-ups remain unverified. */}
   return result;
  }
  if(name==='open_app'&&!['notepad','calculator','explorer'].includes(args.app)){if(grant?.mode!=='full')throw new NoSideEffectError('Enable Full computer access to launch another application.');const executable=await realpath(String(args.app));if(!/\.exe$/i.test(executable))throw new NoSideEffectError('Choose a Windows executable.');await review('Launch this application?',{executable});return this.native('launch',{app:executable,full:true},signal);}
  if(name==='browser_action'){if(!grant)await review('Use Capri’s visible browser?',args);if(grant?.mode==='scoped'&&this.browserTask!==taskId)await review('Allow browser use during this task?',{request:grant.request});const activity=await this.native('activity',{},signal) as any;if(this.lastInput!==undefined&&activity.lastInputTick!==undefined&&this.lastInput!==activity.lastInputTick)throw new NoSideEffectPause('You took over the computer. Resume when ready.');this.assertBeforeDispatch(taskId,signal);this.browserTask=taskId;const result=await this.browser.run(args,signal);signal.throwIfAborted();const after=await this.native('activity',{},signal) as any;this.lastInput=after.lastInputTick;return result;}
  if(name==='create_artifact'){const target=await this.filePath(args.path,true,taskId);try{await stat(target);await review('Replace this existing artifact?',{path:target});await this.games.backup(target);}catch(e:any){if(e.code!=='ENOENT')throw e;}if(taskId)this.assertBeforeDispatch(taskId,signal);const artifact=await createArtifact(target,args,signal);const row=await this.store.put('artifact',{...artifact,taskId});this.options.onProgress?.({type:'artifact',artifact:row});return row;}
  if(name==='game_workshop'){
   if(args.action==='discover')return {games:await discoverGames(),note:'Terraria/tModLoader have built-in operations. Other games need a documented adapter.'};
   if(args.action==='backup')return this.games.backup(await this.filePath(args.path,false,taskId));
   if(args.action==='restore'){const p=await this.filePath(args.path,true,taskId);await review('Restore this game file?',{path:p,backupId:args.backupId});return this.games.restore(args.backupId,p);}
   const game=(await discoverGames()).find(g=>g.id===args.gameId);if(!game)throw new NoSideEffectError('Discover games and select an installed gameId.');if(args.action==='logs')return this.games.logs(game);const p=await this.filePath(args.path,args.action==='create',taskId);
   if(args.action==='create')return this.games.createProject(p,args.name,game);if(!['build','test'].includes(args.action))throw new NoSideEffectError('Unsupported game action.');await review('Run this mod in its isolated test profile?',{project:p,game:game.title,action:args.action});return args.action==='build'?this.games.build(p,game,signal):this.games.test(p,game,signal);
  }
  if(name==='adapter_manage'){
   if(args.action==='list')return {adapters:(await this.store.list('adapter')).map(({manifest,...row})=>row)};
   if(args.action==='activate'){const p=await this.filePath(args.path,false,taskId);const bytes=await readFile(p);if(bytes.length>32000)throw new NoSideEffectError('Adapter manifest too large.');let m:any;try{m=JSON.parse(bytes.toString());}catch{throw new NoSideEffectError('Invalid adapter manifest JSON.');}if(!m||typeof m.name!=='string'||typeof m.executable!=='string'||!path.isAbsolute(m.executable)||!Array.isArray(m.arguments)||m.arguments.some((x:any)=>typeof x!=='string'))throw new NoSideEffectError('Invalid adapter manifest.');const executable=await realpath(m.executable);const executableHash=createHash('sha256').update(await readFile(executable)).digest('hex');const hash=createHash('sha256').update(bytes).digest('hex');await review('Activate this exact executable adapter?',{manifest:m,executableHash,hash});return this.store.put('adapter',{id:hash,name:m.name,manifest:{...m,executable},executableHash,active:true});}
   if(args.action!=='run')throw new NoSideEffectError('Unsupported adapter action.');const row=await this.store.get('adapter',args.id);if(!row?.active)throw new NoSideEffectError('Activate the adapter locally first.');if(createHash('sha256').update(await readFile(row.manifest.executable)).digest('hex')!==row.executableHash)throw new NoSideEffectError('Adapter executable changed. Activate it again.');const commandArgs=[...row.manifest.arguments,...(args.arguments||[])];if(commandArgs.some((x:any)=>typeof x!=='string'))throw new NoSideEffectError('Invalid arguments.');await review('Run this adapter?',{executable:row.manifest.executable,arguments:commandArgs});return commandProcess(row.manifest.executable,commandArgs,settings.roots[0],signal);
  }
  if(['read_file','list_files','write_file'].includes(name))args={...args,path:await this.filePath(args.path||'.',name==='write_file',taskId)};
  const legacySettings=async()=>({...settings,roots:grant?.mode==='full'?[path.parse(args.path||settings.roots[0]).root]:[...settings.roots,...(taskId&&this.access.get(taskId)?this.options.workspaceRoots?.(taskId)??[]:[])]});
  const legacy=new LegacyHostTools(this.store,legacySettings,async(summary,details,s)=>{if(grant&&name==='browser_read')return true;return this.access.review(taskId,()=>this.approve(summary,details,s));},this.native);return legacy.run(name,args,signal);
 }
 begin(id:string,request:string){this.lastInput=undefined;this.windows.clear();this.observed.clear();return this.access.grant(id,request);}
 end(id:string){this.access.revoke(id);this.lastInput=undefined;this.windows.clear();}
 reset(){for(const operation of this.operations)operation.abort();this.access.revoke();this.lastInput=undefined;this.windows.clear();this.observed.clear();void this.browser.close();}
 close(){this.reset();}
}
