// Original Capri managed host. Operator configuration is public trust metadata;
// this module never imports the broker's signing/identity implementation.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {lstatSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,execFile,execFileSync,type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {Readable,Writable} from 'node:stream';
import {z} from 'zod';
import {acquireProfileWriter,managedDirectory,readProfileProtectionContext,readProtectionFile,prepareProtectedDesktopContext} from '../desktop/runtime-profile';
import {canonicalJson,featureCapability,releasePolicy} from './policy';
import {SignedUpdateEngine,UpdateStateSchema,createUpdateDisk,createPinnedUpdateTransport,inspectUpdateZip,compareUpdateVersions,type UpdateDisk,type UpdateHost,type UpdateSnapshot,type UpdateIdle,type UpdateState,type UpdateTransport} from './updates';
import {prepareSupervisedLaunch,armSupervisedRun,cancelSupervisedRun,inspectSupervisedRun,type SupervisorControl,type SupervisorIdentity} from './supervisor';
import {ActionReceiptSchema,type ExtensionModule,type ExtensionFeatureStatus,type ExtensionActionContext} from './contracts';

export const managedHash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const sha=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid();
const pin=z.object({path:z.string().min(1),sha256:sha}).strict();
export const ManagedConfigSchema=z.object({schemaVersion:z.literal(1),installationId:uuid,ownerSha256:sha,
 root:z.string(),profilesRoot:z.string(),appData:z.string(),port:z.number().int().min(1024).max(65535),
 node:pin,controller:pin,launcher:pin,supervisor:pin,windowsHelper:pin,
 maintenance:z.object({root:z.string(),snapshot:UpdateStateSchema.shape.active}).strict(),
 brokerJournal:z.string(),attestationRoot:z.string(),feed:z.object({origin:z.string(),ca:z.string().max(32768),certificateSha256:sha}).strict(),
 keys:z.record(z.string(),z.string()),channel:z.enum(['stable','preview']),arch:z.enum(['x64','arm64']),minimumSequence:z.number().int().nonnegative().safe(),
 dataVersion:z.literal(1),pollMs:z.number().int().min(1000).max(3600000).default(30000)}).strict();
