import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Assistant} from '../src/server/assistant';
import {Store} from '../src/server/store';
import {defaults} from '../src/shared';
import {TaskPaused} from '../src/agency';
import {HostTools} from '../src/server/host';
import {CapriError,NoSideEffectError} from '../src/server/policy';
import {CapriBrowser} from '../src/server/browser';

const call=(name:string,args:any,id:string)=>({type:'function_call',name,arguments:JSON.stringify(args),call_id:id});
const final=(text='Verified the requested file by readback.')=>({output:[{type:'message',content:[{type:'output_text',text}]}],provider:'fake'});
function result(body:any,id:string){const item=body.input.find((x:any)=>x.type==='function_call_output'&&x.call_id===id);assert.ok(item,'model receives a result for '+id);return JSON.parse(item.output);}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}

// Only the real runner, Assistant lifecycle, and encrypted temporary Store are used.
// Both provider and host are fakes: no keys, sockets, user profile, or native apps.
async function fixture(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'capri-task-evaluation-'));const key=randomBytes(32);
 let store=await new Store(dir,key).init();const events:any[]=[];const files=new Map<string,string>();
 const dispatches:{name:string;args:any}[]=[];const active=new Set<string>();const assistants:Assistant[]=[];
 let host:(name:string,args:any,signal:AbortSignal,taskId?:string)=>Promise<any>=async(name,args,signal)=>{
  signal.throwIfAborted();
  if(name==='write_file'){files.set(args.path,args.content);return {path:args.path,verified:true};}
  if(name==='read_file'){if(!files.has(args.path))throw new Error('File is not present');return {path:args.path,content:files.get(args.path),untrusted:true};}
  throw new Error('Unexpected fake host tool: '+name);
 };
 const makeAssistant=(lifecycle?:(phase:'start'|'end'|'waitMs',task:any)=>void)=>{
  const ai=new Assistant(store,async()=>({...defaults,providerMode:'local'}),()=>undefined,e=>events.push(e),async(name,args,signal,id)=>{
   assert.ok(active.has(id!),'tool dispatch retains the task lifecycle grant');dispatches.push({name,args});return host(name,args,signal,id);
  },(phase,task)=>{if(phase==='start')active.add(task.id);if(phase==='end')active.delete(task.id);lifecycle?.(phase,task);return 0;});
  ai.router.available=async()=>true;ai.call=async()=>{throw new Error('Missing fake provider turn');};assistants.push(ai);return ai;
 };
 const run=async(ai:Assistant,id='evaluation',privateSession=false)=>{await ai.chat('Save and verify the requested file.',privateSession,id);await Promise.all([...ai.jobs.values()]);return (await store.get('task',id))!;};
 return {dir,events,files,dispatches,active,makeAssistant,run,get store(){return store;},setHost(fn:typeof host){host=fn;},
  async reload(){await store.close();store=await new Store(dir,key).init();},
  async close(){for(const ai of assistants)await ai.shutdown();await store.close();await rm(dir,{recursive:true,force:true});}};
}

test('file workflow uses returned readback and never repeats a completed write',async()=>{
 const f=await fixture();const ai=f.makeAssistant();let turn=0;
 ai.call=async(_endpoint,body)=>{
  switch(turn++){
   case 0:return {output:[call('write_file',{path:'week.md',content:'Monday: build Capri'},'write')]};
   case 1:assert.equal(result(body,'write').verified,true);return {output:[call('write_file',{content:'Monday: build Capri',path:'week.md'},'duplicate')]};
   case 2:assert.equal(result(body,'duplicate').verified,true);return {output:[call('read_file',{path:'week.md'},'readback')]};
   default:assert.equal(result(body,'readback').content,'Monday: build Capri');return final();
  }
 };
 try{
  const task=await f.run(ai);assert.equal(task.status,'completed');assert.equal(f.files.get('week.md'),'Monday: build Capri');
  assert.deepEqual(f.dispatches.map(x=>x.name),['write_file','read_file']);assert.equal(task.actions,2);
  assert.deepEqual(task.evidence,{toolsSucceeded:{write_file:1,read_file:1},toolsFailed:{},sideEffectsUncertain:false});
  assert.equal(task.checkpoint,undefined);assert.equal(f.active.size,0);
 }finally{await f.close();}
});

