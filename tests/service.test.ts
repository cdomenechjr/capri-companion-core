import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp,rm,mkdir,realpath,readFile,writeFile,copyFile,rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Store } from '../src/server/store';
import { createService,hash } from '../src/server/service';
import { Assistant } from '../src/server/assistant';
import { HostTools } from '../src/server/host';
import type { commandProcess } from '../src/server/commands';
import { defaultExtensionSettings } from '../src/extensions/contracts';
import { hubRecordKinds } from '../src/extensions/hub';
import { resolveSkillHostFacts } from '../src/extensions/skills';
import { skillEvidenceKind,fileWriteEvidenceKind,type SkillExecutionJournal } from '../src/extensions/skill-verification';
import type { Checkpoint } from '../src/agency';
import { defaults } from '../src/shared';
import { NoSideEffectError } from '../src/server/policy';
const auth={authorization:'Bearer test-admin-not-a-real-secret'};
async function fixture(){const dir=await mkdtemp(path.join(os.tmpdir(),'capri-service-'));const store=await new Store(dir,randomBytes(32)).init();return {dir,store,close:async()=>{await store.close();await rm(dir,{recursive:true,force:true});}};}

test('voice uses interruptible audio, deduplicates saved transcripts, and keeps private calls out of history',async()=>{
 const f=await fixture();const originalFetch=globalThis.fetch;let calls=0;const sessions:any[]=[];
 globalThis.fetch=async(input,init)=>{const url=String(input);if(url.endsWith('/realtime/calls')){sessions.push(JSON.parse(String((init!.body as FormData).get('session'))));return new Response('mock-sdp',{status:201,headers:{location:'https://api.openai.com/v1/realtime/calls/mock-'+ ++calls}});}if(url.endsWith('/hangup'))return new Response(null,{status:200});throw Error('Unexpected network request in test.');};
 await f.store.put('settings',{...defaults,id:'main',providerMode:'openai'});
 const {app}=await createService({store:f.store,adminToken:'test-admin-not-a-real-secret',key:()=> 'test-key-never-sent'});
 try{
  const call=(await app.inject({method:'POST',url:'/v1/voice/call',headers:auth,payload:{sdp:'mock-offer'}})).json();assert.equal(call.maxSeconds,120);assert.equal(sessions[0].audio.input.turn_detection.interrupt_response,true);assert.equal(sessions[0].audio.output.voice,'marin');
  const transcript={callId:call.callId,id:'item-1:user',role:'user',text:'Please remember my favourite colour.'};
  for(let i=0;i<2;i++)assert.equal((await app.inject({method:'POST',url:'/v1/voice/transcript',headers:auth,payload:transcript})).statusCode,200);
  assert.equal((await f.store.list('message')).length,1);
  const privateCall=(await app.inject({method:'POST',url:'/v1/voice/call',headers:auth,payload:{sdp:'mock-offer',private:true}})).json();
  const hidden=await app.inject({method:'POST',url:'/v1/voice/transcript',headers:auth,payload:{...transcript,callId:privateCall.callId,text:'This is a private conversation.'}});assert.equal(hidden.json().saved,false);assert.equal((await f.store.list('message')).length,1);
  await app.inject({method:'POST',url:'/v1/stop',headers:auth});assert.equal((await app.inject({method:'POST',url:'/v1/voice/transcript',headers:auth,payload:transcript})).statusCode,409);
 }finally{await app.close();globalThis.fetch=originalFetch;await rm(f.dir,{recursive:true,force:true});}
});
test('research refresh is opt-in, limited to daily, and preserves citations and retrieval dates',async()=>{
 const f=await fixture();const ai=new Assistant(f.store,async()=>defaults,()=> 'test-key-never-sent',()=>{},async()=>({}));let calls=0;ai.call=async(_endpoint,body)=>{calls++;assert.equal(body.tools[0].type,'web_search');return {output:[{type:'web_search_call'},{type:'message',content:[{type:'output_text',text:'A sourced current update.',annotations:[{type:'url_citation',title:'Primary reference',url:'https://example.com/reference'}]}]}],usage:{input_tokens:100,output_tokens:50}};};
 try{await f.store.put('topic',{title:'An inactive topic',active:false});await ai.refreshTopics();assert.equal(calls,0);await f.store.put('topic',{title:'A subscribed topic',active:true});await ai.refreshTopics();await ai.refreshTopics();assert.equal(calls,1);const knowledge=(await f.store.list('knowledge'))[0];assert.equal(knowledge.citations[0].url,'https://example.com/reference');assert.ok(Number.isFinite(Date.parse(knowledge.retrievedAt)));}finally{await ai.shutdown();await f.close();}
});
test('reverse proxy HTTPS origins work only with explicit trusted-proxy configuration',async()=>{
 const f=await fixture();const previous=process.env.CAPRI_TRUST_PROXY;process.env.CAPRI_TRUST_PROXY='loopback';const {app}=await createService({store:f.store,adminToken:'test-admin-not-a-real-secret',key:()=>undefined});
 try{assert.equal((await app.inject({method:'POST',url:'/v1/records/plan',headers:{...auth,host:'capri.example.com',origin:'https://capri.example.com','x-forwarded-proto':'https'},payload:{title:'A plan behind HTTPS'}})).statusCode,200);assert.equal((await app.inject({method:'POST',url:'/v1/records/plan',headers:{...auth,host:'capri.example.com',origin:'https://untrusted.example','x-forwarded-proto':'https'},payload:{title:'Blocked cross-origin request'}})).statusCode,403);assert.equal((await app.inject({method:'POST',url:'/v1/records/plan',remoteAddress:'203.0.113.4',headers:{...auth,host:'capri.example.com',origin:'https://capri.example.com','x-forwarded-proto':'https'},payload:{title:'Untrusted proxy refused'}})).statusCode,403);}finally{await app.close();previous===undefined?delete process.env.CAPRI_TRUST_PROXY:process.env.CAPRI_TRUST_PROXY=previous;await rm(f.dir,{recursive:true,force:true});}
});

const taskDone=(text='Saved the requested result.')=>({output:[{type:'message',content:[{type:'output_text',text}]}]});
const taskCall=(name:string,args:any,id=name)=>({output:[{type:'function_call',name,arguments:JSON.stringify(args),call_id:id}]});
async function skillService(localContext=true,restoredTask?:{id:string;text:string;status:string;privateSession:boolean},command?:typeof commandProcess){
 const f=await fixture(),events:any[]=[],grants:unknown[]=[];let writes=0,copies=0;
 const workspace=path.join(f.dir,'workspace');await mkdir(workspace);const root=await realpath(workspace);
 const config={...defaults,id:'main',providerMode:'local' as const,initiative:false,roots:[root]};await f.store.put('settings',config);
 if(restoredTask)await f.store.put('task',restoredTask);
 const extensions=defaultExtensionSettings();extensions.skills.enabled=true;await f.store.put(hubRecordKinds.settings,{id:'main',schemaVersion:1,settings:extensions});
 const host=new HostTools(f.store,async()=>config,async()=>true,async()=>{throw Error('No native operations in this fixture.');},{command:command??(async(_executable,_args,_cwd,signal)=>{
  signal.throwIfAborted();copies++;await copyFile(path.join(root,'source.txt'),path.join(root,'copy.txt'));return {code:0,output:'Fake command completed.',untrusted:true};
 })});
 const service=await createService({store:f.store,adminToken:'test-admin-not-a-real-secret',key:()=>undefined,onEvent:event=>events.push(event),
  host:(name,args,signal,id)=>{if(name==='create_artifact')writes++;return host.run(name,args,signal,id);},
  taskLifecycle:(phase,task)=>{if(phase==='start'){host.begin(task.id,task.text);grants.push(host.access.get(task.id));}else if(phase==='end')host.end(task.id);},
  ...(localContext?{taskPermission:(id:string)=>host.access.get(id)}:{}),
  extensions:{profile:'self-test',skillFacts:async()=>resolveSkillHostFacts({capabilities:[{id:'artifacts',available:true},{id:'images',available:true},{id:'coding',available:true}],tools:['create_artifact','add_plan','update_plan','generate_image','read_file','list_files','write_file','run_command']})},
 });
 const ai=service.assistant;ai.router.available=async()=>true;
 const artifact={path:'memo.md',format:'md',title:'Memo',sections:[{heading:'Result',text:'Neutral service artifact.'}]};
 const submit=async(id:string,headers=auth)=>{const response=await service.app.inject({method:'POST',url:'/v1/chat',headers,payload:{id,text:'Hello Capri',private:false}});assert.equal(response.statusCode,200);return response;};
 return {...f,...service,host,events,grants,root,artifact,submit,writes:()=>writes,copies:()=>copies,
  close:async()=>{await service.app.close();host.close();await rm(f.dir,{recursive:true,force:true});}};
}

