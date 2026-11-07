import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {SessionSpeechDetector,recognitionConfiguration,speechModelFile,boundedSileroV4Transport,SILERO_HISTORY_SAMPLES,createSileroDetector,type SpeechDetectorTransport} from '../src/extensions/speech';
import {LocalSpeech,wav,readReferenceWav} from '../src/server/local-speech';

const pcm=(samples:Float32Array)=>Buffer.from(samples.buffer,samples.byteOffset,samples.byteLength).toString('base64');
const frame=(sequence=0,sessionId='capture-1',samples:Float32Array=new Float32Array(1600),reset=false)=>({sessionId,sequence,samples:pcm(samples),...(reset?{reset:true}:{})});
const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(run:(directory:string)=>Promise<void>){const dir=await mkdtemp(path.join(os.tmpdir(),'capri-speech-detector-'));try{
 await writeFile(path.join(dir,'silero_vad.onnx'),'fake model: test transports only');await run(dir);
}finally{await rm(dir,{recursive:true,force:true});}}
/** Deterministic varied PCM tests transport/order/ownership, not Silero recognition accuracy. */
function voiced(){return Float32Array.from({length:1600},(_,i)=>.12*Math.sin(i*.09)*(1+.3*Math.sin(i*.003))+.04*Math.sin(i*.21));}

test('hard history boundary drains ongoing speech without resets, dropped samples, padding or frame-phase changes',()=>{
 let history=0,maximum=0,queued=0,onset=0,active=false,resets=0,flushes=0,count=0;
 let expected=0,quiet=true;const references:Float32Array[]=[];
 const native={acceptWaveform(samples:Float32Array){
  assert.equal(samples.length,512,'native only receives complete inference windows');references.push(samples);
  for(const n of samples){assert.equal(n,quiet?0:Math.fround(((expected++%251)+1)/1000));count++;}
  history+=samples.length;maximum=Math.max(maximum,history);
  active=!quiet&&++onset>=2;if(!active)history=Math.min(history,1536);
 },isDetected:()=>active,isEmpty:()=>queued===0,pop(){queued--;},flush(){
  assert.equal(count%512,0);assert.ok(active);flushes++;queued++;history=0;active=false;
  // A real sherpa flush clears the segment boundary, leaving the recurrent/onset state intact.
 },reset(){resets++;history=0;queued=0;onset=0;},clear(){queued=0;}};
 const d=boundedSileroV4Transport(native);
 assert.equal(d.detect(new Float32Array(1536)),false);assert.equal(maximum,1536);quiet=false;
 for(let frame=0;frame<1200;frame++){
  const samples=Float32Array.from({length:1600},(_,i)=>(((frame*1600+i)%251)+1)/1000);
  assert.equal(d.detect(samples),true,'sustained speech survives every native flush and HTTP-frame boundary');samples.fill(0);
  assert.equal(queued,0);assert.equal(resets,0);
  assert.ok(references.at(-1)!.subarray(((frame+1)*1600)%512).every(v=>v===0),'only the pending partial window may retain PCM');
 }
 assert.equal(count,1200*1600+1536);assert.ok(flushes>3700);assert.equal(maximum,SILERO_HISTORY_SAMPLES,'exercise the full silence-to-onset bound');
 // The last 64 samples of a 100 ms frame wait in the adapter, then must be wiped on privacy reset.
 d.detect(Float32Array.from({length:64},(_,i)=>(((count+i)%251)+1)/1000));d.reset();
 assert.equal(resets,1);expected=0;assert.equal(d.detect(Float32Array.from({length:512},(_,i)=>((i%251)+1)/1000)),false);
 d.reset();assert.ok(references.every(b=>b.every(v=>v===0)));
});

test('strict 100ms float PCM contract rejects malformed frames before loading a native model',async()=>fixture(async dir=>{
 let loads=0;const d=new SessionSpeechDetector(dir,{factory:()=>{loads++;throw Error();}});
 try{for(const input of [null,{},frame(-1),frame(0,'bad/name'),{...frame(),reset:'yes'}, {...frame(),generation:1},frame(0,'short',new Float32Array(1599)),frame(0,'nan',new Float32Array(1600).fill(NaN)),frame(0,'loud',new Float32Array(1600).fill(2))]){
  await assert.rejects(()=>d.detect(input),/Invalid/);
 }assert.equal(loads,0);}finally{await d.close();}
}));

