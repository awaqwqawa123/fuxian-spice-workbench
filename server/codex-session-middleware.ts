import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { parseProject } from '../src/core/circuit'
import { CodexRuntimeError } from './codex-runtime'
import { CodexSessionManager, type CodexSessionManagerOptions } from './codex-session-manager'
import { CodexSessionError } from './codex-session-store'
import { validWorkbenchProjectId } from '../src/core/codex-workbench-link'

const prefix = '/api/codex-session/'
const MAX_BODY = 192 * 1024
function localRequest(req: IncomingMessage) {
  const host = req.headers.host
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') || !host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host) || req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin && ![`http://${host}`,`https://${host}`].includes(origin)) return false
  return req.method === 'GET' ? req.headers['x-fuxian-session'] === '1' : !!origin
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new CodexSessionError(400, '工作台会话请求字段不正确')
  return value as Record<string, unknown>
}
function readBody(req: IncomingMessage, timeout: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false
    const chunks: Buffer[] = []
    const timer = setTimeout(() => fail(new CodexSessionError(408, '请求正文接收超时')), timeout)
    function cleanup() { clearTimeout(timer); req.off('data',data); req.off('end',end); req.off('error',fail); req.off('aborted',aborted) }
    function fail(error: Error) { if (settled) return; settled = true; cleanup(); req.pause(); reject(error) }
    function aborted() { fail(new CodexSessionError(400, '请求已断开')) }
    function data(part: Buffer | string) { const chunk = Buffer.from(part); size += chunk.length; if (size > MAX_BODY) fail(new CodexSessionError(413, '工作台项目内容过大')); else chunks.push(chunk) }
    function end() {
      if (settled) return
      settled = true; cleanup()
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new CodexSessionError(400, '请求不是有效 JSON')) }
    }
    if (Number(req.headers['content-length']) > MAX_BODY) { fail(new CodexSessionError(413, '工作台项目内容过大')); return }
    req.on('data',data); req.once('end',end); req.once('error',fail); req.once('aborted',aborted)
  })
}
export function createCodexSessionMiddleware(options: CodexSessionManagerOptions & { bodyTimeoutMs?: number; manager?: CodexSessionManager }) {
  const manager = options.manager ?? new CodexSessionManager(options)
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!(req.url ?? '').split('?')[0].startsWith(prefix)) { next(); return }
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff')
    const reply = (status: number, value: unknown) => { if (!res.destroyed) { if (!req.complete) res.setHeader('Connection','close'); res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)) } }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost'), action = url.pathname.slice(prefix.length)
      if (!localRequest(req)) throw new CodexSessionError(403, '工作台会话只接受本机同源请求')
      if (action === 'state') {
        if (req.method !== 'GET') throw new CodexSessionError(405, '会话状态使用 GET')
        if ([...url.searchParams.keys()].some(key => key !== 'id')) throw new CodexSessionError(400,'会话状态参数不正确')
        reply(200, await manager.state(url.searchParams.get('id') ?? '')); return
      }
      if (!['create','send','cancel','refresh','check-write-access','bind-workbench'].includes(action)) throw new CodexSessionError(404,'未找到工作台会话接口')
      if (req.method !== 'POST') throw new CodexSessionError(405,'工作台会话操作使用 POST')
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new CodexSessionError(415,'请求必须使用 application/json')
      const raw = await readBody(req, options.bodyTimeoutMs ?? 10000)
      const workbench = (projectId: unknown) => {
        if (!validWorkbenchProjectId(projectId)) throw new CodexSessionError(400, '网页项目编号格式不正确')
        // localRequest checked this exact Origin against the request Host and loopback socket.
        return { origin: req.headers.origin!, projectId }
      }
      if (action === 'create') {
        const body = object(raw,['project','projectId'])
        let project
        try { project = parseProject(body.project,{allowDraft:true}) } catch { throw new CodexSessionError(400,'项目格式不正确') }
        reply(201, await manager.create(project, body.projectId === undefined ? undefined : workbench(body.projectId)))
      } else if (action === 'send') {
        const body = object(raw,['id','message','requestId','project','context','projectId','revision'])
        let project
        if (body.project !== undefined) { try { project=parseProject(body.project,{allowDraft:true}) } catch { throw new CodexSessionError(400,'项目格式不正确') } }
        reply(202, await manager.send({ id: body.id as string, message: body.message as string, requestId: body.requestId as string, ...(project ? {project} : {}), ...(body.context !== undefined ? {context:body.context as string} : {}), ...(body.revision !== undefined ? {revision:body.revision} : {}), ...(body.projectId !== undefined ? {workbench:workbench(body.projectId)} : {}) }))
      } else if (action === 'bind-workbench') {
        const body = object(raw, ['id','projectId'])
        reply(200, await manager.bindWorkbench(body.id as string, workbench(body.projectId)))
      } else { const body=object(raw,['id']); reply(200,await (action === 'refresh' ? manager.refresh(body.id as string) : action === 'check-write-access' ? manager.checkWriteAccess(body.id as string) : manager.cancel(body.id as string))) }
    } catch (error) {
      reply(error instanceof CodexSessionError ? error.status : 500, {error:error instanceof CodexSessionError || error instanceof CodexRuntimeError ? error.message : '本机工作台会话服务失败，请检查本地服务'})
    }
  }
  return Object.assign(middleware,{manager,close:()=>manager.close()})
}
export function codexSessionPlugin(options: Partial<CodexSessionManagerOptions> = {}): Plugin {
  let root = process.cwd()
  const install = (server: { middlewares: { use: (middleware: ReturnType<typeof createCodexSessionMiddleware>) => unknown }; httpServer?: { once: (event: string, listener: () => void) => unknown } | null }) => {
    const middleware = createCodexSessionMiddleware({ ...options, directory: options.directory ?? join(root,'.codex-sessions'), projectDirectory: options.projectDirectory ?? root })
    server.middlewares.use(middleware)
    server.httpServer?.once('close',()=>{void middleware.close()})
  }
  return {name:'local-codex-persistent-session',configResolved(config){root=config.root},configureServer:install,configurePreviewServer:install}
}