test('service without optional taskPermission retains authorized ordinary plan/artifact/image/copy producers without skill claims',async()=>{
 const f=await skillService(false);try{
  await writeFile(path.join(f.root,'source.txt'),'Neutral copy source.');
  f.assistant.image=async prompt=>{const row=await f.store.put('attachment',{mime:'image/png',base64:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'),source:'fake-provider'});return {attachmentId:row.id,url:'/v1/attachments/'+row.id,prompt};};
  const responses=[taskCall('add_plan',{title:'Neutral plan',dueAt:''}),async()=>taskCall('update_plan',{id:(await f.store.list('plan'))[0].id,title:'Updated plan'}),
   taskCall('create_artifact',f.artifact),taskCall('generate_image',{prompt:'A neutral test image'}),
   taskCall('run_command',{command:"Copy-Item -LiteralPath 'source.txt' -Destination 'copy.txt'",target:'requested copy'}),taskDone()];
  f.assistant.call=async()=>{const next=responses.shift();return typeof next==='function'?next():next??taskDone();};
  await f.submit('optional-context');await f.assistant.jobs.get('optional-context');
  const task=await f.store.get('task','optional-context');assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,false);
  assert.equal((await f.store.list('plan'))[0].title,'Updated plan');assert.equal((await f.store.list('attachment')).length,1);
  assert.match(await readFile(path.join(f.root,'memo.md'),'utf8'),/Neutral service artifact/);
  assert.equal(await readFile(path.join(f.root,'copy.txt'),'utf8'),'Neutral copy source.');assert.equal(f.writes(),1);assert.equal(f.copies(),1);
  assert.deepEqual(await f.store.list(skillEvidenceKind),[]);assert.equal(f.events.some(event=>event.state==='success'&&event.taskVerified===true),false);
  await assert.rejects(f.assistant.tool('extension_status',{},new AbortController().signal,false,'optional-context'),/no longer active/);
  await assert.rejects(f.host.run('read_file',{path:'source.txt'},new AbortController().signal,'ungranted'),/authorization|permissions/i);
 }finally{await f.close();}
});

test('real service preserves ordinary letter, comparison table and code answers without file obligations',async()=>{
 for(const text of ['Write a letter to my landlord','Make a table comparing X and Y','Write a Python script that sorts a list']){
  const f=await skillService();try{
   const answer='Useful chat draft for '+text;let turns=0;f.assistant.call=async()=>{turns++;return taskDone(answer);};
   assert.equal((await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'ordinary-draft',text,private:false}})).statusCode,200);
   await f.assistant.jobs.get('ordinary-draft');const task=await f.store.get('task','ordinary-draft');
   assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,false);assert.equal(task?.result,answer);assert.equal(turns,1);
   assert.equal((await f.store.list('message')).find(row=>row.role==='assistant')?.text,answer);
   assert.equal(f.events.filter(event=>event.type==='message'&&event.message.text===answer).length,1);
   assert.equal(f.writes(),0);assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
  }finally{await f.close();}
 }
});

test('skills-enabled service saves ordinary text and edits notes once without coding commands or verified claims',async()=>{
 for(const [text,target,before] of [
  ['Write my shopping list to shoppinglist/list.txt','shoppinglist/list.txt',null],
  ['Edit notes.md to add milk','notes.md','Existing note.'],
  ['Save this to a file named list.txt','list.txt',null],
 ] as const){
  const f=await skillService();try{
   if(before!==null)await writeFile(path.join(f.root,target),before);
   let writes=0;const tool=f.assistant.tool.bind(f.assistant);f.assistant.tool=async(name,...args)=>{if(name==='write_file')writes++;return tool(name,...args);};
   const args={path:target,content:'Milk and bread.'},responses=[taskCall('write_file',args,'write-text'),taskCall('write_file',args,'cached-text'),taskCall('read_file',{path:target}),taskDone('Saved your text.')];
   f.assistant.call=async()=>responses.shift()??taskDone();
   assert.equal((await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'ordinary-file',text,private:false}})).statusCode,200);
   await f.assistant.jobs.get('ordinary-file');const task=await f.store.get('task','ordinary-file');
   assert.equal(task?.status,'completed',text);assert.equal(task?.taskVerified,false);assert.equal(writes,1);assert.equal(f.copies(),0);
   assert.equal(await readFile(path.join(f.root,target),'utf8'),args.content);assert.equal((await f.store.list('backup'))[0].before,before);
   assert.deepEqual(await f.store.list(skillEvidenceKind),[]);assert.equal((await f.store.list(fileWriteEvidenceKind)).length,1);
   assert.equal(f.events.some(event=>event.taskVerified===true||event.message?.taskVerified===true),false);
   if(before===null)assert.match(task?.result,/restore_file cannot remove/);
  }finally{await f.close();}
 }
});

test('service returns unsupported toolchain answers unverified while available saved-output checks still gate completion',async()=>{
 for(const mode of ['ordinary','missing-output','forged-output','valid-output'] as const){
  const f=await skillService();try{
   if(mode==='forged-output')f.assistant.tool=async()=>({verified:true,passed:true,sha256:'a'.repeat(64)});
   const responses=[...(mode==='forged-output'||mode==='valid-output'?[taskCall('create_artifact',f.artifact)]:[]),taskDone('Useful Ruby repair draft; the tests still need to be run.')];
   f.assistant.call=async()=>responses.shift()??taskDone();
   const text='Fix the Ruby project and run tests'+(mode==='ordinary'?'':' and save a markdown document');
   await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'unsupported-toolchain',text,private:false}});
   await f.assistant.jobs.get('unsupported-toolchain');const task=await f.store.get('task','unsupported-toolchain');
   assert.equal(task?.status,mode==='ordinary'||mode==='valid-output'?'completed':'paused',mode);assert.equal(task?.taskVerified,false);assert.equal(f.copies(),0);
   assert.equal(f.events.some(event=>event.taskVerified===true||event.message?.taskVerified===true),false);
   if(task?.status==='completed'){
    assert.match(task.result,/Task unverified/);assert.match(task.result,/unavailable for ruby/);
    const message=(await f.store.list('message')).find(row=>row.role==='assistant');assert.equal(message?.text,task.result);assert.deepEqual(message?.verifierReasons,task.verifierReasons);
   }else assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
  }finally{await f.close();}
 }
});

test('service saves standalone Python scripts and SQL queries with real readback, no command, and explicit limitations',async()=>{
 for(const [text,target,content] of [
  ['Save a hello-world Python script to hello.py','hello.py','print("Hello world")\n'],
  ['Write a SQL query and save it to queries.sql','queries.sql','SELECT 1 AS value;\n'],
 ] as const)for(const before of [null,'Prior source.']){
  const f=await skillService();try{
   if(before!==null)await writeFile(path.join(f.root,target),before);
   let writes=0,commands=0;const tool=f.assistant.tool.bind(f.assistant);
   f.assistant.tool=async(name,...args)=>{if(name==='write_file')writes++;if(name==='run_command')commands++;return tool(name,...args);};
   const args={path:target,content},responses=[taskCall('write_file',args,'standalone-save'),taskCall('write_file',args,'cached-save'),taskDone('Saved the source.')];
   f.assistant.call=async()=>responses.shift()??taskDone();
   assert.equal((await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'standalone-source',text,private:false}})).statusCode,200);
   await f.assistant.jobs.get('standalone-source');const task=await f.store.get('task','standalone-source');
   assert.equal(task?.status,'completed',text);assert.equal(task?.taskVerified,false);assert.equal(writes,1);assert.equal(commands,0);
   assert.equal(await readFile(path.join(f.root,target),'utf8'),content);assert.equal((await f.store.list('backup'))[0].before,before);
   const [row]=await f.store.list(fileWriteEvidenceKind);assert.equal(row.receipt.binding.taskId,'standalone-source');assert.equal(row.receipt.path,path.join(f.root,target));
   assert.deepEqual(await f.store.list(skillEvidenceKind),[]);assert.match(task?.result,/Task unverified/);assert.match(task?.result,/program\/query behavior and project build\/test outcomes were not verified/);
   assert.deepEqual((await f.store.list('message')).find(row=>row.role==='assistant')?.verifierReasons,task?.verifierReasons);
   assert.equal(f.events.some(event=>event.taskVerified===true||event.message?.taskVerified===true),false);
   if(before===null)assert.match(task?.result,/restore_file cannot remove/);
  }finally{await f.close();}
 }
});

test('service cannot finish an explicitly saved standalone script from model text alone',async()=>{
 const f=await skillService();try{
  f.assistant.call=async()=>taskDone('print("Hello world")');
  await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'missing-script',text:'Write a Python script and save it as hello.py',private:false}});
  await f.assistant.jobs.get('missing-script');const task=await f.store.get('task','missing-script');
  assert.equal(task?.status,'paused');assert.equal(task?.taskVerified,false);assert.match(task?.error,/saved output.*read-back proof/);
  assert.equal(task?.checkpoint.finalResponse.output[0].content[0].text,'print("Hello world")');assert.deepEqual(await f.store.list(fileWriteEvidenceKind),[]);
  assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
 }finally{await f.close();}
});

