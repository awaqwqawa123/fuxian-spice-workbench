import type { AiRequest } from '../src/core/ai'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown) => typeof value === 'string' ? value : ''
const validArguments = (value: unknown) => {
  if (typeof value !== 'string') return false
  try { return record(JSON.parse(value)) } catch { return false }
}
export const MAX_MODEL_BYTES = 8 * 1024 * 1024

/** The SDK sees our loopback bridge, so its provider detection cannot see the real service. */
export function agentModelCompat(request: Pick<AiRequest, 'model' | 'protocol'>) {
  if (request.protocol === 'responses') return { supportsStrictMode: false }
  return {
    supportsStore: false, supportsUsageInStreaming: false, supportsStrictMode: false,
    supportsDeveloperRole: false,
    // Current OpenAI reasoning models require this spelling even behind a gateway.
    maxTokensField: /^(?:gpt-[5-9](?:[.\-/]|$)|o[1-9](?:[.\-/]|$))/i.test(request.model) ? 'max_completion_tokens' : 'max_tokens',
  }
}

export async function boundedModelText(response: Response) {
  if (!response.body) return ''
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let bytes = 0, result = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > MAX_MODEL_BYTES) throw new Error('模型响应超过 8 MB 限制')
      result += decoder.decode(value, { stream: true })
    }
    return result + decoder.decode()
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function modelErrorDetails(body: unknown): { message: string; code?: string } {
  if (!record(body)) return { message: '' }
  const error = record(body.error) ? body.error : record(body.response) && record(body.response.error) ? body.response.error : body
  return { message: string(error.message) || string(body.error), code: string(error.code) || string(error.type) || undefined }
}

export function modelFailureMessage(request: Pick<AiRequest, 'protocol' | 'model'>, stage: string,
  failure: { message?: string; code?: string; status?: number }, redact: (value: string) => string) {
  const detail = redact(failure.message ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 1000)
  const code = redact(failure.code ?? '').slice(0, 100)
  const protocol = request.protocol === 'responses' ? 'Responses' : 'Chat Completions'
  const status = failure.status ? ` · HTTP ${failure.status}` : ''
  let hint = '请核对所选模型与 API 协议；可在配置中测试模型推理。'
  if (failure.status === 401 || failure.status === 403) hint = '请检查本次会话的 API 密钥及模型访问权限。'
  else if (failure.status === 404) hint = '请检查 API 基础地址、模型 ID，以及该服务是否提供所选协议的接口。'
  else if (failure.status === 429) hint = '请检查服务额度或速率限制，稍后手动重试。'
  else if (code === 'max-tokens' || /(?:token limit|output limit|maximum (?:output )?tokens).*(?:exceeded|reached)|(?:finish_reason: length|incomplete.max_output_tokens)/i.test(detail)) hint = '回复达到输出上限，请缩小任务目标后重试。'
  else if (/tool|function/i.test(detail)) hint = '该服务拒绝或未完成工具调用，请确认模型支持所选协议的 tools 参数。'
  else if (/stream|terminal|finish_reason|SSE/i.test(detail)) hint = '服务返回的响应流未完整结束，请检查中转服务的流式转发支持。'
  return `${stage} · ${protocol} · ${redact(request.model)}${status}${code ? ` · ${code}` : ''}\n${detail || '服务没有返回具体错误说明。'}\n${hint}`
}

/** Some compatible gateways ignore stream:true and return a complete JSON response.
 * Convert only a recognized, terminal response. This never sends a second model request.
 */
export function completedJsonToSse(body: unknown, protocol: AiRequest['protocol']): string {
  if (!record(body)) throw new Error('模型返回的 JSON 响应不是有效对象')
  const failure = modelErrorDetails(body)
  if (body.error) throw new Error(`${failure.code ?? 'MODEL_ERROR'}: ${failure.message || '模型服务返回错误'}`)
  const data = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`
  if (protocol !== 'responses') {
    if (!Array.isArray(body.choices) || body.choices.length !== 1) throw new Error('Chat Completions JSON 缺少唯一的 choices 回复')
    const choice = body.choices[0]
    if (!record(choice) || !record(choice.message) || choice.message.role !== 'assistant' || typeof choice.finish_reason !== 'string') throw new Error('Chat Completions JSON 缺少完整 message / finish_reason')
    const message = choice.message
    if (message.content != null && typeof message.content !== 'string') throw new Error('Chat Completions JSON 的 message.content 不是文本')
    if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.some(call => !record(call) || typeof call.id !== 'string' || !call.id || call.type !== 'function' || !record(call.function) || typeof call.function.name !== 'string' || !call.function.name || !validArguments(call.function.arguments)))) throw new Error('Chat Completions JSON 工具调用数据不完整')
    if (!['stop', 'tool_calls', 'length'].includes(choice.finish_reason)) throw new Error(`Provider finish_reason: ${choice.finish_reason}`)
    if (choice.finish_reason === 'tool_calls' && (!Array.isArray(message.tool_calls) || !message.tool_calls.length)) throw new Error('Chat Completions JSON 的 finish_reason 为 tool_calls，但未返回工具调用')
    if (Array.isArray(message.tool_calls) && message.tool_calls.length && choice.finish_reason !== 'tool_calls') throw new Error('Chat Completions JSON 的 tool_calls 与 finish_reason 不一致')
    const common = { id: string(body.id) || 'gateway-completion', object: 'chat.completion.chunk', created: body.created ?? 0, model: body.model }
    const delta = { ...message, ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) }
    return data({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })
      + data({ ...common, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: body.usage }) + 'data: [DONE]\n\n'
  }
  if (body.status === 'failed' || body.status === 'cancelled') throw new Error(`${failure.code ?? body.status}: ${failure.message || 'Responses 请求未完成'}`)
  if (!['completed', 'incomplete'].includes(String(body.status)) || !Array.isArray(body.output) || typeof body.id !== 'string') throw new Error('Responses JSON 缺少终止状态、id 或 output，不能作为已完成任务')
  const items = body.output
  if (items.some(item => !record(item) || !['message', 'function_call', 'reasoning'].includes(String(item.type)) || typeof item.id !== 'string'
    || item.type === 'function_call' && (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name || !validArguments(item.arguments))
    || item.type === 'message' && (!Array.isArray(item.content) || item.role !== 'assistant'
      || item.content.some(part => !record(part) || !(part.type === 'output_text' && typeof part.text === 'string' || part.type === 'refusal' && typeof part.refusal === 'string'))))) throw new Error('Responses JSON 输出项不完整或包含不支持的工具类型')
  const event = (value: Record<string, unknown>) => `event: ${value.type}\n${data(value)}`
  return event({ type: 'response.created', response: { ...body, status: 'in_progress', output: [] } })
    + items.map((item, output_index) => event({ type: 'response.output_item.added', output_index, item }) + event({ type: 'response.output_item.done', output_index, item })).join('')
    + event({ type: body.status === 'completed' ? 'response.completed' : 'response.incomplete', response: body })
}
