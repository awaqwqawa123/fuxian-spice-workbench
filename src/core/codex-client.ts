import { readAgentResponse, type AgentProgressEvent, type AgentResult } from './agent-client'
import { parseCodexRequest, type CodexRequest, type CodexStatus } from './codex'
export type { CodexRequest, CodexStatus } from './codex'

async function readStatusBody(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('本机 Codex 未返回状态')
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0, body = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 16000) throw new Error('Codex 状态响应超过上限')
      body += decoder.decode(value, { stream: true })
    }
    return JSON.parse(body + decoder.decode())
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function getCodexStatus(signal?: AbortSignal): Promise<CodexStatus> {
  const response = await fetch('/api/codex/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal })
  const raw: unknown = await readStatusBody(response)
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  if (!response.ok) throw new Error(typeof data.error === 'string' && data.error.length <= 8000 ? data.error : `本机 Codex 状态请求失败（${response.status}）`)
  if (typeof data.installed !== 'boolean' || typeof data.available !== 'boolean' || !(data.authenticated === null || typeof data.authenticated === 'boolean')
    || typeof data.version !== 'string' || data.version.length > 200 || !(data.model === null || typeof data.model === 'string' && data.model.length <= 200)
    || typeof data.message !== 'string' || data.message.length > 8000) throw new Error('本机 Codex 状态格式不正确')
  return { installed: data.installed, available: data.available, authenticated: data.authenticated, version: data.version, model: data.model, message: data.message }
}

export async function requestCodexAgent(request: CodexRequest, onProgress: (event: AgentProgressEvent) => void, signal?: AbortSignal): Promise<AgentResult> {
  const payload = parseCodexRequest(request)
  const response = await fetch('/api/codex/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(payload), signal })
  return readAgentResponse(response, { project: request.project, baseline: payload.project }, onProgress, signal)
}