test('incidental scratch writes may be renamed, removed or changed by a later task command without gating an honest answer',async()=>{
 for(const operation of ['rename','delete','modify'] as const){
  let commands=0;const f=await skillService(true,undefined,async(_exe,_args,cwd,signal)=>{
   signal.throwIfAborted();commands++;
   if(operation==='rename')await rename(path.join(cwd,'scratch.txt'),path.join(cwd,'final.txt'));
   else if(operation==='delete')await rm(path.join(cwd,'scratch.txt'));
   else await writeFile(path.join(cwd,'scratch.txt'),'Later command bytes.');
   return {code:0,output:'Untrusted command output claims success and SHA256 '+ '0'.repeat(64),untrusted:true};
  });try{
   const args={path:'scratch.txt',content:'Temporary bytes.'};let original:any;
   // This command has no fixed verifier. Its successful exit must not invent a
   // proof for the changed scratch file, or prevent useful unverified completion.
   const responses=[taskCall('write_file',args,'scratch-write'),async()=>{
    original=(await f.store.list(fileWriteEvidenceKind))[0].receipt;
    return taskCall('run_command',{command:'node process-scratch.js',target:'temporary task work'},'scratch-command');
   },taskDone('The scratch work is finished; its final contents have not been verified.')];
   f.assistant.call=async()=>{const next=responses.shift();return typeof next==='function'?next():next??taskDone();};
   await f.submit('incidental-scratch');await f.assistant.jobs.get('incidental-scratch');const task=await f.store.get('task','incidental-scratch');
   assert.equal(task?.status,'completed',operation);assert.equal(task?.taskVerified,false);assert.equal(commands,1);
   assert.match(task?.result,/Incidental file write proof is missing, changed or unavailable/);assert.match(task?.result,/restorable backups are not verified/);
   assert.deepEqual((await f.store.list(fileWriteEvidenceKind)).map(row=>row.receipt),[original]);assert.equal(original.callId,'scratch-write');
   assert.equal((await f.store.list('backup')).length,1);assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
   assert.equal(f.events.some(event=>event.taskVerified===true||event.message?.taskVerified===true),false);
   if(operation==='rename')assert.equal(await readFile(path.join(f.root,'final.txt'),'utf8'),args.content);
   if(operation==='delete')await assert.rejects(readFile(path.join(f.root,'scratch.txt')), {code:'ENOENT'});
   if(operation==='modify')assert.equal(await readFile(path.join(f.root,'scratch.txt'),'utf8'),'Later command bytes.');
  }finally{await f.close();}
 }
});

test('a declined or unwitnessable incidental write preserves another successful workflow with explicit unverified limitations',async()=>{
 for(const mode of ['declined','unwitnessable'] as const)for(const workflow of ['plan','artifact','direct'] as const){
  const f=await skillService();try{
   const run=f.host.run.bind(f.host);let writes=0;
   f.host.run=async(name,args,signal,id)=>{
    if(name==='write_file'&&args.path==='scratch.txt'){writes++;if(mode==='declined')throw new NoSideEffectError('You declined this action.',403);
     // Simulate a legacy host effect whose read-back witness is unavailable.
     await writeFile(path.join(f.root,'scratch.txt'),args.content);return {path:path.join(f.root,'scratch.txt'),verified:false};}
    return run(name,args,signal,id);
   };
   const responses=[workflow==='plan'?taskCall('add_plan',{title:'Useful saved plan',dueAt:''},'successful-plan'):workflow==='artifact'?taskCall('create_artifact',f.artifact,'successful-artifact'):taskCall('write_file',{path:'answer.txt',content:'Requested bytes.'},'successful-direct'),taskCall('write_file',{path:'scratch.txt',content:'Temporary.'},'incidental-write'),taskDone('The requested output was saved. Scratch output could not be verified.')];
   f.assistant.call=async()=>responses.shift()??taskDone();
   if(workflow==='plan')await f.submit('incidental-limited');else await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'incidental-limited',text:workflow==='artifact'?'Save a markdown document':'Save this to a file named answer.txt',private:false}});
   await f.assistant.jobs.get('incidental-limited');
   const task=await f.store.get('task','incidental-limited');assert.equal(task?.status,'completed',mode);assert.equal(task?.taskVerified,false);assert.equal(writes,1);
   if(workflow==='direct'){assert.equal(await readFile(path.join(f.root,'answer.txt'),'utf8'),'Requested bytes.');assert.deepEqual(await f.store.list(skillEvidenceKind),[]);}
   else{assert.equal((await f.store.list(workflow==='plan'?'plan':'artifact')).length,1);assert.equal((await f.store.list(skillEvidenceKind))[0].receipt.check,workflow==='plan'?'plan-record':'artifact-readback');}
   assert.equal((await f.store.list(fileWriteEvidenceKind)).length,workflow==='direct'?1:0);assert.match(task?.result,/Incidental file write proof is missing, changed or unavailable/);
   assert.equal(task?.evidence.sideEffectsUncertain,false);assert.equal(task?.evidence.toolsSucceeded[workflow==='plan'?'add_plan':workflow==='artifact'?'create_artifact':'write_file'],workflow==='direct'&&mode==='unwitnessable'?2:1);
   assert.equal(f.events.some(event=>event.taskVerified===true||event.message?.taskVerified===true),false);
  }finally{await f.close();}
 }
});

test('requested direct outputs reconcile fixed task-owned move, delete and modification observations without replacing original receipts',async()=>{
 for(const operation of ['move','remove','modify'] as const){
  let commands=0;const command=operation==='move'?"Move-Item -LiteralPath 'scratch.txt' -Destination 'final.txt'":operation==='remove'?"Remove-Item -LiteralPath 'scratch.txt'":"Set-Content -LiteralPath 'scratch.txt' -Value 'Final bytes.' -NoNewline -Encoding utf8";
  const f=await skillService(true,undefined,async(_exe,args,cwd,signal)=>{
   signal.throwIfAborted();assert.equal(args.at(-1),command);commands++;
   if(operation==='move')await rename(path.join(cwd,'scratch.txt'),path.join(cwd,'final.txt'));
   else if(operation==='remove')await rm(path.join(cwd,'scratch.txt'));
   else await writeFile(path.join(cwd,'scratch.txt'),'Final bytes.');
   return {code:0,output:'Command returned.',untrusted:true};
  });try{
   let original:any;const args={path:'scratch.txt',content:'Original bytes.'};
   const responses=[taskCall('write_file',args,'original-write'),async()=>{original=(await f.store.list(fileWriteEvidenceKind))[0].receipt;
    return taskCall('run_command',{command,target:'requested output follow-up'},'observed-followup');},taskDone('Requested output workflow observed.')];
   f.assistant.call=async()=>{const next=responses.shift();return typeof next==='function'?next():next??taskDone();};
   const text='Save this to a file named scratch.txt and then '+(operation==='move'?'move it to final.txt':operation==='remove'?'remove scratch.txt':'change it to Final bytes.');
   await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'followup-output',text,private:false}});await f.assistant.jobs.get('followup-output');
   const task=await f.store.get('task','followup-output');assert.equal(task?.status,'completed',operation);assert.equal(task?.taskVerified,false);assert.equal(commands,1);
   const receipts=(await f.store.list(fileWriteEvidenceKind)).map(row=>row.receipt);assert.equal(receipts.length,2);
   assert.deepEqual(receipts.find(receipt=>receipt.id===original.id),original);const effect=receipts.find(receipt=>receipt.id!==original.id);
   assert.equal(effect.callId,'observed-followup');assert.deepEqual(effect.binding,original.binding);
   assert.deepEqual(effect.effect,{operation,previousId:original.id,fromPath:original.path});
   assert.match(task?.result,/task-bound before\/after observations/);assert.match(task?.result,/not a restorable backup of the final state/);
   assert.equal(f.events.some(event=>event.taskVerified===true||event.message?.taskVerified===true),false);
  }finally{await f.close();}
 }
});

test('a named requested output gates its own receipt while changed scratch writes remain an unverified limitation',async()=>{
 for(const saved of [false,true])for(const mixed of [false,true]){
  const f=await skillService();try{
   const responses=[...(mixed?[taskCall('create_artifact',f.artifact,'requested-memo')]:[]),taskCall('write_file',{path:'scratch.txt',content:'Temporary bytes.'},'scratch-write'),
    ...(saved?[taskCall('write_file',{path:'answer.txt',content:'Requested output.'},'answer-write')]:[]),async()=>{
     await rm(path.join(f.root,'scratch.txt'));return taskDone('Answer draft; scratch proof is unavailable.');
    }];
   f.assistant.call=async()=>{const next=responses.shift();return typeof next==='function'?next():next??taskDone();};
   await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'named-output',text:'Save this to a file named answer.txt'+(mixed?' and save a markdown document named memo.md':''),private:false}});await f.assistant.jobs.get('named-output');
   const task=await f.store.get('task','named-output');assert.equal(task?.status,saved?'completed':'paused');assert.equal(task?.taskVerified,false);
   assert.equal((await f.store.list(fileWriteEvidenceKind)).length,saved?2:1);
   if(saved){assert.match(task?.result,/Incidental file write proof/);assert.equal(await readFile(path.join(f.root,'answer.txt'),'utf8'),'Requested output.');}
   else{assert.match(task?.error,/read-back proof/);assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);}
  }finally{await f.close();}
 }
});

