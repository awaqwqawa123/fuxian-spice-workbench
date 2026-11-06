import assert from 'node:assert/strict'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import { parseProject, type Project } from '../src/core/circuit'
import { blankProject, editableProject } from '../src/core/editor'
import { addDevice } from '../src/core/drawing'
import { parseSpiceLibrary } from '../src/core/spice-models'
import { PROJECTS_STORAGE, PROJECT_SELECTION_STORAGE, createEntry, loadProjectCollection, saveProjectCollection, saveProjectSelection, selectProject, type ProjectCollection } from '../src/core/project-store'

function memoryStorage() {
  const values = new Map<string, string>(), writes: { key: string; value: string }[] = []
  return { values, writes, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { writes.push({ key, value }); values.set(key, value) } }
}

function fixture(count = 2): ProjectCollection {
  const project = blankProject()
  project.models = parseSpiceLibrary('.model fixture_diode D(IS=3n RS=.7 N=1.7)', { label: 'Independent test fixture', license: 'CC0', url: 'https://example.com/model.lib', attribution: 'Test author' }).models
  for (let i = 0; i < 48; i++) project.drawing = addDevice(project.drawing!, 'R', { x: 100 + i % 8 * 120, y: 100 + Math.floor(i / 8) * 120 }).drawing
  const entries = Array.from({ length: count }, (_, i) => createEntry({ ...project, title: `工程 ${i}` }))
  return { version: 1, activeId: entries[0].id, entries }
}

test('selection persistence writes only a small record and never reads project payloads', () => {
  const storage = memoryStorage(), collection = fixture()
  saveProjectCollection(storage, collection)
  const full = storage.getItem(PROJECTS_STORAGE)
  let reads = 0
  // Deliberately mutable caller data: selection does not serialize or pretend to
  // save this payload. A later full save remains responsible for validation.
  const descriptor = Object.getOwnPropertyDescriptor(collection.entries[0], 'project')!
  Object.defineProperty(collection.entries[0], 'project', { configurable: true, get() { reads++; return descriptor.value } })
  const selected = selectProject(collection, collection.entries[1].id)
  saveProjectSelection(storage, selected)
  assert.equal(reads, 0)
  assert.equal(storage.getItem(PROJECTS_STORAGE), full)
  assert.equal(storage.writes.at(-1)!.key, PROJECT_SELECTION_STORAGE)
  assert.ok(storage.writes.at(-1)!.value.length < 200)
  Object.defineProperty(collection.entries[0], 'project', descriptor)
  assert.deepEqual(loadProjectCollection(storage, blankProject()).collection, selected)
})

test('damaged, stale, missing and unavailable selection records preserve the saved library', () => {
  const storage = memoryStorage(), collection = fixture()
  saveProjectCollection(storage, collection)
  const revision = JSON.parse(storage.getItem(PROJECTS_STORAGE)!).selectionRevision
  for (const raw of ['{', 'null', '[]', JSON.stringify({ version: 2, revision, activeId: collection.entries[1].id }), JSON.stringify({ version: 1, revision: 'stale', activeId: collection.entries[1].id }), JSON.stringify({ version: 1, revision, activeId: 'missing' })]) {
    storage.values.set(PROJECT_SELECTION_STORAGE, raw)
    const loaded = loadProjectCollection(storage, blankProject())
    assert.equal(loaded.canPersist, true)
    assert.deepEqual(loaded.collection, collection)
  }
  storage.values.delete(PROJECT_SELECTION_STORAGE)
  assert.deepEqual(loadProjectCollection(storage, blankProject()).collection, collection)
  assert.deepEqual(loadProjectCollection({ getItem(key) { if (key === PROJECT_SELECTION_STORAGE) throw new Error('unavailable'); return storage.getItem(key) } }, blankProject()).collection, collection)
})