export type ManagedConfig=z.infer<typeof ManagedConfigSchema>;
export type ManagedTrust={config:ManagedConfig;file:string;sha256:string;assert():Promise<void>};
const inside=(parent:string,child:string)=>{const r=path.relative(parent.toLowerCase(),child.toLowerCase());return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
export function managedOwnerSha256(){return managedHash('capri-managed-owner-v1\0'+os.userInfo().username+'\0'+os.homedir());}
export async function readManagedFile(file:string,max=32*1024*1024):Promise<Buffer>{
 if(!path.isAbsolute(file)||path.resolve(file)!==file)throw Error('Canonical managed file required.');
 const disk=createUpdateDisk(path.dirname(file),async()=>{});
 // Do not walk unrelated siblings/private material. read() checks every ancestor.
 return disk.read(path.basename(file),max);
}
export async function loadManagedTrust(file:string,digest:string,appData?:string):Promise<ManagedTrust>{
 if(!sha.safeParse(digest).success)throw Error('Pinned managed configuration required.');
 const bytes=await readManagedFile(file,65536);if(managedHash(bytes)!==digest)throw Error('Managed trust changed.');
 const config=ManagedConfigSchema.parse(JSON.parse(bytes.toString()));
 if(config.ownerSha256!==managedOwnerSha256()||appData&&path.resolve(appData).toLowerCase()!==config.appData.toLowerCase())throw Error('Managed owner changed.');
 const dirs=[config.root,config.profilesRoot,config.attestationRoot,config.maintenance.root];
 for(const dir of dirs)managedDirectory(dir,config.appData);
 if(inside(config.root,config.profilesRoot)||inside(config.profilesRoot,config.root))throw Error('Profiles must be outside replaceable update storage.');
 if(inside(config.root,config.maintenance.root)||inside(config.maintenance.root,config.root)||inside(config.profilesRoot,config.maintenance.root)||inside(config.maintenance.root,config.profilesRoot))throw Error('Pinned maintenance runtime must be independent of snapshots/profiles.');
 for(const artifact of [config.node,config.controller,config.launcher,config.supervisor,config.windowsHelper]){
  managedDirectory(path.dirname(artifact.path),config.appData);
  if(inside(config.root,artifact.path)||inside(config.profilesRoot,artifact.path)||managedHash(await readManagedFile(artifact.path,512*1024*1024))!==artifact.sha256)throw Error('External runtime pin changed.');
 }
 if(inside(config.root,file)||inside(config.profilesRoot,file))throw Error('Trust must survive profile/snapshot replacement.');
 // Validate the dedicated transport before constructing any controller or app.
 createPinnedUpdateTransport(config.feed);
 const assert=async()=>{if(managedHash(await readManagedFile(file,65536))!==digest||config.ownerSha256!==managedOwnerSha256())throw Error('Managed trust/owner changed.');
  for(const dir of [config.root,config.profilesRoot])managedDirectory(dir,config.appData);
  const records=[file,path.join(config.root,'host.json'),path.join(config.root,'state.json'),path.join(config.root,'protection-context.json'),path.join(config.root,'backup-key.dpapi'),path.join(config.root,'control-key.dpapi'),path.join(config.profilesRoot,'.capri-managed.json')];
  const existing:string[]=[];for(const record of records){try{const info=await fs.lstat(record);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error('Managed authority record is aliased.');existing.push(record);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  await assertManagedProtection([config.root,config.profilesRoot,config.maintenance.root,path.dirname(file),config.attestationRoot,path.dirname(config.brokerJournal),...existing,... [config.node,config.controller,config.launcher,config.supervisor,config.windowsHelper].flatMap(p=>[path.dirname(p.path),p.path])]);
 };await assert();
 return {config,file,sha256:digest,assert};
}
function protectionInvocation(paths:readonly string[]){
 if(process.platform!=='win32')throw Error('Windows managed protection unavailable.');
 const encoded=Buffer.from(JSON.stringify([...new Set(paths)])).toString('base64');
 const script="$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$allowed=@($sid,'S-1-5-18','S-1-5-32-544');$paths=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"')));foreach($p in $paths){$a=Get-Acl -LiteralPath $p;$owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;if($allowed -notcontains $owner){throw 'Foreign owner'};foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and ([int64]$r.FileSystemRights -band 852310) -ne 0 -and $allowed -notcontains $r.IdentityReference.Value){throw 'Foreign writable access'}}};Write-Output 'protected'";
 return {executable:path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]};
}
export function assertManagedProtectionSync(paths:readonly string[]){
 const call=protectionInvocation(paths),result=execFileSync(call.executable,call.args,{windowsHide:true,timeout:15000,maxBuffer:4096,encoding:'utf8'}).trim();
 if(result!=='protected')throw Error('Managed protection unconfirmed.');
}
export async function assertManagedProtection(paths:readonly string[]){
 const call=protectionInvocation(paths);
 const result=await new Promise<string>((resolve,reject)=>execFile(call.executable,call.args,{windowsHide:true,timeout:15000,maxBuffer:4096},(e,out)=>e?reject(Error('Managed storage ownership/protection unavailable.')):resolve(out.trim())));
 if(result!=='protected')throw Error('Managed protection unconfirmed.');
}
export function managedGeneration(config:ManagedConfig,generation:string){uuid.parse(generation);return managedDirectory(path.join(config.profilesRoot,generation),config.appData);}

/** Synchronous path selection only, before Electron ready. No keys/Stores are
 * opened here. Full asynchronous resource/ACL trust and writer checks still
 * precede all vault access. Reject unpinned input before creating Chromium data. */
export function managedDesktopData(appData:string,profile:string,maintenance:boolean,env:NodeJS.ProcessEnv=process.env){
 const file=env.CAPRI_MANAGED_TRUST!,digest=env.CAPRI_MANAGED_TRUST_SHA256!;
 if(!sha.safeParse(digest).success||!file||!path.isAbsolute(file)||path.resolve(file)!==file)throw Error('Pinned managed configuration required.');
 managedDirectory(path.dirname(file),appData);
 const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>65536)throw Error('Invalid managed trust file.');
 const bytes=readFileSync(file),after=lstatSync(file);managedDirectory(path.dirname(file),appData);
 if(after.isSymbolicLink()||after.nlink!==1||after.ino!==info.ino||after.dev!==info.dev||after.mtimeMs!==info.mtimeMs||after.ctimeMs!==info.ctimeMs||after.size!==info.size||bytes.length!==info.size||managedHash(bytes)!==digest)throw Error('Managed trust changed.');
 const c=ManagedConfigSchema.parse(JSON.parse(bytes.toString()));
 if(c.ownerSha256!==managedOwnerSha256()||c.appData.toLowerCase()!==path.resolve(appData).toLowerCase())throw Error('Managed owner changed.');
 uuid.parse(env.CAPRI_MANAGED_EPOCH);if(!sha.safeParse(env.CAPRI_MANAGED_CHANNEL).success)throw Error('Captured managed context required.');
 managedDirectory(c.root,appData);managedDirectory(c.profilesRoot,appData);
 if(inside(c.root,c.profilesRoot)||inside(c.profilesRoot,c.root)||inside(c.root,file)||inside(c.profilesRoot,file))throw Error('Managed paths must remain independent.');
 if(managedGeneration(c,env.CAPRI_MANAGED_GENERATION!)!==profile)throw Error('Managed physical profile mismatch.');
 return maintenance?managedDirectory(path.join(c.root,'maintenance-electron',env.CAPRI_MANAGED_EPOCH!),appData):profile;
}

const ProtectionBinding=z.object({schemaVersion:z.literal(1),installationId:uuid,ownerSha256:sha,contextSha256:sha}).strict();
/** Immutable, private host association; its digest covers only the selected
 * profile's DPAPI-wrapped OSCrypt field. Existing backup keys never bootstrap it.
 * Keep this file with the original backup-key.dpapi in the protected, stable
 * managed root across closed copies/recovery. Complete profile archives already
 * retain Local State; rollback never replaces this host association or the key.
 * This is same authorized Windows-user context continuity, not a promise of
 * cross-user/machine DPAPI portability. No browser/default-profile discovery. */
export async function bindManagedProtectionContext(trust:ManagedTrust,generation:string,gate:{owned():boolean}){
 const owned=()=>{if(!gate.owned())throw Error('Protection context writer ownership lost.');};owned();await trust.assert();owned();const c=trust.config,context=readProfileProtectionContext(managedGeneration(c,generation),c.appData);
 const binding={schemaVersion:1 as const,installationId:c.installationId,ownerSha256:c.ownerSha256,contextSha256:managedHash(context)},file=path.join(c.root,'protection-context.json');
 try{const old=ProtectionBinding.parse(JSON.parse((await readManagedFile(file,4096)).toString()));if(canonicalJson(old)!==canonicalJson(binding))throw Error('Managed protection context changed.');return;}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 try{await fs.lstat(path.join(c.root,'backup-key.dpapi'));throw Error('Existing backup key context unavailable.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 await trust.assert();owned();const h=await fs.open(file,'wx',0o600);try{owned();await h.writeFile(canonicalJson(binding));await h.sync();}finally{await h.close();}
 assertManagedProfileContext(c,generation);
}
export function assertManagedProfileContext(c:ManagedConfig,generation:string){
 const binding=ProtectionBinding.parse(JSON.parse(readProtectionFile(path.join(c.root,'protection-context.json'),c.appData,4096).toString()));
 if(binding.installationId!==c.installationId||binding.ownerSha256!==c.ownerSha256||binding.contextSha256!==managedHash(readProfileProtectionContext(managedGeneration(c,generation),c.appData)))throw Error('Managed protection context mismatch.');
}

/** An elected normal owner must be the controller's CURRENT launch, before
 * Chromium initializes the selected original profile. Duplicate election is
 * resolved first, so an ordinary second launch still focuses and exits quietly. */
export function assertManagedNormalStartupContext(appData:string,profile:string,env:NodeJS.ProcessEnv,gate:{owned():boolean}){
 if(!gate.owned())throw Error('Protection context writer ownership lost.');managedDesktopData(appData,profile,false,env);
 const c=ManagedConfigSchema.parse(JSON.parse(readProtectionFile(env.CAPRI_MANAGED_TRUST!,appData,65536).toString()));
 const journal=JSON.parse(readProtectionFile(path.join(c.root,'host.json'),appData,1024*1024).toString()),state=UpdateStateSchema.parse(JSON.parse(readProtectionFile(path.join(c.root,'state.json'),appData,1024*1024).toString()));
 if(journal.installationId!==c.installationId||journal.ownerSha256!==c.ownerSha256||journal.trustSha256!==env.CAPRI_MANAGED_TRUST_SHA256||journal.epoch!==env.CAPRI_MANAGED_EPOCH||journal.generation!==env.CAPRI_MANAGED_GENERATION||!['starting','quiescent'].includes(journal.phase)||!env.CAPRI_UPDATE_NONCE||state.nonce!==env.CAPRI_UPDATE_NONCE)throw Error('Stale managed normal protection selection.');
 assertManagedProfileContext(c,env.CAPRI_MANAGED_GENERATION!);return profile;
}

/** Actual pre-ready product seam, also used by the opt-in neutral acceptance.
 * No override context path exists: the pinned generation supplies all material. */
export function prepareManagedDesktopContext(appData:string,profile:string,env:NodeJS.ProcessEnv,gate:{owned():boolean},assertProtection:(paths:readonly string[])=>void=assertManagedProtectionSync,signal?:AbortSignal){
 const epochDirectory=managedDesktopData(appData,profile,true,env),directory=path.join(epochDirectory,randomUUID());
 const c=ManagedConfigSchema.parse(JSON.parse(readProtectionFile(env.CAPRI_MANAGED_TRUST!,appData,65536).toString()));
 const current=()=>{if(managedDesktopData(appData,profile,true,env)!==epochDirectory)throw Error('Managed selection changed.');
  const journal=JSON.parse(readProtectionFile(path.join(c.root,'host.json'),appData,1024*1024).toString());
  let selected=journal.generation===env.CAPRI_MANAGED_GENERATION;
  if(!selected&&journal.failedGeneration===env.CAPRI_MANAGED_GENERATION){const state=UpdateStateSchema.parse(JSON.parse(readProtectionFile(path.join(c.root,'state.json'),appData,1024*1024).toString()));selected=state.phase==='rolling-back'&&journal.rollbackCandidateId===state.candidate?.id;}
  if(journal.installationId!==c.installationId||journal.ownerSha256!==c.ownerSha256||journal.trustSha256!==env.CAPRI_MANAGED_TRUST_SHA256||journal.epoch!==env.CAPRI_MANAGED_EPOCH||!selected||journal.phase!=='maintenance')throw Error('Stale managed protection selection.');
  assertManagedProfileContext(c,env.CAPRI_MANAGED_GENERATION!);
 };
 signal?.throwIfAborted();if(!gate.owned())throw Error('Protection context writer ownership lost.');current();
 assertProtection([c.root,c.profilesRoot,profile,env.CAPRI_MANAGED_TRUST!,path.join(c.root,'host.json'),path.join(c.root,'protection-context.json'),path.join(profile,'Local State')]);
 return prepareProtectedDesktopContext({profile,directory,appData,gate,assertCurrent:current,signal});
}

const NormalIdentity=z.object({pid:z.number().int().positive(),created:z.string().regex(/^\d+$/),snapshotId:uuid,generation:uuid,nonce:uuid,epoch:uuid}).strict();
const JournalSchema=z.object({schemaVersion:z.literal(1),installationId:uuid,ownerSha256:sha,trustSha256:sha,
 sequenceFloor:z.number().int().nonnegative().safe(),generation:uuid,failedGeneration:uuid.optional(),rollbackCandidateId:uuid.optional(),pendingGeneration:uuid.optional(),generations:z.array(uuid).min(1),epoch:uuid,
 phase:z.enum(['idle','maintenance','starting','quiescent','active','stopped','unknown']),backupKeyRef:z.literal('backup-key.dpapi'),
 operations:z.array(z.object({requestId:z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),action:z.enum(['check','stage']),state:z.enum(['queued','finished','unknown']),epoch:uuid}).strict()).max(10000).default([]),
 normal:NormalIdentity.optional(),maintenance:z.unknown().optional(),prepared:z.unknown().optional()}).strict();
export type ManagedJournal=z.infer<typeof JournalSchema>;
export async function writeManagedJson(file:string,value:unknown){
 const bytes=Buffer.from(canonicalJson(value)),temp=path.join(path.dirname(file),'.managed-'+randomUUID()+'.tmp');
 // Check existing destination before replacing it; never replace aliases.
 try{await readManagedFile(file);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const h=await fs.open(temp,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
 await fs.rename(temp,file);if(!(await readManagedFile(file)).equals(bytes))throw Error('Managed journal readback failed.');
}

/** Authenticated captured stdio only. Never exported as a model/HTTP RPC server.
 * Method names and data are checked again by the receiver. No payload is logged. */
class ManagedRequestTimeout extends Error {constructor(){super('Managed operation unconfirmed.');}}
export class ManagedChannel {
 private buffer='';private serial=0;private closed=false;
 private expired=new Set<number>();
 private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
 handler?:(method:string,input:any)=>Promise<unknown>;onLost?:()=>void;
 constructor(private input:Readable,private output:Writable,private token:string,readonly epoch:string,private maxFrameBytes=384*1024*1024,private disconnect:()=>void=()=>{}){
  if(!/^[a-f0-9]{64}$/.test(token)||!uuid.safeParse(epoch).success)throw Error('Invalid captured channel binding.');
  input.on('data',this.data);input.once('end',this.lost);input.once('close',this.lost);input.once('error',this.lost);output.on('error',this.lost);output.once('close',this.lost);
 }
 private lost=()=>{if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Managed channel closed.'));}this.pending.clear();this.expired.clear();this.disconnect();this.onLost?.();};
 private data=(chunk:Buffer)=>{try{this.buffer+=chunk.toString('utf8');if(this.buffer.length>this.maxFrameBytes)throw Error('Managed frame too large.');
  let end;while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);if(!line.startsWith('CAPRI_MANAGED_RPC ')){if(line.length>8192)throw Error('Oversized nonprotocol output.');continue;}const v=JSON.parse(line.slice(18));
   if(!v||v.protocol!=='capri-managed-v1'||v.token!==this.token||v.epoch!==this.epoch||!Number.isSafeInteger(v.id)||v.id<1)throw Error('Managed frame binding invalid.');
   if(v.type==='reply'){
    if(typeof v.ok!=='boolean'||Object.keys(v).some(k=>!['protocol','token','epoch','id','type','ok','value'].includes(k))||!v.ok&&'value' in v)throw Error('Invalid managed reply.');
    const p=this.pending.get(v.id);
    // One structurally valid, authenticated reply to this EXACT expired request
    // is harmless. It cannot satisfy another request; unknown/duplicate IDs fail.
    if(!p){if(this.expired.delete(v.id))continue;throw Error('Unmatched managed reply.');}
    clearTimeout(p.timer);this.pending.delete(v.id);v.ok?p.resolve(v.value):p.reject(Error('Managed operation refused.'));
   }
   else if(v.type==='request'&&typeof v.method==='string')void Promise.resolve().then(()=>{if(this.closed||!this.handler)throw Error('Managed receiver unavailable.');return this.handler(v.method,v.input);}).then(value=>this.send({id:v.id,type:'reply',ok:true,value}),()=>this.send({id:v.id,type:'reply',ok:false}));
   else throw Error('Invalid managed message.');
  }
 }catch{this.lost();}};
 private send(value:object){if(this.closed)return;this.output.write('CAPRI_MANAGED_RPC '+JSON.stringify({protocol:'capri-managed-v1',token:this.token,epoch:this.epoch,...value})+'\n');}
 request(method:string,input:unknown={},timeout=120000,signal?:AbortSignal):Promise<any>{if(this.closed)return Promise.reject(Error('Managed channel closed.'));if(signal?.aborted)return Promise.reject(Error('Managed operation stopped.'));const id=++this.serial;
  const work=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.abandon(id);reject(new ManagedRequestTimeout());},timeout);this.pending.set(id,{resolve,reject,timer});this.send({id,type:'request',method,input});});
  const abort=()=>{const p=this.pending.get(id);if(p){clearTimeout(p.timer);this.abandon(id);p.reject(Error('Managed operation stopped.'));}};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();return work.finally(()=>signal?.removeEventListener('abort',abort));}
 private abandon(id:number){this.pending.delete(id);this.expired.add(id);
  // Never evict an unknown identity into permission to accept it. A pathological
  // peer exhausting this bounded quarantine loses the channel cooperatively.
  if(this.expired.size>256)this.lost();}
 close(){this.lost();this.input.removeListener('data',this.data);this.input.removeListener('end',this.lost);this.input.removeListener('close',this.lost);this.input.removeListener('error',this.lost);this.output.removeListener('error',this.lost);this.output.removeListener('close',this.lost);}
}