test('service Resume reuses original write and observed follow-up receipts without replaying either effect',async()=>{
 let commands=0;const command="Move-Item -LiteralPath 'scratch.txt' -Destination 'final.txt'";
 const f=await skillService(true,undefined,async(_exe,args,cwd,signal)=>{
  signal.throwIfAborted();assert.equal(args.at(-1),command);commands++;await rename(path.join(cwd,'scratch.txt'),path.join(cwd,'final.txt'));return {code:0,output:'Move returned.',untrusted:true};
 });try{
  const args={path:'scratch.txt',content:'Saved bytes.'},commandArgs={command,target:'requested output move'};let turns=0;
  f.assistant.call=async()=>++turns===1?taskCall('write_file',args,'original-write'):turns===2?taskCall('run_command',commandArgs,'original-move'):(f.assistant.pause('followup-resume'),taskDone('Paused draft.'));
  await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'followup-resume',text:'Save this to a file named scratch.txt and move it to final.txt',private:false}});await f.assistant.jobs.get('followup-resume');
  const before=await f.store.get('task','followup-resume');assert.equal(before?.status,'paused');const original=before?.checkpoint.fileWrites.receipts;
  assert.equal(original.length,2);assert.equal(commands,1);const responses=[taskCall('write_file',args,'cached-write'),taskCall('run_command',commandArgs,'cached-move'),taskDone('Saved output reconciled.')];
  f.assistant.call=async()=>responses.shift()??taskDone();
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/followup-resume/resume',headers:auth})).statusCode,200);await f.assistant.jobs.get('followup-resume');
  const task=await f.store.get('task','followup-resume');assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,false);assert.equal(commands,1);
  assert.equal((await f.store.list('backup')).length,1);assert.deepEqual((await f.store.list(fileWriteEvidenceKind)).map(row=>row.receipt).sort((a,b)=>a.id.localeCompare(b.id)),[...original].sort((a,b)=>a.id.localeCompare(b.id)));
  assert.equal(await readFile(path.join(f.root,'final.txt'),'utf8'),args.content);assert.match(task?.result,/not a restorable backup of the final state/);
 }finally{await f.close();}
});

test('required saved output rejects unrelated exits, unobserved changes, failed writes and uncertain incidental effects',async()=>{
 for(const mode of ['unrelated-exit','unobserved-change','failed-write','uncertain-incidental','failed-followup','unobserved-followup'] as const){
  const f=await skillService(true,undefined,async()=>({code:mode==='failed-followup'?1:0,output:'Claimed SHA256 '+ '0'.repeat(64),untrusted:true}));try{
   const tool=f.assistant.tool.bind(f.assistant);f.assistant.tool=async(name,...args)=>{
    if(name==='write_file'&&mode==='failed-write')throw new NoSideEffectError('Write declined.',403);
    if(name==='write_file'&&mode==='uncertain-incidental')return {error:'Write outcome unknown.',uncertain:true};return tool(name,...args);
   };
   const responses=[taskCall('remember',{text:'Useful neutral note.',source:'User-provided neutral fixture note.',category:'fact'},'other-success'),taskCall('write_file',{path:'list.txt',content:'Required bytes.'},'requested-write'),async()=>{
    if(mode==='unobserved-change')await writeFile(path.join(f.root,'list.txt'),'Changed outside the host producer.');
    return taskCall('run_command',{command:mode==='unrelated-exit'?"Move-Item -LiteralPath 'list.txt' -Destination 'final.txt'":mode.endsWith('followup')?"Remove-Item -LiteralPath 'list.txt'":'node unrelated.js',target:'declared target'},'bare-exit');
   },taskDone('Done.')];
   f.assistant.call=async()=>{const next=responses.shift();return typeof next==='function'?next():next??taskDone();};
   const text=mode==='uncertain-incidental'?'Hello Capri':'Save this to a file named list.txt'+(mode.endsWith('followup')?' and then remove list.txt':'');
   // In the unrelated-exit case the requested move never happens. Change the
   // required source too, so the original write cannot satisfy final readback.
   if(mode==='unrelated-exit'){const command=f.host.run.bind(f.host);f.host.run=async(name,args,signal,id)=>{const result=await command(name,args,signal,id);if(name==='run_command')await rm(path.join(f.root,'list.txt'));return result;};}
   await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'required-negative',text,private:false}});await f.assistant.jobs.get('required-negative');
   const task=await f.store.get('task','required-negative');assert.equal(task?.status,'paused',mode);assert.equal(task?.taskVerified,false);
   assert.ok(task?.checkpoint.finalResponse);assert.equal((await f.store.list('memory')).length,1);
   assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
   assert.equal((await f.store.list(fileWriteEvidenceKind)).some(row=>row.receipt.effect),false);
  }finally{await f.close();}
 }
});

test('service coding writes require both correlated build and test exits, including honest new-file handling',async()=>{
 for(const [isNew,testExit] of [[false,0],[false,1],[true,0]] as const){
  const commands:string[]=[];
  const f=await skillService(true,undefined,async(_exe,args,_cwd,signal)=>{signal.throwIfAborted();const command=String(args.at(-1));commands.push(command);return {code:command==='npm test'?testExit:0,output:'Fake project command receipt.',untrusted:true};});
  try{
   if(!isNew)await writeFile(path.join(f.root,'code.ts'),'export const before = 1;');
   const responses=[taskCall('write_file',{path:'code.ts',content:'export const after = 2;'},'write-code'),taskCall('run_command',{command:'npm run build',target:'selected project'},'build-code'),taskCall('run_command',{command:'npm test',target:'selected project'},'test-code'),taskDone('Code saved; project receipts recorded.')];
   f.assistant.call=async()=>responses.shift()??taskDone();
   await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'code-project',text:'Fix the TypeScript project and run build and run tests',private:false}});
   await f.assistant.jobs.get('code-project');const task=await f.store.get('task','code-project');
   assert.equal(task?.status,testExit===0?'completed':'paused');assert.equal(task?.taskVerified,testExit===0);assert.deepEqual(commands,['npm run build','npm test']);
   const receipt=(await f.store.list(skillEvidenceKind)).find(row=>row.receipt.check==='file-backup')!.receipt;
   assert.equal(receipt.proof.priorState,isNew?'absent':'present');
   if(isNew){assert.equal((await f.store.list('backup'))[0].before,null);assert.match(task?.result,/no prior bytes/i);}
   if(testExit!==0){assert.match(task?.error,/command-exit-status/);assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);}
  }finally{await f.close();}
 }
});

test('service treats Go ahead as ordinary phrasing while explicit Go projects require matching commands',async()=>{
 for(const [text,commands,complete] of [
  ['Go ahead and fix the project and run the tests',['npm test','npm run build'],true],
  ['Go ahead and fix the project and run the tests and run build',['npm test','npm run build'],true],
  ['Go ahead and fix the project and run the tests and run build',['npm test'],false],
  ['Go ahead and fix the project and run the tests and run build',['npm run build'],false],
  ['Fix the Go project and run build and run tests',['npm test','npm run build'],false],
  ['Fix the Go project and run build and run tests',['go test ./...','go build ./...'],true],
 ] as const){
  const observed:string[]=[];
  const f=await skillService(true,undefined,async(_exe,args,_cwd,signal)=>{signal.throwIfAborted();observed.push(String(args.at(-1)));return {code:0,output:'Fake project command receipt.',untrusted:true};});
  try{
   await writeFile(path.join(f.root,'code.txt'),'Prior source.');
   const responses=[taskCall('write_file',{path:'code.txt',content:'Updated source.'}),...commands.map((command,index)=>taskCall('run_command',{command,target:'selected project'},'project-command-'+index)),taskDone('Project command results recorded.')];
   f.assistant.call=async()=>responses.shift()??taskDone();
   await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'project-toolchain',text,private:false}});
   await f.assistant.jobs.get('project-toolchain');const task=await f.store.get('task','project-toolchain');
   assert.deepEqual(observed,commands);assert.equal(task?.status,complete?'completed':'paused',text+' '+commands.join(', '));assert.equal(task?.taskVerified,complete);
   if(!complete){assert.match(task?.error,/command-exit-status/);assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);}
  }finally{await f.close();}
 }
});

