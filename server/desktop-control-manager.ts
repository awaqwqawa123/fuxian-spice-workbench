import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validWorkbenchProjectId } from '../src/core/codex-workbench-link'
import type { DesktopControlApproval, DesktopControlMessage, DesktopControlOwner, DesktopControlState } from '../src/core/desktop-control'
import type { DesktopCircuitManager } from './desktop-circuit-manager'
import { DesktopControlCircuit } from './desktop-control-circuit'

type Data = Record<string, any>
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
const requestIdValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/.test(value)
const rejectedBeforeCreation = (error: unknown) => [-32600, -32601, -32602].includes(object(error).code)
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const empty = (projectId: string): DesktopControlState => ({ projectId, threadId: null, connected: false, ready: false, desktopConnected: false, owner: null, busy: false, pendingOwner: null, pendingApprovals: 0, approvals: [], messages: [], error: null, updatedAt: Date.now() })
export class DesktopControlError extends Error { constructor(readonly status: number, message: string) { super(message) } }
export function circuitConversationName(title: unknown): string {
  if (typeof title !== 'string' || title.length > 80) throw new DesktopControlError(400, '电路项目标题格式不正确')
  return `电路：${title.replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim() || '未命名电路'}`
}
/** Translate native failures without exposing provider URLs, credentials or local paths. */
export function desktopControlFailure(error: unknown, operation = '处理会话请求'): DesktopControlError {
  if (error instanceof DesktopControlError) return error
  const source = object(error), code = source.code, detail = typeof source.message === 'string' ? source.message : ''
  if (code === 'DESKTOP_DISCOVERY_MISSING') return new DesktopControlError(503, '桌面共享入口尚未安装或已失效，点击“连接 Codex”可自动修复。')
  if (code === 'DESKTOP_DISCOVERY_INVALID') return new DesktopControlError(503, '桌面共享配置已失效，点击“连接 Codex”可重新配置。')
  if (code === 'DESKTOP_TRANSPORT_CLOSED' || code === 'DESKTOP_CONNECT_TIMEOUT') return new DesktopControlError(503, '桌面共享连接已断开，点击“连接 Codex”可重新检测并恢复。')
  if (Number.isSafeInteger(code)) {
    if (/\b(?:session|thread)\b[^\r\n]{0,180}\bis archived\b/i.test(detail)) return new DesktopControlError(409, '当前项目对话已归档，请在 Codex 恢复这段对话后重试切换；原项目和对话关联已保留。')
    if (code === -32041) return new DesktopControlError(409, '当前控制权属于另一端，请等待任务结束并使用交接按钮')
    return new DesktopControlError(502, `官方 Codex 未能${operation}（错误码 ${code}）；请在桌面查看该对话的错误详情，原项目和对话关联已保留。`)
  }
  return new DesktopControlError(503, '桌面共享尚未连接，点击“连接 Codex”可自动检测并修复连接。')
}
export interface DesktopControlBroker {
  connect(): Promise<unknown>
  call(method: string, params: unknown): Promise<any>
  status(threadId?: string): Promise<any>
  handoff(threadId: string, owner: DesktopControlOwner): Promise<any>
  listen(listener: (event: any) => void): (() => void)
  respond(id: string | number, response: { result: unknown } | { error: unknown }): Promise<unknown> | void
  registerTools?(threadId: string, names: string[]): Promise<unknown>
  close(): Promise<unknown> | void
}
export interface DesktopControlManagerOptions {
  directory: string; projectDirectory: string; legacyDirectory?: string
  /** Resolve the shared Codex project directory only when starting a fresh thread. */
  conversationDirectory?: () => Promise<string>
  brokerFactory?: () => Promise<DesktopControlBroker> | DesktopControlBroker
  circuitManager?: DesktopCircuitManager
  explanationOnly?: boolean
}
interface Receipt { id: string; hash: string; wireHash?: string; message: string; redrawTaskId?: string; createdAt: number; delivery: 'sent' | 'unknown' | 'failed'; turnId?: string; error?: string }
interface SavedConversation { threadId: string; receipts: Receipt[]; emptyStub?: boolean }
interface Binding { projectId: string; threadId: string | null; creating?: boolean; restoreWeb?: boolean; receipts: Receipt[]; history?: SavedConversation[]; cache: DesktopControlState }
interface PendingApproval { id: string | number; method: string; params: Data }
function automaticApprovalResult(request: PendingApproval): unknown | null {
  if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') return { decision: 'accept' }
  if (request.method === 'execCommandApproval' || request.method === 'applyPatchApproval') return { decision: 'approved' }
  if (request.method === 'item/permissions/requestApproval') {
    const requested = request.params.permissions ?? request.params.requestedPermissions
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)) return null
    return { permissions: requested, scope: 'session' }
  }
  return null
}

