import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID,X509Certificate} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import {execFile} from 'node:child_process';
import {inflateRawSync} from 'node:zlib';
import {z} from 'zod';
import {ReleaseManifestSchema,ReleaseVersionSchema,Sha256Schema,type ReleaseManifest,type ReleaseArtifact} from './contracts';
import {canonicalJson,releasePolicy,type ReleasePolicyContext} from './policy';
import {retainContactJournalAcrossRollback} from './contacts';
import {retainPairedAndroidJournalAcrossRollback,type Store} from '../server/store';

/** Integration contract (operator bootstrap, never a tool/model argument):
 * - Install this module in the trusted host. Pin keys/feed CA outside candidate directories;
 *   bootstrap an ACL-protected, single-owner root with state.json and a verified known-good
 *   snapshot. Seed sequenceFloor from the actually installed signed sequence.
 *   Under the writer gate, bootstrap/restart must persist a fresh randomUUID() nonce in
 *   state.json (including healthy/rolled-back), then pass that exact --nonce to the launcher.
 *   Missing, malformed or mismatched nonces fail closed even for read-only verification.
 *   Keep all known-good public keys pinned through the recovery retention window. Run the
 *   engine in an owned helper when replacing the process that originally owned the profile.
 * - scripts/build.mjs bundles scripts/update-launcher.mjs (including this verifier and Zod)
 *   into native/publish/update-launcher.cjs. Existing extraResources native/publish -> native
 *   packages it at resources/native/update-launcher.cjs. Resolve with packagedUpdateLauncher,
 *   never a source checkout or app.asar path. Bootstrap pins its SHA256 and the external Node
 *   binary. The optional .ps1 wrapper is not required and never needs a policy exception.
 *   See the Node entrypoint for public trust fields/CLI and owned-host responsibilities.
 * - acquireMaintenance owns an exclusive OS/profile lease, blocks new task/call/mic/scan/game
 *   activity, closes the sole profile writer, and remains held through health/rollback.
 *   stopCandidate must confirm the whole candidate process has exited before profile restore.
 * - verifyAcceptance resolves independent operator evidence for this EXACT archive digest,
 *   snapshot commit/version and file inventory. Provider text/worker claims are never evidence.
 * - Profile backup captures the complete closed profile (including private config and contact
 *   linked records), not Store.export. Key stays with the host. restoreBackup must use a fresh
 *   profile; contactStores exposes the still-intact failed and recovered offline stores. This
 *   module itself merges main and all linked contact records before reopening either profile.
 * - The process adapter starts only the verified side-by-side snapshot, correlates a fresh
 *   startup nonce and checks version/schema/profile ownership, then returns observed health.
 *   No startup registration, installed-file replacement, signing or publishing occurs here.
 * - Recovery never resumes an interrupted candidate migration/start. It stops the candidate,
 *   restores the verified backup + all contact records, and launches known-good. Keep snapshots,
 *   archives, backup and sequenceFloor even after rollback or an uncertain transition.
 * Local files cannot defend against another unrestricted process: the host MUST enforce the
 * protected-root/lease contract. Unconfigured and portable hosts must not construct this engine.
 */
export const maxSupportedUpdateArtifactBytes=0x7fffffff; // bounded non-ZIP64 broker snapshot
const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const integer=z.number().int().nonnegative().safe();
const FileSchema=z.object({path:z.string(),bytes:integer,sha256:Sha256Schema}).strict();
export type UpdateFile=z.infer<typeof FileSchema>;
const SnapshotSchema=z.object({id:z.string().uuid(),manifest:ReleaseManifestSchema,
  files:z.array(FileSchema).min(1).max(50000),inventorySha256:Sha256Schema}).strict();
export type UpdateSnapshot=z.infer<typeof SnapshotSchema>;
const BackupSchema=z.object({id:z.string().uuid(),sha256:Sha256Schema,dataVersion:integer.min(1)}).strict();
export type UpdateBackup=z.infer<typeof BackupSchema>;
const phases=['staging','staged','backing-up','backed-up','activating','pending-health','healthy','rolling-back','rollback-health','rolled-back'] as const;
export const UpdateStateSchema=z.object({schemaVersion:z.literal(1),sequenceFloor:integer,
  active:SnapshotSchema,phase:z.enum(phases),candidate:SnapshotSchema.optional(),previous:SnapshotSchema.optional(),
  backup:BackupSchema.optional(),nonce:z.string().uuid().optional()}).strict();
