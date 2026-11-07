import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {prepareSupervisedLaunch,armSupervisedRun,inspectSupervisedRun,cancelSupervisedRun,supervisorMessageInvocation} from '../src/extensions/supervisor.ts';

const developmentRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const supervisor=process.env.CAPRI_PROCESS_SUPERVISOR || path.join(developmentRoot,'runtime/tools/process-supervisor/Capri.ProcessSupervisor.exe');
const windows={skip:process.platform!=='win32',timeout:15000};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
async function until(check,label,ms=6000){const deadline=Date.now()+ms;while(!check()){if(Date.now()>=deadline)throw Error('Timed out: '+label);await sleep(20);}}
async function bounded(promise,label,ms=6000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),ms);})]);}finally{clearTimeout(timer);}}

function observe(command,args,options){
 const child=spawn(command,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],...options});let stdout='',stderr='';
 child.stdout?.on('data',chunk=>stdout+=chunk.toString());child.stderr?.on('data',chunk=>stderr+=chunk.toString());child.stdin?.on('error',()=>{});
 const closed=new Promise(resolve=>{child.once('error',error=>resolve({error,code:null,signal:null}));child.once('close',(code,signal)=>resolve({code,signal}));});
 return {child,closed,get stdout(){return stdout;},get stderr(){return stderr;}};
}

function fixture(t){
 assert.ok(path.isAbsolute(supervisor),'Supervisor must be an absolute binary path');assert.ok(fs.statSync(supervisor).isFile(),'Publish the supervisor before running its fixtures');
 const directory=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'capri-supervisor-'))),lifetime=path.join(directory,'lifetime');fs.writeFileSync(lifetime,'owned fixture');
 const children=[];
 const env={...process.env,CAPRI_SUPERVISOR_FIXTURE:'neutral fixture Ω'};delete env.NODE_OPTIONS;
 const write=(name,source)=>{const file=path.join(directory,name);fs.writeFileSync(file,source);return file;};
 const start=(args,extra={})=>{const result=observe(supervisor,['--',process.execPath,...args],{cwd:directory,env,...extra});children.push(result);return result;};
 t.after(async()=>{
  // Fixture descendants also self-expire if a failing supervisor leaves them
  // behind. Never look up or kill any PID from a file, and never use taskkill.
  fs.rmSync(lifetime,{force:true});
  for(const owned of children)if(owned.child.exitCode===null&&!owned.child.killed)owned.child.kill('SIGKILL');
  await Promise.all(children.map(child=>bounded(child.closed,'fixture wrapper cleanup',3000).catch(()=>{})));
  await sleep(120);
  const absolute=path.resolve(directory);assert.ok(path.basename(absolute).startsWith('capri-supervisor-'));assert.equal(path.dirname(absolute),fs.realpathSync.native(os.tmpdir()));fs.rmSync(absolute,{recursive:true,force:true});
 });
 return {directory,lifetime,env,write,start,children};
}

function treeScripts(f){
 const grandchild=f.write('grandchild.cjs',`const fs=require('node:fs');
const [lifetime,ready]=process.argv.slice(2);
fs.writeFileSync(ready+'.tmp',JSON.stringify({pid:process.pid}));fs.renameSync(ready+'.tmp',ready);
process.stdout.write('owned grandchild stream\\n');
setInterval(()=>{if(!fs.existsSync(lifetime))process.exit(0);},30);
`);
 const main=f.write('main.cjs',`const fs=require('node:fs');const {spawn}=require('node:child_process');
const [mode,script,lifetime,grandchildReady,mainReady]=process.argv.slice(2);
spawn(process.execPath,[script,lifetime,grandchildReady],{stdio:['ignore','inherit','inherit'],windowsHide:true});
function ready(){
 if(!fs.existsSync(lifetime))process.exit(0);
 if(!fs.existsSync(grandchildReady)){setTimeout(ready,10);return;}
 const grandchild=JSON.parse(fs.readFileSync(grandchildReady,'utf8')).pid;
 fs.writeFileSync(mainReady+'.tmp',JSON.stringify({main:process.pid,grandchild}));fs.renameSync(mainReady+'.tmp',mainReady);
 if(mode==='exit')process.exit(17);
 if(mode==='crash')throw Error('neutral owned fixture crash');
 setInterval(()=>{if(!fs.existsSync(lifetime))process.exit(0);},30);
}
ready();
`);
 return {main,grandchild,mainReady:path.join(f.directory,'main-ready.json'),grandchildReady:path.join(f.directory,'grandchild-ready.json')};
}

