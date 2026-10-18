[CmdletBinding()]
param(
  [ValidateSet('Prepare','Activate','Restore','Repair')][string]$Mode = 'Prepare',
  [string]$InstallDirectory = (Join-Path $env:USERPROFILE '.codex/desktop-control'),
  [string]$RealCodexPath,
  [string]$NodePath
)
$ErrorActionPreference = 'Stop'
# A Node process launched from PowerShell 7 can inherit its PSModulePath while
# invoking Windows PowerShell 5. Load this host's built-ins, not the other edition.
foreach ($desktopModule in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Security')) {
  Import-Module (Join-Path $PSHOME ('Modules/' + $desktopModule)) -ErrorAction Stop
}
$InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
$statePath = Join-Path $InstallDirectory 'install-state.json'
function Save-State($State) { [IO.File]::WriteAllText($statePath, ($State | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false)) }
function Notify-Environment {
  if (-not ('DesktopControlEnvironment' -as [type])) {
    Add-Type 'using System; using System.Runtime.InteropServices; public static class DesktopControlEnvironment { [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r); }'
  }
  $result = [UIntPtr]::Zero
  [void][DesktopControlEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$result)
}
function Is-OwnedEntry([string]$Value) {
  if (-not $Value) { return $false }
  try {
    $resolved = [IO.Path]::GetFullPath($Value)
    return $resolved.StartsWith($InstallDirectory.TrimEnd('\','/') + '\', [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -eq 'codex-desktop-control.exe'
  } catch { return $false }
}
if ($Mode -eq 'Repair') {
  $current = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User')
  $existing = $null
  $oldStateText = $null
  if (Test-Path -LiteralPath $statePath) {
    $oldStateText = [IO.File]::ReadAllText($statePath)
    try { $existing = $oldStateText | ConvertFrom-Json } catch { }
  }
  # Do not replace a deliberately configured third-party launcher. A dangling
  # entry under our installation is ours even when its state file disappeared.
  if ($current -and -not (Is-OwnedEntry $current)) { throw 'CODEX_CLI_PATH changed by another tool; refusing to overwrite it.' }
  $preparedIsUsable = $false
  if ($existing -and (Is-OwnedEntry $existing.launcher) -and (Test-Path -LiteralPath $existing.launcher)) {
    try {
      $configPath = Join-Path (Split-Path -LiteralPath $existing.launcher) 'desktop-control.config'
      $config = [IO.File]::ReadAllLines($configPath)
      $runtime = Get-Content -LiteralPath (Join-Path (Split-Path -LiteralPath $existing.launcher) 'runtime.json') -Raw | ConvertFrom-Json
      $preparedIsUsable = $config.Length -eq 5 -and (Test-Path -LiteralPath $config[1]) -and (Test-Path -LiteralPath $config[2]) -and (Test-Path -LiteralPath $runtime.realCodex)
      $runtimeRoot = (Split-Path -LiteralPath $existing.launcher).TrimEnd('\','/') + '\'
      if (-not $config[1].StartsWith($runtimeRoot, [StringComparison]::OrdinalIgnoreCase)) { $preparedIsUsable = $false }
      $currentBrokerSource = Join-Path $PSScriptRoot 'desktop-broker/broker.mjs'
      if ((Test-Path -LiteralPath $currentBrokerSource) -and (Get-FileHash -LiteralPath $currentBrokerSource -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $config[2] -Algorithm SHA256).Hash) { $preparedIsUsable = $false }
      $officialRoot = Join-Path $env:LOCALAPPDATA 'OpenAI/Codex/bin'
      $latestOfficial = Get-ChildItem -LiteralPath $officialRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'codex.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Sort-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } -Descending | Select-Object -First 1
      if ($latestOfficial -and $runtime.realCodex -ne $latestOfficial) { $preparedIsUsable = $false }
      foreach ($helper in @('codex-code-mode-host.exe','codex-windows-sandbox-setup.exe','codex-command-runner.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path (Split-Path -LiteralPath $existing.launcher) $helper))) { $preparedIsUsable = $false }
      }
    } catch { $preparedIsUsable = $false }
  }
  if ($preparedIsUsable) {
    if (-not $existing.active -or $current -ne $existing.launcher) {
      $previous = if ($existing.active) { $existing.previousUserValue } else { $current }
      if (Is-OwnedEntry $previous) { $previous = $null }
      if ($previous -and -not (Test-Path -LiteralPath $previous)) { $previous = $null }
      $existing | Add-Member -NotePropertyName previousUserValue -NotePropertyValue $previous -Force
      $existing | Add-Member -NotePropertyName active -NotePropertyValue $true -Force
      Save-State $existing
      [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $existing.launcher, 'User'); Notify-Environment
    }
    Write-Output 'Desktop sharing entry is ready. Completely quit and reopen Codex to activate it in the running app.'
    return
  }
  # Keep a valid original override; never make Restore return to our dead path.
  $previous = if ($existing -and $existing.active) { $existing.previousUserValue } else { $current }
  if (Is-OwnedEntry $previous) { $previous = $null }
  if ($previous -and -not (Test-Path -LiteralPath $previous)) { $previous = $null }
  try {
    if ($existing) { $existing | Add-Member -NotePropertyName active -NotePropertyValue $false -Force; Save-State $existing }
    elseif ($oldStateText) { [IO.File]::WriteAllText($statePath, '{"version":1,"active":false}', [Text.UTF8Encoding]::new($false)) }
    & $PSCommandPath -Mode Prepare -InstallDirectory $InstallDirectory -NodePath $NodePath -RealCodexPath $RealCodexPath
    $prepared = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $prepared.previousUserValue = $previous; $prepared.active = $true; Save-State $prepared
    [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $prepared.launcher, 'User'); Notify-Environment
    Write-Output 'Desktop sharing installation repaired and activated. Completely quit and reopen Codex once.'
  } catch {
    if ($oldStateText -and (Test-Path -LiteralPath $InstallDirectory)) { [IO.File]::WriteAllText($statePath, $oldStateText, [Text.UTF8Encoding]::new($false)) }
    throw
  }
  return
}
if ($Mode -ne 'Prepare') {
  if (-not (Test-Path -LiteralPath $statePath)) { throw 'Run Prepare first; no installation state exists.' }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $current = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User')
  if ($Mode -eq 'Activate') {
    if ($state.active) {
      if ($current -ne $state.launcher) { throw 'CODEX_CLI_PATH changed after activation; refusing to overwrite it.' }
      Write-Output 'Already activated. Restart Codex when your work is saved.'; return
    }
    if (-not (Test-Path -LiteralPath $state.launcher)) { throw 'Prepared launcher is missing.' }
    $state.previousUserValue = $current
    # Save the old value before writing registry, so an interrupted activation is reversible.
    $state.active = $true; Save-State $state
    try { [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $state.launcher, 'User') }
    catch { $state.active = $false; Save-State $state; throw }
    Notify-Environment
    Write-Output 'Activated for future Codex launches. Current Codex processes and conversations are unchanged.'
  } else {
    if (-not $state.active) { Write-Output 'No active override to restore.'; return }
    if ($current -ne $state.launcher -and $current -ne $state.previousUserValue) { throw 'CODEX_CLI_PATH was changed by another tool; refusing to overwrite that newer value.' }
    [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $state.previousUserValue, 'User')
    $state.active = $false; Save-State $state; Notify-Environment
    Write-Output 'Previous user CODEX_CLI_PATH restored. Restart Codex when your work is saved; no running process was stopped.'
  }
  return
}
if (Test-Path -LiteralPath $statePath) {
  $existing = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if ($existing.active) { throw 'Installation is active. Restore before preparing an updated launcher.' }
}
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
if (-not $RealCodexPath) {
  $codexRoot = Join-Path $env:LOCALAPPDATA 'OpenAI/Codex/bin'
  $RealCodexPath = Get-ChildItem -LiteralPath $codexRoot -Directory | ForEach-Object { Join-Path $_.FullName 'codex.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Sort-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } -Descending | Select-Object -First 1
}
if (-not $RealCodexPath -or -not (Test-Path -LiteralPath $RealCodexPath)) { throw 'Official Codex executable was not found; pass -RealCodexPath.' }
$RealCodexPath = [IO.Path]::GetFullPath($RealCodexPath)
$NodePath = [IO.Path]::GetFullPath($NodePath)
New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
# Keep discovery credentials private to this Windows account and SYSTEM.
# Build only a new DACL. Reusing Get-Acl's descriptor on a protected directory can
# carry owner/audit sections into Set-Acl and demand SeSecurityPrivilege on a
# second Prepare. The user does not need administrative or auditing privileges.
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagate = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($userSid, 'FullControl', $inherit, $propagate, $allow))
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'), 'FullControl', $inherit, $propagate, $allow))
if ([IO.Directory].GetMethod('SetAccessControl', [type[]]@([string], [Security.AccessControl.DirectorySecurity]))) {
  [IO.Directory]::SetAccessControl($InstallDirectory, $acl)
} else {
  [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($InstallDirectory), $acl)
}
$source = Join-Path $PSScriptRoot 'desktop-broker'
if (-not (Test-Path -LiteralPath $source)) { throw 'Run Prepare from the source checkout; installed copy supports Activate and Restore.' }
$runtime = Join-Path $InstallDirectory ('runtime-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $runtime | Out-Null
Get-ChildItem -LiteralPath $source -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $runtime }
# Codex-managed caches rotate on updates. Keep the standalone Windows Node
# runtime alongside the launcher so its configured path survives cache cleanup.
$stableNodePath = Join-Path $runtime 'node.exe'
Copy-Item -LiteralPath $NodePath -Destination $stableNodePath
if ((Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $stableNodePath -Algorithm SHA256).Hash) { throw 'Node runtime copy verification failed.' }
$NodePath = $stableNodePath
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
$launcherPath = Join-Path $runtime 'codex-desktop-control.exe'
$compiledSource = Join-Path $runtime 'launcher.cs'
$embeddedConfig = (Join-Path $runtime 'desktop-control.config').Replace('"','""')
$launcherSource = (Get-Content -LiteralPath $compiledSource -Raw).Replace('__DESKTOP_CONTROL_CONFIG_PATH__', $embeddedConfig)
[IO.File]::WriteAllText($compiledSource, $launcherSource, [Text.UTF8Encoding]::new($false))
& $csc /nologo /target:exe "/out:$launcherPath" $compiledSource
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
$configuration = @('version=1', $NodePath, (Join-Path $runtime 'broker.mjs'), $runtime, $InstallDirectory)
[IO.File]::WriteAllLines((Join-Path $runtime 'desktop-control.config'), $configuration, [Text.UTF8Encoding]::new($false))
$runtimeFiles = @()
$realBinDirectory = Split-Path -LiteralPath $RealCodexPath
foreach ($helper in @('codex-code-mode-host.exe','codex-windows-sandbox-setup.exe','codex-command-runner.exe')) {
  $sourceHelper = Join-Path $realBinDirectory $helper
  if (-not (Test-Path -LiteralPath $sourceHelper)) { throw "Official runtime sibling is missing: $helper. Prepare requires a complete Codex runtime bundle." }
  $destinationHelper = Join-Path $runtime $helper
  Copy-Item -LiteralPath $sourceHelper -Destination $destinationHelper
  $sourceHash = (Get-FileHash -LiteralPath $sourceHelper -Algorithm SHA256).Hash
  $destinationHash = (Get-FileHash -LiteralPath $destinationHelper -Algorithm SHA256).Hash
  if ($sourceHash -ne $destinationHash) { throw "Runtime sibling copy verification failed: $helper" }
  $runtimeFiles += @{name=$helper; source=$sourceHelper; sha256=$sourceHash}
}
[IO.File]::WriteAllText((Join-Path $runtime 'runtime.json'), (@{realCodex=$RealCodexPath; realCodexSha256=(Get-FileHash -LiteralPath $RealCodexPath -Algorithm SHA256).Hash; siblings=$runtimeFiles} | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $InstallDirectory 'install-desktop-control.ps1') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'restore-desktop-control.ps1') -Destination (Join-Path $InstallDirectory 'restore-desktop-control.ps1') -Force
Save-State ([pscustomobject]@{version=1; active=$false; launcher=$launcherPath; realCodex=$RealCodexPath; previousUserValue=$null; preparedAt=[DateTime]::UtcNow.ToString('o')})
Write-Output "Prepared launcher: $launcherPath"
Write-Output 'No environment variable has been changed. Activate only after reviewing and saving current work.'
