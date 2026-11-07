import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync, realpathSync} from 'node:fs';
import {mkdtemp, mkdir, rm, symlink, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runtimeProfile, compiledProfileIdentity, seedProfileSettings, loginItemPolicy,prepareDesktopStartup,acquireProfileWriter} from '../src/desktop/runtime-profile';
import {randomUUID} from 'node:crypto';
import {version} from '../src/version';
import {Store} from '../src/server/store';
import {createService} from '../src/server/service';
import {defaults} from '../src/shared';

test('Chromium paths and duplicate election precede a delayed writer gate and ready',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'capri-startup-order-'));
 const paths=new Map<string,string>(),events:string[]=[];let second:(()=>void)|undefined,focus=0,release!:()=>void;
 const app={setPath:(name:string,value:string)=>{events.push(name);paths.set(name,value);},requestSingleInstanceLock:()=>{events.push('elected');return true;},on:(_event:'second-instance',listener:()=>void)=>{second=listener;}};
 const gateDelay=new Promise<void>(resolve=>{release=resolve;});
 try{
  assert.equal(prepareDesktopStartup(app,root,true,()=>{focus++;}),true);
  // This is the entry module's synchronous prefix. The asynchronous trust/gate
  // chain is deliberately still pending when the simulated ready event fires.
  let vaultOpened=false;const startup=(async()=>{await gateDelay;events.push('writer');vaultOpened=true;})();
  await Promise.resolve().then(()=>{events.push('ready');assert.equal(paths.get('userData'),root);assert.equal(paths.get('sessionData'),root);assert.equal(vaultOpened,false);});
  second!();assert.equal(focus,1);release();await startup;
  assert.deepEqual(events,['userData','sessionData','elected','ready','writer']);
  const source=await readFile(path.resolve('src/desktop/main.ts'),'utf8');
  assert.ok(source.indexOf('const ownsDesktopInstance=prepareDesktopStartup(')<source.indexOf('async function main()'));
  assert.ok(source.indexOf('if(!ownsDesktopInstance)')<source.indexOf('writerGate=await acquireProfileWriter'));
  assert.equal(source.includes("app.setPath('userData'"),false);
 }finally{release?.();await rm(root,{recursive:true,force:true});}
});

test('ordinary second launch quietly focuses owner without attempting its writer gate; genuine gate failure remains an error',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'capri-second-launch-')),identity={installationId:randomUUID(),ownerSha256:'a'.repeat(64)};
 const gate=await acquireProfileWriter(identity);let focus=0,acquisitions=0;let existingSecond:(()=>void)|undefined;
 const app={setPath:()=>{},requestSingleInstanceLock:()=>true,on:(_event:'second-instance',listener:()=>void)=>{existingSecond=listener;}};
 try{
  prepareDesktopStartup(app,root,true,()=>{focus++;});
  const launch=async(elected:boolean)=>{
   const owned=prepareDesktopStartup({...app,requestSingleInstanceLock:()=>{if(!elected)existingSecond!();return elected;}},root,true,()=>{});
   if(!owned)return 'quiet-exit';acquisitions++;const secondGate=await acquireProfileWriter(identity);await secondGate.close();return 'writer';
  };
  assert.equal(await launch(false),'quiet-exit');assert.equal(focus,1);assert.equal(acquisitions,0);
  await assert.rejects(launch(true),{code:'EADDRINUSE'});assert.equal(acquisitions,1);assert.equal(gate.owned(),true);
 }finally{await gate.close();await rm(root,{recursive:true,force:true});}
});

