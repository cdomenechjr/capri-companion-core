import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import JSZip from 'jszip';
import {defaults} from '../src/shared';
import {Store,seal,unseal} from '../src/server/store';
import {acquireProfileWriter} from '../src/desktop/runtime-profile';
import {createMaintenanceOperations,openExistingProfile,type ProtectedStorage} from '../src/desktop/update-maintenance';
import {canonicalJson,releaseSigningPayload} from '../src/extensions/policy';
import type {ReleaseManifest} from '../src/extensions/contracts';
import {inspectUpdateZip,type UpdateSnapshot,type UpdateState} from '../src/extensions/updates';
import {ManagedChannel,ManagedUpdateController,bootstrapManagedHost,managedHash,verifyManagedAcceptance,brokerInventoryOrder,managedDesktopData,managedOwnerSha256,waitManagedNormalExit,serveManagedControl,managedControlCommand,waitManagedHealth,managedStartupTimeoutMs,captureManagedChannel,type ManagedConfig,type ManagedTrust,type ManagedProcesses,type ManagedSession} from '../src/extensions/managed-update-host';

// Real controller + encrypted SQLite/complete filesystem backups + offline RPCs.
// Process, cursor, protected-storage and publication authority are explicit fakes.
// No provider, installed profile, signed release, notification or scan is used.
const clock=1_000_000;
function pair(){const a=new PassThrough(),b=new PassThrough(),token=randomBytes(32).toString('hex'),epoch=randomUUID();const client=new ManagedChannel(a,b,token,epoch),server=new ManagedChannel(b,a,token,epoch);return {client,server,reply:(value:object)=>a.write('CAPRI_MANAGED_RPC '+JSON.stringify({protocol:'capri-managed-v1',token,epoch,type:'reply',...value})+'\n'),close(){client.close();server.close();a.destroy();b.destroy();}};}
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('cold health retries only within its deadline; an exact expired reply cannot resolve the next health or poison shutdown',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const p=pair(),first=deferred(),second=deferred(),releaseFirst=deferred(),releaseSecond=deferred();let elapsed=0,calls=0,lost=false,settled=false;
 p.client.onLost=()=>{lost=true;};p.server.handler=async method=>{
  if(method==='shutdown')return {closing:true};assert.equal(method,'health');calls++;
  if(calls===1){first.resolve();await releaseFirst.promise;return {nonce:'expired'};}
  if(calls===2){second.resolve();await releaseSecond.promise;}
  return {nonce:'current'};
 };
 try{
  const health=waitManagedHealth(p.client,'current',new AbortController().signal,()=>elapsed);void health.then(()=>{settled=true;},()=>{});await first.promise;
  elapsed=10000;t.mock.timers.tick(10000);await second.promise;
  releaseFirst.resolve();await turn();assert.equal(lost,false);assert.equal(settled,false);
  releaseSecond.resolve();assert.deepEqual(await health,{nonce:'current'});assert.equal(lost,false);
  assert.deepEqual(await p.client.request('health'),{nonce:'current'});
  assert.deepEqual(await p.client.request('shutdown'),{closing:true});assert.equal(calls,3);
 }finally{releaseFirst.resolve();releaseSecond.resolve();p.close();}
});

test('expired reply quarantine still fails closed on forged, malformed, unknown and duplicate frames',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const frame of [{id:1,ok:'true'},{id:1,ok:false,value:'invalid'},{id:1,ok:true,token:'0'.repeat(64)},{id:99,ok:true}]){
  const p=pair();p.server.handler=()=>new Promise(()=>{});let lost=false;p.client.onLost=()=>{lost=true;};
  try{const timeout=assert.rejects(p.client.request('health',{},10),/unconfirmed/);t.mock.timers.tick(10);await timeout;
   p.reply(frame);assert.equal(lost,true);await assert.rejects(p.client.request('shutdown'),/closed/);
  }finally{p.close();}
 }
 const p=pair();p.server.handler=()=>new Promise(()=>{});
 try{const timeout=assert.rejects(p.client.request('health',{},10),/unconfirmed/);t.mock.timers.tick(10);await timeout;
  p.reply({id:1,ok:true});let lost=false;p.client.onLost=()=>{lost=true;};p.reply({id:1,ok:true});assert.equal(lost,true);
 }finally{p.close();}
});

test('health deadline and Stop cancel pending requests without any late readiness success',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const outcome of ['deadline','stop'] as const){const p=pair(),abort=new AbortController(),entered=deferred(),release=deferred();let calls=0,elapsed=0;
  p.server.handler=async method=>{if(method==='shutdown')return {closing:true};calls++;entered.resolve();await release.promise;return {nonce:'late'};};
  try{const health=waitManagedHealth(p.client,'late',abort.signal,()=>elapsed),failed=assert.rejects(health,outcome==='deadline'?/deadline/:/abort|stopped/i);await entered.promise;
   if(outcome==='deadline'){for(let i=0;i<12;i++){elapsed+=10000;t.mock.timers.tick(10000);await turn();}assert.equal(elapsed,managedStartupTimeoutMs);assert.equal(calls,12);}
   else abort.abort();
   await failed;release.resolve();await turn();assert.deepEqual(await p.client.request('shutdown'),{closing:true});
  }finally{release.resolve();p.close();}
 }
});

