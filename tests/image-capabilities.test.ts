import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Assistant} from '../src/server/assistant';
import {capabilities} from '../src/server/capabilities';
import {createService,hash} from '../src/server/service';
import {LocalSpeech} from '../src/server/local-speech';
import {SpeechOutput,defaultSpeechPreferences} from '../src/server/speech-output';
import {Store} from '../src/server/store';
import {defaults,Settings} from '../src/shared';

const headers={authorization:'Bearer image-test-admin'};
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/YQAAAAASUVORK5CYII=';
const response=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
async function fixture(patch:Partial<Settings>={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'capri-image-capabilities-'));
 const store=await new Store(dir,randomBytes(32)).init();
 await store.put('settings',{...defaults,initiative:false,maxSuggestions:0,...patch,id:'main'});
 const settings=async()=>({...defaults,...await store.get('settings','main')}) as Settings;
 const ai=new Assistant(store,settings,()=> 'fake-openai-key',()=>{},async()=>({}));
 return {dir,store,settings,ai,close:async()=>{await ai.shutdown();await store.close();await rm(dir,{recursive:true,force:true});}};
}
const fakeSpeech=(ready:boolean)=>({status:(engine:string)=>({ready,engine,reason:ready?'':'Selected local speech models are missing.'}),stop:()=>{},close:async()=>{}}) as unknown as LocalSpeech;

test('image policy defaults to follow and requires explicit permission for cloud images with local reasoning',async t=>{
 const f=await fixture();t.mock.method(globalThis,'fetch',async()=>{throw Error('Policy checks must not contact a provider.');});
 try{
  for(const mode of [undefined,'follow','openai','disabled'] as const){
   for(const providerMode of ['local','openai'])for(const key of [undefined,'fake-key']){
    await f.store.put('settings',{...defaults,id:'main',providerMode,imageProviderMode:mode});f.ai.key=()=>key;
    const status=await f.ai.router.imageStatus();
    assert.equal(status.mode,mode??'follow');
    assert.equal(status.available,!!key&&mode!=='disabled'&&(mode==='openai'||providerMode==='openai'));
    assert.equal(status.verification,'configuration');
    if(!status.available){assert.ok(status.reason);await assert.rejects(f.ai.image('A garden'));}
   }
  }
  assert.deepEqual(await f.store.list('usage'),[]);
 }finally{await f.close();}
});

test('authenticated capabilities and settings migrate old records without changing the voice or personal data',async t=>{
 const f=await fixture({providerMode:'local'});
 const {imageProviderMode:_,...legacy}=await f.settings();await f.store.put('settings',{...legacy,id:'main'});
 await f.store.put('memory',{id:'existing',text:'Keep my old personal data.'});
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{assert.equal(String(input),'http://127.0.0.1:11434/api/tags');assert.equal(new Headers(init?.headers).has('Authorization'),false);return response({models:[{name:defaults.localModel}]});});
 const service=await createService({store:f.store,adminToken:'image-test-admin',key:()=> 'fake-key'});
 try{
  assert.equal((await service.app.inject({method:'GET',url:'/v1/capabilities'})).statusCode,401);
  assert.equal((await service.app.inject({method:'GET',url:'/v1/capabilities',headers:{authorization:'Bearer wrong'}})).statusCode,401);
  const initial=(await service.app.inject({method:'GET',url:'/v1/capabilities',headers})).json();
  assert.equal(initial.reasoning.provider,'local');assert.equal(initial.reasoning.available,true);
  assert.equal(initial.images.mode,'follow');assert.equal(initial.images.available,false);assert.equal(initial.speech.available,false);
  assert.deepEqual(initial.capabilities.map((item:any)=>item.id),['reasoning','images','speech']);
  for(const item of initial.capabilities)assert.equal(item.available,initial[item.id].available);
  const saved=(await service.app.inject({method:'GET',url:'/v1/settings',headers})).json();
  assert.equal(saved.imageProviderMode,'follow');assert.equal(saved.voice,legacy.voice);assert.equal(saved.speechEngine,legacy.speechEngine);
  await f.store.put('device',{id:hash('phone-token'),role:'phone',revoked:false});
  const phone={authorization:'Bearer phone-token'};
  assert.equal((await service.app.inject({method:'GET',url:'/v1/capabilities',headers:phone})).statusCode,200);
  assert.equal((await service.app.inject({method:'PATCH',url:'/v1/settings',headers:phone,payload:{imageProviderMode:'openai'}})).statusCode,403);
  for(const mode of ['bad','',null,1])assert.equal((await service.app.inject({method:'PATCH',url:'/v1/settings',headers,payload:{imageProviderMode:mode}})).statusCode,400);
  assert.equal((await service.app.inject({method:'PATCH',url:'/v1/settings',headers,payload:{imageProviderMode:'openai'}})).statusCode,200);
  const allowed=(await service.app.inject({method:'GET',url:'/v1/capabilities',headers})).json();
  assert.equal(allowed.images.available,true);assert.equal(allowed.reasoning.provider,'local');
  assert.equal(allowed.capabilities.find((item:any)=>item.id==='images').available,true);
  assert.equal((await f.store.get('memory','existing'))?.text,'Keep my old personal data.');
  assert.deepEqual(await f.store.list('usage'),[]);
 }finally{await service.app.close();await rm(f.dir,{recursive:true,force:true});}
});

