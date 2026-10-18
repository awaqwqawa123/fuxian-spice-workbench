import { parseProject, type Project } from './circuit'
import { parseAgentSimulation, type AgentSimulation, type AgentToolEvent } from './agent-client'
import { parseCodexWorkbenchLink, type CodexWorkbenchLink } from './codex-workbench-link'
import { parseAgentModelAcquisitions, type AgentModelAcquisition } from './agent-models'

export type CodexSessionStatus = 'idle' | 'running' | 'completed' | 'interrupted' | 'error' | 'cancelled'
export interface CodexSessionMessage { id: string; requestId: string; role: 'user' | 'assistant'; content: string; createdAt: number; delivery?: 'notSent' }
export interface CodexSessionState {
  id: string; threadId: string; model: string; reasoningEffort: string; status: CodexSessionStatus
  messages: CodexSessionMessage[]; events: AgentToolEvent[]; project: Project
  result: null | { type: 'done' | 'interrupted'; summary: string; project: Project; changed: boolean; simulation: AgentSimulation | null; base: string; reason?: 'timeout'; modelAcquisitions?: AgentModelAcquisition[] }
  lastSimulation: AgentSimulation | null
  error: string | null; activeRequestId: string | null; createdAt: number; updatedAt: number
  resultRequestId?: string | null
  desktop?: { projectId: string | null; projectName: string | null; syncedAt?: string; syncStatus: 'unverified' | 'synced' | 'busy' | 'unavailable'; message: string }
  writeAccess?: { status: 'available' | 'busy'; checkedAt: string; message: string }
  workbench?: CodexWorkbenchLink
}
export const CODEX_SESSION_STORAGE = 'fuxian.codex-session-lab.v1'
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 8000): value is string => typeof value === 'string' && value.length <= max
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const timestamp = (value: unknown) => typeof value === 'string' ? Date.parse(value) : finite(value) ? value : NaN

function parseSimulation(value: unknown): AgentSimulation | null {
  try {
    const parsed = parseAgentSimulation(value)
    if (parsed && parsed.points <= 0) throw new Error('采样点为空')
    return parsed
  } catch (error) { throw new Error(`会话仿真采样格式不正确：${(error as Error).message}`) }
}

export function parseCodexSessionState(raw: unknown): CodexSessionState {
  if (!record(raw) || !text(raw.id, 200) || !raw.id || !text(raw.threadId, 200) || !text(raw.model, 200) || !text(raw.reasoningEffort, 40) || !['idle', 'running', 'completed', 'interrupted', 'error', 'cancelled'].includes(String(raw.status)) || !finite(timestamp(raw.createdAt)) || !finite(timestamp(raw.updatedAt)) || !(raw.error === null || text(raw.error)) || !(raw.activeRequestId === null || text(raw.activeRequestId, 200))) throw new Error('Codex 会话状态格式不正确')
  if (!Array.isArray(raw.messages) || raw.messages.length > 1000 || raw.messages.some(message => !record(message) || !text(message.id, 200) || !text(message.requestId, 200) || !['user', 'assistant'].includes(String(message.role)) || !text(message.content, 100_000) || !finite(timestamp(message.createdAt)))) throw new Error('Codex 会话消息格式不正确')
  if (!Array.isArray(raw.events) || raw.events.length > 1000 || raw.events.some(event => !record(event) || event.type !== 'tool' || !text(event.name, 100) || !text(event.detail) || !['running', 'completed', 'error'].includes(String(event.status)))) throw new Error('Codex 会话工具记录格式不正确')
  if (raw.resultRequestId !== undefined && raw.resultRequestId !== null && !text(raw.resultRequestId, 200)) throw new Error('Codex 会话结果编号格式不正确')
  let result: CodexSessionState['result'] = null
  if (raw.result !== null) {
    const candidate = raw.result
    if (!record(candidate) || !['done', 'interrupted'].includes(String(candidate.type)) || !text(candidate.summary) || typeof candidate.changed !== 'boolean' || !text(candidate.base, 300_000) || candidate.type === 'interrupted' && candidate.reason !== 'timeout') throw new Error('Codex 会话候选格式不正确')
    const modelAcquisitions = parseAgentModelAcquisitions(candidate.modelAcquisitions)
    result = { type: candidate.type as 'done' | 'interrupted', summary: candidate.summary, changed: candidate.changed, base: candidate.base, project: parseProject(candidate.project, { allowDraft: true }), simulation: parseSimulation(candidate.simulation), ...(modelAcquisitions.length ? { modelAcquisitions } : {}), ...(candidate.reason === 'timeout' ? { reason: 'timeout' as const } : {}) }
  }
  let desktop: CodexSessionState['desktop']
  if (raw.desktop !== undefined) {
    const item = raw.desktop
    if (!record(item) || !(item.projectId === null || text(item.projectId, 200)) || !(item.projectName === null || text(item.projectName, 300)) || !['unverified', 'synced', 'busy', 'unavailable'].includes(String(item.syncStatus)) || !text(item.message) || item.syncedAt !== undefined && (!text(item.syncedAt, 100) || !finite(timestamp(item.syncedAt)))) throw new Error('Codex 桌面同步状态格式不正确')
    desktop = item as unknown as CodexSessionState['desktop']
  }
  let writeAccess: CodexSessionState['writeAccess']
  if (raw.writeAccess !== undefined) {
    const item = raw.writeAccess
    if (!record(item) || !['available', 'busy'].includes(String(item.status)) || !text(item.checkedAt, 100) || !finite(timestamp(item.checkedAt)) || !text(item.message)) throw new Error('Codex 执行权检测状态格式不正确')
    writeAccess = item as unknown as CodexSessionState['writeAccess']
  }
  const workbench = raw.workbench === undefined ? undefined : parseCodexWorkbenchLink(raw.workbench, raw.id)
  return { id: raw.id, threadId: raw.threadId, model: raw.model, reasoningEffort: raw.reasoningEffort, status: raw.status as CodexSessionStatus, messages: raw.messages.map(message => ({ ...message, createdAt: timestamp(message.createdAt) })) as CodexSessionMessage[], events: raw.events as unknown as AgentToolEvent[], project: parseProject(raw.project, { allowDraft: true }), result, lastSimulation: parseSimulation(raw.lastSimulation ?? null), error: raw.error, activeRequestId: raw.activeRequestId, createdAt: timestamp(raw.createdAt), updatedAt: timestamp(raw.updatedAt), ...(desktop ? { desktop } : {}), ...(writeAccess ? { writeAccess } : {}), ...(workbench ? { workbench } : {}), ...(raw.resultRequestId !== undefined ? { resultRequestId: raw.resultRequestId as string | null } : {}) }
}