test('lost captured child channel sends EOF for cooperative exit without treating channel closure as exit proof',{timeout:10000},async()=>{
 const child=spawn(process.execPath,['-e','process.stdin.resume()'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const channel=captureManagedChannel(child,randomBytes(32).toString('hex'),randomUUID());
 try{await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.stdout.destroy();
  await exited;assert.equal(child.exitCode,0);assert.equal(await waitManagedNormalExit(child,'123',async()=>{throw Error('Use captured exit.');},0),true);
  await assert.rejects(channel.request('health'),/closed/);
 }finally{channel.close();if(child.exitCode===null)child.kill();}
});

async function fixture(){
 const parent=path.resolve('dist');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'managed-update-'));
 const profilesRoot=path.join(root,'profiles'),hostRoot=path.join(root,'host'),appData=path.join(root,'appdata'),attestationRoot=path.join(root,'attestations');for(const d of [profilesRoot,hostRoot,appData,attestationRoot])await fs.mkdir(d);
 const generation=randomUUID(),profile=path.join(profilesRoot,generation);await fs.mkdir(profile);const wrapping=randomBytes(32),key=randomBytes(32),protection:ProtectedStorage={isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(seal(v,wrapping)),decryptString:b=>unseal(b.toString(),wrapping)};
 await fs.writeFile(path.join(profile,'private.config'),protection.encryptString(JSON.stringify({storageKey:key.toString('base64')})));
 const s=await new Store(path.join(profile,'data'),key).init();await s.put('settings',{id:'main',...defaults,speechEngine:'designed-hq'});await s.put('memory',{id:'retained-memory',text:'isolated fixture'});await s.close();
 const keys=generateKeyPairSync('ed25519'),pem=keys.publicKey.export({format:'pem',type:'spki'}).toString();
 const fakePin={path:path.join(root,'unused-fake-process'),sha256:managedHash('neutral process fixture')};
 const config:ManagedConfig={schemaVersion:1,installationId:randomUUID(),ownerSha256:managedHash(randomBytes(32)),root:hostRoot,profilesRoot,appData,port:18601,dataVersion:1,pollMs:3600000,keys:{fixture:pem},channel:'preview',arch:'x64',minimumSequence:1,feed:{origin:'https://127.0.0.1:19443',ca:'not used by injected transport',certificateSha256:managedHash('fixture ca')},brokerJournal:path.join(root,'broker.json'),attestationRoot,node:fakePin,controller:fakePin,launcher:fakePin,supervisor:fakePin,windowsHelper:fakePin,maintenance:{root:path.join(root,'unused-maintenance-runtime'),snapshot:undefined as any}};
 const trust:ManagedTrust={config,file:path.join(root,'trust.json'),sha256:managedHash('isolated-public-trust'),assert:async()=>{}};
 async function snapshot(version:string,sequence:number){const zip=new JSZip(),report=JSON.stringify({fixture:true,version});zip.file('win-unpacked/Capri.exe','neutral fixture executable '+version);zip.file('win-unpacked/resources/app.asar','neutral fixture app '+version);zip.file('win-unpacked/resources.pak','neutral electron fixture');zip.file('VERIFICATION.json',report);
  const bytes=await zip.generateAsync({type:'nodebuffer'}),inspected=await inspectUpdateZip(bytes,1000000);
  const manifest:ReleaseManifest={release:{schemaVersion:1,version,sequence,channel:'preview',publishedAt:clock-100,expiresAt:clock+10000,migration:{readMin:1,readMax:1,writeVersion:1,backupRequired:true,reversible:true},artifacts:[{platform:'win32',arch:'x64',url:config.feed.origin+'/artifacts/'+managedHash(bytes)+'.zip',sha256:managedHash(bytes),bytes:bytes.length}]},signature:{algorithm:'ed25519',keyId:'fixture',value:''}};
  manifest.signature.value=sign(null,Buffer.from(releaseSigningPayload(manifest)),keys.privateKey).toString('base64');
  const snapshot:UpdateSnapshot={id:randomUUID(),manifest,files:inspected.files,inventorySha256:managedHash(canonicalJson(inspected.files))};return {bytes,inspected,snapshot};
 }
 const old=await snapshot('0.6.0',1),candidate=await snapshot('0.7.0-dev.1',2);
 config.maintenance.snapshot=candidate.snapshot;
 for(const [relative,bytes] of [[`snapshots/${old.snapshot.id}/package.zip`,old.bytes],...[...old.inspected.contents].map(([name,b])=>[`snapshots/${old.snapshot.id}/app/${name}`,b])] as [string,Buffer][]){const file=path.join(hostRoot,...relative.split('/'));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
 const state:UpdateState={schemaVersion:1,sequenceFloor:1,active:old.snapshot,phase:'healthy',nonce:randomUUID()};await fs.writeFile(path.join(hostRoot,'state.json'),canonicalJson(state));
 const taskEvidence=[{id:'fixture-review',owner:'codex',reviewer:'claude',reviewSha256:managedHash('review'),checks:['candidate:typecheck','candidate:test','candidate:build'].map(id=>({id,sha256:managedHash(id)}))}];
 const payload={kind:'capri-operator-release-attestation',commit:'a'.repeat(40),releaseVersion:candidate.snapshot.manifest.release.version,snapshotReportSha256:managedHash(''+JSON.stringify({fixture:true,version:candidate.snapshot.manifest.release.version})),executableSha256:candidate.inspected.files.find(f=>f.path==='win-unpacked/Capri.exe')!.sha256,appAsarSha256:candidate.inspected.files.find(f=>f.path==='win-unpacked/resources/app.asar')!.sha256,taskCount:1,taskEvidence,reviewDigest:managedHash(JSON.stringify(taskEvidence)),checks:['isolated-independent-fixture']};
 const attestation={id:managedHash(JSON.stringify(payload)),...payload};await fs.writeFile(path.join(attestationRoot,'attestation.json'),JSON.stringify(attestation));
 await fs.writeFile(config.brokerJournal,JSON.stringify({records:{[payload.commit]:{commit:payload.commit,phase:'published',sequence:2,version:payload.releaseVersion,release:candidate.snapshot.manifest.release,artifact:{sha256:managedHash(candidate.bytes),bytes:candidate.bytes.length},snapshotManifestSha256:managedHash(JSON.stringify(brokerInventoryOrder(candidate.inspected.files))),attestationFile:'attestation.json',attestationId:attestation.id}}}));
 await bootstrapManagedHost(trust,{generation,state});
 let failHealth=false,failOperational=false,wrongHealth='',uncertainStop=false,pausedRestore:(()=>Promise<void>)|undefined,failJournalOnce=false,now=clock,onMigrate:(()=>void)|undefined;
 let active=0,normalActive=0,starts=0,posts=0;const sessions=new Set<ManagedSession>();const events:string[]=[];
 let owner:ManagedChannel,exitNormal:()=>Promise<void>,dropChannel:()=>void,rejectExit:()=>void,onHealth:((sequence:number)=>Promise<void>)|undefined;
 const binding={routeId:'route',routeRevision:1,recipientId:'recipient',recipientSha256:'a'.repeat(64),workflowId:'workflow',templateId:'template',templateVersion:1,bodySha256:'b'.repeat(64)};
 async function effects(directory:string){const store=await openExistingProfile(directory,protection);
  const entry=(id:string,state:string)=>({intent:{requestId:id,binding},createdAt:clock-100,phase:'final',receipt:{id:'remote-'+id,requestId:id,binding,adapter:'fixture',state,observedAt:clock,evidence:state==='unconfirmed'?{source:'none'}:{source:'service-receipt',recordId:'record-'+id}},fingerprint:'c'.repeat(64),channel:'gmail'});
  await store.put('contact-outbox-receipt',{id:'archived',version:1,entry:entry('archived','sent')});await store.put('contact-outbox-approval',{id:'consumed',expiresAt:clock+1000});
  await store.put('contact-outbox',{id:'main',version:2,entries:[entry('hot','unconfirmed')],challenges:[],consumedApprovals:[],verifiedRoutes:[],archiveHead:'archived',approvalHead:'consumed'});
  for(const [id,state]of [['claim','unconfirmed'],['delivered','delivered']])await store.put('paired-android-receipt',{id,deviceId:'fixture-device',notificationId:id,bodySha256:managedHash(id),state});await store.close();
 }
 const processes:ManagedProcesses={
  async reconcile(journal){return !journal.normal||normalActive===0;},
  async maintenance(_snapshot,context,prepared,armed,signal){signal.throwIfAborted();await prepared({fixture:true} as any);await armed({fixture:true} as any);const gate=await acquireProfileWriter(config);active++;events.push('maintenance:'+context.generation);const p=pair();
   const operate=await createMaintenanceOperations({trust,generation:context.generation,gate,protection,restoreCursor:async()=>true});
   p.server.handler=async(method,input)=>{if(method==='restore')await pausedRestore?.();if(method==='migrate')onMigrate?.();if(method==='journal'&&input.operation==='put'&&failJournalOnce){failJournalOnce=false;throw Error('simulated crash during retention');}return operate(method,input);};
   let stopped=false;const session={channel:p.client,stop:async()=>{if(stopped)return true;await operate('close',{});stopped=true;active--;await gate.close();p.close();sessions.delete(session);return true;}};sessions.add(session);return session;
  },
  async normal(snapshot,context,save,signal){signal.throwIfAborted();const gate=await acquireProfileWriter(config);active++;normalActive++;starts++;events.push('normal:'+context.generation);const directory=path.join(profilesRoot,context.generation);if(snapshot.manifest.release.sequence===2)await effects(directory);
   const p=pair();owner=p.server;await save({pid:process.pid,created:'1',snapshotId:snapshot.id,...context});let activated=false;
   p.server.handler=async(method,input)=>{
    if(method==='health'){await onHealth?.(snapshot.manifest.release.sequence);const value:any={nonce:context.nonce,epoch:context.epoch,version:snapshot.manifest.release.version,dataVersion:1,generation:context.generation,profile:directory,installationId:config.installationId,trustSha256:trust.sha256,writer:gate.owned(),quiescent:!activated};if(failHealth&&snapshot.manifest.release.sequence===2)value.writer=false;if(wrongHealth)value[wrongHealth]='wrong';return value;}
    if(method==='shutdown'){events.push('controller-shutdown');return {closing:true};}
    if(method==='activate'){assert.equal(input.epoch,context.epoch);if(failOperational&&snapshot.manifest.release.sequence===2)throw Error('simulated service initialization failure');activated=true;events.push('activated');return {activated:true};}
    if(method==='observe')return {version:snapshot.manifest.release.version,dataVersion:1,sequence:snapshot.manifest.release.sequence,automatic:true,idle:{task:false,call:false,microphone:false,scan:false,game:false}};
    throw Error('unsupported fixture command');
   };
   let stopped=false,prove!:(confirmed:boolean)=>void;const exitProof=new Promise<boolean>(resolve=>{prove=resolve;});
   const finish=async()=>{if(stopped)return;stopped=true;active--;normalActive--;await gate.close();p.close();sessions.delete(session);prove(true);};
   exitNormal=finish;dropChannel=()=>p.close();rejectExit=()=>prove(false);
   const session={channel:p.client,exited:()=>exitProof,stop:async()=>{if(uncertainStop)return false;if(!stopped)try{await p.client.request('shutdown',{});}catch{/* Simulated process exit remains independent proof. */}await finish();return true;}};sessions.add(session);return session;
  }
 };
 const transport={read:async(url:string)=>url.endsWith('/manifest.json')?Buffer.from(JSON.stringify(candidate.snapshot.manifest)):candidate.bytes};
 const controller=()=>new ManagedUpdateController(trust,processes,()=>now,transport);
 return {root,profile,trust,config,generation,protection,candidate,old,events,controller,processes,
  health:(value:boolean)=>{failHealth=!value;},failOperational:()=>{failOperational=true;},wrongHealth:(value:string)=>{wrongHealth=value;},uncertainStop:(value:boolean)=>{uncertainStop=value;},failJournal:()=>{failJournalOnce=true;},pauseRestore:(fn:()=>Promise<void>)=>{pausedRestore=fn;},expireDuringMigration:()=>{onMigrate=()=>{now=clock+20000;};},starts:()=>starts,posts:()=>posts,
  ownerStop:()=>owner.request('stop',{}),ownerQuit:()=>owner.request('quit',{}),exitNormal:()=>exitNormal(),dropChannel:()=>dropChannel(),rejectExit:()=>rejectExit(),
  ownerRequest:(method:string,input:unknown)=>owner.request(method,input),onHealth:(fn:(sequence:number)=>Promise<void>)=>{onHealth=fn;},
  state:async()=>JSON.parse(await fs.readFile(path.join(hostRoot,'state.json'),'utf8')) as UpdateState,journal:async()=>JSON.parse(await fs.readFile(path.join(hostRoot,'host.json'),'utf8')),
  close:async()=>{uncertainStop=false;for(const session of [...sessions])await session.stop();key.fill(0);wrapping.fill(0);assert.equal(path.dirname(root),parent);await fs.rm(root,{recursive:true,force:true});}};
}

test('managed Chromium selection is synchronous, pinned, generation-specific and maintenance stays outside closed profiles',async()=>{
 const f=await fixture();try{
  const c={...f.config,ownerSha256:managedOwnerSha256()},file=path.join(f.root,'startup-public.json'),bytes=Buffer.from(JSON.stringify(c));await fs.writeFile(file,bytes);
  const epoch=randomUUID(),env={CAPRI_MANAGED_TRUST:file,CAPRI_MANAGED_TRUST_SHA256:managedHash(bytes),CAPRI_MANAGED_EPOCH:epoch,CAPRI_MANAGED_GENERATION:f.generation,CAPRI_MANAGED_CHANNEL:randomBytes(32).toString('hex')};
  assert.equal(managedDesktopData(c.appData,f.profile,false,env),f.profile);
  const helperData=managedDesktopData(c.appData,f.profile,true,env);assert.equal(helperData,path.join(c.root,'maintenance-electron',epoch));assert.ok(path.relative(c.profilesRoot,helperData).startsWith('..'));
  assert.equal(await fs.stat(helperData).then(()=>true,()=>false),false,'selection performs no writes');
  assert.throws(()=>managedDesktopData(c.appData,f.profile,true,{...env,CAPRI_MANAGED_TRUST_SHA256:'0'.repeat(64)}),/trust changed/);
  assert.throws(()=>managedDesktopData(c.appData,f.profile,true,{...env,CAPRI_MANAGED_GENERATION:randomUUID()}),/profile mismatch/);
  assert.throws(()=>managedDesktopData(c.appData,f.profile,true,{...env,CAPRI_MANAGED_EPOCH:'../escape'}));
  await fs.mkdir(path.dirname(helperData),{recursive:true});await fs.symlink(f.profile,helperData,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>managedDesktopData(c.appData,f.profile,true,env),/alias/);
 }finally{await f.close();}
});

test('normal Quit waits for captured positive exit, cleans control/singleton, and permits documented start without replay',async()=>{
 const f=await fixture();let controller=await f.controller().open(),closeControl:(()=>Promise<void>)|undefined;
 let closed!:()=>void;const retired=new Promise<void>(resolve=>{closed=resolve;});
 try{
  await controller.start(true);const old=await f.journal();
  closeControl=await serveManagedControl(controller,randomBytes(32),()=>{});
  controller.onClosed=()=>{void closeControl!().then(closed);};
  assert.deepEqual(await f.ownerQuit(),{closing:true});f.dropChannel();await Promise.resolve();
  assert.ok((await f.journal()).normal,'closed channel alone must retain owner');
  await assert.rejects(f.controller().open(),{code:'EADDRINUSE'});
  await f.exitNormal();await retired;const after=await f.journal();assert.equal(after.phase,'stopped');assert.equal(after.normal,undefined);
  controller=await f.controller().open();await controller.start();assert.notEqual((await f.journal()).epoch,old.epoch);assert.equal(f.starts(),2);assert.equal(f.posts(),0);
  // Real control address can be served again after Quit; it was not stranded.
  closeControl=await serveManagedControl(controller,randomBytes(32),()=>{});await closeControl();closeControl=undefined;
 }finally{controller.onClosed=undefined;await controller.stop();await closeControl?.();await f.close();}
});

test('owner Stop retains its writer; authenticated start retires it and creates a fresh active epoch',async()=>{
 const f=await fixture(),controlKey=randomBytes(32);const original=await f.journal();
 original.operations=[{requestId:'already-handled',action:'check',state:'finished',epoch:original.epoch}];await fs.writeFile(path.join(f.config.root,'host.json'),canonicalJson(original));
 const controller=await f.controller().open();let closeControl:(()=>Promise<void>)|undefined;
 try{
  await controller.start(true);const before=await f.journal();
  closeControl=await serveManagedControl(controller,Buffer.from(controlKey),()=>{});
  await assert.rejects(managedControlCommand(f.trust,Buffer.from(controlKey),'start'),/refused/,'active start must not replace an owner');
  assert.deepEqual(await f.ownerStop(),{stopped:true});assert.equal(controller.status().updates.state,'disabled');assert.equal(f.starts(),1);
  await assert.rejects(acquireProfileWriter(f.config),{code:'EADDRINUSE'});
  assert.deepEqual(await managedControlCommand(f.trust,Buffer.from(controlKey),'start'),{started:true});
  const after=await f.journal();assert.equal(after.phase,'active');assert.notEqual(after.epoch,before.epoch);assert.notEqual(after.normal.nonce,before.normal.nonce);assert.equal(f.starts(),2);assert.equal(f.posts(),0);
  assert.deepEqual(after.operations,original.operations);await assert.rejects(f.ownerRequest('check',{requestId:'already-handled'}),/refused/);assert.equal(f.starts(),2);
 }finally{await closeControl?.();controlKey.fill(0);await controller.stop();await f.close();}
});

test('Quit and Stop/relaunch retain evidence/singleton when captured retirement is unconfirmed',async()=>{
 for(const intent of ['quit','stop'] as const){const f=await fixture(),controller=await f.controller().open();try{
  await controller.start(true);const saved=(await f.journal()).normal;f.uncertainStop(true);
  if(intent==='quit'){
   let closed=false;const original=controller.onClosed;controller.onClosed=()=>{closed=true;};
   await f.ownerQuit();f.dropChannel();f.rejectExit();
   // Wait for the actual async journal write without assuming channel loss is proof.
   for(let i=0;i<100&&(await f.journal()).phase!=='unknown';i++)await new Promise(r=>setTimeout(r,10));
   assert.equal(closed,false);controller.onClosed=original;
  }else{await f.ownerStop();await assert.rejects(controller.relaunch(),/exit unconfirmed/);}
  const after=await f.journal();assert.equal(after.phase,'unknown');assert.deepEqual(after.normal,saved);assert.equal(controller.status().updates.state,'recovery-required');assert.equal(f.starts(),1);
  await assert.rejects(f.controller().open(),{code:'EADDRINUSE'});await assert.rejects(controller.relaunch());
 }finally{f.uncertainStop(false);await f.exitNormal();await controller.stop().catch(()=>{});await f.close();}}
});

test('captured normal process exit proof distinguishes running, identity failure/reuse and actual subprocess exit',async()=>{
 const child=spawn(process.execPath,['-e','process.stdin.resume()'],{windowsHide:true,stdio:['pipe','pipe','pipe']});child.stdout.resume();child.stderr.resume();
 await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 try{
  assert.equal(await waitManagedNormalExit(child,'123',async()=> '123',0),false);
  assert.equal(await waitManagedNormalExit(child,'123',async()=> '456',0),false);
  await assert.rejects(waitManagedNormalExit(child,'123',async()=>{throw Error('query denied');},0),/query denied/);
  child.stdin.end();await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  assert.equal(await waitManagedNormalExit(child,'123',async()=>{throw Error('captured exit is sufficient');},0),true);
 }finally{child.stdin.end();if(child.exitCode===null)child.kill();}
});

test('late operator Stop during explicit relaunch cannot launch or activate the replacement',async()=>{
 const f=await fixture(),controller=await f.controller().open();let release!:()=>void;
 try{
  await controller.start(true);await f.ownerStop();let reached!:()=>void;const waiting=new Promise<void>(r=>{reached=r;}),delay=new Promise<void>(r=>{release=r;});const normal=f.processes.normal;
  f.processes.normal=async(...args)=>{reached();await delay;args[3].throwIfAborted();return normal(...args);};
  const restarting=controller.relaunch();await waiting;const stopping=controller.stop();release();await assert.rejects(restarting);await stopping;
  assert.equal(f.starts(),1);assert.equal(f.events.filter(e=>e==='activated').length,1);assert.equal((await f.journal()).phase,'stopped');
 }finally{release?.();await controller.stop();await f.close();}
});

test('Stop retains a durable in-flight normal identity when launch never returns its session and exit remains unknown',async()=>{
 const f=await fixture();let reached!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>{reached=r;}),delay=new Promise<void>(r=>{release=r;});
 const normal=f.processes.normal;f.processes.normal=async(...args)=>{const session=await normal(...args);reached();await delay;args[3].throwIfAborted();return session;};
 const controller=await f.controller().open();try{
  const starting=controller.start(true);await waiting;const saved=(await f.journal()).normal;const stopping=controller.stop();release();await assert.rejects(starting);await assert.rejects(stopping,/exit unconfirmed/);
  assert.equal((await f.journal()).phase,'unknown');assert.deepEqual((await f.journal()).normal,saved);await assert.rejects(f.controller().open(),{code:'EADDRINUSE'});
  await f.exitNormal();await controller.stop();assert.equal((await f.journal()).normal,undefined);
 }finally{release?.();await controller.stop();await f.close();}
});

