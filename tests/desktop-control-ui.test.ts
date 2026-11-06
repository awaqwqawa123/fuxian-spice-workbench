import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useState,Profiler } from 'react'
import { editorTemplate } from '../src/core/editor'
import type { Project } from '../src/core/circuit'
import type { DesktopControlState } from '../src/core/desktop-control'
import type { DesktopCircuitTask } from '../src/core/desktop-circuit'
import { desktopControlDraftKey } from '../src/components/DesktopControlAssistant'
import { aiProjectFingerprint } from '../src/core/ai'

const initialState = (projectId = 'project-a'): DesktopControlState => ({ projectId, threadId: 'official-thread-a', connected: true, ready: true, desktopConnected: true, owner: 'desktop', busy: false, pendingOwner: null, pendingApprovals: 0, approvals: [], messages: [], error: null, updatedAt: 1 })
async function environment(initialPatch: Partial<DesktopControlState> = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost:3032/' }), previous = new Map<string, PropertyDescriptor | undefined>()
  dom.window.localStorage.setItem('fuxian-assistant-settings-v1',JSON.stringify({connectionMode:'native'}))
  const initial = editorTemplate('rc-lowpass'), requests: { path: string; body: any }[] = []
  const states = new Map([['project-a', { ...initialState(), ...initialPatch }], ['project-b', { ...initialState('project-b'), threadId: 'official-thread-b' }]])
  let current = initial, tasks: DesktopCircuitTask[] = [], failSend = false, rejectSend = 0, backendOffline = false, update = () => {}, select = (_id: string) => {}, replace = (_project: Project) => {}
  let handoffFailure: { status: number; message: string } | null = null, handoffWait: Promise<void> | null = null
  let applyFailure = false,renderCommits=0
  const legacyKey = 'fuxian.codex-project-session.v1:project-a', legacyValue = JSON.stringify({ sessionId: 'old-session', draft: '原网页草稿', candidates: [] })
  const hapiKey = 'fuxian.hapi-draft.v1:project-a', hapiValue = JSON.stringify({ draft: 'HAPI 原草稿' })
  dom.window.localStorage.setItem(legacyKey, legacyValue); dom.window.localStorage.setItem(hapiKey, hapiValue)
  const fetchFixture = async (input: string, options?: RequestInit) => {
    if (input === '/api/codex-session/state?id=old-session') {
      assert.equal(options?.method, 'GET'); requests.push({ path: input, body: undefined })
      return Response.json({ id: 'old-session', threadId: 'legacy-thread', model: 'old-model', reasoningEffort: 'medium', status: 'running', messages: [{ id: 'old-message', requestId: 'old-request', role: 'user', content: '旧的未送达问题', delivery: 'notSent', createdAt: 1 }], events: [], project: initial, result: null, lastSimulation: null, error: null, activeRequestId: 'old-request', createdAt: 1, updatedAt: 2 })
    }
    if (!input.startsWith('/api/desktop-control/')) requests.push({ path: input, body: options?.body ? JSON.parse(String(options.body)) : undefined })
    assert.ok(input.startsWith('/api/desktop-control/'), `desktop default must not start other runtimes: ${input}`)
    assert.equal((options?.headers as Record<string, string>)['X-Fuxian-Desktop-Control'], '1')
    const body = options?.body ? JSON.parse(String(options.body)) : undefined; requests.push({ path: input, body })
    if (backendOffline) throw new TypeError('Failed to fetch')
    const id = body?.projectId ?? new URL(input, 'http://localhost').searchParams.get('projectId'), state = states.get(id)!
    assert.ok(state, id)
    if (input.includes('/state?')) return Response.json(state)
    if(input.endsWith('/reconnect')){if(state.connected&&state.ready&&state.desktopConnected&&!state.threadId){state.threadId=`new-official-thread-${id}`;state.owner='web'};return Response.json({stage:state.connected&&state.ready?'connected':'waiting-desktop',connected:state.connected,state,restartRequired:false,message:state.connected?'已连接 Codex，项目对话已就绪。':'等待桌面共享服务连接。'})}
    if (input.endsWith('/handoff')) {
      if (handoffWait) await handoffWait
      if (handoffFailure) { const failure = handoffFailure; handoffFailure = null; return Response.json({ error: failure.message }, { status: failure.status }) }
      if (state.busy || state.pendingApprovals) state.pendingOwner = body.owner; else state.owner = body.owner
      return Response.json(state)
    }
    if (input.endsWith('/bind')) { state.threadId = body.threadId ?? (body.create ? 'new-official-thread' : 'restored-thread'); return Response.json(state) }
    if (input.endsWith('/ensure')) {
      assert.equal(typeof body.title, 'string')
      state.threadId ??= `new-official-thread-${id}`
      state.owner = 'web'
      return Response.json(state)
    }
    if (input.endsWith('/send')) {
      assert.equal(state.owner, 'web'); assert.equal(state.pendingOwner, null)
      if (failSend) { failSend = false; throw new Error('送达未确认') }
      if (rejectSend) { const status = rejectSend; rejectSend = 0; return Response.json({ error: '控制权已变化，此消息尚未发送' }, { status }) }
      state.messages.push({ id: body.requestId, role: 'user', content: body.message, createdAt: 1, delivery: 'sent' }, { id: `reply-${body.requestId}`, role: 'assistant', content: '**已确认**：同一官方会话', createdAt: 2 })
      return Response.json(state)
    }
    if (input.endsWith('/approval')) { state.approvals = state.approvals.filter(item => item.id !== body.id); state.pendingApprovals = state.approvals.length; return Response.json(state) }
    assert.equal(input, '/api/desktop-control/cancel'); state.busy = false; return Response.json(state)
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchFixture })) { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
  const { createRoot } = await import('react-dom/client'), { default: AiAssistant } = await import('../src/components/AiAssistant'), root = createRoot(dom.window.document.getElementById('root')!)
  function Harness() {
    const [project, setProject] = useState(initial), [projectId, setProjectId] = useState('project-a'), [, repaint] = useState(0)
    current = project; select = setProjectId; replace = setProject; update = () => repaint(n => n + 1)
    const circuitState = { snapshot: { projectId, revision: 1, project, updatedAt: '2026-09-25' }, tasks, cliPath: 'C:/fixture/desktop-circuit.mjs' }
    const circuit = { status: 'ready' as const, error: '', reconnect() {}, refresh() {}, retry:async()=>({status:'ready' as const,error:'',state:circuitState}), state:circuitState }
    return createElement(AiAssistant, { projectId, project, desktopCircuit: circuit, onApply: (next: Project) => { if(applyFailure){applyFailure=false;throw new Error('P2 电流探针分支无法确认；原图和探针已保留。')}setProject(next) }, onClose() {} })
  }
  const doc = dom.window.document
  const button = (label: string) => { const node = [...doc.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label); assert.ok(node, label); return node }
  const click = async (label: string) => { await act(async () => button(label).click()) }
  const desktopLink = () => doc.querySelector<HTMLAnchorElement>('.desktop-control-handoff a[href^="codex://threads/"]')!
  const openDesktop = async () => { const link = desktopLink(); assert.ok(link); link.addEventListener('click', event => event.preventDefault(), { once: true }); await act(async () => link.click()) }
  const type = async (text: string) => act(async () => { const input = doc.querySelector<HTMLTextAreaElement>('[aria-label="桌面共享会话问题"]')!; Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
  await act(async () => root.render(createElement(Profiler,{id:'desktop-control',onRender:()=>{renderCommits++}},createElement(Harness))))
  return { doc, requests, states, initial, button, click, desktopLink, openDesktop, type,get renderCommits(){return renderCommits}, get current() { return current }, failOnce() { failSend = true }, rejectOnce(status: number) { rejectSend = status }, setBackendOffline(value: boolean) { backendOffline = value },
    rejectHandoffOnce(status: number, message: string) { handoffFailure = { status, message } },
    rejectApplyOnce() { applyFailure = true },
    holdHandoff() { let release: () => void; handoffWait = new Promise<void>(resolve => { release = resolve }); return () => { handoffWait = null; release!() } },
    async refresh() { await click('重新连接桌面共享') }, async switchProject(id: string) { await act(async () => select(id)) }, async external(project: Project) { await act(async () => replace(project)) }, async addTask(task: DesktopCircuitTask) { tasks = [...tasks, task]; await act(async () => update()) },
    assertOtherDrafts() { assert.equal(dom.window.localStorage.getItem(legacyKey), legacyValue); assert.equal(dom.window.localStorage.getItem(hapiKey), hapiValue) },
    async cleanup() { await act(async () => root.unmount()); dom.window.close(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) } },
  }
}

test('desktop default performs read-only discovery and does not start HAPI or old runtimes', async () => {
  const page = await environment()
  try {
    assert.equal(page.requests.length, 1); assert.equal(page.requests[0].body, undefined)
    assert.equal(page.button('发送给 Codex').disabled, true)
    assert.equal(page.doc.querySelector('a[href="codex://threads/official-thread-a"]')?.textContent?.trim(), '打开并切到桌面')
    const selector = page.doc.querySelector<HTMLSelectElement>('[aria-label="AI 运行方式"]')!
    assert.equal(selector.value, 'codex'); assert.deepEqual([...selector.options].map(option => option.value), ['codex', 'cursor', 'dsh'])
    assert.equal(page.doc.querySelector('[aria-label="Codex 会话入口"]'), null)
    assert.equal(page.doc.querySelector('.hapi-assistant, .persistent-assistant'), null)
    await page.type('尚未发送的草稿'); page.assertOtherDrafts()
    assert.equal(page.doc.querySelector<HTMLTextAreaElement>('textarea')?.value, '尚未发送的草稿')
    assert.equal(page.requests.length, 1)
  } finally { await page.cleanup() }
})

test('an invalid canvas draft cannot appear synchronized or crash the desktop assistant', async () => {
  const page = await environment({ owner: 'web' })
  try {
    const invalid = structuredClone(page.initial)
    invalid.drawing!.devices[0].value = '1'.repeat(81)
    await page.external(invalid)
    assert.equal(page.button('发送给 Codex').disabled, true)
    assert.equal(page.doc.querySelector('.desktop-control-scroll') !== null, true)
    assert.equal(page.requests.filter(item => item.path.endsWith('/send')).length, 0)
    await page.refresh()
    assert.match(page.doc.body.textContent ?? '', /画布(?:尚未同步|仍在同步)|正在同步当前画布/)
  } finally { await page.cleanup() }
})

test('a busy chat keeps a visible loading icon after all tool steps finish', async () => {
  const startedAt = Date.now() - 120000
  const page = await environment({ owner: 'web', busy: true, messages: [{ id: 'question', role: 'user', content: '帮我做一个滤波电路', createdAt: startedAt, delivery: 'sent' }] })
  try {
    const task: DesktopCircuitTask = { id: 'task-running', projectId: 'project-a', requestId: 'question', request: '帮我做一个滤波电路', source: 'desktop', status: 'running', baseline: structuredClone(page.initial), baselineRevision: 1, layoutOnly: false, events: [
      { type: 'tool', name: 'inspect_circuit', status: 'completed', detail: '已完成' },
      { type: 'tool', name: 'replace_candidate', status: 'completed', detail: '已完成' },
      { type: 'tool', name: 'validate_circuit', status: 'completed', detail: '已完成' },
    ], result: null, createdAt: new Date(startedAt).toISOString(), updatedAt: new Date(Date.now() - 30000).toISOString() }
    await page.addTask(task)
    const banner = page.doc.querySelector('.desktop-control-run-status')!
    assert.ok(banner)
    assert.equal(page.doc.querySelector('.desktop-control-scroll')!.contains(banner), false, 'loading remains visible outside the scrolling task history')
    assert.ok(banner.querySelector('.desktop-control-run-icon .desktop-control-spinner'))
    assert.match(banner.textContent!, /本轮仍在进行.*3\/3 个电路步骤已完成.*最近工具更新/s)
    assert.match(page.doc.querySelector('.desktop-control-task-waiting')!.textContent!, /等待本轮对话结束/)
    assert.match(page.doc.querySelector('.desktop-control-status')!.textContent!, /本轮进行中/)
    page.states.get('project-a')!.busy = false
    await page.refresh()
    assert.equal(page.doc.querySelector('.desktop-control-run-status'), null)
    assert.match(page.doc.querySelector('.desktop-control-status')!.textContent!, /本轮已结束/)
  } finally { await page.cleanup() }
})

test('an approval stays beside the composer when the earlier circuit task was interrupted', async () => {
  const startedAt = Date.now() - 120000
  const page = await environment({ owner: 'web', busy: true, pendingApprovals: 1, messages: [{ id: 'question', role: 'user', content: '配置波形图', createdAt: startedAt, delivery: 'sent' }], approvals: [{ id: 'approval-1', method: 'item/commandExecution/requestApproval', title: '允许本次命令执行', detail: 'node scripts/desktop-circuit.mjs inspect', supported: true }] })
  try {
    const task: DesktopCircuitTask = { id: 'task-interrupted', projectId: 'project-a', requestId: 'question', request: '配置波形图', source: 'desktop', status: 'interrupted', baseline: structuredClone(page.initial), baselineRevision: 1, layoutOnly: false, events: [{ type: 'tool', name: 'configure_waveforms', status: 'error', detail: '参数需要修正' }], result: null, error: '工作台服务重启，旧任务已中断', createdAt: new Date(startedAt).toISOString(), updatedAt: new Date(Date.now() - 30000).toISOString() }
    await page.addTask(task)
    const dock = page.doc.querySelector('.desktop-control-approval-dock')!
    assert.ok(dock)
    assert.equal(page.doc.querySelector('.desktop-control-scroll')!.contains(dock), false)
    assert.ok(dock.querySelector('button')?.textContent?.includes('允许本次'))
    const banner = page.doc.querySelector('.desktop-control-run-status')!
    assert.match(banner.textContent!, /电路任务已因服务重启中断.*请求待确认/)
    assert.doesNotMatch(banner.textContent!, /最近工具更新/)
    await page.click('允许本次')
    assert.equal(page.states.get('project-a')!.pendingApprovals, 0)
  } finally { await page.cleanup() }
})

test('desktop-only project chat leaves old local records untouched', async () => {
  const page = await environment()
  try {
    const proposal = structuredClone(page.initial); proposal.drawing!.devices[0].x += 80
    const original = { sessionId: 'old-session', draft: '原网页草稿', candidates: [{ requestId: 'saved-candidate', summary: '旧方案', project: proposal, baseline: page.initial, base: aiProjectFingerprint(page.initial), everApplied: false, discarded: false }] }
    localStorage.setItem('fuxian.codex-project-session.v1:project-a', JSON.stringify(original))
    assert.equal(page.doc.querySelector('.persistent-assistant, .hapi-assistant'), null)
    await page.type('当前桌面共享草稿')
    assert.ok(page.requests.every(item => item.body === undefined), 'history never mutates a server runtime')
    assert.ok(page.requests.every(item => item.path.startsWith('/api/desktop-control/state?')))
    assert.deepEqual(JSON.parse(localStorage.getItem('fuxian.codex-project-session.v1:project-a')!), original)
    assert.equal(localStorage.getItem('fuxian.hapi-draft.v1:project-a'), JSON.stringify({ draft: 'HAPI 原草稿' }))
  } finally { await page.cleanup() }
})

test('opening the bound chat in desktop also transfers control and blocks web sending', async () => {
  const page = await environment({ owner: 'web' })
  try {
    await page.type('留在网页的草稿')
    assert.equal(page.doc.querySelector('.desktop-control-details a'), null, 'the lower duplicate action is removed')
    await page.openDesktop()
    assert.deepEqual(page.requests.find(item => item.path.endsWith('/handoff'))?.body, { projectId: 'project-a', owner: 'desktop' })
    assert.equal(page.states.get('project-a')!.owner, 'desktop')
    assert.equal(page.button('发送给 Codex').disabled, true)
    assert.equal(page.doc.querySelector<HTMLTextAreaElement>('textarea')!.value, '留在网页的草稿')
    assert.equal(page.doc.querySelector('[aria-label="官方 Codex Thread ID"]'), null)
    assert.match(page.doc.querySelector('.desktop-control-details')!.textContent!, /对话编号（Thread ID）只是定位用/)
  } finally { await page.cleanup() }
})

test('disconnected desktop ownership cannot open or transfer the project chat', async () => {
  const page = await environment({ owner: 'desktop' })
  try {
    page.states.get('project-a')!.connected = false
    await page.refresh()
    assert.equal(page.desktopLink().getAttribute('aria-disabled'), 'true')
    let allowed = true
    await act(async () => { allowed = page.desktopLink().dispatchEvent(new page.doc.defaultView!.MouseEvent('click', { bubbles: true, cancelable: true })) })
    assert.equal(allowed, false)
    assert.equal(page.requests.filter(item => item.path.endsWith('/handoff')).length, 0)
    assert.match(page.doc.querySelector('.ai-notice')!.textContent!, /当前无法切到桌面/)
  } finally { await page.cleanup() }
})

test('a bound project shows one fixed chat with no action to create a second', async () => {
  const page = await environment({ owner: 'web' })
  try {
    assert.equal(page.doc.querySelector('.desktop-control-conversations,.desktop-control-history'), null)
    assert.equal(page.doc.querySelector('[aria-label="官方 Codex Thread ID"]'), null)
    assert.match(page.doc.querySelector('.desktop-control-intro')!.textContent!, /每个项目固定一段新建的 Codex 对话/)
    assert.ok(page.requests.every(item => !item.path.endsWith('/bind') && !item.path.endsWith('/new-thread')))
  } finally { await page.cleanup() }
})

test('disconnected setup and binding details start collapsed so the compose area stays available', async () => {
  const page = await environment({ connected: false, ready: false, threadId: null, owner: null })
  try {
    assert.equal(page.doc.querySelector<HTMLDetailsElement>('.desktop-control-setup')!.open, false)
    assert.equal(page.doc.querySelector<HTMLDetailsElement>('.desktop-control-details')!.open, false)
    assert.ok(page.doc.querySelector('[aria-label="桌面共享会话问题"]'))
    assert.equal(page.button('发送给 Codex').disabled, true)
  } finally { await page.cleanup() }
})

test('busy handoff waits for broker acknowledgement before enabling sends in the same thread', async () => {
  const page = await environment({ busy: true })
  try {
    await page.type('继续解释电路'); await page.click('切到网页')
    assert.equal(page.doc.querySelector('.desktop-control-assistant')?.getAttribute('data-control'), 'pending')
    assert.equal(page.button('发送给 Codex').disabled, true)
    assert.match(page.doc.body.textContent!, /确认前网页不会发送消息/)
    const state = page.states.get('project-a')!; state.busy = false; state.owner = 'web'; state.pendingOwner = null
    await page.refresh(); assert.equal(page.button('发送给 Codex').disabled, false)
    await page.click('发送给 Codex'); assert.equal(state.threadId, 'official-thread-a')
    assert.equal(state.messages.length, 2); assert.equal(page.doc.querySelector<HTMLTextAreaElement>('textarea')!.value, '')
    await page.openDesktop(); assert.equal(page.button('发送给 Codex').disabled, true)
  } finally { await page.cleanup() }
})

test('handoff failure stays beside buttons through successful polling and does not falsely disconnect', async () => {
  const page = await environment()
  try {
    await page.type('保留这份草稿')
    page.rejectHandoffOnce(409, '此对话已归档，请先在 Codex 恢复归档后再切换。')
    await page.click('切到网页')
    const feedback = () => page.doc.querySelector('.desktop-control-handoff-feedback')
    assert.match(feedback()!.textContent!, /尚未确认切到网页.*已归档/)
    assert.match(page.doc.querySelector('.desktop-control-status')!.textContent!, /桌面控制中/)
    assert.doesNotMatch(page.doc.querySelector('.desktop-control-status')!.textContent!, /未就绪|未连接/)
    assert.equal(page.button('切到网页').disabled, false)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1900)) })
    assert.match(feedback()!.textContent!, /已归档/)
    assert.equal(page.requests.filter(item => item.path.endsWith('/handoff')).length, 1, 'polling never retries the handoff')
    assert.equal(page.doc.querySelector<HTMLTextAreaElement>('textarea')!.value, '保留这份草稿')
    await page.click('切到网页')
    assert.equal(feedback(), null)
    assert.equal(page.states.get('project-a')!.owner, 'web')
    assert.equal(page.doc.querySelector<HTMLTextAreaElement>('textarea')!.value, '保留这份草稿')
    assert.equal(page.requests.filter(item => item.path.endsWith('/send')).length, 0)
  } finally { await page.cleanup() }
})

