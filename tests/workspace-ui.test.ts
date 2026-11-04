import { codexStatusFixture } from './codex-status-fixture'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { parseProject, projectKey, type Project } from '../src/core/circuit'
import { exampleProject } from '../src/core/examples'
import { PROJECTS_STORAGE, type ProjectCollection } from '../src/core/project-store'
import { parseSpiceLibrary } from '../src/core/spice-models'
import { simulate } from './simulate'
import { SIDEBAR_WIDTHS_STORAGE } from '../src/core/sidebar-sizing'

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
    if (url === '/api/model-library/browse') return Response.json({groups:[],counts:[],libraries:[],total:0,offset:0,limit:40})
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

test('canvas maximization and central view changes preserve zoom, probes and the mounted AI draft', { timeout: 30000 }, async () => {
  const ui = await workspace(exampleProject('diode-sweep'))
  try {
    const canvas = ui.query('.editor-canvas'), project = structuredClone(ui.active())
    assert.equal(ui.query<HTMLElement>('#workspace-left').hidden, false)
    assert.equal(ui.query<HTMLElement>('#workspace-right').hidden, true)
    const results=ui.query<HTMLElement>('[data-page-waveform]:not([hidden])'),resultId=results.getAttribute('data-result-id')
    assert.equal(results.hidden, false, 'results belong to the page beside the circuit')
    assert.ok(resultId)
    await ui.click(ui.button('放大画布'))
    const zoom = ui.query('.zoom-controls span').textContent, viewBox = canvas.getAttribute('viewBox')
    await ui.selectDevice('R1')
    assert.equal(ui.query<HTMLElement>('#workspace-right').hidden, false)
    await ui.click(ui.button('探测 R1 引脚 2'))
    const marker = ui.query('.measurement-marker'), measurement = ui.query('.probe-record-option')
    await ui.key('ArrowRight', ui.query('.probe-badge'))
    project.probes=structuredClone(ui.active().probes)
    assert.equal(project.probes?.length,1,'placed probes now persist in the project')
    const badgePosition = ui.query('.probe-badge').getAttribute('transform')
    await ui.selectDevice('D1'); await ui.click(ui.button('编辑 SPICE 模型'))
    const modelPreview = ui.query('[aria-label="当前 SPICE 代码"]'), modelCode = modelPreview.textContent
    assert.equal(ui.doc.querySelector('[aria-label="编辑模型定义"]'), null)
    await ui.click(ui.button('编辑器件 SPICE 代码'))
    await ui.input('[aria-label="编辑模型定义"]', '.model layout_draft D(IS=2n)')
    assert.equal(ui.query('.editor-inspector').contains(ui.query('[role="dialog"][aria-label="编辑 SPICE 模型"]')), false)
    await ui.click(ui.button('取消', ui.query('[role="dialog"][aria-label="编辑 SPICE 模型"]')))
    assert.equal(ui.doc.querySelector('[aria-label="编辑模型定义"]'), null)
    assert.equal(ui.query('#inspector-model-tab').getAttribute('aria-selected'), 'true', 'closing model editing keeps the model inspector visible')
    assert.equal(projectKey(ui.active()), projectKey(project), 'canceling the draft does not change the model')
    await ui.click(ui.button('打开 AI 助手'))
    assert.equal(ui.query('#inspector-model-tab').getAttribute('aria-selected'), 'true', 'AI must not replace the active inspector tab')
    assert.equal(ui.query('.editor-inspector').contains(ui.query('.assistant-sidebar')), false)
    assert.equal(ui.query<HTMLElement>('#workspace-right').hidden, false)
    for (const [label, key] of [['调整左侧栏宽度', 'ArrowRight'], ['调整电路与波形比例', 'ArrowRight'], ['调整 AI 助手宽度', 'ArrowLeft']] as const) {
      const handle = ui.query(`[role="separator"][aria-label="${label}"]`), before = Number(handle.getAttribute('aria-valuenow'))
      await ui.key(key, handle)
      assert.equal(Number(handle.getAttribute('aria-valuenow')), before + 12)
      await ui.key('Delete', handle)
      assert.equal(projectKey(ui.active()), projectKey(project), 'splitter shortcuts do not edit circuit elements')
    }
    const savedWidths = ui.dom.window.localStorage.getItem(SIDEBAR_WIDTHS_STORAGE)
    assert.deepEqual(JSON.parse(savedWidths!), { left: 244, right: 320, ai: 372 })
    assert.equal(ui.doc.querySelector('.workspace-body > #workspace-right'),null,'properties use the waveform sidebar instead of a third column')
    await ui.input('[aria-label="桌面共享会话问题"]', '检查这个电路；保留正在输入的内容')
    const assistant = ui.query('.ai-assistant'), prompt = ui.query('[aria-label="桌面共享会话问题"]')
    await ui.click(ui.button('最大化画布'))
    assert.equal(ui.query<HTMLElement>('#workspace-left').hidden, true)
    assert.equal(ui.query<HTMLElement>('#workspace-right').hidden, true)
    assert.equal(ui.query<HTMLElement>('#workspace-ai').hidden, true)
    assert.equal(ui.query('.workspace-shell').classList.contains('is-canvas-maximized'), true)
    for (const name of ['查看网表', '原理图']) {
      await ui.click(ui.button(name))
      assert.equal(ui.query<HTMLElement>('.workspace-canvas-host').hidden, name !== '原理图')
      assert.equal(ui.query<HTMLElement>('[data-page-waveform]:not([hidden])'), results)
      assert.equal(results.hidden, false, 'central schematic/netlist switching preserves the mounted page result')
      assert.equal(ui.query<HTMLElement>('.page-waveform-host').hidden,true,'maximizing the circuit hides its shared sidebar')
      assert.equal(results.getAttribute('data-result-id'), resultId)
      assert.equal(ui.query('.editor-canvas'), canvas)
      assert.equal(canvas.getAttribute('viewBox'), viewBox)
      assert.equal(ui.query('.zoom-controls span').textContent, zoom)
      assert.equal(ui.query('.measurement-marker'), marker)
      assert.equal(ui.query('.probe-record-option'), measurement)
      assert.equal(ui.query('.probe-badge').getAttribute('transform'), badgePosition)
    }
    await ui.click(ui.button('恢复侧栏布局'))
    assert.equal(ui.query<HTMLElement>('#workspace-left').hidden, false)
    assert.equal(ui.query<HTMLElement>('#workspace-right').hidden, false)
    assert.equal(ui.query<HTMLElement>('#workspace-ai').hidden, false)
    assert.equal(ui.query('#inspector-model-tab').getAttribute('aria-selected'), 'true')
    assert.equal(ui.query('[aria-label="当前 SPICE 代码"]'), modelPreview)
    assert.equal(ui.query('[aria-label="当前 SPICE 代码"]').textContent, modelCode)
    assert.equal(ui.doc.querySelector('[aria-label="编辑模型定义"]'), null, 'restoring layout keeps code preview without unexpectedly opening a modal')
    assert.equal(ui.dom.window.localStorage.getItem(SIDEBAR_WIDTHS_STORAGE), savedWidths)
    assert.equal(ui.query('.ai-assistant'), assistant)
    for (const tab of ['inspector-device-tab', 'inspector-model-tab']) {
      await ui.click(ui.query(`#${tab}`))
      assert.equal(ui.query('.editor-canvas'), canvas)
      assert.equal(ui.query('.ai-assistant'), assistant)
      assert.equal(ui.query('[aria-label="桌面共享会话问题"]'), prompt)
    }
    assert.equal(ui.query<HTMLTextAreaElement>('[aria-label="桌面共享会话问题"]').value, '检查这个电路；保留正在输入的内容')
    await ui.click(ui.button('编辑器件 SPICE 代码'))
    assert.match(ui.query<HTMLTextAreaElement>('[aria-label="编辑模型定义"]').value, /\.model D_SI_edit/)
    assert.doesNotMatch(ui.query<HTMLTextAreaElement>('[aria-label="编辑模型定义"]').value, /layout_draft/, 'explicit cancellation discards only that model draft')
    await ui.key('Escape', ui.query('[aria-label="编辑模型定义"]'))
    assert.equal(ui.query('.ai-assistant'), assistant, 'opening and closing the model dialog does not unmount the independent assistant')
    assert.equal(ui.query('[aria-label="桌面共享会话问题"]'), prompt)
    assert.equal(projectKey(ui.active()), projectKey(project), 'layout, probes and drafts do not mutate the electrical project')
    assert.equal(ui.requests.length, 0, 'opening AI tools must not call a provider')
    await ui.key('p')
    assert.equal(ui.doc.querySelector('#probe-tools-popover'),null)
    assert.ok(ui.query('.workspace-commandbar').contains(ui.query('[aria-label="探针类型"]')))
    assert.equal(ui.doc.activeElement,ui.button('电压探针'),'P focuses the inline probe types')
    assert.equal(ui.doc.querySelector('#inspector-probes-tab'), null)
  } finally { await ui.close() }
})