test('real service retains a saved-file checkpoint draft and ordinary Resume can finish its missing work',async()=>{
 const f=await skillService();try{
  const answer='The useful letter text is retained even though the file is missing.';let turns=0;
  f.assistant.call=async()=>{turns++;return taskDone(answer);};
  await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'missing-file',text:'Save a markdown document containing my letter',private:false}});
  await f.assistant.jobs.get('missing-file');const task=await f.store.get('task','missing-file');
  assert.equal(task?.status,'paused');assert.equal(task?.taskVerified,false);assert.match(task?.error,/artifact-readback/);
  assert.equal(task?.checkpoint.finalResponse.output[0].content[0].text,answer);
  assert.ok(task?.checkpoint.input.some((item:any)=>item.type==='message'&&item.content?.[0]?.text===answer));
  assert.equal((await f.store.list('message')).some(row=>row.role==='assistant'),false);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/missing-file/resume',headers:auth})).statusCode,200);await f.assistant.jobs.get('missing-file');
  assert.equal(turns,2);assert.equal(f.writes(),0);assert.equal((await f.store.get('task','missing-file'))?.status,'paused');
  assert.equal((await f.store.list('message')).filter(row=>row.role==='assistant').length,0);
  assert.equal(f.events.filter(event=>event.type==='message').length,0);assert.equal(f.events.some(event=>event.state==='success'||event.type==='notice'),false);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/missing-file/resume',headers:auth,payload:{continueWork:'true',taskVerified:true}})).statusCode,400);
  assert.equal(turns,2);assert.equal(f.writes(),0);
  let step=0;f.assistant.call=async()=>++step===1?taskCall('create_artifact',f.artifact):taskDone(answer);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/missing-file/resume',headers:auth})).statusCode,200);await f.assistant.jobs.get('missing-file');
  assert.equal((await f.store.get('task','missing-file'))?.taskVerified,true);assert.equal(f.writes(),1);
  const completed=(await f.store.list('message')).filter(row=>row.role==='assistant');assert.equal(completed.length,1);assert.equal(completed[0].text,answer);
  assert.equal(f.events.filter(event=>event.type==='message').length,1);
 }finally{await f.close();}
});

test('real service evidence-only recheck verifies the retained answer with the original receipt and a fresh grant',async()=>{
 const f=await skillService();try{
  const answer='Original final answer for the generated memo.';let original='';let turns=0;
  f.assistant.call=async()=>{if(++turns===1)return taskCall('create_artifact',f.artifact,'only-write');original=await readFile(path.join(f.root,'memo.md'),'utf8');await writeFile(path.join(f.root,'memo.md'),'External mismatch.');return taskDone(answer);};
  await f.submit('evidence-recheck');await f.assistant.jobs.get('evidence-recheck');
  const paused=await f.store.get('task','evidence-recheck');assert.equal(paused?.status,'paused');const receipt=paused?.checkpoint.skillExecution.receipts[0];
  assert.equal(paused?.checkpoint.finalResponse.output[0].content[0].text,answer);
  assert.equal((await f.store.list('message')).some(row=>row.role==='assistant'),false);
  assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
  await writeFile(path.join(f.root,'memo.md'),original);
  f.assistant.call=async()=>{turns++;throw Error('Verification recheck must not ask the model again.');};
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/evidence-recheck/resume',headers:auth})).statusCode,200);await f.assistant.jobs.get('evidence-recheck');
  const completed=await f.store.get('task','evidence-recheck');assert.equal(completed?.status,'completed');assert.equal(completed?.taskVerified,true);assert.equal(completed?.result,answer);
  assert.equal(turns,2);assert.equal(f.grants.length,2);assert.notEqual(f.grants[0],f.grants[1]);assert.equal(f.writes(),1);
  assert.deepEqual((await f.store.list(skillEvidenceKind))[0].receipt,receipt);assert.equal((await f.store.list(skillEvidenceKind)).length,1);
  const messages=(await f.store.list('message')).filter(row=>row.role==='assistant');assert.equal(messages.length,1);assert.equal(messages[0].text,answer);
 }finally{await f.close();}
});

test('real service private unverified drafts remain ephemeral and cannot resume or publish after a privacy boundary',async()=>{
 for(const late of [false,true]){
  const f=await skillService();try{
   const session=(await f.app.inject({method:'POST',url:'/v1/extensions/session',headers:auth,payload:{privateSession:true,revision:1}})).json();
   const answer='Private letter draft retained only in the owner session.';let turns=0;
   f.assistant.call=async()=>{turns++;if(late)await f.app.inject({method:'POST',url:'/v1/extensions/session',headers:auth,payload:{privateSession:false,revision:2}});return taskDone(answer);};
   assert.equal((await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'private-draft',text:'Save a markdown document',private:true,privacyEpoch:session.privacyEpoch}})).statusCode,200);
   await f.assistant.jobs.get('private-draft');
   assert.deepEqual(await f.store.list('message'),[]);assert.equal(JSON.stringify(await f.store.list('task')).includes(answer),false);
   assert.equal(f.events.some(event=>event.state==='success'),false);
   if(!late){
    assert.equal(f.assistant.privateCheckpoints.has('private-draft'),true);
    assert.equal((f.assistant.privateCheckpoints.get('private-draft') as any).finalResponse.output[0].content[0].text,answer);
    assert.equal(f.events.some(event=>event.type==='message'),false);
    assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/private-draft/resume',headers:auth})).statusCode,200);await f.assistant.jobs.get('private-draft');assert.equal(turns,2);
    await f.app.inject({method:'POST',url:'/v1/extensions/session',headers:auth,payload:{privateSession:false,revision:2}});
   }else assert.equal(f.events.some(event=>event.type==='message'),false);
   const emitted=f.events.filter(event=>event.type==='message').length;
   assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/private-draft/resume',headers:auth})).statusCode,409);
   assert.equal(f.assistant.privateCheckpoints.has('private-draft'),false);assert.equal(f.assistant.privateRequests.has('private-draft'),false);
   assert.equal(f.events.filter(event=>event.type==='message').length,emitted);assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
  }finally{await f.close();}
 }
});

async function pauseAfterArtifact(f:Awaited<ReturnType<typeof skillService>>,id:string,headers=auth){
 let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});let turn=0;
 f.assistant.call=async(_endpoint,_body,signal)=>{
  if(++turn===1)return taskCall('create_artifact',f.artifact,'original-write');
  entered();await new Promise<void>(resolve=>{if(signal!.aborted)resolve();else signal!.addEventListener('abort',()=>resolve(),{once:true});});signal!.throwIfAborted();return taskDone();
 };
 await f.submit(id,headers);await Promise.race([ready,f.assistant.jobs.get(id)!.then(()=>{throw Error('Task ended before the pause checkpoint.');})]);const oldGrant=f.host.access.get(id);assert.ok(oldGrant);
 const pause=await f.app.inject({method:'POST',url:`/v1/tasks/${id}/pause`,headers});assert.equal(pause.statusCode,200);await f.assistant.jobs.get(id);
 const task=await f.store.get('task',id);assert.equal(task?.status,'paused');assert.equal(task?.taskVerified,false);
 const receipt=task?.checkpoint.skillExecution.receipts[0];assert.ok(receipt?.id);assert.equal(receipt.callId,'original-write');
 assert.equal(f.host.access.get(id),undefined);assert.throws(()=>f.taskContext(id),/no longer active/);
 return {receipt,oldGrant};
}

async function openEvents(f:Awaited<ReturnType<typeof skillService>>){
 await f.app.ready();const ticket=await f.app.inject({method:'POST',url:'/v1/event-ticket',headers:auth,payload:{}});assert.equal(ticket.statusCode,200);
 let ready!:()=>void;const connected=new Promise<void>(resolve=>{ready=resolve;});
 const ws=await f.app.injectWS('/v1/events?ticket='+ticket.json().ticket,{}, {onInit:socket=>{
  socket.on('message',data=>{if(JSON.parse(String(data)).type==='ready')ready();});socket.on('close',ready);
 }});await connected;assert.equal(ws.readyState,1);return ws;
}
async function closeEvents(ws:Awaited<ReturnType<typeof openEvents>>){
 const closed=new Promise<void>(resolve=>ws.once('close',()=>resolve()));ws.close();await closed;await setImmediate();
}
async function syncPublic(f:Awaited<ReturnType<typeof skillService>>){
 // The real main panel performs this GET/POST on mount after reconnect.
 const current=(await f.app.inject({method:'GET',url:'/v1/extensions/session',headers:auth})).json();assert.equal(current.privateSession,false);
 const synced=await f.app.inject({method:'POST',url:'/v1/extensions/session',headers:auth,payload:{privateSession:false,revision:current.revision+1}});
 assert.equal(synced.statusCode,200);assert.equal(synced.json().privacyEpoch,current.privacyEpoch);
 const after=(await f.app.inject({method:'GET',url:'/v1/extensions/session',headers:auth})).json();assert.equal(after.revision,current.revision+1);
 return after;
}

test('real service pause/resume keeps authenticated session identity and original read-back receipt with fresh authorization and one write',async()=>{
 const f=await skillService();try{
  const initial=(await f.app.inject({method:'GET',url:'/v1/extensions/session',headers:auth})).json();
  const {receipt,oldGrant}=await pauseAfterArtifact(f,'same-session');assert.notEqual(receipt.binding.sessionEpoch,initial.privacyEpoch);
  let turn=0;f.assistant.call=async()=>++turn===1?taskCall('create_artifact',f.artifact,'cached-write'):taskDone();
  const resumed=await f.app.inject({method:'POST',url:'/v1/tasks/same-session/resume',headers:auth});assert.equal(resumed.statusCode,200);await f.assistant.jobs.get('same-session');
  const task=await f.store.get('task','same-session');assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,true);
  assert.equal(f.grants.length,2);assert.notEqual(f.grants[1],oldGrant);assert.equal(f.writes(),1);
  assert.match(await readFile(path.join(f.root,'memo.md'),'utf8'),/Neutral service artifact/);
  const rows=await f.store.list(skillEvidenceKind);assert.equal(rows.length,1);assert.deepEqual(rows[0].receipt,receipt);
  assert.equal((await f.store.list('artifact')).length,1);assert.equal(f.events.filter(event=>event.state==='success'&&event.taskVerified===true).length,1);
 }finally{await f.close();}
});