test('audio decisions use isolated native streams and echo identities without energy pretending to be a model',async()=>fixture(async dir=>{
 const handles:{calls:number;references:Float32Array[];resets:number}[]=[];
 const d=new SessionSpeechDetector(dir,{factory:()=>{const state={calls:0,references:[] as Float32Array[],resets:0};handles.push(state);
  return {detect(samples){state.calls++;state.references.push(samples);return samples.some(v=>v>.05);},reset(){state.resets++;}};}});
 try{assert.deepEqual(await d.detect(frame()),{sessionId:'capture-1',sequence:0,available:true,speech:false});
  assert.equal((await d.detect(frame(1,'capture-1',voiced())) as any).speech,true);
  assert.equal((await d.detect(frame(0,'capture-2'))) .available,true);assert.equal(handles.length,2);
  assert.deepEqual(handles.map(h=>h.calls),[2,1]);assert.ok(handles.flatMap(h=>h.references).every(b=>b.every(n=>n===0)),'caller PCM is wiped after inference');
 }finally{await d.close();}assert.ok(handles.every(h=>h.resets===1));
}));

test('replayed/out-of-order frames never infer; missing frames need a reset and reset cannot rewind sequence',async()=>fixture(async dir=>{
 let calls=0,loads=0;const d=new SessionSpeechDetector(dir,{factory:()=>{loads++;return {detect(){calls++;return false;},reset(){}};}});
 try{await d.detect(frame());
  assert.equal((await d.detect(frame())).available,false);assert.equal((await d.detect(frame(3)) as any).reason,'sequence-gap');
  assert.equal((await d.detect(frame(0,'capture-1',voiced(),true)) as any).reason,'stale-frame');
  assert.equal(calls,1);assert.equal((await d.detect(frame(3,'capture-1',voiced(),true))).available,true);
  assert.equal(loads,2);assert.equal(calls,2);
 }finally{await d.close();}
}));

test('concurrent frames execute in reservation order even with asynchronous native transport',async()=>fixture(async dir=>{
 const gate=deferred<boolean>();let calls=0;const seen:number[]=[];
 const d=new SessionSpeechDetector(dir,{factory:()=>({detect(samples){seen.push(samples[0]);return ++calls===1?gate.promise:false;},reset(){}})});
 try{const a=d.detect(frame(0,'ordered',new Float32Array(1600).fill(.1)));const b=d.detect(frame(1,'ordered',new Float32Array(1600).fill(.2)));
  await tick();assert.equal(calls,1);gate.resolve(true);const result=await Promise.all([a,b]);
  assert.equal(calls,2);assert.ok(Math.abs(seen[0]-.1)<.00001&&Math.abs(seen[1]-.2)<.00001);assert.deepEqual(result.map(r=>r.sequence),[0,1]);
 }finally{gate.resolve(false);await d.close();}
}));

test('reset invalidates delayed generations and queued PCM without releasing their capacity early',async()=>fixture(async dir=>{
 const gate=deferred<boolean>();let calls=0,resets=0;const buffers:Float32Array[]=[];
 const d=new SessionSpeechDetector(dir,{maxPending:3,factory:()=>({detect(b){buffers.push(b);calls++;return calls===1?gate.promise:false;},reset(){resets++;}})});
 try{const a=d.detect(frame(0,'reset',voiced())),b=d.detect(frame(1,'reset',voiced()));await tick();
  const c=d.detect(frame(2,'reset',voiced(),true));assert.equal((await d.detect(frame(3,'reset')) as any).reason,'busy');
  await tick();assert.equal(calls,2);assert.ok(buffers[0].every(n=>n===0));gate.resolve(true);
  const results=await Promise.all([a,b,c]);assert.deepEqual(results.map(r=>r.available),[false,false,true]);assert.equal(calls,2);assert.equal(resets,1);
 }finally{gate.resolve(false);await d.close();}
}));