test('controller performs actual offline rollback across physical generations retaining hot/cold/approval/paired evidence without repost',async()=>{
 const f=await fixture(),controller=await f.controller().open();try{await controller.start(true);f.health(false);assert.deepEqual(await controller.check(),{outcome:'rolled-back'});
  const state=await f.state(),journal=await f.journal();assert.equal(state.sequenceFloor,2);assert.equal(state.active.manifest.release.version,'0.6.0');assert.notEqual(journal.generation,f.generation);assert.equal(journal.failedGeneration,f.generation);assert.equal(f.posts(),0);
  const recovered=await openExistingProfile(path.join(f.config.profilesRoot,journal.generation),f.protection);
  try{assert.equal((await recovered.get('contact-outbox','main'))?.entries[0].receipt.state,'unconfirmed');assert.equal((await recovered.get('contact-outbox-receipt','archived'))?.entry.receipt.state,'sent');assert.equal((await recovered.get('contact-outbox-approval','consumed'))?.expiresAt,clock+1000);assert.equal((await recovered.get('paired-android-receipt','claim'))?.state,'unconfirmed');assert.equal((await recovered.get('paired-android-receipt','delivered'))?.state,'delivered');assert.equal((await recovered.get('settings','main'))?.speechEngine,'designed-hq');}finally{await recovered.close();}
  const encrypted=await fs.readFile(path.join(f.config.root,'backups',state.backup!.id+'.bin'));assert.equal(encrypted.subarray(0,8).toString(),'CAPRIUP1');assert.ok(!encrypted.includes(Buffer.from('retained-memory')));assert.ok(await fs.stat(f.profile));
 }finally{await controller.stop();await f.close();}
});

