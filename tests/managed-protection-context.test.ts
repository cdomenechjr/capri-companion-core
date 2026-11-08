import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store,seal,unseal} from '../src/server/store';
import {defaults} from '../src/shared';
import {claimProfileWriter,prepareDesktopStartup,prepareProtectedDesktopContext,readProfileProtectionContext} from '../src/desktop/runtime-profile';
import {bindManagedProtectionContext,prepareManagedDesktopContext,assertManagedNormalStartupContext,managedDesktopData,managedHash,managedOwnerSha256,type ManagedConfig,type ManagedTrust} from '../src/extensions/managed-update-host';
import {createMaintenanceOperations,openExistingProfile,captureClosedProfile,restoreClosedProfile,type ProtectedStorage} from '../src/desktop/update-maintenance';

// This fake models the defect: every independently initialized Chromium session
// has its OWN key. Availability alone says nothing about a retained ciphertext.
function fakeContext(key=randomBytes(32)){
 return {os_crypt:{encrypted_key:Buffer.concat([Buffer.from('DPAPI'),key]).toString('base64')},preferences:{foreign:true},permissions:{microphone:true},browser:{enabled_labs_experiments:['foreign']}};
}
async function fakeProtection(directory:string):Promise<ProtectedStorage>{
 const state=JSON.parse(await fs.readFile(path.join(directory,'Local State'),'utf8')),key=Buffer.from(state.os_crypt.encrypted_key,'base64').subarray(5);
 return {isEncryptionAvailable:()=>true,encryptString:v=>Buffer.concat([Buffer.from('v10'),Buffer.from(seal(v,key))]),decryptString:b=>{assert.equal(b.subarray(0,3).toString(),'v10');return unseal(b.subarray(3).toString(),key);}};
}
function configFor(root:string,ownerSha256=managedOwnerSha256()):ManagedConfig{
 const pin={path:path.join(root,'unused-tool.exe'),sha256:managedHash('neutral tool')};
 return {schemaVersion:1,installationId:randomUUID(),ownerSha256,root:path.join(root,'host'),profilesRoot:path.join(root,'profiles'),appData:path.join(root,'appdata'),port:18601,dataVersion:1,pollMs:3600000,
  node:pin,controller:pin,launcher:pin,supervisor:pin,windowsHelper:pin,brokerJournal:path.join(root,'broker.json'),attestationRoot:path.join(root,'attestations'),feed:{origin:'https://127.0.0.1:19443',ca:'unused neutral transport',certificateSha256:managedHash('neutral certificate')},keys:{},channel:'preview',arch:'x64',minimumSequence:1,
  maintenance:{root:path.join(root,'runtime'),snapshot:{id:randomUUID(),inventorySha256:'a'.repeat(64),files:[{path:'win-unpacked/Capri.exe',bytes:1,sha256:'a'.repeat(64)}],manifest:{release:{schemaVersion:1,version:'0.7.0-dev.1',sequence:1,channel:'preview',publishedAt:1,expiresAt:2,migration:{readMin:1,readMax:1,writeVersion:1,backupRequired:true,reversible:true},artifacts:[{platform:'win32',arch:'x64',url:'https://example.invalid/fixture.zip',bytes:1,sha256:'a'.repeat(64)}]},signature:{algorithm:'ed25519',keyId:'neutral',value:Buffer.alloc(64).toString('base64')}}}}};
}
async function fixture(){
 const parent=path.resolve('dist');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'protection-context-')),config=configFor(root);
 for(const directory of [config.root,config.profilesRoot,config.appData])await fs.mkdir(directory);
 const generation=randomUUID(),profile=path.join(config.profilesRoot,generation);await fs.mkdir(profile);
 await fs.writeFile(path.join(profile,'Local State'),JSON.stringify(fakeContext()));const protection=await fakeProtection(profile),storageKey=randomBytes(32);
 const vault={storageKey:storageKey.toString('base64'),adminToken:randomBytes(32).toString('hex'),apiKey:['neutral','configuration'].join('-')};
 await fs.writeFile(path.join(profile,'private.config'),protection.encryptString(JSON.stringify(vault)));
 const store=await new Store(path.join(profile,'data'),storageKey).init();await store.put('settings',{...defaults,id:'main',speechEngine:'designed-hq'});await store.put('memory',{id:'known',text:'Neutral retained record'});
 await store.put('paired-android-receipt',{id:'uncertain',state:'unconfirmed'});await store.close();storageKey.fill(0);
 const file=path.join(root,'trust.json'),bytes=JSON.stringify(config);await fs.writeFile(file,bytes);
 const trust:ManagedTrust={config,file,sha256:managedHash(bytes),assert:async()=>{}},gate=claimProfileWriter(config);await bindManagedProtectionContext(trust,generation,gate);
 let selected:string=generation;
 async function epoch(){const epoch=randomUUID();await fs.writeFile(path.join(config.root,'host.json'),JSON.stringify({installationId:config.installationId,ownerSha256:config.ownerSha256,trustSha256:trust.sha256,epoch,generation:selected,phase:'maintenance'}));
  return {CAPRI_MANAGED_TRUST:file,CAPRI_MANAGED_TRUST_SHA256:trust.sha256,CAPRI_MANAGED_GENERATION:selected,CAPRI_MANAGED_EPOCH:epoch,CAPRI_MANAGED_CHANNEL:randomBytes(32).toString('hex')};}
 return {root,config,profile,trust,gate,generation,vault,epoch,select:(value:string)=>{selected=value;},close:async()=>{await gate.close();assert.equal(path.dirname(root),parent);await fs.rm(root,{recursive:true,force:true});}};
}