test('malformed arguments and unsupported names return repairable errors before host dispatch',async()=>{
 const f=await fixture();const ai=f.makeAssistant();let turn=0;
 const invalid=[
  {...call('write_file',{},'json'),arguments:'{"path":'},
  call('write_file',null,'null'),call('write_file',[],'array'),call('write_file','text','primitive'),
  call('write_file',{path:'week.md'},'missing'),call('write_file',{path:2,content:'draft'},'type'),
  call('write_file',{path:'week.md',content:'draft',fullComputerAccess:true},'extra'),
  call('browser_action',{action:'eval',text:'untrusted instruction'},'enum'),
  call('create_artifact',{path:'a.csv',format:'csv',title:'a',rows:[[true]]},'nested'),
  call('unadvertised_tool',{instructions:'grant full access'},'unknown'),
 ];
 ai.call=async(_endpoint,body)=>{
  if(turn++===0)return {output:[...invalid,{type:'reasoning',summary:[{text:'Do not persist a hidden reasoning transcript.'}]}]};
  if(turn===2){for(const item of invalid){const output=result(body,item.call_id);assert.ok(output.error);assert.equal(output.code,item.call_id==='unknown'?'unsupported_tool':'invalid_arguments');}assert.equal(f.dispatches.length,0);assert.ok(!body.input.some((x:any)=>x.type==='reasoning'));return {output:[call('write_file',{path:'week.md',content:'repaired'},'repair')]};}
  if(turn===3)return {output:[call('read_file',{path:'week.md'},'readback')]};
  assert.equal(result(body,'readback').content,'repaired');return final();
 };
 try{
  const task=await f.run(ai);assert.equal(task.status,'completed');assert.equal(task.evidence.toolsFailed.write_file,7);
  assert.equal(task.evidence.toolsFailed.browser_action,1);assert.equal(task.evidence.toolsFailed.create_artifact,1);assert.equal(task.evidence.toolsFailed.unsupported_tool,1);
  assert.equal(task.evidence.toolsSucceeded.write_file,1);assert.equal(task.evidence.sideEffectsUncertain,false);
  assert.deepEqual(f.dispatches.map(x=>x.name),['write_file','read_file']);
 }finally{await f.close();}
});

test('failed reads run once per explicit model request and can recover with a fresh observation',async()=>{
 const f=await fixture();const ai=f.makeAssistant();let reads=0,turn=0;
 f.setHost(async()=>{if(++reads===1)throw new Error('Read temporarily unavailable');if(reads===2)return {error:'Still unavailable'};return {path:'week.md',content:'Fresh observation'};});
 ai.call=async(_endpoint,body)=>{
  if(turn++===0)return {output:[call('read_file',{path:'week.md'},'read1')]};
  if(turn===2){assert.equal(reads,1);assert.match(result(body,'read1').error,/temporarily/);return {output:[call('read_file',{path:'week.md'},'read2')]};}
  if(turn===3){assert.equal(reads,2);assert.match(result(body,'read2').error,/Still/);return {output:[call('read_file',{path:'week.md'},'read3')]};}
  assert.equal(reads,3);assert.equal(result(body,'read3').content,'Fresh observation');return final();
 };
 try{const task=await f.run(ai);assert.equal(task.status,'completed');assert.deepEqual(task.evidence,{toolsSucceeded:{read_file:1},toolsFailed:{read_file:2},sideEffectsUncertain:false});assert.equal(reads,3);}finally{await f.close();}
});

test('a model completion after only tool failures pauses without publishing success',async()=>{
 const f=await fixture();const ai=f.makeAssistant();let turn=0;
 ai.call=async()=>turn++===0?{output:[call('read_file',{path:'missing.md'},'missing')]}:final('Everything succeeded.');
 try{
  const task=await f.run(ai);assert.equal(task.status,'paused');assert.match(task.error,/only failures/);
  assert.deepEqual(task.evidence,{toolsSucceeded:{},toolsFailed:{read_file:1},sideEffectsUncertain:false});
  assert.equal(f.dispatches.length,1);assert.ok(!f.events.some(e=>e.type==='message'||e.state==='success'));assert.ok(task.checkpoint);
 }finally{await f.close();}
});

test('Stop aborts an in-flight host action and prevents later calls or completion',async()=>{
 const f=await fixture();const ai=f.makeAssistant();const started=deferred();let providerCalls=0;
 f.setHost(async(_name,_args,signal)=>{started.resolve();await new Promise<void>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('Stopped fake host')),{once:true});});return {verified:true};});
 ai.call=async()=>{providerCalls++;return {output:[call('write_file',{path:'one.md',content:'one'},'first'),call('write_file',{path:'two.md',content:'two'},'second')]};};
 try{
  await ai.chat('Save two files.',false,'stop');await started.promise;ai.stop();await Promise.all([...ai.jobs.values()]);
  const task=(await f.store.get('task','stop'))!;assert.equal(task.status,'cancelled');assert.equal(f.dispatches.length,1);assert.equal(providerCalls,1);assert.equal(f.files.size,0);
  assert.equal(task.evidence.sideEffectsUncertain,true);assert.equal(task.evidence.toolsFailed.write_file,1);assert.ok(task.checkpoint.executed[0][1].uncertain);
  assert.ok(!f.events.some(e=>e.type==='message'||e.state==='success'));assert.equal(f.active.size,0);
 }finally{await f.close();}
});

