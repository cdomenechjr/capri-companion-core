import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign,X509Certificate} from 'node:crypto';
import tls from 'node:tls';
import https from 'node:https';
import type {AddressInfo} from 'node:net';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import JSZip from 'jszip';
import {build} from 'esbuild';
import {canonicalJson,releaseSigningPayload} from '../src/extensions/policy';
import type {ReleaseManifest} from '../src/extensions/contracts';
import {SignedUpdateEngine,compareUpdateVersions,createUpdateDisk,createPinnedUpdateTransport,decryptUpdateBackup,
  encryptUpdateBackup,inspectUpdateZip,packagedUpdateLauncher,retainUpdateContacts,updateRelativePath,
  type UpdateDisk,type UpdateFile,type UpdateHost,type UpdateIdle,type UpdateSnapshot,type UpdateState,type UpdateTrust} from '../src/extensions/updates';

// Ephemeral cryptographic fixtures only. No operator keys, TLS identity, installed profile,
// external network, paid provider, actual executable, startup change or live install is used.
// The TLS integration test uses only an ephemeral loopback server and generated test CA/leaves.
const keys=generateKeyPairSync('ed25519'),pem=keys.publicKey.export({format:'pem',type:'spki'}).toString();
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const now=1000000;
const signal=()=>new AbortController().signal;
async function fixtureDirectory(prefix:string){
  // Public-assets checks remove dist; these fixtures must also work before any build.
  const checkout=path.resolve('.'),parent=path.join(checkout,'dist');
  assert.equal(await fs.realpath(checkout),checkout,'fixture checkout must not be aliased');
  try{await fs.mkdir(parent);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const info=await fs.lstat(parent);
  assert.ok(info.isDirectory()&&!info.isSymbolicLink(),'fixture parent must be a regular directory');
  assert.equal(await fs.realpath(parent),parent,'fixture parent must stay inside the checkout');
  const directory=await fs.mkdtemp(path.join(parent,prefix));
  assert.equal(path.dirname(directory),parent);
  assert.equal(await fs.realpath(directory),directory,'fixture directory must not be aliased');
  return directory;
}
async function archive(version='0.7.0',other:Record<string,string>={}){
  const zip=new JSZip();zip.file('win-unpacked/Capri.exe','NEUTRAL-FAKE-EXECUTABLE-'+version);zip.file('win-unpacked/resources/app.asar','fake packaged app '+version);
  zip.file('VERIFICATION.json',JSON.stringify({fixture:true,version}));for(const [name,bytes] of Object.entries(other))zip.file(name,bytes);
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',platform:'UNIX'});
}
function signed(bytes:Uint8Array,changes:Partial<ReleaseManifest['release']>={}):ReleaseManifest {
  const manifest:ReleaseManifest={release:{schemaVersion:1,version:'0.7.0',sequence:2,channel:'preview',publishedAt:now-100,expiresAt:now+10000,
    migration:{readMin:1,readMax:2,writeVersion:2,backupRequired:true,reversible:false},
    artifacts:[{platform:'win32',arch:'x64',url:'https://127.0.0.1:19443/artifacts/'+sha(bytes)+'.zip',sha256:sha(bytes),bytes:bytes.length}],...changes},
    signature:{algorithm:'ed25519',keyId:'operator',value:''}};
  manifest.signature.value=sign(null,Buffer.from(releaseSigningPayload(manifest)),keys.privateKey).toString('base64');return manifest;
}
class MemoryDisk implements UpdateDisk {
  files=new Map<string,Buffer>();dirs=new Set<string>();protected=true;
  failPhase?:UpdateState['phase'];powerLost=false;
  async assertProtected(){assert.equal(this.protected,true);}
  async read(p:string,max:number){if(this.powerLost)throw Error('simulated outage');const b=this.files.get(p);if(!b)throw Error('missing '+p);if(b.length>max)throw Error('size');return Buffer.from(b);}
  async writeNew(p:string,b:Uint8Array){if(this.powerLost)throw Error('simulated outage');updateRelativePath(p);if(this.files.has(p))throw Error('exists');this.files.set(p,Buffer.from(b));}
  async writeState(s:UpdateState){if(this.powerLost)throw Error('simulated outage');this.files.set('state.json',Buffer.from(canonicalJson(s)));
    if(s.phase===this.failPhase){this.powerLost=true;throw Error('power lost after durable '+s.phase);}}
  async createDirectory(p:string){if(this.dirs.has(p))throw Error('exists');this.dirs.add(p);}
  async inventory(p:string){const files:UpdateFile[]=[];for(const [name,bytes] of this.files)if(name.startsWith(p+'/'))files.push({path:name.slice(p.length+1),bytes:bytes.length,sha256:sha(bytes)});return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);}
  state():UpdateState{return JSON.parse(this.files.get('state.json')!.toString());}
}
async function fixture(){
  const disk=new MemoryDisk(),oldZip=await archive('0.6.0'),oldManifest=signed(oldZip,{version:'0.6.0',sequence:1,migration:{readMin:1,readMax:1,writeVersion:1,backupRequired:true,reversible:true}});
  const inspected=await inspectUpdateZip(oldZip,100000),good:UpdateSnapshot={id:randomUUID(),manifest:oldManifest,files:inspected.files,inventorySha256:sha(canonicalJson(inspected.files))};
  disk.files.set(`snapshots/${good.id}/package.zip`,oldZip);for(const [name,b] of inspected.contents)disk.files.set(`snapshots/${good.id}/app/${name}`,b);
  await disk.writeState({schemaVersion:1,sequenceFloor:1,active:good,phase:'healthy',nonce:randomUUID()});
  const zip=await archive(),manifest=signed(zip),downloads:string[]=[],events:string[]=[],backupKey=randomBytes(32),profile=Buffer.from('complete fixture profile WITH PRIVATE CONTACT RECORDS');
  let idle:UpdateIdle={task:false,call:false,microphone:false,scan:false,game:false},automatic=true,dataVersion=1,acceptance=true,healthy=true,stopped=true,cursor=true,clock=now;
  let onMigrate=()=>{},onBackup=()=>{},onAcceptance=()=>{},onLease=()=>{},onRetain=()=>{};
  const retained=new Map<string,any>(),recovered={get:async(k:string,id:string)=>retained.get(k+':'+id),put:async(k:string,v:any)=>{retained.set(k+':'+v.id,structuredClone(v));return v;}};
  let running:UpdateSnapshot|undefined=good;
  const host:UpdateHost={
    now:()=>clock,current:async()=>({version:'0.6.0',dataVersion,sequence:1,automatic,idle}),
    acquireMaintenance:async()=>{events.push('lease');onLease();return {release:async()=>{events.push('release');}};},
    restoreCursor:async()=>{events.push('cursor');return cursor;},
    verifyAcceptance:async ({artifact,manifest:m,inventorySha256,files})=>{events.push('acceptance');assert.equal(artifact.sha256,m.release.artifacts[0].sha256);assert.equal(inventorySha256,sha(canonicalJson(files)));onAcceptance();return acceptance;},
    backupProfile:async()=>{events.push('backup');onBackup();return {dataVersion,bytes:profile};},
    verifyProfileBackup:async (bytes,version)=>Buffer.from(bytes).equals(profile)&&version===1,
    migrateProfile:async version=>{events.push('migrate');dataVersion=version;onMigrate();},
    start:async snapshot=>{events.push(snapshot.id===good.id?'start-old':'start-new');running=snapshot;},
    healthy:async snapshot=>{events.push(snapshot.id===good.id?'health-old':'health-new');return running?.id===snapshot.id&&(snapshot.id===good.id||healthy);},
    stopCandidate:async()=>{events.push('stop');if(stopped)running=undefined;return stopped;},
    restoreBackup:async (bytes,version)=>{assert.deepEqual(Buffer.from(bytes),profile);events.push('restore');dataVersion=version;},
    contactStores:async()=>{events.push('retain-contacts');onRetain();return {current:{get:async()=>undefined,list:async()=>[]},recovered};},
  };
  const trust:UpdateTrust={keys:{operator:pem},channel:'preview',arch:'x64',minimumSequence:1,maxExpandedBytes:100000,maxArtifactBytes:100000,
    allowedUrl:(value,kind)=>kind==='manifest'?value==='https://127.0.0.1:19443/manifest.json':value.startsWith('https://127.0.0.1:19443/artifacts/')};
  const transport={read:async (url:string,max:number)=>{downloads.push(url);const bytes=url.endsWith('/manifest.json')?Buffer.from(JSON.stringify(manifest)):zip;assert.ok(bytes.length<=max);return bytes;}};
  const engine=()=>new SignedUpdateEngine(disk,host,transport,trust,backupKey);
  return {disk,good,manifest,zip,events,downloads,backupKey,profile,host,trust,transport,engine,
    stage:()=>engine().stage('https://127.0.0.1:19443/manifest.json',signal()),
    clock:(value:number)=>{clock=value;},idle:(value:Partial<UpdateIdle>)=>{idle={...idle,...value};},automatic:(value:boolean)=>{automatic=value;},
    acceptance:(value:boolean)=>{acceptance=value;},healthy:(value:boolean)=>{healthy=value;},stopped:(value:boolean)=>{stopped=value;},cursor:(value:boolean)=>{cursor=value;},
    onMigrate:(fn:()=>void)=>{onMigrate=fn;},onBackup:(fn:()=>void)=>{onBackup=fn;},onAcceptance:(fn:()=>void)=>{onAcceptance=fn;},onLease:(fn:()=>void)=>{onLease=fn;},onRetain:(fn:()=>void)=>{onRetain=fn;}};
}