test('abort invalidates its generation for reset/retry; trusted cancellation and Stop retain session tombstones',async()=>fixture(async dir=>{
 const gate=deferred<boolean>();let calls=0;let buffer:Float32Array|undefined;const controller=new AbortController();
 const d=new SessionSpeechDetector(dir,{factory:()=>({detect(b){calls++;if(calls===1){buffer=b;return gate.promise;}return false;},reset(){}})});
 try{const a=d.detect(frame(0,'old',voiced()),controller.signal),b=d.detect(frame(1,'old',voiced()));await tick();controller.abort();
  assert.ok(buffer!.every(v=>v===0));assert.equal((await d.detect(frame(2,'old')) as any).reason,'reset-required');
  assert.equal((await d.detect(frame(2,'old',voiced(),true))).available,true);d.cancel('old');
  assert.equal((await d.detect(frame(3,'old',voiced(),true)) as any).reason,'cancelled');
  assert.equal((await d.detect(frame(0,'new'))).available,true);d.stop();gate.resolve(true);
  assert.deepEqual((await Promise.all([a,b])).map(r=>r.available),[false,false]);assert.equal(calls,3);
 }finally{gate.resolve(false);await d.close();}
}));

test('TTL expires native state, late frames stay unavailable and session/pending limits are bounded',async()=>fixture(async dir=>{
 let now=0,resets=0;const d=new SessionSpeechDetector(dir,{now:()=>now,ttlMs:1000,maxSessions:1,factory:()=>({detect:()=>false,reset(){resets++;}})});
 try{await d.detect(frame());assert.equal((await d.detect(frame(0,'other')) as any).reason,'busy');now=1001;
  assert.equal((await d.detect(frame(1)) as any).reason,'session-expired');assert.equal(resets,1);
  assert.equal((await d.detect(frame(0,'other'))).available,true);
 }finally{await d.close();}
}));

test('close waits for abandoned generation work and blocks late detector results',async()=>fixture(async dir=>{
 const gate=deferred<SpeechDetectorTransport>();let calls=0,resets=0;
 const d=new SessionSpeechDetector(dir,{factory:()=>gate.promise});
 const a=d.detect(frame());await tick();const b=d.detect(frame(1,'capture-1',voiced(),true));
 let closed=false;const close=d.close().then(()=>closed=true);await tick();assert.equal(closed,false);
 gate.resolve({detect(){calls++;return true;},reset(){resets++;}});await close;
 assert.deepEqual((await Promise.all([a,b])).map(r=>r.available),[false,false]);assert.equal(calls,0);assert.equal(resets,1);
 assert.equal((await d.detect(frame(0,'late')) as any).reason,'cancelled');
}));

test('unavailable model/native errors have bounded reasons, never energy speech or leaked paths',async()=>fixture(async dir=>{
 const missing=new SessionSpeechDetector(path.join(dir,'absent'));
 const broken=new SessionSpeechDetector(dir,{factory:()=>{throw Error('sensitive native error C:/private');}});
 const failed=new SessionSpeechDetector(dir,{factory:()=>({detect(){throw Error('secret');},reset(){}})});
 try{assert.equal((await missing.detect(frame()) as any).reason,'model-missing');assert.equal((await broken.detect(frame(0,'broken',voiced())) as any).reason,'native-unavailable');
  assert.equal((await failed.detect(frame(0,'failed',voiced())) as any).reason,'native-unavailable');
 }finally{await Promise.all([missing.close(),broken.close(),failed.close()]);}
}));

async function recognitionFiles(dir:string){for(const f of ['encoder','decoder','joiner','tokens'])await writeFile(path.join(dir,f),'fake');
 return {encoder:'encoder',decoder:'decoder',tokens:'tokens',recognition:{parakeet:{encoder:'encoder',decoder:'decoder',joiner:'joiner',tokens:'tokens'}}};}

test('manifest-selected recognition preserves Whisper default and validates every optional model file',async()=>fixture(async dir=>{
 const cfg=await recognitionFiles(dir);assert.equal(recognitionConfiguration(dir,cfg).backend,'whisper');
 const selected=recognitionConfiguration(dir,{...cfg,recognition:{...cfg.recognition,backend:'parakeet'}});assert.equal(selected.backend,'parakeet');
 assert.equal(selected.config.modelConfig.modelType,'nemo_transducer');assert.equal(recognitionConfiguration(dir,cfg).backend,'whisper');
 await rm(path.join(dir,'joiner'));assert.throws(()=>recognitionConfiguration(dir,cfg,'parakeet'));
 assert.throws(()=>recognitionConfiguration(dir,{recognition:{backend:'cloud'}}));
 await mkdir(path.join(dir,'nested'));assert.throws(()=>speechModelFile(path.join(dir,'nested'),'../encoder'));
 await writeFile(path.join(dir,'empty'),'');assert.throws(()=>speechModelFile(dir,'empty'));assert.throws(()=>speechModelFile(dir,'nested'));
}));

