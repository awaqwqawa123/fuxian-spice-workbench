// Run against a sanitized public source snapshot, never the private checkout.
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function portableDependencyPaths(lock, moduleRoot) {
  return Object.keys(lock.packages ?? {}).filter(path => path.startsWith('node_modules/') && existsSync(join(moduleRoot, path.slice('node_modules/'.length))))
}

export function assertPublicSnapshot(root) {
  if (!existsSync(join(root, 'PUBLIC-SNAPSHOT.json')) || !existsSync(join(root, 'LICENSE'))) throw new Error('Package only a sanitized public source snapshot with PUBLIC-SNAPSHOT.json and LICENSE')
  for (const forbidden of ['model-library', '.desktop-circuit', '.desktop-control', '.codex-sessions', '.hapi-local', '.hapi-bridge', '.env']) {
    if (existsSync(join(root, forbidden))) throw new Error(`Private runtime/data found in public staging root: ${forbidden}`)
  }
}

const launcherSources = ['scripts/launcher.cs', 'scripts/build-launcher.ps1', 'scripts/launcher-service.ps1', 'scripts/launch-portable.ps1', 'scripts/local-service.ps1', 'scripts/local-service-host.mjs', 'scripts/local-service-startup.ps1', 'scripts/local-service-runtime.ps1', 'scripts/local-service-hidden.vbs', 'scripts/serve-local.mjs']

/** Generate fixed, ASCII-only commands; paths are passed as arguments, never PowerShell code. */
export function portableLauncherFiles() {
  const gui = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    ...['Fuxian.exe', 'WINDOWS-PORTABLE.json', 'runtime/node.exe', 'dist/index.html', 'node_modules/vite/package.json', ...launcherSources].map(path => `if not exist "%~dp0${path.replaceAll('/', '\\')}" goto incomplete`),
    'start "" "%~dp0Fuxian.exe"',
    'if errorlevel 1 goto launchfailed',
    'exit /b 0',
    ':incomplete',
    'echo Please fully extract the ZIP into a writable folder before launching.',
    'echo Required application files are missing. Download and extract the complete Windows package.',
    'pause',
    'exit /b 1',
    ':launchfailed',
    'echo Windows could not open Fuxian.exe.',
    'pause',
    'exit /b 1',
    '',
  ].join('\r\n')
  const files = { '启动伏线.cmd': gui, 'Launch-Fuxian.cmd': gui }
  for (const [name, action] of [['Start-Fuxian.cmd', 'Start'], ['Stop-Fuxian.cmd', 'Stop'], ['Status-Fuxian.cmd', 'Status']]) {
    files[name] = `@echo off\r\nsetlocal DisableDelayedExpansion\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\launch-portable.ps1" -Action ${action}\r\nif errorlevel 1 pause\r\n`
  }
  return files
}

export function writePortableLaunchers(output) {
  for (const [name, command] of Object.entries(portableLauncherFiles())) writeFileSync(join(output, name), command, 'utf8')
}

export function packageWindows({ root, output, nodePath, modules = join(root, 'node_modules'), zip = true }) {
  root = resolve(root); output = resolve(output); modules = realpathSync(modules)
  assertPublicSnapshot(root)
  if (!existsSync(join(root, 'dist/index.html'))) throw new Error('Build the public frontend before packaging')
  for (const path of launcherSources) if (!existsSync(join(root, path))) throw new Error(`Launcher source is missing from public snapshot: ${path}`)
  if (process.platform !== 'win32') throw new Error('Build Windows portable packages on Windows so the native GUI launcher can be compiled')
  if (existsSync(output) || existsSync(`${output}.zip`)) throw new Error('Output must be new; existing release artifacts are never overwritten')
  const within = relative(root, output)
  if (!isAbsolute(within) && within !== '..' && !within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Place output outside source root')
  if (!nodePath || !existsSync(nodePath)) throw new Error('Supply a Windows x64 Node executable with --node')
  const executable = readFileSync(nodePath)
  if (executable.subarray(0, 2).toString() !== 'MZ') throw new Error('Portable runtime must be a Windows executable')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const allowedRoots = new Set(['src', 'server', 'scripts', 'public', 'dist', 'docs', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'README.md', 'PUBLIC-SNAPSHOT.json', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'index.html', 'run-workbench.cmd'])
  mkdirSync(output, { recursive: true })
  for (const entry of readdirSync(root)) if (allowedRoots.has(entry)) cpSync(join(root, entry), join(output, entry), { recursive: true })
  // Compile at release time; end users receive a ready-to-run Windows GUI executable.
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(output, 'scripts', 'build-launcher.ps1'), '-OutputPath', join(output, 'Fuxian.exe')], { windowsHide: true, stdio: 'inherit' })
  if (!existsSync(join(output, 'Fuxian.exe')) || readFileSync(join(output, 'Fuxian.exe')).subarray(0, 2).toString() !== 'MZ') throw new Error('Launcher build did not produce a Windows executable: Fuxian.exe')
  const dependencies = portableDependencyPaths(lock, modules)
  for (const entry of dependencies) {
    const path = entry.slice('node_modules/'.length), from = join(modules, path), to = join(output, 'node_modules', path)
    cpSync(from, to, { recursive: true, dereference: true, filter: value => {
      const parts = relative(from, value).split(/[\\/]/)
      return !parts.includes('node_modules') && !parts.includes('.cache') && !parts.includes('.vite') && !parts.includes('.git')
    } })
  }
  // Preserve every package's shipped notices/sources, not merely a license list.
  mkdirSync(join(output, 'runtime'), { recursive: true })
  copyFileSync(nodePath, join(output, 'runtime', 'node.exe'))
  const nodeLicense = join(dirname(nodePath), 'NODE-LICENSE.txt')
  if (!existsSync(nodeLicense)) throw new Error('NODE-LICENSE.txt must accompany the supplied Node executable')
  copyFileSync(nodeLicense, join(output, 'runtime', 'NODE-LICENSE.txt'))
  writePortableLaunchers(output)
  writeFileSync(join(output, 'WINDOWS-PORTABLE.json'), JSON.stringify({ version: pkg.version, platform: 'win32-x64', createdAt: new Date().toISOString(), nodeSha256: createHash('sha256').update(executable).digest('hex'), dependencies: dependencies.length, mode: 'production', startup: '启动伏线.cmd', alternateStartup: 'Launch-Fuxian.cmd', executable: 'Fuxian.exe', launcher: 'scripts/launcher.cs', sourceSnapshot: 'PUBLIC-SNAPSHOT.json', excluded: ['private vendor snapshots', 'accounts and credentials', 'user project and conversation data'] }, null, 2) + '\n')
  const notices = dependencies.map(path => ({ path, version: lock.packages[path].version, license: lock.packages[path].license ?? 'See package notices' }))
  writeFileSync(join(output, 'DEPENDENCY-LICENSES.json'), JSON.stringify(notices, null, 2) + '\n')
  if (zip) execFileSync('tar.exe', ['-a', '-cf', `${output}.zip`, '-C', dirname(output), basename(output)], { stdio: 'inherit', windowsHide: true })
  return { output, archive: zip ? `${output}.zip` : undefined, version: pkg.version, dependencies: dependencies.length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }
  const output = value('--output')
  if (!output) throw new Error('Usage: node scripts/package-windows.mjs --output NEW_DIRECTORY --node WINDOWS_NODE_EXE [--modules NODE_MODULES] [--no-zip]')
  console.log(JSON.stringify(packageWindows({ root: process.cwd(), output, nodePath: value('--node'), modules: value('--modules'), zip: !args.includes('--no-zip') })))
}
