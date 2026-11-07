import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {defaultExtensionSettings,SecurityJobSchema} from '../src/extensions/contracts';
import {SecurityTools,SecurityScheduler,securityOutcome,validateSecurityTarget,
  type DefenderObservation,type SecurityHost,type SecurityJournal,type SecurityJournalRecord,
  type SecurityRequest,type SecurityScheduleContext} from '../src/extensions/security';

const request:SecurityRequest={taskId:'task-1',requestId:'request-1',operation:'quick-scan'};
const signal=()=>new AbortController().signal;
// Fake per-user Windows paths, joined from parts so the public export's home-path scanner stays strict.
const fakeUserPath=(...parts:string[])=>['C:','Users',...parts].join('\\');
const health={available:true,mode:'normal' as const,antivirusEnabled:true,realTimeProtection:true,serviceEnabled:true,
  signaturesOutOfDate:false,signatureVersion:'1.2.3',signatureUpdatedAt:1000,firewallEnabled:true,pendingReboot:false,startupEntryCount:3};
const observation=(patch:Partial<DefenderObservation>={}):DefenderObservation=>({requestId:request.requestId,
  operation:'quick-scan',phase:'returned',scan:{recordId:'event-50',scanId:'scan-1',completed:true,cancelled:false,
    correlated:true,exclusiveWindow:true},detections:[],detectionsComplete:true,...patch});
class Journal implements SecurityJournal {
  records=new Map<string,SecurityJournalRecord>();
  async claim(key:string,value:SecurityJournalRecord){if(this.records.has(key))return false;this.records.set(key,structuredClone(value));return true;}
  async read(key:string){return structuredClone(this.records.get(key));}
  async save(key:string,value:SecurityJournalRecord){this.records.set(key,structuredClone(value));}
}
function setup(invoke:SecurityHost['invoke']=async()=>observation(),platform='win32',journal=new Journal()){
  const calls:{operation:string;input:unknown}[]=[];
  const host:SecurityHost={platform,invoke:async(operation,input,s)=>{calls.push({operation,input});return invoke(operation,input,s);}};
  let sequence=0;
  return {tools:new SecurityTools(host,journal,{now:()=>2000,localDate:n=>new Date(n)},()=>`id-${++sequence}`),calls,journal};
}
const outcome=(o:unknown,operation:SecurityRequest['operation']='quick-scan')=>securityOutcome(operation,o,request.requestId);
test('clean scan requires matching event completion and complete detection read, never exit zero',()=>{
  assert.equal(outcome(observation()),'no-detection');
  for(const raw of [{exitCode:0},observation({scan:undefined}),observation({detectionsComplete:false}),
    observation({requestId:'other'}),observation({operation:'full-scan'}),observation({phase:'not-dispatched'})])
    assert.equal(outcome(raw),'uncertain');
  for(const change of [{correlated:false},{exclusiveWindow:false},{completed:false}])
    assert.equal(outcome(observation({scan:{...observation().scan!,...change}})),'uncertain');
});
test('threat outcomes distinguish remediation, action required and uncertain actions',()=>{
  assert.equal(outcome(observation({detections:[{id:'d1',action:'remediated'}]})),'remediated');
  assert.equal(outcome(observation({detections:[{id:'d1',action:'remediated'},{id:'d2',action:'action-required'}]})),'action-required');
  assert.equal(outcome(observation({detections:[{id:'d1',action:'uncertain'}]})),'uncertain');
  assert.equal(outcome(observation({scan:{...observation().scan!,completed:false,cancelled:true}})),'cancelled');
});