export const managedStartupTimeoutMs=120000;
const managedHealthRequestMs=10000;
/** Cold Electron startup includes pinned-byte/ACL checks, writer acquisition,
 * ready and existing Store verification. Only timeouts are retried, at most 12
 * times, within the same monotonic deadline used by the update engine. A reply
 * is still just data: the controller must validate its full health identity. */
export async function waitManagedHealth(channel:ManagedChannel,nonce:string,signal:AbortSignal,now=()=>performance.now()){
 const deadline=now()+managedStartupTimeoutMs;
 for(let attempt=0;attempt<managedStartupTimeoutMs/managedHealthRequestMs;attempt++){
  signal.throwIfAborted();const remaining=deadline-now();if(remaining<=0)break;
  try{const value=await channel.request('health',{nonce},Math.min(managedHealthRequestMs,remaining),signal);signal.throwIfAborted();if(now()>=deadline)break;return value;}
  catch(error){signal.throwIfAborted();if(!(error instanceof ManagedRequestTimeout))throw error;}
 }
 throw Error('Managed startup health deadline exceeded.');
}

/** Losing the authenticated captured channel must deliver EOF even before the
 * desktop has installed its handler. EOF is a shutdown request, never exit proof. */
export function captureManagedChannel(child:Pick<ChildProcessWithoutNullStreams,'stdin'|'stdout'|'stderr'>,token:string,epoch:string){
 child.stderr.resume();return new ManagedChannel(child.stdout,child.stdin,token,epoch,undefined,()=>child.stdin.end());
}

/** Positive kernel creation identity. Access denied/query failure stays unknown. */
export async function managedProcessIdentity(pid:number):Promise<string|'exited'>{
 if(process.platform!=='win32'||!Number.isInteger(pid)||pid<1)throw Error('Windows process identity unavailable.');
 const script="$ErrorActionPreference='Stop';try{$p=Get-Process -Id "+pid+" -ErrorAction Stop;Write-Output ([string]$p.StartTime.ToUniversalTime().Ticks)}catch{if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*'){Write-Output 'exited'}else{throw}}";
 const result=await new Promise<string>((resolve,reject)=>execFile(path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:4096},(e,out)=>e?reject(Error('Process identity uncertain.')):resolve(out.trim())));
 if(result!=='exited'&&!/^\d+$/.test(result))throw Error('Process identity uncertain.');return result;
}

export interface ManagedSession {channel:ManagedChannel;stop():Promise<boolean>;exited?():Promise<boolean>}
export interface ManagedProcesses {
 normal(snapshot:UpdateSnapshot,context:{epoch:string;generation:string;nonce:string},save:(identity:z.infer<typeof NormalIdentity>)=>Promise<void>,signal:AbortSignal):Promise<ManagedSession>;
 maintenance(snapshot:UpdateSnapshot,context:{epoch:string;generation:string},prepared:(control:SupervisorControl)=>Promise<void>,armed:(identity:SupervisorIdentity)=>Promise<void>,signal:AbortSignal):Promise<ManagedSession>;
 reconcile(journal:ManagedJournal):Promise<boolean>;
}

/** A closed RPC channel is never process-exit evidence. Retain the captured
 * handle and exact creation identity; a query failure/reused PID stays unknown. */
export async function waitManagedNormalExit(child:Pick<ChildProcessWithoutNullStreams,'pid'|'exitCode'|'signalCode'>,created:string,identity=managedProcessIdentity,timeout=30000){
 const deadline=Date.now()+timeout;
 do{if(child.exitCode!==null||child.signalCode!==null)return true;
  const actual=await identity(child.pid!);if(actual==='exited')return true;if(actual!==created)return false;
  if(Date.now()>=deadline)return false;await new Promise(r=>setTimeout(r,30));
 }while(true);
}