export type UpdateState=z.infer<typeof UpdateStateSchema>;
export interface UpdateIdle {task:boolean;call:boolean;microphone:boolean;scan:boolean;game:boolean}
export interface UpdateTransport {read(url:string,maxBytes:number,signal:AbortSignal):Promise<Uint8Array>}
export interface UpdateDisk {
  /** All methods enforce containment, regular files, no links/aliases and single-link files. */
  read(relative:string,maxBytes:number):Promise<Buffer>;
  writeNew(relative:string,bytes:Uint8Array):Promise<void>;
  writeState(state:UpdateState):Promise<void>;
  createDirectory(relative:string):Promise<void>;
  inventory(relative:string):Promise<UpdateFile[]>;
  assertProtected():Promise<void>;
}
export interface UpdateHost {
  now():number;
  current():Promise<{version:string;dataVersion:number;sequence:number;automatic:boolean;idle:UpdateIdle}>;
  acquireMaintenance(signal:AbortSignal):Promise<{release():Promise<void>}>;
  restoreCursor():Promise<boolean>;
  verifyAcceptance(input:{manifest:ReleaseManifest;artifact:ReleaseArtifact;files:UpdateFile[];inventorySha256:string}):Promise<boolean>;
  backupProfile(id:string):Promise<{dataVersion:number;bytes:Uint8Array}>;
  verifyProfileBackup(bytes:Uint8Array,dataVersion:number):Promise<boolean>;
  migrateProfile(writeVersion:number,signal:AbortSignal):Promise<void>;
  start(snapshot:UpdateSnapshot,nonce:string):Promise<void>;
  /** Read-only observation. A host adapter must also bound process start/stop and never
   * leave an unowned late spawn after stopCandidate has confirmed termination. */
  healthy(snapshot:UpdateSnapshot,nonce:string):Promise<boolean>;
  /** Concrete managed hosts await bounded full application startup here after
   * health/epoch permits activation and before persisting a healthy pointer. */
  activate?(snapshot:UpdateSnapshot,nonce:string):Promise<void>;
  stopCandidate(snapshot:UpdateSnapshot):Promise<boolean>;
  restoreBackup(bytes:Uint8Array,dataVersion:number):Promise<void>;
  /** Both stores remain offline; restoreBackup must preserve the failed profile intact. */
  contactStores():Promise<{current:Pick<Store,'get'|'list'>;recovered:Pick<Store,'get'|'put'>}>;
}
export interface UpdateTrust {
  keys:Readonly<Record<string,string>>;channel:'stable'|'preview';arch:'x64'|'arm64';
  /** Exact operator-configured URL allowlist, including artifact routes; transport also enforces it. */
  allowedUrl(url:string,kind:'manifest'|'artifact'):boolean;
  minimumSequence:number;maxArtifactBytes?:number;maxExpandedBytes?:number;startupTimeoutMs?:number;
}
export function packagedUpdateLauncher(resourcesPath:string):string{return path.join(resourcesPath,'native','update-launcher.cjs');}
export async function retainUpdateContacts(current:Pick<Store,'get'>,recovered:Pick<Store,'get'|'put'>):Promise<void>{
  // This hook copies main AND every linked receipt/approval, and verifies writes.
  await retainContactJournalAcrossRollback(current,recovered);
}
function fail(message:string):never{throw Error(message);}
function aborted(signal:AbortSignal){if(signal.aborted)fail('Update cancelled.');}
function isIdle(idle:UpdateIdle){return idle&&['task','call','microphone','scan','game'].every(k=>idle[k as keyof UpdateIdle]===false);}
export function updateRelativePath(value:string):string {
  if(typeof value!=='string'||value.length>1000||!value||/[\\:\x00-\x1f\x7f]/.test(value)||value.startsWith('/')||
    value.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/[<>"|?*]/.test(p)||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))fail('Unsafe update path.');
  return value;
}
/** Semver ordering without lossy integer conversion, including numeric prereleases. */
export function compareUpdateVersions(a:string,b:string):number {
  ReleaseVersionSchema.parse(a);ReleaseVersionSchema.parse(b);
  const split=(v:string)=>v.split('+')[0].split('-'),aa=split(a),bb=split(b);
  const number=(x:string,y:string)=>x.length-y.length||(x<y?-1:x>y?1:0);
  const ac=aa[0].split('.'),bc=bb[0].split('.');
  for(let i=0;i<3;i++){const d=number(ac[i],bc[i]);if(d)return Math.sign(d);}
  const ap=aa.slice(1).join('-'),bp=bb.slice(1).join('-');
  if(!ap||!bp)return ap===bp?0:ap?-1:1;
  const x=ap.split('.'),y=bp.split('.');
  for(let i=0;i<Math.min(x.length,y.length);i++){
    if(x[i]===y[i])continue;const xn=/^\d+$/.test(x[i]),yn=/^\d+$/.test(y[i]);
    return xn&&yn?Math.sign(number(x[i],y[i])):xn!==yn?xn?-1:1:x[i]<y[i]?-1:1;
  }return Math.sign(x.length-y.length);
}
function sorted(files:UpdateFile[]){return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);}
function checkInventory(files:UpdateFile[]){
  const names=new Set<string>();
  for(const f of files){FileSchema.parse(f);updateRelativePath(f.path);const key=f.path.toLowerCase();
    if(names.has(key))fail('Duplicate update path.');names.add(key);}
  for(const name of names)for(let p=name.lastIndexOf('/');p>0;p=name.lastIndexOf('/',p-1))if(names.has(name.slice(0,p)))fail('File/directory alias.');
  if(!names.has('win-unpacked/capri.exe')||!names.has('win-unpacked/resources/app.asar'))fail('Complete packaged snapshot required.');
}
function snapshotCheck(s:UpdateSnapshot){SnapshotSchema.parse(s);checkInventory(s.files);
  if(hash(canonicalJson(sorted([...s.files])))!==s.inventorySha256)fail('Snapshot inventory changed.');}
const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes:Uint8Array){let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
/** Inspect raw ZIP names, local headers and directory before writing anything.
 * Inflate with an explicit per-entry output bound; ZIP metadata cannot waive limits.
 * Multi-volume/ZIP64/encrypted archives are unavailable rather than partly extracted. */
export async function inspectUpdateZip(bytes:Uint8Array,maxExpandedBytes:number):Promise<{files:UpdateFile[];contents:Map<string,Buffer>}> {
  if(bytes.length>0x7fffffff||!Number.isSafeInteger(maxExpandedBytes)||maxExpandedBytes<1)fail('Archive exceeds supported bounds.');
  const b=Buffer.from(bytes);let end=-1;
  for(let p=b.length-22;p>=Math.max(0,b.length-65557);p--)if(b.readUInt32LE(p)===0x06054b50&&p+22+b.readUInt16LE(p+20)===b.length){end=p;break;}
  if(end<0||b.readUInt16LE(end+4)||b.readUInt16LE(end+6)||b.readUInt16LE(end+8)!==b.readUInt16LE(end+10))fail('Unsupported archive.');
  const count=b.readUInt16LE(end+10),size=b.readUInt32LE(end+12),offset=b.readUInt32LE(end+16);
  if(!count||count>50000||count===65535||offset+size!==end)fail('Unsupported ZIP64 or invalid archive.');
  let p=offset,total=0;const names=new Set<string>(),fileNames=new Set<string>(),localOffsets=new Set<number>();
  const entries:{name:string;local:number;start:number;end:number;method:number;expanded:number;crc:number;directory:boolean}[]=[];
  for(let i=0;i<count;i++){
    if(p+46>end||b.readUInt32LE(p)!==0x02014b50)fail('Invalid archive directory.');
    const flags=b.readUInt16LE(p+8),method=b.readUInt16LE(p+10),expanded=b.readUInt32LE(p+24),compressed=b.readUInt32LE(p+20),
      len=b.readUInt16LE(p+28),extra=b.readUInt16LE(p+30),comment=b.readUInt16LE(p+32),attrs=b.readUInt32LE(p+38),local=b.readUInt32LE(p+42);
    if(p+46+len+extra+comment>end||flags&~0x80e||![0,8].includes(method)||b.readUInt16LE(p+34)||localOffsets.has(local))fail('Unsupported archive entry.');
    localOffsets.add(local);
    const raw=b.subarray(p+46,p+46+len),name=raw.toString('utf8'),directory=name.endsWith('/'),normalized=directory?name.slice(0,-1):name;
    if(!Buffer.from(name).equals(raw)||name.includes('\ufffd'))fail('Invalid archive encoding.');
    updateRelativePath(normalized);const key=normalized.toLowerCase();if(names.has(key))fail('Archive path alias.');names.add(key);
    const kind=(attrs>>>16)&0xf000;if(kind!==0&&kind!==(directory?0x4000:0x8000)||attrs&0x400||directory&&expanded!==0)fail('Archive links or special files rejected.');
    if(local+30>offset||b.readUInt32LE(local)!==0x04034b50||b.readUInt16LE(local+6)!==flags||b.readUInt16LE(local+8)!==method)fail('Invalid local archive entry.');
    const llen=b.readUInt16LE(local+26),lextra=b.readUInt16LE(local+28);
    if(!b.subarray(local+30,local+30+llen).equals(raw)||local+30+llen+lextra+compressed>offset)fail('Archive local name or bounds differ.');
    const crc=b.readUInt32LE(p+16),start=local+30+llen+lextra;
    if(!(flags&8)&&(b.readUInt32LE(local+14)!==crc||b.readUInt32LE(local+18)!==compressed||b.readUInt32LE(local+22)!==expanded))fail('Archive local sizes differ.');
    entries.push({name,local,start,end:start+compressed,method,expanded,crc,directory});
    if(!directory){fileNames.add(key);total+=expanded;if(total>maxExpandedBytes||expanded===0xffffffff)fail('Expanded archive exceeds limit.');}
    p+=46+len+extra+comment;
  }
  if(p!==end)fail('Archive directory length differs.');
  for(const name of names)for(let j=name.lastIndexOf('/');j>0;j=name.lastIndexOf('/',j-1))if(fileNames.has(name.slice(0,j)))fail('Archive file/directory conflict.');
  const ranges=entries.map(e=>({start:e.local,end:e.end})).sort((a,b)=>a.start-b.start);
  for(let i=1;i<ranges.length;i++)if(ranges[i].start<ranges[i-1].end)fail('Overlapping archive entries.');
  const files:UpdateFile[]=[],contents=new Map<string,Buffer>();
  for(const entry of entries){
    if(entry.expanded>0x7fffffff)fail('Archive entry exceeds supported bound.');
    const compressed=b.subarray(entry.start,entry.end),data=entry.method===0?compressed:inflateRawSync(compressed,{maxOutputLength:Math.max(1,entry.expanded)});
    if(data.length!==entry.expanded||crc32(data)!==entry.crc)fail('Archive data integrity differs.');
    if(!entry.directory){contents.set(entry.name,data);files.push({path:entry.name,bytes:data.length,sha256:hash(data)});}
  }
  if(files.length!==fileNames.size||files.reduce((n,f)=>n+f.bytes,0)!==total)fail('Archive entry interpretation differs.');
  checkInventory(files);return {files:sorted(files),contents};
}

export function encryptUpdateBackup(bytes:Uint8Array,key:Buffer,metadata:{id:string;dataVersion:number}):Buffer {
  if(key.length!==32)fail('Backup protection unavailable.');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(canonicalJson(metadata)));const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
  return Buffer.concat([Buffer.from('CAPRIUP1'),iv,cipher.getAuthTag(),encrypted]);
}
export function decryptUpdateBackup(bytes:Uint8Array,key:Buffer,metadata:{id:string;dataVersion:number}):Buffer {
  const b=Buffer.from(bytes);if(key.length!==32||b.length<36||b.subarray(0,8).toString()!=='CAPRIUP1')fail('Invalid encrypted backup.');
  const decipher=createDecipheriv('aes-256-gcm',key,b.subarray(8,20));decipher.setAAD(Buffer.from(canonicalJson(metadata)));decipher.setAuthTag(b.subarray(20,36));
  return Buffer.concat([decipher.update(b.subarray(36)),decipher.final()]);
}

