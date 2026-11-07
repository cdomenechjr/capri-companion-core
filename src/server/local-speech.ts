import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CapriError } from './policy';
import { speechTempo } from './speech-tempo';
import { QwenSpeech } from './qwen-speech';
import {SessionSpeechDetector,SpeechDetectorInputError,recognitionConfiguration,type SpeechDetectorOptions,type RecognitionBackend} from '../extensions/speech';

export function wav(samples:Float32Array,rate:number){const out=Buffer.alloc(44+samples.length*2);out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(rate,24);out.writeUInt32LE(rate*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(samples.length*2,40);for(let i=0;i<samples.length;i++)out.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),44+i*2);return out;}
export function readReferenceWav(bytes:Buffer){
 if(bytes.length<44||bytes.length>4000000||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw new CapriError('Invalid designed voice reference.');
 let rate=0,valid=false,data:Buffer|undefined;
 for(let offset=12;offset+8<=bytes.length;){const name=bytes.toString('ascii',offset,offset+4);const size=bytes.readUInt32LE(offset+4);const start=offset+8;if(start+size>bytes.length)throw new CapriError('Truncated voice reference.');if(name==='fmt '){if(size<16)throw new CapriError('Invalid voice reference format.');valid=bytes.readUInt16LE(start)===1&&bytes.readUInt16LE(start+2)===1&&bytes.readUInt16LE(start+14)===16;rate=bytes.readUInt32LE(start+4);}if(name==='data')data=bytes.subarray(start,start+size);offset=start+size+(size%2);}
 if(!valid||!data||!data.length||data.length%2||rate<8000||rate>48000||data.length/(2*rate)>20)throw new CapriError('Use a short mono PCM16 designed voice reference.');
 const samples=new Float32Array(data.length/2);for(let i=0;i<samples.length;i++)samples[i]=data.readInt16LE(i*2)/32768;return {samples,sampleRate:rate};
}
export class LocalSpeech {
 private recognizer?:Promise<RecognitionBackend>;private recognizerKey='';private tts?:Promise<any>;private designed?:Promise<any>;private queue:Promise<any>=Promise.resolve();private controllers=new Set<AbortController>();
 readonly detector:SessionSpeechDetector;
 constructor(private modelDirectory:string,private quality=new QwenSpeech(),private options:SpeechDetectorOptions&{createRecognizer?:(config:any)=>Promise<RecognitionBackend>}={}){this.detector=new SessionSpeechDetector(modelDirectory,options);}
 private config(){const file=path.join(this.modelDirectory,'speech.json');if(!existsSync(file))throw new CapriError('Local speech models are not installed. Run Capri’s local setup.',503);return JSON.parse(readFileSync(file,'utf8'));}
 status(engine='kokoro'){try{const cfg=this.config();const recognition=recognitionConfiguration(this.modelDirectory,cfg);const models=engine==='designed'?Object.values(cfg.designed||{}):engine==='designed-hq'?[cfg.designed?.reference]:[cfg.tts.model,cfg.tts.voices,cfg.tts.tokens,cfg.tts.lexicon];const paths=models.filter(Boolean);const modelReady=(!engine.startsWith('designed')||!!cfg.designed)&&paths.every((p:any)=>existsSync(path.join(this.modelDirectory,p)));const quality=engine==='designed-hq'?this.quality.status():{ready:true,reason:''};const ready=modelReady&&quality.ready;return {ready,recognition:recognition.backend==='whisper'?'Whisper tiny.en':'Parakeet',voice:engine==='designed-hq'?'Designed A · Qwen quality':engine==='designed'?'Designed A · Pocket fast':'Kokoro English',engine,reason:ready?'':modelReady?quality.reason:'A local speech model file is missing.'};}catch{return {ready:false,reason:'A local speech model is missing or invalid.'};}}
 /** Independent recognition readiness: voice selection and text-model preference do not select ASR. */
 recognitionStatus(){try{const selected=recognitionConfiguration(this.modelDirectory,this.config());return {available:true,backend:selected.backend};}catch{return {available:false,reason:'model-missing'};}}
 async detect(input:unknown,signal?:AbortSignal){try{return await this.detector.detect(input,signal);}catch(error){if(error instanceof SpeechDetectorInputError)throw new CapriError('Invalid speech detector frame.',400);throw error;}}
 cancelDetection(sessionId:string){this.detector.cancel(sessionId);}
 private async run<T>(work:(signal:AbortSignal)=>Promise<T>,external?:AbortSignal){const controller=new AbortController();const abort=()=>controller.abort();if(external?.aborted)controller.abort();external?.addEventListener('abort',abort,{once:true});this.controllers.add(controller);const previous=this.queue;let release!:()=>void;this.queue=new Promise<void>(resolve=>release=resolve);try{await previous;controller.signal.throwIfAborted();return await work(controller.signal);}finally{external?.removeEventListener('abort',abort);this.controllers.delete(controller);release();}}
 async transcribe(base64:string,external?:AbortSignal){
  if(typeof base64!=='string'||base64.length>1800000||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw new CapriError('Invalid local microphone audio.');
  const bytes=Buffer.from(base64,'base64');if(bytes.length%4||bytes.length<3200||bytes.length>1280000)throw new CapriError('Use microphone audio between 50 ms and 20 seconds.');
  const samples=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));bytes.fill(0);if(samples.some(n=>!Number.isFinite(n)||Math.abs(n)>1.1)){samples.fill(0);throw new CapriError('Invalid microphone samples.');}
  try{return await this.run(async signal=>{let selected:ReturnType<typeof recognitionConfiguration>;
   try{selected=recognitionConfiguration(this.modelDirectory,this.config());}catch{throw new CapriError('The selected local recognition model is missing or invalid.',503);}
   const key=JSON.stringify(selected);if(this.recognizerKey!==key){this.recognizer=undefined;this.recognizerKey=key;}
   this.recognizer??=(this.options.createRecognizer?this.options.createRecognizer(selected.config):require('sherpa-onnx-node').OfflineRecognizer.createAsync(selected.config)).catch((e:unknown)=>{this.recognizer=undefined;throw e;});
   const recognizer=await this.recognizer!;signal.throwIfAborted();const stream=recognizer.createStream();stream.acceptWaveform({samples,sampleRate:16000});const result=await recognizer.decodeAsync(stream);signal.throwIfAborted();return {text:String(result.text||'').trim(),local:true};},external);}finally{samples.fill(0);}
 }
 async speak(text:string,speaker=1,speed=1.08,engine='kokoro',external?:AbortSignal){
  if(typeof text!=='string'||!text.trim()||text.length>6000)throw new CapriError('Speech text is empty or too long.');if(!Number.isInteger(speaker)||speaker<0||speaker>10||!Number.isFinite(speed)||speed<.7||speed>1.4)throw new CapriError('Invalid local voice settings.');
  if(!['kokoro','designed','designed-hq'].includes(engine))throw new CapriError('Unknown speech engine.');
  return this.run(async signal=>{const cfg=this.config();const file=(p:string)=>p?path.join(this.modelDirectory,p):'';const sherpa=require('sherpa-onnx-node');let tts:any,generationConfig:any;
   if(engine==='designed-hq'){
    const status=this.status(engine);if(!status.ready)throw new CapriError(status.reason,503);
    const textForSpeech=text.replace(/https?:\/\/\S+/g,'linked source').replace(/[*#`]/g,'');
    const chunks=await this.quality.generate(textForSpeech,file(cfg.designed.reference),signal);
    const decoded=chunks.map(bytes=>readReferenceWav(bytes));if(!decoded.length)throw new CapriError('Quality speech returned no audio.');
    const rate=decoded[0].sampleRate;if(decoded.some(c=>c.sampleRate!==rate))throw new CapriError('Quality speech sample rate changed.');
    const gap=Math.round(rate*.12);const samples=new Float32Array(decoded.reduce((n,c)=>n+c.samples.length,0)+gap*(decoded.length-1));
    let offset=0;for(const chunk of decoded){samples.set(chunk.samples,offset);offset+=chunk.samples.length+gap;}
    signal.throwIfAborted();return {base64:wav(speechTempo(samples,rate,speed),rate).toString('base64'),mime:'audio/wav',local:true,engine};
   }
   if(engine==='designed'){
    if(!this.status(engine).ready)throw new CapriError('The designed voice model is not installed.',503);
    const {reference,...model}=cfg.designed;const pocket=Object.fromEntries(Object.entries(model).map(([key,value])=>[key,file(value as string)]));
    this.designed??=sherpa.OfflineTts.createAsync({model:{pocket,numThreads:2,provider:'cpu'},maxNumSentences:1}).catch((e:any)=>{this.designed=undefined;throw e;});tts=await this.designed;
    const ref=readReferenceWav(readFileSync(file(reference)));generationConfig={speed:1,referenceAudio:ref.samples,referenceSampleRate:ref.sampleRate,numSteps:8,extra:{max_reference_audio_len:12,seed:7}};
   }else{this.tts??=sherpa.OfflineTts.createAsync({model:{kokoro:{model:file(cfg.tts.model),voices:file(cfg.tts.voices),tokens:file(cfg.tts.tokens),lexicon:file(cfg.tts.lexicon)},numThreads:2,provider:'cpu'},numThreads:2,provider:'cpu',maxNumSentences:1}).catch((e:any)=>{this.tts=undefined;throw e;});tts=await this.tts;}
   signal.throwIfAborted();const audio=await tts.generateAsync({text:text.replace(/https?:\/\/\S+/g,'linked source').replace(/[*#`]/g,''),sid:speaker,speed:engine==='designed'?1:speed,...(generationConfig?{generationConfig}:{}),enableExternalBuffer:false,onProgress:()=>!signal.aborted});signal.throwIfAborted();if(!audio.samples?.length)throw new CapriError('Local speech returned no audio.');const sampleRate=audio.sampleRate||tts.sampleRate;const samples=engine==='designed'?speechTempo(audio.samples,sampleRate,speed):audio.samples;return {base64:wav(samples,sampleRate).toString('base64'),mime:'audio/wav',local:true,engine};},external);
 }
 stop(){for(const controller of this.controllers)controller.abort();this.detector.stop();}
 async close(){this.stop();await Promise.all([this.queue,this.detector.close()]);}
}