test('real service public pause/reconnect/mount/resume reuses the stored artifact receipt with fresh grants and no replay',{timeout:20000},async()=>{
 for(const reconnect of ['replacement','close'] as const){
  const f=await skillService();try{
   const first=await openEvents(f),initial=(await f.app.inject({method:'GET',url:'/v1/extensions/session',headers:auth})).json();
   const {receipt,oldGrant}=await pauseAfterArtifact(f,'public-reconnect');
   if(reconnect==='close')await closeEvents(first);
   const next=await openEvents(f),current=await syncPublic(f);assert.notEqual(current.privacyEpoch,initial.privacyEpoch);
   let turns=0;f.assistant.call=async()=>++turns===1?taskCall('create_artifact',f.artifact,'cached-after-reconnect'):taskDone();
   assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/public-reconnect/resume',headers:auth})).statusCode,200);await f.assistant.jobs.get('public-reconnect');
   const task=await f.store.get('task','public-reconnect');assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,true);
   assert.equal(f.grants.length,2);assert.notEqual(f.grants[1],oldGrant);assert.equal(f.writes(),1);
   assert.match(await readFile(path.join(f.root,'memo.md'),'utf8'),/Neutral service artifact/);assert.equal((await f.store.list('artifact')).length,1);
   const rows=await f.store.list(skillEvidenceKind);assert.equal(rows.length,1);assert.deepEqual(rows[0].receipt,receipt);
   assert.equal(f.events.filter(event=>event.state==='success'&&event.taskVerified===true).length,1);await closeEvents(next);
  }finally{await f.close();}
 }
});

test('real service keeps a running public artifact producer alive across event reconnect and public mount synchronization',{timeout:20000},async()=>{
 for(const reconnect of ['replacement','close'] as const){
  const f=await skillService();let release!:()=>void;const released=new Promise<void>(resolve=>{release=resolve;});
  try{
   const first=await openEvents(f);let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});let producerSignal:AbortSignal|undefined;
   const run=f.host.run.bind(f.host);f.host.run=async(name,args,signal,id)=>{
    if(name==='create_artifact'){producerSignal=signal;entered();await released;signal.throwIfAborted();}
    return run(name,args,signal,id);
   };
   let turns=0;f.assistant.call=async()=>++turns===1?taskCall('create_artifact',f.artifact,'held-write'):taskDone();
   await f.submit('running-reconnect');await Promise.race([ready,f.assistant.jobs.get('running-reconnect')!.then(()=>{throw Error('Task ended before producer dispatch.');})]);
   if(reconnect==='close')await closeEvents(first);
   const next=await openEvents(f);await syncPublic(f);assert.equal(producerSignal?.aborted,false);
   // Re-read the actual current Hub context too, so this checks its live resolver.
   assert.equal(f.hub.skillExecutionSignal(f.taskContext('running-reconnect')).aborted,false);
   release();await f.assistant.jobs.get('running-reconnect');
   const task=await f.store.get('task','running-reconnect');assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,true);
   assert.equal(f.writes(),1);assert.equal(f.grants.length,1);assert.match(await readFile(path.join(f.root,'memo.md'),'utf8'),/Neutral service artifact/);
   const rows=await f.store.list(skillEvidenceKind);assert.equal(rows.length,1);assert.equal(rows[0].receipt.callId,'held-write');assert.equal(rows[0].receipt.binding.taskId,'running-reconnect');
   assert.equal(f.events.filter(event=>event.state==='success'&&event.taskVerified===true).length,1);await closeEvents(next);
  }finally{release();await f.close();}
 }
});

test('real service still binds private producer identity and cancellation to its protected event session',{timeout:20000},async()=>{
 const f=await skillService();let release!:()=>void;const released=new Promise<void>(resolve=>{release=resolve;});
 try{
  const initial=(await f.app.inject({method:'POST',url:'/v1/extensions/session',headers:auth,payload:{privateSession:true,revision:1}})).json();
  await openEvents(f);let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});let producerSignal:AbortSignal|undefined;
  const run=f.host.run.bind(f.host);f.host.run=async(name,args,signal,id)=>{
   if(name==='create_artifact'){producerSignal=signal;entered();await released;signal.throwIfAborted();}
   return run(name,args,signal,id);
  };
  let turns=0;f.assistant.call=async()=>++turns===1?taskCall('create_artifact',f.artifact,'private-held-write'):taskDone();
  assert.equal((await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'private-reconnect',text:'Hello Capri',private:true,privacyEpoch:initial.privacyEpoch}})).statusCode,200);
  await Promise.race([ready,f.assistant.jobs.get('private-reconnect')!.then(()=>{throw Error('Task ended before private producer dispatch.');})]);
  const checkpoint=f.assistant.privateCheckpoints.get('private-reconnect') as (Checkpoint&{skillExecution?:SkillExecutionJournal})|undefined;
  assert.equal(checkpoint?.skillExecution?.bindings[0]?.sessionEpoch,initial.privacyEpoch);
  const next=await openEvents(f);assert.equal(producerSignal?.aborted,true);release();await f.assistant.jobs.get('private-reconnect');
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/private-reconnect/resume',headers:auth})).statusCode,409);
  assert.equal(f.assistant.privateCheckpoints.has('private-reconnect'),false);assert.equal((await f.store.list('artifact')).length,0);
  assert.deepEqual(await f.store.list(skillEvidenceKind),[]);assert.equal(f.events.some(event=>event.state==='success'),false);
  assert.notEqual((await f.store.get('task','private-reconnect'))?.status,'completed');await closeEvents(next);
 }finally{release();await f.close();}
});

test('real service privacy, Stop and owner retirement refuse old paused receipts without replay',async()=>{
 for(const boundary of ['privacy','privacy-roundtrip','stop','owner','phone-stop'] as const){
  const f=await skillService();try{
   const ownerToken='neutral-device-owner',deviceOwner=boundary==='owner'||boundary==='phone-stop',headers=deviceOwner?{authorization:'Bearer '+ownerToken}:auth;
   if(deviceOwner)await f.store.put('device',{id:hash(ownerToken),role:boundary==='phone-stop'?'phone':'desktop',revoked:false});
   const {receipt}=await pauseAfterArtifact(f,'ended-session',headers);
   if(boundary==='privacy'||boundary==='privacy-roundtrip')assert.equal((await f.app.inject({method:'POST',url:'/v1/extensions/session',headers,payload:{privateSession:true,revision:1}})).statusCode,200);
   if(boundary==='privacy-roundtrip')assert.equal((await f.app.inject({method:'POST',url:'/v1/extensions/session',headers,payload:{privateSession:false,revision:2}})).statusCode,200);
   if(boundary==='stop')assert.equal((await f.app.inject({method:'POST',url:'/v1/stop',headers})).statusCode,200);
   if(boundary==='phone-stop')assert.equal((await f.app.inject({method:'POST',url:'/v1/stop',headers})).statusCode,200);
   if(boundary==='owner')assert.equal((await f.app.inject({method:'DELETE',url:'/v1/devices/'+hash(ownerToken),headers:auth})).statusCode,200);
   let turns=0;f.assistant.call=async()=>{turns++;return taskCall('create_artifact',f.artifact,'must-not-dispatch');};
   const resumed=await f.app.inject({method:'POST',url:'/v1/tasks/ended-session/resume',headers:auth});assert.equal(resumed.statusCode,boundary==='privacy'?409:200);await f.assistant.jobs.get('ended-session');
   const task=await f.store.get('task','ended-session');assert.notEqual(task?.status,'completed',boundary);assert.equal(task?.taskVerified,false);
   if(boundary!=='privacy')assert.match(task?.error,/verification incomplete/i);
   assert.equal(turns,0);assert.equal(f.writes(),1);assert.equal(f.grants.length,boundary==='privacy'?1:2);
   assert.equal(task?.checkpoint.skillExecution.receipts[0].id,receipt.id);assert.deepEqual((await f.store.list(skillEvidenceKind))[0].receipt,receipt);
   assert.equal((await f.store.list('artifact')).length,1);assert.equal(f.events.some(event=>event.state==='success'),false);
  }finally{await f.close();}
 }
});