test('an unconfigured service reports no ready image, speech, or reasoning provider',async t=>{
 const f=await fixture({localFallback:false});t.mock.method(globalThis,'fetch',async()=>{throw Error('No provider request expected.');});
 const {app}=await createService({store:f.store,adminToken:'image-test-admin',key:()=>undefined});
 try{const status=(await app.inject({method:'GET',url:'/v1/capabilities',headers})).json();for(const name of ['images','speech','reasoning']){assert.equal(status[name].available,false);assert.ok(status[name].reason);}assert.equal(status.speech.provider,'none');assert.equal(status.speech.output.available,false);}finally{await app.close();await rm(f.dir,{recursive:true,force:true});}
});

test('source attachments and prompt are validated before reserving money or issuing requests',async t=>{
 const f=await fixture({imageProviderMode:'openai'});t.mock.method(globalThis,'fetch',async()=>{throw Error('Invalid images must not reach a provider.');});
 try{
  for(const id of ['missing','',null,42,'x'.repeat(151)])await assert.rejects(f.ai.image('Edit this',undefined,id as any));
  for(const image of [{mime:'text/plain',base64:png},{mime:'image/png',base64:''},{mime:'image/png',base64:'!!!!'},{mime:'image/png',base64:Buffer.from('not an image').toString('base64')},{mime:'image/jpeg',base64:png},{mime:'image/png',base64:png+'x'},{mime:'image/png',base64:'a'.repeat(8*1024*1024+1)}]){
   const row=await f.store.put('attachment',image);await assert.rejects(f.ai.image('Edit this',undefined,row.id));
  }
  await assert.rejects(f.ai.image(''));
  assert.deepEqual(await f.store.list('usage'),[]);
 }finally{await f.close();}
});

test('Image Studio generates and edits explicitly selected attachments with local reasoning and the existing one dollar budget',async t=>{
 const f=await fixture({providerMode:'local',imageProviderMode:'openai'});let calls=0;
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  calls++;assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer fake-key');assert.equal(init?.redirect,'error');
  const reserved=(await f.store.list('usage')).filter(x=>x.reserved);assert.equal(reserved.length,1);assert.equal(reserved[0].amount,1);
  if(calls===1){assert.equal(String(input),'https://api.openai.com/v1/images/generations');const body=JSON.parse(String(init?.body));assert.equal(body.model,defaults.imageModel);assert.equal(body.quality,'low');assert.equal(body.prompt,'A garden');}
  else{assert.equal(String(input),'https://api.openai.com/v1/images/edits');const form=init?.body as FormData;assert.equal(form.get('prompt'),'Add a pond');assert.equal(form.get('model'),defaults.imageModel);const source=form.get('image[]') as File;assert.equal(source.type,'image/png');assert.equal(Buffer.from(await source.arrayBuffer()).toString('base64'),png);}
  return response({data:[{b64_json:png}]});
 });
 const {app,assistant}=await createService({store:f.store,adminToken:'image-test-admin',key:()=> 'fake-key'});
 try{
  const generated=await app.inject({method:'POST',url:'/v1/images',headers,payload:{prompt:'A garden'}});assert.equal(generated.statusCode,200);
  const id=generated.json().attachmentId;assert.equal((await app.inject({method:'POST',url:'/v1/images',headers,payload:{prompt:'Add a pond',attachmentId:id}})).statusCode,200);
  assert.equal(calls,2);assert.equal(await assistant.router.selected(),'local');
  const usage=await f.store.list('usage');assert.equal(usage.reduce((n,x)=>n+x.amount,0),2);assert.ok(usage.every(x=>!x.reserved));
  const image=await app.inject({method:'GET',url:generated.json().url,headers});assert.equal(image.statusCode,200);assert.equal(image.headers['content-type'],'image/png');
 }finally{await app.close();await rm(f.dir,{recursive:true,force:true});}
});