for(const guard of ['credentials','desktop takeover','browser takeover','revoked grant','grant revoked during approval'] as const)test(guard+' pauses before dispatch and resumes across restart with one verified action',async()=>{
 const f=await fixture();let effects=0,tick=1,password=false,revokeDuringApproval=false;
 // Real host guards and runner, fake native/browser transports and provider.
 // No browser, desktop app, network connection or installed profile is opened.
 const makeHost=()=>{
  const h=new HostTools(f.store,async()=>({...defaults,roots:[f.dir]}),async()=>{
   if(revokeDuringApproval){revokeDuringApproval=false;h.access.revoke('handoff');}
   return true;
  },async(action)=>{
   if(action==='inspect')return {processId:22,lastInputTick:tick,passwordFocused:password,elements:[{id:'continue',name:effects?'Saved':'Continue'}]};
   if(action==='activity')return {lastInputTick:tick};
   assert.ok(action==='invoke'||action==='key');effects++;tick++;return {performed:true};
  });
  h.browser.run=async(args)=>{
   if(args.action!=='inspect'){assert.equal(args.action,'click');effects++;tick++;}
   return {tabId:1,url:'https://example.invalid/',title:'Fake application',text:effects?'Saved':'Continue',elements:[],untrusted:true};
  };
  return h;
 };
 let host=makeHost();
 const lifecycle=(phase:string,task:any)=>{if(phase==='start')host.begin(task.id,task.text);if(phase==='end')host.end(task.id);};
 f.setHost((name,args,signal,id)=>host.run(name,args,signal,id));
 const ai=f.makeAssistant(lifecycle);let turn=0;
 const action=guard==='browser takeover'?call('browser_action',{action:'click',tabId:1,ref:'continue'},'guarded'):
  call('desktop_input',{windowId:3,action:guard==='grant revoked during approval'?'key':'invoke',...(guard==='grant revoked during approval'?{text:'ENTER'}:{elementId:'continue'})},'guarded');
 ai.call=async()=>{
  if(turn++===0)return {output:[call('inspect_desktop',{windowId:3},'initial')]};
  assert.equal(turn,2,'handoff must stop before another provider request');
  if(guard==='credentials')password=true;
  if(guard==='desktop takeover'||guard==='browser takeover')tick++;
  if(guard==='revoked grant')host.access.revoke('handoff');
  if(guard==='grant revoked during approval')revokeDuringApproval=true;
  return {output:[action]};
 };
 try{
  let task=await f.run(ai,'handoff');
  assert.equal(task.status,'paused');assert.equal(effects,0);assert.equal(turn,2);
  assert.equal(task.evidence.sideEffectsUncertain,false);assert.equal(task.evidence.toolsFailed[action.name],1);
  assert.deepEqual(task.checkpoint.executed,[],'undispatched handoffs must not cache a rejected action');
  const handoff=result({input:task.checkpoint.input},'guarded');
  assert.equal(handoff.code,'pre_dispatch_pause');assert.equal(handoff.uncertain,false);
  assert.match(handoff.error,/credentials manually|took over|permissions changed/);
  assert.doesNotMatch(task.error,/outcome is uncertain/);assert.equal(f.active.size,0);
  assert.ok(!f.events.some(e=>e.type==='message'||e.state==='success'));
  host.close();await f.reload();password=false;host=makeHost();
  const recovered=f.makeAssistant(lifecycle);let recoveryTurn=0;
  recovered.call=async(_endpoint,body)=>{
   if(recoveryTurn++===0){assert.deepEqual(result(body,'guarded'),handoff);return {output:[call('inspect_desktop',{windowId:3},'fresh')]};}
   if(recoveryTurn===2)return {output:[{...action,call_id:'retry'}]};
   if(recoveryTurn===3){assert.equal(effects,1);assert.equal(result(body,'retry').uncertain,false);return {output:[{...action,call_id:'duplicate'}]};}
   if(recoveryTurn===4){assert.equal(result(body,'duplicate').uncertain,false);assert.equal(effects,1);return {output:[guard==='browser takeover'?call('browser_action',{action:'inspect',tabId:1},'readback'):call('inspect_desktop',{windowId:3},'readback')]};}
   const readback=result(body,'readback');assert.equal(guard==='browser takeover'?readback.text:readback.elements[0].name,'Saved');
   return final('Verified Saved in the application after resuming.');
  };
  await recovered.resume('handoff');await Promise.all([...recovered.jobs.values()]);task=(await f.store.get('task','handoff'))!;
  assert.equal(task.status,'completed');assert.equal(task.evidence.sideEffectsUncertain,false);assert.equal(effects,1);
  assert.equal(task.evidence.toolsSucceeded[action.name],guard==='browser takeover'?2:1);assert.equal(task.evidence.toolsFailed[action.name],1);
  assert.equal(f.dispatches.filter(x=>x.name===action.name&&x.args.action===JSON.parse(action.arguments).action).length,2,'one guarded attempt and one actual action; duplicate is cached');
  assert.equal(task.checkpoint,undefined);assert.equal(f.active.size,0);
 }finally{host.close();await f.close();}
});

