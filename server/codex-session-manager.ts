import { randomUUID } from 'node:crypto'
import { aiProjectFingerprint } from '../src/core/ai'
import { isSchematicRedrawRequest } from '../src/core/redraw-intent'
import { parseProject, projectKey, type Project } from '../src/core/circuit'
import { CodexRuntimeError, type CodexRuntimeOptions } from './codex-runtime'
import { createCodexCircuitSession, runCodexCircuitSession } from './codex-session-runtime'
import { CodexSessionError, CodexSessionStore, sessionId, type CodexSessionState } from './codex-session-store'
import { checkCodexWriteAccess, readCodexCircuitSession, type NativeSessionSnapshot } from './codex-session-native'
import { CodexThreadInUseError } from './codex-rpc'
import { createCodexWorkbenchLink } from '../src/core/codex-workbench-link'

export interface CodexSessionManagerOptions {
  directory: string
  projectDirectory?: string
  /** Test-only/server-owned dependencies, never accepted in browser input. */
  runtimeOptions?: CodexRuntimeOptions
  create?: (options: Parameters<typeof createCodexCircuitSession>[0]) => Promise<Pick<CodexSessionState, 'threadId' | 'model' | 'desktop'>>
  run?: typeof runCodexCircuitSession
  read?: typeof readCodexCircuitSession
  checkWriteAccess?: typeof checkCodexWriteAccess
}