test('service observes active grant loss and cannot revive bound evidence with a new attempt grant',async()=>{
 const f=await skillService();try{
  let turn=0;f.assistant.call=async()=>{if(++turn===1)return taskCall('create_artifact',f.artifact);f.host.access.revoke('grant-loss');return taskDone();};
  await f.submit('grant-loss');await f.assistant.jobs.get('grant-loss');
  const paused=await f.store.get('task','grant-loss');assert.equal(paused?.status,'paused');assert.equal(paused?.taskVerified,false);
  const receipt=paused?.checkpoint.skillExecution.receipts[0];assert.ok(receipt?.id);
  let resumedTurns=0;f.assistant.call=async()=>{resumedTurns++;return taskDone();};
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/grant-loss/resume',headers:auth})).statusCode,200);await f.assistant.jobs.get('grant-loss');
  const task=await f.store.get('task','grant-loss');assert.notEqual(task?.status,'completed');assert.equal(task?.taskVerified,false);
  assert.equal(resumedTurns,0);assert.equal(f.grants.length,2);assert.equal(f.writes(),1);assert.match(task?.error,/verification incomplete/i);
  assert.equal(task?.checkpoint.skillExecution.receipts[0].id,receipt.id);assert.equal((await f.store.list('artifact')).length,1);
  assert.equal(f.events.some(event=>event.state==='success'),false);
 }finally{await f.close();}
});

async function publicBoundary(f:Awaited<ReturnType<typeof skillService>>,boundary:'stop'|'privacy'){
 if(boundary==='stop')assert.equal((await f.app.inject({method:'POST',url:'/v1/stop',headers:auth})).statusCode,200);
 else {
  const current=(await f.app.inject({method:'GET',url:'/v1/extensions/session',headers:auth})).json();
  assert.equal((await f.app.inject({method:'POST',url:'/v1/extensions/session',headers:auth,payload:{privateSession:true,revision:current.revision+1}})).statusCode,200);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/extensions/session',headers:auth,payload:{privateSession:false,revision:current.revision+2}})).statusCode,200);
 }
}

test('trusted public Resume reconciles ordinary text after Stop/privacy with original receipts and no write replay',async()=>{
 for(const boundary of ['stop','privacy'] as const){
  const f=await skillService();try{
   const args={path:'list.txt',content:'Milk.'};let turn=0;
   f.assistant.call=async()=>{if(++turn===1)return taskCall('write_file',args,'original-text');await writeFile(path.join(f.root,args.path),'External mismatch.');return taskDone('Saved text draft.');};
   await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'resumable-text',text:'Save this to a file named list.txt',private:false}});
   await f.assistant.jobs.get('resumable-text');const paused=await f.store.get('task','resumable-text');assert.equal(paused?.status,'paused');
   assert.equal(paused?.checkpoint.skillExecution.bindings.length,0);const receipt=paused?.checkpoint.fileWrites.receipts[0];assert.ok(receipt.id);
   await publicBoundary(f,boundary);await writeFile(path.join(f.root,args.path),args.content);let writes=0;
   const tool=f.assistant.tool.bind(f.assistant);f.assistant.tool=async(name,...values)=>{if(name==='write_file')writes++;return tool(name,...values);};
   let resumedTurn=0;f.assistant.call=async()=>++resumedTurn===1?taskCall('write_file',args,'cached-text'):taskDone('Text reconciled under the current grant.');
   assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/resumable-text/resume',headers:auth})).statusCode,200);
   await f.assistant.jobs.get('resumable-text');const completed=await f.store.get('task','resumable-text');
   assert.equal(completed?.status,'completed');assert.equal(completed?.taskVerified,false);assert.equal(writes,0);assert.equal((await f.store.list('backup')).length,1);
   assert.deepEqual((await f.store.list(fileWriteEvidenceKind))[0].receipt,receipt);assert.equal((await f.store.list(fileWriteEvidenceKind)).length,1);
  }finally{await f.close();}
 }
});

test('a fresh public Resume can finish missing direct writes with a new origin while retaining old receipts',async()=>{
 const f=await skillService();try{
  const args={path:'first.txt',content:'First saved effect.'};let turn=0;
  f.assistant.call=async()=>{if(++turn===1)return taskCall('write_file',args,'first-write');await writeFile(path.join(f.root,args.path),'External mismatch.');return taskDone('Saved draft.');};
  await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'remaining-text',text:'Save this to a file named first.txt',private:false}});
  await f.assistant.jobs.get('remaining-text');const before=await f.store.get('task','remaining-text'),original=before?.checkpoint.fileWrites.receipts[0];assert.equal(before?.status,'paused');
  await publicBoundary(f,'stop');await writeFile(path.join(f.root,args.path),args.content);
  const responses=[taskCall('write_file',args,'cached-first'),taskCall('write_file',{path:'second.txt',content:'Remaining saved effect.'},'remaining-write'),taskDone('Both files are present.')];
  f.assistant.call=async()=>responses.shift()??taskDone();
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/remaining-text/resume',headers:auth})).statusCode,200);await f.assistant.jobs.get('remaining-text');
  const task=await f.store.get('task','remaining-text');assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,false);assert.equal((await f.store.list('backup')).length,2);
  const receipts=(await f.store.list(fileWriteEvidenceKind)).map(row=>row.receipt);assert.equal(receipts.length,2);assert.deepEqual(receipts.find(receipt=>receipt.id===original.id),original);
  const fresh=receipts.find(receipt=>receipt.id!==original.id);assert.equal(fresh.callId,'remaining-write');assert.notEqual(fresh.binding.sessionEpoch,original.binding.sessionEpoch);assert.notEqual(fresh.binding.runId,original.binding.runId);
 }finally{await f.close();}
});

test('trusted public Resume after Stop or privacy round-trip reconciles ordinary tasks without replay, including optional-context services',async()=>{
 for(const localContext of [false,true])for(const boundary of ['stop','privacy'] as const){
  const f=await skillService(localContext);try{
   const id='ordinary-resume',args={text:'A neutral remembered preference.',source:'User request'};
   let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});let turns=0;
   let capturedGuard:(()=>void)|undefined;
   const chat=f.assistant.chat.bind(f.assistant);f.assistant.chat=(text,privateSession,requestedId,guard)=>{capturedGuard=guard;return chat(text,privateSession,requestedId,guard);};
   f.assistant.call=async(_endpoint,_body,signal)=>{
    if(++turns===1)return taskCall('remember',args,'original-memory');
    entered();await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));signal!.throwIfAborted();return taskDone();
   };
   await f.submit(id);await Promise.race([ready,f.assistant.jobs.get(id)!.then(()=>{throw Error('Ordinary task ended before pause.');})]);
   const oldContext=localContext?f.taskContext(id):undefined,oldSignal=oldContext?f.hub.skillExecutionSignal(oldContext):undefined;
   assert.equal((await f.app.inject({method:'POST',url:`/v1/tasks/${id}/pause`,headers:auth})).statusCode,200);await f.assistant.jobs.get(id);
   const paused=await f.store.get('task',id);assert.equal(paused?.status,'paused');assert.equal(paused?.checkpoint.skillExecution?.bindings.length??0,0);
   const executed=paused?.checkpoint.executed;assert.equal(executed.length,1);assert.equal((await f.store.list('memory')).length,1);
   await publicBoundary(f,boundary);
   // Duplicate submissions and a lifecycle-only resume cannot mint authority.
   assert.equal((await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id,text:'Hello Capri',private:false}})).statusCode,409);
   await f.assistant.resume(id);await f.assistant.jobs.get(id);assert.equal(turns,2);assert.notEqual((await f.store.get('task',id))?.status,'completed');
   assert.throws(()=>capturedGuard!(),/session ended/);
   let step=0;f.assistant.call=async()=>{
    assert.throws(()=>capturedGuard!(),/session ended/); // late old submission, after fresh origin exists
    if(oldContext)assert.throws(()=>f.hub.skillExecutionSignal(oldContext));
    return ++step===1?taskCall('remember',args,'cached-memory'):step===2?taskCall('read_file',{path:'source.txt'},'fresh-read'):taskDone('Reconciled public task.');
   };
   await writeFile(path.join(f.root,'source.txt'),'Fresh reconciliation evidence.');
   assert.equal((await f.app.inject({method:'POST',url:`/v1/tasks/${id}/resume`,headers:auth})).statusCode,200);await f.assistant.jobs.get(id);
   const done=await f.store.get('task',id);assert.equal(done?.status,'completed');assert.equal(done?.taskVerified,false);assert.equal(step,3);
   assert.equal((await f.store.list('memory')).length,1);assert.deepEqual((await f.store.list('memory'))[0].text,args.text);
   assert.equal(f.grants.length,2);assert.equal(oldSignal?.aborted,localContext?true:undefined);assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
   assert.equal(f.events.filter(event=>event.state==='success').length,1);
  }finally{await f.close();}
 }
});