test('one full-height left navigation switches and collapses panels without losing drafts, and F2 restores library focus', { timeout: 30000 }, async () => {
  const ui = await workspace(exampleProject('diode-sweep'))
  try {
    const canvas = ui.query('.editor-canvas'), id = ui.collection().activeId
    const rail = ui.query('.workspace-navigation-rail')
    assert.equal(rail.parentElement, ui.query('.workspace-shell'), 'navigation spans the entire shell, outside the toolbar and work surface')
    assert.equal(ui.query('.free-app').contains(rail), false)
    assert.equal(rail.nextElementSibling, ui.query('.free-app'))
    assert.equal(rail.querySelector('[role="tablist"]')?.getAttribute('aria-orientation'), 'vertical')
    for (const label of ['项目侧栏', '器件库侧栏']) {
      const entrances = ui.doc.querySelectorAll(`[aria-label="${label}"]`)
      assert.equal(entrances.length, 1, `${label} has one entrance`)
      assert.ok(rail.contains(entrances[0]))
    }
    assert.equal(ui.query('#workspace-left').querySelector('[role="tablist"]'), null, 'panel does not repeat the rail navigation')
    await ui.input('[aria-label="项目名称"]', '侧栏切换中的工程')
    assert.equal(ui.doc.querySelector('[aria-label="搜索器件"]'),null,'sidebar has only common shortcuts and one extension entrance')
    await ui.click(ui.query('.library-extension-toggle'))
    await ui.input('[aria-label="搜索本地器件"]', '继电器')
    await ui.click(ui.button('关闭拓展器件'))
    await ui.click(ui.button('项目侧栏'))
    assert.equal(ui.query<HTMLElement>('#workspace-projects-panel').hidden, false)
    assert.ok(ui.doc.querySelector('.project-sidebar-entry[title="侧栏切换中的工程"]'))
    await ui.click(ui.query('#workspace-library-tab'))
    await ui.click(ui.query('.library-extension-toggle'))
    assert.equal(ui.query<HTMLInputElement>('[aria-label="搜索本地器件"]').value,'继电器','switching sections preserves the extension search')
    await ui.click(ui.button('关闭拓展器件'))
    await ui.click(ui.query('#workspace-projects-tab'))
    await ui.key('End', ui.query('#workspace-projects-tab'))
    assert.equal(ui.query('#workspace-library-tab').getAttribute('aria-selected'), 'true')
    await ui.key('ArrowUp', ui.query('#workspace-library-tab'))
    assert.equal(ui.doc.activeElement, ui.query('#workspace-projects-tab'))
    assert.equal(ui.query('#workspace-projects-tab').getAttribute('aria-expanded'), 'true')
    await ui.key('ArrowDown', ui.query('#workspace-projects-tab'))
    assert.equal(ui.doc.activeElement, ui.query('#workspace-library-tab'))
    assert.equal(ui.query('#workspace-library-tab').getAttribute('aria-expanded'), 'true')
    await ui.click(ui.button('最大化画布'))
    await ui.click(ui.button('查看网表'))
    await ui.key('F2')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(ui.query<HTMLElement>('#workspace-left').hidden, false)
    assert.equal(ui.query<HTMLElement>('#workspace-library-panel').hidden, false)
    assert.equal(ui.query<HTMLElement>('#workspace-right').hidden, true)
    assert.equal(ui.query('.workspace-shell').classList.contains('is-canvas-maximized'), false)
    assert.equal(ui.query<HTMLElement>('.workspace-canvas-host').hidden, false)
    const search=ui.query<HTMLInputElement>('[aria-label="搜索本地器件"]')
    assert.ok(search.closest('[role="dialog"][aria-label="拓展器件"]'))
    assert.equal(ui.doc.activeElement,search,'F2 opens the unified dialog and focuses its local model search')
    assert.equal(search.value,'继电器','F2 keeps the existing local filters')
    await ui.click(ui.button('关闭拓展器件'))
    assert.equal(ui.collection().activeId, id)
    assert.equal(ui.active().title, '侧栏切换中的工程')
    assert.equal(ui.query('.editor-canvas'), canvas)
    await ui.click(ui.button('项目侧栏'))
    const projectPanel = ui.query('.project-sidebar')
    await ui.click(ui.button('项目侧栏'))
    assert.equal(ui.query<HTMLElement>('#workspace-left').hidden, true)
    assert.equal(ui.query('#workspace-projects-tab').getAttribute('aria-expanded'), 'false')
    await ui.click(ui.button('项目侧栏'))
    assert.equal(ui.query<HTMLElement>('#workspace-left').hidden, false)
    assert.equal(ui.query('#workspace-projects-tab').getAttribute('aria-expanded'), 'true')
    assert.equal(ui.query('.project-sidebar'), projectPanel)
    assert.equal(ui.collection().activeId, id)
  } finally { await ui.close() }
})

