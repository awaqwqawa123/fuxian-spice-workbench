import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProjectOpenHandoff } from '../server/project-open-handoff'
import { ProjectRepository } from '../server/project-repository'
import { blankProject } from '../src/core/editor'
import { createProjectArchive, readProjectFile } from '../src/core/project-file'
import { addProject } from '../src/core/project-store'

test('a launcher request opens exactly one validated archive, leaves its original intact and can be saved locally', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fuxian-open-'))
  const inbox = join(root, 'open-project-inbox')
  await mkdir(inbox)
  const handler = createProjectOpenHandoff(root)
  const server = createServer((req, res) => void handler(req, res, () => res.writeHead(404).end()))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (token: string, requestOrigin = origin) => fetch(origin + '/api/open-project-handoff', {
    method: 'POST',
    headers: { origin: requestOrigin, 'content-type': 'application/json', 'x-fuxian-project-open': '1' },
    body: JSON.stringify({ token }),
  })
  const original = join(root, '收到的 RC 工程.fuxian')
  const project = { ...blankProject(), title: '收到的 RC 工程' }
  const bytes = createProjectArchive(project)
  await writeFile(original, bytes)
  const stage = async () => {
    const token = randomBytes(16).toString('hex'), path = join(inbox, token + '.fuxian')
    await writeFile(path, bytes)
    return { token, path }
  }
  const fresh = await stage()
  assert.equal((await post(fresh.token, 'http://different.example')).status, 403)
  assert.equal((await post('../' + fresh.token)).status, 400)
  const responses = await Promise.all([post(fresh.token), post(fresh.token)])
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 404])
  const accepted = responses.find(response => response.ok)!
  assert.equal(accepted.headers.get('cache-control'), 'no-store')
  const file = new File([await accepted.arrayBuffer()], '工程.fuxian')
  const imported = await readProjectFile(file)
  assert.equal(imported.project.title, project.title)
  assert.deepEqual(await readFile(original), Buffer.from(bytes))
  const store = new ProjectRepository(join(root, 'library'))
  const starting = await store.bootstrap()
  const collection = addProject(starting.collection, imported.project)
  const saved = await store.save(collection, starting.revision)
  assert.deepEqual(await new ProjectRepository(store.directory).bootstrap(), saved)
  const old = await stage()
  const past = new Date(Date.now() - 6 * 60_000)
  await utimes(old.path, past, past)
  assert.equal((await post(old.token)).status, 410)
  assert.equal((await post(old.token)).status, 404)
})