test('handoff progress names the direction and only confirmed ownership clears an earlier failure', async () => {
  const page = await environment()
  let release: (() => void) | undefined
  try {
    release = page.holdHandoff(); await page.click('切到网页')
    assert.equal(page.button('正在切到网页…').disabled, true)
    assert.equal(page.desktopLink().getAttribute('aria-disabled'), 'true')
    assert.equal(page.doc.querySelector('[aria-label="会话控制权"]')!.getAttribute('aria-busy'), 'true')
    await act(async () => release!())
    assert.equal(page.states.get('project-a')!.owner, 'web')
    release = page.holdHandoff(); page.rejectHandoffOnce(503, '交接尚未确认'); await page.openDesktop()
    assert.equal(page.desktopLink().getAttribute('aria-disabled'), 'true')
    await act(async () => release!())
    assert.match(page.doc.querySelector('.desktop-control-handoff-feedback')!.textContent!, /尚未确认切到桌面/)
    await page.refresh()
    assert.ok(page.doc.querySelector('.desktop-control-handoff-feedback'), 'successful GET with unchanged owner cannot clear failure')
    page.states.get('project-a')!.owner = 'desktop'; await page.refresh()
    assert.equal(page.doc.querySelector('.desktop-control-handoff-feedback'), null)
    assert.equal(page.requests.filter(item => item.path.endsWith('/handoff')).length, 2)
  } finally { release?.(); await page.cleanup() }
})

