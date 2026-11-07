import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/server/store';
import {Assistant} from '../src/server/assistant';
import {HostTools} from '../src/server/host';
import {DesktopQueue,hostFailure,hostExecutionResult} from '../src/server/remote';
import {CapriError} from '../src/server/policy';
import {TaskPaused} from '../src/agency';
import {defaults} from '../src/shared';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const call=(name:string,args:any,id:string)=>({type:'function_call',name,arguments:JSON.stringify(args),call_id:id});
const inspect=(id:string)=>call('inspect_desktop',{windowId:3},id);
const input=(id:string,elementId='continue')=>call('desktop_input',{windowId:3,action:'invoke',elementId},id);
const final=()=>({output:[{type:'message',content:[{type:'output_text',text:'Observed Saved in the application.'}]}],provider:'fake'});
function output(body:any,id:string){const item=body.input.find((x:any)=>x.type==='function_call_output'&&x.call_id===id);assert.ok(item,'returned tool result for '+id);return JSON.parse(item.output);}

// Real queue, runner, host guards and encrypted Store; fake JSON transport,
// provider and native application. No sockets, keys, installed profile or apps.
async function fixture(mode:'normal'|'legacy-pause'|'unbranded'|'lost'='normal'){
 const dir=await mkdtemp(path.join(os.tmpdir(),'capri-remote-recovery-'));const key=randomBytes(32);
 let store=await new Store(dir,key).init();const events:any[]=[],transportErrors:unknown[]=[];const deliveries=new Set<Promise<void>>();let assistants:Assistant[]=[];
 const state={password:false,tick:1,effects:0};const hostCalls:any[]=[];
 const settings=async()=>({...defaults,providerMode:'local' as const,roots:[dir]});
 const makeHost=()=>new HostTools(store,settings,async()=>true,async(action)=>{
  if(action==='inspect')return {processId:22,lastInputTick:state.tick,passwordFocused:state.password,elements:[{id:'continue',name:state.effects?'Saved':'Continue'}]};
  assert.equal(action,'invoke');state.effects++;state.tick++;
  if(mode==='unbranded')throw new CapriError('Unconfirmed application action',403);
  return {performed:true};
 });
 let host=makeHost();let queue=new DesktopQueue(store,e=>events.push(e));
 const deliver=async(event:any)=>{
  const existing=await store.get('hostExecution',event.id);let receipt:any;
  if(existing)receipt=hostExecutionResult(existing);
  else{
   await store.put('hostExecution',{id:event.id,status:'running'});hostCalls.push(event);
   try{const result=await host.run(event.name,event.args,new AbortController().signal,event.taskId);await store.put('hostExecution',{id:event.id,status:'completed',result});receipt={result};}
   catch(error){receipt=hostFailure(error);await store.put('hostExecution',{id:event.id,status:'failed',...receipt});}
  }
  const packet=JSON.parse(JSON.stringify({type:'host_result',id:event.id,...receipt}));
  if(mode==='legacy-pause')delete packet.failureEffect;
  if(mode==='lost'&&event.name==='desktop_input')queue.remove(worker);
  else queue.result(worker,packet);
  return packet;
 };
 const worker:any={readyState:1,sent:[] as any[],send(text:string){
  const event=JSON.parse(text);this.sent.push(event);if(event.type!=='host_call')return;
  const delivery=deliver(event).then(()=>{},error=>{transportErrors.push(error);queue.result(worker,{id:event.id,error:'Fake transport failed'});});
  deliveries.add(delivery);void delivery.finally(()=>deliveries.delete(delivery));
 }};
 queue.add(worker);
 const assistant=()=>{
  const ai=new Assistant(store,settings,()=>undefined,e=>events.push(e),(name,args,signal,id)=>queue.run(name,args,signal,id),(phase,task)=>{
   if(phase==='start')host.begin(task.id,task.text);if(phase==='end')host.end(task.id);return 0;
  });
  ai.router.available=async()=>true;ai.call=async()=>{throw Error('Missing fake provider turn');};assistants.push(ai);return ai;
 };
 const drain=async()=>{await Promise.all(deliveries);await tick();assert.deepEqual(transportErrors,[]);};
 const stop=async()=>{for(const ai of assistants)await ai.shutdown();assistants=[];queue.close();await drain();host.close();await store.close();};
 return {state,events,worker,hostCalls,assistant,deliver,get store(){return store;},
  async run(ai:Assistant){await ai.chat('Press Continue and verify Saved.',false,'remote');await Promise.all([...ai.jobs.values()]);await drain();return (await store.get('task','remote'))!;},
  async resume(ai:Assistant){await ai.resume('remote');await Promise.all([...ai.jobs.values()]);await drain();return (await store.get('task','remote'))!;},
  async restart(){await stop();store=await new Store(dir,key).init();host=makeHost();queue=new DesktopQueue(store,e=>events.push(e));queue.add(worker);},
  async close(){await stop();await rm(dir,{recursive:true,force:true});}
 };
}

