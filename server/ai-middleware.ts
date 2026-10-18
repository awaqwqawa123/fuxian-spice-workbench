import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { buildAiMessages, parseAiRequest } from '../src/core/ai'
import { parseAiProvider, providerUrls, type AiModelInfo } from '../src/core/ai-provider'

const MAX_BODY = 192 * 1024, MAX_RESPONSE = 1024 * 1024
type Next = () => void
class GatewayError extends Error { constructor(public status: number, message: string) { super(message) } }

function sameLocalOrigin(req: IncomingMessage) {
  const address = req.socket.remoteAddress
  if (!address || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false
  const host = req.headers.host
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) return false
  const origin = req.headers.origin
  return origin === `http://${host}` || origin === `https://${host}`
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0
  if (Number(req.headers['content-length']) > MAX_BODY) throw new GatewayError(413, '项目内容过大，请缩小电路后重试')
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new GatewayError(413, '项目内容过大，请缩小电路后重试')
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new GatewayError(400, 'AI 请求不是有效 JSON') }
}

async function readResponse(response: Response, maxBytes = MAX_RESPONSE) {
  if (!response.body) throw new GatewayError(502, '模型服务没有返回内容')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let size = 0, text = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new GatewayError(502, '模型服务响应过大，请手填模型名称或缩小问题范围') }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally { reader.releaseLock() }
}

function providerError(status: number): string {
  if (status === 401 || status === 403) return `模型服务拒绝授权（${status}），请检查 API 密钥和模型访问权限`
  if (status === 404) return '模型或 API 路径不存在（404），请检查地址及模型名称'
  if (status === 429) return '模型服务限流或额度不足（429），请稍后重试或检查账户额度'
  if (status === 400 || status === 422) return `模型服务不接受此请求（${status}），请检查所选协议及模型是否受该服务支持`
  return `模型服务请求失败（${status}），请检查服务状态后重试`
}

export function createAiMiddleware(options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
  return async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const route = req.url?.split('?')[0]
    if (!['/api/ai', '/api/ai/models', '/api/ai/test'].includes(route ?? '')) { next(); return }
    const listing = route === '/api/ai/models', testing = route === '/api/ai/test'
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const send = (status: number, data: object) => { if (!res.destroyed && !res.writableEnded) { res.statusCode = status; res.end(JSON.stringify(data)) } }
    if (!sameLocalOrigin(req) || req.headers['sec-fetch-site'] === 'cross-site') { send(403, { error: 'AI 网关只接受本机工作台的同源请求' }); return }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(405, { error: 'AI 网关仅接受 POST' }); return }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) { send(415, { error: 'AI 请求必须使用 application/json' }); return }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, options.timeoutMs ?? 60_000)
    const abort = () => { if (!res.writableEnded) controller.abort() }
    res.once('close', abort)
    try {
      const raw = await readBody(req)
      let request, messages
      try {
        request = parseAiProvider(raw, !listing)
        // Configuration actions never accept or forward the user's circuit or prompt.
        if (!listing) messages = testing ? [{ role: 'user', content: 'Reply with exactly OK.' }] : buildAiMessages(parseAiRequest(raw))
      } catch (error) { throw new GatewayError(400, (error as Error).message) }
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
      if (request.apiKey) headers.Authorization = `Bearer ${request.apiKey}`
      const startedAt = Date.now(), urls = providerUrls(request.endpoint)
      const response = await (options.fetchImpl ?? fetch)(listing ? urls.models : request.protocol === 'responses' ? urls.responses : urls.chat, {
        method: listing ? 'GET' : 'POST', headers, redirect: 'error', signal: controller.signal,
        ...(listing ? {} : { body: JSON.stringify(request.protocol === 'responses' ? { model: request.model, input: messages, stream: false, store: false } : { model: request.model, messages, stream: false }) }),
      })
      if (!response.ok) { await response.body?.cancel(); throw new GatewayError(502, `${providerError(response.status)}${listing ? '；模型列表不可用时仍可手填模型名称并测试推理' : ''}`) }
      // Large catalogues contain metadata we discard; inference replies keep the original 1 MiB limit.
      const body = await readResponse(response, listing ? 4 * MAX_RESPONSE : MAX_RESPONSE)
      let payload
      try { payload = JSON.parse(body) } catch { throw new GatewayError(502, '模型服务返回的不是 JSON，请检查 API 地址') }
      if (listing) {
        if (!Array.isArray(payload?.data)) throw new GatewayError(502, '服务未返回兼容的模型列表；请手填模型名称后测试推理')
        const unique = new Map<string, AiModelInfo>()
        for (const item of payload.data) {
          if (typeof item?.id !== 'string' || !item.id.trim() || item.id.length > 200 || /[\r\n\x00]/.test(item.id) || (request.apiKey && item.id.includes(request.apiKey))) continue
          const id = item.id.trim()
          const name = typeof item.name === 'string' && item.name.length <= 200 ? item.name : undefined
          unique.set(id, { id, ...(name && (!request.apiKey || !name.includes(request.apiKey)) ? { name } : {}) })
        }
        if (!unique.size) throw new GatewayError(502, '服务返回了空模型列表；请确认已安装或有权访问模型，也可以手填名称')
        send(200, { models: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 1000), truncated: unique.size > 1000 })
        return
      }
      let text = ''
      if (request.protocol === 'responses') {
        if (payload?.error || payload?.incomplete_details || (payload?.status !== undefined && payload.status !== 'completed')) throw new GatewayError(502, '模型回复未完成，请重试或缩小问题；未完整返回的方案不会应用')
        const output: { type?: string; status?: string; role?: string; content?: { type?: string; text?: string }[] }[] = Array.isArray(payload?.output) ? payload.output : []
        if (output.some(item => item?.type === 'message' && item.status !== undefined && item.status !== 'completed')) throw new GatewayError(502, '模型消息未完成，请重试或缩小问题')
        text = output.filter(item => item?.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)).flatMap(item => item.content ?? []).filter(part => part?.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('\n')
      } else {
        const choice = payload?.choices?.[0], content = choice?.message?.content
        if (payload?.error || (choice?.finish_reason && choice.finish_reason !== 'stop')) throw new GatewayError(502, '模型回复未完整结束，请重试或缩小问题')
        text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : ''
      }
      if (!text.trim()) throw new GatewayError(502, '模型未返回可显示的文本，请检查所选协议和模型')
      if (testing) { send(200, { model: request.model, elapsedMs: Date.now() - startedAt }); return }
      // Some proxies echo request headers. Never forward the supplied secret back to the browser.
      if (request.apiKey) text = text.split(request.apiKey).join('[密钥已隐藏]')
      send(200, { text })
    } catch (error) {
      if (timedOut) send(504, { error: '模型响应超时（60 秒），请缩小问题或检查模型服务' })
      else if (error instanceof GatewayError) send(error.status, { error: error.message })
      else if (!controller.signal.aborted) send(502, { error: '无法连接模型服务，请检查地址、网络或本机模型是否运行' })
    } finally { clearTimeout(timer); res.off('close', abort) }
  }
}

export function aiGatewayPlugin(): Plugin {
  return {
    name: 'local-ai-gateway',
    configureServer(server) { server.middlewares.use(createAiMiddleware()) },
    configurePreviewServer(server) { server.middlewares.use(createAiMiddleware()) },
  }
}
