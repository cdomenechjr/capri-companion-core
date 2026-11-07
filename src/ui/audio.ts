import { audioDeviceId } from './audio-devices';
import { TurnSegmenter, rms, speechThreshold } from './listening';
export { encodePcm, rms } from './listening';
/** Echo cancellation always stays on for the selected device; noise suppression is a listening preference. */
export function microphoneOptions(id='',{noiseSuppression=true}:{noiseSuppression?:boolean}={}):MediaStreamConstraints{return {audio:{...(id?{deviceId:{exact:id}}:{}),echoCancellation:true,noiseSuppression,autoGainControl:true},video:false};}
export async function captureMicrophone(id='',options:{noiseSuppression?:boolean}={}){return navigator.mediaDevices.getUserMedia(microphoneOptions(await audioDeviceId(id,'audioinput'),options));}
/** Energy-only segmenter with the original thresholds. Returns each recognizer-sized part; long turns continue without truncation. */
export class UtteranceSegmenter {
 private turns=new TurnSegmenter({silenceSamples:22400,preRollSamples:4800});private noise=.002;private ready:Float32Array[]=[];
 get collecting(){return this.turns.collecting;}
 reset(){this.turns.reset();this.ready=[];}
 push(samples:Float32Array):Float32Array|undefined{
  const level=rms(samples);const talking=level>speechThreshold(this.noise);
  if(!this.turns.collecting&&!talking)this.noise=this.noise*.95+level*.05;
  for(const event of this.turns.push(samples,talking,level))if(event.chunk)this.ready.push(event.chunk);
  return this.ready.shift();
 }
}
async function sink(context:AudioContext,id:string){if(!id)return;const audio=context as AudioContext&{setSinkId?:(id:string)=>Promise<void>};if(!audio.setSinkId)throw Error('Output selection is unavailable in this browser. Use the Capri Windows app.');await audio.setSinkId(await audioDeviceId(id,'audiooutput'));}
export const virtualAudioDevice=(name:string)=>/cable|voicemeeter|virtual|vb-audio|voicemod|sonar|wave link|loopback/i.test(name);

/** The call bus is opt-in each launch and never changes a call app's settings. */
export class CallMixer {
 context?:AudioContext;stream?:MediaStream;outputId='';private mix?:GainNode;private remote?:MediaStreamAudioSourceNode;private voices=new Set<AudioBufferSourceNode>();private generation=0;
 get active(){return !!this.context;}
 async start(microphoneId:string,outputId:string){
  await this.stop();const generation=this.generation;if(!outputId||outputId==='default')throw Error('Choose a virtual audio output for the shared microphone profile.');
  const stream=await captureMicrophone(microphoneId);if(generation!==this.generation){stream.getTracks().forEach(t=>t.stop());return;}
  try{const devices=await navigator.mediaDevices.enumerateDevices();const resolved=await audioDeviceId(outputId,'audiooutput');if(generation!==this.generation){stream.getTracks().forEach(t=>t.stop());return;}const selected=devices.find(d=>d.deviceId===resolved&&d.kind==='audiooutput');if(!selected||!virtualAudioDevice(selected.label))throw Error('Choose a virtual cable or virtual mixer output, not your physical speakers.');
   const context=new AudioContext();this.context=context;this.stream=stream;await sink(context,outputId);await context.resume();this.outputId=outputId;this.mix=context.createGain();this.mix.gain.value=.8;const compressor=context.createDynamicsCompressor();this.mix.connect(compressor);compressor.connect(context.destination);context.createMediaStreamSource(stream).connect(this.mix);
  }catch(e){stream.getTracks().forEach(t=>t.stop());await this.stop();throw e;}
 }
 attachRemote(stream:MediaStream){this.remote?.disconnect();if(this.context&&this.mix){this.remote=this.context.createMediaStreamSource(stream);this.remote.connect(this.mix);}}
 play(buffer:AudioBuffer){if(!this.context||!this.mix)return;const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.mix);this.voices.add(source);source.onended=()=>{this.voices.delete(source);source.disconnect();};source.start();}
 stopSpeech(){for(const source of this.voices){try{source.stop();}catch{}}this.voices.clear();this.remote?.disconnect();this.remote=undefined;}
 async stop(){this.generation++;this.stopSpeech();this.stream?.getTracks().forEach(t=>t.stop());this.stream=undefined;const context=this.context;this.context=undefined;this.mix=undefined;this.outputId='';if(context&&context.state!=='closed')await context.close();}
}
/**
 * The voice owner's capture context and the node feeding its microphone worklet's reference input. Playback rendered here
 * reaches the speakers once and the worklet as the echo reference. The context belongs to the voice owner: playback never
 * closes it.
 */
export type SharedOutput={context:AudioContext;reference:AudioNode};
const sharedSinks=new WeakMap<AudioContext,string>();
async function sharedSink(context:AudioContext,id:string){
 if((sharedSinks.get(context)??'')===id)return;
 if(id)await sink(context,id);else await (context as AudioContext&{setSinkId?:(id:string)=>Promise<void>}).setSinkId?.('');
 sharedSinks.set(context,id);
}
export class SpeechPlayer {
 context?:AudioContext;source?:AudioBufferSourceNode;playing=false;
 /** Whether the current or most recent playback is rendered into the shared capture context, so the reference covers it. */
 tapped=false;
 private frame=0;private done?:()=>void;private generation=0;private current?:object;
 constructor(private mixer:CallMixer,private level:(level:number)=>void){}
 async play(base64:string,outputId:string,shared?:SharedOutput){
  this.stop();const generation=this.generation;const token={};this.current=token;
  const owned=!shared||shared.context.state==='closed';const context=this.context=owned?new AudioContext():shared!.context;this.tapped=!owned;
  let source:AudioBufferSourceNode|undefined,analyser:AnalyserNode|undefined;
  try{
   await (owned?sink(context,outputId):sharedSink(context,outputId));await context.resume();const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const buffer=await context.decodeAudioData(bytes.buffer);if(generation!==this.generation)return;
   source=this.source=context.createBufferSource();source.buffer=buffer;analyser=context.createAnalyser();analyser.fftSize=256;source.connect(analyser);analyser.connect(context.destination);
   // The same rendered samples also reach the microphone worklet's reference input; the speakers still get one playback.
   if(!owned)source.connect(shared!.reference);
   const samples=new Float32Array(analyser.fftSize);const meter=analyser;this.playing=true;this.mixer.play(buffer);const tick=()=>{if(!this.playing)return;meter.getFloatTimeDomainData(samples);this.level(Math.min(1,rms(samples)*3));this.frame=requestAnimationFrame(tick);};tick();
   const playing=source;await new Promise<void>(resolve=>{this.done=resolve;playing.onended=()=>resolve();playing.start();});
  }finally{
   if(this.current===token){this.current=undefined;this.playing=false;this.source=undefined;this.context=undefined;cancelAnimationFrame(this.frame);this.level(0);}
   if(owned){if(context.state!=='closed')await context.close();}
   else{try{source?.disconnect();analyser?.disconnect();}catch{}}
  }
 }
 stop(){this.generation++;this.playing=false;cancelAnimationFrame(this.frame);try{this.source?.stop();}catch{}this.source=undefined;this.done?.();this.done=undefined;this.mixer.stopSpeech();this.level(0);}
}
