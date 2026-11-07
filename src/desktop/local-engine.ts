import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
export async function ensureLocalEngine(){
 try{const response=await fetch('http://127.0.0.1:11434/api/version',{signal:AbortSignal.timeout(1000),redirect:'error'});if(response.ok)return {running:true};}catch{}
 const executable=path.join(process.env.LOCALAPPDATA||'','Programs','Ollama','ollama.exe');if(!existsSync(executable))return {running:false,reason:'Install Ollama with Capri’s local setup.'};
 const env:NodeJS.ProcessEnv={OLLAMA_HOST:'127.0.0.1:11434',OLLAMA_NO_CLOUD:'1',OLLAMA_NUM_PARALLEL:'1',OLLAMA_MAX_LOADED_MODELS:'1'};for(const name of ['SystemRoot','PATH','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
 const child=spawn(executable,['serve'],{windowsHide:true,detached:true,stdio:'ignore',env});child.on('error',()=>{});child.unref();
 for(let attempt=0;attempt<15;attempt++){try{const response=await fetch('http://127.0.0.1:11434/api/version',{signal:AbortSignal.timeout(1000),redirect:'error'});if(response.ok)return {running:true};}catch{}await new Promise(resolve=>setTimeout(resolve,300));}return {running:false,reason:'Ollama did not start. Open it from the Start menu and retry.'};
}