export class SignedUpdateEngine {
  private busy=false;
  private readonly trust:UpdateTrust;
  private readonly key:Buffer;
  constructor(private disk:UpdateDisk,private host:UpdateHost,private transport:UpdateTransport,trust:UpdateTrust,backupKey:Buffer){
    if(backupKey.length!==32||!Number.isSafeInteger(trust.minimumSequence)||trust.minimumSequence<0||!Object.keys(trust.keys).length||
      trust.startupTimeoutMs!==undefined&&(!Number.isSafeInteger(trust.startupTimeoutMs)||trust.startupTimeoutMs<1||trust.startupTimeoutMs>120000))fail('Trusted managed bootstrap required.');
    this.trust={...trust,keys:Object.freeze({...trust.keys})};this.key=Buffer.from(backupKey);
  }
  private async exclusive<T>(fn:()=>Promise<T>):Promise<T>{if(this.busy)fail('Updater busy.');this.busy=true;try{await this.disk.assertProtected();return await fn();}finally{this.busy=false;}}
  private async state(){const state=UpdateStateSchema.parse(JSON.parse((await this.disk.read('state.json',32*1024*1024)).toString()));
    if(state.sequenceFloor<this.trust.minimumSequence||state.active.manifest.release.sequence>state.sequenceFloor)fail('Update sequence state invalid.');
    snapshotCheck(state.active);return state;}
  private async save(state:UpdateState){await this.disk.writeState(UpdateStateSchema.parse(state));
    if(canonicalJson(await this.state())!==canonicalJson(state))fail('Update state persistence failed.');}
  private async authorize(manifest:ReleaseManifest,state:UpdateState){
    const current=await this.host.current(),context:ReleasePolicyContext={now:this.host.now(),channel:this.trust.channel,platform:'win32',arch:this.trust.arch,
      currentSequence:Math.max(state.sequenceFloor,current.sequence),dataVersion:current.dataVersion,trustedKeys:this.trust.keys};
    if(current.sequence>state.sequenceFloor)fail('Installed sequence differs from managed bootstrap.');
    const decision=releasePolicy(manifest,context);if(!decision.available)fail('Release verification failed: '+decision.reason);
    if(new Set(manifest.release.artifacts.map(a=>a.platform+':'+a.arch)).size!==manifest.release.artifacts.length)fail('Duplicate artifact target.');
    if(compareUpdateVersions(manifest.release.version,current.version)<=0||compareUpdateVersions(manifest.release.version,state.active.manifest.release.version)<=0)fail('Release version is not newer.');
    if(!this.trust.allowedUrl(decision.artifact.url,'artifact'))fail('Artifact destination is not pinned.');
    return {artifact:decision.artifact,current};
  }
  private async verifySnapshot(snapshot:UpdateSnapshot){
    snapshotCheck(snapshot);
    // Reverify the signature against current host pins without treating known-good as a new update.
    const r=snapshot.manifest.release,decision=releasePolicy(snapshot.manifest,{now:r.publishedAt,channel:this.trust.channel,platform:'win32',arch:this.trust.arch,
      currentSequence:0,dataVersion:r.migration.writeVersion,trustedKeys:this.trust.keys});
    if(!decision.available)fail('Snapshot signature is untrusted.');
    const zip=await this.disk.read(`snapshots/${snapshot.id}/package.zip`,this.trust.maxArtifactBytes??maxSupportedUpdateArtifactBytes);
    if(zip.length!==decision.artifact.bytes||hash(zip)!==decision.artifact.sha256)fail('Snapshot archive changed.');
    const archive=await inspectUpdateZip(zip,this.trust.maxExpandedBytes??8*2**30);
    const actual=await this.disk.inventory(`snapshots/${snapshot.id}/app`);
    if(canonicalJson(actual)!==canonicalJson(snapshot.files)||canonicalJson(archive.files)!==canonicalJson(snapshot.files))fail('Staged bytes changed.');
    return decision.artifact;
  }
  private async health(snapshot:UpdateSnapshot,nonce:string,signal?:AbortSignal):Promise<boolean>{
    if(signal?.aborted)return false;
    let timer:NodeJS.Timeout|undefined,abort:(()=>void)|undefined;
    try{const observed=await Promise.race([this.host.healthy(snapshot,nonce),new Promise<false>(resolve=>{
      timer=setTimeout(()=>resolve(false),this.trust.startupTimeoutMs??30000);
      abort=()=>resolve(false);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)resolve(false);
    })]);return observed===true;}catch{return false;}
    finally{if(timer)clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);}
  }
  async stage(manifestUrl:string,signal:AbortSignal):Promise<UpdateSnapshot>{return this.exclusive(async()=>{
    aborted(signal);const state=await this.state();if(!['healthy','rolled-back'].includes(state.phase))fail('Recover previous update first.');
    const destination=new URL(manifestUrl);if(destination.protocol!=='https:'||destination.username||destination.password||destination.hash||destination.href!==manifestUrl)fail('Unsafe manifest URL.');
    if(!this.trust.allowedUrl(manifestUrl,'manifest'))fail('Manifest destination is not pinned.');
    const raw=await this.transport.read(manifestUrl,1024*1024,signal);if(raw.length>1024*1024)fail('Manifest too large.');
    const manifest=ReleaseManifestSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8'))),{artifact}=await this.authorize(manifest,state);
    const max=Math.min(this.trust.maxArtifactBytes??maxSupportedUpdateArtifactBytes,maxSupportedUpdateArtifactBytes);if(artifact.bytes>max)fail('Artifact exceeds limit.');
    state.phase='staging';delete state.candidate;delete state.backup;delete state.previous;delete state.nonce;await this.save(state);
    const bytes=await this.transport.read(artifact.url,artifact.bytes,signal);aborted(signal);
    if(bytes.length!==artifact.bytes||hash(bytes)!==artifact.sha256)fail('Artifact hash or byte count differs.');
    const {files,contents}=await inspectUpdateZip(bytes,this.trust.maxExpandedBytes??8*2**30);
    const candidate:UpdateSnapshot={id:randomUUID(),manifest,files,inventorySha256:hash(canonicalJson(files))};
    if(await this.host.verifyAcceptance({manifest,artifact,files,inventorySha256:candidate.inventorySha256})!==true)fail('Independent acceptance required.');
    const base=`snapshots/${candidate.id}`;await this.disk.createDirectory(base);await this.disk.writeNew(`${base}/package.zip`,bytes);await this.disk.createDirectory(`${base}/app`);
    for(const f of files){aborted(signal);await this.disk.writeNew(`${base}/app/${f.path}`,contents.get(f.path)!);}
    await this.verifySnapshot(candidate);aborted(signal);state.phase='staged';state.candidate=candidate;await this.save(state);return candidate;
  });}
  async apply(signal:AbortSignal):Promise<'healthy'|'rolled-back'|'deferred'>{return this.exclusive(async()=>{
    let state=await this.state();if(state.phase!=='staged'||!state.candidate)fail('No verified staged update.');
    let auth=await this.authorize(state.candidate.manifest,state);aborted(signal);
    if(!auth.current.automatic||!isIdle(auth.current.idle))return 'deferred';
    const lease=await this.host.acquireMaintenance(signal);
    try {
      state=await this.state();if(state.phase!=='staged'||!state.candidate)fail('Staged state changed.');
      auth=await this.authorize(state.candidate.manifest,state);aborted(signal);
      if(!auth.current.automatic||!isIdle(auth.current.idle))return 'deferred';
      const candidate=state.candidate,artifact=await this.verifySnapshot(candidate);
      await this.verifySnapshot(state.active);
      const prior=state.active.manifest.release.migration;
      if(auth.current.dataVersion<prior.readMin||auth.current.dataVersion>prior.readMax)fail('Known-good cannot read the backup schema.');
      if(await this.host.verifyAcceptance({manifest:candidate.manifest,artifact,files:candidate.files,inventorySha256:candidate.inventorySha256})!==true)fail('Independent acceptance changed.');
      if(await this.host.restoreCursor()!==true)fail('Cursor restoration required.');aborted(signal);
      state.phase='backing-up';await this.save(state);
      const id=randomUUID(),profile=await this.host.backupProfile(id);
      if(profile.dataVersion!==auth.current.dataVersion||await this.host.verifyProfileBackup(profile.bytes,profile.dataVersion)!==true)fail('Profile backup verification failed.');
      const metadata={id,dataVersion:profile.dataVersion},encrypted=encryptUpdateBackup(profile.bytes,this.key,metadata);
      await this.disk.writeNew(`backups/${id}.bin`,encrypted);
      const observed=await this.disk.read(`backups/${id}.bin`,encrypted.length);
      const decoded=decryptUpdateBackup(observed,this.key,metadata);
      if(!decoded.equals(Buffer.from(profile.bytes))||await this.host.verifyProfileBackup(decoded,profile.dataVersion)!==true)fail('Encrypted backup readback failed.');
      state.backup={...metadata,sha256:hash(observed)};state.phase='backed-up';await this.save(state);
      await this.verifySnapshot(candidate);auth=await this.authorize(candidate.manifest,state);aborted(signal);
      if(!auth.current.automatic||!isIdle(auth.current.idle))fail('Update became busy or disabled.');
      state.previous=state.active;state.sequenceFloor=Math.max(state.sequenceFloor,candidate.manifest.release.sequence);
      state.phase='activating';state.nonce=randomUUID();await this.save(state); // burn sequence BEFORE migration/start
      try {
        aborted(signal);
        await this.host.migrateProfile(candidate.manifest.release.migration.writeVersion,signal);aborted(signal);
        await this.verifySnapshot(candidate);state.active=candidate;state.phase='pending-health';await this.save(state);
        // Migration, disk verification and durable writes can outlast a manifest's lifetime.
        // The sequence was deliberately burned already; authorize() would reject that replay.
        // Recheck actual time at the final synchronous boundary before first process start.
        const launchNow=this.host.now(),release=candidate.manifest.release;
        if(!Number.isSafeInteger(launchNow)||launchNow<release.publishedAt||launchNow>=release.expiresAt)fail('Release expired before first launch.');
        aborted(signal);
        await this.host.start(candidate,state.nonce!);
        if(await this.health(candidate,state.nonce!,signal)!==true)fail('Startup health failed.');aborted(signal);
        await this.host.activate?.(candidate,state.nonce!);aborted(signal);
        state.phase='healthy';await this.save(state);return 'healthy';
      }catch {await this.rollback(state);return 'rolled-back';}
    }finally{await lease.release();}
  });}
  private async rollback(state:UpdateState){
    if(!state.previous||!state.backup||!state.candidate)fail('Recovery metadata missing; keep profile closed.');
    state.phase='rolling-back';await this.save(state);
    if(await this.host.restoreCursor()!==true)fail('Cursor restoration required for rollback.');
    if(await this.host.stopCandidate(state.candidate)!==true)fail('Candidate termination unconfirmed; keep profile closed.');
    await this.verifySnapshot(state.previous);
    const b=await this.disk.read(`backups/${state.backup.id}.bin`,2**31-1);if(hash(b)!==state.backup.sha256)fail('Recovery backup changed.');
    const restored=decryptUpdateBackup(b,this.key,{id:state.backup.id,dataVersion:state.backup.dataVersion});
    if(await this.host.verifyProfileBackup(restored,state.backup.dataVersion)!==true)fail('Recovery backup invalid.');
    await this.host.restoreBackup(restored,state.backup.dataVersion);
    const stores=await this.host.contactStores();
    if(stores.current===stores.recovered)fail('Distinct offline recovery stores required.');
    await retainUpdateContacts(stores.current,stores.recovered); // main AND every linked receipt/approval
    await retainPairedAndroidJournalAcrossRollback(stores.current,stores.recovered);
    state.active=state.previous;state.phase='rollback-health';state.nonce=randomUUID();await this.save(state);
    await this.host.start(state.active,state.nonce);
    if(await this.health(state.active,state.nonce)!==true){await this.host.stopCandidate(state.active);fail('Known-good health unconfirmed; recovery required.');}
    await this.host.activate?.(state.active,state.nonce);
    state.phase='rolled-back';await this.save(state);
  }
  async recover(signal:AbortSignal):Promise<void>{return this.exclusive(async()=>{
    const state=await this.state();if(['healthy','staged','rolled-back'].includes(state.phase))return;
    if(state.phase==='staging'){
      // Downloads did not acquire the profile lease. Do not interrupt its current owner.
      state.phase='healthy';delete state.candidate;delete state.previous;delete state.backup;delete state.nonce;await this.save(state);return;
    }
    const lease=await this.host.acquireMaintenance(signal);
    try {
      if(await this.host.restoreCursor()!==true)fail('Cursor restoration required.');
      if(['activating','pending-health','rolling-back'].includes(state.phase))await this.rollback(state);
      else if(state.phase==='rollback-health'){
        await this.verifySnapshot(state.active);
        if(!await this.health(state.active,state.nonce!)){
          // After a crash between rollback pointer/start, first confirm there is no owner.
          if(await this.host.stopCandidate(state.active)!==true)fail('Known-good owner termination unconfirmed.');
          await this.host.start(state.active,state.nonce!);
          if(!await this.health(state.active,state.nonce!)){await this.host.stopCandidate(state.active);fail('Known-good health unconfirmed; recovery required.');}
        }
        await this.host.activate?.(state.active,state.nonce!);state.phase='rolled-back';await this.save(state);
      }else{
        // Backup phases closed the sole writer, but never migrated it. Restart verified old
        // code against that intact profile; do not restore a backup or discard contact records.
        await this.verifySnapshot(state.active);
        if(await this.host.stopCandidate(state.active)!==true)fail('Original owner termination unconfirmed.');
        state.phase='rollback-health';state.nonce=randomUUID();await this.save(state);
        await this.host.start(state.active,state.nonce);
        if(!await this.health(state.active,state.nonce)){await this.host.stopCandidate(state.active);fail('Original startup health unconfirmed.');}
        await this.host.activate?.(state.active,state.nonce);
        state.phase='healthy';await this.save(state);
      }
    }finally{await lease.release();}
  });}
}

