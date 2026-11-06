import { listenOnSafeTestPort } from './helpers/safe-test-port'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDesktopControlSetup } from '../server/desktop-control-setup'
import { createDesktopControlMiddleware } from '../server/desktop-control-middleware'
import type { DesktopControlManager } from '../server/desktop-control-manager'

test('desktop setup reports installation stages without exposing local paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-setup-test-'))
  const statePath = join(directory, 'install-state.json'), launcher = join(directory, 'launcher.exe')
  try {
    assert.deepEqual(await readDesktopControlSetup(directory), { stage: 'not-prepared' })
    await writeFile(statePath, JSON.stringify({ launcher, active: false }))
    assert.deepEqual(await readDesktopControlSetup(directory), { stage: 'broken' })
    await writeFile(launcher, '')
    const node = join(directory, 'node.exe'), broker = join(directory, 'broker.mjs'), codex = join(directory, 'codex.exe')
    for (const file of [node, broker, codex, ...['codex-code-mode-host.exe', 'codex-windows-sandbox-setup.exe', 'codex-command-runner.exe'].map(name => join(directory, name))]) await writeFile(file, 'fixture')
    await writeFile(join(directory, 'desktop-control.config'), ['version=1', node, broker, directory, directory].join('\n'))
    await writeFile(join(directory, 'runtime.json'), JSON.stringify({ realCodex: codex }))
    assert.deepEqual(await readDesktopControlSetup(directory), { stage: 'prepared' })
    await writeFile(statePath, JSON.stringify({ launcher, active: true }))
    assert.deepEqual(await readDesktopControlSetup(directory), { stage: 'activated' })
    await writeFile(statePath, '{')
    assert.deepEqual(await readDesktopControlSetup(directory), { stage: 'broken' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('visual setup accepts only a fixed same-origin action and empty body', async () => {
  const calls: string[] = []
  const middleware = createDesktopControlMiddleware({
    directory: 'unused', projectDirectory: 'unused', manager: {} as DesktopControlManager,
    setupAction: async action => { calls.push(action); return { stage: 'prepared' } },
  })
  const server = createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end() }) })
  await listenOnSafeTestPort(server)
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`, url = `${origin}/api/desktop-control/setup/prepare`
  const headers = { Origin: origin, 'X-Fuxian-Desktop-Control': '1', 'Content-Type': 'application/json' }
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://example.test' }, body: '{}' })).status, 403)
    assert.equal((await fetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{"command":"arbitrary"}' })).status, 400)
    assert.equal((await fetch(url, { method: 'GET', headers })).status, 405)
    assert.deepEqual(calls, [])
    const response = await fetch(url, { method: 'POST', headers, body: '{}' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { stage: 'prepared' })
    assert.deepEqual(calls, ['prepare'])
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