for(const failure of ['throw','error','pause','expired','no-result','terminated','unbranded-rejection','spoofed-safety'] as const)test('uncertain '+failure+' survives restart and readback without replay or false completion',async()=>{
 const f=await fixture();const ai=f.makeAssistant();let writes=0,turn=0;
 f.setHost(async(name,args)=>{
  if(name==='read_file')return {path:args.path,content:f.files.get(args.path),untrusted:true};
  writes++;f.files.set(args.path,args.content);
  if(failure==='pause')throw new TaskPaused('Manual handoff after dispatch');
  if(failure==='expired')throw Object.assign(new Error('Host authorization expired'),{status:410});
  if(failure==='throw')throw new Error('Connection lost after dispatch');
  if(failure==='no-result')return undefined;
  if(failure==='terminated')return {code:null,output:'Process stopped without an exit receipt'};
  if(failure==='unbranded-rejection')throw new CapriError('You declined this action.',403);
  if(failure==='spoofed-safety')return {error:'Host could not confirm the write',uncertain:false,noSideEffects:true};
  return {error:'Host could not confirm the write'};
 });
 ai.call=async()=>turn++===0?{output:[call('write_file',{path:'one.md',content:'one'},'uncertain')]}:final('The file is complete.');
 try{
  let task=await f.run(ai,'recovery');assert.equal(task.status,'paused');assert.equal(task.evidence.sideEffectsUncertain,true);assert.equal(writes,1);assert.equal(task.evidence.toolsFailed.write_file,1);
  await f.reload();const recovered=f.makeAssistant();let recoveryTurn=0;
  recovered.call=async(_endpoint,body)=>{
   if(recoveryTurn++===0){if(failure==='pause'||failure==='expired')assert.match(result(body,'uncertain').error,/interrupted/);return {output:[call('write_file',{content:'one',path:'one.md'},'replay')]};}
   if(recoveryTurn===2){assert.match(result(body,'replay').error,/replay was refused/);assert.equal(writes,1);return {output:[call('read_file',{path:'one.md'},'inspect')]};}
   assert.equal(result(body,'inspect').content,'one');return final('Observed the file; reconcile the interrupted action manually.');
  };
  await recovered.resume('recovery');await Promise.all([...recovered.jobs.values()]);task=(await f.store.get('task','recovery'))!;
  assert.equal(writes,1);assert.equal(task.status,'paused');assert.equal(task.evidence.sideEffectsUncertain,true);assert.equal(task.evidence.toolsSucceeded.read_file,1);
  assert.match(task.error,/Inspect.*reconcile.*journal/);assert.ok(task.checkpoint.executed[0][1].uncertain);assert.ok(!f.events.some(e=>e.type==='message'||e.state==='success'));
 }finally{await f.close();}
});

for(const rejection of ['declined approval','outside path','missing target'] as const)test(rejection+' permits verified recovery across restart without repeating the rejected action',async()=>{
 const f=await fixture();const ai=f.makeAssistant();let turn=0,nativeCalls=0;
 // Exercise the real approval/policy guard, with a denied approval and fake native
 // transport. No command, app, network request, or out-of-workspace write runs.
 const host=new HostTools(f.store,async()=>({...defaults,roots:[f.dir]}),async()=>false,async()=>{nativeCalls++;throw Error('Must not dispatch');});
 const rejected=rejection==='outside path'?call('write_file',{path:path.join(f.dir,'..','outside.md'),content:'blocked'},'rejected'):
  call('run_command',{command:'Write-Output test',target:rejection==='missing target'?'':'The fake fixture'},'rejected');
 f.setHost(async(name,args,signal)=>{
  if(name==='run_command'||args.path===path.join(f.dir,'..','outside.md'))return host.run(name,args,signal);
  if(name==='write_file'){f.files.set(args.path,args.content);return {path:args.path,verified:true};}
  return {path:args.path,content:f.files.get(args.path)};
 });
 ai.call=async(_endpoint,body)=>{
  if(turn++===0)return {output:[rejected]};
  assert.ok(result(body,'rejected').error);assert.equal(result(body,'rejected').uncertain,false);
  throw new TaskPaused('Review the rejected action before recovery');
 };
 try{
  let task=await f.run(ai,'known-rejection');assert.equal(task.status,'paused');assert.equal(task.evidence.sideEffectsUncertain,false);
  assert.equal(task.checkpoint.executed[0][1].uncertain,false);assert.equal(f.dispatches.length,1);assert.equal(f.files.size,0);
  await f.reload();const recovered=f.makeAssistant();let recoveryTurn=0;
  recovered.call=async(_endpoint,body)=>{
   if(recoveryTurn++===0)return {output:[{...rejected,call_id:'cached-rejection'}]};
   if(recoveryTurn===2){assert.ok(result(body,'cached-rejection').error);assert.equal(result(body,'cached-rejection').uncertain,false);assert.equal(f.dispatches.length,1);return {output:[call('write_file',{path:'recovered.md',content:'verified recovery'},'repair')]};}
   if(recoveryTurn===3)return {output:[call('read_file',{path:'recovered.md'},'readback')]};
   assert.equal(result(body,'readback').content,'verified recovery');return final();
  };
  await recovered.resume('known-rejection');await Promise.all([...recovered.jobs.values()]);task=(await f.store.get('task','known-rejection'))!;
  assert.equal(task.status,'completed');assert.equal(task.evidence.sideEffectsUncertain,false);assert.equal(task.evidence.toolsFailed[rejected.name],1);
  assert.deepEqual(task.evidence.toolsSucceeded,{write_file:1,read_file:1});assert.equal(f.dispatches.length,3);assert.equal(nativeCalls,0);
 }finally{host.close();await f.close();}
});

