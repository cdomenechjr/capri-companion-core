import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,Script} from 'node:vm';
import {DetectorSlots,ECHO_DELAY_SAMPLES,FRAME_SAMPLES,analyzeEcho,probabilityThreshold,rms,ListeningDiagnostics,ListeningPipeline,RECOGNIZER_MAX_SAMPLES,TurnSegmenter,applyVocabulary,clearListeningCalibration,updateListeningPreferences,defaultListeningPreferences,loadListeningPreferences,normalizeListeningPreferences,normalizeVocabulary,parseVadResponse,saveListeningPreferences,speechThreshold,toListeningSettings,type ListeningDiagnostic,type ListeningPreferences,type SegmentEvent,type VadRequest} from '../src/ui/listening';
import {microphoneOptions} from '../src/ui/audio';
import {Voice} from '../src/ui/voice';

/** Generated neutral audio only: constant-level frames tagged by value so order and completeness can be checked. No microphone. */
const FRAME=1600;
const frame=(level:number,length=FRAME)=>new Float32Array(length).fill(level);
const tagged=(base:number,i:number)=>frame(base+i*1e-6);
const tick=()=>new Promise<void>(r=>setImmediate(r));
async function until(check:()=>boolean){const deadline=Date.now()+2000;while(!check()){assert.ok(Date.now()<deadline,'actual detector POST dispatch deadline');await tick();}}
const voices=new Set<Voice>();
afterEach(async()=>{try{for(const voice of voices)await voice.stop();}finally{voices.clear();}});
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function clock(){const timers=new Set<{run:()=>void}>();return {schedule:(run:()=>void)=>{const t={run};timers.add(t);return ()=>timers.delete(t);},fire(){for(const t of [...timers]){timers.delete(t);t.run();}},get size(){return timers.size;}};}
const prefs=(patch:Partial<ListeningPreferences>={})=>({...defaultListeningPreferences(),...patch});
function pipeline(patch:Partial<ListeningPreferences>={},extra:Partial<ConstructorParameters<typeof ListeningPipeline>[0]>={}){
 const segments:SegmentEvent[]=[];const diagnostics:ListeningDiagnostic[]=[];let bargeIns=0;const timers=clock();
 const p=new ListeningPipeline({preferences:prefs(patch),sessionId:'session-1',schedule:timers.schedule,now:()=>1000,onSegment:e=>segments.push(e),onBargeIn:()=>{bargeIns++;},onDiagnostic:d=>diagnostics.push(d),...extra});
 return {p,segments,diagnostics,timers,get bargeIns(){return bargeIns;}};
}
const quiet={outputActive:false,outputLevel:0};
const turns=(segments:SegmentEvent[])=>segments.filter(s=>s.final&&!s.discarded);

test('actual microphone worklet keeps paired offsets and PCM aligned across real buffer transfers',async()=>{
 const source=await readFile(new URL('../src/ui/mic-worklet.js',import.meta.url),'utf8');
 for(const sampleRate of [48000,44100]){
  let Processor:any;
  class Shim {port={postMessage:(_packet:any,_transfer?:ArrayBuffer[])=>{}};}
  const realm=createContext({AudioWorkletProcessor:Shim,Float32Array,sampleRate,registerProcessor:(name:string,ctor:any)=>{
   assert.equal(name,'capri-microphone');assert.equal(Processor,undefined);Processor=ctor;
  }});
  new Script(source,{filename:'mic-worklet.js'}).runInContext(realm,{timeout:1000});
  assert.equal(typeof Processor,'function');
  const capture=(paired:boolean)=>{
   const processor=new Processor({processorOptions:{paired}}),packets:any[]=[];
   processor.port.postMessage=(packet:any,transfer?:ArrayBuffer[])=>{
    if(paired){
     assert.equal(transfer?.length,2);assert.equal(transfer![0],packet.samples.buffer);assert.equal(transfer![1],packet.reference.buffer);
     const size=packet.samples.length;assert.ok(size>=1600);
     packets.push(structuredClone(packet,{transfer:transfer!}));
     assert.equal(packet.samples.length,0,'transfer really detaches microphone PCM');
     assert.equal(packet.reference.length,0,'transfer really detaches reference PCM');
     assert.equal(packets.at(-1).samples.length,size);
    }else{assert.equal(transfer,undefined);packets.push(structuredClone(packet));}
   };
   return {processor,packets};
  };
  const {processor,packets}=capture(true);
  for(let q=0;q<200;q++){
   const mic=Float32Array.from({length:128},(_,i)=>q*128+i);
   const left=mic.map(v=>v*.25),right=mic.map(v=>v*.5);
   assert.equal(processor.process([[mic],[left,right]]),true);
  }
  assert.ok(packets.length>=4);assert.ok(packets.some(p=>p.samples.length>1600),'quantum-sized packets are not hardcoded to 1600');
  let start=0,previous=-1;
  for(const [sequence,packet] of packets.entries()){
   assert.equal(packet.sequence,sequence);assert.equal(packet.startSample,start);assert.equal(packet.sampleRate,16000);
   assert.equal(packet.referenceValid,true);assert.equal(packet.reference.length,packet.samples.length);
   for(let i=0;i<packet.samples.length;i++){
    const index=packet.samples[i];assert.ok(index>previous,'microphone samples never repeat or reorder');
    assert.ok(Math.abs(index-(start+i)*sampleRate/16000)<1.000001,'continuous resampling phase across packets');
    assert.equal(packet.reference[i],index*.375,'stereo reference is averaged at the same capture instant');previous=index;
   }
   start+=packet.samples.length;
  }
  const missing=capture(true);
  for(let q=0;q<120;q++){
   const mic=new Float32Array(128).fill(.125),ref=new Float32Array(128).fill(.25);
   // Missing microphone also invalidates this packet, without advancing its sample clock.
   if(q===6)assert.equal(missing.processor.process([[],[ref]]),true);
   assert.equal(missing.processor.process([[mic],q===5?[]:[ref]]),true);
  }
  assert.ok(missing.packets.length>=3);assert.equal(missing.packets[0].referenceValid,false);
  assert.ok(missing.packets[0].reference.some((v:number)=>v===0),'missing reference is zero filled');
  start=0;
  for(const [sequence,packet] of missing.packets.entries()){
   assert.equal(packet.sequence,sequence);assert.equal(packet.startSample,start);start+=packet.samples.length;
   assert.ok(packet.samples.every((v:number)=>v===.125));
   if(sequence>0){assert.equal(packet.referenceValid,true);assert.ok(packet.reference.every((v:number)=>v===.25));}
  }
  const legacy=capture(false);
  for(let q=0;q<120;q++)legacy.processor.process([[new Float32Array(128).fill(.125)]]);
  assert.ok(legacy.packets.length>=3);
  assert.ok(legacy.packets.every(p=>p instanceof Float32Array&&p.every((v:number)=>v===.125)),'legacy unpaired format is unchanged');
 }
});

/** Deterministic speech-like PCM: harmonics on a gliding pitch, a syllable envelope and breath noise. Generated only. */
function voiced(length:number,{seed,pitch,rate,level}:{seed:number;pitch:number;rate:number;level:number}){
 let s=seed>>>0;const noise=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/2**31-1;};
 const out=new Float32Array(length);let phase=0;
 for(let i=0;i<length;i++){
  const t=i/16000,f0=pitch*(1+.12*Math.sin(2*Math.PI*.7*t+seed)+.04*Math.sin(2*Math.PI*3.1*t+2*seed));phase+=2*Math.PI*f0/16000;
  let v=0;for(let h=1;h<=8;h++)v+=Math.sin(h*phase+h*seed)/h;out[i]=(.4+.6*Math.max(0,Math.sin(2*Math.PI*rate*t+seed)))*(v+.6*noise());
 }
 const k=level/rms(out);for(let i=0;i<length;i++)out[i]*=k;return out;
}
const hiss=(length:number,level=.0008,seed=99)=>{let s=seed;const out=new Float32Array(length);for(let i=0;i<length;i++){s=(Math.imul(s,1664525)+1013904223)>>>0;out[i]=(s/2**31-1)*level*1.7;}return out;};
/** Room path from the rendered output to the microphone: delayed copies, optional one-pole low-pass and speaker clipping. */
type Path={taps:[number,number][];lowpass?:number;clip?:number};
function echoOf(reference:Float32Array,{taps,lowpass,clip}:Path){
 const out=new Float32Array(reference.length);for(const [delay,gain] of taps)for(let i=delay;i<out.length;i++)out[i]+=gain*reference[i-delay];
 if(lowpass){let y=0;for(let i=0;i<out.length;i++){y+=lowpass*(out[i]-y);out[i]=y;}}
 if(clip!==undefined)for(let i=0;i<out.length;i++)out[i]=Math.max(-clip,Math.min(clip,out[i]));
 return out;
}
const mix=(...parts:Float32Array[])=>{const out=new Float32Array(Math.max(...parts.map(p=>p.length)));for(const p of parts)for(let i=0;i<p.length;i++)out[i]+=p[i];return out;};
/** `source` placed at `at` seconds in a take of `seconds`. */
const place=(seconds:number,at:number,source:Float32Array)=>{const out=new Float32Array(seconds*16000);out.set(source.subarray(0,Math.max(0,out.length-at*16000)),at*16000);return out;};
const CAPRI={seed:1,pitch:210,rate:3.3,level:.15},USER={seed:7,pitch:118,rate:2.4,level:.08};

/** Pushes aligned microphone/reference blocks with a monotonic capture index, as the paired worklet does. */
type Feed={output:(frame:number)=>boolean;valid?:(frame:number)=>boolean;start?:(offset:number)=>number;epoch?:(frame:number)=>number;block?:number;reference?:boolean;each?:()=>Promise<void>};
async function feed(p:Pick<ListeningPipeline,'push'>,mic:Float32Array,ref:Float32Array,{output,valid=()=>true,start=o=>o,epoch=()=>1,block=FRAME,reference=true,each}:Feed){
 for(let o=0;o<mic.length;o+=block){
  const n=Math.min(block,mic.length-o),f=Math.floor(o/FRAME);
  p.push(mic.slice(o,o+n),{outputActive:output(f),...(reference?{reference:{startSample:start(o),samples:ref.slice(o,o+n),valid:valid(f),epoch:epoch(f)}}:{})});
  await each?.();
 }
}
/** Where a turn's audio starts in the take, in frames. */
const startFrame=(mic:Float32Array,chunk:Float32Array)=>{for(let f=0;f*FRAME<mic.length;f++)if(chunk.subarray(0,FRAME).every((v,i)=>v===mic[f*FRAME+i]))return f;return -1;};
/** Capri talks for 9 s, quietly coupled for 6 s, then louder and clipped (output gain and path both change), with tails up to 375 ms after she ends. */
function attenuatedThenStrongEcho(){
 const length=16000*11,capri=voiced(16000*9,CAPRI),ref=new Float32Array(length);
 for(let i=0;i<capri.length;i++)ref[i]=capri[i]*(i<16000*6?.6:1.4);
 const weak=echoOf(ref,{taps:[[2200,.008]]}),strong=echoOf(ref,{taps:[[2200,.35],[2600,.12],[6000,.06]],clip:.12});
 const mic=hiss(length);for(let i=0;i<length;i++)mic[i]+=i<16000*6?weak[i]:strong[i];
 return {mic,ref};
}
/** Capri talks for 5 s through a filtered multi-path room; the user talks over her from 2 s to 3.5 s at a comparable level. */
function doubleTalk(user=true){
 const length=16000*8,ref=place(8,0,voiced(16000*5,CAPRI));
 return {ref,mic:mix(echoOf(ref,{taps:[[1800,.3],[1801,.15],[4000,.1]],lowpass:.5}),user?place(8,2,voiced(24000,USER)):new Float32Array(length),hiss(length))};
}

