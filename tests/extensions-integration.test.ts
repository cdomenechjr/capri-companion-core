import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ExtensionHub,createExtensionHub,ExtensionHubError,hubRecordKinds,stageAgentWorkspace,delegatedTextChanges,type ExtensionHubOptions,type HubHostContext,type HubContext} from '../src/extensions/hub';
import {ActionReceiptSchema,ExtensionStatusSchema,defaultExtensionSettings,type CursorStatus,type ExtensionAction,type ExtensionFeatureStatus} from '../src/extensions/contracts';
import {featureCapability,sha256} from '../src/extensions/policy';
import {skillRecordKinds,skillToolNames,skillManifest,SkillRecipeSchema} from '../src/extensions/skills';
import type {DefenderObservation} from '../src/extensions/security';
import {ContactsService,type ResolvedContact,type ContactChannelPolicy} from '../src/extensions/contacts';
import {reviewedContactBody,type ContactProvider} from '../src/extensions/contact-providers';
import {AgentLeasePool} from '../src/extensions/agent-lease';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/server/store';
import {createService,hash} from '../src/server/service';
import {LocalSpeech} from '../src/server/local-speech';
import {defaults,extensionToolDefinitions,dispatchVoicePresentation} from '../src/shared';
import {api,dispatchLocalVoiceEvent} from '../src/ui/api';

async function serviceFixture(extensions?:Omit<ExtensionHubOptions,'store'|'clock'>,speech?:LocalSpeech,extra:Partial<Parameters<typeof createService>[0]>={}){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'capri-extension-service-'));
 const store=await new Store(path.join(directory,'data'),randomBytes(32)).init();
 await store.put('settings',{...defaults,id:'main',providerMode:'local',initiative:false,localFallback:false});
 const service=await createService({store,adminToken:'neutral-admin',key:()=>undefined,extensions,speech,...extra});
 const headers={authorization:'Bearer neutral-admin'};
 return {directory,store,service,headers,close:async()=>{await service.app.close();fs.rmSync(directory,{recursive:true,force:true});}};
}

test('authenticated global Stop awaits the managed update owner and reports unresolved cleanup',async()=>{
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let stops=0;
 const f=await serviceFixture({profile:'development',updates:{feature:'updates',status:async()=>({feature:'updates',capability:featureCapability({enabled:true,configured:true,supported:true,ready:false,verification:'none'}),updates:{state:'current'}}),action:async()=>{throw Error('no operation');},stop:async()=>{stops++;entered();await waiting;},close:async()=>{}}});
 try{let complete=false;const response=f.service.app.inject({method:'POST',url:'/v1/stop',headers:f.headers,payload:{}}).then(r=>{complete=true;return r;});await started;assert.equal(complete,false);release();const result=await response;assert.equal(result.statusCode,200);assert.ok(stops>=1);assert.deepEqual(result.json().extensions.errors,[]);}finally{release();await f.close();}
});

test('authenticated service exposes typed extension controls but never accepts model authority or unsupported exact approvals',async()=>{
 const f=await serviceFixture();const {app}=f.service;
 try{
  assert.equal((await app.inject({method:'GET',url:'/v1/extensions/status'})).statusCode,401);
  await f.store.put('device',{id:hash('neutral-phone'),role:'phone',revoked:false});
  assert.equal((await app.inject({method:'GET',url:'/v1/extensions/status',headers:{authorization:'Bearer neutral-phone'}})).statusCode,403);
  const status=ExtensionStatusSchema.parse((await app.inject({method:'GET',url:'/v1/extensions/status',headers:f.headers})).json());
  assert.equal(status.features.agents.available,false);assert.equal(status.features.contacts.available,false);assert.equal(status.features.updates.available,false);
  const request=(feature:string,action:string,payload:any)=>app.inject({method:'POST',url:`/v1/extensions/${feature}/${action}`,headers:f.headers,payload});
  assert.equal((await request('agents','start',{requestId:'forged',authority:'task',approved:true,input:{}})).statusCode,400);
  assert.equal((await request('agents','grant',{requestId:'foreign-task',taskId:'nonexistent',input:{}})).statusCode,403);
  for(const action of ['approve','configure-gmail','configure-twilio','reconcile']){
   const response=await request('contacts',action,{requestId:'unsupported-'+action,input:{}});assert.equal(ActionReceiptSchema.parse(response.json()).error?.code,'unsupported');
  }
  assert.equal((await request('contacts','review-details',{requestId:'malformed-review',input:{}})).statusCode,400,'exact preview requires its authenticated session binding');
  const queued=await request('skills','draft',{requestId:'public-draft',input:draft});assert.equal(queued.json().outcome,'completed');
  const session=(await app.inject({method:'GET',url:'/v1/extensions/session',headers:f.headers})).json();
  await app.inject({method:'POST',url:'/v1/extensions/session',headers:f.headers,payload:{privateSession:true,revision:session.revision+1}});
  const privateDraft={...draft,id:'private-service-draft',name:'Private draft secret'};
  assert.equal((await request('skills','draft',{requestId:'private-draft',input:privateDraft})).json().outcome,'completed');
  assert.equal(JSON.stringify(await f.store.list(skillRecordKinds.draft)).includes('Private draft secret'),false);
  assert.equal(JSON.stringify(await f.store.export()).includes('private-service-draft'),false);
  assert.equal((await request('updates','check',{requestId:'private-update',input:{}})).json().error.code,'forbidden');
 }finally{await f.close();}
});

