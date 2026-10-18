[CmdletBinding()]
param([ValidateSet('Install', 'Status', 'Remove', 'Run')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
if ($Action -eq 'Run') {
    try {
        & (Join-Path $PSScriptRoot 'local-service.ps1') -Action Ensure | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Local service returned exit code $LASTEXITCODE" }
    } catch {
        $logDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\workbench-services'
        [IO.Directory]::CreateDirectory($logDirectory) | Out-Null
        [IO.File]::AppendAllText((Join-Path $logDirectory 'startup-errors.log'), "$(Get-Date -Format o) $($_.Exception.Message)`r`n")
        throw
    }
    exit 0
}
$projectDirectory = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$serviceScript = Join-Path $PSScriptRoot 'local-service.ps1'
$watchdogScript = $MyInvocation.MyCommand.Path
$hiddenLauncher = Join-Path $PSScriptRoot 'local-service-hidden.vbs'
$scriptHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
$hiddenArguments = '//B //NoLogo "' + $hiddenLauncher + '"'
$legacyWatchdogCommand = Join-Path $PSScriptRoot 'local-service-watchdog.cmd'
$startupDirectory = [Environment]::GetFolderPath('Startup')
$linkPath = Join-Path $startupDirectory 'Fuxian Workbench.lnk'
$powershell = Join-Path $PSHOME 'powershell.exe'
$command = Join-Path $env:SystemRoot 'System32\cmd.exe'
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
try { $projectHash = ([BitConverter]::ToString($hashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectDirectory.ToLowerInvariant())))).Replace('-', '').Substring(0, 16) }
finally { $hashAlgorithm.Dispose() }
$taskName = "Fuxian Workbench $projectHash-3032"
$serviceDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) ".codex\workbench-services\$projectHash-3032"
$failureLog = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\workbench-services\startup-errors.log'

function Read-Shortcut {
    if (!(Test-Path -LiteralPath $linkPath -PathType Leaf)) { return $null }
    return $shell.CreateShortcut($linkPath)
}
function Is-OurShortcut($shortcut) {
    return $shortcut -and
        (([string]::Equals($shortcut.TargetPath, $scriptHost, [StringComparison]::OrdinalIgnoreCase) -and
          [string]::Equals($shortcut.Arguments, $hiddenArguments, [StringComparison]::OrdinalIgnoreCase)) -or
         ([string]::Equals($shortcut.TargetPath, $powershell, [StringComparison]::OrdinalIgnoreCase) -and
          ($shortcut.Arguments.Contains(('"' + $watchdogScript + '"')) -or $shortcut.Arguments.Contains(('"' + $serviceScript + '"')))) -or
         ([string]::Equals($shortcut.TargetPath, $command, [StringComparison]::OrdinalIgnoreCase) -and $shortcut.Arguments.Contains(('"' + $legacyWatchdogCommand + '"'))))
}
function Read-Task { return Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
function Is-OurTask($task) {
    return $task -and $task.Actions.Count -eq 1 -and
        (([string]::Equals($task.Actions[0].Execute, $scriptHost, [StringComparison]::OrdinalIgnoreCase) -and
          [string]::Equals($task.Actions[0].Arguments, $hiddenArguments, [StringComparison]::OrdinalIgnoreCase)) -or
         ([string]::Equals($task.Actions[0].Execute, $powershell, [StringComparison]::OrdinalIgnoreCase) -and
          $task.Actions[0].Arguments.Contains(('"' + $watchdogScript + '"'))))
}
function Write-Status {
    $task = Read-Task
    $info = if ($task) { Get-ScheduledTaskInfo -TaskName $taskName } else { $null }
    [ordered]@{
        installed = [bool](Is-OurTask $task)
        enabled = [bool]((Is-OurTask $task) -and $task.State -ne 'Disabled')
        taskName = $taskName
        lastRunTime = if ($info) { $info.LastRunTime } else { $null }
        lastTaskResult = if ($info) { $info.LastTaskResult } else { $null }
        startupShortcut = [bool](Is-OurShortcut (Read-Shortcut))
        path = $linkPath
        projectDirectory = $projectDirectory
        failureLog = $failureLog
    } | ConvertTo-Json -Compress
}

$shell = New-Object -ComObject WScript.Shell
if ($Action -eq 'Status') { Write-Status; exit 0 }

$existingTask = Read-Task
$existingShortcut = Read-Shortcut
if ($existingTask -and !(Is-OurTask $existingTask)) { throw 'A scheduled task with this name belongs to another program; it was not changed.' }
if ($existingShortcut -and !(Is-OurShortcut $existingShortcut)) { throw 'The startup shortcut belongs to another program; it was not changed.' }
if ($Action -eq 'Remove') {
    if ($existingTask) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    if ($existingShortcut) { Remove-Item -LiteralPath $linkPath }
    Write-Status; exit 0
}

# The logon trigger starts promptly. The repeating trigger repairs missed logons
# and restarts a crashed service while the user is signed in.
if (!(Test-Path -LiteralPath $hiddenLauncher -PathType Leaf)) { throw "Hidden launcher was not found: $hiddenLauncher" }
$onLogon = New-ScheduledTaskTrigger -AtLogOn
$repeat = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)
# A GUI script host hides PowerShell before its console can be created.
$actionSpec = New-ScheduledTaskAction -Execute $scriptHost -Argument $hiddenArguments -WorkingDirectory $projectDirectory
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$principal = New-ScheduledTaskPrincipal -UserId $userSid -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $actionSpec -Trigger @($onLogon, $repeat) -Settings $settings -Principal $principal -Force | Out-Null

# The task handles both sign-in and recovery. Retire our duplicate login entry
# only after task registration succeeds, retaining ownership checks for upgrades.
$remainingShortcut = Read-Shortcut
if ($remainingShortcut) {
    if (!(Is-OurShortcut $remainingShortcut)) { throw 'The startup shortcut belongs to another program; it was not changed.' }
    Remove-Item -LiteralPath $linkPath
}
Write-Status
