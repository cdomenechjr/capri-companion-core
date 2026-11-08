import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {Store} from '../src/server/store';
import {seal,unseal} from '../src/server/store';
import {acquireProfileWriter,assertManagedProfileLaunch,managedDirectory,runtimeProfile} from '../src/desktop/runtime-profile';
import {captureClosedProfile,parseClosedProfile,restoreClosedProfile,openExistingProfile,createMaintenanceOperations,type ProtectedStorage} from '../src/desktop/update-maintenance';
import {ManagedChannel,managedHash,bindManagedProtectionContext,type ManagedTrust,type ManagedConfig} from '../src/extensions/managed-update-host';
import {defaults} from '../src/shared';

// Generated isolated profiles/keys only. No real safeStorage, provider, device,
// cursor mutation, security scan or installed application/profile is used.
export async function maintenanceFixture(){
 const parent=path.resolve('dist');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'maintenance-'));
 const appData=path.join(root,'appdata'),managed=path.join(root,'host'),profilesRoot=path.join(root,'profiles');for(const dir of [appData,managed,profilesRoot])await fs.mkdir(dir);
 const wrapping=randomBytes(32),key=randomBytes(32);const protection:ProtectedStorage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(seal(value,wrapping)),decryptString:bytes=>unseal(bytes.toString(),wrapping)};
 const generation=randomUUID(),profile=path.join(profilesRoot,generation);await fs.mkdir(profile);
 await fs.writeFile(path.join(profile,'Local State'),JSON.stringify({os_crypt:{encrypted_key:Buffer.concat([Buffer.from('DPAPI'),wrapping]).toString('base64')}}));
 await fs.writeFile(path.join(profile,'private.config'),protection.encryptString(JSON.stringify({storageKey:key.toString('base64'),adminToken:randomBytes(32).toString('hex')})));
 const store=await new Store(path.join(profile,'data'),key).init();await store.put('settings',{id:'main',...defaults,voice:'Designed A'});await store.put('memory',{id:'personal-format',text:'Neutral fixture memory'});await store.close();
 const config={schemaVersion:1,installationId:randomUUID(),ownerSha256:managedHash(randomBytes(32)),root:managed,profilesRoot,appData,port:18601,dataVersion:1,pollMs:3600000} as ManagedConfig;
 const trust:ManagedTrust={config,file:path.join(root,'public-trust.json'),sha256:managedHash('public fixture trust'),assert:async()=>{}};
 const bindingGate=await acquireProfileWriter(config);try{await bindManagedProtectionContext(trust,generation,bindingGate);}finally{await bindingGate.close();}
 return {root,profile,config,trust,generation,key,protection,close:async()=>{wrapping.fill(0);key.fill(0);assert.equal(path.dirname(root),parent);await fs.rm(root,{recursive:true,force:true});}};
}

test('offline complete backup restores ciphertext, preferences and unexported records into a fresh generation',async()=>{
 const f=await maintenanceFixture();try{
  const s=await openExistingProfile(f.profile,f.protection);await s.put('paired-android-receipt',{id:'claim',deviceId:'fixture-device',notificationId:'notice',bodySha256:managedHash('body'),state:'unconfirmed'});await s.close();
  await fs.mkdir(path.join(f.profile,'empty'));await fs.writeFile(path.join(f.profile,'private-extra.bin'),randomBytes(128));
  const bytes=await captureClosedProfile(f.profile),profile=parseClosedProfile(bytes);assert.ok(profile.files.some(v=>v.path==='private-extra.bin'));assert.ok(profile.directories.includes('empty'));
  const restored=path.join(f.config.profilesRoot,randomUUID());await restoreClosedProfile(bytes,restored);assert.deepEqual(await captureClosedProfile(restored),bytes);
  const recovered=await openExistingProfile(restored,f.protection);assert.equal((await recovered.get('settings','main'))?.voice,'Designed A');assert.equal((await recovered.get('paired-android-receipt','claim'))?.state,'unconfirmed');assert.equal((await recovered.export())['paired-android-receipt'],undefined);await recovered.close();
  await assert.rejects(restoreClosedProfile(bytes,restored));assert.deepEqual(await captureClosedProfile(f.profile),bytes);
 }finally{await f.close();}
});

test('missing vault/key/database/settings and corrupt SQLite fail without replacement or changed bytes',async()=>{
 const f=await maintenanceFixture();try{
  for(const file of ['private.config','data/capri.sqlite']){const full=path.join(f.profile,file),saved=await fs.readFile(full);await fs.unlink(full);await assert.rejects(openExistingProfile(f.profile,f.protection));await assert.rejects(fs.access(full));await fs.writeFile(full,saved);}
  const file=path.join(f.profile,'data','capri.sqlite'),before=await fs.readFile(file);await fs.writeFile(file,Buffer.from('invalid-sqlite'));await assert.rejects(openExistingProfile(f.profile,f.protection));assert.equal((await fs.readFile(file)).toString(),'invalid-sqlite');await fs.writeFile(file,before);
  const s=await openExistingProfile(f.profile,f.protection);await s.remove('settings','main');await s.close();const missingSettings=await fs.readFile(file);await assert.rejects(openExistingProfile(f.profile,f.protection));assert.deepEqual(await fs.readFile(file),missingSettings);
 }finally{await f.close();}
});