test('file actions remain available in the top menu and close on Escape or an action', { timeout: 30000 }, async () => {
  const ui = await workspace(exampleProject('diode-sweep'))
  try {
    const project = structuredClone(ui.active()), menu = ui.query<HTMLDetailsElement>('.workspace-file-menu'), summary = ui.query('.workspace-file-menu > summary')
    assert.equal(menu.open, false)
    await ui.click(summary)
    assert.equal(menu.open, true)
    for (const label of ['空白画布', '打开工程文件', '保存工程文件', '导出原理图 SVG', '导出 LTspice .asc', '导出 SPICE .cir']) {
      assert.ok(menu.contains(ui.button(label)))
    }
    await ui.key('Escape', ui.button('打开工程文件'))
    assert.equal(menu.open, false)
    assert.equal(ui.doc.activeElement, summary)
    await ui.click(summary)
    await ui.click(ui.button('打开工程文件'))
    assert.equal(menu.open, false)
    assert.equal(projectKey(ui.active()), projectKey(project))
  } finally { await ui.close() }
})



test('right waveform groups retain coordinates, curves and cursors across collapse/focus without editing the circuit', {timeout:30000}, async()=>{
  const ui=await workspace(exampleProject('diode-sweep'))
  try {
    const canvas=ui.query('.editor-canvas'),original=structuredClone(ui.active())
    const page=()=>ui.query('[data-page-waveform]:not([hidden])')
    assert.deepEqual([...ui.query('[aria-label="工作区导航"]').querySelectorAll('button')].map(node=>node.textContent),['原理图','网表'])
    assert.equal(canvas.querySelector('[data-canvas-diagram]'),null)
    assert.ok(ui.query('[aria-label="调整电路与波形比例"]'))
    assert.equal(ui.query<HTMLElement>('.workspace-canvas-host').hidden,false)
    // Automatic fitting may respond to layout changes. Preserve an explicitly
    // chosen camera here, rather than an initial camera awaiting its first fit.
    await ui.click(ui.button('放大画布'))
    const viewBox=canvas.getAttribute('viewBox')
    await ui.selectDevice('D1')
    await ui.click(ui.query('#page-sidebar-waveform-tab'))
    const selection=ui.doc.querySelectorAll('.editor-device.selected').length
    await ui.input(page().querySelector('[aria-label="波形视图布局"]')!,'2')
    await ui.click(ui.button('放大所有波形',page()))
    await ui.click(ui.button('曲线',page()))
    const selected=page().querySelector<HTMLInputElement>('.wave-embedded-curves input:checked')!
    assert.ok(selected);await ui.click(selected)
    await ui.click(ui.button('绘图',page()))
    await ui.click(ui.button('A/B 测量',page()))
    const waveform=ui.query('.wave-workspace'),plot=page().querySelector('.wave-plot')!,start=plot.getAttribute('data-x-start'),end=plot.getAttribute('data-x-end')
    const curveIds=[...page().querySelectorAll('[data-wave-trace]')].map(trace=>trace.getAttribute('data-wave-trace'))
    const cursors=[...page().querySelectorAll('[data-wave-cursor]')].map(cursor=>cursor.getAttribute('aria-valuenow'))
    const beforeRuns=ui.pending.length
    await ui.click(ui.button('收起波形'))
    assert.equal(ui.query('.single-page-workspace').getAttribute('data-workspace-mode'),'schematic')
    assert.equal(ui.doc.querySelector('.page-waveform-rail'),null,'collapsed results do not reserve a second full-height navigation rail')
    await ui.click(ui.button('展开波形',ui.query('[aria-label="工作区视图"]')))
    for(const focus of ['专注波形','专注电路']){
      await ui.click(ui.button(focus));await ui.click(ui.button('恢复左右布局'))
    }
    assert.equal(ui.query('.wave-workspace'),waveform)
    assert.equal(plot.getAttribute('data-x-start'),start);assert.equal(plot.getAttribute('data-x-end'),end)
    assert.deepEqual([...page().querySelectorAll('[data-wave-trace]')].map(trace=>trace.getAttribute('data-wave-trace')),curveIds)
    assert.deepEqual([...page().querySelectorAll('[data-wave-cursor]')].map(cursor=>cursor.getAttribute('aria-valuenow')),cursors)
    assert.equal(canvas.getAttribute('viewBox'),viewBox)
    assert.equal(ui.pending.length,beforeRuns)
    assert.equal(ui.doc.querySelectorAll('.editor-device.selected').length,selection)
    assert.equal(ui.doc.querySelector('[role="dialog"][aria-label="放大波形"]'),null)
    await ui.click(ui.button('新图组'))
    await ui.click(ui.button('图组与对比',page()))
    await ui.click(ui.button('删除图组',page()))
    await ui.click(ui.button('撤销图组操作'))
    assert.equal((ui.query('[aria-label="当前波形图组"]') as HTMLSelectElement).options.length,2)
    await ui.key('Delete',ui.query('[aria-label="当前波形图组"]'))
    await ui.key('Enter',ui.query('[aria-label="当前波形图组"]'),{ctrlKey:true})
    assert.equal(ui.pending.length,beforeRuns,'waveform controls do not dispatch circuit run shortcuts')
    assert.equal(projectKey(ui.active()),projectKey(original))
    await ui.remount()
    assert.equal((ui.query('[aria-label="当前波形图组"]') as HTMLSelectElement).options.length,2)
    assert.equal(ui.doc.querySelector('[data-canvas-diagram]'),null)
  } finally {await ui.close()}
})