async function sibling(f){
 const ready=path.join(f.directory,'sibling-ready');
 const script=f.write('sibling.cjs',`const fs=require('node:fs');const [lifetime,ready]=process.argv.slice(2);fs.writeFileSync(ready,'ready');setInterval(()=>{if(!fs.existsSync(lifetime))process.exit(0);},30);`);
 const child=observe(process.execPath,[script,f.lifetime,ready],{cwd:f.directory,env:f.env});child.child.stdin.end();f.children.push(child);await until(()=>fs.existsSync(ready),'independent sibling ready');return child;
}

test('supervisor preserves exact argv, cwd, provided env, stdin/stdout/stderr, and the main exit code',windows,async t=>{
 const f=fixture(t);
 const script=f.write('echo fixture Ω.cjs',`const fs=require('node:fs');const input=fs.readFileSync(0,'utf8');process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),marker:process.env.CAPRI_SUPERVISOR_FIXTURE,input})+'\\n');process.stderr.write('fixture stderr Ω\\n');process.exitCode=37;`);
 const args=['','plain','two words','a"b','ends-with\\','space ends with\\','\\\\\\"quoted"','Ω 日本語 🙂','--','%PATH% & | ; $HOME','tab\tand\nnewline'];
 const input='fixture stdin\nsecond line Ω\n';const child=f.start([script,...args]);child.child.stdin.end(input);
 const result=await bounded(child.closed,'echo completion');assert.equal(result.error,undefined);assert.equal(result.code,37,child.stderr);assert.equal(result.signal,null);
 assert.deepEqual(JSON.parse(child.stdout),{args,cwd:f.directory,marker:f.env.CAPRI_SUPERVISOR_FIXTURE,input});assert.equal(child.stderr,'fixture stderr Ω\n');
});

for(const mode of ['exit','crash'])test('supervisor cleans descendants holding inherited stdout after main '+mode,windows,async t=>{
 const f=fixture(t),tree=treeScripts(f),outside=await sibling(f);
 const child=f.start([tree.main,mode,tree.grandchild,f.lifetime,tree.grandchildReady,tree.mainReady]);child.child.stdin.end();
 const result=await bounded(child.closed,'job completion despite held descendant pipes');assert.equal(result.error,undefined);assert.equal(result.code,mode==='exit'?17:1,child.stderr);
 assert.ok(fs.existsSync(tree.mainReady));const ids=JSON.parse(fs.readFileSync(tree.mainReady,'utf8'));
 await until(()=>!alive(ids.main)&&!alive(ids.grandchild),'both owned processes gone');
 assert.equal(outside.child.exitCode,null,'job must not include an independent sibling');assert.equal(alive(outside.child.pid),true);
 if(mode==='exit')assert.equal(child.stderr,'');else assert.match(child.stderr,/neutral owned fixture crash/);
});

test('force-killing supervisor OS-closes its job and kills live main and grandchild while leaving a sibling alone',windows,async t=>{
 const f=fixture(t),tree=treeScripts(f),outside=await sibling(f);
 const child=f.start([tree.main,'hold',tree.grandchild,f.lifetime,tree.grandchildReady,tree.mainReady]);child.child.stdin.end();
 await until(()=>fs.existsSync(tree.mainReady),'main and grandchild ready');const ids=JSON.parse(fs.readFileSync(tree.mainReady,'utf8'));
 assert.equal(alive(ids.main),true);assert.equal(alive(ids.grandchild),true);
 // ChildProcess owns the actual wrapper handle; production and tests never
 // reopen a PID to terminate an exited or potentially reused process identity.
 assert.equal(child.child.kill('SIGKILL'),true);
 await bounded(child.closed,'forced wrapper close');await until(()=>!alive(ids.main)&&!alive(ids.grandchild),'job killed after owner close');
 assert.equal(outside.child.exitCode,null);assert.equal(alive(outside.child.pid),true);assert.equal(child.stderr,'');
});

