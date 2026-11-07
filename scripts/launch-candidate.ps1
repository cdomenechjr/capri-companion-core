$ErrorActionPreference='Stop'
$capriCheckout=Split-Path $PSScriptRoot -Parent
$capriRoot=Split-Path $capriCheckout -Parent
if((Split-Path $capriRoot -Leaf) -eq 'worktrees'){$capriRoot=Split-Path $capriRoot -Parent}
$capriDeliverables=[IO.Path]::GetFullPath((Join-Path $capriRoot 'deliverables'))
$capriMetadata=Join-Path $capriDeliverables 'current-candidate.json'
if(-not (Test-Path -LiteralPath $capriMetadata -PathType Leaf)){throw 'No verified packaged candidate: deliverables/current-candidate.json is missing. The coordinator must verify a packaged snapshot before writing this file.'}

# Coordinator-owned pointer, written only after final verification:
# {"executablePath":"<snapshot>/win-unpacked/Capri.exe","version":"0.6.0-dev.1","commit":"<full Git commit>"}
$capriSnapshot=Get-Content -LiteralPath $capriMetadata -Raw | ConvertFrom-Json
if($capriSnapshot.version -isnot [string] -or $capriSnapshot.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or $capriSnapshot.commit -isnot [string] -or $capriSnapshot.commit -notmatch '^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$'){
    throw 'Verified candidate metadata must include a version and full Git commit.'
}
$capriRelative=$capriSnapshot.executablePath
if($capriRelative -isnot [string] -or [string]::IsNullOrWhiteSpace($capriRelative) -or [IO.Path]::IsPathRooted($capriRelative) -or $capriRelative.Contains(':')){
    throw 'Candidate executablePath must be a relative executable path inside deliverables.'
}
$capriExecutable=[IO.Path]::GetFullPath((Join-Path $capriDeliverables $capriRelative))
$capriBoundary=$capriDeliverables+[IO.Path]::DirectorySeparatorChar
if(-not $capriExecutable.StartsWith($capriBoundary,[StringComparison]::OrdinalIgnoreCase)){
    throw 'Candidate executablePath escapes deliverables.'
}
if(-not (Test-Path -LiteralPath $capriExecutable -PathType Leaf)) {throw 'The verified packaged candidate executable is missing.'}
# Resolve-Path does not dereference Windows junctions. Reject reparse points in
# the snapshot path so a pointer cannot redirect this launch outside deliverables.
$capriEntry=Get-Item -LiteralPath $capriExecutable -Force
while($null -ne $capriEntry){
    if(($capriEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Candidate snapshot paths must not contain aliases or junctions.'}
    if($capriEntry.FullName -eq $capriDeliverables){break}
    $capriEntry=Get-Item -LiteralPath (Split-Path $capriEntry.FullName -Parent) -Force
}
$capriCandidate=Split-Path $capriExecutable -Parent
if((Split-Path $capriExecutable -Leaf) -ne 'Capri.exe' -or -not (Test-Path -LiteralPath (Join-Path $capriCandidate 'resources\app.asar') -PathType Leaf)){
    throw 'Candidate must be an unpacked packaged Capri app, not an installer or worktree build.'
}
$env:CAPRI_PROFILE_DIR=Join-Path $capriRoot 'profiles\candidate-preview'
$env:CAPRI_DEV_PORT='18700'
$env:CAPRI_AGENT_ACTIVITY_FILE=Join-Path $capriRoot 'runtime\coordinator\activity.jsonl'
Write-Host "Launching verified Capri $($capriSnapshot.version) ($($capriSnapshot.commit))"
Start-Process -FilePath $capriExecutable -WorkingDirectory $capriCandidate -WindowStyle Hidden