test('LocalSpeech exposes detection without recognition/task effects; canceled transcription never decodes or returns a stale result',async()=>fixture(async dir=>{
 const cfg=await recognitionFiles(dir);await writeFile(path.join(dir,'speech.json'),JSON.stringify(cfg));
 let loads=0,decodes=0;const ready=deferred<any>();const speech=new LocalSpeech(dir,undefined,{factory:()=>({detect:()=>false,reset(){}}),createRecognizer:()=>{loads++;return ready.promise;}});
 try{await assert.rejects(()=>speech.detect({}),(e:any)=>e.status===400);await speech.detect(frame());await speech.detect(frame());assert.equal(loads,0);assert.equal(decodes,0);
  const controller=new AbortController(),p=speech.transcribe(pcm(voiced()),controller.signal);await tick();controller.abort();
  ready.resolve({createStream(){throw Error('must not create stale stream');},decodeAsync(){decodes++;}});
  await assert.rejects(()=>p);assert.equal(decodes,0);assert.equal((await speech.detect(frame(1))).available,true);
 }finally{await speech.close();}
}));

test('recognition backend changes require explicit manifest configuration and missing selection never falls back',async()=>fixture(async dir=>{
 const cfg:any=await recognitionFiles(dir);await writeFile(path.join(dir,'speech.json'),JSON.stringify(cfg));const configs:any[]=[];const references:Float32Array[]=[];
 const speech=new LocalSpeech(dir,undefined,{createRecognizer:async config=>{configs.push(config);return {createStream:()=>({acceptWaveform:({samples})=>references.push(samples)}),decodeAsync:async()=>({text:' Hello Capri '})};}});
 try{assert.deepEqual(await speech.transcribe(pcm(voiced())),{text:'Hello Capri',local:true});assert.ok(configs[0].modelConfig.whisper);
  cfg.recognition.backend='parakeet';await writeFile(path.join(dir,'speech.json'),JSON.stringify(cfg));await speech.transcribe(pcm(voiced()));assert.ok(configs[1].modelConfig.transducer);
  assert.ok(references.every(b=>b.every(n=>n===0)));await rm(path.join(dir,'joiner'));await assert.rejects(()=>speech.transcribe(pcm(voiced())),/missing or invalid/);assert.equal(configs.length,2);
 }finally{await speech.close();}
}));

test('installed Silero smoke: digital silence stays silent, or absence is explicitly unavailable',async()=>{
 const d=new SessionSpeechDetector(path.resolve('models'));
 try{for(let i=0;i<6;i++){const result=await d.detect(frame(i,'native-silence'));
  if(!result.available){assert.equal(result.reason,'model-missing','installed native failures must be investigated');return;}
  assert.equal(result.speech,false);
 }}finally{await d.close();}
});