test('image exhaustion persists independently and does not reroute or replay reasoning',async t=>{
 const f=await fixture({imageProviderMode:'openai'});let images=0,reasoning=0;
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
  if(String(input).endsWith('/images/generations')){images++;return response({error:{message:'Image allowance reached',code:'insufficient_quota'}},429);}
  assert.equal(String(input),'https://api.openai.com/v1/responses');reasoning++;return response({output:[],usage:{input_tokens:10,output_tokens:10}});
 });
 try{
  await assert.rejects(f.ai.image('A garden'),/Image allowance reached/);
  assert.equal(await f.ai.router.selected(),'openai');assert.equal((await f.ai.capabilityStatus()).images.available,false);assert.equal((await f.ai.capabilityStatus()).reasoning.available,true);
  const restarted=new Assistant(f.store,f.settings,()=> 'fake-openai-key',()=>{},async()=>({}));
  await assert.rejects(restarted.image('Try again'),/image allowance reached/);assert.equal(images,1);
  await restarted.call('responses',{model:defaults.model,input:'Continue reasoning'});assert.equal(reasoning,1);assert.equal(await f.store.get('connection','fallback'),undefined);
  assert.equal((await f.store.list('usage')).find(x=>x.category==='image')?.amount,0);
 }finally{await f.close();}
});

test('known image access failures block images while ordinary rate limits remain retryable',async t=>{
 const f=await fixture();let status=401;
 t.mock.method(globalThis,'fetch',async()=>response({error:{message:'Image request rejected',code:status===429?'rate_limit_exceeded':'access_denied'}},status));
 try{for(status of [401,403,404,429,500]){
  await f.ai.router.clearImageBlock();await assert.rejects(f.ai.image('A garden'),/Image request rejected/);
  assert.equal((await f.ai.router.imageStatus()).available,![401,403,404].includes(status));assert.equal(await f.ai.router.selected(),'openai');
  assert.ok((await f.store.list('usage')).every(x=>x.amount===0&&!x.reserved));
 }}finally{await f.close();}
});

test('explicit image provider reselection recovers image access without clearing reasoning fallback',async t=>{
 const f=await fixture({providerMode:'local'});t.mock.method(globalThis,'fetch',async()=>{throw Error('No provider calls expected.');});
 await f.ai.router.blockImages('Image access blocked','insufficient_quota');await f.ai.router.block('Reasoning allowance reached','insufficient_quota');
 const {app,assistant}=await createService({store:f.store,adminToken:'image-test-admin',key:()=> 'fake-key'});
 try{
  assert.equal((await app.inject({method:'PATCH',url:'/v1/settings',headers,payload:{imageProviderMode:'openai'}})).statusCode,200);
  assert.equal((await assistant.router.imageStatus()).available,true);assert.equal((await f.store.get('connection','fallback'))?.active,true);
  assert.equal(await assistant.router.selected(),'local');
 }finally{await app.close();await rm(f.dir,{recursive:true,force:true});}
});