test('a correlated failed scan is a failure with its record, never a clean or ambiguous result',async()=>{
  const failed=observation({scan:{...observation().scan!,completed:false,failed:true}});
  assert.equal(outcome(failed),'failed');
  for(const change of [{correlated:false},{exclusiveWindow:false}])
    assert.equal(outcome({...failed,scan:{...failed.scan!,...change}}),'uncertain');
  assert.equal(outcome({...failed,requestId:'unrelated'}),'uncertain');
  const {tools}=setup(async()=>failed);
  const job=await tools.run(request,signal());
  assert.equal(job.state,'failed');assert.equal(job.evidence[0].outcome,'failed');
  assert.equal(job.evidence[0].recordId,'event-50');
});
test('observed threat evidence retains the native record reference with a private summary',async()=>{
  const {tools}=setup(async()=>observation({detections:[{id:'detection-1',action:'action-required'}]}));
  const job=await tools.run(request,signal());
  assert.equal(job.evidence[0].recordId,'detection-1');assert.equal(job.evidence[0].outcome,'action-required');
});
test('absence, passive mode, disabled protection, permission failures and unknown dispatch stay honest',()=>{
  for(const error of ['unavailable','access-denied','busy'] as const){
    assert.equal(outcome(observation({phase:'not-dispatched',error})),'unavailable');
    assert.equal(outcome(observation({phase:'returned',error})),'uncertain');
  }
  for(const mode of ['passive','disabled','unknown'] as const)
    assert.equal(outcome(observation({operation:'status',health:{...health,mode}}),'status'),'unavailable');
  assert.equal(outcome(observation({operation:'status',health:{...health,available:false}}),'status'),'unavailable');
  assert.equal(outcome(observation({operation:'status',health:{...health,realTimeProtection:false}}),'status'),'findings');
  assert.equal(outcome(observation({phase:'not-dispatched',error:'invalid-target'})),'failed');
});
test('health is read-only evidence, missing fields cannot imply healthy, definitions require read-back',()=>{
  const status=observation({operation:'status',health,scan:undefined});
  assert.equal(outcome(status,'status'),'healthy');
  for(const changed of [{signaturesOutOfDate:null},{signaturesOutOfDate:true},{firewallEnabled:null},{pendingReboot:true}])
    assert.equal(outcome({...status,health:{...health,...changed}},'status'),'findings');
  assert.equal(outcome({...status,detectionsComplete:false},'status'),'findings');
  assert.equal(outcome(observation({operation:'update-signatures'}),'update-signatures'),'uncertain');
  assert.equal(outcome(observation({operation:'update-signatures',signatureUpdateVerified:true}),'update-signatures'),'healthy');
});
test('custom paths permit literal local punctuation and reject device, remote, wildcard, ADS and traversal paths',()=>{
  assert.equal(validateSecurityTarget("C:\\Files\\O'Brien; $(text).zip"),"C:\\Files\\O'Brien; $(text).zip");
  assert.equal(validateSecurityTarget('D:\\'),'D:\\');
  for(const value of ['relative.exe','C:relative','\\\\server\\share','\\\\?\\C:\\x','C:\\file:stream',
    'C:\\*.exe','C:\\a\\..\\b','C:\\a\\.\\b','C:\\a.','C:\\CON.txt','C:\\lpt1','C:/a','C:\\a\nname','C:\\a"b'])
    assert.throws(()=>validateSecurityTarget(value),TypeError,value);
});
test('quick, explicit full, file and folder scans dispatch only the fixed operation with scoped target',async()=>{
  for(const [index,operation,target] of [[0,'quick-scan',undefined],[1,'full-scan',undefined],
    [2,'custom-scan','C:\\Files\\installer.exe'],[3,'custom-scan','C:\\Files']] as const){
    const id=`request-${index}`;
    const {tools,calls}=setup(async()=>observation({requestId:id,operation}));
    const result=await tools.run({...request,requestId:id,operation,...(target?{target,targetId:'target-1'}:{})},signal());
    assert.equal(result.state,'completed');assert.equal(result.evidence[0].outcome,'no-detection');
    assert.deepEqual(calls,[{operation,input:{requestId:id,...(target?{target}:{})}}]);
    assert.equal(SecurityJobSchema.safeParse(result).success,true);
  }
});
test('malformed or authority-bearing input never dispatches, and unsupported platforms report unavailable',async()=>{
  const {tools,calls}=setup();
  for(const value of [{...request,approved:true},{...request,operation:'disable-protection'},
    {...request,target:'C:\\Files'},{...request,operation:'custom-scan'},
    {...request,operation:'custom-scan',target:'\\\\host\\share'}])
    await assert.rejects(()=>tools.run(value as SecurityRequest,signal()));
  assert.equal(calls.length,0);
  const unsupported=setup(undefined,'linux');
  assert.equal((await unsupported.tools.run(request,signal())).evidence[0].outcome,'unavailable');
  assert.equal(unsupported.calls.length,0);
});
test('durable request claims deduplicate across restarts and reject changed targets or task identities',async()=>{
  const a=setup();const custom={...request,operation:'custom-scan' as const,target:'C:\\one.exe'};
  const job=await a.tools.run(custom,signal());
  const b=setup(undefined,'win32',a.journal);
  assert.deepEqual(await b.tools.run(custom,signal()),job);assert.equal(b.calls.length,0);
  await assert.rejects(()=>b.tools.run({...custom,target:'C:\\two.exe'},signal()),/conflict/);
  await assert.rejects(()=>b.tools.run({...custom,taskId:'task-2'},signal()),/conflict/);
  // Interrupted jobs stay pending/running; reading them never launches a retry.
  a.journal.records.get('security-request:request-1')!.job.state='running';
  assert.equal((await b.tools.run(custom,signal())).state,'running');assert.equal(b.calls.length,0);
});
test('concurrent duplicate requests dispatch at most once, including different module instances',async()=>{
  const journal=new Journal();let complete!:(v:unknown)=>void;
  const a=setup(()=>new Promise(resolve=>{complete=resolve;}),'win32',journal),b=setup(undefined,'win32',journal);
  const pending=a.tools.run(request,signal());
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await b.tools.run(request,signal())).state,'running');
  complete(observation());await pending;assert.equal(a.calls.length+b.calls.length,1);
});
test('Stop is task-scoped, returns without a cooperative host, never cancels unrelated engine work or replays',async()=>{
  const aborts:string[]=[];let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
  const {tools,calls}=setup(async(_op,_input,s)=>{s.addEventListener('abort',()=>aborts.push('monitor'));started();return new Promise(()=>{});});
  const pending=tools.run(request,signal());await ready;
  tools.stop('other-task');assert.deepEqual(aborts,[]);
  tools.stop('task-1');const job=await pending;
  assert.equal(job.state,'unconfirmed');assert.equal(job.evidence[0].outcome,'unconfirmed');
  assert.match(job.evidence[0].summary,/engine may continue/);assert.deepEqual(aborts,['monitor']);
  assert.deepEqual(await tools.run(request,signal()),job);assert.equal(calls.length,1);
});
test('abort before dispatch has no host effect; transport failures after dispatch stay unconfirmed',async()=>{
  const {tools,calls}=setup();const controller=new AbortController();controller.abort();
  assert.equal((await tools.run(request,controller.signal)).state,'cancelled');assert.equal(calls.length,0);
  const bad=setup(async()=>{throw new Error('ACCESS DENIED '+fakeUserPath('PrivateProject')+' token=secret');});
  const job=await bad.tools.run(request,signal());
  assert.equal(job.state,'unconfirmed');assert.doesNotMatch(JSON.stringify(job),/PrivateProject|secret|ACCESS DENIED/);
});
test('Stop while a durable claim is pending prevents subsequent dispatch',async()=>{
  const journal=new Journal();const original=journal.claim.bind(journal);
  let release!:()=>void,started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
  journal.claim=async(key,value)=>{started();await new Promise<void>(resolve=>{release=resolve;});return original(key,value);};
  const {tools,calls}=setup(undefined,'win32',journal);
  const job=tools.run(request,signal());await ready;tools.stop('task-1');release();
  assert.equal((await job).state,'cancelled');assert.equal(calls.length,0);
});
test('read-only health inspection exposes definition facts and fixed recommendations without update effects',async()=>{
  const h={...health,firewallEnabled:false,signaturesOutOfDate:true,pendingReboot:true};
  const {tools,calls}=setup(async()=>observation({requestId:'health-1',operation:'status',health:h}));
  const result=await tools.inspect('health-1',signal());
  assert.equal(result.outcome,'findings');assert.deepEqual(result.health,h);
  assert.ok(result.recommendations.some(r=>r.includes('firewall')));
  assert.ok(result.recommendations.some(r=>r.includes('updates')));
  assert.ok(result.recommendations.some(r=>r.includes('startup')));
  assert.deepEqual(calls,[{operation:'status',input:{requestId:'health-1'}}]);
});
test('owned scan gate rejects overlapping scan monitoring but permits read-only health work',async()=>{
  let ready!:()=>void;const started=new Promise<void>(r=>{ready=r;});
  const {tools,calls}=setup(async(op,input)=>{if(op==='status')return observation({requestId:input.requestId,operation:'status',health});ready();return new Promise(()=>{});});
  const first=tools.run(request,signal());await started;
  assert.equal((await tools.run({...request,requestId:'r2',operation:'full-scan'},signal())).evidence[0].outcome,'unavailable');
  assert.equal((await tools.run({...request,requestId:'r3',operation:'status'},signal())).state,'completed');
  tools.stop();await first;assert.equal(calls.length,2);
});
test('private alert summaries exclude path, threat identity, task identity and untrusted native fields',async()=>{
  const privateRequest={...request,taskId:'secret-project',operation:'custom-scan' as const,target:fakeUserPath('Private','file.exe')};
  const {tools}=setup(async()=>({...observation(),resources:['C:\\Private'],message:'<script>private</script>'}));
  const result=await tools.run(privateRequest,signal());
  assert.equal(result.evidence[0].outcome,'uncertain');
  assert.doesNotMatch(result.evidence[0].summary,/Private|secret-project|file.exe|script/);
  assert.equal(result.targetId,undefined); // Raw path is not persisted in the job.
});

