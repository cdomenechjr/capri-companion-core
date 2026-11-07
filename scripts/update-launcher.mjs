// Preferred managed updater runtime. Build (no runtime npm/TypeScript dependency):
// scripts/build.mjs -> native/publish/update-launcher.cjs -> resources/native/update-launcher.cjs
// The existing electron-builder native extraResources rule includes this file outside asar.
// CLI: <pinned-node> <pinned-launcher.cjs> --trust-file <absolute-public-json>
//      --trust-file-sha256 <bootstrap-pin> --nonce <durable-startup-uuid-v4>
//      [--owner-pid <pid> --owner-start-ticks <ticks>] [--launch]
// Default is read-only verification. Launch requires the original owner's exact PID/start
// identity and durable nonce. The external managed host MUST hold its stable writer gate,
// prove all profile writers stopped, complete offline migration/receipt retention, and keep
// the protected root/trust/launcher/Node immutable through spawn and health observation.
// Bootstrap MUST generate randomUUID(), durably write it to state.json even when phase is
// healthy, and pass it as --nonce. For each subsequent restart, rearm a fresh nonce under
// the same gate after confirming prior owners stopped; never reuse a completed launch's
// nonce. Verification also requires the exact nonce; absence/malformed/mismatch is denied.
// This helper does not install, register startup, migrate, recover, delete or sign anything.
// Public trust schema 1 (strict): root, profile, port, nodeExecutable, nodeSha256,
// launcherSha256, keys:{keyId:Ed25519PublicPEM}, channel, arch, minimumSequence, dataVersion.
// dataVersion is the trusted offline profile schema at this launch, not candidate metadata.
// Root/profile must be disjoint. Trust, Node and this launcher must live outside BOTH.
// Pin this compiled file, not its source; bootstrap pins the trust JSON's exact bytes. No
// private signing/TLS material is read. Never invoke through PowerShell execution-policy flags.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {z} from 'zod';
import {createUpdateDisk,inspectUpdateZip,UpdateStateSchema,compareUpdateVersions} from '../src/extensions/updates.ts';
import {canonicalJson,releasePolicy} from '../src/extensions/policy.ts';

const hash=b=>createHash('sha256').update(b).digest('hex');
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const integer=z.number().int().nonnegative().safe();
const Trust=z.object({schemaVersion:z.literal(1),root:z.string(),profile:z.string(),
  port:integer.min(1024).max(65535),nodeExecutable:z.string(),nodeSha256:digest,launcherSha256:digest,
  keys:z.record(z.string(),z.string()).refine(v=>Object.keys(v).length>0),
  channel:z.enum(['stable','preview']),arch:z.enum(['x64','arm64']),minimumSequence:integer,dataVersion:integer.min(1)}).strict();
