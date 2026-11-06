import { listenOnSafeTestPort } from './helpers/safe-test-port'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopControlManager, type DesktopControlBroker } from '../server/desktop-control-manager'
import { createDesktopControlMiddleware } from '../server/desktop-control-middleware'
import { DesktopCircuitManager } from '../server/desktop-circuit-manager'
import { DesktopConversationFolder } from '../server/desktop-conversation-folder'
import { editorTemplate } from '../src/core/editor'

const threadId = '01a0d69a-8f55-71e1-a62c-1989712a3778'
const sessionId = 'f95b3f97-f6fb-40bf-8f40-b6b7dc94cbeb'
const nextThreadId = '01a0d69a-8f55-71e1-a62c-1989712a3779'
const anotherThreadId = '01a0d69a-8f55-71e1-a62c-1989712a3780'
class Broker implements DesktopControlBroker {
  control = { connected: true, ready: true, desktopConnected: true, owner: 'desktop', busy: false, pendingOwner: null as string | null, pendingApprovals: 0, loaded: true }
  calls: { method: string; params: any }[] = []
  turns: any[] = []; responses: any[] = []; registrations: any[] = []
  listener: ((event: any) => void) | undefined
  lostAck = false; persistLost = false; offline = false
  emptyTurnsUnsupported = false
  orphanedThreadId?: string
  resumeError?: Error
  readError?: Error
  startError?: Error
  resumeThreadId?: string
  handoffs = 0; starts = 0
  async connect() { if (this.offline) throw new Error('private-token/path must not be exposed') }
  async call(method: string, params: any) {
    this.calls.push({ method, params })
    if (this.offline) throw new Error('private-token/path must not be exposed')
    if (method === 'thread/read') { if (this.readError) throw this.readError; return { thread: { id: params.threadId, ephemeral: false, ...(this.emptyTurnsUnsupported && params.threadId === nextThreadId ? { status: { type: 'idle' }, threadSource: null, preview: '', turns: [] } : {}), ...(this.orphanedThreadId === params.threadId ? { status: { type: 'notLoaded' }, threadSource: null, preview: '', turns: [] } : {}) } } }
    if (method === 'thread/resume') { assert.deepEqual(params, { threadId: params.threadId }); if (this.resumeError) throw this.resumeError; this.control.loaded = true; return { thread: { id: this.resumeThreadId ?? params.threadId, ephemeral: false } } }
    if (method === 'thread/start') {
      if (this.startError) { const error = this.startError; this.startError = undefined; throw error }
      return { thread: { id: ++this.starts === 1 ? nextThreadId : this.starts === 2 ? anotherThreadId : randomUUID(), ephemeral: false } }
    }
    if (method === 'thread/name/set') return {}
    if (method === 'thread/turns/list') { if (this.emptyTurnsUnsupported && params.threadId === nextThreadId) throw Object.assign(new Error('list_turns is not supported yet'), { code: -32601 }); if (this.orphanedThreadId === params.threadId) throw Object.assign(new Error(`invalid paginated history lineage for ${params.threadId}: missing source rollout`), { code: -32600 }); return { data: [...this.turns].reverse(), nextCursor: null } }
    if (method === 'turn/start') {
      const turn = { id: `turn-${this.turns.length}`, status: 'inProgress', startedAt: Date.now() / 1000, items: [{ id: `user-${this.turns.length}`, type: 'userMessage', content: params.input }] }
      if (!this.lostAck || this.persistLost) this.turns.push(turn)
      if (this.lostAck) throw new Error('lost response')
      this.control.busy = true; return { turn }
    }
    if (method === 'turn/interrupt') { const turn = this.turns.find(t => t.id === params.turnId); if (turn) turn.status = 'interrupted'; this.control.busy = false; return {} }
    throw new Error(`unsupported ${method}`)
  }
  async status() { if (this.offline) throw new Error('offline'); return this.control }
  async handoff(_threadId: string, owner: 'desktop' | 'web') { this.handoffs++; if (this.control.busy || this.control.pendingApprovals) this.control.pendingOwner = owner; else { this.control.owner = owner; this.control.pendingOwner = null }; return this.control }
  listen(listener: (event: any) => void) { this.listener = listener; return () => { this.listener = undefined } }
  async respond(id: string | number, response: any) { this.responses.push({ id, response }); this.control.pendingApprovals = 0 }
  async registerTools(id: string, names: string[]) { this.registrations.push({ id, names }); return {} }
  async close() {}
  emit(event: any) { this.listener?.(event) }
}
async function fixture(legacy = true, circuits = false) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-control-test-')), broker = new Broker()
  const legacyDirectory = join(directory, '.codex-sessions')
  if (legacy) {
    await mkdir(join(legacyDirectory, sessionId), { recursive: true })
    await writeFile(join(legacyDirectory, 'project-bindings.json'), JSON.stringify({ 'project-a': sessionId }))
    await writeFile(join(legacyDirectory, sessionId, 'session.json'), JSON.stringify({ id: sessionId, threadId, workbench: { projectId: 'project-a' } }))
  }
  const circuitManager = circuits ? new DesktopCircuitManager({ directory: join(directory, '.desktop-circuit'), projectDirectory: directory }) : undefined
  if (circuitManager) await circuitManager.sync({ projectId: 'project-a', project: editorTemplate('rc-lowpass'), expectedRevision: null })
  const options = { directory: join(directory, '.desktop-control'), projectDirectory: directory, legacyDirectory, brokerFactory: () => broker, circuitManager }
  const manager = new DesktopControlManager(options)
  return { directory, broker, manager, options, circuitManager, async close() { await manager.close(); await circuitManager?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }) } }
}