test('real crypto, complete ZIP staging, authenticated encrypted backup and healthy side-by-side activation',async()=>{
  const f=await fixture(),candidate=await f.stage();assert.equal(f.disk.state().active.id,f.good.id);assert.equal(f.disk.state().phase,'staged');
  assert.ok(candidate.files.some(x=>x.path==='win-unpacked/Capri.exe'));
  assert.equal(await f.engine().apply(signal()),'healthy');const state=f.disk.state();assert.equal(state.active.id,candidate.id);assert.equal(state.sequenceFloor,2);
  const encrypted=f.disk.files.get(`backups/${state.backup!.id}.bin`)!;assert.ok(!encrypted.includes(f.profile));
  assert.deepEqual(decryptUpdateBackup(encrypted,f.backupKey,{id:state.backup!.id,dataVersion:1}),f.profile);
  assert.ok(f.events.indexOf('cursor')<f.events.indexOf('backup'));assert.ok(f.events.indexOf('backup')<f.events.indexOf('migrate'));
  assert.equal(f.events.filter(x=>x==='start-new').length,1);assert.equal(f.events.at(-1),'release');
  await f.engine().recover(signal());assert.equal(f.events.filter(x=>x==='start-new').length,1);
  await assert.rejects(f.stage(),/rollback-or-current/); // durable anti-replay, even though fixture current() is older
  Object.assign(f.manifest,signed(f.zip,{version:'0.6.5',sequence:3}));
  await assert.rejects(f.stage(),/not newer/); // stale process version cannot permit pointer downgrade
});