test('invalid invocation and non-executables fail before dispatch without echoing argv or environment',windows,async t=>{
 const f=fixture(t),sentinel='never-print-this-fixture-argument';
 const invalid=f.write('invalid.exe','This is not a PE executable');
 for(const args of [[],['--','node.exe',sentinel],['--',path.join(f.directory,'missing.exe'),sentinel],['--',invalid,sentinel]]){
  const child=observe(supervisor,args,{cwd:f.directory,env:f.env});f.children.push(child);child.child.stdin.end();const result=await bounded(child.closed,'rejected invocation');
  assert.equal(result.code,125);assert.equal(child.stdout,'');assert.match(child.stderr,/^ProcessSupervisor: [^\r\n]+\.\r?\n$/);assert.equal(child.stderr.includes(sentinel),false);assert.equal(child.stderr.includes(f.env.CAPRI_SUPERVISOR_FIXTURE),false);assert.equal(child.stderr.includes(f.directory),false);
 }
});

for(const mode of ['exit','crash'])test('supervisor cancels its owned job when the actual creating Node parent '+(mode==='exit'?'exits':'crashes'),windows,async t=>{
 const f=fixture(t),tree=treeScripts(f),outside=await sibling(f),ready=path.join(f.directory,'owner-ready.json');
 const creator=f.write('creator.cjs',`const fs=require('node:fs');const {spawn}=require('node:child_process');
const [supervisor,main,grandchild,lifetime,grandchildReady,mainReady,ready,mode]=process.argv.slice(2);
// Detach to exercise the supervisor monitor independently of Node's child cleanup.
const wrapper=spawn(supervisor,['--',process.execPath,main,'hold',grandchild,lifetime,grandchildReady,mainReady],{stdio:['ignore','inherit','inherit'],windowsHide:true,detached:true});
wrapper.on('error',()=>process.exit(40));
function poll(){
 if(!fs.existsSync(lifetime))process.exit(0);
 if(!fs.existsSync(mainReady)){setTimeout(poll,10);return;}
 const ids=JSON.parse(fs.readFileSync(mainReady,'utf8'));
 fs.writeFileSync(ready+'.tmp',JSON.stringify({owner:process.pid,supervisor:wrapper.pid,...ids}));fs.renameSync(ready+'.tmp',ready);
 if(mode==='crash')throw Error('neutral creating process crash');
 process.exit(27);
}
poll();
`);
 const creatorChild=observe(process.execPath,[creator,supervisor,tree.main,tree.grandchild,f.lifetime,tree.grandchildReady,tree.mainReady,ready,mode],{cwd:f.directory,env:f.env});f.children.push(creatorChild);creatorChild.child.stdin.end();
 const result=await bounded(creatorChild.closed,'creator and supervised job close');assert.equal(result.code,mode==='exit'?27:1,creatorChild.stderr);
 assert.ok(fs.existsSync(ready),'creator must exit only after its main and grandchild are running');const ids=JSON.parse(fs.readFileSync(ready,'utf8'));
 assert.equal(ids.owner,creatorChild.child.pid);assert.ok(ids.supervisor>0&&ids.main>0&&ids.grandchild>0);
 await until(()=>!alive(ids.owner)&&!alive(ids.supervisor)&&!alive(ids.main)&&!alive(ids.grandchild),'all processes owned by lost creator gone');
 assert.match(creatorChild.stderr,/ProcessSupervisor: creating process exited; owned processes terminated\./);
 assert.equal(outside.child.exitCode,null,'unrelated sibling must survive creator loss');assert.equal(alive(outside.child.pid),true);assert.equal(alive(process.pid),true,'outside test observer must survive');
});