test('available fresh context cannot decrypt v10; actual startup seam opens encrypted Store in independent epochs without source mutation',async()=>{
 const f=await fixture();try{
  const before=await captureClosedProfile(f.profile),vaultBefore=await fs.readFile(path.join(f.profile,'private.config'));
  const fresh=path.join(f.root,'old-fresh-context');await fs.mkdir(fresh);await fs.writeFile(path.join(fresh,'Local State'),JSON.stringify(fakeContext()));
  const wrong=await fakeProtection(fresh);assert.equal(wrong.isEncryptionAvailable(),true);await assert.rejects(openExistingProfile(f.profile,wrong));assert.deepEqual(await captureClosedProfile(f.profile),before);
  const directories=new Set<string>();
  for(let i=0;i<3;i++){
   const env=await f.epoch(),directory=prepareManagedDesktopContext(f.config.appData,f.profile,env,f.gate,()=>{});directories.add(directory);
   const paths=new Map<string,string>();prepareDesktopStartup({setPath:(name,value)=>paths.set(name,value),requestSingleInstanceLock:()=>true,on:()=>{}},directory,false,()=>{});
   assert.equal(paths.get('userData'),directory);assert.equal(paths.get('sessionData'),directory);assert.ok(path.relative(f.config.profilesRoot,directory).startsWith('..'));
   const state=JSON.parse(await fs.readFile(path.join(directory,'Local State'),'utf8'));assert.deepEqual(Object.keys(state),['os_crypt']);assert.deepEqual(Object.keys(state.os_crypt),['encrypted_key']);
   const protection=await fakeProtection(paths.get('sessionData')!),decoded=JSON.parse(protection.decryptString(vaultBefore));assert.deepEqual(decoded,f.vault);
   const store=await openExistingProfile(f.profile,protection);try{assert.equal((await store.get('memory','known'))?.text,'Neutral retained record');assert.equal((await store.get('settings','main'))?.speechEngine,'designed-hq');assert.equal((await store.get('paired-android-receipt','uncertain'))?.state,'unconfirmed');}finally{await store.close();}
  }
  assert.equal(directories.size,3);assert.deepEqual(await captureClosedProfile(f.profile),before);assert.deepEqual(await fs.readFile(path.join(f.profile,'private.config')),vaultBefore);
 }finally{await f.close();}
});

test('backup key survives new helpers, reconstruction and fresh restored generations with exact original ciphertext',async()=>{
 const f=await fixture();try{
  const before=await captureClosedProfile(f.profile),env=await f.epoch(),directory=prepareManagedDesktopContext(f.config.appData,f.profile,env,f.gate,()=>{});
  let operate=await createMaintenanceOperations({trust:f.trust,generation:f.generation,gate:f.gate,protection:await fakeProtection(directory),restoreCursor:async()=>true});
  const original=await operate('backup-key',{initialize:true}) as {key:string},wrapped=await fs.readFile(path.join(f.config.root,'backup-key.dpapi')),association=await fs.readFile(path.join(f.config.root,'protection-context.json'));
  const backup=await operate('backup',{}) as {bytes:string};await operate('close',{});assert.deepEqual(await captureClosedProfile(f.profile),before);
  const recovered=randomUUID();await restoreClosedProfile(Buffer.from(backup.bytes,'base64'),path.join(f.config.profilesRoot,recovered));f.select(recovered);
  for(let restart=0;restart<2;restart++){
   const next=await f.epoch(),selected=path.join(f.config.profilesRoot,recovered),data=prepareManagedDesktopContext(f.config.appData,selected,next,f.gate,()=>{});
   operate=await createMaintenanceOperations({trust:f.trust,generation:recovered,gate:f.gate,protection:await fakeProtection(data),restoreCursor:async()=>true});
   assert.deepEqual(await operate('backup-key',{initialize:restart===1}),original);await operate('close',{});
  }
  assert.deepEqual(await fs.readFile(path.join(f.config.root,'backup-key.dpapi')),wrapped);assert.deepEqual(await fs.readFile(path.join(f.config.root,'protection-context.json')),association);assert.deepEqual(await captureClosedProfile(f.profile),before);assert.deepEqual(await captureClosedProfile(path.join(f.config.profilesRoot,recovered)),before);
 }finally{await f.close();}
});

test('independent owned installations reopen complete closed copies without sharing writable Chromium directories',async()=>{
 const f=await fixture();let otherGate:ReturnType<typeof claimProfileWriter>|undefined;
 try{
  const original=await captureClosedProfile(f.profile),otherRoot=path.join(f.root,'independent-copy'),config=configFor(otherRoot),generation=randomUUID(),profile=path.join(config.profilesRoot,generation);
  for(const dir of [config.root,config.profilesRoot,config.appData])await fs.mkdir(dir,{recursive:true});await restoreClosedProfile(original,profile);
  const file=path.join(otherRoot,'trust.json'),bytes=JSON.stringify(config);await fs.writeFile(file,bytes);const trust:ManagedTrust={config,file,sha256:managedHash(bytes),assert:async()=>{}};
  otherGate=claimProfileWriter(config);await bindManagedProtectionContext(trust,generation,otherGate);const epoch=randomUUID();
  await fs.writeFile(path.join(config.root,'host.json'),JSON.stringify({installationId:config.installationId,ownerSha256:config.ownerSha256,trustSha256:trust.sha256,epoch,generation,phase:'maintenance'}));
  const env={CAPRI_MANAGED_TRUST:file,CAPRI_MANAGED_TRUST_SHA256:trust.sha256,CAPRI_MANAGED_EPOCH:epoch,CAPRI_MANAGED_GENERATION:generation,CAPRI_MANAGED_CHANNEL:randomBytes(32).toString('hex')};
  const first=prepareManagedDesktopContext(f.config.appData,f.profile,await f.epoch(),f.gate,()=>{}),second=prepareManagedDesktopContext(config.appData,profile,env,otherGate,()=>{});assert.notEqual(first,second);
  for(const [selected,session] of [[f.profile,first],[profile,second]]){const s=await openExistingProfile(selected,await fakeProtection(session));try{assert.equal((await s.get('memory','known'))?.text,'Neutral retained record');}finally{await s.close();}}
  assert.deepEqual(await captureClosedProfile(f.profile),original);assert.deepEqual(await captureClosedProfile(profile),original);
 }finally{await otherGate?.close();await f.close();}
});

