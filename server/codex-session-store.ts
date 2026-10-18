import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CircuitAgentEvent } from '../src/core/agent-circuit'
import { parseProject, type Project } from '../src/core/circuit'
import type { runCodexCircuitSession } from './codex-session-runtime'
import type { CodexDesktopState, CodexWriteAccess } from './codex-session-native'
import { parseCodexWorkbenchLink, validWorkbenchProjectId, type CodexWorkbenchLink } from '../src/core/codex-workbench-link'

export type CodexSessionResult = Awaited<ReturnType<typeof runCodexCircuitSession>>
export interface CodexSessionMessage { id: string; requestId: string; role: 'user' | 'assistant'; content: string; createdAt: string; nativeItemId?: string; nativeTurnId?: string; source?: 'workbench' | 'codex'; delivery?: 'notSent' }
export interface CodexSessionState {
  id: string; threadId: string; model: string; reasoningEffort: 'medium'
  status: 'idle' | 'running' | 'completed' | 'interrupted' | 'error' | 'cancelled'
  messages: CodexSessionMessage[]; events: CircuitAgentEvent[]; project: Project
  result: CodexSessionResult | null; error: string | null; activeRequestId: string | null
  resultRequestId?: string | null
  lastSimulation: CodexSessionResult['simulation']
  createdAt: string; updatedAt: string
  desktop?: CodexDesktopState
  writeAccess?: CodexWriteAccess
  workbench?: CodexWorkbenchLink
}
export class CodexSessionError extends Error { constructor(public status: number, message: string) { super(message) } }
export function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new CodexSessionError(400, '工作台会话编号格式不正确')
  return value
}

/** Only app records and owned thread IDs are stored here; Codex owns its actual history. */
export class CodexSessionStore {
  readonly directory: string
  private bindings: Record<string, string> | null = null
  constructor(directory: string) { this.directory = resolve(directory) }
  workspace(id: string) { return join(this.directory, sessionId(id), 'workspace') }
  private path(id: string) { return join(this.directory, sessionId(id), 'session.json') }
  /** Persist the first resolved association so later history sync cannot change ownership. */
  private async projectBindings() {
    if (this.bindings) return this.bindings
    await mkdir(this.directory, { recursive: true })
    const path = join(this.directory, 'project-bindings.json')
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid bindings')
      for (const [projectId, id] of Object.entries(value)) { if (!validWorkbenchProjectId(projectId)) throw new Error('invalid project'); sessionId(id) }
      if (new Set(Object.values(value)).size !== Object.keys(value).length) throw new Error('duplicate session')
      this.bindings = Object.assign(Object.create(null), value) as Record<string,string>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CodexSessionError(500, '项目与会话关联记录无法读取，原文件已保留，请先恢复关联记录。')
      // Legacy projects may contain several historical sessions. Keep every history;
      // the latest saved association becomes canonical exactly once during migration.
      const states: CodexSessionState[] = []
      for (const id of (await readdir(this.directory)).filter(name => /^[a-f0-9-]{36}$/i.test(name))) {
        try { states.push(await this.load(id)) }
        catch (reason) { if (!(reason instanceof CodexSessionError && reason.status === 404)) throw reason }
      }
      states.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      this.bindings = Object.create(null) as Record<string,string>
      const threads = new Set<string>()
      for (const state of states) if (state.workbench && !this.bindings[state.workbench.projectId] && (!state.threadId || !threads.has(state.threadId))) {
        this.bindings[state.workbench.projectId] = state.id
        if (state.threadId) threads.add(state.threadId)
      }
      await this.saveProjectBindings()
    }
    return this.bindings!
  }
  private async saveProjectBindings() {
    const path = join(this.directory, 'project-bindings.json'), temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(this.bindings), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  }
  async projectSession(projectId: string) {
    const bindings = await this.projectBindings(), id = bindings[projectId]
    if (!id) return undefined
    try { await this.load(id); return id }
    catch (error) {
      if (!(error instanceof CodexSessionError && error.status === 404)) throw error
      // A process may die after claiming a new binding but before session.json is
      // written. Repair only an absent record; never replace a damaged history.
      delete bindings[projectId]; await this.saveProjectBindings(); return undefined
    }
  }
  async claimProjectSession(projectId: string, id: string) {
    const bindings = await this.projectBindings()
    if (bindings[projectId] && bindings[projectId] !== id) throw new CodexSessionError(409, '此项目已有专属对话，请连接项目会话；不能将一个项目绑定到多个对话。')
    if (Object.entries(bindings).some(([owner, session]) => session === id && owner !== projectId)) throw new CodexSessionError(409, '此会话已绑定另一个网页项目，请回到对应项目继续。')
    bindings[projectId] = sessionId(id)
    await this.saveProjectBindings()
  }
  async releaseUncreatedProjectSession(projectId: string, id: string) {
    const bindings = await this.projectBindings()
    if (bindings[projectId] !== id) return
    delete bindings[projectId]
    await this.saveProjectBindings()
  }
  async assertThreadOwner(threadId: string, projectId: string, id: string) {
    if (!threadId) return
    for (const [owner, session] of Object.entries(await this.projectBindings())) {
      if (session === id) continue
      const state = await this.load(session)
      if (state.threadId === threadId && owner !== projectId) throw new CodexSessionError(409, '此 Codex 对话已属于另一个项目，未关联或发送当前项目的内容。')
    }
  }
  async allocate() {
    await mkdir(this.directory, { recursive: true })
    if ((await readdir(this.directory)).filter(name => /^[a-f0-9-]{36}$/i.test(name)).length >= 50) throw new CodexSessionError(409, '工作台会话数量已达 50 个，请继续已有会话')
    const id = randomUUID()
    await mkdir(this.workspace(id), { recursive: true })
    return id
  }
  async discardUncreated(id: string) {
    // id is our freshly allocated UUID, never a caller-provided path.
    await rm(join(this.directory, sessionId(id)), { recursive: true, force: true })
  }
  async load(id: string): Promise<CodexSessionState> {
    const path = this.path(id)
    try {
      if ((await stat(path)).size > 4 * 1024 * 1024) throw new Error('oversized')
      const value = JSON.parse(await readFile(path, 'utf8')) as CodexSessionState
      if (value.id !== id || typeof value.threadId !== 'string' || typeof value.model !== 'string' || !Array.isArray(value.messages) || value.messages.length > 200 || !Array.isArray(value.events)) throw new Error('invalid session')
      value.project = parseProject(value.project, { allowDraft: true })
      if (value.workbench) value.workbench = parseCodexWorkbenchLink(value.workbench, id)
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CodexSessionError(404, '未找到此工作台会话，请新建会话')
      if (error instanceof CodexSessionError) throw error
      throw new CodexSessionError(500, '工作台会话记录无法读取，请保留文件并新建会话')
    }
  }
  async save(state: CodexSessionState) {
    state.updatedAt = new Date().toISOString()
    const path = this.path(state.id), temporary = `${path}.${randomUUID()}.tmp`
    const text = JSON.stringify(state)
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new CodexSessionError(413, '工作台会话记录超过大小限制')
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  }
}
