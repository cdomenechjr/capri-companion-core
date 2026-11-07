/**
 * Local listening for the one desktop voice owner: ordered speech decisions from the local detector with an honest energy
 * fallback, an adaptive noise floor, natural turn segmentation, recognizer-sized chunks and barge-in that compares the
 * microphone with Capri's actual rendered playback. Audio is held only for the current turn, pre-roll and the bounded
 * playback reference; diagnostics are numbers, never audio or transcripts.
 * Speech detection is not echo cancellation or speaker identification and is never an authorization factor.
 */
export const SAMPLE_RATE=16000;
/** /v1/voice/local/transcribe accepts 50 ms to 20 seconds of 16 kHz float PCM. */
export const RECOGNIZER_MAX_SAMPLES=320000;
const RECOGNIZER_MIN_SAMPLES=1600;
/**
 * Hard bound on one continuous turn. Raw audio is never held for this long (parts leave at the recognizer limit); a turn
 * reaching it fails explicitly and nothing of it is submitted. It is not a point at which a partial request is sent.
 */
export const MAX_TURN_SAMPLES=SAMPLE_RATE*300;
const PAUSE_SEARCH_SAMPLES=SAMPLE_RATE*4;
const MIN_VOICED_SAMPLES=3200;
const BARGE_IN_FRAMES=4;
/** The highest noise floor the adaptive threshold (and saved preferences) can use. */
const CALIBRATION_MAX_FLOOR=.05;
const ms=(samples:number)=>Math.round(samples*1000/SAMPLE_RATE);
const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value));