test('signature/tampering/untrusted publisher/schema/channel/replay/downgrade fail before artifact fetch',async()=>{
  const cases:(()=>Promise<Awaited<ReturnType<typeof fixture>>>)[]=[];
  for(const change of [
    (m:ReleaseManifest)=>{m.signature.value='A'.repeat(86)+'==';},
    (m:ReleaseManifest)=>{m.signature.keyId='feed-supplied-key';},
    (m:ReleaseManifest)=>{m.release.version='0.9.0';},
  ])cases.push(async()=>{const f=await fixture();change(f.manifest);return f;});
  for(const change of [{sequence:1},{version:'0.5.0',sequence:3},{version:'0.6.0+build.2',sequence:3},{channel:'stable'},
    {publishedAt:now+1},{expiresAt:now},{migration:{readMin:2,readMax:3,writeVersion:2,backupRequired:true,reversible:true}},
    {schemaVersion:2}] as Partial<ReleaseManifest['release']>[])cases.push(async()=>{const f=await fixture();Object.assign(f.manifest,signed(f.zip,change));return f;});
  for(const make of cases){const f=await make();await assert.rejects(f.stage());assert.equal(f.downloads.length,1);assert.ok(!f.events.includes('backup'));}
  const f=await fixture();f.trust.keys={};assert.throws(()=>f.engine(),/bootstrap/);
  const unknown=await fixture();(unknown.manifest as any).approved=true;await assert.rejects(unknown.stage());assert.equal(unknown.downloads.length,1);
});

test('artifact byte count/hash, independent acceptance and destination pins are mandatory',async()=>{
  for(const fault of ['hash','bytes','acceptance','url'] as const){
    const f=await fixture();
    if(fault==='hash')f.zip[0]^=1;
    if(fault==='bytes'){f.manifest.release.artifacts[0].bytes++;f.manifest.signature.value=sign(null,Buffer.from(releaseSigningPayload(f.manifest)),keys.privateKey).toString('base64');}
    if(fault==='acceptance')f.acceptance(false);
    if(fault==='url')f.trust.allowedUrl=()=>false;
    await assert.rejects(f.stage());assert.equal(f.disk.state().active.id,f.good.id);assert.ok(!f.events.includes('migrate'));
  }
});

test('all five busy states and disabled automatic preference defer before backup or process effects',async()=>{
  for(const key of ['task','call','microphone','scan','game'] as const){const f=await fixture();await f.stage();f.idle({[key]:true});
    assert.equal(await f.engine().apply(signal()),'deferred');assert.equal(f.disk.state().phase,'staged');assert.ok(!f.events.includes('lease'));assert.ok(!f.events.includes('backup'));}
  const f=await fixture();await f.stage();f.automatic(false);assert.equal(await f.engine().apply(signal()),'deferred');assert.ok(!f.events.includes('lease'));
  const changed=await fixture();await changed.stage();changed.onLease(()=>changed.idle({microphone:true}));assert.equal(await changed.engine().apply(signal()),'deferred');assert.ok(!changed.events.includes('backup'));
});

test('cursor recovery, backup validation, cancellation and fresh idle check prevent migration',async()=>{
  for(const fault of ['cursor','backup','cancel','busy'] as const){
    const f=await fixture();await f.stage();const controller=new AbortController();
    if(fault==='cursor')f.cursor(false);
    if(fault==='backup')f.host.verifyProfileBackup=async()=>false;
    if(fault==='cancel')f.onBackup(()=>controller.abort());
    if(fault==='busy')f.onBackup(()=>f.idle({game:true}));
    await assert.rejects(f.engine().apply(controller.signal));assert.ok(!f.events.includes('migrate'));assert.equal(f.disk.state().active.id,f.good.id);
    f.onBackup(()=>{});await f.engine().recover(signal());assert.ok(!f.events.includes('start-new'));
  }
});

test('staged bytes and known-good archive are verified again before any profile mutation',async()=>{
  for(const fault of ['file','archive','inventory','prior'] as const){const f=await fixture(),s=await f.stage();
    if(fault==='file')f.disk.files.set(`snapshots/${s.id}/app/win-unpacked/Capri.exe`,Buffer.from('changed'));
    if(fault==='archive')f.disk.files.get(`snapshots/${s.id}/package.zip`)![0]^=1;
    if(fault==='inventory')f.disk.files.set(`snapshots/${s.id}/app/extra.dll`,Buffer.from('extra'));
    if(fault==='prior')f.disk.files.get(`snapshots/${f.good.id}/package.zip`)![0]^=1;
    await assert.rejects(f.engine().apply(signal()));assert.ok(!f.events.includes('backup'));assert.ok(!f.events.includes('migrate'));
  }
});

test('failed startup and cancelled migration restore matching backup and retain contacts BEFORE old owner starts',async()=>{
  for(const fault of ['health','migration','cancel'] as const){const f=await fixture();await f.stage();const controller=new AbortController();
    if(fault==='health')f.healthy(false);
    if(fault==='migration')f.onMigrate(()=>{throw Error('fixture migration failed after write');});
    if(fault==='cancel')f.onMigrate(()=>controller.abort());
    assert.equal(await f.engine().apply(controller.signal),'rolled-back');const state=f.disk.state();assert.equal(state.active.id,f.good.id);assert.equal(state.sequenceFloor,2);
    assert.ok(f.events.indexOf('stop')<f.events.indexOf('restore'));assert.ok(f.events.indexOf('restore')<f.events.indexOf('retain-contacts'));
    assert.ok(f.events.indexOf('retain-contacts')<f.events.indexOf('start-old'));assert.ok(f.disk.files.has(`snapshots/${state.candidate!.id}/package.zip`));
    await assert.rejects(f.stage(),/rollback-or-current/);
  }
});

test('expiry reached during migration or pending-health persistence rolls back without a first candidate launch',async()=>{
  for(const boundary of ['migration','persistence'] as const){
    const f=await fixture();await f.stage();
    if(boundary==='migration')f.onMigrate(()=>f.clock(f.manifest.release.expiresAt));
    else {const save=f.disk.writeState.bind(f.disk);f.disk.writeState=async state=>{await save(state);if(state.phase==='pending-health')f.clock(f.manifest.release.expiresAt);};}
    assert.equal(await f.engine().apply(signal()),'rolled-back');
    assert.ok(!f.events.includes('start-new'));assert.ok(f.events.includes('start-old'));
    assert.ok(f.events.indexOf('retain-contacts')<f.events.indexOf('start-old'));
    assert.equal(f.disk.state().sequenceFloor,2);
    assert.equal(f.disk.state().active.id,f.good.id); // expired known-good remains recoverable
  }
});

