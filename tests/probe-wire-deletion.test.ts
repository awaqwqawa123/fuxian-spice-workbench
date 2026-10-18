import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { parseProject, type Project } from '../src/core/circuit'
import { editorTemplate, remember, redo, undo } from '../src/core/editor'
import { removeSelection } from '../src/core/selection'
import { reconcileProjectProbes } from '../src/core/project-probes'
import { terminal, wirePoints } from '../src/core/drawing'
import { newCanvasWaveform } from '../src/core/canvas-waveform-store'
import { initialSimulationProfiles } from '../src/core/simulation-profiles'

function fixture(): Project {
  const project = editorTemplate('rc-lowpass'), drawing = project.drawing!, wire = drawing.wires[0]
  drawing.junctions.push({ id: 'J99', x: 80, y: 120 })
  drawing.wires.push({ id: 'W99', from: terminal('V1', 0), to: { junction: 'J99' }, bend: 'hv' })
  const kept = { anchor: { wireId: 'W99', fraction: .4 } }, deleted = { anchor: { wireId: wire.id, fraction: .45 } }
  project.probes = [
    { id: 'P1', kind: 'voltage', positive: terminal('R1', 0), positiveLayout: deleted },
    { id: 'P2', kind: 'voltage', positive: terminal('V1', 0), positiveLayout: kept, negative: terminal('R1', 0), negativeLayout: deleted },
    { id: 'P3', kind: 'current', wire: { wireId: wire.id, from: wire.from, to: wire.to, direction: 1 }, layout: deleted },
    { id: 'P4', kind: 'voltage', positive: terminal('V1', 0), positiveLayout: kept },
    { id: 'P5', kind: 'current', device: 'R1', layout: { offset: { x: 20, y: -60 } } },
    { id: 'P6', kind: 'voltage', positive: terminal('R1', 0) },
    { id: 'P7', kind: 'voltage', positive: { junction: 'J99' } },
  ]
  const profiles = initialSimulationProfiles(project)
  project.waveformSetup = { version: 1, profiles, diagrams: [newCanvasWaveform(drawing, profiles.activeId)] }
  return parseProject(project, { allowDraft: true })
}

test('deleting a wire removes voltage, either differential endpoint, and wire-current attachments without moving surviving same-net probes', () => {
  const before = fixture(), drawing = removeSelection(before.drawing!, ['W1'])
  const { project: after, notices } = reconcileProjectProbes(before, { ...before, drawing })
  assert.deepEqual(after.probes!.map(probe => probe.id), ['P4', 'P5', 'P6', 'P7'])
  assert.deepEqual(after.probes, before.probes!.slice(3), 'surviving attachments are not rebound or relocated')
  assert.equal(notices.length, 3)
  for (const id of ['P1', 'P2', 'P3']) assert.ok(notices.some(notice => notice.includes(id) && notice.includes('W1')))
  assert.deepEqual(after.waveformSetup, before.waveformSetup, 'historical plot configuration is not discarded')
  let history = remember({ past: [], present: before, future: [] }, after)
  history = undo(history); assert.deepEqual(history.present, before, 'one undo restores the wire and all its probes')
  history = redo(history); assert.deepEqual(history.present, after)
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(after)), { allowDraft: true }), after)
})

test('device and junction deletion remove their probes and any probes attached to incident wires', () => {
  const before = fixture()
  const device = reconcileProjectProbes(before, { ...before, drawing: removeSelection(before.drawing!, ['R1']) }).project
  assert.deepEqual(device.probes!.map(probe => probe.id), ['P4', 'P7'])
  const junction = reconcileProjectProbes(before, { ...before, drawing: removeSelection(before.drawing!, ['J99']) }).project
  assert.deepEqual(junction.probes!.map(probe => probe.id), ['P1', 'P3', 'P5', 'P6'])
  const diff = structuredClone(before.probes![1]); assert.equal(diff.kind, 'voltage')
  if (diff.kind !== 'voltage') return
  const flipped = { ...before, probes: [{ ...diff, positiveLayout: diff.negativeLayout, negativeLayout: diff.positiveLayout }] }
  assert.deepEqual(reconcileProjectProbes(flipped, { ...flipped, drawing: removeSelection(before.drawing!, ['W1']) }).project.probes, [], 'positive differential attachment also deletes the whole measurement')
})

