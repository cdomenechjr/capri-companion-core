// Trusted transport only. Never construct these options/identities from model
// arguments or rediscover a public key from a terminal record after a restart.
// Persist the identity in onArmed BEFORE ACK; only then can child code execute.
// The control root belongs outside every delegated workspace/profile export.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';

const hex=/^[a-f0-9]{64}$/;
const hash=(value:crypto.BinaryLike)=>crypto.createHash('sha256').update(value).digest('hex');
const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const contains=(root:string,file:string)=>{const relative=path.relative(root,file);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const exact=(value:any,fields:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const integer=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>0;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function safePath(value:string,directory:boolean){
 if(typeof value==='string'&&process.platform==='win32')value=value.replaceAll('/',path.sep);
 if(typeof value!=='string'||!path.isAbsolute(value)||value.includes('\0')||value.includes('~')||value.startsWith('\\\\')||!same(path.resolve(value),value))throw Error('Supervisor paths must be canonical absolute local paths.');
 let current=path.parse(value).root;for(const part of path.relative(current,value).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('Supervisor paths cannot contain aliases.');}
 const info=fs.lstatSync(value);if(info.isDirectory()!==directory||!directory&&(!info.isFile()||info.nlink!==1)||!same(fs.realpathSync.native(value),value))throw Error('Supervisor path identity changed.');
 return value;
}
function readFile(file:string){safePath(file,false);const fd=fs.openSync(file,'r');try{const info=fs.fstatSync(fd);if(!info.isFile()||info.nlink!==1||info.size<1||info.size>16384)throw Error('Invalid supervisor record.');const bytes=fs.readFileSync(fd);if(bytes.length!==info.size)throw Error('Supervisor record changed while reading.');return bytes;}finally{fs.closeSync(fd);}}
function read(file:string){const bytes=readFile(file);return {bytes,value:JSON.parse(bytes.toString('utf8'))};}
function writeNew(file:string,value:unknown){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function supervisorCommandHash(executable:string,args:readonly string[]){const chunks:Buffer[]=[];for(const value of [executable,...args]){const bytes=Buffer.from(value,'utf8'),length=Buffer.alloc(4);length.writeInt32LE(bytes.length);chunks.push(length,bytes);}return hash(Buffer.concat(chunks));}
export type SupervisorControl={root:string;directory:string;token:string;scopeSha256:string;helperPath:string;helperSha256:string;creatorPid:number;cwdSha256:string;commandSha256:string;requestSha256:string};
export type SupervisorArmed={schemaVersion:1;token:string;requestSha256:string;scopeSha256:string;helperPath:string;helperSha256:string;creatorPid:number;creatorCreated:string;guardianPid:number;guardianCreated:string;cwdSha256:string;commandSha256:string;jobId:string;publicKey:string;armedAt:string};
export type SupervisorIdentity=SupervisorControl&{armedSha256:string;armed:SupervisorArmed};
export type SupervisorProof={schemaVersion:1;token:string;requestSha256:string;armedSha256:string;jobId:string;activeProcesses:0;reason:'main-exited'|'creator-exited'|'cancelled'|'guardian-error';mainExitCode:number|null;finishedAt:string};
export type SupervisorInspection={state:'stopped';proof:SupervisorProof;terminalSha256:string}|{state:'recovery-required';reason:'proof-missing'|'binding-invalid'|'proof-invalid'};
const requestFields=['schemaVersion','token','scopeSha256','helperPath','helperSha256','creatorPid','cwdSha256','commandSha256'];
const armedFields=[...requestFields.filter(field=>field!=='schemaVersion'), 'requestSha256','schemaVersion','creatorCreated','guardianPid','guardianCreated','jobId','publicKey','armedAt'];
const controlFields=['root','directory','token','scopeSha256','helperPath','helperSha256','creatorPid','cwdSha256','commandSha256','requestSha256'];
function requestValue(c:SupervisorControl){return {schemaVersion:1,token:c.token,scopeSha256:c.scopeSha256,helperPath:c.helperPath,helperSha256:c.helperSha256,creatorPid:c.creatorPid,cwdSha256:c.cwdSha256,commandSha256:c.commandSha256};}
function validateControl(c:SupervisorControl){
 if(!c||[c.token,c.scopeSha256,c.helperSha256,c.requestSha256,c.cwdSha256,c.commandSha256].some(value=>!hex.test(value))||!integer(c.creatorPid))throw Error('Invalid trusted supervisor control identity.');
 safePath(c.root,true);safePath(c.directory,true);if(!same(c.directory,path.join(c.root,c.token)))throw Error('Supervisor control escaped its trusted root.');
 const record=read(path.join(c.directory,'request.json'));if(!exact(record.value,requestFields)||hash(record.bytes)!==c.requestSha256||JSON.stringify(record.value)!==JSON.stringify(requestValue(c)))throw Error('Supervisor request binding changed.');
}
function validateArmed(c:SupervisorControl,value:any):asserts value is SupervisorArmed{
 if(!exact(value,armedFields)||value.schemaVersion!==1||!integer(value.guardianPid)||!/^\d{1,20}$/.test(value.creatorCreated)||!/^\d{1,20}$/.test(value.guardianCreated)||BigInt(value.creatorCreated)<=0n||BigInt(value.guardianCreated)<BigInt(value.creatorCreated)||!hex.test(value.jobId)||typeof value.publicKey!=='string'||value.publicKey.length>1024||!Number.isFinite(Date.parse(value.armedAt)))throw Error('Invalid armed supervisor identity.');
 for(const key of ['token','requestSha256','scopeSha256','helperPath','helperSha256','creatorPid','cwdSha256','commandSha256'] as const)if(value[key]!==c[key]&&!(key==='helperPath'&&same(value[key],c[key])))throw Error('Armed supervisor does not match the prepared run.');
 const key=crypto.createPublicKey({key:Buffer.from(value.publicKey,'base64'),format:'der',type:'spki'});if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error('Unexpected supervisor proof key.');
}
/** The helper executable/hash, control root, exact argv and scope digest are
 * trusted host configuration. scopeSha256 should bind provider/lease/session.
 * This function never spawns, reads auth, or consults a global lease/profile. */
export function prepareSupervisedLaunch(options:{helperPath:string;helperSha256:string;controlRoot:string;cwd:string;executable:string;args:readonly string[];scopeSha256:string;excludedRoots?:readonly string[];token?:string}){
 if(process.platform!=='win32')throw Error('The native supervisor control protocol requires Windows.');
 const helperPath=safePath(options.helperPath,false),cwd=safePath(options.cwd,true),executable=safePath(options.executable,false),root=safePath(options.controlRoot,true);
 if(!helperPath.toLowerCase().endsWith('.exe')||!executable.toLowerCase().endsWith('.exe')||!hex.test(options.helperSha256)||hash(fs.readFileSync(helperPath))!==options.helperSha256||!hex.test(options.scopeSha256)||!Array.isArray(options.args)||options.args.some(arg=>typeof arg!=='string'||arg.includes('\0')))throw Error('Invalid trusted supervisor executable, scope or arguments.');
 for(const proposed of [cwd,...options.excludedRoots||[]]){const excluded=safePath(proposed,true);if(contains(excluded,root)||contains(root,excluded))throw Error('Supervisor control overlaps a delegated workspace.');}
 const token=options.token??crypto.randomBytes(32).toString('hex');if(!hex.test(token))throw Error('Invalid supervisor run token.');
 const directory=path.join(root,token);fs.mkdirSync(directory,{mode:0o700});
 const partial={root,directory,token,scopeSha256:options.scopeSha256,helperPath,helperSha256:options.helperSha256,creatorPid:process.pid,cwdSha256:hash(Buffer.from(cwd.toLowerCase(),'utf8')),commandSha256:supervisorCommandHash(executable,options.args)};
 const record=requestValue({...partial,requestSha256:''});writeNew(path.join(directory,'request.json'),record);
 const control:SupervisorControl={...partial,requestSha256:hash(readFile(path.join(directory,'request.json')))};
 // Node's Windows creator Job can otherwise kill a non-detached guardian before
 // it writes creator-loss proof. Only the guardian is detached; the provider is
 // still created suspended inside its native owned Job. No permission bypass.
 const spawnOptions:Readonly<{detached:true;windowsHide:true}>=Object.freeze({detached:true,windowsHide:true});
 return {executable:helperPath,args:['--control',directory,'--token',token,'--',executable,...options.args],control,spawnOptions};
}
function beforeDeadline(deadline:number,signal?:AbortSignal){if(signal?.aborted)throw signal.reason??Error('Supervisor arming aborted.');if(Date.now()>=deadline)throw Error('Supervisor arming deadline expired.');}
function boundedArming<T>(work:Promise<T>,deadline:number,signal?:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  let done=false;const finish=(failed:boolean,error?:unknown,value?:T)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);failed?reject(error??Error('Supervisor persistence callback rejected.')):resolve(value as T);};
  const abort=()=>finish(true,signal?.reason??Error('Supervisor arming aborted.')),timer=setTimeout(()=>finish(true,Error('Supervisor arming deadline expired.')),Math.max(1,deadline-Date.now()));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  work.then(value=>{try{beforeDeadline(deadline,signal);finish(false,undefined,value);}catch(error){finish(true,error);}},error=>finish(true,error));
 });
}
/** Captured native publisher invocation, also useful for neutral transport tests.
 * Its prepared stdout handshake is not provider output. It publishes only after
 * stdin 'commit'; EOF, creator death or deadline expiry leaves no target record. */