const scheduleContext:SecurityScheduleContext={settings:defaultExtensionSettings().security,profile:'user',
  hostAvailable:true,active:false,gameDocked:false,quiet:false};
function schedule(){
  let date=new Date(2026,10,5,9,0);const days=new Set<string>();const dispatched:string[]=[];
  const scheduler=new SecurityScheduler({async claimOccurrence(day){if(days.has(day))return false;days.add(day);return true;}},
    {now:()=>date.getTime(),localDate:()=>new Date(date)});
  return {scheduler,days,dispatched,setDate:(d:Date)=>{date=d;},tick:(ctx=scheduleContext)=>scheduler.tick(ctx,async item=>{assert.equal(item.operation,'quick-scan');dispatched.push(item.occurrence);})};
}
test('owner-selected daily 09:00 quick schedule is default; development/self-test and opt-out never scan',async()=>{
  assert.equal(scheduleContext.settings.dailyQuickScan,true);assert.equal(scheduleContext.settings.localHour,9);
  const s=schedule();
  for(const profile of ['development','self-test'] as const)assert.equal(await s.tick({...scheduleContext,profile}),'non-user-profile');
  for(const settings of [{...scheduleContext.settings,enabled:false},{...scheduleContext.settings,dailyQuickScan:false}])
    assert.equal(await s.tick({...scheduleContext,settings}),'disabled');
  assert.deepEqual(s.dispatched,[]);assert.equal(await s.tick(),'dispatched');assert.deepEqual(s.dispatched,['2026-11-05']);
});
test('scheduling defers activity, gaming, quiet use and unavailable hosts, with bounded same-day catch-up',async()=>{
  const s=schedule();s.setDate(new Date(2026,10,5,8,59));assert.equal(await s.tick(),'not-due');
  s.setDate(new Date(2026,10,5,9));
  for(const state of [{active:true},{gameDocked:true},{quiet:true}])assert.equal(await s.tick({...scheduleContext,...state}),'deferred');
  assert.equal(await s.tick({...scheduleContext,hostAvailable:false}),'unavailable');
  assert.equal(s.days.size,0);s.setDate(new Date(2026,10,5,20,59));assert.equal(await s.tick(),'dispatched');
  s.setDate(new Date(2026,10,6,21));assert.equal(await s.tick(),'not-due');
  s.setDate(new Date(2026,10,7,9));assert.equal(await s.tick(),'dispatched');
  assert.deepEqual(s.dispatched,['2026-11-05','2026-11-07']);
});
test('durable local-day claims deduplicate concurrent ticks, clock rollback and failed dispatch without retries',async()=>{
  const s=schedule();const results=await Promise.all([s.tick(),s.tick()]);assert.deepEqual(results,['dispatched','already-claimed']);
  s.setDate(new Date(2026,10,5,10));assert.equal(await s.tick(),'already-claimed');
  s.setDate(new Date(2026,10,6,9));
  assert.equal(await s.scheduler.tick(scheduleContext,async()=>{throw Error('lost');}),'unconfirmed');
  assert.equal(await s.tick(),'already-claimed');
  s.setDate(new Date(2026,10,5,9));assert.equal(await s.tick(),'already-claimed');
});
// Git may check out the C# raw string with CRLF. Normalize only this read-only
// fixture copy; production source/transport encoding remains untouched.
function readNativeSource():string {
  return readFileSync('native/Security.cs','utf8').replace(/\r\n/g,'\n');
}