test('controller cold startup accepts only a fresh matching health after the first request timed out',async t=>{
 const f=await fixture(),controller=await f.controller().open(),entered=[deferred(),deferred()],release=[deferred(),deferred()];let calls=0,elapsed=0;
 t.mock.timers.enable({apis:['setTimeout']});t.mock.method(performance,'now',()=>elapsed);
 f.onHealth(async()=>{const call=calls++;if(call<2){entered[call].resolve();await release[call].promise;}});
 try{const start=controller.start(true);await entered[0].promise;
  elapsed=10000;t.mock.timers.tick(10000);await entered[1].promise;release[0].resolve();await turn();
  assert.equal(f.events.includes('activated'),false);assert.equal((await f.journal()).phase,'quiescent');
  release[1].resolve();await start;assert.equal((await f.journal()).phase,'active');assert.equal(f.starts(),1);assert.equal(f.posts(),0);
  await controller.stop();assert.ok(f.events.includes('controller-shutdown'));assert.equal((await f.journal()).normal,undefined);
 }finally{for(const r of release)r.resolve();await controller.stop();await f.close();}
});

test('controller startup deadline cooperatively retires a waiting owner and retains any unconfirmed identity',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let elapsed=0;t.mock.method(performance,'now',()=>elapsed);
 for(const uncertain of [false,true]){const f=await fixture(),controller=await f.controller().open(),entered=deferred(),release=deferred();
  f.onHealth(async()=>{entered.resolve();await release.promise;});
  try{const start=controller.start(true),failed=assert.rejects(start,/health failed/);await entered.promise;const original=(await f.journal()).normal;
   f.uncertainStop(uncertain);elapsed+=managedStartupTimeoutMs;t.mock.timers.tick(managedStartupTimeoutMs);await failed;
   release.resolve();await turn();const journal=await f.journal();assert.equal(journal.phase,'unknown');assert.equal(f.events.includes('activated'),false);
   assert.deepEqual(journal.normal,uncertain?original:undefined);await assert.rejects(f.controller().open(),{code:'EADDRINUSE'});
   if(uncertain)assert.equal(controller.status().updates.state,'recovery-required');else assert.ok(f.events.includes('controller-shutdown'));
  }finally{release.resolve();f.uncertainStop(false);await controller.stop();await f.close();}
 }
});