test('a complete nonzero command receipt stays failed and cached while verified recovery can complete',async()=>{
 const f=await fixture();const ai=f.makeAssistant();let turn=0,commands=0;
 const command=call('run_command',{command:'pnpm test',target:'Fixture tests'},'command');
 f.setHost(async(name,args)=>{
  if(name==='run_command'){commands++;f.files.set('checks.log','One failing check');return {code:1,output:'One failing check'};}
  if(name==='write_file'){f.files.set(args.path,args.content);return {path:args.path,verified:true};}
  return {path:args.path,content:f.files.get(args.path)};
 });
 ai.call=async()=>turn++===0?{output:[command]}:final('Tests passed.');
 try{
  let task=await f.run(ai,'nonzero');assert.equal(task.status,'paused');assert.match(task.error,/only failures/);
  assert.deepEqual(task.evidence,{toolsSucceeded:{},toolsFailed:{run_command:1},sideEffectsUncertain:false});
  assert.equal(task.checkpoint.executed[0][1].uncertain,false);assert.ok(!f.events.some(e=>e.type==='message'||e.state==='success'));
  await f.reload();const recovered=f.makeAssistant();let recoveryTurn=0;
  recovered.call=async(_endpoint,body)=>{
   if(recoveryTurn++===0)return {output:[{...command,call_id:'cached-command'}]};
   if(recoveryTurn===2){assert.equal(result(body,'cached-command').code,1);assert.equal(commands,1);return {output:[call('write_file',{path:'checks.log',content:'Checks repaired'},'repair')]};}
   if(recoveryTurn===3)return {output:[call('read_file',{path:'checks.log'},'verify')]};
   assert.equal(result(body,'verify').content,'Checks repaired');return final('Recovered and verified checks.log; the original command failed.');
  };
  await recovered.resume('nonzero');await Promise.all([...recovered.jobs.values()]);task=(await f.store.get('task','nonzero'))!;
  assert.equal(task.status,'completed');assert.equal(commands,1);
  assert.deepEqual(task.evidence,{toolsSucceeded:{write_file:1,read_file:1},toolsFailed:{run_command:1},sideEffectsUncertain:false});
 }finally{await f.close();}
});

test('memory and plan validation failures can be repaired without uncertain effects',async()=>{
 const f=await fixture();const ai=f.makeAssistant();let turn=0;
 const invalid=[call('remember',{text:' ',source:'User statement'},'memory'),call('add_plan',{title:' '},'title'),call('add_plan',{title:'Build Capri',dueAt:'not-a-date'},'date')];
 ai.call=async(_endpoint,body)=>{
  if(turn++===0)return {output:invalid};
  if(turn===2){for(const item of invalid)assert.ok(result(body,item.call_id).error);return {output:[call('remember',{text:'I build Capri',source:'User statement'},'memory-repair'),call('add_plan',{title:'Build Capri',dueAt:''},'plan-repair')]};}
  assert.equal(result(body,'memory-repair').text,'I build Capri');assert.equal(result(body,'plan-repair').title,'Build Capri');return final('Saved the corrected memory and plan.');
 };
 try{
  const task=await f.run(ai);assert.equal(task.status,'completed');assert.equal(f.dispatches.length,0);
  assert.deepEqual(task.evidence,{toolsSucceeded:{remember:1,add_plan:1},toolsFailed:{remember:1,add_plan:2},sideEffectsUncertain:false});
  assert.equal((await f.store.list('memory')).length,1);assert.equal((await f.store.list('plan')).length,1);
 }finally{await f.close();}
});