test('echo analysis explains Capri at any gain, clipping, filtering and delay, and leaves independent speech unexplained',()=>{
 // A 400 ms search window here; the 2 s pipeline window and long delays are covered by their own test.
 const ref=voiced(16000*3,CAPRI),user=voiced(16000*3,USER),window=6400+FRAME;
 const at=(mic:Float32Array,f:number)=>analyzeEcho(mic.slice(f*FRAME,(f+1)*FRAME),ref.slice((f+1)*FRAME-window,(f+1)*FRAME));
 const frames=[10,14,18,22,26];
 const paths:[string,Path][]=[['attenuated',{taps:[[2200,.02]]}],['strong',{taps:[[2200,.6]]}],['clipped',{taps:[[2200,.5],[2600,.12]],clip:.06}],
  ['filtered multi-path',{taps:[[1800,.3],[1801,.15],[4000,.1],[5600,.06]],lowpass:.35}],['delayed 375 ms',{taps:[[6000,.3]]}]];
 for(const [name,path] of paths){const mic=mix(echoOf(ref,path),hiss(ref.length,.0002));for(const f of frames)assert.ok(at(mic,f).explained>=.75,name+' frame '+f+' explained '+at(mic,f).explained);}
 // The same waveform at a fiftyfold gain change is judged the same way: nothing is learned from earlier frames.
 const quietEcho=mix(echoOf(ref,{taps:[[2200,.01]]}),hiss(ref.length,.00002)),loudEcho=mix(echoOf(ref,{taps:[[2200,.5]]}),hiss(ref.length,.001));
 for(const f of frames)assert.ok(Math.abs(at(quietEcho,f).explained-at(loudEcho,f).explained)<.05);
 const alone=mix(user,hiss(ref.length));for(const f of frames)assert.ok(at(alone,f).explained<.3,'independent speech frame '+f);
 const both=mix(echoOf(ref,{taps:[[1800,.3],[1801,.15],[4000,.1]],lowpass:.5}),user,hiss(ref.length));
 assert.ok(frames.filter(f=>at(both,f).explained<.7).length>=3,'comparable double talk mostly stays unexplained');
 for(const f of frames)assert.ok(Math.abs(at(both,f).residual-rms(user.slice(f*FRAME,(f+1)*FRAME)))<.02,'the residual is the user');
 const silent=analyzeEcho(new Float32Array(FRAME),ref.slice(0,window));
 assert.deepEqual({...silent,reference:0},{explained:0,residual:0,level:0,reference:0},'silence explains nothing');
 // The reference level is the loudest 100 ms of the window, so a long, mostly silent window does not dilute it.
 const short=new Float32Array(ECHO_DELAY_SAMPLES+FRAME);short.set(ref.subarray(0,FRAME));
 assert.ok(Math.abs(analyzeEcho(new Float32Array(FRAME),short).reference-rms(ref.subarray(0,FRAME)))<1e-9);
});

test('default energy threshold is unchanged and sensitivity moves it both ways',()=>{
 for(const noise of [0,.001,.002,.005,.01,.05])assert.equal(speechThreshold(noise),Math.max(.006,Math.min(.025,noise*3)));
 assert.ok(speechThreshold(.004,.1)<speechThreshold(.004,.5));assert.ok(speechThreshold(.004,.9)>speechThreshold(.004,.5));
});

test('background noise, short clicks and silence never produce a turn; speech with natural pauses is one turn with pre-roll',()=>{
 const t=pipeline();
 for(let i=0;i<30;i++)t.p.push(frame(.003+(i%3)*.0005),quiet);// fan noise below the adaptive threshold
 t.p.push(frame(.2),quiet);for(let i=0;i<16;i++)t.p.push(frame(.001),quiet);// one 100 ms click
 assert.equal(turns(t.segments).length,0);assert.equal(t.segments.filter(s=>s.discarded).length,1);
 for(let i=0;i<3;i++)t.p.push(tagged(.001,i),quiet);// pre-roll
 for(let i=0;i<5;i++)t.p.push(frame(.08),quiet);for(let i=0;i<10;i++)t.p.push(frame(.001),quiet);// one-second pause
 assert.equal(t.p.collecting,true);
 for(let i=0;i<5;i++)t.p.push(frame(.08),quiet);for(let i=0;i<14;i++)t.p.push(frame(.001),quiet);
 const [turn]=turns(t.segments);assert.ok(turn?.chunk);assert.equal(turn.chunk.length,(3+5+10+5+14)*FRAME);
 assert.equal(turn.chunk[0],Math.fround(.001));assert.equal(turn.chunk[2*FRAME],Math.fround(.001+2e-6),'pre-roll is kept in order');
 assert.equal(t.p.collecting,false);
});

test('an adaptive noise floor follows a louder room without treating it as speech, and calibration measures the room',async()=>{
 const t=pipeline();
 for(let i=0;i<200;i++)t.p.push(frame(.003+.005*i/200),quiet);// a room that slowly gets louder than the starting threshold
 assert.equal(t.segments.length,0);assert.ok(t.p.status().noiseFloor>.006);
 const measured=t.p.calibrate(10);for(let i=0;i<10;i++)t.p.push(frame(.004),quiet);
 assert.ok(Math.abs(await measured-.004)<1e-6);assert.equal(t.p.status().calibrated,true);
 for(let i=0;i<6;i++)t.p.push(frame(.1),quiet);for(let i=0;i<14;i++)t.p.push(frame(.004),quiet);
 assert.equal(turns(t.segments).length,1);
 const late=t.p.calibrate(10);t.timers.fire();await assert.rejects(late,/quiet/);
 const stopped=t.p.calibrate(10);t.p.close();await assert.rejects(stopped,/stopped/);
});

test('long turns are split within the recognizer limit at pauses without truncating or repeating audio',()=>{
 const segmenter=new TurnSegmenter({silenceSamples:22400,preRollSamples:4800});const input:Float32Array[]=[];const out:SegmentEvent[]=[];
 // 45 seconds of speech with a short breath every 3 seconds, then end-of-turn silence.
 for(let i=0;i<449;i++){const breath=i%30===29;const f=breath?tagged(.001,i):tagged(.1,i);input.push(f);out.push(...segmenter.push(f,!breath));}
 for(let i=0;i<14&&!out.some(e=>e.final);i++){const f=tagged(.0005,1000+i);input.push(f);out.push(...segmenter.push(f,false));}
 const chunks=out.map(e=>e.chunk!).filter(Boolean);
 assert.equal(out.filter(e=>e.final).length,1);assert.equal(chunks.length,3);
 for(const c of chunks)assert.ok(c.length<=RECOGNIZER_MAX_SAMPLES&&c.length>=1600);
 const joined=new Float32Array(chunks.reduce((n,c)=>n+c.length,0));let o=0;for(const c of chunks){joined.set(c,o);o+=c.length;}
 const expected=new Float32Array(input.length*FRAME);input.forEach((f,i)=>expected.set(f,i*FRAME));
 assert.equal(joined.length,expected.length,'nothing is dropped or repeated');
 assert.equal(joined.findIndex((v,i)=>v!==expected[i]),-1,'every captured sample appears once, in order');
 assert.equal(chunks[0][chunks[0].length-1],Math.fround(.001+179e-6),'the first part ends on a breath');
});

test('continuous speech is split exactly at the limit and the remainder carries into the next part',()=>{
 const segmenter=new TurnSegmenter({silenceSamples:22400,preRollSamples:4800});const out:SegmentEvent[]=[];
 for(let i=0;i<250;i++)out.push(...segmenter.push(frame(.1,1601),true));
 for(let i=0;i<14;i++)out.push(...segmenter.push(frame(0),false));
 const lengths=out.filter(e=>e.chunk).map(e=>e.chunk!.length);assert.equal(lengths[0],RECOGNIZER_MAX_SAMPLES);
 assert.equal(lengths.reduce((a,b)=>a+b,0),250*1601+14*FRAME);
});

test('a turn reaching the hard bound overflows without a submittable part, and the rest of that speech never becomes a turn',()=>{
 const segmenter=new TurnSegmenter({silenceSamples:22400,preRollSamples:4800,maxChunkSamples:16000,maxTurnSamples:64000});const out:SegmentEvent[]=[];
 for(let i=0;i<40;i++)out.push(...segmenter.push(frame(.1),true));
 assert.equal(out.filter(e=>e.final).length,1);const last=out.at(-1)!;
 assert.equal(last.overflow,true);assert.equal(last.chunk,undefined,'the overflow carries no audio of its own');
 assert.equal(out.filter(e=>e.chunk).length,4,'audio left in recognizer-sized parts before the bound');
 // The user keeps talking: nothing is held or emitted until the natural pause, and that speech cannot start a new turn.
 for(let i=0;i<60;i++)out.push(...segmenter.push(frame(.1),true));
 for(let i=0;i<13;i++)out.push(...segmenter.push(frame(.001),false));
 assert.equal(out.length,5);assert.equal(segmenter.collecting,true,'still the same spoken request');
 out.push(...segmenter.push(frame(.001),false));assert.equal(segmenter.collecting,false);assert.equal(out.length,5);
 for(let i=0;i<4;i++)out.push(...segmenter.push(frame(.2),true));for(let i=0;i<14;i++)out.push(...segmenter.push(frame(.001),false));
 const next=out.slice(5);assert.equal(next.filter(e=>e.final&&!e.overflow&&!e.discarded).length,1);
 assert.equal(next.reduce((n,e)=>n+(e.chunk?.length??0),0),(4+14)*FRAME,'the next request holds only its own audio');
});

test('detector results resolved out of order are applied in capture order and override energy',async()=>{
 const requests:{body:VadRequest;reply:ReturnType<typeof deferred<unknown>>}[]=[];
 const t=pipeline({enabled:true},{maxInflight:40,maxPending:40,detect:body=>{const reply=deferred<unknown>();requests.push({body,reply});return reply.promise;}});
 for(let i=0;i<24;i++)t.p.push(tagged(.001,i),quiet);// all too quiet for energy
 assert.equal(requests.length,24);assert.equal(requests[0].body.reset,true);assert.equal(requests[1].body.reset,undefined);
 assert.deepEqual(requests.map(r=>r.body.sequence),[...Array(24).keys()]);assert.ok(requests.every(r=>r.body.sessionId==='session-1'&&typeof r.body.samples==='string'));
 const speech=(i:number)=>i>=4&&i<8;
 for(let i=23;i>=1;i--)requests[i].reply.resolve({available:true,speech:speech(i)});await tick();
 assert.equal(t.segments.length,0,'nothing is processed while the first frame is undecided');assert.equal(t.p.pending,24);
 requests[0].reply.resolve({available:true,speech:false});await tick();
 const [turn]=turns(t.segments);assert.ok(turn?.chunk);
 for(let k=0;k<turn.chunk.length/FRAME;k++)assert.equal(turn.chunk[k*FRAME],Math.fround(.001+(k+1)*1e-6),'frame '+k+' in capture order');
 assert.equal(t.p.status().detector,'model');
});

test('probability uses the sensitivity threshold; unavailable, malformed and mismatched results fall back to energy honestly',async()=>{
 assert.deepEqual(parseVadResponse({available:true,speech:true,probability:.7},{sessionId:'s',sequence:1}),{available:true,speech:true,probability:.7});
 assert.equal(parseVadResponse({available:true,speech:true,sequence:2},{sessionId:'s',sequence:1}),undefined,'a duplicate for another frame is rejected');
 assert.equal(parseVadResponse({available:true,speech:true,sessionId:'old'},{sessionId:'s',sequence:1}),undefined);
 assert.equal(parseVadResponse({available:true,speech:'yes'},{sessionId:'s',sequence:1}),undefined);
 assert.deepEqual(parseVadResponse({available:false,reason:'Model missing: C:\\secret'},{sessionId:'s',sequence:1}),{available:false,reason:'unavailable'},'untrusted reason text is not echoed');
 // The backend has no model: one honest reply switches this session to energy.
 let calls=0;const off=pipeline({enabled:true},{detect:async()=>{calls++;return {available:false,reason:'model-missing'};}});
 off.p.push(frame(.001),quiet);await tick();for(let i=0;i<5;i++)off.p.push(frame(.001),quiet);
 assert.equal(calls,1);assert.deepEqual(off.p.status(),{...off.p.status(),detector:'energy',reason:'model-missing'});
 assert.deepEqual(off.diagnostics.filter(d=>d.kind==='vad-fallback').map(d=>d.reason),['model-missing']);
 // A backend that repeats the first frame's answer for every frame is treated as broken, not as speech.
 const stale=pipeline({enabled:true},{detect:async()=>({available:true,speech:true,sequence:0})});
 for(let i=0;i<20;i++){stale.p.push(frame(.001),quiet);await tick();}
 assert.equal(stale.p.status().detector,'energy');assert.equal(turns(stale.segments).length,0,'stale speech answers created no turn');
 const prob=pipeline({enabled:true,vadThreshold:.8},{detect:async()=>({available:true,speech:true,probability:.6})});
 for(let i=0;i<6;i++){prob.p.push(frame(.001),quiet);await tick();}assert.equal(prob.p.collecting,false,'0.6 is below a 0.8 threshold');
});

test('detector requests stay bounded; timeouts decide by energy, mark a gap, and later replies change nothing',async()=>{
 const replies:ReturnType<typeof deferred<unknown>>[]=[];const bodies:VadRequest[]=[];
 const t=pipeline({enabled:true},{maxInflight:2,maxPending:10,detect:body=>{bodies.push(body);const d=deferred<unknown>();replies.push(d);return d.promise;}});
 for(let i=0;i<8;i++)t.p.push(frame(.1),quiet);
 assert.equal(replies.length,2,'only two requests are outstanding');assert.equal(t.p.pending,8,'later frames wait behind the first in order');
 t.timers.fire();assert.equal(t.p.pending,6,'waiting frames keep their place for the detector');assert.equal(t.p.collecting,true,'energy decided only the timed-out frames');
 replies[0].resolve({available:true,speech:false});replies[1].resolve({available:true,speech:false});await tick();
 assert.equal(t.p.collecting,true,'late replies change nothing');assert.equal(t.p.status().detector,'model','two timeouts are not yet a fallback');
 assert.deepEqual(bodies.map(b=>b.sequence),[0,1,2,3],'freed slots go to the next frames in order');assert.equal(bodies[2].reset,true,'the detector is told its stream has a gap');assert.equal(bodies[3].reset,undefined);
 const bounded=pipeline({enabled:true},{maxInflight:2,maxPending:4,detect:()=>new Promise(()=>{})});
 for(let i=0;i<30;i++){bounded.p.push(frame(.1),quiet);assert.ok(bounded.p.pending<=4);}
 assert.deepEqual(bounded.p.status(),{...bounded.p.status(),detector:'energy',reason:'overloaded'});
});