test('disconnect disables sends and preserves project/thread drafts without automatic retry', async () => {
  const page = await environment({ owner: 'web' })
  try {
    await page.type('未确认消息'); page.failOnce(); await page.click('发送给 Codex')
    assert.match(page.doc.body.textContent!, /不会自动重发/)
    assert.equal(page.requests.filter(item => item.path.endsWith('/send')).length, 1)
    await page.click('核对发送状态')
    assert.equal(page.requests.filter(item => item.path.endsWith('/send')).length, 1)
    assert.equal(page.button('发送给 Codex').disabled, true)
    const saved = JSON.parse(localStorage.getItem(desktopControlDraftKey('project-a', 'official-thread-a'))!); assert.equal(saved.text, '未确认消息'); assert.ok(saved.pending.id)
    await page.switchProject('project-b'); assert.equal(page.doc.querySelector<HTMLTextAreaElement>('textarea')!.value, '')
    await page.type('乙草稿'); await page.switchProject('project-a'); assert.equal(page.doc.querySelector<HTMLTextAreaElement>('textarea')!.value, '未确认消息')
    const state = page.states.get('project-a')!; state.messages.push({ id: saved.pending.id, role: 'user', content: saved.pending.text, createdAt: 3, delivery: 'sent' }); await page.refresh()
    assert.equal(page.doc.querySelector<HTMLTextAreaElement>('textarea')!.value, '')
    state.connected = false; await page.refresh(); assert.equal(page.button('发送给 Codex').disabled, true); assert.match(page.doc.body.textContent!, /原项目.*(?:对话.*草稿|关联).*保留/)
    page.assertOtherDrafts()
  } finally { await page.cleanup() }
})