test('installed Silero sustained neutral read-speech fixture: 120 seconds stays bounded with natural pause, resumption and Stop',async t=>{
 let model:string;try{model=speechModelFile(path.resolve('models'),'silero_vad.onnx');}catch{
  const d=new SessionSpeechDetector(path.resolve('models'));try{assert.equal((await d.detect(frame()) as any).reason,'model-missing');
   t.diagnostic('Native sustained acceptance unavailable: optional model missing.');return;
  }finally{await d.close();}
 }
 // Read the existing optional Whisper bundle's neutral read-speech fixture in place. Never copy
 // audio/transcripts into source or export. An installed-model acceptance run needs this fixture;
 // its absence is a failure for the operator to resolve, not a skipped native test or a download.
 const bytes=readFileSync(speechModelFile(path.resolve('models'),'sherpa-onnx-whisper-tiny.en/test_wavs/0.wav'));
 const fixtureSha256=createHash('sha256').update(bytes).digest('hex');let audio:ReturnType<typeof readReferenceWav>;
 try{audio=readReferenceWav(bytes);}finally{bytes.fill(0);}
 assert.equal(audio.sampleRate,16000);let position=0;
 const generate=()=>Float32Array.from({length:1600},()=>audio.samples[position++%audio.samples.length]);
 const sherpa=require('sherpa-onnx-node'),Original=sherpa.Vad;
 let instances=0,flushes=0,pops=0,resets=0,maxSegment=0,accepted=0,initialCapacity=0;
 // Instrument supported APIs only. front(false) makes a private copy, immediately zeroed; production never calls it.
 sherpa.Vad=class extends Original{
  constructor(config:any,seconds:number){super(config,seconds);instances++;initialCapacity=seconds*config.sampleRate;}
  acceptWaveform(samples:Float32Array){assert.equal(samples.length,512);accepted+=samples.length;super.acceptWaveform(samples);}
  flush(){super.flush();flushes++;if(!this.isEmpty()){const segment=this.front(false);try{
   maxSegment=Math.max(maxSegment,segment.samples.length);assert.ok(segment.samples.length<=SILERO_HISTORY_SAMPLES,'actual native segment exceeds hard history bound');
  }finally{segment.samples.fill(0);}}}
  pop(){pops++;super.pop();}
  reset(){resets++;super.reset();}
 };
 const d=new SessionSpeechDetector(path.dirname(model));let sequence=0;
 const send=async(samples:Float32Array)=>{try{const result=await d.detect(frame(sequence++,'native-sustained',samples));
  assert.equal(result.available,true);return (result as {speech:boolean}).speech;
 }finally{samples.fill(0);}};
 try{
  let positive=0;const blocks:number[]=[];
  for(let block=0;block<12;block++){let count=0;for(let i=0;i<100;i++){
   if(await send(generate())){positive++;count++;}assert.equal(resets,0,'history release must not reset recurrent state');
  }blocks.push(count);assert.ok(count>=70,'speech must remain detectable throughout the two-minute stream');}
  assert.ok(positive>=900,`sustained native fixture produced insufficient speech: ${positive}/1200`);
  const pause=[];for(let i=0;i<20;i++)pause.push(await send(new Float32Array(1600)));
  assert.ok(pause.slice(-10).every(s=>!s),'natural silence must not latch speech after flush');
  let resumed=0;for(let i=0;i<50;i++)if(await send(generate()))resumed++;
  assert.ok(resumed>=35,'speech must resume after the natural pause');
  assert.equal(instances,1);assert.equal(initialCapacity,3200);assert.ok(maxSegment>0);assert.ok(flushes>2500);assert.ok(pops>=flushes);
  d.stop();assert.equal(resets,1);assert.equal((await d.detect(frame(sequence,'native-sustained')) as any).reason,'cancelled');
  t.diagnostic(JSON.stringify({mode:'actual-installed-native-neutral-read-speech',fixtureSha256,frames:1200,positive,blocks,resumed,accepted,flushes,pops,maxSegment,initialCapacity,historyLimit:SILERO_HISTORY_SAMPLES}));
 }finally{await d.close();audio.samples.fill(0);sherpa.Vad=Original;}
});

test('unaligned Silero layouts are explicitly unavailable before native inference',async()=>fixture(async dir=>{
 // Minimal ONNX graph inputs for v5 (input/state/sr); real model bytes never enter source/tests.
 const field=(id:number,bytes:Buffer)=>Buffer.concat([Buffer.from([id*8+2,bytes.length]),bytes]);
 const graph=Buffer.concat(['input','state','sr'].map(name=>field(11,field(1,Buffer.from(name)))));
 const model=path.join(dir,'silero_vad.onnx');await writeFile(model,field(7,graph));
 assert.throws(()=>createSileroDetector(model),/unsupported-vad-model/);
 const d=new SessionSpeechDetector(dir);try{assert.equal((await d.detect(frame()) as any).reason,'native-unavailable');}finally{await d.close();}
}));

test('benchmark utilities measure word edits, decode WAV and refuse truncated audio',async()=>{
 const script='../scripts/benchmark-listening.mjs';const {wordErrors,decodeWav}=await import(script);
 assert.deepEqual(wordErrors('Hello, Capri turn on the light','hello capri turn off light'),{edits:2,words:6});
 const bytes=wav(voiced(),16000),audio=decodeWav(bytes);assert.equal(audio.sampleRate,16000);assert.equal(audio.samples.length,1600);
 assert.throws(()=>decodeWav(bytes.subarray(0,100)),/WAV/);assert.deepEqual(wordErrors('','hallucinated words'),{edits:2,words:0});
});