function controlledFixture(t){
 const f=fixture(t),cwd=path.join(f.directory,'workspace'),controlRoot=path.join(f.directory,'control');fs.mkdirSync(cwd);fs.mkdirSync(controlRoot);
 const helperSha256=crypto.createHash('sha256').update(fs.readFileSync(supervisor)).digest('hex'),scopeSha256=crypto.createHash('sha256').update('neutral lease/session fixture').digest('hex');
 const prepare=(args,extra={})=>prepareSupervisedLaunch({helperPath:supervisor,helperSha256,controlRoot,cwd,executable:process.execPath,args,scopeSha256,...extra});
 const spawnLaunch=launch=>{assert.equal(Object.isFrozen(launch.spawnOptions),true);assert.deepEqual(launch.spawnOptions,{detached:true,windowsHide:true});const child=observe(launch.executable,launch.args,{...launch.spawnOptions,cwd,env:f.env});f.children.push(child);return child;};
 const start=async(args,options={})=>{const launch=prepare(args),child=spawnLaunch(launch);child.child.stdin.end();let saved;const identity=await armSupervisedRun(launch.control,child.child,{onArmed:async identity=>{saved=structuredClone(identity);fs.writeFileSync(path.join(f.directory,'identity-'+identity.token+'.json'),JSON.stringify(identity));await options.onArmed?.(identity);}});assert.deepEqual(saved,identity);return {launch,child,identity};};
 return {...f,cwd,controlRoot,helperSha256,scopeSha256,prepare,spawnLaunch,start};
}

test('controlled launch arms before dispatch and durable exact binding verifies an immutable terminal receipt',windows,async t=>{
 const f=controlledFixture(t),outside=await sibling(f),marker=path.join(f.directory,'dispatched'),script=f.write('controlled-echo.cjs',"require('node:fs').writeFileSync(process.argv[2],'dispatched');process.stdout.write(JSON.stringify(process.argv.slice(3)));process.exit(37);");
 const args=['two words','a"b','ends\\','Ω 日本語'],launch=f.prepare([script,marker,...args]),child=f.spawnLaunch(launch);child.child.stdin.end();
 await until(()=>fs.existsSync(path.join(launch.control.directory,'armed.json')),'guardian prepared before child dispatch');assert.equal(fs.existsSync(marker),false);
 let saved;const identity=await armSupervisedRun(launch.control,child.child,{onArmed:value=>{assert.equal(fs.existsSync(marker),false);saved=structuredClone(value);}});assert.deepEqual(identity,saved);
 assert.equal((await bounded(child.closed,'controlled echo')).code,37,child.stderr);assert.deepEqual(JSON.parse(child.stdout),args);assert.equal(child.stderr,'');assert.equal(fs.existsSync(marker),true);
 const proof=inspectSupervisedRun(identity);assert.equal(proof.state,'stopped');assert.equal(proof.proof.activeProcesses,0);assert.equal(proof.proof.reason,'main-exited');assert.equal(proof.proof.mainExitCode,37);
 const terminal=path.join(identity.directory,'terminal.json'),before=fs.readFileSync(terminal);assert.deepEqual(inspectSupervisedRun(JSON.parse(JSON.stringify(identity))),proof);assert.deepEqual(await cancelSupervisedRun(identity),proof);assert.deepEqual(fs.readFileSync(terminal),before);
 const duplicate=f.spawnLaunch(launch);duplicate.child.stdin.end();assert.equal((await bounded(duplicate.closed,'duplicate control rejection')).code,125);assert.deepEqual(fs.readFileSync(terminal),before);assert.equal(alive(outside.child.pid),true);
});

test('exact-token sidechannel cancellation drains only its owned Job and duplicate cancellation is idempotent',windows,async t=>{
 const f=controlledFixture(t),tree=treeScripts(f),outside=await sibling(f),run=await f.start([tree.main,'hold',tree.grandchild,f.lifetime,tree.grandchildReady,tree.mainReady]);
 await until(()=>fs.existsSync(tree.mainReady),'controlled tree ready');const ids=JSON.parse(fs.readFileSync(tree.mainReady));
 assert.deepEqual(inspectSupervisedRun(run.identity),{state:'recovery-required',reason:'proof-missing'});
 assert.equal((await cancelSupervisedRun({...run.identity,token:'f'.repeat(64)},{timeoutMs:100})).state,'recovery-required');assert.equal(alive(ids.main),true);
 const outcomes=await Promise.all([cancelSupervisedRun(run.identity),cancelSupervisedRun(run.identity)]);assert.ok(outcomes.every(result=>result.state==='stopped'&&result.proof.reason==='cancelled'));
 assert.equal((await bounded(run.child.closed,'controlled cancellation')).code,125,run.child.stderr);await until(()=>!alive(ids.main)&&!alive(ids.grandchild),'exact cancelled Job gone');assert.equal(alive(outside.child.pid),true);assert.equal(alive(process.pid),true);
});