test('backend outage recovers through read-only polling without losing thread, history or draft', async () => {
  const page = await environment({ owner: 'web', messages: [{ id: 'prior-reply', role: 'assistant', content: '已保存的解释', createdAt: 1 }] })
  try {
    await page.type('还没发送的新问题'); page.setBackendOffline(true); await page.refresh()
    assert.match(page.doc.querySelector('.desktop-control-status')!.textContent!, /本机工作台后台未连接/)
    assert.match(page.doc.querySelector('.desktop-control-retry')!.textContent!, /已尝试 1 次.*秒后再试/)
    assert.match(page.doc.querySelector('.desktop-control-reconnect-result')!.textContent!, /重新连接失败/)
    assert.match(page.doc.body.textContent!, /run-workbench\.cmd/)
    assert.doesNotMatch(page.doc.body.textContent!, /Failed to fetch|首次接入需通过共享启动器/)
    assert.match(page.doc.querySelector('.desktop-control-messages')!.textContent!, /已保存的解释/)
    assert.equal(page.button('发送给 Codex').disabled, true)
    assert.equal(page.desktopLink().getAttribute('aria-disabled'), 'true')
    const draftKey = desktopControlDraftKey('project-a', 'official-thread-a')
    assert.equal(JSON.parse(localStorage.getItem(draftKey)!).text, '还没发送的新问题')
    page.setBackendOffline(false)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1900)) })
    assert.match(page.doc.querySelector('.desktop-control-status')!.textContent!, /网页控制中/)
    assert.equal(page.button('发送给 Codex').disabled, false)
    assert.equal(page.doc.querySelector<HTMLTextAreaElement>('textarea')!.value, '还没发送的新问题')
    assert.equal(page.states.get('project-a')!.threadId, 'official-thread-a')
    assert.equal(page.requests.filter(request=>request.path.endsWith('/reconnect')).length,1,'only the explicitly clicked repair request is submitted')
    assert.ok(page.requests.filter(request=>!request.path.endsWith('/reconnect')).every(request => request.body === undefined), 'automatic recovery must not bind, handoff or resend')
    page.assertOtherDrafts()
  } finally { await page.cleanup() }
})

