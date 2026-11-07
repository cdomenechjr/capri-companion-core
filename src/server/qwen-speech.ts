import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';

export const qwenVoiceFiles={binary:'bin/llama-tts.exe',model:'Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf',projector:'mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf'};
export function qwenVoiceDirectory(){return path.join(process.env.LOCALAPPDATA||os.homedir(),'Capri','Voice','Qwen');}
export function speechChunks(text:string){
 const chunks:string[]=[];let chunk='';
 for(const word of text.trim().split(/\s+/)){
  if(word.length>160)throw Error('A spoken word is too long.');
  if(chunk&&chunk.length+1+word.length>160){chunks.push(chunk);chunk='';}
  chunk+=(chunk?' ':'')+word;
 }
 if(chunk)chunks.push(chunk);return chunks;
}

/** Optional local quality engine. Only fixed local files are passed to the CLI;
 * it receives no URL, cloud model name, shell command, or provider credential.
 */
export class QwenSpeech {
 constructor(readonly directory=qwenVoiceDirectory()){}
 status(){const ready=Object.values(qwenVoiceFiles).every(f=>existsSync(path.join(this.directory,f)));return {ready,reason:ready?'':'Run scripts/setup-quality-voice.ps1 to prepare the Designed A quality engine.'};}
 async generate(text:string,reference:string,signal:AbortSignal){
  if(!this.status().ready)throw Error(this.status().reason);
  signal.throwIfAborted();const directory=await mkdtemp(path.join(os.tmpdir(),'capri-speech-'));const result:Buffer[]=[];
  try{
   for(const chunk of speechChunks(text)){
    signal.throwIfAborted();const output=path.join(directory,'utterance.wav');
    const args=['-m',path.join(this.directory,qwenVoiceFiles.model),'-mm',path.join(this.directory,qwenVoiceFiles.projector),'--tts-speaker-file',reference,'--tts-lang','en','-p',chunk,'-o',output,'-ngl','0','--no-mmproj-offload','-t','2','-tb','2','-c','2048','-n','240','--seed','7','--temp','0.8','--top-k','50','--top-p','0.95','--repeat-penalty','1.05'];
    await new Promise<void>((resolve,reject)=>{
     const child=spawn(path.join(this.directory,qwenVoiceFiles.binary),args,{cwd:this.directory,windowsHide:true,stdio:['ignore','ignore','ignore']});
     let timeout=false;const kill=()=>child.kill();
     const timer=setTimeout(()=>{timeout=true;child.kill();},120000);
     const finish=(error?:Error)=>{clearTimeout(timer);signal.removeEventListener('abort',kill);error?reject(error):resolve();};
     signal.addEventListener('abort',kill,{once:true});if(signal.aborted)kill();
     child.once('error',error=>finish(error));child.once('close',code=>finish(signal.aborted?new Error('Speech cancelled.'):timeout?new Error('Quality voice timed out. Choose the fast local voice or try a shorter reply.'):code!==0?new Error('The local quality voice failed (exit '+code+').'):undefined));
    });
    signal.throwIfAborted();const bytes=await readFile(output);if(bytes.length>4000000)throw Error('Quality speech exceeded its audio limit.');result.push(bytes);
   }
   return result;
  }finally{if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('capri-speech-'))throw Error('Refusing cleanup outside the temporary speech folder.');await rm(directory,{recursive:true,force:true});}
 }
}
