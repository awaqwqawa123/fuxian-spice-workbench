import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeOptions } from '../scripts/runtime-options.mjs'
import { runtimeCache } from '../server/runtime-cache'
import { assertPublicSnapshot, portableDependencyPaths } from '../scripts/package-windows.mjs'

test('normal launch requires a built frontend and debug is explicitly selected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuxian runtime '))
  try {
    assert.throws(() => runtimeOptions([], {}, root), /Built frontend missing/)
    assert.equal(runtimeOptions(['--dev'], {}, root).mode, 'development')
    await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/index.html'), '<html/>')
    assert.deepEqual(runtimeOptions([], {}, root), { mode: 'production', port: 3032 })
    assert.equal(runtimeOptions(['--production'], { FUXIAN_MODE: 'development' }, root).mode, 'production')
    assert.throws(() => runtimeOptions(['--dev', '--production'], {}, root), /one runtime mode/)
    assert.throws(() => runtimeOptions([], { FUXIAN_PORT: '3032.5' }, root), /valid local port/)
    assert.throws(() => runtimeOptions(['--whatever'], {}, root), /Unknown launch/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('only fingerprinted build assets are immutable; APIs and app shell revalidate', () => {
  for (const [url, expected] of [['/assets/index-AbCd1234.js', 'public, max-age=31536000, immutable'], ['/assets/engine-AbCd1234.wasm?x=1', 'public, max-age=31536000, immutable'], ['/', 'no-cache'], ['/index.html', 'no-cache'], ['/models/opamp.lib', 'no-cache'], ['/api/model-library/browse', 'no-store']]) {
    const headers = new Map<string, string>(); let continued = false
    runtimeCache({ url } as never, { setHeader: (name: string, value: string) => headers.set(name, value) } as never, () => { continued = true })
    assert.equal(headers.get('Cache-Control'), expected); assert.equal(continued, true)
  }
})

test('portable packaging rejects private checkout and enumerates only locked installed dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuxian public packaging '))
  try {
    assert.throws(() => assertPublicSnapshot(root), /sanitized public/)
    await writeFile(join(root, 'PUBLIC-SNAPSHOT.json'), '{}'); await writeFile(join(root, 'LICENSE'), 'MIT')
    assert.doesNotThrow(() => assertPublicSnapshot(root))
    await mkdir(join(root, '.desktop-control'))
    assert.throws(() => assertPublicSnapshot(root), /Private runtime\/data/)
    await mkdir(join(root, 'pkg'))
    assert.deepEqual(portableDependencyPaths({ packages: { '': {}, 'node_modules/pkg': {}, 'node_modules/missing': {} } }, root), ['node_modules/pkg'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
