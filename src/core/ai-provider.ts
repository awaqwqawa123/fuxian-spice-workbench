export type AiProtocol = 'chat-completions' | 'responses'
export interface AiProvider { endpoint: string; model: string; apiKey: string; protocol?: AiProtocol }
export type AiProviderId = 'openai' | 'codex' | 'deepseek' | 'openrouter' | 'ollama' | 'custom'
export interface AiProviderPreset { id: AiProviderId; name: string; endpoint: string; hint: string; docs: string; protocol?: AiProtocol }

export const aiProviderPresets: AiProviderPreset[] = [
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', hint: '填写有 Chat Completions 权限的模型 ID，或先获取模型列表。', docs: 'https://platform.openai.com/docs/api-reference/chat/create' },
  { id: 'codex', name: 'Codex / Responses', endpoint: 'https://api.openai.com/v1', protocol: 'responses', hint: '连接提供 Responses API 的 Codex 兼容模型服务；填写该服务的地址、密钥和模型 ID，不会复用桌面应用登录。', docs: 'https://developers.openai.com/api/reference/resources/responses/methods/create' },
  { id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com', hint: '使用 DeepSeek API 密钥；模型 ID 以当前账户可用列表为准。', docs: 'https://api-docs.deepseek.com/' },
  { id: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', hint: '模型 ID 通常包含供应商前缀；列表可见不代表账户可调用。', docs: 'https://openrouter.ai/docs/api/reference/overview' },
  { id: 'ollama', name: 'Ollama · 本机', endpoint: 'http://localhost:11434/v1', hint: '先启动 Ollama 并下载模型。此处连接本机兼容接口，密钥可留空。', docs: 'https://docs.ollama.com/api/openai-compatibility' },
  { id: 'custom', name: '自定义兼容服务', endpoint: '', hint: '可选 Chat Completions 或 Responses；按你的服务文档填写地址和模型 ID。', docs: '' },
]

export function providerUrls(endpoint: string): { chat: string; responses: string; models: string } {
  let url: URL
  try { url = new URL(endpoint.trim()) } catch { throw new Error('请输入完整 API 地址，例如 https://api.example.com/v1') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('API 地址必须使用 http:// 或 https://')
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含用户名、密钥、查询参数或锚点；密钥请填写到单独输入框')
  const path = url.pathname.replace(/\/+$/, '')
  if (/\/(messages|models)$/.test(path)) throw new Error('请填写 API 基础地址或完整 /chat/completions、/responses 地址，不要填写 /messages 或 /models')
  const base = path.replace(/\/(chat\/completions|responses)$/, '')
  url.pathname = `${base}/chat/completions`
  const chat = url.toString()
  url.pathname = `${base}/responses`
  const responses = url.toString()
  url.pathname = `${base}/models`
  return { chat, responses, models: url.toString() }
}

export const providerUrl = (endpoint: string, protocol: AiProtocol = 'chat-completions') => {
  const urls = providerUrls(endpoint)
  return protocol === 'responses' ? urls.responses : urls.chat
}

export function inferProviderId(endpoint: string): AiProviderId {
  try { return aiProviderPresets.find(preset => preset.endpoint && providerUrl(preset.endpoint) === providerUrl(endpoint))?.id ?? 'custom' }
  catch { return 'custom' }
}

export function parseAiProvider(raw: unknown, requireModel = true): AiProvider {
  if (!raw || typeof raw !== 'object') throw new Error('AI 配置格式错误')
  const data = raw as Record<string, unknown>
  for (const [key, limit] of [['endpoint', 2048], ['model', 200], ['apiKey', 4096]] as const) {
    if (typeof data[key] !== 'string' || data[key].length > limit) throw new Error('AI 配置长度不正确')
  }
  const { endpoint, model, apiKey } = data as unknown as AiProvider
  providerUrls(endpoint)
  if (requireModel && !model.trim()) throw new Error('请填写或选择模型名称')
  if (/[\r\n\x00]/.test(apiKey) || /[\r\n\x00]/.test(model)) throw new Error('模型或密钥格式不正确')
  const protocol = data.protocol ?? 'chat-completions'
  if (protocol !== 'chat-completions' && protocol !== 'responses') throw new Error('请选择 Chat Completions 或 Responses 协议')
  return { endpoint: endpoint.trim(), model: model.trim(), apiKey: apiKey.trim(), protocol }
}

export interface AiModelInfo { id: string; name?: string }
export interface AiModelList { models: AiModelInfo[]; truncated: boolean }
export interface AiConnectionTest { model: string; elapsedMs: number }

async function providerAction<T>(action: 'models' | 'test', provider: AiProvider, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/ai/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parseAiProvider(provider, action === 'test')), signal })
  let result: unknown
  try { result = await response.json() } catch { throw new Error('AI 服务未启动：请使用本项目的 npm run dev 或 npm run preview 启动工作台') }
  if (!response.ok) throw new Error(typeof (result as { error?: unknown })?.error === 'string' ? (result as { error: string }).error : `模型配置请求失败（${response.status}）`)
  return result as T
}

export const listAiModels = (provider: AiProvider, signal?: AbortSignal) => providerAction<AiModelList>('models', provider, signal)
export const testAiConnection = (provider: AiProvider, signal?: AbortSignal) => providerAction<AiConnectionTest>('test', provider, signal)
