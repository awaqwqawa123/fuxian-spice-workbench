[CmdletBinding()]
param(
    [ValidateSet('Start', 'Ensure', 'Status', 'Stop')][string]$Action = 'Start',
    [ValidateRange(1024, 65535)][int]$Port = 3032,
    [string]$ProjectDirectory = '',
    [string]$NodeExecutable = '',
    [ValidateRange(2, 120)][int]$TimeoutSeconds = 30
)
$ErrorActionPreference = 'Stop'
if (!$ProjectDirectory) { $ProjectDirectory = Split-Path -Parent $PSScriptRoot }
$ProjectDirectory = (Resolve-Path -LiteralPath $ProjectDirectory).Path
# Directory aliases must share the same service identity after moving a project.
# Resolve the actual checkout before hashing it or validating its host process.
$projectAliases = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
while ($true) {
    if (!$projectAliases.Add($ProjectDirectory)) { throw 'Project directory aliases contain a cycle.' }
    $projectItem = Get-Item -LiteralPath $ProjectDirectory
    if (!$projectItem.LinkType -or !$projectItem.Target) { break }
    $aliasTarget = [string]@($projectItem.Target)[0]
    if (![IO.Path]::IsPathRooted($aliasTarget)) { $aliasTarget = Join-Path (Split-Path -Parent $ProjectDirectory) $aliasTarget }
    $ProjectDirectory = (Resolve-Path -LiteralPath $aliasTarget).Path
}
$hostScript = Join-Path $ProjectDirectory 'scripts\local-service-host.mjs'
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
try { $projectHash = ([BitConverter]::ToString($hashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($ProjectDirectory.ToLowerInvariant())))).Replace('-', '').Substring(0, 16) }
finally { $hashAlgorithm.Dispose() }
# MSIX desktop children may see a virtualized LOCALAPPDATA that WMI cannot see.
# The user profile path is shared by the editor and the independent service.
$serviceDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) ".codex\workbench-services\$projectHash-$Port"
$stateFile = Join-Path $serviceDirectory 'state.json'
$pausedFile = Join-Path $serviceDirectory 'paused'
function Read-State {
    if (Test-Path -LiteralPath $stateFile) {
        try { return Get-Content -LiteralPath $stateFile -Encoding UTF8 -Raw | ConvertFrom-Json }
        catch { throw "Local service state cannot be read safely. Logs and state were retained: $serviceDirectory. $($_.Exception.Message)" }
    }
    return $null
}
function Get-OwnedHost($state) {
    if (!$state -or $state.projectDirectory -ne $ProjectDirectory -or $state.port -ne $Port) { return $null }
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$state.hostPid)" -ErrorAction Stop
    # A unique configuration path identifies this exact run, even if Windows has reused its PID.
    if ($candidate -and $candidate.CommandLine -and
        $candidate.CommandLine.Contains($hostScript) -and $candidate.CommandLine.Contains([string]$state.configPath) -and
        ([IO.Path]::GetFileName([string]$state.configPath)) -eq "$($state.serviceId).json") { return $candidate }
    return $null
}
function Write-Status($state, [bool]$running) {
    $result = [ordered]@{ running = $running; managedHostRunning = $running; status = 'stopped'; port = $Port; url = "http://localhost:$Port"; projectDirectory = $ProjectDirectory; serviceDirectory = $serviceDirectory; paused = (Test-Path -LiteralPath $pausedFile) }
    if ($state) {
        $result.status = $(if ($running -or $state.status -eq 'failed') { $state.status } else { 'stopped' })
        $result.hostPid = $state.hostPid; $result.childPid = $state.childPid
        $result.stdoutPath = $state.stdoutPath; $result.stderrPath = $state.stderrPath
        $result.nodeExecutable = $state.nodeExecutable
        $result.lastExitCode = $state.lastExitCode; $result.updatedAt = $state.updatedAt
        if ($running -and $state.status -eq 'ready') {
            $readyListener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $state.childPid
            $result.running = [bool]$readyListener
            if (!$readyListener) { $result.status = 'recovering' }
        } elseif ($running) { $result.running = $false }
    }
    $result | ConvertTo-Json -Compress
}
$serviceMutex = New-Object Threading.Mutex($false, "Local\FuxianWorkbench-$projectHash-$Port")
$mutexHeld = $false
try {
try { $mutexHeld = $serviceMutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds + 2)) }
catch [Threading.AbandonedMutexException] { $mutexHeld = $true }
if (!$mutexHeld) { throw 'Another local service command is still running. Retry after it finishes.' }
$state = Read-State
$ownedHost = Get-OwnedHost $state
if ($Action -eq 'Status') { Write-Status $state ([bool]$ownedHost); exit 0 }
if ($Action -eq 'Stop') {
    [IO.Directory]::CreateDirectory($serviceDirectory) | Out-Null
    [IO.File]::WriteAllText($pausedFile, 'paused')
    if (!$ownedHost) { Write-Status $state $false; exit 0 }
    # The service handles this request by closing Vite and all middleware gracefully.
    $stopFile = Join-Path $serviceDirectory "$($state.serviceId).stop"
    [IO.File]::WriteAllText($stopFile, [string]$state.serviceId)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 200
        if (!(Get-OwnedHost $state)) { Write-Status (Read-State) $false; exit 0 }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "The local service did not finish closing within $TimeoutSeconds seconds. No process was forcibly killed. Logs: $serviceDirectory"
}
if ($Action -eq 'Ensure' -and (Test-Path -LiteralPath $pausedFile)) { Write-Status $state ([bool]$ownedHost); exit 0 }
if ($Action -eq 'Start' -and (Test-Path -LiteralPath $pausedFile)) { Remove-Item -LiteralPath $pausedFile }
if ($ownedHost) { Write-Status $state $true; exit 0 }
$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listener) { throw "Port $Port is already in use. This command will not replace or stop an unmanaged process. Stop the verified previous service first, then retry." }
if (!(Test-Path -LiteralPath $hostScript -PathType Leaf)) { throw "Service host was not found: $hostScript" }
[IO.Directory]::CreateDirectory($serviceDirectory) | Out-Null
. (Join-Path $PSScriptRoot 'local-service-runtime.ps1')
$NodeExecutable = Resolve-ServiceNode $NodeExecutable
$serviceId = [Guid]::NewGuid().ToString()
$runConfig = Join-Path $serviceDirectory "$serviceId.json"
@{ directory = $serviceDirectory; projectDirectory = $ProjectDirectory; port = $Port; serviceId = $serviceId; nodeExecutable = $NodeExecutable } |
    ConvertTo-Json | Set-Content -LiteralPath $runConfig -Encoding UTF8