test('Stop interrupts cold health readiness and late health cannot activate the retired operation',async t=>{
 const f=await fixture(),controller=await f.controller().open(),entered=deferred(),release=deferred();
 t.mock.timers.enable({apis:['setTimeout']});f.onHealth(async()=>{entered.resolve();await release.promise;});
 try{const start=controller.start(true),failed=assert.rejects(start);await entered.promise;await controller.stop();await failed;
  release.resolve();await turn();assert.equal(f.events.includes('activated'),false);assert.equal((await f.journal()).normal,undefined);assert.equal((await f.journal()).phase,'stopped');
 }finally{release.resolve();await controller.stop();await f.close();}
});

test('real controller health deadline/channel loss rolls back without interpreting controller shutdown as owner Quit',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let elapsed=0;t.mock.method(performance,'now',()=>elapsed);
 for(const failure of ['deadline','channel-loss'] as const){const f=await fixture(),controller=await f.controller().open(),entered=deferred(),release=deferred();
  try{await controller.start(true);f.onHealth(async sequence=>{if(sequence===2){entered.resolve();await release.promise;}});
   const checking=controller.check();await entered.promise;
   if(failure==='deadline'){elapsed+=managedStartupTimeoutMs;t.mock.timers.tick(managedStartupTimeoutMs);}else f.dropChannel();
   assert.deepEqual(await checking,{outcome:'rolled-back'});release.resolve();await turn();
   const state=await f.state(),journal=await f.journal();assert.equal(state.sequenceFloor,2);assert.equal(state.active.manifest.release.version,'0.6.0');assert.notEqual(journal.generation,f.generation);assert.equal(journal.phase,'active');assert.equal(f.posts(),0);
   const recovered=await openExistingProfile(path.join(f.config.profilesRoot,journal.generation),f.protection);
   try{assert.equal((await recovered.get('contact-outbox','main'))?.entries[0].receipt.state,'unconfirmed');assert.equal((await recovered.get('contact-outbox-receipt','archived'))?.entry.receipt.state,'sent');assert.ok(await recovered.get('contact-outbox-approval','consumed'));assert.equal((await recovered.get('paired-android-receipt','claim'))?.state,'unconfirmed');assert.equal((await recovered.get('paired-android-receipt','delivered'))?.state,'delivered');}finally{await recovered.close();}
   assert.equal(controller.status().updates.state,'current');
  }finally{release.resolve();await controller.stop();await f.close();}
 }
});