test('with the production concurrency limit, slow detector replies still decide every frame in order and overload falls back visibly',async()=>{
 // 100 ms frames and 500 ms detector replies: every frame waits for the model, so loud noise the model rejects never becomes a turn.
 let step=0;const requests:{at:number;body:VadRequest;reply:ReturnType<typeof deferred<unknown>>;done?:boolean}[]=[];
 const t=pipeline({enabled:true},{detect:body=>{const reply=deferred<unknown>();requests.push({at:step,body,reply});return reply.promise;}});
 const answer=(age:number)=>{for(const r of requests)if(!r.done&&step-r.at>=age){r.done=true;r.reply.resolve({available:true,speech:false,sequence:r.body.sequence});}};
 for(step=0;step<20;step++){answer(5);await tick();t.p.push(step===8||step===9?frame(.3):frame(.001),quiet);assert.ok(requests.filter(r=>!r.done).length<=3);}
 for(let i=0;i<40&&t.p.pending;i++){step+=5;answer(0);await tick();}
 assert.equal(t.p.pending,0);assert.equal(t.p.collecting,false);assert.equal(t.segments.length,0,'the model rejected the noise');
 assert.deepEqual(requests.map(r=>r.body.sequence),[...Array(20).keys()],'every frame reached the detector, in order, with no gap');
 assert.equal(t.p.status().detector,'model');assert.equal(t.diagnostics.filter(d=>d.kind==='vad-fallback').length,0);
 // A detector that stays slower than capture builds a backlog; past the bound the session switches to energy and says so.
 for(let i=0;i<60;i++){step++;answer(5);await tick();t.p.push(frame(.001),quiet);assert.ok(t.p.pending<=12);}
 assert.deepEqual(t.p.status(),{...t.p.status(),detector:'energy',reason:'overloaded'});
 assert.deepEqual(t.diagnostics.filter(d=>d.kind==='vad-fallback').map(d=>d.reason),['overloaded']);
});

test('detector results that arrive after stop are ignored and cannot submit a turn',async()=>{
 const replies:ReturnType<typeof deferred<unknown>>[]=[];let frames=0;
 const t=pipeline({enabled:true},{maxInflight:40,maxPending:40,onFrame:()=>{frames++;},detect:()=>{const d=deferred<unknown>();replies.push(d);return d.promise;}});
 for(let i=0;i<25;i++)t.p.push(frame(.1),quiet);t.p.close();
 for(const r of replies)r.resolve({available:true,speech:true});await tick();
 t.p.push(frame(.1),quiet);await tick();
 assert.equal(frames,0);assert.deepEqual(t.segments,[]);assert.equal(t.timers.size,0,'timers were cancelled');
});

test('quiet echo followed by louder, clipped echo and tails after Capri ends never interrupts or becomes a request',async()=>{
 const {mic,ref}=attenuatedThenStrongEcho();
 for(const mode of ['energy','detector'] as const){
  const d=heldDetector();const t=pipeline({bargeIn:true,enabled:mode==='detector'},mode==='detector'?{detect:d.detect,maxPending:100}:{});
  // The playback guard ends 100 ms after the rendered output: the louder path's 375 ms tail arrives after it.
  await feed(t.p,mic,ref,{output:f=>f<91,block:1621,each:mode==='detector'?()=>d.answer():undefined});await d.answer();
  assert.equal(t.p.pending,0);assert.equal(mode==='detector'?t.p.status().detector:'energy',mode==='detector'?'model':'energy');
  assert.equal(t.bargeIns,0,mode+': no interruption');assert.deepEqual(turns(t.segments),[],mode+': no request from echo');assert.equal(t.p.collecting,false);
  assert.ok(t.diagnostics.some(e=>e.kind==='echo-suppressed'));
  // Normal listening afterwards hears the next request, with none of Capri's audio as pre-roll.
  const next=mix(place(3,.4,voiced(16000,USER)),hiss(48000,.0008,5));
  await feed(t.p,next,new Float32Array(next.length),{output:()=>false,start:o=>mic.length+o,each:mode==='detector'?()=>d.answer():undefined});await d.answer();
  const [turn]=turns(t.segments);assert.equal(turns(t.segments).length,1,mode+': one request');assert.equal(startFrame(next,turn.chunk!),1,'pre-roll is the user’s own room');
 }
});

test('a short noise over Capri never interrupts; sustained speech her reference cannot explain barges in once without her echo',async()=>{
 const {mic,ref}=doubleTalk();
 // A 200 ms knock (uncorrelated with her playback) during the reply, before the user talks.
 const knock=hiss(3200,.2,3);for(let i=0;i<3200;i++)mic[16000+i]+=knock[i];
 const t=pipeline({bargeIn:true});
 await feed(t.p,mic.slice(0,16000*2),ref.slice(0,16000*2),{output:()=>true});
 assert.equal(t.bargeIns,0,'the knock and her echo do not interrupt');assert.equal(t.p.collecting,false);
 await feed(t.p,mic.slice(16000*2),ref.slice(16000*2),{output:f=>f<35,start:o=>32000+o});
 assert.equal(t.bargeIns,1,'one interruption');assert.equal(turns(t.segments).length,1);assert.equal(t.p.collecting,false,'the turn ended on its pause');
 const [turn]=turns(t.segments);const first=startFrame(mic,turn.chunk!);
 assert.ok(first>=20&&first<=21,'the turn starts with the user, not with echo pre-roll (frame '+first+')');
 assert.ok(first+turn.chunk!.length/FRAME>=35,'and keeps every frame of their speech');
 assert.ok(t.diagnostics.some(e=>e.kind==='barge-in'));
 // The same take without the user: pure echo with the knock.
 const echo=doubleTalk(false);for(let i=0;i<3200;i++)echo.mic[16000+i]+=knock[i];
 const e=pipeline({bargeIn:true});await feed(e.p,echo.mic,echo.ref,{output:f=>f<55});
 assert.equal(e.bargeIns,0);assert.deepEqual(turns(e.segments),[]);
});

test('headphones: playback the microphone never hears lets the user interrupt with their quiet pre-roll',async()=>{
 const ref=place(8,0,voiced(16000*5,CAPRI)),mic=mix(place(8,2,voiced(24000,USER)),hiss(16000*8));
 const t=pipeline({bargeIn:true});await feed(t.p,mic,ref,{output:f=>f<55});
 assert.equal(t.bargeIns,1);const [turn]=turns(t.segments);assert.equal(turns(t.segments).length,1);
 assert.equal(startFrame(mic,turn.chunk!),17,'three quiet frames of pre-roll, then the user');
});

test('missing, invalid, discontinuous, other-graph or detached reference is unknown: no interruption, normal listening afterwards',async()=>{
 const {mic,ref}=doubleTalk();
 const cases:[string,Partial<Feed>][]=[['invalid',{valid:()=>false}],['missing',{reference:false}],['discontinuous',{start:o=>o+Math.floor(o/FRAME)*7}],
  ['other graph',{epoch:f=>f}],['detached mid-reply',{valid:f=>f<15}],['stale capture index',{start:o=>o%(FRAME*4)}]];
 for(const [name,options] of cases){
  const t=pipeline({bargeIn:true});await feed(t.p,mic,ref,{output:f=>f<55,...options});
  assert.equal(t.bargeIns,0,name);assert.deepEqual(turns(t.segments),[],name+': speech over unknown playback is not a request');
  assert.ok(t.diagnostics.some(e=>e.kind==='reference-unknown'),name+' is reported');
  const next=mix(place(3,.4,voiced(16000,USER)),hiss(48000));for(let f=0;f*FRAME<next.length;f++)t.p.push(next.slice(f*FRAME,(f+1)*FRAME),quiet);
  assert.equal(turns(t.segments).length,1,name+': normal listening still works');
 }
 // A reference that was explaining the room keeps doing so until it detaches; the user then cannot interrupt automatically.
 const late=pipeline({bargeIn:true});await feed(late.p,mic,ref,{output:f=>f<55,valid:f=>f<19});assert.equal(late.bargeIns,0);
});

/**
 * Capri rendered very quietly (every 25 ms of reference below 0.002 RMS) while the speaker volume and room make her echo
 * louder than normal speech, with delayed paths up to 375 ms that keep arriving after the playback guard ends.
 */
function quietRenderedLoudEcho(){
 const length=16000*8,ref=place(8,0,voiced(16000*4,{...CAPRI,level:.0008}));
 return {ref,mic:mix(echoOf(ref,{taps:[[2200,80],[4400,40],[6000,40]]}),hiss(length))};
}
test('quiet rendered playback amplified by the room is compared by waveform, during playback and its delayed tail, with barge-in on or off',async()=>{
 const {ref,mic}=quietRenderedLoudEcho();
 for(let i=0;i<16000*4;i+=400)assert.ok(rms(ref.subarray(i,i+400))<.002,'the reference stays below 0.002 at '+i);
 const loud=(from:number,to:number)=>{let n=0;for(let f=from;f<to;f++)if(rms(mic.subarray(f*FRAME,(f+1)*FRAME))>speechThreshold(.05))n++;return n;};
 assert.ok(loud(2,40)>=30,'the echo is above the highest energy threshold during playback');assert.ok(loud(40,44)>=3,'and in the delayed tail');
 for(const bargeIn of [true,false])for(const mode of ['energy','detector'] as const){
  const name=(bargeIn?'barge-in ':'no barge-in ')+mode,d=heldDetector();
  const t=pipeline({bargeIn,enabled:mode==='detector'},mode==='detector'?{detect:d.detect,maxPending:100}:{});
  // The playback guard ends exactly when rendering ends; up to 375 ms of echo arrives after it.
  await feed(t.p,mic,ref,{output:f=>f<40,each:mode==='detector'?()=>d.answer():undefined});await d.answer();
  assert.equal(t.p.pending,0);assert.equal(t.bargeIns,0,name+': no interruption');
  assert.equal(turns(t.segments).length,0,name+': no request from echo');assert.equal(t.p.collecting,false,name);
  // Once the reference tail has expired, silence is silence again and the next request is heard with its own pre-roll.
  const next=mix(place(3,.4,voiced(16000,USER)),hiss(48000,.0008,5));
  await feed(t.p,next,new Float32Array(next.length),{output:()=>false,start:o=>mic.length+o,each:mode==='detector'?()=>d.answer():undefined});await d.answer();
  const [turn]=turns(t.segments);assert.equal(turns(t.segments).length,1,name+': one request');assert.equal(startFrame(next,turn.chunk!),1,name+': pre-roll is the user’s own room');
 }
});

/**
 * Capri talks for 3 s and her echo reaches the microphone only along delayed paths (800 ms, 1.2 s, or both through a
 * filter) with a gain that keeps changing. The playback guard ends 500 ms after her output, so up to 700 ms of pure echo
 * arrives after it, beyond the old 500 ms reference window.
 */
const GUARD_END=35;
function longTail(seconds:number,taps:[number,number][],lowpass?:number){
 const length=seconds*16000,ref=new Float32Array(length);ref.set(voiced(16000*3,CAPRI));
 const echo=echoOf(ref,{taps,lowpass});for(let i=0;i<length;i++)echo[i]*=1+.5*Math.sin(2*Math.PI*.37*i/16000+1);
 return {ref,mic:mix(echo,hiss(length))};
}
const TAILS:[string,[number,number][],number?][]=[['800 ms',[[12800,.7]]],['1.2 s',[[19203,.6]]],['800 ms and 1.2 s, filtered',[[12810,.5],[19203,.5]],.5]];

test('echo analysis over the 2 s window finds delayed paths past 500 ms and still leaves independent speech unexplained',()=>{
 const ref=voiced(16000*4,CAPRI),user=voiced(16000*4,USER),window=ECHO_DELAY_SAMPLES+FRAME;
 const at=(mic:Float32Array,f:number)=>analyzeEcho(mic.slice(f*FRAME,(f+1)*FRAME),ref.slice((f+1)*FRAME-window,(f+1)*FRAME));
 for(const [name,taps,lowpass] of TAILS){const mic=mix(echoOf(ref,{taps,lowpass}),hiss(ref.length,.0002));for(const f of [24,28,32,36])assert.ok(at(mic,f).explained>=.75,name+' frame '+f+' explained '+at(mic,f).explained);}
 const alone=mix(user,hiss(ref.length));for(const f of [24,28,32,36])assert.ok(at(alone,f).explained<.3,'independent speech frame '+f);
});