test('offline fixed RPC rejects generic kinds/paths and drains before close; protected key survives reconstruction',async()=>{
 const f=await maintenanceFixture(),gate=await acquireProfileWriter(f.config);try{
  const operate=await createMaintenanceOperations({trust:f.trust,generation:f.generation,gate,protection:f.protection,restoreCursor:async()=>true});
  assert.equal((await operate('ready',{}) as any).writer,true);await assert.rejects(operate('eval',{command:'anything'}));await assert.rejects(operate('journal',{operation:'list',generation:f.generation,kind:'memory'}));
  const key=await operate('backup-key',{initialize:true}) as any;assert.equal(Buffer.from(key.key,'base64').length,32);assert.ok(!(await fs.readFile(path.join(f.config.root,'backup-key.dpapi'))).includes(Buffer.from(key.key,'base64')));
  assert.equal((await operate('backup-key',{initialize:false}) as any).key,key.key);
  const backup=operate('backup',{}),close=operate('close',{});assert.ok((await backup as any).bytes);assert.deepEqual(await close,{closed:true});await assert.rejects(operate('ready',{}));
 }finally{await gate.close();await f.close();}
});

test('stable listening handle excludes competing normal/maintenance generations and reacquires after owner close',async()=>{
 const id={installationId:randomUUID(),ownerSha256:managedHash(randomBytes(32))},gate=await acquireProfileWriter(id);
 try{await assert.rejects(acquireProfileWriter(id),/EADDRINUSE/);}finally{await gate.close();}
 const next=await acquireProfileWriter(id);assert.equal(next.owned(),true);await next.close();
});

test('actual independent subprocess ownership collides across generations and releases after crash',async()=>{
 const id={installationId:randomUUID(),ownerSha256:managedHash(randomBytes(32))};
 const name=managedHash('capri-profile-writer-v1\0'+id.ownerSha256+'\0'+id.installationId),address=process.platform==='win32'?'\\\\.\\pipe\\capri-writer-'+name:path.join('/tmp','capri-writer-'+name+'.sock');
 const source="import net from 'node:net';const server=net.createServer(s=>s.destroy());server.listen({path:process.argv[1],exclusive:true},()=>console.log('owned'));";
 const child=spawn(process.execPath,['--input-type=module','-e',source,address],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});
 try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('gate fixture timed out')),10000);child.stdout.on('data',b=>{if(b.toString().includes('owned')){clearTimeout(timer);resolve();}});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);reject(Error('gate fixture exited '+code));});});await assert.rejects(acquireProfileWriter(id),/EADDRINUSE/);}
 finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}}
 const gate=await acquireProfileWriter(id);await gate.close();
});

test('managed marker prevents ordinary launch bypass and rejects installed namespaces/aliases',async()=>{
 const f=await maintenanceFixture();try{
  const marker={schemaVersion:1,trustFile:f.trust.file,trustSha256:f.trust.sha256};await fs.writeFile(path.join(f.config.profilesRoot,'.capri-managed.json'),JSON.stringify(marker));
  assert.throws(()=>assertManagedProfileLaunch(f.profile,{}),/captured/);assert.throws(()=>assertManagedProfileLaunch(f.profile,{CAPRI_MANAGED_TRUST:f.trust.file,CAPRI_MANAGED_TRUST_SHA256:'0'.repeat(64),CAPRI_MANAGED_CHANNEL:'present'}));
  assert.doesNotThrow(()=>assertManagedProfileLaunch(f.profile,{CAPRI_MANAGED_TRUST:f.trust.file,CAPRI_MANAGED_TRUST_SHA256:f.trust.sha256,CAPRI_MANAGED_CHANNEL:'present'}));
  assert.equal(runtimeProfile(f.config.appData,{},'capri-companion-core').path,path.join(f.config.appData,'capri-companion-core'));
  assert.throws(()=>managedDirectory(path.join(f.config.appData,'capri-companion'),f.config.appData),/separate/);
  const alias=path.join(f.root,'alias');await fs.symlink(f.config.profilesRoot,alias,process.platform==='win32'?'junction':'dir');assert.throws(()=>managedDirectory(path.join(alias,f.generation),f.config.appData),/alias/);
 }finally{await f.close();}
});

test('captured channel ignores bounded ordinary logs, rejects foreign epochs, and never infers receipt success',async()=>{
 const a=new PassThrough(),b=new PassThrough(),token=randomBytes(32).toString('hex'),epoch=randomUUID();
 const client=new ManagedChannel(a,b,token,epoch),server=new ManagedChannel(b,a,token,epoch);server.handler=async(method)=>{if(method!=='status')throw Error('refused');return {state:'observed'};};
 try{a.write('ordinary diagnostic output\n');assert.deepEqual(await client.request('status',{},1000),{state:'observed'});await assert.rejects(client.request('maintenance-command',{},1000));
  a.write('CAPRI_MANAGED_RPC '+JSON.stringify({protocol:'capri-managed-v1',token,epoch:randomUUID(),id:9,type:'reply',ok:true,value:{accepted:true}})+'\n');await assert.rejects(client.request('status',{},1000),/closed/);
 }finally{client.close();server.close();a.destroy();b.destroy();}
});
