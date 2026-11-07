import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile,writeFile,realpath } from 'node:fs/promises';
import { randomBytes,createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store';
import { DesktopQueue, hostFailure, hostExecutionResult } from '../src/server/remote';
import { CapriError, NoSideEffectError, NoSideEffectPause } from '../src/server/policy';
import { TaskPaused } from '../src/agency';
import { Assistant } from '../src/server/assistant';
import { defaults } from '../src/shared';
import { HostTools } from '../src/server/host';
import { externalLink } from '../src/desktop/links';
import { Voice } from '../src/ui/voice';
import { VoiceState } from '../src/ui/voice-state';
import type {ExtensionHub,HubContext} from '../src/extensions/hub';

async function fixture(){const dir=await mkdtemp(path.join(os.tmpdir(),'capri-runtime-'));const store=await new Store(dir,randomBytes(32)).init();await mkdir(path.join(dir,'workspace'));return {dir,store,settings:async()=>({...defaults,roots:[path.join(dir,'workspace')]}),close:async()=>{await store.close();await rm(dir,{recursive:true,force:true});}};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('reviewed host writes recheck the exact preimage after backup, preserve user edits and retain restorable backups',async()=>{
 const f=await fixture();const file=path.join(f.dir,'workspace','review.ts'),digest=(value:string)=>createHash('sha256').update(value).digest('hex');
 const host=new HostTools(f.store,f.settings,async()=>false,async()=>({}));host.begin('apply-task','Apply exact reviewed text');
 try{
  await writeFile(file,'before');const put=f.store.put.bind(f.store);let change=true;
  f.store.put=async(kind,value)=>{const record=await put(kind,value);if(kind==='backup'&&change){change=false;await writeFile(file,'user edit during backup');}return record;};
  await assert.rejects(host.writeReviewedText(file,'after',digest('before'),new AbortController().signal,'apply-task'),/changed/);
  assert.equal(await readFile(file,'utf8'),'user edit during backup');
  await writeFile(file,'before');const applied=await host.writeReviewedText(file,'after',digest('before'),new AbortController().signal,'apply-task');assert.equal(applied.verified,true);assert.equal(await readFile(file,'utf8'),'after');
  assert.equal((await f.store.get('backup',applied.backupId))?.before,'before');
  const added=path.join(f.dir,'workspace','added.ts');await host.writeReviewedText(added,'new file',undefined,new AbortController().signal,'apply-task');assert.equal(await readFile(added,'utf8'),'new file');
  await assert.rejects(host.writeReviewedText(added,'overwrite',undefined,new AbortController().signal,'apply-task'),/changed/);assert.equal(await readFile(added,'utf8'),'new file');
 }finally{host.close();await f.close();}
});

test('Stop or grant removal during a reviewed backup prevents the write boundary',async()=>{
 for(const stop of ['stop','revoke'] as const){const f=await fixture(),file=path.join(f.dir,'workspace','review.ts');const host=new HostTools(f.store,f.settings,async()=>false,async()=>({}));host.begin('apply-task','Apply exact review');
  try{await writeFile(file,'before');const put=f.store.put.bind(f.store);f.store.put=async(kind,value)=>{const record=await put(kind,value);if(kind==='backup'){if(stop==='stop')host.reset();else host.end('apply-task');}return record;};
   await assert.rejects(host.writeReviewedText(file,'after',createHash('sha256').update('before').digest('hex'),new AbortController().signal,'apply-task'));assert.equal(await readFile(file,'utf8'),'before');
  }finally{host.close();await f.close();}
 }
});

test('task-owned snapshot roots use normal host file tools only for their live granted task',async()=>{
 const f=await fixture();const staged=path.join(f.dir,'capri-companion','agent-workspaces','snapshot');await mkdir(staged,{recursive:true});
 // The trusted registration may use Windows short TEMP spelling; allowedPath
 // returns the physical spelling. Neither changes which task owns the root.
 const physical=await realpath(staged);
 const host=new HostTools(f.store,f.settings,async()=>false,async()=>({}),{workspaceRoots:id=>id==='owner-task'?[staged]:[]});
 try{
  host.begin('owner-task','Review a staged project');host.begin('other-task','Unrelated task');
  const file=path.join(physical,'draft.ts');const written=await host.run('write_file',{path:file,content:'export const verified=1;'},new AbortController().signal,'owner-task');
  assert.equal(written.verified,true);assert.ok(written.backupId);
  assert.equal((await host.run('read_file',{path:file},new AbortController().signal,'owner-task')).content,'export const verified=1;');
  await assert.rejects(host.run('read_file',{path:file},new AbortController().signal,'other-task'));
  await assert.rejects(host.run('write_file',{path:path.join(staged,'.env'),content:'never'},new AbortController().signal,'owner-task'));
  for(const name of ['private.config','browser','credentials','capri-companion']){
   const nested=path.join(staged,name);await mkdir(nested);await writeFile(path.join(nested,'state.txt'),'protected');
   await assert.rejects(host.run('read_file',{path:path.join(nested,'state.txt')},new AbortController().signal,'owner-task'));
  }
  const sibling=path.join(f.dir,'capri-companion','private.config');await writeFile(sibling,'protected');
  await assert.rejects(host.run('read_file',{path:sibling},new AbortController().signal,'owner-task'));
  await assert.rejects(host.run('run_command',{command:'pnpm build',target:'staged project',cwd:staged},new AbortController().signal,'owner-task'),/declined/,'even a routine build needs review before executing untrusted staged scripts');
  host.end('owner-task');await assert.rejects(host.run('read_file',{path:file},new AbortController().signal,'owner-task'));
 }finally{host.close();await f.close();}
});

test('model runner routes delegated result tools, confines untrusted text to task output and suppresses automatic speech',async()=>{
 const f=await fixture(),events:any[]=[];let calls=0,reads=0;
 const ai=new Assistant(f.store,f.settings,()=> 'test-key-never-sent',event=>events.push(event),async()=>{throw Error('Unexpected host dispatch');});
 const report='UNTRUSTED_REPORT_FIXTURE project-private-id claim: all tests passed';
 ai.extensions={context:()=>({} as HubContext),hub:{selectSkills:async()=>({selected:[]}),skillGuidance:async()=>[],agentResult:async()=>{reads++;return {jobId:'job-1',verification:'unverified',untrusted:true,report:{text:report},changedFiles:[{path:'app.ts',kind:'modified'}]};}} as unknown as ExtensionHub};
 ai.call=async(_endpoint,body)=>{
  assert.ok(body.tools.some((tool:any)=>tool.name==='agent_result'));
  if(++calls===1)return {output:[{type:'function_call',call_id:'result-1',name:'agent_result',arguments:JSON.stringify({jobId:'job-1'})}]};
  const result=JSON.parse(body.input.find((item:any)=>item.call_id==='result-1'&&item.type==='function_call_output').output);
  assert.equal(result.verification,'unverified');assert.equal(result.report.text,report);
  return {output:[{type:'message',content:[{type:'output_text',text:'The provider returned a handoff. Its build and test claims remain unverified.'}]}]};
 };
 try{
  await ai.chat('Inspect the selected delegated handoff.',false,'result-task');await Promise.all([...ai.jobs.values()]);
  assert.equal(reads,1);assert.equal((await f.store.get('task','result-task'))?.status,'completed');
  assert.equal(JSON.stringify(await f.store.list('activity')).includes(report),false);
  const message=events.find(event=>event.type==='message');assert.equal(message.message.suppressSpeech,true);
  const task=await f.store.get('task','result-task');assert.equal(task?.evidence.toolsSucceeded.agent_result,1);assert.equal(task?.evidence.verifiedChecks,undefined,'a provider report cannot mint task verification');
 }finally{await ai.shutdown();await f.close();}
});

test('model extension unknown receipts retain uncertainty and cannot dispatch twice or complete the parent task',async()=>{
 const f=await fixture();let turns=0,dispatches=0;
 const ai=new Assistant(f.store,f.settings,()=> 'test-key-never-sent',()=>{},async()=>{throw Error('Unexpected host dispatch');});
 ai.extensions={context:()=>({} as HubContext),hub:{selectSkills:async()=>({selected:[]}),skillGuidance:async()=>[],dispatch:async(feature:string,action:string,request:{requestId:string})=>{dispatches++;return {id:'receipt-1',feature,action,requestId:request.requestId,observedAt:Date.now(),outcome:'unconfirmed',effect:'unknown',error:{code:'unconfirmed',message:'Read-only reconciliation required.',retry:'read-only-reconcile'}};}} as unknown as ExtensionHub};
 ai.call=async()=>++turns<=2?{output:[{type:'function_call',call_id:'send-'+turns,name:'notify_contact',arguments:JSON.stringify({requestId:'unknown-send',binding:{routeId:'route-1',routeRevision:1,recipientId:'recipient-1',recipientSha256:'a'.repeat(64),workflowId:'workflow-1',templateId:'template-1',templateVersion:1,bodySha256:'b'.repeat(64)}})}]}:{output:[{type:'message',content:[{type:'output_text',text:'This untrusted claim must not complete an unknown send.'}]}]};
 try{
  await ai.chat('Use the previously reviewed notification workflow.',false,'unknown-task');await Promise.all([...ai.jobs.values()]);
  assert.equal(dispatches,1);const task=await f.store.get('task','unknown-task');assert.equal(task?.status,'paused');assert.equal(task?.evidence.sideEffectsUncertain,true);
  assert.equal((await f.store.list('message')).some(message=>message.role==='assistant'),false);
 }finally{await ai.shutdown();await f.close();}
});
function worker(){return {readyState:1,sent:[] as any[],send(text:string){this.sent.push(JSON.parse(text));}} as any;}

test('speaking animation lasts through playback and stops on interruption',()=>{
 const v=new VoiceState();assert.equal(v.accept('output_audio_buffer.started'),'speaking');
 assert.equal(v.accept('response.done'),undefined);assert.equal(v.state,'speaking');assert.equal(v.visible('working'),'speaking');assert.equal(v.visible('success'),'speaking');
 assert.equal(v.accept('input_audio_buffer.speech_started'),'listening');assert.equal(v.playing,false);
 v.accept('output_audio_buffer.started');assert.equal(v.accept('output_audio_buffer.stopped'),'listening');v.reset();assert.equal(v.state,'idle');
});
test('offline desktop task waits, dispatches once, and rejects foreign or duplicate results',async()=>{
 const f=await fixture();const q=new DesktopQueue(f.store,()=>{});try{
  const task=await f.store.put('task',{status:'running',expiresAt:new Date(Date.now()+60000).toISOString()});
  const result=q.run('write_file',{path:'draft.md'},new AbortController().signal,task.id);await tick();
  assert.equal((await f.store.get('task',task.id))?.status,'waiting');
  const w=worker();q.add(w);q.add(w);await tick();assert.equal(w.sent.length,1);
  const id=w.sent[0].id;q.result(worker(),{id,result:'wrong'});assert.equal(q.pending.size,1);
  q.result(w,{id,result:{verified:true}});assert.deepEqual(await result,{verified:true});q.result(w,{id,result:'duplicate'});assert.equal(q.pending.size,0);
 }finally{q.close();await tick();await f.close();}
});
test('stop removes queued actions before Windows reconnects',async()=>{
 const f=await fixture();const q=new DesktopQueue(f.store,()=>{});try{const controller=new AbortController();const result=q.run('open_app',{app:'notepad'},controller.signal);const rejected=assert.rejects(result,/Stopped/);await tick();controller.abort();await rejected;const w=worker();q.add(w);await tick();assert.equal(w.sent.length,0);}finally{q.close();await tick();await f.close();}
});
test('lost Windows connection never replays an action with an uncertain outcome',async()=>{
 const f=await fixture();const q=new DesktopQueue(f.store,()=>{});try{const w=worker();q.add(w);const result=q.run('run_command',{command:'example'},new AbortController().signal);const rejected=assert.rejects(result,/Automatic replay was refused/);await tick();assert.equal(w.sent.length,1);q.remove(w);await rejected;const replacement=worker();q.add(replacement);await tick();assert.equal(replacement.sent.length,0);}finally{q.close();await tick();await f.close();}
});
test('only the assigned worker can return a known pre-dispatch failure, and duplicates are ignored',async()=>{
 const f=await fixture();const q=new DesktopQueue(f.store,()=>{});const assigned=worker(),foreign=worker();q.add(assigned);q.add(foreign);
 try{
  for(const error of [new NoSideEffectPause('Manual sign-in'),new NoSideEffectError('Declined')]){
   const result=q.run('desktop_input',{},new AbortController().signal);const rejected=assert.rejects(result,e=>{assert.ok(e instanceof error.constructor);assert.equal((e as Error).message,error.message);return true;});await tick();
   const id=assigned.sent.at(-1).id;const packet=JSON.parse(JSON.stringify({id,...hostFailure(error)}));
   q.result(foreign,packet);assert.equal(q.pending.size,1);q.result(assigned,packet);await rejected;
   q.result(assigned,packet);assert.equal(q.pending.size,0);assert.equal(foreign.sent.length,0);
  }
 }finally{q.close();await tick();await f.close();}
});
test('old and unknown failure receipts never acquire trusted provenance',async()=>{
 const f=await fixture();const q=new DesktopQueue(f.store,()=>{});const assigned=worker();q.add(assigned);
 try{
  for(const failureEffect of [undefined,'unknown','None',false,{none:true}])for(const paused of [true,false]){
   const result=q.run('desktop_input',{},new AbortController().signal);const rejected=assert.rejects(result,e=>{
    assert.ok(e instanceof (paused?TaskPaused:CapriError));assert.ok(!(e instanceof NoSideEffectError));assert.ok(!(e instanceof NoSideEffectPause));return true;
   });await tick();q.result(assigned,{id:assigned.sent.at(-1).id,error:'Unconfirmed action',paused,failureEffect});await rejected;
  }
  for(const error of [new TaskPaused('Paused after dispatch'),new CapriError('Declined',403),Object.assign(new Error('Spoofed'),{failureEffect:'none',noSideEffects:true}),{message:'Spoofed',failureEffect:'none'}]){
   const receipt=hostFailure(error);assert.equal(receipt.failureEffect,undefined);
   assert.match(hostExecutionResult({status:'failed',...receipt}).error!,/outcome unknown/);
  }
  assert.match(hostExecutionResult({status:'running',error:'Incomplete',paused:true,failureEffect:'none'}).error!,/outcome unknown/);
  assert.match(hostExecutionResult({status:'failed',error:'Old failure'}).error!,/outcome unknown/);
  assert.deepEqual(hostExecutionResult({status:'completed',result:{verified:true}}),{result:{verified:true}});
 }finally{q.close();await tick();await f.close();}
});
test('cancellation wins over a late known-no-effect receipt and cannot dispatch on reconnect',async()=>{
 const f=await fixture();const q=new DesktopQueue(f.store,()=>{});const assigned=worker();q.add(assigned);
 try{
  const controller=new AbortController();const result=q.run('desktop_input',{},controller.signal);const rejected=assert.rejects(result,/Stopped/);await tick();
  const id=assigned.sent[0].id;controller.abort();await rejected;assert.deepEqual(assigned.sent[1],{type:'host_cancel',id});
  q.result(assigned,{id,...hostFailure(new NoSideEffectPause('Too late'))});q.remove(assigned);const next=worker();q.add(next);await tick();assert.equal(next.sent.length,0);assert.equal(q.pending.size,0);
 }finally{q.close();await tick();await f.close();}
});
test('expired authorizations do not reach Windows',async()=>{
 const f=await fixture();const q=new DesktopQueue(f.store,()=>{});try{const task=await f.store.put('task',{expiresAt:new Date(Date.now()-1000).toISOString()});const w=worker();q.add(w);await assert.rejects(q.run('open_app',{},new AbortController().signal,task.id),/expired/);assert.equal(w.sent.length,0);}finally{q.close();await f.close();}
});
test('reasoning uses real executor results, remembers context, and deduplicates submissions',async()=>{
 const f=await fixture();const events:any[]=[];const host=new HostTools(f.store,f.settings,async()=>false,async()=>({}));const ai=new Assistant(f.store,f.settings,()=> 'test-key-never-sent',e=>events.push(e),(name,args,signal)=>host.run(name,args,signal));let calls=0;
 ai.call=async()=>{calls++;return calls===1?{output:[{type:'function_call',name:'write_file',arguments:JSON.stringify({path:'week.md',content:'Monday: build Capri'}),call_id:'test-call'}],usage:{input_tokens:100,output_tokens:100}}:{output:[{type:'message',content:[{type:'output_text',text:'The plan was saved and verified.'}]}],usage:{input_tokens:100,output_tokens:100}};};
 try{const tasks=await Promise.all([ai.chat('Save a weekly plan.',false,'same-request'),ai.chat('Save a weekly plan.',false,'same-request')]);assert.equal(tasks[0].id,tasks[1].id);await Promise.all([...ai.jobs.values()]);assert.equal(calls,2);assert.equal(await readFile(path.join(f.dir,'workspace/week.md'),'utf8'),'Monday: build Capri');assert.equal((await f.store.list('backup')).length,1);assert.equal((await f.store.list('message')).length,2);assert.equal((await f.store.get('task','same-request'))?.status,'completed');assert.ok(events.some(e=>e.type==='message'));}finally{await ai.shutdown();await f.close();}
});
test('private conversations leave no saved transcript or personal task result',async()=>{
 const f=await fixture();const ai=new Assistant(f.store,f.settings,()=> 'test-key-never-sent',()=>{},async()=>({}));ai.call=async()=>({output:[{type:'message',content:[{type:'output_text',text:'Private secret answer.'}]}]});try{await ai.chat('Private secret request.',true,'private-request');await Promise.all([...ai.jobs.values()]);assert.deepEqual(await f.store.list('message'),[]);assert.deepEqual(await f.store.list('memory'),[]);const task=await f.store.get('task','private-request');assert.equal(JSON.stringify(task).includes('secret'),false);}finally{await ai.shutdown();await f.close();}
});
test('stopping reasoning cancels its provider request and cannot report completion',async()=>{
 const f=await fixture();const ai=new Assistant(f.store,f.settings,()=> 'test-key-never-sent',()=>{},async()=>({}));let started!:()=>void;const begun=new Promise<void>(r=>started=r);ai.call=async(_endpoint,_body,signal)=>{started();return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));};try{await ai.chat('Do a task.',false,'stop-request');await begun;ai.stop();await Promise.all([...ai.jobs.values()]);assert.equal((await f.store.get('task','stop-request'))?.status,'cancelled');assert.equal((await f.store.list('message')).some(m=>m.role==='assistant'),false);}finally{await ai.shutdown();await f.close();}
});

// A linked page cannot launch local programs or inject credentials into a URL.
test('external sources and setup links only open plain HTTPS URLs',()=>{assert.equal(externalLink('https://platform.openai.com/api-keys'),'https://platform.openai.com/api-keys');for(const url of ['file:///C:/Windows/System32/cmd.exe','javascript:alert(1)','powershell:command','https://secret@example.com/','not a URL'])assert.equal(externalLink(url),undefined);});

test('spoken task results wait for current playback and none are dropped',async()=>{const v=new Voice(()=>{},()=>false);const sent:any[]=[];v.channel={readyState:'open',send:(value:string)=>sent.push(JSON.parse(value))} as any;v.playback.playing=true;v.announceResult('First completed task');v.announceResult('Second completed task');assert.equal(sent.length,0);v.playback.playing=false;await (v as any).receive({type:'response.done'});assert.equal(sent.length,1);assert.match(sent[0].response.instructions,/First completed task/);assert.equal(v.pendingResults.length,1);await (v as any).receive({type:'response.done'});assert.equal(sent.length,2);assert.match(sent[1].response.instructions,/Second completed task/);assert.equal(v.pendingResults.length,0);});
