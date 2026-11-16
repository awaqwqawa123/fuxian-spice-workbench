import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { blankProject } from '../src/core/editor'
import { createProjectArchive, readProjectFile } from '../src/core/project-file'
import { createEntry, type ProjectCollection } from '../src/core/project-store'
import { createProjectRepositoryMiddleware } from '../server/project-repository-middleware'
import { ProjectRepository } from '../server/project-repository'

const modulePath = new URL('../server/project-repository.ts', import.meta.url).href
let sequence = 0
function fixture(): ProjectCollection {
  const entries = ['合成 RC 工程', '合成稳压工程'].map(title => createEntry({ ...blankProject(), title }))
  return { version: 1, activeId: entries[0].id, entries }
}
async function temp(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'fuxian-project-repo-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
async function publish(t: TestContext, directory: string) {
  const middleware = createProjectRepositoryMiddleware({ directory })
  const server = createServer((req, res) => { void middleware(req, res, () => { res.writeHead(404).end() }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return async (value: object, headers: Record<string, string> = {}, path = '/api/project-repository') => {
    const response = await fetch(origin + path, {
      method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-fuxian-project-repository': '1', ...headers },
      body: JSON.stringify(value),
    })
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }
  }
}

test('one clean service can pick up an existing project library from another port; selection is a small operation', async t => {
  const directory = await temp(t)
  const initial = new ProjectRepository(directory)
  const first = await publish(t, directory), second = await publish(t, directory)
  const empty = { collection: { version: 1, activeId: '', entries: [] }, revision: null }
  assert.deepEqual(await first({ action: 'bootstrap' }), { status: 200, body: empty, cache: 'no-store' })
  await assert.rejects(access(initial.path), { code: 'ENOENT' })
  const collection = fixture()
  const saved = await first({ action: 'save', collection, expectedRevision: null })
  assert.equal(saved.status, 200)
  assert.match(saved.body.revision, /^[a-z0-9-]+$/i)
  assert.deepEqual(await second({ action: 'bootstrap' }), saved)
  const activeId = collection.entries[1].id
  assert.deepEqual(await second({ action: 'select', activeId, expectedRevision: saved.body.revision }), {
    status: 200, body: { activeId, revision: saved.body.revision }, cache: 'no-store',
  })
  const reopened = await new ProjectRepository(directory).bootstrap()
  assert.deepEqual(reopened, { revision: saved.body.revision, collection: { ...saved.body.collection, activeId } })
})

test('migration is idempotent for the same legacy data; a conflicting or corrupt source does not overwrite the current library', async t => {
  const directory = await temp(t)
  const store = new ProjectRepository(directory), original = fixture()
  const imported = await store.migrate(original)
  const revised = structuredClone(imported.collection)
  revised.entries[0].project.title = '后来编辑过'
  const edited = await store.save(revised, imported.revision)
  assert.deepEqual(await store.migrate(original), edited)
  await assert.rejects(store.save(revised, imported.revision), { status: 409 })
  await assert.rejects(store.save({ ...revised, activeId: 'nope' }, edited.revision), { status: 400 })
  assert.deepEqual(await store.bootstrap(), edited)
  const otherBrowser = fixture()
  const merged = await store.migrate(otherBrowser)
  assert.equal(merged.collection.entries.length, 4)
  assert.deepEqual(merged.collection.entries.slice(0, 2), edited.collection.entries)
  assert.equal(merged.collection.activeId, otherBrowser.activeId)
  assert.deepEqual(await store.migrate(otherBrowser), merged)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(store.path)
  try {
    const row = db.prepare('SELECT document FROM previous_projects WHERE id = ?').get(original.activeId)
    assert.equal(JSON.parse(String(row?.document)).title, original.entries[0].project.title)
  } finally { db.close() }
})

test('invalid callers and damaged disk state cannot turn an existing file into an empty or writable library', async t => {
  const directory = await temp(t)
  const store = new ProjectRepository(directory), endpoint = await publish(t, directory)
  assert.equal((await endpoint({ action: 'bootstrap' }, { origin: 'http://other.invalid' })).status, 403)
  assert.equal((await endpoint({ action: 'bootstrap' }, { 'x-fuxian-project-repository': '0' })).status, 403)
  assert.equal((await endpoint({ action: 'bootstrap' }, {}, '/api/project-repository?path=anything')).status, 400)
  assert.equal((await endpoint({ action: 'bootstrap', path: 'ignored' })).status, 400)
  const badBytes = Buffer.from('previous but unreadable project store')
  await writeFile(store.path, badBytes)
  assert.equal((await endpoint({ action: 'bootstrap' })).status, 503)
  assert.equal((await endpoint({ action: 'save', expectedRevision: null, collection: fixture() })).status, 503)
  assert.deepEqual(await readFile(store.path), badBytes)
})

test('previous revisions remain exportable when an active document is damaged', async t => {
  const directory = await temp(t)
  const store = new ProjectRepository(directory), request = await publish(t, directory)
  assert.deepEqual((await request({ action: 'list-backups', offset: 0 })).body, { backups: [], more: false })
  await assert.rejects(access(store.path), { code: 'ENOENT' })
  const first = await store.save(fixture(), null)
  const before = first.collection.entries[0]
  const edited = structuredClone(first.collection)
  edited.entries[0].project.title = '修改后'
  edited.entries[0].updatedAt++
  const second = await store.save(edited, first.revision)
  const list = await request({ action: 'list-backups', offset: 0 })
  assert.deepEqual(list, { status: 200, cache: 'no-store', body: { more: false, backups: [{ id: before.id, updatedAt: before.updatedAt, title: before.project.title }] } })
  const key = { id: before.id, updatedAt: before.updatedAt }
  assert.deepEqual((await request({ action: 'read-backup', ...key })).body, { backup: before })
  assert.equal((await request({ action: 'read-backup', id: before.id, updatedAt: before.updatedAt + 1 })).status, 409)
  assert.equal((await request({ action: 'list-backups', offset: 0 }, { origin: 'http://other.invalid' })).status, 403)
  assert.deepEqual(await store.bootstrap(), second)

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(store.path)
  try { db.prepare('UPDATE projects SET document = ? WHERE id = ?').run('{damaged', before.id) }
  finally { db.close() }

  const disk = await readFile(store.path)
  assert.equal((await request({ action: 'bootstrap' })).status, 503)
  assert.deepEqual(await request({ action: 'list-backups', offset: 0 }), list)
  const recovered = await request({ action: 'read-backup', ...key })
  assert.deepEqual(recovered.body, { backup: before })
  const payload = createProjectArchive(recovered.body.backup.project)
  const reopened = await readProjectFile(new File([new Uint8Array(payload)], '本机备份.fuxian'))
  assert.deepEqual(reopened.project, before.project)
  assert.deepEqual(await readFile(store.path), disk)
})

test('parallel real Node processes cannot both commit from the same revision', { timeout: 20_000 }, async t => {
  const directory = await temp(t)
  const store = new ProjectRepository(directory), starting = await store.save(fixture(), null)
  const code = `
    const { ProjectRepository } = await import(${JSON.stringify(modulePath)})
    const [directory, raw, revision] = process.argv.slice(1)
    const store = new ProjectRepository(directory)
    const completion = await store.save(JSON.parse(raw), revision).then(result => ({ code:200, revision:result.revision }), error => ({code:error.status}))
    console.log(JSON.stringify(completion))
  `
  const workers = ['并行窗口甲', '并行窗口乙'].map(title => {
    const collection = structuredClone(starting.collection)
    collection.entries[0].project.title = title
    collection.entries[0].updatedAt += ++sequence
    return new Promise<{ title: string; code: number; revision?: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code, directory, JSON.stringify(collection), starting.revision!], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let output = '', diagnostic = ''
      child.stdout.setEncoding('utf8').on('data', value => { output += value })
      child.stderr.setEncoding('utf8').on('data', value => { diagnostic += value })
      child.on('error', reject)
      child.on('close', status => {
        try {
          assert.equal(status, 0, diagnostic)
          resolve({ title, ...JSON.parse(output.trim()) })
        } catch (error) { reject(error) }
      })
    })
  })
  const results = await Promise.all(workers)
  assert.deepEqual(results.map(value => value.code).sort(), [200, 409])
  const winner = results.find(value => value.code === 200)!
  const current = await store.bootstrap()
  assert.equal(current.revision, winner.revision)
  assert.equal(current.collection.entries[0].project.title, winner.title)
})

test('terminating a writer mid-transaction retains the last committed revision', { timeout: 20_000 }, async t => {
  const directory = await temp(t)
  const store = new ProjectRepository(directory), saved = await store.save(fixture(), null)
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { DatabaseSync } from 'node:sqlite'
    const db = new DatabaseSync(process.argv[1])
    db.exec('PRAGMA cache_size = 8; PRAGMA cache_spill = ON; BEGIN IMMEDIATE;')
    db.exec("UPDATE repository SET active_id = 'interrupted'; UPDATE projects SET document = hex(zeroblob(1024 * 1024));")
    console.log('uncommitted write')
    setInterval(() => {}, 1000)
  `, store.path], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const exited = once(child, 'exit')
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  await Promise.race([
    once(child.stdout, 'data').then(([chunk]) => assert.equal(String(chunk).trim(), 'uncommitted write')),
    exited.then(([code]) => { throw new Error(`write process exited early: ${code}`) }),
  ])
  child.kill('SIGKILL')
  await exited
  assert.deepEqual(await new ProjectRepository(directory).bootstrap(), saved)
})
