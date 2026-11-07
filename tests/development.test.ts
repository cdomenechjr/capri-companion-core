import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,realpathSync} from 'node:fs';
import {mkdtemp,appendFile,rm,writeFile,mkdir,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {normalizeAgentActivity,redactActivity} from '../src/development';
import {runtimeProfile} from '../src/desktop/runtime-profile';
import {watchDevelopmentActivity} from '../src/desktop/development-activity';
function powershellExecutable() {
  const preferred = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)
    .filter(Boolean).map(directory => path.join(directory.replace(/^"|"$/g, ''), 'pwsh.exe'))
    .find(candidate => existsSync(candidate));
  return preferred ?? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
const activity={id:'one',agent:'claude',sessionId:'session',taskId:'animation',project:'Capri',kind:'working',summary:'Testing motion',at:new Date().toISOString()};
test('agent events validate identity and redact secrets without changing permissions',()=>{
  assert.equal(normalizeAgentActivity(activity)?.agent,'claude');assert.equal(normalizeAgentActivity({...activity,agent:'browser'}),undefined);
  assert.equal(normalizeAgentActivity({...activity,at:'no'}),undefined);assert.equal(normalizeAgentActivity({...activity,taskId:''}),undefined);
  assert.ok(!redactActivity('api_key=abc123456 token:other Bearer hiddenvalue sk-example123456789').includes('abc123456'));
});
test('development profile never aliases the installed profile and ports are bounded',()=>{
  const root=path.resolve('fixture-appdata');assert.equal(runtimeProfile(root,{}).development,false);
  assert.throws(()=>runtimeProfile(root,{CAPRI_PROFILE_DIR:path.join(root,'capri-companion')}),/separate/);
  assert.throws(()=>runtimeProfile(root,{CAPRI_DEV_PORT:'NaN'}),/port/);assert.throws(()=>runtimeProfile(root,{CAPRI_PROFILE_DIR:'relative'}),/absolute/);
  assert.equal(runtimeProfile(root,{CAPRI_PROFILE_DIR:path.resolve('fixture-profile'),CAPRI_DEV_PORT:'43101'}).port,43101);
});
test('activity tail handles partial lines, duplicates, invalid data and rotation',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'capri-activity-'));const file=path.join(directory,'events.jsonl');await writeFile(file,'');const received:string[]=[];
  const stop=watchDevelopmentActivity(file,e=>received.push(e.id),10);
  try {await appendFile(file,JSON.stringify(activity).slice(0,30));await new Promise(r=>setTimeout(r,30));assert.deepEqual(received,[]);
    await appendFile(file,JSON.stringify(activity).slice(30)+'\n'+JSON.stringify(activity)+'\nnot json\n');
    for(let i=0;i<50&&!received.length;i++)await new Promise(r=>setTimeout(r,10));assert.deepEqual(received,['one']);
    await writeFile(file,'');await new Promise(r=>setTimeout(r,30));await appendFile(file,JSON.stringify({...activity,id:'two'})+'\n');
    for(let i=0;i<50&&received.length<2;i++)await new Promise(r=>setTimeout(r,10));assert.deepEqual(received,['one','two']);
  }finally{stop();await rm(directory,{recursive:true,force:true});}
});