const uuid=z.string().uuid().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const fail=()=>{throw Error('Managed update verification refused.');};
const within=(value,root)=>{const r=path.relative(root,value);return !r||!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);};
function absolute(value){
  if(!path.isAbsolute(value)||path.resolve(value)===path.parse(value).root||
    process.platform==='win32'&&!/^[A-Za-z]:[\\/]/.test(value))fail();
  return path.resolve(value);
}
async function externalRead(file,max){
  // Reuse regular-file, hardlink, ancestor alias, bounded read and read-race checks.
  const disk=createUpdateDisk(path.dirname(file),async()=>{});
  await disk.assertProtected();return disk.read(path.basename(file),max);
}
function args(){
  const options=new Map(),allowed=['--trust-file','--trust-file-sha256','--owner-pid','--owner-start-ticks','--nonce','--launch','--maintenance','--snapshot-id'];
  for(let i=2;i<process.argv.length;i++){
    const name=process.argv[i];if(!allowed.includes(name)||options.has(name))fail();
    if(name==='--launch'||name==='--maintenance')options.set(name,true);
    else {const value=process.argv[++i];if(!value||value.startsWith('--'))fail();options.set(name,value);}
  }
  if(!options.has('--trust-file')||!digest.safeParse(options.get('--trust-file-sha256')).success)fail();
  const pid=options.get('--owner-pid'),ticks=options.get('--owner-start-ticks');
  if((pid===undefined)!==(ticks===undefined)||pid!==undefined&&(!/^[1-9]\d{0,9}$/.test(pid)||Number(pid)>2147483647||!/^[1-9]\d{0,18}$/.test(ticks)))fail();
  if(!uuid.safeParse(options.get('--nonce')).success)fail();
  if(options.has('--launch')&&(pid===undefined||!options.has('--nonce')))fail();
  if(options.has('--maintenance')&&(options.has('--launch')||!uuid.safeParse(options.get('--snapshot-id')).success))fail();
  return options;
}
async function ownerStatus(pid,ticks){
  // Exact Windows kernel start identity; never interpret an access/query failure as exited.
  // Other OSes may verify snapshots, but cannot launch without a reviewed identity adapter.
  if(process.platform!=='win32')fail();
  const script="$ErrorActionPreference='Stop';try{$p=Get-Process -Id "+pid+" -ErrorAction Stop;Write-Output ([string]$p.StartTime.ToUniversalTime().Ticks)}catch{if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*'){Write-Output 'exited'}else{throw}}";
  const result=await new Promise((resolve,reject)=>execFile('powershell.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')
  ],{windowsHide:true,timeout:10000,maxBuffer:4096},(error,stdout)=>error?reject(error):resolve(stdout.trim())));
  if(result==='exited')return false;
  if(result!==ticks)fail();return true;
}
async function main(){
  const options=args(),trustFile=absolute(options.get('--trust-file')),launcher=absolute(process.argv[1]);
  const trustBytes=await externalRead(trustFile,65536);
  if(hash(trustBytes)!==options.get('--trust-file-sha256'))fail();
  const config=Trust.parse(JSON.parse(trustBytes.toString('utf8')));
  const root=absolute(config.root),profile=absolute(config.profile),node=absolute(config.nodeExecutable);
  if(within(root,profile)||within(profile,root))fail();
  for(const file of [trustFile,launcher,node])if(within(file,root)||within(file,profile))fail();
  if(path.resolve(process.execPath).toLowerCase()!==node.toLowerCase()||
    hash(await externalRead(node,512*1024*1024))!==config.nodeSha256||
    hash(await externalRead(launcher,32*1024*1024))!==config.launcherSha256)fail();
  const profileStat=await fs.lstat(profile);if(!profileStat.isDirectory()||profileStat.isSymbolicLink())fail();
  // Validate profile ancestors too, without reading private profile contents.
  await createUpdateDisk(profile,async()=>{}).assertProtected();
  const disk=createUpdateDisk(root,async()=>{});
  async function verify(){
    await disk.assertProtected();
    const state=UpdateStateSchema.parse(JSON.parse((await disk.read('state.json',32*1024*1024)).toString('utf8')));
    if(state.sequenceFloor<config.minimumSequence||!options.has('--maintenance')&&!['healthy','staged','pending-health','rollback-health','rolled-back'].includes(state.phase))fail();
    if(!uuid.safeParse(state.nonce).success||options.get('--nonce')!==state.nonce)fail();
    const snapshot=options.has('--maintenance')&&state.previous?.id===options.get('--snapshot-id')?state.previous:state.active,r=snapshot.manifest.release;
    if(options.has('--maintenance')&&snapshot.id!==options.get('--snapshot-id'))fail();
    if(r.sequence>state.sequenceFloor||new Set(r.artifacts.map(a=>a.platform+':'+a.arch)).size!==r.artifacts.length)fail();
    const firstLaunch=state.phase==='pending-health'&&snapshot.id===state.active.id;
    if(options.has('--maintenance')&&firstLaunch)fail(); // only pinned known-good helpers may run offline
    if(firstLaunch&&(!state.candidate||!state.previous||!state.backup||
      canonicalJson(state.candidate)!==canonicalJson(snapshot)||r.sequence!==state.sequenceFloor||
      r.sequence<=state.previous.manifest.release.sequence||compareUpdateVersions(r.version,state.previous.manifest.release.version)<=0))fail();
    if(['rolled-back','rollback-health'].includes(state.phase)&&state.previous&&canonicalJson(state.previous)!==canonicalJson(snapshot))fail();
    // Historical validity is only for a previously installed/known-good pointer. A new
    // pending-health build must still be valid NOW, including on a delayed first launch.
    const decision=releasePolicy(snapshot.manifest,{now:firstLaunch?Date.now():r.publishedAt,
      channel:config.channel,platform:'win32',arch:config.arch,currentSequence:0,
      dataVersion:config.dataVersion,trustedKeys:config.keys});
    if(!decision.available)fail();
    const zip=await disk.read(`snapshots/${snapshot.id}/package.zip`,0x7fffffff);
    if(zip.length!==decision.artifact.bytes||hash(zip)!==decision.artifact.sha256)fail();
    const archive=await inspectUpdateZip(zip,8*2**30),actual=await disk.inventory(`snapshots/${snapshot.id}/app`);
    const inventory=canonicalJson(archive.files);
    if(canonicalJson(snapshot.files)!==inventory||canonicalJson(actual)!==inventory||hash(inventory)!==snapshot.inventorySha256)fail();
    const checkedAt=Date.now();
    if(firstLaunch&&(checkedAt<r.publishedAt||checkedAt>=r.expiresAt))fail();
    return {state,snapshot};
  }
  const verified=await verify();
  if(options.has('--owner-pid')){
    const deadline=Date.now()+60000;
    while(await ownerStatus(options.get('--owner-pid'),options.get('--owner-start-ticks'))){
      if(!options.has('--launch')||Date.now()>=deadline)fail();
      await new Promise(resolve=>setTimeout(resolve,200));
    }
  }
  if(options.has('--launch')){
    // Owner wait may be long. Recheck the full signed archive and every extracted byte,
    // pointer/nonce stability, then check the actual clock at the last spawn boundary.
    const final=await verify();if(canonicalJson(final.state)!==canonicalJson(verified.state))fail();
    const r=final.snapshot.manifest.release,now=Date.now();
    if(final.state.phase==='pending-health'&&(now<r.publishedAt||now>=r.expiresAt))fail();
    const executable=path.join(root,'snapshots',final.snapshot.id,'app','win-unpacked','Capri.exe');
    const child=spawn(executable,[],{cwd:path.dirname(executable),shell:false,detached:true,windowsHide:true,stdio:'ignore',
      env:{...process.env,CAPRI_PROFILE_DIR:profile,CAPRI_DEV_PORT:String(config.port),CAPRI_UPDATE_NONCE:final.state.nonce}});
    await new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',resolve);});
    child.unref(); // spawn is not health evidence; the external controller owns health/rollback.
  }
  console.log('Verified Capri '+verified.snapshot.manifest.release.version);
}
main().catch(()=>{console.error('Managed update verification refused. Check pinned runtime/trust, signed snapshot, schema, sequence and owner.');process.exitCode=1;});