test('manual reconnect checks the bound chat and canvas and shows a confirmed result',async()=>{
  const page=await environment({owner:'web'})
  try{
    await page.type('连接完成后继续')
    const before=page.requests.length
    await page.click('重新连接桌面共享')
    assert.equal(page.requests.length,before+1)
    assert.deepEqual(page.requests.slice(before).map(request=>request.body),[{projectId:'project-a',title:page.initial.title}])
    assert.match(page.doc.querySelector('.desktop-control-reconnect-result')!.textContent!,/重新连接完成.*项目对话已连接.*当前画布已同步/)
    assert.equal(page.button('发送给 Codex').disabled,false)
  }finally{await page.cleanup()}
})

test('successful reconnect stops elapsed timers and timestamp-only idle polls do not commit a React render',async()=>{
  const page=await environment({owner:'web'})
  try{
    await page.click('重新连接桌面共享')
    assert.match(page.doc.querySelector('.desktop-control-reconnect-result')!.textContent!,/重新连接完成/)
    const commits=page.renderCommits,reads=page.requests.length
    page.states.get('project-a')!.updatedAt=999
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,3900))})
    assert.ok(page.requests.length>reads,'read-only synchronization remains active')
    assert.equal(page.renderCommits,commits,'no state or clock updates when only last-poll timestamp changes')
    page.states.get('project-a')!.messages.push({id:'new-desktop-message',role:'assistant',content:'Meaningful external change',createdAt:2})
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1900))})
    assert.match(page.doc.querySelector('.desktop-control-messages')!.textContent!,/Meaningful external change/)
  }finally{await page.cleanup()}
})

test('reachable backend without a broker is distinguished from a workbench service outage', async () => {
  const page = await environment({ connected: false, ready: false, desktopConnected: false, error: '等待共享启动器' })
  try {
    assert.match(page.doc.querySelector('.desktop-control-status')!.textContent!, /桌面连接未就绪/)
    assert.match(page.doc.querySelector('.desktop-control-setup')!.textContent!, /检查并修复共享入口/)
    assert.doesNotMatch(page.doc.body.textContent!, /工作台后台未连接/)
    assert.equal(page.button('发送给 Codex').disabled, true)
  } finally { await page.cleanup() }
})

test('an unbound project offers named creation and migrates only its unbound draft', async () => {
  const page = await environment({ threadId: null, owner: null })
  try {
    assert.match(page.doc.querySelector('.desktop-control-status')!.textContent!, /桌面已连接 · 正在创建项目对话/)
    assert.equal(page.doc.querySelector<HTMLDetailsElement>('.desktop-control-details')!.open, false)
    assert.ok(page.button('新建并连接项目对话'))
    await page.type('连接前草稿'); await page.click('新建并连接项目对话')
    const request = page.requests.find(item => item.path.endsWith('/reconnect'))!
    assert.deepEqual(request.body, { projectId: 'project-a', title: page.initial.title })
    assert.equal(page.doc.querySelector<HTMLTextAreaElement>('textarea')!.value, '连接前草稿')
    assert.equal(page.button('发送给 Codex').disabled, false)
    page.assertOtherDrafts()
  } finally { await page.cleanup() }
})

test('a new project shows a visible create action, preserves its draft and hands control to the web', async () => {
  const page = await environment({ threadId: null, owner: null })
  try {
    assert.equal(page.doc.querySelector<HTMLDetailsElement>('.desktop-control-details')!.open, false)
    await page.type('帮我生成一个 RC 滤波电路')
    await page.click('新建并连接项目对话')
    assert.equal(page.requests.filter(item => item.path.endsWith('/reconnect')).length, 1)
    assert.equal(page.requests.filter(item => item.path.endsWith('/bind')).length, 0)
    assert.match(page.doc.querySelector('.desktop-control-status')!.textContent!, /网页控制中/)
    assert.equal(page.desktopLink().getAttribute('href'), 'codex://threads/new-official-thread-project-a')
    assert.equal(page.doc.querySelector<HTMLTextAreaElement>('textarea')!.value, '帮我生成一个 RC 滤波电路')
    await page.click('发送给 Codex')
    assert.equal(page.states.get('project-a')!.messages[0].content, '帮我生成一个 RC 滤波电路')
  } finally { await page.cleanup() }
})