for(const receipt of ['error','nonzero','terminated'] as const)test('legacy '+receipt+' journal preserves outcome certainty and refuses duplicate dispatch',async()=>{
 const f=await fixture();const ai=f.makeAssistant();const args={command:'pnpm test',target:'Fixture tests'};
 const hash=createHash('sha256').update('run_command:'+JSON.stringify(args)).digest('hex');
 const recorded=receipt==='error'?{error:'Unknown outcome'}:{code:receipt==='nonzero'?1:null,output:'Recorded command output'};
 try{
  await f.store.put('task',{id:'legacy',text:'Original request',status:'paused',checkpoint:{input:[{role:'user',content:'Original request'},call('run_command',args,'original')],executed:[[hash,recorded]],actions:1,elapsedMs:1,phase:'recover',sources:[]}});
  f.files.set('checks.log','Fresh verified state');let turn=0;
  ai.call=async(_endpoint,body)=>{
   if(turn++===0)return {output:[call('run_command',{target:args.target,command:args.command},'duplicate')]};
   if(turn===2){if(receipt==='nonzero')assert.equal(result(body,'duplicate').code,1);else assert.match(result(body,'duplicate').error,/replay was refused/);return {output:[call('read_file',{path:'checks.log'},'readback')]};}
   assert.equal(result(body,'readback').content,'Fresh verified state');return final();
  };
  await ai.resume('legacy');await Promise.all([...ai.jobs.values()]);const task=(await f.store.get('task','legacy'))!;
  assert.equal(task.status,receipt==='nonzero'?'completed':'paused');assert.equal(task.evidence.sideEffectsUncertain,receipt!=='nonzero');
  assert.deepEqual(f.dispatches.map(x=>x.name),['read_file']);
 }finally{await f.close();}
});

test('older persisted checkpoints retain their journal when argument keys are reordered',async()=>{
 const f=await fixture();const ai=f.makeAssistant();const args={path:'old.md',content:'old'};
 const hash=createHash('sha256').update('write_file:'+JSON.stringify(args)).digest('hex');
 try{
  await f.store.put('task',{id:'old',text:'Original request',status:'paused',checkpoint:{input:[{role:'user',content:'Original request'},call('write_file',args,'original')],executed:[[hash,{uncertain:true}]],actions:1,elapsedMs:1,phase:'recover',sources:[]}});
  let turn=0;ai.call=async(_endpoint,body)=>turn++===0?{output:[call('write_file',{content:'old',path:'old.md'},'old-write')]}:(assert.match(result(body,'old-write').error,/replay was refused/),final());
  await ai.resume('old');await Promise.all([...ai.jobs.values()]);const task=(await f.store.get('task','old'))!;
  assert.equal(f.dispatches.length,0);assert.equal(task.status,'paused');assert.equal(task.evidence.sideEffectsUncertain,true);
 }finally{await f.close();}
});

test('private paused tasks keep transcripts and journals out of the stored task',async()=>{
 const f=await fixture();const ai=f.makeAssistant();let turn=0;
 f.setHost(async()=>{throw new Error('private secret host detail');});
 ai.call=async()=>turn++===0?{output:[call('write_file',{path:'secret.md',content:'private secret text'},'private')]}:final('private secret answer');
 try{
  const task=await f.run(ai,'private',true);assert.equal(task.status,'paused');assert.equal(task.checkpoint,undefined);assert.equal(task.evidence.sideEffectsUncertain,true);
  assert.doesNotMatch(JSON.stringify(task),/secret/);assert.deepEqual(await f.store.list('message'),[]);
  const activity=await f.store.list('activity');assert.ok(activity.every(x=>x.summary==='Private task'));assert.ok(ai.privateCheckpoints.has('private'));
 }finally{await f.close();}
});

// Real CapriBrowser.run/snapshot and their guard boundaries, with only Playwright
// page/element transport faked. No browser process, profile or network is opened.
function browserTransport(directory:string,approve=async()=>true){
 let effects=0,failAfterInput=false,name='Continue',type='button';
 const browser=new CapriBrowser(directory,approve,async input=>input,true);
 const effect=async()=>{effects++;if(failAfterInput)browser.pages.delete(1);};
 const element={evaluate:async(fn:any)=>fn({tagName:'BUTTON',innerText:name,offsetWidth:20,offsetHeight:20,getClientRects:()=>[{}],getAttribute:(key:string)=>key==='type'?type:null}),click:effect,fill:effect,selectOption:effect,setInputFiles:effect};
 const page={bringToFront:async()=>{},title:async()=>'Fixture page',url:()=>'http://127.0.0.1/fixture',$$:async()=>[element],locator:()=>({innerText:async()=>effects?'Saved':'Ready'}),goto:effect,close:effect,goBack:effect,mouse:{wheel:effect}};
 browser.context={close:async()=>{}} as any;browser.pages.set(1,page as any);browser.pages.set(2,{...page} as any);
 return {browser,get effects(){return effects;},set name(value:string){name=value;},set type(value:string){type=value;},set failAfterInput(value:boolean){failAfterInput=value;},restorePage(){browser.pages.set(1,page as any);}};
}

