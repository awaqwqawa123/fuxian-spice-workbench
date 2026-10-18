import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import { DESKTOP_CIRCUIT_API, type DesktopCircuitStart, type DesktopCircuitSync } from '../src/core/desktop-circuit'
import { DesktopCircuitError, DesktopCircuitManager, type DesktopCircuitManagerOptions } from './desktop-circuit-manager'
import { handleWorkbenchMcp, workbenchMcpTools, workbenchMcpVersions } from './workbench-mcp'

const prefix = `${DESKTOP_CIRCUIT_API}/`
const MAX_BODY = 2 * 1024 * 1024
function isLoopback(req: IncomingMessage): boolean {
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(req.headers.host ?? '')
}
function browserRequest(req: IncomingMessage): boolean {
  if (!isLoopback(req) || req.headers['sec-fetch-site'] === 'cross-site') return false
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return false
  return req.method === 'GET' ? req.headers['x-fuxian-desktop'] === '1' : req.headers.origin === `http://${req.headers.host}`
}
function object(raw: unknown, fields: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key))) throw new DesktopCircuitError(400, '请求字段不正确')
  return raw as Record<string, unknown>
}
function readBody(req: IncomingMessage, timeout: number): Promise<unknown> {
  return new Promise((accept, reject) => {
    let size = 0, settled = false
    const chunks: Buffer[] = []
    const timer = setTimeout(() => fail(new DesktopCircuitError(408, '请求正文接收超时')), timeout)
    function cleanup() { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted) }
    function fail(error: Error) { if (settled) return; settled = true; cleanup(); req.pause(); reject(error) }
    function data(value: Buffer | string) { const chunk = Buffer.from(value); size += chunk.length; if (size > MAX_BODY) fail(new DesktopCircuitError(413, '电路请求超过 2 MiB 上限')); else chunks.push(chunk) }
    function end() { if (settled) return; settled = true; cleanup(); try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new DesktopCircuitError(400, '请求不是有效 JSON')) } }
    function aborted() { fail(new DesktopCircuitError(400, '请求已断开')) }
    if (Number(req.headers['content-length']) > MAX_BODY) { fail(new DesktopCircuitError(413, '电路请求超过 2 MiB 上限')); return }
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted)
  })
}
export function createDesktopCircuitMiddleware(options: DesktopCircuitManagerOptions & { manager?: DesktopCircuitManager; bodyTimeoutMs?: number }) {
  const manager = options.manager ?? new DesktopCircuitManager(options)
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!(req.url ?? '').split('?')[0].startsWith(prefix)) { next(); return }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    const reply = (status: number, value: unknown) => { if (!res.destroyed) { if (!req.complete) res.setHeader('Connection', 'close'); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) } }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost'), action = url.pathname.slice(prefix.length)
      const agent = action.startsWith('agent/') || action === 'mcp'
      if (agent) {
        // Agents use a local capability file, never browser Origin/cookies or an exposed token.
        if (!isLoopback(req) || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined || !manager.authenticates(req.headers.authorization)) throw new DesktopCircuitError(403, '电路工具只接受本机 Agent 凭证请求')
      } else if (!browserRequest(req)) throw new DesktopCircuitError(403, '画布同步只接受本机同源请求')
      if (action === 'mcp-info') {
        if (req.method !== 'GET') throw new DesktopCircuitError(405, 'MCP 连接信息使用 GET')
        if (url.search) throw new DesktopCircuitError(400, 'MCP 连接信息不接受 URL 参数')
        const status = await manager.workbenchStatus() // Await restoration; ready describes the interface, even with no projects.
        reply(200, { ...manager.mcpConnectionInfo(workbenchMcpTools.length),
          synchronizedProjectCount: status.projects.count,
          runningTaskCount: status.tasks.byStatus.running,
          interruptedTaskCount: status.tasks.byStatus.interrupted,
        }); return
      }
      if (action === 'mcp') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new DesktopCircuitError(405, 'MCP 使用 POST JSON；此服务不提供 SSE 流') }
        if (url.search) throw new DesktopCircuitError(400, 'MCP 不接受 URL 参数')
        const version = req.headers['mcp-protocol-version']
        if (version !== undefined && !workbenchMcpVersions.includes(version as typeof workbenchMcpVersions[number])) throw new DesktopCircuitError(400, '不支持此 MCP 协议版本')
        if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new DesktopCircuitError(415, 'MCP 请求必须使用 application/json')
        let raw: unknown
        try { raw = await readBody(req, options.bodyTimeoutMs ?? 10000) }
        catch (error) {
          if (error instanceof DesktopCircuitError && error.status === 400 && error.message === '请求不是有效 JSON') {
            reply(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return
          }
          throw error
        }
        const response = await handleWorkbenchMcp(manager, raw)
        if (response.body === undefined) { res.writeHead(response.status); res.end() }
        else reply(response.status, response.body)
        return
      }
      if (action === 'state') {
        if (req.method !== 'GET') throw new DesktopCircuitError(405, '画布状态使用 GET')
        if ([...url.searchParams.keys()].some(key => key !== 'projectId') || url.searchParams.getAll('projectId').length !== 1) throw new DesktopCircuitError(400, 'projectId 参数不正确')
        reply(200, await manager.state(url.searchParams.get('projectId')!)); return
      }
      if (!['sync','cancel','agent/list','agent/inspect','agent/start','agent/call','agent/edit','agent/diff','agent/finish','agent/cancel'].includes(action)) throw new DesktopCircuitError(404, '没有该电路接口')
      if (req.method !== 'POST') throw new DesktopCircuitError(405, '电路操作使用 POST')
      if (url.search) throw new DesktopCircuitError(400, '电路操作不接受 URL 参数')
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new DesktopCircuitError(415, '请求必须使用 application/json')
      const raw = await readBody(req, options.bodyTimeoutMs ?? 10000)
      if (action === 'sync') { const body = object(raw, ['projectId','project','expectedRevision']); reply(200, await manager.sync(body as unknown as DesktopCircuitSync)) }
      else if (action === 'cancel') { const body = object(raw, ['projectId','taskId']); reply(200, await manager.cancelProjectTask(body.projectId as string, body.taskId as string)) }
      else if (action === 'agent/list') { object(raw, []); reply(200, await manager.list()) }
      else if (action === 'agent/inspect') { const body = object(raw, ['projectId','sourceTaskId']); reply(200, await manager.inspect(body.projectId as string, body.sourceTaskId as string | undefined)) }
      else if (action === 'agent/start') { const body = object(raw, ['projectId','expectedRevision','requestId','request','layoutOnly','sourceTaskId']); reply(200, await manager.start(body as unknown as DesktopCircuitStart)) }
      else if (action === 'agent/call') { const body = object(raw, ['taskId','name','input']); reply(200, await manager.call(body.taskId as string, body.name as string, body.input)) }
      else if (action === 'agent/edit') { const body = object(raw, ['taskId','expectedCandidateRevision','operationId','operations']); reply(200, await manager.editCandidate(body as unknown as Parameters<typeof manager.editCandidate>[0])) }
      else if (action === 'agent/diff') { const body = object(raw, ['taskId','expectedCandidateRevision']); reply(200, await manager.diffCandidate(body)) }
      else if (action === 'agent/finish') { const body = object(raw, ['taskId','summary']); reply(200, await manager.finish(body.taskId as string, body.summary as string)) }
      else { const body = object(raw, ['taskId']); reply(200, await manager.cancel(body.taskId as string)) }
    } catch (error) {
      reply(error instanceof DesktopCircuitError ? error.status : 500, { error: error instanceof DesktopCircuitError ? error.message.slice(0, 2400) : '本机电路工具服务失败；原工程未被自动修改，请检查服务日志' })
    }
  }
  return Object.assign(middleware, { manager, close: () => manager.close() })
}

export function desktopCircuitPlugin(options: Partial<DesktopCircuitManagerOptions> & { onManager?: (manager: DesktopCircuitManager) => void } = {}): Plugin {
  let root = process.cwd()
  const install = (server: ViteDevServer | PreviewServer) => {
    const middleware = createDesktopCircuitMiddleware({ ...options, directory: options.directory ?? join(root, '.desktop-circuit'), projectDirectory: options.projectDirectory ?? root })
    options.onManager?.(middleware.manager)
    server.middlewares.use(middleware)
    const publish = () => {
      const address = server.httpServer?.address()
      if (address && typeof address !== 'string') void middleware.manager.connect(`http://127.0.0.1:${address.port}`).catch(error => server.config.logger.error(`电路工具连接初始化失败：${(error as Error).message}`))
    }
    if (server.httpServer?.listening) publish(); else server.httpServer?.once('listening', publish)
    server.httpServer?.once('close', () => { void middleware.close().catch(() => {}) })
  }
  return { name: 'local-desktop-circuit-tools', configResolved(config) { root = config.root }, configureServer: install, configurePreviewServer: install }
}
