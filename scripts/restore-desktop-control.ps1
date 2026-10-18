[CmdletBinding()]
param([string]$InstallDirectory = (Join-Path $env:USERPROFILE '.codex/desktop-control'))
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'install-desktop-control.ps1'
& $installer -Mode Restore -InstallDirectory $InstallDirectory
