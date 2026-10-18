import { parseCodexRequest, type CodexRequest } from './codex'

export interface CursorRequest extends CodexRequest { projectId?: string }

/** Project bindings are identifiers, never a caller-selected host path or CLI session. */
export function parseCursorRequest(raw: unknown): CursorRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Cursor 请求格式错误')
  const { projectId, ...request } = raw as Record<string, unknown>
  if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 200 || /[\x00-\x1f]/.test(projectId))) throw new Error('Cursor 项目标识格式不正确')
  return { ...parseCodexRequest(request), ...(typeof projectId === 'string' ? { projectId } : {}) }
}