function nativeScript(source:string):string {
  const normalized=source.replace(/\r\n/g,'\n'),marker='private const string Script="""\n';
  const start=normalized.indexOf(marker),end=normalized.indexOf('\n""";');
  assert.ok(start>=0,'Native raw script start boundary must exist');
  assert.ok(end>start,'Native raw script end must follow start');
  assert.equal(normalized.indexOf(marker,start+marker.length),-1,'Unique native raw script');
  return normalized.slice(start+marker.length,end);
}

// This deny guard is checked in JS before starting PowerShell. The dispatcher
// fixture also AST-allowlists every command before executing its script block.
const forbiddenNativeCommands=/Defender\\|NetSecurity\\|\b(?:Import-Module|Join-Path|Get-Mp\w+|Start-MpScan|Update-MpSignature|Get-CimInstance|Get-WinEvent|Get-Process|Get-Item|Test-Path|Wait-Job|Receive-Job|Get-Date|Start-Sleep|Stop-MpScan|CancelScan|MpCmdRun|Stop-Job|Invoke-Expression|Invoke-Command|Start-Process)\b/i;
function syntheticDispatcher(source:string):string {
  let script=nativeScript(source);
  const start=script.indexOf('function Health {'),end=script.indexOf('function ReadDefenderEvents(');
  assert.ok(start>=0&&end>start,'Bounded native health/detection replacement');
  script=script.slice(0,start)+script.slice(end);
  // Remove source comments from the executable fixture so forbidden tokens in
  // the production safety comments cannot mask an actual command occurrence.
  script=script.replace(/^\s*#.*$/gm,'');
  const replace=(from:string,to:string,count:number)=>{
    assert.equal(script.split(from).length-1,count,`Bound synthetic entry point: ${from}`);
    script=script.split(from).join(to);
  };
  replace('$inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json','$inputData=$script:dispatchInput',1);
  replace("Import-Module -Name (Join-Path $PSHOME 'Modules\\Defender\\Defender.psd1') -ErrorAction Stop",'SyntheticImportModule',1);
  replace('=Health','=SyntheticHealth',2);
  replace('@(Detections ','@(SyntheticDetections ',2);
  for(const [from,to,count] of [
    ['Defender\\Start-MpScan','SyntheticStartScan',3],
    ['Defender\\Update-MpSignature','SyntheticUpdateSignatures',1],
    ['Get-CimInstance','SyntheticCim',1],['Get-WinEvent','SyntheticEvents',1],
    ['Get-Process','SyntheticProcess',3],['Get-Item','SyntheticTarget',2],
    ['Wait-Job','SyntheticWait',1],['Receive-Job','SyntheticReceive',1],
    ['Get-Date','SyntheticClock',4],['Start-Sleep','SyntheticSleep',1],
  ] as const)replace(from,to,count);
  assert.doesNotMatch(script,forbiddenNativeCommands,'No reachable real native/provider command');
  return script;
}

test('dispatcher fixture bounds LF/CRLF extraction and rejects unmocked native entry points',()=>{
  const source=readNativeSource(),fixture=syntheticDispatcher(source);
  assert.equal(syntheticDispatcher(source.replace(/\n/g,'\r\n')),fixture);
  assert.throws(()=>syntheticDispatcher(source.replace('private const string Script="""\n','')),/start boundary/);
  assert.throws(()=>syntheticDispatcher(source.replace('\n""";','')),/end must follow/);
  assert.throws(()=>syntheticDispatcher('\n""";'+source),/end must follow/);
  for(const command of ['Import-Module','Defender\\Get-MpThreat','Get-CimInstance','Get-WinEvent',
    'Get-Process','Get-Item','Test-Path','Wait-Job','Receive-Job','Get-Date','Start-Sleep','Start-MpScan'])
    assert.throws(()=>syntheticDispatcher(source.replace("$r | ConvertTo-Json",`${command}\n$r | ConvertTo-Json`)),
      assert.AssertionError,command);
});

type DispatchFixture={state:string;receiveError?:boolean;events:ReturnType<typeof event>[];
  detections?:{id:string;action:'action-required'}[];detectionsError?:boolean;
  operation?:SecurityRequest['operation'];parameters?:string;target?:string};
type DispatchResult={observation:DefenderObservation;calls:Record<string,number>};
function nativeDispatch(fixtures:DispatchFixture[]):DispatchResult[] {
  const dispatcher=syntheticDispatcher(readNativeSource());
  // Only synthetic entry points exist in this fixture. No module is imported,
  // no OS/provider command is shadowed, and the real event helpers/dispatcher
  // still decide correlation, polling, and completion from the synthetic inputs.
  const fakes=String.raw`
$ErrorActionPreference='Stop'
function SyntheticImportModule {$script:calls.module++}
function SyntheticHealth {$script:calls.health++;return $script:fixtureHealth}
function SyntheticDetections($since) {
 $script:calls.detections++
 if($null -eq $since){throw 'Expected scan detection window'}
 if($script:fixture.detectionsError){throw 'Synthetic detection read error'}
 return $script:fixture.detections
}
function SyntheticCim {
 [CmdletBinding()]param($ClassName)
 $script:calls.cim++
 if($ClassName -ne 'Win32_OperatingSystem'){throw 'Unexpected synthetic CIM query'}
 return [pscustomobject]@{LastBootUpTime=([datetime]'2026-11-05T08:00:00Z')}
}
function SyntheticTarget {
 [CmdletBinding()]param($LiteralPath,[switch]$Force)
 $script:calls.target++
 if($LiteralPath -notin 'C:\Synthetic\file.exe','C:\Synthetic','C:\'){throw 'Unexpected synthetic target'}
 return [pscustomobject]@{FullName=$LiteralPath;Attributes=0}
}
function SyntheticStartScan {
 [CmdletBinding()]param($ScanType,$ScanPath,[switch]$AsJob)
 $script:calls.dispatch++
 $expected=@{'quick-scan'='QuickScan';'full-scan'='FullScan';'custom-scan'='CustomScan'}[$script:dispatchInput.operation]
 if(-not $AsJob -or $ScanType -ne $expected -or $ScanPath -ne $script:dispatchInput.target){throw 'Unexpected synthetic scan'}
 $script:dispatched=$true
 $script:ownJob=[pscustomobject]@{State=$script:fixture.state}
 return $script:ownJob
}
function SyntheticUpdateSignatures {throw 'Unexpected synthetic update'}
function SyntheticProcess {
 [CmdletBinding()]param($Id)
 $script:calls.process++
 if($Id -ne 4242){throw 'Unexpected synthetic owner'}
 return [pscustomobject]@{StartTime=([datetime]'2026-11-05T09:00:00Z')}
}
function SyntheticWait {
 [CmdletBinding()]param($Job,$Timeout)
 $script:calls.wait++
 if(-not [object]::ReferenceEquals($Job,$script:ownJob) -or $Timeout -ne 1){throw 'Unexpected synthetic wait'}
 $Job.State='Completed'
}
function SyntheticReceive {
 [CmdletBinding()]param($Job)
 $script:calls.receive++
 if(-not [object]::ReferenceEquals($Job,$script:ownJob)){throw 'Unexpected synthetic receive'}
 if($script:fixture.receiveError){throw 'Synthetic receive failure'}
}
function SyntheticClock {
 $script:calls.clock++
 return ([datetime]'2026-11-05T10:00:00Z').AddSeconds(10*$script:calls.clock)
}
function SyntheticSleep {
 param($Milliseconds)
 $script:calls.sleep++
 if($Milliseconds -ne 500 -or $script:calls.sleep -gt 3){throw 'Unexpected synthetic delay'}
}
function SyntheticEvents {
 [CmdletBinding()]param($FilterHashtable,$MaxEvents)
 if($FilterHashtable.LogName -ne $log){throw 'Unexpected synthetic log'}
 if(-not $script:dispatched){
  if($MaxEvents -eq 1){$script:calls.baseline++;return [pscustomobject]@{RecordId=9}}
  $script:calls.preEvents++
  return @()
 }
 $script:calls.postEvents++
 if($MaxEvents -ne 2048 -or ($FilterHashtable.Id -join ',') -ne '1000,1001,1002,1005'){throw 'Unexpected synthetic event query'}
 foreach($e in $script:fixture.events){
  $xml='<Event><EventData><Data Name="Scan ID">'+$e.scan+'</Data><Data Name="Scan Parameters">'+$script:fixture.parameters+'</Data><Data Name="Scan Resources">'+$script:dispatchInput.target+'</Data></EventData></Event>'
  $record=[pscustomobject]@{Id=$e.id;RecordId=$e.record;TimeCreated=([datetime]$e.time);xml=$xml}
  $record | Add-Member -MemberType ScriptMethod -Name ToXml -Value {return $this.xml}
  $record
 }
}
`;
  const run=String.raw`
$all=@()
foreach($case in $fixtures){
 $script:fixture=$case
 $script:fixtureHealth=$health
 $script:dispatchInput=[pscustomobject]@{requestId='request-1';operation=$case.operation;target=$case.target;monitorPid=4242}
 $script:calls=@{module=0;health=0;cim=0;target=0;dispatch=0;process=0;wait=0;receive=0;clock=0;sleep=0;baseline=0;preEvents=0;postEvents=0;detections=0}
 $script:dispatched=$false
 $result=InvokeSyntheticDispatcher | ConvertFrom-Json
 $all+=@{observation=$result;calls=$script:calls}
}
ConvertTo-Json -InputObject $all -Depth 12 -Compress`;
  const data=JSON.stringify(fixtures.map(f=>({operation:'quick-scan',parameters:'QuickScan',detections:[],...f})));
  const harness=fakes+`\n$fixtures=ConvertFrom-Json '${data.replace(/'/g,"''")}'\n`+
    `$health=ConvertFrom-Json '${JSON.stringify(health)}'\n`+
    'function InvokeSyntheticDispatcher {\n'+dispatcher+'\n}\n'+run;
  assert.doesNotMatch(harness,forbiddenNativeCommands,'Zero forbidden real commands before PowerShell');
  // Parse and allowlist the complete fixture before invoking it. Dynamic commands
  // or new commands fail closed instead of reaching an installed provider.
  const runner=String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$text=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Synthetic fixture parse failure'}
$allowed='SyntheticImportModule','SyntheticHealth','SyntheticDetections','SyntheticCim','SyntheticTarget','SyntheticStartScan','SyntheticUpdateSignatures','SyntheticProcess','SyntheticWait','SyntheticReceive','SyntheticClock','SyntheticSleep','SyntheticEvents','Millis','ReadDefenderEvents','ScanEvents','ScanBusy','ScanEvidence','Where-Object','Out-Null','ConvertTo-Json','ConvertFrom-Json','Add-Member','InvokeSyntheticDispatcher'
foreach($command in $ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]},$true)){
 if($command.GetCommandName() -notin $allowed){throw 'Unmocked fixture command'}
}
& ([scriptblock]::Create($text))`;
  assert.doesNotMatch(runner,forbiddenNativeCommands);
  const ps=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(runner,'utf16le').toString('base64')],
    {input:harness,encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(ps.error,undefined,ps.error?.message);
  assert.equal(ps.status,0,ps.stderr+ps.stdout);
  return JSON.parse(ps.stdout);
}

test('production dispatcher requires own completed job AND successful receive before event 1001 can attest no detection',
  {skip:process.platform!=='win32'},()=>{
  const complete=[event(1001,11,'external'),event(1000,10,'external')];
  const fixtures:DispatchFixture[]=[
    // Exact independently reproduced race: baseline 9, empty busy precheck,
    // failed own dispatch/receive, only another same-kind scan's 10/11 pair.
    {state:'Failed',receiveError:true,events:complete},
    {state:'Completed',events:complete},
    {state:'Failed',events:complete},{state:'Stopped',events:complete},
    {state:'Completed',receiveError:true,events:complete},
    {state:'Running',events:complete},
    {state:'Failed',receiveError:true,events:[event(1005,11),event(1000,10)]},
    {state:'Stopped',receiveError:true,events:[event(1002,11),event(1000,10)]},
    ...[[event(1001,11,'other'),event(1000,10)],
      [event(1001,11),event(1000,10),event(1000,12,'other')],
      [event(1001,11)],[event(1000,10)],
      [event(1001,8),event(1000,7)],
      [event(1005,11),event(1001,12),event(1000,10)]].map(events=>({state:'Completed',events})),
    {state:'Completed',events:complete,parameters:'FullScan'},
    {state:'Completed',events:complete,detectionsError:true},
    ...[complete,[event(1005,11),event(1000,10)],[]].map(events=>({state:'Failed',receiveError:true,
      events,detections:[{id:'unresolved-1',action:'action-required' as const}]})),
    {state:'Completed',events:complete,operation:'full-scan',parameters:'FullScan'},
    {state:'Completed',events:complete,operation:'custom-scan',parameters:'CustomScan',target:'C:\\Synthetic\\file.exe'},
  ];
  const results=nativeDispatch(fixtures);
  assert.equal(results.length,fixtures.length);
  for(const [i,{observation:o,calls}] of results.entries()){
    assert.equal(o.error,undefined,`case ${i} must reach evidence reduction`);
    assert.equal(o.phase,'returned');
    for(const key of ['module','health','baseline','preEvents','cim','dispatch','receive','detections'])
      assert.equal(calls[key],1,`case ${i}: synthetic ${key}`);
    assert.ok(calls.postEvents>=1&&calls.postEvents<=2);
    assert.equal(calls.wait,i===5?1:0);
    assert.equal(calls.process,1+calls.sleep+calls.wait);
    assert.equal(calls.clock,3+calls.sleep);
    assert.equal(calls.target,i===20?4:0);
  }
  assert.deepEqual(results[0].calls,{module:1,health:1,baseline:1,preEvents:1,cim:1,dispatch:1,
    receive:1,detections:1,postEvents:1,process:1,clock:3,wait:0,sleep:0,target:0});
  assert.deepEqual(results.map(({observation:o})=>securityOutcome(o.operation,o,request.requestId)),[
    'uncertain','no-detection','uncertain','uncertain','uncertain','no-detection','failed','cancelled',
    ...Array(8).fill('uncertain'),...Array(3).fill('action-required'),'no-detection','no-detection',
  ]);
  assert.deepEqual(results[0].observation.scan,{recordId:'event-11',scanId:'external',completed:false,
    cancelled:false,failed:false,correlated:true,exclusiveWindow:true});
  assert.equal(results[0].observation.detectionsComplete,true);
  assert.deepEqual(results[0].observation.detections,[]);
});

test('fixed native PowerShell parses without execution; no actual Defender calls',()=>{
  if(process.platform!=='win32')return; // Parser check is Windows-only; all fake checks above are cross-platform.
  const source=readNativeSource();
  const script=source.split('private const string Script="""\n')[1]?.split('\n""";')[0];assert.ok(script);
  assert.ok(Buffer.from(script,'utf16le').toString('base64').length+400<32767,'Encoded script fits Windows command-line limit');
  const parser="$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{$_.ToString()};exit 1}";
  const ps=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(parser,'utf16le').toString('base64')],{input:script,encoding:'utf8',windowsHide:true});
  assert.equal(ps.status,0,ps.stderr+ps.stdout);
});
test('compiled native transport round-trips JSON to fixed PowerShell without a UTF-8 BOM',
  {skip:process.platform!=='win32'},()=>{
  const source=readNativeSource();
  const marker='private const string Script="""\n';
  const start=source.indexOf(marker),end=source.indexOf('\n""";',start);
  assert.ok(start>=0&&end>start);
  const script=source.slice(start+marker.length,end);
  const reader='$inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json';
  assert.ok(script.includes(reader));
  // Keep the actual C# Run method and the exact production PowerShell JSON
  // reader. Replace only the Defender body with a synthetic echo; no module,
  // log, health query, scan or update is executed, even on a real Windows host.
  const echo=script.slice(0,script.indexOf(reader)+reader.length)+String.raw`