test('wrong retained backup-key ciphertext is unavailable and never replaced by initialize=true',async()=>{
 const f=await fixture();try{
  const env=await f.epoch(),data=prepareManagedDesktopContext(f.config.appData,f.profile,env,f.gate,()=>{}),operate=await createMaintenanceOperations({trust:f.trust,generation:f.generation,gate:f.gate,protection:await fakeProtection(data)});
  const wrong=path.join(f.root,'wrong-key-context');await fs.mkdir(wrong);await fs.writeFile(path.join(wrong,'Local State'),JSON.stringify(fakeContext()));
  const wrapped=(await fakeProtection(wrong)).encryptString(randomBytes(32).toString('base64')),file=path.join(f.config.root,'backup-key.dpapi');await fs.writeFile(file,wrapped,{flag:'wx'});
  await assert.rejects(operate('backup-key',{initialize:true}));assert.deepEqual(await fs.readFile(file),wrapped);
 }finally{await f.close();}
});

test('elected managed normal context requires the current generation, launch epoch and nonce before initialization',async()=>{
 const f=await fixture();try{
  const env={...await f.epoch(),CAPRI_UPDATE_NONCE:randomUUID()},journalFile=path.join(f.config.root,'host.json'),journal=JSON.parse(await fs.readFile(journalFile,'utf8'));
  const state={schemaVersion:1,sequenceFloor:1,active:f.config.maintenance.snapshot,phase:'healthy',nonce:env.CAPRI_UPDATE_NONCE};await fs.writeFile(path.join(f.config.root,'state.json'),JSON.stringify(state));
  journal.phase='starting';await fs.writeFile(journalFile,JSON.stringify(journal));const before=await captureClosedProfile(f.profile);
  assert.equal(assertManagedNormalStartupContext(f.config.appData,f.profile,env,f.gate),f.profile);
  for(const field of ['CAPRI_UPDATE_NONCE','CAPRI_MANAGED_EPOCH','CAPRI_MANAGED_GENERATION'])assert.throws(()=>assertManagedNormalStartupContext(f.config.appData,f.profile,{...env,[field]:randomUUID()},f.gate));
  journal.phase='active';await fs.writeFile(journalFile,JSON.stringify(journal));assert.throws(()=>assertManagedNormalStartupContext(f.config.appData,f.profile,env,f.gate),/Stale/);
  assert.deepEqual(await captureClosedProfile(f.profile),before);
 }finally{await f.close();}
});

for(const mode of ['missing','corrupt','wrong','hardlink','alias','binding','installation','owner','epoch','generation','override','stopped','lost-during-preparation'] as const)test('protection selection fails closed: '+mode,async()=>{
 const f=await fixture();try{
  const env=await f.epoch(),stateFile=path.join(f.profile,'Local State'),original=await fs.readFile(stateFile),before=await fs.readFile(path.join(f.profile,'private.config'));
  const destination=managedDesktopData(f.config.appData,f.profile,true,env),abort=new AbortController();let owned=true;
  if(mode==='missing')await fs.unlink(stateFile);
  if(mode==='corrupt')await fs.writeFile(stateFile,'{');
  if(mode==='wrong')await fs.writeFile(stateFile,JSON.stringify(fakeContext()));
  if(mode==='hardlink'){const other=path.join(f.root,'own-context-copy');await fs.rename(stateFile,other);await fs.link(other,stateFile);}
  // Windows junctions exercise a real directory alias without requiring the
  // elevated file-symlink privilege. The selected context remains under that
  // alias, and production must reject it before preparing a helper directory.
  if(mode==='alias'){const other=path.join(f.root,'own-profile-copy');await fs.rename(f.profile,other);await fs.symlink(other,f.profile,process.platform==='win32'?'junction':'dir');assert.equal((await fs.lstat(f.profile)).isSymbolicLink(),true);}
  if(mode==='binding')await fs.writeFile(path.join(f.config.root,'protection-context.json'),'{}');
  if(mode==='owner'||mode==='installation'||mode==='epoch'||mode==='generation'){const file=path.join(f.config.root,'host.json'),record=JSON.parse(await fs.readFile(file,'utf8'));record[mode==='owner'?'ownerSha256':mode==='installation'?'installationId':mode]=randomUUID();await fs.writeFile(file,JSON.stringify(record));}
  if(mode==='override')env.CAPRI_MANAGED_TRUST_SHA256='0'.repeat(64);
  if(mode==='stopped')abort.abort();
  const prepare=()=>prepareManagedDesktopContext(f.config.appData,f.profile,env,{owned:()=>owned},()=>{if(mode==='lost-during-preparation')owned=false;},abort.signal);
  if(mode==='alias')assert.throws(prepare,/alias/i);else assert.throws(prepare);
  await assert.rejects(fs.access(destination));assert.deepEqual(await fs.readFile(path.join(f.profile,'private.config')),before);await assert.rejects(fs.access(path.join(f.config.root,'backup-key.dpapi')));
  // The negative path never repairs, rewrites or imports context.
  if(!['missing','corrupt','wrong'].includes(mode))assert.deepEqual(await fs.readFile(stateFile),original);
 }finally{await f.close();}
});

