import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useState } from 'react'
import { editorTemplate } from '../src/core/editor'
import type { Project } from '../src/core/circuit'
import type { DesktopCircuitTask } from '../src/core/desktop-circuit'
import { aiProjectFingerprint } from '../src/core/ai'

async function environment(options: { clipboard?: boolean; legacyPending?: boolean; holdNativeState?: boolean } = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost:3032/' })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  const initial = editorTemplate('rc-lowpass'), requests: { path: string; signal?: AbortSignal | null }[] = [], copied: string[] = []
  let current = initial, tasks: DesktopCircuitTask[] = [], update = () => {}, replace = (_project: Project) => {}, mode = (_mode: 'mcp' | 'native') => {}, settingsOpened = 0
  let busy = false
  if (options.legacyPending) dom.window.localStorage.setItem('fuxian.desktop-candidate-reviews.v1:project-a', JSON.stringify({ 'task-a': { redraw: { text: '保留的重画要求', pending: { id: 'old-native-request', text: '保留的重画要求' } } } }))
  const navigator = options.clipboard === false ? { userAgent: dom.window.navigator.userAgent } : { userAgent: dom.window.navigator.userAgent, clipboard: { async writeText(text: string) { copied.push(text) } } }
  const fetchFixture = async (input: string, init?: RequestInit) => {
    requests.push({ path: input, signal: init?.signal })
    if (options.holdNativeState && input.startsWith('/api/desktop-control/state?')) return new Promise<Response>(() => {})
    if (input.startsWith('/api/desktop-control/state?')) return Response.json({ projectId: 'project-a', threadId: 'native-thread', connected: true, ready: true, desktopConnected: true, owner: 'desktop', busy: false, pendingOwner: null, pendingApprovals: 0, approvals: [], messages: [], error: null, updatedAt: 1 })
    throw new Error(`Unexpected API request: ${input}`)
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchFixture })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const { createRoot } = await import('react-dom/client'), { default: DesktopControlAssistant } = await import('../src/components/DesktopControlAssistant')
  const root = createRoot(dom.window.document.getElementById('root')!)
  function Harness() {
    const [project, setProject] = useState(initial), [connectionMode, setMode] = useState<'mcp' | 'native'>('mcp'), [, repaint] = useState(0)
    current = project; replace = setProject; mode = setMode; update = () => repaint(n => n + 1)
    const state = { snapshot: { projectId: 'project-a', revision: 7, project, updatedAt: '2026-11-06' }, tasks, cliPath: 'C:/fixture/desktop-circuit.mjs' }
    const circuit = { status: 'ready' as const, error: '', reconnect() {}, refresh() {}, retry: async () => ({ status: 'ready' as const, error: '', state }), state }
    return createElement(DesktopControlAssistant, { projectId: 'project-a', project, circuit, connectionMode, onOpenSettings() { settingsOpened++ }, onBusyChange(value) { busy = value }, onApply(next: Project) { setProject(next); return next } })
  }
  const doc = dom.window.document
  const button = (label: string) => { const node = [...doc.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label); assert.ok(node, label); return node }
  const click = async (label: string) => act(async () => button(label).click())
  await act(async () => root.render(createElement(Harness)))
  return { doc, requests, initial, copied, button, click, get current() { return current }, get busy() { return busy }, get settingsOpened() { return settingsOpened },
    async addTask(task: DesktopCircuitTask) { tasks = [...tasks, task]; await act(async () => update()) },
    async external(project: Project) { await act(async () => replace(project)) },
    async mode(value: 'mcp' | 'native') { await act(async () => mode(value)) },
    async type(text: string) { await act(async () => { const input = doc.querySelector<HTMLTextAreaElement>('[aria-label="重画要求"]')!; Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) }) },
    async cleanup() { await act(async () => root.unmount()); dom.window.close(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) } },
  }
}
function task(initial: Project, value = '2k'): DesktopCircuitTask {
  const proposal = structuredClone(initial); proposal.drawing!.devices.find(device => device.id === 'R1')!.value = value
  return { id: 'task-a', projectId: 'project-a', requestId: 'mcp-request', request: '调整 R1', source: 'desktop', status: 'completed', baseline: structuredClone(initial), baselineRevision: 7, layoutOnly: false, events: [], result: { summary: '调整 R1 为 2k', proposal: { project: proposal, summary: '调整参数', changes: ['R1=2k'], warnings: [], base: aiProjectFingerprint(initial) }, changed: true, simulation: null }, createdAt: '2026-11-06', updatedAt: '2026-11-06' }
}

test('MCP task panel shows synchronized project and configuration without native conversation requests', async () => {
  const page = await environment()
  try {
    assert.ok(page.doc.querySelector('[aria-label="MCP 电路任务"]'))
    assert.match(page.doc.body.textContent!, /当前画布已同步到电路工具/)
    assert.match(page.doc.body.textContent!, /project-a/)
    assert.equal(page.doc.querySelector('.desktop-control-handoff, .desktop-control-messages, .desktop-control-composer'), null)
    assert.equal(page.doc.querySelector('[aria-label="桌面共享会话问题"]'), null)
    await page.click('连接配置'); assert.equal(page.settingsOpened, 1)
    await page.click('复制工程任务提示')
    assert.match(page.copied[0], /projectId: project-a/)
    assert.match(page.copied[0], /先读取当前工程及 revision/)
    assert.match(page.doc.body.textContent!, /此处尚未发送任务/)
    assert.deepEqual(page.requests, [])
  } finally { await page.cleanup() }
})