@{requestId=$inputData.requestId;operation=$inputData.operation;phase='returned';target=$inputData.target;monitorPid=$inputData.monitorPid;text='é 日本'} | ConvertTo-Json -Compress`;
  assert.doesNotMatch(echo,/Import-Module|Defender\\|Get-CimInstance|Start-MpScan/);
  const fixture=source.slice(0,start+marker.length)+echo+source.slice(end);
  // A real BOM-emitting writer is the negative control: this same transport
  // must reproduce the failure instead of hiding malformed JSON as success.
  const broken=fixture.replace('new UTF8Encoding(false)','new UTF8Encoding(true)');
  assert.notEqual(broken,fixture);
  const wrap=(name:string,body:string)=>`namespace ${name} {\nusing System;\nusing System.Linq;\nusing System.Threading;\n${body}\n}`;
  const compiled='#nullable enable\n'+wrap('BomFree',fixture)+'\n'+wrap('WithBom',broken)+String.raw`
public static class SecurityTransportRegression {
 public static string Run() {
  using var input=System.Text.Json.JsonDocument.Parse("{\"operation\":\"status\",\"requestId\":\"transport-1\"}");
  return System.Text.Json.JsonSerializer.Serialize(new {
   good=BomFree.Security.Run(input.RootElement),bad=WithBom.Security.Run(input.RootElement)
  });
 }
}`;
  // PowerShell 7 compiles the native C# against its current .NET runtime; that
  // C# then launches Windows PowerShell 5.1 exactly as the production helper does.
  const harness=String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition ([Console]::In.ReadToEnd())
[Console]::Write([SecurityTransportRegression]::Run())`;
  const ps=spawnSync('pwsh.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(harness,'utf16le').toString('base64')],
    {input:compiled,encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(ps.error,undefined,ps.error?.message);
  assert.equal(ps.status,0,ps.stderr+ps.stdout);
  const result=JSON.parse(ps.stdout);
  assert.deepEqual(result.good,{requestId:'transport-1',operation:'status',phase:'returned',
    target:null,monitorPid:result.good.monitorPid,text:'é 日本'});
  assert.ok(Number.isInteger(result.good.monitorPid)&&result.good.monitorPid>0);
  assert.deepEqual(result.bad,{requestId:'transport-1',operation:'status',phase:'returned',error:'failed'});
});

