import type { HapiSessionState, HapiStatus } from './hapi-types'
import type { Project } from './circuit'

export class HapiClientError extends Error { constructor(message: string, readonly status: number) { super(message) } }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
async function request(route: string, signal?: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await fetch(`/api/hapi/${route}`, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal,
    headers: { 'X-Fuxian-Hapi': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  if (text.length > 4_000_000) throw new HapiClientError('HAPI 回复过大，请在 HAPI 查看完整历史', 413)
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new HapiClientError('HAPI 服务未返回有效数据，请检查本机 Hub 与 Runner', response.status) }
  if (!response.ok) throw new HapiClientError(record(value) && typeof value.error === 'string' ? value.error : `HAPI 请求失败（${response.status}）`, response.status)
  return value
}
export function parseHapiSession(value: unknown, projectId: string): HapiSessionState {
  if (!record(value) || value.projectId !== projectId || !(value.sessionId === null || typeof value.sessionId === 'string') || !(value.threadId === null || typeof value.threadId === 'string') || !['idle', 'running', 'offline', 'error'].includes(String(value.status)) || !Array.isArray(value.messages) || !Array.isArray(value.approvals) || typeof value.updatedAt !== 'number') throw new Error('HAPI 返回的会话不属于当前项目或格式不正确')
  if (value.messages.some(item => !record(item) || typeof item.id !== 'string' || !['user', 'assistant'].includes(String(item.role)) || typeof item.content !== 'string' || typeof item.createdAt !== 'number' || item.delivery !== undefined && !['queued', 'sent', 'unknown', 'failed'].includes(String(item.delivery)))) throw new Error('HAPI 消息格式不正确')
  if (value.approvals.some(item => !record(item) || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.detail !== 'string' || !['approval', 'question'].includes(String(item.kind)) || item.questions !== undefined && (!Array.isArray(item.questions) || item.questions.some(q => !record(q) || typeof q.id !== 'string' || typeof q.question !== 'string' || !Array.isArray(q.options) || q.options.some(o => !record(o) || typeof o.label !== 'string'))))) throw new Error('HAPI 审批格式不正确')
  return value as unknown as HapiSessionState
}
export async function getHapiStatus(signal?: AbortSignal): Promise<HapiStatus> {
  const value = await request('status', signal)
  if (!record(value) || typeof value.installed !== 'boolean' || typeof value.available !== 'boolean' || typeof value.message !== 'string' || typeof value.version !== 'string') throw new Error('HAPI 状态格式不正确')
  return value as unknown as HapiStatus
}
const sessionRequest = async (projectId: string, route: string, signal?: AbortSignal, body?: unknown) => parseHapiSession(await request(route, signal, body), projectId)
export const getHapiSession = (projectId: string, signal?: AbortSignal) => sessionRequest(projectId, `session?projectId=${encodeURIComponent(projectId)}`, signal)
export const connectHapiSession = (projectId: string, project: Project, signal?: AbortSignal) => sessionRequest(projectId, 'connect', signal, { projectId, project })
export const sendHapiMessage = (projectId: string, message: string, requestId: string, signal?: AbortSignal) => sessionRequest(projectId, 'send', signal, { projectId, message, requestId })
export const cancelHapiSession = (projectId: string, signal?: AbortSignal) => sessionRequest(projectId, 'cancel', signal, { projectId })
export const answerHapiApproval = (projectId: string, id: string, decision: 'approve' | 'deny', answers?: Record<string, string[]>, signal?: AbortSignal) => sessionRequest(projectId, 'approval', signal, { projectId, id, decision, ...(answers ? { answers } : {}) })

export interface HapiDraft { draft: string; pending?: { id: string; message: string } }
export const hapiDraftKey = (projectId: string) => `fuxian.hapi-draft.v1:${encodeURIComponent(projectId)}`
export function readHapiDraft(projectId: string): HapiDraft {
  try {
    const value = JSON.parse(localStorage.getItem(hapiDraftKey(projectId)) ?? 'null')
    if (!record(value) || typeof value.draft !== 'string') return { draft: '' }
    const pending = record(value.pending) && typeof value.pending.id === 'string' && typeof value.pending.message === 'string' ? { id: value.pending.id, message: value.pending.message } : undefined
    return { draft: value.draft.slice(0, 8000), ...(pending ? { pending } : {}) }
  } catch { return { draft: '' } }
}
export function saveHapiDraft(projectId: string, value: HapiDraft) { try { localStorage.setItem(hapiDraftKey(projectId), JSON.stringify(value)); return true } catch { return false } }

/** The sibling launcher carries the isolated Hub/home settings; no secret enters the page. */
export function hapiTerminalCommand(cliPath: string | undefined, sessionId: string): string | null {
  if (!cliPath || !/^(?:[a-z]:[/\\]|\/)/i.test(cliPath) || !/[/\\]desktop-circuit\.mjs$/i.test(cliPath) || !/^[a-z\d_-]+$/i.test(sessionId)) return null
  const launcher = cliPath.replace(/\\/g, '/').replace(/desktop-circuit\.mjs$/i, 'hapi-terminal.mjs')
  // PowerShell single quotes treat spaces, Unicode and metacharacters literally.
  return `node '${launcher.replace(/'/g, "''")}' ${sessionId}`
}
