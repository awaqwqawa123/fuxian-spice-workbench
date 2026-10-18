import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import { USER_LIBRARY_API } from '../src/core/user-library-sync'
import { UserLibraryStore } from './user-library-store'

const MAX_BODY = 32 * 1024 * 1024
class RequestError extends Error { constructor(readonly status: number, message: string) { super(message) } }
function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = []; let size = 0, settled = false
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted) }
    const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); req.pause(); reject(error) }
    const aborted = () => fail(new RequestError(400, '保存请求已断开'))
    const data = (value: Buffer | string) => { const chunk = Buffer.from(value); size += chunk.length; if (size > MAX_BODY) fail(new RequestError(413, '自建库请求超过 32 MB')); else chunks.push(chunk) }
    const end = () => { if (settled) return; settled = true; cleanup(); try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new RequestError(400, '自建库请求不是有效 JSON')) } }
    const timer = setTimeout(() => fail(new RequestError(408, '自建库保存请求超时')), 10000)
    if (Number(req.headers['content-length']) > MAX_BODY) { fail(new RequestError(413, '自建库请求超过 32 MB')); return }
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted)
  })
}
export function createUserLibraryMiddleware(options: { directory: string; store?: UserLibraryStore }) {
  const store = options.store ?? new UserLibraryStore(options.directory)
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== USER_LIBRARY_API && !path.startsWith(`${USER_LIBRARY_API}/`)) { next(); return }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    const reply = (status: number, value: unknown) => { if (!res.destroyed) { if (!req.complete) res.setHeader('Connection', 'close'); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) } }
    try {
      const host = req.headers.host ?? ''
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host) || req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && req.headers.origin !== `http://${host}`) throw new RequestError(403, '自建库只接受本机同源请求')
      if (req.url?.includes('?')) throw new RequestError(400, '自建库接口不接受 URL 参数')
      if (path === USER_LIBRARY_API && req.method === 'GET') {
        if (req.headers['x-fuxian-user-library'] !== '1') throw new RequestError(403, '自建库读取需要本机页面请求')
        reply(200, { document: await store.load() }); return
      }
      if (!['merge', 'remove'].includes(path.slice(USER_LIBRARY_API.length + 1))) throw new RequestError(404, '没有该自建库接口')
      if (req.method !== 'POST') throw new RequestError(405, '自建库操作使用 POST')
      if (req.headers.origin !== `http://${host}`) throw new RequestError(403, '自建库保存需要同源请求')
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new RequestError(415, '自建库请求必须使用 application/json')
      const raw = await body(req)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RequestError(400, '自建库请求字段不正确')
      const value = raw as Record<string, unknown>, action = path.slice(USER_LIBRARY_API.length + 1)
      if (action === 'merge') {
        if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'document')) throw new RequestError(400, '自建库合并字段不正确')
        reply(200, await store.merge(value.document))
      } else {
        if (Object.keys(value).length !== 1 || typeof value.id !== 'string') throw new RequestError(400, '自建库移除字段不正确')
        reply(200, await store.remove(value.id))
      }
    } catch (error) { reply(error instanceof RequestError ? error.status : 409, { error: (error as Error).message.slice(0, 2000) }) }
  }
}
export function userLibraryPlugin(options: { directory?: string } = {}): Plugin {
  let root = process.cwd()
  const install = (server: ViteDevServer | PreviewServer) => { server.middlewares.use(createUserLibraryMiddleware({ directory: options.directory ?? join(root, '.desktop-circuit') })) }
  return { name: 'persistent-personal-model-library', configResolved(config) { root = config.root }, configureServer: install, configurePreviewServer: install }
}
