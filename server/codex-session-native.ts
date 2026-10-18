import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { CodexRuntimeError, openRuntime, type CodexRuntimeOptions } from './codex-runtime'
import { CodexThreadInUseError } from './codex-rpc'

export interface CodexWriteAccess {
  status: 'available' | 'busy'
  checkedAt: string
  message: string
}

export interface CodexDesktopState {
  projectId: string | null
  projectName: string | null
  syncedAt?: string
  syncStatus: 'unverified' | 'synced' | 'busy' | 'unavailable'
  message: string
}
export interface NativeSessionMessage {
  nativeItemId: string; nativeTurnId: string; role: 'user' | 'assistant'; content: string; createdAt: string
}
export interface NativeSessionSnapshot { messages: NativeSessionMessage[]; desktop: CodexDesktopState }
const pathKey = (path: string) => resolve(path).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()

/** A one-shot official resume handshake; it never starts a turn or retains the writer. */
export async function checkCodexWriteAccess(threadId: string, options: CodexRuntimeOptions): Promise<CodexWriteAccess> {
  if (!/^[a-f0-9-]{36}$/i.test(threadId)) throw new CodexRuntimeError('此会话尚无有效的 Codex Thread')
  const runtime = await openRuntime({ ...options, timeoutMs: 20000 })
  try {
    const { thread } = await runtime.rpc.call('thread/resume', { threadId, excludeTurns: true })
    if (thread?.id !== threadId || thread.ephemeral) throw new CodexRuntimeError('Codex 未恢复当前持久会话，已停止检查')
    return { status: 'available', checkedAt: new Date().toISOString(), message: '当前可从网页继续同一段对话。未发送任何问题；请检查输入框后发送。再次在桌面续聊可能重新占用。' }
  } catch (error) {
    if (error instanceof CodexThreadInUseError) return { status: 'busy', checkedAt: new Date().toISOString(), message: '桌面仍持有这段会话，网页无法强制解除。请先保存工作并结束桌面任务，再完全退出 Codex 桌面进程，然后从外部浏览器打开工作台，重新检查。收起面板或切换聊天不会可靠释放。' }
    throw error
  } finally {
    // unsubscribe acknowledges subscription removal but did not release the writer
    // in the installed CLI. Closing only our own child is required and verified.
    await runtime.close()
  }
}

/** Resolve a Git worktree to its registered repository without reading desktop configuration. */
export async function codexProjectBinding(directory: string, options: CodexRuntimeOptions) {
  const common = await new Promise<string | null>(done => execFile('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: directory, windowsHide: true, timeout: 5000 }, (error, stdout) => done(error ? null : stdout.trim())))
  const roots = new Set([pathKey(directory), ...(common ? [pathKey(dirname(common))] : [])])
  const runtime = await openRuntime({ ...options, timeoutMs: 20000 })
  try {
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const result = await runtime.rpc.call('project/list', { limit: 100, ...(cursor ? { cursor } : {}) })
      const matches = (result.data ?? []).filter((project: any) => Array.isArray(project.roots) && project.roots.some((root: any) => typeof root.path === 'string' && roots.has(pathKey(root.path))))
      if (matches.length === 1) return { projectId: String(matches[0].id), projectName: String(matches[0].name).slice(0, 120) }
      if (matches.length > 1) return { projectId: null, projectName: null }
      cursor = result.nextCursor ?? undefined
      if (!cursor) break
    }
    return { projectId: null, projectName: null }
  } finally { await runtime.close() }
}

/** Read only the application's recorded thread ID. Summary view excludes reasoning and tool payloads. */
export async function readCodexCircuitSession(threadId: string, options: CodexRuntimeOptions): Promise<NativeSessionSnapshot> {
  if (!/^[a-f0-9-]{36}$/i.test(threadId)) throw new CodexRuntimeError('此会话尚无有效的 Codex Thread')
  const runtime = await openRuntime({ ...options, timeoutMs: 25000 })
  try {
    const { thread } = await runtime.rpc.call('thread/read', { threadId, includeTurns: false })
    if (thread?.id !== threadId || thread.ephemeral) throw new CodexRuntimeError('Codex 返回的持久会话与当前工作台不一致')
    const turns: any[] = []
    let cursor: string | undefined
    for (let page = 0; page < 6; page++) {
      const result = await runtime.rpc.call('thread/turns/list', { threadId, limit: 40, sortDirection: 'desc', itemsView: 'summary', ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(result.data)) throw new CodexRuntimeError('Codex 会话历史格式不正确')
      turns.push(...result.data)
      cursor = result.nextCursor ?? undefined
      if (!cursor) break
    }
    if (cursor) throw new CodexRuntimeError('此会话过长，暂不能完整同步；请保留桌面对话')
    const busy = thread.status?.type === 'active' || turns[0]?.status === 'inProgress'
    const messages: NativeSessionMessage[] = []
    for (const turn of turns.reverse()) {
      for (const item of turn.items ?? []) {
        let role: 'user' | 'assistant', content: string
        if (item.type === 'userMessage') { role = 'user'; content = (item.content ?? []).filter((part: any) => part.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n') }
        else if (item.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string') { role = 'assistant'; content = item.text }
        else continue
        if (!content.trim()) continue
        const timestamp = Number(turn.startedAt ?? thread.updatedAt) * 1000
        messages.push({ nativeItemId: String(item.id), nativeTurnId: String(turn.id), role, content: content.trim().slice(0, 8000), createdAt: Number.isFinite(timestamp) && Math.abs(timestamp) < 8640000000000000 ? new Date(timestamp).toISOString() : new Date().toISOString() })
      }
    }
    if (messages.length > 198) throw new CodexRuntimeError('会话已接近 100 轮限制，请在 Codex 中继续或新建工作台会话')
    return { messages, desktop: { projectId: typeof thread.projectId === 'string' ? thread.projectId : null, projectName: null, syncedAt: new Date().toISOString(), syncStatus: busy ? 'busy' : 'synced',
      message: busy ? 'Codex 历史显示有回合执行中，请等待桌面完成。' : '已同步同一 Thread 的公开记录；网页执行仍须 Codex 释放此会话的写入占用。同步成功不表示已交接执行权。' } }
  } finally { await runtime.close() }
}