test('pure echo delayed past 500 ms with changing gain is compared for its whole tail, never interrupts or becomes a request, and speech resumes after it',async()=>{
 for(const [name,taps,lowpass] of TAILS){
  const {ref,mic}=longTail(6,taps,lowpass);
  let late=0;for(let f=GUARD_END;f<45;f++)if(rms(mic.subarray(f*FRAME,(f+1)*FRAME))>speechThreshold(.05))late++;
  assert.ok(late>=2,name+': speech-level echo keeps arriving after the playback guard ('+late+' frames)');
  for(const bargeIn of [true,false])for(const mode of ['energy','detector'] as const){
   const label=name+(bargeIn?' barge-in ':' no barge-in ')+mode,d=heldDetector();
   const t=pipeline({bargeIn,enabled:mode==='detector'},mode==='detector'?{detect:d.detect,maxPending:100}:{});
   await feed(t.p,mic,ref,{output:f=>f<GUARD_END,block:1621,each:mode==='detector'?()=>d.answer():undefined});await d.answer();
   assert.equal(t.p.pending,0);assert.equal(t.bargeIns,0,label+': no interruption');
   assert.deepEqual(turns(t.segments),[],label+': no request from her delayed echo');assert.equal(t.p.collecting,false,label);
   assert.ok(t.diagnostics.some(e=>e.kind==='echo-suppressed'),label);
   // The bounded window has cleared (5.1 s): the next request is heard normally, with the user's own pre-roll.
   const next=mix(place(3,.4,voiced(16000,USER)),hiss(48000,.0008,5));
   await feed(t.p,next,new Float32Array(next.length),{output:()=>false,start:o=>mic.length+o,each:mode==='detector'?()=>d.answer():undefined});await d.answer();
   const [turn]=turns(t.segments);assert.equal(turns(t.segments).length,1,label+': one request');assert.equal(startFrame(next,turn.chunk!),1,label+': pre-roll is the user’s own room');
  }
 }
});

test('the user is heard inside the long tail window once her echo has ended; a reference lost in the tail stays unknown until it clears',async()=>{
 // Echo along 800 ms ends at 3.8 s; the user starts at 4.2 s, while the window still holds her output (until 5.1 s).
 const {ref,mic:echo}=longTail(7,[[12800,.7]]),mic=mix(echo,place(7,4.2,voiced(16000,USER)));
 for(const bargeIn of [true,false])for(const mode of ['energy','detector'] as const){
  const label=(bargeIn?'barge-in ':'no barge-in ')+mode,d=heldDetector();
  const t=pipeline({bargeIn,enabled:mode==='detector'},mode==='detector'?{detect:d.detect,maxPending:100}:{});
  await feed(t.p,mic,ref,{output:f=>f<GUARD_END,each:mode==='detector'?()=>d.answer():undefined});await d.answer();
  assert.equal(t.bargeIns,0,label+': Capri was not playing, so nothing is interrupted');
  const [turn]=turns(t.segments);assert.equal(turns(t.segments).length,1,label+': not deaf for the length of the window');
  assert.equal(startFrame(mic,turn.chunk!),39,label+': three quiet frames of pre-roll after her echo, then the user');
  assert.ok(39+turn.chunk!.length/FRAME>=52,label+': all of the request');
 }
 // The paired reference detaches after the guard while her 1.2 s echo still arrives: unknown, never a request, and
 // ordinary listening returns once her output has left the window.
 const lost=longTail(6,[[19203,.6]]);
 const t=pipeline({bargeIn:true});await feed(t.p,lost.mic,lost.ref,{output:f=>f<GUARD_END,valid:f=>f<GUARD_END+1});
 assert.equal(t.bargeIns,0);assert.deepEqual(turns(t.segments),[]);assert.equal(t.p.collecting,false);
 const next=mix(place(3,.4,voiced(16000,USER)),hiss(48000,.0008,5));
 await feed(t.p,next,new Float32Array(next.length),{output:()=>false,start:o=>lost.mic.length+o});
 assert.equal(turns(t.segments).length,1);assert.equal(startFrame(next,turns(t.segments)[0].chunk!),1);
});

test('without barge-in playback audio is discarded as before',()=>{
 const t=pipeline();for(let i=0;i<20;i++)t.p.push(frame(.4),{outputActive:true,outputLevel:.1});
 assert.equal(t.bargeIns,0);assert.equal(t.p.collecting,false);for(let i=0;i<14;i++)t.p.push(frame(.001),quiet);assert.deepEqual(turns(t.segments),[]);
});

test('variable worklet blocks become exact 1600-sample detector frames without losing or repeating samples',async()=>{
 const sent:Float32Array[]=[];const bodies:VadRequest[]=[];
 const t=pipeline({enabled:true},{maxInflight:100,maxPending:100,encode:s=>{sent.push(s.slice());return 'x';},detect:body=>{bodies.push(body);return new Promise(()=>{});}});
 // 44.1 and 48 kHz capture downsampled by the worklet arrives as 1621-1626 samples per message.
 const sizes=[1621,1626,1622,1625,1623,1624,1621,1626,1600,7,3200,1599];let total=0;const input:Float32Array[]=[];
 for(const [i,size] of sizes.entries()){const block=new Float32Array(size);for(let k=0;k<size;k++)block[k]=Math.sin(total+k)*.01;total+=size;input.push(block);t.p.push(block,quiet);}
 const joined=new Float32Array(total);let o=0;for(const b of input){joined.set(b,o);o+=b.length;}
 const whole=Math.floor(total/FRAME_SAMPLES);
 assert.equal(sent.length,whole);assert.ok(sent.every(s=>s.length===FRAME_SAMPLES),'every detector call is exactly 1600 samples');
 assert.deepEqual(bodies.map(b=>b.sequence),[...Array(whole).keys()]);
 sent.forEach((s,i)=>assert.equal(s.findIndex((v,k)=>v!==joined[i*FRAME_SAMPLES+k]),-1,'frame '+i+' is the next 1600 captured samples'));
 // The tail waits for the next block and is completed by it, not padded or dropped.
 const tail=total%FRAME_SAMPLES;const next=new Float32Array(FRAME_SAMPLES-tail).fill(.5);t.p.push(next,quiet);
 assert.equal(sent.length,whole+1);assert.equal(sent[whole].findIndex((v,k)=>v!==(k<tail?joined[whole*FRAME_SAMPLES+k]:Math.fround(.5))),-1);
 // Stop drops the unfinished tail and later blocks; a new capture session starts clean at sequence 0 with reset.
 t.p.push(new Float32Array(900).fill(.2),quiet);t.p.close();t.p.push(new Float32Array(5000),quiet);assert.equal(sent.length,whole+1);
 const fresh=pipeline({enabled:true},{encode:s=>{sent.push(s.slice());return 'x';},detect:body=>{bodies.push(body);return new Promise(()=>{});}});
 fresh.p.push(new Float32Array(1000).fill(.3),quiet);assert.equal(sent.length,whole+1);fresh.p.push(new Float32Array(600).fill(.3),quiet);
 assert.equal(sent.length,whole+2);assert.ok(sent[whole+1].every(v=>v===Math.fround(.3)),'no samples from the stopped session');
 assert.deepEqual(bodies.at(-1),{sessionId:'session-1',sequence:0,samples:'x',reset:true});
 fresh.p.close();
});

test('a frame that contains any playback audio is treated as playback',()=>{
 const t=pipeline();
 for(let i=0;i<20;i++){t.p.push(frame(.4,800),quiet);t.p.push(frame(.4,800),{outputActive:true,outputLevel:.1});}
 for(let i=0;i<14;i++)t.p.push(frame(.001),quiet);
 assert.deepEqual(t.segments,[],'mixed frames never start a turn while barge-in is off');
});

test('turning the detector off and on abandons outstanding decisions, frees its slots and resets the model stream',async()=>{
 const requests:{body:VadRequest;reply:ReturnType<typeof deferred<unknown>>}[]=[];
 const t=pipeline({enabled:true},{detect:body=>{const reply=deferred<unknown>();requests.push({body,reply});return reply.promise;}});
 for(let i=0;i<3;i++)t.p.push(tagged(.001,i),quiet);// pre-roll
 for(let i=0;i<3;i++)t.p.push(tagged(.1,3+i),quiet);
 assert.equal(requests.length,3);assert.equal(t.p.pending,6);
 t.p.configure(prefs({enabled:false}));
 assert.equal(t.p.pending,0,'waiting frames are decided by energy in place');assert.equal(t.p.collecting,true,'the user turn continues');
 assert.deepEqual(t.p.status(),{...t.p.status(),detector:'energy',reason:'disabled'});
 for(const r of requests)r.reply.resolve({available:false,reason:'model-missing'});await tick();
 assert.equal(t.diagnostics.filter(d=>d.kind==='vad-fallback').length,0,'stale replies cannot cause a fallback');
 for(let i=0;i<3;i++)t.p.push(tagged(.1,6+i),quiet);// energy-only frames: a gap in the model stream
 assert.equal(requests.length,3);
 t.p.configure(prefs({enabled:true}));assert.deepEqual(t.p.status(),{...t.p.status(),detector:'model',reason:'ready'});
 for(let i=0;i<3;i++)t.p.push(tagged(.1,9+i),quiet);
 assert.equal(requests.length,6,'slots held by abandoned requests are free again');
 assert.deepEqual(requests.slice(3).map(r=>[r.body.sequence,r.body.reset]),[[9,true],[10,undefined],[11,undefined]],'the first request after the gap resets the model');
 // A quick off/on with frames outstanding also abandons them and resets again.
 t.p.configure(prefs({enabled:false}));t.p.configure(prefs({enabled:true}));
 assert.equal(t.p.pending,0);
 for(const r of requests.slice(3))r.reply.resolve({available:true,speech:false});await tick();
 t.p.push(tagged(.1,12),quiet);assert.equal(requests[6].body.reset,true);assert.equal(requests[6].body.sequence,12);
 requests[6].reply.resolve({available:true,speech:true});await tick();
 for(let i=0;i<14;i++){t.p.push(frame(.001),quiet);await tick();for(const r of requests)r.reply.resolve({available:true,speech:false,sequence:r.body.sequence});await tick();}
 const [turn]=turns(t.segments);assert.ok(turn?.chunk,'one turn across every transition');assert.equal(turns(t.segments).length,1);
 for(let k=0;k<13;k++)assert.equal(turn.chunk[k*FRAME],Math.fround(k<3?.001+k*1e-6:.1+k*1e-6),'frame '+k+' kept in capture order');
});

test('an explicit re-enable retries a detector that had fallen back',async()=>{
 const bodies:VadRequest[]=[];let available=false;
 const t=pipeline({enabled:true},{detect:async body=>{bodies.push(body);return available?{available:true,speech:false}:{available:false,reason:'model-missing'};}});
 t.p.push(frame(.001),quiet);await tick();assert.equal(t.p.status().reason,'model-missing');
 t.p.push(frame(.001),quiet);assert.equal(bodies.length,1);
 available=true;t.p.configure(prefs({enabled:false}));t.p.configure(prefs({enabled:true}));
 assert.equal(t.p.status().detector,'model');t.p.push(frame(.001),quiet);
 assert.deepEqual(bodies.map(b=>[b.sequence,b.reset]),[[0,true],[2,true]]);
});

test('a user turn still open when playback starts keeps every frame and ends on its pause despite Capri echo',()=>{
 for(const bargeIn of [false,true]){
  const t=pipeline({bargeIn});const playing={outputActive:true,outputLevel:.12};
  for(let i=0;i<3;i++)t.p.push(tagged(.001,i),quiet);for(let i=0;i<5;i++)t.p.push(tagged(.1,i),quiet);
  for(let i=0;i<20&&!t.segments.length;i++)t.p.push(frame(.05),playing);// her voice leaking back is not user speech
  const [turn]=turns(t.segments);assert.ok(turn?.chunk,'the turn is submitted, not discarded');assert.equal(t.segments.filter(s=>s.discarded).length,0);
  assert.equal(turn.chunk.length,(3+5+14)*FRAME);assert.equal(turn.chunk[3*FRAME],Math.fround(.1));assert.equal(t.bargeIns,0);
 }
});

