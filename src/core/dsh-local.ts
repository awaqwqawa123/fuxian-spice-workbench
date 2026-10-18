import { parseCodexRequest, type CodexRequest } from './codex'

export interface DshLocalProvider {
  id: string
  label: string
  configured: boolean
  auth: 'oauth' | 'api-key' | 'none'
  models: string[]
}
export interface DshLocalStatus {
  installed: boolean
  available: boolean
  version: string
  message: string
  providers: DshLocalProvider[]
}
export interface DshLocalSelection { provider: string; model: string }
export interface DshLocalRequest extends Omit<CodexRequest, 'model'>, DshLocalSelection {}

export function parseDshLocalRequest(raw: unknown): DshLocalRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('本机 DSH 请求格式错误')
  const { provider, ...rest } = raw as Record<string, unknown>
  if (typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(provider)) throw new Error('请选择本机 DSH 供应商')
  let request: CodexRequest
  try { request = parseCodexRequest(rest) }
  catch (error) { throw new Error(error instanceof Error ? error.message.replaceAll('Codex', 'DSH') : '本机 DSH 请求格式错误') }
  if (!request.model) throw new Error('请选择本机 DSH 模型')
  return { ...request, provider, model: request.model }
}