test('native detection reduction with synthetic CIM data requires complete remediation and no extra actions',()=>{
  if(process.platform!=='win32')return;
  const source=readNativeSource();
  const body=source.slice(source.indexOf('function Detections($since)'),source.indexOf('function ReadDefenderEvents'))
    .replace('Defender\\Get-MpThreatDetection','$script:detections').replace('Defender\\Get-MpThreat','$script:threats');
  // Only this pure function is run. Every CIM read is replaced by synthetic data;
  // the production script/module/scan entry point is never executed by tests.
  assert.doesNotMatch(body,/Defender\\|Start-MpScan|Get-CimInstance/);
  const base={DetectionID:'d1',ThreatID:1,ActionSuccess:true,ThreatStatusID:3,ThreatStatusErrorCode:0,
    AdditionalActionsBitMask:0,CurrentThreatExecutionStatusID:4,RemediationTime:'2026-11-05T10:00:00Z'};
  const cases=[{detections:[base],threats:[]},
    ...[4,8,16,32768].map(mask=>({detections:[{...base,AdditionalActionsBitMask:mask}],threats:[]})),
    {detections:[{...base,ThreatStatusID:5}],threats:[]},
    {detections:[{...base,ActionSuccess:false}],threats:[]},
    {detections:[{...base,ThreatStatusErrorCode:7}],threats:[]},
    {detections:[{...base,CurrentThreatExecutionStatusID:3}],threats:[]},
    {detections:[{...base,RemediationTime:null}],threats:[]},
    {detections:[{DetectionID:'d1',ThreatID:1}],threats:[]},
    {detections:[],threats:[{ThreatID:99,IsActive:true}]}];
  const harness="$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$cases=[Console]::In.ReadToEnd()|ConvertFrom-Json;"+
    body+"\n$all=@();foreach($case in $cases){$script:detections=$case.detections;$script:threats=$case.threats;$all+=,@(Detections $null)};ConvertTo-Json -InputObject $all -Depth 8 -Compress";
  const ps=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(harness,'utf16le').toString('base64')],
    {input:JSON.stringify(cases),encoding:'utf8',windowsHide:true});
  assert.equal(ps.status,0,ps.stderr+ps.stdout);
  const actions=(JSON.parse(ps.stdout) as {action:string}[][]).map(items=>items[0]?.action);
  assert.deepEqual(actions,['remediated',...Array(8).fill('action-required'),'uncertain','uncertain','action-required']);
});