test('a mixed deletion and rewiring never treats a reused junction as the old physical network', () => {
  const before = fixture(), drawing = removeSelection(before.drawing!, ['W2'])
  drawing.wires = drawing.wires.map(wire => wire.id === 'W99' ? { ...wire, from: terminal('C1', 0) } : wire)
  const after = reconcileProjectProbes(before, { ...before, drawing }).project
  const junctionProbe = after.probes!.find(probe => probe.id === 'P7')!
  assert.equal(junctionProbe.kind, 'voltage')
  if (junctionProbe.kind === 'voltage') assert.deepEqual(junctionProbe.positive, terminal('R1', 0), 'only the proven original pin network is retained')
})

test('moving wire geometry retains attachments and historical measurements', () => {
  const before = fixture(), drawing = structuredClone(before.drawing!)
  drawing.devices.find(device => device.id === 'R1')!.x += 40
  const after = reconcileProjectProbes(before, { ...before, drawing })
  assert.deepEqual(after.project.probes!.slice(0, 6), before.probes!.slice(0, 6))
  assert.equal(after.project.probes!.at(-1)!.id, 'P7', 'junction measurements retain their proven stable pin network on geometry edits')
  assert.deepEqual(after.notices, [])
})

test('real Workbench Delete and wire context menu remove attached probes, persist them, and undo/redo atomically', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost:3034/' })
  const doc = dom.window.document, prior = new Map<string, PropertyDescriptor | undefined>(), seed = fixture()
  let current = seed
  for (const [key, value] of Object.entries({ window: dom.window, document: doc, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    Worker: class { postMessage() {} terminate() {} }, fetch: async () => Response.json({ groups: [], counts: [], libraries: [], total: 0 }),
    DOMPoint: class { constructor(public x: number, public y: number) {} matrixTransform() { return { x: this.x, y: this.y } } },
  })) { prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
  Object.assign(dom.window.SVGElement.prototype, { getScreenCTM: () => ({ a: 1, inverse: () => ({ a: 1, d: 1 }) }), setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false })
  const { createRoot } = await import('react-dom/client'), { default: Editor } = await import('../src/EditorWorkbench'), root = createRoot(doc.getElementById('root')!)
  const query = (selector: string) => { const item = doc.querySelector(selector); assert.ok(item, selector); return item }
  const pointer = async (selector: string, type: string, x = 200, y = 200) => act(async () => query(selector).dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })))
  const key = async (key: string, ctrlKey = false, shiftKey = false) => act(async () => query('.editor-canvas').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, ctrlKey, shiftKey, bubbles: true, cancelable: true })))
  const saved = () => parseProject(JSON.parse(dom.window.localStorage.getItem('wire-delete-fixture')!), { allowDraft: true })
  const onProjectChange = (project: Project) => { current = project; dom.window.localStorage.setItem('wire-delete-fixture', JSON.stringify(project)) }
  const checks = () => {
    assert.ok(!current.drawing!.wires.some(wire => wire.id === 'W1'))
    assert.deepEqual(current.probes!.map(probe => probe.id), ['P4', 'P5', 'P6', 'P7'])
    assert.deepEqual(saved().probes, current.probes)
    for (const id of ['P1', 'P2+', 'P2−', 'P3']) assert.equal(doc.querySelector(`[data-context-probe="${id}"]`), null)
    assert.ok(doc.querySelector('[data-context-probe="P4"]'))
  }
  try {
    await act(async () => root.render(createElement(Editor, { seed, onProjectChange })))
    // A previously selected probe cannot take Delete away from a newly selected wire.
    await pointer('[data-context-probe="P1"] .probe-badge', 'pointerdown')
    await pointer('.editor-canvas', 'pointerup')
    const points = wirePoints(seed.drawing!, seed.drawing!.wires[0]), at = points[1]
    await pointer('[data-context-wire="W1"]', 'pointerdown', at.x, at.y)
    await pointer('.editor-canvas', 'pointerup', at.x, at.y)
    await key('Delete'); checks()
    await key('z', true); assert.deepEqual(current.probes, seed.probes); assert.deepEqual(current.drawing, seed.drawing)
    await key('z', true, true); checks()
    await key('z', true)
    // Wire menu deletion shares the same transaction and does not leave probe records.
    await act(async () => query('[data-context-wire="W1"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y })))
    const deleteItem = [...doc.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.includes('删除导线'))
    assert.ok(deleteItem, 'wire-specific delete menu item')
    await act(async () => deleteItem.click()); checks()
    await key('z', true); assert.deepEqual(current.probes, seed.probes)
    await key('z', true, true); checks()
    const reopened = saved()
    await act(async () => root.render(null))
    await act(async () => root.render(createElement(Editor, { seed: reopened, onProjectChange })))
    checks()
    assert.deepEqual(current.waveformSetup, seed.waveformSetup)
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})