for(const mode of ['exit','crash'])test('creator '+mode+' leaves signed zero-process proof bound to its pre-ACK durable identity',windows,async t=>{
 const f=controlledFixture(t),tree=treeScripts(f),outside=await sibling(f),ready=path.join(f.directory,'controlled-owner-ready.json'),identityFile=path.join(f.directory,'durable-owner-identity.json'),adapter=new URL('../src/extensions/supervisor.ts',import.meta.url).href;
 const creator=f.write('controlled-creator.mjs',`import fs from 'node:fs';import {spawn} from 'node:child_process';
const [adapter,helper,helperHash,root,cwd,main,grandchild,lifetime,grandReady,mainReady,ready,identityFile,mode]=process.argv.slice(2);
const {prepareSupervisedLaunch,armSupervisedRun}=await import(adapter);
const launch=prepareSupervisedLaunch({helperPath:helper,helperSha256:helperHash,controlRoot:root,cwd,executable:process.execPath,args:[main,'hold',grandchild,lifetime,grandReady,mainReady],scopeSha256:'a'.repeat(64)});
const child=spawn(launch.executable,launch.args,{...launch.spawnOptions,cwd,stdio:['ignore','inherit','inherit']});child.on('error',()=>process.exit(40));
await armSupervisedRun(launch.control,child,{onArmed:identity=>{const fd=fs.openSync(identityFile,'wx');try{fs.writeFileSync(fd,JSON.stringify(identity));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}});
while(!fs.existsSync(mainReady))await new Promise(resolve=>setTimeout(resolve,10));
fs.writeFileSync(ready,JSON.stringify({owner:process.pid,supervisor:child.pid,...JSON.parse(fs.readFileSync(mainReady))}));
if(mode==='crash')throw Error('neutral controlled creator crash');process.exit(27);
`);
 const child=observe(process.execPath,[creator,adapter,supervisor,f.helperSha256,f.controlRoot,f.cwd,tree.main,tree.grandchild,f.lifetime,tree.grandchildReady,tree.mainReady,ready,identityFile,mode],{cwd:f.cwd,env:f.env});f.children.push(child);child.child.stdin.end();
 assert.equal((await bounded(child.closed,'controlled creator cleanup',10000)).code,mode==='exit'?27:1,child.stderr);
 const identity=JSON.parse(fs.readFileSync(identityFile)),ids=JSON.parse(fs.readFileSync(ready));assert.equal(identity.creatorPid,child.child.pid);assert.equal(identity.armed.guardianPid,ids.supervisor);
 await until(()=>inspectSupervisedRun(identity).state==='stopped','durable proof after creator loss');const proof=inspectSupervisedRun(identity);assert.equal(proof.proof.reason,'creator-exited');assert.equal(proof.proof.activeProcesses,0);
 await until(()=>!alive(ids.owner)&&!alive(ids.supervisor)&&!alive(ids.main)&&!alive(ids.grandchild),'controlled creator Job and descendants gone');assert.equal(alive(outside.child.pid),true);
});

test('failed durable arming callback never dispatches and can cancel the prelaunch zero-process Job',windows,async t=>{
 const f=controlledFixture(t),marker=path.join(f.directory,'must-not-dispatch'),script=f.write('never-dispatch.cjs',"require('node:fs').writeFileSync(process.argv[2],'unexpected');"),launch=f.prepare([script,marker]),child=f.spawnLaunch(launch);child.child.stdin.end();let identity;
 await assert.rejects(armSupervisedRun(launch.control,child.child,{onArmed:value=>{identity=value;throw Error('Neutral durable journal failure');}}),/durable journal failure/);assert.equal(fs.existsSync(marker),false);assert.equal(fs.existsSync(path.join(identity.directory,'ack.json')),false);
 const proof=await cancelSupervisedRun(identity);assert.equal(proof.state,'stopped');assert.equal(proof.proof.reason,'cancelled');await bounded(child.closed,'undispatched Job cancellation');assert.equal(fs.existsSync(marker),false);
});

