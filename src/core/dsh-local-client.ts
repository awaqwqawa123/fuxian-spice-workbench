import { readAgentResponse, type AgentProgressEvent, type AgentResult } from './agent-client'
import { parseDshLocalRequest, type DshLocalRequest, type DshLocalStatus } from './dsh-local'
export type { DshLocalProvider, DshLocalRequest, DshLocalSelection, DshLocalStatus } from './dsh-local'

export async function getDshLocalStatus(signal?: AbortSignal): Promise<DshLocalStatus> {
  const response = await fetch('/api/dsh-local/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal })
  if (!response.body) throw new Error('本机 DSH 未返回状态')
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let body = '', bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > 64000) throw new Error('DSH 状态响应超过上限')
      body += decoder.decode(value, { stream: true })
    }
    const raw: unknown = JSON.parse(body + decoder.decode())
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('本机 DSH 状态格式不正确')
    const data = raw as Record<string, unknown>
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error.slice(0,8000) : '本机 DSH 状态读取失败')
    if (typeof data.installed !== 'boolean' || typeof data.available !== 'boolean' || typeof data.version !== 'string' || data.version.length > 100
      || typeof data.message !== 'string' || data.message.length > 8000 || !Array.isArray(data.providers) || data.providers.length > 64) throw new Error('本机 DSH 状态格式不正确')
    const providers = data.providers.map((item: unknown) => {
      if (!item || typeof item !== 'object') throw new Error('DSH 供应商状态格式不正确')
      const row = item as Record<string, unknown>
      if (typeof row.id !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(row.id) || typeof row.label !== 'string' || row.label.length > 200
        || typeof row.configured !== 'boolean' || !['oauth', 'api-key', 'none'].includes(String(row.auth)) || !Array.isArray(row.models)
        || row.models.length > 300 || row.models.some(model => typeof model !== 'string' || model.length > 200)) throw new Error('DSH 供应商状态格式不正确')
      return { id: row.id, label: row.label, configured: row.configured, auth: row.auth as 'oauth' | 'api-key' | 'none', models: row.models as string[] }
    })
    return { installed: data.installed, available: data.available, version: data.version, message: data.message, providers }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function requestDshLocalAgent(request: DshLocalRequest, onProgress: (event: AgentProgressEvent) => void, signal?: AbortSignal): Promise<AgentResult> {
  const payload = parseDshLocalRequest(request)
  const response = await fetch('/api/dsh-local/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(payload), signal })
  return readAgentResponse(response, { project: request.project, baseline: payload.project }, onProgress, signal)
}
