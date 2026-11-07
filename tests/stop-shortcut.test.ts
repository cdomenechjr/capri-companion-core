import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerStopShortcut,stopAccelerator,stopShortcutFailure,stopShortcutLabel,stopShortcutText} from '../src/desktop/shortcuts';

test('documented Windows Stop shortcut registers once and dispatches each Stop action once',async()=>{
 const registrations:string[]=[];
 let handler:()=>void=()=>assert.fail('No Stop handler registered');
 const calls:string[]=[];
 const workers=[new AbortController(),new AbortController()];
 const status=registerStopShortcut((accelerator,callback)=>{
  registrations.push(accelerator);handler=callback;return true;
 },{
  stopLocal:()=>{calls.push('local');},
  abortWorkers:()=>{calls.push('workers');for(const worker of workers)worker.abort();},
  broadcastStop:()=>{calls.push('broadcast');},
  stopRemote:async()=>{calls.push('remote');throw Error('Fake offline remote');}
 });
 assert.equal(stopAccelerator,'Control+Alt+Shift+X');
 assert.equal(stopShortcutLabel,'Ctrl+Alt+Shift+X');
 // The public core exports a generated README.md in place of the private README.txt; both must document real Stop paths.
 if(process.env.CAPRI_PUBLIC_BUILD==='1'){
  const readme=readFileSync('README.md','utf8');
  assert.ok(readme.includes(stopShortcutLabel+', Stop and the tray Stop action cancel'));
  assert.match(readme,/If the shortcut cannot register, use the visible Stop controls/);
 }else assert.ok(readFileSync('README.txt','utf8').includes(stopShortcutLabel+', Stop and the tray'));
 assert.deepEqual(registrations,[stopAccelerator]);
 assert.deepEqual(status,{registered:true});
 assert.equal(stopShortcutText(status),stopShortcutLabel);
 assert.deepEqual(calls,[],'registration must not run Stop');
 handler();
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['local','workers','broadcast','remote']);
 assert.ok(workers.every(worker=>worker.signal.aborted));
});

test('false and thrown registration failures report an actionable fallback without running Stop',()=>{
 for(const failure of ['false','throw']){
  let registrations=0;
  const unexpected=()=>assert.fail('Registration failure must not run Stop');
  const status=registerStopShortcut(accelerator=>{
   registrations++;assert.equal(accelerator,stopAccelerator);
   if(failure==='throw')throw Error('Private platform diagnostics');
   return false;
  },{stopLocal:unexpected,abortWorkers:unexpected,broadcastStop:unexpected,stopRemote:async()=>unexpected()});
  assert.equal(registrations,1);
  assert.deepEqual(status,{registered:false});
  assert.equal(stopShortcutText(status),stopShortcutFailure);
  assert.match(stopShortcutFailure,/Ctrl\+Alt\+Shift\+X could not be registered/);
  assert.match(stopShortcutFailure,/Use Stop in Capri or the tray/);
  assert.match(stopShortcutFailure,/restart Capri to retry/);
  assert.doesNotMatch(stopShortcutFailure,/Private platform diagnostics/);
 }
 assert.match(stopShortcutText(),/availability unconfirmed/);
});

test('desktop and UI wire the shared shortcut, preserve Talk, and retain visible failure status',()=>{
 const desktop=readFileSync('src/desktop/main.ts','utf8');
 const ui=readFileSync('src/ui/main.tsx','utf8');
 assert.equal((desktop.match(/registerStopShortcut\(/g)||[]).length,1);
 assert.doesNotMatch(desktop,/globalShortcut\.register\([^\n]*Escape/);
 assert.match(desktop,/globalShortcut\.register\('CommandOrControl\+Shift\+Space'/);
 assert.match(desktop,/if\(action==='stopShortcut'\)return stopShortcut/);
 assert.match(ui,/agency\('stopShortcut'\)\.then\(setStopShortcut\)/);
 assert.match(ui,/stopShortcut\?\.registered===false&&<div className="error-banner" role="alert">\{stopShortcutFailure\}/);
 assert.match(ui,/title=\{'Stop tasks, voice, and wake listening \('\+stopShortcutText\(stopShortcut\)/);
 assert.doesNotMatch(ui,/Ctrl\+Shift\+Esc/);
});