test('each newly selected project opens its own chat and returning reuses it', async () => {
  const page = await environment({ threadId: null, owner: null })
  try {
    const second = page.states.get('project-b')!
    second.threadId = null; second.owner = null
    await page.click('新建并连接项目对话')
    const firstLink = page.desktopLink().getAttribute('href')
    await page.switchProject('project-b')
    await page.click('新建并连接项目对话')
    const secondLink = page.desktopLink().getAttribute('href')
    assert.notEqual(secondLink, firstLink)
    await page.switchProject('project-a')
    assert.equal(page.desktopLink().getAttribute('href'), firstLink)
    assert.deepEqual(page.requests.filter(item => item.path.endsWith('/reconnect')).map(item => item.body.projectId), ['project-a', 'project-b'])
  } finally { await page.cleanup() }
})

test('a bound project read failure names the project problem and keeps its thread', async () => {
  const page = await environment({ connected: false, ready: false, desktopConnected: true, error: '官方对话暂时无法读取' })
  try {
    assert.match(page.doc.querySelector('.desktop-control-status')!.textContent!, /项目对话暂不可用/)
    assert.equal(page.doc.querySelector<HTMLDetailsElement>('.desktop-control-setup')!.open, false)
    assert.match(page.doc.querySelector('.desktop-control-setup')!.textContent!, /官方对话暂时无法读取/)
    assert.equal(page.states.get('project-a')!.threadId, 'official-thread-a')
    assert.equal(page.button('发送给 Codex').disabled, true)
  } finally { await page.cleanup() }
})

test('a definite pre-forward rejection returns to an editable draft without automatic resend', async () => {
  const page = await environment({ owner: 'web' })
  try {
    await page.type('未转发的消息'); page.rejectOnce(409); await page.click('发送给 Codex')
    const saved = JSON.parse(localStorage.getItem(desktopControlDraftKey('project-a', 'official-thread-a'))!)
    assert.equal(saved.text, '未转发的消息'); assert.equal(saved.pending, undefined)
    assert.equal(page.requests.filter(item => item.path.endsWith('/send')).length, 1)
    await page.refresh(); assert.equal(page.button('发送给 Codex').disabled, false)
    assert.equal(page.requests.filter(item => item.path.endsWith('/send')).length, 1)
  } finally { await page.cleanup() }
})

test('pending handoff keeps current web turn approvals and stop available while new sends stay blocked', async () => {
  const page = await environment({ owner: 'web', busy: true, pendingOwner: 'desktop', pendingApprovals: 1, approvals: [{ id: 'approval-a', method: 'item/commandExecution/requestApproval', title: '运行仿真命令', detail: 'ngspice', supported: true }] })
  try {
    assert.equal(page.button('发送给 Codex').disabled, true)
    assert.equal(page.button('允许本次').disabled, false)
    assert.equal(page.button('停止本轮').disabled, false)
    await page.click('允许本次'); await page.click('停止本轮')
    assert.equal(page.states.get('project-a')!.busy, false)
    assert.equal(page.states.get('project-a')!.pendingApprovals, 0)
  } finally { await page.cleanup() }
})

test('only confirmed web owner may answer supported requests, unsupported requests stay read-only', async () => {
  const page = await environment({ owner: 'web', pendingApprovals: 2, approvals: [
    { id: 'approval-a', method: 'item/commandExecution/requestApproval', title: '运行仿真命令', detail: 'ngspice', supported: true },
    { id: 'approval-b', method: 'future/requestApproval', title: '未来请求', detail: '未知协议', supported: false },
  ] })
  try {
    assert.equal(page.button('发送给 Codex').disabled, true)
    await page.click('允许本次'); assert.deepEqual(page.requests.find(item => item.path.endsWith('/approval'))?.body, { projectId: 'project-a', id: 'approval-a', decision: 'approve' })
    assert.match(page.doc.body.textContent!, /此请求尚不支持在网页回答/)
    assert.equal([...page.doc.querySelectorAll('button')].filter(item => item.textContent === '允许本次').length, 0)
  } finally { await page.cleanup() }
})

test('legacy approvals can be answered and extra permissions only expose deny', async () => {
  const page = await environment({ owner: 'web', busy: true, pendingApprovals: 3, approvals: [
    { id: 'legacy-exec', method: 'execCommandApproval', title: '旧命令审批', detail: 'ngspice', supported: true },
    { id: 'legacy-patch', method: 'applyPatchApproval', title: '旧文件审批', detail: 'patch', supported: true },
    { id: 'permissions', method: 'item/permissions/requestApproval', title: '额外权限', detail: 'permissions', supported: true },
  ] })
  try {
    await page.click('允许本次'); await page.click('允许本次')
    const card = page.doc.querySelector('[aria-label="额外权限"]')!
    assert.equal([...card.querySelectorAll('button')].some(item => /允许/.test(item.textContent ?? '')), false)
    await page.click('拒绝额外权限')
    assert.deepEqual(page.requests.filter(item => item.path.endsWith('/approval')).map(item => [item.body.id, item.body.decision]), [['legacy-exec', 'approve'], ['legacy-patch', 'approve'], ['permissions', 'deny']])
  } finally { await page.cleanup() }
})

test('questions and unsupported requests offer interrupt instead of invalid answers or impossible desktop handoff', async () => {
  for (const method of ['item/tool/requestUserInput', 'future/unknownApproval']) {
    const page = await environment({ owner: 'web', busy: true, pendingApprovals: 1, approvals: [{ id: 'question', method, title: '等待回答', detail: '', supported: method.endsWith('requestUserInput'), ...(method.endsWith('requestUserInput') ? { questions: [{ id: 'q', question: '元件参数？' }] } : {}) }] })
    try {
      const card = page.doc.querySelector('[aria-label="等待回答"]')!
      assert.equal([...card.querySelectorAll('button')].some(item => item.textContent === '拒绝'), false)
      assert.doesNotMatch(card.textContent!, /请在 Codex 桌面处理/)
      await page.click('停止本轮')
      assert.equal(page.requests.filter(item => item.path.endsWith('/cancel')).length, 1)
      assert.equal(page.requests.filter(item => item.path.endsWith('/approval')).length, 0)
    } finally { await page.cleanup() }
  }
})