for(const guard of ['stale','cross-tab','closed tab','website declined','upload declined','download declined','file input','password'] as const)test('actual browser '+guard+' guard recovers through fresh inspection and one verified input',async()=>{
 const f=await fixture();let approved=false;
 const transport=browserTransport(f.dir,async()=>approved);const {browser}=transport;
 const ai=f.makeAssistant();f.setHost((name,args,signal)=>{assert.equal(name,'browser_action');return browser.run(args,signal);});
 let turn=0,rejected:any;
 ai.call=async(_endpoint,body)=>{
  if(turn++===0)return {output:[call('browser_action',{action:'inspect',tabId:1},'initial')]};
  if(turn===2){
   const ref=result(body,'initial').elements[0].ref;
   if(guard==='stale')await browser.snapshot(1);
   if(guard==='website declined')transport.name='Delete';
   if(guard==='file input'||guard==='upload declined')transport.type='file';
   if(guard==='password')transport.type='password';
   rejected=call('browser_action',{action:guard==='upload declined'?'upload':guard==='download declined'?'download':guard==='file input'?'fill':'click',tabId:guard==='cross-tab'?2:guard==='closed tab'?99:1,ref,...(['upload declined','download declined'].includes(guard)?{path:path.join(f.dir,'download.txt')}:{})},'rejected');
   return {output:[rejected]};
  }
  if(turn===3){
   assert.ok(result(body,'rejected').error);assert.equal(result(body,'rejected').uncertain,false);assert.equal(transport.effects,0);
   approved=true;transport.name='Continue';transport.type='button';return {output:[call('browser_action',{action:'inspect',tabId:1},'fresh')]};
  }
  if(turn===4)return {output:[call('browser_action',{action:'click',tabId:1,ref:result(body,'fresh').elements[0].ref},'repair')]};
  assert.equal(result(body,'repair').text,'Saved');return final('Verified the application shows Saved.');
 };
 try{
  await writeFile(path.join(f.dir,'download.txt'),'Existing fixture');
  const task=await f.run(ai);assert.equal(task.status,'completed');assert.equal(transport.effects,1);
  assert.deepEqual(task.evidence,{toolsSucceeded:{browser_action:3},toolsFailed:{browser_action:1},sideEffectsUncertain:false});
  assert.equal(await readFile(path.join(f.dir,'download.txt'),'utf8'),'Existing fixture');
 }finally{await browser.close();await f.close();}
});

for(const action of ['click','navigate','upload'] as const)test('actual browser '+action+' followed by failed verification pauses across restart without duplicate effects',async()=>{
 const f=await fixture();const transport=browserTransport(f.dir);const {browser}=transport;transport.failAfterInput=true;
 f.setHost((name,args,signal)=>{assert.equal(name,'browser_action');return browser.run(args,signal);});
 const ai=f.makeAssistant();let turn=0,actionCall:any;
 ai.call=async(_endpoint,body)=>{
  if(turn++===0)return {output:[call('browser_action',{action:'inspect',tabId:1},'initial')]};
  if(turn===2){actionCall=call('browser_action',{action,tabId:1,...(action==='navigate'?{url:'http://127.0.0.1/next'}:{ref:result(body,'initial').elements[0].ref,...(action==='upload'?{path:'fixture.txt'}:{})})},'input');return {output:[actionCall]};}
  assert.ok(result(body,'input').error);assert.equal(result(body,'input').uncertain,true);return final('The action succeeded.');
 };
 try{
  let task=await f.run(ai,'browser-uncertain');assert.equal(task.status,'paused');assert.equal(transport.effects,1);assert.equal(task.evidence.sideEffectsUncertain,true);
  await f.reload();transport.restorePage();transport.failAfterInput=false;const recovered=f.makeAssistant();let recoveryTurn=0;
  recovered.call=async(_endpoint,body)=>{
   if(recoveryTurn++===0)return {output:[{...actionCall,call_id:'duplicate'}]};
   if(recoveryTurn===2){assert.match(result(body,'duplicate').error,/replay was refused/);return {output:[call('browser_action',{action:'inspect',tabId:1},'readback')]};}
   assert.equal(result(body,'readback').text,'Saved');return final('Observed Saved; the interrupted action still needs reconciliation.');
  };
  await recovered.resume('browser-uncertain');await Promise.all([...recovered.jobs.values()]);task=(await f.store.get('task','browser-uncertain'))!;
  assert.equal(task.status,'paused');assert.equal(task.evidence.sideEffectsUncertain,true);assert.equal(transport.effects,1);
  assert.match(task.error,/reconcile.*journal/);assert.ok(!f.events.some(e=>e.type==='message'||e.state==='success'));
 }finally{await browser.close();await f.close();}
});

test('actual browser rejects unsupported operations and cancellation during approval before input',async()=>{
 const controller=new AbortController();const transport=browserTransport('unused',async()=>{controller.abort();return true;});
 try{
  await assert.rejects(transport.browser.run({action:'unsupported'},new AbortController().signal),NoSideEffectError);
  const initial=await transport.browser.snapshot(1);transport.name='Delete';
  await assert.rejects(transport.browser.run({action:'click',tabId:1,ref:initial.elements[0].ref},controller.signal));assert.equal(transport.effects,0);
 }finally{await transport.browser.close();}
});