test('candidate launcher parses without changing PowerShell execution policy', {skip:process.platform !== 'win32'}, async () => {
  const script = path.resolve('scripts/launch-candidate.ps1');
  const source = await readFile(script, 'utf8');
  assert.doesNotMatch(source, /ExecutionPolicy|Invoke-Expression|ScriptBlock::Create/i);
  const powershell = powershellExecutable();
  // Parsing reads syntax only; it neither executes the launcher nor overrides policy.
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `
    $tokens=$null
    $parseErrors=$null
    $null=[System.Management.Automation.Language.Parser]::ParseFile('${script.replace(/'/g, "''")}',[ref]$tokens,[ref]$parseErrors)
    if($parseErrors.Count){Write-Error ($parseErrors | Out-String);exit 1}
  `], {encoding:'utf8', timeout:15000, windowsHide:true});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('candidate launcher uses only the pinned packaged snapshot and rejects unsafe pointers', {skip:process.platform !== 'win32'}, async t => {
  const root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'capri-launch-fixture-')));
  const deliverables = path.join(root, 'deliverables');
  const checkout = path.join(root, 'worktrees', 'candidate');
  const script = path.join(checkout, 'scripts', 'launch-candidate.ps1');
  const metadata = path.join(deliverables, 'current-candidate.json');
  const executable = path.join(deliverables, 'verified-snapshot', 'win-unpacked', 'Capri.exe');
  const pointer = {executablePath:'verified-snapshot/win-unpacked/Capri.exe', version:'0.6.0-dev.1', commit:'a'.repeat(40)};
  const powershell = powershellExecutable();
  // Intercept process creation: no Electron, installer, registry or real profile is used.
  const command = `function Start-Process { param($FilePath,$WorkingDirectory,$WindowStyle)
    'CAPRI_LAUNCH_CAPTURE '+(@{filePath=$FilePath;workingDirectory=$WorkingDirectory;windowStyle=$WindowStyle;profile=$env:CAPRI_PROFILE_DIR;port=$env:CAPRI_DEV_PORT;activity=$env:CAPRI_AGENT_ACTIVITY_FILE}|ConvertTo-Json -Compress)
  }
  & '${script.replace(/'/g, "''")}'`;
  const launch = () => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {encoding:'utf8', timeout:15000, windowsHide:true});
  const writePointer = (value:object) => writeFile(metadata, JSON.stringify(value));
  const reject = (pattern:RegExp) => {
    const result = launch();
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stdout, /CAPRI_LAUNCH_CAPTURE/);
  };
  try {
    await mkdir(path.dirname(script), {recursive:true});
    await writeFile(script, await readFile(path.resolve('scripts/launch-candidate.ps1')));
    await mkdir(path.join(path.dirname(executable), 'resources'), {recursive:true});
    await writeFile(executable, 'fake executable, never run');
    await writeFile(path.join(path.dirname(executable), 'resources', 'app.asar'), 'fake package');
    // A moving worktree build exists but cannot serve as a fallback.
    await mkdir(path.join(checkout, 'dist'));
    await writeFile(path.join(checkout, 'dist', 'main.cjs'), 'moving build');
    await t.test('missing verification pointer', () => reject(/No verified packaged candidate/));
    await t.test('pinned snapshot and isolated environment', async () => {
      await writePointer(pointer);
      const result = launch();
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('CAPRI_LAUNCH_CAPTURE '));
      assert.ok(line);
      assert.deepEqual(JSON.parse(line.slice('CAPRI_LAUNCH_CAPTURE '.length)), {
        filePath:executable, workingDirectory:path.dirname(executable), windowStyle:'Hidden',
        profile:path.join(root, 'profiles', 'candidate-preview'), port:'18700', activity:path.join(root, 'runtime', 'coordinator', 'activity.jsonl')
      });
      assert.match(result.stdout, new RegExp(pointer.commit));
      assert.ok(result.stdout.includes(pointer.version));
    });
    for (const [name, value, pattern] of [
      ['parent escape', {...pointer, executablePath:'../outside/Capri.exe'}, /escapes deliverables/],
      ['absolute path', {...pointer, executablePath:executable}, /relative executable path/],
      ['alternate stream', {...pointer, executablePath:'snapshot/Capri.exe:stream'}, /relative executable path/],
      ['missing executable', {...pointer, executablePath:'missing/Capri.exe'}, /executable is missing/],
      ['missing version', {...pointer, version:undefined}, /version and full Git commit/],
      ['missing commit', {...pointer, commit:undefined}, /version and full Git commit/],
      ['invalid commit', {...pointer, commit:'candidate'}, /version and full Git commit/]
    ] as const) await t.test(name, async () => {await writePointer(value); reject(pattern);});
    await t.test('installer is never launched', async () => {
      await writeFile(path.join(deliverables, 'Capri-Setup.exe'), 'fake installer');
      await writePointer({...pointer, executablePath:'Capri-Setup.exe'});
      reject(/not an installer or worktree build/);
    });
    await t.test('junction cannot escape deliverables', async () => {
      const outside = path.join(root, 'outside-package');
      await mkdir(outside);
      await writeFile(path.join(outside, 'Capri.exe'), 'fake executable');
      await symlink(outside, path.join(deliverables, 'redirect'), 'junction');
      await writePointer({...pointer, executablePath:'redirect/Capri.exe'});
      reject(/must not contain aliases or junctions/);
    });
  } finally { await rm(root, {recursive:true, force:true}); }
});
