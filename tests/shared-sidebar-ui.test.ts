import { codexStatusFixture } from './codex-status-fixture'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { projectKey, type Project } from '../src/core/circuit'
import { exampleProject } from '../src/core/examples'
import { PROJECTS_STORAGE, type ProjectCollection } from '../src/core/project-store'
import { parseSpiceLibrary } from '../src/core/spice-models'
import { simulate } from './simulate'

async function workspace(seed: Project) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost:3031/#editor' })
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1600 })
  const original = new Map<string, PropertyDescriptor | undefined>()
  const install = (key: string, value: unknown) => { original.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) install(key, value)
  install('DOMPoint', class { constructor(public x: number, public y: number) {} matrixTransform() { return { x: this.x, y: this.y } } })
  Object.assign(dom.window.SVGElement.prototype, { getScreenCTM: () => ({ inverse: () => ({ a: 1, d: 1 }) }), setPointerCapture: () => {}, releasePointerCapture: () => {}, hasPointerCapture: () => false })
  const pending: Promise<void>[] = [], requests: Record<string, unknown>[] = []
  class SimulationTransport {
    onmessage: ((message: { data: unknown }) => void) | null = null
    onerror: ((error: { message: string }) => void) | null = null
    terminated = false
    postMessage(project: Project) { pending.push(simulate(project).then(result => { if (!this.terminated) this.onmessage?.({ data: { type: 'result', result } }) }, error => { if (!this.terminated) this.onerror?.({ message: String(error) }) })) }
    terminate() { this.terminated = true }
  }
  install('Worker', SimulationTransport)
  // All AI traffic is local fixture data; an unexpected URL fails the test.
  install('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/desktop-control/ensure') { const { projectId } = JSON.parse(String(init?.body)) as { projectId: string }; return Response.json({ projectId, threadId: crypto.randomUUID(), connected: true, approvals: [], messages: [] }) }
    if (url.startsWith('/api/desktop-control/state?')) {
      const projectId = new URL(url, 'http://localhost').searchParams.get('projectId')!
      return Response.json({ projectId, threadId: 'fixture-project-thread', connected: true, ready: true, desktopConnected: true, owner: 'web', busy: false, pendingOwner: null, pendingApprovals: 0, approvals: [], messages: [], error: null, updatedAt: 1 })
    }
    if (url === '/api/codex/status') return Response.json(codexStatusFixture)
    const source={label:'Fixture model source',url:'https://example.com/test.lib'}
    if(url==='/api/model-library/search')return new Response(JSON.stringify({candidates:[{id:'fixture-model',name:'SEARCH_D.lib',path:'Models/SEARCH_D.lib',source,matchedModels:['SEARCH_D']}],notices:[],indexedFiles:1}),{headers:{'Content-Type':'application/json'}})
    if(url==='/api/model-library/download')return new Response(JSON.stringify({...parseSpiceLibrary('.model SEARCH_D D(IS=4n N=1.5 RS=.3)',source),source,text:'.model SEARCH_D D(IS=4n N=1.5 RS=.3)'}),{headers:{'Content-Type':'application/json'}})
    assert.equal(url, '/api/ai', 'integration tests must never contact a model provider')
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(JSON.stringify({ text: '这是测试助手回复：检查二极管导通压降，并通过 ngspice 验证。' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  dom.window.localStorage.setItem('fuxian-free-editor-v2', JSON.stringify(seed))
  const { createRoot } = await import('react-dom/client'), { default: App } = await import('../src/App')
  const root = createRoot(dom.window.document.getElementById('root')!), doc = dom.window.document
  const query = <T extends Element = HTMLElement>(selector: string) => { const node = doc.querySelector<T>(selector); assert.ok(node, `Missing ${selector}`); return node }
  const button = (text: string, within: ParentNode = doc) => { const node = [...within.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text || item.getAttribute('aria-label') === text); assert.ok(node, `Missing button ${text}`); return node }
  const click = async (element: Element) => { await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) }) }
  const key = async (key: string, target: Element = doc.body, options: KeyboardEventInit = {}) => { await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...options })) }) }
  const input = async (selector: string | Element, value: string) => {
    const element = typeof selector === 'string' ? query(selector) : selector
    const prototype = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
    await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) })
  }
  const collection = () => JSON.parse(dom.window.localStorage.getItem(PROJECTS_STORAGE)!) as ProjectCollection
  const active = () => { const saved = collection(); return saved.entries.find(entry => entry.id === saved.activeId)!.project }
  const settle = async () => { await act(async () => { await Promise.all(pending) }) }
  const selectDevice = async (id: string) => { await key('Enter', query(`.editor-device[aria-label^="${id} "]`)) }
  const editModel = async (text: string) => {
    await click(button('编辑 SPICE 模型'))
    await click(button('编辑器件 SPICE 代码'))
    await input('[aria-label="编辑模型定义"]', text)
    await click(button('验证并预览')); await click(button('应用模型'))
    assert.equal(doc.querySelector('[role="dialog"][aria-label="编辑 SPICE 模型"]'), null)
  }
  const remount = async () => { await act(async () => root.render(null)); await act(async () => root.render(createElement(App))); await settle() }
  await act(async () => root.render(createElement(App)))
  await settle()
  return { doc, dom, root, query, button, click, key, input, collection, active, settle, selectDevice, editModel, remount, pending, requests,
    async close() { await act(async () => root.unmount()); await Promise.all(pending); dom.window.close(); for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } },
  }
}