export function rms(samples:Float32Array){let sum=0;for(let i=0;i<samples.length;i++)sum+=samples[i]*samples[i];return Math.sqrt(sum/Math.max(1,samples.length));}
export function encodePcm(samples:Float32Array){const bytes=new Uint8Array(samples.buffer,samples.byteOffset,samples.byteLength);let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
function concat(frames:readonly {samples:Float32Array}[]){const out=new Float32Array(frames.reduce((n,f)=>n+f.samples.length,0));let offset=0;for(const f of frames){out.set(f.samples,offset);offset+=f.samples.length;}return out;}
function pad(samples:Float32Array){if(samples.length>=RECOGNIZER_MIN_SAMPLES)return samples;const out=new Float32Array(RECOGNIZER_MIN_SAMPLES);out.set(samples);return out;}
/** Energy speech threshold. At sensitivity threshold 0.5 without calibration this is the original 0.5 segmenter rule. */
export function speechThreshold(noise:number,vadThreshold=.5,calibratedFloor=0){const t=clamp(vadThreshold,0,1);return Math.max(.003+.006*t,Math.min(Math.max(.015+.02*t,calibratedFloor*2),noise*(1.5+3*t)));}
/**
 * Detector probability needed for speech. Sensitivity 0..1 maps onto 0.1..0.9, so at both slider ends probability 0 stays
 * silence and probability 1 stays speech. A reply's probability, when present, decides; its `speech` flag is used only
 * when it carries no probability.
 */
export function probabilityThreshold(vadThreshold=.5){return .1+.8*clamp(Number.isFinite(vadThreshold)?vadThreshold:.5,0,1);}

// ---------------------------------------------------------------- preferences

/** Renderer-local listening preferences. They map onto the shared ListeningSettings contract; `localOnly` is fixed. */
export type ListeningPreferences={enabled:boolean;bargeIn:boolean;noiseSuppression:boolean;vadThreshold:number;silenceMs:number;diagnostics:boolean;vocabulary:string[];noiseFloor?:number};
export const LISTENING_KEY='capri-listening';
export function defaultListeningPreferences():ListeningPreferences{return {enabled:false,bargeIn:false,noiseSuppression:true,vadThreshold:.5,silenceMs:1400,diagnostics:false,vocabulary:[]};}
const bool=(value:unknown,fallback:boolean)=>typeof value==='boolean'?value:fallback;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
export function normalizeListeningPreferences(value:unknown):ListeningPreferences{
 const d=defaultListeningPreferences();if(!value||typeof value!=='object'||Array.isArray(value))return d;const v=value as Record<string,unknown>;
 const out:ListeningPreferences={enabled:bool(v.enabled,d.enabled),bargeIn:bool(v.bargeIn,d.bargeIn),noiseSuppression:bool(v.noiseSuppression,d.noiseSuppression),
  vadThreshold:finite(v.vadThreshold)?clamp(v.vadThreshold,0,1):d.vadThreshold,silenceMs:finite(v.silenceMs)?Math.round(clamp(v.silenceMs,200,5000)):d.silenceMs,
  diagnostics:bool(v.diagnostics,d.diagnostics),vocabulary:Array.isArray(v.vocabulary)?normalizeVocabulary(v.vocabulary.filter((s):s is string=>typeof s==='string')):[]};
 if(finite(v.noiseFloor))out.noiseFloor=clamp(v.noiseFloor,.0005,.05);
 return out;
}
type ReadStorage=Pick<Storage,'getItem'>;type WriteStorage=Pick<Storage,'setItem'>;
function storage(){try{return globalThis.localStorage;}catch{return undefined;}}
/** Missing or unreadable preferences use defaults without overwriting what is stored. */
export function loadListeningPreferences(store?:ReadStorage){try{const raw=(store??storage())?.getItem(LISTENING_KEY);return normalizeListeningPreferences(raw?JSON.parse(raw):undefined);}catch{return defaultListeningPreferences();}}
export function saveListeningPreferences(preferences:ListeningPreferences,store?:WriteStorage){const normalized=normalizeListeningPreferences(preferences);const target=store??storage();if(!target)throw Error('Listening preferences cannot be saved in this window.');target.setItem(LISTENING_KEY,JSON.stringify(normalized));return normalized;}
/** Merges a change over the stored preferences. */
export function updateListeningPreferences(patch:Partial<ListeningPreferences>,store?:ReadStorage&WriteStorage){return saveListeningPreferences({...loadListeningPreferences(store),...patch},store);}
/** Removes the saved calibration outright; merging a patch without it would bring the stored value back. */
export function clearListeningCalibration(store?:ReadStorage&WriteStorage){const {noiseFloor:_,...rest}=loadListeningPreferences(store);return saveListeningPreferences(rest,store);}
/** The shared `ListeningSettings` record for later extension integration. */
export function toListeningSettings(p:ListeningPreferences){return {enabled:p.enabled,mode:'wake' as const,localOnly:true as const,noiseSuppression:p.noiseSuppression,vadThreshold:p.vadThreshold,silenceMs:p.silenceMs};}

// ---------------------------------------------------------------- vocabulary

const MAX_TERMS=50,MAX_TERM_LENGTH=40;
/** Bounded names/terms the user wants spelled their way. Text only, applied locally after recognition. */
export function normalizeVocabulary(input:string|readonly string[]){
 const items=typeof input==='string'?input.split(/[\n,;]+/):input;const out:string[]=[];const seen=new Set<string>();
 for(const item of items){const term=String(item).normalize('NFKC').replace(/[^\p{L}\p{N}' .-]/gu,'').replace(/\s+/g,' ').trim().slice(0,MAX_TERM_LENGTH).trim();const key=term.toLowerCase();if(!term||seen.has(key))continue;seen.add(key);out.push(term);if(out.length>=MAX_TERMS)break;}
 return out;
}
function withinOneEdit(a:string,b:string){
 if(a===b)return true;if(Math.abs(a.length-b.length)>1)return false;let i=0,j=0,edits=0;
 while(i<a.length&&j<b.length){if(a[i]===b[j]){i++;j++;continue;}if(++edits>1)return false;if(a.length>b.length)i++;else if(b.length>a.length)j++;else{i++;j++;}}
 return edits+(a.length-i)+(b.length-j)<=1;
}
const escapeRegExp=(text:string)=>text.replace(/[.*+?^${}()|[\]\\-]/g,'\\$&');
/** Applies the user's spelling: exact case-insensitive matches, and one-letter slips for single words of six or more letters. */
export function applyVocabulary(text:string,vocabulary:readonly string[]){
 if(!text||!vocabulary.length)return text;let result=text;
 for(const term of vocabulary)result=result.replace(new RegExp('(?<![\\p{L}\\p{N}])'+escapeRegExp(term).replace(/ /g,'\\s+')+'(?![\\p{L}\\p{N}])','giu'),term);
 const words=vocabulary.filter(t=>!t.includes(' ')&&t.length>=6);
 if(words.length)result=result.replace(/[\p{L}\p{N}']+/gu,word=>{if(word.length<6)return word;const lower=word.toLowerCase();return words.find(t=>withinOneEdit(lower,t.toLowerCase()))??word;});
 return result;
}

// ---------------------------------------------------------------- diagnostics

export type ListeningDiagnosticKind='turn'|'chunk'|'discarded'|'overflow'|'barge-in'|'echo-suppressed'|'reference-unknown'|'vad-fallback'|'calibrated';
/** Numeric listening evidence only: no audio, transcript or device names. */
export type ListeningDiagnostic={at:number;kind:ListeningDiagnosticKind;durationMs?:number;frames?:number;noiseFloor?:number;detector?:'model'|'energy';reason?:string};
const DIAGNOSTIC_LIMIT=40;
export class ListeningDiagnostics {
 private entries:ListeningDiagnostic[]=[];private counts:Partial<Record<ListeningDiagnosticKind,number>>={};
 record(entry:ListeningDiagnostic){this.entries.push(entry);if(this.entries.length>DIAGNOSTIC_LIMIT)this.entries.shift();this.counts[entry.kind]=(this.counts[entry.kind]||0)+1;}
 snapshot(){return {entries:this.entries.map(e=>({...e})),counts:{...this.counts}};}
 clear(){this.entries=[];this.counts={};}
}

// ---------------------------------------------------------------- turn segmentation

type Frame={samples:Float32Array;level:number;talking:boolean};
/**
 * A recognizer-sized part of the current turn. `final` closes the turn; parts belong to one submission. `overflow` closes
 * a turn that reached the hard bound: it must fail without submitting any part.
 */
export type SegmentEvent={chunk?:Float32Array;final:boolean;discarded?:boolean;overflow?:boolean;cancelled?:boolean;turnSamples:number};
export type SegmenterOptions={silenceSamples:number;preRollSamples:number;minVoicedSamples?:number;maxChunkSamples?:number;maxTurnSamples?:number};
/**
 * Groups decided frames into turns. Natural pauses shorter than `silenceSamples` stay in the turn. A turn longer than the
 * recognizer limit is split at the quietest recent pause, or exactly at the limit during continuous speech, carrying the
 * remainder forward: no sample is dropped or repeated. A turn reaching `maxTurnSamples` overflows; the rest of that
 * speech is dropped until its natural pause, so no fragment of it can become a request of its own.
 */
export class TurnSegmenter {
 private frames:Frame[]=[];private before:Frame[]=[];private count=0;private beforeCount=0;private silence=0;private voiced=0;private total=0;private emitted=0;private started=false;private draining=false;
 constructor(public options:SegmenterOptions){}
 get collecting(){return this.started;}
 /** Forgets pre-roll held before a turn: audio that must not open a later turn (Capri's echo, unknown playback). */
 dropPreRoll(){if(!this.started){for(const frame of this.before)frame.samples.fill(0);this.before=[];this.beforeCount=0;}}
 /** Zeroes the held turn and pre-roll audio before forgetting it (emitted chunks are separate copies owned by the receiver). */
 wipe(){this.reset();}
 /** Every sample the segmenter forgets is zeroed first: its frames are its own copies. */
 reset(){for(const frame of [...this.frames,...this.before])frame.samples.fill(0);this.frames=[];this.before=[];this.count=0;this.beforeCount=0;this.silence=0;this.voiced=0;this.total=0;this.emitted=0;this.started=false;this.draining=false;}
 push(samples:Float32Array,talking:boolean,level=rms(samples)):SegmentEvent[]{
  const out:SegmentEvent[]=[];
  if(this.draining){if(talking)this.silence=0;else this.silence+=samples.length;if(this.silence>=this.options.silenceSamples)this.reset();return out;}
  const frame={samples:samples.slice(),level,talking};
  if(!this.started){
   if(!talking){this.before.push(frame);this.beforeCount+=samples.length;while(this.before.length>1&&this.beforeCount-this.before[0].samples.length>=this.options.preRollSamples){const old=this.before.shift()!;this.beforeCount-=old.samples.length;old.samples.fill(0);}return out;}
   this.started=true;const preRoll=this.before;this.before=[];this.beforeCount=0;for(const f of preRoll)this.append(f,out);
  }
  this.append(frame,out);if(talking){this.voiced+=samples.length;this.silence=0;}else this.silence+=samples.length;
  if(this.silence>=this.options.silenceSamples)this.finish(out);
  else if(this.total>=(this.options.maxTurnSamples??MAX_TURN_SAMPLES))this.overflow(out);
  return out;
 }
 /** Holds no audio while draining, but stays `collecting` so output still waits for the user's pause. */
 private overflow(out:SegmentEvent[]){const turnSamples=this.total;const silence=this.silence;this.reset();this.started=true;this.draining=true;this.silence=silence;out.push({final:true,overflow:true,turnSamples});}
 private append(frame:Frame,out:SegmentEvent[]){this.frames.push(frame);this.count+=frame.samples.length;this.total+=frame.samples.length;while(this.count>=(this.options.maxChunkSamples??RECOGNIZER_MAX_SAMPLES))this.split(out);}
 private split(out:SegmentEvent[]){
  const limit=this.options.maxChunkSamples??RECOGNIZER_MAX_SAMPLES;let position=0,best=-1,bestLevel=Infinity,bestEnd=0;
  for(let i=0;i<this.frames.length;i++){position+=this.frames[i].samples.length;if(position>limit)break;if(position>=limit-PAUSE_SEARCH_SAMPLES&&position>=limit/2&&!this.frames[i].talking&&this.frames[i].level<=bestLevel){best=i;bestLevel=this.frames[i].level;bestEnd=position;}}
  let chunk:Float32Array;
  // The emitted chunk is the only copy left: frames and intermediate buffers it was cut from are zeroed.
  if(best>=0){const used=this.frames.slice(0,best+1);chunk=concat(used);for(const f of used)f.samples.fill(0);this.frames=this.frames.slice(best+1);this.count-=bestEnd;}
  else{const all=concat(this.frames);for(const f of this.frames)f.samples.fill(0);chunk=all.slice(0,limit);const rest=all.slice(limit);all.fill(0);this.frames=rest.length?[{samples:rest,level:rms(rest),talking:true}]:[];this.count=rest.length;}
  this.emitted++;out.push({chunk,final:false,turnSamples:this.total});
 }
 private finish(out:SegmentEvent[]){
  const turnSamples=this.total;
  if(this.emitted>0||this.voiced>=(this.options.minVoicedSamples??MIN_VOICED_SAMPLES)){
   if(!this.count)out.push({final:true,turnSamples});
   else{const joined=concat(this.frames),chunk=pad(joined);if(chunk!==joined)joined.fill(0);out.push({chunk,final:true,turnSamples});}
  }
  else out.push({final:true,discarded:true,turnSamples});
  this.reset();
 }
}

// ---------------------------------------------------------------- local detector contract

/** POST /v1/voice/local/detect body: one 16 kHz float PCM frame for the capture session, in sequence order. */
export type VadRequest={sessionId:string;sequence:number;samples:string;reset?:boolean};
export type VadDecision={available:true;speech:boolean;probability?:number}|{available:false;reason:string};
const REASON=/^[a-z0-9][a-z0-9-]{0,39}$/;
/** Accepts only a structurally valid response for this exact request; echoed identities must match. */
export function parseVadResponse(value:unknown,request:Pick<VadRequest,'sessionId'|'sequence'>):VadDecision|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return;const v=value as Record<string,unknown>;
 if(v.sequence!==undefined&&v.sequence!==request.sequence||v.sessionId!==undefined&&v.sessionId!==request.sessionId)return;
 if(v.available===false)return {available:false,reason:typeof v.reason==='string'&&REASON.test(v.reason)?v.reason:'unavailable'};
 if(v.available!==true||typeof v.speech!=='boolean')return;
 if(v.probability!==undefined&&!(finite(v.probability)&&v.probability>=0&&v.probability<=1))return;
 return finite(v.probability)?{available:true,speech:v.speech,probability:v.probability}:{available:true,speech:v.speech};
}

/**
 * Detector requests physically outstanding at the transport, shared by every capture pipeline of one voice owner. A slot
 * is released only when the transport settles, so requests abandoned by a timeout, a detector toggle, a privacy change or
 * Stop keep counting until they do (they are aborted, but a transport may ignore that). New capture never exceeds `limit`.
 */
export class DetectorSlots {
 private held=0;private listeners=new Set<()=>void>();
 constructor(readonly limit=3){}
 get active(){return this.held;}
 get free(){return this.held<this.limit;}
 take(){if(this.held>=this.limit)return false;this.held++;return true;}
 release(){if(this.held>0)this.held--;for(const listener of [...this.listeners])listener();}
 watch(listener:()=>void){this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};}
}

// ---------------------------------------------------------------- playback reference

/** Every detector request carries exactly this many 16 kHz samples (100 ms). */
export const FRAME_SAMPLES=1600;
/**
 * Longest playback-to-microphone delay searched (2 s): output and input latency, wireless and Bluetooth speakers and long
 * room tails. Rendered playback is kept this long after it ends, so a delayed echo is still compared rather than heard as
 * a new request; echo arriving later than this is outside the bound.
 */
export const ECHO_DELAY_SAMPLES=32000;
/** Delays up to this (400 ms) are searched at 4-sample resolution; longer ones at 16 samples, then refined. */
const NEAR_DELAY_SAMPLES=6400;
const REFERENCE_HISTORY=ECHO_DELAY_SAMPLES+FRAME_SAMPLES;
/**
 * Rendered output at or below this sample magnitude (-100 dBFS) is digital silence. Anything louder, however quiet, may be
 * amplified by the speaker volume and acoustic path into speech-level echo, so it is compared, never assumed inaudible.
 */
const REFERENCE_SILENT=1e-5;
const REFERENCE_STRONG=.01;
/** A frame whose energy Capri's own playback explains this well is her echo, whatever its level. */
const ECHO_EXPLAINED=.7;
/** Frames where the reference visibly accounts for what the microphone hears before any residual can count as the user. */
const PATH_EVIDENCE=3;
/**
 * Capri's rendered playback, captured by the microphone worklet from the same audio context and resampling phase, so
 * `samples[i]` was rendered when microphone sample `startSample+i` was captured. `valid` is false when the reference does
 * not cover what is playing (no paired capture, playback outside this context). `epoch` names the capture graph.
 */
export type ReferenceBlock={startSample:number;samples:Float32Array;valid:boolean;epoch?:number};
/** How much of a microphone frame Capri's rendered playback explains. Levels are RMS; `explained` is an energy fraction. */
export type EchoAnalysis={explained:number;residual:number;level:number;reference:number};

function solve(matrix:number[][],target:number[]){
 const n=target.length,a=matrix.map((row,i)=>[...row,target[i]]);let scale=0;for(let i=0;i<n;i++)scale=Math.max(scale,a[i][i]);
 for(let i=0;i<n;i++)a[i][i]+=scale*1e-9+1e-12;
 for(let c=0;c<n;c++){
  let pivot=c;for(let r=c+1;r<n;r++)if(Math.abs(a[r][c])>Math.abs(a[pivot][c]))pivot=r;
  if(Math.abs(a[pivot][c])<1e-15)return;[a[c],a[pivot]]=[a[pivot],a[c]];
  for(let r=0;r<n;r++){if(r===c)continue;const f=a[r][c]/a[c][c];if(f)for(let k=c;k<=n;k++)a[r][k]-=f*a[c][k];}
 }
 return a.map((row,i)=>row[n]/row[i]);
}
/**
 * Compares one microphone frame with the rendered playback around it. `reference` holds the output for the frame and up
 * to `maxDelay` samples before it, so `reference[reference.length-mic.length+i]` was rendered when `mic[i]` was captured.
 * Delays are found by normalised correlation (coarse, then refined), and up to six delayed copies (several paths, or a
 * short filter) are fitted by least squares to this frame alone. No coupling level is learned across frames, so quieter
 * or louder playback, volume changes and changing paths are judged on their own waveform. `reference` in the result is
 * the loudest 100 ms of rendered output in the window, so a long window does not dilute a short reply or its tail.
 * Work per frame is bounded by the window: delays past 400 ms are swept at 16-sample resolution and refined only around
 * their best peaks.
 */
export function analyzeEcho(mic:Float32Array,reference:Float32Array,maxDelay=ECHO_DELAY_SAMPLES):EchoAnalysis{
 const n=mic.length,base=reference.length-n,delay=Math.min(maxDelay,base);
 const dot=(a:ArrayLike<number>,b:ArrayLike<number>)=>{let s=0;for(let i=0;i<n;i++)s+=a[i]*b[i];return s;};
 const micEnergy=dot(mic,mic),level=Math.sqrt(micEnergy/Math.max(1,n)),referenceLevel=loudest(reference);
 if(n<64||delay<0||micEnergy<=1e-12||referenceLevel<=1e-6)return {explained:0,residual:level,level,reference:referenceLevel};
 const column=(lag:number)=>reference.subarray(base-lag,base-lag+n);
 // Coarse search over 4-sample sums.
 const Q=4,m=Math.floor(n/Q),offset=base%Q,zero=(base-offset)/Q,coarse=new Float64Array(Math.floor((reference.length-offset)/Q)),small=new Float64Array(m);
 for(let k=0;k<coarse.length;k++){let s=0;for(let j=0;j<Q;j++)s+=reference[offset+k*Q+j];coarse[k]=s;}
 let smallEnergy=0;for(let k=0;k<m;k++){let s=0;for(let j=0;j<Q;j++)s+=mic[k*Q+j];small[k]=s;smallEnergy+=s*s;}
 const top=Math.min(delay,base-offset),near=Math.min(top,NEAR_DELAY_SAMPLES);
 const score=(lag:number)=>{const s=zero-lag/Q;let d=0,e=0;for(let k=0;k<m;k++){const r=coarse[s+k];d+=small[k]*r;e+=r*r;}return e>0&&smallEnergy>0?Math.abs(d)/Math.sqrt(e*smallEnergy):0;};
 const scores:{lag:number;score:number}[]=[];
 for(let lag=0;lag<=near;lag+=Q)scores.push({lag,score:score(lag)});
 if(top>near){
  // Long tails: 16-sample sums swept every 16 samples; the best peaks are refined at 4 samples.
  const W=4,C=Q*W,mm=Math.floor(m/W),wide=new Float64Array(Math.max(0,coarse.length-W+1)),compact=new Float64Array(mm);
  for(let k=0;k<wide.length;k++){let s=0;for(let j=0;j<W;j++)s+=coarse[k+j];wide[k]=s;}
  let compactEnergy=0;for(let k=0;k<mm;k++){let s=0;for(let j=0;j<W;j++)s+=small[k*W+j];compact[k]=s;compactEnergy+=s*s;}
  const far:{lag:number;score:number}[]=[];
  for(let lag=near+Q;lag<=top;lag+=C){const s=zero-lag/Q;let d=0,e=0;for(let k=0;k<mm;k++){const r=wide[s+k*W];d+=compact[k]*r;e+=r*r;}far.push({lag,score:e>0&&compactEnergy>0?Math.abs(d)/Math.sqrt(e*compactEnergy):0});}
  far.sort((a,b)=>b.score-a.score);const picked:number[]=[];
  for(const {lag} of far){if(picked.length>=6)break;if(picked.every(p=>Math.abs(p-lag)>2*C))picked.push(lag);}
  const seen=new Set<number>();
  for(const peak of picked)for(let lag=Math.max(near+Q,peak-C);lag<=Math.min(top,peak+C);lag+=Q)if(!seen.has(lag)){seen.add(lag);scores.push({lag,score:score(lag)});}
 }
 scores.sort((a,b)=>b.score-a.score);const peaks:number[]=[];
 for(const {lag} of scores){if(peaks.length>=4)break;if(peaks.every(p=>Math.abs(p-lag)>2*Q))peaks.push(lag);}
 // Refine each peak at the full rate; its neighbours let the fit follow a short filter.
 const lags=new Set<number>();
 for(const peak of peaks){
  let best=peak,bestScore=-1;
  for(let lag=Math.max(0,peak-Q);lag<=Math.min(delay,peak+Q);lag++){const c=column(lag),e=dot(c,c);const score=e>0?Math.abs(dot(mic,c))/Math.sqrt(e):0;if(score>bestScore){bestScore=score;best=lag;}}
  for(let d=-2;d<=2;d++)if(best+d>=0&&best+d<=delay)lags.add(best+d);
 }
 const columns=[...lags].map(column),energies=columns.map(c=>dot(c,c));
 const chosen:number[]=[];let residual=Float64Array.from(mic),residualEnergy=micEnergy;
 for(let step=0;step<6;step++){
  let best=-1,bestScore=0;
  for(let j=0;j<columns.length;j++){if(chosen.includes(j)||energies[j]<=1e-12)continue;const score=Math.abs(dot(residual,columns[j]))/Math.sqrt(energies[j]);if(score>bestScore){bestScore=score;best=j;}}
  if(best<0)break;chosen.push(best);
  const gains=solve(chosen.map(a=>chosen.map(b=>dot(columns[a],columns[b]))),chosen.map(a=>dot(mic,columns[a])));
  if(!gains){chosen.pop();break;}
  const next=Float64Array.from(mic);for(let a=0;a<chosen.length;a++){const c=columns[chosen[a]],g=gains[a];for(let i=0;i<n;i++)next[i]-=g*c[i];}
  const energy=dot(next,next);if(energy>=residualEnergy*(1-1e-3)){chosen.pop();break;}
  residual=next;residualEnergy=energy;
 }
 return {explained:clamp(1-residualEnergy/micEnergy,0,1),residual:Math.sqrt(residualEnergy/n),level,reference:referenceLevel};
}
/** RMS of the loudest 100 ms block of rendered output, counted back from the end of the window. */
function loudest(reference:Float32Array){let best=0;for(let end=reference.length;end>0;end-=FRAME_SAMPLES){let sum=0;const start=Math.max(0,end-FRAME_SAMPLES);for(let i=start;i<end;i++)sum+=reference[i]*reference[i];best=Math.max(best,sum/(end-start));}return Math.sqrt(best);}

// ---------------------------------------------------------------- pipeline

/**
 * Capture-time playback state. `outputActive` is the voice owner's playback guard; `reference` is the rendered playback
 * for these exact samples. `outputLevel` is a display meter only: it is never evidence of echo or of user speech.
 */
export type FrameContext={outputActive:boolean;outputLevel?:number;reference?:ReferenceBlock};
export type ListeningStatus={detector:'model'|'energy';reason:string;noiseFloor:number;calibrated:boolean;collecting:boolean;calibrating:boolean};
export type PipelineOptions={
 preferences:ListeningPreferences;sessionId:string;
 /** `signal` aborts the transport request once its answer can no longer be used. */
 detect?:(request:VadRequest,signal:AbortSignal)=>Promise<unknown>;encode?:(samples:Float32Array)=>string;slots?:DetectorSlots;
 schedule?:(run:()=>void,ms:number)=>()=>void;now?:()=>number;
 onFrame?:(collecting:boolean)=>void;onSegment:(event:SegmentEvent)=>void;onBargeIn?:()=>void;onDiagnostic?:(entry:ListeningDiagnostic)=>void;
 vadTimeoutMs?:number;maxInflight?:number;maxPending?:number;
};
type Calibration={levels:number[];frames:number;resolve:(floor:number)=>void;reject:(error:Error)=>void;cancel:()=>void};
/**
 * Playback exposure fixed when the frame was captured: 'none' (no output could be heard), 'unknown' (output may be heard
 * but the reference is missing, discontinuous or from another capture graph) or 'exposed' with the rendered reference
 * window kept until the frame is decided. Echo classes add 'quiet', 'echo' and 'user' once decided.
 */
type Exposure='none'|'unknown'|'exposed';
type EchoClass='none'|'unknown'|'quiet'|'echo'|'user';
/** `calibration` is the measurement active when any of the frame's samples was captured; `excluded` marks audio captured before one began. Neither is ever segmented. */
type Pending={sequence:number;samples:Float32Array;level:number;outputActive:boolean;exposure:Exposure;window?:Float32Array;continuity:number;echo?:EchoClass;decided:boolean;requested?:boolean;speech?:boolean;user?:boolean;cancel?:()=>void;calibration?:Calibration;excluded?:boolean};
const defaultSchedule=(run:()=>void,delay:number)=>{const timer=setTimeout(run,delay);return ()=>clearTimeout(timer);};
/** Zeroes frames this pipeline no longer holds; whatever still needs their audio has its own copy. */
const forget=(frames:readonly Pending[])=>{for(const frame of frames)frame.samples.fill(0);};

/**
 * Capture arrives in worklet-sized blocks (about 1621-1626 samples at 44.1/48 kHz); they are cut into exact
 * `FRAME_SAMPLES` frames, carrying the remainder into the next frame so no sample is lost or repeated. A frame that
 * contains any audio captured during playback counts as playback. The tail shorter than a frame is dropped on close.
 *
 * Frames enter in capture order and leave in that order, whether decided by the local detector or by energy. While the
 * detector is in use every frame is sent to it in sequence: at most `maxInflight` requests are outstanding and later frames
 * wait their turn. A backlog beyond `maxPending` means the detector cannot keep up, so the session falls back to energy
 * and reports 'overloaded' rather than silently mixing decisions. Late, duplicate, mismatched or post-close detector
 * results never change a decision. A frame decided without the detector (timeout/error/disabled) marks a gap in the
 * detector's stream, so the next request carries `reset`. Three consecutive detector failures fall back to energy for the
 * session. Turning the detector off or on starts a new detector epoch: outstanding requests are aborted and their
 * frames decided by energy in place, and an explicit re-enable retries a detector that had fallen back. Aborted requests
 * hold their shared slots until the transport settles; while every slot is held by such abandoned work, new frames are
 * decided by energy at once (a gap, so the next request resets the model) instead of launching more requests.
 *
 * Echo: each frame keeps the rendered playback captured with it (bounded to the 2 s search delay before it, including
 * tails after playback ends) and is compared with it when decided, so a late detector answer is judged against
 * capture-time output. Only speech the reference cannot explain, after the reference has visibly accounted for the room,
 * can interrupt Capri, or start a turn while her delayed tail may still arrive. Missing, discontinuous or other-graph
 * reference is unknown: such frames never interrupt, open a turn or become pre-roll, and the user can still press
 * Interrupt. Once the window holds no rendered output, frames are ordinary again. The reference is held in memory only,
 * dropped with the pipeline, and frames' audio is zeroed once nothing in the pipeline still needs it.
 */
export class ListeningPipeline {
 private queue:Pending[]=[];private sequence=0;private processed=-1;private failures=0;private sentReset=false;private closed=false;private fallbackReason='';private detectorEpoch=0;
 private slots:DetectorSlots;private unwatch:()=>void;private requests=new Set<{abort:()=>void}>();private epochHeld=0;
 private partial=new Float32Array(FRAME_SAMPLES);private filled=0;private partialOutput=false;private partialCalibration?:Calibration;private partialExcluded=false;
 private history=new Float32Array(REFERENCE_HISTORY);private captured=0;private lastRendered=-Infinity;private knownFrom=Infinity;private referenceNext?:number;private referenceEpoch?:number;private continuity=0;private pathContinuity=-1;private pathEvidence=0;private unknownOutput=-Infinity;
 private barriers:{through:number;resolve:()=>void}[]=[];
 private noise:number;private calibratedFloor:number;private turns:TurnSegmenter;private preferences:ListeningPreferences;
 private candidate:Pending[]=[];private quiet:Pending[]=[];private quietCount=0;private run=0;private gap=0;private bargeTurn=false;private inPlayback=false;private boundary=false;private echoFrames=0;private unknownFrames=0;
 private calibration?:Calibration;
 private schedule:(run:()=>void,ms:number)=>()=>void;private now:()=>number;private encode:(samples:Float32Array)=>string;
 constructor(private options:PipelineOptions){
  this.preferences=normalizeListeningPreferences(options.preferences);this.noise=this.preferences.noiseFloor??.002;this.calibratedFloor=this.preferences.noiseFloor??0;
  this.turns=new TurnSegmenter({silenceSamples:this.preferences.silenceMs*SAMPLE_RATE/1000,preRollSamples:4800});
  this.schedule=options.schedule??defaultSchedule;this.now=options.now??Date.now;this.encode=options.encode??encodePcm;
  this.slots=options.slots??new DetectorSlots(options.maxInflight??3);
  // A slot freed by any pipeline's settled transport lets this one continue in order.
  this.unwatch=this.slots.watch(()=>{if(!this.closed){this.pump();this.drain();}});
 }
 private get maxPending(){return this.options.maxPending??12;}
 private get usingDetector(){return this.preferences.enabled&&!!this.options.detect&&!this.fallbackReason;}
 /** Every slot is held by abandoned requests (an older epoch or a closed pipeline), none of which can decide this epoch's frames. */
 private get blocked(){return this.usingDetector&&!this.slots.free&&this.epochHeld===0;}
 get collecting(){return this.turns.collecting;}
 get pending(){return this.queue.length;}
 status():ListeningStatus{return {detector:this.usingDetector&&!this.blocked?'model':'energy',reason:!this.preferences.enabled?'disabled':!this.options.detect?'unavailable':this.fallbackReason||(this.blocked?'busy':'ready'),noiseFloor:this.noise,calibrated:this.calibratedFloor>0,collecting:this.turns.collecting,calibrating:!!this.calibration};}
 configure(preferences:ListeningPreferences){
  const wasEnabled=this.preferences.enabled,wasUsing=this.usingDetector;
  this.preferences=normalizeListeningPreferences(preferences);this.turns.options.silenceSamples=this.preferences.silenceMs*SAMPLE_RATE/1000;
  if(!this.preferences.bargeIn){forget([...this.candidate,...this.quiet]);this.candidate=[];this.quiet=[];this.quietCount=0;this.run=0;this.gap=0;this.boundary=false;}
  // An explicit re-enable gives a detector that fell back another try.
  if(this.preferences.enabled&&!wasEnabled){this.fallbackReason='';this.failures=0;}
  if(wasUsing!==this.usingDetector){this.restartDetector();this.drain();}
 }
 /** Accepts any block length from the capture and decides exact `FRAME_SAMPLES` frames. */
 push(samples:Float32Array,context:FrameContext){
  if(this.closed)return;
  const reference=this.acceptReference(samples,context.reference);
  for(let offset=0;offset<samples.length&&!this.closed;){
   const n=Math.min(FRAME_SAMPLES-this.filled,samples.length-offset);this.partial.set(samples.subarray(offset,offset+n),this.filled);
   this.appendReference(reference?.subarray(offset,offset+n),n);this.filled+=n;offset+=n;
   // Output without a usable reference keeps later frames unknown for as long as its echo could still arrive.
   if(!reference&&context.outputActive)this.unknownOutput=this.captured;
   this.partialOutput||=context.outputActive;
   // Tagged as calibration audio when captured, so a frame finished after calibration ends is still never segmented.
   if(this.calibration)this.partialCalibration=this.calibration;
   if(this.filled<FRAME_SAMPLES)break;
   const ready=this.partial.slice(),outputActive=this.partialOutput,tag={calibration:this.partialCalibration,excluded:this.partialExcluded};
   this.filled=0;this.partialOutput=false;this.partialCalibration=undefined;this.partialExcluded=false;this.enqueue(ready,outputActive,tag);
  }
 }
 /** A block's reference counts only when it is valid, finite, the same length and continues the previous block in the same graph. */
 private acceptReference(samples:Float32Array,block?:ReferenceBlock){
  const valid=!!block&&block.valid===true&&block.samples instanceof Float32Array&&block.samples.length===samples.length&&Number.isSafeInteger(block.startSample)&&block.startSample>=0&&block.samples.every(v=>Number.isFinite(v));
  if(!valid){this.referenceNext=undefined;this.knownFrom=Infinity;return undefined;}
  // Nothing before a discontinuity is known; path evidence starts over with it. The first block of this pipeline at
  // index 0 starts its capture graph: nothing was rendered into that graph before it, so the empty history is known.
  if(block.startSample!==this.referenceNext||block.epoch!==this.referenceEpoch){this.knownFrom=block.startSample===0&&this.captured===0&&this.referenceEpoch===undefined?-Infinity:this.captured;this.continuity++;}
  this.referenceNext=block.startSample+samples.length;this.referenceEpoch=block.epoch;return block.samples;
 }
 private appendReference(reference:Float32Array|undefined,n:number){
  const history=this.history,size=history.length;
  if(n>=size){if(reference)history.set(reference.subarray(n-size));else history.fill(0);}
  else{history.copyWithin(0,n);if(reference)history.set(reference,size-n);else history.fill(0,size-n);}
  if(reference)for(let i=n-1;i>=0;i--)if(Math.abs(reference[i])>REFERENCE_SILENT){this.lastRendered=this.captured+i+1;break;}
  this.captured+=n;
 }
 /**
  * Exposure of the frame that ends at the current capture index, from the reference captured with it. A frame is 'none'
  * only when playback is inactive and the whole search window of known reference (2.1 s) is digital silence: quiet
  * rendered output, during playback or as a delayed tail up to the search bound, is compared by waveform, and any
  * reference before a discontinuity counts as possible output of unknown alignment.
  */
 private provenance(outputActive:boolean):Pick<Pending,'exposure'|'window'|'continuity'>{
  const start=this.captured-REFERENCE_HISTORY,known=this.knownFrom<=start,rendered=this.lastRendered>start;
  if(known)return outputActive||rendered?{exposure:'exposed',window:this.history.slice(),continuity:this.continuity}:{exposure:'none',continuity:this.continuity};
  return {exposure:outputActive||this.unknownOutput>start||rendered?'unknown':'none',continuity:this.continuity};
 }
 private enqueue(samples:Float32Array,outputActive:boolean,tag:{calibration?:Calibration;excluded:boolean}){
  if(this.closed)return;
  const frame:Pending={sequence:this.sequence++,samples,level:rms(samples),outputActive,...this.provenance(outputActive),decided:false,...tag};
  this.queue.push(frame);
  if(!this.usingDetector)frame.decided=true;
  else if(this.queue.length>this.maxPending)this.fallback('overloaded');
  else this.pump();
  this.drain();
 }
 /**
  * Resolves once every frame captured so far has been decided and processed, so output can check whether a user turn has
  * started before it takes the floor. Bounded by `timeoutMs`; resolves at once in energy mode and when listening stops.
  */
 settled(timeoutMs=3000):Promise<void>{
  const through=this.sequence-1;if(this.closed||this.processed>=through)return Promise.resolve();
  return new Promise<void>(resolve=>{
   let cancel=()=>{};const entry={through,resolve:()=>{const i=this.barriers.indexOf(entry);if(i<0)return;this.barriers.splice(i,1);cancel();resolve();}};
   this.barriers.push(entry);cancel=this.schedule(entry.resolve,timeoutMs);
  });
 }
 /** Sends waiting frames to the detector in capture order while a shared request slot is free. */
 private pump(){
  if(this.closed||!this.usingDetector)return;
  for(const frame of this.queue){if(frame.decided||frame.requested)continue;if(!this.slots.take())break;this.request(frame);}
  // Only abandoned work holds the slots: decide waiting frames by energy now rather than stall them behind it.
  if(this.blocked)for(const frame of this.queue)if(!frame.decided&&!frame.requested){this.settle(frame);this.sentReset=false;}
 }
 /**
  * Measures the room's noise floor from the next frames of the existing capture while Capri is silent. Calibration audio is
  * a measurement, never a request: an open turn (including one an uncalibrated threshold opened on steady room noise) is
  * dropped unsent with its pre-roll, and nothing captured until calibration ends is segmented or can interrupt Capri.
  * Fails explicitly when the room is too loud or the measurement is disturbed by speech or sudden sounds.
  */
 calibrate(frames=15,timeoutMs=10000):Promise<number>{
  if(this.closed)return Promise.reject(Error('Listening has stopped.'));
  const previous=this.calibration;this.calibration=undefined;if(previous){previous.cancel();previous.reject(Error('Calibration was restarted.'));}
  this.suspendTurn();
  // Audio captured before this point (still awaiting the detector, or part of the frame being filled) is neither measured
  // nor segmented later, whenever its decision arrives.
  for(const frame of this.queue)frame.excluded=true;if(this.filled)this.partialExcluded=true;
  return new Promise<number>((resolve,reject)=>{
   const entry:Calibration={levels:[],frames:Math.round(clamp(frames,5,100)),resolve,reject,cancel:()=>{}};this.calibration=entry;
   entry.cancel=this.schedule(()=>{if(this.calibration!==entry)return;this.endCalibration();reject(Error('Calibration needs a couple of quiet seconds while Capri is silent. Try again when the room is quiet.'));},timeoutMs);
  });
 }
 private suspendTurn(){
  const open=this.turns.collecting;this.turns.reset();forget([...this.candidate,...this.quiet]);this.candidate=[];this.quiet=[];this.quietCount=0;this.run=0;this.gap=0;this.boundary=false;this.bargeTurn=false;
  if(open)this.options.onSegment({final:true,discarded:true,cancelled:true,turnSamples:0});
  if(!this.closed)this.options.onFrame?.(false);
 }
 /** Nothing measured becomes pre-roll for the next turn. */
 private endCalibration(){this.calibration=undefined;this.turns.reset();forget(this.quiet);this.quiet=[];this.quietCount=0;}
 /**
  * Stops listening and wipes every sample it still holds: queued frames (including those an unresolved detector request
  * still references), the partly filled frame and its tags, pre-roll, barge-in candidates, the open turn and the reference.
  */
 close(){
  if(this.closed)return;this.closed=true;
  const held=[...this.queue,...this.candidate,...this.quiet];this.queue=[];this.candidate=[];this.quiet=[];this.quietCount=0;this.boundary=false;
  for(const frame of held){frame.cancel?.();frame.cancel=undefined;frame.samples.fill(0);frame.window=undefined;frame.calibration=undefined;}
  this.partial.fill(0);this.filled=0;this.partialOutput=false;this.partialCalibration=undefined;this.partialExcluded=false;this.turns.wipe();
  this.history.fill(0);this.lastRendered=-Infinity;this.knownFrom=Infinity;this.referenceNext=undefined;this.referenceEpoch=undefined;this.unknownOutput=-Infinity;
  for(const request of [...this.requests])request.abort();this.unwatch();
  const calibration=this.calibration;this.calibration=undefined;if(calibration){calibration.cancel();calibration.reject(Error('Listening has stopped.'));}
  this.release();
 }
 /** The caller has taken one shared slot; it is released exactly once, when the transport settles. */
 private request(frame:Pending){
  const epoch=this.detectorEpoch;frame.requested=true;this.epochHeld++;const controller=new AbortController();
  // The frame (and its audio) is referenced only while its answer can still be used.
  let target:Pending|undefined=frame;
  const entry={abort:()=>{target=undefined;this.requests.delete(entry);controller.abort();}};this.requests.add(entry);
  let open=true;const done=()=>{if(!open)return;open=false;target=undefined;this.requests.delete(entry);if(epoch===this.detectorEpoch&&!this.closed)this.epochHeld--;this.slots.release();};
  const sessionId=this.options.sessionId,sequence=frame.sequence;const reset=!this.sentReset;this.sentReset=true;
  // A frame decided without the detector leaves a gap in its stream; the next request asks it to start fresh.
  const missed=(f:Pending,reason:string)=>{this.fail(reason);this.settle(f);this.sentReset=false;};
  const usable=()=>!this.closed&&epoch===this.detectorEpoch&&target&&!target.decided?target:undefined;
  frame.cancel=this.schedule(()=>{const f=usable();if(!f)return;entry.abort();missed(f,'timeout');this.pump();this.drain();},this.options.vadTimeoutMs??1000);
  let result:Promise<unknown>;try{result=Promise.resolve(this.options.detect!({sessionId,sequence,samples:this.encode(frame.samples),...(reset?{reset:true}:{})},controller.signal));}catch(e){result=Promise.reject(e);}
  const finish=(apply:(f:Pending)=>void)=>{const f=usable();try{if(f)apply(f);}finally{done();}if(!this.closed){this.pump();this.drain();}};
  result.then(value=>finish(f=>{
   const decision=parseVadResponse(value,{sessionId,sequence});
   if(!decision)missed(f,'malformed');
   else if(!decision.available){this.fallback(decision.reason);this.settle(f);}
   else{this.failures=0;this.settle(f,decision.probability===undefined?decision.speech:decision.probability>=probabilityThreshold(this.preferences.vadThreshold));}
  }),()=>finish(f=>missed(f,'error')));
 }
 private settle(frame:Pending,speech?:boolean){frame.cancel?.();frame.cancel=undefined;frame.decided=true;frame.speech=speech;}
 private fail(reason:string){if(++this.failures>=3)this.fallback(reason);}
 private fallback(reason:string){if(this.fallbackReason)return;this.fallbackReason=reason;this.diagnostic({kind:'vad-fallback',reason,detector:'energy'});this.restartDetector();}
 /**
  * Aborts outstanding requests: their frames are decided by energy where they stand, and the next request resets the model.
  * Their slots stay held until each transport settles, so the shared bound is never reset.
  */
 private restartDetector(){this.detectorEpoch++;this.epochHeld=0;this.sentReset=false;for(const request of [...this.requests])request.abort();for(const frame of this.queue)if(!frame.decided)this.settle(frame);}
 /** A processed frame's audio now lives only in the segmenter's copy, or in a barge-in candidate/pre-roll list that still holds it. */
 private drain(){while(!this.closed&&this.queue.length&&this.queue[0].decided){const frame=this.queue.shift()!;this.process(frame);if(!this.candidate.includes(frame)&&!this.quiet.includes(frame))forget([frame]);}this.release();}
 private release(){for(const barrier of [...this.barriers])if(this.closed||barrier.through<=this.processed)barrier.resolve();}
 private process(frame:Pending){
  this.processed=frame.sequence;const threshold=speechThreshold(this.noise,this.preferences.vadThreshold,this.calibratedFloor);
  const talking=frame.speech??frame.level>threshold;
  // Calibration frames are measured whatever the uncalibrated threshold thinks of them, and never segmented, even when
  // their detector answer arrives after the measurement has ended. Frames captured before it started, while Capri is
  // audible, or straddling a calibration boundary are dropped rather than measured.
  if(frame.excluded||frame.calibration||this.calibration){
   frame.window=undefined;
   if(frame.calibration&&frame.calibration===this.calibration&&!frame.excluded&&!frame.outputActive&&frame.exposure==='none')this.calibrationFrame(frame.level);
   if(!this.closed)this.options.onFrame?.(this.turns.collecting);return;
  }
  const echo=frame.echo=this.classify(frame,talking,threshold);frame.window=undefined;
  if(echo==='none'&&!frame.outputActive&&!talking){const rate=frame.level<this.noise?.2:.05;this.noise=clamp(this.noise*(1-rate)+frame.level*rate,.0005,.05);}
  if(echo!=='none'&&frame.outputActive&&!this.bargeTurn)this.playbackFrame(frame,echo,talking);
  else{
   if(this.inPlayback)this.endPlayback();
   // After the output guard, her delayed tail is still compared for the length of the reference window: only speech the
   // reference cannot explain (or no exposure at all) is the user; echo and unknown audio neither talk nor become pre-roll.
   const tail=!frame.outputActive&&echo!=='none';
   if(tail&&echo==='echo'&&talking)this.echoFrames++;else if(echo==='none'&&this.echoFrames){this.diagnostic({kind:'echo-suppressed',frames:this.echoFrames});this.echoFrames=0;}
   const user=talking&&(tail?echo==='user':echo!=='echo');if(this.boundary)this.boundaryFrame(frame,user);else this.segment(frame,user);
  }
  if(!this.closed)this.options.onFrame?.(this.turns.collecting);
 }
 /**
  * Decides what playback contributed to the frame. Energy the rendered reference explains is echo at any gain. Speech
  * left over after removing it counts as the user only once the reference has visibly accounted for this room (echo it
  * explains, or quiet while Capri plays); until then, or without a usable reference, it is unknown.
  */
 private classify(frame:Pending,talking:boolean,threshold:number):EchoClass{
  if(frame.exposure!=='exposed'||!frame.window)return frame.exposure==='exposed'?'unknown':frame.exposure;
  if(frame.continuity!==this.pathContinuity){this.pathContinuity=frame.continuity;this.pathEvidence=0;}
  const a=analyzeEcho(frame.samples,frame.window);const strong=a.reference>=REFERENCE_STRONG;
  // Quiet is evidence only while Capri is audibly playing; in a delayed tail it shows nothing about the room.
  if(a.level<=threshold&&!talking){const echo=a.explained>=ECHO_EXPLAINED;if(strong&&(echo||frame.outputActive))this.pathEvidence++;return echo?'echo':'quiet';}
  if(a.explained>=ECHO_EXPLAINED){if(strong)this.pathEvidence++;return 'echo';}
  if(talking&&a.residual>threshold)return this.pathEvidence>=PATH_EVIDENCE?'user':'unknown';
  return 'echo';
 }
 /**
  * The floor is the median frame level. A room louder than the highest usable floor, unreadable levels, or a measurement
  * whose loud tail stands well above that median (speech, music, door slams) fail instead of setting a misleading floor.
  */
 private calibrationFrame(level:number){
  const calibration=this.calibration!;
  const fail=(message:string)=>{this.endCalibration();calibration.cancel();calibration.reject(Error(message));};
  if(!finite(level)){fail('Calibration could not read the microphone level. Try again.');return;}
  calibration.levels.push(level);if(calibration.levels.length<calibration.frames)return;
  const sorted=[...calibration.levels].sort((a,b)=>a-b);const median=sorted[Math.floor(sorted.length/2)];const high=sorted[Math.floor(sorted.length*.9)];
  if(median>CALIBRATION_MAX_FLOOR){fail('The background is too loud to calibrate reliably. Try again somewhere quieter, or turn on noise suppression or use headphones.');return;}
  if(high>Math.max(median*4,median+.02)){fail('Calibration heard speech or sudden sounds. Stay quiet for a couple of seconds and try again.');return;}
  const floor=clamp(median,.0005,CALIBRATION_MAX_FLOOR);
  this.endCalibration();calibration.cancel();this.noise=floor;this.calibratedFloor=floor;this.diagnostic({kind:'calibrated'});calibration.resolve(floor);
 }
 /**
  * Capri may be audible. Without barge-in the frame is discarded as before; with it, only a sustained run of speech the
  * playback reference cannot explain interrupts her. Echo and unknown frames are never kept as pre-roll.
  */
 private playbackFrame(frame:Pending,echo:EchoClass,talking:boolean){
  this.inPlayback=true;this.boundary=false;const user=talking&&echo==='user';
  if(echo==='unknown')this.unknownFrames++;else if(echo==='echo'&&talking)this.echoFrames++;
  // Output waits for decided frames, but a turn can still be open when it starts (bounded wait, frames in flight). The turn
  // keeps every sample; only speech the reference cannot explain counts as talking, so Capri's voice lets it end naturally.
  if(this.turns.collecting){this.openTurnFrame(frame,user);return;}
  this.turns.dropPreRoll();
  if(!this.preferences.bargeIn)return;
  frame.user=user;
  if(user){this.candidate.push(frame);this.run++;this.gap=0;}
  else if(this.candidate.length&&this.gap<1){this.gap++;this.candidate.push(frame);}
  else{for(const f of this.candidate)this.remember(f);this.candidate=[];this.run=0;this.gap=0;this.remember(frame);}
  if(this.run>=BARGE_IN_FRAMES)this.bargeIn();
 }
 /**
  * The frame already belongs to the open turn, which keeps it either way. With barge-in the same sustained run of speech
  * the reference cannot explain (one-frame gaps allowed) still interrupts Capri; echo and short noise do not.
  */
 private openTurnFrame(frame:Pending,user:boolean){
  this.segment(frame,user);if(this.closed)return;
  if(!this.preferences.bargeIn||!this.turns.collecting){this.run=0;this.gap=0;return;}
  if(user){this.run++;this.gap=0;}else if(this.run&&this.gap<1)this.gap++;else{this.run=0;this.gap=0;}
  if(this.run<BARGE_IN_FRAMES)return;
  const frames=this.run;this.run=0;this.gap=0;this.bargeTurn=true;this.inPlayback=false;
  this.diagnostic({kind:'barge-in',frames});this.options.onBargeIn?.();
 }
 /** Pre-roll for a barge-in is contiguous audio Capri's echo does not account for; echo or unknown audio breaks it. */
 private remember(frame:Pending){if(frame.echo==='echo'||frame.echo==='unknown'){forget([...this.quiet,frame]);this.quiet=[];this.quietCount=0;return;}this.quiet.push(frame);this.quietCount+=frame.samples.length;while(this.quiet.length>1&&this.quietCount-this.quiet[0].samples.length>=4800){const old=this.quiet.shift()!;this.quietCount-=old.samples.length;forget([old]);}}
 private bargeIn(){
  const preRoll=this.quiet,speech=this.candidate;this.quiet=[];this.quietCount=0;this.candidate=[];this.run=0;this.gap=0;this.bargeTurn=true;this.inPlayback=false;this.turns.reset();
  this.diagnostic({kind:'barge-in',frames:speech.length});this.options.onBargeIn?.();
  try{
   for(const f of preRoll){if(this.closed)return;this.segment(f,false);}
   for(const f of speech){if(this.closed)return;this.segment(f,!!f.user);}
  }finally{forget([...preRoll,...speech]);}
 }
 private endPlayback(){
  this.inPlayback=false;if(this.echoFrames)this.diagnostic({kind:'echo-suppressed',frames:this.echoFrames});this.echoFrames=0;
  if(this.unknownFrames&&this.preferences.bargeIn)this.diagnostic({kind:'reference-unknown',frames:this.unknownFrames});this.unknownFrames=0;
  // Speech that began just before Capri finished keeps its start and pre-roll, but still needs the same sustained run.
  if(this.candidate.length){this.boundary=true;return;}
  forget(this.quiet);this.quiet=[];this.quietCount=0;this.run=0;this.gap=0;
 }
 /** Continues an unconfirmed candidate after playback ends. */
 private boundaryFrame(frame:Pending,talking:boolean){
  frame.user=talking;
  if(talking){this.candidate.push(frame);this.run++;this.gap=0;}
  else if(this.gap<1){this.gap++;this.candidate.push(frame);}
  else{this.releaseBoundary(false,frame);return;}
  if(this.run>=BARGE_IN_FRAMES)this.releaseBoundary(true);
 }
 /** A confirmed candidate starts the turn after its pre-roll; an unconfirmed one is kept only as pre-roll for a later turn. */
 private releaseBoundary(confirmed:boolean,next?:Pending){
  const frames=[...this.quiet.map(f=>({f,talking:false})),...this.candidate.map(f=>({f,talking:confirmed&&!!f.user}))];if(next)frames.push({f:next,talking:false});
  this.quiet=[];this.quietCount=0;this.candidate=[];this.run=0;this.gap=0;this.boundary=false;
  try{for(const {f,talking} of frames){if(this.closed)return;this.segment(f,talking);}}finally{forget(frames.map(({f})=>f));}
 }
 /** Echo and unknown playback audio is kept inside an open turn (no gaps) but never becomes pre-roll for a new one. */
 private segment(frame:Pending,talking:boolean){
  if(!talking&&!this.turns.collecting&&(frame.echo==='echo'||frame.echo==='unknown')){this.turns.dropPreRoll();return;}
  this.segmentEvents(this.turns.push(frame.samples,talking,frame.level));
 }
 private segmentEvents(events:SegmentEvent[]){
  for(const event of events){
   if(event.final)this.bargeTurn=false;
   if(event.overflow)this.diagnostic({kind:'overflow',durationMs:ms(event.turnSamples)});
   else if(event.discarded)this.diagnostic({kind:'discarded',durationMs:ms(event.turnSamples)});
   else if(!event.final)this.diagnostic({kind:'chunk',durationMs:ms(event.chunk?.length??0)});
   else this.diagnostic({kind:'turn',durationMs:ms(event.turnSamples),detector:this.usingDetector?'model':'energy'});
   this.options.onSegment(event);if(this.closed)return;
  }
 }
 private diagnostic(entry:Omit<ListeningDiagnostic,'at'>){try{this.options.onDiagnostic?.({at:this.now(),noiseFloor:Math.round(this.noise*1e5)/1e5,...entry});}catch{}}
}