// Execute the exact production event helpers with a fake Get-WinEvent. No
// operational log, Defender module, process/boot status or scan is accessed.
function nativeEventHelpers(source:string):string {
  const normalized=source.replace(/\r\n/g,'\n');
  const start=normalized.indexOf('function ReadDefenderEvents($filter,$limit) {');
  const end=normalized.indexOf('\ntry {\n Import-Module');
  assert.ok(start>=0,'Native event helper start boundary must exist');
  assert.ok(end>=0,'Native dispatcher boundary must exist');
  assert.ok(end>start,'Native dispatcher must follow event helpers');
  const helpers=normalized.slice(start,end);
  assert.ok(helpers.startsWith('function ReadDefenderEvents'));
  assert.doesNotMatch(helpers,/Defender\\|Start-MpScan|Get-CimInstance|Import-Module/);
  return helpers;
}

test('native event fixture extraction handles LF and CRLF and rejects missing, reversed or unsafe boundaries',()=>{
  const lf=readNativeSource();
  const helpers=nativeEventHelpers(lf);
  assert.equal(nativeEventHelpers(lf.replace(/\n/g,'\r\n')),helpers);
  for(const name of ['ReadDefenderEvents','ScanEvents','ScanBusy','ScanEvidence'])
    assert.ok(helpers.includes(`function ${name}(`));
  assert.throws(()=>nativeEventHelpers(lf.replace('function ReadDefenderEvents($filter,$limit) {','')),/start boundary/);
  assert.throws(()=>nativeEventHelpers(lf.replace('\ntry {\n Import-Module','')),/dispatcher boundary/);
  assert.throws(()=>nativeEventHelpers('\ntry {\n Import-Module\n'+helpers),/must follow/);
  for(const forbidden of ['Defender\\Get-MpThreat','Start-MpScan','Get-CimInstance','Import-Module'])
    assert.throws(()=>nativeEventHelpers(lf.replace('function ScanEvents($after) {',
      `function ScanEvents($after) {\n ${forbidden}`)),assert.AssertionError);
});