test('waveform and editable properties share one mounted sidebar and preserve the schematic and waveform view', { timeout: 30000 }, async () => {
  const ui = await workspace(exampleProject('diode-sweep'))
  try {
    const canvas = ui.query('.editor-canvas'), page = ui.query('[data-page-waveform]:not([hidden])')
    const plot = page.querySelector('.wave-plot')!, resultId = page.getAttribute('data-result-id')
    assert.ok(plot); assert.ok(resultId)
    const groupId = ui.query<HTMLSelectElement>('[aria-label="当前波形图组"]').value
    const widthStyle = ui.query<HTMLElement>('.single-page-workspace').style.getPropertyValue('--page-schematic-width')
    assert.equal(ui.doc.querySelector('.workspace-body > #workspace-right'), null, 'properties never allocate a third workspace column')
    assert.equal(ui.doc.querySelector('[aria-label="调整器件属性栏宽度"]'), null)
    assert.equal(ui.query('#workspace-right').parentElement?.id, 'page-sidebar-properties-panel')
    await ui.click(ui.button('放大画布'))
    const viewBox = canvas.getAttribute('viewBox')
    await ui.selectDevice('R1')
    assert.equal(ui.query('#page-sidebar-properties-tab').getAttribute('aria-selected'), 'true')
    assert.equal(ui.query<HTMLElement>('#page-sidebar-waveform-panel').hidden, true)
    assert.equal(ui.query<HTMLElement>('#workspace-right').hidden, false)
    assert.equal(ui.query<HTMLElement>('.page-schematic-host').hidden, false)
    assert.equal(ui.query<HTMLElement>('.single-page-workspace').style.getPropertyValue('--page-schematic-width'), widthStyle)
    assert.equal(canvas.getAttribute('viewBox'), viewBox)
    const valueField = ui.query<HTMLInputElement>('.device-value-fields input')
    await ui.input(valueField, '2k')
    assert.equal(ui.active().drawing!.devices.find(device => device.id === 'R1')!.value, '2k')
    await ui.click(ui.query('#page-sidebar-waveform-tab'))
    assert.equal(ui.query('#page-sidebar-waveform-tab').getAttribute('aria-selected'), 'true')
    assert.equal(ui.query<HTMLElement>('#page-sidebar-waveform-panel').hidden, false)
    assert.equal(ui.query<HTMLElement>('#page-sidebar-properties-panel').hidden, true)
    assert.equal(ui.query('[data-page-waveform]:not([hidden])'), page)
    assert.equal(page.querySelector('.wave-plot'), plot)
    assert.equal(page.getAttribute('data-result-id'), resultId)
    assert.equal(ui.query<HTMLSelectElement>('[aria-label="当前波形图组"]').value, groupId)
    assert.equal(canvas.getAttribute('viewBox'), viewBox)
    const split=ui.query<HTMLElement>('.single-page-workspace'),beforeWheel=split.style.getPropertyValue('--page-schematic-width')
    const beforeProject=JSON.stringify(ui.active())
    await act(async()=>{for(let index=0;index<2;index++)plot.dispatchEvent(new ui.dom.window.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-120}))})
    assert.notEqual(split.style.getPropertyValue('--page-schematic-width'),beforeWheel,'actual App plot resizes the dock through the shared workspace')
    assert.equal(canvas.getAttribute('viewBox'),viewBox,'waveform resize never zooms the circuit camera')
    assert.equal(JSON.stringify(ui.active()),beforeProject,'outer resize does not rewrite circuit, wave axes or samples')
    const beforeRuns = ui.pending.length
    await ui.key('ArrowRight', ui.query('#page-sidebar-waveform-tab'))
    assert.equal(ui.query('#page-sidebar-properties-tab').getAttribute('aria-selected'), 'true')
    assert.equal(ui.doc.activeElement, ui.query('#page-sidebar-properties-tab'))
    assert.equal(ui.query<HTMLInputElement>('.device-value-fields input').value, '2k')
    await ui.click(ui.button('收起右侧栏'))
    assert.equal(ui.query<HTMLElement>('.page-waveform-host').hidden, true)
    assert.equal(ui.query<HTMLElement>('.page-schematic-host').hidden, false)
    await ui.click(ui.button('展开右侧栏'))
    assert.equal(ui.query<HTMLElement>('.page-waveform-host').hidden, false)
    assert.equal(ui.query('#page-sidebar-properties-tab').getAttribute('aria-selected'), 'true')
    await ui.click(ui.button('返回波形'))
    assert.equal(ui.query('#page-sidebar-waveform-tab').getAttribute('aria-selected'), 'true')
    assert.equal(page.querySelector('.wave-plot'), plot)
    assert.equal(ui.pending.length, beforeRuns, 'sidebar switching does not launch simulation')
  } finally { await ui.close() }
})

