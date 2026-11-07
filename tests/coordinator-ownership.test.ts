import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Coordinator,control,type CoordinatorProcesses} from '../tools/coordinator/engine';
import {git,prepareTask,snapshotTask} from '../tools/coordinator/git';
import {planningDigest} from '../tools/coordinator/versioning';
import {AgentRunError} from '../tools/coordinator/process';
import {AgentCapacityBusy,isAgentCapacityBusy,type Agent,type AgentOwnershipHooks,type AgentOwnershipLease,type Config,type RunIdentity,type TaskSpec} from '../tools/coordinator/types';

const spec=(id='owned',owner:Agent='codex'):TaskSpec=>({id,owner,goal:'Neutral local ownership fixture',allowedPaths:['src/'+id+'.ts'],dependencies:[],resources:[id],acceptance:['check']});
const run=(taskId='owned',mode:RunIdentity['mode']='implement',agent:Agent='codex'):RunIdentity=>({pid:2147483647,marker:'neutral-ownership-fixture',agent,mode,taskId,sessionId:taskId+'-'+mode,leaseToken:'neutral-exact-lease-token',ownership:'native-job-v1',startedAt:new Date().toISOString()});
const result={status:'completed',summary:'Neutral fake implementation',changedFiles:[],tests:[],limitations:[],handoff:'No coding CLI was launched.'};
function ownership(){
 const values={proved:false,cleanup:'unconfirmed' as 'confirmed'|'unconfirmed',ready:{codex:true,claude:true},reports:[{agent:'codex',state:'ready'},{agent:'claude',state:'ready'}] as AgentOwnershipLease[],inspected:[] as RunIdentity[],leaseCalls:0,custom:undefined as undefined|((run:Readonly<RunIdentity>)=>Promise<{stopped:boolean;reason?:string}>)};
 const hooks:AgentOwnershipHooks={protocol:'capri-agent-ownership-v1',reconcile:async saved=>{assert.equal(Object.isFrozen(saved),true);values.inspected.push(structuredClone(saved));return values.custom?values.custom(saved):{stopped:values.proved,reason:values.proved?'Exact fake Job proof':'No fake whole-tree proof'};},cleanupStatus:()=>values.cleanup,ready:agent=>values.ready[agent],reconcileLeases:async()=>{values.leaseCalls++;return structuredClone(values.reports);}};
 return {values,hooks};
}
async function fixture(t:any,specs:TaskSpec[]=[spec()]){
 const parent=fs.realpathSync.native(os.tmpdir()),root=fs.realpathSync.native(fs.mkdtempSync(path.join(parent,'capri-ownership-'))),repo=path.join(root,'repo');fs.mkdirSync(repo);git(repo,'init','-b','main');git(repo,'config','core.autocrlf','false');git(repo,'config','user.name','Ownership fixture');git(repo,'config','user.email','fixture@localhost');
 const prompts=path.join(repo,'prompts');fs.mkdirSync(prompts);for(const key of ['master','codex','claude','review'])fs.writeFileSync(path.join(prompts,key+'.md'),'Neutral fixture; no provider calls.');fs.writeFileSync(path.join(repo,'baseline'),'neutral');fs.writeFileSync(path.join(repo,'tasks.json'),JSON.stringify(specs));fs.writeFileSync(path.join(repo,'ROADMAP.md'),'Neutral local fixture.');git(repo,'add','.');git(repo,'commit','-m','neutral baseline');
 const config:Config={version:1,repo,developmentRoot:root,stateDir:path.join(root,'runtime'),worktreeRoot:path.join(root,'worktrees'),profileRoot:path.join(root,'profiles'),referenceRoot:path.join(root,'reference'),candidateBranch:'codex/candidate',tasksFile:path.join(repo,'tasks.json'),prompts:Object.fromEntries(['master','codex','claude','review'].map(key=>[key,path.join(prompts,key+'.md')])) as Config['prompts'],checks:[{id:'check',command:process.execPath,args:['-e','process.exit(0)']}],agents:{codex:{command:process.execPath},claude:{command:process.execPath}},continuous:false,timeoutMs:10000,maxRepairAttempts:1,pollMs:10,maxProposalsPerCycle:2,maxQueuedTasks:12,proposalAllowedPaths:['src/','tests/'],roadmapFile:path.join(repo,'ROADMAP.md')};
 const engines:Coordinator[]=[],calls:any[]=[];let behavior:(request:any,start:(saved:RunIdentity)=>void,record:(saved:RunIdentity,value:any)=>void)=>Promise<any>=async()=>assert.fail('Fixture attempted an uninjected provider');
 const create=(hooks?:AgentOwnershipHooks)=>{const engine=new Coordinator(config,()=>{},{processesFactory:(_config,start,record)=>({ownership:hooks,execute:async request=>{calls.push(request);return behavior(request,start,record);},stop:async()=>{}})});engines.push(engine);return engine;};
 t.after(async()=>{for(const engine of engines){await engine.stop();engine.lock.release();}assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('capri-ownership-'));assert.equal(fs.lstatSync(root).isSymbolicLink(),false);fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
 return {root,repo,config,calls,create,setBehavior:(next:typeof behavior)=>{behavior=next;},async saved(saved:RunIdentity=run()){const engine=create();await engine.initialize();if(saved.mode==='propose'){engine.state.proposalRun=saved;engine.state.planning={inputDigest:planningDigest(config,engine.state,engine.candidate),outcome:'running',at:new Date().toISOString()};}else{const task=engine.state.tasks.find(task=>task.id===saved.taskId)!;task.phase='running';task.attempts=1;prepareTask(config,task,engine.candidate,'saved-fixture');fs.mkdirSync(path.join(task.worktree!,'src'));fs.writeFileSync(path.join(task.worktree!,'src',task.id+'.ts'),'preserved partial work\n');task.run=saved;}engine.save();engine.lock.release();return engine;}};
}
async function resume(engine:Coordinator){control(engine.config,'resume');await engine.consumeControl();}

test('native dead-PID uncertainty keeps exact identity and work until trusted proof enables explicit resume',async t=>{
 const f=await fixture(t),saved=run();await f.saved(saved);const {hooks,values}=ownership(),engine=f.create(hooks);await engine.initialize();const task=engine.state.tasks[0],work=fs.readFileSync(path.join(task.worktree!,'src','owned.ts'),'utf8');
 assert.equal(engine.state.status,'paused');assert.equal(task.phase,'blocked');assert.deepEqual(task.run,saved);assert.equal(task.ownershipRecovery?.stopped,false);assert.throws(()=>engine.retryTask(task.id,'Do not erase uncertain owner'),/confirmed.*ownership/);await engine.propose();assert.equal(f.calls.length,0);
 await resume(engine);assert.equal(engine.state.status,'paused');assert.deepEqual(task.run,saved);assert.equal(task.attempts,1);values.proved=true;await resume(engine);assert.equal(engine.state.status,'running');assert.equal(task.run,undefined);assert.equal(task.phase,'queued');assert.equal(task.attempts,1);assert.equal(task.ownershipRecovery?.stopped,true);assert.deepEqual(task.ownershipRecovery?.run,saved);assert.equal(fs.readFileSync(path.join(task.worktree!,'src','owned.ts'),'utf8'),work);assert.ok(values.inspected.length>=3);assert.ok(values.inspected.every(value=>value.sessionId===saved.sessionId&&value.leaseToken===saved.leaseToken));assert.equal(f.calls.length,0);
});

for(const protocol of ['missing','wrong'])test('native saved runs never use PID fallback with '+protocol+' ownership hooks',async t=>{
 const f=await fixture(t),saved=run();await f.saved(saved);const hooks=protocol==='missing'?undefined:{...ownership().hooks,protocol:'untrusted-output'} as any,engine=f.create(hooks);await engine.initialize();assert.equal(engine.state.status,'paused');assert.deepEqual(engine.state.tasks[0].run,saved);await resume(engine);assert.deepEqual(engine.state.tasks[0].run,saved);assert.equal(engine.state.status,'paused');assert.equal(f.calls.length,0);
});

test('legacy unmarked saved runs retain prior missing-PID recovery when hooks are absent',async t=>{
 const f=await fixture(t),saved=run();delete saved.ownership;delete saved.leaseToken;await f.saved(saved);const engine=f.create();await engine.initialize();assert.equal(engine.state.tasks[0].run,undefined);assert.equal(engine.state.tasks[0].phase,'blocked');await resume(engine);assert.equal(engine.state.tasks[0].phase,'queued');assert.equal(f.calls.length,0);
});

test('unconfirmed native implementation success cannot snapshot, review or integrate its claimed output',async t=>{
 const f=await fixture(t),{hooks}=ownership(),engine=f.create(hooks);await engine.initialize();f.setBehavior(async(request,start,record)=>{const saved=run(request.taskId);start(saved);record(saved,{type:'result',ownership:'confirmed',stopped:true});fs.mkdirSync(path.join(request.cwd,'src'));fs.writeFileSync(path.join(request.cwd,'src','owned.ts'),'neutral edit');return {sessionId:saved.sessionId,value:result,output:'',malformed:0};});
 const before=engine.state.candidateCommit,task=engine.state.tasks[0];await engine.implement(task);assert.equal(task.phase,'blocked');assert.equal(task.attempts,1);assert.equal(task.commit,undefined);assert.equal(task.validation,undefined);assert.equal(task.run?.ownership,'native-job-v1');assert.equal(engine.state.status,'paused');await engine.combine(task);assert.equal(engine.state.candidateCommit,before);assert.equal(f.calls.length,1);
});

for(const failure of ['quota','crash','callback','Stop'])test('unconfirmed native '+failure+' preserves ownership and suppresses repair',async t=>{
 const f=await fixture(t),{hooks}=ownership(),engine=f.create(hooks);await engine.initialize();if(failure==='callback')engine.event=()=>{throw Error('Neutral activity callback failed');};
 f.setBehavior(async(request,start)=>{start(run(request.taskId));if(failure==='Stop')await engine.stop();throw failure==='quota'?new AgentRunError('usage limit reached'):Error('Neutral '+failure+' failure');});const task=engine.state.tasks[0];await engine.implement(task);assert.equal(task.phase,'blocked');assert.equal(task.attempts,1);assert.equal(task.run?.leaseToken,'neutral-exact-lease-token');assert.equal(task.ownershipRecovery?.stopped,false);assert.equal(task.commit,undefined);assert.equal(engine.state.status,failure==='Stop'?'stopped':'paused');assert.equal(JSON.parse(fs.readFileSync(engine.stateFile,'utf8')).tasks[0].run.sessionId,task.run?.sessionId);assert.equal(f.calls.length,1);
});

test('confirmed native error retains proof and preserves ordinary quota handling',async t=>{
 const f=await fixture(t),{hooks,values}=ownership();values.cleanup='confirmed';const engine=f.create(hooks);await engine.initialize();f.setBehavior(async(request,start)=>{start(run(request.taskId));throw new AgentRunError('usage limit reached');});const task=engine.state.tasks[0];await engine.implement(task);assert.equal(task.phase,'blocked');assert.equal(task.run,undefined);assert.equal(task.ownershipRecovery?.stopped,true);assert.equal(task.attempts,1);
});

test('unconfirmed native review cannot store approval or advance integration',async t=>{
 const f=await fixture(t),{hooks}=ownership(),engine=f.create(hooks);await engine.initialize();const task=engine.state.tasks[0];task.attempts=1;prepareTask(f.config,task,engine.candidate,'review-fixture');fs.mkdirSync(path.join(task.worktree!,'src'));fs.writeFileSync(path.join(task.worktree!,'src','owned.ts'),'neutral edit');task.result={...result,status:'completed'};snapshotTask(task);task.phase='review';f.setBehavior(async(request,start)=>{start(run(request.taskId,'review',request.agent));return {sessionId:'review',value:{approved:true,summary:'Untrusted completion until cleanup proof',issues:[]},output:'',malformed:0};});await engine.review(task,'claude');assert.equal(task.phase,'blocked');assert.equal(task.run?.agent,'claude');assert.equal(task.review,undefined);assert.equal(task.reviewHistory,undefined);
});

test('saved planning ownership is reconciled without replaying an uncertain proposal',async t=>{
 const f=await fixture(t,[]),saved=run('continuous-proposal','propose');await f.saved(saved);const {hooks,values}=ownership(),engine=f.create(hooks);await engine.initialize();assert.deepEqual(engine.state.proposalRun,saved);await engine.propose();assert.equal(engine.state.proposalAttempts,0);values.proved=true;await resume(engine);assert.equal(engine.state.proposalRun,undefined);assert.equal(engine.state.proposalOwnershipRecovery?.stopped,true);await engine.propose();assert.equal(f.calls.length,0);
 values.cleanup='confirmed';f.setBehavior(async(request,start)=>{start({...run(request.taskId,'propose'),sessionId:'new-input-proposal'});return {sessionId:'new-input-proposal',value:{tasks:[]},output:'',malformed:0};});fs.appendFileSync(f.config.roadmapFile,'\nNew neutral reproducible input.');await engine.propose();assert.equal(f.calls.length,1);assert.equal(engine.state.proposalAttempts,1);assert.equal(engine.state.proposalRun,undefined);
});

test('unconfirmed planning success retains its run and ignores proposed task claims',async t=>{
 const f=await fixture(t,[]),{hooks}=ownership(),engine=f.create(hooks);await engine.initialize();f.setBehavior(async(request,start)=>{start(run(request.taskId,'propose'));return {sessionId:'proposal',value:{tasks:[{id:'should-not-exist',owner:'codex',goal:'Unconfirmed proposal',allowedPaths:['src/new.ts'],resources:[]}]},output:'',malformed:0};});await engine.propose();assert.equal(engine.state.tasks.length,0);assert.ok(engine.state.proposalRun);assert.equal(engine.state.planning?.ownershipUnconfirmed,true);assert.equal(engine.state.status,'paused');await engine.propose();assert.equal(f.calls.length,1);
});

test('dangling unknown leases require reconciliation and foreign busy owners are never stopped or retried',async t=>{
 const f=await fixture(t),{hooks,values}=ownership();values.reports=[{agent:'codex',state:'unconfirmed',reason:'Dangling exact-token proof unavailable'},{agent:'claude',state:'ready'}];const engine=f.create(hooks);await engine.initialize();assert.equal(engine.state.status,'paused');assert.equal(engine.state.agentOwnership?.leases[0].state,'unconfirmed');assert.throws(()=>engine.retryTask('owned','Do not clear a dangling lease'),/ownership/);
 values.reports=[{agent:'codex',state:'busy',reason:'Unrelated live runtime owner'},{agent:'claude',state:'ready'}];values.ready.codex=false;await resume(engine);assert.equal(engine.state.status,'running');await engine.implement(engine.state.tasks[0]);await engine.propose();assert.equal(engine.state.tasks[0].attempts,0);assert.equal(engine.state.proposalAttempts,0);assert.equal(values.inspected.length,0);assert.equal(f.calls.length,0);
 values.ready.codex=true;values.cleanup='confirmed';f.setBehavior(async(request,start)=>{start(run(request.taskId));return {sessionId:'impl',value:result,output:'',malformed:0};});await engine.implement(engine.state.tasks[0]);assert.equal(engine.state.tasks[0].attempts,1);assert.equal(engine.state.tasks[0].phase,'review');assert.equal(f.calls.length,1);
});

test('malformed startup lease reports are explicit unknowns rather than assumed capacity',async t=>{
 const f=await fixture(t),{hooks,values}=ownership();values.reports=[{agent:'codex',state:'ready'}];const engine=f.create(hooks);await engine.initialize();assert.equal(engine.state.status,'paused');assert.deepEqual(engine.state.agentOwnership?.leases.map(row=>row.state),['unconfirmed','unconfirmed']);assert.equal(engine.providerReady('codex'),false);assert.equal(engine.providerReady('claude'),false);assert.equal(f.calls.length,0);
});

test('Stop preempts an awaited ownership resume and a late proof cannot resurrect or erase the saved run',async t=>{
 const f=await fixture(t),saved=run();await f.saved(saved);const {hooks,values}=ownership(),engine=f.create(hooks);await engine.initialize();let resolveProof:(value:{stopped:boolean})=>void=()=>{};values.custom=async()=>new Promise(resolve=>{resolveProof=resolve;});control(f.config,'resume');const pending=engine.consumeControl();await new Promise(resolve=>setImmediate(resolve));control(f.config,'stop');await engine.consumeControl();await pending;assert.equal(engine.state.status,'stopped');assert.deepEqual(engine.state.tasks[0].run,saved);resolveProof({stopped:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(engine.state.status,'stopped');assert.deepEqual(engine.state.tasks[0].run,saved);assert.equal(f.calls.length,0);
});

test('busy providers are skipped by the scheduler without consuming their queued attempts',async t=>{
 const f=await fixture(t,[spec()]),{hooks,values}=ownership();values.ready.codex=false;values.reports=[{agent:'codex',state:'busy',reason:'Foreign runtime owner'},{agent:'claude',state:'ready'}];const engine=f.create(hooks);await engine.run(true);assert.equal(engine.state.tasks[0].phase,'queued');assert.equal(engine.state.tasks[0].attempts,0);assert.equal(engine.state.proposalAttempts,0);assert.equal(values.inspected.length,0);assert.equal(f.calls.length,0);
});

test('one deferred Stop is joined before lease release and cannot overwrite a replacement coordinator',async t=>{
 const f=await fixture(t,[]),engine=f.create();let releaseStop:()=>void=()=>{},stops=0,finished=false;
 engine.processes.stop=()=>{stops++;return stops===1?new Promise<void>(resolve=>{releaseStop=resolve;}):Promise.resolve();};
 const work=engine.run(true).then(()=>{finished=true;});while(stops===0)await new Promise(resolve=>setTimeout(resolve,10));
 let explicitFinished=false;const explicit=engine.stop().then(()=>{explicitFinished=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(stops,1);assert.equal(finished,false);assert.equal(explicitFinished,false);assert.equal(fs.existsSync(engine.lock.file),true);
 const replacement=f.create();await assert.rejects(replacement.initialize(),/already running/);releaseStop();await Promise.all([work,explicit]);assert.equal(stops,1);assert.equal(engine.lock.held,false);
 await replacement.initialize();replacement.state.lastError='Replacement owns the queue';replacement.save();const before=fs.readFileSync(replacement.stateFile);await engine.stop();engine.state.lastError='Late obsolete state';assert.equal(engine.save(),false);engine.event(run(),'error','Late obsolete event');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(fs.readFileSync(replacement.stateFile),before);assert.equal(stops,1);
});

test('late Stop persistence requires the exact lease token even when the old object still thinks it holds the lease',async t=>{
 const f=await fixture(t,[]),engine=f.create();await engine.initialize();let releaseStop:()=>void=()=>{};engine.processes.stop=()=>new Promise<void>(resolve=>{releaseStop=resolve;});const stopping=engine.stop();
 const replacement={...engine.state,lastError:'Replacement state survives',generation:999};fs.writeFileSync(engine.stateFile,JSON.stringify(replacement));fs.writeFileSync(engine.lock.file,JSON.stringify({pid:process.pid,token:'replacement-token'}));const before=fs.readFileSync(engine.stateFile);releaseStop();await stopping;assert.equal(engine.save(),false);assert.deepEqual(fs.readFileSync(engine.stateFile),before);engine.lock.release();assert.equal(JSON.parse(fs.readFileSync(engine.lock.file,'utf8')).token,'replacement-token');fs.unlinkSync(engine.lock.file);
});

test('an Abort callback re-entering Stop joins the already-published single completion',async t=>{
 const f=await fixture(t,[]),engine=f.create();await engine.initialize();let stops=0,reentrant:Promise<void>|undefined;engine.processes.stop=async()=>{stops++;};engine.abort.signal.addEventListener('abort',()=>{reentrant=engine.stop();},{once:true});await engine.stop();await reentrant;assert.equal(stops,1);assert.equal(engine.state.status,'stopped');
});

test('Stop rejects a late dispatch callback while the coordinator still owns its lease',async t=>{
 const f=await fixture(t),engine=f.create();await engine.initialize();await engine.stop();assert.equal(engine.lock.held,true,'the owner is still joining work, so its lease alone cannot authorize dispatch');
 const saved=fs.readFileSync(engine.stateFile),events=fs.existsSync(engine.eventsFile)?fs.readFileSync(engine.eventsFile):undefined;
 for(const savedRun of [run(engine.state.tasks[0].id),run('late-planning','propose')])assert.throws(()=>engine.started(savedRun),/stopped before agent dispatch/);
 assert.equal(engine.state.tasks[0].run,undefined);assert.equal(engine.state.proposalRun,undefined);assert.deepEqual(fs.readFileSync(engine.stateFile),saved);assert.deepEqual(fs.existsSync(engine.eventsFile)?fs.readFileSync(engine.eventsFile):undefined,events);
});

test('atomic capacity loss after ready defers implementation without consuming attempts and succeeds when capacity returns',async t=>{
 const f=await fixture(t),{hooks,values}=ownership();values.cleanup='confirmed';const engine=f.create(hooks);await engine.initialize();let available=false;
 f.setBehavior(async(request,start)=>{if(!available)throw new AgentCapacityBusy(request.agent);start(run(request.taskId));return {sessionId:'later-capacity',value:result,output:'',malformed:0};});const task=engine.state.tasks[0];await engine.implement(task);const worktree=task.worktree;assert.equal(task.phase,'queued');assert.equal(task.attempts,0);assert.equal(task.run,undefined);assert.equal(task.commit,undefined);assert.equal(task.startedAt,undefined);
 available=true;await engine.implement(task);assert.equal(task.worktree,worktree);assert.equal(task.attempts,1);assert.equal(task.phase,'review');assert.equal(f.calls.length,2);
});

test('atomic proposal capacity loss leaves no failed input cache or consumed attempt and retries the same input',async t=>{
 const f=await fixture(t,[]),{hooks,values}=ownership();values.cleanup='confirmed';const engine=f.create(hooks);await engine.initialize();let available=false;
 f.setBehavior(async(request,start)=>{if(!available)throw new AgentCapacityBusy('codex');start(run(request.taskId,'propose'));return {sessionId:'later-proposal-capacity',value:{tasks:[]},output:'',malformed:0};});await engine.propose();assert.equal(engine.state.proposalAttempts,0);assert.equal(engine.state.planning,undefined);assert.equal(engine.state.proposalRun,undefined);
 available=true;await engine.propose();assert.equal(engine.state.proposalAttempts,1);assert.equal(JSON.parse(fs.readFileSync(engine.stateFile,'utf8')).planning.outcome,'empty');assert.equal(f.calls.length,2);
});

test('capacity branding cannot exempt model error text, prototype lookalikes or an already-started native run',async t=>{
 assert.equal(isAgentCapacityBusy({name:'AgentCapacityBusy',agent:'codex'},'codex'),false);assert.equal(isAgentCapacityBusy(Object.create(AgentCapacityBusy.prototype),'codex'),false);assert.equal(isAgentCapacityBusy(new AgentCapacityBusy('claude'),'codex'),false);
 const f=await fixture(t),{hooks}=ownership(),engine=f.create(hooks);await engine.initialize();f.setBehavior(async(request,start)=>{start(run(request.taskId));throw new AgentCapacityBusy('codex');});const task=engine.state.tasks[0];await engine.implement(task);assert.equal(task.attempts,1);assert.equal(task.phase,'blocked');assert.ok(task.run);assert.equal(task.ownershipRecovery?.stopped,false);
});

test('reviewer capacity loss preserves the exact implementation without queuing another implementation',async t=>{
 const f=await fixture(t),{hooks,values}=ownership();values.cleanup='confirmed';const engine=f.create(hooks);await engine.initialize();f.setBehavior(async(request,start)=>{start(run(request.taskId));return {sessionId:'impl',value:result,output:'',malformed:0};});const task=engine.state.tasks[0];await engine.implement(task);const commit=task.commit,attempts=task.attempts;f.setBehavior(async()=>{throw new AgentCapacityBusy('claude');});await engine.review(task,'claude');assert.equal(task.phase,'review');assert.equal(task.commit,commit);assert.equal(task.attempts,attempts);assert.equal(task.reviewHistory,undefined);
});

test('capacity-looking model or process error text still consumes its ordinary attempt',async t=>{
 const f=await fixture(t),{hooks,values}=ownership();values.cleanup='confirmed';const engine=f.create(hooks);await engine.initialize();f.setBehavior(async()=>{throw Error('AgentCapacityBusy: provider capacity is busy before dispatch');});const task=engine.state.tasks[0];await engine.implement(task);assert.equal(task.attempts,1);assert.equal(task.phase,'queued');assert.ok(task.error?.includes('AgentCapacityBusy'));
});

test('pre-dispatch capacity loss racing Stop consumes neither implementation nor planning budget',async t=>{
 for(const mode of ['implement','propose']){
  const f=await fixture(t,mode==='implement'?[spec()]:[]),{hooks}=ownership(),engine=f.create(hooks);await engine.initialize();f.setBehavior(async()=>{await engine.stop();throw new AgentCapacityBusy('codex');});
  if(mode==='implement'){await engine.implement(engine.state.tasks[0]);assert.equal(engine.state.tasks[0].attempts,0);assert.equal(engine.state.tasks[0].phase,'blocked');assert.equal(engine.state.tasks[0].run,undefined);}else{await engine.propose();assert.equal(engine.state.proposalAttempts,0);assert.equal(engine.state.planning,undefined);assert.equal(engine.state.proposalRun,undefined);}
  assert.equal(engine.state.status,'stopped');assert.equal(f.calls.length,1);
 }
});