test('unknown process termination or failed receipt retention NEVER reopens a profile',async()=>{
  for(const fault of ['stop','contacts','backup'] as const){const f=await fixture();await f.stage();f.healthy(false);
    if(fault==='stop')f.stopped(false);
    if(fault==='contacts')f.onRetain(()=>{throw Error('receipt retention failed');});
    if(fault==='backup')f.onMigrate(()=>{const s=f.disk.state();f.disk.files.get(`backups/${s.backup!.id}.bin`)![40]^=1;});
    await assert.rejects(f.engine().apply(signal()));assert.equal(f.disk.state().phase,'rolling-back');assert.ok(!f.events.includes('start-old'));assert.equal(f.disk.state().sequenceFloor,2);
  }
});

test('missing startup health times out and failed known-good health remains recovery-required',async()=>{
  const timed=await fixture();await timed.stage();timed.trust.startupTimeoutMs=5;
  timed.host.healthy=async snapshot=>snapshot.id===timed.good.id?true:new Promise<boolean>(()=>{});
  assert.equal(await timed.engine().apply(signal()),'rolled-back');assert.ok(timed.events.includes('stop'));
  const failed=await fixture();await failed.stage();failed.host.healthy=async()=>false;
  await assert.rejects(failed.engine().apply(signal()),/Known-good health/);assert.equal(failed.disk.state().phase,'rollback-health');
  await assert.rejects(failed.stage(),/Recover previous update first/);
});

test('power loss after every durable transition recovers without resuming the interrupted candidate',async()=>{
  for(const phase of ['staging','staged','backing-up','backed-up','activating','pending-health','healthy','rolling-back','rollback-health','rolled-back'] as const){
    const f=await fixture();if(!['staging','staged'].includes(phase))await f.stage();f.disk.failPhase=phase;
    if(['rolling-back','rollback-health','rolled-back'].includes(phase))f.healthy(false);
    if(['staging','staged'].includes(phase))await assert.rejects(f.stage());else await assert.rejects(f.engine().apply(signal()));
    assert.equal(f.disk.state().phase,phase);const starts=f.events.filter(x=>x==='start-new').length;
    f.disk.powerLost=false;f.disk.failPhase=undefined;await f.engine().recover(signal());
    assert.equal(f.events.filter(x=>x==='start-new').length,starts);
    if(['activating','pending-health','rolling-back','rollback-health','rolled-back'].includes(phase)){
      assert.equal(f.disk.state().phase,'rolled-back');assert.equal(f.disk.state().active.id,f.good.id);assert.equal(f.disk.state().sequenceFloor,2);
    }else assert.ok(['healthy','staged'].includes(f.disk.state().phase));
  }
});

test('encrypted backup rejects wrong key, altered metadata and changed ciphertext',()=>{
  const bytes=Buffer.from('private fixture'),key=randomBytes(32),metadata={id:randomUUID(),dataVersion:1},encrypted=encryptUpdateBackup(bytes,key,metadata);
  assert.deepEqual(decryptUpdateBackup(encrypted,key,metadata),bytes);
  assert.throws(()=>decryptUpdateBackup(encrypted,randomBytes(32),metadata));assert.throws(()=>decryptUpdateBackup(encrypted,key,{...metadata,dataVersion:2}));
  encrypted[encrypted.length-1]^=1;assert.throws(()=>decryptUpdateBackup(encrypted,key,metadata));
});

test('semver handles arbitrary precision, prereleases/build metadata and strict invalid forms',()=>{
  for(const [a,b] of [['0.7.0','0.7.0-rc.9'],['0.7.0-rc.10','0.7.0-rc.9'],['0.7.0-beta','0.7.0-10'],['0.7.0-a.1','0.7.0-a'],['99999999999999999999.0.0','99999999999999999998.0.0']]){
    assert.equal(compareUpdateVersions(a,b),1);assert.equal(compareUpdateVersions(b,a),-1);
  }
  assert.equal(compareUpdateVersions('0.7.0+build.2','0.7.0+build.1'),0);
  for(const value of ['0.7','0.7.0-01','0.07.0','0.7.0\n'])assert.throws(()=>compareUpdateVersions(value,'0.7.0'));
});

test('ZIP validation rejects traversal, local-name mismatches, case aliases, links, bombs, corrupt data and missing runtime',async()=>{
  for(const name of ['../escape','/root','C:/escape','a\\b','a/../b','a./b','aux.txt','a:stream']){
    assert.throws(()=>updateRelativePath(name));const zip=new JSZip();zip.file(name,'fixture');await assert.rejects(inspectUpdateZip(await zip.generateAsync({type:'nodebuffer'}),100000));
  }
  await assert.rejects(inspectUpdateZip(await archive('0.7.0',{'win-unpacked/capri.EXE':'alias'}),100000),/alias/);
  const link=new JSZip();link.file('win-unpacked/Capri.exe','target',{unixPermissions:0xa1ff});link.file('win-unpacked/resources/app.asar','app');
  await assert.rejects(inspectUpdateZip(await link.generateAsync({type:'nodebuffer',platform:'UNIX'}),100000),/links/);
  await assert.rejects(inspectUpdateZip(await archive(),10),/limit/);
  const corrupt=await archive();corrupt[35]^=1;await assert.rejects(inspectUpdateZip(corrupt,100000));
  const wrongLocal=await archive();wrongLocal[30]^=1;await assert.rejects(inspectUpdateZip(wrongLocal,100000));
  const fakeSize=await archive();const central=fakeSize.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));fakeSize.writeUInt32LE(1,central+24);await assert.rejects(inspectUpdateZip(fakeSize,100000));
  const missing=new JSZip();missing.file('Capri.exe','root layout is incorrect');await assert.rejects(inspectUpdateZip(await missing.generateAsync({type:'nodebuffer'}),100000),/snapshot/);
});

