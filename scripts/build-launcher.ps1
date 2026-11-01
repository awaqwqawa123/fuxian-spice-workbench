[CmdletBinding()]
param([string]$OutputPath = '')
$ErrorActionPreference = 'Stop'
if (!$OutputPath) { $OutputPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'Fuxian.exe' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$compiler = $null
foreach ($folder in @('Framework64','Framework')) {
    $candidate = Join-Path $env:WINDIR "Microsoft.NET\$folder\v4.0.30319\csc.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $compiler = $candidate; break }
}
if (!$compiler) { throw 'The built-in .NET Framework C# compiler was not found. Use the prebuilt Windows package.' }
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPath)) | Out-Null
$arguments = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001', "/out:$OutputPath", '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', (Join-Path $PSScriptRoot 'launcher.cs'))
$diagnostics = & $compiler @arguments 2>&1
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $OutputPath -PathType Leaf)) { throw "Launcher compilation failed: $($diagnostics -join [Environment]::NewLine)" }
Write-Output $OutputPath
