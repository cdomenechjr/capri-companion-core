import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CapriError} from './policy';

import {upstreamVoice,offlinePhrases,SpeechPreferences} from '../speech-shared';
export {upstreamVoice,offlinePhrases,defaultSpeechPreferences} from '../speech-shared';
type Options={directory:string;key:()=>string|undefined;saveKey:(key:string)=>Promise<void>;preferences:()=>Promise<SpeechPreferences>;local:(text:string,p:SpeechPreferences,signal:AbortSignal)=>Promise<any>;fetch?:typeof fetch;reserve?:(text:string)=>Promise<{id:string}>;settle?:(id:string,amount?:number)=>Promise<void>};
export class SpeechOutput{
 private requests=new Map<string,{controller:AbortController;promise:Promise<any>}>();private cancelled=new Set<string>();
 constructor(private options:Options){}
 private async remote(route:string,init:RequestInit={},key=this.options.key()){
  if(!key)throw new CapriError('Connect ElevenLabs in voice settings.',503);
  const response=await (this.options.fetch||fetch)('https://api.elevenlabs.io'+route,{...init,headers:{'xi-api-key':key,...init.headers},signal:init.signal||AbortSignal.timeout(20000)});
  if(!response.ok){const detail=await response.json().catch(()=>({})) as any;const code=String(detail.detail?.status||'');throw new CapriError(response.status===401?'ElevenLabs rejected the key.':response.status===403?'This key cannot access the selected ElevenLabs voice.':response.status===404?'Voice unavailable. Add it to your ElevenLabs account or choose another.':/quota|credit/.test(code)?'ElevenLabs credits are exhausted.':'ElevenLabs could not generate speech (HTTP '+response.status+').',response.status);}
  return response;
 }
 async connection(key?:string,voiceId=upstreamVoice){
  if(key!==undefined&&(!key.trim()||key.length>512))throw new CapriError('Enter a valid ElevenLabs key.');
  await this.remote('/v1/voices/'+encodeURIComponent(voiceId),{},key);
  if(key!==undefined)await this.options.saveKey(key.trim());return {connected:true};
 }
 async voices(){const response=await this.remote('/v2/voices?page_size=100');const data=await response.json() as any;return {voices:(data.voices||[]).map((v:any)=>({id:v.voice_id,name:v.name}))};}
 async status(){const p=await this.options.preferences();return {provider:p.provider,connected:!!this.options.key(),voiceId:p.voiceId,model:p.model,offlinePhrases:Object.keys(offlinePhrases).length};}
 private cacheFile(text:string,p:SpeechPreferences){return path.join(this.options.directory,createHash('sha256').update(JSON.stringify([p.voiceId,p.model,'wav_24000',text])).digest('hex')+'.wav');}
 private async cloud(text:string,p:SpeechPreferences,signal:AbortSignal){
  if(!this.options.key())throw new CapriError('Connect ElevenLabs in voice settings.',503);signal.throwIfAborted();const reservation=await this.options.reserve?.(text);try{signal.throwIfAborted();const response=await this.remote('/v1/text-to-speech/'+encodeURIComponent(p.voiceId)+'?output_format=wav_24000',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,model_id:p.model}),signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length<44||bytes.length>20000000||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw new CapriError('ElevenLabs returned invalid WAV audio.',502);if(reservation)await this.options.settle?.(reservation.id);return bytes;}catch(e:any){if(reservation)await this.options.settle?.(reservation.id,[401,403,404,429].includes(e.status)?0:undefined);throw e;}
 }
 speak(requestId:string,text:string,privateSession=false):Promise<any>{
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)||typeof text!=='string'||!text.trim()||text.length>6000)return Promise.reject(new CapriError('Invalid speech request.'));
  if(this.cancelled.has(requestId))return Promise.reject(new CapriError('Speech was cancelled.',409));
  const existing=this.requests.get(requestId);if(existing)return existing.promise;
  if(this.requests.size>=64)return Promise.reject(new CapriError('Too many speech requests.',429));
  const controller=new AbortController();const promise=this.generate(text,privateSession,controller.signal).finally(()=>{this.requests.delete(requestId);this.cancelled.add(requestId);if(this.cancelled.size>2000)this.cancelled.delete(this.cancelled.values().next().value!);});
  this.requests.set(requestId,{controller,promise});return promise;
 }
 private async generate(text:string,privateSession:boolean,signal:AbortSignal){
  const p=await this.options.preferences();signal.throwIfAborted();let fallbackReason='';
  if(p.provider==='elevenlabs'){
   if(!privateSession&&Object.values(offlinePhrases).includes(text)){try{const bytes=await readFile(this.cacheFile(text,p));if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw Error('Invalid cached phrase');signal.throwIfAborted();return {base64:bytes.toString('base64'),mime:'audio/wav',provider:'elevenlabs',voiceId:p.voiceId,fromCache:true};}catch(e){signal.throwIfAborted();}}
   try{const bytes=await this.cloud(text,p,signal);signal.throwIfAborted();return {base64:bytes.toString('base64'),mime:'audio/wav',provider:'elevenlabs',voiceId:p.voiceId,fromCache:false};}catch(e:any){signal.throwIfAborted();fallbackReason=e.message||'ElevenLabs is unavailable.';}
  }
  const audio=await this.options.local(text,p,signal);signal.throwIfAborted();return {...audio,provider:'local',fromCache:false,...(fallbackReason?{fallbackReason}:{})};
 }
 cancel(id:string){this.cancelled.add(id);this.requests.get(id)?.controller.abort();if(this.cancelled.size>2000)this.cancelled.delete(this.cancelled.values().next().value!);return {cancelled:true};}
 stop(){for(const id of this.requests.keys())this.cancel(id);}
 async downloadPhrases(){
  const p=await this.options.preferences();const controller=new AbortController();const id='phrase_'+crypto.randomUUID();const promise=(async()=>{await this.connection(undefined,p.voiceId);controller.signal.throwIfAborted();await mkdir(this.options.directory,{recursive:true});let saved=0;for(const text of Object.values(offlinePhrases)){controller.signal.throwIfAborted();try{await readFile(this.cacheFile(text,p));}catch{const audio=await this.cloud(text,p,controller.signal);controller.signal.throwIfAborted();await writeFile(this.cacheFile(text,p),audio);}saved++;}return {saved};})();this.requests.set(id,{controller,promise});try{return await promise;}finally{this.requests.delete(id);}
 }
}