/** All spawn boundaries use freshly hashed external resources. The normal app
 * is detached, captured, and outside the maintenance Job/cursor guardian. */
export function createManagedProcesses(trust:ManagedTrust):ManagedProcesses {
 const c=trust.config;let normalChild:ChildProcessWithoutNullStreams|undefined;
 const verifyPins=async()=>{await trust.assert();for(const p of [c.node,c.controller,c.launcher,c.supervisor,c.windowsHelper])if(managedHash(await readManagedFile(p.path,512*1024*1024))!==p.sha256)throw Error('Runtime resource changed.');};
 const env=(context:{epoch:string;generation:string;nonce?:string},token:string)=>{
  // No inherited provider settings/keys. Windows essentials only.
  const value:NodeJS.ProcessEnv={};for(const k of ['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PATH'])if(process.env[k])value[k]=process.env[k];
  return {...value,CAPRI_PROFILE_DIR:managedGeneration(c,context.generation),CAPRI_DEV_PORT:String(c.port),CAPRI_MANAGED_TRUST:trust.file,CAPRI_MANAGED_TRUST_SHA256:trust.sha256,
   CAPRI_MANAGED_EPOCH:context.epoch,CAPRI_MANAGED_GENERATION:context.generation,CAPRI_MANAGED_CHANNEL:token,CAPRI_UPDATE_NONCE:context.nonce??''};
 };
 const captured=captureManagedChannel;
 const waitSpawn=(child:ChildProcessWithoutNullStreams)=>new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 const verifyLaunch=async(context:{generation:string;nonce:string},snapshotId?:string)=>{
  const launcherTrust={schemaVersion:1,root:c.root,profile:managedGeneration(c,context.generation),port:c.port,nodeExecutable:c.node.path,nodeSha256:c.node.sha256,launcherSha256:c.launcher.sha256,keys:c.keys,channel:c.channel,arch:c.arch,minimumSequence:c.minimumSequence,dataVersion:1};
  const trustFile=path.join(path.dirname(trust.file),'launch-'+randomUUID()+'.json');await writeManagedJson(trustFile,launcherTrust);
  try{await new Promise<void>((resolve,reject)=>execFile(c.node.path,[c.launcher.path,'--trust-file',trustFile,'--trust-file-sha256',managedHash(canonicalJson(launcherTrust)),'--nonce',context.nonce,...snapshotId?['--maintenance','--snapshot-id',snapshotId]:[]],{windowsHide:true,timeout:120000,maxBuffer:4096},e=>e?reject(Error('Pinned launcher refused.')):resolve()));}finally{await fs.unlink(trustFile).catch(()=>{});}
 };
 const verifyMaintenance=async()=>{
  const snapshot=c.maintenance.snapshot,r=snapshot.manifest.release,decision=releasePolicy(snapshot.manifest,{now:r.publishedAt,channel:c.channel,platform:'win32',arch:c.arch,currentSequence:0,dataVersion:1,trustedKeys:c.keys});
  if(!decision.available||r.migration.writeVersion!==1)throw Error('Pinned maintenance runtime is incompatible.');
  const disk=createUpdateDisk(c.maintenance.root,trust.assert);await disk.assertProtected();const zip=await disk.read('package.zip',0x7fffffff);
  if(zip.length!==decision.artifact.bytes||managedHash(zip)!==decision.artifact.sha256)throw Error('Pinned maintenance archive changed.');
  const archive=await inspectUpdateZip(zip,8*2**30),actual=await disk.inventory('app');
  if(canonicalJson(actual)!==canonicalJson(snapshot.files)||canonicalJson(archive.files)!==canonicalJson(actual)||managedHash(canonicalJson(actual))!==snapshot.inventorySha256||!await verifyManagedAcceptance(c,{manifest:snapshot.manifest,artifact:decision.artifact,files:actual,inventorySha256:snapshot.inventorySha256}))throw Error('Pinned maintenance runtime acceptance changed.');
 };
 return {
  async normal(snapshot,context,save,signal){signal.throwIfAborted();await verifyPins();signal.throwIfAborted();
   // Preserved 0.6 snapshots do not implement the early writer/activation
   // protocol. Root must explicitly promote the accepted first 0.7 baseline;
   // never run an old executable against a managed generation to discover that.
   if(compareUpdateVersions(snapshot.manifest.release.version,'0.7.0-dev.1')<0)throw Error('Root must promote a managed-protocol baseline before normal start.');
   // The verify-only launcher independently checks signature, archive, extracted
   // inventory, current state/nonce and actual expiry. It never launches Capri.
   await verifyLaunch(context);
   await verifyPins();const state=UpdateStateSchema.parse(JSON.parse((await readManagedFile(path.join(c.root,'state.json'))).toString()));
   if(state.active.id!==snapshot.id||state.nonce!==context.nonce)throw Error('Launch pointer changed.');
   const r=snapshot.manifest.release;if(state.phase==='pending-health'&&(Date.now()<r.publishedAt||Date.now()>=r.expiresAt))throw Error('Candidate expired before launch.');
   const token=randomBytes(32).toString('hex'),exe=path.join(c.root,'snapshots',snapshot.id,'app','win-unpacked','Capri.exe');
   signal.throwIfAborted();const child=normalChild=spawn(exe,[],{cwd:path.dirname(exe),env:env(context,token),detached:true,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
   const channel=captured(child,token,context.epoch);await waitSpawn(child);
   let created:string;try{const observed=await managedProcessIdentity(child.pid!);if(observed==='exited')throw Error('Normal app exited before ownership pin.');created=observed;signal.throwIfAborted();
    await save({pid:child.pid!,created,snapshotId:snapshot.id,...context});signal.throwIfAborted();
   }catch(error){child.stdin.end();channel.close();throw error;}
   const exited=()=>waitManagedNormalExit(child,created);
   return {channel,exited,stop:async()=>{try{await channel.request('shutdown',{},30000);}catch{/* Exit proof, not a reply, controls mutation. */}finally{child.stdin.end();}
    const confirmed=await exited();if(confirmed)channel.close();return confirmed;}};
  },
  async maintenance(_snapshot,context,prepared,armed,signal){signal.throwIfAborted();await verifyPins();signal.throwIfAborted();await verifyMaintenance();await verifyPins();signal.throwIfAborted();
   // 0.6 is preserved as the normal rollback pointer. It need not implement this
   // new protocol: use Root's separately copied, pinned accepted 0.7 maintenance
   // runtime, never execute an old normal app with an unrecognized switch.
   const token=randomBytes(32).toString('hex'),exe=path.join(c.maintenance.root,'app','win-unpacked','Capri.exe');
   const controlRoot=path.join(c.root,'maintenance-control');await fs.mkdir(controlRoot,{recursive:true});
   const launch=prepareSupervisedLaunch({helperPath:c.supervisor.path,helperSha256:c.supervisor.sha256,controlRoot,cwd:path.dirname(exe),executable:exe,args:['--update-maintenance'],scopeSha256:managedHash(canonicalJson({installationId:c.installationId,...context}))});
   await prepared(launch.control);signal.throwIfAborted();const child=spawn(launch.executable,launch.args,{...launch.spawnOptions,cwd:path.dirname(exe),env:env(context,token),shell:false,stdio:['pipe','pipe','pipe']});
   const channel=captured(child,token,context.epoch);
   const identity=await armSupervisedRun(launch.control,child,{onArmed:armed,signal});
   return {channel,stop:async()=>{try{await channel.request('close',{},10000);}catch{}const proof=await cancelSupervisedRun(identity);channel.close();return proof.state==='stopped';}};
  },
  async reconcile(journal){
   if(journal.maintenance){const result=await cancelSupervisedRun(journal.maintenance as SupervisorIdentity);if(result.state!=='stopped')return false;}
   else if(journal.prepared)return false; // pre-arming ambiguity is retained; no dead-PID shortcut.
   if(journal.normal){const actual=await managedProcessIdentity(journal.normal.pid);if(actual!=='exited')return false;}
   if(journal.phase==='starting'&&!journal.normal)return false;
   return !normalChild||normalChild.exitCode!==null||normalChild.signalCode!==null;
  }
 };
}

/** Resolve exact independent broker evidence from operator-owned files. Hashes
 * inside a candidate are checked against the separately retained attestation. */
export async function verifyManagedAcceptance(config:ManagedConfig,input:Parameters<UpdateHost['verifyAcceptance']>[0]):Promise<boolean>{
 try{
  const broker=JSON.parse((await readManagedFile(config.brokerJournal,16*1024*1024)).toString());
  const matches=Object.values(broker.records??{}).filter((v:any)=>v.phase==='published'&&v.sequence===input.manifest.release.sequence&&v.version===input.manifest.release.version&&canonicalJson(v.release)===canonicalJson(input.manifest.release)&&v.artifact?.sha256===input.artifact.sha256&&v.artifact?.bytes===input.artifact.bytes) as any[];
  if(matches.length!==1)return false;const row=matches[0];if(!/^[a-f0-9]{40}$/.test(row.commit)||!sha.safeParse(row.attestationId).success||typeof row.attestationFile!=='string'||path.basename(row.attestationFile)!==row.attestationFile)return false;
  const attestation=JSON.parse((await readManagedFile(path.join(config.attestationRoot,row.attestationFile),16*1024*1024)).toString());const {id,...payload}=attestation;
  if(id!==row.attestationId||id!==managedHash(JSON.stringify(payload))||attestation.kind!=='capri-operator-release-attestation'||attestation.commit!==row.commit||attestation.releaseVersion!==row.version||!Array.isArray(attestation.taskEvidence)||!attestation.taskEvidence.length||attestation.taskEvidence.length!==attestation.taskCount||managedHash(JSON.stringify(attestation.taskEvidence))!==attestation.reviewDigest)return false;
  if(!Array.isArray(attestation.checks)||!attestation.checks.length||!['candidate:typecheck','candidate:test','candidate:build'].every(check=>attestation.taskEvidence.every((t:any)=>['codex','claude'].includes(t.owner)&&['codex','claude'].includes(t.reviewer)&&t.owner!==t.reviewer&&sha.safeParse(t.reviewSha256).success&&t.checks?.some((r:any)=>r.id===check&&sha.safeParse(r.sha256).success))))return false;
  const find=(name:string)=>input.files.find(f=>f.path===name)?.sha256;
  return row.snapshotManifestSha256===managedHash(JSON.stringify(brokerInventoryOrder(input.files)))&&input.inventorySha256===managedHash(canonicalJson(input.files))&&find('VERIFICATION.json')===attestation.snapshotReportSha256&&find('win-unpacked/Capri.exe')===attestation.executableSha256&&find('win-unpacked/resources/app.asar')===attestation.appAsarSha256;
 }catch{return false;}
}
/** Broker packageManifest walks sorted directory entries recursively. Comparing
 * path segments reproduces that order (resources/ precedes resources.pak),
 * whereas the updater's signed inventory uses global full-path sorting. */
export function brokerInventoryOrder(files:UpdateSnapshot['files']){return files.map(f=>({path:f.path,bytes:f.bytes,sha256:f.sha256})).sort((a,b)=>{
 const aa=a.path.split('/'),bb=b.path.split('/');for(let i=0;i<Math.min(aa.length,bb.length);i++)if(aa[i]!==bb[i])return aa[i]<bb[i]?-1:1;return aa.length-bb.length;
});}

const emptyIdle:UpdateIdle={task:false,call:false,microphone:false,scan:false,game:false};
type Observation={automatic:boolean;idle:UpdateIdle;version:string;dataVersion:number;sequence:number};
/** Durable controller state lives outside all physical profiles. Methods are
 * serialized, Stop invalidates the epoch synchronously before awaiting cleanup. */
export class ManagedUpdateController {
 private journal!:ManagedJournal;private disk:UpdateDisk;private engine?:SignedUpdateEngine;
 private singleton?:Awaited<ReturnType<typeof acquireProfileWriter>>;private normal?:ManagedSession;private maintenance?:ManagedSession;
 private stopped=false;private abort=new AbortController();private work?:Promise<unknown>;private timer?:NodeJS.Timeout;private reserving=false;private normalRetiring=false;
 private observation?:Observation;private backupKey?:Buffer;private lastStatus:Extract<ExtensionFeatureStatus,{feature:'updates'}>;
 private journalWrites:Promise<void>=Promise.resolve();
 private stopTask?:Promise<void>;private retirement?:Promise<void>;private relaunchTask?:Promise<ExtensionFeatureStatus>;
 private ownerQuit=false;private ownerExit?:Promise<void>;
 /** Called only after positive owner/helper retirement and singleton release. */
 onClosed?:()=>void;
 constructor(readonly trust:ManagedTrust,private processes:ManagedProcesses=createManagedProcesses(trust),private clock=Date.now,private transport?:UpdateTransport){
  this.disk=createUpdateDisk(trust.config.root,trust.assert);
  this.lastStatus={feature:'updates',capability:featureCapability({enabled:true,configured:true,supported:true,ready:false,verification:'none',actions:['check','stage','rollback']}),updates:{state:'current'}};
 }
 private get c(){return this.trust.config;}
 private save(){const write=this.journalWrites.then(()=>writeManagedJson(path.join(this.c.root,'host.json'),JournalSchema.parse(this.journal)));this.journalWrites=write.catch(()=>{});return write;}
 private guard(epoch=this.journal.epoch){if(this.stopped||this.abort.signal.aborted||epoch!==this.journal.epoch||this.journal.phase==='unknown')throw Error('Managed operation stopped or requires recovery.');}
 private async state(){return UpdateStateSchema.parse(JSON.parse((await this.disk.read('state.json',32*1024*1024)).toString()));}
 private async floor(){const state=await this.state();if(state.sequenceFloor<this.journal.sequenceFloor||state.sequenceFloor<this.c.minimumSequence)throw Error('Managed sequence regressed.');
  if(state.sequenceFloor>this.journal.sequenceFloor){this.journal.sequenceFloor=state.sequenceFloor;await this.save();}return state;}
 async open(){
  await this.trust.assert();
  // Separate singleton namespace from the writer gate, so maintenance/normal
  // can own the writer while this external controller remains alive.
  this.singleton=await acquireProfileWriter({installationId:this.c.installationId,ownerSha256:managedHash(this.c.ownerSha256+'\0controller')});
  try{this.journal=JournalSchema.parse(JSON.parse((await readManagedFile(path.join(this.c.root,'host.json'))).toString()));
   if(this.journal.installationId!==this.c.installationId||this.journal.ownerSha256!==this.c.ownerSha256||this.journal.trustSha256!==this.trust.sha256)throw Error('Managed host identity changed.');
   managedGeneration(this.c,this.journal.generation);await this.floor();
   if(!await this.processes.reconcile(this.journal)){this.journal.phase='unknown';await this.save();throw Error('Prior managed owner exit is unconfirmed.');}
   this.journal.epoch=randomUUID();delete this.journal.normal;delete this.journal.maintenance;delete this.journal.prepared;this.journal.phase='idle';await this.save();
  }catch(error){await this.singleton.close();this.singleton=undefined;throw error;}
  return this;
 }
 private async observe():Promise<Observation>{
  const state=await this.floor();let observation:Observation;
  if(this.maintenance){const ready=await this.maintenance.channel.request('ready');this.guard();
   if(ready.writer!==true||ready.generation!==this.journal.failedGeneration&&ready.generation!==this.journal.generation||ready.dataVersion!==1)throw Error('Offline writer health invalid.');
   observation={version:state.active.manifest.release.version,dataVersion:1,sequence:state.active.manifest.release.sequence,automatic:ready.automatic===true,idle:{...emptyIdle}};
  }else if(this.normal){observation=await this.normal.channel.request('observe');this.guard();
   z.object({version:z.string(),dataVersion:z.literal(1),sequence:z.number().int().nonnegative(),automatic:z.boolean(),idle:z.object({task:z.boolean(),call:z.boolean(),microphone:z.boolean(),scan:z.boolean(),game:z.boolean()}).strict()}).strict().parse(observation);
   if(observation.version!==state.active.manifest.release.version||observation.sequence!==state.active.manifest.release.sequence)throw Error('Current app identity differs.');
  }else observation={version:state.active.manifest.release.version,dataVersion:1,sequence:state.active.manifest.release.sequence,automatic:true,idle:{...emptyIdle}};
  this.observation=observation;return observation;
 }
 private async ensureMaintenance():Promise<ManagedSession>{
  this.guard();if(this.maintenance)return this.maintenance;
  const epoch=this.journal.epoch;
  if(this.normal){this.normalRetiring=true;let stopped:boolean;try{stopped=await this.normal.stop();}finally{this.normalRetiring=false;}this.guard(epoch);if(!stopped)throw Error('Original owner termination unconfirmed.');this.normal=undefined;delete this.journal.normal;await this.save();}
  else if(this.journal.normal){if(!await this.processes.reconcile(this.journal))throw Error('Prior owner termination unconfirmed.');delete this.journal.normal;}
  this.journal.phase='maintenance';await this.save();const state=await this.state();
  const generation=state.phase==='rolling-back'&&this.journal.rollbackCandidateId===state.candidate?.id&&this.journal.failedGeneration?this.journal.failedGeneration:this.journal.generation;
  const session=await this.processes.maintenance(state.previous??state.active,{epoch,generation},async control=>{this.guard(epoch);this.journal.prepared=control;await this.save();this.guard(epoch);},async identity=>{this.guard(epoch);this.journal.maintenance=identity;await this.save();this.guard(epoch);},this.abort.signal);
  if(this.stopped||epoch!==this.journal.epoch){await session.stop();throw Error('Late maintenance launch stopped.');}
  this.maintenance=session;await session.channel.request('ready');this.guard(epoch);return session;
 }
 private async closeMaintenance(){if(!this.maintenance)return;const old=this.maintenance;if(!await old.stop())throw Error('Maintenance whole-Job termination unconfirmed.');
  this.maintenance=undefined;delete this.journal.prepared;delete this.journal.maintenance;await this.save();}
 private async makeEngine(initializeKey=false){
  if(this.engine)return this.engine;const session=await this.ensureMaintenance();
  const value=await session.channel.request('backup-key',{initialize:initializeKey});this.guard();
  this.backupKey=Buffer.from(value.key,'base64');if(this.backupKey.length!==32)throw Error('Protected backup key unavailable.');
  const rpc=async(method:string,input:unknown={})=>{const s=await this.ensureMaintenance();this.guard();const result=await s.channel.request(method,input);this.guard();return result;};
  const host:UpdateHost={now:this.clock,current:()=>this.observe(),
   acquireMaintenance:async signal=>{signal.throwIfAborted();await this.ensureMaintenance();signal.throwIfAborted();return {release:async()=>{
    await this.floor();this.guard();const state=await this.state();
    if(['healthy','rolled-back'].includes(state.phase)&&this.normal&&this.journal.phase!=='active'){await this.activate();}
    else if(['staged','healthy','rolled-back'].includes(state.phase)&&!this.normal){await this.closeMaintenance();await this.startNormal(state.active,await this.freshNonce());await this.assertHealth(state.active,this.journal.normal!.nonce);await this.activate();}
   }};},
   restoreCursor:async()=>await rpc('cursor-restored')===true,
   verifyAcceptance:input=>verifyManagedAcceptance(this.c,input),
   backupProfile:async()=>{const value=await rpc('backup');return {dataVersion:value.dataVersion,bytes:Buffer.from(value.bytes,'base64')};},
   verifyProfileBackup:async(bytes,dataVersion)=>await rpc('verify',{bytes:Buffer.from(bytes).toString('base64'),dataVersion})===true,
   migrateProfile:async(writeVersion,signal)=>{signal.throwIfAborted();await rpc('migrate',{writeVersion});signal.throwIfAborted();},
   start:async(snapshot,nonce)=>this.startNormal(snapshot,nonce),healthy:(snapshot,nonce)=>this.assertHealth(snapshot,nonce),
   activate:async(snapshot,nonce)=>{if(this.journal.normal?.snapshotId!==snapshot.id||this.journal.normal.nonce!==nonce)throw Error('Activation ownership mismatch.');await this.activate();},
   stopCandidate:async()=>{if(this.normal){this.normalRetiring=true;let stopped:boolean;try{stopped=await this.normal.stop();}finally{this.normalRetiring=false;}if(!stopped)return false;this.normal=undefined;delete this.journal.normal;await this.save();}
    return await this.processes.reconcile({...this.journal,maintenance:undefined,prepared:undefined});},
   restoreBackup:async(bytes,dataVersion)=>{if(dataVersion!==1)throw Error('Unsupported backup schema.');const candidate=(await this.state()).candidate?.id;if(!candidate)throw Error('Rollback operation identity missing.');
    const failed=this.journal.rollbackCandidateId===candidate&&this.journal.failedGeneration?this.journal.failedGeneration:this.journal.generation;
    const session=await this.ensureMaintenance(),generation=randomUUID();
    // Persist intent first. A partial generation is retained and never reused.
    this.journal.failedGeneration=failed;this.journal.rollbackCandidateId=candidate;this.journal.pendingGeneration=generation;this.journal.generations.push(generation);await this.save();await session.channel.request('restore',{bytes:Buffer.from(bytes).toString('base64'),generation});this.guard();
    this.journal.generation=generation;delete this.journal.pendingGeneration;await this.save();},
   contactStores:async()=>{
    if(!this.maintenance||!this.journal.failedGeneration||this.journal.failedGeneration===this.journal.generation)throw Error('Distinct closed recovery profiles required.');
    const session=this.maintenance,failed=this.journal.failedGeneration,recovered=this.journal.generation;
    const read=async(generation:string,kind:string,id:string)=>{this.guard();return await session.channel.request('journal',{operation:'get',generation,kind,id})??undefined;};
    return {current:{get:(kind,id)=>read(failed,kind,id),list:async kind=>{this.guard();return session.channel.request('journal',{operation:'list',generation:failed,kind});}},
     recovered:{get:(kind,id)=>read(recovered,kind,id),put:async(kind,value)=>{this.guard();return session.channel.request('journal',{operation:'put',generation:recovered,kind,id:value.id,value});}}};
   }
  };
  this.engine=new SignedUpdateEngine(this.disk,host,this.transport??createPinnedUpdateTransport(this.c.feed),{keys:this.c.keys,channel:this.c.channel,arch:this.c.arch,minimumSequence:this.journal.sequenceFloor,startupTimeoutMs:managedStartupTimeoutMs,
   allowedUrl:(url,kind)=>kind==='manifest'?url===this.c.feed.origin+'/manifest.json':url.startsWith(this.c.feed.origin+'/artifacts/')&&/\/artifacts\/[a-f0-9]{64}\.zip$/.test(url)},this.backupKey);
  return this.engine;
 }
 private async freshNonce(){const state=await this.floor();state.nonce=randomUUID();await this.disk.writeState(state);return state.nonce;}
 private async startNormal(snapshot:UpdateSnapshot,nonce:string){
  this.guard();const epoch=this.journal.epoch;await this.closeMaintenance();this.guard(epoch);
  if(this.normal||this.journal.normal)throw Error('Normal writer is already captured.');
  this.journal.phase='starting';await this.save();this.guard(epoch);
  const session=await this.processes.normal(snapshot,{epoch,generation:this.journal.generation,nonce},async identity=>{this.guard(epoch);this.journal.normal=identity;await this.save();this.guard(epoch);},this.abort.signal);
  if(this.stopped||epoch!==this.journal.epoch){await session.stop();throw Error('Late normal launch stopped.');}
  this.normal=session;session.channel.handler=async(method,input)=>{
   if(method==='status'){z.object({}).strict().parse(input);return this.status();}
   if(method==='stop'){z.object({}).strict().parse(input);if(this.normal!==session)throw Error('Stale stopping owner.');return this.suspendFromOwner();}
   if(method==='quit'){z.object({}).strict().parse(input);if(this.normal!==session)throw Error('Stale quitting owner.');this.ownerQuit=true;await this.suspendFromOwner();return {closing:true};}
   if(method==='check'||method==='stage'){
    const request=method==='check'?z.object({requestId:z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/)}).strict().parse(input):z.object({requestId:z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),version:z.string().max(120)}).strict().parse(input);
    this.guard(epoch);if(this.work||this.reserving||this.journal.operations.some(o=>o.requestId===request.requestId)||this.journal.operations.length>=10000)throw Error('Managed operation busy or already claimed.');
    this.reserving=true;const record:ManagedJournal['operations'][number]={requestId:request.requestId,action:method as 'check'|'stage',state:'queued',epoch};this.journal.operations.push(record);
    try{await this.save();this.guard(epoch);const run=this.check('version' in request?String(request.version):undefined);
     void run.then(()=>{record.state='finished';},()=>{record.state='unknown';}).then(()=>this.save()).catch(()=>{});return {queued:true};
    }finally{this.reserving=false;}
   }
   throw Error('Unsupported managed owner operation.');
  };
  session.channel.onLost=()=>{if(this.normal!==session||this.normalRetiring)return;
   if(this.ownerQuit){this.ownerExit??=this.finishOwnerQuit(session);void this.ownerExit.catch(()=>{});}
   else if(!this.stopped&&this.journal.phase==='active'){this.abort.abort();clearInterval(this.timer);this.journal.phase='unknown';this.lastStatus={...this.lastStatus,updates:{state:'recovery-required'}};void this.save().catch(()=>{});}
  };
  this.journal.phase='quiescent';await this.save();
 }
 private async assertHealth(snapshot:UpdateSnapshot,nonce:string){
  this.guard();const n=this.journal.normal;if(!this.normal||!n)return false;const epoch=this.journal.epoch;
  try{const h=await waitManagedHealth(this.normal.channel,nonce,this.abort.signal);this.guard(epoch);
   return h.nonce===nonce&&h.epoch===epoch&&h.version===snapshot.manifest.release.version&&h.dataVersion===1&&h.generation===this.journal.generation&&h.profile===managedGeneration(this.c,this.journal.generation)&&h.installationId===this.c.installationId&&h.trustSha256===this.trust.sha256&&h.writer===true&&h.quiescent===true&&n.snapshotId===snapshot.id;
  }catch{return false;}
 }
 private async activate(){this.guard();const n=this.journal.normal;if(!n||!this.normal)throw Error('Captured normal owner missing.');
  const state=await this.floor();if(!['healthy','rolled-back','pending-health','rollback-health','staged'].includes(state.phase)||!await this.assertHealth(state.active,n.nonce))throw Error('Activation health/epoch mismatched.');
  this.guard();const result=await this.normal.channel.request('activate',{nonce:n.nonce,epoch:this.journal.epoch},120000);this.guard();if(result?.activated!==true)throw Error('Application operational startup unconfirmed.');this.journal.phase='active';await this.save();
 }
 private exclusive<T>(work:()=>Promise<T>):Promise<T>{if(this.work)return Promise.reject(Error('Managed controller busy.'));
  const run=work();this.work=run;void run.finally(()=>{if(this.work===run)this.work=undefined;}).catch(()=>{});return run;}
 async start(initializeKey=false){return this.exclusive(async()=>{try{const engine=await this.makeEngine(initializeKey);await engine.recover(this.abort.signal);this.guard();const state=await this.floor();
  if(!this.normal){await this.closeMaintenance();await this.startNormal(state.active,await this.freshNonce());if(!await this.assertHealth(state.active,this.journal.normal!.nonce))throw Error('Managed normal health failed.');await this.activate();}
  this.timer=setInterval(()=>{if(!this.work&&!this.stopped)void this.check().catch(()=>{});},this.c.pollMs);this.timer.unref();return this.status();
 }catch(error){if(!this.stopped){
  // A genuine cold-start deadline must not leave a quiescent owner waiting for
  // activation. Controller shutdown is distinct from the owner's Quit/Stop;
  // suppress channel-loss callbacks while retaining any uncertain exit identity.
  if(this.normal){this.normalRetiring=true;try{if(await this.normal.stop()){this.normal=undefined;delete this.journal.normal;}}catch{/* Keep ownership evidence. */}finally{this.normalRetiring=false;}}
  this.journal.phase='unknown';this.lastStatus={...this.lastStatus,updates:{state:'recovery-required'}};await this.save();}throw error;}});}
 async check(version?:string){return this.exclusive(async()=>{this.guard();const epoch=this.journal.epoch;const engine=await this.makeEngine();
  const observation=await this.observe();if(!observation.automatic||Object.values(observation.idle).some(Boolean))return {deferred:true};
  try{const before=await this.state();if(before.phase!=='staged'){delete this.journal.failedGeneration;delete this.journal.rollbackCandidateId;await this.save();}
   const candidate=before.phase==='staged'?before.candidate!:await engine.stage(this.c.feed.origin+'/manifest.json',this.abort.signal);
   this.guard(epoch);if(version&&candidate.manifest.release.version!==version)throw Error('Selected update changed.');
   this.lastStatus={feature:'updates',capability:featureCapability({enabled:true,configured:true,supported:true,ready:true,verification:'verified',actions:['check','stage','rollback']}),updates:{state:'available',version:candidate.manifest.release.version}};
   const outcome=await engine.apply(this.abort.signal);this.guard(epoch);await this.floor();return {outcome};
  }catch(error){if(!this.stopped){const state=await this.state();if(!['healthy','staged','rolled-back'].includes(state.phase)){this.journal.phase='unknown';await this.save();}}
   throw error;
  }finally{this.lastStatus={feature:'updates',capability:featureCapability({enabled:true,configured:true,supported:true,ready:false,verification:'none',actions:['check','stage','rollback']}),updates:{state:this.journal.phase==='unknown'?'recovery-required':'current'}};}
 });}
 status():Extract<ExtensionFeatureStatus,{feature:'updates'}>{return {...this.lastStatus,updates:this.journal.phase==='unknown'?{state:'recovery-required'}:this.stopped?{state:'disabled'}:this.lastStatus.updates};}
 /** Stop from the still-running owner must not wait for that owner's exit.
  * It revokes future launches and waits for already-owned helper cleanup. */
 private async suspendFromOwner(){const wasStopped=this.stopped;this.stopped=true;this.abort.abort();clearInterval(this.timer);
  if(this.normal&&['starting','quiescent'].includes(this.journal.phase))void this.normal.channel.request('shutdown',{},30000).catch(()=>{});
  if(!wasStopped)this.journal.epoch=randomUUID();if(this.journal.phase!=='unknown')this.journal.phase='stopped';await this.save();
  // A live owner's Stop can race the controller waiting for that owner's quit.
  // Revocation precedes the reply; no post-abort spawn/ACK/activation is allowed.
  // Helpers exist only after the original owner has positively exited.
  if(!this.normal)await this.work?.catch(()=>{});if(this.maintenance)await this.closeMaintenance();this.backupKey?.fill(0);return {stopped:true};}
 private async finishOwnerQuit(session:ManagedSession){try{
  if(!await session.exited?.())throw Error('Quitting owner exit unconfirmed.');
  if(this.normal!==session)return;this.normal=undefined;delete this.journal.normal;await this.save();await this.stop();
 }catch(error){if(this.normal!==session)return;this.journal.phase='unknown';await this.save();throw error;}}
 private retire():Promise<void>{if(this.retirement)return this.retirement;const run=(async()=>{try{await this.suspendFromOwner();if(this.normal){
   this.normalRetiring=true;let confirmed:boolean;try{confirmed=await this.normal.stop();}finally{this.normalRetiring=false;}
   if(!confirmed)throw Error('Normal app exit unconfirmed.');this.normal=undefined;delete this.journal.normal;
  }
  await this.work?.catch(()=>{});if(this.maintenance)await this.closeMaintenance();
  // A stopped launch can have durably pinned identity before returning its
  // live session. Retain that evidence/singleton until exact recovery confirms
  // retirement too; lack of a callback is not proof of no subprocess.
  if(this.journal.normal||this.journal.maintenance||this.journal.prepared){if(!await this.processes.reconcile(this.journal))throw Error('Pending owner exit unconfirmed.');delete this.journal.normal;delete this.journal.maintenance;delete this.journal.prepared;}
  this.journal.phase='stopped';await this.save();
 }catch(error){this.journal.phase='unknown';await this.save();throw error;}})();this.retirement=run;void run.catch(()=>{if(this.retirement===run)this.retirement=undefined;});return run;}
 stop():Promise<void>{if(this.stopTask)return this.stopTask;const run=(async()=>{await this.retire();await this.singleton?.close();this.singleton=undefined;this.onClosed?.();})();this.stopTask=run;void run.catch(()=>{if(this.stopTask===run)this.stopTask=undefined;});return run;}
 /** Explicit authenticated operator start after owner Stop. Retire the old
  * captured app first; keep the controller singleton throughout the transfer.
  * A fresh epoch/abort/engine cannot replay old requests or activate late work. */
 relaunch():Promise<ExtensionFeatureStatus>{
  if(this.relaunchTask)return this.relaunchTask;
  if(!this.stopped||this.ownerQuit||this.stopTask||this.journal.phase!=='stopped')return Promise.reject(Error('Managed relaunch requires a suspended confirmed owner.'));
  const run=(async()=>{await this.retire();if(this.stopTask)throw Error('Managed controller is closing.');
   this.engine=undefined;this.backupKey?.fill(0);this.backupKey=undefined;this.abort=new AbortController();this.stopped=false;this.retirement=undefined;
   this.journal.epoch=randomUUID();this.journal.phase='idle';await this.save();this.guard();return this.start();})();
  this.relaunchTask=run;void run.finally(()=>{if(this.relaunchTask===run)this.relaunchTask=undefined;}).catch(()=>{});return run;
 }
 async initializeBackup(){return this.exclusive(async()=>{const engine=await this.makeEngine(true);void engine;const session=this.maintenance!;if(await session.channel.request('cursor-restored')!==true)throw Error('Cursor recovery required.');await session.channel.request('backup');await this.closeMaintenance();this.journal.phase='idle';await this.save();});}
}

