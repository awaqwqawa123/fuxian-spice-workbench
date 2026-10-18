import { parseAiHistory, type AiConversationMessage } from './ai'
import { parseProject, type Project } from './circuit'

export interface CodexRequest { prompt: string; project: Project; history?: AiConversationMessage[]; model?: string }
export interface CodexStatus {
  installed: boolean
  available: boolean
  authenticated: boolean | null
  version: string
  model: string | null
  message: string
}

/** Native Codex uses the local runtime configuration, never browser provider credentials. */
export function parseCodexRequest(raw: unknown): CodexRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Codex 请求格式错误')
  const data = raw as Record<string, unknown>
  if (Object.keys(data).some(key => !['prompt', 'project', 'history', 'model'].includes(key))) throw new Error('本机 Codex 仅接受问题、电路、对话历史和可选模型，不接受 API 配置')
  if (typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 8000) throw new Error('请填写问题，长度不超过 8000 字符')
  if (data.model !== undefined && (typeof data.model !== 'string' || data.model.length > 200 || /[\r\n\x00]/.test(data.model))) throw new Error('Codex 模型名称格式不正确')
  const model = typeof data.model === 'string' ? data.model.trim() : ''
  return { prompt: data.prompt.trim(), project: parseProject(data.project, { allowDraft: true }),
    history: parseAiHistory(data.history), ...(model ? { model } : {}) }
}
