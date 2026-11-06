import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { editorTemplate } from '../src/core/editor'
import { aiProjectFingerprint } from '../src/core/ai'
import { parseSpiceLibrary } from '../src/core/spice-models'
import type { DesktopCircuitTask } from '../src/core/desktop-circuit'
import type { AgentModelAcquisition } from '../src/core/agent-models'

async function environment() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost:3032/' })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  const calls: { path: string; payload?: any; signal?: AbortSignal | null }[] = []
  let hold = false, projectId = 'project-a', tasks: DesktopCircuitTask[] = [], received: AgentModelAcquisition[] = []
  const initial = editorTemplate('rc-lowpass')
  dom.window.localStorage.setItem('fuxian-assistant-settings-v1', JSON.stringify({ connectionMode: 'native' }))
  for (const id of ['project-a', 'project-b']) dom.window.localStorage.setItem(`fuxian.project-assistant-engine.v1:${id}`, 'dsh')
  const fetchFixture = async (path: string, options?: RequestInit) => {
    const payload = options?.body ? JSON.parse(String(options.body)) : undefined
    calls.push({ path, payload, signal: options?.signal })
    assert.equal(path, '/api/agent/run', 'MCP never starts native status or conversation APIs')
    if (hold) return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
    const candidate = structuredClone(payload.project); candidate.drawing!.devices.find((device: any) => device.id === 'R1')!.value = '820'
    const events = [{ type: 'started', engine: 'DSH fixture', version: '1' }, { type: 'done', summary: 'R1 已改为 820，等待审阅。', changed: true, project: candidate, base: aiProjectFingerprint(payload.project), simulation: null }]
    return new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } })
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchFixture })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const { createRoot } = await import('react-dom/client'), { default: AiAssistant } = await import('../src/components/AiAssistant'), { updateAssistantSettings } = await import('../src/core/assistant-settings')
  updateAssistantSettings({ api: { endpoint: 'https://example.invalid/v1', model: 'fixture-model', apiKey: 'private-session-key', preset: 'custom', protocol: 'chat-completions' } })
  const root = createRoot(dom.window.document.getElementById('root')!), doc = dom.window.document
  const render = async () => act(async () => root.render(createElement(AiAssistant, { projectId, project: initial, onOpenSettings() {}, onClose() {}, onApply(next) { return next }, onModelAcquisitions(items) { received = items }, desktopCircuit: { status: 'ready', error: '', reconnect() {}, refresh() {}, retry: async () => ({ status: 'ready' as const, error: '', state: null }), state: { snapshot: { projectId, project: initial, revision: 1, updatedAt: '2026-11-06' }, tasks, cliPath: 'fixture.mjs' } } })))
  const input = () => doc.querySelector<HTMLTextAreaElement>('[aria-label="AI 问题"]')!
  await render()
  return { doc, calls, initial, get received() { return received }, get input() { return input() },
    async type(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value); input().dispatchEvent(new dom.window.Event('input', { bubbles: true })) }) },
    async submit(wait = false) { hold = wait; await act(async () => doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))) },
    async mode(connectionMode: 'mcp' | 'native') { await act(async () => updateAssistantSettings({ connectionMode })) },
    async project(id: string) { projectId = id; await render() },
    async tasks(value: DesktopCircuitTask[]) { tasks = value; await render() },
    async cleanup() { await act(async () => root.unmount()); dom.window.close(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) } },
  }
}

test('DSH drafts, conversation, reviewed candidates and project isolation survive MCP mode changes without replay', async () => {
  const page = await environment()
  try {
    await page.type('将 R1 调整为 820'); await page.submit()
    assert.ok(page.doc.querySelector('[aria-label="AI 修改方案"]'))
    assert.match(page.doc.querySelector('[aria-label="AI 对话记录"]')!.textContent!, /R1 已改为 820/)
    await page.type('尚未发送的新要求')
    await page.mode('mcp'); assert.equal(page.doc.querySelector('[aria-label="AI 问题"]'), null)
    await page.mode('native'); assert.equal(page.input.value, '尚未发送的新要求')
    assert.ok(page.doc.querySelector('[aria-label="AI 修改方案"]'))
    assert.match(page.doc.querySelector('[aria-label="AI 对话记录"]')!.textContent!, /R1 已改为 820/)
    assert.equal(page.calls.length, 1)
    await page.project('project-b'); assert.equal(page.input.value, ''); assert.equal(page.doc.querySelector('[aria-label="AI 修改方案"]'), null)
    await page.type('项目 B 草稿'); await page.project('project-a'); assert.equal(page.input.value, '尚未发送的新要求')
    await page.submit(); assert.equal(page.calls[1].payload.history.length, 2)
    assert.ok(!JSON.stringify(localStorage).includes('private-session-key'))
  } finally { await page.cleanup() }
  const otherWindow = await environment()
  try { assert.equal(otherWindow.input.value, ''); assert.equal(otherWindow.doc.querySelector('[aria-label="AI 对话记录"]'), null) }
  finally { await otherWindow.cleanup() }
})

test('switching an active DSH task to MCP aborts it and restores stopped status without resending', async () => {
  const page = await environment()
  try {
    await page.type('运行中任务'); await page.submit(true)
    assert.equal(page.calls.length, 1); assert.ok(page.doc.querySelector('.agent-run-running'))
    await page.mode('mcp'); assert.equal(page.calls[0].signal?.aborted, true)
    await page.mode('native'); assert.equal(page.input.value, '运行中任务')
    assert.ok(page.doc.querySelector('.agent-run-stopped')); assert.equal(page.doc.querySelector('.agent-run-running'), null)
    assert.match(page.doc.body.textContent!, /不会自动重发/)
    assert.equal(page.calls.length, 1); assert.equal(page.input.disabled, false)
  } finally { await page.cleanup() }
})

test('MCP mode forwards acquired model results into the existing library review callback', async () => {
  const page = await environment()
  try {
    const source = { label: 'fixture library' }, text = '.model REVIEW_D D(IS=1n)'
    const acquisition: AgentModelAcquisition = { id: 'model-a', name: 'REVIEW_D', query: 'REVIEW_D', origin: 'online', importedModelIds: [], text, source, ...parseSpiceLibrary(text, source) }
    await page.mode('mcp')
    await page.tasks([{ id: 'task-a', projectId: 'project-a', requestId: 'request-a', request: '搜索模型', source: 'desktop', status: 'completed', baseline: page.initial, baselineRevision: 1, layoutOnly: false, createdAt: '2026-11-06', updatedAt: '2026-11-06', events: [], result: { changed: false, simulation: null, summary: '模型已找到', proposal: { summary: '模型已找到', project: page.initial, changes: [], warnings: [], base: aiProjectFingerprint(page.initial) }, modelAcquisitions: [acquisition] } }])
    assert.deepEqual(page.received, [acquisition]); assert.equal(page.calls.length, 0)
  } finally { await page.cleanup() }
})
