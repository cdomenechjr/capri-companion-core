import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {AgentProcesses,type NativeAgentTransportOptions} from '../tools/coordinator/process';
import {isAgentCapacityBusy,type Config,type RunIdentity} from '../tools/coordinator/types';
import {AgentLeasePool,AgentLeaseJournal,agentLeaseDigest,sharedAgentLeaseDirectory,sharedAgentLeases,ensureAgentLeaseDirectory,type AgentNativeLeaseClaim} from '../src/extensions/agent-lease';
import type {SupervisorControl,SupervisorIdentity} from '../src/extensions/supervisor';

const hash=(value:crypto.BinaryLike)=>crypto.createHash('sha256').update(value).digest('hex');
test('shared defaults canonicalize the OS temp base without changing its existing per-user key',()=>{
 const expected=path.join(fs.realpathSync.native(os.tmpdir()),'capri-agent-leases-'+hash(os.homedir()).slice(0,16));assert.equal(sharedAgentLeaseDirectory(),expected);assert.equal(sharedAgentLeases.directory,expected);assert.equal(path.dirname(expected),fs.realpathSync.native(os.tmpdir()));assert.equal(expected.includes('~'),false);
});
function fixture(t:test.TestContext){
 const parent=fs.realpathSync.native(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'capri-transport-unit-'));
 t.after(()=>{assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('capri-transport-unit-'));fs.rmSync(root,{recursive:true,force:true});});
 const repo=path.join(root,'repo'),cwd=path.join(root,'workspace'),controlRoot=path.join(root,'control'),poolDir=path.join(root,'leases');for(const directory of [repo,cwd,controlRoot])fs.mkdirSync(directory);
 const helperPath=path.join(root,'fixture-helper.exe');fs.writeFileSync(helperPath,'Inert fixture; never execute.');const helperSha256=hash(fs.readFileSync(helperPath)),leases=new AgentLeasePool(poolDir),hostId='f'.repeat(64);
 const config={repo,developmentRoot:root,stateDir:path.join(root,'state'),worktreeRoot:path.join(root,'worktrees'),profileRoot:path.join(root,'profiles'),referenceRoot:path.join(root,'reference'),timeoutMs:1000,agents:{codex:{command:process.execPath},claude:{command:process.execPath}}} as Config;
 const options:NativeAgentTransportOptions={helperPath,helperSha256,controlRoot,leases,hostId,creatorIdentity:async()=> '123',creatorState:async()=> 'dead'};
 const request={agent:'codex' as const,mode:'implement' as const,taskId:'neutral-unit',cwd,profile:path.join(root,'profile'),port:18601,prompt:'Neutral fixture',schema:{type:'object'},outputDir:path.join(root,'output')};
 return {root,config,options,leases,request,cwd,controlRoot,helperPath,helperSha256,hostId};
}
function claim(f:ReturnType<typeof fixture>,owner='development:unit-session'){
 const native:AgentNativeLeaseClaim={protocol:'capri-native-agent-lease-v1',sessionId:'unit-session',hostId:f.hostId,creatorCreated:'123',startedAt:new Date().toISOString(),controlRoot:f.controlRoot,controlToken:crypto.randomBytes(32).toString('hex'),helperPath:f.helperPath,helperSha256:f.helperSha256,workspaceSha256:hash(Buffer.from(f.cwd.toLowerCase()))};
 const lease=f.leases.acquire('codex',owner,native),journal=new AgentLeaseJournal(f.leases,'codex',lease.record);return {lease,journal,native};
}
test('only trusted OS-base normalization accepts short aliases; explicit paths and reparse roots stay strict',t=>{
 const f=fixture(t),osSpelling=path.join(os.tmpdir(),path.basename(f.root)),derived=sharedAgentLeaseDirectory(osSpelling,f.cwd);assert.equal(path.dirname(derived),f.root);assert.equal(fs.existsSync(derived),false);const pool=new AgentLeasePool(derived),lease=pool.acquire('codex','neutral-canonical-layout');lease.release();assert.equal(pool.peek('codex').state,'available');
 const literal=path.join(f.root,'literal~alias');fs.mkdirSync(literal);assert.throws(()=>ensureAgentLeaseDirectory(literal),/canonical/);assert.throws(()=>sharedAgentLeaseDirectory(literal,f.cwd),/canonical/);const alias=path.join(f.root,'junction');fs.symlinkSync(f.cwd,alias,'junction');assert.throws(()=>sharedAgentLeaseDirectory(alias,f.cwd),/reparse alias/);
});
test('invalid OS TEMP cannot crash imports or memory hosts and shared dispatch remains unavailable',t=>{
 const f=fixture(t),alias=path.join(f.root,'temp-junction');fs.symlinkSync(f.cwd,alias,'junction');const base=path.dirname(fileURLToPath(import.meta.url)),leaseModule=pathToFileURL(path.resolve(base,'../src/extensions/agent-lease.ts')).href,processModule=pathToFileURL(path.resolve(base,'../tools/coordinator/process.ts')).href,runtimeModule=pathToFileURL(path.resolve(base,'../src/extensions/agents.ts')).href,loader=pathToFileURL(path.resolve(base,'../node_modules/tsx/dist/loader.mjs')).href;
 const script=`const {AgentLeasePool,sharedAgentLeases}=await import(${JSON.stringify(leaseModule)});await import(${JSON.stringify(runtimeModule)});const {AgentProcesses}=await import(${JSON.stringify(processModule)});const memory=new AgentLeasePool();memory.acquire('codex','memory-only').release();if(memory.peek('codex').state!=='available')throw Error('Memory host failed');if(!sharedAgentLeases.directory||!sharedAgentLeases.initializationError)throw Error('Missing explicit shared unavailability');let rejected=false;try{sharedAgentLeases.acquire('codex','must-not-dispatch');}catch{rejected=true;}let inspections=0;await sharedAgentLeases.reconcile('codex',async()=>{inspections++;return true;});let spawns=0;const config=${JSON.stringify(f.config)},request=${JSON.stringify(f.request)},options={helperPath:${JSON.stringify(f.helperPath)},helperSha256:${JSON.stringify(f.helperSha256)},controlRoot:${JSON.stringify(f.controlRoot)},leases:sharedAgentLeases,creatorIdentity:async()=> '123',spawnChild:()=>{spawns++;throw Error('Unexpected spawn');}};const transport=new AgentProcesses(config,()=>{},()=>{},sharedAgentLeases,undefined,options);let failed=false;try{await transport.execute(request);}catch{failed=true;}console.log(JSON.stringify({imported:true,memoryAvailable:true,sharedState:sharedAgentLeases.peek('codex').state,rejected,failed,ready:transport.ownership.ready('codex'),inspections,spawns}));`;
 for(const temp of [alias,path.join(f.root,'missing-temp')]){const env:NodeJS.ProcessEnv={...process.env,TEMP:temp,TMP:temp,TMPDIR:temp,TSX_DISABLE_CACHE:'1'};delete env.NODE_OPTIONS;const result=spawnSync(process.execPath,['--import',loader,'--input-type=module','-e',script],{cwd:f.root,env,encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout.trim()),{imported:true,memoryAvailable:true,sharedState:'unknown',rejected:true,failed:true,ready:false,inspections:0,spawns:0});assert.equal(fs.existsSync(path.join(temp,path.basename(sharedAgentLeases.directory!))),false);}
});
function prepared(f:ReturnType<typeof fixture>,c:ReturnType<typeof claim>){
 const directory=path.join(f.controlRoot,c.native.controlToken);fs.mkdirSync(directory);
 const partial={root:f.controlRoot,directory,token:c.native.controlToken,scopeSha256:agentLeaseDigest({provider:'codex',lease:c.lease.record}),helperPath:f.helperPath,helperSha256:f.helperSha256,creatorPid:c.lease.record.pid,cwdSha256:c.native.workspaceSha256,commandSha256:'a'.repeat(64)};
 const request={schemaVersion:1,token:partial.token,scopeSha256:partial.scopeSha256,helperPath:partial.helperPath,helperSha256:partial.helperSha256,creatorPid:partial.creatorPid,cwdSha256:partial.cwdSha256,commandSha256:partial.commandSha256},raw=Buffer.from(JSON.stringify(request));fs.writeFileSync(path.join(directory,'request.json'),raw);
 const control:SupervisorControl={...partial,requestSha256:hash(raw)};c.journal.prepare(control);return control;
}
function armed(f:ReturnType<typeof fixture>,c:ReturnType<typeof claim>){
 const control=prepared(f,c),keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),value={schemaVersion:1 as const,token:control.token,requestSha256:control.requestSha256,scopeSha256:control.scopeSha256,helperPath:control.helperPath,helperSha256:control.helperSha256,creatorPid:control.creatorPid,creatorCreated:c.native.creatorCreated,guardianPid:2147483000,guardianCreated:'124',cwdSha256:control.cwdSha256,commandSha256:control.commandSha256,jobId:'b'.repeat(64),publicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),armedAt:new Date().toISOString()},raw=Buffer.from(JSON.stringify(value));fs.writeFileSync(path.join(control.directory,'armed.json'),raw);
 const identity:SupervisorIdentity={...control,armedSha256:hash(raw),armed:value};c.journal.arm(identity);
 const run:RunIdentity={pid:value.guardianPid,marker:'neutral unit',agent:'codex',mode:'implement',taskId:'unit-task',sessionId:c.native.sessionId,startedAt:c.native.startedAt,leaseToken:c.lease.token,ownership:'native-job-v1',supervisor:identity};
 const stopProof=()=>{const proof={schemaVersion:1,token:identity.token,requestSha256:identity.requestSha256,armedSha256:identity.armedSha256,jobId:identity.armed.jobId,activeProcesses:0,reason:'creator-exited',mainExitCode:null,finishedAt:new Date(Date.now()+1).toISOString()},payload=JSON.stringify(proof),signature=crypto.sign('sha256',Buffer.from(payload),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');fs.writeFileSync(path.join(control.directory,'terminal.json'),JSON.stringify({schemaVersion:1,payload,signature}));};
 return {identity,run,stopProof};
}
test('unconfigured or wrong-pinned native transport is unavailable with no raw spawn fallback',async t=>{
 const f=fixture(t);let spawns=0;for(const patch of [{helperPath:path.join(f.root,'missing.exe')},{helperSha256:'0'.repeat(64)}]){
  const processes=new AgentProcesses(f.config,()=>{throw Error('Unexpected start');},()=>{},f.leases,undefined,{...f.options,...patch,spawnChild:(()=>{spawns++;throw Error('Unexpected subprocess');}) as any});
  assert.equal(processes.ownership?.protocol,'capri-agent-ownership-v1');assert.equal(processes.ownership?.ready?.('codex'),false);const reports=await processes.ownership!.reconcileLeases!();assert.deepEqual(reports.map(row=>row.state),['ready','ready']);assert.ok(reports.every(row=>row.reason?.includes('dispatch unavailable')));await assert.rejects(processes.execute(f.request));assert.equal(f.leases.peek('codex').state,'available');
 }assert.equal(spawns,0);assert.equal(fs.existsSync(path.join(f.root,'output')),false);
});
test('legacy injected lifecycle preserves per-controller isolation and branded atomic capacity loss',async t=>{
 const f=fixture(t),pool=new AgentLeasePool(),held=pool.acquire('codex','runtime:neutral'),lifecycle={launch(){throw Error('Must not launch');},async stop(){},async inspectStopped(){return true;}},processes=new AgentProcesses(f.config,()=>{},()=>{},pool,lifecycle as any);
 await assert.rejects(processes.execute(f.request),error=>isAgentCapacityBusy(error,'codex'));assert.equal(processes.children.size,0);held.release();assert.equal(pool.peek('codex').state,'available');assert.equal(new AgentLeasePool().peek('codex').state,'available');
});
test('claimed checkpoint is flushed before reservation and recovers only enforced no-dispatch ownership',async t=>{
 const f=fixture(t),c=claim(f);assert.equal(c.journal.read().phase,'claimed');assert.ok(fs.existsSync(path.join(c.journal.directory,'claim.json')));assert.ok(fs.existsSync(path.join(c.journal.directory,'head.json')));c.lease.retain();
 const processes=new AgentProcesses(f.config,()=>{},()=>{},f.leases,undefined,f.options),reports=await processes.ownership!.reconcileLeases!();assert.deepEqual(reports.map(row=>row.agent),['codex','claude']);assert.equal(f.leases.peek('codex').state,'available');assert.equal(JSON.parse(fs.readFileSync(path.join(c.journal.directory,'settled.json'),'utf8')).inspection.state,'not-dispatched');
});
test('prepared orphan with no ACK recovers without task rows, while ACK or unknown creator retains it',async t=>{
 for(const condition of ['safe','ack-present','creator-unknown']){
  const f=fixture(t),c=claim(f),control=prepared(f,c);c.lease.retain();if(condition==='ack-present')fs.writeFileSync(path.join(control.directory,'ack.json'),'{}');
  const processes=new AgentProcesses(f.config,()=>{},()=>{},f.leases,undefined,{...f.options,creatorState:async()=>condition==='creator-unknown'?'unknown':'dead'});const reports=await processes.ownership!.reconcileLeases!();assert.equal(f.leases.peek('codex').state,condition==='safe'?'available':'occupied');if(condition!=='safe')assert.equal(reports[0].state,'unconfirmed');
 }
});
test('armed dead-PID lease cannot recover until matching signed zero-Job proof exists',async t=>{
 const f=fixture(t),c=claim(f),a=armed(f,c);c.lease.retain();const processes=new AgentProcesses(f.config,()=>{},()=>{},f.leases,undefined,f.options);
 assert.equal(processes.ownership!.cleanupStatus(a.run),'unconfirmed');assert.equal((await processes.ownership!.reconcileLeases!())[0].state,'unconfirmed');assert.equal(f.leases.peek('codex').state,'occupied');
 a.stopProof();assert.equal(processes.ownership!.cleanupStatus(a.run),'confirmed');assert.equal((await processes.ownership!.reconcile(a.run)).stopped,true);assert.equal(f.leases.peek('codex').state,'available');assert.equal(processes.ownership!.cleanupStatus(a.run),'confirmed');assert.equal((await processes.ownership!.reconcile({...a.run,pid:a.run.pid-1})).stopped,false);
});
test('a missing provider slot after restart cannot hide its unsettled armed reservation',async t=>{
 const f=fixture(t),c=claim(f),a=armed(f,c);c.lease.retain();fs.unlinkSync(path.join(f.leases.directory!,'codex.json'));const restartedPool=new AgentLeasePool(f.leases.directory),processes=new AgentProcesses(f.config,()=>{},()=>{},restartedPool,undefined,{...f.options,leases:restartedPool});assert.equal(restartedPool.peek('codex').state,'occupied');assert.throws(()=>restartedPool.acquire('codex','runtime:must-wait'));assert.equal((await processes.ownership!.reconcileLeases!())[0].state,'unconfirmed');a.stopProof();await processes.ownership!.reconcileLeases!();assert.equal(restartedPool.peek('codex').state,'available');
});
test('changed or missing ordered checkpoint cannot be downgraded to an unused claimed slot',async t=>{
 for(const corruption of ['head','prepared','armed','claim']){
  const f=fixture(t),c=claim(f);armed(f,c);c.lease.retain();fs.unlinkSync(path.join(c.journal.directory,corruption+'.json'));
  const processes=new AgentProcesses(f.config,()=>{},()=>{},f.leases,undefined,f.options);assert.equal((await processes.ownership!.reconcileLeases!())[0].state,'unconfirmed');assert.notEqual(f.leases.peek('codex').state,'available');assert.throws(()=>f.leases.acquire('codex','unsafe-downgrade'));
 }
});
test('foreign live runtime owner remains busy and is never cancelled or cleared',async t=>{
 const f=fixture(t),c=claim(f,'runtime:unit-session');armed(f,c);c.lease.retain();let spawns=0;const processes=new AgentProcesses(f.config,()=>{},()=>{},f.leases,undefined,{...f.options,creatorState:async()=> 'alive',spawnChild:(()=>{spawns++;throw Error('Foreign work must not be stopped');}) as any});
 assert.equal(processes.ownership!.ready!('codex'),false);assert.equal((await processes.ownership!.reconcileLeases!())[0].state,'busy');assert.equal(f.leases.peek('codex').state,'occupied');assert.equal(spawns,0);
});
test('reused token, altered identity and forged terminal text do not establish cleanup proof',async t=>{
 const f=fixture(t),c=claim(f),a=armed(f,c);c.lease.retain();const processes=new AgentProcesses(f.config,()=>{},()=>{},f.leases,undefined,f.options);fs.writeFileSync(path.join(a.identity.directory,'terminal.json'),JSON.stringify({state:'stopped',activeProcesses:0}));
 assert.equal(processes.ownership!.cleanupStatus(a.run),'unconfirmed');assert.equal((await processes.ownership!.reconcileLeases!())[0].state,'unconfirmed');assert.equal(processes.ownership!.cleanupStatus({...a.run,leaseToken:crypto.randomUUID()}),'unconfirmed');assert.equal(processes.ownership!.cleanupStatus({...a.run,sessionId:'foreign'}),'unconfirmed');assert.equal(f.leases.peek('codex').state,'occupied');
});
test('immutable generations survive advisory mirror deletion and stale settlement without releasing a successor',async t=>{
 const f=fixture(t),first=f.leases.acquire('codex','legacy:first');first.retain();fs.unlinkSync(path.join(f.leases.directory!,'codex.json'));let resolveProof!:(value:boolean)=>void,entered!:(value?:unknown)=>void;const enteredPromise=new Promise(resolve=>{entered=resolve;}),proof=new Promise<boolean>(resolve=>{resolveProof=resolve;}),stale=new AgentLeasePool(f.leases.directory).reconcile('codex',async()=>{entered();return proof;});await enteredPromise;
 assert.throws(()=>new AgentLeasePool(f.leases.directory).acquire('codex','must-wait'));await f.leases.reconcile('codex',async()=>true);const secondPool=new AgentLeasePool(f.leases.directory),second=secondPool.acquire('codex','legacy:second');resolveProof(true);await stale;assert.equal(secondPool.peek('codex').state,'occupied');assert.equal(first.release(),'recovery-required');assert.throws(()=>f.leases.acquire('codex','still-must-wait'));assert.equal(second.record.generation,2);second.release();const third=secondPool.acquire('codex','legacy:third');assert.equal(third.record.generation,3);third.release();
});
test('missing or changed generation, anchor and settlement history never becomes available',async t=>{
 for(const target of ['0000000000000001.json','0000000000000002.json','0000000000000002.anchor.json','0000000000000001.settled.json','0000000000000002.settled.json','0000000000000002.settled.anchor.json','ledger.json']){
  const f=fixture(t);f.leases.acquire('codex','legacy:first').release();f.leases.acquire('codex','legacy:second').release();const directory=path.join(f.leases.directory!,'generations','codex');fs.unlinkSync(path.join(directory,target));const restarted=new AgentLeasePool(f.leases.directory);assert.equal(restarted.peek('codex').state,'unknown');let inspections=0;assert.equal((await restarted.reconcile('codex',async()=>{inspections++;return true;})).reason,'unreadable-record');assert.equal(inspections,0);assert.throws(()=>restarted.acquire('codex','must-not-reuse'));assert.equal(fs.existsSync(path.join(directory,target)),false);
 }
});
test('unknown legacy records migrate only after exact trusted proof and ambiguous generation hints stay blocked',async t=>{
 const f=fixture(t);fs.mkdirSync(f.leases.directory!);const file=path.join(f.leases.directory!,'codex.json'),unknown={pid:2147483000,owner:'runtime:old',token:'legacy-unfenced'};fs.writeFileSync(file,JSON.stringify(unknown));assert.throws(()=>f.leases.acquire('codex','must-wait'));assert.equal((await f.leases.reconcile('codex')).reason,'inspector-required');assert.equal((await f.leases.reconcile('codex',async()=>false)).reason,'tree-unconfirmed');assert.equal(await f.leases.recover('codex',async record=>record.token===unknown.token),true);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),unknown);const next=f.leases.acquire('codex','legacy:new');assert.equal(next.record.generation,2);next.release();
 fs.writeFileSync(file,JSON.stringify({...unknown,generation:77,token:'unknown-generation'}));assert.equal((await f.leases.reconcile('codex',async()=>true)).reason,'unreadable-record');assert.notEqual(f.leases.peek('codex').state,'available');assert.throws(()=>f.leases.acquire('codex','must-not-adopt'));
});
test('an armed generation cannot be settled by a true callback without actual native proof',async t=>{
 const f=fixture(t),c=claim(f);armed(f,c);c.lease.retain();assert.equal((await f.leases.reconcile('codex',async()=>true)).state,'recovery-required');assert.equal(fs.existsSync(path.join(f.leases.directory!,'generations','codex','0000000000000001.settled.json')),false);assert.equal(f.leases.peek('codex').state,'occupied');
});
