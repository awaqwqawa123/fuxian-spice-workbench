import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import type { CircuitAgentEvent } from '../src/core/agent-circuit'
import { parseCodexRequest, type CodexRequest, type CodexStatus } from '../src/core/codex'
import { CODEX_GATEWAY_TIMEOUT_MS } from '../src/core/agent-timeouts'
import { CodexTimeoutError } from './codex-rpc'
import type { runCodexAgent } from './codex-runtime'

const MAX_BODY = 192 * 1024
type Run = (request: CodexRequest, options: { signal: AbortSignal; onEvent?: (event: CircuitAgentEvent) => void }) => ReturnType<typeof runCodexAgent>
type Status = (options?: { signal?: AbortSignal }) => Promise<CodexStatus>
class RequestError extends Error { constructor(public status: number, message: string) { super(message) } }

function sameLocalOrigin(req: IncomingMessage) {
  const address = req.socket.remoteAddress, host = req.headers.host
  return !!address && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) && !!host
    && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)
    && [`http://${host}`, `https://${host}`].includes(req.headers.origin ?? '')
    && req.headers['sec-fetch-site'] !== 'cross-site'
}

async function readRequest(req: IncomingMessage, signal: AbortSignal) {
  let size = 0; const chunks: Buffer[] = []
  if (Number(req.headers['content-length']) > MAX_BODY) throw new RequestError(413, '项目内容过大，请缩小电路后重试')
  // A client can send valid headers and then stop halfway through the body.
  // Abort the read itself so it cannot retain the single-task lock indefinitely.
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted)
      signal.removeEventListener('abort', aborted)
    }
    const fail = (error: Error) => { cleanup(); req.pause(); reject(error) }
    const aborted = () => fail(new Error('任务已停止'))
    const end = () => { cleanup(); resolve() }
    const data = (part: Buffer | string) => {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
      size += chunk.length
      if (size > MAX_BODY) { fail(new RequestError(413, '项目内容过大，请缩小电路后重试')); return }
      chunks.push(chunk)
    }
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RequestError(400, 'Codex 请求不是有效 JSON') }
}

export function createCodexMiddleware(options: { timeoutMs?: number; statusTimeoutMs?: number; run?: Run; status?: Status } = {}) {
  let running = false
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split('?')[0]
    if (path !== '/api/codex/run' && path !== '/api/codex/status') { next(); return }
    const isStatus = path === '/api/codex/status'
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    const reject = (status: number, error: string) => {
      if (!req.complete) res.setHeader('Connection', 'close')
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error }))
    }
    if (!sameLocalOrigin(req)) { reject(403, 'Codex 只接受本机工作台同源请求'); return }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reject(405, 'Codex 仅接受 POST'); return }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) { reject(415, 'Codex 请求必须使用 application/json'); return }
    if (running) { reject(409, '已有 Codex 任务运行中，请先停止或等待完成'); return }
    running = true
    const controller = new AbortController(); let timedOut = false, disconnected = false, started = false
    let lastTool:CircuitAgentEvent|undefined,lastFailure:CircuitAgentEvent|undefined
    const timer = setTimeout(() => { timedOut = true; controller.abort(new CodexTimeoutError()) }, isStatus ? options.statusTimeoutMs ?? 15000 : options.timeoutMs ?? CODEX_GATEWAY_TIMEOUT_MS)
    const abort = () => { if (!res.writableEnded) { disconnected = true; controller.abort() } }
    res.once('close', abort)
    const emit = (event: unknown) => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`) }
    try {
      const raw = await readRequest(req, controller.signal)
      if (controller.signal.aborted) throw new Error('任务已停止')
      if (isStatus) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length) throw new RequestError(400, 'Codex 状态请求必须为空对象')
        const status = options.status ?? (await import('./codex-runtime')).getCodexStatus
        const result = await status({ signal: controller.signal })
        if (controller.signal.aborted) throw new Error('任务已停止')
        // Keep account/config details private even if the runtime adds internal fields later.
        const publicStatus: CodexStatus = { installed: result.installed, available: result.available, authenticated: result.authenticated,
          version: result.version, model: result.model, message: result.message }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(publicStatus))
        return
      }
      let request: CodexRequest
      try { request = parseCodexRequest(raw) }
      catch (error) { throw new RequestError(400, error instanceof Error ? error.message : 'Codex 请求格式错误') }
      started = true
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' })
      emit({ type: 'started', engine: 'Codex', version: 'App Server' })
      const run = options.run ?? (await import('./codex-runtime')).runCodexAgent
      const result = await run(request, { signal: controller.signal, onEvent: event=>{
        lastTool=event
        if(event.status==='error')lastFailure=event
        else if(event.status==='completed'&&lastFailure?.name===event.name)lastFailure=undefined
        emit(event)
      } })
      // Only the trusted runtime can construct a validated interrupted result.
      // A normal cancellation/disconnect must never turn into a proposal.
      const recoveredDeadline = result.type === 'interrupted' && result.reason === 'timeout' && timedOut && controller.signal.reason instanceof CodexTimeoutError
      if (disconnected || controller.signal.aborted && !recoveredDeadline) throw new Error('任务已停止')
      emit(result)
    } catch (error) {
      if (!res.destroyed) {
        if (!started) reject(error instanceof RequestError ? error.status : timedOut ? 504 : 500,
          error instanceof RequestError ? error.message : timedOut ? 'Codex 请求超时' : '本机 Codex 状态或请求失败')
        else {
          const context=lastFailure?`。最近失败的电路步骤 ${lastFailure.name}：${lastFailure.detail.slice(0,2000)}；按此提示修正后重试`
            :lastTool?`。最后执行步骤 ${lastTool.name}（${lastTool.status==='completed'?'已完成':lastTool.status==='running'?'执行中':'失败'}）：${lastTool.detail.slice(0,500)}`:''
          emit({ type:'error',error:timedOut?`Codex 任务超过时间限制，已停止${context}`:error instanceof Error?error.message.slice(0,8000):`Codex 执行失败${context}` })
        }
      }
    } finally {
      clearTimeout(timer); res.off('close', abort)
      running = false
      if (!res.destroyed && !res.writableEnded) res.end()
    }
  }
}

export function codexGatewayPlugin(): Plugin {
  return { name: 'local-codex-agent-gateway',
    configureServer(server) { server.middlewares.use(createCodexMiddleware()) },
    configurePreviewServer(server) { server.middlewares.use(createCodexMiddleware()) },
  }
}