/** Real contained storage. Root/ancestors must already be created by trusted bootstrap.
 * Windows additionally checks the actual ReparsePoint attribute (realpath alone is insufficient).
 * The injected assertion enforces host ACLs/ownership, not candidate-provided booleans. */
export function createUpdateDisk(root:string,assertProtected:()=>Promise<void>):UpdateDisk {
  const base=path.resolve(root);
  if(!path.isAbsolute(root)||base===path.parse(base).root||process.platform==='win32'&&!/^[A-Za-z]:[\\/]/.test(root))fail('Dedicated absolute local update root required.');
  const target=(relative:string)=>path.join(base,...updateRelativePath(relative).split('/'));
  async function check(value:string,missing=false){
    const resolved=path.resolve(value);if(resolved!==base&&!resolved.startsWith(base+path.sep))fail('Update escaped root.');
    const chain:string[]=[];let cursor=resolved;
    for(;;){chain.push(cursor);const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
    for(const item of chain.reverse()){
      let s;try{s=await fs.lstat(item);}catch(e){if(missing&&(e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
      if(s.isSymbolicLink()||!s.isDirectory()&&!s.isFile()||s.isFile()&&s.nlink!==1||path.resolve(await fs.realpath(item)).toLowerCase()!==item.toLowerCase())fail('Update path uses an alias.');
    }
  }
  async function windowsTreeCheck(value:string){
    if(process.platform==='win32'){
      const script="$ErrorActionPreference='Stop'; $root="+"[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+Buffer.from(value).toString('base64')+"')); $p=$root; while($p){$i=Get-Item -LiteralPath $p -Force;if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse point rejected'};$p=[IO.Path]::GetDirectoryName($p)}; $q=New-Object 'System.Collections.Generic.Queue[string]';$q.Enqueue($root);while($q.Count){$dir=$q.Dequeue();foreach($i in Get-ChildItem -LiteralPath $dir -Force){if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse point rejected'};if($i.PSIsContainer){$q.Enqueue($i.FullName)}}}";
      await new Promise<void>((resolve,reject)=>execFile('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:4096},e=>e?reject(Error('Windows update path check failed.')):resolve()));
    }
  }
  async function directory(value:string){await check(value,true);await fs.mkdir(value,{recursive:true});await check(value);}
  const disk:UpdateDisk={
    async assertProtected(){await assertProtected();await check(base);await windowsTreeCheck(base);},
    async read(relative,maxBytes){const file=target(relative);await check(file);const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
      try{const before=await h.stat();if(!before.isFile()||before.nlink!==1||before.size>maxBytes)fail('Invalid update file.');const bytes=await h.readFile();const after=await h.stat();
        await check(file);const named=await fs.stat(file);if(bytes.length!==before.size||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||named.ino!==before.ino||named.size!==before.size||named.mtimeMs!==before.mtimeMs||named.ctimeMs!==before.ctimeMs)fail('Update bytes changed during read.');return bytes;
      }finally{await h.close();}},
    async writeNew(relative,bytes){const file=target(relative);await directory(path.dirname(file));await check(file,true);
      const h=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
      try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}await check(file);},
    async createDirectory(relative){const value=target(relative);await check(value,true);await directory(path.dirname(value));await fs.mkdir(value);await check(value);},
    async writeState(state){const temp=`state-${randomUUID()}.tmp`;await disk.writeNew(temp,Buffer.from(canonicalJson(UpdateStateSchema.parse(state))));await check(target('state.json'),true);
      await fs.rename(target(temp),target('state.json'));await check(target('state.json'));
      // fsync directories is not supported on Windows; atomic same-volume rename + flushed file.
      if(process.platform!=='win32'){const h=await fs.open(base,constants.O_RDONLY);try{await h.sync();}finally{await h.close();}}},
    async inventory(relative){const start=target(relative),files:UpdateFile[]=[];await windowsTreeCheck(start);
      async function visit(dir:string,prefix:string){await check(dir);for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        const name=prefix+entry.name;updateRelativePath(name);await check(path.join(dir,entry.name));
        if(entry.isDirectory())await visit(path.join(dir,entry.name),name+'/');else if(entry.isFile()){const data=await disk.read(relative+'/'+name,2**31-1);files.push({path:name,bytes:data.length,sha256:hash(data)});}else fail('Snapshot contains a link.');
      }}await visit(start,'');checkInventory(files);return sorted(files);},
  };return disk;
}

/** Dedicated fixed loopback HTTPS client, independently implemented from the operator feed
 * contract. No generic fetch/private-network exemption, redirects or global TLS overrides. */
export function createPinnedUpdateTransport(config:{origin:string;ca:string;certificateSha256:string;timeoutMs?:number}):UpdateTransport {
  const origin=new URL(config.origin),certificate=new X509Certificate(config.ca),timeout=config.timeoutMs??120000;
  if(origin.origin!==config.origin||origin.protocol!=='https:'||!['127.0.0.1','localhost'].includes(origin.hostname)||!certificate.ca||
    hash(certificate.raw)!==config.certificateSha256||!Number.isSafeInteger(timeout)||timeout<1||timeout>3600000)fail('Invalid pinned feed configuration.');
  const allowedUrl=(value:string)=>{try{const url=new URL(value);return url.href===value&&url.origin===config.origin&&!url.username&&!url.password&&!url.search&&!url.hash&&
    (url.pathname==='/manifest.json'||/^\/artifacts\/[a-f0-9]{64}\.zip$/.test(url.pathname));}catch{return false;}};
  return {async read(value,maxBytes,signal){
    aborted(signal);if(!allowedUrl(value)||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>0x7fffffff)fail('Feed request rejected.');
    return new Promise<Buffer>((resolve,reject)=>{
      // certificateSha256 pins the supplied CA, not the CA-signed server leaf. Restrict
      // chain trust to that CA and retain normal SAN/hostname and validity checks.
      let timer:NodeJS.Timeout;const request=https.get(value,{ca:certificate.toString(),rejectUnauthorized:true,
        checkServerIdentity:tls.checkServerIdentity,
        agent:false,minVersion:'TLSv1.2',family:4,signal,headers:{'Accept-Encoding':'identity'},
        lookup(_hostname,options,callback){if(options.all)callback(null,[{address:'127.0.0.1',family:4}]);else callback(null,'127.0.0.1',4);}},response=>{
        const length=response.headers['content-length'];if(response.statusCode!==200||response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'||
          length!==undefined&&(!/^\d+$/.test(length)||Number(length)>maxBytes)){response.destroy();reject(Error('Feed response rejected.'));return;}
        const chunks:Buffer[]=[];let count=0;response.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>maxBytes){request.destroy(Error('Feed exceeds limit.'));return;}chunks.push(chunk);});
        response.once('error',()=>reject(Error('Feed transfer failed.')));response.once('end',()=>{clearTimeout(timer);if(length!==undefined&&count!==Number(length))reject(Error('Feed size differs.'));else resolve(Buffer.concat(chunks));});
      });
      timer=setTimeout(()=>request.destroy(Error('Feed timeout.')),timeout);timer.unref();request.once('error',()=>{clearTimeout(timer);reject(Error('Pinned feed unavailable.'));});request.once('close',()=>clearTimeout(timer));
    });
  }};
}
