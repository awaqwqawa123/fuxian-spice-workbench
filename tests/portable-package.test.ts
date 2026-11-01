import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { packageWindows, portableLauncherFiles, writePortableLaunchers } from '../scripts/package-windows.mjs'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "fuxian launcher 100% & ' "))
  const root = join(directory, 'public source'), output = join(directory, 'Windows portable'), nodePath = join(directory, 'node.exe')
  const put = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
  put('PUBLIC-SNAPSHOT.json', '{}'); put('LICENSE', 'MIT')
  put('package.json', JSON.stringify({ version: '0.0.0-test' }))
  put('package-lock.json', JSON.stringify({ packages: { 'node_modules/vite': { version: 'test', license: 'MIT' } } }))
  put('dist/index.html', '<!doctype html><title>Packaged application</title>')
  put('node_modules/vite/package.json', '{"name":"vite","version":"test"}')
  for (const path of ['launcher.cs', 'build-launcher.ps1', 'launcher-service.ps1', 'launch-portable.ps1', 'local-service.ps1', 'local-service-host.mjs', 'local-service-startup.ps1', 'local-service-runtime.ps1', 'local-service-hidden.vbs', 'serve-local.mjs']) put(`scripts/${path}`, `fixture source: ${path}`)
  writeFileSync(nodePath, 'MZ-test-only-runtime'); writeFileSync(join(directory, 'NODE-LICENSE.txt'), 'Node license fixture')
  return { root, output, nodePath, dispose: () => rmSync(directory, { recursive: true, force: true }) }
}

test('GUI launch entries use identical ASCII commands, complete extraction checks and the ready native executable', () => {
  const files = portableLauncherFiles(), command = files['启动伏线.cmd']
  assert.equal(command, files['Launch-Fuxian.cmd'])
  assert.ok([...command].every(character => character.charCodeAt(0) < 128), 'Chinese file names never depend on the batch file code page')
  assert.match(command, /setlocal DisableDelayedExpansion/)
  for (const required of ['Fuxian.exe', 'WINDOWS-PORTABLE.json', 'runtime\\node.exe', 'dist\\index.html', 'node_modules\\vite\\package.json', 'scripts\\launcher.cs', 'scripts\\build-launcher.ps1', 'scripts\\launcher-service.ps1', 'scripts\\launch-portable.ps1', 'scripts\\local-service-host.mjs']) assert.ok(command.includes(`if not exist "%~dp0${required}" goto incomplete`), required)
  assert.ok(command.includes('start "" "%~dp0Fuxian.exe"'))
  assert.match(command, /exit \/b 0/)
  assert.match(command, /Please fully extract the ZIP/)
  assert.doesNotMatch(command, /powershell|build-launcher\.ps1"\s+-|%\*|\bcall\b|\b-Wait\b/i, 'the user launches the built GUI directly, with no compilation, injected user arguments or waiting terminal')
  for (const [name, action] of [['Start-Fuxian.cmd', 'Start'], ['Stop-Fuxian.cmd', 'Stop'], ['Status-Fuxian.cmd', 'Status']]) assert.ok(files[name].includes(`-Action ${action}`))
})

test('a minimal real package compiles a Windows GUI executable and retains sources, launch entries and metadata', { skip: process.platform !== 'win32' }, () => {
  const f = fixture()
  try {
    // Use actual compiler inputs, with one tiny fixture dependency instead of copying the installed tree.
    for (const path of ['launcher.cs', 'build-launcher.ps1']) copyFileSync(new URL(`../scripts/${path}`, import.meta.url), join(f.root, 'scripts', path))
    const result = packageWindows({ root: f.root, output: f.output, nodePath: f.nodePath, zip: false })
    assert.equal(result.dependencies, 1)
    assert.equal(result.archive, undefined)
    assert.equal(readFileSync(join(f.output, 'scripts/launcher.cs'), 'utf8'), readFileSync(new URL('../scripts/launcher.cs', import.meta.url), 'utf8'))
    assert.equal(readFileSync(join(f.output, 'scripts/build-launcher.ps1'), 'utf8'), readFileSync(new URL('../scripts/build-launcher.ps1', import.meta.url), 'utf8'))
    const executable = readFileSync(join(f.output, 'Fuxian.exe'))
    assert.equal(executable.subarray(0, 2).toString(), 'MZ')
    assert.equal(executable.readUInt16LE(executable.readUInt32LE(0x3c) + 24 + 68), 2, 'PE subsystem is Windows GUI rather than a console')
    assert.equal(readFileSync(join(f.output, 'scripts/launcher-service.ps1'), 'utf8'), 'fixture source: launcher-service.ps1')
    assert.equal(readFileSync(join(f.output, 'scripts/launch-portable.ps1'), 'utf8'), 'fixture source: launch-portable.ps1')
    for (const [name, expected] of Object.entries(portableLauncherFiles())) assert.equal(readFileSync(join(f.output, name), 'utf8'), expected)
    const manifest = JSON.parse(readFileSync(join(f.output, 'WINDOWS-PORTABLE.json'), 'utf8'))
    assert.equal(manifest.startup, '启动伏线.cmd')
    assert.equal(manifest.alternateStartup, 'Launch-Fuxian.cmd')
    assert.equal(manifest.launcher, 'scripts/launcher.cs')
    assert.equal(manifest.executable, 'Fuxian.exe')
    assert.equal(manifest.mode, 'production')
    assert.ok(existsSync(join(f.output, 'node_modules/vite/package.json')))
    writePortableLaunchers(f.output)
    assert.equal(readFileSync(join(f.output, '启动伏线.cmd'), 'utf8'), portableLauncherFiles()['启动伏线.cmd'])
  } finally { f.dispose() }
})

test('a public snapshot without GUI launcher source is rejected before producing an incomplete package', () => {
  const f = fixture()
  try {
    rmSync(join(f.root, 'scripts/launcher.cs'))
    assert.throws(() => packageWindows({ root: f.root, output: f.output, nodePath: f.nodePath, zip: false }), /Launcher source is missing.*launcher\.cs/)
    assert.equal(existsSync(f.output), false)
  } finally { f.dispose() }
})

test('cross-platform packaging refuses to silently ship an unbuilt Windows launcher', { skip: process.platform === 'win32' }, () => {
  const f = fixture()
  try {
    assert.throws(() => packageWindows({ root: f.root, output: f.output, nodePath: f.nodePath, zip: false }), /Build Windows portable packages on Windows/)
    assert.equal(existsSync(f.output), false)
  } finally { f.dispose() }
})

test('a public snapshot without the native launcher compiler is rejected before output', () => {
  const f = fixture()
  try {
    rmSync(join(f.root, 'scripts/build-launcher.ps1'))
    assert.throws(() => packageWindows({ root: f.root, output: f.output, nodePath: f.nodePath, zip: false }), /Launcher source is missing.*build-launcher\.ps1/)
    assert.equal(existsSync(f.output), false)
  } finally { f.dispose() }
})

test('a public snapshot without the GUI service helper is rejected before producing an incomplete package', () => {
  const f = fixture()
  try {
    rmSync(join(f.root, 'scripts/launcher-service.ps1'))
    assert.throws(() => packageWindows({ root: f.root, output: f.output, nodePath: f.nodePath, zip: false }), /Launcher source is missing.*launcher-service\.ps1/)
    assert.equal(existsSync(f.output), false)
  } finally { f.dispose() }
})