test('forced controlled guardian death leaves no fabricated terminal proof even though Windows kills its Job',windows,async t=>{
 const f=controlledFixture(t),tree=treeScripts(f),outside=await sibling(f),run=await f.start([tree.main,'hold',tree.grandchild,f.lifetime,tree.grandchildReady,tree.mainReady]);
 await until(()=>fs.existsSync(tree.mainReady),'force-kill controlled Job ready');const ids=JSON.parse(fs.readFileSync(tree.mainReady));assert.equal(run.child.child.kill('SIGKILL'),true);await bounded(run.child.closed,'forced controlled guardian close');
 await until(()=>!alive(ids.main)&&!alive(ids.grandchild),'forced controlled Job cleanup');assert.equal(fs.existsSync(path.join(run.identity.directory,'terminal.json')),false);
 assert.deepEqual(inspectSupervisedRun(run.identity),{state:'recovery-required',reason:'proof-missing'});assert.deepEqual(await cancelSupervisedRun(run.identity,{timeoutMs:100}),{state:'recovery-required',reason:'proof-missing'});assert.equal(alive(outside.child.pid),true);
});

test('forged, corrupt, cross-run and changed-identity records never establish stopped proof',windows,async t=>{
 const f=controlledFixture(t),script=f.write('completed.cjs','process.exit(0);'),first=await f.start([script]);await bounded(first.child.closed,'first proof fixture');const second=await f.start([script]);await bounded(second.child.closed,'second proof fixture');
 const file=path.join(first.identity.directory,'terminal.json'),original=fs.readFileSync(file),valid=inspectSupervisedRun(first.identity);assert.equal(valid.state,'stopped');
 const envelope=JSON.parse(original),pair=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),forged={...envelope,payload:JSON.stringify({...JSON.parse(envelope.payload),reason:'cancelled'})};forged.signature=crypto.sign('sha256',Buffer.from(forged.payload),{key:pair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
 for(const bytes of [Buffer.from('{corrupt'),Buffer.from(JSON.stringify({...envelope,signature:'A'.repeat(86)+'=='})),Buffer.from(JSON.stringify(forged)),fs.readFileSync(path.join(second.identity.directory,'terminal.json'))]){fs.writeFileSync(file,bytes);assert.equal(inspectSupervisedRun(first.identity).state,'recovery-required');assert.deepEqual(fs.readFileSync(file),bytes);}
 fs.writeFileSync(file,original);assert.deepEqual(inspectSupervisedRun(first.identity),valid);
 for(const identity of [{...first.identity,scopeSha256:'f'.repeat(64)},{...first.identity,armedSha256:'f'.repeat(64)},{...first.identity,armed:{...first.identity.armed,guardianCreated:'1'}},{...first.identity,armed:{...first.identity.armed,publicKey:pair.publicKey.export({format:'der',type:'spki'}).toString('base64')}}])assert.equal(inspectSupervisedRun(identity).state,'recovery-required');
 const request=path.join(first.identity.directory,'request.json'),requestBytes=fs.readFileSync(request);fs.writeFileSync(request,'{}');assert.equal(inspectSupervisedRun(first.identity).state,'recovery-required');fs.writeFileSync(request,requestBytes);assert.deepEqual(inspectSupervisedRun(first.identity),valid);
});

test('unsafe aliases, overlapping controls, reused tokens and preexisting forged ownership fail before dispatch',windows,async t=>{
 const f=controlledFixture(t),marker=path.join(f.directory,'unsafe-dispatched'),script=f.write('unsafe-dispatch.cjs',"require('node:fs').writeFileSync(process.argv[2],'unexpected');"),args=[script,marker];
 assert.throws(()=>f.prepare(args,{controlRoot:f.cwd}),/overlaps/);assert.throws(()=>f.prepare(args,{helperSha256:'a'.repeat(64)}),/executable/);assert.throws(()=>f.prepare(args,{token:'../escape'}),/token/);
 const alias=path.join(f.directory,'control-alias');fs.symlinkSync(f.controlRoot,alias,'junction');assert.throws(()=>f.prepare(args,{controlRoot:alias}),/aliases/);
 const first=f.prepare(args);assert.throws(()=>f.prepare(args,{token:first.control.token}),/EEXIST/);fs.writeFileSync(path.join(first.control.directory,'terminal.json'),'{}');const rejected=f.spawnLaunch(first);rejected.child.stdin.end();assert.equal((await bounded(rejected.closed,'forged preexisting record rejection')).code,125);assert.equal(fs.existsSync(marker),false);
 const second=f.prepare(args),request=path.join(second.control.directory,'request.json'),value=JSON.parse(fs.readFileSync(request));value.creatorPid=2147483647;fs.writeFileSync(request,JSON.stringify(value));const wrongCreator=f.spawnLaunch(second);wrongCreator.child.stdin.end();assert.equal((await bounded(wrongCreator.closed,'forged creator rejection')).code,125);assert.equal(fs.existsSync(marker),false);assert.equal(fs.existsSync(path.join(second.control.directory,'terminal.json')),false);
 const third=f.prepare(args),thirdRequest=path.join(third.control.directory,'request.json');fs.linkSync(thirdRequest,path.join(f.directory,'hard-linked-request'));const hardLink=f.spawnLaunch(third);hardLink.child.stdin.end();assert.equal((await bounded(hardLink.closed,'hard-linked prepared record rejection')).code,125);assert.equal(fs.existsSync(marker),false);assert.equal(fs.existsSync(path.join(third.control.directory,'armed.json')),false);
});

test('immutable arming records resist replacement and a forged cancel cannot target another token',windows,async t=>{
 const f=controlledFixture(t),tree=treeScripts(f),outside=await sibling(f),run=await f.start([tree.main,'hold',tree.grandchild,f.lifetime,tree.grandchildReady,tree.mainReady]);await until(()=>fs.existsSync(tree.mainReady),'immutable binding fixture ready');
 for(const name of ['request.json','armed.json'])assert.throws(()=>fs.writeFileSync(path.join(run.identity.directory,name),'{}'),/EPERM|EBUSY|EACCES/);
 fs.writeFileSync(path.join(run.identity.directory,'cancel.json'),JSON.stringify({schemaVersion:1,token:'f'.repeat(64),requestSha256:run.identity.requestSha256,armedSha256:run.identity.armedSha256}));
 assert.equal((await bounded(run.child.closed,'invalid control fails closed')).code,125);assert.match(run.child.stderr,/control message binding changed/);
 const proof=inspectSupervisedRun(run.identity);assert.equal(proof.state,'stopped');assert.equal(proof.proof.reason,'guardian-error');assert.equal(proof.proof.activeProcesses,0);assert.equal(alive(outside.child.pid),true);
});

for(const mode of ['delayed','unresolved','abort','reject-empty'])test('arming '+mode+' persistence never ACKs late or dispatches provider code',windows,async t=>{
 const f=controlledFixture(t),marker=path.join(f.directory,'must-never-run'),script=f.write('arming-deadline.cjs',"require('node:fs').writeFileSync(process.argv[2],'unexpected');"),launch=f.prepare([script,marker]),child=f.spawnLaunch(launch);child.child.stdin.end();
 await until(()=>fs.existsSync(path.join(launch.control.directory,'armed.json')),'deadline fixture reaches persistence boundary');
 const controller=new AbortController();let identity,resolveCallback,timer;
 const callback=new Promise(resolve=>{resolveCallback=resolve;});const start=Date.now();
 const work=armSupervisedRun(launch.control,child.child,{timeoutMs:800,signal:controller.signal,onArmed:value=>{identity=value;if(mode==='abort')timer=setTimeout(()=>controller.abort(Error('Neutral Stop before ACK')),20);else if(mode==='delayed')timer=setTimeout(resolveCallback,1100);return mode==='reject-empty'?Promise.reject():callback;}});
 await assert.rejects(work,mode==='abort'?/Stop before ACK/:mode==='reject-empty'?/callback rejected/:/deadline/);assert.ok(Date.now()-start<4000,'callback is bounded, with only bounded cancellation cleanup');assert.ok(identity,'test must reach the real persistence callback');
 resolveCallback();clearTimeout(timer);await sleep(100);assert.equal(fs.existsSync(path.join(identity.directory,'ack.json')),false,'late callback must have no ACK continuation');assert.equal(fs.existsSync(marker),false);
 await bounded(child.closed,'arming failure guardian cleanup');assert.equal(inspectSupervisedRun(identity).state,'stopped');assert.equal(fs.existsSync(marker),false);
});

test('independent cancellation publishers use one-link atomic records through a held publication window',windows,async t=>{
 const f=controlledFixture(t),tree=treeScripts(f),outside=await sibling(f),run=await f.start([tree.main,'hold',tree.grandchild,f.lifetime,tree.grandchildReady,tree.mainReady]);await until(()=>fs.existsSync(tree.mainReady),'interprocess cancellation fixture ready');
 const invocation=supervisorMessageInvocation(run.identity,'cancel'),held=observe(invocation.executable,invocation.args,{cwd:f.cwd,env:f.env});f.children.push(held);
 await until(()=>held.stdout.trim()==='{"prepared":true}','first native publisher fully flushed before rename');assert.equal(fs.existsSync(path.join(run.identity.directory,'cancel.json')),false);
 const adapter=new URL('../src/extensions/supervisor.ts',import.meta.url).href,identityFile=path.join(f.directory,'cross-process-identity.json');fs.writeFileSync(identityFile,JSON.stringify(run.identity));
 const script=f.write('independent-canceller.mjs',`import fs from 'node:fs';const [adapter,file]=process.argv.slice(2);const {cancelSupervisedRun}=await import(adapter);const result=await cancelSupervisedRun(JSON.parse(fs.readFileSync(file)));if(result.state!=='stopped')process.exit(3);process.stdout.write('confirmed');`);
 const publishers=[0,1].map(()=>{const child=observe(process.execPath,[script,adapter,identityFile],{cwd:f.cwd,env:f.env});child.child.stdin.end();f.children.push(child);return child;});
 for(const child of publishers){assert.equal((await bounded(child.closed,'independent cancellation publisher',10000)).code,0,child.stderr);assert.equal(child.stdout,'confirmed');}
 held.child.stdin.end('commit\n');assert.equal((await bounded(held.closed,'held duplicate publication')).code,0,held.stderr);
 const file=path.join(run.identity.directory,'cancel.json');assert.equal(fs.lstatSync(file).nlink,1);assert.equal(JSON.parse(fs.readFileSync(file)).token,run.identity.token);await bounded(run.child.closed,'interprocess cancelled guardian');assert.equal(inspectSupervisedRun(run.identity).state,'stopped');assert.equal(alive(outside.child.pid),true);
});

test('publisher crash after flushing its temporary record leaves no target or two-link artifact',windows,async t=>{
 const f=controlledFixture(t),tree=treeScripts(f),outside=await sibling(f),run=await f.start([tree.main,'hold',tree.grandchild,f.lifetime,tree.grandchildReady,tree.mainReady]);await until(()=>fs.existsSync(tree.mainReady),'publisher crash fixture ready');
 const invocation=supervisorMessageInvocation(run.identity,'cancel'),publisher=observe(invocation.executable,invocation.args,{cwd:f.cwd,env:f.env});f.children.push(publisher);await until(()=>publisher.stdout.trim()==='{"prepared":true}','crashing publisher has flushed its private temporary');
 publisher.child.kill('SIGKILL');await bounded(publisher.closed,'captured publisher crash');assert.equal(fs.existsSync(path.join(run.identity.directory,'cancel.json')),false);assert.equal(inspectSupervisedRun(run.identity).state,'recovery-required');
 for(const name of fs.readdirSync(run.identity.directory))assert.equal(fs.lstatSync(path.join(run.identity.directory,name)).nlink,1,'no link publication window survives publisher crash');
 const ids=JSON.parse(fs.readFileSync(tree.mainReady));assert.equal(alive(ids.main),true);assert.equal(alive(ids.grandchild),true);assert.equal((await cancelSupervisedRun(run.identity)).state,'stopped');await bounded(run.child.closed,'subsequent exact cancellation');assert.equal(alive(outside.child.pid),true);
});