/** Trusted owner facade: no update transport, path, manifest or maintenance RPC
 * is accepted from the UI/model. Requests carry intent on the captured channel. */
export function managedUpdateFacade(channel:ManagedChannel,isClosing:()=>boolean):ExtensionModule&{stop():Promise<void>}{
 let stopped=false;const stop=async()=>{if(stopped||isClosing())return;stopped=true;await channel.request('stop',{},45000);};
 return {feature:'updates',status:async()=>{if(stopped)return {feature:'updates',capability:featureCapability({enabled:false,configured:true,supported:true,ready:false,verification:'none'}),updates:{state:'disabled'}};return channel.request('status');},
  action:async(action,request,context:ExtensionActionContext)=>{context.signal.throwIfAborted();if(context.authority!=='trusted-ui'||context.privateSession||context.localOnly||stopped||isClosing())throw Error('Managed owner action forbidden.');
   if(!['check','stage'].includes(action))throw Error('Managed action unavailable.');const input=action==='stage'?z.object({version:z.string().max(120)}).strict().parse(request.input):z.object({}).strict().parse(request.input);await channel.request(action,{...input,requestId:request.requestId});context.signal.throwIfAborted();
   return ActionReceiptSchema.parse({id:randomUUID(),requestId:request.requestId,feature:'updates',action,observedAt:Date.now(),outcome:'pending',effect:'queued'});},stop,close:stop};
}

