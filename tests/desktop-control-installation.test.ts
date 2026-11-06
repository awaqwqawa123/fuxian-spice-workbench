import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CodexInstallationError, CodexInstallationStore } from '../server/codex-installation'
import { changeDesktopControlSetup, readDesktopControlSetup } from '../server/desktop-control-setup'
import { createDesktopControlMiddleware } from '../server/desktop-control-middleware'
import type { DesktopControlManager } from '../server/desktop-control-manager'
import { listenOnSafeTestPort } from './helpers/safe-test-port'

const execute = promisify(execFile)
const helpers = ['codex-code-mode-host.exe', 'codex-windows-sandbox-setup.exe', 'codex-command-runner.exe']
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fuxian-setup-installation-')), installation = join(root, 'private installation'), selected = join(root, 'selected Codex & bundle', process.platform === 'win32' ? 'codex.exe' : 'codex')
  await mkdir(dirname(selected), { recursive: true }); await writeFile(selected, 'selected executable fixture', { mode: 0o700 })
  return { root, installation, selected, store: new CodexInstallationStore(join(root, '.desktop-circuit')), close: () => rm(root, { recursive: true, force: true, maxRetries: 3 }) }
}

test('prepare and repair pass only this installation selected executable as a fixed argument; invalid selection never launches installer', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(), calls: { file: string; args: string[] }[] = []
  const run = async (file: string, args: string[]) => { calls.push({ file, args }) }
  try {
    const selected = await f.store.update(f.selected)
    for (const action of ['prepare', 'repair'] as const) await changeDesktopControlSetup(action, f.root, { execute: run, directory: f.installation })
    assert.equal(calls.length, 2)
    for (const call of calls) { assert.equal(call.file, 'powershell.exe'); assert.equal(call.args[call.args.indexOf('-RealCodexPath') + 1], selected); assert.ok(!call.args.includes('-TestEnvironmentFile')) }
    await rm(f.selected)
    await assert.rejects(changeDesktopControlSetup('repair', f.root, { execute: run }), /不存在或无法访问/)
    assert.equal(calls.length, 2)
    // Restore remains available even after a manually selected installation disappears.
    await changeDesktopControlSetup('restore', f.root, { execute: run, directory: f.installation })
    assert.ok(!calls[2].args.includes('-RealCodexPath'))
  } finally { await f.close() }
})

