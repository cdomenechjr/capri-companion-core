import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {agentEnvironment,packagedRuntimeResources,createNativeRuntimeAgentFactory,RuntimeAgents,createClaudeDriver,type RuntimeResourceManifest,type AgentDriverContext,type ClaudeSdkDriver} from '../src/extensions/agents';
import {AgentLeasePool} from '../src/extensions/agent-lease';
import {packagedUpdateLauncher} from '../src/extensions/updates';

const sha=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const scratch=()=>{fs.mkdirSync('dist',{recursive:true});return fs.mkdtempSync(path.resolve('dist/runtime-packaging-'));};

function neutralResources(root:string){
  const executable=process.platform==='win32'?'claude.exe':'claude';
  const names=['Capri.ProcessSupervisor.exe','claude/sdk/sdk.mjs','claude/sdk/package.json','claude/sdk/LICENSE.md','claude/sdk/README.md',
    'claude/platform/'+executable,'claude/platform/package.json','claude/platform/LICENSE.md','claude/platform/README.md'];
  const files:Record<string,string>={};
  for(const name of names){const file=path.join(root,...name.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'inert resource '+name);files[name]=sha(file);}
  const manifest:RuntimeResourceManifest={schemaVersion:1,platform:process.platform,arch:process.arch,claudeSdkVersion:'0.3.318',files,processSupervisorSha256:files[names[0]]};
  return packagedRuntimeResources(root,manifest);
}

test('routine resource and actual runtime status polls use verified identities without reading executable bytes',async t=>{
  const root=scratch(),runtime=neutralResources(path.join(root,'native'));
  let reads=0;
  const read=fs.readSync,readFile=fs.readFileSync;
  t.mock.method(fs,'readSync',(...args:Parameters<typeof fs.readSync>)=>{reads++;return (read as Function)(...args);});
  t.mock.method(fs,'readFileSync',(...args:Parameters<typeof fs.readFileSync>)=>{reads++;return (readFile as Function)(...args);});
  const factory=createNativeRuntimeAgentFactory({controlRoot:path.join(root,'control'),leases:new AgentLeasePool(path.join(root,'leases')),runtimeResources:runtime});
  const explicitHelper=createNativeRuntimeAgentFactory({controlRoot:path.join(root,'explicit-control'),leases:new AgentLeasePool(path.join(root,'explicit-leases')),
    helperPath:runtime.helperPath,helperSha256:runtime.helperSha256});
  const module=new RuntimeAgents({...factory,store:{get:async()=>undefined,list:async()=>[],put:async(_kind,value)=>value,remove:async()=>{}},clock:()=>1000,
    host:{run:async()=>{throw Error('No host calls');}},transport:{request:async()=>{throw Error('No transport calls');}},
    resolveAuthority:async()=>{throw Error('Status cannot acquire task authority');},
    providerStatus:async()=>['codex','claude-api'].map(provider=>({provider:provider as 'codex'|'claude-api',enabled:false,configured:false,ready:false}))});
  try{
    assert.ok(reads>0,'Host composition must first verify the pinned bytes');const initialReads=reads;
    for(let i=0;i<20;i++){
      assert.equal(runtime.available('claude-api'),true);assert.equal(runtime.available('supervisor'),true);
      assert.equal(factory.configuration('claude-api').available,process.platform==='win32');
      assert.equal(factory.drivers['claude-api'].ownedLifecycle!.available!(),process.platform==='win32');
      assert.equal(explicitHelper.configuration('codex').available,process.platform==='win32');
      const status=await module.status(new AbortController().signal);assert.equal(status.capability.available,false);
    }
    assert.equal(reads,initialReads,'Polling must never hash or read resource bytes, including the native helper');
    fs.unlinkSync(runtime.helperPath);
    assert.equal(factory.configuration('codex').available,false);assert.equal(factory.configuration('claude-api').available,false);
    assert.equal(explicitHelper.configuration('codex').available,false);
    assert.equal(factory.drivers.codex.ownedLifecycle!.available!(),false);
    assert.equal(reads,initialReads);
  }finally{await module.close();t.mock.restoreAll();fs.rmSync(root,{recursive:true,force:true});}
});