test('explanation child keeps a separate persistent thread and sends the current circuit snapshot without writing tools', async () => {
  const f = await fixture(false, true)
  const explanation = new DesktopControlManager({ ...f.options, directory: join(f.directory, '.desktop-control', 'explanation'), explanationOnly: true })
  try {
    const drawing = await f.manager.ensure('project-a', '低边开关')
    const child = await explanation.ensure('project-a', '低边开关')
    assert.ok(child.threadId)
    assert.notEqual(child.threadId, drawing.threadId)
    assert.equal(f.broker.calls.filter(call => call.method === 'thread/start').length, 2)
    assert.deepEqual(f.broker.calls.filter(call => call.method === 'thread/name/set').map(call => call.params.name), ['电路：低边开关', '电路解释：低边开关'])
    assert.equal(f.broker.registrations.some(item => item.id === child.threadId), false)
    await explanation.send('project-a', '负载电流从哪里流过？', 'explain-request-1')
    const sent = [...f.broker.calls].reverse().find(call => call.method === 'turn/start')!
    assert.equal(sent.params.threadId, child.threadId)
    assert.match(sent.params.input[0].text, /当前项目快照/)
    assert.match(sent.params.input[0].text, /负载电流从哪里流过/)
    assert.match(sent.params.input[0].text, /不修改电路/)
    const restored = new DesktopControlManager({ ...f.options, directory: join(f.directory, '.desktop-control', 'explanation'), explanationOnly: true })
    assert.equal((await restored.state('project-a')).threadId, child.threadId)
    await restored.close()
  } finally { await explanation.close(); await f.close() }
})

test('an empty Codex thread stub without a rollout is replaced after restart while its ID stays in recovery history', async () => {
  const f = await fixture(false)
  const directory = join(f.directory, '.desktop-control', 'explanation')
  const explanation = new DesktopControlManager({ ...f.options, directory, explanationOnly: true })
  try {
    const first = await explanation.ensure('project-a', '低边开关')
    assert.equal(first.threadId, nextThreadId)
    await explanation.close()
    f.broker.orphanedThreadId = nextThreadId
    f.broker.control.owner = 'desktop'; f.broker.control.loaded = false
    const reopened = new DesktopControlManager({ ...f.options, directory, explanationOnly: true })
    try {
      const unbound = await reopened.state('project-a')
      assert.equal(unbound.threadId, null)
      assert.equal(unbound.connected, true)
      assert.equal(f.broker.starts, 1, 'status polling must not create conversations')
      const repaired = await reopened.ensure('project-a', '低边开关')
      assert.equal(repaired.threadId, anotherThreadId)
      assert.equal(repaired.owner, 'web')
      assert.equal(f.broker.starts, 2)
      assert.equal((await reopened.ensure('project-a', '低边开关')).threadId, anotherThreadId)
      assert.equal(f.broker.starts, 2, 'repeated ensure must not create another conversation')
      const saved = JSON.parse(await readFile(join(directory, 'bindings.json'), 'utf8'))
      assert.equal(saved.bindings[0].history[0].threadId, nextThreadId)
      assert.equal(saved.bindings[0].threadId, anotherThreadId)
    } finally { await reopened.close() }
  } finally { await f.close() }
})

test('a missing rollout never replaces a conversation with a recorded user message', async () => {
  const f = await fixture(false, true)
  const directory = join(f.directory, '.desktop-control', 'explanation')
  const explanation = new DesktopControlManager({ ...f.options, directory, explanationOnly: true })
  try {
    await explanation.ensure('project-a', '低边开关')
    await explanation.send('project-a', '电流怎样流动？', 'request-1')
    f.broker.control.busy = false; f.broker.control.owner = 'desktop'; f.broker.control.loaded = false
    f.broker.orphanedThreadId = nextThreadId
    f.broker.resumeError = Object.assign(new Error('no rollout found for thread id'), { code: -32600 })
    const state = await explanation.state('project-a')
    assert.equal(state.threadId, nextThreadId)
    assert.equal(state.connected, false)
    assert.equal(f.broker.starts, 1)
    const saved = JSON.parse(await readFile(join(directory, 'bindings.json'), 'utf8'))
    assert.equal(saved.bindings[0].threadId, nextThreadId)
    assert.equal(saved.bindings[0].history, undefined)
  } finally { await explanation.close(); await f.close() }
})

test('empty stub recovery prunes only a verified empty history entry at the 100-entry limit', async () => {
  const f = await fixture(false)
  const directory = join(f.directory, '.desktop-control', 'explanation')
  const protectedId = randomUUID(), expiredId = randomUUID()
  const history = [
    { threadId: protectedId, receipts: [{ id: 'old-question', hash: 'a'.repeat(64), message: 'saved', delivery: 'sent', createdAt: 1 }] },
    { threadId: expiredId, receipts: [], emptyStub: true },
    ...Array.from({ length: 98 }, () => ({ threadId: randomUUID(), receipts: [], emptyStub: true })),
  ]
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'bindings.json'), JSON.stringify({ version: 1, bindings: [{ projectId: 'project-a', threadId: nextThreadId, receipts: [], history, cache: { messages: [] } }] }))
  f.broker.orphanedThreadId = nextThreadId
  const manager = new DesktopControlManager({ ...f.options, directory, explanationOnly: true })
  try {
    const state = await manager.state('project-a')
    assert.equal(state.threadId, null)
    const saved = JSON.parse(await readFile(join(directory, 'bindings.json'), 'utf8'))
    const kept = saved.bindings[0].history
    assert.equal(kept.length, 100)
    assert.equal(kept[0].threadId, protectedId)
    assert.equal(kept[0].receipts[0].message, 'saved')
    assert.equal(kept.some((entry: { threadId: string }) => entry.threadId === expiredId), false)
    assert.deepEqual(kept.at(-1), { threadId: nextThreadId, receipts: [], emptyStub: true })
  } finally { await manager.close(); await f.close() }
})

test('full history without a verified empty stub is kept intact', async () => {
  const f = await fixture(false)
  const directory = join(f.directory, '.desktop-control', 'explanation')
  const history = Array.from({ length: 100 }, () => ({ threadId: randomUUID(), receipts: [] }))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'bindings.json'), JSON.stringify({ version: 1, bindings: [{ projectId: 'project-a', threadId: nextThreadId, receipts: [], history, cache: { messages: [] } }] }))
  f.broker.orphanedThreadId = nextThreadId
  const manager = new DesktopControlManager({ ...f.options, directory, explanationOnly: true })
  try {
    const state = await manager.state('project-a')
    assert.equal(state.threadId, nextThreadId)
    assert.match(state.error!, /没有可安全清理的空对话/)
    const saved = JSON.parse(await readFile(join(directory, 'bindings.json'), 'utf8'))
    assert.deepEqual(saved.bindings[0].history, history)
    assert.equal(saved.bindings[0].threadId, nextThreadId)
  } finally { await manager.close(); await f.close() }
})