export class CodexSessionClientError extends Error { constructor(public status: number, message: string) { super(message) } }
async function sessionRequest(route: string, payload?: unknown, signal?: AbortSignal): Promise<CodexSessionState> {
  const response = await fetch(`/api/codex-session/${route}`, { method: payload === undefined ? 'GET' : 'POST', headers: { 'X-Fuxian-Session': '1', ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}), cache: 'no-store', signal })
  const body = await response.text()
  if (body.length > 2_000_000) throw new Error('Codex 会话响应过大')
  let raw: unknown
  try { raw = JSON.parse(body) } catch { throw new Error('Codex 持久会话服务没有返回有效数据，请检查本地工作台服务') }
  if (!response.ok) throw new CodexSessionClientError(response.status, record(raw) && text(raw.error) && raw.error.trim() ? raw.error : `Codex 会话请求失败（${response.status}）`)
  return parseCodexSessionState(raw)
}
export const createCodexSession = (project: Project, signal?: AbortSignal, projectId?: string) => sessionRequest('create', { project, ...(projectId ? { projectId } : {}) }, signal)
export const getCodexSession = (id: string, signal?: AbortSignal) => sessionRequest(`state?id=${encodeURIComponent(id)}`, undefined, signal)
export interface CodexSessionRevision { requestId: string; project: Project; base: string }
export const sendCodexSession = (id: string, message: string, requestId: string, signal?: AbortSignal, project?: Project, context?: string, projectId?: string, revision?: CodexSessionRevision) => sessionRequest('send', { id, message, requestId, ...(project ? { project } : {}), ...(context ? { context } : {}), ...(projectId ? { projectId } : {}), ...(revision ? { revision } : {}) }, signal)
export const cancelCodexSession = (id: string, signal?: AbortSignal) => sessionRequest('cancel', { id }, signal)
export const refreshCodexDesktopSession = (id: string, signal?: AbortSignal) => sessionRequest('refresh', { id }, signal)
export const checkCodexSessionWriteAccess = (id: string, signal?: AbortSignal) => sessionRequest('check-write-access', { id }, signal)
export const bindCodexWorkbench = (id: string, projectId: string, signal?: AbortSignal) => sessionRequest('bind-workbench', { id, projectId }, signal)

export interface CodexSessionCandidate {
  requestId: string; summary: string; project: Project; baseline: Project; base: string
  everApplied: boolean; discarded: boolean
  lastApply?: { before: Project; after: Project }
}
export interface CodexProjectSessionBinding { sessionId: string; draft: string; candidates: CodexSessionCandidate[] }
const bindingKey = (projectId: string) => `fuxian.codex-project-session.v1:${encodeURIComponent(projectId)}`
export function loadCodexProjectSession(projectId: string): CodexProjectSessionBinding {
  const empty = { sessionId: '', draft: '', candidates: [] }
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(bindingKey(projectId)) ?? 'null')
    if (!record(raw) || !text(raw.sessionId, 200) || !text(raw.draft, 8000) || !Array.isArray(raw.candidates)) return empty
    const candidates: CodexSessionCandidate[] = []
    for (const item of raw.candidates.slice(-6)) {
      if (!record(item) || !text(item.requestId, 200) || !text(item.summary) || !text(item.base, 300_000) || typeof item.everApplied !== 'boolean' || typeof item.discarded !== 'boolean') continue
      try {
        const candidate: CodexSessionCandidate = { requestId: item.requestId, summary: item.summary, base: item.base, baseline: parseProject(item.baseline, { allowDraft: true }), project: parseProject(item.project, { allowDraft: true }), everApplied: item.everApplied, discarded: item.discarded }
        if (record(item.lastApply)) try { candidate.lastApply = { before: parseProject(item.lastApply.before, { allowDraft: true }), after: parseProject(item.lastApply.after, { allowDraft: true }) } } catch { /* Keep a valid candidate even if old apply metadata is damaged. */ }
        candidates.push(candidate)
      } catch { /* Preserve the session even when one saved preview is damaged. */ }
    }
    return { sessionId: raw.sessionId, draft: raw.draft, candidates }
  } catch { return empty }
}
export function saveCodexProjectSession(projectId: string, binding: CodexProjectSessionBinding): boolean {
  try { localStorage.setItem(bindingKey(projectId), JSON.stringify({ ...binding, candidates: binding.candidates.slice(-6) })); return true } catch { return false }
}
