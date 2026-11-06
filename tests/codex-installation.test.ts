import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { chmod, copyFile, link, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexInstallationStore, configureCodexInstallation } from '../server/codex-installation'
import { createCodexInstallationMiddleware } from '../server/codex-installation-middleware'
import { findCodexExecutable, getCodexStatus } from '../server/codex-runtime'
import { listenOnSafeTestPort } from './helpers/safe-test-port'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fuxian-codex-path-'))
  const filename = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const first = join(root, 'first installation', filename), automatic = join(root, 'automatic', filename)
  for (const file of [first, automatic]) { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'location-only test fixture'); await chmod(file, 0o700) }
  return { root, first, automatic, store: new CodexInstallationStore(join(root, '.desktop-circuit')), close: () => rm(root, { recursive: true, force: true, maxRetries: 3 }) }
}

test('Codex installation persists a quoted path with spaces, validates replacements before writing, and restores automatic discovery', async () => {
  const f = await fixture()
  try {
    assert.equal(await f.store.read(), null)
    const selected = await f.store.update(`"${f.first}"`)
    assert.equal(await new CodexInstallationStore(f.store.directory).selectedExecutable(), selected)
    const original = await readFile(join(f.store.directory, 'codex-installation.json'), 'utf8')
    const directory = join(f.root, process.platform === 'win32' ? 'folder.exe' : 'codex')
    await mkdir(directory)
    for (const bad of ['', 'relative/codex.exe', f.first + ' --unsafe', join(f.root, 'missing', process.platform === 'win32' ? 'codex.exe' : 'codex'), join(f.root, 'launch.cmd'), directory]) {
      await assert.rejects(f.store.update(bad))
      assert.equal(await readFile(join(f.store.directory, 'codex-installation.json'), 'utf8'), original)
    }
    await assert.rejects(f.store.update(f.first.slice(0, 3) + '\n' + f.first.slice(3)))
    await f.store.update(null)
    assert.equal(await f.store.read(), null)
    await writeFile(join(f.store.directory, 'codex-installation.json'), '{broken')
    await assert.rejects(f.store.read(), /损坏/)
    await f.store.update(null)
    assert.equal(await f.store.read(), null, 'explicit reset can recover corrupted settings without reading credentials')
  } finally { await f.close() }
})

test('configured Codex selection wins automatic environment discovery and deletion never falls back to another installation', async () => {
  const f = await fixture(), previousEnvironment = process.env.CODEX_EXECUTABLE
  try {
    const store = configureCodexInstallation(f.root)
    const selected = await store.update(f.first)
    assert.equal(await findCodexExecutable({ CODEX_EXECUTABLE: f.automatic }), selected)
    assert.equal(await findCodexExecutable({ CODEX_EXECUTABLE: f.automatic }, { ignoreConfigured: true }), f.automatic)
    await rm(f.first)
    await assert.rejects(findCodexExecutable({ CODEX_EXECUTABLE: f.automatic }), /不存在或无法访问/)
    const unavailable = await getCodexStatus()
    assert.equal(unavailable.available, false)
    assert.match(unavailable.message, /不存在或无法访问/)
    await store.update(null)
    assert.equal(await findCodexExecutable({ CODEX_EXECUTABLE: f.automatic }), f.automatic)
    assert.equal(process.env.CODEX_EXECUTABLE, previousEnvironment, 'selection never mutates the server environment')
  } finally { await f.close() }
})

test('installation HTTP API enforces loopback origin, bounded JSON, preserved errors and real selected paths', async () => {
  const f = await fixture()
  const middleware = createCodexInstallationMiddleware({ store: f.store, findAutomatic: async () => f.automatic })
  const server = createServer((req, res) => { void middleware(req, res, () => { res.writeHead(404); res.end() }) })
  await listenOnSafeTestPort(server)
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`, url = origin + '/api/codex/installation'
  const get = (headers: Record<string, string> = {}) => fetch(url, { headers: { 'X-Fuxian-Codex-Installation': '1', ...headers } })
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { Origin: origin, 'X-Fuxian-Codex-Installation': '1', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  try {
    const initial = await get(); assert.equal(initial.status, 200); assert.equal(initial.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await initial.json(), { configuredPath: null, effectivePath: f.automatic, source: 'automatic', available: true, message: '使用环境变量、PATH 或默认安装位置自动检测到的 Codex 程序。' })
    assert.equal((await get({ Origin: 'https://other.invalid' })).status, 403)
    assert.equal((await get({ 'Sec-Fetch-Site': 'cross-site' })).status, 403)
    assert.equal((await get({ 'X-Fuxian-Codex-Installation': '' })).status, 403)
    assert.equal((await post({ executable: f.first }, { Origin: '' })).status, 403)
    assert.equal((await post({ executable: f.first }, { 'Content-Type': 'text/plain' })).status, 415)
    assert.equal((await post({ executable: f.first, args: ['--foo'] })).status, 400)
    assert.equal((await post({ executable: 'x'.repeat(9000) })).status, 413)
    const selected = await post({ executable: f.first }); assert.equal(selected.status, 200)
    const value = await selected.json(); assert.equal(value.source, 'manual'); assert.equal(value.configuredPath, await f.store.read())
    for (const bad of ['', 'relative', 'bad.cmd']) {
      assert.equal((await post({ executable: bad })).status, 400)
      assert.equal(await f.store.read(), value.configuredPath)
    }
    await rm(f.first)
    const unavailable = await (await get()).json(); assert.equal(unavailable.available, false); assert.equal(unavailable.source, 'manual'); assert.equal(unavailable.effectivePath, null)
    const reset = await post({ executable: null }); assert.equal(reset.status, 200); assert.equal((await reset.json()).effectivePath, f.automatic)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close() }
})


test('a saved installation path launches that selected executable through the native protocol', async () => {
  const f = await fixture()
  const store = configureCodexInstallation(f.root)
  try {
    await rm(f.first)
    try { await link(process.execPath, f.first) }
    catch { await copyFile(process.execPath, f.first) }
    await chmod(f.first, 0o700)
    const peer = join(f.root, 'installation-peer.mjs')
    await writeFile(peer, String.raw`
import { createInterface } from 'node:readline';
if (process.argv.includes('debug')) { console.log(JSON.stringify({models:[{slug:'selected-installation-model'}]})); process.exit(0) }
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'initialize') send({id:m.id,result:{userAgent:'selected-installation/0.159.2'}});
 else if (m.method === 'config/read') send({id:m.id,result:{config:{}}});
 else if (m.method === 'account/read') send({id:m.id,result:{account:{type:'apiKey'},requiresOpenaiAuth:true}});
 else if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'selected-installation-thread'},model:'selected-installation-model'}});
});
`)
    await store.update(f.first)
    const status = await getCodexStatus({ argsPrefix: [peer], signal: AbortSignal.timeout(12000), timeoutMs: 8000 })
    assert.equal(status.available, true)
    assert.equal(status.authenticated, true)
    assert.equal(status.version, '0.159.2')
    assert.equal(status.model, 'selected-installation-model')
  } finally { await store.update(null); await f.close() }
})