export class CodexSessionManager {
  readonly store: CodexSessionStore
  private states = new Map<string, CodexSessionState>()
  private saving = new Map<string, Promise<void>>()
  private tasks = new Map<string, { controller: AbortController; task: Promise<void>; requestId: string }>()
  private mutation = Promise.resolve()
  constructor(private options: CodexSessionManagerOptions) { this.store = new CodexSessionStore(options.directory) }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(action)
    this.mutation = result.then(() => {}, () => {})
    return result
  }
  private persist(state: CodexSessionState) {
    state.updatedAt = new Date().toISOString()
    const snapshot = structuredClone(state)
    const operation = (this.saving.get(state.id) ?? Promise.resolve()).catch(() => {}).then(() => this.store.save(snapshot))
    this.saving.set(state.id, operation)
    return operation
  }
  private async obtain(id: string) {
    sessionId(id)
    const present = this.states.get(id)
    if (present) return present
    const saved = await this.store.load(id)
    // Associate legacy results before any external transcript is merged. Identical
    // later desktop replies must never reassign a circuit candidate to that turn.
    if (saved.resultRequestId === undefined) saved.resultRequestId = saved.result ? saved.messages.filter(item => item.role === 'assistant' && item.content === saved.result!.summary).at(-1)?.requestId ?? null : null
    // A restarted web server cannot claim a killed/unknown old turn is still running.
    if (saved.status === 'running') {
      saved.status = 'interrupted'; saved.activeRequestId = null
      saved.error = '工作台服务在上一轮执行时重启；该轮未自动续跑，可在同一会话继续提问。'
      await this.persist(saved)
    }
    this.states.set(id, saved)
    return saved
  }
  private snapshot(state: CodexSessionState) {
    const copy = structuredClone(state), task = this.tasks.get(state.id)
    // Completion includes durable saving and releasing the task lease.
    if (task) { copy.status = 'running'; copy.activeRequestId = task.requestId }
    return copy
  }
  state(id: string) { return this.exclusive(async () => this.snapshot(await this.obtain(id))) }
  private mergeNative(state: CodexSessionState, native: NativeSessionSnapshot) {
    const remaining = [...state.messages]
    const merged: CodexSessionState['messages'] = native.messages.map(message => {
      let index = remaining.findIndex(local => local.nativeItemId === message.nativeItemId)
      if (index < 0) index = remaining.findIndex(local => !local.nativeItemId && local.delivery !== 'notSent' && local.role === message.role && local.content.trim() === message.content.trim())
      const existing = index >= 0 ? remaining.splice(index, 1)[0] : undefined
      return { ...message, id: existing?.id ?? `native-${message.nativeItemId}`, requestId: existing?.requestId ?? `native-${message.nativeTurnId}`, source: existing?.source ?? (existing ? 'workbench' as const : 'codex' as const), createdAt: existing?.createdAt ?? message.createdAt }
    })
    if (merged.length + remaining.length > 200) throw new CodexSessionError(413, '同步后的对话超过工作台容量，请在 Codex 桌面继续')
    // Keep rejected/local-only attempts in their original chronological position.
    // Preserve native item ordering within a turn (both may share a timestamp).
    for (const local of remaining) {
      const before = merged.findIndex(message => Date.parse(message.createdAt) > Date.parse(local.createdAt))
      merged.splice(before < 0 ? merged.length : before, 0, local)
    }
    state.messages = merged
    state.desktop = { ...native.desktop, projectName: native.desktop.projectId === state.desktop?.projectId ? state.desktop?.projectName ?? null : null }
  }
  private async syncNative(state: CodexSessionState) {
    if (!state.threadId) return
    if (this.tasks.has(state.id)) throw new CodexSessionError(409, '工作台正在执行，请完成或停止后再同步桌面对话')
    try {
      const native = await (this.options.read ?? readCodexCircuitSession)(state.threadId, { ...this.options.runtimeOptions, workingDirectory: this.store.workspace(state.id) })
      if (native.desktop.syncStatus === 'busy') { state.desktop = native.desktop; await this.persist(state); throw new CodexSessionError(409, native.desktop.message) }
      this.mergeNative(state, native)
      await this.persist(state)
    } catch (error) {
      if (!(error instanceof CodexSessionError && error.status === 409)) {
        state.desktop = { projectId: state.desktop?.projectId ?? null, projectName: state.desktop?.projectName ?? null, syncStatus: 'unavailable', message: error instanceof CodexRuntimeError || error instanceof CodexSessionError ? error.message : '无法读取 Codex 保存的对话，请稍后重试。' }
        await this.persist(state)
      }
      throw error
    }
  }
  refresh(id: string) { return this.exclusive(async () => { const state = await this.obtain(id); await this.syncNative(state); return this.snapshot(state) }) }
  checkWriteAccess(id: string) {
    return this.exclusive(async () => {
      const state = await this.obtain(id)
      if (this.tasks.size) throw new CodexSessionError(409, '请先等待或停止正在执行的工作台任务')
      if (!state.threadId) throw new CodexSessionError(409, '发送首轮问题后才会创建持久会话，无需检查占用')
      state.writeAccess = await (this.options.checkWriteAccess ?? checkCodexWriteAccess)(state.threadId, { ...this.options.runtimeOptions, workingDirectory: this.store.workspace(state.id) })
      await this.persist(state)
      return this.snapshot(state)
    })
  }
  private async bindLink(state: CodexSessionState, binding: { origin: string; projectId: string }) {
    if (state.workbench && state.workbench.projectId !== binding.projectId) throw new CodexSessionError(409, '此会话已绑定另一个网页项目，请回到对应项目继续；未覆盖当前画布或会话。')
    let link
    try { link = createCodexWorkbenchLink(binding.origin, binding.projectId, state.id) }
    catch { throw new CodexSessionError(400, '工作台项目链接格式不正确') }
    const existing = await this.store.projectSession(binding.projectId)
    if (existing && existing !== state.id) throw new CodexSessionError(409, '此项目已有专属对话，请连接项目会话；原有聊天记录已保留。')
    await this.store.assertThreadOwner(state.threadId, binding.projectId, state.id)
    await this.store.claimProjectSession(binding.projectId, state.id)
    state.workbench = link
  }
  bindWorkbench(id: string, binding: { origin: string; projectId: string }) {
    return this.exclusive(async () => {
      const state = await this.obtain(id)
      await this.bindLink(state, binding)
      await this.persist(state)
      return this.snapshot(state)
    })
  }
  create(project: Project, binding?: { origin: string; projectId: string }) {
    return this.exclusive(async () => {
      const parsed = parseProject(project, { allowDraft: true })
      if (binding) {
        // Resolve before allocation/native creation: repeated clicks and browser
        // tabs use the same durable conversation, including after server restart.
        try { createCodexWorkbenchLink(binding.origin, binding.projectId, '00000000-0000-4000-8000-000000000000') }
        catch { throw new CodexSessionError(400, '工作台项目链接格式不正确') }
        const existing = await this.store.projectSession(binding.projectId)
        if (existing) {
          const state = await this.obtain(existing)
          await this.bindLink(state, binding); await this.persist(state)
          return this.snapshot(state)
        }
      }
      const id = await this.store.allocate()
      try {
        const created = await (this.options.create ?? createCodexCircuitSession)({ ...this.options.runtimeOptions, workingDirectory: this.store.workspace(id), projectDirectory: this.options.projectDirectory })
        const now = new Date().toISOString()
        const state: CodexSessionState = { id, threadId: created.threadId, model: created.model, reasoningEffort: 'medium', status: 'idle', messages: [], events: [], project: parsed,
          result: null, resultRequestId: null, lastSimulation: null, error: null, activeRequestId: null, createdAt: now, updatedAt: now, ...(created.desktop ? { desktop: created.desktop } : {}) }
        if (binding) await this.bindLink(state, binding)
        await this.persist(state); this.states.set(id, state)
        return this.snapshot(state)
      } catch (error) {
        if (binding) await this.store.releaseUncreatedProjectSession(binding.projectId, id).catch(() => {})
        await this.store.discardUncreated(id).catch(() => {}); throw error
      }
    })
  }
  send(input: { id: string; message: string; requestId: string; project?: Project; context?: string; revision?: unknown; workbench?: { origin: string; projectId: string } }) {
    return this.exclusive(async () => {
      const state = await this.obtain(input.id)
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 8000) throw new CodexSessionError(400, '请填写问题，长度不超过 8000 字符')
      if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) throw new CodexSessionError(400, '请求编号格式不正确')
      if (input.context !== undefined && (typeof input.context !== 'string' || input.context.length > 2400)) throw new CodexSessionError(400, '候选状态上下文格式不正确或超过 2400 字符')
      let revision: Project | undefined
      if (input.revision !== undefined) {
        const entry = input.revision as Record<string, unknown>
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(entry.requestId) || typeof entry.base !== 'string' || !isSchematicRedrawRequest(input.message)) throw new CodexSessionError(400, '重画候选请求格式不正确')
        try { revision = parseProject(entry.project, { allowDraft: true }) } catch { throw new CodexSessionError(400, '重画候选电路格式不正确') }
        if (entry.base !== aiProjectFingerprint(input.project ?? state.project)) throw new CodexSessionError(409, '当前画布已变化，请选择与当前画布匹配的候选重新排版')
      }
      if (input.workbench) await this.bindLink(state, input.workbench)
      else if (state.workbench) await this.bindLink(state, { origin: new URL(state.workbench.url).origin, projectId: state.workbench.projectId })
      const message = input.message.trim()
      const repeated = state.messages.find(item => item.role === 'user' && item.requestId === input.requestId)
      if (repeated) {
        if (repeated.content !== message) throw new CodexSessionError(409, '同一请求编号不能提交不同消息')
        const unsent = repeated.delivery === 'notSent' && !repeated.nativeItemId && !repeated.nativeTurnId
          && !state.messages.some(item => item.role === 'assistant' && item.requestId === input.requestId)
        if (!unsent) return structuredClone(state)
      }
      if (this.tasks.size) throw new CodexSessionError(409, '已有工作台 Codex 会话执行中，请停止或等待完成')
      if (state.threadId) await this.syncNative(state)
      // A retry of a rejected, locally retained prompt replaces that failed local
      // attempt. Messages already accepted into native history remain immutable.
      state.messages = state.messages.filter(item => !(item.role === 'user' && item.delivery === 'notSent' && !item.nativeItemId && !item.nativeTurnId && item.content.trim() === message && !state.messages.some(reply => reply.role === 'assistant' && reply.requestId === item.requestId)))
      if (state.messages.length >= 198) throw new CodexSessionError(409, '此会话已达到网页 100 轮容量，请在 Codex 桌面继续同一对话；项目绑定已保留。')
      if (Buffer.byteLength(JSON.stringify(state)) > 3 * 1024 * 1024) throw new CodexSessionError(413, '此会话记录接近网页容量限制，请在 Codex 桌面继续同一对话；项目绑定已保留。')
      if (input.project !== undefined) {
        const project = parseProject(input.project, { allowDraft: true })
        if (state.lastSimulation && projectKey(project) !== projectKey(state.project)) state.lastSimulation.stale = true
        state.project = project
      }
      state.status = 'running'; state.activeRequestId = input.requestId; state.events = []; state.error = null; state.result = null; state.resultRequestId = null
      delete state.writeAccess
      state.messages.push({ id: randomUUID(), requestId: input.requestId, role: 'user', content: message, createdAt: new Date().toISOString(), source: 'workbench' })
      const controller = new AbortController()
      // Reserve synchronously before any asynchronous persistence or native process work.
      const running = { controller, task: Promise.resolve(), requestId: input.requestId }
      this.tasks.set(state.id, running)
      try { await this.persist(state) } catch (error) { this.tasks.delete(state.id); state.status = 'error'; state.activeRequestId = null; throw error }
      const accepted = structuredClone(state)
      running.task = this.execute(state, input.requestId, message, controller, input.context, revision)
      return accepted
    })
  }
  private async execute(state: CodexSessionState, requestId: string, message: string, controller: AbortController, context?: string, revision?: Project) {
    try {
      const result = await (this.options.run ?? runCodexCircuitSession)({ threadId: state.threadId, model: state.model, project: structuredClone(state.project), message, context, revision: revision && structuredClone(revision), projectId: state.desktop?.projectId, workbench: state.workbench }, {
        ...this.options.runtimeOptions, workingDirectory: this.store.workspace(state.id), signal: controller.signal,
        onThreadStarted: async thread => {
          if (state.workbench) await this.store.assertThreadOwner(thread.threadId, state.workbench.projectId, state.id)
          state.threadId = thread.threadId; state.model = thread.model; await this.persist(state)
        },
        onEvent: event => {
          if (controller.signal.aborted || state.events.length >= 100) return
          state.events.push(structuredClone(event))
          void this.persist(state).catch(() => controller.abort())
        },
      })
      if (controller.signal.aborted) throw new CodexRuntimeError('任务已停止')
      if (result.simulation) state.lastSimulation = result.simulation
      else if (state.lastSimulation && projectKey(result.project) !== projectKey(state.project)) state.lastSimulation.stale = true
      state.result = result; state.resultRequestId = requestId; state.project = result.project
      state.status = result.type === 'interrupted' ? 'interrupted' : 'completed'
      state.messages.push({ id: randomUUID(), requestId, role: 'assistant', content: result.summary, createdAt: new Date().toISOString(), source: 'workbench' })
    } catch (error) {
      if (error instanceof CodexThreadInUseError) {
        state.writeAccess = { status: 'busy', checkedAt: new Date().toISOString(), message: error.message }
        state.desktop = { projectId: state.desktop?.projectId ?? null, projectName: state.desktop?.projectName ?? null, syncStatus: 'busy', message: error.message }
        const rejected = state.messages.find(item => item.role === 'user' && item.requestId === requestId)
        if (rejected) rejected.delivery = 'notSent'
      }
      state.status = controller.signal.aborted ? 'cancelled' : 'error'
      state.error = controller.signal.aborted ? '本轮已停止；会话和之前记录已保留。'
        : error instanceof CodexRuntimeError || error instanceof CodexSessionError ? error.message.slice(0,8000) : '工作台 Codex 本轮执行失败，可在同一会话重新提问。'
    } finally {
      state.activeRequestId = null
      await this.persist(state).catch(() => { state.status = 'error'; state.error = '会话记录保存失败，请检查本地工作台存储。' })
      this.tasks.delete(state.id)
    }
  }
  cancel(id: string) {
    return this.exclusive(async () => {
      const state = await this.obtain(id)
      this.tasks.get(id)?.controller.abort()
      return this.snapshot(state)
    })
  }
  async close() {
    await this.mutation
    for (const task of this.tasks.values()) task.controller.abort()
    await Promise.allSettled([...this.tasks.values()].map(task => task.task))
    await Promise.allSettled(this.saving.values())
  }
}