test('restart in interrupted retention always merges ORIGINAL failed generation into another fresh generation',async()=>{
 const f=await fixture();let controller=await f.controller().open();try{
  await controller.start(true);f.health(false);f.failJournal();await assert.rejects(controller.check());const interrupted=await f.journal();assert.equal(interrupted.failedGeneration,f.generation);assert.notEqual(interrupted.generation,f.generation);await controller.stop();
  controller=await f.controller().open();await controller.start();const journal=await f.journal();assert.equal(journal.failedGeneration,f.generation);assert.notEqual(journal.generation,interrupted.generation);assert.equal((await f.state()).sequenceFloor,2);
  const restored=await openExistingProfile(path.join(f.config.profilesRoot,journal.generation),f.protection);try{assert.equal((await restored.get('paired-android-receipt','claim'))?.state,'unconfirmed');assert.ok(await restored.get('contact-outbox-approval','consumed'));}finally{await restored.close();}assert.equal(f.posts(),0);
 }finally{await controller.stop();await f.close();}
});

test('uncertain normal-owner exit prevents maintenance, mutation, and competing controller ownership',async()=>{
 const f=await fixture(),controller=await f.controller().open();try{
  await controller.start(true);await assert.rejects(f.controller().open(),/EADDRINUSE/);f.uncertainStop(true);await assert.rejects(controller.check(),/termination unconfirmed/);
  assert.equal((await f.journal()).generation,f.generation);assert.equal((await f.state()).phase,'staged');assert.equal(f.events.filter(v=>v.startsWith('normal:')).length,1);
 }finally{f.uncertainStop(false);await controller.stop();await f.close();}
});