test('a project without a binding stays unbound until a fresh chat is ensured', async () => {
  const f = await fixture()
  try {
    const state = await f.manager.state('project-a')
    assert.equal(state.threadId, null)
    assert.equal(f.broker.calls.length, 0)
    const created = await f.manager.ensure('project-a')
    assert.equal(created.threadId, nextThreadId)
    assert.equal(created.owner, 'web', 'a newly created project chat is ready for the web composer')
    assert.notEqual(created.threadId, threadId, 'a legacy chat must not be silently reused')
    assert.equal((await f.manager.ensure('project-a')).threadId, nextThreadId)
    assert.equal(f.broker.calls.filter(c => c.method === 'thread/start').length, 1)
    assert.equal(f.broker.handoffs, 1, 'returning to the project does not seize its conversation again')
    await assert.rejects(f.manager.bind('project-a', { threadId: nextThreadId }), /未替换/)
    await assert.rejects(f.manager.bind('project-b', { threadId: nextThreadId }), /另一个项目/)
    const reopened = new DesktopControlManager(f.options)
    assert.equal((await reopened.state('project-a')).threadId, nextThreadId); await reopened.close()
  } finally { await f.close() }
})

test('a rejected thread/start can be retried, while an uncertain response cannot', async () => {
  const f = await fixture(false)
  try {
    f.broker.startError = Object.assign(new Error('Invalid request: unknown sandbox variant'), { code: -32600 })
    await assert.rejects(f.manager.ensure('project-rejected'), /unknown sandbox variant/)
    assert.equal((await f.manager.state('project-rejected')).threadId, null)
    assert.equal((await f.manager.ensure('project-rejected')).threadId, nextThreadId)
    assert.equal(f.broker.starts, 1)

    f.broker.startError = new Error('lost response')
    await assert.rejects(f.manager.ensure('project-uncertain'), /lost response/)
    await assert.rejects(f.manager.ensure('project-uncertain'), /尚未确认/)
    assert.equal(f.broker.calls.filter(call => call.method === 'thread/start').length, 3)
  } finally { await f.close() }
})

test('a legacy invalid-request marker releases the project on service restart', async () => {
  const f = await fixture(false)
  try {
    await mkdir(f.options.directory, { recursive: true })
    await writeFile(join(f.options.directory, 'bindings.json'), JSON.stringify({ version: 1, bindings: [{
      projectId: 'project-rejected', threadId: null, creating: true, receipts: [],
      cache: { error: '官方 Codex 未能处理会话请求（错误码 -32600）；请在桌面查看该对话的错误详情，原项目和对话关联已保留。' },
    }] }))
    const reopened = new DesktopControlManager(f.options)
    try {
      assert.equal((await reopened.ensure('project-rejected')).threadId, nextThreadId)
      assert.equal(f.broker.starts, 1)
    } finally { await reopened.close() }
  } finally { await f.close() }
})

test('after a service restart the saved web owner resumes the same unloaded chat and restores web control', async () => {
  const f = await fixture(false)
  try {
    const original = await f.manager.ensure('project-a', '低通电路')
    assert.equal(original.owner, 'web')
    f.broker.control.owner = 'desktop'; f.broker.control.loaded = false
    const reopened = new DesktopControlManager(f.options)
    try {
      const restored = await reopened.state('project-a')
      assert.equal(restored.threadId, original.threadId)
      assert.equal(restored.owner, 'web')
      assert.equal((await reopened.ensure('project-a', '低通电路')).threadId, original.threadId)
      assert.equal(f.broker.calls.filter(call => call.method === 'thread/start').length, 1)
      assert.deepEqual(f.broker.calls.filter(call => call.method === 'thread/resume').map(call => call.params), [{ threadId: original.threadId }])
      assert.equal(f.broker.handoffs, 2)
    } finally { await reopened.close() }
  } finally { await f.close() }
})

test('a live broker restart restores the saved web owner without creating or replacing its thread', async () => {
  const f = await fixture(false)
  try {
    const original = await f.manager.ensure('project-a')
    f.broker.control.owner = 'desktop'; f.broker.control.loaded = false
    const restored = await f.manager.state('project-a')
    assert.equal(restored.owner, 'web')
    assert.equal(restored.threadId, original.threadId)
    assert.equal(f.broker.handoffs, 2)
    assert.equal(f.broker.calls.filter(call => call.method === 'thread/start').length, 1)
  } finally { await f.close() }
})

test('project chats use the circuit title and keep the same thread when renamed', async () => {
  const f = await fixture(false)
  try {
    const first = await f.manager.ensure('project-a', '  RC 低通  ')
    assert.equal(first.threadId, nextThreadId)
    assert.deepEqual(f.broker.calls.filter(call => call.method === 'thread/name/set').map(call => call.params), [{ threadId: nextThreadId, name: '电路：RC 低通' }])
    const renamed = await f.manager.ensure('project-a', '有源低通滤波器')
    assert.equal(renamed.threadId, nextThreadId)
    assert.equal(f.broker.starts, 1)
    assert.deepEqual(f.broker.calls.filter(call => call.method === 'thread/name/set').at(-1)?.params, { threadId: nextThreadId, name: '电路：有源低通滤波器' })
    await assert.rejects(f.manager.ensure('project-b', 'x'.repeat(81)), /标题格式/)
    assert.equal(f.broker.starts, 1, 'invalid titles cannot create a chat')
  } finally { await f.close() }
})

