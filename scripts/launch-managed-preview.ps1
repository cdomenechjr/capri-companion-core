param(
 [Parameter(Mandatory=$true)][string]$NodeExecutable,
 [Parameter(Mandatory=$true)][string]$Controller,
 [Parameter(Mandatory=$true)][ValidateSet('start','status','stop','bootstrap')][string]$Command,
 [Parameter(Mandatory=$true)][string]$Config,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ConfigSha256,
 [string]$Generation
)
$ErrorActionPreference='Stop'
$arguments=@($Controller,$Command,'--config',$Config,'--config-sha256',$ConfigSha256)
if($Command -eq 'bootstrap'){$arguments+=@('--generation',$Generation)}
& $NodeExecutable @arguments
exit $LASTEXITCODE