# Win32_Process.Create starts the host under WMI, outside the caller's Windows Job.
# Start-Process / Node detached would still inherit an editor Job with KillOnClose.
$startup = New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$commandLine = '"' + $NodeExecutable + '" "' + $hostScript + '" "' + $runConfig + '"'
try {
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $ProjectDirectory; ProcessStartupInformation = $startup }
} catch { throw "Independent service launch through Windows WMI failed. No security settings were changed. $($_.Exception.Message)" }
if ($created.ReturnValue -ne 0) { throw "Windows WMI refused independent service launch (code $($created.ReturnValue)). No security settings were changed." }
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
    Start-Sleep -Milliseconds 200
    $current = Read-State
    if ($current -and $current.serviceId -eq $serviceId) {
        if ($current.status -eq 'ready' -and (Get-OwnedHost $current)) { Write-Status $current $true; exit 0 }
        if ($current.status -eq 'failed' -or $current.status -eq 'stopped') { throw "The local service stopped during startup. Logs: $serviceDirectory" }
    }
    if (!(Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$created.ProcessId)")) { throw "The independent service host exited during startup. Logs: $serviceDirectory" }
} while ([DateTime]::UtcNow -lt $deadline)
throw "The local service is still starting after $TimeoutSeconds seconds. Use -Action Status to inspect it. Logs: $serviceDirectory"
} finally {
    if ($mutexHeld) { $serviceMutex.ReleaseMutex() }
    $serviceMutex.Dispose()
}