test('shared properties retain model editing, circuit probes and waveform return without adding a column', { timeout: 30000 }, async () => {
  const ui = await workspace(exampleProject('diode-sweep'))
  try {
    const canvas = ui.query('.editor-canvas'), before = projectKey(ui.active())
    await ui.selectDevice('D1')
    await ui.click(ui.button('编辑 SPICE 模型'))
    const preview = ui.query('[aria-label="当前 SPICE 代码"]'), modelCode = preview.textContent
    assert.ok(ui.query('#page-sidebar-properties-panel').contains(preview))
    await ui.click(ui.button('编辑器件 SPICE 代码'))
    await ui.input('[aria-label="编辑模型定义"]', '.model sidebar_draft D(IS=3n)')
    await ui.click(ui.button('取消', ui.query('[role="dialog"][aria-label="编辑 SPICE 模型"]')))
    assert.equal(projectKey(ui.active()), before)
    await ui.click(ui.query('#page-sidebar-waveform-tab'))
    await ui.click(ui.query('#page-sidebar-properties-tab'))
    assert.equal(ui.query('#inspector-model-tab').getAttribute('aria-selected'), 'true')
    assert.equal(ui.query('[aria-label="当前 SPICE 代码"]'), preview)
    assert.equal(preview.textContent, modelCode)
    await ui.selectDevice('R1')
    await ui.click(ui.button('探测 R1 引脚 2'))
    assert.equal(ui.active().probes!.length, 1)
    await ui.click(ui.button('返回波形'))
    assert.equal(ui.query('#page-sidebar-waveform-tab').getAttribute('aria-selected'), 'true')
    assert.equal(ui.query('.editor-canvas'), canvas)
    assert.equal(ui.doc.querySelector('.workspace-body > #workspace-right'), null)
    assert.equal(ui.doc.querySelector('[role="dialog"][aria-label="放大波形"]'), null)
  } finally { await ui.close() }
})
