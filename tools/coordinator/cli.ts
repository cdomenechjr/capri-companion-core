import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Coordinator,control,retryOffline,replanOffline,reintegrateOffline,amendScopeOffline} from './engine';
import {loadConfig,readJson,isAlive,atomicJson} from './storage';
import {operatorFeedback} from './protocol';
import type {State} from './types';

async function main(){
 const args=process.argv.slice(2),command=args.find(a=>!a.startsWith('-'))||'status';const configIndex=args.indexOf('--config');const file=path.resolve(configIndex>=0?args[configIndex+1]:path.join(path.dirname(fileURLToPath(import.meta.url)),'config.json'));const config=loadConfig(file);
 const releaseQuiesce=args.includes('--release-quiesce'),daemonChild=args.includes('--coordinator-child'),stopIntent=path.join(config.stateDir,'operator-stop.json');
 if(releaseQuiesce&&!['start','stop'].includes(command))throw Error('--release-quiesce is reserved for release start/stop coordination.');
 if(daemonChild&&!['start','resume'].includes(command))throw Error('Invalid coordinator child command.');
 if(command==='stop'&&!releaseQuiesce)atomicJson(stopIntent,{version:1,id:randomUUID(),at:new Date().toISOString()});
 if(['start','resume'].includes(command)&&!releaseQuiesce&&!daemonChild)fs.rmSync(stopIntent,{force:true});
 if((releaseQuiesce||daemonChild)&&['start','resume'].includes(command)&&fs.existsSync(stopIntent))throw Error('Explicit operator Stop is active; only an explicit start/resume may clear it.');
 if(command==='status'){
  const stateFile=path.join(config.stateDir,'state.json');if(!fs.existsSync(stateFile)){console.log(JSON.stringify({status:'not_started',stateDir:config.stateDir},null,2));return;}
  const state=readJson<State>(stateFile);let pid:number|undefined;try{pid=readJson<any>(path.join(config.stateDir,'coordinator.lock')).pid;}catch{}
  console.log(JSON.stringify({status:pid&&isAlive(pid)?state.status:'stopped',pid:pid&&isAlive(pid)?pid:undefined,candidateCommit:state.candidateCommit,updatedAt:state.updatedAt,lastError:state.lastError,agentOwnership:state.agentOwnership,tasks:state.tasks.map(t=>({id:t.id,owner:t.owner,phase:t.phase,attempts:t.attempts,manualRetries:t.manualRetries,attemptLimit:t.attemptLimit,commit:t.commit,summary:t.result?.summary,reviewIssues:t.review?.issues,error:t.error}))},null,2));return;
 }
 if(command==='retry'){
  const taskIndex=args.indexOf('--task'),feedbackIndex=args.indexOf('--feedback-file');if(taskIndex<0||feedbackIndex<0||!args[taskIndex+1]||!args[feedbackIndex+1])throw Error('Usage: coordinator retry --task <id> --feedback-file <JSON file> [--allow-path <exact file>]');const allowPaths=args.flatMap((value,index)=>value==='--allow-path'?[args[index+1]]:[]);if(allowPaths.some(value=>!value||value.startsWith('--')))throw Error('--allow-path requires an exact repository-relative file');const feedbackFile=path.resolve(args[feedbackIndex+1]);if(fs.statSync(feedbackFile).size>65000)throw Error('Feedback file exceeds 65000 bytes');const feedback=operatorFeedback(readJson(feedbackFile));const leaseFile=path.join(config.stateDir,'coordinator.lock');let live=false;if(fs.existsSync(leaseFile))live=isAlive(readJson<any>(leaseFile).pid);if(live){control(config,'retry',{taskId:args[taskIndex+1],feedback,allowPaths});console.log('Retry requested for '+args[taskIndex+1]+'; inspect status for acceptance');}else{const task=retryOffline(config,args[taskIndex+1],feedback,allowPaths);console.log(JSON.stringify({status:'retry_queued_offline',taskId:task.id,attempts:task.attempts,manualRetries:task.manualRetries,attemptLimit:task.attemptLimit,addedPaths:task.retryHistory?.at(-1)?.addedPaths}));}return;
 }
 if(command==='replan'){const audit=replanOffline(config);console.log(JSON.stringify({status:'replanned_offline',...audit},null,2));return;}
 if(command==='amend-scope'){
  const usage='Usage: coordinator amend-scope --task <id> --feedback-file <JSON file> --allow-path <exact file> [--allow-path <exact file>] [--config file]';
  const options=new Map<string,string[]>();
  for(let index=0;index<args.length;index++){
   if(index===0&&args[index]===command)continue;
   const flag=args[index],value=args[++index];if(!['--task','--feedback-file','--allow-path','--config'].includes(flag)||!value||value.startsWith('--'))throw Error(usage);
   const values=options.get(flag)||[];values.push(value);options.set(flag,values);
  }
  if(options.get('--task')?.length!==1||options.get('--feedback-file')?.length!==1||!options.get('--allow-path')?.length||(options.get('--config')?.length||0)>1)throw Error(usage);
  const feedbackFile=path.resolve(options.get('--feedback-file')![0]);if(fs.statSync(feedbackFile).size>65000)throw Error('Feedback file exceeds 65000 bytes');
  const result=amendScopeOffline(config,options.get('--task')![0],operatorFeedback(readJson(feedbackFile)),options.get('--allow-path')!);
  console.log(JSON.stringify({status:result.changed?'scope_amended_offline':'scope_unchanged_offline',taskId:result.task.id,addedPaths:result.addedPaths,fingerprint:result.task.fingerprint}));return;
 }
 if(command==='reintegrate'){
  const taskIndex=args.indexOf('--task'),feedbackIndex=args.indexOf('--feedback-file');if(taskIndex<0||feedbackIndex<0||!args[taskIndex+1]||!args[feedbackIndex+1]||args.includes('--allow-path'))throw Error('Usage: coordinator reintegrate --task <id> --feedback-file <JSON file>; commit and scope are immutable');const feedbackFile=path.resolve(args[feedbackIndex+1]);if(fs.statSync(feedbackFile).size>65000)throw Error('Feedback file exceeds 65000 bytes');const feedback=operatorFeedback(readJson(feedbackFile)),leaseFile=path.join(config.stateDir,'coordinator.lock');const live=fs.existsSync(leaseFile)&&isAlive(readJson<any>(leaseFile).pid);if(live){control(config,'reintegrate',{taskId:args[taskIndex+1],feedback});console.log('Reintegration requested for '+args[taskIndex+1]+'; inspect status for acceptance');}else{const task=reintegrateOffline(config,args[taskIndex+1],feedback);console.log(JSON.stringify({status:'reintegration_queued_offline',taskId:task.id,attempts:task.attempts,commit:task.commit}));}return;
 }
 if(['pause','resume','stop'].includes(command)){
  const stopIsInactive=()=>{let lease:any;try{lease=readJson(path.join(config.stateDir,'coordinator.lock'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(lease&&isAlive(lease.pid))return false;const stateFile=path.join(config.stateDir,'state.json');if(fs.existsSync(stateFile)){const saved=readJson<State>(stateFile);if(saved.proposalRun||saved.tasks.some(task=>task.run||['running','integration'].includes(task.phase)))throw Error('No live coordinator; preserved worker/integration state requires recovery before confirming Stop.');}return true;};
  if(command==='stop'&&stopIsInactive()){console.log('Coordinator already stopped');return;}
  try{const lease=readJson<any>(path.join(config.stateDir,'coordinator.lock'));if(!isAlive(lease.pid))throw Error('Coordinator is not running');control(config,command as 'pause'|'resume'|'stop');console.log(command+' requested');}
  catch(error){if(command==='stop'&&!releaseQuiesce&&(error as NodeJS.ErrnoException).code==='EEXIST'&&fs.existsSync(stopIntent)){console.log('stop requested; durable operator Stop takes priority over pending controls');return;}if(command==='stop'&&stopIsInactive()){console.log('Coordinator already stopped');return;}if(command==='resume'&&(error as NodeJS.ErrnoException).code!=='EEXIST'){console.log('Starting coordinator with preserved state');await launch(args.includes('--daemon'));}else throw error;}return;
 }
 if(command!=='start')throw Error('Usage: coordinator start [--daemon] [--once] | status | pause | resume | stop | replan | amend-scope/retry/reintegrate --task id --feedback-file JSON [--allow-path exact-file] [--config file]');
 await launch(args.includes('--daemon'));
 async function launch(daemon:boolean){
  if(daemon){fs.mkdirSync(config.stateDir,{recursive:true});const out=fs.openSync(path.join(config.stateDir,'coordinator.log'),'a');const child=spawn(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),command==='resume'?'resume':'start','--config',file,'--coordinator-child',...(releaseQuiesce?['--release-quiesce']:[]),...(args.includes('--once')?['--once']:[])],{cwd:config.repo,detached:true,windowsHide:true,stdio:['ignore',out,out]});child.unref();fs.closeSync(out);console.log(JSON.stringify({status:'starting',pid:child.pid,log:path.join(config.stateDir,'coordinator.log')}));return;}
  const coordinator=new Coordinator(config);const signalStop=()=>{atomicJson(stopIntent,{version:1,id:randomUUID(),at:new Date().toISOString()});void coordinator.stop();};process.once('SIGINT',signalStop);process.once('SIGTERM',signalStop);await coordinator.run(args.includes('--once'),command==='resume');
 }
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
