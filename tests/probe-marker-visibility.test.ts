import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { editorTemplate } from '../src/core/editor'
import type { Project } from '../src/core/circuit'
import { initialSimulationProfiles } from '../src/core/simulation-profiles'
import { newCanvasWaveform } from '../src/core/canvas-waveform-store'
import { PROBE_MARKER_VISIBILITY_KEY, readProbeMarkerVisibility, saveProbeMarkerVisibility } from '../src/core/probe-marker-visibility'

test('probe view preference defaults visible and tolerates disabled storage', () => {
  const disabled = { getItem(): string | null { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  assert.equal(readProbeMarkerVisibility(disabled), true)
  assert.doesNotThrow(() => saveProbeMarkerVisibility(false, disabled))
  assert.equal(readProbeMarkerVisibility({ getItem: () => 'unexpected', setItem() {} }), true)
})

test('real workbench restores the probe display preference without touching measurements, waveform setup or history', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost:3034/#editor' }), doc = dom.window.document
  const previous = new Map<string, PropertyDescriptor | undefined>(), seed = editorTemplate('rc-lowpass')
  seed.probes = [
    { id: 'P1', kind: 'voltage', positive: { device: 'R1', pin: 0 } },
    { id: 'P2', kind: 'current', device: 'R1' },
    { id: 'P3', kind: 'voltage', positive: { device: 'C1', pin: 0 }, negative: { device: 'C1', pin: 1 } },
  ]
  const profiles = initialSimulationProfiles(seed)
  seed.waveformSetup = { version: 1, profiles, diagrams: [newCanvasWaveform(seed.drawing!, profiles.activeId)] }
  let current: Project | undefined, saves = 0
  const onProjectChange = (project: Project) => { current = project; saves++ }
  class Worker { postMessage() {} terminate() {} }
  for (const [key, value] of Object.entries({ window: dom.window, document: doc, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, Worker, fetch: async () => Response.json({ groups: [], counts: [], libraries: [], total: 0, offset: 0, limit: 40 }), DOMPoint: class { constructor(public x: number, public y: number) {} matrixTransform() { return { x: this.x, y: this.y } } } })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  Object.assign(dom.window.SVGElement.prototype, { getScreenCTM: () => ({ a: 1, inverse: () => ({ a: 1, d: 1 }) }), setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false })
  const { createRoot } = await import('react-dom/client'), { default: Editor } = await import('../src/EditorWorkbench')
  let root = createRoot(doc.getElementById('root')!)
  const button = (name: string) => { const found = doc.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`); assert.ok(found, name); return found }
  const click = async (name: string) => act(async () => button(name).click())
  const render = async () => act(async () => root.render(createElement(Editor, { seed, onProjectChange })))
  try {
    await render()
    const baseline = structuredClone(current!), savedCount = saves
    const markerCount = () => doc.querySelectorAll('.editor-canvas .measurement-marker').length
    assert.equal(markerCount(), 4, 'V/I/differential +/- markers are actually rendered')
    assert.equal(button('隐藏全部探针图标').getAttribute('aria-pressed'), 'true')
    assert.equal(doc.querySelector('[aria-label="顶栏探针"]')?.contains(button('隐藏全部探针图标')), true)
    const records = [...doc.querySelectorAll<HTMLOptionElement>('[aria-label="探针测量记录"] option')].map(option => option.value)
    assert.deepEqual(records, ['P1', 'P2', 'P3'])

    await click('电压探针')
    assert.equal(button('电压探针').getAttribute('aria-pressed'), 'true')
    await click('隐藏全部探针图标')
    assert.equal(button('显示全部探针图标').getAttribute('aria-pressed'), 'false')
    assert.equal(markerCount(), 0, 'all marker tips, badges and leaders disappear from the actual canvas')
    assert.equal(button('电压探针').getAttribute('aria-pressed'), 'false', 'hiding cancels active placement instead of leaving an invisible tool')
    assert.deepEqual(current, baseline)
    assert.equal(saves, savedCount, 'view-only change does not save a new Project')
    assert.equal(button('撤销').disabled, true, 'visibility does not create an electrical undo entry')
    assert.equal(dom.window.localStorage.getItem(PROBE_MARKER_VISIBILITY_KEY), 'hidden')
    assert.deepEqual([...doc.querySelectorAll<HTMLOptionElement>('[aria-label="探针测量记录"] option')].map(option => option.value), records)

    await act(async () => root.unmount()); root = createRoot(doc.getElementById('root')!)
    await render()
    assert.equal(button('显示全部探针图标').getAttribute('aria-pressed'), 'false', 'reload restores the view preference')
    assert.equal(markerCount(), 0, 'reopening keeps actual markers hidden')
    const reopened = structuredClone(current!), reopenedSaves = saves
    await click('显示全部探针图标')
    assert.equal(button('隐藏全部探针图标').getAttribute('aria-pressed'), 'true')
    assert.equal(markerCount(), 4, 'show restores every original probe')
    assert.deepEqual(current, reopened)
    assert.equal(saves, reopenedSaves)

    await click('隐藏全部探针图标'); await click('差分探针')
    assert.equal(button('隐藏全部探针图标').getAttribute('aria-pressed'), 'true', 'explicit placement makes markers visible again')
    assert.equal(button('差分探针').getAttribute('aria-pressed'), 'true')
    assert.deepEqual(current!.probes, seed.probes)
    assert.deepEqual(current!.waveformSetup, reopened.waveformSetup)
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})