test('MCP candidates apply, undo, reapply, discard and restore using the shared review flow', async () => {
  const page = await environment()
  try {
    const candidate = task(page.initial)
    await page.addTask(candidate)
    assert.ok(page.doc.querySelector('[aria-label="候选原理图预览"]'))
    await page.click('应用方案（可撤销）'); assert.deepEqual(page.current, candidate.result!.proposal.project)
    await page.click('撤销应用'); assert.deepEqual(page.current, page.initial)
    await page.click('再次应用方案'); assert.deepEqual(page.current, candidate.result!.proposal.project)
    await page.click('撤销应用'); await page.click('舍弃方案')
    assert.equal(page.doc.querySelector('[aria-label="候选原理图预览"]'), null)
    await page.click('恢复方案'); assert.ok(page.doc.querySelector('[aria-label="候选原理图预览"]'))
    assert.deepEqual(page.requests, [])
  } finally { await page.cleanup() }
})

test('MCP conflict resolution requires preview and preserves undo snapshot', async () => {
  const page = await environment()
  try {
    await page.addTask(task(page.initial))
    const manual = structuredClone(page.initial); manual.title = '手工编辑'; manual.drawing!.devices.find(device => device.id === 'R1')!.value = '3k'
    await page.external(manual)
    assert.equal(page.doc.querySelector('.desktop-control-task')!.getAttribute('data-candidate-state'), 'conflict')
    await page.click('保留其他手动改动并应用'); assert.deepEqual(page.current, manual)
    await page.click('确认保留其他改动并应用')
    assert.equal(page.current.title, manual.title)
    assert.equal(page.current.drawing!.devices.find(device => device.id === 'R1')!.value, '2k')
    await page.click('撤销应用'); assert.deepEqual(page.current, manual)
    assert.deepEqual(page.requests, [])
  } finally { await page.cleanup() }
})

test('MCP redraw copies project and candidate context without resending legacy pending native messages', async () => {
  const page = await environment({ legacyPending: true })
  try {
    await page.addTask(task(page.initial)); await page.click('重画'); await page.type('反馈回路放上方')
    assert.equal(page.button('复制重画任务提示').disabled, false)
    await page.click('复制重画任务提示')
    assert.match(page.copied[0], /projectId: project-a/); assert.match(page.copied[0], /taskId: task-a/); assert.match(page.copied[0], /反馈回路放上方/)
    const saved = JSON.parse(localStorage.getItem('fuxian.desktop-candidate-reviews.v1:project-a')!)
    assert.equal(saved['task-a'].redraw.pending.id, 'old-native-request')
    assert.deepEqual(page.current, page.initial); assert.deepEqual(page.requests, [])
  } finally { await page.cleanup() }
})

test('clipboard failure provides the full manual copy text and never reports sent or copied', async () => {
  const page = await environment({ clipboard: false })
  try {
    await page.click('复制工程任务提示')
    const input = page.doc.querySelector<HTMLTextAreaElement>('[aria-label="手动复制任务提示"]')!
    assert.match(input.value, /projectId: project-a/)
    assert.equal(input.readOnly, true)
    assert.match(page.doc.querySelector('.ai-notice')!.textContent!, /无法自动复制/)
    assert.doesNotMatch(page.doc.querySelector('.ai-notice')!.textContent!, /任务提示已复制/)
    assert.deepEqual(page.requests, [])
  } finally { await page.cleanup() }
})

test('switching from native to MCP aborts native polling and retains application history', async () => {
  const page = await environment({ holdNativeState: true })
  try {
    await page.addTask(task(page.initial)); await page.click('应用方案（可撤销）')
    await page.mode('native'); assert.equal(page.requests.length, 1)
    const nativeRequest = page.requests[0]; assert.match(nativeRequest.path, /desktop-control/)
    await page.mode('mcp'); assert.equal(nativeRequest.signal?.aborted, true)
    assert.equal(page.requests.length, 1)
    assert.equal(page.doc.querySelector('.desktop-control-task')!.getAttribute('data-candidate-state'), 'applied')
    await page.click('撤销应用'); assert.deepEqual(page.current, page.initial)
    assert.equal(page.requests.length, 1)
  } finally { await page.cleanup() }
})

test('MCP running tasks expose task activity without claiming a desktop conversation is busy', async () => {
  const page = await environment()
  try {
    const running = task(page.initial); running.status = 'running'; running.result = null
    await page.addTask(running)
    assert.equal(page.busy, true)
    assert.match(page.doc.querySelector('.desktop-control-task-waiting')!.textContent!, /等待 AI 客户端提交任务结果/)
    assert.equal(page.doc.querySelector('.desktop-control-run-status'), null)
    assert.deepEqual(page.requests, [])
  } finally { await page.cleanup() }
})