test('candidate preview applies, undoes, reapplies and blocks overwriting manual edits', async () => {
  const page = await environment()
  try {
    const proposal = structuredClone(page.initial); proposal.drawing!.devices[0].x += 80
    const task: DesktopCircuitTask = { id: 'task-a', projectId: 'project-a', requestId: 'request-a', request: '重新整理', source: 'desktop', status: 'completed', baseline: structuredClone(page.initial), baselineRevision: 1, layoutOnly: true, events: [], result: { summary: '拉开间距', proposal: { project: proposal, summary: '拉开间距', changes: ['布局'], warnings: [], base: aiProjectFingerprint(page.initial) }, changed: true, simulation: null }, createdAt: '2026-09-25', updatedAt: '2026-09-25' }
    await page.addTask(task); assert.ok(page.doc.querySelector('[aria-label="候选原理图预览"]'))
    page.rejectApplyOnce(); await page.click('应用方案（可撤销）')
    assert.deepEqual(page.current,page.initial)
    assert.match(page.doc.body.textContent!,/未应用方案：P2/)
    assert.equal(page.doc.querySelector('.desktop-control-task')!.getAttribute('data-candidate-state'),'ready')
    assert.equal(page.button('应用方案（可撤销）').disabled,false)
    await page.click('应用方案（可撤销）'); assert.deepEqual(page.current, proposal)
    await page.click('撤销应用'); assert.deepEqual(page.current, page.initial)
    await page.click('再次应用方案'); assert.deepEqual(page.current, proposal)
    const manual = structuredClone(proposal); manual.drawing!.devices[1].x += 20; await page.external(manual)
    assert.equal(page.button('再次应用方案').disabled, true); assert.equal(page.button('撤销应用').disabled, true)
    assert.equal(page.requests.filter(item => item.path.endsWith('/send')).length, 0)
  } finally { await page.cleanup() }
})

test('busy candidate accepts redraw feedback, stops the old turn, and sends once from that candidate', async () => {
  const page = await environment({ owner: 'web', busy: true })
  try {
    const proposal = structuredClone(page.initial); proposal.drawing!.devices[0].x += 80
    const task: DesktopCircuitTask = { id: 'redraw-source', projectId: 'project-a', requestId: 'old-request', request: '画电路', source: 'desktop', status: 'completed', baseline: structuredClone(page.initial), baselineRevision: 1, layoutOnly: true, events: [], result: { summary: '候选已生成', proposal: { project: proposal, summary: '候选已生成', changes: ['布局'], warnings: [], base: aiProjectFingerprint(page.initial) }, changed: true, simulation: null }, createdAt: '2026-09-25', updatedAt: '2026-09-25' }
    await page.addTask(task)
    await page.click('重画')
    await act(async () => {
      const input = page.doc.querySelector<HTMLTextAreaElement>('[aria-label="重画要求"]')!
      Object.getOwnPropertyDescriptor(page.doc.defaultView!.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '把反馈回路移到上方，保留参数和连接')
      input.dispatchEvent(new page.doc.defaultView!.Event('input', { bubbles: true }))
    })
    assert.equal(page.button('停止当前回合并重画').disabled, false)
    assert.equal(page.requests.filter(request => request.path.endsWith('/send')).length, 0)
    await page.click('停止当前回合并重画')
    const sends = page.requests.filter(request => request.path.endsWith('/send'))
    assert.equal(page.requests.filter(request => request.path.endsWith('/cancel')).length, 1)
    assert.equal(sends.length, 1)
    assert.equal(sends[0].body.redrawTaskId, task.id)
    assert.match(sends[0].body.message, /把反馈回路移到上方/)
    assert.deepEqual(page.current, page.initial)
    await page.switchProject('project-b'); await page.switchProject('project-a')
    assert.equal(page.requests.filter(request => request.path.endsWith('/send')).length, 1, 'switching projects must not resubmit')
  } finally { await page.cleanup() }
})

test('discarded candidate stays hidden across project switches while preserving canvas and chat', async () => {
  const page = await environment({ owner: 'web', busy: true })
  try {
    const proposal = structuredClone(page.initial); proposal.drawing!.devices[0].x += 80
    const task: DesktopCircuitTask = { id: 'discard-source', projectId: 'project-a', requestId: 'old-request', request: '画电路', source: 'desktop', status: 'completed', baseline: structuredClone(page.initial), baselineRevision: 1, layoutOnly: true, events: [], result: { summary: '候选已生成', proposal: { project: proposal, summary: '候选已生成', changes: ['布局'], warnings: [], base: aiProjectFingerprint(page.initial) }, changed: true, simulation: null }, createdAt: '2026-09-25', updatedAt: '2026-09-25' }
    await page.addTask(task)
    await page.click('舍弃方案')
    assert.equal(page.doc.querySelector('.desktop-control-task')?.getAttribute('data-candidate-state'), 'discarded')
    assert.equal(page.doc.querySelector('[aria-label="候选原理图预览"]'), null)
    await page.switchProject('project-b'); await page.switchProject('project-a')
    assert.equal(page.doc.querySelector('.desktop-control-task')?.getAttribute('data-candidate-state'), 'discarded')
    assert.deepEqual(page.current, page.initial)
    assert.equal(page.requests.filter(request => request.path.endsWith('/cancel') || request.path.endsWith('/send')).length, 0)
    await page.click('恢复方案')
    assert.equal(page.doc.querySelector('.desktop-control-task')?.getAttribute('data-candidate-state'), 'ready')
    assert.ok(page.doc.querySelector('[aria-label="候选原理图预览"]'))
  } finally { await page.cleanup() }
})