for(const rejection of ['extension','oversize'] as const)test('actual write_file '+rejection+' rejection permits an alternative file verified by readback',async()=>{
 const f=await fixture();const workspace=path.join(f.dir,'workspace');await mkdir(workspace);
 const host=new HostTools(f.store,async()=>({...defaults,roots:[workspace]}),async()=>true,async()=>{throw Error('No native calls expected');});
 f.setHost((name,args,signal)=>host.run(name,args,signal));const ai=f.makeAssistant();let turn=0;
 ai.call=async(_endpoint,body)=>{
  if(turn++===0)return {output:[call('write_file',{path:rejection==='extension'?'unknown.bin':'too-large.md',content:rejection==='oversize'?'x'.repeat(128001):'unknown format'},'rejected')]};
  if(turn===2){
   if(rejection==='oversize'){
    // The runner compacts the oversized call before the next provider turn;
    // the known failed outcome must survive in the checkpoint summary.
    const summary=body.input.find((x:any)=>x.role==='assistant')?.content;
    assert.match(summary,/File content exceeds 128 KB/);assert.match(summary,/"uncertain":false/);
   }else{assert.equal(result(body,'rejected').uncertain,false);assert.match(result(body,'rejected').error,/dedicated editor/);}
   return {output:[call('write_file',{path:'verified.md',content:'Verified alternative'},'repair')]};
  }
  if(turn===3){assert.equal(result(body,'repair').verified,true);return {output:[call('read_file',{path:'verified.md'},'readback')]};}
  assert.equal(result(body,'readback').content,'Verified alternative');return final();
 };
 try{
  const task=await f.run(ai);assert.equal(task.status,'completed');assert.deepEqual(task.evidence,{toolsSucceeded:{write_file:1,read_file:1},toolsFailed:{write_file:1},sideEffectsUncertain:false});
  assert.equal((await f.store.list('backup')).length,1);assert.equal(await readFile(path.join(workspace,'verified.md'),'utf8'),'Verified alternative');
  await assert.rejects(readFile(path.join(workspace,rejection==='extension'?'unknown.bin':'too-large.md')));
 }finally{host.close();await f.close();}
});

test('missing memory and plan updates recover using actual stored alternatives',async()=>{
 const f=await fixture();const ai=f.makeAssistant();let turn=0,memoryId='',planId='';
 ai.call=async(_endpoint,body)=>{
  if(turn++===0)return {output:[call('update_memory',{id:'missing',text:'Correction'},'memory-missing'),call('update_plan',{id:'missing',title:'Correction'},'plan-missing')]};
  if(turn===2){for(const id of ['memory-missing','plan-missing']){assert.match(result(body,id).error,/not found/);assert.equal(result(body,id).uncertain,false);}return {output:[call('remember',{text:'Original fact',source:'User'},'memory-new'),call('add_plan',{title:'Original plan'},'plan-new')]};}
  if(turn===3){memoryId=result(body,'memory-new').id;planId=result(body,'plan-new').id;return {output:[call('update_memory',{id:memoryId,text:'Corrected fact'},'memory-repair'),call('update_plan',{id:planId,title:'Corrected plan'},'plan-repair')]};}
  assert.equal(result(body,'memory-repair').updated,true);assert.equal(result(body,'plan-repair').title,'Corrected plan');return final('Saved the corrected memory and plan.');
 };
 try{
  const task=await f.run(ai);assert.equal(task.status,'completed');assert.equal(task.evidence.sideEffectsUncertain,false);assert.deepEqual(task.evidence.toolsFailed,{update_memory:1,update_plan:1});
  assert.equal((await f.store.get('memory',memoryId))?.text,'Corrected fact');assert.equal((await f.store.get('plan',planId))?.title,'Corrected plan');
  // Direct guards too: the runner's timestamp schema must not be the only boundary.
  await assert.rejects(ai.tool('add_plan',{title:'Invalid',dueAt:'invalid'},new AbortController().signal,false),NoSideEffectError);
  await assert.rejects(ai.tool('update_plan',{id:planId,dueAt:'invalid'},new AbortController().signal,false),NoSideEffectError);
  await assert.rejects(ai.tool('unknown',{},new AbortController().signal,false),NoSideEffectError);
 }finally{await f.close();}
});

test('image source and provider guards reject before reservations or provider dispatch',async()=>{
 const f=await fixture();const ai=f.makeAssistant();let reservations=0,providerCalls=0;
 ai.reserve=async()=>{reservations++;throw Error('Must not reserve');};ai.call=async()=>{providerCalls++;throw Error('Must not call provider');};
 try{
  ai.router.selected=async()=>'local';
  await assert.rejects(ai.tool('generate_image',{prompt:'A local request'},new AbortController().signal,false),NoSideEffectError);
  ai.router.selected=async()=>'openai';
  await assert.rejects(ai.tool('generate_image',{prompt:'No configured key'},new AbortController().signal,false),NoSideEffectError);
  ai.key=()=>'fixture-unused-key';
  await assert.rejects(ai.tool('generate_image',{prompt:'Edit source',attachmentId:'missing'},new AbortController().signal,false),{message:'Source image not found.'});
  assert.equal(reservations,0);assert.equal(providerCalls,0);assert.equal((await f.store.list('usage')).length,0);
 }finally{await f.close();}
});
