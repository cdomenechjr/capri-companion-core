import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {Coordinator,control} from '../tools/coordinator/engine';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {Config} from '../tools/coordinator/types';

const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../tools/coordinator/cli.ts');
function fixture(t:any){
 const temp=fs.realpathSync.native(os.tmpdir()),base=fs.realpathSync.native(fs.mkdtempSync(path.join(temp,'capri-stop-intent-'))),repo=path.join(base,'repo');fs.mkdirSync(repo);
 t.after(()=>{assert.equal(path.dirname(base),temp);assert.ok(path.basename(base).startsWith('capri-stop-intent-'));assert.equal(fs.lstatSync(base).isSymbolicLink(),false);fs.rmSync(base,{recursive:true,force:true});});
 execFileSync('git',['init','-b','main'],{cwd:repo,windowsHide:true,stdio:'pipe'});fs.writeFileSync(path.join(repo,'baseline.txt'),'baseline\n');execFileSync('git',['add','baseline.txt'],{cwd:repo,windowsHide:true});execFileSync('git',['-c','user.name=Capri Test','-c','user.email=capri-test@localhost','commit','-m','fixture'],{cwd:repo,windowsHide:true,stdio:'pipe'});
 const stateDir=path.join(base,'runtime'),spec=path.join(base,'tasks.json'),file=path.join(base,'config.json');fs.mkdirSync(stateDir);fs.writeFileSync(spec,'[]');
 const config:Config={version:1,repo,developmentRoot:base,stateDir,worktreeRoot:path.join(base,'worktrees'),profileRoot:path.join(base,'profiles'),referenceRoot:path.join(base,'reference'),candidateBranch:'codex/candidate',tasksFile:spec,prompts:{master:path.join(base,'master'),codex:path.join(base,'codex'),claude:path.join(base,'claude'),review:path.join(base,'review')},checks:[{id:'check',command:process.execPath,args:['-e','process.exit(0)']}],agents:{codex:{command:process.execPath},claude:{command:process.execPath}},continuous:false,timeoutMs:10000,maxRepairAttempts:1,pollMs:1,maxProposalsPerCycle:1,maxQueuedTasks:2,proposalAllowedPaths:['src/'],roadmapFile:path.join(base,'roadmap')};
 fs.writeFileSync(file,JSON.stringify(config));return {base,repo,stateDir,config,file,intent:path.join(stateDir,'operator-stop.json')};
}
function invoke(file:string,...args:string[]){return spawnSync(process.execPath,['--import','tsx',cli,...args,'--config',file],{encoding:'utf8',windowsHide:true,timeout:30000});}
test('ordinary Stop durably records user intent even after natural exit without rewriting progress',async t=>{
 const f=fixture(t),engine=new Coordinator(f.config,()=>{});await engine.run(true);const before=fs.readFileSync(engine.stateFile,'utf8');
 const first=invoke(f.file,'stop');assert.equal(first.status,0,first.stderr);assert.match(first.stdout,/already stopped/);const one=JSON.parse(fs.readFileSync(f.intent,'utf8'));assert.equal(one.version,1);assert.ok(one.id);assert.ok(Number.isFinite(Date.parse(one.at)));assert.equal(fs.readFileSync(engine.stateFile,'utf8'),before);
 const second=invoke(f.file,'stop');assert.equal(second.status,0,second.stderr);assert.notEqual(JSON.parse(fs.readFileSync(f.intent,'utf8')).id,one.id);assert.equal(fs.readFileSync(engine.stateFile,'utf8'),before);
});
test('release quiescence does not fabricate user Stop and cannot clear a real one',async t=>{
 const f=fixture(t);const stopped=invoke(f.file,'stop','--release-quiesce');assert.equal(stopped.status,0,stopped.stderr);assert.equal(fs.existsSync(f.intent),false);
 fs.writeFileSync(f.intent,'{"version":1,"id":"manual-stop"}');const before=fs.readFileSync(f.intent,'utf8');
 const start=invoke(f.file,'start','--release-quiesce','--once');assert.notEqual(start.status,0);assert.match(start.stderr,/Explicit operator Stop/);assert.equal(fs.readFileSync(f.intent,'utf8'),before);assert.equal(fs.existsSync(f.config.worktreeRoot),false);
});
test('a delayed daemon child honors a newer Stop under the coordinator lease',async t=>{
 const f=fixture(t);fs.writeFileSync(f.intent,'{"version":1,"id":"newer-stop"}');
 const child=invoke(f.file,'start','--coordinator-child','--once');assert.notEqual(child.status,0);assert.match(child.stderr,/Explicit operator Stop/);assert.equal(JSON.parse(fs.readFileSync(f.intent,'utf8')).id,'newer-stop');assert.equal(fs.existsSync(f.config.worktreeRoot),false);assert.equal(fs.existsSync(path.join(f.stateDir,'coordinator.lock')),false);
});
test('explicit user start clears prior Stop and runs the preserved empty queue',async t=>{
 const f=fixture(t);fs.writeFileSync(f.intent,'{"version":1,"id":"previous-stop"}');const result=invoke(f.file,'start','--once');assert.equal(result.status,0,result.stderr);assert.equal(fs.existsSync(f.intent),false);assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir,'state.json'),'utf8')).status,'stopped');
});
test('durable Stop preempts a live pending resume instead of losing to its occupied control slot',async t=>{
 const f=fixture(t),engine=new Coordinator(f.config,()=>{});await engine.initialize();let stops=0;engine.processes={children:new Map(),stop:async()=>{stops++;}} as any;
 try{control(f.config,'resume');const stop=invoke(f.file,'stop');assert.equal(stop.status,0,stop.stderr);assert.match(stop.stdout,/durable operator Stop/);engine.consumeControl();assert.equal(engine.stopping,true);assert.equal(engine.abort.signal.aborted,true);assert.equal(engine.state.status,'stopped');assert.equal(stops,1);assert.equal(fs.existsSync(engine.controlFile),false);engine.consumeControl();assert.equal(stops,1);assert.equal(fs.existsSync(f.intent),true);}finally{engine.lock.release();}
});
test('an internal resume child cannot clear durable Stop while a coordinator is already live',async t=>{
 const f=fixture(t),engine=new Coordinator(f.config,()=>{});await engine.initialize();try{fs.writeFileSync(f.intent,'{"version":1,"id":"active-stop"}');const child=invoke(f.file,'resume','--coordinator-child');assert.notEqual(child.status,0);assert.match(child.stderr,/Explicit operator Stop/);assert.equal(fs.existsSync(engine.controlFile),false);assert.equal(JSON.parse(fs.readFileSync(f.intent,'utf8')).id,'active-stop');}finally{engine.lock.release();}
});
for(const signal of ['SIGINT','SIGTERM'])test('foreground '+signal+' records operator intent through its registered CLI handler',async t=>{
 const f=fixture(t),bootstrap=path.join(f.base,'signal.mjs');
 fs.writeFileSync(bootstrap,"const [cli,config,signal]=process.argv.slice(2);const once=process.once;process.once=function(event,callback){const result=once.call(this,event,callback);if(event===signal)setImmediate(()=>process.emit(signal));return result;};process.argv=[process.execPath,cli,'start','--once','--config',config];await import("+JSON.stringify(pathToFileURL(cli).href)+");");
 const result=spawnSync(process.execPath,['--import','tsx',bootstrap,cli,f.file,signal],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(fs.readFileSync(f.intent,'utf8')).version,1);
});
