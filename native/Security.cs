using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// Independent implementation using Microsoft's built-in Defender module and event
// schema: https://learn.microsoft.com/defender-endpoint/troubleshoot-microsoft-defender-antivirus
// No upstream source imported. Only fixed native actions; JSON stdin is data, never
// interpolated into PowerShell source. No protection, exclusion or reboot mutations.
internal static class Security {
 internal static object Run(JsonElement args) {
  var operation=args.GetProperty("operation").GetString()??"";
  var requestId=args.GetProperty("requestId").GetString()??"";
  if(!new[]{"status","quick-scan","full-scan","custom-scan","update-signatures"}.Contains(operation)||
    !Regex.IsMatch(requestId,@"\A[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\z"))throw new Exception("Invalid security request.");
  foreach(var property in args.EnumerateObject())
   if(!new[]{"operation","requestId","target"}.Contains(property.Name))throw new Exception("Invalid security argument.");
  string? target=args.TryGetProperty("target",out var value)?value.GetString():null;
  if((operation=="custom-scan")!=(target!=null))throw new Exception("Custom scans need one local target.");
  if(target!=null) {
   if(target.Length>240||!Regex.IsMatch(target,@"\A[A-Za-z]:\\")||target.Contains('/')||
     Regex.IsMatch(target,"[\\x00-\\x1f\\x7f*?\"<>|]")||target[2..].Contains(':'))throw new Exception("Invalid local scan target.");
   foreach(var part in target[3..].Split('\\'))if(part=="."||part==".."||part.EndsWith('.')||part.EndsWith(' ')||
     Regex.IsMatch(part,@"\A(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)",RegexOptions.IgnoreCase))throw new Exception("Invalid local scan target.");
   target=Path.GetFullPath(target);
   // Local fixed disks only; reject all reparse points including parent junctions.
   // A file can still change while being scanned; completion does not attest a hash.
   if(new DriveInfo(Path.GetPathRoot(target)!).DriveType!=DriveType.Fixed)return new{requestId,operation,phase="not-dispatched",error="invalid-target"};
   if(!File.Exists(target)&&!Directory.Exists(target))return new{requestId,operation,phase="not-dispatched",error="invalid-target"};
   var current=target;
   while(current!=null){if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)return new{requestId,operation,phase="not-dispatched",error="invalid-target"};current=Path.GetDirectoryName(current);}
  }
  if(!OperatingSystem.IsWindows())return new{requestId,operation,phase="not-dispatched",error="unavailable"};
  // Serialize our own native requests. This is NOT ownership of Defender's engine,
  // and never authorizes a global scan cancellation.
  using var mutex=new Mutex(false,@"Local\Capri.Defender.Monitor.v1");
  bool locked=false;
  try {
   if(operation!="status"){
    try{locked=mutex.WaitOne(0);}catch(AbandonedMutexException){locked=true;}
    if(!locked)return new{requestId,operation,phase="not-dispatched",error="busy"};
   }
   var executable=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","WindowsPowerShell","v1.0","powershell.exe");
   // StreamWriter emits Encoding.UTF8's BOM; Console.In passes it to
   // ConvertFrom-Json, which rejects it before the script's guarded dispatch.
   var utf8=new UTF8Encoding(false);
   var start=new ProcessStartInfo(executable){UseShellExecute=false,CreateNoWindow=true,
    RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,
    StandardInputEncoding=utf8,StandardOutputEncoding=utf8,StandardErrorEncoding=utf8};
   foreach(var argument in new[]{"-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Convert.ToBase64String(Encoding.Unicode.GetBytes(Script))})start.ArgumentList.Add(argument);
   using var process=Process.Start(start)??throw new Exception("Defender helper unavailable.");
   var output=process.StandardOutput.ReadToEndAsync();var errors=process.StandardError.ReadToEndAsync();
   process.StandardInput.Write(JsonSerializer.Serialize(new{operation,requestId,target,monitorPid=Environment.ProcessId}));process.StandardInput.Close();
   // No engine cancellation on timeout. Kill only this owned monitoring process.
   if(!process.WaitForExit(24*60*60*1000)){process.Kill();return new{requestId,operation,phase="returned",error="failed"};}
   var json=output.GetAwaiter().GetResult();errors.GetAwaiter().GetResult();
   if(json.Length>1000000)return new{requestId,operation,phase="returned",error="failed"};
   try{return JsonDocument.Parse(json).RootElement.Clone();}
   catch{return new{requestId,operation,phase="returned",error="failed"};}
  }catch{return new{requestId,operation,phase="returned",error="failed"};}
  finally{if(locked)mutex.ReleaseMutex();}
 }

 // Get-WinEvent data, not localized message text. Unknown/localized scan parameter
 // representations fail correlation closed rather than claiming a clean result.
 private const string Script="""
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json
$r=@{requestId=$inputData.requestId;operation=$inputData.operation;phase='not-dispatched'}
$log='Microsoft-Windows-Windows Defender/Operational'
function Millis($v) { if($null -eq $v){return $null}; return ([DateTimeOffset]([datetime]$v)).ToUnixTimeMilliseconds() }
function Health {
 $s=Defender\Get-MpComputerStatus
 $firewall=$null; $startup=$null; $reboot=$null
 try { $p=@(NetSecurity\Get-NetFirewallProfile); if($p.Count -gt 0){$firewall=(@($p | Where-Object { $_.Enabled -ne $true }).Count -eq 0)} } catch {}
 try { $startup=@(Get-CimInstance -ClassName Win32_StartupCommand).Count } catch {}
 try { $reboot=(Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or (Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') } catch {}
 $mode='unknown'
 if($s.AMRunningMode -eq 'Normal'){$mode='normal'} elseif($s.AMRunningMode -match 'Passive|EDR Block'){$mode='passive'} elseif(-not $s.AMServiceEnabled){$mode='disabled'}
 return @{available=[bool]$s.AMServiceEnabled;mode=$mode;antivirusEnabled=[bool]$s.AntivirusEnabled;realTimeProtection=[bool]$s.RealTimeProtectionEnabled;serviceEnabled=[bool]$s.AMServiceEnabled;signaturesOutOfDate=$s.DefenderSignaturesOutOfDate;signatureVersion=[string]$s.AntivirusSignatureVersion;signatureUpdatedAt=(Millis $s.AntivirusSignatureLastUpdated);firewallEnabled=$firewall;pendingReboot=$reboot;startupEntryCount=$startup}
}
function Detections($since) {
 # Never return resource paths, usernames, or threat names. ActionSuccess alone
 # does not prove remediation: require no active matching threat and a remediation time.
 $active=@(Defender\Get-MpThreat)
 $items=@(Defender\Get-MpThreatDetection)
 $result=@()
 foreach($d in $items){
  $isActive=@($active | Where-Object { $_.ThreatID -eq $d.ThreatID -and $_.IsActive }).Count -gt 0
  $needsAction=$isActive -or $d.ActionSuccess -eq $false -or $d.AdditionalActionsBitMask -gt 0 -or ($null -ne $d.ThreatStatusErrorCode -and $d.ThreatStatusErrorCode -ne 0) -or $d.ThreatStatusID -eq 5 -or $d.ThreatStatusID -ge 100 -or $d.CurrentThreatExecutionStatusID -in 2,3
  if($null -ne $since -and -not $needsAction -and $null -ne $d.InitialDetectionTime -and $null -ne $d.LastThreatStatusChangeTime -and $d.InitialDetectionTime -lt $since -and $d.LastThreatStatusChangeTime -lt $since){continue}
  $action='uncertain'
  if($needsAction){$action='action-required'}
  elseif($d.ActionSuccess -eq $true -and $d.ThreatStatusID -in 2,3,4 -and $d.AdditionalActionsBitMask -eq 0 -and $d.ThreatStatusErrorCode -eq 0 -and $null -ne $d.RemediationTime -and ([datetime]$d.RemediationTime).Year -gt 1970){$action='remediated'}
  $id=([string]$d.DetectionID).Trim('{}')
  if($id -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'){$id='detection-'+[string]$d.ThreatID}
  $result+=@{id=$id;action=$action}
 }
 foreach($t in $active){if($t.IsActive -and @($items | Where-Object { $_.ThreatID -eq $t.ThreatID }).Count -eq 0){$result+=@{id='threat-'+[string]$t.ThreatID;action='action-required'}}}
 if($result.Count -gt 1000){throw 'Too many records'}
 return $result
}
function ReadDefenderEvents($filter,$limit) {
 try { return @(Get-WinEvent -FilterHashtable $filter -MaxEvents $limit -ErrorAction Stop) }
 catch {
  # Get-WinEvent uses an error for a successful query with no matching records.
  # Only that specific condition is empty; denied/missing logs still fail closed.
  if($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*'){return @()}
  throw
 }
}
function ScanEvents($after) {
 $events=@(ReadDefenderEvents @{LogName=$log;Id=1000,1001,1002,1005} 2048)
 $result=@()
 foreach($e in $events){if($e.RecordId -le $after){continue};$fields=@{};[xml]$xml=$e.ToXml();foreach($d in $xml.Event.EventData.Data){$fields[[string]$d.Name]=[string]$d.'#text'}
  $result+=@{id=$e.Id;record=$e.RecordId;time=$e.TimeCreated;scan=$fields['Scan ID'];parameters=$fields['Scan Parameters'];resources=$fields['Scan Resources']}
 }
 return $result
}
function ScanBusy($events,$boot,$now) {
 # A shutdown may leave no terminal record. Ignore previous-boot starts and
 # bound history to 24 hours so an abandoned scan cannot block all future work.
 $cutoff=$now.AddHours(-24)
 if($boot -gt $cutoff){$cutoff=$boot}
 foreach($s in @($events | Where-Object { $_.id -eq 1000 })){
  if($null -eq $s.time){return $true}
  if($s.time -lt $cutoff){continue}
  if(@($events | Where-Object { $_.scan -eq $s.scan -and $_.id -in 1001,1002,1005 -and $_.record -gt $s.record }).Count -eq 0){return $true}
 }
 return $false
}
function ScanEvidence($events,$operation,$target) {
 $starts=@($events | Where-Object { $_.id -eq 1000 })
 if($starts.Count -ne 1){return $null}
 $s=$starts[0];$scanId=([string]$s.scan).Trim('{}')
 $term=@($events | Where-Object { $_.scan -eq $s.scan -and $_.id -in 1001,1002,1005 -and $_.record -gt $s.record })
 $param=([string]$s.parameters).Replace(' ','')
 $kind=($operation -eq 'quick-scan' -and $param -in 'QuickScan','1') -or ($operation -eq 'full-scan' -and $param -in 'FullScan','2') -or ($operation -eq 'custom-scan' -and $param -in 'CustomScan','3' -and ([string]$s.resources).Trim() -eq $target)
 if($term.Count -ne 1 -or $scanId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'){return $null}
 return @{recordId='event-'+[string]$term[0].record;scanId=$scanId;completed=($term[0].id -eq 1001);cancelled=($term[0].id -eq 1002);failed=($term[0].id -eq 1005);correlated=[bool]$kind;exclusiveWindow=$true}
}
try {
 Import-Module -Name (Join-Path $PSHOME 'Modules\Defender\Defender.psd1') -ErrorAction Stop
 $r.health=Health
 if($inputData.operation -eq 'status'){
  try{$r.detections=@(Detections $null);$r.detectionsComplete=$true}catch{$r.detectionsComplete=$false}
  $r.phase='returned'
 } elseif(-not $r.health.available -or $r.health.mode -ne 'normal' -or -not $r.health.antivirusEnabled){$r.error='unavailable'}
 elseif($inputData.operation -eq 'update-signatures'){
  $r.phase='returned'
  Defender\Update-MpSignature -ErrorAction Stop | Out-Null
  $r.health=Health
  $r.signatureUpdateVerified=($r.health.signaturesOutOfDate -eq $false -and $null -ne $r.health.signatureUpdatedAt -and $r.health.signatureVersion.Length -gt 0)
 } else {
  # Recheck target immediately before dispatch. Literal filesystem lookup only;
  # no wildcard expansion, command construction or remote scan paths.
  if($inputData.operation -eq 'custom-scan'){
   $item=Get-Item -LiteralPath $inputData.target -Force
   $current=$item.FullName
   while($null -ne $current){$entry=Get-Item -LiteralPath $current -Force;if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Invalid target'};$current=[IO.Path]::GetDirectoryName($current)}
  }
  $latest=@(ReadDefenderEvents @{LogName=$log} 1)
  $baseline=0
  if($latest.Count -gt 0){$baseline=$latest[0].RecordId}
  # An active unrelated scan is not ours. Failed/stopped/completed scans and
  # stale starts are not active. Inaccessible logs or boot status fail closed.
  $recent=@(ScanEvents 0)
  $boot=(Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime
  if($null -eq $boot){throw 'Boot status unavailable'}
  if(ScanBusy $recent ([datetime]$boot) (Get-Date)){$r.error='busy'}
  if(-not $r.error){
   $since=Get-Date
   $r.phase='returned'
   switch($inputData.operation){
    'quick-scan' {$job=Defender\Start-MpScan -ScanType QuickScan -AsJob}
    'full-scan' {$job=Defender\Start-MpScan -ScanType FullScan -AsJob}
    'custom-scan' {$job=Defender\Start-MpScan -ScanType CustomScan -ScanPath ([string]$inputData.target) -AsJob}
    default {throw 'Unsupported scan'}
   }
   # Only this CIM invocation is monitored. Never call Stop-MpScan, CancelScan,
   # MpCmdRun -Scan -Cancel or Stop-Job. Lost monitor => unknown engine outcome.
   $owner=Get-Process -Id $inputData.monitorPid
   $ownerStarted=$owner.StartTime
   while($job.State -in 'Running','NotStarted'){
    $p=Get-Process -Id $inputData.monitorPid -ErrorAction SilentlyContinue
    if($null -eq $p -or $p.StartTime -ne $ownerStarted){exit 0}
    $null=Wait-Job -Job $job -Timeout 1
   }
   # A failed CIM job can still have a correlated 1005 failure record. Read the
   # events before judging it; the invocation alone proves no scan outcome.
   $jobCompleted=($job.State -eq 'Completed')
   $received=$false
   try{Receive-Job -Job $job -ErrorAction Stop | Out-Null;$received=$true}catch{}
   # Allow the operational log to catch up with the CIM return before judging
   # completion. Missing/rotated/ambiguous events remain uncertain, never clean.
   $eventDeadline=(Get-Date).AddSeconds(15)
   do {
    $events=@(ScanEvents $baseline)
    $eventStarts=@($events | Where-Object { $_.id -eq 1000 })
    $evidence=ScanEvidence $events $inputData.operation $inputData.target
    if($eventStarts.Count -gt 1 -or $null -ne $evidence){break}
    $p=Get-Process -Id $inputData.monitorPid -ErrorAction SilentlyContinue
    if($null -eq $p -or $p.StartTime -ne $ownerStarted){exit 0}
    Start-Sleep -Milliseconds 500
   } while((Get-Date) -lt $eventDeadline)
   if($null -ne $evidence){
    # Another same-kind scan can race the busy check. Its 1001 cannot attest a
    # failed/unreceived invocation. Keep 1005/1002 and independent detections.
    $evidence.completed=($evidence.completed -and $jobCompleted -and $received)
    $r.scan=$evidence
   }
   try{$r.detections=@(Detections $since);$r.detectionsComplete=$true}catch{$r.detectionsComplete=$false}
  }
 }
} catch {
 # Typed categories only; native exception text may contain private paths.
 $r.error='failed'
 if($r.phase -eq 'not-dispatched'){
  if($_.Exception -is [UnauthorizedAccessException] -or $_.Exception.HResult -eq -2147024891){$r.error='access-denied'}
  else{$r.error='unavailable'}
 }
}
$r | ConvertTo-Json -Depth 8 -Compress
""";
}
