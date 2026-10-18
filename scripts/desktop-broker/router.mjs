// ID multiplexing derived from DusuWorks/codex-webui (MIT); see NOTICE.md.
const readMethods = new Set(['thread/read', 'thread/list', 'thread/loaded/list', 'thread/turns/list', 'model/list', 'config/read', 'account/read', 'account/rateLimits/read', 'server/read'])
const metadataMethods = new Set(['thread/name/set'])
const webMethods = new Set([...readMethods, ...metadataMethods, 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt', 'turn/steer'])
const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval', 'item/tool/requestUserInput'])
const circuitToolNames = new Set(['inspect_circuit', 'set_component_value', 'replace_candidate', 'set_measurement_probes', 'configure_waveforms', 'validate_circuit', 'simulate_circuit', 'search_spice_models', 'download_spice_model', 'import_spice_model'])
const threadIdOf = params => params?.threadId ?? params?.thread_id ?? params?.conversationId ?? params?.conversation_id ?? params?.thread?.id ?? null
const key = id => `${typeof id}:${id}`

export class DesktopRouter {
  constructor({ child, desktop, broadcast, sendWeb }) {
    Object.assign(this, { child, desktop, broadcast, sendWeb })
    this.ready = false; this.desktopConnected = true; this.nextId = 1
    this.pending = new Map(); this.requests = new Map(); this.threads = new Map(); this.toolHandlers = new Map()
  }
  state(threadId) {
    const t = this.threads.get(threadId)
    return { connected: true, ready: this.ready, desktopConnected: this.desktopConnected, threadId,
      owner: t?.owner ?? 'desktop', busy: Boolean(t?.busy), pendingOwner: t?.pendingOwner ?? null,
      pendingApprovals: [...this.requests.values()].filter(r => r.threadId === threadId && r.approval).length,
      loaded: Boolean(t?.loaded) }
  }
  track(threadId, owner = 'desktop') {
    if (!threadId) return null
    if (!this.threads.has(threadId)) this.threads.set(threadId, { owner, ownerRevision: 0, activityRevision: 0, busy: false, loaded: false, pendingOwner: null })
    return this.threads.get(threadId)
  }
  changed(threadId) { this.broadcast({ type: 'control', state: this.state(threadId) }) }
  settle(threadId) {
    const t = this.threads.get(threadId)
    if (t?.pendingOwner && !t.busy && ![...this.requests.values()].some(r => r.threadId === threadId)) {
      t.owner = t.pendingOwner; t.pendingOwner = null
    }
    this.changed(threadId)
  }
  handoff(threadId, owner) {
    if (!['desktop', 'web'].includes(owner) || typeof threadId !== 'string') throw new Error('控制权参数无效')
    const t = this.threads.get(threadId)
    if (!this.ready || !this.desktopConnected || !t?.loaded) throw new Error('请先在已连接的 Codex 桌面打开这段会话，再切换控制权')
    t.ownerRevision++
    t.pendingOwner = owner === t.owner ? null : owner
    this.settle(threadId)
    return this.state(threadId)
  }
  registerTools(client, threadId, names) {
    if (typeof threadId !== 'string' || !Array.isArray(names) || names.some(n => !circuitToolNames.has(n))) throw new Error('只能注册已知电路工具')
    const previousClient = this.toolHandlers.get(threadId)?.client
    this.toolHandlers.set(threadId, { client, names: new Set(names) })
    // Polling refreshes registration. Replaying to the same live handler would
    // enqueue the same simulation/download again while its first call is running.
    if (previousClient === client) return
    for (const req of this.requests.values()) if (req.owner === 'tools' && req.threadId === threadId && names.includes(req.message.params?.tool)) {
      req.client = client; this.sendWeb(client, { type: 'server-request', message: req.message })
    }
  }
  detach(client) {
    for (const handler of this.toolHandlers.values()) if (handler.client === client) handler.client = null
    for (const route of this.pending.values()) if (route.client === client) route.client = null
  }
  reply(route, message) {
    if (route.owner === 'desktop') this.desktop({ id: route.id, ...message })
    else this.sendWeb(route.client, { type: 'response', requestId: route.id, ...message })
  }
  reject(route, text, code = -32041) { this.reply(route, { error: { code, message: text } }) }
  fromClient(owner, message, client) {
    const route = { owner, client, id: message.id, method: message.method, threadId: threadIdOf(message.params) }
    if (message.id !== undefined && !message.method) return this.respond(owner, message.id, message, client)
    if (!message.method) return
    if (owner === 'web' && !webMethods.has(message.method)) return this.reject(route, '网页不支持此 Codex 操作', -32601)
    if (owner === 'web' && !this.ready) return this.reject(route, 'Codex 桌面尚未完成连接', -32042)
    const t = route.threadId && this.threads.get(route.threadId)
    // A desktop window can subscribe/read while the web owns a thread. Resume with
    // overrides, unsubscribe, interrupt, steering, rollback and all other writes
    // must not change the other client's active task.
    const plainResume = message.method === 'thread/resume' && Object.keys(message.params ?? {}).every(k => ['threadId', 'excludeTurns', 'initialTurnsPage'].includes(k))
    // Naming a project chat changes only sidebar metadata, not its active turn.
    const readonly = readMethods.has(message.method) || metadataMethods.has(message.method) || plainResume
    if (t && t.owner !== owner && !readonly) {
      if (message.id !== undefined) this.reject(route, '此会话的控制权在另一端，请先切换控制权')
      return
    }
    if (owner === 'web' && message.method !== 'thread/start' && !readonly && !t?.loaded) return this.reject(route, '会话尚未由共享 Codex 服务加载', -32042)
    if (message.method === 'turn/start') {
      if (t?.busy) return this.reject(route, '当前回合尚未完成，请等待或停止后重试', -32043)
      if (t?.pendingOwner) return this.reject(route, '正在等待控制权切换，请先完成切换再发送', -32043)
      if (t) { t.busy = true; t.turnOwner = owner; t.activityRevision++; this.changed(route.threadId) }
    }
    if (message.id === undefined) { this.child(message); return }
    const id = this.nextId++
    // A read started before a turn must not later reset that newer turn's state.
    if (message.method === 'thread/read' || message.method === 'turn/start') route.activityRevision = t?.activityRevision
    this.pending.set(id, route)
    this.child({ ...message, id })
  }
  respond(owner, id, response, client) {
    const request = this.requests.get(key(id))
    if (!request || !(request.owner === owner || (owner === 'web' && request.owner === 'tools' && request.client === client))) {
      if (owner === 'web') this.sendWeb(client, { type: 'response', requestId: response.requestId, error: { code: -32041, message: '此审批已结束或属于另一端' } })
      return false
    }
    this.requests.delete(key(id))
    this.child({ id, ...(response.error ? { error: response.error } : { result: response.result }) })
    this.broadcast({ type: 'server-request-resolved', id })
    if (request.threadId) this.settle(request.threadId)
    return true
  }
  fromChild(message) {
    if (message.id !== undefined && !message.method) {
      const route = this.pending.get(message.id)
      if (!route) return
      this.pending.delete(message.id)
      if (route.method === 'initialize' && !message.error) this.ready = true
      const thread = message.result?.thread
      const threadId = thread?.id ?? route.threadId
      if (threadId && ['thread/start', 'thread/resume', 'thread/read'].includes(route.method) && !message.error) {
        const t = this.track(threadId, route.method === 'thread/start' ? route.owner : 'desktop')
        if (route.method === 'thread/start' && !t.ownerRevision) t.owner = route.owner
        if (route.method !== 'thread/read') t.loaded = thread?.status?.type !== 'notLoaded'
        if (route.method === 'thread/read' && route.activityRevision === t.activityRevision) {
          // The native status repairs missed completion/unload notifications after
          // a web reconnect. Never let an older read undo a newer turn/start.
          const status = thread?.status?.type
          if (status === 'active') t.busy = true
          if (status === 'idle' || status === 'systemError' || status === 'notLoaded') {
            t.busy = false; delete t.turnOwner; t.activityRevision++
            if (status === 'notLoaded') { t.loaded = false; t.pendingOwner = null }
            else this.settle(threadId)
          }
        } else if (route.method !== 'thread/read' && thread?.status?.type === 'active') t.busy = true
        this.changed(threadId)
      }
      if (route.method === 'turn/start' && message.error && threadId) {
        const t = this.threads.get(threadId)
        if (t && route.activityRevision === t.activityRevision) {
          t.busy = false; delete t.turnOwner; t.activityRevision++
          this.settle(threadId)
        }
      }
      this.reply(route, message.error ? { error: message.error } : { result: message.result })
      return
    }
    const threadId = threadIdOf(message.params)
    if (message.id !== undefined && message.method) {
      const t = threadId && this.threads.get(threadId)
      const approval = approvalMethods.has(message.method)
      const toolHandler = message.method === 'item/tool/call' && this.toolHandlers.get(threadId)
      if (toolHandler && toolHandler.names.has(message.params?.tool)) {
        this.requests.set(key(message.id), { owner: 'tools', client: toolHandler.client, threadId, approval: false, message })
        if (toolHandler.client) this.sendWeb(toolHandler.client, { type: 'server-request', message })
        else {
          // An unavailable circuit handler must not silently leave Codex waiting.
          this.requests.delete(key(message.id)); this.child({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: '电路工作台工具服务已断开，请重新连接后重试；未修改或仿真电路。' }] } })
        }
        return
      }
      // Unknown dynamic tools and desktop integrations must keep the official
      // app's tool host. Only explicitly supported approvals use turn ownership.
      const owner = approval ? t?.turnOwner ?? t?.owner ?? 'desktop' : 'desktop'
      this.requests.set(key(message.id), { owner, threadId, approval, message })
      if (owner === 'desktop') this.desktop(message)
      else this.broadcast({ type: 'server-request', message })
      if (threadId) this.changed(threadId)
      return
    }
    if (threadId) {
      const t = this.track(threadId)
      if (message.method === 'thread/started') t.loaded = true
      if (message.method === 'turn/started') { t.busy = true; t.turnOwner ??= t.owner; t.loaded = true; t.activityRevision++ }
      if (message.method === 'turn/completed') {
        t.busy = false; delete t.turnOwner; t.activityRevision++
        for (const [id, req] of this.requests) if (req.threadId === threadId) { this.requests.delete(id); this.broadcast({ type: 'server-request-resolved', id: req.message.id }) }
        this.settle(threadId)
      }
      if (message.method === 'thread/status/changed') {
        const status = message.params?.status?.type
        if (status === 'active') { t.busy = true; t.activityRevision++ }
        if (status === 'idle' || status === 'systemError') { t.busy = false; delete t.turnOwner; t.activityRevision++; this.settle(threadId) }
        if (status === 'notLoaded') { t.loaded = false; t.busy = false; delete t.turnOwner; t.pendingOwner = null; t.activityRevision++ }
      }
      this.changed(threadId)
    }
    this.desktop(message)
    this.broadcast({ type: 'notification', message })
  }
  pendingForWeb() { return [...this.requests.values()].filter(r => r.owner === 'web').map(r => ({ type: 'server-request', message: r.message })) }
}