test('Codex setup routes retain trusted owner/privacy authority and never infer login from executable configuration',async()=>{
 const directory=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'capri-connection-service-'));
 const root=path.join(directory,'setup'),configDir=path.join(directory,'runtime-home');fs.mkdirSync(root);fs.mkdirSync(configDir);let saves=0,opens=0;
 const configuration={provider:'codex' as const,executable:process.execPath,model:'preserved-model',configDir,isolated:true as const};
 const options:Omit<ExtensionHubOptions,'store'|'clock'>={profile:'development',agents:{native:{controlRoot:path.join(directory,'control'),leases:new AgentLeasePool(),helperPath:path.join(directory,'missing.exe'),helperSha256:'0'.repeat(64)},
   resolveAuthority:async()=>({settings:defaultExtensionSettings(),privateSession:false,localOnly:false,configuration}),
   connection:{configuration:()=>configuration,save:async()=>{saves++;},workspace:{id:'setup',root,writable:false,excludedRoots:[configDir]},open:async()=>{opens++;}},
   providerStatus:async()=>[{provider:'codex',enabled:true,configured:true,ready:true}]}};
 const f=await serviceFixture(options);
 try{
  const get=(headers=f.headers)=>f.service.app.inject({method:'GET',url:'/v1/extensions/agents/connection',headers});
  assert.equal((await f.service.app.inject({method:'GET',url:'/v1/extensions/agents/connection'})).statusCode,401);
  await f.store.put('device',{id:hash('neutral-connection-phone'),role:'phone',revoked:false});assert.equal((await get({authorization:'Bearer neutral-connection-phone'})).statusCode,403);
  const state=await get();assert.equal(state.headers['cache-control'],'no-store');assert.equal(state.json().authenticated,false);assert.equal(state.json().model,'preserved-model');assert.equal(state.json().inferenceVerified,false);
  const post=(action:string,requestId:string,input={})=>f.service.app.inject({method:'POST',url:'/v1/extensions/agents/'+action,headers:f.headers,payload:{requestId,input}});
  const result=await post('connect-codex','unavailable-setup');assert.equal(ActionReceiptSchema.parse(result.json()).outcome,'rejected');assert.equal(result.json().error.code,'unavailable');
  await post('connect-codex','unavailable-setup');assert.equal(opens,0);assert.equal(saves,0);assert.deepEqual(await f.store.list('extension:agents:request'),[]);
  assert.notEqual((await post('configure','premature-enable',{codexEnabled:true})).json().outcome,'completed');assert.equal((await f.service.app.inject({method:'GET',url:'/v1/extensions/settings',headers:f.headers})).json().agents.codexEnabled,false);
  await f.service.app.inject({method:'POST',url:'/v1/extensions/session',headers:f.headers,payload:{privateSession:true,revision:1}});
  assert.equal((await get()).statusCode,403);for(const action of ['connect-codex','inspect-codex','select-codex-model'])assert.equal((await post(action,'private-'+action,action==='select-codex-model'?{model:'preserved-model'}:{})).json().error.code,'forbidden');
  assert.equal(opens,0);assert.equal(saves,0);assert.equal(JSON.stringify(await f.store.export()).includes('authUrl'),false);
 }finally{await f.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('model/task contexts and event-shaped inputs cannot start or configure a Codex account session',async()=>{
 const f=await fixture();try{
  const task=f.context({authority:'task',taskId:'task-1'});
  for(const action of ['connect-codex','inspect-codex','select-codex-model']){
   const result=await f.hub.dispatch('agents',action,{requestId:'model-'+action,taskId:'task-1',input:action==='select-codex-model'?{model:'provider-model'}:{}},task.handle);
   assert.equal(result.outcome,'rejected');assert.equal(result.error?.code,'forbidden');
  }
  const result=await f.action('agents','connect-codex',{approved:true,privateSession:false,authUrl:'https://auth.openai.com/'});assert.equal(result.error?.code,'invalid-request');
 }finally{await f.hub.close();}
});

test('queued security jobs retain the authenticated UI scope after the HTTP reply and Stop aborts without replay',async()=>{
 const gate=deferred();let calls=0,aborted=false;
 const f=await serviceFixture({profile:'development',security:{host:{platform:'win32',invoke:async(_op,input,signal)=>{calls++;signal.addEventListener('abort',()=>{aborted=true;gate.resolve();},{once:true});await gate.promise;return scan(input.requestId);}},authorize:async()=>true}});
 try{
  const response=await f.service.app.inject({method:'POST',url:'/v1/extensions/security/quick-scan',headers:f.headers,payload:{requestId:'one-job',input:{}}});
  assert.equal(response.statusCode,202);assert.equal(response.json().outcome,'pending');await until(()=>calls===1);
  assert.equal(aborted,false,'a normal HTTP reply must not retire the queued context');
  await f.service.app.inject({method:'POST',url:'/v1/stop',headers:f.headers,payload:{}});await until(()=>aborted);
  const again=await f.service.app.inject({method:'POST',url:'/v1/extensions/security/quick-scan',headers:f.headers,payload:{requestId:'one-job',input:{}}});
  assert.notEqual(again.json().outcome,'completed');assert.equal(calls,1);
 }finally{gate.resolve();await f.close();}
});

test('normal task completion retires queued UI job handles without tying them to HTTP completion',async()=>{
 const inference=deferred(),monitor=deferred();let active=true,aborted=false,nativeCalls=0;
 const parent={taskId:'parent-task',request:'Neutral fixture task',mode:'scoped' as const,createdAt:Date.now(),revoked:false};
 const f=await serviceFixture({profile:'development',security:{host:{platform:'win32',invoke:async(_op,input,signal)=>{nativeCalls++;signal.addEventListener('abort',()=>{aborted=true;monitor.resolve();},{once:true});await monitor.promise;return scan(input.requestId);}},authorize:async()=>active}},undefined,{taskPermission:id=>active&&id===parent.taskId?parent:undefined,taskLifecycle:async phase=>{if(phase==='end')active=false;}});
 f.service.assistant.router.available=async()=>true;
 f.service.assistant.call=async()=>{await inference.promise;return {output:[{type:'message',content:[{type:'output_text',text:'Neutral task result.'}]}]};};
 try{
  await f.service.app.inject({method:'POST',url:'/v1/chat',headers:f.headers,payload:{id:parent.taskId,text:'Neutral fixture task',private:false}});
  await until(()=>{try{return !!f.service.taskContext(parent.taskId);}catch{return false;}});
  const reply=await f.service.app.inject({method:'POST',url:'/v1/extensions/security/quick-scan',headers:f.headers,payload:{requestId:'task-job',taskId:parent.taskId,input:{}}});assert.equal(reply.statusCode,202);await until(()=>nativeCalls===1);assert.equal(aborted,false);
  inference.resolve();await Promise.all([...f.service.assistant.jobs.values()]);await until(()=>aborted);assert.equal(active,false);assert.equal(nativeCalls,1);
 }finally{inference.resolve();monitor.resolve();await f.close();}
});

test('model extension handlers use live task authority, strict input and the existing security journal without replay',async()=>{
 const inference=deferred();let active=true,native=0;
 const parent={taskId:'model-tools',request:'Inspect a selected project',mode:'scoped' as const,createdAt:Date.now(),revoked:false};
 const seen:{authority:string;taskId?:string;privateSession:boolean;localOnly:boolean}[]=[];
 const f=await serviceFixture({profile:'development',security:{host:{platform:'win32',invoke:async(_operation,input)=>{native++;return scan(input.requestId);}},authorize:async(_op,_target,context)=>{seen.push(context);return active&&context.authority==='task'&&context.taskId===parent.taskId;}}},undefined,{taskPermission:id=>active&&id===parent.taskId?parent:undefined});
 const ai=f.service.assistant;ai.router.available=async()=>true;ai.call=async()=>{await inference.promise;return {output:[{type:'message',content:[{type:'output_text',text:'Neutral complete.'}]}]};};
 const invoke=(name:string,args:any,privateFlag=false)=>ai.tool(name,args,new AbortController().signal,privateFlag,parent.taskId);
 try{
  await ai.chat(parent.request,false,parent.taskId);await until(()=>{try{return !!f.service.taskContext(parent.taskId);}catch{return false;}});
  const status=await invoke('extension_status',{});assert.equal(status.status.features.agents.available,false);assert.deepEqual(status.workspaces,[]);
  const skills=await invoke('select_skills',{text:'Build this selected project'});assert.deepEqual(skills.guidance,[],'disabled/unverified skills cannot invent guidance or checks');
  const delegated=await invoke('delegate_task',{requestId:'model-agent',provider:'codex',workspaceId:'workspace-1',prompt:'Inspect the project'});
  assert.equal(delegated.error.code,'unconfigured');assert.equal(delegated.outcome,'rejected');
  assert.match((await invoke('agent_result',{jobId:'foreign-job'})).error,/No confirmed/);
  const intent={requestId:'model-notify',binding:{routeId:'route-1',routeRevision:1,recipientId:'recipient-1',recipientSha256:'a'.repeat(64),workflowId:'workflow-1',templateId:'template-1',templateVersion:1,bodySha256:'b'.repeat(64)}};
  assert.notEqual((await invoke('notify_contact',intent)).outcome,'completed');assert.equal(native,0);
  for(const forged of [{authority:'trusted-ui'},{privateSession:false},{localOnly:false},{taskId:'other-task'},{approved:true}]){
   await assert.rejects(invoke('delegate_task',{requestId:'forged-agent',provider:'codex',workspaceId:'workspace-1',prompt:'No dispatch',...forged}),/Invalid extension/);
   await assert.rejects(invoke('security_job',{requestId:'forged-scan',action:'quick-scan',...forged}),/Invalid extension/);
   await assert.rejects(invoke('notify_contact',{...intent,...forged}),/Invalid extension/);
  }
  for(const action of ['configure','grant','review','approve','reconcile','stage-workspace'])await assert.rejects(invoke('security_job',{requestId:'ui-only',action}),/Invalid extension/);
  const args={requestId:'model-scan',action:'quick-scan'};
  const queued=await invoke('security_job',args,true);assert.equal(queued.outcome,'pending');assert.equal(queued.effect,'queued');
  await until(async()=>!!(await f.store.list(hubRecordKinds.security))[0]?.record.job.evidence?.length);
  const evidence=await invoke('security_result',{jobId:queued.jobId});assert.equal(evidence.taskId,parent.taskId);assert.ok(evidence.evidence.length);assert.equal(native,1);
  await invoke('security_job',args);assert.equal(native,1,'same request resolves through the existing journal');
  const inspection=await invoke('security_job',{requestId:'model-inspect',action:'inspect',jobId:queued.jobId});assert.equal(inspection.jobId,queued.jobId);
  const other={...evidence,id:'foreign-security',taskId:'foreign-task',requestId:'foreign-request'};
  await f.store.put(hubRecordKinds.security,{id:'foreign-request',record:{job:other,intentSha256:'a'.repeat(64)}});
  assert.match((await invoke('security_result',{jobId:other.id})).error,/No task-owned/);
  assert.equal((await invoke('security_job',{requestId:'foreign-inspect',action:'inspect',jobId:other.id})).error.code,'forbidden');
  assert.ok(seen.length>=2);assert.ok(seen.every(context=>context.authority==='task'&&context.taskId===parent.taskId&&!context.privateSession&&!context.localOnly),'caller private flag cannot override the live host context');
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(ai.tool('security_job',{requestId:'aborted',action:'quick-scan'},cancelled.signal,false,parent.taskId));
  active=false;await assert.rejects(invoke('extension_status',{}),/authorization/);assert.equal(native,1);
 }finally{inference.resolve();await Promise.all([...ai.jobs.values()]);await f.close();}
});

test('real private/local-only task scopes deny remote model tools despite caller flags and Stop retires old scopes',async()=>{
 for(const privateSession of [true,false]){
  const gate=deferred();let native=0;
  const parent={taskId:'restricted-task',request:privateSession?'Private task':'Local-only project task',mode:'scoped' as const,createdAt:Date.now(),revoked:false};
  const f=await serviceFixture({profile:'development',security:{host:{platform:'win32',invoke:async(_operation,input)=>{native++;return scan(input.requestId);}},authorize:async()=>false}},undefined,{taskPermission:id=>id===parent.taskId?parent:undefined});
  const ai=f.service.assistant;ai.router.available=async()=>true;ai.call=async()=>{await gate.promise;return {output:[]};};
  try{
   const sessionResponse=await f.service.app.inject({method:'GET',url:'/v1/extensions/session',headers:f.headers});assert.equal(sessionResponse.statusCode,200);
   const session=sessionResponse.json();assert.equal(session.protocol,'capri-private-v1');
   const transition=await f.service.app.inject({method:'POST',url:'/v1/extensions/session',headers:f.headers,payload:{privateSession,revision:session.revision+1}});assert.equal(transition.statusCode,200);
   const current=transition.json();assert.equal(current.privateSession,privateSession);
   const started=await f.service.app.inject({method:'POST',url:'/v1/chat',headers:f.headers,payload:{id:parent.taskId,text:parent.request,private:privateSession,...(privateSession?{privacyEpoch:current.privacyEpoch}:{})}});assert.equal(started.statusCode,200);
   await until(()=>{try{return !!f.service.taskContext(parent.taskId);}catch{return false;}});
   const invoke=(name:string,args:any)=>ai.tool(name,args,new AbortController().signal,false,parent.taskId);
   assert.equal((await invoke('delegate_task',{requestId:'restricted-agent',provider:'claude-api',workspaceId:'workspace-1',prompt:'Never dispatched'})).error.code,'forbidden');
   assert.equal((await invoke('notify_contact',{requestId:'restricted-contact',binding:{routeId:'route-1',routeRevision:1,recipientId:'recipient-1',recipientSha256:'a'.repeat(64),workflowId:'workflow-1',templateId:'template-1',templateVersion:1,bodySha256:'b'.repeat(64)}})).error.code,'forbidden');
   assert.equal((await invoke('security_job',{requestId:'denied-scan',action:'quick-scan'})).error.code,'forbidden');assert.equal(native,0);
   const handle=f.service.taskContext(parent.taskId);await ai.stop();
   assert.equal((await f.service.hub.dispatch('security','quick-scan',{requestId:'after-stop',taskId:parent.taskId,input:{}},handle)).error?.code,'forbidden');
   await assert.rejects(invoke('extension_status',{}));assert.equal(native,0);
  }finally{gate.resolve();await Promise.all([...ai.jobs.values()]);await f.close();}
 }
});

test('every advertised extension tool has a reviewed profile with real permission and dependency declarations',()=>{
 for(const tool of extensionToolDefinitions){assert.ok(skillToolNames.includes(tool.name),tool.name);assert.equal(tool.parameters.additionalProperties,false);assert.equal(Object.hasOwn(tool.parameters.properties,'authority'),false);assert.equal(Object.hasOwn(tool.parameters.properties,'taskId'),false);}
 const recipe=SkillRecipeSchema.parse({summary:'Use a granted isolated delegate and inspect its result.',keywords:['project'],tools:['delegate_task','agent_result','run_command'],steps:['Delegate the selected task, then inspect and test its actual changes.'],verify:['Report the requested command exit status.'],checks:['command-exit-status']});
 const manifest=skillManifest({id:'delegate-recipe',version:'1',name:'Delegate project',description:'Inspect project changes',recipe});
 assert.ok(manifest.dependencies.includes('tool:delegate_task'));assert.ok(manifest.requiredCapabilities.includes('agents'));assert.ok(manifest.permissions.includes('delegate'));assert.ok(manifest.permissions.includes('network'));assert.equal(manifest.localOnly,false);
});

test('detector transport uses server-owned generations, ordered frames and immediate explicit capture cancellation',async()=>{
 const directory=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'capri-detector-route-'));fs.writeFileSync(path.join(directory,'silero_vad.onnx'),'neutral-fake-model');
 let detects=0;const speech=new LocalSpeech(directory,undefined,{factory:()=>({reset(){},detect:()=>{detects++;return true;}})});
 const f=await serviceFixture(undefined,speech);const post=(payload:any)=>f.service.app.inject({method:'POST',url:'/v1/voice/local/detect',headers:f.headers,payload});
 const token=async()=>(await f.service.app.inject({method:'GET',url:'/v1/voice/local/capture',headers:f.headers})).json().captureToken;
 try{
  const captureToken=await token(),frame={sessionId:'capture-a',sequence:0,samples:Buffer.alloc(6400).toString('base64'),reset:true,captureToken};
  assert.equal((await post({...frame,captureToken:'forged'})).json().available,false);assert.equal(detects,0);
  assert.equal((await post(frame)).json().available,true);assert.equal(detects,1);
  assert.equal((await post(frame)).json().reason,'stale-frame');assert.equal(detects,1);
  await f.service.app.inject({method:'DELETE',url:'/v1/voice/local/capture',headers:f.headers,payload:{sessionId:frame.sessionId,captureToken}});
  assert.equal((await post({...frame,sequence:1})).json().available,false);
  // A previously unseen reset frame cannot cross the server generation either.
  assert.equal((await post({...frame,sessionId:'unseen-old',sequence:0})).json().available,false);assert.equal(detects,1);
  const nextToken=await token();assert.equal((await post({...frame,sessionId:'capture-b',captureToken:nextToken})).json().available,true);
  await f.service.app.inject({method:'DELETE',url:'/v1/voice/local/detect/capture-a',headers:f.headers,payload:{captureToken}});
  assert.equal((await post({...frame,sessionId:'capture-b',sequence:1,reset:undefined,captureToken:nextToken})).json().available,true,'late cancellation of A cannot invalidate B');
  assert.equal((await post({...frame,captureToken:await token()})).json().reason,'cancelled','ended raw session IDs stay tombstoned');
  const session=(await f.service.app.inject({method:'GET',url:'/v1/extensions/session',headers:f.headers})).json();
  await f.service.app.inject({method:'POST',url:'/v1/extensions/session',headers:f.headers,payload:{privateSession:true,revision:session.revision+1}});
  assert.equal((await post({...frame,sessionId:'capture-b',sequence:2,captureToken:nextToken})).json().available,false);
 }finally{await f.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('actual response closure during fake local inference retires its generation before idle expiry',async()=>{
 const entered=deferred(),gate=deferred();const directory=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'capri-detector-abort-'));fs.writeFileSync(path.join(directory,'silero_vad.onnx'),'neutral-fake-model');
 const speech=new LocalSpeech(directory,undefined,{factory:()=>({reset(){},detect:async()=>{entered.resolve();await gate.promise;return true;}})});
 let cancelled=0;const cancelDetection=speech.cancelDetection.bind(speech);speech.cancelDetection=id=>{cancelled++;cancelDetection(id);};
 const f=await serviceFixture(undefined,speech);let close!:()=>void;
 f.service.app.addHook('onRequest',async(req,reply)=>{if(req.url==='/v1/voice/local/detect')close=()=>reply.raw.emit('close');});
 try{
  const captureToken=(await f.service.app.inject({method:'GET',url:'/v1/voice/local/capture',headers:f.headers})).json().captureToken;
  const payload={sessionId:'abort-id',sequence:0,reset:true,samples:Buffer.alloc(6400).toString('base64'),captureToken};
  // light-my-request rejects a destroyed response; attach its handler before
  // closure while still checking the real server close hook synchronously.
  const pending=f.service.app.inject({method:'POST',url:'/v1/voice/local/detect',headers:f.headers,payload}).then(response=>({response}),error=>({error}));
  await entered.promise;close();assert.equal(cancelled,1,'explicit closure cancels the detector before inference settles');gate.resolve();
  const settled=await pending;
  if('error' in settled)assert.equal(settled.error.code,'LIGHT_ECONNRESET');
  else assert.equal(settled.response.json().available,false);
  const token=(await f.service.app.inject({method:'GET',url:'/v1/voice/local/capture',headers:f.headers})).json().captureToken;
  const repeated=await f.service.app.inject({method:'POST',url:'/v1/voice/local/detect',headers:f.headers,payload:{...payload,captureToken:token}});assert.equal(repeated.json().reason,'cancelled');
 }finally{gate.resolve();await f.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('bounded capture retirement releases obsolete namespace capacity while rejecting every old token',async()=>{
 let detects=0,cancels=0;
 const speech={detect:async(body:any)=>{detects++;return {...body,available:true,speech:false};},cancelDetection(){cancels++;},stop(){},async close(){}} as unknown as LocalSpeech;
 const f=await serviceFixture(undefined,speech),app=f.service.app;
 const token=async()=>(await app.inject({method:'GET',url:'/v1/voice/local/capture',headers:f.headers})).json().captureToken;
 const post=(captureToken:string,sessionId:string,sequence=0)=>app.inject({method:'POST',url:'/v1/voice/local/detect',headers:f.headers,payload:{captureToken,sessionId,sequence,reset:true,samples:Buffer.alloc(6400).toString('base64')}});
 try{
  const first=await token();assert.equal((await post(first,'old-live')).json().available,true);assert.equal(cancels,0,'normal response does not retire capture');
  for(let i=0;i<4100;i++){
   const response=await app.inject({method:'DELETE',url:'/v1/voice/local/detect/ended-'+i,headers:f.headers,payload:{captureToken:await token()}});assert.equal(response.statusCode,200);
  }
  const fresh=await token();assert.notEqual(fresh,first);assert.equal(cancels,1,'namespace retirement cancels its original active detector');
  assert.equal((await post(first,'old-live',1)).json().available,false);assert.equal((await post(first,'unseen-old')).json().available,false);assert.equal(detects,1);
  assert.equal((await post(fresh,'fresh-live')).json().available,true);
  // A delayed old-token close cannot refill the new namespace or close B.
  await app.inject({method:'DELETE',url:'/v1/voice/local/capture',headers:f.headers,payload:{captureToken:first,sessionId:'fresh-live'}});
  assert.equal((await post(fresh,'fresh-live',1)).json().available,true);assert.equal(detects,3);
 }finally{await f.close();}
});

test('actual local event dispatch closes A once; same-owner mirrored inactive events and duplicate cleanup preserve B',async()=>{
 let cancels=0;
 const speech={detect:async(body:any)=>({...body,available:true,speech:false}),cancelDetection(){cancels++;},stop(){},async close(){}} as unknown as LocalSpeech;
 const f=await serviceFixture(undefined,speech),previous=(globalThis as any).window;
 const requests:{method:string;route:string;body:any}[]=[],presented:any[]=[],mirrors:any[]=[];
 const bridge=async(method:string,route:string,body?:any)=>{requests.push({method,route,body});const response=await f.service.app.inject({method:method as any,url:route,headers:f.headers,...(body===undefined?{}:{payload:body})});if(response.statusCode>=400)throw Error('Neutral bridge HTTP '+response.statusCode);return response.json();};
 (globalThis as any).window={capri:{request:bridge}};
 const frame=(sessionId:string,sequence=0)=>({sessionId,sequence,reset:true,samples:Buffer.alloc(6400).toString('base64')});
 try{
  assert.equal((await api('/v1/voice/local/detect','POST',frame('event-a'))).available,true);assert.equal(cancels,0);
  const inactive={type:'voice',active:false};
  dispatchLocalVoiceEvent(inactive,event=>presented.push(event),event=>dispatchVoicePresentation(event,value=>mirrors.push(value)));
  // B is requested immediately; the real API waits for exact A cleanup before obtaining B's token.
  assert.equal((await api('/v1/voice/local/detect','POST',frame('event-b'))).available,true);assert.equal(cancels,1);
  const closed=requests.find(row=>row.method==='DELETE'&&row.route==='/v1/voice/local/capture')!;
  assert.equal(closed.body.sessionId,'event-a');assert.equal(typeof closed.body.captureToken,'string');
  const before=requests.length;
  for(const event of [...mirrors,...mirrors])dispatchVoicePresentation(event,value=>presented.push(value));
  assert.equal(requests.length,before,'presentation dispatch has no service/capture side effects');assert.equal(presented.length,3);
  await bridge(closed.method,closed.route,closed.body); // duplicate late cleanup for A, from the same authenticated owner
  assert.equal((await api('/v1/voice/local/detect','POST',frame('event-b',1))).available,true);assert.equal(cancels,1);
  const unscoped=await f.service.app.inject({method:'DELETE',url:'/v1/voice/local/capture',headers:f.headers});assert.equal(unscoped.statusCode,400);
  assert.equal((await api('/v1/voice/local/detect','POST',frame('event-b',2))).available,true);
  const controller=new AbortController();controller.abort();const launched=requests.length;
  await assert.rejects(api('/v1/voice/local/detect','POST',frame('never-launched'),{signal:controller.signal}));assert.equal(requests.length,launched);
  await api('/v1/stop','POST',{});assert.equal(cancels,2,'explicit global Stop still retires B');
 }finally{try{await api('/v1/voice/local/capture','DELETE');}finally{(globalThis as any).window=previous;await f.close();}}
});

test('selected ordinary Git projects stage clean bounded copies, preserve originals and reject aliases',()=>{
 const directory=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'capri-staged-project-'));
 try{
  const source=path.join(directory,'project'),base=path.join(directory,'staging'),protectedRoot=path.join(directory,'protected');fs.mkdirSync(source);fs.mkdirSync(base);fs.mkdirSync(protectedRoot);
  fs.mkdirSync(path.join(source,'.git'));fs.writeFileSync(path.join(source,'.git','config'),'private-vcs-config');fs.writeFileSync(path.join(source,'.env'),'secret');fs.mkdirSync(path.join(source,'node_modules'));fs.writeFileSync(path.join(source,'node_modules','private.config'),'secret');fs.writeFileSync(path.join(source,'app.ts'),'export const value=1;');
  const snapshot=stageAgentWorkspace({sourceRoot:source,stagingRoot:base,excludedRoots:[protectedRoot],signal:new AbortController().signal});
  assert.equal(snapshot.files,1);assert.deepEqual(fs.readdirSync(snapshot.root),['app.ts']);fs.writeFileSync(path.join(snapshot.root,'app.ts'),'changed');assert.equal(fs.readFileSync(path.join(source,'app.ts'),'utf8'),'export const value=1;');
  fs.linkSync(path.join(source,'app.ts'),path.join(source,'linked.ts'));
  assert.throws(()=>stageAgentWorkspace({sourceRoot:source,stagingRoot:base,excludedRoots:[protectedRoot],signal:new AbortController().signal}),ExtensionHubError);
  const stopped=new AbortController();stopped.abort();assert.throws(()=>stageAgentWorkspace({sourceRoot:source,stagingRoot:base,excludedRoots:[protectedRoot],signal:stopped.signal}));
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('delegated exact text review binds both file hashes and refuses traversal, binary and stale changes',()=>{
 const directory=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'capri-delegated-review-'));
 try{
  const source=path.join(directory,'source'),staged=path.join(directory,'staged');fs.mkdirSync(source);fs.mkdirSync(staged);
  fs.writeFileSync(path.join(source,'app.ts'),'before\n');fs.writeFileSync(path.join(staged,'app.ts'),'after\n');
  const change={path:'app.ts',kind:'modified' as const,beforeSha256:sha256('before\n'),afterSha256:sha256('after\n')};
  assert.deepEqual(delegatedTextChanges(source,staged,[change]),[{path:'app.ts',before:'before\n',after:'after\n',beforeSha256:change.beforeSha256,afterSha256:change.afterSha256}]);
  assert.throws(()=>delegatedTextChanges(source,staged,[{...change,path:'../outside'}]),ExtensionHubError);
  assert.throws(()=>delegatedTextChanges(source,staged,[{...change,kind:'deleted'}]),ExtensionHubError);
  fs.writeFileSync(path.join(source,'app.ts'),'user edited\n');assert.throws(()=>delegatedTextChanges(source,staged,[change]),ExtensionHubError);
  fs.writeFileSync(path.join(source,'app.ts'),'before\n');fs.writeFileSync(path.join(staged,'app.ts'),Buffer.from([0,255,0]));assert.throws(()=>delegatedTextChanges(source,staged,[change]),ExtensionHubError);
  assert.equal(fs.readFileSync(path.join(source,'app.ts'),'utf8'),'before\n');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {resolve,promise};}
const pause=()=>new Promise<void>(r=>setTimeout(r,5));
async function until(check:()=>unknown|Promise<unknown>){const end=Date.now()+3000;while(!await check()){if(Date.now()>end)throw Error('Isolated Hub fixture deadline');await pause();}}
function memory(){
  const rows=new Map<string,any>(),writes:{kind:string;value:any}[]=[];
  const store={get:async(kind:string,id:string)=>structuredClone(rows.get(kind+':'+id)),
    list:async(kind:string)=>[...rows].filter(([key])=>key.startsWith(kind+':')).map(([,value])=>structuredClone(value)),
    put:async(kind:string,value:any)=>{const row={...structuredClone(value),updatedAt:'fixture'};rows.set(kind+':'+value.id,row);writes.push({kind,value:structuredClone(value)});return row;},
    remove:async(kind:string,id:string)=>{rows.delete(kind+':'+id);}};
  return {store,rows,writes};
}
async function fixture(change:Partial<ExtensionHubOptions>={},database=memory()){
  let now=new Date(2026,0,2,10).getTime();
  const options:ExtensionHubOptions={store:database.store,clock:()=>now,profile:'development',...change};
  const hub=await createExtensionHub(options),sources:HubHostContext[]=[];
  const context=(patch:Partial<HubHostContext>={})=>{const source:HubHostContext={authority:'trusted-ui',signal:new AbortController().signal,privateSession:false,localOnly:false,privacyEpoch:'epoch-1',...patch};
    sources.push(source);return {handle:hub.context(()=>source),source};};
  const ui=context();
  let number=0;
  const action=(feature:Parameters<ExtensionHub['dispatch']>[0],name:string,input:Record<string,unknown>={},handle:HubContext=ui.handle,requestId='request-'+(++number))=>{
    return hub.dispatch(feature,name,{requestId,input},handle);
  };
  return {...database,options,hub,ui,context,action,advance:(ms:number)=>{now+=ms;}};
}
const receipt=(value:unknown)=>ActionReceiptSchema.parse(value);
const draft={id:'weekly-notes',name:'Private weekly notes',description:'Summarize a chosen notes folder.',recipe:{summary:'Summarize my notes.',keywords:['weekly','notes'],
  tools:['list_files','read_file','create_artifact'],steps:['Read the selected folder.','Create a summary artifact.'],verify:['Read back the artifact.'],checks:['artifact-readback']}};
function cursor(){const calls:string[]=[];let status:CursorStatus={state:'inactive',recoveryAvailable:false};
  const controller={status:()=>({...status}),recover:async()=>{calls.push('recover');return {...status};},stop:async()=>{calls.push('stop');status={state:'inactive',recoveryAvailable:true};return {...status};},
    enable:async()=>{calls.push('enable');status={state:'active',recoveryAvailable:true};return {...status};},updateEnvironment:async()=>({...status})};
  return {calls,controller,cache:{importFolder:async(folder:string)=>{calls.push('import:'+folder);return {directory:'isolated-private-cache',animated:[],static:[]};}},environment:async()=>({gameDocked:false,locked:false,reducedMotion:false})};
}
const scan=(requestId:string,patch:Partial<DefenderObservation>={}):DefenderObservation=>({requestId,operation:'quick-scan',phase:'returned',scan:{recordId:'event-1',scanId:'scan-1',completed:true,cancelled:false,correlated:true,exclusiveWindow:true},detections:[],detectionsComplete:true,...patch});

test('Hub defaults are strictly typed, unconfigured and model-free without native/provider placeholders',async()=>{
  const f=await fixture();
  try{
    const settings=await f.hub.settings(f.ui.handle);assert.deepEqual(settings,defaultExtensionSettings());
    const state=ExtensionStatusSchema.parse(await f.hub.status(f.ui.handle));
    assert.equal(state.listening.owner,'desktop');assert.equal(state.listening.state,'disabled');assert.equal(state.updates.state,'untrusted');
    assert.equal(state.features.agents.available,false);assert.equal(state.features.contacts.available,false);assert.equal(state.features.updates.available,false);
    assert.equal((await f.action('agents','start',{provider:'codex',workspaceId:'work-1',prompt:'No actual model'})).error?.code,'unconfigured');
    assert.equal((await f.action('updates','stage',{version:'0.7.0-dev.2'})).error?.code,'unsupported');
    assert.equal((await f.action('contacts','approve',{requestId:'outbox-1',reviewDigest:'a'.repeat(64)})).error?.code,'unsupported');
    assert.equal((await f.action('contacts','review-details',{outboxRequestId:'outbox-1',privacyEpoch:'epoch-1'})).error?.code,'unsupported');
    await assert.rejects(f.hub.overview('contacts',f.ui.handle),e=>e instanceof ExtensionHubError&&e.code==='unsupported');
    assert.equal(f.writes.some(w=>['usage','message','memory','settings'].includes(w.kind)),false);
  }finally{await f.hub.close();}
});

test('opaque live host contexts reject JSON impersonation, cross-Hub handles, model approval and revoked scope',async()=>{
  const f=await fixture(),other=await fixture();
  try{
    for(const handle of [{} as HubContext,other.ui.handle])assert.equal((await f.action('agents','configure',{codexEnabled:true},handle)).error?.code,'forbidden');
    const task=f.context({authority:'task',taskId:'task-1'});
    const request:ExtensionAction={requestId:'forged-1',taskId:'task-1',input:{enabled:true,authority:'trusted-ui',approved:true}};
    assert.equal((await f.hub.dispatch('cursor','configure',request,task.handle)).error?.code,'forbidden');
    await assert.rejects(f.hub.dispatch('agents','configure',{requestId:'forged-2',input:{codexEnabled:true},authority:'trusted-ui'},task.handle));
    assert.equal((await f.action('agents','configure',{codexEnabled:true,approved:true})).error?.code,'invalid-request');
    f.ui.source.privacyEpoch='epoch-2';assert.equal((await f.action('agents','configure',{codexEnabled:true})).error?.code,'forbidden');
    assert.equal((await f.hub.settings(f.context().handle)).agents.codexEnabled,false);
  }finally{await f.hub.close();await other.hub.close();}
});

test('feature settings preserve sibling subtrees, optional cursor fields and all legacy voice/data records',async()=>{
  const f=await fixture();f.rows.set('settings:main',{id:'main',voice:'Designed A',model:'existing-local'});f.rows.set('memory:one',{id:'one',text:'preserved'});
  try{
    const results=await Promise.all([f.action('agents','configure',{codexEnabled:true,claudeApiEnabled:false}),f.action('security','configure',{dailyQuickScan:false}),f.action('cursor','configure',{enabled:false,intensity:0.3})]);
    assert.ok(results.every(r=>receipt(r).outcome==='completed'));
    assert.equal((await f.action('cursor','configure',{durationMs:1000})).outcome,'completed');
    const settings=await f.hub.settings(f.ui.handle);
    assert.equal(settings.agents.codexEnabled,true);assert.equal(settings.security.dailyQuickScan,false);assert.equal(settings.security.enabled,true);
    assert.equal(settings.cursor.intensity,0.3);assert.equal(settings.cursor.enabled,false);assert.equal(settings.cursor.durationMs,1000);
    assert.deepEqual(f.rows.get('settings:main'),{id:'main',voice:'Designed A',model:'existing-local'});assert.equal(f.rows.get('memory:one').text,'preserved');
    const status=await f.hub.status(f.ui.handle);assert.equal(status.features.agents.available,false);
  }finally{await f.hub.close();}
});

test('settings require matching durable readback and corrupt saved subtrees never reset to defaults',async()=>{
  const db=memory(),get=db.store.get;let corrupt=false;db.store.get=async(kind,id)=>{const value=await get(kind,id);if(corrupt&&kind===hubRecordKinds.settings&&value)value.settings.agents.codexEnabled=false;return value;};
  const f=await fixture({},db);
  try{corrupt=true;assert.equal((await f.action('agents','configure',{codexEnabled:true})).outcome,'unconfirmed');
    corrupt=false;db.rows.set(hubRecordKinds.settings+':main',{id:'main',schemaVersion:1,settings:{malformed:true}});
    await assert.rejects(f.hub.settings(f.ui.handle),e=>e instanceof ExtensionHubError&&e.code==='unavailable');
    await assert.rejects(f.hub.status(f.ui.handle));
  }finally{await f.hub.close();}
});

test('cursor composition imports privately, enables only from trusted UI and never replays a completed request after Stop',async()=>{
  const c=cursor(),f=await fixture({cursor:c});
  try{
    assert.deepEqual(c.calls,['recover']);
    await f.action('cursor','import',{folder:'selected-private-folder'});
    const first=await f.action('cursor','configure',{enabled:true},f.ui.handle,'enable-once');assert.equal(first.outcome,'completed');
    assert.equal((await f.hub.status(f.ui.handle)).cursor.state,'active');
    const stopped=await f.hub.stop();assert.equal(stopped.cursor?.state,'inactive');assert.equal((await f.action('cursor','restore')).error?.code,'forbidden');
    const next=f.context();const duplicate=await f.action('cursor','configure',{enabled:true},next.handle,'enable-once');assert.equal(duplicate.id,first.id);
    assert.equal(c.calls.filter(call=>call==='enable').length,1);assert.equal((await f.hub.status(next.handle)).cursor.state,'inactive');
    assert.equal((await f.action('cursor','configure',{enabled:false},next.handle,'enable-once')).error?.code,'conflict');
  }finally{await f.hub.close();}
});

test('Stop fences a late cursor environment and a late initialization before either can start new native work',async()=>{
  const gate=deferred<{gameDocked:boolean;locked:boolean;reducedMotion:boolean}>(),entered=deferred(),c=cursor();
  const f=await fixture({cursor:{...c,environment:async()=>{entered.resolve();return gate.promise;}}});
  try{
    await f.action('cursor','import',{folder:'selected-private-folder'});
    const action=f.action('cursor','configure',{enabled:true});await entered.promise;await f.hub.stop();
    gate.resolve({gameDocked:false,locked:false,reducedMotion:false});assert.equal((await action).outcome,'unconfirmed');assert.equal(c.calls.includes('enable'),false);
  }finally{await f.hub.close();}
  const db=memory(),held=deferred(),read=deferred(),c2=cursor(),get=db.store.get;
  db.store.get=async(kind,id)=>{if(kind===hubRecordKinds.settings){read.resolve();await held.promise;}return get(kind,id);};
  const hub=new ExtensionHub({store:db.store,clock:()=>1000,profile:'development',cursor:c2});
  const initialized=hub.initialize();await read.promise;const closing=hub.close();held.resolve();
  await assert.rejects(initialized);await closing;assert.equal(c2.calls.includes('recover'),false);assert.equal(c2.calls.includes('enable'),false);
});

test('private skill drafts stay in session memory and Stop removes them without claiming registered verification',async()=>{
  const f=await fixture({skillFacts:async()=>({capabilities:['files','artifacts'],dependencies:['tool:list_files','tool:read_file','tool:create_artifact']})});
  try{
    await f.action('skills','configure',{enabled:true});const privateUi=f.context({privateSession:true});
    assert.equal((await f.action('skills','draft',draft,privateUi.handle)).outcome,'completed');
    const catalog=await f.hub.overview('skills',privateUi.handle) as any;
    assert.ok(catalog.skills.some((s:any)=>s.skillId===draft.id&&s.private));assert.equal(f.writes.some(w=>w.kind===skillRecordKinds.draft),false);
    assert.equal((await f.hub.overview('skills',f.ui.handle) as any).skills.some((s:any)=>s.skillId===draft.id),false);
    assert.equal((await f.action('skills','review',{skillId:draft.id,manifestSha256:catalog.skills.find((s:any)=>s.skillId===draft.id).manifestSha256},privateUi.handle)).outcome,'rejected');
    const guidance=await f.hub.skillGuidance(['document-artifacts'],f.ui.handle);assert.deepEqual(guidance,[]);
    await f.hub.stop();const next=f.context({privateSession:true,privacyEpoch:'epoch-2'});
    assert.equal((await f.hub.overview('skills',next.handle) as any).skills.some((s:any)=>s.skillId===draft.id),false);
  }finally{await f.hub.close();}
});

test('a privacy boundary during skill lookup prevents a late draft from being retained',async()=>{
  const db=memory(),get=db.store.get,entered=deferred(),gate=deferred();let hold=false;
  db.store.get=async(kind,id)=>{if(hold&&kind===skillRecordKinds.draft){hold=false;entered.resolve();await gate.promise;}return get(kind,id);};
  const f=await fixture({},db);
  try{
    hold=true;const action=f.action('skills','draft',draft);await entered.promise;
    f.ui.source.privateSession=true;f.ui.source.privacyEpoch='epoch-2';gate.resolve();
    assert.notEqual((await action).outcome,'completed');assert.equal(db.writes.some(w=>w.kind===skillRecordKinds.draft),false);
  }finally{gate.resolve();await f.hub.close();}
});

test('security jobs use actual correlated module evidence, deduplicate in-flight work, and Stop keeps uncertain effects',async()=>{
  const entered=deferred(),answer=deferred<DefenderObservation>();let native=0;
  const f=await fixture({security:{host:{platform:'win32',invoke:async(_operation,input)=>{native++;entered.resolve();return answer.promise;}},
    authorize:async(_operation,_target,ctx)=>ctx.authority==='trusted-ui',availability:async()=>({configured:true,ready:true})}});
  try{
    const first=await f.action('security','quick-scan',{},f.ui.handle,'scan-once');assert.equal(first.outcome,'pending');await entered.promise;
    const duplicate=await f.action('security','quick-scan',{},f.ui.handle,'scan-once');assert.equal(duplicate.jobId,first.jobId);assert.equal(native,1);
    assert.equal((await f.action('security','full-scan',{},f.ui.handle,'scan-once')).error?.code,'conflict');
    await f.hub.stop();answer.resolve(scan('scan-once'));
    const next=f.context();await until(async()=>{const overview=await f.hub.overview('security',next.handle) as any;return overview.jobs[0]?.state==='unconfirmed';});
    const replay=await f.action('security','quick-scan',{},next.handle,'scan-once');assert.equal(replay.outcome,'unconfirmed');assert.equal(native,1);
    const jobs=(await f.hub.overview('security',next.handle) as any).jobs;assert.equal(jobs[0].evidence[0].outcome,'unconfirmed');
  }finally{answer.resolve(scan('scan-once'));await f.hub.close();}
});

test('security authorization is rechecked after durable claim and invalid task/model targets never reach native',async()=>{
  const db=memory(),get=db.store.get,entered=deferred(),gate=deferred();let pauseClaim=false,allowed=true,native=0;
  db.store.get=async(kind,id)=>{const row=await get(kind,id);if(pauseClaim&&kind===hubRecordKinds.security&&row){pauseClaim=false;entered.resolve();await gate.promise;}return row;};
  const f=await fixture({security:{host:{platform:'win32',invoke:async(_op,input)=>{native++;return scan(input.requestId);}},authorize:async()=>allowed}},db);
  try{
    pauseClaim=true;const action=f.action('security','quick-scan');await entered.promise;allowed=false;gate.resolve();await action;
    await until(async()=>{const records=await db.store.list(hubRecordKinds.security);return records[0]?.record.job.state==='unconfirmed';});assert.equal(native,0);
    assert.equal((await f.action('security','custom-scan',{target:'../escape'})).error?.code,'invalid-request');
    const task=f.context({authority:'task',taskId:'task-1'});
    assert.equal((await f.hub.dispatch('security','quick-scan',{requestId:'task-scan',taskId:'task-1',input:{}},task.handle)).error?.code,'forbidden');assert.equal(native,0);
  }finally{gate.resolve();await f.hub.close();}
});

test('security schedule is explicit, user-profile-only, freshly idle, and claimed once without retry',async()=>{
  for(const profile of ['development','self-test','user'] as const){let native=0,active=false;
    const f=await fixture({profile,security:{host:{platform:'win32',invoke:async(_op,input)=>{native++;return scan(input.requestId);}},
      authorize:async(_op,_target,ctx)=>ctx.authority==='trusted-ui',scheduleContext:async()=>({hostAvailable:true,active,gameDocked:false,quiet:false})}});
    try{
      assert.equal(native,0); // no constructor/status-owned schedule loop
      if(profile!=='user'){assert.equal(await f.hub.tickSecurity(f.ui.handle),'non-user-profile');assert.equal(native,0);continue;}
      active=true;assert.equal(await f.hub.tickSecurity(f.ui.handle),'deferred');assert.equal(native,0);
      active=false;assert.equal(await f.hub.tickSecurity(f.ui.handle),'dispatched');await until(()=>native===1);
      assert.equal(await f.hub.tickSecurity(f.ui.handle),'already-claimed');assert.equal(native,1);
      await f.action('security','configure',{dailyQuickScan:false});assert.equal(await f.hub.tickSecurity(f.ui.handle),'disabled');
    }finally{await f.hub.close();}
  }
});

test('scheduled scans recheck profile, settings and all idle gates after a durable occurrence claim without replay',async()=>{
  for(const change of ['active','gameDocked','quiet','hostAvailable','settings','profile','hour'] as const){
    const db=memory(),get=db.store.get,entered=deferred(),gate=deferred();let paused=false,native=0;
    const presence={hostAvailable:true,active:false,gameDocked:false,quiet:false};
    db.store.get=async(kind,id)=>{const row=await get(kind,id);if(!paused&&kind===hubRecordKinds.schedule&&row?.claimed){paused=true;entered.resolve();await gate.promise;}return row;};
    const f=await fixture({profile:'user',security:{host:{platform:'win32',invoke:async(_op,input)=>{native++;return scan(input.requestId);}},
      authorize:async(_op,_target,ctx)=>ctx.authority==='trusted-ui',scheduleContext:async()=>({...presence})}},db);
    try{
      const tick=f.hub.tickSecurity(f.ui.handle);await entered.promise;
      if(change==='settings')await f.action('security','configure',{dailyQuickScan:false});
      else if(change==='profile')f.options.profile='development';
      else if(change==='hour')f.advance(12*3600000);
      else presence[change]=change==='hostAvailable'?false:true;
      gate.resolve();assert.equal(await tick,'unconfirmed',change);assert.equal(native,0,change);
      presence.hostAvailable=true;presence.active=false;presence.gameDocked=false;presence.quiet=false;f.options.profile='user';
      if(change==='settings')await f.action('security','configure',{dailyQuickScan:true});
      if(change==='hour')f.advance(-12*3600000);
      assert.equal(await f.hub.tickSecurity(f.ui.handle),'already-claimed',change);assert.equal(native,0);
    }finally{gate.resolve();await f.hub.close();}
  }
});

test('scheduled scan native invocation rechecks idle state after asynchronous security authorization too',async()=>{
  const entered=deferred(),gate=deferred();let checks=0,native=0,active=false;
  const f=await fixture({profile:'user',security:{host:{platform:'win32',invoke:async(_op,input)=>{native++;return scan(input.requestId);}},
    authorize:async()=>{if(++checks===2){entered.resolve();await gate.promise;}return true;},
    scheduleContext:async()=>({hostAvailable:true,active,gameDocked:false,quiet:false})}});
  try{
    const tick=f.hub.tickSecurity(f.ui.handle);await entered.promise;active=true;gate.resolve();await tick;
    await until(async()=>(await f.store.list(hubRecordKinds.security))[0]?.record.job.state==='unconfirmed');
    assert.equal(native,0);active=false;assert.equal(await f.hub.tickSecurity(f.ui.handle),'already-claimed');assert.equal(native,0);
  }finally{gate.resolve();await f.hub.close();}
});

test('scheduled scan cannot use settings cached before the final awaited activity observation',async()=>{
  const entered=deferred(),gate=deferred();let observations=0,native=0;
  const f=await fixture({profile:'user',security:{host:{platform:'win32',invoke:async(_op,input)=>{native++;return scan(input.requestId);}},authorize:async()=>true,
    scheduleContext:async()=>{if(++observations===3){entered.resolve();await gate.promise;}return {hostAvailable:true,active:false,gameDocked:false,quiet:false};}}});
  try{
    const tick=f.hub.tickSecurity(f.ui.handle);await entered.promise;await f.action('security','configure',{dailyQuickScan:false});gate.resolve();await tick;
    await until(async()=>(await f.store.list(hubRecordKinds.security))[0]?.record.job.state==='unconfirmed');assert.equal(native,0);
    await f.action('security','configure',{dailyQuickScan:true});assert.equal(await f.hub.tickSecurity(f.ui.handle),'already-claimed');assert.equal(native,0);
  }finally{gate.resolve();await f.hub.close();}
});

test('private/local-only scopes deny delegates, sends and update requests without invoking trusted provider callbacks',async()=>{
  let calls=0;
  const update={feature:'updates' as const,status:async():Promise<ExtensionFeatureStatus>=>({feature:'updates',capability:featureCapability({enabled:true,configured:true,supported:true,trusted:false,ready:false}),updates:{state:'untrusted'}}),
    action:async()=>{calls++;throw Error('Must not call a provider');},close:async()=>{}};
  const f=await fixture({updates:update});
  try{
    for(const flags of [{privateSession:true},{localOnly:true}]){
      const ctx=f.context(flags);
      for(const [feature,action,input] of [['agents','start',{provider:'codex',workspaceId:'work-1',prompt:'private'}],['contacts','send',{}],['updates','check',{}]] as const)
        assert.equal((await f.hub.dispatch(feature,action,{requestId:'blocked-'+feature,input},ctx.handle)).error?.code,'forbidden');
    }
    assert.equal(calls,0);
  }finally{await f.hub.close();}
});

test('underlying update receipt mismatch and provider exceptions stay unknown without invented trust',async()=>{
  let calls=0;const f=await fixture({updates:{feature:'updates',status:async()=>({feature:'updates',capability:featureCapability({enabled:true,configured:true,supported:true,trusted:false}),updates:{state:'untrusted'}}),
    action:async()=>{calls++;return {id:'wrong',requestId:'other',feature:'updates',action:'check',observedAt:1000,outcome:'completed',effect:'none'};},close:async()=>{}}});
  try{
    const value=await f.action('updates','check',{},f.ui.handle,'read-once');assert.equal(value.outcome,'unconfirmed');assert.equal(value.effect,'unknown');
    assert.equal((await f.action('updates','check',{},f.ui.handle,'read-once')).outcome,'unconfirmed');assert.equal(calls,1);
    assert.equal((await f.hub.status(f.ui.handle)).updates.state,'untrusted');
  }finally{await f.hub.close();}
});

test('overview adapters are bounded and cannot leak credentials or create review/approval authority',async()=>{
  const f=await fixture({contactsOverview:async()=>({providers:[],routes:[],rules:[],outbox:[],credential:'not-allowed'} as any)});
  try{
    await assert.rejects(f.hub.overview('contacts',f.ui.handle));
    assert.equal((await f.action('contacts','approve',{})).error?.code,'unsupported');
    assert.deepEqual((await f.hub.overview('agents',f.ui.handle) as any).jobs,[]);
    await assert.rejects(f.hub.overview('agents',f.context({authority:'task',taskId:'task-1'}).handle),e=>e instanceof ExtensionHubError&&e.code==='forbidden');
  }finally{await f.hub.close();}
});

test('Hub contact composition consumes the existing earned route proof and outbox without sending twice after restart',async()=>{
  const base=new Date(2026,0,2,10).getTime(),settings=defaultExtensionSettings();settings.contacts={enabled:true,automaticEnabled:true};
  const message={channel:'sms' as const,sender:'+15550000001',recipient:'+15550000002',body:'Neutral fixture alert.'};
  const policy:ContactChannelPolicy={enabled:true,configured:true,sender:message.sender,optedInRecipientHashes:[sha256(message.recipient)],maxDispatchCostMicros:100,dailyBudgetMicros:1000,maxPerMinute:10,maxPerDay:20};
  let providerCalls=0,sends=0;
  const provider:ContactProvider={id:'fixture-sms',channel:'sms',prepare:async value=>({dispatch:async()=>{providerCalls++;if(value.body===message.body)sends++;return {state:'accepted',recordId:'remote-'+providerCalls};}})};
  const resolved:ResolvedContact={message,channelPolicy:policy,execution:{active:true,localOnly:false},context:{settings,privateSession:false,containsPrivateContent:false,rules:[],approvals:[],
    route:{id:'route-1',revision:1,adapter:provider.id,recipientId:'recipient-1',recipientSha256:sha256(message.recipient),kind:'self',enabled:true,
      verification:{method:'user-challenge',recordId:'unearned',verifiedAt:base-1000,expiresAt:base+86400000}},
    workflow:{id:'workflow-1',enabled:true,automatic:true,templateIds:['template-1']},template:{id:'template-1',version:1,bodySha256:sha256(reviewedContactBody(message)),contentClass:'personal'}}};
  const f=await fixture({contacts:{providers:[provider],resolve:async()=>resolved,availability:async()=>({enabled:true,configured:true,ready:true})}});
  let restarted:ExtensionHub|undefined;
  try{
    await f.action('contacts','configure',{enabled:true,automaticEnabled:true});
    const service=new ContactsService({store:f.store,clock:f.options.clock,providers:[provider],resolve:async()=>resolved,
      resolveVerification:async()=>{const {verification,...route}=resolved.context.route!;return {route,channel:'sms',recipient:message.recipient,channelPolicy:policy};}});
    const challenge=await service.beginVerification('route-1'),code=(await f.store.get('contact-outbox','main')).challenges[0].code;
    await service.dispatch(challenge.requestId,new AbortController().signal);
    const {verification,...route}=resolved.context.route!;resolved.context.route=await service.completeVerification(challenge.challengeId,code,route);f.advance(86400001);
    const intent={requestId:'message-once',binding:{routeId:'route-1',routeRevision:1,recipientId:'recipient-1',recipientSha256:sha256(message.recipient),workflowId:'workflow-1',templateId:'template-1',templateVersion:1,bodySha256:sha256(reviewedContactBody(message))}};
    const task=f.context({authority:'task',taskId:'task-1'}),request={requestId:intent.requestId,taskId:'task-1',input:intent};
    const first=await f.hub.dispatch('contacts','send',request,task.handle);assert.equal(first.outcome,'completed');assert.equal(first.delivery?.state,'accepted');assert.equal(sends,1);
    assert.equal((await f.hub.dispatch('contacts','send',request,task.handle)).delivery?.id,first.delivery?.id);assert.equal(sends,1);
    await f.hub.close();restarted=await createExtensionHub(f.options);
    const ctx:HubHostContext={authority:'task',taskId:'task-1',privateSession:false,localOnly:false,privacyEpoch:'epoch-1',signal:new AbortController().signal};
    assert.equal((await restarted.dispatch('contacts','send',request,restarted.context(()=>ctx))).delivery?.id,first.delivery?.id);assert.equal(sends,1);
    assert.equal(f.writes.some(w=>w.kind===hubRecordKinds.request&&w.value.feature==='contacts'),true,'only configure has a Hub receipt; sends remain in the one existing outbox');
  }finally{await restarted?.close();await f.hub.close();}
});

test('Hub stores only a task-parent-bound UI delegation grant and missing native resources cannot be enabled by probes',async()=>{
  const parent={taskId:'task-1',request:'Inspect a selected project',createdAt:1000,mode:'scoped' as const,revoked:false};
  const temporary=fs.realpathSync.native(os.tmpdir()),directory=fs.mkdtempSync(path.join(temporary,'capri-hub-grant-'));
  const root=path.join(directory,'project'),privateRoot=path.join(directory,'control'),configDir=path.join(directory,'provider');fs.mkdirSync(root);fs.mkdirSync(configDir);let authorizations=0;
  const f=await fixture({agents:{native:{controlRoot:privateRoot,leases:new AgentLeasePool(),helperPath:path.join(privateRoot,'missing.exe'),helperSha256:'0'.repeat(64)},
    resolveAuthority:async(_task,_provider,workspaceId)=>{authorizations++;return {settings:defaultExtensionSettings(),privateSession:false,localOnly:false,parentGrant:parent,
      workspace:{id:workspaceId==='workspace-1'?workspaceId:'outside',root,writable:true,excludedRoots:[configDir]},configuration:{provider:'codex',executable:process.execPath,model:'configured-codex-model',configDir,isolated:true}};},
    providerStatus:async()=>[{provider:'codex',enabled:true,configured:true,ready:true}],catalog:async()=>({tasks:[{id:'task-1',label:'Selected task'}],workspaces:[{id:'workspace-1',label:'Staged workspace'}]})}});
  try{
    await f.action('agents','configure',{codexEnabled:true});const ui=f.context({taskId:'task-1'});
    const request={requestId:'grant-1',taskId:'task-1',input:{providers:['codex'],workspaceIds:['workspace-1'],allowPaid:false,expiresInMinutes:5}};
    assert.equal((await f.hub.dispatch('agents','grant',request,ui.handle)).outcome,'completed');assert.ok(authorizations>0);
    const grant=(await f.store.get(hubRecordKinds.grant,'task-1')).grant;assert.equal(grant.request,parent.request);assert.equal(grant.createdAt,parent.createdAt);assert.equal(grant.allowPaid,false);
    assert.equal((await f.hub.status(ui.handle)).agents.find(item=>item.provider==='codex')!.capability.available,false);
    const task=f.context({authority:'task',taskId:'task-1'});
    const started=await f.hub.dispatch('agents','start',{requestId:'no-native',taskId:'task-1',input:{provider:'codex',workspaceId:'workspace-1',prompt:'No actual inference'}},task.handle);
    assert.equal(started.error?.code,'unavailable');assert.equal(f.rows.has('extension:agents:request:no-native'),false);
    parent.revoked=true;assert.notEqual((await f.hub.dispatch('agents','grant',{...request,requestId:'revoked-grant'},ui.handle)).outcome,'completed');
    const overview=await f.hub.overview('agents',ui.handle) as any;assert.equal(overview.grants.length,1);assert.equal(overview.grants[0].request,undefined);
  }finally{await f.hub.close();if(path.dirname(path.resolve(directory))!==temporary||!path.basename(directory).startsWith('capri-hub-grant-'))throw Error('Invalid isolated Hub fixture cleanup');fs.rmSync(directory,{recursive:true,force:true});}
});

test('live contact guards prevent stale effects after credential preparation or durable dispatch marker without an original signal abort',async()=>{
  for(const phase of ['prepare','marker'] as const)for(const boundary of ['private','local-only','epoch'] as const){
    const db=memory(),put=db.store.put,entered=deferred(),gate=deferred();let held=false,sends=0;
    const base=new Date(2026,0,2,10).getTime(),settings=defaultExtensionSettings();settings.contacts={enabled:true,automaticEnabled:true};
    const message={channel:'sms' as const,sender:'+15550000001',recipient:'+15550000002',body:'Neutral privacy boundary fixture.'};
    const policy:ContactChannelPolicy={enabled:true,configured:true,sender:message.sender,optedInRecipientHashes:[sha256(message.recipient)],maxDispatchCostMicros:100,dailyBudgetMicros:1000,maxPerMinute:10,maxPerDay:20};
    db.store.put=async(kind,value)=>{const result=await put(kind,value);
      if(phase==='marker'&&!held&&kind==='contact-outbox'&&value.entries?.some((entry:any)=>entry.intent.requestId==='race-message'&&entry.phase==='dispatching')){held=true;entered.resolve();await gate.promise;}return result;};
    const provider:ContactProvider={id:'boundary-sms',channel:'sms',prepare:async value=>{
      if(phase==='prepare'&&value.body===message.body&&!held){held=true;entered.resolve();await gate.promise;}
      return {dispatch:async()=>{if(value.body===message.body)sends++;return {state:'accepted',recordId:'remote-fixture'};}};
    }};
    const resolved:ResolvedContact={message,channelPolicy:policy,execution:{active:true,localOnly:false},context:{settings,privateSession:false,containsPrivateContent:false,rules:[],approvals:[],
      route:{id:'route-1',revision:1,adapter:provider.id,recipientId:'recipient-1',recipientSha256:sha256(message.recipient),kind:'self',enabled:true,verification:{method:'user-challenge',recordId:'unearned',verifiedAt:base-1000,expiresAt:base+86400000}},
      workflow:{id:'workflow-1',enabled:true,automatic:true,templateIds:['template-1']},template:{id:'template-1',version:1,bodySha256:sha256(reviewedContactBody(message)),contentClass:'personal'}}};
    const f=await fixture({contacts:{providers:[provider],resolve:async()=>resolved,availability:async()=>({enabled:true,configured:true,ready:true})}},db);
    try{
      await f.action('contacts','configure',{enabled:true,automaticEnabled:true});
      const service=new ContactsService({store:f.store,clock:f.options.clock,providers:[provider],resolve:async()=>resolved,resolveVerification:async()=>{
        const {verification,...route}=resolved.context.route!;return {route,channel:'sms',recipient:message.recipient,channelPolicy:policy};}});
      const challenge=await service.beginVerification('route-1'),code=(await f.store.get('contact-outbox','main')).challenges[0].code;
      await service.dispatch(challenge.requestId,new AbortController().signal);const {verification,...route}=resolved.context.route!;
      resolved.context.route=await service.completeVerification(challenge.challengeId,code,route);f.advance(86400001);
      const scope=f.context({authority:'task',taskId:'task-1'}),intent={requestId:'race-message',binding:{routeId:'route-1',routeRevision:1,recipientId:'recipient-1',recipientSha256:sha256(message.recipient),workflowId:'workflow-1',templateId:'template-1',templateVersion:1,bodySha256:sha256(reviewedContactBody(message))}};
      const request={requestId:intent.requestId,taskId:'task-1',input:intent},work=f.hub.dispatch('contacts','send',request,scope.handle);await entered.promise;
      if(boundary==='private')scope.source.privateSession=true;else if(boundary==='local-only')scope.source.localOnly=true;else scope.source.privacyEpoch='epoch-2';
      assert.equal(scope.source.signal.aborted,false);gate.resolve();assert.notEqual((await work).outcome,'completed',phase+':'+boundary);assert.equal(sends,0,phase+':'+boundary);
      const next=f.context({authority:'task',taskId:'task-1',privacyEpoch:'epoch-3'});assert.notEqual((await f.hub.dispatch('contacts','send',request,next.handle)).outcome,'completed');assert.equal(sends,0);
      assert.equal(f.writes.some(write=>write.kind===hubRecordKinds.request&&write.value.action==='send'),false);
    }finally{gate.resolve();await f.hub.close();}
  }
});