test('setup endpoints report invalid saved paths and refuse to label an old live broker as the newly selected installation', async () => {
  const f = await fixture()
  const bundle = join(f.installation, 'runtime-fixture'), launcher = join(bundle, 'codex-desktop-control.exe'), node = join(bundle, 'node.exe'), broker = join(bundle, 'broker.mjs'), old = join(bundle, 'old-codex.exe')
  await mkdir(bundle, { recursive: true })
  for (const file of [launcher, node, broker, old, ...helpers.map(name => join(bundle, name))]) await writeFile(file, 'fixture')
  await writeFile(join(f.installation, 'install-state.json'), JSON.stringify({ launcher, active: true }))
  await writeFile(join(bundle, 'desktop-control.config'), ['version=1', node, broker, bundle, f.installation].join('\n'))
  await writeFile(join(bundle, 'runtime.json'), JSON.stringify({ realCodex: old }))
  await f.store.update(f.selected)
  let connected = true, ensured = 0, repairs = 0
  const manager = { async reconnectTransport() { return { connected, ready: true, desktopConnected: true } }, async ensure() { ensured++; throw new Error('must not continue old broker') }, async state() { return null } } as unknown as DesktopControlManager
  const middleware = createDesktopControlMiddleware({ directory: join(f.root, '.desktop-control'), projectDirectory: f.root, setupDirectory: f.installation, manager, setupAction: async () => { repairs++; throw new CodexInstallationError(400, '该 Codex 程序不存在或无法访问，请核对完整安装路径') } })
  const server = createServer((req, res) => { void middleware(req, res, () => { res.writeHead(404); res.end() }) }); await listenOnSafeTestPort(server)
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const post = (path: string) => fetch(origin + '/api/desktop-control/' + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Fuxian-Desktop-Control': '1' }, body: '{}' })
  try {
    assert.equal((await readDesktopControlSetup(f.installation, f.root)).stage, 'broken')
    const stale = await (await post('reconnect')).json()
    assert.equal(stale.stage, 'restart-required'); assert.equal(stale.connected, false); assert.equal(stale.restartRequired, true)
    assert.match(stale.message, /当前桌面不一致/); assert.equal(ensured, 0); assert.equal(repairs, 0)
    for (const operation of ['prepare', 'activate']) { const blocked = await post('setup/' + operation); assert.equal(blocked.status, 409); assert.match((await blocked.json()).error, /共享仍在运行/) }
    assert.equal(repairs, 0)
    connected = false
    const failed = await (await post('reconnect')).json(); assert.match(failed.message, /不存在或无法访问/)
    const prepare = await post('setup/prepare'); assert.equal(prepare.status, 400); assert.match((await prepare.json()).error, /不存在或无法访问/)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close() }
})

test('real PowerShell Prepare and Repair honor an explicit bundle and refresh every broker source without registry or desktop operations', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const f = await fixture(), scripts = join(f.root, 'scripts'), environmentFile = join(f.root, 'test-environment.txt'), localAppData = join(f.root, 'fake appdata'), fakeNode = join(f.root, 'node.exe')
  await mkdir(scripts)
  await copyFile(resolve('scripts/install-desktop-control.ps1'), join(scripts, 'install-desktop-control.ps1'))
  await copyFile(resolve('scripts/restore-desktop-control.ps1'), join(scripts, 'restore-desktop-control.ps1'))
  await cp(resolve('scripts/desktop-broker'), join(scripts, 'desktop-broker'), { recursive: true })
  await writeFile(fakeNode, 'node fixture; never executed')
  for (const helper of helpers) await writeFile(join(dirname(f.selected), helper), 'selected sibling ' + helper)
  const newest = join(localAppData, 'OpenAI', 'Codex', 'bin', 'newest', 'codex.exe')
  await mkdir(dirname(newest), { recursive: true }); await writeFile(newest, 'different automatic installation')
  const run = async (mode: string, path = f.selected) => execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(scripts, 'install-desktop-control.ps1'), '-Mode', mode, '-InstallDirectory', f.installation, '-RealCodexPath', path, '-NodePath', fakeNode, '-TestEnvironmentFile', environmentFile], { cwd: f.root, windowsHide: true, timeout: 30000, maxBuffer: 32000, env: { ...process.env, LOCALAPPDATA: localAppData } })
  const state = async () => JSON.parse(await readFile(join(f.installation, 'install-state.json'), 'utf8'))
  const runtime = async () => JSON.parse(await readFile(join(dirname((await state()).launcher), 'runtime.json'), 'utf8'))
  try {
    await run('Prepare'); const first = await state(), originalRuntime = await runtime()
    assert.equal(originalRuntime.realCodex, f.selected); assert.ok(originalRuntime.brokerSources['router.mjs']); assert.ok(originalRuntime.brokerSources['launcher.cs'])
    assert.notEqual(await readFile(join(dirname(first.launcher), 'launcher.cs'), 'utf8'), await readFile(join(scripts, 'desktop-broker', 'launcher.cs'), 'utf8'), 'generated launcher embeds its own path')
    await run('Repair'); assert.equal((await state()).launcher, first.launcher, 'same manually selected bundle stays valid even with another automatic installation')
    assert.equal((await state()).active, true); assert.equal(await readFile(environmentFile, 'utf8'), first.launcher)
    await f.store.update(f.selected); assert.equal((await readDesktopControlSetup(f.installation, f.root)).stage, 'activated')
    await f.store.update(null)
    assert.equal((await readDesktopControlSetup(f.installation, f.root, { CODEX_EXECUTABLE: f.selected })).stage, 'activated', 'automatic selection matching installed bundle is ready')
    assert.equal((await readDesktopControlSetup(f.installation, f.root, { CODEX_EXECUTABLE: newest })).stage, 'broken', 'resetting to a different automatic selection invalidates the old manual runtime')
    await f.store.update(f.selected)
    await appendFile(join(scripts, 'desktop-broker', 'router.mjs'), '\n// new automatic handoff fixture\n')
    assert.equal((await readDesktopControlSetup(f.installation, f.root)).stage, 'broken', 'status detects updated router independently of broker.mjs')
    await run('Repair'); const updated = await state(); assert.notEqual(updated.launcher, first.launcher); assert.equal((await runtime()).realCodex, f.selected)
    assert.equal(await readFile(join(dirname(updated.launcher), 'router.mjs'), 'utf8'), await readFile(join(scripts, 'desktop-broker', 'router.mjs'), 'utf8'))
    await run('Repair'); assert.equal((await state()).launcher, updated.launcher, 'generated launcher.cs must not cause repeated rebuilding')
    await rm(join(dirname(updated.launcher), 'common.mjs')); await run('Repair'); const repaired = await state(); assert.notEqual(repaired.launcher, updated.launcher, 'missing owned code is re-prepared')
    const other = join(f.root, 'other Codex', 'codex.exe'); await mkdir(dirname(other)); await writeFile(other, 'other selected installation')
    for (const helper of helpers) await writeFile(join(dirname(other), helper), 'other sibling ' + helper)
    await run('Repair', other); assert.equal((await runtime()).realCodex, other); assert.notEqual((await state()).launcher, repaired.launcher)
    const saved = await readFile(join(f.installation, 'install-state.json'), 'utf8'), entry = await readFile(environmentFile, 'utf8')
    await assert.rejects(run('Repair', join(f.root, 'missing.exe')), /Selected Codex executable is missing or invalid/)
    assert.equal(await readFile(join(f.installation, 'install-state.json'), 'utf8'), saved); assert.equal(await readFile(environmentFile, 'utf8'), entry)
    const runtimePath = join(dirname((await state()).launcher), 'runtime.json'), legacy = await runtime()
    delete legacy.brokerSources; delete legacy.launcherSha256
    await writeFile(runtimePath, JSON.stringify(legacy)); await run('Repair', other)
    assert.notEqual((await state()).launcher, JSON.parse(saved).launcher, 'legacy installations without a complete source manifest are upgraded')
  } finally { await f.close() }
})