test('wrong nonce/version/profile/trust/epoch/generation/writer health never activates',async()=>{
 for(const field of ['nonce','version','profile','trustSha256','epoch','generation','writer']){const f=await fixture(),controller=await f.controller().open();try{f.wrongHealth(field);await assert.rejects(controller.start(true),/health failed/);assert.equal(f.events.includes('activated'),false);}finally{await controller.stop();await f.close();}}
});

test('offline bootstrap initialization never starts normal UI/audio/provider work',async()=>{
 const f=await fixture(),controller=await f.controller().open();try{await controller.initializeBackup();assert.equal(f.starts(),0);assert.equal(f.events.includes('activated'),false);assert.ok(await fs.stat(path.join(f.config.root,'backup-key.dpapi')));}finally{await controller.stop();await f.close();}
});

test('Stop revokes a pending asynchronous normal launch before it can create another writer',async()=>{
 const f=await fixture();let reached!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>{reached=r;}),delayed=new Promise<void>(r=>{release=r;});
 const normal=f.processes.normal;f.processes.normal=async(...args)=>{reached();await delayed;args[3].throwIfAborted();return normal(...args);};
 const controller=await f.controller().open();try{const start=controller.start(true);await waiting;const stopping=controller.stop();release();await assert.rejects(start);await stopping;assert.equal(f.starts(),0);assert.equal(f.events.includes('activated'),false);}finally{await controller.stop();await f.close();}
});