/** A client of the desktop's existing broker. This class never starts an app-server. */
export class DesktopControlManager {
  private bindings = new Map<string, Binding>()
  private ready: Promise<void>
  private chain: Promise<unknown> = Promise.resolve()
  private broker: DesktopControlBroker | null = null
  private brokerPromise: Promise<DesktopControlBroker> | null = null
  private unlisten?: () => void
  private approvals = new Map<string, PendingApproval>()
  private approving = new Set<string>()
  private circuits?: DesktopControlCircuit
  private circuitErrors = new Map<string, string>()
  private restoreAttempts = new Map<string, number>()
  constructor(readonly options: DesktopControlManagerOptions) {
    if (options.circuitManager && !options.explanationOnly) this.circuits = new DesktopControlCircuit(options.circuitManager, threadId => [...this.bindings.values()].find(b => b.threadId === threadId)?.projectId, (threadId, turnId) => {
      const binding = [...this.bindings.values()].find(b => b.threadId === threadId)
      const receipt = binding?.receipts.find(r => r.turnId === turnId) ?? [...(binding?.receipts ?? [])].reverse().find(r => !r.turnId && r.delivery === 'unknown' && !!r.redrawTaskId && Date.now() - r.createdAt < 30_000)
      return receipt ? { message: receipt.message, redrawTaskId: receipt.redrawTaskId } : undefined
    }, (threadId, error) => this.circuitErrors.set(threadId, error))
    this.ready = this.restore(); void this.ready.catch(() => {})
  }
  private validateProject(projectId: unknown): asserts projectId is string { if (!validWorkbenchProjectId(projectId) || projectId === '.' || projectId === '..') throw new DesktopControlError(400, '项目编号格式不正确') }
  private async locked<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    this.validateProject(projectId); await this.ready
    const current = this.chain.catch(() => {}).then(fn); this.chain = current
    return current
  }
  private async restore() {
    try {
      const file = join(this.options.directory, 'bindings.json')
      if ((await stat(file)).size > 32 * 1024 * 1024) throw new Error('oversized')
      const data = JSON.parse(await readFile(file, 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.bindings) || data.bindings.length > 100) throw new Error('invalid bindings')
      const threads = new Set<string>()
      for (const b of data.bindings) {
        this.validateProject(b.projectId)
        if (this.bindings.has(b.projectId) || (b.threadId !== null && (!uuid(b.threadId) || threads.has(b.threadId))) || !Array.isArray(b.receipts) || (b.history !== undefined && (!Array.isArray(b.history) || b.history.length > 100))) throw new Error('invalid binding')
        for (const conversation of [{ threadId: b.threadId, receipts: b.receipts }, ...(b.history ?? [])]) {
          if (conversation !== undefined && (!Array.isArray(conversation.receipts) || conversation.emptyStub !== undefined && typeof conversation.emptyStub !== 'boolean')) throw new Error('invalid receipts')
          if (conversation.threadId) {
            if (!uuid(conversation.threadId) || threads.has(conversation.threadId)) throw new Error('invalid thread')
            threads.add(conversation.threadId)
          }
          for (const r of conversation.receipts) if (!requestIdValid(r.id) || !/^[a-f0-9]{64}$/.test(r.hash) || typeof r.message !== 'string' || r.redrawTaskId !== undefined && !requestIdValid(r.redrawTaskId) || !['sent', 'unknown', 'failed'].includes(r.delivery)) throw new Error('invalid receipt')
        }
        b.restoreWeb ??= b.cache?.owner === 'web'
        // Older versions left an invalid thread/start request marked as uncertain.
        // Codex rejected that request before creating a thread, so it is safe to retry.
        if (b.creating && !b.threadId && /^官方 Codex 未能处理会话请求（错误码 -3260[012]）/.test(b.cache?.error ?? '')) b.creating = false
        b.cache = { ...empty(b.projectId), ...object(b.cache), connected: false, ready: false, desktopConnected: false, threadId: b.threadId }
        this.bindings.set(b.projectId, b)
      }
    } catch (error) { if (object(error).code !== 'ENOENT') throw new DesktopControlError(500, '官方会话绑定记录无法读取；原文件已保留，未创建替代对话') }
  }
  private async save() {
    await mkdir(this.options.directory, { recursive: true })
    const file = join(this.options.directory, 'bindings.json'), temporary = `${file}.${randomUUID()}.tmp`
    const text = JSON.stringify({ version: 1, bindings: [...this.bindings.values()] })
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new DesktopControlError(507, '会话缓存超过本机上限，请保留已有对话')
    await writeFile(temporary, text, { mode: 0o600 }); await rename(temporary, file)
  }
  private async client(): Promise<DesktopControlBroker> {
    if (this.broker) return this.broker
    if (this.brokerPromise) return this.brokerPromise
    this.brokerPromise = (async () => {
      const client: DesktopControlBroker = this.options.brokerFactory ? await this.options.brokerFactory() : new (await import(/* @vite-ignore */ pathToFileURL(join(this.options.projectDirectory, 'scripts', 'desktop-broker', 'client.mjs')).href)).DesktopControlClient()
      const unlisten = client.listen(event => {
        if (this.circuits?.onEvent(client, event)) return
        if (event.type === 'server-request') {
          const message = object(event.message)
          if ((typeof message.id === 'string' || typeof message.id === 'number') && typeof message.method === 'string') {
            const request = { id: message.id, method: message.method, params: object(message.params) }
            if (this.bindings.size && [...this.bindings.values()].some(binding => binding.threadId === request.params.threadId) && automaticApprovalResult(request)) void this.autoApprove(client, request)
            else this.approvals.set(String(message.id), request)
          }
        }
        if (event.type === 'notification' && event.message?.method === 'serverRequest/resolved') this.approvals.delete(String(event.message.params?.requestId))
        if (event.type === 'server-request-resolved') this.approvals.delete(String(event.id))
        if (event.type === 'notification' && event.message?.method === 'turn/started') this.circuitErrors.delete(event.message.params?.threadId)
        if (event.type === 'disconnected' && this.broker === client) { this.broker = null; this.approvals.clear(); this.restoreAttempts.clear() }
      })
      this.unlisten?.(); this.unlisten = unlisten
      try { await client.connect(); for (const b of this.bindings.values()) if (b.threadId) await this.circuits?.register(client, b.threadId); this.broker = client; return client }
      catch (error) { unlisten(); await client.close(); throw error }
    })()
    try { return await this.brokerPromise } finally { this.brokerPromise = null }
  }
  /** Refresh only the transport. Creation/delivery journals are deliberately kept. */
  async reconnectTransport(): Promise<{ connected: boolean; ready: boolean; desktopConnected: boolean }> {
    await this.ready
    const current = this.chain.catch(() => {}).then(async () => {
      this.unlisten?.(); this.unlisten = undefined
      const old = this.broker; this.broker = null
      await old?.close(); this.approvals.clear(); this.restoreAttempts.clear()
      const client = await this.client()
      let state = await client.status()
      const deadline = Date.now() + 5000
      while (state.connected && state.desktopConnected && !state.ready && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250))
        state = await client.status()
      }
      return state
    })
    this.chain = current
    return current
  }
  private safeError(error: unknown) {
    return desktopControlFailure(error).message
  }
  private async autoApprove(client: DesktopControlBroker, request: PendingApproval) {
    const key = String(request.id), result = automaticApprovalResult(request)
    if (!result || this.approving.has(key)) return
    this.approving.add(key)
    try { await client.respond(request.id, { result }); this.approvals.delete(key) }
    catch { this.approvals.set(key, request) }
    finally { this.approving.delete(key) }
  }
  private async json(path: string): Promise<Data | null> {
    try { if ((await stat(path)).size > 5 * 1024 * 1024) throw new Error('oversized'); return object(JSON.parse(await readFile(path, 'utf8'))) }
    catch (error) { if (object(error).code === 'ENOENT') return null; throw new DesktopControlError(500, '旧会话关联文件无法读取；未改绑或新建对话') }
  }
  private async legacyThread(projectId: string, explicitId?: string): Promise<string | null> {
    const directory = this.options.legacyDirectory ?? join(this.options.projectDirectory, '.codex-sessions')
    if (explicitId && !uuid(explicitId)) throw new DesktopControlError(400, '旧会话编号格式不正确')
    const map = await this.json(join(directory, 'project-bindings.json'))
    if (map && explicitId && map[projectId] && map[projectId] !== explicitId) throw new DesktopControlError(409, '项目已有另一条旧会话关联，未覆盖原绑定')
    const id = explicitId ?? map?.[projectId]
    if (id) {
      if (!uuid(id)) throw new DesktopControlError(500, '旧会话关联记录格式不正确')
      const value = await this.json(join(directory, id, 'session.json'))
      if (!value || value.id !== id || value.workbench?.projectId !== projectId) throw new DesktopControlError(409, '旧会话与项目不匹配，未关联其他聊天')
      if (!value.threadId) return null
      if (!uuid(value.threadId)) throw new DesktopControlError(500, '旧会话中的官方 Thread 编号无效')
      return value.threadId
    }
    if (map) return null
    let files: string[]
    try { files = await readdir(directory) } catch (error) { if (object(error).code === 'ENOENT') return null; throw new DesktopControlError(500, '无法读取旧项目关联') }
    const threads = new Set<string>()
    for (const name of files.filter(uuid)) {
      const value = await this.json(join(directory, name, 'session.json'))
      if (value?.workbench?.projectId === projectId && value.threadId) {
        if (!uuid(value.threadId)) throw new DesktopControlError(500, '旧会话中的官方 Thread 编号无效')
        threads.add(value.threadId)
      }
    }
    if (threads.size > 1) throw new DesktopControlError(409, '发现多个旧对话，请选择要继续的旧会话，未自动替换')
    return [...threads][0] ?? null
  }
  private claim(projectId: string, threadId: string) {
    const existing = this.bindings.get(projectId)
    if (existing?.threadId && existing.threadId !== threadId) throw new DesktopControlError(409, '此项目已有专属官方对话，不能静默替换')
    if ([...this.bindings.values()].some(b => b.threadId === threadId && b.projectId !== projectId || b.history?.some(item => item.threadId === threadId))) throw new DesktopControlError(409, '这段官方对话已绑定另一个项目或已在项目历史中')
    const b = existing ?? { projectId, threadId, receipts: [], cache: empty(projectId) }
    b.threadId = threadId; b.creating = false; this.bindings.set(projectId, b); return b
  }
  private view(b: Binding, state: DesktopControlState): DesktopControlState {
    return { ...state, ...(b.creating ? { error: '上次新建对话的结果尚未确认；请先核对 Codex 桌面中的对话，当前对话仍已保留。' } : {}) }
  }
  private async assertLegacyOwner(projectId: string, threadId: string) {
    const directory = this.options.legacyDirectory ?? join(this.options.projectDirectory, '.codex-sessions')
    const map = await this.json(join(directory, 'project-bindings.json'))
    if (!map) return
    for (const [owner, id] of Object.entries(map)) {
      if (owner === projectId) continue
      if (!validWorkbenchProjectId(owner) || !uuid(id)) throw new DesktopControlError(500, '旧会话关联记录格式不正确')
      const state = await this.json(join(directory, id, 'session.json'))
      if (state?.threadId === threadId) throw new DesktopControlError(409, '这段官方对话在旧记录中已属于另一个项目')
    }
  }
  private async readThread(client: DesktopControlBroker, threadId: string) {
    const result = await client.call('thread/read', { threadId, includeTurns: false }), thread = object(result.thread)
    if (thread.id !== threadId || thread.ephemeral) throw new DesktopControlError(409, '共享服务返回了不同的对话；原项目绑定已保留')
    return thread
  }
  private async resumeThread(client: DesktopControlBroker, threadId: string) {
    try {
      // A plain resume may be sent while the desktop still owns the thread.
      // Access settings belong to thread/start and turn/start after handoff.
      const result = await client.call('thread/resume', { threadId }), thread = object(result.thread)
      if (thread.id !== threadId || thread.ephemeral) throw new DesktopControlError(409, '官方服务未恢复当前项目的原对话，控制权未切换；原关联已保留')
    } catch (error) { throw desktopControlFailure(error, '恢复当前项目的原对话') }
  }
  private async restoreWebOwnership(client: DesktopControlBroker, b: Binding) {
    if (!b.threadId || !b.restoreWeb || Date.now() - (this.restoreAttempts.get(b.projectId) ?? 0) < 10_000) return
    try {
      const control = await client.status(b.threadId)
      if (!control.connected || !control.ready || !control.desktopConnected || control.owner !== 'desktop' || control.loaded !== false || control.busy || control.pendingApprovals) return
      this.restoreAttempts.set(b.projectId, Date.now())
      await this.resumeThread(client, b.threadId)
      await client.handoff(b.threadId, 'web')
      this.restoreAttempts.delete(b.projectId)
    } catch { /* Keep the binding and let the visible handoff report a specific failure. */ }
  }
  private async createFresh(projectId: string, client: DesktopControlBroker) {
    const status = await client.status()
    if (!status.connected || !status.ready || !status.desktopConnected) throw new DesktopControlError(503, '桌面共享尚未连接；连接恢复后会为此项目自动创建对话')
    const cwd = this.options.conversationDirectory ? await this.options.conversationDirectory() : resolve(this.options.projectDirectory)
    // A recovered empty thread keeps its old ID in history, so never replace
    // the whole binding when creating its successor.
    const b: Binding = this.bindings.get(projectId) ?? { projectId, threadId: null, receipts: [], cache: empty(projectId) }
    b.creating = true; b.cache = empty(projectId)
    this.bindings.set(projectId, b); await this.save()
    try {
      const result = await client.call('thread/start', { cwd, ephemeral: false, approvalPolicy: 'never', sandbox: 'danger-full-access' })
      if (!uuid(result.thread?.id) || result.thread.ephemeral) throw new DesktopControlError(502, '共享服务未返回持久对话编号，未再次创建')
      const next = this.claim(projectId, result.thread.id); await this.save(); return this.refresh(client, next)
    } catch (error) {
      // Invalid request / method / params are definite pre-creation rejections.
      // A timeout or disconnect remains uncertain and must not be retried blindly.
      if (rejectedBeforeCreation(error)) b.creating = false
      b.cache.error = this.safeError(error); await this.save(); throw error
    }
  }
  async ensure(projectId: string, title?: string) { return this.locked(projectId, async () => {
    const conversationName = title === undefined ? null : this.options.explanationOnly ? `电路解释：${circuitConversationName(title).slice(3)}` : circuitConversationName(title)
    const existing = this.bindings.get(projectId)
    if (existing?.creating) throw new DesktopControlError(409, '上次新建是否成功尚未确认；请在 Codex 桌面核对，未重复创建')
    const client = await this.client()
    if (existing?.threadId) await this.retireUnresumableEmptyThread(client, existing)
    let state: DesktopControlState
    if (existing?.threadId) { await this.restoreWebOwnership(client, existing); state = await this.refresh(client, existing) }
    else {
      const created = await this.createFresh(projectId, client)
      state = created
      if (created.threadId && created.connected && created.ready && created.desktopConnected) {
        try { await client.handoff(created.threadId, 'web'); state = await this.refresh(client, this.bindings.get(projectId)!) }
        catch { /* The new conversation remains bound and can be handed off later. */ }
      }
    }
    if (conversationName && state.threadId) {
      try { await client.call('thread/name/set', { threadId: state.threadId, name: conversationName }) }
      catch (error) {
        if (object(error).code === -32601) throw new DesktopControlError(501, '桌面共享中转需要重新打开 Codex 才能同步项目对话名称；现有对话仍可使用')
        throw desktopControlFailure(error, '更新项目对话名称')
      }
    }
    return state
  }) }
  async bind(projectId: string, input: { threadId?: string; legacySessionId?: string; create?: boolean } = {}) { return this.locked(projectId, async () => {
    if (input.threadId !== undefined && !uuid(input.threadId)) throw new DesktopControlError(400, '官方对话编号格式不正确')
    if (input.create !== undefined && typeof input.create !== 'boolean') throw new DesktopControlError(400, '创建标记格式不正确')
    const oldThread = input.create ? null : await this.legacyThread(projectId, input.legacySessionId), existing = this.bindings.get(projectId)
    if (existing?.creating && !input.threadId) throw new DesktopControlError(409, '上次新建是否成功尚未确认；请在官方桌面找到该对话后使用其编号关联，不会重复创建')
    const id = existing?.threadId ?? oldThread ?? input.threadId
    if ((existing?.threadId && oldThread && oldThread !== existing.threadId) || (input.threadId && id && input.threadId !== id)) throw new DesktopControlError(409, '项目已有官方对话，未替换原关联')
    const client = await this.client()
    if (id) {
      await this.assertLegacyOwner(projectId, id); await this.readThread(client, id)
      const b = this.claim(projectId, id); await this.save()
      await this.circuits?.register(client, id)
      await this.resumeThread(client, id)
      return this.refresh(client, b)
    }
    if (!input.create) throw new DesktopControlError(409, '此项目尚未关联官方对话；请输入要继续的官方 Thread 编号，或明确新建对话')
    return this.createFresh(projectId, client)
  }) }
  private approvalView(value: PendingApproval): DesktopControlApproval {
    const input = value.params, method = value.method
    const question = method === 'item/tool/requestUserInput'
    const supported = question || ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval'].includes(method)
    const title = question ? 'Codex 需要你的回答' : /fileChange|applyPatch/.test(method) ? '允许本次文件修改' : /commandExecution|execCommand/.test(method) ? '允许本次命令执行' : '此请求需要支持的官方审批界面'
    const detail = [input.reason, input.command, input.cwd].filter(v => typeof v === 'string').join('\n').slice(0, 8000)
    const questions = question && Array.isArray(input.questions) ? input.questions.map((q: Data) => ({ id: String(q.id), question: String(q.question ?? ''), ...(Array.isArray(q.options) ? { options: q.options.map((o: Data) => ({ label: String(o.label), ...(typeof o.description === 'string' ? { description: o.description } : {}) })) } : {}), ...(q.isSecret ? { isSecret: true } : {}) })) : undefined
    return { id: String(value.id), method, supported, title, detail, ...(method === 'item/permissions/requestApproval' && automaticApprovalResult(value) ? { canGrantPermissions: true } : {}), ...(questions ? { questions } : {}) }
  }
  private async turns(client: DesktopControlBroker, threadId: string): Promise<Data[] & { truncated?: boolean }> {
    const all: Data[] = []; let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      let result: Data
      try { result = await client.call('thread/turns/list', { threadId, limit: 50, sortDirection: 'desc', itemsView: 'summary', ...(cursor ? { cursor } : {}) }) }
      catch (error) {
        // The native service cannot list turns for a newly started, empty thread.
        // Confirm it is still empty before treating this specific first-page error as zero history.
        if (page === 0 && [-32600, -32601].includes(object(error).code)) {
          const thread = await this.readThread(client, threadId)
          if (thread.status?.type === 'idle' && thread.threadSource == null && !thread.preview && Array.isArray(thread.turns) && thread.turns.length === 0) return Object.assign([], { truncated: false })
        }
        throw error
      }
      if (!Array.isArray(result.data)) throw new DesktopControlError(502, '官方聊天记录格式不正确')
      all.push(...result.data); cursor = result.nextCursor ?? undefined; if (!cursor) break
    }
    return Object.assign(all.reverse(), { truncated: !!cursor })
  }
  /** Codex can leave an empty thread/start stub without a rollout. After a
   * desktop restart that stub cannot be resumed or listed. Only retire it when
   * both the local delivery journal and the native history prove it is empty. */
  private async retireUnresumableEmptyThread(client: DesktopControlBroker, b: Binding): Promise<boolean> {
    if (!b.threadId || b.creating || b.receipts.length || b.cache.messages.length) return false
    let thread: Data
    try { thread = await this.readThread(client, b.threadId) } catch { return false }
    if (thread.status?.type !== 'notLoaded' || thread.threadSource != null || thread.preview || !Array.isArray(thread.turns) || thread.turns.length) return false
    try { await client.call('thread/turns/list', { threadId: b.threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary' }); return false }
    catch (error) {
      if (object(error).code !== -32600 || !/invalid paginated history lineage[^\r\n]*missing source rollout/i.test(object(error).message ?? '')) return false
    }
    const history = [...(b.history ?? [])]
    if (history.length >= 100) {
      // Only entries marked when their missing rollout was verified are safe
      // to expire. A conversation with any recorded delivery stays forever.
      const expired = history.findIndex(entry => entry.emptyStub === true && entry.receipts.length === 0)
      if (expired < 0) throw new DesktopControlError(507, '对话历史记录已达上限且没有可安全清理的空对话；原记录已保留')
      history.splice(expired, 1)
    }
    b.history = [...history, { threadId: b.threadId, receipts: b.receipts, emptyStub: true }]
    b.threadId = null; b.restoreWeb = false; b.receipts = []; b.cache = empty(b.projectId)
    await this.save()
    return true
  }
  private turnError(turn: Data | undefined): string | null {
    if (!turn?.error) return null
    const error = object(turn.error), detail = `${error.message ?? ''} ${JSON.stringify(error.codexErrorInfo ?? {})}`
    if (/403|Forbidden/i.test(detail) && /model.{0,100}(?:available|access|support)|not.{0,20}available/i.test(detail)) return '当前官方对话所选模型不受现有服务渠道支持（403）。请在 Codex 桌面选择该渠道支持的模型，再从同一对话继续；聊天与电路均已保留。'
    if (/401|unauthori[sz]ed|authentication|invalid.{0,15}(?:key|token)/i.test(detail)) return '模型服务鉴权失败，请在官方 Codex 桌面检查登录或服务渠道配置。'
    if (/429|rate.?limit|quota|usage.?limit/i.test(detail)) return '模型服务达到速率或额度限制，请检查当前账号额度或稍后继续。'
    if (/timeout|timed out|network|connection|stream.*disconnect/i.test(detail)) return '本轮模型连接中断或超时；请先核对已有回复和工具结果，再决定是否继续。'
    return '官方 Codex 本轮执行出错，请在桌面查看本轮错误详情；没有自动重发或替换对话。'
  }
  private async refresh(client: DesktopControlBroker, b: Binding): Promise<DesktopControlState> {
    try {
      await this.readThread(client, b.threadId!)
      await this.circuits?.register(client, b.threadId!)
      const [control, turns] = await Promise.all([client.status(b.threadId!), this.turns(client, b.threadId!)])
      if (control.loaded === true && !control.pendingOwner) b.restoreWeb = control.owner === 'web'
      await this.circuits?.reconcile(b.threadId!, turns)
      const messages: DesktopControlMessage[] = []
      for (const turn of turns) for (const item of turn.items ?? []) {
        const role = item.type === 'userMessage' ? 'user' : item.type === 'agentMessage' ? 'assistant' : null
        if (!role) continue
        const nativeContent = role === 'user' ? (item.content ?? []).filter((p: Data) => p.type === 'text' && typeof p.text === 'string').map((p: Data) => p.text).join('\n') : item.text
        const receipt = role === 'user' ? b.receipts.find(r => r.turnId === turn.id || (!r.turnId && typeof nativeContent === 'string' && (r.wireHash ? hash(nativeContent) === r.wireHash : nativeContent === r.message + this.context(b.projectId, r.id)))) : undefined
        if (receipt) { receipt.turnId = turn.id; receipt.delivery = 'sent' }
        const content = receipt?.message ?? nativeContent
        if (typeof content !== 'string' || !content.trim()) continue
        const timestamp = Number(turn.startedAt) * 1000
        messages.push({ id: receipt?.id ?? String(item.id), role, content: content.slice(0, 48000), createdAt: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(), ...(role === 'user' ? { delivery: 'sent' as const } : {}) })
      }
      for (const receipt of b.receipts) if (!messages.some(m => m.id === receipt.id)) messages.push({ id: receipt.id, role: 'user', content: receipt.message, createdAt: receipt.createdAt, delivery: receipt.delivery })
      const approvals = [...this.approvals.values()].filter(a => a.params.threadId === b.threadId).map(a => this.approvalView(a))
      b.cache = { projectId: b.projectId, threadId: b.threadId, connected: control.connected === true, ready: control.ready === true, desktopConnected: control.desktopConnected === true, owner: ['desktop', 'web'].includes(control.owner) ? control.owner : null, busy: control.busy === true, pendingOwner: ['desktop', 'web'].includes(control.pendingOwner) ? control.pendingOwner : null, pendingApprovals: Number(control.pendingApprovals) || 0, approvals, messages: messages.sort((a, b) => a.createdAt - b.createdAt), error: b.receipts.some(r => r.delivery === 'unknown') ? '有消息送达状态尚未确认；为避免重复执行，不会自动重发' : this.turnError(turns.at(-1)) ?? this.circuitErrors.get(b.threadId!) ?? [...b.receipts].reverse().find(r => r.delivery === 'failed')?.error ?? null, updatedAt: Date.now() }
      if (turns.truncated) { b.cache.historyTruncated = true; b.cache.error ??= '网页当前显示最近 500 轮；更早的记录仍保留在官方桌面对话中' }
      await this.save(); return structuredClone(this.view(b, b.cache))
    } catch (error) {
      // A thread read can fail while the desktop broker itself remains healthy.
      // Preserve that distinction so the UI can point to the project conversation.
      const desktopConnected = await client.status().then(status => status.desktopConnected === true, () => false)
      b.cache = { ...b.cache, threadId: b.threadId, connected: false, ready: false, desktopConnected, error: this.safeError(error), updatedAt: Date.now() }
      return structuredClone(this.view(b, b.cache))
    }
  }
  async state(projectId: string) { return this.locked(projectId, async () => {
    const b = this.bindings.get(projectId)
    try {
      const client = await this.client()
      if (b?.threadId) await this.retireUnresumableEmptyThread(client, b)
      if (b?.threadId) { await this.restoreWebOwnership(client, b); return this.refresh(client, b) }
      const state = await client.status()
      const next = { ...empty(projectId), connected: state.connected === true, ready: state.ready === true, desktopConnected: state.desktopConnected === true, error: b?.creating ? '上次新建结果未确认，请关联官方桌面中的原对话' : null }
      return b ? this.view(b, next) : next
    } catch (error) { const next = { ...(b?.cache ?? empty(projectId)), threadId: b?.threadId ?? null, connected: false, ready: false, desktopConnected: false, error: this.safeError(error), updatedAt: Date.now() }; return b ? this.view(b, next) : next }
  }) }
  private binding(projectId: string) { const b = this.bindings.get(projectId); if (!b?.threadId) throw new DesktopControlError(409, '请先关联当前项目的官方对话'); return b }
  async handoff(projectId: string, owner: DesktopControlOwner) { return this.locked(projectId, async () => {
    if (!['desktop', 'web'].includes(owner)) throw new DesktopControlError(400, '控制端只能是桌面或网页')
    const b = this.binding(projectId), client = await this.client(); await this.readThread(client, b.threadId!)
    const current = await client.status(b.threadId!)
    if (!current.ready || !current.connected || !current.desktopConnected) throw new DesktopControlError(409, '官方桌面尚未连接共享服务，不能确认控制权交接')
    if (current.loaded === false) await this.resumeThread(client, b.threadId!)
    try { await client.handoff(b.threadId!, owner) }
    catch (error) { throw desktopControlFailure(error, '切换对话控制权') }
    return this.refresh(client, b)
  }) }
  private context(projectId: string, requestId: string) {
    if (this.options.explanationOnly) return `\n\n[电路解释子对话：项目 ${projectId}，请求 ${requestId}]\n这是与绘制对话分开的解释会话。只能根据本轮附带的最新项目快照说明电路拓扑、信号路径、器件作用及仿真局限；不修改电路、项目文件或候选方案，不调用写入工具。快照若缺少某项信息，明确说不确定。\n[/电路解释子对话]`
    const root = resolve(this.options.projectDirectory), cli = join(root, 'scripts', 'desktop-circuit.mjs')
    return `\n\n[电路工作台上下文：项目 ${projectId}，请求 ${requestId}]\n本轮来自同一官方 Codex 对话的网页入口。需要读取/修改/仿真电路时，优先调用本轮已注册的 inspect_circuit 读取当前完整候选及 generationInstructions；工具未列出或旧 schema 不支持 set_measurement_probes / configure_waveforms 时，不重复发送未知字段；运行 node "${cli}" inspect --project "${projectId}" 读取最新画布、tools 定义及 activeTask，node "${cli}" --help 查询 start/call/finish。旧会话的动态工具 schema 不会因重启或注册回调自动更新，不要为此新建 Thread 或第二个 Codex writer。若 activeTask 是本轮先前电路工具已返回的同一 taskId，核对后复用它，通过 call --task ID --name set_measurement_probes --input-file JSON_PATH 设置完整探针列表，或 --name configure_waveforms 设置完整波形图和仿真配置；先 call inspect_circuit 读取该任务的当前候选，不用网页快照覆盖它。复用的动态工具任务由原回合自动完成，不手动 finish/cancel。activeTask 无法确认属于本轮时先报告占用，不接管或提前结束别人的任务。只有没有 activeTask 时才能按 inspect 的 revision 创建本轮 CLI 任务；只对自己创建的 CLI 任务执行 finish。没有命令工具时明确说明本轮无法调用新增工具，保留候选。修改仅产生候选，用户审阅后应用，不直接写浏览器或自动应用。电气修改必须通过 simulate_circuit 使用真实 ngspice。绘制或重排前读取 "${join(root, 'docs', 'drawing-guide.md')}"，并查 drawing-patterns.md、drawing-acceptance.md；受限工具环境按 inspect_circuit 返回的绘图指导执行。纯重画从完整候选复制后只改图面几何，保留 devices.params、labels、sourceId、output、模型、源设置及测量。replace_candidate 被拒绝时按具体字段及前后差异修正重试，不删参数绕过校验；只有提交成功、重新检查有实际几何变化且 validate_circuit 通过，才说明重画候选已生成。不要修改工作台源码或其他项目。\n[/电路工作台上下文]`
  }
  async send(projectId: string, message: string, requestId: string, redrawTaskId?: string) { return this.locked(projectId, async () => {
    if (typeof message !== 'string' || !message.trim() || message.length > 16000 || !requestIdValid(requestId)) throw new DesktopControlError(400, '消息需要 1–16000 字符和有效请求编号')
    if (redrawTaskId !== undefined && !requestIdValid(redrawTaskId)) throw new DesktopControlError(400, '重画来源编号格式不正确')
    const b = this.binding(projectId), client = await this.client(), prior = b.receipts.find(r => r.id === requestId)
    if (prior) { if (prior.hash !== hash(message) || prior.redrawTaskId !== redrawTaskId) throw new DesktopControlError(409, '同一个请求编号不能发送不同消息'); return this.refresh(client, b) }
    if (b.receipts.length >= 2000) throw new DesktopControlError(507, '本项目网页发送记录已达上限，请保留对话并从官方桌面继续')
    await this.readThread(client, b.threadId!)
    const state = await client.status(b.threadId!)
    if (!state.connected || !state.ready || !state.desktopConnected || state.owner !== 'web' || state.pendingOwner || state.busy || state.pendingApprovals) throw new DesktopControlError(409, '当前尚未完成交接或仍有任务/审批；请等待网页获得控制权后发送')
    await this.circuits?.drain(b.threadId!)
    if (redrawTaskId) {
      if (this.options.explanationOnly || !this.options.circuitManager) throw new DesktopControlError(400, '当前对话不能重画候选方案')
      await this.options.circuitManager.inspect(projectId, redrawTaskId)
    }
    let wireText = message + this.context(projectId, requestId)
    if (redrawTaskId) wireText += `\n\n[重画来源]本轮应以候选任务 ${redrawTaskId} 为起点。注册的 inspect_circuit 已配置返回该候选的完整电路；若改用 CLI，inspect 和 start 都必须附加 --source-task ${redrawTaskId}。不要从尚未应用的旧画布重新生成。[/重画来源]`
    if (this.options.explanationOnly) {
      const snapshot = (await this.options.circuitManager?.state(projectId))?.snapshot
      if (!snapshot) throw new DesktopControlError(409, '项目画布尚未同步，请等待同步后再提问')
      const circuit = JSON.stringify({ revision: snapshot.revision, project: snapshot.project })
      if (circuit.length > 200_000) throw new DesktopControlError(413, '项目快照过大，无法安全附加到解释问题')
      wireText += `\n\n[当前项目快照]\n${circuit}\n[/当前项目快照]`
    }
    const receipt: Receipt = { id: requestId, hash: hash(message), wireHash: hash(wireText), message, ...(redrawTaskId ? { redrawTaskId } : {}), createdAt: Date.now(), delivery: 'unknown' }
    b.receipts.push(receipt); await this.save()
    try {
      const result = await client.call('turn/start', { threadId: b.threadId, input: [{ type: 'text', text: wireText, text_elements: [] }], approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })
      if (typeof result.turn?.id !== 'string') throw new DesktopControlError(502, '官方服务未返回回合编号；送达状态待核对')
      receipt.turnId = result.turn.id; receipt.delivery = 'sent'
    } catch (error) { if (typeof object(error).code === 'number') receipt.delivery = 'failed'; receipt.error = this.safeError(error) }
    await this.save(); return this.refresh(client, b)
  }) }
  async cancel(projectId: string) { return this.locked(projectId, async () => {
    const b = this.binding(projectId), client = await this.client(), state = await client.status(b.threadId!)
    if (!state.connected || !state.ready || state.owner !== 'web') throw new DesktopControlError(409, '只能中断网页当前持有的任务')
    const turn = (await this.turns(client, b.threadId!)).reverse().find(t => t.status === 'inProgress')
    if (turn) await client.call('turn/interrupt', { threadId: b.threadId, turnId: turn.id })
    return this.refresh(client, b)
  }) }
  async approval(projectId: string, id: string, decision: 'approve' | 'deny', answers?: Record<string, string[]>) { return this.locked(projectId, async () => {
    if (typeof id !== 'string' || id.length > 300 || !['approve', 'deny'].includes(decision)) throw new DesktopControlError(400, '审批请求格式不正确')
    const b = this.binding(projectId), client = await this.client(), request = this.approvals.get(id)
    if (!request || request.params.threadId !== b.threadId) throw new DesktopControlError(409, '审批已经处理、已断开或不属于此项目')
    const view = this.approvalView(request)
    if (!view.supported) throw new DesktopControlError(409, '此原生审批类型尚未支持；未自动批准')
    let result: unknown
    if (request.method === 'item/tool/requestUserInput') {
      if (decision !== 'approve' || !answers || Object.values(answers).some(v => !Array.isArray(v) || v.some(s => typeof s !== 'string' || s.length > 8000)) || view.questions?.some(q => !Array.isArray(answers[q.id]))) throw new DesktopControlError(400, '请回答每个问题后提交')
      result = { answers: Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, { answers: values }])) }
    } else if (request.method === 'item/permissions/requestApproval') {
      result = decision === 'approve' ? automaticApprovalResult(request) : { permissions: {}, scope: 'turn' }
      if (!result) throw new DesktopControlError(409, '官方请求未列出可授予的权限，请在 Codex 桌面处理')
    } else result = { decision: request.method.startsWith('item/') ? decision === 'approve' ? 'accept' : 'decline' : decision === 'approve' ? 'approved' : 'denied' }
    await client.respond(request.id, { result }); this.approvals.delete(id); return this.refresh(client, b)
  }) }
  async close() { await this.ready; await this.chain.catch(() => {}); await this.circuits?.close(); this.unlisten?.(); await this.broker?.close(); this.broker = null }
}
