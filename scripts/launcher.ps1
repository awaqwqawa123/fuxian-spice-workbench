[CmdletBinding()]
param([ValidateRange(1024,65535)][int]$Port = 3032, [ValidateRange(2,120)][int]$TimeoutSeconds = 45)
$ErrorActionPreference = 'Stop'
$executable = Join-Path (Split-Path -Parent $PSScriptRoot) 'Fuxian.exe'
if (!(Test-Path -LiteralPath $executable -PathType Leaf)) {
    & (Join-Path $PSScriptRoot 'build-launcher.ps1') -OutputPath $executable | Out-Null
}
# Native winexe owns the visible window; this compatibility shell stays hidden.
Start-Process -FilePath $executable -ArgumentList @('-Port', [string]$Port, '-TimeoutSeconds', [string]$TimeoutSeconds)
