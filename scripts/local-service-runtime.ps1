# Keep the service runtime outside Codex's replaceable application/runtime folders.
# This file is dot-sourced by the manager after its per-service mutex is acquired.
function Test-ServiceNode([string]$candidate) {
    if (!$candidate -or !(Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
    try {
        $version = (& $candidate --version 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { return $null }
        $major = [int]$Matches[1]; $minor = [int]$Matches[2]
        if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 12)) { return $null }
        return $version
    } catch { return $null }
}
function Resolve-ServiceNode([string]$explicitNode) {
    $runtimeFile = Join-Path $serviceDirectory 'runtime.json'
    if (!$explicitNode -and (Test-Path -LiteralPath $runtimeFile -PathType Leaf)) {
        try {
            $saved = Get-Content -LiteralPath $runtimeFile -Encoding UTF8 -Raw | ConvertFrom-Json
            $expected = Join-Path $serviceDirectory "runtime\$($saved.sha256)\node.exe"
            if ($saved.sha256 -match '^[0-9A-Fa-f]{64}$' -and
                [string]::Equals($saved.executable, $expected, [StringComparison]::OrdinalIgnoreCase) -and
                (Test-ServiceNode $expected)) { return $expected }
        } catch { # A damaged record is repaired from a validated installed runtime below.
        }
    }
    $candidates = New-Object 'System.Collections.Generic.List[string]'
    if ($explicitNode) { $candidates.Add((Resolve-Path -LiteralPath $explicitNode).Path) }
    else {
        $profileDirectory = [Environment]::GetFolderPath('UserProfile')
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($nodeCommand) { $candidates.Add($nodeCommand.Source) }
        $candidates.Add((Join-Path $profileDirectory '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
        $desktopRuntimeRoot = Join-Path $profileDirectory '.codex\desktop-control'
        if (Test-Path -LiteralPath $desktopRuntimeRoot -PathType Container) {
            foreach ($runtimeDirectory in (Get-ChildItem -LiteralPath $desktopRuntimeRoot -Directory -Filter 'runtime-*' | Sort-Object LastWriteTimeUtc -Descending)) {
                $candidates.Add((Join-Path $runtimeDirectory.FullName 'node.exe'))
            }
        }
    }
    foreach ($candidate in $candidates) {
        $version = Test-ServiceNode $candidate
        if (!$version) { continue }
        $checksum = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
        $runtimeDirectory = Join-Path $serviceDirectory "runtime\$checksum"
        $stableExecutable = Join-Path $runtimeDirectory 'node.exe'
        [IO.Directory]::CreateDirectory($runtimeDirectory) | Out-Null
        # Publish only a complete executable; concurrent managers share the service mutex.
        if (!(Test-Path -LiteralPath $stableExecutable -PathType Leaf) -or !(Test-ServiceNode $stableExecutable)) {
            $temporary = Join-Path $runtimeDirectory ([Guid]::NewGuid().ToString() + '.exe')
            try {
                Copy-Item -LiteralPath $candidate -Destination $temporary
                if (!(Test-ServiceNode $temporary) -or (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $checksum) {
                    throw 'The private Node.js runtime copy did not pass validation.'
                }
                Move-Item -LiteralPath $temporary -Destination $stableExecutable -Force
            } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
        }
        $record = @{ executable = $stableExecutable; sourceExecutable = $candidate; sha256 = $checksum; version = $version; selectedAt = [DateTime]::UtcNow.ToString('o') }
        $record | ConvertTo-Json | Set-Content -LiteralPath ($runtimeFile + '.tmp') -Encoding UTF8
        Move-Item -LiteralPath ($runtimeFile + '.tmp') -Destination $runtimeFile -Force
        return $stableExecutable
    }
    throw 'No working Node.js 22.12 or newer runtime was found. Supply -NodeExecutable once; the service retains a private copy for subsequent starts.'
}