test('trusted Resume preserves skill drafts and original evidence after real boundaries without upgrading or replaying them',async()=>{
 for(const boundary of ['stop','privacy'] as const){
  const f=await skillService();try{
   const answer='The memo draft needs artifact reconciliation.';let turns=0;
   f.assistant.call=async()=>{
    if(++turns===1)return taskCall('create_artifact',f.artifact,'original-effect');
    await writeFile(path.join(f.root,'memo.md'),'Changed externally.');return taskDone(answer);
   };
   await f.submit('bound-draft');await f.assistant.jobs.get('bound-draft');
   const before=await f.store.get('task','bound-draft');assert.equal(before?.status,'paused');const journal=before?.checkpoint.skillExecution;
   assert.equal(journal.receipts.length,1);assert.equal(before?.checkpoint.finalResponse.output[0].content[0].text,answer);
   await publicBoundary(f,boundary);
   f.assistant.call=async()=>{throw Error('Old binding must fail before model reconciliation or another producer.');};
   assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/bound-draft/resume',headers:auth})).statusCode,200);await f.assistant.jobs.get('bound-draft');
   const after=await f.store.get('task','bound-draft');assert.equal(after?.status,'paused');assert.equal(after?.taskVerified,false);assert.match(after?.error,/verification incomplete/i);
   assert.deepEqual(after?.checkpoint.skillExecution,journal);assert.deepEqual(after?.checkpoint.executed,before?.checkpoint.executed);
   assert.deepEqual(after?.checkpoint.finalResponse,before?.checkpoint.finalResponse);assert.deepEqual((await f.store.list(skillEvidenceKind))[0].receipt,journal.receipts[0]);
   assert.equal(f.grants.length,2);assert.equal(f.writes(),1);assert.equal(turns,2);assert.equal((await f.store.list('artifact')).length,1);
   assert.equal((await f.store.list('message')).some(row=>row.role==='assistant'),false);assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
  }finally{await f.close();}
 }
});

test('Resume waits for late old producer cleanup and never reauthorizes its aborted dispatch',async()=>{
 const f=await skillService();let release!:()=>void;const released=new Promise<void>(resolve=>{release=resolve;});
 try{
  let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});let oldSignal:AbortSignal|undefined;
  const run=f.host.run.bind(f.host);f.host.run=async(name,args,signal,id)=>{
   if(name==='create_artifact'){oldSignal=signal;entered();await released;signal.throwIfAborted();}
   return run(name,args,signal,id);
  };
  let turns=0;f.assistant.call=async()=>{turns++;return taskCall('create_artifact',f.artifact,'late-old-producer');};
  await f.submit('late-old');await Promise.race([ready,f.assistant.jobs.get('late-old')!.then(()=>{throw Error('Producer did not enter.');})]);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/late-old/pause',headers:auth})).statusCode,200);
  await publicBoundary(f,'stop');assert.equal(oldSignal?.aborted,true);
  const resumed=f.app.inject({method:'POST',url:'/v1/tasks/late-old/resume',headers:auth});await setImmediate();assert.equal(f.grants.length,1);
  release();assert.equal((await resumed).statusCode,200);await f.assistant.jobs.get('late-old');
  const task=await f.store.get('task','late-old');assert.equal(task?.status,'paused');assert.equal(task?.taskVerified,false);assert.match(task?.error,/verification incomplete/i);
  assert.equal(turns,1);assert.equal(f.grants.length,2);assert.equal(f.writes(),1);assert.equal(oldSignal?.aborted,true);
  assert.equal(task?.checkpoint.executed.length,1);assert.equal(task?.checkpoint.executed[0][1].uncertain,true);
  assert.equal(task?.checkpoint.skillExecution.receipts.length,0);assert.deepEqual(await f.store.list(skillEvidenceKind),[]);assert.deepEqual(await f.store.list('artifact'),[]);
  assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
 }finally{release();await f.close();}
});

test('a new Stop while trusted Resume saves its running record prevents dispatch and needs another explicit Resume',async()=>{
 const f=await skillService(false);let release!:()=>void;const released=new Promise<void>(resolve=>{release=resolve;});
 try{
  // Ordinary failure is resumable without any skill authority or proof.
  f.assistant.call=async()=>{throw Error('Initial neutral interruption.');};await f.submit('resume-race');await f.assistant.jobs.get('resume-race');
  await publicBoundary(f,'stop');let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  const put=f.store.put.bind(f.store);let hold=true;
  f.store.put=async(kind,row)=>{const result=await put(kind,row);if(hold&&kind==='task'&&row.id==='resume-race'&&row.status==='running'){hold=false;entered();await released;}return result;};
  let turns=0;f.assistant.call=async()=>{turns++;return taskDone('Fresh ordinary reconciliation.');};
  const pending=f.app.inject({method:'POST',url:'/v1/tasks/resume-race/resume',headers:auth});await ready;
  await publicBoundary(f,'stop');release();assert.equal((await pending).statusCode,409);assert.equal(turns,0);assert.equal(f.grants.length,1);
  assert.equal(f.assistant.controllers.has('resume-race'),false);assert.equal((await f.store.get('task','resume-race'))?.status,'paused');
  const phone='neutral-resume-phone',desktop='neutral-resume-desktop';await f.store.put('device',{id:hash(phone),role:'phone',revoked:false});await f.store.put('device',{id:hash(desktop),role:'desktop',revoked:true});
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/resume-race/resume',headers:{authorization:'Bearer '+phone}})).statusCode,403);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/resume-race/resume',headers:{authorization:'Bearer '+desktop}})).statusCode,401);
  assert.equal(turns,0);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/resume-race/resume',headers:auth})).statusCode,200);await f.assistant.jobs.get('resume-race');
  assert.equal((await f.store.get('task','resume-race'))?.status,'completed');assert.equal(turns,1);assert.equal(f.grants.length,2);
 }finally{release();await f.close();}
});

test('fresh public Resume binds ordinary cancellation to the resuming owner across device ownership and restored tasks',async()=>{
 for(const restored of [false,true])for(const localContext of [false,true]){
  const f=await skillService(localContext,restored?{id:'resumed-owner',text:'Hello Capri',status:'interrupted',privateSession:false}:undefined);try{
   const id='resumed-owner';
   // Restored records supply classification/work, never a live origin. The
   // alternate case retains the original device's submission audience.
   if(!restored){
    const token='neutral-first-desktop';await f.store.put('device',{id:hash(token),role:'desktop',revoked:false});
    f.assistant.call=async()=>{throw Error('Original attempt needs reconciliation.');};await f.submit(id,{authorization:'Bearer '+token});await f.assistant.jobs.get(id);
    await publicBoundary(f,'stop');
   }
   let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});let activeSignal:AbortSignal|undefined;
   f.assistant.call=async(_endpoint,_body,signal)=>{
    activeSignal=signal;entered();await new Promise<void>(resolve=>{if(signal!.aborted)resolve();else signal!.addEventListener('abort',()=>resolve(),{once:true});});
    signal!.throwIfAborted();return taskDone('This retired work must never publish.');
   };
   assert.equal((await f.app.inject({method:'POST',url:`/v1/tasks/${id}/resume`,headers:auth})).statusCode,200);
   await Promise.race([ready,f.assistant.jobs.get(id)!.then(()=>{throw Error('Resumed task did not start.');})]);assert.equal(activeSignal?.aborted,false);
   const current=(await f.app.inject({method:'GET',url:'/v1/extensions/session',headers:auth})).json();
   assert.equal((await f.app.inject({method:'POST',url:'/v1/extensions/session',headers:auth,payload:{privateSession:true,revision:current.revision+1}})).statusCode,200);
   assert.equal(activeSignal?.aborted,true);await f.assistant.jobs.get(id);
   assert.notEqual((await f.store.get('task',id))?.status,'completed');assert.equal((await f.store.list('message')).some(row=>row.role==='assistant'),false);
   assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
  }finally{await f.close();}
 }
});

test('explicit Resume never rebinds a retired private draft into public or a later private session',async()=>{
 const f=await skillService();try{
  const initial=(await f.app.inject({method:'POST',url:'/v1/extensions/session',headers:auth,payload:{privateSession:true,revision:1}})).json();
  let turns=0;f.assistant.call=async()=>{turns++;return taskDone('Private saved-file draft.');};
  assert.equal((await f.app.inject({method:'POST',url:'/v1/chat',headers:auth,payload:{id:'private-retired',text:'Save a markdown document',private:true,privacyEpoch:initial.privacyEpoch}})).statusCode,200);
  await f.assistant.jobs.get('private-retired');assert.equal(f.assistant.privateCheckpoints.has('private-retired'),true);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/extensions/session',headers:auth,payload:{privateSession:false,revision:2}})).statusCode,200);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/private-retired/resume',headers:auth})).statusCode,409);
  const next=(await f.app.inject({method:'POST',url:'/v1/extensions/session',headers:auth,payload:{privateSession:true,revision:3}})).json();assert.notEqual(next.privacyEpoch,initial.privacyEpoch);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/tasks/private-retired/resume',headers:auth})).statusCode,409);
  assert.equal(f.assistant.privateCheckpoints.has('private-retired'),false);assert.equal(f.assistant.privateRequests.has('private-retired'),false);
  assert.equal(turns,1);assert.equal(f.grants.length,1);assert.deepEqual(await f.store.list('message'),[]);assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
  assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
 }finally{await f.close();}
});