test('follow images recover on explicit provider reselection without wider permission or automatic requests',async t=>{
 const f=await fixture();let images=0,fail=true;
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
  if(String(input)==='http://127.0.0.1:11434/api/tags')return response({models:[{name:defaults.localModel}]});
  assert.equal(String(input),'https://api.openai.com/v1/images/generations');images++;
  return fail?response({error:{message:'Restore image credits',code:'insufficient_quota'}},429):response({data:[{b64_json:png}]});
 });
 const {app,assistant}=await createService({store:f.store,adminToken:'image-test-admin',key:()=> 'fake-key'});
 try{
  const actions=[
   ()=>assistant.router.switch('openai'),
   ()=>app.inject({method:'POST',url:'/v1/provider',headers,payload:{mode:'auto'}}),
   ()=>app.inject({method:'PATCH',url:'/v1/settings',headers,payload:{providerMode:'openai'}}),
   ()=>app.inject({method:'POST',url:'/v1/chat',headers,payload:{text:'use OpenAI'}}),
  ];
  for(const action of actions){
   fail=true;await assert.rejects(assistant.image('A garden'),/Restore image credits/);const before=images;
   await assert.rejects(assistant.image('No automatic retry'),/image allowance reached/);assert.equal(images,before);
   await action();assert.equal(images,before);assert.equal((await assistant.router.imageStatus()).available,true);
   assert.equal((await f.settings()).imageProviderMode,'follow');
   fail=false;await assistant.image('Explicit retry');assert.equal(images,before+1);
  }
  await assistant.router.blockImages('Blocked','insufficient_quota');await assistant.router.switch('local');
  assert.equal((await f.store.get('connection','images'))?.active,true);
  await assert.rejects(assistant.image('Local remains forbidden'));const before=images;
  await app.inject({method:'PATCH',url:'/v1/settings',headers,payload:{imageProviderMode:'disabled',providerMode:'auto'}});
  await assert.rejects(assistant.image('Disabled remains forbidden'));assert.equal(images,before);
 }finally{await app.close();await rm(f.dir,{recursive:true,force:true});}
});

test('only a successfully verified key replacement clears image blocking and preserves follow policy and reasoning fallback',async t=>{
 const f=await fixture({localFallback:false});let key='sk-'+ 'a'.repeat(24),accept=false,saved=0,checks=0;
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  assert.equal(String(input),'https://api.openai.com/v1/models/'+encodeURIComponent(defaults.model));
  assert.equal(init?.method,undefined);checks++;return response({},accept?200:403);
 });
 const {app,assistant}=await createService({store:f.store,adminToken:'image-test-admin',key:()=>key,saveKey:async next=>{saved++;key=next;}});
 try{
  await assistant.router.blockImages('Invalid image key','invalid_api_key',401);
  await assistant.router.block('Reasoning fallback remains active','insufficient_quota');
  const replacement='sk-'+ 'b'.repeat(24);
  assert.equal((await app.inject({method:'POST',url:'/v1/connection',headers,payload:{key:replacement}})).statusCode,403);
  assert.equal(saved,0);assert.equal((await f.store.get('connection','images'))?.active,true);
  accept=true;
  assert.equal((await app.inject({method:'POST',url:'/v1/connection',headers,payload:{key}})).statusCode,200);
  assert.equal((await f.store.get('connection','images'))?.active,true);
  assert.equal((await app.inject({method:'POST',url:'/v1/connection',headers,payload:{key:replacement}})).statusCode,200);
  assert.equal((await f.store.get('connection','images'))?.active,false);
  assert.equal((await f.store.get('connection','fallback'))?.active,true);
  assert.equal((await f.settings()).imageProviderMode,'follow');assert.equal((await assistant.router.imageStatus()).available,true);
  await app.inject({method:'PATCH',url:'/v1/settings',headers,payload:{providerMode:'local'}});
  assert.equal((await assistant.router.imageStatus()).available,false);
  assert.equal(checks,3);assert.equal(saved,2);assert.deepEqual(await f.store.list('usage'),[]);
 }finally{await app.close();await rm(f.dir,{recursive:true,force:true});}
});

test('changing the image model clears model failures but retains authentication and quota blocks',async t=>{
 const f=await fixture();let status=404,code='model_not_found',calls=0;
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
  assert.equal(String(input),'https://api.openai.com/v1/images/generations');calls++;
  return response({error:{message:'Image provider rejected the request',code}},status);
 });
 const {app,assistant}=await createService({store:f.store,adminToken:'image-test-admin',key:()=> 'fake-key'});
 const patch=(payload:any)=>app.inject({method:'PATCH',url:'/v1/settings',headers,payload});
 try{
  for(const failure of [{status:404,code:'model_not_found',cleared:true},{status:403,code:'model_not_available',cleared:true},{status:401,code:'invalid_api_key',cleared:false},{status:429,code:'insufficient_quota',cleared:false}]){
   ({status,code}=failure);await assistant.router.clearImageBlock();
   await assert.rejects(assistant.image('A garden'),/Image provider rejected/);const before=calls;
   const old=(await f.settings()).imageModel;
   assert.equal((await patch({imageModel:old})).statusCode,200);assert.equal((await f.store.get('connection','images'))?.active,true);
   await patch({voiceSpeed:1});assert.equal((await f.store.get('connection','images'))?.active,true);
   assert.equal((await patch({imageModel:old+'-replacement'})).statusCode,200);
   assert.equal((await assistant.router.imageStatus()).available,failure.cleared);
   assert.equal((await f.settings()).imageProviderMode,'follow');assert.equal(calls,before);
   assert.equal(await f.store.get('connection','fallback'),undefined);
  }
 }finally{await app.close();await rm(f.dir,{recursive:true,force:true});}
});