test('real filesystem adapter contains writes, preserves existing snapshots and rejects hardlink aliases',async()=>{
  const root=await fixtureDirectory('capri-update-disk-');
  try{
    const disk=createUpdateDisk(root,async()=>{});await disk.assertProtected();await disk.createDirectory('snapshots');await disk.createDirectory('snapshots/fresh');
    await disk.writeNew('snapshots/fresh/win-unpacked/Capri.exe',Buffer.from('neutral'));await disk.writeNew('snapshots/fresh/win-unpacked/resources/app.asar',Buffer.from('neutral app'));
    assert.equal((await disk.inventory('snapshots/fresh')).length,2);
    await assert.rejects(disk.writeNew('../escape',Buffer.from('x')));await assert.rejects(disk.writeNew('snapshots/fresh/win-unpacked/Capri.exe',Buffer.from('replace')));
    await fs.link(path.join(root,'snapshots/fresh/win-unpacked/Capri.exe'),path.join(root,'alias'));
    await assert.rejects(disk.read('alias',100));await assert.rejects(disk.inventory('snapshots/fresh'));
    await fs.unlink(path.join(root,'alias'));const f=await fixture();await disk.writeState(f.disk.state());assert.equal(JSON.parse((await disk.read('state.json',32000000)).toString()).sequenceFloor,1);
    await fs.symlink(path.join(root,'snapshots/fresh'),path.join(root,'junction'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(disk.read('junction/win-unpacked/Capri.exe',100));
  }finally{assert.ok(root.startsWith(path.resolve('dist')+path.sep));await fs.rm(root,{recursive:true,force:true});}
});

test('rollback bridge copies main and EVERY linked receipt/approval, preserving no-replay records',async()=>{
  const memory=()=>{const rows=new Map<string,any>();return {rows,get:async(k:string,id:string)=>structuredClone(rows.get(k+':'+id)),put:async(k:string,value:any)=>{rows.set(k+':'+value.id,structuredClone(value));return value;}};};
  const current=memory(),restored=memory();
  const binding={routeId:'route',routeRevision:1,recipientId:'recipient',recipientSha256:'a'.repeat(64),workflowId:'workflow',templateId:'template',templateVersion:1,bodySha256:'b'.repeat(64)};
  for(const id of ['receipt-1','receipt-2'])await current.put('contact-outbox-receipt',{id,version:1,previous:id==='receipt-2'?'receipt-1':undefined,
    entry:{intent:{requestId:id,binding},createdAt:now-100,phase:'final',receipt:{id:'remote-'+id,requestId:id,binding,adapter:'fixture',state:'sent',observedAt:now,evidence:{source:'service-receipt',recordId:'record-'+id}},fingerprint:'c'.repeat(64),channel:'gmail'}});
  await current.put('contact-outbox-approval',{id:'approval-1',expiresAt:now+100});await current.put('contact-outbox-approval',{id:'approval-2',expiresAt:now+100,previous:'approval-1'});
  await current.put('contact-outbox',{id:'main',version:2,entries:[],challenges:[],consumedApprovals:[],verifiedRoutes:[],archiveHead:'receipt-2',approvalHead:'approval-2'});
  await retainUpdateContacts(current,restored);
  for(const kind of ['contact-outbox-receipt','contact-outbox-approval'])assert.equal([...restored.rows.keys()].filter(k=>k.startsWith(kind+':')).length,2);
  assert.equal((await restored.get('contact-outbox','main')).archiveHead!==undefined,true);
  await retainUpdateContacts(current,restored);assert.equal(restored.rows.size,5); // interruption/retry is idempotent
  current.rows.delete('contact-outbox-receipt:receipt-1');await assert.rejects(retainUpdateContacts(current,memory()));
});

test('dedicated feed rejects non-loopback/unpinned TLS configuration and destination escape without a request',async()=>{
  const ca=tls.rootCertificates.find(pem=>new X509Certificate(pem).ca)!;
  const certificateSha256=sha(new X509Certificate(ca).raw),config={origin:'https://127.0.0.1:19443',ca,certificateSha256};
  for(const origin of ['http://127.0.0.1:19443','https://192.168.1.2','https://example.com','https://127.0.0.1:19443/path'])assert.throws(()=>createPinnedUpdateTransport({...config,origin}));
  assert.throws(()=>createPinnedUpdateTransport({...config,certificateSha256:'0'.repeat(64)}));
  const transport=createPinnedUpdateTransport(config);
  for(const value of ['https://example.com/manifest.json','https://127.0.0.1:19444/manifest.json',config.origin+'/redirect',config.origin+'/manifest.json?next=private',config.origin+'/x/../manifest.json'])await assert.rejects(transport.read(value,1000,signal()),/rejected/);
  assert.equal(packagedUpdateLauncher('C:\\Capri\\resources'),path.join('C:\\Capri\\resources','native','update-launcher.cjs'));
});

function ephemeralFeedCertificates():{ca:string;otherCa:string;valid:string;wrongSan:string}{
  // Independent test identities generated in memory with .NET's CertificateRequest API.
  // No certificate-store changes, operator identity imports or private fixture files.
  // PowerShell 7 supplies this API on Windows; do not skip the actual TLS handshake checks.
  const script=`
$ErrorActionPreference='Stop'
$rsa=[Security.Cryptography.RSA]::Create(2048)
$leafKey=[Security.Cryptography.RSA]::Create(2048)
$otherKey=[Security.Cryptography.RSA]::Create(2048)
$certs=[Collections.Generic.List[IDisposable]]::new()
try {
  $alg=[Security.Cryptography.HashAlgorithmName]::SHA256
  $pad=[Security.Cryptography.RSASignaturePadding]::Pkcs1
  $start=[DateTimeOffset]::UtcNow.AddMinutes(-5)
  $end=[DateTimeOffset]::UtcNow.AddHours(1)
  function New-TestCA($name,$key) {
    $req=[Security.Cryptography.X509Certificates.CertificateRequest]::new($name,$key,$alg,$pad)
    $req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
    $req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign,$true))
    return $req.CreateSelfSigned($start,$end.AddHours(1))
  }
  $ca=New-TestCA 'CN=Ephemeral Capri Test CA' $rsa
  $other=New-TestCA 'CN=Different Ephemeral Test CA' $otherKey
  $certs.Add($ca);$certs.Add($other)
  function New-TestLeaf($dns,$ip) {
    $req=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Test Feed',$leafKey,$alg,$pad)
    $req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
    $req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment,$true))
    $oids=[Security.Cryptography.OidCollection]::new()
    [void]$oids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
    $req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$false))
    $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName($dns)
    if($ip){$san.AddIpAddress([Net.IPAddress]::Parse($ip))}
    $req.CertificateExtensions.Add($san.Build())
    $serial=[Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
    $serial[0]=$serial[0] -band 127;$serial[15]=$serial[15] -bor 1
    $public=$req.Create($ca,$start,$end,$serial)
    $leaf=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($public,$leafKey)
    $certs.Add($public);$certs.Add($leaf)
    return [Convert]::ToBase64String($leaf.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pkcs12,''))
  }
  $result=@{ca=$ca.ExportCertificatePem();otherCa=$other.ExportCertificatePem();valid=(New-TestLeaf 'localhost' '127.0.0.1');wrongSan=(New-TestLeaf 'wrong.invalid' '')}
  [Console]::Write(($result | ConvertTo-Json -Compress))
} finally {
  foreach($cert in $certs){$cert.Dispose()}
  $rsa.Dispose();$leafKey.Dispose();$otherKey.Dispose()
}`;
  const bytes=execFileSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:65536});
  try{return JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);}
}