test('missing backup-key association never regenerates an existing key, even with initialization requested',async()=>{
 const f=await fixture();try{
  const env=await f.epoch(),data=prepareManagedDesktopContext(f.config.appData,f.profile,env,f.gate,()=>{}),protection=await fakeProtection(data);
  const operate=await createMaintenanceOperations({trust:f.trust,generation:f.generation,gate:f.gate,protection});await operate('backup-key',{initialize:true});
  const file=path.join(f.config.root,'backup-key.dpapi'),before=await fs.readFile(file);await fs.unlink(path.join(f.config.root,'protection-context.json'));
  await assert.rejects(operate('backup-key',{initialize:true}));await assert.rejects(bindManagedProtectionContext(f.trust,f.generation,f.gate),/context unavailable/);assert.deepEqual(await fs.readFile(file),before);
 }finally{await f.close();}
});

test('owned context preparation rejects overlap and ownership loss at the write boundary; main calls it before startup selection',async()=>{
 const f=await fixture();try{
  assert.throws(()=>prepareProtectedDesktopContext({profile:f.profile,directory:path.join(f.profile,'cache'),appData:f.config.appData,gate:f.gate,assertCurrent:()=>{}}),/Independent/);
  let owned=true,checks=0;const directory=path.join(f.root,'cancelled-helper');assert.throws(()=>prepareProtectedDesktopContext({profile:f.profile,directory,appData:f.config.appData,gate:{owned:()=>owned},assertCurrent:()=>{if(++checks===3)owned=false;}}),/ownership lost/);
  await assert.rejects(fs.access(directory));
  const source=await fs.readFile(path.resolve('src/desktop/main.ts'),'utf8');assert.ok(source.indexOf('desktopData=prepareManagedDesktopContext(')<source.indexOf('const ownsDesktopInstance=prepareDesktopStartup('));assert.ok(source.indexOf('writerGate=claimProfileWriter(config)')<source.indexOf('desktopData=prepareManagedDesktopContext('));
 }finally{await f.close();}
});

test('malformed Local State exposes only a generic error through the production parser and startup seam',async()=>{
 const f=await fixture();try{
  // A short invalid literal is included verbatim by the pinned Node parser's
  // syntax error; an EOF-only error would not exercise input-snippet redaction.
  const marker=['neutral',randomBytes(4).toString('hex')].join('-'),file=path.join(f.profile,'Local State'),malformed=marker;
  await fs.writeFile(file,malformed);const before=await captureClosedProfile(f.profile),env=await f.epoch();
  for(const read of [()=>readProfileProtectionContext(f.profile,f.config.appData),()=>prepareManagedDesktopContext(f.config.appData,f.profile,env,f.gate,()=>{})]){
   assert.throws(read,(error:unknown)=>{
    assert.ok(error instanceof Error);assert.equal(error.message,'Selected protection context unavailable.');
    const exposed=JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(error).map(name=>[name,(error as any)[name]])));
    assert.equal(exposed.includes(marker),false);assert.equal(Object.hasOwn(error,'cause'),false);assert.deepEqual(Object.getOwnPropertyNames(error).sort(),['message','stack']);return true;
   });
  }
  assert.deepEqual(await captureClosedProfile(f.profile),before);await assert.rejects(fs.access(managedDesktopData(f.config.appData,f.profile,true,env)));
 }finally{await f.close();}
});

// This is an exact owned environment, never an ambient allowlist. The six
// automatic Windows metadata names are the only names normalized in the child.
function neutralNativeEnvironment(root:string,profile:string):Record<string,string>{
 return {SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',ComSpec:'C:\\Windows\\System32\\cmd.exe',PATHEXT:'.COM;.EXE;.BAT;.CMD',PATH:'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Windows',
  USERPROFILE:path.join(root,'neutral-user'),APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'neutral-local'),TEMP:path.join(root,'temp'),TMP:path.join(root,'temp'),TMPDIR:path.join(root,'temp'),CAPRI_PROFILE_DIR:profile,CAPRI_DEV_PORT:'18601'};
}
function checkNeutralEnvironment(actual:NodeJS.ProcessEnv,expected:Record<string,string>){
 const automatic=['HOMEDRIVE','HOMEPATH','LOGONSERVER','SYSTEMDRIVE','USERDOMAIN','USERNAME'],seen=new Set<string>(),removed:string[]=[];
 const wanted=new Map(Object.entries(expected).map(([name,value])=>[name.toUpperCase(),value]));
 for(const [name,value] of Object.entries(actual)){
  const key=name.toUpperCase();if(seen.has(key))throw Error('Neutral environment binding invalid.');seen.add(key);
  if(!wanted.has(key)&&automatic.includes(key)){removed.push(key);continue;}
  if(!wanted.has(key)||value!==wanted.get(key))throw Error('Neutral environment binding invalid.');
 }
 if([...wanted.keys()].some(name=>!seen.has(name)))throw Error('Neutral environment binding invalid.');return removed.sort();
}
test('neutral child environment rejects inherited credentials, launch overrides and path drift',()=>{
 const root=path.resolve('dist','neutral-environment'),env=neutralNativeEnvironment(root,path.join(root,'profiles',randomUUID()));
 assert.deepEqual(checkNeutralEnvironment({...env},env),[]);
 const automatic=['HOMEDRIVE','HOMEPATH','LOGONSERVER','SYSTEMDRIVE','USERDOMAIN','USERNAME'];
 assert.deepEqual(checkNeutralEnvironment({...env,...Object.fromEntries(automatic.map(name=>[name,'automatic-metadata']))},env),automatic.sort());
 for(const name of [['PROVIDER','CREDENTIAL'].join('_'),'NODE_OPTIONS','ELECTRON_RUN_AS_NODE','CAPRI_MANAGED_TRUST','UNKNOWN_METADATA'])assert.throws(()=>checkNeutralEnvironment({...env,[name]:'untrusted'},env),/binding invalid/);
 for(const name of ['APPDATA','LOCALAPPDATA','USERPROFILE','PATH','CAPRI_PROFILE_DIR'])assert.throws(()=>checkNeutralEnvironment({...env,[name]:path.join(root,'wrong')},env),/binding invalid/);
 const missing={...env};delete missing.APPDATA;assert.throws(()=>checkNeutralEnvironment(missing,env),/binding invalid/);
 assert.throws(()=>checkNeutralEnvironment({...env,path:env.PATH},env),/binding invalid/);
});