test('application budget blocks images independently and local speech remains ready at zero budget',async t=>{
 const f=await fixture({monthlyBudget:.5});t.mock.method(globalThis,'fetch',async()=>{throw Error('Budget checks must not contact a provider.');});
 const {app,assistant}=await createService({store:f.store,adminToken:'image-test-admin',key:()=> 'fake-key',speech:fakeSpeech(true)});
 try{
  let status=(await app.inject({method:'GET',url:'/v1/capabilities',headers})).json();assert.equal(status.reasoning.available,true);assert.equal(status.images.available,false);assert.match(status.images.reason,/budget/);assert.equal(status.speech.available,true);
  await assert.rejects(assistant.image('A garden'),/budget reached/);assert.deepEqual(await f.store.list('usage'),[]);
  await app.inject({method:'PATCH',url:'/v1/settings',headers,payload:{monthlyBudget:0,providerMode:'local'}});
  status=await assistant.speechStatus!();assert.equal(status.available,true);assert.equal(status.provider,'local');assert.deepEqual(status.operations,['speak','transcribe']);
 }finally{await app.close();await rm(f.dir,{recursive:true,force:true});}
});

test('speech readiness uses the selected local engine and independent configured ElevenLabs output',async t=>{
 const f=await fixture({providerMode:'local'});let connected=false;let localReady=false;const engines:string[]=[];
 t.mock.method(globalThis,'fetch',async()=>{throw Error('Speech readiness must not make paid requests.');});
 const output=new SpeechOutput({directory:f.dir,key:()=>connected?'fake-elevenlabs-key':undefined,saveKey:async()=>{},preferences:async()=>({...defaultSpeechPreferences}),local:async()=>{throw Error('No speech synthesis in readiness tests.');}});
 const speech={...fakeSpeech(false),status:(engine:string)=>{engines.push(engine);return {ready:localReady,reason:localReady?'':'Selected engine is missing.',engine};}} as unknown as LocalSpeech;
 const {app,assistant}=await createService({store:f.store,adminToken:'image-test-admin',key:()=>undefined,speech,speechOutput:output});
 try{
  assert.equal((await assistant.speechStatus!()).available,false);
  connected=true;assert.equal((await assistant.speechStatus!()).available,false);
  await f.store.put('desktop',{id:'speech',preferences:{costPer1000Characters:.3}});
  let status:any=await assistant.speechStatus!();assert.equal(status.available,true);assert.equal(status.provider,'elevenlabs');assert.deepEqual(status.operations,['speak']);assert.equal(status.output.voiceId,defaultSpeechPreferences.voiceId);assert.equal(status.realtime.available,false);
  localReady=true;connected=false;status=await assistant.speechStatus!();assert.equal(status.provider,'local');assert.deepEqual(status.operations,['speak','transcribe']);
  assert.ok(engines.every(engine=>engine===defaults.speechEngine));assert.deepEqual(await f.store.list('usage'),[]);
 }finally{await app.close();await rm(f.dir,{recursive:true,force:true});}
});