test('sustained unexplained speech in a turn already open when playback starts barges in once and keeps every frame',async()=>{
 // An earlier reply showed how this room couples Capri's playback; then the user starts talking and she starts over them.
 const earlier=place(2,0,voiced(16000,{...CAPRI,seed:3})),path:Path={taps:[[1800,.3],[1801,.15],[4000,.1]],lowpass:.5};
 const reply=place(5,1,voiced(16000*4,CAPRI)),user=place(5,.4,voiced(16000*2,USER));
 const ref=mix(earlier,place(7,2,reply)),mic=mix(echoOf(ref,path),place(7,2,user),hiss(16000*7));
 const output=(f:number)=>f<15||f>=30&&f<75;
 for(const bargeIn of [true,false]){
  const t=pipeline({bargeIn});await feed(t.p,mic,ref,{output});
  assert.equal(t.bargeIns,bargeIn?1:0);assert.equal(turns(t.segments).length,1);assert.equal(t.segments.filter(s=>s.discarded).length,0);
  const [turn]=turns(t.segments);assert.equal(startFrame(mic,turn.chunk!),21,'pre-roll, then the user from before Capri started');
  assert.ok(21+turn.chunk!.length/FRAME>=44,'every frame of their speech over Capri is kept');
 }
 // Loud sound her reference never explains, with no earlier evidence of how the room couples her playback, is unknown
 // (low correlation alone is not another speaker): no interruption, but the open turn keeps its frames and ends on its pause.
 const loud=place(5,.4,voiced(16000*2,{...USER,level:.25}));
 const fresh=mix(echoOf(place(7,2,reply),path),place(7,2,loud),hiss(16000*7));
 const t=pipeline({bargeIn:true});await feed(t.p,fresh,place(7,2,reply),{output:f=>f>=30&&f<75});
 assert.equal(t.bargeIns,0);assert.equal(turns(t.segments).length,1);assert.equal(startFrame(fresh,turns(t.segments)[0].chunk!),21);
});

test('the settled barrier waits for outstanding detector frames, is bounded, and releases on stop',async()=>{
 const replies:ReturnType<typeof deferred<unknown>>[]=[];
 const t=pipeline({enabled:true},{detect:()=>{const d=deferred<unknown>();replies.push(d);return d.promise;}});
 let done=false;await t.p.settled();// nothing pending
 t.p.push(frame(.001),quiet);t.p.push(frame(.001),quiet);void t.p.settled().then(()=>{done=true;});
 t.p.push(frame(.001),quiet);// a later frame does not extend the barrier
 replies[0].resolve({available:true,speech:false});await tick();assert.equal(done,false);
 replies[1].resolve({available:true,speech:false});await tick();assert.equal(done,true);assert.equal(t.p.pending,1);
 const energy=pipeline();energy.p.push(frame(.1),quiet);let instant=false;void energy.p.settled().then(()=>{instant=true;});await tick();assert.equal(instant,true);
 const timers:{run:()=>void;ms:number}[]=[];
 const stuck=pipeline({enabled:true},{schedule:(run,ms)=>{const t={run,ms};timers.push(t);return ()=>{timers.splice(timers.indexOf(t)>>>0,1);};},detect:()=>new Promise(()=>{})});stuck.p.push(frame(.001),quiet);
 let bounded=false;void stuck.p.settled(50).then(()=>{bounded=true;});timers.find(t=>t.ms===50)!.run();await tick();
 assert.equal(bounded,true,'the wait is bounded');assert.equal(stuck.p.pending,1,'while the detector frame is still undecided');
 stuck.p.push(frame(.001),quiet);let closed=false;void stuck.p.settled().then(()=>{closed=true;});stuck.p.close();await tick();assert.equal(closed,true);
});

function voiceHarness(detect?:(body:any)=>Promise<unknown>,transcribe?:(body:any,n:number)=>unknown){
 const transcripts:any[]=[];const chats:any[]=[];const detects:any[]=[];const events:any[]=[];const played:string[]=[];let stops=0;
 const captureToken=crypto.randomUUID();
 (globalThis as any).window={capri:{request:async(method:string,route:string,body:any)=>{
  if(route==='/v1/voice/local/capture'&&method==='GET'){assert.equal(body,undefined);return {captureToken};}
  if(route==='/v1/voice/local/transcribe'){transcripts.push(body);return transcribe?transcribe(body,transcripts.length):{text:'part '+transcripts.length};}
  if(route==='/v1/chat'){chats.push(body);return {id:body.id,status:'running'};}
  if(route==='/v1/voice/local/detect'){assert.equal(method,'POST');assert.equal(body.captureToken,captureToken);assert.equal(typeof body.sessionId,'string');assert.ok(Number.isSafeInteger(body.sequence)&&body.sequence>=0);assert.equal(typeof body.samples,'string');assert.ok(body.reset===undefined||body.reset===true);detects.push(body);return detect?detect(body):{available:false,reason:'model-missing'};}
  if(route==='/v1/voice/speak')return {base64:body.text};
  if(method==='DELETE')return {};throw Error('Unexpected route '+route);
 }}};
 (globalThis as any).cancelAnimationFrame=()=>{};
 const voice=new Voice(e=>events.push(e),()=>false,true);
 voices.add(voice);
 voice.player={playing:false,play:async(text:string)=>{played.push(text);},stop:()=>{stops++;(voice.player as any).playing=false;}} as any;
 voice.active=true;voice.localMode=true;
 return {voice,transcripts,chats,detects,events,played,get stops(){return stops;}};
}

test('prepared output waits for the detector so a user turn captured just before it is submitted whole',async()=>{
 const pending:{body:VadRequest;reply:ReturnType<typeof deferred<unknown>>}[]=[];
 const h=voiceHarness(body=>{const reply=deferred<unknown>();pending.push({body,reply});return reply.promise;});h.voice.applyListening(prefs({enabled:true}));
 const p=(h.voice as any).listen(h.voice.generation) as ListeningPipeline;const ctx=()=>({outputActive:h.voice.outputGuardActive,outputLevel:h.voice.outputGuardActive?.12:0});
 const answer=async(speech:(sequence:number)=>boolean)=>{for(let i=0;i<10;i++){for(const r of pending.splice(0))r.reply.resolve({available:true,speech:speech(r.body.sequence),sequence:r.body.sequence});await tick();}};
 // The user starts speaking; their frames are still with the detector when Capri's reply is ready to play.
 for(let i=0;i<3;i++)p.push(frame(.001),ctx());for(let i=0;i<6;i++)p.push(frame(.1),ctx());
 (h.voice as any).speechQueue.push('prepared reply');void (h.voice as any).flushLocal();for(let i=0;i<5;i++)await tick();
 assert.deepEqual(h.played,[],'output does not take the floor over undecided frames');
 await answer(s=>s>=3);assert.equal(p.collecting,true);assert.deepEqual(h.played,[],'the decided frames opened a turn, so output keeps waiting');
 for(let i=0;i<14;i++){p.push(frame(.001),ctx());await answer(s=>s>=3&&s<9);}
 assert.equal(h.transcripts.length,1);assert.equal(h.chats.length,1,'the user turn is submitted once');
 const samples=Buffer.from(h.transcripts[0].samples,'base64').length/4;assert.equal(samples,(3+6+14)*FRAME,'pre-roll, speech and pause, nothing dropped');
 assert.deepEqual(h.played,[],'still waiting for the submitted task');
 h.voice.announceResult('task result',h.chats[0].id);for(let i=0;i<5;i++)await tick();
 assert.deepEqual(h.played,['prepared reply','task result'],'the prepared reply plays once, after the turn');
 await h.voice.stop();
});

test('a long local turn is transcribed in parts and submitted once with vocabulary applied',async()=>{
 const h=voiceHarness();h.voice.applyListening(prefs({vocabulary:['Part']}));
 const p=(h.voice as any).listen(h.voice.generation) as ListeningPipeline;
 for(let i=0;i<260;i++)p.push(frame(.1),quiet);for(let i=0;i<14;i++)p.push(frame(.001),quiet);
 await tick();await tick();await tick();
 assert.equal(h.transcripts.length,2,'two recognizer-sized parts');assert.equal(h.chats.length,1,'one submission');
 assert.equal(h.chats[0].text,'Part 1 Part 2');
 await h.voice.stop();
});

const decode=(body:any)=>{const bytes=Buffer.from(body.samples,'base64');return new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);};
const notices=(events:any[])=>events.filter(e=>e.type==='notice').map(e=>e.text as string);

test('a continuous spoken request longer than 90 seconds is transcribed as it goes and submitted once after its final pause',async()=>{
 const h=voiceHarness();const p=(h.voice as any).listen(h.voice.generation) as ListeningPipeline;const input:Float32Array[]=[];
 // 100 seconds of uninterrupted speech arriving in real-time-sized batches, then the user's natural pause.
 for(let i=0;i<1000;i++){const f=tagged(.1,i);input.push(f);p.push(f,quiet);if(i%20===19)await tick();}
 await tick();
 assert.equal(h.chats.length,0,'nothing is executed before the final pause');assert.equal(h.transcripts.length,5,'each 20-second part was transcribed as it arrived');
 assert.equal(p.collecting,true,'one logical turn is still open');assert.equal((h.voice as any).turn.parts.length,0,'transcribed audio is released');
 for(let i=0;i<14;i++){const f=tagged(.001,i);input.push(f);p.push(f,quiet);}
 for(let i=0;i<5;i++)await tick();
 assert.equal(h.transcripts.length,6);assert.equal(h.chats.length,1,'exactly one submission');
 assert.equal(h.chats[0].text,'part 1 part 2 part 3 part 4 part 5 part 6','every part once, in order');
 const heard=h.transcripts.map(decode);assert.ok(heard.every(s=>s.length<=RECOGNIZER_MAX_SAMPLES));
 const joined=new Float32Array(heard.reduce((n,s)=>n+s.length,0));let o=0;for(const s of heard){joined.set(s,o);o+=s.length;}
 assert.equal(joined.length,input.length*FRAME,'no audio dropped or repeated');
 assert.equal(joined.findIndex((v,i)=>v!==input[Math.floor(i/FRAME)][i%FRAME]),-1,'every captured sample once, in capture order');
 assert.deepEqual(notices(h.events),[]);assert.equal(h.events.filter(e=>e.type==='userTranscript').length,1);
 await h.voice.stop();
});

test('a transcription backlog past its bound fails the turn explicitly, holds no more audio and submits nothing of it',async()=>{
 const stalled:ReturnType<typeof deferred<unknown>>[]=[];let stall=true;
 const h=voiceHarness(undefined,()=>{if(!stall)return {text:'turn the lights off'};const d=deferred<unknown>();stalled.push(d);return d.promise;});
 const p=(h.voice as any).listen(h.voice.generation) as ListeningPipeline;
 for(let i=0;i<800;i++){p.push(frame(.1),quiet);if(i%20===19)await tick();}
 assert.equal(stalled.length,1,'parts are transcribed one at a time');
 const turn=(h.voice as any).turn;assert.equal(turn.failure,'backlog');assert.equal(turn.parts.length,0,'queued audio was released');
 for(let i=0;i<200;i++){p.push(frame(.1),quiet);if(i%20===19)await tick();}// the user keeps going; nothing more is queued
 assert.equal(turn.parts.length,0);
 for(let i=0;i<14;i++)p.push(frame(.001),quiet);await tick();
 assert.equal(h.chats.length,0);assert.equal(notices(h.events).length,1);assert.match(notices(h.events)[0],/didn’t send any of it/);
 stall=false;for(const d of stalled)d.resolve({text:'late words'});for(let i=0;i<5;i++)await tick();
 assert.equal(h.chats.length,0,'a late transcript of the failed turn submits nothing');
 for(let i=0;i<6;i++)p.push(frame(.1),quiet);for(let i=0;i<14;i++)p.push(frame(.001),quiet);for(let i=0;i<5;i++)await tick();
 assert.equal(h.chats.length,1);assert.equal(h.chats[0].text,'turn the lights off','the next request is unaffected');
 await h.voice.stop();
});

test('too much text or the hard duration bound fails explicitly with what was heard and never submits a partial request',async()=>{
 const long=voiceHarness(undefined,()=>({text:'word '.repeat(1000)}));const lp=(long.voice as any).listen(long.voice.generation) as ListeningPipeline;
 for(let i=0;i<620;i++){lp.push(frame(.1),quiet);if(i%20===19)await tick();}for(let i=0;i<14;i++)lp.push(frame(.001),quiet);for(let i=0;i<5;i++)await tick();
 assert.equal(long.chats.length,0);assert.equal(long.transcripts.length,3,'the final part is not transcribed after the turn failed');
 assert.match(notices(long.events)[0],/too long to send as one/);
 const preview=long.events.filter(e=>e.type==='caption').at(-1).text as string;assert.ok(preview.startsWith('I heard: “word word'));assert.ok(preview.length<=220);
 // Five minutes without a pause: the turn fails at the bound while the user is still talking, and the rest is not a request.
 const h=voiceHarness();const p=(h.voice as any).listen(h.voice.generation) as ListeningPipeline;
 for(let i=0;i<3000;i++){p.push(frame(.1),quiet);if(i%20===19)await tick();}
 await tick();assert.equal(h.chats.length,0);assert.equal(notices(h.events).length,1);assert.match(notices(h.events)[0],/longer than I can take/);
 const transcribed=h.transcripts.length;assert.ok(transcribed>=14);
 for(let i=0;i<100;i++){p.push(frame(.1),quiet);if(i%20===19)await tick();}assert.equal(p.collecting,true);
 for(let i=0;i<14;i++)p.push(frame(.001),quiet);for(let i=0;i<5;i++)await tick();
 assert.equal(p.collecting,false);assert.equal(h.chats.length,0,'the tail after the bound never becomes its own request');assert.equal(h.transcripts.length,transcribed);
 for(let i=0;i<6;i++)p.push(frame(.1),quiet);for(let i=0;i<14;i++)p.push(frame(.001),quiet);for(let i=0;i<5;i++)await tick();
 assert.equal(h.chats.length,1,'a later request is heard normally');
 await long.voice.stop();await h.voice.stop();
});