test('offline desktop delays automatic creation without claiming a legacy chat', async () => {
  const f = await fixture()
  try {
    f.broker.offline = true
    const state = await f.manager.state('project-a')
    assert.equal(state.threadId, null); assert.equal(state.connected, false)
    assert.equal(state.ready, false); assert.deepEqual(state.messages, [])
    assert.ok(state.error)
    await assert.rejects(f.manager.ensure('project-a'))
    f.broker.offline = false
    assert.equal((await f.manager.ensure('project-a')).threadId, nextThreadId)
    assert.equal(f.broker.calls.filter(call => call.method === 'thread/start').length, 1)
  } finally { await f.close() }
})

test('auto creation waits for desktop readiness without leaving an uncertain binding', async () => {
  const f = await fixture(false)
  try {
    f.broker.control.desktopConnected = false
    await assert.rejects(f.manager.ensure('project-a'), /连接恢复后/)
    assert.equal(f.broker.starts, 0)
    assert.equal((await f.manager.state('project-a')).threadId, null)
    f.broker.control.desktopConnected = true
    assert.equal((await f.manager.ensure('project-a')).threadId, nextThreadId)
    assert.equal(f.broker.starts, 1)
  } finally { await f.close() }
})

test('thread read failure keeps the desktop connection visible without claiming the project is ready', async () => {
  const f = await fixture()
  try {
    await f.manager.bind('project-a')
    f.broker.readError = Object.assign(new Error('thread read failed'), { code: -32603 })
    const state = await f.manager.state('project-a')
    assert.equal(state.threadId, threadId)
    assert.equal(state.connected, false)
    assert.equal(state.ready, false)
    assert.equal(state.desktopConnected, true)
    assert.match(state.error!, /官方 Codex 未能处理会话请求/)
    f.broker.readError = undefined
    assert.equal((await f.manager.state('project-a')).connected, true)
  } finally { await f.close() }
})

test('handoff waits for active turns and approvals; disconnected desktop cannot report successful transfer', async () => {
  const f = await fixture()
  try {
    await f.manager.bind('project-a'); f.broker.control.busy = true
    const waiting = await f.manager.handoff('project-a', 'web')
    assert.equal(waiting.owner, 'desktop'); assert.equal(waiting.pendingOwner, 'web')
    await assert.rejects(f.manager.send('project-a', 'do work', 'request-1'), /尚未完成交接/)
    f.broker.control.busy = false; f.broker.control.pendingApprovals = 1
    assert.equal((await f.manager.handoff('project-a', 'web')).owner, 'desktop')
    f.broker.control.desktopConnected = false
    await assert.rejects(f.manager.handoff('project-a', 'web'), /官方桌面尚未连接/)
    f.broker.offline = true
    const offline = await f.manager.state('project-a')
    assert.equal(offline.connected, false); assert.doesNotMatch(offline.error!, /private-token/)
  } finally { await f.close() }
})

test('HTTP handoff distinguishes archived/native resume failures from disconnect and retains original thread and owner', async () => {
  const f = await fixture(), middleware = createDesktopControlMiddleware({ ...f.options, manager: f.manager })
  const server = createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end() }) })
  await listenOnSafeTestPort(server)
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`
  const headers = { 'X-Fuxian-Desktop-Control': '1', 'Content-Type': 'application/json', Origin: origin }
  const handoff = () => fetch(`${origin}/api/desktop-control/handoff`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'project-a', owner: 'web' }) })
  try {
    await f.manager.bind('project-a')
    f.broker.control.loaded = false
    f.broker.resumeError = Object.assign(new Error(`session ${threadId} is archived. Run \`codex unarchive ${threadId}\` to unarchive it first.`), { code: -32600 })
    const archived = await handoff(), archivedBody = await archived.json() as {error: string}
    assert.equal(archived.status, 409); assert.match(archivedBody.error, /对话已归档.*Codex 恢复/)
    assert.doesNotMatch(archivedBody.error, /未就绪|已断开/)
    assert.equal(f.broker.handoffs, 0)
    const unchanged = await f.manager.state('project-a')
    assert.equal(unchanged.threadId, threadId); assert.equal(unchanged.owner, 'desktop')
    assert.equal(unchanged.connected, true); assert.equal(unchanged.ready, true)
    assert.equal(f.broker.calls.some(call => call.method === 'thread/start'), false)

    f.broker.resumeError = Object.assign(new Error('Internal native error at http://secret-provider.test/v1 token=private-token C:/secret/config'), { code: -32603 })
    const failed = await handoff(), failedBody = await failed.json() as {error: string}
    assert.equal(failed.status, 502); assert.match(failedBody.error, /恢复当前项目的原对话.*-32603/)
    assert.doesNotMatch(failedBody.error, /secret-provider|private-token|C:\/secret|已断开/)
    assert.equal(f.broker.handoffs, 0)

    f.broker.resumeError = undefined
    f.broker.resumeThreadId = nextThreadId
    assert.equal((await handoff()).status, 409, 'a different resumed thread must not grant control')
    assert.equal(f.broker.handoffs, 0)
    f.broker.resumeThreadId = undefined; f.broker.control.loaded = false
    const restored = await handoff(), restoredBody = await restored.json() as {threadId: string; owner: string}
    assert.equal(restored.status, 200); assert.equal(restoredBody.threadId, threadId); assert.equal(restoredBody.owner, 'web')
    assert.equal(f.broker.handoffs, 1)
    for (const call of f.broker.calls.filter(call => call.method === 'thread/resume')) assert.deepEqual(call.params, { threadId })
    assert.equal(f.broker.calls.some(call => call.method === 'thread/start'), false)
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await f.close() }
})

test('bind reports archived source thread without replacing the saved association', async () => {
  const f = await fixture()
  try {
    f.broker.resumeError = Object.assign(new Error(`session ${threadId} is archived`), { code: -32600 })
    await assert.rejects(f.manager.bind('project-a'), { status: 409, message: /已归档/ })
    const reopened = new DesktopControlManager(f.options)
    try { assert.equal((await reopened.state('project-a')).threadId, threadId) } finally { await reopened.close() }
    assert.equal(f.broker.calls.some(call => call.method === 'thread/start'), false)
  } finally { await f.close() }
})

