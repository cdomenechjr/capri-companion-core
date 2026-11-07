param(
    [Parameter(Mandatory=$true)][string]$TrustFile,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$TrustFileSha256,
    [int]$OwnerProcessId=0,
    [long]$OwnerStartTicks=0,
    [Parameter(Mandatory=$true)][string]$Nonce,
    [switch]$Launch
)
$ErrorActionPreference='Stop'
# Optional wrapper only, for hosts whose existing policy permits .ps1 scripts.
# Preferred entrypoint: pinned Node + resources/native/update-launcher.cjs.
# Never change execution policy or use bypass flags to run this wrapper.
# The compiled Node resource performs ALL signature, ZIP, inventory, pointer,
# schema, sequence, owner and first-launch expiry verification. No inline verifier.
if((Get-Item -LiteralPath $TrustFile).Length -gt 65536 -or
   (Get-FileHash -LiteralPath $TrustFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $TrustFileSha256){throw 'Bootstrap trust pin differs.'}
$config=Get-Content -LiteralPath $TrustFile -Raw | ConvertFrom-Json
if(-not [IO.Path]::IsPathRooted($config.nodeExecutable) -or
   (Get-FileHash -LiteralPath $config.nodeExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.nodeSha256){throw 'Node runtime pin differs.'}
$launcher=Join-Path $PSScriptRoot 'update-launcher.cjs'
if((Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.launcherSha256){throw 'Launcher pin differs.'}
$arguments=@($launcher,'--trust-file',$TrustFile,'--trust-file-sha256',$TrustFileSha256)
if($OwnerProcessId -ne 0 -or $OwnerStartTicks -ne 0){$arguments+=@('--owner-pid',[string]$OwnerProcessId,'--owner-start-ticks',[string]$OwnerStartTicks)}
if($Nonce){$arguments+=@('--nonce',$Nonce)}
if($Launch){$arguments+='--launch'}
& $config.nodeExecutable @arguments
if($LASTEXITCODE -ne 0){throw 'Managed update verification refused.'}