export function supervisorMessageInvocation(identity:SupervisorIdentity,kind:'ack'|'cancel',deadlineUnixMs=0){
 validateControl(identity);validateArmed(identity,identity.armed);
 if(!hex.test(identity.armedSha256)||!['ack','cancel'].includes(kind)||!Number.isSafeInteger(deadlineUnixMs)||kind==='ack'&&deadlineUnixMs<=Date.now()||kind==='cancel'&&deadlineUnixMs!==0)throw Error('Invalid exact supervisor message binding.');
 const executable=safePath(identity.helperPath,false);if(hash(fs.readFileSync(executable))!==identity.helperSha256)throw Error('Supervisor publisher executable changed.');
 return {executable,args:['--control-message',identity.directory,'--token',identity.token,'--binding',identity.armedSha256,'--kind',kind,'--deadline',String(deadlineUnixMs)]};
}
async function publishNative(identity:SupervisorIdentity,kind:'ack'|'cancel',deadline:number,signal?:AbortSignal){
 beforeDeadline(deadline,signal);const invocation=supervisorMessageInvocation(identity,kind,kind==='ack'?deadline:0);beforeDeadline(deadline,signal);
 await new Promise<void>((resolve,reject)=>{
  const child=spawn(invocation.executable,invocation.args,{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});let output='',failure:unknown,committed=false,done=false;
  const stop=(error:unknown)=>{failure??=error;child.stdin.end();try{child.kill('SIGKILL');}catch{}};
  const timer=setTimeout(()=>stop(Error('Supervisor control publication deadline expired.')),Math.max(1,deadline-Date.now())),abort=()=>stop(signal?.reason??Error('Supervisor arming aborted.'));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();child.stdin.on('error',()=>{});child.stderr.resume();
  child.stdout.on('data',chunk=>{try{output+=chunk.toString('utf8');if(output.length>1024)throw Error('Invalid supervisor publisher handshake.');if(output.includes('\n')&&!committed){if(output.trim()!=='{"prepared":true}')throw Error('Invalid supervisor publisher handshake.');beforeDeadline(deadline,signal);committed=true;child.stdin.end('commit\n');}}catch(error){stop(error);}});
  const finish=(error?:unknown)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
  child.once('error',error=>finish(error));child.once('close',code=>finish(failure||code!==0||!committed?failure||Error('Supervisor control publication failed.'):undefined));
 });
}
/** Persist onArmed's exact identity outside the delegated workspace before this
 * function ACKs. Returning it only after launch without persistence is unsafe
 * for creator-crash recovery. A failed callback never authorizes child launch. */
