import type { CodexStatus } from './codex'
import type { DshLocalStatus } from './dsh-local'
export type LocalAssistantEngine = 'codex' | 'cursor' | 'dsh'
export type AssistantConnectionAction = 'connect' | 'login' | 'configure'
export interface AssistantConnectionResult { engine: LocalAssistantEngine; state: 'ready' | 'login-required' | 'configuration-required' | 'unavailable'; message: string; native?: CodexStatus; dsh?: DshLocalStatus; url?: string }
export async function connectLocalAssistant(engine: LocalAssistantEngine, action: AssistantConnectionAction = 'connect', signal?: AbortSignal): Promise<AssistantConnectionResult> {
  const response = await fetch('/api/assistant-connections', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fuxian-Assistant-Connection': '1' }, body: JSON.stringify({ engine, action }), signal })
  const text = await response.text()
  if (text.length > 64000) throw new Error('本机助手连接响应超过上限')
  const raw = JSON.parse(text) as AssistantConnectionResult & { error?: unknown }
  if (!response.ok) throw new Error(typeof raw.error === 'string' ? raw.error.slice(0, 1200) : '本机助手连接失败')
  if (raw.engine !== engine || !['ready', 'login-required', 'configuration-required', 'unavailable'].includes(raw.state) || typeof raw.message !== 'string' || raw.message.length > 8000) throw new Error('本机助手连接响应格式错误')
  if (raw.native && (typeof raw.native.installed !== 'boolean' || typeof raw.native.available !== 'boolean' || !(raw.native.authenticated === null || typeof raw.native.authenticated === 'boolean') || typeof raw.native.version !== 'string' || raw.native.version.length > 200 || !(raw.native.model === null || typeof raw.native.model === 'string' && raw.native.model.length <= 200) || typeof raw.native.message !== 'string' || raw.native.message.length > 8000)) throw new Error('本机助手状态格式错误')
  if (raw.dsh && (typeof raw.dsh.installed !== 'boolean' || typeof raw.dsh.available !== 'boolean' || typeof raw.dsh.version !== 'string' || raw.dsh.version.length > 200 || typeof raw.dsh.message !== 'string' || raw.dsh.message.length > 8000 || !Array.isArray(raw.dsh.providers) || raw.dsh.providers.length > 64 || raw.dsh.providers.some(provider => !provider || typeof provider.id !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(provider.id) || typeof provider.label !== 'string' || provider.label.length > 200 || typeof provider.configured !== 'boolean' || !['none', 'oauth', 'api-key'].includes(provider.auth) || !Array.isArray(provider.models) || provider.models.length > 300 || provider.models.some(model => typeof model !== 'string' || model.length > 200)))) throw new Error('DSH 本机状态格式错误')
  if (raw.url && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\//.test(raw.url)) throw new Error('本机配置界面地址无效')
  return raw
}
