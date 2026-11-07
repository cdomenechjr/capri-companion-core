import {readFileSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';

export const DETECTOR_FRAME_SAMPLES=1600;
export class SpeechDetectorInputError extends Error {}
export type SpeechDetectionRequest={sessionId:string;sequence:number;samples:string;reset?:boolean};
export type SpeechDetectionResult={sessionId:string;sequence:number}&(
 {available:true;speech:boolean}|{available:false;reason:string});
/** Native inference only. No transcription, task submission, playback or persistent audio storage. */
export interface SpeechDetectorTransport {
 detect(samples:Float32Array):boolean|Promise<boolean>;
 reset():void;
}
export type DetectorFactory=(model:string)=>SpeechDetectorTransport|Promise<SpeechDetectorTransport>;

/** Resolve only nonempty regular files beneath the configured model root, including through junctions. */
export function speechModelFile(directory:string,name:unknown){
 if(typeof name!=='string'||!name||path.isAbsolute(name))throw Error('model-missing');
 const root=realpathSync(directory),file=realpathSync(path.resolve(root,name));
 const relative=path.relative(root,file);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('model-missing');
 const info=statSync(file);if(!info.isFile()||info.size===0)throw Error('model-missing');return file;
}

const SILERO_WINDOW=512;
/** Native waveform ring bound: 2 context windows + 1 onset window + the next window (128 ms).
 * Segment/scratch copies are also bounded by these windows; this is not a native heap byte count.
 */
export const SILERO_HISTORY_SAMPLES=4*SILERO_WINDOW;
type SileroVad={acceptWaveform(samples:Float32Array):void;isDetected():boolean;isEmpty():boolean;pop():void;flush():void;reset():void;clear():void};

/** Read ONNX protobuf fields without loading tensors or adding a model-parser dependency. */
function protobufFields(bytes:Uint8Array){
 let pos=0;const fields:{id:number;bytes:Uint8Array}[]=[];
 const integer=()=>{let n=0,scale=1;for(let i=0;i<10&&pos<bytes.length;i++){const b=bytes[pos++];n+=(b&127)*scale;
  if(!(b&128)){if(!Number.isSafeInteger(n))throw Error('unsupported-vad-model');return n;}scale*=128;}throw Error('unsupported-vad-model');};
 while(pos<bytes.length){const tag=integer(),wire=tag%8,id=Math.floor(tag/8);if(!id)throw Error('unsupported-vad-model');
  if(wire===0){integer();continue;}
  const size=wire===2?integer():wire===1?8:wire===5?4:-1;
  if(size<0||size>bytes.length-pos)throw Error('unsupported-vad-model');
  if(wire===2)fields.push({id,bytes:bytes.subarray(pos,pos+size)});pos+=size;
 }return fields;
}
/** The installed k2-fsa v4 model has x/h/c inputs, with no waveform overlap. v5 needs a different
 * window/overlap adapter: reject it honestly rather than discard its pending samples on flush.
 */
function requireSileroV4(model:string){
 if(statSync(model).size>16*1024*1024)throw Error('unsupported-vad-model');
 const bytes=readFileSync(model);
 try{const graph=protobufFields(bytes).find(f=>f.id===7);if(!graph)throw Error('unsupported-vad-model');
  const inputs=protobufFields(graph.bytes).filter(f=>f.id===11).map(f=>{
   const name=protobufFields(f.bytes).find(f=>f.id===1);return name?Buffer.from(name.bytes).toString('utf8'):'';
  }).sort().join(',');
  if(inputs!=='c,h,x'&&inputs!=='c,h,input,sr')throw Error('unsupported-vad-model');
 }finally{bytes.fill(0);}
}

/** Flush is a waveform-history boundary, NOT a model reset. sherpa v4 keeps its recurrent/onset/
 * silence state. Never flush partial windows: it would discard pending, not-yet-inferred PCM.
 * Silence retains at most 1536 samples; the next full window reaches 2048 before pruning/flush.
 * pop alone and maxSpeechDuration do NOT impose this bound on an ongoing voiced segment.
 */
export function boundedSileroV4Transport(vad:SileroVad):SpeechDetectorTransport{
 const window=new Float32Array(SILERO_WINDOW);let used=0;
 return {detect(samples){let speech=false;
  for(let start=0;start<samples.length;){const n=Math.min(SILERO_WINDOW-used,samples.length-start);
   window.set(samples.subarray(start,start+n),used);used+=n;start+=n;
   if(used===SILERO_WINDOW){try{
    vad.acceptWaveform(window);const active=vad.isDetected();speech=active||!vad.isEmpty()||speech;
    if(active)vad.flush(); // emit and release the ongoing segment, preserving Silero recurrent state
    while(!vad.isEmpty())vad.pop(); // never copy native segment audio into JS
   }finally{window.fill(0);used=0;}}
  }return speech;
 },reset(){window.fill(0);used=0;vad.reset();vad.clear();}};
}

/** sherpa exposes a boolean, not Silero probabilities. Do not fabricate a probability from energy. */
export const createSileroDetector:DetectorFactory=model=>{
 requireSileroV4(model);const sherpa=require('sherpa-onnx-node');
 return boundedSileroV4Transport(new sherpa.Vad({sileroVad:{model,threshold:.5,minSilenceDuration:.032,minSpeechDuration:.032,
  windowSize:SILERO_WINDOW,maxSpeechDuration:.1},sampleRate:16000,numThreads:1,provider:'cpu',debug:false},.2));
};

type Epoch={tail:Promise<void>;handle?:SpeechDetectorTransport;buffers:Set<Float32Array>;cancelled:boolean;pending:number;reason?:string};
type Session={sequence:number;epoch:Epoch;touched:number;reason?:string};
export type SpeechDetectorOptions={factory?:DetectorFactory;now?:()=>number;ttlMs?:number;maxSessions?:number;maxPending?:number};
const bounded=(value:number|undefined,fallback:number,min:number,max:number)=>Number.isFinite(value)?Math.max(min,Math.min(max,Math.round(value!))):fallback;

/**
 * Session IDs belong to one desktop capture owner. Reset starts a new inference generation, but never lowers its
 * sequence high-water mark. Gaps require reset; replays and old queued generations never reach native inference.
 * Idle state expires after 30 s, renewed by accepted frames. Tombstones retain only ordering metadata for up to
 * 10 minutes since the last frame. All capacity limits include abandoned native work until settled.
 */
export class SessionSpeechDetector {
 private sessions=new Map<string,Session>();private pending=0;private closed=false;
 private work=new Set<Promise<SpeechDetectionResult>>();
 private timer?:ReturnType<typeof setInterval>;
 private now:()=>number;private ttl:number;private factory:DetectorFactory;private maxSessions:number;private maxPending:number;
 constructor(private directory:string,options:SpeechDetectorOptions={}){
  this.now=options.now??Date.now;this.ttl=bounded(options.ttlMs,30000,1000,60000);
  this.factory=options.factory??createSileroDetector;this.maxSessions=bounded(options.maxSessions,4,1,8);
  this.maxPending=bounded(options.maxPending,6,1,12);
 }
 private epoch():Epoch{return {tail:Promise.resolve(),buffers:new Set(),cancelled:false,pending:0};}
 private clear(epoch:Epoch,reason='stale-generation'){epoch.cancelled=true;epoch.reason=reason;for(const b of epoch.buffers)b.fill(0);epoch.buffers.clear();
  // Native async work, if injected, owns the handle until it settles. Production VAD inference is synchronous.
  if(!epoch.pending)this.release(epoch);
 }
 private release(epoch:Epoch){try{epoch.handle?.reset();}catch{}epoch.handle=undefined;}
 private retire(session:Session,reason:string){session.reason=reason;this.clear(session.epoch,reason);}
 private sweep(){const now=this.now();for(const [id,s] of this.sessions){
  if(!s.reason&&now-s.touched>=this.ttl)this.retire(s,'session-expired');
  if(s.reason&&!s.epoch.pending&&now-s.touched>=600000)this.sessions.delete(id);
 }if(!this.sessions.size&&this.timer){clearInterval(this.timer);this.timer=undefined;}}
 /** Trusted Stop/privacy/device transition can cancel one capture session without affecting another. */
 cancel(sessionId:string){const s=this.sessions.get(sessionId);if(s)this.retire(s,'cancelled');}
 stop(){for(const s of this.sessions.values())this.retire(s,'cancelled');if(this.timer)clearInterval(this.timer);this.timer=undefined;}
 async close(){this.closed=true;this.stop();await Promise.all(this.work);}
 async detect(input:unknown,signal?:AbortSignal):Promise<SpeechDetectionResult>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new SpeechDetectorInputError('Invalid speech detector frame.');
  const r=input as SpeechDetectionRequest;
  if(Object.keys(r).some(k=>!['sessionId','sequence','samples','reset'].includes(k))||typeof r.sessionId!=='string'||
   !/^[a-zA-Z0-9._:-]{1,128}$/.test(r.sessionId)||!Number.isSafeInteger(r.sequence)||r.sequence<0||
   (r.reset!==undefined&&typeof r.reset!=='boolean')||typeof r.samples!=='string'||r.samples.length!==8536||
   !/^[A-Za-z0-9+/]+={2}$/.test(r.samples))throw new SpeechDetectorInputError('Invalid speech detector frame.');
  const unavailable=(reason:string):SpeechDetectionResult=>({sessionId:r.sessionId,sequence:r.sequence,available:false,reason});
  if(this.closed||signal?.aborted)return unavailable('cancelled');this.sweep();
  let s=this.sessions.get(r.sessionId);
  if(s?.reason)return unavailable(s.reason);
  if(s&&r.sequence<=s.sequence)return unavailable('stale-frame');
  if(s&&r.sequence!==s.sequence+1&&!r.reset)return unavailable('sequence-gap');
  if(s?.epoch.cancelled&&!r.reset)return unavailable('reset-required');
  if(!s&&r.sequence!==0&&!r.reset)return unavailable('reset-required');
  if(this.pending>=this.maxPending)return unavailable('busy');
  if(!s&&(this.sessions.size>=64||[...this.sessions.values()].filter(s=>!s.reason).length>=this.maxSessions))return unavailable('busy');
  const bytes=Buffer.from(r.samples,'base64');if(bytes.length!==6400||bytes.toString('base64')!==r.samples){bytes.fill(0);throw new SpeechDetectorInputError('Invalid speech detector PCM.');}
  const samples=new Float32Array(DETECTOR_FRAME_SAMPLES);for(let i=0;i<samples.length;i++)samples[i]=bytes.readFloatLE(i*4);bytes.fill(0);
  if(samples.some(n=>!Number.isFinite(n)||Math.abs(n)>1.1)){samples.fill(0);throw new SpeechDetectorInputError('Invalid speech detector PCM.');}
  if(!s){s={sequence:-1,epoch:this.epoch(),touched:this.now()};this.sessions.set(r.sessionId,s);
   if(!this.timer){this.timer=setInterval(()=>this.sweep(),1000);this.timer.unref();}}
  if(r.reset){this.clear(s.epoch);s.epoch=this.epoch();}
  s.sequence=r.sequence;s.touched=this.now();const session=s,epoch=s.epoch;epoch.pending++;this.pending++;epoch.buffers.add(samples);
  // A transport timeout invalidates this generation, but a higher-sequence reset can retry the same capture session.
  const abort=()=>this.clear(epoch,'cancelled');signal?.addEventListener('abort',abort,{once:true});
  const live=()=>!this.closed&&!signal?.aborted&&!epoch.cancelled&&session.epoch===epoch&&!session.reason;
  const work=epoch.tail.then(async()=>{
   try{
    this.sweep();if(!live())return unavailable(session.reason??epoch.reason??'cancelled');
    if(!epoch.handle){let file:string;try{file=speechModelFile(this.directory,'silero_vad.onnx');}catch{return unavailable('model-missing');}
     try{epoch.handle=await this.factory(file);}catch{return unavailable('native-unavailable');}}
    if(!live())return unavailable(session.reason??epoch.reason??'cancelled');
    const speech=await epoch.handle.detect(samples);this.sweep();
    if(!live())return unavailable(session.reason??epoch.reason??'cancelled');
    if(typeof speech!=='boolean')return unavailable('native-unavailable');
    return {sessionId:r.sessionId,sequence:r.sequence,available:true as const,speech};
   }catch{if(live())this.retire(session,'native-unavailable');return unavailable(session.reason??epoch.reason??'cancelled');}
   finally{samples.fill(0);epoch.buffers.delete(samples);epoch.pending--;this.pending--;signal?.removeEventListener('abort',abort);
    if(epoch.cancelled&&!epoch.pending)this.release(epoch);}
  });epoch.tail=work.then(()=>{});this.work.add(work);void work.finally(()=>this.work.delete(work));return work;
 }
}