/**
 * A room around the local voice owner: each 100 ms the paired worklet delivers what the microphone heard and what Capri
 * rendered. She renders only while the (fake) player is playing, so an interruption silences her reference; the room
 * keeps carrying her delayed echo. Generated audio only, no microphone or speaker.
 */
function voiceRoom(h:ReturnType<typeof voiceHarness>,initial:Path={taps:[[1800,.3],[1801,.15],[4000,.1]]}){
 const rendered=new Float32Array(16000*60),heard=new Float32Array(16000*60);let index=0;let path=initial;const noise=hiss(16000*60,.0008,11);
 const player=h.voice.player as any;player.tapped=true;
 const step=({capri,user,valid=true,packet=true}:{capri?:Float32Array;user?:Float32Array;valid?:boolean;packet?:boolean}={})=>{
  const reference=player.playing&&capri?capri.slice():new Float32Array(FRAME);rendered.set(reference,index);
  const mic=new Float32Array(FRAME),{taps,clip}=path;
  for(let i=0;i<FRAME;i++){let v=noise[index+i]+(user?.[i]??0);for(const [d,g] of taps){const j=index+i-d;if(j>=0)v+=g*rendered[j];}mic[i]=clip===undefined?v:Math.max(-clip,Math.min(clip,v));}
  heard.set(mic,index);
  (h.voice as any).capture(h.voice.generation,packet?{sequence:index/FRAME,startSample:index,sampleRate:16000,samples:mic,reference,referenceValid:valid}:mic);index+=FRAME;
 };
 return {step,heard,setPath(next:Path){path=next;},get frame(){return index/FRAME;}};
}
const slice=(source:Float32Array,f:number)=>source.subarray(f*FRAME,(f+1)*FRAME);

test('speech continuing from an open turn into playback interrupts Capri once and is submitted whole',async()=>{
 const h=voiceHarness();h.voice.applyListening(prefs({bargeIn:true}));(h.voice as any).listen(h.voice.generation);
 const room=voiceRoom(h),player=h.voice.player as any,capri=voiced(16000*6,CAPRI),user=voiced(16000*2,USER);
 try{
  player.playing=true;for(let f=0;f<12;f++)room.step({capri:slice(capri,f)});player.playing=false;// an earlier reply
  for(let f=0;f<10;f++)room.step();
  for(let f=0;f<5;f++)room.step({user:slice(user,f)});assert.equal(h.stops,0);// the user starts a request
  player.playing=true;for(let f=5;f<20;f++)room.step({capri:slice(capri,f+15),user:slice(user,f)});
  assert.equal(h.stops,1,'interrupted once');
  for(let f=0;f<20;f++)room.step();for(let i=0;i<5;i++)await tick();
  assert.equal(h.stops,1);assert.equal(h.chats.length,1);assert.equal(h.transcripts.length,1);
  const sent=decode(h.transcripts[0]);assert.equal(startFrame(room.heard,sent),19,'pre-roll first');assert.ok(sent.length>=(3+20)*FRAME,'every frame of the request');
 }finally{await h.voice.stop();}
});

test('pure echo never interrupts or reaches transcription; double talk interrupts once without replaying Capri and is sent once',async()=>{
 const h=voiceHarness();h.voice.applyListening(prefs({bargeIn:true}));(h.voice as any).speaking=true;(h.voice as any).speechQueue.push('queued reply');
 (h.voice as any).listen(h.voice.generation);const player=h.voice.player as any;player.playing=true;
 const capri=voiced(16000*20,CAPRI),user=voiced(16000*2,USER);
 try{
  // Quiet coupling, then her volume and the room's coupling rise and the speaker clips.
  const room=voiceRoom(h,{taps:[[2200,.008]]});for(let f=0;f<50;f++){room.step({capri:slice(capri,f)});if(f%10===9)await tick();}
  assert.equal(h.stops,0);
  const loud=new Float32Array(capri.length);for(let i=0;i<loud.length;i++)loud[i]=capri[i]*1.5;
  room.setPath({taps:[[2200,.4],[2600,.12],[6000,.06]],clip:.12});
  for(let f=50;f<100;f++)room.step({capri:slice(loud,f)});
  for(let i=0;i<5;i++)await tick();
  assert.equal(h.stops,0,'no interruption from echo');assert.deepEqual(h.transcripts,[]);assert.deepEqual(h.chats,[]);
  for(let f=0;f<20;f++)room.step({capri:slice(capri,100+f),user:slice(user,f)});
  assert.equal(h.stops,1);assert.deepEqual((h.voice as any).speechQueue,[],'interrupted speech is not queued again');
  for(let f=0;f<20;f++)room.step();for(let i=0;i<5;i++)await tick();
  assert.equal(h.chats.length,1);assert.equal(h.transcripts.length,1);assert.equal(h.stops,1);assert.deepEqual(h.played,[]);
 }finally{await h.voice.stop();}
});

test('playback outside the capture context, a privacy change, a detached reference and Stop leave the reference unknown',async()=>{
 const capri=voiced(16000*30,CAPRI),user=voiced(16000*3,{...USER,level:.25});
 // Control: in one continuous capture, loud talk over Capri after her reference has explained the room interrupts her.
 const c=voiceHarness();c.voice.applyListening(prefs({bargeIn:true}));(c.voice as any).listen(c.voice.generation);
 try{const room=voiceRoom(c);(c.voice.player as any).playing=true;for(let f=0;f<30;f++)room.step({capri:slice(capri,f)});for(let f=0;f<20;f++)room.step({capri:slice(capri,30+f),user:slice(user,f)});assert.equal(c.stops,1);}
 finally{await c.voice.stop();}
 // Untapped playback (rendered in another context): loud talk over Capri never interrupts and is not a request.
 const a=voiceHarness();a.voice.applyListening(prefs({bargeIn:true}));(a.voice as any).listen(a.voice.generation);
 try{
  const room=voiceRoom(a);const player=a.voice.player as any;player.playing=true;player.tapped=false;
  for(let f=0;f<30;f++)room.step({capri:slice(capri,f)});for(let f=0;f<20;f++)room.step({capri:slice(capri,30+f),user:slice(user,f)});
  assert.equal(a.stops,0);player.playing=false;for(let f=0;f<20;f++)room.step();for(let i=0;i<5;i++)await tick();
  assert.deepEqual(a.chats,[]);assert.deepEqual(a.transcripts,[]);
 }finally{await a.voice.stop();}
 // A privacy change starts a fresh capture pipeline: what the old one learned about the room and its reference is gone.
 const b=voiceHarness();let privateMode=false;(b.voice as any).isPrivate=()=>privateMode;b.voice.applyListening(prefs({bargeIn:true}));(b.voice as any).listen(b.voice.generation);
 try{
  const room=voiceRoom(b);const player=b.voice.player as any;player.playing=true;const before=(b.voice as any).pipeline;
  for(let f=0;f<30;f++)room.step({capri:slice(capri,f)});
  privateMode=true;for(let f=0;f<20;f++)room.step({capri:slice(capri,30+f),user:slice(user,f)});
  assert.notEqual((b.voice as any).pipeline,before);assert.equal(b.stops,0,'no interruption from a reference the new pipeline has not verified');
  // The reference detaches (unpaired packets) while she keeps talking.
  for(let f=0;f<20;f++)room.step({capri:slice(capri,50+f),user:slice(user,f),packet:false});assert.equal(b.stops,0);
  player.playing=false;for(let f=0;f<20;f++)room.step();for(let i=0;i<5;i++)await tick();assert.deepEqual(b.chats,[]);
  await b.voice.stop();
  // After Stop, late packets from the old capture change nothing.
  for(let f=0;f<20;f++)room.step({user:slice(user,f)});for(let i=0;i<5;i++)await tick();
  assert.deepEqual(b.transcripts,[]);assert.deepEqual(b.chats,[]);assert.equal((b.voice as any).pipeline,undefined);
 }finally{await b.voice.stop();}
});

test('both ends of the sensitivity slider keep detector silence as silence and let pauses finish the request',async()=>{
 assert.equal(probabilityThreshold(.5),.5,'the default is unchanged');assert.equal(probabilityThreshold(0),.1);assert.ok(Math.abs(probabilityThreshold(1)-.9)<1e-12);
 assert.equal(probabilityThreshold(NaN),.5);
 // Slider 100 (threshold 0) and slider 0 (threshold 1). Every frame is far below the energy threshold, so only the
 // detector's answers decide.
 for(const [vadThreshold,heard,ignored] of [[0,.15,.05],[1,.95,.85]] as const){
  // Pauses answered {speech:false, probability:0} finish the request at either end instead of running into the bound.
  const s=pipeline({enabled:true,vadThreshold},{detect:async body=>{const v=decode(body)[0];return {available:true,speech:v>.0015,probability:v>.0015?.99:0,sequence:body.sequence};}});
  for(let i=0;i<3;i++){s.p.push(frame(.001),quiet);await tick();}for(let i=0;i<6;i++){s.p.push(frame(.002),quiet);await tick();}
  for(let i=0;i<20&&!turns(s.segments).length;i++){s.p.push(frame(.001),quiet);await tick();}
  assert.equal(turns(s.segments).length,1,'threshold '+vadThreshold+': silence ends the request');assert.equal(s.p.collecting,false);assert.equal(s.segments.filter(e=>e.overflow).length,0);
  assert.equal(turns(s.segments)[0].chunk!.length,(3+6+14)*FRAME);
  // The slider still has an effect: a borderline probability is speech at one end and silence at the other.
  const edge=pipeline({enabled:true,vadThreshold},{detect:async body=>({available:true,speech:false,probability:vadThreshold===0?heard:ignored,sequence:body.sequence})});
  for(let i=0;i<6;i++){edge.p.push(frame(.001),quiet);await tick();}assert.equal(edge.p.collecting,vadThreshold===0,'threshold '+vadThreshold);
  const low=pipeline({enabled:true,vadThreshold},{detect:async body=>({available:true,speech:true,probability:vadThreshold===0?ignored:heard,sequence:body.sequence})});
  for(let i=0;i<6;i++){low.p.push(frame(.001),quiet);await tick();}assert.equal(low.p.collecting,vadThreshold===1,'threshold '+vadThreshold+' probability decides over the flag');
  s.p.close();edge.p.close();low.p.close();
 }
});

test('stopping voice discards an unfinished turn and late frames from the old capture',async()=>{
 const h=voiceHarness();h.voice.applyListening(prefs({enabled:true}));
 const p=(h.voice as any).listen(h.voice.generation) as ListeningPipeline;
 for(let i=0;i<10;i++)p.push(frame(.1),quiet);await tick();
 await h.voice.stop();
 for(let i=0;i<20;i++)p.push(frame(.001),quiet);await tick();
 assert.deepEqual(h.transcripts,[]);assert.deepEqual(h.chats,[]);
 assert.ok(h.detects.length>=1&&h.detects.every(d=>d.sessionId===h.detects[0].sessionId));
});

