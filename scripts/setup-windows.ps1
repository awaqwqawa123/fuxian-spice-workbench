[CmdletBinding()]
param([switch]$DesktopSharing, [switch]$NoStart, [switch]$ReinstallDependencies)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$previous = Get-Location
try {
  Set-Location -LiteralPath $project
  $node = Get-Command node.exe -ErrorAction Stop
  $version = (& $node.Source --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw "Node.js 24 or newer is required; found $version" }

  if ($ReinstallDependencies -or !(Test-Path -LiteralPath 'node_modules\typescript\bin\tsc') -or !(Test-Path -LiteralPath 'node_modules\vite\bin\vite.js')) {
    if (!(Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Dependencies are missing and npm was not found. Install the official Node.js 24 package with npm, then run setup again.' }
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check the npm error above.' }
  }
  & $node.Source 'node_modules\typescript\bin\tsc' -b
  if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed. Check the compiler error above.' }
  & $node.Source 'node_modules\vite\bin\vite.js' build
  if ($LASTEXITCODE -ne 0) { throw 'The workbench build failed. Check the compiler error above.' }

  if ($DesktopSharing) {
    $installer = Join-Path $PSScriptRoot 'install-desktop-control.ps1'
    & $installer -Mode Repair -NodePath $node.Source
    if ($LASTEXITCODE -ne 0) { throw 'Desktop sharing repair failed.' }
  }

  if (!$NoStart) {
    & (Join-Path $PSScriptRoot 'local-service.ps1') -Action Start -NodeExecutable $node.Source
    if ($LASTEXITCODE -ne 0) { throw 'The local workbench service did not start.' }
    try {
      & (Join-Path $PSScriptRoot 'local-service-startup.ps1') -Action Install
      if ($LASTEXITCODE -ne 0) { throw "Startup registration returned exit code $LASTEXITCODE" }
    } catch {
      throw "The workbench is running, but automatic recovery could not be installed. Run scripts/local-service-startup.ps1 -Action Install again to enable sign-in startup and crash recovery. $($_.Exception.Message)"
    }
  }
  Write-Output 'Workbench setup complete. Open http://localhost:3032/'
  if ($DesktopSharing) { Write-Output 'Completely quit and reopen Codex once, then refresh the workbench desktop-sharing status.' }
} finally { Set-Location $previous }
