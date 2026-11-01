[CmdletBinding()]
param([ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Start', [ValidateRange(1024,65535)][int]$Port = 3032)
$ErrorActionPreference = 'Stop'
$portableRoot = Split-Path -Parent $PSScriptRoot
$portableNode = Join-Path $portableRoot 'runtime\node.exe'
if (!(Test-Path -LiteralPath $portableNode) -or !(Test-Path -LiteralPath (Join-Path $portableRoot 'dist\index.html'))) {
    throw 'Fully extract the ZIP before launching. runtime/node.exe and dist/index.html are required.'
}
# No package installation or network access is needed for normal simulation.
$env:FUXIAN_MODE = 'production'
$result = & (Join-Path $PSScriptRoot 'local-service.ps1') -Action $Action -Port $Port -ProjectDirectory $portableRoot -NodeExecutable $portableNode
if ($LASTEXITCODE -ne 0) { throw 'The local service could not complete the requested action. See its retained diagnostic logs.' }
$result
if ($Action -eq 'Start') {
    $state = $result | ConvertFrom-Json
    if (!$state.running) { throw 'The local service did not become ready.' }
    Start-Process -FilePath "http://localhost:$Port"
}