const zeroed=(samples:Float32Array)=>samples.every(v=>v===0);
test('close wipes queued, partial, pre-roll, candidate, turn and reference audio while detector requests are unresolved',async()=>{
 // Detector mode: an open turn, playback frames still with the detector and a partly filled frame captured during playback.
 const d=heldDetector();const t=pipeline({enabled:true,bargeIn:true},{detect:d.detect,maxPending:100,maxInflight:100});
 for(let i=0;i<3;i++)t.p.push(frame(.001),quiet);for(let i=0;i<6;i++)t.p.push(frame(.1),quiet);await d.answer();assert.equal(t.p.collecting,true);
 // Enough playback for the 2.1 s reference window to be fully known, so the last frames hold capture-time windows.
 const capri=voiced(16000*3,CAPRI),played=25;
 for(let f=0;f<played;f++)t.p.push(frame(.1),{outputActive:true,reference:{startSample:f*FRAME,samples:slice(capri,f).slice(),valid:true,epoch:1}});
 t.p.push(frame(.1,800),{outputActive:true,reference:{startSample:played*FRAME,samples:capri.slice(played*FRAME,played*FRAME+800),valid:true,epoch:1}});
 const p=t.p as any,queued=[...p.queue] as {samples:Float32Array;window?:Float32Array}[],turn=[...p.turns.frames] as {samples:Float32Array}[];
 assert.equal(queued.length,played);assert.equal(d.held.length,played,'their detector requests are unresolved');assert.ok(queued.some(f=>f.window));
 assert.ok(!zeroed(p.partial)&&p.filled===800&&p.partialOutput);assert.ok(!zeroed(p.history));assert.ok(turn.length>0);
 t.p.close();
 assert.ok(queued.every(f=>zeroed(f.samples)&&!f.window),'queued frames referenced by pending requests are zeroed');
 assert.ok(zeroed(p.partial));assert.deepEqual([p.filled,p.partialOutput,p.partialCalibration,p.partialExcluded],[0,false,undefined,false]);
 assert.ok(zeroed(p.history),'the reference is cleared');assert.ok(turn.every(f=>zeroed(f.samples)),'the open turn is zeroed');
 assert.deepEqual([p.queue.length,p.candidate.length,p.quiet.length,p.turns.frames.length,p.turns.before.length],[0,0,0,0,0]);
 // The transport answers later with speech: nothing is decided or emitted.
 const segments=t.segments.length;for(const r of d.held.splice(0))r.reply.resolve({available:true,speech:true,sequence:r.body.sequence});await tick();
 assert.equal(t.segments.length,segments);assert.equal(t.timers.size,0);
 // Energy mode with barge-in: quiet pre-roll and an unconfirmed candidate held over Capri (headphones), and calibration tags.
 const e=pipeline({bargeIn:true});const user=voiced(4800,USER),ref=voiced(16000*2,CAPRI);
 for(let f=0;f<12;f++)e.p.push(f<10?hiss(FRAME,.0008,f):user.slice((f-10)*FRAME,(f-9)*FRAME),{outputActive:true,reference:{startSample:f*FRAME,samples:slice(ref,f).slice(),valid:true,epoch:1}});
 const q=e.p as any,held=[...q.quiet,...q.candidate] as {samples:Float32Array}[];assert.ok(q.quiet.length>0&&q.candidate.length>0,'pre-roll and candidate are held');
 const calibration=e.p.calibrate(5);e.p.push(frame(.002,700),quiet);assert.ok(q.partialCalibration);
 const pre=[...q.quiet,...q.candidate] as {samples:Float32Array}[];
 e.p.close();await assert.rejects(calibration,/stopped/);
 assert.ok(pre.every(f=>zeroed(f.samples)));assert.ok(zeroed(q.partial));assert.equal(q.partialCalibration,undefined);assert.ok(zeroed(q.history));
 assert.ok(held.length>0);assert.equal(e.bargeIns,0);assert.deepEqual(turns(e.segments),[]);
});

test('Stop and privacy changes wipe the old capture pipeline while its detector requests are still pending',async()=>{
 const d=heldDetector();const h=voiceHarness(d.detect);let privateMode=false;(h.voice as any).isPrivate=()=>privateMode;
 h.voice.applyListening(prefs({enabled:true,bargeIn:true}));(h.voice as any).listen(h.voice.generation);
 const capture=(f:Float32Array)=>(h.voice as any).capture(h.voice.generation,f);
 const fill=()=>{for(let i=0;i<4;i++)capture(frame(.1));capture(frame(.1,900));};
 const inspect=(p:any)=>({queued:[...p.queue] as {samples:Float32Array}[],partial:p.partial as Float32Array});
 try{
  fill();await until(()=>d.held.length===3);const first=(h.voice as any).pipeline,before=inspect(first);
  assert.equal(before.queued.length,4);assert.ok(!zeroed(before.partial));assert.equal(d.held.length,3,'bounded detector work is pending');
  privateMode=true;capture(frame(.1));
  assert.notEqual((h.voice as any).pipeline,first);
  assert.ok(before.queued.every(f=>zeroed(f.samples))&&zeroed(before.partial),'the privacy change wiped the old capture');
  // The old transports settle (late speech claims change nothing) and free the shared slots for the new capture.
  await d.answer();assert.deepEqual(h.transcripts,[]);
  fill();const second=(h.voice as any).pipeline,after=inspect(second);assert.ok(after.queued.length>0&&!zeroed(after.partial));
  await h.voice.stop();
  assert.ok(after.queued.every(f=>zeroed(f.samples))&&zeroed(after.partial),'Stop wiped the current capture');assert.equal((h.voice as any).pipeline,undefined);
  await d.answer();assert.deepEqual(h.transcripts,[]);assert.deepEqual(h.chats,[]);
 }finally{await h.voice.stop();}
});

test('diagnostics are opt-in, bounded, numeric and never recorded in private sessions',async()=>{
 const diagnostics=new ListeningDiagnostics();for(let i=0;i<100;i++)diagnostics.record({at:i,kind:'turn',durationMs:i});
 const snap=diagnostics.snapshot();assert.equal(snap.entries.length,40);assert.equal(snap.counts.turn,100);
 let privateMode=true;(globalThis as any).window={capri:{request:async(_m:string,route:string)=>route==='/v1/voice/local/transcribe'?{text:''}:{}}};
 const voice=new Voice(()=>{},()=>privateMode,true);voice.player={playing:false,play:async()=>{},stop:()=>{}} as any;voice.active=true;voice.localMode=true;
 voice.applyListening(prefs({diagnostics:true}));(voice as any).listen(voice.generation);
 // Through the capture path, so the session started in private mode is re-fenced when privacy changes.
 const capture=(f:Float32Array)=>(voice as any).capture(voice.generation,f);
 const turn=()=>{for(let i=0;i<4;i++)capture(frame(.1));for(let i=0;i<14;i++)capture(frame(.001));};
 turn();assert.deepEqual(voice.listeningDiagnostics().entries,[]);
 privateMode=false;turn();const entries=voice.listeningDiagnostics().entries;assert.ok(entries.length>0);
 for(const e of entries)assert.deepEqual(Object.keys(e).filter(k=>!['at','kind','durationMs','frames','noiseFloor','detector','reason'].includes(k)),[]);
 voice.applyListening(prefs({diagnostics:false}));assert.deepEqual(voice.listeningDiagnostics().entries,[]);
 await voice.stop();
});

test('preferences are bounded, local only, and malformed storage is not overwritten',()=>{
 const stored=new Map<string,string>();const store={getItem:(k:string)=>stored.get(k)??null,setItem:(k:string,v:string)=>{stored.set(k,v);}};
 assert.deepEqual(loadListeningPreferences(store),defaultListeningPreferences());
 stored.set('capri-listening','{not json');assert.deepEqual(loadListeningPreferences(store),defaultListeningPreferences());assert.equal(stored.get('capri-listening'),'{not json');
 const saved=saveListeningPreferences({...defaultListeningPreferences(),vadThreshold:7,silenceMs:20,noiseFloor:9,enabled:true,vocabulary:Array(80).fill(0).map((_,i)=>'Name'+i)},store);
 assert.equal(saved.vadThreshold,1);assert.equal(saved.silenceMs,200);assert.equal(saved.noiseFloor,.05);assert.equal(saved.vocabulary.length,50);
 assert.deepEqual(loadListeningPreferences(store),saved);
 assert.deepEqual(normalizeListeningPreferences({enabled:'yes',localOnly:false,approved:true}),defaultListeningPreferences());
 assert.deepEqual(toListeningSettings(saved),{enabled:true,mode:'wake',localOnly:true,noiseSuppression:true,vadThreshold:1,silenceMs:200});
 assert.equal((microphoneOptions('',{noiseSuppression:false}).audio as MediaTrackConstraints).echoCancellation,true);
 assert.equal((microphoneOptions('',{noiseSuppression:false}).audio as MediaTrackConstraints).noiseSuppression,false);
});

test('clearing calibration removes the stored noise floor and it stays cleared after reload',()=>{
 const stored=new Map<string,string>();const store={getItem:(k:string)=>stored.get(k)??null,setItem:(k:string,v:string)=>{stored.set(k,v);}};
 updateListeningPreferences({noiseFloor:.004,bargeIn:true},store);assert.equal(loadListeningPreferences(store).noiseFloor,.004);
 const cleared=clearListeningCalibration(store);assert.equal(cleared.noiseFloor,undefined);assert.equal(cleared.bargeIn,true,'other preferences are kept');
 assert.equal('noiseFloor' in JSON.parse(stored.get('capri-listening')!),false);
 updateListeningPreferences({silenceMs:2000},store);
 const reloaded=loadListeningPreferences(store);assert.equal(reloaded.noiseFloor,undefined,'a later change does not bring it back');assert.equal(reloaded.silenceMs,2000);
});

/** Steady generated room noise around RMS 0.01: above the default uncalibrated energy threshold of 0.006. */
const ambient=(i:number)=>frame(.0098+(i%5)*.0001);

test('calibration recovers from steady ambient noise above the default threshold and drops the turn the noise opened',async()=>{
 const t=pipeline();assert.ok(speechThreshold(.002)<.0098,'the default threshold treats this room as speech');
 for(let i=0;i<40;i++)t.p.push(ambient(i),quiet);
 assert.equal(t.p.collecting,true,'the uncalibrated segmenter is stuck in an endless turn on room noise');
 const measured=t.p.calibrate();
 assert.equal(t.p.collecting,false,'the noise turn is dropped when calibration starts');assert.equal(t.p.status().calibrating,true);
 assert.deepEqual(t.segments,[{final:true,discarded:true,cancelled:true,turnSamples:0}],'cancelled, never a submittable turn');
 for(let i=0;i<15;i++)t.p.push(ambient(i),quiet);
 const floor=await measured;assert.ok(floor>=.0098&&floor<=.0102,'the median room level: '+floor);
 assert.deepEqual(t.p.status(),{...t.p.status(),calibrated:true,calibrating:false,collecting:false});
 assert.ok(speechThreshold(floor,.5,floor)>.0102,'the calibrated threshold is above the room');
 for(let i=0;i<60;i++)t.p.push(ambient(i),quiet);
 assert.equal(t.p.collecting,false,'the room no longer opens turns');assert.equal(turns(t.segments).length,0);
 // Normal speech afterwards: one turn with its room-noise pre-roll and pause, nothing from calibration.
 for(let i=0;i<6;i++)t.p.push(tagged(.1,i),quiet);for(let i=0;i<14;i++)t.p.push(ambient(i),quiet);
 const [turn]=turns(t.segments);assert.ok(turn?.chunk);assert.equal(turns(t.segments).length,1);
 assert.equal(turn.chunk.length,(3+6+14)*FRAME);assert.equal(turn.chunk[3*FRAME],Math.fround(.1));
 assert.ok(t.diagnostics.some(d=>d.kind==='calibrated'));
});

test('calibration fails explicitly on speech, a room too loud or no level, and never segments what it measured',async()=>{
 const t=pipeline();
 const speech=t.p.calibrate();for(let i=0;i<10;i++)t.p.push(frame(.004),quiet);for(let i=0;i<5;i++)t.p.push(frame(.1),quiet);
 await assert.rejects(speech,/speech or sudden sounds/);assert.equal(t.p.status().calibrated,false);assert.equal(t.p.status().calibrating,false);
 assert.deepEqual(t.segments,[],'speech heard while calibrating is not a request');
 const loud=t.p.calibrate();for(let i=0;i<15;i++)t.p.push(frame(.08),quiet);await assert.rejects(loud,/too loud/);
 const broken=t.p.calibrate();t.p.push(frame(NaN),quiet);await assert.rejects(broken,/could not read/);
 // Capri's own output is never measured; frames during playback do not count toward the measurement.
 // Nor are the two seconds after it without a playback reference, while its echo could still arrive.
 const echo=t.p.calibrate(5);for(let i=0;i<10;i++)t.p.push(frame(.3),{outputActive:true,outputLevel:.2});assert.equal(t.p.status().calibrating,true);
 for(let i=0;i<20;i++)t.p.push(frame(.05),quiet);assert.equal(t.p.status().calibrating,true,'the echo window is not measured');
 for(let i=0;i<5;i++)t.p.push(frame(.003),quiet);assert.ok(Math.abs(await echo-.003)<1e-6);
 assert.deepEqual(t.segments,[],'no turn from any calibration audio');assert.equal(t.bargeIns,0);
 // Frames captured before calibration started are dropped, not measured.
 const det=pipeline({enabled:true},{detect:body=>new Promise(r=>setTimeout(()=>r({available:true,speech:false,sequence:body.sequence}),0))});
 det.p.push(frame(.2),quiet);const early=det.p.calibrate(5);for(let i=0;i<5;i++)det.p.push(frame(.002),quiet);
 for(let i=0;i<5;i++)await new Promise(r=>setTimeout(r,1));assert.ok(Math.abs(await early-.002)<1e-6);
});

test('calibrating local voice from steady noise sends nothing from the noise or the calibration, then hears the next request',async()=>{
 const h=voiceHarness();const capture=(f:Float32Array)=>(h.voice as any).capture(h.voice.generation,f);(h.voice as any).listen(h.voice.generation);
 // More than one recognizer-sized part of room noise: the uncalibrated turn already sent a part for transcription.
 for(let i=0;i<220;i++){capture(ambient(i));if(i%20===19)await tick();}
 await tick();assert.equal(h.transcripts.length,1);assert.ok((h.voice as any).turn,'an open noise turn');
 const measured=h.voice.calibrateListening();assert.equal((h.voice as any).turn,undefined,'the noise turn is cancelled');
 for(let i=0;i<20;i++)capture(ambient(i));const floor=await measured;assert.ok(floor>.009&&floor<.011);
 for(let i=0;i<40;i++)capture(ambient(i));for(let i=0;i<5;i++)await tick();
 assert.equal(h.chats.length,0,'neither the noise nor the calibration audio became a request');assert.equal(h.transcripts.length,1);
 assert.deepEqual(notices(h.events),[]);assert.equal(h.events.filter(e=>e.type==='userTranscript').length,0);
 for(let i=0;i<6;i++)capture(frame(.1));for(let i=0;i<14;i++)capture(ambient(i));for(let i=0;i<5;i++)await tick();
 assert.equal(h.chats.length,1,'one request');assert.equal(h.chats[0].text,'part 2','only the new speech was transcribed and sent');
 assert.equal(decode(h.transcripts[1]).length,(3+6+14)*FRAME);
 await h.voice.stop();
});