test('desktop candidate merges later independent edits and undo restores the exact pre-merge canvas', async () => {
  const page = await environment()
  try {
    const proposal = structuredClone(page.initial)
    proposal.drawing!.devices.find(device => device.id === 'R1')!.value = '2k'
    const task: DesktopCircuitTask = { id: 'merge-task', projectId: 'project-a', requestId: 'merge-request', request: '调整 R1', source: 'desktop', status: 'completed', baseline: structuredClone(page.initial), baselineRevision: 1, layoutOnly: false, events: [], result: { summary: '将 R1 调整为 2k', proposal: { project: proposal, summary: '调整 R1', changes: ['R1=2k'], warnings: [], base: aiProjectFingerprint(page.initial) }, changed: true, simulation: null }, createdAt: '2026-09-25', updatedAt: '2026-09-25' }
    await page.addTask(task)
    const later = structuredClone(page.initial)
    later.title = '手动命名的电路'
    later.drawing!.devices.find(device => device.id === 'R1')!.x += 60
    await page.external(later)
    assert.equal(page.doc.querySelector('.desktop-control-task')!.getAttribute('data-candidate-state'), 'mergeable')
    assert.match(page.doc.querySelector('.desktop-control-task')!.textContent!, /上方预览已包含这些编辑/)
    assert.match(page.doc.querySelector('.agent-proposal-heading')!.textContent!, /合并后原理图/)
    await page.click('合并方案到当前画布')
    assert.equal(page.current.title, later.title)
    assert.equal(page.current.drawing!.devices.find(device => device.id === 'R1')!.x, later.drawing!.devices.find(device => device.id === 'R1')!.x)
    assert.equal(page.current.drawing!.devices.find(device => device.id === 'R1')!.value, '2k')
    assert.equal(page.doc.querySelector('.desktop-control-task')!.getAttribute('data-candidate-state'), 'applied')
    await page.switchProject('project-b'); await page.switchProject('project-a')
    assert.equal(page.doc.querySelector('.desktop-control-task')!.getAttribute('data-candidate-state'), 'applied', 'application snapshot survives project switching')
    await page.click('撤销应用'); assert.deepEqual(page.current, later)
    assert.equal(page.doc.querySelector('.desktop-control-task')!.getAttribute('data-candidate-state'), 'mergeable')
    await page.click('合并方案到当前画布')
    const edited = structuredClone(page.current); edited.drawing!.devices.find(device => device.id === 'R1')!.y += 40
    await page.external(edited)
    assert.equal(page.doc.querySelector('.desktop-control-task')!.getAttribute('data-candidate-state'), 'already-present')
    assert.equal(page.button('撤销应用').disabled, true, 'later edits cannot be erased by a stale undo')
    assert.deepEqual(page.current, edited)
  } finally { await page.cleanup() }
})

test('conflicted candidate previews a safe choice, keeps independent edits, and restores the exact pre-application canvas', async () => {
  const page = await environment()
  try {
    const proposal = structuredClone(page.initial), later = structuredClone(page.initial)
    proposal.drawing!.devices.find(device => device.id === 'R1')!.value = '2k'
    later.drawing!.devices.find(device => device.id === 'R1')!.value = '3k'
    later.title = '手动取名'
    later.drawing!.devices.find(device => device.id === 'R1')!.x += 40
    const task: DesktopCircuitTask = { id: 'conflict-task', projectId: 'project-a', requestId: 'conflict-request', request: '调整 R1', source: 'desktop', status: 'completed', baseline: structuredClone(page.initial), baselineRevision: 1, layoutOnly: false, events: [], result: { summary: '将 R1 调整为 2k', proposal: { project: proposal, summary: '调整 R1', changes: ['R1=2k'], warnings: [], base: aiProjectFingerprint(page.initial) }, changed: true, simulation: null }, createdAt: '2026-09-25', updatedAt: '2026-09-25' }
    await page.addTask(task); await page.external(later)
    assert.equal(page.doc.querySelector('.desktop-control-task')!.getAttribute('data-candidate-state'), 'conflict')
    assert.match(page.doc.querySelector('.desktop-control-task')!.textContent!, /devices\[R1\]\.value/)
    assert.equal([...page.doc.querySelectorAll('button')].some(button => button.textContent?.trim() === '应用方案（可撤销）'), false, 'conflicts show actionable choices instead of a disabled apply button')
    assert.deepEqual(page.current, later)
    await page.click('保留其他手动改动并应用')
    assert.deepEqual(page.current, later, 'selecting a resolution must not mutate the canvas')
    assert.match(page.doc.querySelector('.agent-proposal-heading')!.textContent!, /应用后原理图/)
    await page.click('确认保留其他改动并应用')
    assert.equal(page.current.title, later.title)
    assert.equal(page.current.drawing!.devices.find(device => device.id === 'R1')!.x, later.drawing!.devices.find(device => device.id === 'R1')!.x)
    assert.equal(page.current.drawing!.devices.find(device => device.id === 'R1')!.value, '2k')
    await page.click('撤销应用')
    assert.deepEqual(page.current, later)
  } finally { await page.cleanup() }
})

test('conflicted candidate can restore its starting canvas and apply after explicit preview and confirmation', async () => {
  const page = await environment()
  try {
    const proposal = structuredClone(page.initial), later = structuredClone(page.initial)
    proposal.drawing!.devices.find(device => device.id === 'R1')!.value = '2k'
    later.drawing!.devices.find(device => device.id === 'R1')!.value = '3k'
    later.title = '后来修改的标题'
    const task: DesktopCircuitTask = { id: 'restore-task', projectId: 'project-a', requestId: 'restore-request', request: '调整 R1', source: 'desktop', status: 'completed', baseline: structuredClone(page.initial), baselineRevision: 1, layoutOnly: false, events: [], result: { summary: '将 R1 调整为 2k', proposal: { project: proposal, summary: '调整 R1', changes: ['R1=2k'], warnings: [], base: aiProjectFingerprint(page.initial) }, changed: true, simulation: null }, createdAt: '2026-09-25', updatedAt: '2026-09-25' }
    await page.addTask(task); await page.external(later)
    await page.click('恢复到方案起点并应用')
    assert.deepEqual(page.current, later)
    assert.match(page.doc.querySelector('.agent-proposal-heading')!.textContent!, /应用后原理图/)
    assert.match(page.doc.querySelector('[aria-label="确认冲突处理方式"]')!.textContent!, /移除方案生成以后/)
    await page.click('确认恢复起点并应用')
    assert.deepEqual(page.current, proposal)
    await page.click('撤销应用')
    assert.deepEqual(page.current, later)
  } finally { await page.cleanup() }
})
