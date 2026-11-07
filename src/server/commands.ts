import {spawn} from 'node:child_process';
export async function commandProcess(executable:string,args:string[],cwd:string,signal:AbortSignal,timeout=120000){
 signal.throwIfAborted();return new Promise<{code:number|null;output:string;untrusted:true}>((resolve,reject)=>{let timedOut=false;const child=spawn(executable,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,OPENAI_API_KEY:undefined,ELEVENLABS_API_KEY:undefined}});let output='';
 const kill=()=>{if(child.pid&&process.platform==='win32'){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else child.kill('SIGKILL');};
 const timer=setTimeout(()=>{timedOut=true;kill();},timeout);const abort=()=>kill();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)kill();
 child.stdout.on('data',b=>{output=(output+b.toString()).slice(-64000);});child.stderr.on('data',b=>{output=(output+b.toString()).slice(-64000);});child.on('error',error=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(error);});child.on('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else resolve({code,output:output+(timedOut?'\nProcess timed out and its process tree was stopped.':''),untrusted:true});});});
}