/** Bootstrap never overwrites an existing pointer/snapshot/profile. Root first
 * supplies a verified immutable snapshot and an isolated CLOSED profile copy. */
export async function bootstrapManagedHost(trust:ManagedTrust,input:{generation:string;state:UpdateState}){
 const c=trust.config;await trust.assert();uuid.parse(input.generation);const state=UpdateStateSchema.parse(input.state);
 if(state.phase!=='healthy'||state.sequenceFloor<c.minimumSequence||state.active.manifest.release.sequence!==state.sequenceFloor)throw Error('Installed signed sequence required.');
 await fs.access(path.join(managedGeneration(c,input.generation),'private.config'));await fs.access(path.join(managedGeneration(c,input.generation),'data','capri.sqlite'));
 const gate=await acquireProfileWriter(c);try{
  const file=path.join(c.root,'host.json');try{await fs.access(file);throw Error('Managed bootstrap already exists.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  // Verify the already supplied state; never rewrite the immutable bootstrap pointer.
  const actual=UpdateStateSchema.parse(JSON.parse((await readManagedFile(path.join(c.root,'state.json'))).toString()));if(canonicalJson(actual)!==canonicalJson(state))throw Error('Existing bootstrap pointer differs.');
  await bindManagedProtectionContext(trust,input.generation,gate);
  const marker=path.join(c.profilesRoot,'.capri-managed.json'),markerBytes=Buffer.from(canonicalJson({schemaVersion:1,trustFile:trust.file,trustSha256:trust.sha256}));
  try{const h=await fs.open(marker,'wx',0o600);try{await h.writeFile(markerBytes);await h.sync();}finally{await h.close();}}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||!(await readManagedFile(marker,4096)).equals(markerBytes))throw error;}
  await writeManagedJson(file,{schemaVersion:1,installationId:c.installationId,ownerSha256:c.ownerSha256,trustSha256:trust.sha256,sequenceFloor:state.sequenceFloor,generation:input.generation,generations:[input.generation],epoch:randomUUID(),phase:'idle',backupKeyRef:'backup-key.dpapi'});
 }finally{await gate.close();}
}

