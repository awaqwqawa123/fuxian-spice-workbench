import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { editorTemplate } from '../src/core/editor'
import { aiProjectFingerprint } from '../src/core/ai'
import { initialSimulationProfiles } from '../src/core/simulation-profiles'
import { codexStatusFixture } from './codex-status-fixture'

test('switching editors and rendering controls does not deserialize unused candidate undo snapshots', async t => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost:3032/#editor' })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const seed = editorTemplate('rc-lowpass'), historyKey = (id: string) => `fuxian.editor-candidate-undo.v1:${id}`
  const snapshot = { project: seed, waveformSetup: { version: 1, profiles: initialSimulationProfiles(seed), diagrams: [] } }
  const history = JSON.stringify(Array.from({ length: 12 }, () => ({ before: snapshot, afterFingerprint: aiProjectFingerprint(seed) })))
  for (const id of ['mount-a', 'mount-b']) dom.window.localStorage.setItem(historyKey(id), history)
  let undoReads = 0, undoBytes = 0
  const getItem = dom.window.Storage.prototype.getItem
  dom.window.Storage.prototype.getItem = function (key: string) {
    const value = getItem.call(this, key)
    if (key.startsWith('fuxian.editor-candidate-undo.v1:')) { undoReads++; undoBytes += value?.length ?? 0 }
    return value
  }
  let workerStarts = 0
  class Transport {
    onmessage = null
    onerror = null
    constructor() { workerStarts++ }
    postMessage() {}
    terminate() {}
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, Worker: Transport })) install(key, value)
  install('fetch', async (path: string) => {
    if (path === '/api/codex/status') return Response.json(codexStatusFixture)
    if (path === '/api/model-library/browse') return Response.json({ groups: [], counts: [], libraries: [], total: 0, offset: 0, limit: 40 })
    if (path.startsWith('/api/desktop-circuit/')) return Response.json({ snapshot: null, tasks: [], cliPath: 'C:/fixture/desktop-circuit.mjs' })
    throw new Error(`Unexpected request ${path}`)
  })
  const { createRoot } = await import('react-dom/client'), { default: Editor } = await import('../src/EditorWorkbench')
  const root = createRoot(dom.window.document.getElementById('root')!)
  const render = async (id: string) => act(async () => { root.render(createElement(Editor, { key: id, seed, projectId: id })) })
  const click = async (label: string) => {
    const button = dom.window.document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    assert.ok(button, label)
    await act(async () => button.click())
  }
  try {
    await render('mount-a')
    for (let i = 0; i < 3; i++) { await click('放大画布'); await click('缩小画布') }
    await render('mount-b')
    for (let i = 0; i < 3; i++) { await click('放大画布'); await click('缩小画布') }
    t.diagnostic(`Unused undo history: ${undoReads} reads, ${undoBytes} characters deserialized across two mounts and twelve zoom actions`)
    assert.equal(undoReads, 0, 'candidate history belongs to the AI apply/undo path, not project switching or canvas controls')
    assert.equal(workerStarts, 2, 'each newly opened valid project still starts its normal automatic simulation')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
