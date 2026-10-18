import { circuitAgentTools } from '../src/core/agent-circuit'
import { isLayoutOnlyFeedback } from '../src/core/redraw-intent'
import type { DesktopCircuitManager } from './desktop-circuit-manager'
import type { DesktopControlBroker } from './desktop-control-manager'

type Turn = { threadId: string; taskId?: string; inspectedRevision?: number; request?: { message: string; redrawTaskId?: string }; summary: string; finalizing?: boolean; pending: Promise<unknown> }
type ToolResult = { contentItems: { type: 'inputText'; text: string }[]; success: boolean }
const failure = (text: string): ToolResult => ({ contentItems: [{ type: 'inputText', text: text.slice(0, 2000) }], success: false })
/** Existing durable Codex threads keep their dynamic tools. Bind their callbacks to
 * the same candidate manager used by the CLI; no new native writer is opened. */
export class DesktopControlCircuit {
  readonly names = circuitAgentTools.map(tool => tool.name)
  private turns = new Map<string, Turn>()
  private results = new Map<string, { arguments: string; result: Promise<ToolResult> }>()
  private completedTurns = new Set<string>()
  constructor(private manager: DesktopCircuitManager, private projectForThread: (threadId: string) => string | undefined, private requestForTurn: (threadId: string, turnId: string) => { message: string; redrawTaskId?: string } | undefined, private onError: (threadId: string, error: string) => void) {}
  async register(client: DesktopControlBroker, threadId: string) {
    if (!client.registerTools) throw new Error('当前共享服务不支持旧电路动态工具回调')
    await client.registerTools(threadId, this.names)
  }
  private state(threadId: string, turnId: string) {
    let state = this.turns.get(turnId)
    if (!state) {
      // A desktop user may start the next turn immediately after native completion.
      // Wait for candidate finishing from the preceding turn before another edit.
      const previous = [...this.turns.values()].filter(value => value.threadId === threadId).map(value => value.pending)
      state = { threadId, summary: '', pending: Promise.allSettled(previous) }; this.turns.set(turnId, state)
    }
    return state
  }
  private async turnRequest(client: DesktopControlBroker, threadId: string, turnId: string, state: Turn) {
    if (state.request) return state.request
    const saved = this.requestForTurn(threadId, turnId)
    if (saved) return state.request = saved
    const result = await client.call('thread/turns/list', { threadId, limit: 10, sortDirection: 'desc', itemsView: 'summary' })
    const turn = result.data?.find((item: any) => item.id === turnId)
    const message = (turn?.items ?? []).filter((item: any) => item.type === 'userMessage').flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
    if (!message?.trim()) return { message: '' }
    const match = message.match(/\[重画来源\]本轮应以候选任务 ([a-zA-Z0-9._:-]+) 为起点/)
    return state.request = { message, ...(match ? { redrawTaskId: match[1] } : {}) }
  }
  private finalize(threadId: string, turn: any): Promise<unknown> | undefined {
    const state = this.turns.get(turn.id)
    if (!state || state.threadId !== threadId || !['completed', 'interrupted', 'failed', 'cancelled'].includes(turn.status)) return undefined
    if (state.finalizing) return state.pending
    state.finalizing = true
    const finalMessage = (Array.isArray(turn.items) ? turn.items : []).filter((item: any) => item.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string').at(-1)
    if (finalMessage) state.summary = finalMessage.text
    state.pending = state.pending.catch(() => {}).then(async () => {
      if (!state.taskId) return
      if (turn.status === 'completed') await this.manager.finish(state.taskId, state.summary || 'Codex 已完成本轮电路工具操作，请审阅候选')
      else await this.manager.cancel(state.taskId)
    }).catch(async error => {
      this.onError(threadId, `候选未完成：${error instanceof Error ? error.message.slice(0, 1500) : '工具校验失败'}`)
      if (state.taskId) await this.manager.cancel(state.taskId).catch(() => {})
    }).finally(() => {
      this.turns.delete(turn.id); this.completedTurns.add(JSON.stringify([threadId, turn.id]))
      for (const key of this.results.keys()) { const ids = JSON.parse(key); if (ids[0] === threadId && ids[1] === turn.id) this.results.delete(key) }
    })
    return state.pending
  }
  /** History is authoritative when a disconnect hid the live completion event. */
  async reconcile(threadId: string, turns: any[]) {
    await Promise.allSettled(turns.map(turn => this.finalize(threadId, turn)).filter((pending): pending is Promise<unknown> => !!pending))
  }
  onEvent(client: DesktopControlBroker, event: any): boolean {
    const message = event.message, params = message?.params
    if (event.type === 'notification') {
      if (message?.method === 'item/completed' && params?.item?.type === 'agentMessage' && this.projectForThread(params.threadId) && typeof params.turnId === 'string' && !this.completedTurns.has(JSON.stringify([params.threadId, params.turnId]))) this.state(params.threadId, params.turnId).summary = String(params.item.text ?? '')
      if (message?.method === 'turn/completed' && typeof params?.turn?.id === 'string') {
        this.finalize(params.threadId, params.turn)
      }
      return false
    }
    if (event.type !== 'server-request' || message?.method !== 'item/tool/call') return false
    const projectId = params && this.projectForThread(params.threadId)
    if (!params || !this.names.includes(params.tool) || (params.namespace && params.namespace !== 'functions') || !projectId || typeof params.turnId !== 'string') {
      void Promise.resolve(client.respond(message.id, { result: failure('电路工具与当前已绑定项目或命名空间不匹配，未执行修改') })).catch(() => {})
      return true
    }
    if (this.completedTurns.has(JSON.stringify([params.threadId, params.turnId]))) {
      void Promise.resolve(client.respond(message.id, { result: failure('本轮已完成，未重新执行旧工具请求；请在新回合读取当前画布') })).catch(() => {})
      return true
    }
    const key = JSON.stringify([params.threadId, params.turnId, typeof message.id, message.id]), signature = JSON.stringify([params.tool, params.arguments])
    const cached = this.results.get(key)
    if (cached) {
      void cached.result.then(result => client.respond(message.id, { result: cached.arguments === signature ? result : failure('重复工具请求编号的参数已改变，未重复执行') })).catch(() => {})
      return true
    }
    const state = this.state(params.threadId, params.turnId)
    const operation = state.pending.catch(() => {}).then(async (): Promise<ToolResult> => {
      try {
        let output: unknown
        if (!state.taskId && params.tool === 'inspect_circuit') {
          const request = await this.turnRequest(client, params.threadId, params.turnId, state)
          const inspected = await this.manager.inspect(projectId, request.redrawTaskId)
          state.inspectedRevision = inspected.snapshot.revision; output = inspected.inspection
        }
        else {
          if (!state.taskId) {
            if (!state.inspectedRevision) throw new Error('请先调用 inspect_circuit 阅读当前画布，再修改候选；未根据未读画布建立任务')
            const request = await this.turnRequest(client, params.threadId, params.turnId, state)
            if (!request.message.trim()) throw new Error('无法核对本轮用户请求，未建立候选；请重试并明确电路修改要求')
            const started = await this.manager.start({ projectId, expectedRevision: state.inspectedRevision, requestId: `desktop-turn-${params.turnId}`, request: request.message.slice(0, 8000), layoutOnly: isLayoutOnlyFeedback(request.message), ...(request.redrawTaskId ? { sourceTaskId: request.redrawTaskId } : {}) })
            state.taskId = started.task.id
          }
          output = (await this.manager.call(state.taskId, params.tool, params.arguments)).output
        }
        return { contentItems: [{ type: 'inputText', text: JSON.stringify(output) }], success: true }
      } catch (error) {
        return failure(error instanceof Error ? error.message : '电路工具执行失败')
      }
    })
    this.results.set(key, { arguments: signature, result: operation })
    state.pending = operation.then(result => client.respond(message.id, { result })).catch(() => {})
    return true
  }
  async drain(threadId: string) { await Promise.allSettled([...this.turns.values()].filter(state => state.threadId === threadId).map(state => state.pending)) }
  async close() { for (const state of this.turns.values()) if (state.taskId) await this.manager.cancel(state.taskId).catch(() => {}); await Promise.allSettled([...this.turns.values()].map(state => state.pending)); this.turns.clear(); this.results.clear(); this.completedTurns.clear() }
}
