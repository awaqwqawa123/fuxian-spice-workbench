import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { parseAiRequest } from '../src/core/ai'
import { runDshAgent } from './dsh-runtime'

const MAX_BODY = 192 * 1024
class RequestError extends Error { constructor(public status: number, message: string) { super(message) } }
function sameLocalOrigin(req: IncomingMessage) {
  const address = req.socket.remoteAddress, host = req.headers.host
  return !!address && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) && !!host
    && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)
    && [ `http://${host}`, `https://${host}` ].includes(req.headers.origin ?? '')
    && req.headers['sec-fetch-site'] !== 'cross-site'
}
async function readRequest(req: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = []
  if (Number(req.headers['content-length']) > MAX_BODY) throw new RequestError(413, '项目内容过大，请缩小电路后重试')
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += chunk.length
    if (size > MAX_BODY) throw new RequestError(413, '项目内容过大，请缩小电路后重试')
    chunks.push(chunk)
  }
  let raw: unknown
  try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new RequestError(400, 'Agent 请求不是有效 JSON') }
  try { return parseAiRequest(raw && typeof raw === 'object' ? { ...raw, mode: 'mode' in raw ? raw.mode : 'propose' } : raw) }
  catch (error) {
    const key = raw && typeof raw === 'object' && 'apiKey' in raw && typeof raw.apiKey === 'string' ? raw.apiKey : ''
    const message = (error as Error).message
    throw new RequestError(400, key ? message.split(key).join('[密钥已隐藏]') : message)
  }
}

export function createAgentMiddleware(options: { timeoutMs?: number; run?: typeof runDshAgent } = {}) {
  let running = false
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url?.split('?')[0] !== '/api/agent/run') { next(); return }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    const reject = (status: number, error: string) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error }))
    }
    if (!sameLocalOrigin(req)) { reject(403, 'Agent 只接受本机工作台同源请求'); return }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reject(405, 'Agent 仅接受 POST'); return }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) { reject(415, 'Agent 请求必须使用 application/json'); return }
    if (running) { reject(409, '已有 Agent 任务运行中，请先停止或等待完成'); return }
    running = true
    const controller = new AbortController(); let timedOut = false, started = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, options.timeoutMs ?? 115000)
    const abort = () => { if (!res.writableEnded) controller.abort() }
    res.once('close', abort)
    const emit = (event: unknown) => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`) }
    try {
      const request = await readRequest(req)
      if (controller.signal.aborted) throw new Error('任务已停止')
      started = true
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' })
      emit({ type: 'started', engine: 'DeepSeek Harness', version: '0.1.5-rc.2' })
      const result = await (options.run ?? runDshAgent)(request, { signal: controller.signal, onEvent: emit })
      if (!controller.signal.aborted) emit(result)
    } catch (error) {
      if (!res.destroyed) {
        if (!started) reject(error instanceof RequestError ? error.status : timedOut ? 504 : 500,
          error instanceof RequestError ? error.message : timedOut ? 'Agent 请求超时' : 'Agent 请求失败')
        else emit({ type: 'error', error: timedOut ? 'Agent 任务超过时间限制，已停止' : (error as Error).message })
      }
    } finally {
      clearTimeout(timer); res.off('close', abort)
      running = false
      if (!res.destroyed && !res.writableEnded) res.end()
    }
  }
}
export function agentGatewayPlugin(): Plugin {
  return { name: 'local-dsh-agent-gateway',
    configureServer(server) { server.middlewares.use(createAgentMiddleware()) },
    configurePreviewServer(server) { server.middlewares.use(createAgentMiddleware()) },
  }
}