for(const guard of ['credentials','takeover'] as const)test('paired '+guard+' handoff survives cached replay and resumes with one host effect',async()=>{
 const f=await fixture();const ai=f.assistant();let turn=0;
 ai.call=async()=>{
  if(turn++===0)return {output:[inspect('initial')]};
  assert.equal(turn,2);if(guard==='credentials')f.state.password=true;else f.state.tick++;
  return {output:[input('guarded')]};
 };
 try{
  let task=await f.run(ai);assert.equal(task.status,'paused');assert.equal(f.state.effects,0);assert.equal(task.evidence.sideEffectsUncertain,false);
  assert.deepEqual(task.checkpoint.executed,[]);const handoff=output({input:task.checkpoint.input},'guarded');assert.equal(handoff.code,'pre_dispatch_pause');assert.equal(handoff.uncertain,false);
  const request=f.worker.sent.find((x:any)=>x.name==='desktop_input');const attempts=f.hostCalls.length;
  await f.restart();const cached=await f.deliver(request);assert.equal(cached.failureEffect,'none');assert.equal(cached.paused,true);assert.equal(cached.error,handoff.error);assert.equal(f.hostCalls.length,attempts);
  f.state.password=false;const recovered=f.assistant();let recovery=0;
  recovered.call=async(_endpoint,body)=>{
   if(recovery++===0){assert.deepEqual(output(body,'guarded'),handoff);return {output:[inspect('fresh')]};}
   if(recovery===2)return {output:[input('retry')]};
   if(recovery===3){assert.equal(output(body,'retry').uncertain,false);assert.equal(f.state.effects,1);return {output:[input('duplicate')]};}
   if(recovery===4){assert.equal(output(body,'duplicate').uncertain,false);assert.equal(f.state.effects,1);return {output:[inspect('readback')]};}
   assert.equal(output(body,'readback').elements[0].name,'Saved');return final();
  };
  task=await f.resume(recovered);assert.equal(task.status,'completed');assert.equal(task.evidence.sideEffectsUncertain,false);assert.equal(f.state.effects,1);
  assert.equal(f.hostCalls.filter(x=>x.name==='desktop_input').length,2);assert.equal(task.evidence.toolsFailed.desktop_input,1);assert.equal(task.evidence.toolsSucceeded.desktop_input,1);
  assert.equal(task.checkpoint,undefined);assert.equal(f.events.filter(e=>e.type==='message').length,1);
  const success=f.worker.sent.filter((x:any)=>x.name==='desktop_input').at(-1);const replay=await f.deliver(success);assert.equal(replay.result.performed.performed,true);assert.equal(f.state.effects,1);
 }finally{await f.close();}
});

test('paired pre-dispatch rejection remains known through persistence and recovers without repeating it',async()=>{
 const f=await fixture();const ai=f.assistant();let turn=0;
 ai.call=async(_endpoint,body)=>{
  if(turn++===0)return {output:[inspect('initial')]};
  if(turn===2)return {output:[input('rejected','missing')]};
  assert.equal(output(body,'rejected').uncertain,false);throw new TaskPaused('Review the rejected target.');
 };
 try{
  let task=await f.run(ai);assert.equal(task.status,'paused');assert.equal(task.evidence.sideEffectsUncertain,false);assert.equal(f.state.effects,0);
  const rejection=output({input:task.checkpoint.input},'rejected');assert.match(rejection.error,/Stale accessibility element/);
  const request=f.worker.sent.find((x:any)=>x.name==='desktop_input');const attempts=f.hostCalls.length;await f.restart();
  const cached=await f.deliver(request);assert.equal(cached.failureEffect,'none');assert.equal(cached.paused,false);assert.equal(cached.error,rejection.error);assert.equal(f.hostCalls.length,attempts);
  const recovered=f.assistant();let recovery=0;
  recovered.call=async(_endpoint,body)=>{
   if(recovery++===0)return {output:[input('repeat-rejection','missing')]};
   if(recovery===2){assert.deepEqual(output(body,'repeat-rejection'),rejection);assert.equal(f.hostCalls.length,attempts);return {output:[inspect('fresh')]};}
   if(recovery===3)return {output:[input('corrected')]};
   if(recovery===4){assert.equal(output(body,'corrected').uncertain,false);return {output:[inspect('readback')]};}
   assert.equal(output(body,'readback').elements[0].name,'Saved');return final();
  };
  task=await f.resume(recovered);assert.equal(task.status,'completed');assert.equal(task.evidence.sideEffectsUncertain,false);assert.equal(f.state.effects,1);
  assert.equal(f.hostCalls.filter(x=>x.name==='desktop_input').length,2);assert.equal(task.evidence.toolsFailed.desktop_input,1);
 }finally{await f.close();}
});

for(const mode of ['legacy-pause','unbranded','lost'] as const)test('paired '+mode+' stays uncertain after resume and refuses replay',async()=>{
 const f=await fixture(mode);const ai=f.assistant();let turn=0;
 ai.call=async()=>{
  if(turn++===0)return {output:[inspect('initial')]};
  if(turn===2){if(mode==='legacy-pause')f.state.password=true;return {output:[input('uncertain')]};}
  return final();
 };
 try{
  let task=await f.run(ai);assert.equal(task.status,'paused');assert.equal(task.evidence.sideEffectsUncertain,true);const effects=f.state.effects;assert.equal(effects,mode==='legacy-pause'?0:1);
  const request=f.worker.sent.find((x:any)=>x.name==='desktop_input');const attempts=f.hostCalls.length;await f.restart();f.state.password=false;
  if(mode==='unbranded')assert.match((await f.deliver(request)).error,/outcome unknown/);
  const recovered=f.assistant();let recovery=0;
  recovered.call=async(_endpoint,body)=>{
   if(recovery++===0)return {output:[input('replay')]};
   if(recovery===2){assert.match(output(body,'replay').error,/replay was refused/);assert.equal(f.hostCalls.length,attempts);return {output:[inspect('readback')]};}
   assert.equal(output(body,'readback').elements[0].name,effects?'Saved':'Continue');return final();
  };
  task=await f.resume(recovered);assert.equal(task.status,'paused');assert.equal(task.evidence.sideEffectsUncertain,true);assert.equal(f.state.effects,effects);
  assert.equal(f.hostCalls.filter(x=>x.name==='desktop_input').length,1);assert.ok(task.checkpoint.executed[0][1].uncertain);assert.ok(!f.events.some(e=>e.type==='message'||e.state==='success'));
 }finally{await f.close();}
});
