import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { availableSafeTestPort } from './helpers/safe-test-port'

test('built runtime serves cached assets and real backend hooks with unchanged Origin checks', { timeout: 45000, skip: !existsSync(resolve('dist/index.html')) }, async () => {
  const port = await availableSafeTestPort(), origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [resolve('scripts/serve-local.mjs'), '--production'], {
    cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, FUXIAN_PORT: String(port), VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let diagnostics = ''
  child.stdout!.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000) })
  child.stderr!.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000) })
  try {
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error(`Runtime never ready: ${diagnostics}`)), 25000)
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Runtime exited ${code}: ${diagnostics}`)) })
      child.on('message', raw => { const message = raw as { type?: string; mode?: string }; if (message.type === 'fuxian-service-ready') { clearTimeout(timer); assert.equal(message.mode, 'production'); accept() } })
    })
    const shell = await fetch(origin)
    assert.equal(shell.status, 200); assert.equal(shell.headers.get('cache-control'), 'no-cache')
    const html = await shell.text()
    assert.ok(html.includes('/assets/')); assert.ok(!html.includes('/@vite/client'))
    const asset = html.match(/src="(\/assets\/[^"?]+\.js)"/)?.[1]
    assert.ok(asset)
    const script = await fetch(origin + asset)
    assert.equal(script.status, 200); assert.match(script.headers.get('cache-control') ?? '', /immutable/)
    const etag = script.headers.get('etag')
    assert.ok(etag)
    assert.equal((await fetch(origin + asset, { headers: { 'If-None-Match': etag } })).status, 304)
    const engine = (await readdir(resolve('dist/assets'))).find(name => /^engine\.worker-.*\.js$/.test(name))
    assert.ok(engine)
    const engineResponse = await fetch(`${origin}/assets/${engine}`)
    assert.equal(engineResponse.status, 200)
    assert.ok((await engineResponse.arrayBuffer()).byteLength > 1000000, 'full embedded ngspice engine is shipped')
    assert.equal((await fetch(`${origin}/.desktop-control/state.json`)).status, 403)
    for (const path of ['/api/codex/status', '/api/cursor/status', '/api/dsh-local/status', '/api/model-library/device']) {
      const rejected = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      assert.equal(rejected.status, 403, path)
      assert.match(rejected.headers.get('content-type') ?? '', /application\/json/)
    }
    const invalidModel = await fetch(`${origin}/api/model-library/device`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(invalidModel.status, 400); assert.equal(invalidModel.headers.get('cache-control'), 'no-store')
    const library = await fetch(`${origin}/api/user-library`, { headers: { Origin: origin, 'x-fuxian-user-library': '1' } })
    assert.equal(library.status, 200); assert.ok((await library.json()).document)
    const publicModel = await fetch(`${origin}/models/qucs/transistors.lib`)
    assert.equal(publicModel.status, 200); assert.ok((await publicModel.text()).includes('.model'))
    const built = await readFile(resolve('dist/index.html'), 'utf8')
    assert.equal(html, built)
  } finally {
    if (child.connected) child.send({ type: 'fuxian-service-shutdown' })
    await new Promise<void>(accept => { if (child.exitCode !== null) { accept(); return }; const timer = setTimeout(() => { child.kill(); accept() }, 6000); child.once('exit', () => { clearTimeout(timer); accept() }) })
  }
})