/** Small OS key-storage adapter for the operator CLI's local control capability.
 * Binary material goes through captured stdin/stdout only; disk holds DPAPI bytes.
 * No PowerShell -File, policy override, provider credential or signing key. */
export async function managedControlKey(trust:ManagedTrust,initialize=false):Promise<Buffer>{
 await trust.assert();if(process.platform!=='win32')throw Error('Windows protected key storage required.');
 const transform=async(bytes:Buffer,protect:boolean)=>{
  const script="$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());$o=[Security.Cryptography.ProtectedData]::"+(protect?'Protect':'Unprotect')+"($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($o))";
  return new Promise<Buffer>((resolve,reject)=>{const child=spawn(path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});let out='';const timer=setTimeout(()=>child.kill(),10000);child.stderr.resume();child.stdout.on('data',b=>{out+=b.toString();if(out.length>65536)child.kill();});child.once('error',()=>{clearTimeout(timer);reject(Error('Protected control key unavailable.'));});child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(Error('Protected control key unavailable.'));else resolve(Buffer.from(out,'base64'));});child.stdin.end(bytes.toString('base64'));});
 };
 const file=path.join(trust.config.root,'control-key.dpapi');let wrapped:Buffer;
 try{wrapped=await readManagedFile(file,65536);}catch(error){if(!initialize||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  const key=randomBytes(32);try{wrapped=await transform(key,true);if(wrapped.equals(key))throw Error('Control key was not protected.');const h=await fs.open(file,'wx',0o600);try{await h.writeFile(wrapped);await h.sync();}finally{await h.close();}}finally{key.fill(0);}wrapped=await readManagedFile(file,65536);
 }
 const key=await transform(wrapped,false);if(key.length!==32){key.fill(0);throw Error('Invalid control key.');}return key;
}
export function managedControlAddress(c:ManagedConfig){return process.platform==='win32'?'\\\\.\\pipe\\capri-managed-'+managedHash(c.installationId+'\0'+c.ownerSha256):path.join('/tmp','capri-managed-'+c.installationId+'.sock');}
export async function serveManagedControl(controller:ManagedUpdateController,key:Buffer,onStop:()=>void){
 const c=controller.trust.config,channels=new Set<ManagedChannel>(),sockets=new Set<net.Socket>();
 const server=net.createServer(socket=>{sockets.add(socket);socket.setTimeout(120000,()=>socket.destroy());const channel=new ManagedChannel(socket,socket,key.toString('hex'),c.installationId,65536);channel.onLost=()=>socket.destroy();channels.add(channel);socket.once('close',()=>{sockets.delete(socket);channels.delete(channel);channel.close();});
  channel.handler=async(method,input)=>{z.object({}).strict().parse(input);if(method==='status')return controller.status();if(method==='start'){await controller.relaunch();return {started:true};}if(method==='stop'){await controller.stop();setTimeout(onStop,30);return {stopped:true};}throw Error('Unsupported controller command.');};
 });
 server.maxConnections=8;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen({path:managedControlAddress(c),exclusive:true},()=>{server.removeListener('error',reject);resolve();});});
 let closing:Promise<void>|undefined;
 return ()=>closing??=(async()=>{for(const channel of channels)channel.close();for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));key.fill(0);})();
}
export async function managedControlCommand(trust:ManagedTrust,key:Buffer,command:'start'|'status'|'stop'){
 const socket=net.createConnection(managedControlAddress(trust.config));try{
  await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  const channel=new ManagedChannel(socket,socket,key.toString('hex'),trust.config.installationId,65536);try{return await channel.request(command,{},90000);}finally{channel.close();}
 }finally{socket.destroy();key.fill(0);}
}