test('real loopback TLS accepts the pinned CA with matching leaf SAN and rejects wrong CA, SAN and routes',async()=>{
  const certificates=ephemeralFeedCertificates(),body=Buffer.from('ephemeral release artifact'),artifact='/artifacts/'+sha(body)+'.zip';
  let requests=0;
  const server=https.createServer({pfx:Buffer.from(certificates.valid,'base64'),minVersion:'TLSv1.2'},(req,res)=>{
    requests++;
    if(req.url==='/redirect'){res.writeHead(302,{location:'/manifest.json'});res.end();return;}
    const bytes=req.url===artifact?body:Buffer.from('{"test":"manifest"}');
    res.writeHead(200,{'content-length':bytes.length});res.end(bytes);
  });
  server.on('tlsClientError',()=>{}); // Expected handshake failures have no HTTP response.
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=(server.address() as AddressInfo).port;
  const transport=(hostname:string,ca=certificates.ca)=>createPinnedUpdateTransport({origin:'https://'+hostname+':'+port,ca,
    certificateSha256:sha(new X509Certificate(ca).raw),timeoutMs:5000});
  try{
    for(const hostname of ['localhost','127.0.0.1']){
      const origin='https://'+hostname+':'+port,client=transport(hostname);
      assert.equal((await client.read(origin+'/manifest.json',1000,signal())).toString(),'{"test":"manifest"}');
      assert.deepEqual(await client.read(origin+artifact,1000,signal()),body);
    }
    assert.equal(requests,4); // Real TLS chain+SAN accepted both DNS and IP forms.
    await assert.rejects(transport('127.0.0.1',certificates.otherCa).read('https://127.0.0.1:'+port+'/manifest.json',1000,signal()));
    assert.equal(requests,4); // Wrong CA was rejected during TLS, before HTTP dispatch.
    for(const route of ['/redirect','/private','/manifest.json?escape=1','/artifacts/not-a-hash.zip'])
      await assert.rejects(transport('localhost').read('https://localhost:'+port+route,1000,signal()),/rejected/);
    assert.equal(requests,4); // Route allowlist rejected before socket creation.
    server.setSecureContext({pfx:Buffer.from(certificates.wrongSan,'base64'),minVersion:'TLSv1.2'});
    for(const hostname of ['localhost','127.0.0.1'])
      await assert.rejects(transport(hostname).read('https://'+hostname+':'+port+'/manifest.json',1000,signal()));
    assert.equal(requests,4); // Trusted CA alone cannot authorize an unrelated SAN.
  }finally{
    server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});

test('offline signer verifies independently signed evidence for the exact commit and payload',async()=>{
  const moduleUrl=pathToFileURL(path.resolve('scripts/sign-release.mjs')).href;
  const signer=await import(moduleUrl),f=await fixture(),reviewKeys=generateKeyPairSync('ed25519'),reviewPem=reviewKeys.publicKey.export({format:'pem',type:'spki'}).toString(),commit='a'.repeat(40);
  const evidence={schemaVersion:1,commit,releaseSha256:sha(canonicalJson(f.manifest.release)),artifacts:f.manifest.release.artifacts.map(({sha256,bytes})=>({sha256,bytes})),
    owner:'worker',reviewer:'independent-reviewer',checkedAt:now-1,expiresAt:now+100,checks:{typecheck:'passed',test:'passed',build:'passed'},review:'passed'};
  const envelope={evidence,signature:{algorithm:'ed25519',keyId:'review',value:sign(null,Buffer.from(signer.canonicalReleaseJson(evidence)),reviewKeys.privateKey).toString('base64')}};
  assert.equal(signer.canonicalReleaseJson(f.manifest.release),releaseSigningPayload(f.manifest));
  assert.equal(signer.verifySigningAttestation(envelope,f.manifest.release,{trustedKeys:{review:reviewPem},commit,now}).commit,commit);
  for(const patch of [{commit:'b'.repeat(40)},{now:now+101},{trustedKeys:{}}])assert.throws(()=>signer.verifySigningAttestation(envelope,f.manifest.release,{trustedKeys:{review:reviewPem},commit,now,...patch}));
  assert.throws(()=>signer.verifySigningAttestation(envelope,{...f.manifest.release,sequence:3},{trustedKeys:{review:reviewPem},commit,now}));
  envelope.evidence.checks.test='failed';assert.throws(()=>signer.verifySigningAttestation(envelope,f.manifest.release,{trustedKeys:{review:reviewPem},commit,now}));
  assert.throws(()=>signer.canonicalReleaseJson({undefined:undefined}));
  assert.throws(()=>signer.validateSigningRelease({...f.manifest.release,version:'0.7.0\n'}));
});

test('PowerShell launcher parses on Windows',async()=>{
  if(process.platform==='win32'){
    const command="$e=$null; $t=$null; [void][Management.Automation.Language.Parser]::ParseFile('"+path.resolve('scripts/update-launcher.ps1').replace(/'/g,"''")+"',[ref]$t,[ref]$e); if($e.Count){throw ($e | Out-String)}";
    execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,stdio:'pipe'});
  }
});