test('same request survives lost response/restart without retry; native turn context identifies accepted lost acknowledgement', async () => {
  const f = await fixture()
  try {
    await f.manager.bind('project-a'); await f.manager.handoff('project-a', 'web')
    f.broker.lostAck = true
    const pending = await f.manager.send('project-a', '请解释电路', 'request-1')
    assert.equal(pending.messages[0].delivery, 'unknown')
    const reopened = new DesktopControlManager(f.options)
    assert.equal((await reopened.send('project-a', '请解释电路', 'request-1')).messages[0].delivery, 'unknown')
    assert.equal(f.broker.calls.filter(c => c.method === 'turn/start').length, 1)
    await assert.rejects(reopened.send('project-a', '不同问题', 'request-1'), /不同消息/)
    f.broker.persistLost = true
    const accepted = await reopened.send('project-a', '另一个问题', 'request-2')
    assert.equal(accepted.messages.find(m => m.id === 'request-2')?.delivery, 'sent')
    const payload = f.broker.calls.find(c => c.method === 'turn/start')!.params
    assert.equal(payload.approvalPolicy, 'never')
    assert.deepEqual(payload.sandboxPolicy, { type: 'dangerFullAccess' })
    assert.match(payload.input[0].text, /desktop-circuit.mjs/)
    assert.match(payload.input[0].text, /旧会话的动态工具 schema 不会因重启或注册回调自动更新/)
    assert.match(payload.input[0].text, /activeTask 是本轮先前电路工具已返回的同一 taskId/)
    assert.match(payload.input[0].text, /call --task ID --name set_measurement_probes --input-file JSON_PATH/)
    assert.match(payload.input[0].text, /不手动 finish\/cancel/)
    assert.match(payload.input[0].text, /只有没有 activeTask 时才能.*创建本轮 CLI 任务/)
    await reopened.close()
  } finally { await f.close() }
})

test('explicit new thread uses full access and automatically accepts known approvals for its bound thread', async () => {
  const f = await fixture(false)
  try {
    await assert.rejects(f.manager.bind('project-new'), /尚未关联/)
    const state = await f.manager.bind('project-new', { create: true })
    assert.equal(state.threadId, nextThreadId)
    const creation = f.broker.calls.find(c => c.method === 'thread/start')!.params
    assert.deepEqual(creation, { cwd: await new DesktopConversationFolder(f.options.directory).effectiveDirectory('project-new'), ephemeral: false, approvalPolicy: 'never', sandbox: 'danger-full-access' })
    f.broker.control.pendingApprovals = 1
    f.broker.emit({ type: 'server-request', message: { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: nextThreadId, command: 'node scripts/desktop-circuit.mjs inspect' } } })
    await waitFor(() => f.broker.responses.length === 1)
    assert.deepEqual(f.broker.responses[0], { id: 'approval-1', response: { result: { decision: 'accept' } } })
    assert.equal((await f.manager.state('project-new')).approvals.length, 0)
    await assert.rejects(f.manager.approval('project-new', 'approval-1', 'approve'), /已经处理/)
    f.broker.emit({ type: 'server-request', message: { id: 'file', method: 'item/fileChange/requestApproval', params: { threadId: nextThreadId } } })
    f.broker.emit({ type: 'server-request', message: { id: 'patch', method: 'applyPatchApproval', params: { threadId: nextThreadId } } })
    await waitFor(() => f.broker.responses.length === 3)
    assert.deepEqual(f.broker.responses.slice(1).map(item => item.response.result), [{ decision: 'accept' }, { decision: 'approved' }])
    f.broker.emit({ type: 'server-request', message: { id: 'other-thread', method: 'item/fileChange/requestApproval', params: { threadId: anotherThreadId } } })
    assert.equal(f.broker.responses.length, 3, 'a request for an unbound thread is never auto-approved')
    f.broker.emit({ type: 'server-request', message: { id: 3, method: 'unknown/approval', params: { threadId: nextThreadId } } })
    await assert.rejects(f.manager.approval('project-new', '3', 'approve'), /尚未支持/)
  } finally { await f.close() }
})

test('HTTP ensure creates one titled conversation for a project and rejects multi-chat actions', async () => {
  const f = await fixture(), middleware = createDesktopControlMiddleware({ ...f.options, manager: f.manager })
  const server = createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end() }) })
  await listenOnSafeTestPort(server)
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const headers = { 'X-Fuxian-Desktop-Control': '1', 'Content-Type': 'application/json', Origin: origin }
  const post = (action: string, body: unknown) => fetch(`${origin}/api/desktop-control/${action}`, { method: 'POST', headers, body: JSON.stringify(body) })
  try {
    const created = await post('ensure', { projectId: 'project-a', title: '电阻电容低通' })
    assert.equal(created.status, 200)
    assert.equal((await created.json() as { threadId: string }).threadId, nextThreadId)
    const reused = await post('ensure', { projectId: 'project-a' })
    assert.equal(reused.status, 200)
    assert.equal((await reused.json() as { threadId: string }).threadId, nextThreadId)
    assert.equal(f.broker.calls.filter(call => call.method === 'thread/start').length, 1)
    assert.deepEqual(f.broker.calls.find(call => call.method === 'thread/name/set')?.params, { threadId: nextThreadId, name: '电路：电阻电容低通' })
    const explanation = await post('explain/ensure', { projectId: 'project-a', title: '电阻电容低通' })
    assert.equal(explanation.status, 200)
    assert.equal((await explanation.json() as { threadId: string }).threadId, anotherThreadId)
    assert.equal(f.broker.calls.filter(call=>call.method==='thread/start')[0].params.cwd,f.broker.calls.filter(call=>call.method==='thread/start')[1].params.cwd,'main and explanation conversations share the project workspace')
    const explanationState = await fetch(`${origin}/api/desktop-control/explain/state?projectId=project-a`, { headers })
    assert.equal((await explanationState.json() as { threadId: string }).threadId, anotherThreadId)
    assert.equal((await post('new-thread', { projectId: 'project-a' })).status, 404)
    assert.equal((await post('switch-thread', { projectId: 'project-a', threadId })).status, 404)
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await f.close() }
})