/** A held fake detector answering by level; `reverse` answers each batch out of order. Generated audio only. */
function heldDetector(){
 const held:{body:VadRequest;reply:ReturnType<typeof deferred<unknown>>}[]=[];
 const detect=(body:VadRequest)=>{const reply=deferred<unknown>();held.push({body,reply});return reply.promise;};
 const answer=async(reverse=true)=>{for(let i=0;i<60;i++){const batch=held.splice(0);if(reverse)batch.reverse();for(const r of batch)r.reply.resolve({available:true,speech:decode(r.body).some(v=>Math.abs(v)>.05),sequence:r.body.sequence});await tick();}};
 return {held,detect,answer};
}
/** Calibration speech and pre-calibration speech are marked by a level no genuine request uses. */
const MARK=Math.fround(.3);const marked=(chunk?:Float32Array)=>!!chunk&&chunk.some(v=>v===MARK);

test('calibration audio is tagged when captured, so out-of-order detector answers after calibration never segment it',async()=>{
 const d=heldDetector();const t=pipeline({enabled:true},{detect:d.detect,maxPending:100});
 t.p.push(frame(.3,800),quiet);// pre-calibration speech in the frame being filled
 const measured=t.p.calibrate(5);
 t.p.push(frame(.002,800),quiet);// completes the frame straddling the start: neither measured nor segmented
 for(let i=0;i<5;i++)t.p.push(frame(.002),quiet);// the measurement
 for(let i=0;i<6;i++)t.p.push(frame(.3),quiet);for(let i=0;i<14;i++)t.p.push(frame(.002),quiet);// speech and a pause captured while calibrating
 t.p.push(frame(.3,800),quiet);// calibration speech in the frame being filled when it ends
 assert.equal(t.p.status().calibrating,true,'nothing decided yet');assert.ok(t.p.pending>20);
 await d.answer();
 assert.ok(Math.abs(await measured-.002)<1e-6,'only the five measurement frames were measured');
 assert.equal(t.p.pending,0);assert.deepEqual(t.segments,[],'queued calibration speech decided after calibration ended is dropped');
 assert.equal(t.p.collecting,false);assert.equal(t.bargeIns,0);
 // The first genuine utterance completes the straddling frame (dropped) and is then one turn without calibration audio.
 for(let i=0;i<6;i++)t.p.push(frame(.1),quiet);for(let i=0;i<20;i++)t.p.push(frame(.002),quiet);
 await d.answer();
 const done=turns(t.segments);assert.equal(done.length,1,'exactly one turn');assert.equal((t.segments as SegmentEvent[]).filter(s=>s.final).length,1);
 assert.equal(marked(done[0].chunk),false,'no calibration or pre-calibration audio');
 assert.equal(done[0].chunk!.filter(v=>v===Math.fround(.1)).length,5*FRAME+800,'genuine speech after the dropped boundary frame is kept whole');
});

test('calibration audio still queued when calibration fails or times out is dropped, and the next utterance is one turn',async()=>{
 // Failure: speech during the measurement fails it while more calibration speech still waits for the detector.
 const d=heldDetector();const t=pipeline({enabled:true},{detect:d.detect,maxPending:100});
 const failed=t.p.calibrate(5);for(let i=0;i<3;i++)t.p.push(frame(.002),quiet);for(let i=0;i<8;i++)t.p.push(frame(.3),quiet);
 for(let i=0;i<14;i++)t.p.push(frame(.002),quiet);t.p.push(frame(.3,500),quiet);
 const rejected=assert.rejects(failed,/speech or sudden sounds/);await d.answer();await rejected;
 assert.deepEqual(t.segments,[]);assert.equal(t.p.pending,0);
 for(let i=0;i<6;i++)t.p.push(frame(.1),quiet);for(let i=0;i<20;i++)t.p.push(frame(.002),quiet);await d.answer();
 assert.equal(turns(t.segments).length,1);assert.equal(marked(turns(t.segments)[0].chunk),false);
 // Timeout: only the calibration timer fires; every frame captured before it is still with the detector.
 const timers:{run:()=>void;ms:number}[]=[];const schedule=(run:()=>void,ms:number)=>{const e={run,ms};timers.push(e);return ()=>{const i=timers.indexOf(e);if(i>=0)timers.splice(i,1);};};
 const e=heldDetector();const late=pipeline({enabled:true},{detect:e.detect,maxPending:100,schedule});
 const expired=late.p.calibrate(5);for(let i=0;i<4;i++)late.p.push(frame(.3),quiet);for(let i=0;i<14;i++)late.p.push(frame(.002),quiet);late.p.push(frame(.3,900),quiet);
 const timedOut=assert.rejects(expired,/quiet/);timers.filter(x=>x.ms===10000).forEach(x=>x.run());await timedOut;assert.equal(late.p.status().calibrating,false);
 await e.answer();assert.deepEqual(late.segments,[],'calibration speech answered after the timeout is not a turn');
 for(let i=0;i<6;i++)late.p.push(frame(.1),quiet);for(let i=0;i<20;i++)late.p.push(frame(.002),quiet);await e.answer();
 assert.equal(turns(late.segments).length,1);assert.equal(marked(turns(late.segments)[0].chunk),false);
});

test('local voice never transcribes or sends calibration speech answered late, and submits the next request once',async()=>{
 const d=heldDetector();const h=voiceHarness(d.detect);h.voice.applyListening(prefs({enabled:true}));
 const p=(h.voice as any).listen(h.voice.generation) as ListeningPipeline;
 const measured=h.voice.calibrateListening();void measured.catch(()=>{});
 for(let i=0;i<14;i++){p.push(frame(.002),quiet);if(i%7===6)await d.answer();}assert.equal(p.status().calibrating,true);
 // The fifteenth measurement frame and the user's speech are captured together; the speech is answered first.
 p.push(frame(.002),quiet);for(let i=0;i<6;i++)p.push(frame(.3),quiet);for(let i=0;i<4;i++)p.push(frame(.002),quiet);
 assert.equal(p.status().detector,'model','within the backlog bound, so the detector decides every frame');
 await d.answer();assert.ok(Math.abs(await measured-.002)<1e-6);
 for(let i=0;i<20;i++){p.push(frame(.002),quiet);await d.answer();}
 assert.equal(p.status().detector,'model');
 assert.equal(h.transcripts.length,0,'no calibration audio reached the recognizer');assert.equal(h.chats.length,0);
 for(let i=0;i<6;i++)p.push(frame(.1),quiet);await d.answer();for(let i=0;i<20;i++){p.push(frame(.002),quiet);await d.answer();}
 assert.equal(h.chats.length,1,'the first genuine request is submitted exactly once');assert.equal(h.transcripts.length,1);
 assert.equal(marked(decode(h.transcripts[0])),false);assert.equal(decode(h.transcripts[0]).filter(v=>v===Math.fround(.1)).length,6*FRAME);
 assert.deepEqual(notices(h.events),[]);
 await h.voice.stop();
});

test('detector slots stay globally bounded across repeated toggles, timeouts and closed pipelines until transports settle',async()=>{
 const slots=new DetectorSlots(3);const held:{body:VadRequest;signal:AbortSignal;reply:ReturnType<typeof deferred<unknown>>}[]=[];
 // A transport that ignores cancellation: its promises stay unresolved until the test settles them.
 const detect=(body:VadRequest,signal:AbortSignal)=>{const reply=deferred<unknown>();held.push({body,signal,reply});return reply.promise;};
 const t=pipeline({enabled:true},{slots,detect});
 for(let i=0;i<3;i++)t.p.push(frame(.001),quiet);assert.equal(held.length,3);assert.equal(slots.active,3);
 for(let round=0;round<10;round++){
  t.p.configure(prefs({enabled:false}));t.p.configure(prefs({enabled:true}));
  for(let i=0;i<3;i++){t.p.push(frame(.001),quiet);assert.ok(slots.active<=slots.limit);}
  assert.equal(held.length,3,'no new launch while abandoned requests hold every slot (round '+round+')');
  assert.equal(t.p.pending,0,'waiting frames are decided by energy instead');assert.deepEqual(t.p.status(),{...t.p.status(),detector:'energy',reason:'busy'});
 }
 assert.ok(held.every(r=>r.signal.aborted),'abandoned requests were actually aborted');
 // Timeouts and closed pipelines do not free slots either; a new capture session shares the same bound.
 t.timers.fire();t.p.close();
 const next=pipeline({enabled:true},{slots,detect,sessionId:'session-2'});
 for(let i=0;i<5;i++)next.p.push(frame(.001),quiet);
 assert.equal(held.length,3);assert.equal(slots.active,3);assert.equal(next.p.pending,0);
 // The old transports finally answer (late speech claims): nothing changes, and the slots are free again.
 for(const r of held)r.reply.resolve({available:true,speech:true,sequence:r.body.sequence});await tick();
 assert.equal(slots.active,0);assert.equal(t.segments.length,0);assert.equal(next.p.collecting,false,'late answers decide nothing');
 next.p.push(frame(.001),quiet);
 assert.equal(held.length,4);assert.deepEqual([held[3].body.sessionId,held[3].body.sequence,held[3].body.reset],['session-2',5,true],'a clean new epoch resets the model');
 held[3].reply.resolve({available:true,speech:true,sequence:5});await tick();
 assert.equal(next.p.collecting,true,'the detector decides again');assert.equal(next.p.status().detector,'model');
 assert.equal(slots.active,0,'each slot is released exactly once');
 next.p.close();await tick();
 // A transport that honours cancellation releases its slots as soon as the epoch ends.
 const honour=new DetectorSlots(2);let launched=0;
 const h=pipeline({enabled:true},{slots:honour,detect:(_body,signal)=>{launched++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))));}});
 h.p.push(frame(.001),quiet);h.p.push(frame(.001),quiet);assert.equal(honour.active,2);
 h.p.configure(prefs({enabled:false}));await tick();assert.equal(honour.active,0,'aborted transports settled');
 h.p.configure(prefs({enabled:true}));h.p.push(frame(.001),quiet);assert.equal(launched,3);assert.equal(honour.active,1);
 h.p.close();await tick();assert.equal(honour.active,0,'close aborts and settles');
});

test('repeated privacy changes in local voice keep one bound on detector work across capture pipelines',async()=>{
 const held:{body:any;reply:ReturnType<typeof deferred<unknown>>}[]=[];
 const h=voiceHarness(body=>{const reply=deferred<unknown>();held.push({body,reply});return reply.promise;});
 let privateMode=false;(h.voice as any).isPrivate=()=>privateMode;h.voice.applyListening(prefs({enabled:true}));(h.voice as any).listen(h.voice.generation);
 const capture=(f:Float32Array)=>(h.voice as any).capture(h.voice.generation,f);const slots=(h.voice as any).detectorSlots as DetectorSlots;
 for(let i=0;i<3;i++)capture(frame(.001));await until(()=>held.length===3);
 for(let round=0;round<12;round++){privateMode=!privateMode;for(let i=0;i<4;i++)capture(frame(.001));assert.ok(slots.active<=slots.limit);}
 assert.equal(held.length,slots.limit,'only the first requests were ever launched');assert.equal(new Set(held.map(r=>r.body.sessionId)).size,1);
 for(const r of held)r.reply.resolve({available:true,speech:true,sequence:r.body.sequence});await tick();assert.equal(slots.active,0);
 capture(frame(.001));await until(()=>held.length===4);const last=held.at(-1)!;assert.equal(held.length,4);assert.notEqual(last.body.sessionId,held[0].body.sessionId);assert.equal(last.body.reset,true);
 last.reply.resolve({available:true,speech:false,sequence:last.body.sequence});await tick();
 assert.deepEqual(h.chats,[]);await h.voice.stop();await tick();assert.equal(slots.active,0);
});

test('vocabulary is bounded text and corrects only close matches',()=>{
 assert.deepEqual(normalizeVocabulary('Capri, capri\nNight City;<script>x</script>; '),['Capri','Night City','scriptxscript']);
 assert.equal(applyVocabulary('call capri about night   city',['Capri','Night City']),'call Capri about Night City');
 assert.equal(applyVocabulary('tell Marrisol and Maria',['Marisol']),'tell Marisol and Maria');
 assert.equal(applyVocabulary('a cat sat',['Catalina']),'a cat sat');
 assert.equal(applyVocabulary('hello',[]),'hello');
});