test('actual compiled Node launcher verifies complete signed snapshots and trust/owner failures; never launches',async()=>{
  const directory=await fixtureDirectory('capri-launcher-check-');
  const root=path.join(directory,'managed'),profile=path.join(directory,'profile'),trustFile=path.join(directory,'trust.json'),launcher=path.join(directory,'update-launcher.cjs');
  try{
    // Identical self-contained entrypoint/options to the trusted build; not a test verifier.
    await build({entryPoints:['scripts/update-launcher.mjs'],bundle:true,platform:'node',format:'cjs',target:'node22',outfile:launcher});
    const f=await fixture();await fs.mkdir(profile,{recursive:true});await fs.mkdir(root,{recursive:true});
    for(const [name,bytes] of f.disk.files){const file=path.join(root,...name.split('/'));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
    const config={schemaVersion:1,root,profile,port:18601,nodeExecutable:process.execPath,nodeSha256:sha(await fs.readFile(process.execPath)),
      launcherSha256:sha(await fs.readFile(launcher)),keys:{operator:pem},channel:'preview',arch:'x64',minimumSequence:1,dataVersion:1};
    let trust=JSON.stringify(config);await fs.writeFile(trustFile,trust);
    const setConfig=async(patch:Partial<typeof config>={})=>{trust=JSON.stringify({...config,...patch});await fs.writeFile(trustFile,trust);};
    // Staging clears the engine's in-memory launch nonce. These disk states
    // deliberately exercise the original known-good restart, so retain its
    // exact nonce independently of subsequent engine transitions.
    const originalState=f.disk.state();
    const verify=(extra:string[]=[],nonce:string|null=originalState.nonce!)=>execFileSync(process.execPath,[launcher,'--trust-file',trustFile,'--trust-file-sha256',sha(trust),
      ...(nonce===null?[]:['--nonce',nonce]),...extra],{windowsHide:true,encoding:'utf8',stdio:'pipe',timeout:30000});
    const setState=async(state:UpdateState)=>fs.writeFile(path.join(root,'state.json'),canonicalJson(state));
    assert.match(verify(),/Verified Capri 0.6.0/);
    const stagedState=structuredClone(originalState);stagedState.phase='staged';stagedState.candidate=(await f.stage());await setState(stagedState);
    assert.match(verify(),/Verified Capri 0.6.0/,'a staged candidate must not prevent verified known-good restart');await setState(originalState);
    // A healthy bootstrap is still a correlated launch state. No nonce-less exception.
    for(const phase of ['healthy','rolled-back'] as const){
      const bootstrap=structuredClone(originalState);bootstrap.phase=phase;await setState(bootstrap);
      assert.match(verify(),/Verified Capri 0.6.0/);
      for(const nonce of [null,'', 'invalid', '00000000-0000-0000-0000-000000000000',randomUUID()])
        assert.throws(()=>verify([],nonce));
      for(const nonce of [undefined,'invalid','00000000-0000-0000-0000-000000000000',randomUUID()]){
        const invalid=structuredClone(bootstrap);
        if(nonce===undefined)delete invalid.nonce;else invalid.nonce=nonce;
        await setState(invalid);assert.throws(verify);
      }
    }
    await setState(originalState);
    const exe=path.join(root,'snapshots',f.good.id,'app','win-unpacked','Capri.exe'),original=await fs.readFile(exe);
    await fs.writeFile(exe,'changed neutral fixture');assert.throws(verify);await fs.writeFile(exe,original);
    const state=structuredClone(originalState);state.active.id='../escape';await setState(state);assert.throws(verify);
    await setState(originalState);
    await fs.writeFile(exe,'changed neutral fixture');const changed=f.disk.state(),record=changed.active.files.find(x=>x.path==='win-unpacked/Capri.exe')!;
    record.bytes=Buffer.byteLength('changed neutral fixture');record.sha256=sha('changed neutral fixture');changed.active.inventorySha256=sha(canonicalJson(changed.active.files));
    await setState(changed);assert.throws(verify); // forged inventory cannot override signed ZIP
    await fs.writeFile(exe,original);await setState(originalState);
    const extra=path.join(path.dirname(exe),'unexpected.dll');await fs.writeFile(extra,'extra');assert.throws(verify);await fs.unlink(extra);
    await fs.unlink(exe);assert.throws(verify);await fs.writeFile(exe,original);
    const archiveFile=path.join(root,'snapshots',f.good.id,'package.zip'),zip=await fs.readFile(archiveFile);
    await fs.writeFile(archiveFile,Buffer.concat([zip,Buffer.from('extra')]));assert.throws(verify);await fs.writeFile(archiveFile,zip);
    for(const patch of [{nodeSha256:'0'.repeat(64)},{launcherSha256:'0'.repeat(64)},{minimumSequence:2},
      {dataVersion:2},{channel:'stable'},{arch:'arm64'},{keys:{operator:generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString()}},
      {profile:root}]){await setConfig(patch);assert.throws(verify);}
    await setConfig();await fs.writeFile(trustFile,trust+' ');assert.throws(verify);await setConfig();
    for(const mutate of [
      (s:UpdateState)=>{s.active.manifest.signature.value='A'.repeat(86)+'==';},
      (s:UpdateState)=>{s.active.manifest.signature.keyId='untrusted-publisher';},
      (s:UpdateState)=>{s.active.manifest.release.version='0.7';},
      (s:UpdateState)=>{s.sequenceFloor=0;},
      (s:UpdateState)=>{s.phase='activating';},
    ]){const state=structuredClone(originalState);mutate(state);await setState(state);assert.throws(verify);}
    await setState(originalState);
    for(const extra of [['--launch'],['--owner-pid','1'],['--owner-pid','0','--owner-start-ticks','1'],
      ['--owner-pid',String(process.pid),'--owner-start-ticks','1'],['--nonce',randomUUID()],['--unknown'],
      ['--trust-file',trustFile]])assert.throws(()=>verify(extra));
    assert.match(verify(),/Verified Capri 0.6.0/); // failed requests never mutate pointer
  }finally{assert.ok(directory.startsWith(path.resolve('dist')+path.sep));await fs.rm(directory,{recursive:true,force:true});}
});

test('compiled Node launcher requires current expiry for pending-health, preserving historical known-good launches',async()=>{
  const directory=await fixtureDirectory('capri-launcher-expiry-');
  const root=path.join(directory,'managed'),profile=path.join(directory,'profile'),trustFile=path.join(directory,'trust.json'),launcher=path.join(directory,'update-launcher.cjs');
  try{
    await build({entryPoints:['scripts/update-launcher.mjs'],bundle:true,platform:'node',format:'cjs',target:'node22',outfile:launcher});
    const f=await fixture(),candidate=await f.stage(),state=f.disk.state();
    Object.assign(state,{active:candidate,previous:f.good,phase:'pending-health',sequenceFloor:2,nonce:randomUUID(),backup:{id:randomUUID(),sha256:'a'.repeat(64),dataVersion:1}});
    await fs.mkdir(root,{recursive:true});await fs.mkdir(profile,{recursive:true});
    for(const [name,bytes] of f.disk.files){const file=path.join(root,...name.split('/'));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
    const config={schemaVersion:1,root,profile,port:18601,nodeExecutable:process.execPath,nodeSha256:sha(await fs.readFile(process.execPath)),
      launcherSha256:sha(await fs.readFile(launcher)),keys:{operator:pem},channel:'preview',arch:'x64',minimumSequence:2,dataVersion:2};
    let trust=JSON.stringify(config);await fs.writeFile(trustFile,trust);
    const verify=(nonce:string|null=state.nonce!)=>execFileSync(process.execPath,[launcher,'--trust-file',trustFile,'--trust-file-sha256',sha(trust),
      ...(nonce===null?[]:['--nonce',nonce])],{windowsHide:true,encoding:'utf8',stdio:'pipe',timeout:30000});
    const setState=()=>fs.writeFile(path.join(root,'state.json'),canonicalJson(state));
    await setState();assert.throws(verify); // original fixture expired decades before actual now
    const clock=Date.now();
    state.active.manifest=signed(f.zip,{publishedAt:clock-1000,expiresAt:clock+60000});state.candidate=structuredClone(state.active);
    await setState();assert.match(verify(),/Verified Capri 0.7.0/);
    const startupNonce=state.nonce!;
    for(const phase of ['pending-health','rollback-health'] as const){
      state.phase=phase;
      if(phase==='rollback-health')state.previous=structuredClone(state.active);
      await setState();assert.match(verify(),/Verified Capri 0.7.0/);
      for(const nonce of [null,'malformed',randomUUID()])assert.throws(()=>verify(nonce));
      for(const nonce of [undefined,'malformed',randomUUID()]){
        if(nonce===undefined)delete state.nonce;else state.nonce=nonce;
        await setState();assert.throws(()=>verify(startupNonce));
      }
      state.nonce=startupNonce;
    }
    state.phase='pending-health';state.previous=f.good;await setState();
    const good=structuredClone(state);
    state.active.manifest=signed(f.zip,{publishedAt:clock+60000,expiresAt:clock+120000});state.candidate=structuredClone(state.active);
    await setState();assert.throws(verify); // not yet valid
    Object.assign(state,good);state.active.manifest=signed(f.zip,{publishedAt:clock-1000,expiresAt:clock-1});state.candidate=structuredClone(state.active);
    await setState();assert.throws(verify);
    state.phase='healthy';await setState();assert.match(verify(),/Verified Capri 0.7.0/); // previously health-accepted installed pointer
    state.active=f.good;state.previous=f.good;state.phase='rolled-back';
    config.dataVersion=1;trust=JSON.stringify(config);await fs.writeFile(trustFile,trust);
    await setState();assert.match(verify(),/Verified Capri 0.6.0/); // rollback below burned sequence stays valid
    assert.equal(JSON.parse(await fs.readFile(path.join(root,'state.json'),'utf8')).sequenceFloor,2);
  }finally{assert.ok(directory.startsWith(path.resolve('dist')+path.sep));await fs.rm(directory,{recursive:true,force:true});}
});
