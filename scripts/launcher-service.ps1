[CmdletBinding()]
param(
    [ValidateRange(1024,65535)][int]$Port = 3032,
    [string]$ProjectDirectory = '',
    [ValidateRange(2,120)][int]$TimeoutSeconds = 45
)
$ErrorActionPreference = 'Stop'
# The native launcher reads this child process's redirected pipes as UTF-8.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (!$ProjectDirectory) { $ProjectDirectory = Split-Path -Parent $PSScriptRoot }
$ProjectDirectory = (Resolve-Path -LiteralPath $ProjectDirectory).Path
$node = Join-Path $ProjectDirectory 'runtime\node.exe'
$manager = Join-Path $ProjectDirectory 'scripts\local-service.ps1'
foreach ($required in @($node, $manager, (Join-Path $ProjectDirectory 'dist\index.html'))) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "The portable package is incomplete. Fully extract the ZIP, then retry. Missing: $required"
    }
}
$env:FUXIAN_MODE = 'production'
function Invoke-Manager([string]$action) {
    $global:LASTEXITCODE = 0
    $lines = & $manager -Action $action -Port $Port -ProjectDirectory $ProjectDirectory -NodeExecutable $node -TimeoutSeconds $TimeoutSeconds
    if ($LASTEXITCODE -ne 0) { throw "Local service command failed (exit $LASTEXITCODE). Inspect its retained diagnostic logs." }
    try { $state = ($lines -join "`n") | ConvertFrom-Json }
    catch { throw 'The local service returned an unreadable status. Inspect its retained diagnostic logs.' }
    if (!$state -or $state.port -ne $Port) { throw 'The local service returned a mismatched status.' }
    return $state
}
# Start is idempotent under the existing manager's per-directory/port mutex.
# In particular, a recovering managed host must become ready before the browser opens.
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$state = Invoke-Manager 'Start'
while (!($state.running -and $state.managedHostRunning -and $state.status -eq 'ready')) {
    if ($state.status -in @('failed','stopped')) {
        throw "The local service could not start. Logs: $($state.serviceDirectory)"
    }
    if ([DateTime]::UtcNow -ge $deadline) {
        throw "The local service is not ready yet. Retry shortly. Logs: $($state.serviceDirectory)"
    }
    Start-Sleep -Milliseconds 300
    $state = Invoke-Manager 'Status'
}
# Construct the browser target here, rather than trusting a returned command/URL.
[ordered]@{ ready = $true; port = $Port; url = "http://localhost:$Port/"; serviceDirectory = $state.serviceDirectory } | ConvertTo-Json -Compress
