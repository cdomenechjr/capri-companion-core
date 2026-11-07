import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SpeechOutput,defaultSpeechPreferences,offlinePhrases} from '../src/server/speech-output';
import {wav} from '../src/server/local-speech';
const audio=wav(new Float32Array(1600),24000);
async function fixture(fetcher:typeof fetch,keyValue:string|undefined|null='test-eleven-key'){
 const directory=await mkdtemp(path.join(os.tmpdir(),'capri-output-'));let key=keyValue??undefined;let localCalls=0;const requests:any[]=[];
 const output=new SpeechOutput({directory,key:()=>key,saveKey:async value=>{key=value;},preferences:async()=>({...defaultSpeechPreferences}),local:async()=>{localCalls++;return {base64:audio.toString('base64'),mime:'audio/wav'};},fetch:async(url,init)=>{requests.push({url,init});return fetcher(url,init);}});
 return {output,requests,directory,get localCalls(){return localCalls;},get key(){return key;},close:()=>rm(directory,{recursive:true,force:true})};
}
test('ElevenLabs speech uses the pinned voice, validates audio, and deduplicates concurrent deliveries',async()=>{
 const f=await fixture(async()=>new Response(audio));try{const a=f.output.speak('same','Hello');const b=f.output.speak('same','Hello');assert.equal(a,b);const result=await a;assert.equal(result.provider,'elevenlabs');assert.equal(f.requests.length,1);assert.match(String(f.requests[0].url),/MkTSSXNgnBULS6ek4pon/);assert.equal(JSON.parse(f.requests[0].init.body).model_id,'eleven_multilingual_v2');assert.equal(f.localCalls,0);await assert.rejects(f.output.speak('same','Hello'),/cancelled/);}finally{await f.close();}
});
test('missing credentials, invalid keys, unavailable voices, exhausted credits and timeouts use local fallback',async()=>{
 for(const scenario of ['missing','401','403','404','429','timeout','invalid-audio']){const f=await fixture(async()=>{if(scenario==='timeout')throw new DOMException('Timed out','TimeoutError');return scenario==='invalid-audio'?new Response('invalid'):new Response(JSON.stringify({detail:{status:'quota_exceeded'}}),{status:Number(scenario)||500});},scenario==='missing'?null:'test-key');try{const result=await f.output.speak('fallback','Hello');assert.equal(result.provider,'local',scenario);assert.ok(result.fallbackReason,scenario);assert.equal(f.localCalls,1);if(scenario==='missing')assert.equal(f.requests.length,0);}finally{await f.close();}}
});
test('connection keys are saved only after voice access has been verified',async()=>{
 const denied=await fixture(async()=>new Response('{}',{status:401}),'old-key');try{await assert.rejects(denied.output.connection('new-key'),/rejected/);assert.equal(denied.key,'old-key');}finally{await denied.close();}
 const good=await fixture(async()=>new Response('{}'));try{await good.output.connection('new-key');assert.equal(good.key,'new-key');}finally{await good.close();}
});
test('interrupt cancels synthesis without fallback or late audio, including cancellation before delivery',async()=>{
 const f=await fixture(async(_url,init)=>new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})));try{const request=f.output.speak('pending','Hello');await new Promise(r=>setImmediate(r));f.output.cancel('pending');await assert.rejects(request);assert.equal(f.localCalls,0);f.output.cancel('before');await assert.rejects(f.output.speak('before','Hello'),/cancelled/);assert.equal(f.requests.length,1);}finally{await f.close();}
});
test('only the explicit fixed phrase pack is cached, works offline, and private conversations bypass it',async()=>{
 let online=true;const f=await fixture(async(url)=>{if(!online)throw Error('Offline');return new Response(String(url).includes('/text-to-speech/')?audio:'{}');});try{
  await f.output.speak('chat','Personal conversation');assert.deepEqual(await readdir(f.directory),[]);
  assert.deepEqual(await f.output.downloadPhrases(),{saved:8});assert.equal((await readdir(f.directory)).length,8);const calls=f.requests.length;online=false;
  const cached=await f.output.speak('cached',offlinePhrases.greeting);assert.equal(cached.fromCache,true);assert.equal(f.requests.length,calls);
  const privateReply=await f.output.speak('private',offlinePhrases.greeting,true);assert.equal(privateReply.provider,'local');assert.equal(privateReply.fromCache,false);
 }finally{await f.close();}
});
test('Stop aborts the whole phrase download and does not start subsequent paid generations',async()=>{
 let began!:()=>void;const firstRequest=new Promise<void>(resolve=>began=resolve);let started=0;const f=await fixture(async(url,init)=>{if(!String(url).includes('/text-to-speech/'))return new Response('{}');started++;began();return new Promise((_r,reject)=>init!.signal!.addEventListener('abort',()=>reject(Error('Aborted')),{once:true}));});try{const work=f.output.downloadPhrases();await firstRequest;f.output.stop();await assert.rejects(work);assert.equal(started,1);}finally{await f.close();}
});