test('resource identity changes invalidate availability and only full pinned-byte verification can restore it',()=>{
  const root=scratch(),runtime=neutralResources(path.join(root,'native'));
  try{
    assert.equal(runtime.available('claude-api'),false,'Inventory alone cannot authorize availability');
    runtime.verify('claude-api');assert.equal(runtime.available('claude-api'),true);
    const original=fs.readFileSync(runtime.sdkPath),info=fs.statSync(runtime.sdkPath);
    fs.writeFileSync(runtime.sdkPath,Buffer.alloc(original.length,120));fs.utimesSync(runtime.sdkPath,info.atime,info.mtime);
    assert.equal(runtime.available('claude-api'),false,'Same-size/timestamp edits still change ctime');
    assert.throws(()=>runtime.verify('claude-api'),/changed/);
    fs.writeFileSync(runtime.sdkPath,original);assert.equal(runtime.available('claude-api'),false);
    runtime.verify('claude-api');assert.equal(runtime.available('claude-api'),true);
    fs.renameSync(runtime.claudeExecutable,runtime.claudeExecutable+'.held');
    assert.equal(runtime.available('claude-api'),false);assert.throws(()=>runtime.verify('claude-api'));
    fs.copyFileSync(runtime.claudeExecutable+'.held',runtime.claudeExecutable);
    assert.equal(runtime.available('claude-api'),false,'Replacement bytes need fresh verification');
    runtime.verify('claude-api');assert.equal(runtime.available('claude-api'),true);
    const peer=runtime.claudeExecutable+'.peer';fs.linkSync(runtime.claudeExecutable,peer);
    assert.equal(runtime.available('claude-api'),false);assert.throws(()=>runtime.verify('claude-api'));
    fs.unlinkSync(peer);runtime.verify('claude-api');
    // The same files behind a junction remain unavailable even if file identity matches.
    const sdkDirectory=path.dirname(runtime.sdkPath),held=sdkDirectory+'-held';fs.renameSync(sdkDirectory,held);fs.symlinkSync(held,sdkDirectory,'junction');
    assert.equal(runtime.available('claude-api'),false);assert.throws(()=>runtime.verify('claude-api'),/aliased/);
    fs.unlinkSync(sdkDirectory);fs.renameSync(held,sdkDirectory);runtime.verify('claude-api');
    // Replacing a real ancestor also invalidates unchanged files moved into it.
    fs.renameSync(sdkDirectory,held);fs.mkdirSync(sdkDirectory);
    for(const name of fs.readdirSync(held))fs.renameSync(path.join(held,name),path.join(sdkDirectory,name));
    assert.equal(runtime.available('claude-api'),false);runtime.verify('claude-api');assert.equal(runtime.available('claude-api'),true);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('fresh native claims and the SDK spawn callback rehash pinned bytes after cached availability',async t=>{
  const root=scratch(),runtime=neutralResources(path.join(root,'native')),workspace=path.join(root,'project'),configDir=path.join(root,'config');
  fs.mkdirSync(workspace);fs.mkdirSync(configDir);
  const signal=new AbortController().signal;
  const context:AgentDriverContext={configuration:{provider:'claude-api',apiKey:'neutral-test-only',model:'neutral',budgetUsd:1,configDir,isolated:true},
    workspace:{id:'workspace',root:workspace,writable:false,excludedRoots:[path.join(root,'excluded')]},prompt:'Never infer',signal,
    beforeDispatch:async()=>{},approve:async()=>false,event:()=>{}};
  let reads=0,spawns=0;
  const read=fs.readSync;t.mock.method(fs,'readSync',(...args:Parameters<typeof fs.readSync>)=>{reads++;return (read as Function)(...args);});
  const factory=createNativeRuntimeAgentFactory({controlRoot:path.join(root,'control'),leases:new AgentLeasePool(path.join(root,'leases')),runtimeResources:runtime,
    creatorState:async()=>({state:'alive',created:'123456789'})});
  try{
    if(process.platform==='win32'){
      for(let i=0;i<2;i++){
        const before=reads;await factory.drivers['claude-api'].ownedLifecycle!.claim!({provider:'claude-api',jobId:'neutral-claim',workspace:context.workspace,signal});
        assert.ok(reads>before,'Each claim must hash actual helper and SDK bytes, regardless of cached status');
      }
      fs.appendFileSync(runtime.helperPath,'tampered');
      await assert.rejects(factory.drivers['claude-api'].ownedLifecycle!.claim!({provider:'claude-api',jobId:'neutral-claim',workspace:context.workspace,signal}),/supervision/);
    }else t.diagnostic('Windows claim path is unavailable on this platform; SDK callback checks run independently.');
    // Entire SDK is fake. A tamper after the pre-dispatch verify must be caught
    // by the real spawn callback, before even the injected subprocess seam.
    const sdk:ClaudeSdkDriver={query:({options})=>{
      const before=reads;fs.appendFileSync(runtime.claudeExecutable,'tampered');
      assert.throws(()=>options.spawnClaudeCodeProcess!({command:runtime.claudeExecutable,args:[],env:{},signal}),/changed/);
      assert.ok(reads>before,'Spawn must hash bytes again rather than consult availability');
      throw Error('Neutral SDK stopped without inference');
    }};
    await assert.rejects(createClaudeDriver(async()=>sdk,()=>{spawns++;throw Error('Must not launch');},async()=>{},runtime).run(context),/Neutral SDK stopped/);
    assert.equal(spawns,0);assert.equal(runtime.available('claude-api'),false);
  }finally{t.mock.restoreAll();fs.rmSync(root,{recursive:true,force:true});}
});

test('production output guard normalizes OS temp/case spellings and validates before creating native output', {timeout:60000},t=>{
  // Import the actual build module from a copied checkout at the OS temp spelling.
  // On Windows this can contain an 8.3 username; no personal path is hardcoded.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'capri-output-paths-')),physicalRoot=fs.realpathSync.native(root);
  try{
    fs.mkdirSync(path.join(root,'scripts'));
    for(const name of ['build.mjs','neutral-assets.mjs'])fs.copyFileSync(path.join('scripts',name),path.join(root,'scripts',name));
    fs.symlinkSync(path.resolve('node_modules'),path.join(root,'node_modules'),'junction');
    const script=pathToFileURL(path.join(root,'scripts/build.mjs')).href;
    const run=(directory:string,cwd=root)=>spawnSync(process.execPath,['-e',
      'import(process.argv[1]).then(async b=>console.log(await b.prepareRuntimeOutput(process.argv[2])))',script,directory],
      {cwd,env:process.env,encoding:'utf8',timeout:15000,windowsHide:true});
    const output=path.join(root,'native','publish'),physicalOutput=path.join(physicalRoot,'native','publish');
    const fresh=run(output);assert.equal(fresh.status,0,fresh.stderr);assert.equal(fresh.stdout.trim(),physicalOutput);
    fs.writeFileSync(path.join(output,'keep.txt'),'retained');
    const existing=run(output);assert.equal(existing.status,0,existing.stderr);assert.equal(existing.stdout.trim(),physicalOutput);
    const missing=run(path.join(root,'new-parent','nested','publish'));
    assert.equal(missing.status,0,missing.stderr);assert.equal(missing.stdout.trim(),path.join(physicalRoot,'new-parent','nested','publish'));
    if(process.platform==='win32'){
      const upper=run(output.toUpperCase(),root.toUpperCase());
      assert.equal(upper.status,0,upper.stderr);assert.equal(upper.stdout.trim(),physicalOutput);
      t.diagnostic(root===physicalRoot?'OS temp uses long spelling; case normalization exercised.':'OS short temp spelling normalized to physical output.');
    }
    const foreign=path.join(root,'foreign');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'sentinel.txt'),'untouched');
    const refuse=(directory:string,pattern:RegExp,cwd=root)=>{const result=run(directory,cwd);assert.notEqual(result.status,0);assert.match(result.stderr,pattern);};
    // Reject the native-parent junction BEFORE mkdir can create foreign/publish.
    fs.rmSync(path.join(root,'native'),{recursive:true});fs.symlinkSync(foreign,path.join(root,'native'),'junction');
    refuse(output,/linked or non-directory ancestor/);assert.equal(fs.existsSync(path.join(foreign,'publish')),false);
    fs.unlinkSync(path.join(root,'native'));fs.mkdirSync(path.join(root,'native'));
    // Exact output links and links nested inside an otherwise valid output also refuse.
    fs.symlinkSync(foreign,output,'junction');refuse(output,/linked or non-directory ancestor/);fs.unlinkSync(output);
    fs.mkdirSync(output);fs.writeFileSync(path.join(output,'keep.txt'),'retained');
    fs.symlinkSync(foreign,path.join(output,'nested'),'junction');refuse(output,/refuses to clean linked or aliased output/);
    assert.equal(fs.readFileSync(path.join(output,'keep.txt'),'utf8'),'retained');fs.unlinkSync(path.join(output,'nested'));
    fs.writeFileSync(path.join(root,'file-parent'),'file');refuse(path.join(root,'file-parent','publish'),/non-directory ancestor/);
    refuse(output,/must run from the checkout/,foreign);
    refuse(path.dirname(physicalRoot),/must be a real directory in this checkout/);
    refuse(physicalRoot,/must be a real directory in this checkout/);
    refuse('relative-output',/absolute directory/);assert.equal(fs.existsSync(path.join(root,'relative-output')),false);
    assert.equal(fs.readFileSync(path.join(foreign,'sentinel.txt'),'utf8'),'untouched');
    assert.deepEqual(fs.readdirSync(foreign),['sentinel.txt']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('approved SDK entry, platform and lock are pinned without dependency edits',()=>{
  const pkg=JSON.parse(fs.readFileSync('package.json','utf8')),lock=fs.readFileSync('pnpm-lock.yaml','utf8');
  assert.equal(pkg.dependencies['@anthropic-ai/claude-agent-sdk'],'0.3.318');
  assert.match(lock,/'@anthropic-ai\/claude-agent-sdk':\s+specifier: 0\.3\.318\s+version: 0\.3\.318/);
  const entry=createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  const installed=JSON.parse(fs.readFileSync(path.join(path.dirname(entry),'package.json'),'utf8'));
  assert.equal(installed.version,'0.3.318');assert.equal(installed.exports['.'].default,'./sdk.mjs');
  const platform=`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  assert.equal(installed.optionalDependencies[platform],'0.3.318');
  const nativePkg=JSON.parse(fs.readFileSync(createRequire(entry).resolve(platform+'/package.json'),'utf8'));
  assert.equal(nativePkg.name,platform);assert.equal(nativePkg.version,'0.3.318');
  if(pkg.name==='capri-companion-core'){
    assert.equal(pkg.private,false);assert.equal(pkg.license,'MIT');
    assert.deepEqual(pkg.build,{
      appId:'org.capri.companion.core',productName:'Capri Companion Core',directories:{output:'release'},
      files:['dist/**/*','package.json'],asarUnpack:['node_modules/sql.js/dist/*.wasm'],
      win:{target:'nsis',signExecutable:false},nsis:{oneClick:false,allowToChangeInstallationDirectory:true},
    });
  }else{
    assert.equal(pkg.name,'capri-companion');
    assert.equal(pkg.build.directories.output,`release-${pkg.version}-candidate`);
    assert.ok(pkg.build.extraResources.some((entry:{from:string;to:string;filter:string[]})=>entry.from==='native/publish'&&entry.to==='native'&&entry.filter.includes('**/*')));
  }
});

test('real resource packaging relocates ESM/native SDK and compiled updater outside ASAR', {timeout:120000},async()=>{
  const root=scratch(),staging=path.join(root,'staging'),resourcesPath=path.join(root,'copied app','resources'),native=path.join(resourcesPath,'native');
  fs.mkdirSync(staging);
  try{
    // Compile the actual accepted entrypoint with the production build options.
    // Tests also work before the first desktop build; never substitute a stub launcher.
    await build({entryPoints:['scripts/update-launcher.mjs'],bundle:true,platform:'node',format:'cjs',target:'node22',outfile:path.join(staging,'update-launcher.cjs')});
    const buildScript=await import(pathToFileURL(path.resolve('scripts/build.mjs')).href);
    const manifest:RuntimeResourceManifest=await buildScript.packageRuntimeResources(staging);
    fs.mkdirSync(resourcesPath,{recursive:true});fs.renameSync(staging,native);
    const runtime=packagedRuntimeResources(native,manifest);
    assert.equal(runtime.updateLauncher,packagedUpdateLauncher(resourcesPath));
    assert.equal(manifest.files['update-launcher.cjs'],sha(runtime.updateLauncher));
    runtime.verify('updater');runtime.verify('claude-api');
    const sdk=await runtime.loadClaude();assert.equal(typeof sdk.query,'function'); // NEVER query.
    for(const prefix of ['claude/sdk','claude/platform'])for(const notice of ['README.md','LICENSE.md','package.json']){
      assert.equal(manifest.files[prefix+'/'+notice],sha(path.join(native,prefix,notice)));
    }
    const config=path.join(root,'fresh-config');fs.mkdirSync(config);
    const env={...agentEnvironment(config),PATH:'',CLAUDE_CONFIG_DIR:config,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
    // Native dynamic import from CommonJS with no npm resolution, dev cwd or PATH.
    const imported=spawnSync(process.execPath,['-e','import(process.argv[1]).then(s=>{if(typeof s.query!=="function")process.exitCode=2;else console.log("sdk-import-ok")})',pathToFileURL(runtime.sdkPath).href],
      {cwd:config,env,encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(imported.status,0,imported.stderr);assert.equal(imported.stdout.trim(),'sdk-import-ok');
    // Use the same CJS target and compiled trust injection as the desktop build.
    // The copied JSON is deliberately corrupted: only the compiled pins can authorize loading.
    const cjs=path.join(root,'resource-constructor.cjs');
    await build({entryPoints:['src/extensions/agents.ts'],bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',outfile:cjs,
      define:{__CAPRI_RUNTIME_RESOURCES__:JSON.stringify(manifest)}});
    fs.writeFileSync(path.join(native,'runtime-resources.json'),'{"untrusted":true}');
    const constructor=spawnSync(process.execPath,['-e','const r=require(process.argv[1]).packagedRuntimeResources(process.argv[2]);r.loadClaude().then(s=>{if(typeof s.query!=="function")process.exitCode=2;else console.log("cjs-resource-ok")})',cjs,native],
      {cwd:config,env,encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(constructor.status,0,constructor.stderr);assert.equal(constructor.stdout.trim(),'cjs-resource-ok');
    // Official native artifact only: --version, isolated HOME/config, no auth or inference.
    const version=spawnSync(runtime.claudeExecutable,['--version'],{cwd:config,env,encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(version.status,0,version.stderr);assert.match(version.stdout,/2\.1\.318/);
    const updater=spawnSync(process.execPath,[runtime.updateLauncher],{cwd:config,env,encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(updater.status,1,updater.stderr);assert.match(updater.stderr,/Managed update verification refused/);
    if(manifest.processSupervisorSha256){runtime.verify('supervisor');assert.equal(runtime.helperSha256,sha(runtime.helperPath));}
    else assert.throws(()=>runtime.verify('supervisor'),/pin is absent/);
    // Removing a runtime dependency makes the exact copied location unavailable.
    for(const [kind,file] of [['claude-api',runtime.sdkPath],['claude-api',runtime.claudeExecutable],['updater',runtime.updateLauncher]] as const){
      fs.renameSync(file,file+'.held');
      try{assert.throws(()=>runtime.verify(kind));}finally{fs.renameSync(file+'.held',file);}
    }
    const bytes=fs.readFileSync(runtime.sdkPath);fs.appendFileSync(runtime.sdkPath,'\n// changed');
    try{assert.throws(()=>runtime.verify('claude-api'),/changed/);}finally{fs.writeFileSync(runtime.sdkPath,bytes);}
    const wrong={...manifest,processSupervisorSha256:'0'.repeat(64)};
    assert.throws(()=>packagedRuntimeResources(native,wrong).verify('supervisor'));
    assert.throws(()=>packagedRuntimeResources(native,{...manifest,files:{'../escape':'0'.repeat(64)}}),/resource path/);
    // Resource inventory grants neither API configuration nor ready native lifecycle.
    const factory=createNativeRuntimeAgentFactory({controlRoot:path.join(root,'control'),leases:new AgentLeasePool(path.join(root,'leases')),runtimeResources:runtime});
    if(manifest.processSupervisorSha256)assert.equal(factory.configuration('claude-api').available,process.platform==='win32');
    assert.equal(fs.existsSync(path.join(root,'leases')),false);assert.equal(fs.existsSync(path.join(root,'control')),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('runtime resource manifests cannot create readiness with missing or substituted files',()=>{
  const root=scratch();
  try{
    const manifest:RuntimeResourceManifest={schemaVersion:1,platform:process.platform,arch:process.arch,claudeSdkVersion:'0.3.318',files:{}};
    const runtime=packagedRuntimeResources(root,manifest);
    assert.throws(()=>runtime.verify('claude-api'),/pin is absent/);assert.throws(()=>runtime.verify('updater'),/pin is absent/);
    const factory=createNativeRuntimeAgentFactory({controlRoot:path.join(root,'control'),leases:new AgentLeasePool(path.join(root,'leases')),runtimeResources:runtime});
    assert.equal(factory.configuration('claude-api').available,false);assert.equal(factory.drivers['claude-api'].ownedLifecycle!.available!(),false);
    assert.throws(()=>packagedRuntimeResources(root,{...manifest,claudeSdkVersion:'0.3.317'}));
    assert.throws(()=>packagedRuntimeResources(root,{...manifest,platform:'wrong'}).verify('updater'),/platform differs/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