function nativeEvents(fixture:unknown,check:string):unknown {
  const helpers=nativeEventHelpers(readFileSync('native/Security.cs','utf8'));
  const mock=String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$fixture=[Console]::In.ReadToEnd() | ConvertFrom-Json
$log='fake-log'
function Get-WinEvent {
 [CmdletBinding()] param($FilterHashtable,$MaxEvents)
 if($fixture.error){
  $record=[Management.Automation.ErrorRecord]::new([InvalidOperationException]::new('Synthetic query error'),[string]$fixture.error,[Management.Automation.ErrorCategory]::ObjectNotFound,$null)
  $PSCmdlet.ThrowTerminatingError($record)
 }
 foreach($e in $fixture.events){
  if($FilterHashtable.Id -and $e.id -notin $FilterHashtable.Id){continue}
  $event=[pscustomobject]@{Id=$e.id;RecordId=$e.record;TimeCreated=([datetime]$e.time);xml=('<Event><EventData><Data Name="Scan ID">'+$e.scan+'</Data><Data Name="Scan Parameters">QuickScan</Data></EventData></Event>')}
  $event | Add-Member -MemberType ScriptMethod -Name ToXml -Value {return $this.xml}
  $event
 }
}
`;
  const harness=mock+helpers+'\n'+check;
  const ps=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(harness,'utf16le').toString('base64')],
    {input:JSON.stringify(fixture),encoding:'utf8',windowsHide:true});
  assert.equal(ps.status,0,ps.stderr+ps.stdout);
  return JSON.parse(ps.stdout);
}
const event=(id:number,record:number,scan='scan-1',time='2026-11-05T10:00:00Z')=>({id,record,scan,time});
const busyCheck="ScanBusy @(ScanEvents 0) ([datetime]'2026-11-05T08:00:00Z') ([datetime]'2026-11-05T12:00:00Z') | ConvertTo-Json -Compress";

test('native busy check ignores failed, completed, cancelled, previous-boot and expired starts',
  {skip:process.platform!=='win32'},()=>{
  for(const terminal of [1001,1002,1005])
    assert.equal(nativeEvents({events:[event(terminal,11),event(1000,10)]},busyCheck),false);
  assert.equal(nativeEvents({events:[event(1000,10,'old-boot','2026-11-05T07:00:00Z')]},busyCheck),false);
  // Long-running Windows session: even a same-boot abandoned start is bounded.
  assert.equal(nativeEvents({events:[event(1000,10,'expired','2026-11-03T10:00:00Z')]},
    busyCheck.replace('2026-11-05T08:00:00Z','2026-11-01T08:00:00Z')),false);
  assert.equal(nativeEvents({events:[event(1000,10)]},busyCheck),true);
  assert.equal(nativeEvents({events:[event(1005,11,'other'),event(1000,10)]},busyCheck),true);
  assert.equal(nativeEvents({events:[event(1005,9),event(1000,10)]},busyCheck),true);
});

test('native empty queries allow dispatch baseline zero; actual query failures still fail closed',
  {skip:process.platform!=='win32'},()=>{
  const baselineCheck=String.raw`
$latest=@(ReadDefenderEvents @{LogName=$log} 1)
$baseline=0
if($latest.Count -gt 0){$baseline=$latest[0].RecordId}
@{baseline=$baseline;busy=(ScanBusy @(ScanEvents 0) ([datetime]'2026-11-05T08:00:00Z') ([datetime]'2026-11-05T12:00:00Z'))} | ConvertTo-Json -Compress`;
  for(const fixture of [{events:[]},{error:'NoMatchingEventsFound'}])
    assert.deepEqual(nativeEvents(fixture,baselineCheck),{baseline:0,busy:false});
  for(const error of ['UnauthorizedAccess','NoMatchingLogsFound','EventLogReadFailure'])
    assert.equal(nativeEvents({error},"$result=try { $null=ScanEvents 0; $false } catch { $true }; ConvertTo-Json -InputObject $result -Compress"),true);
});

test('native event 1005 correlates as failed; unrelated, ambiguous and rotated records never attest completion',
  {skip:process.platform!=='win32'},()=>{
  const evidenceCheck="$evidence=ScanEvidence @(ScanEvents 9) 'quick-scan' $null; if($null -eq $evidence){[Console]::Write('null')}else{ConvertTo-Json -InputObject $evidence -Compress}";
  const failed=nativeEvents({events:[event(1005,11),event(1000,10)]},evidenceCheck);
  assert.deepEqual(failed,{recordId:'event-11',scanId:'scan-1',completed:false,cancelled:false,
    failed:true,correlated:true,exclusiveWindow:true});
  assert.equal(outcome(observation({scan:failed as DefenderObservation['scan']})),'failed');
  for(const events of [[event(1005,11,'other'),event(1000,10)],
    [event(1005,11),event(1000,10),event(1000,12,'other')],
    [event(1005,11)],[event(1000,10)],[event(1005,8),event(1000,10)],
    [event(1005,11),event(1001,12),event(1000,10)]])
    assert.equal(nativeEvents({events},evidenceCheck),null);
});