test('OpenAI realtime readiness follows its own transport, key, and reservation budget',async t=>{
 const f=await fixture({voiceTransport:'realtime',localFallback:false});let key:string|undefined='fake-key';
 t.mock.method(globalThis,'fetch',async()=>{throw Error('Readiness must not open a realtime session.');});
 const {app,assistant}=await createService({store:f.store,adminToken:'image-test-admin',key:()=>key});
 try{
  let status:any=await assistant.speechStatus!();assert.equal(status.available,true);assert.equal(status.provider,'openai');assert.equal(status.local.ready,false);assert.equal(status.realtime.available,true);
  key=undefined;assert.equal((await assistant.speechStatus!()).available,false);key='fake-key';
  await app.inject({method:'PATCH',url:'/v1/settings',headers,payload:{monthlyBudget:.5}});assert.equal((await assistant.speechStatus!()).available,false);
  await app.inject({method:'PATCH',url:'/v1/settings',headers,payload:{monthlyBudget:75,voiceTransport:'local'}});assert.equal((await assistant.speechStatus!()).available,false);
 }finally{await app.close();await rm(f.dir,{recursive:true,force:true});}
});

test('capabilities tool keeps host capabilities while replacing unverified provider claims with service evidence',async t=>{
 const f=await fixture();let hostCalls=0;const signal=new AbortController().signal;
 t.mock.method(globalThis,'fetch',async()=>{throw Error('No provider verification call expected.');});
 f.ai.host=async(name,args,received,taskId)=>{hostCalls++;assert.equal(name,'capabilities');assert.equal(received,signal);assert.equal(taskId,'granted-task');return {capabilities:[{id:'browser',available:true},{id:'images',available:false}],existing:'preserved'};};
 try{
  const result=await f.ai.tool('capabilities',{},signal,false,'granted-task');assert.equal(hostCalls,1);assert.equal(result.existing,'preserved');assert.equal(result.capabilities.find((c:any)=>c.id==='browser').available,true);assert.equal(result.capabilities.filter((c:any)=>c.id==='images').length,1);assert.equal(result.capabilities.find((c:any)=>c.id==='images').available,true);assert.equal(result.capabilities.find((c:any)=>c.id==='speech').available,false);
 }finally{await f.close();}
});

test('desktop Settings host-only capabilities omit service-owned provider rows instead of claiming them unavailable',()=>{
 for(const browserAvailable of [false,true]){
  const items=capabilities(browserAvailable,['Terraria']);
  assert.ok(items.every(item=>!['images','reasoning','speech'].includes(item.id)));
  assert.equal(items.find(item=>item.id==='browser')?.available,browserAvailable);
  assert.equal(items.find(item=>item.id==='artifacts')?.available,true);
  assert.equal(items.find(item=>item.id==='games')?.reason,'Detected: Terraria');
 }
});

test('Stop aborts an in-flight image request and prevents saving or replaying its late result',async t=>{
 const f=await fixture();let called!:()=>void;const started=new Promise<void>(resolve=>called=resolve);let release!:(value:Response)=>void;let calls=0;
 t.mock.method(globalThis,'fetch',async(_input:RequestInfo|URL,init?:RequestInit)=>{calls++;called();const result=await new Promise<Response>(resolve=>release=resolve);assert.equal(init?.signal?.aborted,true);return result;});
 try{
  const job=f.ai.image('A garden');await started;f.ai.stop();release(response({data:[{b64_json:png}]}));await assert.rejects(job);
  assert.equal(calls,1);assert.deepEqual(await f.store.list('attachment'),[]);assert.equal((await f.store.list('usage'))[0].reserved,false);assert.equal((await f.store.list('usage'))[0].amount,1);assert.equal(f.ai.jobs.size,0);
 }finally{await f.close();}
});

test('a policy change while waiting for the image reservation refunds it before dispatch',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw Error('The changed policy must prevent provider dispatch.');});
 for(const patch of [{imageProviderMode:'disabled' as const},{imageProviderMode:'follow' as const,providerMode:'local'}]){
  const f=await fixture({imageProviderMode:'openai'});const reserve=f.ai.reserve.bind(f.ai);
  f.ai.reserve=async(category,amount)=>{const row=await reserve(category,amount);await f.store.put('settings',{...await f.settings(),...patch,id:'main'});return row;};
  try{
   await assert.rejects(f.ai.image('A garden'));const usage=await f.store.list('usage');assert.equal(usage.length,1);assert.equal(usage[0].amount,0);assert.equal(usage[0].reserved,false);
   const cancelled=new AbortController();cancelled.abort();await assert.rejects(f.ai.image('A garden',cancelled.signal));assert.equal((await f.store.list('usage')).length,1);
  }finally{await f.close();}
 }
});
