import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFile, type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {JsonLines,extractClaudeResult,jsonObject} from './protocol';
import {redact} from './storage';
import {AgentCapacityBusy,type Agent,type Config,type RunIdentity,type AgentOwnershipHooks,type AgentOwnershipLease} from './types';
import {AgentLeasePool,AgentLeaseJournal,AgentStopUnconfirmed,agentLeaseDigest,ensureAgentLeaseDirectory,isAgentLeaseBusy,sharedAgentLeases,stopAgentProcess,type AgentLease,type AgentNativeLeaseClaim,type AgentLeaseJournalState,type AgentLeaseInspector,type AgentLeaseRecovery,type AgentLeaseRecord,type LeaseProvider} from '../../src/extensions/agent-lease';
import {prepareSupervisedLaunch,armSupervisedRun,inspectSupervisedRun,cancelSupervisedRun,type SupervisorIdentity} from '../../src/extensions/supervisor';
const exec=promisify(execFile);
export async function terminateTree(child:ChildProcess){await stopAgentProcess(child);}
export type LeaseRunIdentity=RunIdentity&{leaseToken?:string};
export type AgentRunLeaseInspector=(record:AgentLeaseRecord,provider:LeaseProvider,run:Readonly<LeaseRunIdentity>)=>Promise<boolean>;
export type AgentRunRecoveryOptions={leases?:AgentLeasePool;inspectStopped?:AgentRunLeaseInspector;onRecovery?:(result:AgentLeaseRecovery)=>void};
/** Trusted engine/operator integration. The inspector must prove this saved run's
 * ENTIRE token-owned tree is gone using the native job/creator-watch ledger.
 * isAlive(run.pid) / a successful taskkill / a dead coordinator are not proof.
 * Keep the saved run and block resume on recovery-required, even if its PID is gone.
 */