export type RecognitionBackendId='whisper'|'parakeet';
export interface RecognitionBackend {
 createStream():{acceptWaveform(input:{samples:Float32Array;sampleRate:number}):void};
 decodeAsync(stream:any):Promise<{text?:string}>;
}
/** Only the host's speech.json selects recognition. Optional model presence never changes the legacy default. */
export function recognitionConfiguration(directory:string,manifest:any,backend?:RecognitionBackendId){
 const selected=backend??manifest.recognition?.backend??'whisper';
 if(selected!=='whisper'&&selected!=='parakeet')throw Error('Unknown local recognition backend.');
 const file=(name:unknown)=>speechModelFile(directory,name);
 const model=selected==='whisper'?{whisper:{encoder:file(manifest.encoder),decoder:file(manifest.decoder),language:'en',task:'transcribe'},tokens:file(manifest.tokens)}:
  {transducer:{encoder:file(manifest.recognition?.parakeet?.encoder),decoder:file(manifest.recognition?.parakeet?.decoder),joiner:file(manifest.recognition?.parakeet?.joiner)},tokens:file(manifest.recognition?.parakeet?.tokens),modelType:'nemo_transducer'};
 return {backend:selected as RecognitionBackendId,config:{featConfig:{sampleRate:16000,featureDim:80},modelConfig:{...model,numThreads:3,provider:'cpu'},decodingMethod:'greedy_search'}};
}