test('conversation folder setting validates the path and groups only newly created chats', async () => {
  const f = await fixture(false), middleware = createDesktopControlMiddleware(f.options)
  const server = createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end() }) })
  await listenOnSafeTestPort(server)
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const url = `${origin}/api/desktop-control/conversation-folder`
  const headers = { 'X-Fuxian-Desktop-Control': '1', 'Content-Type': 'application/json', Origin: origin }
  const post = (action: string, body: unknown) => fetch(`${origin}/api/desktop-control/${action}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const sharedDirectory = join(f.directory, 'shared-circuit-chats')
  try {
    const folders=new DesktopConversationFolder(f.options.directory)
    assert.deepEqual(await (await fetch(url, { headers })).json(), { directory: null, defaultDirectory: folders.defaultDirectory })
    assert.equal((await post('ensure', { projectId: 'project-a', title: '旧电路' })).status, 200)
    const originalProjectDirectory=await folders.effectiveDirectory('project-a')
    assert.equal(f.broker.calls.find(call => call.method === 'thread/start')?.params.cwd, originalProjectDirectory)
    assert.equal((await post('conversation-folder', { directory: join(f.directory, 'missing') })).status, 400)
    assert.equal((await post('conversation-folder', { directory: 'relative/path' })).status, 400)
    await mkdir(sharedDirectory)
    const selected = await post('conversation-folder', { directory: sharedDirectory })
    assert.equal(selected.status, 200)
    assert.equal((await selected.json() as { directory: string }).directory, sharedDirectory)
    assert.equal((await (await fetch(url, { headers })).json() as { directory: string }).directory, sharedDirectory)
    assert.equal((await post('ensure', { projectId: 'project-a', title: '旧电路' })).status, 200)
    await rm(sharedDirectory, { recursive: true })
    assert.equal((await post('ensure', { projectId: 'project-b', title: '新电路' })).status, 400)
    assert.equal(f.broker.calls.filter(call => call.method === 'thread/start').length, 1)
    await mkdir(sharedDirectory)
    assert.equal((await post('explain/ensure', { projectId: 'project-a', title: '旧电路' })).status, 200)
    assert.deepEqual(f.broker.calls.filter(call => call.method === 'thread/start').map(call => call.params.cwd), [originalProjectDirectory, originalProjectDirectory],'an explanation for an existing project keeps its allocated directory after root changes')
    assert.equal((await post('ensure',{projectId:'project-b',title:'../../不是目录'})).status,200)
    assert.equal(f.broker.calls.filter(call=>call.method==='thread/start').at(-1)?.params.cwd,await folders.effectiveDirectory('project-b'))
    assert.equal(await folders.effectiveDirectory('project-b'),join(sharedDirectory,DesktopConversationFolder.projectFolderName('project-b')))
    assert.equal((await post('conversation-folder', { directory: null })).status, 200)
    assert.equal((await (await fetch(url, { headers })).json() as { directory: null }).directory, null)
    assert.equal((await post('conversation-folder', { directory: 17 })).status, 400)
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await middleware.close(); await f.close() }
})

test('switching projects creates distinct chats once and reuses each binding', async () => {
  const f = await fixture(false)
  try {
    const first = await f.manager.ensure('project-a')
    const second = await f.manager.ensure('project-b')
    assert.equal(first.threadId, nextThreadId)
    assert.equal(second.threadId, anotherThreadId)
    assert.equal((await f.manager.ensure('project-a')).threadId, first.threadId)
    assert.equal((await f.manager.ensure('project-b')).threadId, second.threadId)
    assert.equal(f.broker.starts, 2)
    const reopened = new DesktopControlManager(f.options)
    try {
      assert.equal((await reopened.state('project-a')).threadId, first.threadId)
      assert.equal((await reopened.state('project-b')).threadId, second.threadId)
    } finally { await reopened.close() }
  } finally { await f.close() }
})

test('a newly created empty native thread is ready even when native turns listing is unavailable', async () => {
  const f = await fixture(false)
  try {
    f.broker.emptyTurnsUnsupported = true
    const state = await f.manager.bind('project-new', { create: true })
    assert.equal(state.threadId, nextThreadId)
    assert.equal(state.connected, true)
    assert.equal(state.ready, true)
    assert.deepEqual(state.messages, [])
    assert.equal(state.error, null)
    assert.equal((await f.manager.state('project-new')).connected, true)
    assert.equal(f.broker.calls.filter(call => call.method === 'thread/start').length, 1)
  } finally { await f.close() }
})

test('native turn failure has clear model error without leaking endpoint or provider headers', async () => {
  const f = await fixture()
  try {
    await f.manager.bind('project-a')
    f.broker.turns.push({ id: 'error-turn', status: 'failed', items: [], error: { message: 'unexpected status 403 Forbidden: This model is not available http://secret-provider.test/v1 Authorization abc', codexErrorInfo: 'httpConnectionFailed' } })
    const state = await f.manager.state('project-a')
    assert.match(state.error!, /所选模型.*403/); assert.doesNotMatch(state.error!, /secret-provider|Authorization|abc/)
  } finally { await f.close() }
})

test('legacy dynamic circuit tools are registered to the shared candidate manager and routed only for owned project', async () => {
  const f = await fixture(true, true)
  try {
    await f.manager.bind('project-a')
    assert.ok(f.broker.registrations.some(r => r.id === threadId && r.names.includes('inspect_circuit')))
    f.broker.emit({ type: 'server-request', message: { id: 'tool-1', method: 'item/tool/call', params: { threadId, turnId: 'native-turn', namespace: 'functions', tool: 'inspect_circuit', arguments: {} } } })
    for (let n = 0; n < 100 && !f.broker.responses.length; n++) await new Promise(done => setTimeout(done, 10))
    assert.equal(f.broker.responses[0].response.result.success, true)
    const content = JSON.parse(f.broker.responses[0].response.result.contentItems[0].text)
    assert.equal(content.project.title, editorTemplate('rc-lowpass').title)
    assert.equal((await f.circuitManager!.state('project-a')).tasks.length, 0)
  } finally { await f.close() }
})

test('redraw request keeps its source task through the chat gateway and dynamic inspect', async () => {
  const f = await fixture(true, true)
  try {
    await f.manager.bind('project-a')
    const baseline = editorTemplate('rc-lowpass')
    const { task } = await f.circuitManager!.start({ projectId: 'project-a', expectedRevision: 1, requestId: 'source', request: '整理', layoutOnly: true })
    const proposal = structuredClone(baseline); proposal.drawing!.devices[0].x += 80
    await f.circuitManager!.call(task.id, 'replace_candidate', { project: { drawing: proposal.drawing } })
    await f.circuitManager!.finish(task.id, 'Candidate ready')
    f.broker.control.owner = 'web'
    await f.manager.send('project-a', '重画，把反馈回路移到上方', 'redraw-request', task.id)
    assert.match([...f.broker.calls].reverse().find(call => call.method === 'turn/start')!.params.input[0].text, new RegExp(task.id))
    const turnId = f.broker.turns.at(-1)!.id
    f.broker.emit({ type: 'server-request', message: { id: 'redraw-inspect', method: 'item/tool/call', params: { threadId, turnId, namespace: 'functions', tool: 'inspect_circuit', arguments: {} } } })
    for (let n = 0; n < 100 && !f.broker.responses.length; n++) await new Promise(done => setTimeout(done, 10))
    assert.equal(f.broker.responses[0].response.result.success, true)
    const inspected = JSON.parse(f.broker.responses[0].response.result.contentItems[0].text)
    assert.deepEqual(inspected.project.drawing, proposal.drawing)
    await assert.rejects(f.manager.send('project-a', '重画，把反馈回路移到上方', 'redraw-request', 'different-task'), /不能发送不同消息/)
  } finally { await f.close() }
})

async function waitFor(check: () => boolean) {
  for (let n = 0; n < 200 && !check(); n++) await new Promise(done => setTimeout(done, 10))
  assert.ok(check(), 'expected asynchronous broker result')
}
test('dynamic tool replay runs a mutation once, requires inspected revision, and releases failed finish task', async () => {
  const f = await fixture(true, true)
  try {
    await f.manager.bind('project-a')
    f.broker.turns.push({ id: 'native-turn', status: 'inProgress', startedAt: Date.now() / 1000, items: [{ id: 'native-user', type: 'userMessage', content: [{ type: 'text', text: '把 R1 改为 2k' }] }] })
    const emit = (id: string, tool: string, args = {}) => f.broker.emit({ type: 'server-request', message: { id, method: 'item/tool/call', params: { threadId, turnId: 'native-turn', namespace: 'functions', tool, arguments: args } } })
    emit('inspect-1', 'inspect_circuit'); await waitFor(() => f.broker.responses.length === 1)
    const originalCall = f.circuitManager!.call.bind(f.circuitManager!); let mutations = 0
    f.circuitManager!.call = async (...args) => { if (args[1] === 'set_component_value') mutations++; return originalCall(...args) }
    emit('mutate-1', 'set_component_value', { deviceId: 'R1', value: '2k' })
    emit('mutate-1', 'set_component_value', { deviceId: 'R1', value: '2k' })
    await waitFor(() => f.broker.responses.length === 3)
    assert.equal(mutations, 1); assert.equal(f.broker.responses[1].response.result.success, true)
    f.broker.emit({ type: 'notification', message: { method: 'turn/completed', params: { threadId, turn: { id: 'native-turn', status: 'completed' } } } })
    // Electrical changes without a matching real simulation cannot become an applicable candidate.
    let tasks = (await f.circuitManager!.state('project-a')).tasks
    for (let n = 0; n < 100 && tasks.some(t => t.status === 'running'); n++) { await new Promise(done => setTimeout(done, 10)); tasks = (await f.circuitManager!.state('project-a')).tasks }
    assert.equal(tasks[0].status, 'cancelled'); assert.equal(tasks[0].result, null)
    assert.match((await f.manager.state('project-a')).error!, /缺少.*ngspice/)
  } finally { await f.close() }
})

test('a canvas revision change after inspect rejects stale dynamic edits, and unmatched tool callbacks return failure', async () => {
  const f = await fixture(true, true)
  try {
    await f.manager.bind('project-a')
    f.broker.turns.push({ id: 'native-turn', status: 'inProgress', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: '改 R1 参数' }] }] })
    const event = (id: string, tool: string, args = {}, namespace = 'functions') => ({ type: 'server-request', message: { id, method: 'item/tool/call', params: { threadId, turnId: 'native-turn', namespace, tool, arguments: args } } })
    f.broker.emit(event('inspect', 'inspect_circuit')); await waitFor(() => f.broker.responses.length === 1)
    const snapshot = (await f.circuitManager!.state('project-a')).snapshot!
    const changed = structuredClone(snapshot.project); changed.title = '用户刚刚修改了画布'
    await f.circuitManager!.sync({ projectId: 'project-a', project: changed, expectedRevision: snapshot.revision })
    f.broker.emit(event('mutate', 'set_component_value', { deviceId: 'R1', value: '3k' })); await waitFor(() => f.broker.responses.length === 2)
    assert.equal(f.broker.responses[1].response.result.success, false)
    assert.match(f.broker.responses[1].response.result.contentItems[0].text, /版本已变化/)
    assert.equal((await f.circuitManager!.state('project-a')).tasks.length, 0)
    f.broker.emit(event('bad-namespace', 'inspect_circuit', {}, 'untrusted')); await waitFor(() => f.broker.responses.length === 3)
    assert.equal(f.broker.responses[2].response.result.success, false)
    assert.equal((await f.manager.state('project-a')).approvals.length, 0)
  } finally { await f.close() }
})

test('reconnect reconciles a missed native completion once without replaying tools or retaining a running candidate', async () => {
  const f = await fixture(true, true)
  try {
    await f.manager.bind('project-a')
    const turn = { id: 'offline-turn', status: 'inProgress', startedAt: Date.now() / 1000, items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: '请检查当前电路是否有效，不修改参数' }] }] as any[] }
    f.broker.turns.push(turn)
    const emit = (id: string, tool: string) => f.broker.emit({ type: 'server-request', message: { id, method: 'item/tool/call', params: { threadId, turnId: turn.id, tool, arguments: {} } } })
    let toolCalls = 0, finishes = 0
    const originalCall = f.circuitManager!.call.bind(f.circuitManager!), originalFinish = f.circuitManager!.finish.bind(f.circuitManager!)
    f.circuitManager!.call = async (...args) => { toolCalls++; return originalCall(...args) }
    f.circuitManager!.finish = async (...args) => { finishes++; return originalFinish(...args) }
    emit('offline-inspect', 'inspect_circuit'); await waitFor(() => f.broker.responses.length === 1)
    emit('offline-validate', 'validate_circuit'); await waitFor(() => f.broker.responses.length === 2)
    assert.equal((await f.circuitManager!.state('project-a')).tasks[0].status, 'running')
    f.broker.offline = true; f.broker.emit({ type: 'disconnected' })
    // Native finishes after the callback answer, but no completion notification reaches the gateway.
    turn.status = 'completed'; turn.items.push({ id: 'final', type: 'agentMessage', text: '连接和参数检查通过，未修改电路。', phase: 'final_answer' })
    f.broker.offline = false
    await f.manager.state('project-a')
    const task = (await f.circuitManager!.state('project-a')).tasks[0]
    assert.equal(task.status, 'completed'); assert.equal(task.result?.summary, '连接和参数检查通过，未修改电路。')
    assert.equal(toolCalls, 1); assert.equal(finishes, 1)
    f.broker.emit({ type: 'notification', message: { method: 'turn/completed', params: { threadId, turn } } })
    await f.manager.state('project-a'); assert.equal(finishes, 1)
    emit('offline-validate', 'validate_circuit'); await waitFor(() => f.broker.responses.length === 3)
    assert.equal(f.broker.responses[2].response.result.success, false); assert.equal(toolCalls, 1)
  } finally { await f.close() }
})

test('reconnect cancels an interrupted native turn whose completion event was missed', async () => {
  const f = await fixture(true, true)
  try {
    await f.manager.bind('project-a')
    const turn = { id: 'interrupted-turn', status: 'inProgress', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: '请检查当前电路' }] }] }
    f.broker.turns.push(turn)
    for (const tool of ['inspect_circuit', 'validate_circuit']) {
      const expected = f.broker.responses.length + 1
      f.broker.emit({ type: 'server-request', message: { id: tool, method: 'item/tool/call', params: { threadId, turnId: turn.id, tool, arguments: {} } } })
      await waitFor(() => f.broker.responses.length === expected)
    }
    f.broker.emit({ type: 'disconnected' }); turn.status = 'interrupted'
    await f.manager.state('project-a')
    const task = (await f.circuitManager!.state('project-a')).tasks[0]
    assert.equal(task.status, 'cancelled'); assert.equal(task.result, null)
  } finally { await f.close() }
})

test('requested permissions are automatically granted while questions still wait for an answer', async () => {
  const f = await fixture()
  try {
    await f.manager.bind('project-a'); await f.manager.handoff('project-a', 'web')
    f.broker.control.busy = true; f.broker.control.pendingApprovals = 1
    const permissions = { network: { enabled: true } }
    f.broker.emit({ type: 'server-request', message: { id: 'permission', method: 'item/permissions/requestApproval', params: { threadId, permissions } } })
    await waitFor(() => f.broker.responses.length === 1)
    assert.deepEqual(f.broker.responses[0].response.result, { permissions, scope: 'session' })
    const waiting = await f.manager.handoff('project-a', 'desktop')
    assert.equal(waiting.owner, 'web'); assert.equal(waiting.pendingOwner, 'desktop')
    await assert.rejects(f.manager.approval('project-a', 'permission', 'approve'), /已经处理/)
    f.broker.emit({ type: 'server-request', message: { id: 'legacy', method: 'execCommandApproval', params: { threadId } } })
    await waitFor(() => f.broker.responses.length === 2)
    assert.deepEqual(f.broker.responses[1].response.result, { decision: 'approved' })
    f.broker.emit({ type: 'server-request', message: { id: 'unspecified', method: 'item/permissions/requestApproval', params: { threadId } } })
    assert.equal((await f.manager.state('project-a')).approvals[0].canGrantPermissions, undefined)
    await f.manager.approval('project-a', 'unspecified', 'deny')
    assert.deepEqual(f.broker.responses[2].response.result, { permissions: {}, scope: 'turn' })
    f.broker.emit({ type: 'server-request', message: { id: 'question', method: 'item/tool/requestUserInput', params: { threadId, questions: [{ id: 'q', question: '选择参数' }] } } })
    assert.equal((await f.manager.state('project-a')).approvals.length, 1)
    f.broker.emit({ type: 'server-request-resolved', id: 'question' })
    assert.equal((await f.manager.state('project-a')).approvals.length, 0)
  } finally { await f.close() }
})

test('HTTP requires loopback same-origin marker and rejects extra fields, duplicate project parameters and cross-site posts', async () => {
  const f = await fixture(), middleware = createDesktopControlMiddleware({ ...f.options, manager: f.manager })
  const server = createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end() }) })
  await listenOnSafeTestPort(server)
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`
  try {
    assert.equal((await fetch(`${origin}/api/desktop-control/state?projectId=project-a`)).status, 403)
    const headers = { 'X-Fuxian-Desktop-Control': '1', 'Content-Type': 'application/json', Origin: origin }
    const state = await fetch(`${origin}/api/desktop-control/state?projectId=project-a`, { headers }); assert.equal(state.status, 200)
    assert.equal((await fetch(`${origin}/api/desktop-control/state?projectId=project-a&projectId=project-b`, { headers })).status, 400)
    assert.equal((await fetch(`${origin}/api/desktop-control/send`, { method: 'POST', headers: { ...headers, Origin: 'http://evil.test' }, body: '{}' })).status, 403)
    assert.equal((await fetch(`${origin}/api/desktop-control/bind`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'project-a', model: 'override' }) })).status, 400)
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await f.close() }
})