test('offline benchmark reports actual fake decodes, labelled negatives/wake proxy, hashes and unavailable optional models',async()=>fixture(async dir=>{
 const cfg=await recognitionFiles(dir);await writeFile(path.join(dir,'speech.json'),JSON.stringify(cfg));
 await writeFile(path.join(dir,'quiet.wav'),wav(new Float32Array(3200),16000));
 await writeFile(path.join(dir,'command.wav'),wav(voiced(),16000));
 const corpus={cases:[{id:'quiet',wav:'quiet.wav',transcript:'',speech:false,wake:false},{id:'command',wav:'command.wav',transcript:'hey capri turn on the light',speech:true,wake:true}]};
 const fixtures=path.join(dir,'corpus.json');await writeFile(fixtures,JSON.stringify(corpus));await rm(path.join(dir,'joiner'));
 const script='../scripts/benchmark-listening.mjs';const {benchmarkListening}=await import(script);let decoded=0;let closed=0;
 const report=await benchmarkListening({models:dir,fixtures,repeats:2},{createRecognizer:async()=>({createStream:()=>({acceptWaveform(){}}),decodeAsync:async()=>({text:++decoded%2?'':'hey capri turn off the light'})}),
  createDetector:()=>({detect:async()=>({available:true,speech:false}),close:async()=>{closed++;}})});
 assert.equal(decoded,4);assert.equal(closed,2);assert.equal(report.backends[0].cases.length,4);
 assert.equal(report.backends[0].summary.edits,2);assert.equal(report.backends[0].summary.referenceWords,12);
 assert.equal(report.backends[0].summary.wer,1/6);assert.equal(report.backends[0].summary.wakeProxyMisses,0);
 assert.equal(report.vad[0].falseSpeechFrames,0);assert.equal(report.vad[1].missedSpeechCase,true);
 assert.equal(report.backends[1].available,false);assert.equal(report.backends[1].reason,'model-missing-or-invalid');
 assert.equal(report.wake.available,false);assert.equal(report.wake.reason,'wake-model-missing-or-invalid');
 assert.ok(report.backends[0].modelSha256.every((f:any)=>/^[a-f0-9]{64}$/.test(f.sha256)));
 corpus.cases[0].wav='../escape.wav';await writeFile(fixtures,JSON.stringify(corpus));await assert.rejects(()=>benchmarkListening({models:dir,fixtures}));
}));

test('offline keyword benchmark uses fresh real-shaped streams and reports wake misses separately from ASR proxy',async()=>fixture(async dir=>{
 const cfg=await recognitionFiles(dir);await writeFile(path.join(dir,'speech.json'),JSON.stringify(cfg));
 await writeFile(path.join(dir,'wake.json'),JSON.stringify({...cfg,joiner:'joiner'}));await writeFile(path.join(dir,'en.phone'),'HEY HH EY1\nCAPRI K AE1 P R IY0\n');
 await writeFile(path.join(dir,'speech.wav'),wav(voiced(),16000));await writeFile(path.join(dir,'quiet.wav'),wav(new Float32Array(1600),16000));
 const fixtures=path.join(dir,'corpus.json');await writeFile(fixtures,JSON.stringify({cases:[{id:'speech',wav:'speech.wav',transcript:'hey capri',wake:true},{id:'quiet',wav:'quiet.wav',transcript:'',wake:false}]}));
 const script='../scripts/benchmark-listening.mjs';const {benchmarkListening}=await import(script);let streams=0;
 const report=await benchmarkListening({models:dir,fixtures,backends:['whisper'],repeats:1},{createRecognizer:async()=>({createStream:()=>({acceptWaveform(){}}),decodeAsync:async()=>({text:''})}),
  createDetector:()=>({detect:async()=>({available:false,reason:'model-missing'}),close:async()=>{}}),createWake:async()=>({
   createStream(){streams++;return {loud:false,acceptWaveform({samples}:any){this.loud=samples.some((v:number)=>v>.05)||this.loud;}};},
   isReady:()=>false,decode(){},getResult:(stream:any)=>({keyword:stream.loud?'CAPRI_WAKE':''})})});
 assert.equal(streams,2);assert.equal(report.wake.available,true);assert.equal(report.wake.falsePositives,0);assert.equal(report.wake.misses,0);
 assert.equal(report.backends[0].summary.wakeProxyMisses,1,'ASR proxy is distinct from the keyword model');
 assert.equal(report.vad[0].available,false);
}));