test('compiled public identity isolates defaults and explicit aliases from the private namespace',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'capri-public-profile-'));
 try{
  const appData=path.join(root,'appdata');await mkdir(appData);
  const installed=path.join(appData,'capri-companion');await mkdir(installed);
  assert.equal(runtimeProfile(appData,{},'capri-companion').path,installed);
  assert.equal(runtimeProfile(appData,{},'capri-companion-core').path,path.join(realpathSync.native(appData),'capri-companion-core'));
  assert.equal(runtimeProfile(appData,{},compiledProfileIdentity({version,assets:'neutral'})).path,path.join(realpathSync.native(appData),'capri-companion-core'));
  assert.equal(compiledProfileIdentity({version,assets:'private'},'capri-companion-core'),'capri-companion-core');
  assert.throws(()=>compiledProfileIdentity(undefined),/identity/);assert.throws(()=>compiledProfileIdentity({version:'old',assets:'private'}),/identity/);
  for(const identity of ['capri-companion','capri-companion-core'] as const){
   assert.throws(()=>runtimeProfile(appData,{CAPRI_PROFILE_DIR:installed},identity),/separate/);
   assert.throws(()=>runtimeProfile(appData,{CAPRI_PROFILE_DIR:path.join(installed,'descendant')},identity),/separate/);
   assert.equal(runtimeProfile(appData,{CAPRI_PROFILE_DIR:path.join(root,'preview'),CAPRI_DEV_PORT:'18601'},identity).port,18601);
  }
  await symlink(installed,path.join(appData,'capri-companion-core'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>runtimeProfile(appData,{},'capri-companion-core'),/separate/);
  // Neither an environment identity hint nor neutral assets may select the private namespace.
  assert.equal(runtimeProfile(appData,{CAPRI_PUBLIC_BUILD:'1'},'capri-companion').path,installed);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('profile comparison resolves directory junctions and missing descendants using metadata only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'capri-profile-alias-'));
  try {
    const appData = path.join(root, 'appdata');
    const installed = path.join(appData, 'capri-companion');
    const alias = path.join(root, 'installed-alias');
    await mkdir(installed, {recursive:true});
    // Deliberately invalid contents: profile validation must not open these.
    await writeFile(path.join(installed, 'private.config'), 'not a vault');
    await writeFile(path.join(installed, 'capri.sqlite'), 'not a database');
    await symlink(installed, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => runtimeProfile(appData, {CAPRI_PROFILE_DIR:alias}), /separate/);
    assert.throws(() => runtimeProfile(appData, {CAPRI_PROFILE_DIR:path.join(alias, 'fresh', 'profile')}), /separate/);
    const appDataAlias = path.join(root, 'appdata-alias');
    await symlink(appData, appDataAlias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => runtimeProfile(appDataAlias, {CAPRI_PROFILE_DIR:installed}), /separate/);
    assert.equal(await readFile(path.join(installed, 'private.config'), 'utf8'), 'not a vault');
    assert.equal(await readFile(path.join(installed, 'capri.sqlite'), 'utf8'), 'not a database');
    assert.equal(existsSync(path.join(installed, 'fresh')), false);

    const separate = path.join(root, 'separate');
    const separateAlias = path.join(root, 'separate-alias');
    await mkdir(separate);
    await symlink(separate, separateAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const profile = runtimeProfile(appData, {CAPRI_PROFILE_DIR:path.join(separateAlias, 'new')});
    assert.equal(profile.path, path.join(realpathSync.native(separate), 'new'));
    assert.equal(profile.development, true);
    const broken = path.join(root, 'broken');
    await symlink(path.join(root, 'missing'), broken, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => runtimeProfile(appData, {CAPRI_PROFILE_DIR:broken}), /unresolved/);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('fresh development settings are quiet and writable; existing profile settings are never reseeded', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'capri-profile-seed-'));
  const directory = path.join(root, 'profile');
  const documents = path.join(root, 'documents');
  const key = randomBytes(32);
  let store = await new Store(path.join(directory, 'data'), key).init();
  try {
    const seeded = await seedProfileSettings(store, {path:directory, development:true}, documents);
    assert.deepEqual([seeded.startAtLogin, seeded.muted, seeded.wakeEnabled, seeded.voiceGreeting], [false, true, false, false]);
    assert.equal(seeded.speechEngine, defaults.speechEngine);
    assert.equal(seeded.localVoice, defaults.localVoice);
    assert.equal(seeded.voiceInstructions, defaults.voiceInstructions);
    assert.deepEqual(seeded.roots, [path.join(directory, 'Workspace')]);
    await writeFile(path.join(seeded.roots[0], 'writable.txt'), 'test');
    assert.equal(existsSync(documents), false);
    const changed = await store.put('settings', {...seeded, startAtLogin:true, muted:false, wakeEnabled:true, voiceGreeting:true,
      localVoice:5, roots:[path.join(documents, 'existing workspace')], customSetting:'retain unknown personal-data fields'});
    await store.close();
    store = await new Store(path.join(directory, 'data'), key).init();
    const before = await readFile(store.file);
    assert.deepEqual(await seedProfileSettings(store, {path:directory, development:true}, documents), changed);
    assert.deepEqual(await readFile(store.file), before);
    assert.equal(existsSync(documents), false);
  } finally { await store.close(); await rm(root, {recursive:true, force:true}); }
});

test('normal installed profiles retain default settings and Documents workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'capri-installed-fixture-'));
  const store = await new Store(path.join(root, 'profile', 'data'), randomBytes(32)).init();
  try {
    const settings = await seedProfileSettings(store, {path:path.join(root, 'profile'), development:false}, path.join(root, 'documents'));
    const {id, updatedAt, ...value} = settings;
    assert.deepEqual(value, {...defaults, providerMode:'local', roots:[path.join(root, 'documents', 'Capri Workspace')]});
    assert.equal(existsSync(value.roots[0]), true);
    assert.equal(existsSync(path.join(root, 'profile', 'Workspace')), false);
    const existing = await store.put('settings', {...settings, startAtLogin:false, muted:true, localVoice:4});
    await rm(value.roots[0], {recursive:true});
    assert.deepEqual(await seedProfileSettings(store, {path:path.join(root, 'profile'), development:false}, path.join(root, 'documents')), existing);
    assert.equal(existsSync(value.roots[0]), true);
  } finally { await store.close(); await rm(root, {recursive:true, force:true}); }
});

test('startup and settings side effects respect every profile/test mode before persistence', async t => {
  const base = {development:false, packaged:true, selfTest:false, uiSmoke:false};
  for (const [name, mode] of Object.entries({
    installed:base, unpackaged:{...base, packaged:false}, preview:{...base, development:true},
    selfTest:{...base, selfTest:true}, uiSmoke:{...base, uiSmoke:true},
    previewSelfTest:{...base, development:true, selfTest:true}
  })) {
    await t.test(name, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'capri-login-spy-'));
      const store = await new Store(path.join(root, 'data'), randomBytes(32)).init();
      const calls: boolean[] = [];
      const policy = loginItemPolicy(mode, value => calls.push(value));
      const isolated = mode.development || mode.selfTest || mode.uiSmoke;
      await seedProfileSettings(store, {path:root, development:isolated}, path.join(root, 'documents'));
      const service = await createService({store, adminToken:'fixture-admin', key:() => undefined,
        onSettings:settings => policy.apply(settings.startAtLogin)});
      policy.protectSettings(service.app, service.settings);
      const patch = (payload:object) => service.app.inject({method:'PATCH', url:'/v1/settings?fixture=1', headers:{authorization:'Bearer fixture-admin'}, payload});
      try {
        policy.apply((await service.settings()).startAtLogin); // desktop startup
        const before = await store.get('settings', 'main');
        const denied = await patch({startAtLogin:!before!.startAtLogin, muted:!before!.muted});
        if (isolated) {
          assert.equal(denied.statusCode, 403);
          assert.match(denied.json().error, /Windows startup cannot be changed.*installed Capri/);
          assert.deepEqual(await store.get('settings', 'main'), before);
          // Existing development profiles may already have this preference on.
          await store.put('settings', {...before, startAtLogin:true});
          policy.apply(true);
          const existing = await store.get('settings', 'main');
          assert.equal((await patch({startAtLogin:false})).statusCode, 403);
          assert.deepEqual(await store.get('settings', 'main'), existing);
        } else {
          assert.equal(denied.statusCode, 200);
          assert.equal((await service.settings()).startAtLogin, false);
        }
        const current = await service.settings();
        assert.equal((await patch({startAtLogin:current.startAtLogin, avatarScale:1.25})).statusCode, 200);
        assert.equal((await service.settings()).avatarScale, 1.25);
        assert.equal((await patch({startAtLogin:true})).statusCode, 200);
        assert.deepEqual(calls, mode.packaged && !isolated ? [true, false, false, true] : []);
        assert.equal((await service.app.inject({method:'PATCH', url:'/v1/settings', payload:{startAtLogin:false}})).statusCode, 401);
      } finally { await service.app.close(); await rm(root, {recursive:true, force:true}); }
    });
  }
});

test('desktop wiring uses the guarded policy for both login-item writes and all smoke aliases', async () => {
  const source = await readFile(path.resolve('src/desktop/main.ts'), 'utf8');
  assert.equal(source.match(/app\.setLoginItemSettings\(/g)?.length, 1);
  assert.match(source, /loginItemPolicy\(\{development:profileConfig\.development,packaged:app\.isPackaged,selfTest,uiSmoke\}/);
  assert.match(source, /loginItems\.protectSettings\(local\.app,local\.settings\)/);
  assert.match(source, /onSettings:s=>\{loginItems\.apply\(s\.startAtLogin\)/);
  assert.match(source, /loginItems\.apply\(settings\.startAtLogin\)/);
  assert.match(source, /const uiSmoke=process\.argv\.includes\('--ui-smoke'\)\|\|process\.argv\.includes\('--verify-ui'\)/);
  assert.match(source, /seedProfileSettings\(store,\{path:dir,development:profileConfig\.development\|\|selfTest\|\|uiSmoke\}/);
});