// Root-only real-neutral acceptance. Default tests register no native placeholder
// or skip. Opt-in requires exact public pins, and fails if any tool is absent or
// wrong. Never set this mode in worker development. Run with the pinned Node:
// --import tsx --test --test-concurrency=1 tests/managed-protection-context.test.ts
// CAPRI_MANAGED_PROTECTION_NATIVE_TESTS=1 plus these trusted operator variables:
// CAPRI_MANAGED_PROTECTION_{NODE,ELECTRON,SUPERVISOR} (absolute .exe paths),
// matching *_SHA256, and CAPRI_MANAGED_PROTECTION_ELECTRON_VERSION (exact 45.x).
if(process.env.CAPRI_MANAGED_PROTECTION_NATIVE_TESTS==='1')test('real Windows safeStorage two-process continuity, wrong-context negative and recovery restart',{timeout:180000},async t=>{
 assert.equal(process.platform,'win32','Real protected-storage acceptance requires Windows.');
 const {spawn,execFileSync}=await import('node:child_process'),{build}=await import('esbuild');
 const {prepareSupervisedLaunch,armSupervisedRun,inspectSupervisedRun,cancelSupervisedRun}=await import('../src/extensions/supervisor');
 const {readProtectionFile}=await import('../src/desktop/runtime-profile');
 const prefix='CAPRI_MANAGED_PROTECTION_',tools={} as Record<'NODE'|'ELECTRON'|'SUPERVISOR',{path:string;sha256:string}>;
 for(const kind of ['NODE','ELECTRON','SUPERVISOR'] as const){const file=process.env[prefix+kind]??'',pin=process.env[prefix+kind+'_SHA256']??'';assert.match(pin,/^[a-f0-9]{64}$/,'Explicit Root tool pin required.');assert.ok(path.isAbsolute(file)&&file.toLowerCase().endsWith('.exe'));
  tools[kind]={path:file,sha256:pin};assert.equal(managedHash(readProtectionFile(file,path.resolve('dist'),512*1024*1024)),pin,'Pinned tool changed.');}
 assert.equal(path.resolve(tools.NODE.path).toLowerCase(),path.resolve(process.execPath).toLowerCase(),'Run through the exact pinned Node.');
 const electronVersion=process.env[prefix+'ELECTRON_VERSION']??'';assert.match(electronVersion,/^45\.\d+\.\d+$/,'Exact reviewed Electron 45 version required.');
 const parent=path.resolve('dist');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'native-protection-')),generation=randomUUID(),profile=path.join(root,'profiles',generation),childEnvironment=neutralNativeEnvironment(root,profile);
 const evidenceDirectory=path.join(root,'evidence');
 const childCwd=path.join(root,'work');
 for(const directory of [childEnvironment.USERPROFILE,childEnvironment.APPDATA,childEnvironment.LOCALAPPDATA,childEnvironment.TEMP,profile,path.join(root,'host'),path.join(root,'control'),path.join(root,'identities'),evidenceDirectory,childCwd])await fs.mkdir(directory,{recursive:true});
 async function durable(file:string,value:unknown){const h=await fs.open(file,'wx',0o600);try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}}
 const modulePath=(file:string)=>JSON.stringify(path.resolve(file).replaceAll('\\','/'));
 // Derive the production owner in pinned Node under the SAME neutral home as
 // Electron, before constructing config. No parent home or ambient launch flags.
 const ownerHelper=path.join(root,'owner.cjs');
 await build({stdin:{contents:`import {managedOwnerSha256} from ${modulePath('src/extensions/managed-update-host.ts')};console.log(managedOwnerSha256());`,resolveDir:process.cwd(),sourcefile:'neutral-owner.ts',loader:'ts'},bundle:true,platform:'node',format:'cjs',packages:'external',outfile:ownerHelper,logLevel:'silent'});
 const owner=execFileSync(tools.NODE.path,[ownerHelper],{cwd:root,env:childEnvironment,encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','ignore']}).trim();assert.match(owner,/^[a-f0-9]{64}$/,'Neutral Node owner derivation failed.');
 const config=configFor(root,owner);assert.equal(config.appData,childEnvironment.APPDATA);
 const trustFile=path.join(root,'trust.json'),trustBytes=JSON.stringify(config),trustSha256=managedHash(trustBytes);await fs.writeFile(trustFile,trustBytes);
 const optionsFile=path.join(root,'options.json'),helper=path.join(root,'offline.cjs');
 const options={root,config,generation,profile,trustFile,trustSha256,electronVersion,environment:childEnvironment,executable:tools.ELECTRON.path};await fs.writeFile(optionsFile,JSON.stringify(options));
 // Only offline profile/storage/maintenance modules are bundled. No normal
 // desktop, service, provider, voice, cursor invocation or installed data access.
 const source=`
import {app,safeStorage} from 'electron';
import fs from 'node:fs';import path from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from ${modulePath('src/server/store.ts')};
import {defaults} from ${modulePath('src/shared.ts')};
import {claimProfileWriter,prepareDesktopStartup} from ${modulePath('src/desktop/runtime-profile.ts')};
import {bindManagedProtectionContext,prepareManagedDesktopContext,managedOwnerSha256} from ${modulePath('src/extensions/managed-update-host.ts')};
import {createMaintenanceOperations,openExistingProfile} from ${modulePath('src/desktop/update-maintenance.ts')};
const o=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),mode=process.argv[3],selected=process.argv[4]||o.generation;
const trust={config:o.config,file:o.trustFile,sha256:o.trustSha256,assert:async()=>{}},profile=path.join(o.config.profilesRoot,selected);
const checkEnvironment=${checkNeutralEnvironment.toString()};
const removedAutomaticEnvironmentNames=checkEnvironment(process.env,{...o.environment,CAPRI_PROFILE_DIR:profile});
if(managedOwnerSha256()!==o.config.ownerSha256)throw Error('Neutral owner binding invalid.');
app.setPath('appData',o.config.appData);
const gate=claimProfileWriter(o.config);let context=profile;
app.disableHardwareAcceleration();
const env={CAPRI_MANAGED_TRUST:o.trustFile,CAPRI_MANAGED_TRUST_SHA256:o.trustSha256,CAPRI_MANAGED_GENERATION:selected,CAPRI_MANAGED_EPOCH:randomUUID(),CAPRI_MANAGED_CHANNEL:randomBytes(32).toString('hex')};
if(mode==='negative')context=path.join(o.root,'fresh-negative-'+randomUUID());
if(mode==='read'){
 fs.writeFileSync(path.join(o.config.root,'host.json'),JSON.stringify({installationId:o.config.installationId,ownerSha256:o.config.ownerSha256,trustSha256:o.trustSha256,epoch:env.CAPRI_MANAGED_EPOCH,generation:selected,phase:'maintenance'}));
 context=prepareManagedDesktopContext(app.getPath('appData'),profile,env,gate);
}
prepareDesktopStartup(app,context,false,()=>{});
async function run(){
 await app.whenReady();
 const observed={userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),appData:app.getPath('appData'),executable:process.execPath,electron:process.versions.electron};
 if(observed.userData.toLowerCase()!==context.toLowerCase()||observed.sessionData.toLowerCase()!==context.toLowerCase()||observed.appData.toLowerCase()!==o.config.appData.toLowerCase()||observed.executable.toLowerCase()!==o.executable.toLowerCase()||observed.electron!==o.electronVersion)throw Error('Neutral Electron binding invalid.');
 checkEnvironment(process.env,{...o.environment,CAPRI_PROFILE_DIR:profile});
 if(!safeStorage.isEncryptionAvailable())throw Error('Unavailable pinned storage');
 if(mode==='seed'){
  const key=randomBytes(32),vault={storageKey:key.toString('base64'),adminToken:randomBytes(32).toString('hex'),apiKey:['neutral','configuration'].join('-')};
  const encrypted=safeStorage.encryptString(JSON.stringify(vault));if(encrypted.subarray(0,3).toString()!=='v10')throw Error('Expected legacy v10');
  fs.writeFileSync(path.join(profile,'private.config'),encrypted,{flag:'wx'});
  const store=await new Store(path.join(profile,'data'),key).init();await store.put('settings',{...defaults,id:'main',speechEngine:'designed-hq'});await store.put('memory',{id:'known',text:'Neutral real retained record'});await store.put('paired-android-receipt',{id:'uncertain',state:'unconfirmed'});await store.close();key.fill(0);
  const until=Date.now()+10000;while(!fs.existsSync(path.join(profile,'Local State'))&&Date.now()<until)await new Promise(r=>setTimeout(r,50));
  await bindManagedProtectionContext(trust,selected,gate);const operate=await createMaintenanceOperations({trust,generation:selected,gate,protection:safeStorage});
  const backup=await operate('backup-key',{initialize:true});fs.writeFileSync(path.join(o.root,'backup-evidence.bin'),safeStorage.encryptString(backup.key),{flag:'wx'});await operate('close',{});
 }else if(mode==='negative'){
  let failed=false;try{safeStorage.decryptString(fs.readFileSync(path.join(profile,'private.config')));}catch{failed=true;}if(!failed)throw Error('Fresh context unexpectedly decrypted');
 }else if(mode==='read'){
  const store=await openExistingProfile(profile,safeStorage);try{if((await store.get('memory','known'))?.text!=='Neutral real retained record'||(await store.get('settings','main'))?.speechEngine!=='designed-hq'||(await store.get('paired-android-receipt','uncertain'))?.state!=='unconfirmed')throw Error('Retained record mismatch');}finally{await store.close();}
  const operate=await createMaintenanceOperations({trust,generation:selected,gate,protection:safeStorage}),backup=await operate('backup-key',{initialize:true});
  if(safeStorage.decryptString(fs.readFileSync(path.join(o.root,'backup-evidence.bin')))!==backup.key)throw Error('Backup key changed');await operate('close',{});
 }else throw Error('Invalid neutral mode');
 await gate.close();console.log('CAPRI_PROTECTION '+JSON.stringify({passed:true,available:true,negative:mode==='negative',records:mode==='read'?3:0,observed,context,environmentVerified:true,ownerVerified:true,removedAutomaticEnvironmentNames}));app.quit();
}
run().catch(async()=>{await gate.close();console.log('CAPRI_PROTECTION '+JSON.stringify({passed:false}));app.exit(1);});`;
 await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'offline-neutral.ts',loader:'ts'},bundle:true,platform:'node',format:'cjs',packages:'external',outfile:helper,logLevel:'silent'});
 const sourceFiles=['tests/managed-protection-context.test.ts','src/desktop/runtime-profile.ts','src/extensions/managed-update-host.ts','src/desktop/update-maintenance.ts'];
 const bindings={schemaVersion:1,source:await Promise.all(sourceFiles.map(async file=>({path:file,sha256:managedHash(await fs.readFile(file))}))),helper:{path:helper,sha256:managedHash(await fs.readFile(helper))},ownerHelper:{path:ownerHelper,sha256:managedHash(await fs.readFile(ownerHelper))},tools,electronVersion,fixture:root,profile,appData:config.appData,neutralHome:childEnvironment.USERPROFILE};
 await durable(path.join(evidenceDirectory,'bindings.json'),bindings);
 const evidence:object[]=[];let cleanupConfirmed=true,acceptancePassed=false;
 async function run(mode:'seed'|'negative'|'read',selected:string=generation){
  t.signal.throwIfAborted();
  const caseId=mode+'-'+randomUUID(),caseEvidence=path.join(evidenceDirectory,caseId),identityFile=path.join(root,'identities',caseId+'.json');await fs.mkdir(caseEvidence);
  const signal=new AbortController(),timer=setTimeout(()=>signal.abort(Error('Neutral fixture deadline')),30000);
  const stop=()=>signal.abort(Error('Neutral fixture stopped'));t.signal.addEventListener('abort',stop,{once:true});if(t.signal.aborted)stop();
  const launch=prepareSupervisedLaunch({helperPath:tools.SUPERVISOR.path,helperSha256:tools.SUPERVISOR.sha256,controlRoot:path.join(root,'control'),cwd:childCwd,executable:tools.ELECTRON.path,args:[helper,optionsFile,mode,selected],scopeSha256:managedHash(JSON.stringify({helper:managedHash(await fs.readFile(helper)),mode,selected}))});
  const childEnv={...childEnvironment,CAPRI_PROFILE_DIR:path.join(config.profilesRoot,selected)};checkNeutralEnvironment(childEnv,childEnv);
  // Dispatch, exit and inspection receipts contain no control tokens or private
  // errors. Exact private identity + signed native protocol files remain owned
  // beside them so Root can independently reinspect instead of trusting booleans.
  await durable(path.join(caseEvidence,'dispatch.json'),{schemaVersion:1,mode,selected,profile:childEnv.CAPRI_PROFILE_DIR,identityFile,bindings:path.join(evidenceDirectory,'bindings.json'),scopeSha256:launch.control.scopeSha256,commandSha256:launch.control.commandSha256});
  let identity:Awaited<ReturnType<typeof armSupervisedRun>>|undefined,closed:{code:number|null;signal:NodeJS.Signals|null}|undefined,casePassed=false,cancelRequested=false,spawnFailed=false;
  const child=spawn(launch.executable,launch.args,{cwd:childCwd,env:childEnv,stdio:['pipe','pipe','pipe'],shell:false,...launch.spawnOptions});let output='';child.stdout.on('data',b=>{output+=b.toString();if(output.length>8192)signal.abort();});child.stderr.resume();child.stdin.on('error',()=>{});
  // Attach before arming, including spawn-error and cancellation cases. No raw
  // stderr/output is persisted: it may contain private crypto/parser failures.
  const exited=new Promise<void>((resolve,reject)=>{
   child.once('error',()=>{spawnFailed=true;});
   child.once('close',(code,exitSignal)=>{closed={code,signal:exitSignal};durable(path.join(caseEvidence,'exit.json'),{schemaVersion:1,capturedPid:child.pid??null,closeObserved:true,code,signal:exitSignal,spawnFailed,cancelRequested,deadlineOrStop:signal.signal.aborted}).then(resolve,reject);});
  });void exited.catch(()=>{});
  try{
   await armSupervisedRun(launch.control,child,{signal:signal.signal,onArmed:async value=>{
    await durable(identityFile,value);identity=value;
    const a=value.armed;
    await durable(path.join(caseEvidence,'armed.json'),{schemaVersion:1,capturedPid:child.pid,identityFile,creatorPid:a.creatorPid,creatorCreated:a.creatorCreated,guardianPid:a.guardianPid,guardianCreated:a.guardianCreated,jobId:a.jobId,publicKey:a.publicKey,armedAt:a.armedAt,armedSha256:value.armedSha256,helperPath:a.helperPath,helperSha256:a.helperSha256,scopeSha256:a.scopeSha256,commandSha256:a.commandSha256,cwdSha256:a.cwdSha256});
   }});
   signal.signal.throwIfAborted();
   await Promise.race([exited,new Promise<never>((_,reject)=>signal.signal.addEventListener('abort',()=>reject(Error('Neutral fixture stopped')),{once:true}))]);assert.equal(closed?.code,0,'Captured child must exit naturally.');assert.equal(closed.signal,null);assert.ok(identity,'Durable captured identity required.');
   let proof=inspectSupervisedRun(identity);const until=Date.now()+5000;while(proof.state!=='stopped'&&Date.now()<until){await new Promise(r=>setTimeout(r,20));proof=inspectSupervisedRun(identity);}
   assert.equal(proof.state,'stopped');if(proof.state!=='stopped')throw Error('Whole-Job proof missing');assert.equal(proof.proof.activeProcesses,0);assert.equal(proof.proof.reason,'main-exited');assert.equal(proof.proof.mainExitCode,0);
   const line=output.split(/\r?\n/).find(line=>line.startsWith('CAPRI_PROTECTION '));assert.ok(line,'Bounded child evidence missing.');const result=JSON.parse(line.slice('CAPRI_PROTECTION '.length));assert.equal(result.passed,true);assert.equal(result.available,true);assert.equal(result.negative,mode==='negative');
   assert.equal(result.environmentVerified,true);assert.equal(result.ownerVerified,true);assert.equal(result.records,mode==='read'?3:0);
   assert.equal(result.observed.appData,config.appData);assert.equal(result.observed.electron,electronVersion);assert.equal(result.observed.executable.toLowerCase(),tools.ELECTRON.path.toLowerCase());
   assert.equal(result.observed.userData,result.context);assert.equal(result.observed.sessionData,result.context);
   if(mode==='seed')assert.equal(result.context,childEnv.CAPRI_PROFILE_DIR);
   else if(mode==='negative')assert.equal(path.dirname(result.context),root);
   else{assert.equal(path.dirname(path.dirname(path.dirname(result.context))),config.root);assert.equal(path.basename(path.dirname(path.dirname(result.context))),'maintenance-electron');}
   assert.ok(Array.isArray(result.removedAutomaticEnvironmentNames));for(const name of result.removedAutomaticEnvironmentNames)assert.ok(['HOMEDRIVE','HOMEPATH','LOGONSERVER','SYSTEMDRIVE','USERDOMAIN','USERNAME'].includes(name));
   await durable(path.join(caseEvidence,'observation.json'),{schemaVersion:1,mode,passed:true,available:true,negative:result.negative,records:result.records,observed:result.observed,context:result.context,environmentVerified:true,ownerVerified:true,removedAutomaticEnvironmentNames:result.removedAutomaticEnvironmentNames});
   casePassed=true;evidence.push({mode,evidenceDirectory:caseEvidence,naturalExit:true,wholeJobZero:true,records:result.records});
  }catch{throw Error('Neutral native case failed; retained evidence: '+caseEvidence);}
  finally{
   clearTimeout(timer);t.signal.removeEventListener('abort',stop);
   let inspection:ReturnType<typeof inspectSupervisedRun>|undefined;
   if(identity){try{inspection=inspectSupervisedRun(identity);if(inspection.state!=='stopped'){cancelRequested=true;await cancelSupervisedRun(identity);inspection=inspectSupervisedRun(identity);}}catch{/* Preserve unknown cleanup, never emit private native errors. */}}
   child.stdin.end();
   // Bound close observation after failed arming/Stop as well as normal exit.
   let closeTimer:NodeJS.Timeout|undefined;try{await Promise.race([exited,new Promise<void>(resolve=>{closeTimer=setTimeout(resolve,5000);})]);}catch{/* The durable final receipt still records uncertainty. */}finally{clearTimeout(closeTimer);}
   const stopped=inspection?.state==='stopped';cleanupConfirmed=cleanupConfirmed&&stopped&&!!closed;
   const inspected=inspection?.state==='stopped'?{state:'stopped',terminalSha256:inspection.terminalSha256,proof:{schemaVersion:inspection.proof.schemaVersion,jobId:inspection.proof.jobId,activeProcesses:inspection.proof.activeProcesses,reason:inspection.proof.reason,mainExitCode:inspection.proof.mainExitCode,finishedAt:inspection.proof.finishedAt},signatureVerified:true}: {state:'recovery-required',reason:inspection?.state==='recovery-required'?inspection.reason:'captured-identity-unavailable'};
   await durable(path.join(caseEvidence,'inspection.json'),{schemaVersion:1,identityFile,capturedPid:child.pid??null,casePassed,closeObserved:!!closed,naturalExit:!!closed&&!cancelRequested&&!signal.signal.aborted&&closed.signal===null,exitCode:closed?.code??null,cancelRequested,deadlineOrStop:signal.signal.aborted,inspection:inspected});
  }
 }
 try{
  await run('seed');const original=await captureClosedProfile(profile),wrapped=await fs.readFile(path.join(config.root,'backup-key.dpapi'));
  await run('negative');assert.equal((await captureClosedProfile(profile)).equals(original),true,'Negative case changed closed source.');await run('read');assert.equal((await captureClosedProfile(profile)).equals(original),true,'Maintenance changed closed source.');
  const recovered=randomUUID();await restoreClosedProfile(original,path.join(config.profilesRoot,recovered));await run('read',recovered);await run('read',recovered);
  assert.equal((await captureClosedProfile(profile)).equals(original),true,'Original closed profile changed.');assert.equal((await captureClosedProfile(path.join(config.profilesRoot,recovered))).equals(original),true,'Recovery copy changed.');assert.equal((await fs.readFile(path.join(config.root,'backup-key.dpapi'))).equals(wrapped),true,'Protected backup key changed.');
  // No plaintext, decrypted vault, key or secret digest is emitted. The summary
  // binds source/tool/context paths and observed booleans/counts only.
  acceptancePassed=true;
 }finally{
  assert.equal(path.dirname(root),parent);
  await durable(path.join(evidenceDirectory,'acceptance.json'),{schemaVersion:1,acceptancePassed,cleanupConfirmed,fixtureRetained:root,evidence});
  console.log(JSON.stringify({source:'tests/managed-protection-context.test.ts',evidenceDirectory,fixtureRetained:root,acceptancePassed,cleanupConfirmed,cases:evidence.length}));
 }
});