export async function armSupervisedRun(control:SupervisorControl,child:Pick<ChildProcess,'pid'|'exitCode'|'signalCode'>,options:{onArmed:(identity:SupervisorIdentity)=>void|Promise<void>;timeoutMs?:number;signal?:AbortSignal}):Promise<SupervisorIdentity>{
 validateControl(control);if(!integer(child.pid)||typeof options.onArmed!=='function')throw Error('Captured guardian and durable arming callback are required.');
 const timeout=options.timeoutMs??10000;if(!Number.isSafeInteger(timeout)||timeout<100||timeout>14000)throw Error('Invalid supervisor arming timeout.');
 const deadline=Date.now()+timeout;let identity:SupervisorIdentity|undefined;
 try{
  let record:ReturnType<typeof read>|undefined;
  while(Date.now()<deadline){beforeDeadline(deadline,options.signal);try{record=read(path.join(control.directory,'armed.json'));break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(child.exitCode!==null||child.signalCode!==null)throw Error('Guardian exited before arming.');await sleep(Math.min(10,Math.max(1,deadline-Date.now())));}
  beforeDeadline(deadline,options.signal);if(!record)throw Error('Guardian did not arm within its bounded deadline.');validateArmed(control,record.value);
  if(record.value.guardianPid!==child.pid||hash(fs.readFileSync(safePath(control.helperPath,false)))!==control.helperSha256)throw Error('Captured guardian identity changed.');
  identity={...control,armedSha256:hash(record.bytes),armed:record.value};beforeDeadline(deadline,options.signal);
  await boundedArming(Promise.resolve().then(()=>options.onArmed(structuredClone(identity!))),deadline,options.signal);
  beforeDeadline(deadline,options.signal);validateControl(control);
  if(child.exitCode!==null||child.signalCode!==null)throw Error('Guardian exited before acknowledgement.');
  if(hash(readFile(path.join(control.directory,'armed.json')))!==identity.armedSha256)throw Error('Guardian binding changed before acknowledgement.');
  beforeDeadline(deadline,options.signal);await publishNative(identity,'ack',deadline,options.signal);beforeDeadline(deadline,options.signal);return identity;
 }catch(error){
  // An unresolved/late callback has no continuation that can ACK. Cleanup uses
  // a separate bounded native cancellation; it never force-kills the guardian.
  if(identity)await publishNative(identity,'cancel',Date.now()+2500).catch(()=>{});
  throw error;
 }
}
/** Read-only: the caller must supply its DURABLY PINNED identity from onArmed,
 * never construct it from disk claims. Missing guardian/Job names/PIDs provide
 * no evidence. Signed active-count-zero proof is the only stopped result. */
export function inspectSupervisedRun(identity:SupervisorIdentity):SupervisorInspection{
 try{
  if(!exact(identity,[...controlFields,'armedSha256','armed'])||!hex.test(identity.armedSha256))throw Error('Invalid pinned supervisor identity.');
  validateControl(identity);validateArmed(identity,identity.armed);
  const armed=read(path.join(identity.directory,'armed.json'));if(hash(armed.bytes)!==identity.armedSha256||JSON.stringify(armed.value)!==JSON.stringify(identity.armed))throw Error('Pinned guardian binding changed.');
  let terminal:ReturnType<typeof read>;try{terminal=read(path.join(identity.directory,'terminal.json'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {state:'recovery-required',reason:'proof-missing'};throw error;}
  const envelope=terminal.value;if(!exact(envelope,['schemaVersion','payload','signature'])||envelope.schemaVersion!==1||typeof envelope.payload!=='string'||envelope.payload.length>8192||typeof envelope.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature))throw Error('Invalid terminal envelope.');
  const key=crypto.createPublicKey({key:Buffer.from(identity.armed.publicKey,'base64'),format:'der',type:'spki'});
  if(!crypto.verify('sha256',Buffer.from(envelope.payload,'utf8'),{key,dsaEncoding:'ieee-p1363'},Buffer.from(envelope.signature,'base64')))throw Error('Invalid terminal signature.');
  const proof=JSON.parse(envelope.payload);
  if(!exact(proof,['schemaVersion','token','requestSha256','armedSha256','jobId','activeProcesses','reason','mainExitCode','finishedAt'])||proof.schemaVersion!==1||proof.token!==identity.token||proof.requestSha256!==identity.requestSha256||proof.armedSha256!==identity.armedSha256||proof.jobId!==identity.armed.jobId||proof.activeProcesses!==0||!['main-exited','creator-exited','cancelled','guardian-error'].includes(proof.reason)||proof.mainExitCode!==null&&(!Number.isInteger(proof.mainExitCode)||proof.mainExitCode<0||proof.mainExitCode>0xffffffff)||!Number.isFinite(Date.parse(proof.finishedAt))||Date.parse(proof.finishedAt)<Date.parse(identity.armed.armedAt))throw Error('Terminal proof does not bind this zero-process Job.');
  return {state:'stopped',proof,terminalSha256:hash(terminal.bytes)};
 }catch{return {state:'recovery-required',reason:'proof-invalid'};}
}
/** Cancellation addresses the pinned sidechannel, never a reopened PID. Forced
 * guardian death has no synthetic fallback proof and remains recovery-required. */
export async function cancelSupervisedRun(identity:SupervisorIdentity,options:{timeoutMs?:number;pollMs?:number}={}):Promise<SupervisorInspection>{
 const timeout=options.timeoutMs??12000,poll=options.pollMs??20;if(!Number.isSafeInteger(timeout)||timeout<100||timeout>15000||!Number.isSafeInteger(poll)||poll<5||poll>100)throw Error('Invalid supervisor cancellation bounds.');
 const before=inspectSupervisedRun(identity);if(before.state==='stopped'||before.reason!=='proof-missing')return before;
 try{await publishNative(identity,'cancel',Date.now()+Math.min(timeout,3000));}catch{return inspectSupervisedRun(identity);}
 const deadline=Date.now()+timeout;while(Date.now()<deadline){const result=inspectSupervisedRun(identity);if(result.state==='stopped'||result.reason!=='proof-missing')return result;await sleep(poll);}return {state:'recovery-required',reason:'proof-missing'};
}