export async function recoverAgentRunLease(run:LeaseRunIdentity,options:AgentRunRecoveryOptions={}):Promise<AgentLeaseRecovery>{
 const provider=run.agent==='claude'?'claude-api':'codex';
 const inspect:AgentLeaseInspector|undefined=options.inspectStopped?async(record,key)=>{
  if(record.owner!=='development:'+run.sessionId&&record.owner!=='development:'+run.taskId)return false;
  if(run.leaseToken&&record.token!==run.leaseToken)return false;
  return options.inspectStopped!(record,key,Object.freeze({...run}));
 }:undefined;
 // No implicit cross-profile pool: the legacy engine has no native recovery ledger.
 const report:AgentLeaseRecovery=options.leases?await options.leases.reconcile(provider,inspect):
  run.leaseToken?{provider,state:'recovery-required',reason:'inspector-required'}:{provider,state:'available'};
 options.onRecovery?.(report);return report;
}
export async function verifiedOrphanStop(run:LeaseRunIdentity,recovery:AgentRunRecoveryOptions={}){
 if(run.ownership==='native-job-v1'||run.supervisor){if(recovery.leases)await recoverAgentRunLease(run,recovery);return false;}
 if(!Number.isInteger(run.pid)||run.pid<=0)return;
 let matches=false;
 try{if(process.platform==='win32'){const script='$p=Get-CimInstance Win32_Process -Filter "ProcessId='+run.pid+'"; if($p -and $p.CommandLine -and $p.CommandLine.Contains('+"'"+run.marker.replace(/'/g,"''")+"'"+')) { "match" }';const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000});matches=stdout.trim()==='match';}else matches=fs.readFileSync('/proc/'+run.pid+'/cmdline','utf8').includes(run.marker);}catch{/* No trustworthy ownership evidence; do not kill a reused PID. */}
 if(matches){if(process.platform==='win32')await exec('taskkill.exe',['/PID',String(run.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});else try{process.kill(-run.pid,'SIGKILL');}catch{try{process.kill(run.pid,'SIGKILL');}catch{}}}
 // Legacy callers retain their marker-verified orphan stop. Opted-in shared leases
 // require independent tree proof; a missing PID or taskkill never clears them.
 if(recovery.leases)await recoverAgentRunLease(run,recovery);return matches;
}
export type AgentRequest={agent:Agent;mode:RunIdentity['mode'];taskId:string;cwd:string;profile:string;port:number;prompt:string;schema:object;outputDir:string;timeoutMs?:number};
export type AgentResponse={value:any;sessionId:string;output:string;malformed:number};
export class AgentRunError extends Error {constructor(message:string){super(message);this.name='AgentRunError';}}
export function buildInvocation(config:Config,request:AgentRequest,sessionId:string,schemaFile:string,resultFile:string){
 const executable=config.agents[request.agent].command,extra=config.agents[request.agent].args||[];if(extra.some(v=>/dangerously|bypass.*(?:approval|permission|sandbox)/i.test(v)))throw Error('Permission-bypass arguments are prohibited');
 const readOnly=request.mode!=='implement';
 const nodePaths=[process.execPath,process.execPath.replace(/\\/g,'/')];
 const nodeRules=['PowerShell(node *)','PowerShell(node.exe *)',...nodePaths.flatMap(executable=>[
  "PowerShell(& '"+executable+"' *)",'PowerShell(& "'+executable+'" *)',
  ...(!/\s/.test(executable)?['PowerShell('+executable+' *)','PowerShell(& '+executable+' *)']:[])
 ])];
 const rules=['Read','Glob','Grep','Edit','Write','Bash(node *)','Bash(git diff *)','Bash(git status *)','Bash(git log *)','Bash(git show *)','Bash(git rev-parse *)',...nodeRules,'PowerShell(git diff *)','PowerShell(git status *)','PowerShell(git log *)','PowerShell(git show *)','PowerShell(git rev-parse *)'];
 const args=request.agent==='codex'?['-a','never',...extra,'exec','--json','--sandbox',readOnly?'read-only':'workspace-write','-C',request.cwd,'--output-schema',schemaFile,'--output-last-message',resultFile,'-']:[...extra,'-p','--output-format','stream-json','--verbose','--permission-mode',readOnly?'dontAsk':'acceptEdits','--session-id',sessionId,'--json-schema',JSON.stringify(request.schema),'--strict-mcp-config','--mcp-config',JSON.stringify({mcpServers:{}}),'--tools',readOnly?'Read,Glob,Grep':'Read,Glob,Grep,Edit,Write,Bash,PowerShell','--allowedTools',readOnly?'Read,Glob,Grep':rules.join(',')];
 const childEnv={...process.env};const inheritedPath=Object.entries(childEnv).find(([key])=>key.toLowerCase()==='path')?.[1]||'';for(const key of Object.keys(childEnv))if(key.toLowerCase()==='path')delete childEnv[key];childEnv[process.platform==='win32'?'Path':'PATH']=[path.dirname(process.execPath),path.dirname(executable),inheritedPath].join(path.delimiter);
 return {executable,args,marker:request.agent==='codex'?request.cwd:sessionId,env:{...childEnv,CAPRI_PROFILE_DIR:request.profile,CAPRI_DEV_PORT:String(request.port),CAPRI_COORDINATOR_TASK:request.taskId,CAPRI_REFERENCE_ROOT:config.referenceRoot,CAPRI_AGENT_ACTIVITY_FILE:path.join(config.stateDir,'activity.jsonl'),CLAUDE_CODE_USE_POWERSHELL_TOOL:'1',ENABLE_CLAUDEAI_MCP_SERVERS:'false',NO_COLOR:'1'}};
}

export type NativeAgentTransportOptions={helperPath:string;helperSha256:string;controlRoot:string;leases?:AgentLeasePool;hostId?:string;armingTimeoutMs?:number;stopTimeoutMs?:number;
 /** Trusted host/test seams. Never populate these from an agent/model record. */
 invocation?:typeof buildInvocation;spawnChild?:typeof spawn;creatorIdentity?:()=>Promise<string>;creatorState?:(record:AgentLeaseRecord)=>Promise<'alive'|'dead'|'unknown'>;onCheckpoint?:(phase:'claimed'|'prepared'|'armed',record:AgentLeaseRecord)=>void|Promise<void>};
type NativeAttempt={request:AgentRequest;provider:LeaseProvider;lease:AgentLease;journal:AgentLeaseJournal;controller:AbortController;child?:ChildProcess;closed?:Promise<number|null>;identity?:SupervisorIdentity;run?:LeaseRunIdentity;stopping?:Promise<boolean>};
const digest=(value:crypto.BinaryLike)=>crypto.createHash('sha256').update(value).digest('hex');
const inside=(root:string,file:string)=>{const relative=path.relative(root,file);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function beforeStop<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{return new Promise((resolve,reject)=>{let done=false;const finish=(failed:boolean,value:unknown)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);failed?reject(value):resolve(value as T);},abort=()=>finish(true,signal.reason??Error('Owned agent stopped before dispatch'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();work.then(value=>finish(false,value),error=>finish(true,error));});}
const providerFor=(agent:Agent):LeaseProvider=>agent==='claude'?'claude-api':'codex';
const agentFor=(provider:LeaseProvider):Agent=>provider==='claude-api'?'claude':'codex';
function safeExecutable(file:string,pin?:string){
 if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file||file.includes('\0')||file.includes('~')||file.startsWith('\\\\')||!file.toLowerCase().endsWith('.exe'))throw Error('Native executable must be a canonical absolute local .exe');
 let current=path.parse(file).root;for(const part of path.relative(current,file).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('Native executable contains an alias');}
 const info=fs.lstatSync(file);if(!info.isFile()||info.nlink!==1||fs.realpathSync.native(file).toLowerCase()!==file.toLowerCase()||pin!==undefined&&(!/^[a-f0-9]{64}$/.test(pin)||digest(fs.readFileSync(file))!==pin))throw Error('Pinned native executable changed');return file;
}
/** Read-only immutable process-birth observation, used only for enforced
 * pre-ACK ordering. Armed recovery always uses the signed native Job proof. */
export async function agentCreatorState(pid:number,created?:string):Promise<{state:'alive'|'dead'|'unknown';created?:string}>{
 if(process.platform!=='win32'||!Number.isSafeInteger(pid)||pid<=0)return {state:'unknown'};
 try{
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const script='$ErrorActionPreference="Stop";try{$p=[System.Diagnostics.Process]::GetProcessById('+pid+');$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}catch [System.ArgumentException]{"absent"}';
  const {stdout}=await exec(powershell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000,maxBuffer:2048});const observed=stdout.trim();
  if(observed==='absent')return {state:'dead'};if(!/^\d{1,20}$/.test(observed)||BigInt(observed)<=0n)return {state:'unknown'};return created&&created!==observed?{state:'dead',created:observed}:{state:'alive',created:observed};
 }catch{return {state:'unknown'};}
}
let ownCreator:Promise<string>|undefined;
function ownCreatorIdentity(){return ownCreator??=agentCreatorState(process.pid).then(value=>{if(value.state!=='alive'||!value.created)throw Error('Creating process identity is unavailable');return value.created;});}
/** Explicit operator environment only; there is no signing-config/profile read.
 * Runtime hosts pass the same pin/pool and their own private control root. */
export function nativeAgentTransportOptions(config:Config):NativeAgentTransportOptions|undefined{
 const helperPath=process.env.CAPRI_PROCESS_SUPERVISOR,helperSha256=process.env.CAPRI_PROCESS_SUPERVISOR_SHA256;
 if(!helperPath||!helperSha256)return undefined;return {helperPath,helperSha256,controlRoot:path.join(config.developmentRoot,'runtime','agent-supervision'),leases:sharedAgentLeases};
}
export class AgentProcesses{
 children=new Map<string,ChildProcess>();
 private ownedStops=new Map<ChildProcess,()=>Promise<void>>();
 private readonly native?:NativeAgentTransportOptions;
 private readonly nativeAttempts=new Map<Agent,NativeAttempt>();
 private readonly pendingNativeLaunches=new Set<AbortController>();
 private nativeStopGeneration=0;
 private readonly hostId:string;
 private unavailableReason?:string;
 readonly leases:AgentLeasePool;
 readonly ownership?:AgentOwnershipHooks;
 /** Windows production uses the pinned guardian and shared per-user pool.
  * Argument five preserves the explicitly injected legacy lifecycle contract;
  * argument six supplies trusted native configuration/fake transport seams.
  * Missing native configuration is unavailable, never an unsupervised fallback.
  */
 constructor(readonly config:Config,readonly onStart:(run:LeaseRunIdentity)=>void|Promise<void>,readonly onRecord:(run:RunIdentity,record:any)=>void|Promise<void>,leases?:AgentLeasePool,readonly lifecycle?:AgentProcessLifecycle,native?:NativeAgentTransportOptions){
  const configured=native??(!lifecycle&&process.platform==='win32'?nativeAgentTransportOptions(config):undefined);this.native=configured?{...configured,helperPath:configured.helperPath.replaceAll('/',path.sep),controlRoot:configured.controlRoot.replaceAll('/',path.sep)}:undefined;this.leases=leases??this.native?.leases??(!lifecycle&&process.platform==='win32'?sharedAgentLeases:new AgentLeasePool());this.hostId=native?.hostId??agentLeaseDigest({owner:'development',stateDir:path.resolve(config.stateDir).toLowerCase()});
  if(lifecycle){if(native||this.leases.directory)throw Error('Legacy injected lifecycle requires an isolated memory pool; persistent production ownership uses the pinned native transport');if(!lifecycle.launch||!lifecycle.stop||!lifecycle.inspectStopped)throw Error('Incomplete injected lifecycle');return;}
  if(process.platform==='win32'||this.native){
   try{this.validateNative();}catch(error){this.unavailableReason=String((error as Error).message);}
   this.ownership={protocol:'capri-agent-ownership-v1',ready:agent=>!this.unavailableReason&&this.leases.peek(providerFor(agent)).state==='available',cleanupStatus:run=>this.nativeRunStopped(run)?'confirmed':'unconfirmed',reconcile:run=>this.reconcileNativeRun(run),reconcileLeases:()=>this.reconcileNativeLeases()};
  }else if(this.leases.directory)throw Error('Shared agent leases need owned native process supervision');
 }
 async recover(run:LeaseRunIdentity,inspectStopped?:AgentRunLeaseInspector){return recoverAgentRunLease(run,{leases:this.leases,inspectStopped:inspectStopped??this.lifecycle?.inspectStopped});}
 private async stopOwned(child:ChildProcess){await (this.ownedStops.get(child)??(()=>terminateTree(child)))();}
 async execute(request:AgentRequest):Promise<AgentResponse>{
  if(this.ownership)return this.executeNative(request);
  if(this.children.has(request.agent))throw new AgentCapacityBusy(request.agent);
  const sessionId=crypto.randomUUID();let lease:AgentLease;try{lease=this.leases.acquire(request.agent,'development:'+sessionId);}catch(error){if(isAgentLeaseBusy(error))throw new AgentCapacityBusy(request.agent);throw error;}
  let owned:ChildProcess|undefined,stopLease:(()=>Promise<void>)|undefined,failed=false;
  try {
  const outputDir=path.resolve(request.outputDir);fs.mkdirSync(outputDir,{recursive:true});const resultFile=path.join(outputDir,'result.json'),schemaFile=path.join(outputDir,'schema.json');fs.writeFileSync(schemaFile,JSON.stringify(request.schema));
  const {executable,args,marker,env}=buildInvocation(this.config,request,sessionId,schemaFile,resultFile);
  const identity=Object.freeze({token:lease.token,pid:process.pid,owner:'development:'+sessionId}),provider=request.agent==='claude'?'claude-api':'codex';
  const options={cwd:request.cwd,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'] as ['pipe','pipe','pipe'],env};
  if(this.lifecycle){const lifecycle=this.lifecycle;let stopping:Promise<void>|undefined;
   // Even launch failure may leave an owned tree: cleanup is keyed before launch.
   stopLease=()=>stopping??=Promise.resolve().then(async()=>{await lifecycle.stop(identity,provider);if(!await lifecycle.inspectStopped(identity,provider))throw new AgentStopUnconfirmed('Owned agent tree stop unconfirmed');});
  }
  const child=this.lifecycle?this.lifecycle.launch(executable,args,options,identity,provider):spawn(executable,args,options);
  owned=child;
  if(stopLease)this.ownedStops.set(child,stopLease);
  child.on('error',()=>{}); // Ownership cleanup is also safe if onStart throws before normal listeners attach.
  const run:LeaseRunIdentity={pid:child.pid||0,marker,agent:request.agent,mode:request.mode,taskId:request.taskId,sessionId,leaseToken:lease.token,startedAt:new Date().toISOString()};this.children.set(request.agent,child);this.onStart(run);
  const finals:any[]=[];let output='',errorOutput='',timedOut=false;const append=(chunk:string)=>{output=(output+chunk).slice(-65536);fs.appendFileSync(path.join(outputDir,'events.jsonl'),redact(chunk));};
  const parser=new JsonLines(record=>{if(record.type==='result')finals.push(record);this.onRecord(run,record);});
  child.stdout!.on('data',buffer=>{const chunk=buffer.toString();append(chunk);parser.push(chunk);});child.stderr!.on('data',buffer=>{const chunk=redact(buffer.toString());errorOutput=(errorOutput+chunk).slice(-16384);fs.appendFileSync(path.join(outputDir,'stderr.log'),chunk);});
  child.stdin!.on('error',()=>{});
  const timer=setTimeout(()=>{timedOut=true;void this.stopOwned(child).catch(()=>{});},request.timeoutMs||this.config.timeoutMs);
  try{
   const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);child.stdin!.end(request.prompt);});parser.end();
   if(timedOut)throw Error('Agent attempt exceeded '+(request.timeoutMs||this.config.timeoutMs)+' ms');
   if(code!==0)throw Error((errorOutput+'\n'+output).slice(-18000)||'Agent exited '+code);
   const value=request.agent==='codex'?jsonObject(fs.readFileSync(resultFile,'utf8')):extractClaudeResult(finals);return {value,sessionId,output:output.slice(-8000),malformed:parser.malformed};
  }catch(error){throw new AgentRunError(error instanceof Error?error.message:String(error));}finally{clearTimeout(timer);if(this.children.get(request.agent)===child)this.children.delete(request.agent);}
  } catch(error){failed=true;throw error;} finally {
   // An exception from a callback also stops its child. Retain the slot on an unconfirmed stop.
   try{if(stopLease)await stopLease();else if(owned)await this.stopOwned(owned);lease.release();}
   catch(error){lease.retain();if(!failed)throw error;}
   finally{if(owned){this.ownedStops.delete(owned);if(this.children.get(request.agent)===owned)this.children.delete(request.agent);}}
  }
 }
 private validateNative(){
  if(this.leases.initializationError)throw Error(this.leases.initializationError);if(process.platform!=='win32'||!this.native||!this.leases.directory)throw Error('Pinned Windows native agent supervision is not configured');safeExecutable(this.native.helperPath,this.native.helperSha256);
  if(!/^[a-f0-9]{64}$/.test(this.hostId)||this.native.armingTimeoutMs!==undefined&&(!Number.isSafeInteger(this.native.armingTimeoutMs)||this.native.armingTimeoutMs<100||this.native.armingTimeoutMs>14000)||this.native.stopTimeoutMs!==undefined&&(!Number.isSafeInteger(this.native.stopTimeoutMs)||this.native.stopTimeoutMs<100||this.native.stopTimeoutMs>15000))throw Error('Invalid trusted native transport identity or time bounds');
  const root=this.native.controlRoot;if(!path.isAbsolute(root)||path.resolve(root)!==root||root.includes('~')||root.startsWith('\\\\'))throw Error('Invalid private supervisor control root');
  for(const delegated of [this.config.repo,this.config.worktreeRoot,this.config.profileRoot])if(inside(delegated,root)||inside(root,delegated))throw Error('Agent control overlaps a delegated workspace/profile');
 }
 private journal(record:AgentLeaseRecord,provider:LeaseProvider){return new AgentLeaseJournal(this.leases,provider,record);}
 private nativeRunStopped(run:Readonly<RunIdentity>){
  if(run.ownership!=='native-job-v1'||!run.supervisor||!run.leaseToken||run.pid!==run.supervisor.armed.guardianPid||typeof run.sessionId!=='string'||run.sessionId.length===0)return false;
  try{const record=this.recordForRun(run);if(!record)return false;const state=this.journal(record,providerFor(run.agent)).read();return state.phase==='armed'&&agentLeaseDigest(state.supervisor)===agentLeaseDigest(run.supervisor)&&inspectSupervisedRun(state.supervisor).state==='stopped';}catch{return false;}
 }
 private recordForRun(run:Readonly<RunIdentity>):AgentLeaseRecord|undefined{
  const provider=providerFor(run.agent),slot=this.leases.peek(provider);
  if(slot.state==='occupied'&&slot.record.token===run.leaseToken)return this.matchesRun(slot.record,run)?slot.record:undefined;
  // A released run keeps its immutable original claim beside the journal.
  if(!this.leases.directory||!run.leaseToken||!/^[a-f0-9-]{36}$/i.test(run.leaseToken))return undefined;const directory=path.join(this.leases.directory,'runs',run.leaseToken);if(!fs.existsSync(directory))return undefined;ensureAgentLeaseDirectory(directory);const file=path.join(directory,'claim.json');const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>16384)return undefined;const record=JSON.parse(fs.readFileSync(file,'utf8')) as AgentLeaseRecord;return this.matchesRun(record,run)?record:undefined;
 }
 private matchesRun(record:AgentLeaseRecord,run:Readonly<RunIdentity>){return record.token===run.leaseToken&&record.owner==='development:'+run.sessionId&&record.native?.sessionId===run.sessionId&&record.native.hostId===this.hostId&&record.native.startedAt===run.startedAt;}
 private async creatorState(record:AgentLeaseRecord){if(!record.native){try{process.kill(record.pid,0);return 'alive' as const;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM'?'alive' as const:'unknown' as const;}}return this.native?.creatorState?this.native.creatorState(record):(await agentCreatorState(record.pid,record.native.creatorCreated)).state;}
 private noAck(state:AgentLeaseJournalState,record:AgentLeaseRecord){
  const directory=state.phase==='claimed'?path.join(record.native!.controlRoot,record.native!.controlToken):state.control.directory;
  if(fs.existsSync(path.join(directory,'ack.json')))return false;return state.phase!=='armed';
 }
 private async inspectLease(record:AgentLeaseRecord,provider:LeaseProvider,allowCancel=false,localNoDispatch=false){
  if(!record.native)return false;const journal=this.journal(record,provider),state=journal.read();
  if(state.phase==='armed'){
   let proof=inspectSupervisedRun(state.supervisor);if(proof.state!=='stopped'&&allowCancel)proof=await cancelSupervisedRun(state.supervisor,{timeoutMs:this.native?.stopTimeoutMs??12000});
   if(proof.state!=='stopped'&&!allowCancel&&proof.reason==='proof-missing'&&await this.creatorState(record)==='dead'){const until=Date.now()+1000;while(proof.state!=='stopped'&&proof.reason==='proof-missing'&&Date.now()<until){await sleep(20);proof=inspectSupervisedRun(state.supervisor);}}
   if(proof.state!=='stopped')return false;journal.settled(proof);return true;
  }
  if(!this.noAck(state,record)||!localNoDispatch&&await this.creatorState(record)!=='dead')return false;
  journal.settled({state:'not-dispatched',creatorCreated:record.native.creatorCreated});return true;
 }
 private async reconcileNativeRun(run:Readonly<RunIdentity>){
  try{const record=this.recordForRun(run);if(!record||!run.supervisor||run.ownership!=='native-job-v1')return {stopped:false,reason:'Exact native run/lease binding is unavailable'};
   const state=this.journal(record,providerFor(run.agent)).read();if(state.phase!=='armed'||agentLeaseDigest(state.supervisor)!==agentLeaseDigest(run.supervisor)||run.pid!==state.supervisor.armed.guardianPid)return {stopped:false,reason:'Saved native identity differs from its armed journal'};
   if(!await this.inspectLease(record,providerFor(run.agent),true))return {stopped:false,reason:'Exact native Job termination is unconfirmed'};
   const slot=this.leases.peek(providerFor(run.agent));if(slot.state==='occupied'&&slot.record.token===record.token){const result=await this.leases.reconcile(providerFor(run.agent),(current,provider)=>current.token===record.token?this.inspectLease(current,provider):Promise.resolve(false));if(result.state==='recovery-required'&&result.reason!=='active')return {stopped:false,reason:'Native lease ownership changed during recovery'};}
   return {stopped:true,reason:'Matching signed zero-process native Job proof'};
  }catch(error){return {stopped:false,reason:String((error as Error).message)};}
 }
 private async reconcileNativeLeases():Promise<AgentOwnershipLease[]>{
  const reports:AgentOwnershipLease[]=[];for(const provider of ['codex','claude-api'] as const){const agent=agentFor(provider),slot=this.leases.peek(provider);if(slot.state==='available'){reports.push({agent,state:'ready',...(this.unavailableReason?{reason:'Capacity is empty; dispatch unavailable: '+this.unavailableReason}:{})});continue;}if(slot.state==='unknown'){reports.push({agent,state:'unconfirmed',reason:this.leases.initializationError??'Provider lease is unreadable'});continue;}
   try{if(slot.active||await this.creatorState(slot.record)==='alive'){reports.push({agent,state:'busy',reason:'A live provider owner retains its slot'});continue;}
    const result=await this.leases.reconcile(provider,(record,key)=>this.inspectLease(record,key,false));reports.push(result.state==='available'||result.state==='recovered'?{agent,state:'ready',...(this.unavailableReason?{reason:'Capacity is empty; dispatch unavailable: '+this.unavailableReason}:{})}:{agent,state:'unconfirmed',reason:'Provider ownership recovery requires exact lifecycle proof'});
   }catch(error){reports.push({agent,state:'unconfirmed',reason:String((error as Error).message)});}
  }return reports;
 }
 private async stopNative(attempt:NativeAttempt){
  if(attempt.stopping)return attempt.stopping;
  attempt.stopping=Promise.resolve().then(async()=>{
   try{
    const state=attempt.journal.read();if(state.phase==='armed'){attempt.identity??=state.supervisor;return await this.inspectLease(attempt.lease.record,attempt.provider,true);}
    // No provider can start before the armed checkpoint and ACK. Stop only the
    // captured pre-ACK guardian handle; never reopen or signal a stored PID.
    if(!this.noAck(state,attempt.lease.record))return false;
    if(attempt.child&&attempt.child.exitCode===null&&attempt.child.signalCode===null)attempt.child.kill('SIGKILL');
    if(attempt.closed){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([attempt.closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Pre-ACK guardian close unconfirmed')),3000);})]);}finally{clearTimeout(timer);}}
    return await this.inspectLease(attempt.lease.record,attempt.provider,false,true);
   }catch(error){try{attempt.journal.uncertain(String((error as Error).message));}catch{}return false;}
  });attempt.controller.abort(Error('Owned agent Stop'));return attempt.stopping;
 }
 private async executeNative(request:AgentRequest):Promise<AgentResponse>{
  const generation=this.nativeStopGeneration,controller=new AbortController(),options=this.native!,sessionId=crypto.randomUUID(),provider=providerFor(request.agent),startedAt=new Date().toISOString();let creatorCreated:string;
  const requireLaunch=()=>{if(controller.signal.aborted)throw controller.signal.reason??Error('Owned agent stopped before dispatch');if(generation!==this.nativeStopGeneration)throw Error('Owned agent launch superseded by Stop');};
  this.pendingNativeLaunches.add(controller);
  try{this.validateNative();if(this.nativeAttempts.has(request.agent))throw new AgentCapacityBusy(request.agent);creatorCreated=await beforeStop((options.creatorIdentity??ownCreatorIdentity)(),controller.signal);requireLaunch();}
  finally{this.pendingNativeLaunches.delete(controller);}
  const cwd=fs.realpathSync.native(request.cwd);if(cwd.toLowerCase()!==path.resolve(request.cwd).toLowerCase())throw Error('Agent workspace contains an alias');ensureAgentLeaseDirectory(options.controlRoot);ensureAgentLeaseDirectory(this.leases.directory!);if(inside(cwd,this.leases.directory!)||inside(this.leases.directory!,cwd))throw Error('Global leases overlap the delegated workspace');
  const claim:AgentNativeLeaseClaim={protocol:'capri-native-agent-lease-v1',sessionId,hostId:this.hostId,creatorCreated,startedAt,controlRoot:options.controlRoot,controlToken:crypto.randomBytes(32).toString('hex'),helperPath:options.helperPath,helperSha256:options.helperSha256,workspaceSha256:digest(Buffer.from(cwd.toLowerCase(),'utf8'))};
  requireLaunch();let lease:AgentLease;try{lease=this.leases.acquire(provider,'development:'+sessionId,claim);}catch(error){if(isAgentLeaseBusy(error))throw new AgentCapacityBusy(request.agent);throw error;}
  let journal:AgentLeaseJournal;try{journal=this.journal(lease.record,provider);}catch(error){lease.retain();throw error;}
  const attempt:NativeAttempt={request,provider,lease,journal,controller};this.nativeAttempts.set(request.agent,attempt);let failure:unknown;
  try{
   await beforeStop(Promise.resolve(options.onCheckpoint?.('claimed',lease.record)),controller.signal);requireLaunch();
   const outputDir=path.resolve(request.outputDir);fs.mkdirSync(outputDir,{recursive:true});const schemaFile=path.join(outputDir,'schema.json'),resultFile=path.join(outputDir,'result.json');fs.writeFileSync(schemaFile,JSON.stringify(request.schema));
   const invocation=(options.invocation??buildInvocation)(this.config,request,sessionId,schemaFile,resultFile);safeExecutable(invocation.executable);
   const launch=prepareSupervisedLaunch({helperPath:options.helperPath,helperSha256:options.helperSha256,controlRoot:options.controlRoot,cwd,executable:invocation.executable,args:invocation.args,scopeSha256:agentLeaseDigest({provider,lease:lease.record}),token:claim.controlToken});attempt.journal.prepare(launch.control);await beforeStop(Promise.resolve(options.onCheckpoint?.('prepared',lease.record)),controller.signal);requireLaunch();
   const child=(options.spawnChild??spawn)(launch.executable,launch.args,{cwd,env:invocation.env,stdio:['pipe','pipe','pipe'],shell:false,...launch.spawnOptions});attempt.child=child;this.children.set(request.agent,child);child.on('error',()=>{});child.stdin!.on('error',()=>{});
   attempt.closed=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});void attempt.closed.catch(()=>{});
   const finals:any[]=[],callbacks:Promise<void>[]=[];let output='',errorOutput='',failed:unknown,hasFailure=false,timedOut=false,rejectCallback:(error:unknown)=>void=()=>{};const callbackFailure=new Promise<never>((_,reject)=>{rejectCallback=reject;});void callbackFailure.catch(()=>{});
   const fail=(error:unknown)=>{if(hasFailure)return;hasFailure=true;failed=error??Error('Owned agent callback failed');rejectCallback(failed);attempt.controller.abort(failed);void this.stopNative(attempt);};
   const aborted=()=>fail(attempt.controller.signal.reason??Error('Owned agent aborted'));attempt.controller.signal.addEventListener('abort',aborted,{once:true});
   const parser=new JsonLines(record=>{if(record.type==='result')finals.push(record);if(attempt.run){try{const callback=Promise.resolve(this.onRecord(attempt.run,record));callbacks.push(callback);void callback.catch(fail);}catch(error){fail(error);}}});
   child.stdout!.on('data',buffer=>{try{const chunk=buffer.toString();output=(output+chunk).slice(-65536);fs.appendFileSync(path.join(outputDir,'events.jsonl'),redact(chunk));parser.push(chunk);}catch(error){fail(error);}});child.stderr!.on('data',buffer=>{try{const chunk=redact(buffer.toString());errorOutput=(errorOutput+chunk).slice(-16384);fs.appendFileSync(path.join(outputDir,'stderr.log'),chunk);}catch(error){fail(error);}});
   const timer=setTimeout(()=>{timedOut=true;fail(Error('Agent attempt exceeded '+(request.timeoutMs||this.config.timeoutMs)+' ms'));},request.timeoutMs||this.config.timeoutMs);
   try{
    await armSupervisedRun(launch.control,child,{timeoutMs:options.armingTimeoutMs??10000,signal:attempt.controller.signal,onArmed:async identity=>{
     attempt.identity=identity;attempt.journal.arm(identity);await beforeStop(Promise.resolve(options.onCheckpoint?.('armed',lease.record)),controller.signal);requireLaunch();
     const run:LeaseRunIdentity={pid:child.pid||0,marker:invocation.marker,agent:request.agent,mode:request.mode,taskId:request.taskId,sessionId,startedAt,leaseToken:lease.token,ownership:'native-job-v1',supervisor:identity};attempt.run=run;await this.onStart(run);requireLaunch();
    }});
    if(attempt.controller.signal.aborted)throw attempt.controller.signal.reason;child.stdin!.end(request.prompt);
    const code=await Promise.race([attempt.closed,callbackFailure]);parser.end();await Promise.race([Promise.all(callbacks),callbackFailure]);if(hasFailure)throw failed;if(timedOut)throw Error('Agent attempt exceeded its timeout');if(code!==0)throw Error((errorOutput+'\n'+output).slice(-18000)||'Agent exited '+code);
    const value=request.agent==='codex'?jsonObject(fs.readFileSync(resultFile,'utf8')):extractClaudeResult(finals);return {value,sessionId,output:output.slice(-8000),malformed:parser.malformed};
   }finally{clearTimeout(timer);attempt.controller.signal.removeEventListener('abort',aborted);}
  }catch(error){failure=error??Error('Owned agent launch/callback failed');throw failure instanceof AgentRunError?failure:new AgentRunError(failure instanceof Error?failure.message:String(failure));}
  finally{
   const stopped=await this.stopNative(attempt);lease.retain();let released=false;
   if(stopped){try{const result=await this.leases.reconcile(provider,(current,key)=>current.token===lease.token?this.inspectLease(current,key,false,true):Promise.resolve(false));released=result.state==='recovered'||result.state==='available';}catch(error){try{attempt.journal.uncertain(String((error as Error).message));}catch{}}}
   if(!released)try{attempt.journal.uncertain('Exact owned termination/release remains unconfirmed');}catch{}
   this.nativeAttempts.delete(request.agent);if(this.children.get(request.agent)===attempt.child)this.children.delete(request.agent);if(!released&&!failure)throw new AgentStopUnconfirmed('Exact native agent termination is unconfirmed');
  }
 }
 async stop(){this.nativeStopGeneration++;for(const controller of this.pendingNativeLaunches)controller.abort(Error('Owned agent stopped before dispatch'));const native=await Promise.all([...this.nativeAttempts.values()].map(attempt=>this.stopNative(attempt)));await Promise.all([...this.children.values()].filter(child=>![...this.nativeAttempts.values()].some(attempt=>attempt.child===child)).map(child=>this.stopOwned(child)));if(native.some(stopped=>!stopped))throw new AgentStopUnconfirmed('Exact native agent Stop is unconfirmed');}
}

/** Trusted native integration only. launch must durably register exact-token
 * ownership before provider execution/ACK; no raw spawn wrapper can satisfy it.
 */
export interface AgentProcessLifecycle {
 launch(command:string,args:string[],options:Parameters<typeof spawn>[2],record:AgentLeaseRecord,provider:LeaseProvider):ChildProcess;
 stop(record:AgentLeaseRecord,provider:LeaseProvider):Promise<void>;
 inspectStopped:AgentLeaseInspector;
}

export async function runCommand(command:string,args:string[],cwd:string,timeoutMs=300000,signal?:AbortSignal):Promise<{code:number|null;output:string}>{
 if(command==='node')command=process.execPath;
 if(/\.(?:cmd|bat)$/i.test(command))throw Error('Use an executable directly for checks, rather than a batch shell: '+command);
 return new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});let output='',timedOut=false;const add=(b:Buffer)=>{output=(output+redact(b.toString())).slice(-30000);};child.stdout!.on('data',add);child.stderr!.on('data',add);const timer=setTimeout(()=>{timedOut=true;void terminateTree(child).catch(reject);},timeoutMs);const abort=()=>void terminateTree(child).catch(reject);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();child.once('error',e=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(e);});child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve({code:timedOut||signal?.aborted?-1:code,output:(timedOut?'Command timed out.\n':'')+output});});});
}