test('actual-time expiry during async offline migration burns sequence and rolls back without candidate launch',async()=>{
 const f=await fixture(),controller=await f.controller().open();try{await controller.start(true);f.expireDuringMigration();assert.deepEqual(await controller.check(),{outcome:'rolled-back'});assert.equal((await f.state()).sequenceFloor,2);assert.equal(f.starts(),2);assert.equal(f.posts(),0);}finally{await controller.stop();await f.close();}
});

test('successful base health cannot conceal a later service initialization failure',async()=>{
 const f=await fixture(),controller=await f.controller().open();try{await controller.start(true);f.failOperational();assert.deepEqual(await controller.check(),{outcome:'rolled-back'});assert.equal((await f.state()).active.manifest.release.version,'0.6.0');assert.equal((await f.state()).sequenceFloor,2);}finally{await controller.stop();await f.close();}
});

test('independent published evidence rejects wrong artifact/inventory/review and changed attestation',async()=>{
 const f=await fixture();try{const input={manifest:f.candidate.snapshot.manifest,artifact:f.candidate.snapshot.manifest.release.artifacts[0],files:f.candidate.snapshot.files,inventorySha256:f.candidate.snapshot.inventorySha256};assert.equal(await verifyManagedAcceptance(f.config,input),true);
  assert.equal(await verifyManagedAcceptance(f.config,{...input,inventorySha256:'0'.repeat(64)}),false);assert.equal(await verifyManagedAcceptance(f.config,{...input,artifact:{...input.artifact,sha256:'0'.repeat(64)}}),false);
  const file=path.join(f.config.attestationRoot,'attestation.json'),attestation=JSON.parse(await fs.readFile(file,'utf8'));attestation.taskEvidence[0].reviewer='codex';await fs.writeFile(file,JSON.stringify(attestation));assert.equal(await verifyManagedAcceptance(f.config,input),false);
 }finally{await f.close();}
});