test('legacy collections still load and a full save supersedes old selected project records', () => {
  const storage = memoryStorage(), collection = fixture()
  storage.values.set(PROJECTS_STORAGE, JSON.stringify(collection))
  assert.deepEqual(loadProjectCollection(storage, blankProject()).collection, collection)
  saveProjectCollection(storage, collection)
  saveProjectSelection(storage, selectProject(collection, collection.entries[1].id))
  saveProjectCollection(storage, collection)
  assert.deepEqual(loadProjectCollection(storage, blankProject()).collection, collection)
})

test('selection cannot bypass a missing or failed full save; failed writes can retry', () => {
  const storage = memoryStorage(), collection = fixture()
  assert.throws(() => saveProjectSelection(storage, collection), /先保存项目内容/)
  let fail = false
  const adapter = { getItem: storage.getItem, setItem(key: string, value: string) { if (fail) throw new Error('quota'); storage.setItem(key, value) } }
  saveProjectCollection(adapter, collection)
  const selected = selectProject(collection, collection.entries[1].id)
  fail = true
  assert.throws(() => saveProjectSelection(adapter, selected), /选择保存失败/)
  assert.deepEqual(loadProjectCollection(storage, blankProject()).collection, collection)
  fail = false
  saveProjectSelection(adapter, selected)
  assert.deepEqual(loadProjectCollection(storage, blankProject()).collection, selected)
  const edited = { ...selected, entries: [...selected.entries] }
  fail = true
  assert.throws(() => saveProjectCollection(adapter, edited), /空间不足/)
  assert.throws(() => saveProjectSelection(adapter, edited), /先保存项目内容/)
  assert.deepEqual(loadProjectCollection(storage, blankProject()).collection, selected)
  fail = false
  saveProjectCollection(adapter, edited)
  assert.deepEqual(loadProjectCollection(storage, blankProject()).collection, edited)
})

test('full saves still validate in-place edits and reject invalid model data before writing', () => {
  const storage = memoryStorage(), collection = fixture()
  saveProjectCollection(storage, collection)
  collection.entries[0].project.title = '原地编辑后的项目'
  collection.entries[0].project.drawing!.devices[0].value = '47k'
  saveProjectCollection(storage, collection)
  assert.deepEqual(loadProjectCollection(storage, blankProject()).collection, collection)
  const before = storage.getItem(PROJECTS_STORAGE)
  collection.entries[0].project.models![0].spice += '\n.include secret.lib'
  assert.throws(() => saveProjectCollection(storage, collection))
  assert.equal(storage.getItem(PROJECTS_STORAGE), before)
})

test('project switching cost stays independent of drawing payload size', t => {
  const storage = memoryStorage(), collection = fixture(120)
  saveProjectCollection(storage, collection)
  const startFull = performance.now()
  // The previous save path cloned and validated every project for every switch.
  for (let i = 0; i < 5; i++) {
    const entries = collection.entries.map(entry => ({ ...entry, project: editableProject(parseProject(entry.project as Project, { allowDraft: true })) }))
    JSON.stringify({ ...collection, activeId: entries[i].id, entries })
  }
  const fullMs = performance.now() - startFull, startSelection = performance.now()
  for (let i = 0; i < 5; i++) saveProjectSelection(storage, selectProject(collection, collection.entries[i].id))
  const selectionMs = performance.now() - startSelection
  assert.equal(storage.writes.filter(write => write.key === PROJECTS_STORAGE).length, 1)
  assert.equal(storage.writes.filter(write => write.key === PROJECT_SELECTION_STORAGE).length, 5)
  assert.ok(storage.writes.filter(write => write.key === PROJECT_SELECTION_STORAGE).every(write => write.value.length < 200))
  assert.equal(loadProjectCollection(storage, blankProject()).collection.activeId, collection.entries[4].id)
  t.diagnostic(`120 projects × 48 devices, 5 switches: previous validation/serialization ${fullMs.toFixed(1)} ms; selection writes ${selectionMs.toFixed(1)} ms; library ${storage.getItem(PROJECTS_STORAGE)!.length} characters`)
})
