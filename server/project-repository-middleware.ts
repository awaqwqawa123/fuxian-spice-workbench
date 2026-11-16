import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import { PROJECT_REPOSITORY_LIMIT, ProjectRepository, ProjectRepositoryError, projectRepositoryDirectory } from './project-repository'

const route = '/api/project-repository'
const fail = (status: number, message: string) => new ProjectRepositoryError(status, message)
const emptyBody = () => fail(400, '本机工程库请求须为有效 JSON')
type Options = { directory?: string; store?: ProjectRepository }
const hostPattern = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const length = Number(req.headers['content-length'] ?? 0)
    const max = PROJECT_REPOSITORY_LIMIT + 512 * 1024
    const tooLarge = () => fail(413, '工程库请求超过大小上限')
    if (length > max) { reject(tooLarge()); return }
    const chunks: Buffer[] = []
    let bytes = 0, stopped = false
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', chunk)
      req.off('end', end)
      req.off('error', error)
      req.off('aborted', aborted)
    }
    const error = (cause: Error) => {
      if (stopped) return
      stopped = true; cleanup(); req.pause()
      reject(cause)
    }
    const aborted = () => error(fail(400, '本机工程库请求已断开'))
    const chunk = (buffer: Buffer) => {
      bytes += buffer.length
      if (bytes > max) error(tooLarge())
      else chunks.push(buffer)
    }
    const end = () => {
      if (stopped) return
      stopped = true; cleanup()
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(emptyBody()) }
    }
    const timer = setTimeout(() => error(fail(408, '本机工程库请求超时')), 15000)
    req.on('data', chunk); req.once('end', end); req.once('error', error); req.once('aborted', aborted)
  })
}

export function createProjectRepositoryMiddleware(options: Options = {}) {
  let repository = options.store
  return async function projectRepositoryMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    if (req.url?.split('?')[0] !== route) { next(); return }
    function reply(status: number, payload: unknown) {
      if (res.destroyed) return
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      if (!req.complete) res.setHeader('Connection', 'close')
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    try {
      const host = req.headers.host ?? ''
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') || !hostPattern.test(host) ||
        req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] === 'cross-site' ||
        req.headers['x-fuxian-project-repository'] !== '1') throw fail(403, '本机工程库只接受工作台的同源请求')
      if (req.url !== route) throw fail(400, '工程库接口不接受 URL 参数')
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw fail(405, '工程库操作使用 POST') }
      if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw fail(415, '本机工程库请求须使用 application/json')
      const raw = await readBody(req)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw emptyBody()
      const value = raw as Record<string, unknown>
      const fields = (...extra: string[]) => {
        if (Object.keys(value).length !== extra.length + 1 || extra.some(key => !Object.hasOwn(value, key))) throw fail(400, '工程库请求字段不正确')
      }
      const store = () => repository ??= new ProjectRepository(options.directory ?? projectRepositoryDirectory())
      switch (value.action) {
        case 'bootstrap':
          fields(); reply(200, await store().bootstrap()); return
        case 'list-backups':
          fields('offset'); reply(200, await store().listBackups(value.offset)); return
        case 'read-backup':
          fields('id', 'updatedAt'); reply(200, { backup: await store().readBackup(value.id, value.updatedAt) }); return
        case 'save':
          fields('collection', 'expectedRevision')
          if (value.expectedRevision !== null && typeof value.expectedRevision !== 'string') throw fail(400, '本机工程修订标识无效')
          reply(200, await store().save(value.collection, value.expectedRevision)); return
        case 'migrate':
          fields('collection'); reply(200, await store().migrate(value.collection)); return
        case 'select':
          fields('activeId', 'expectedRevision')
          if (typeof value.activeId !== 'string' || typeof value.expectedRevision !== 'string') throw fail(400, '工程标识或修订无效')
          reply(200, await store().select(value.activeId, value.expectedRevision)); return
        default: throw fail(400, '未知的工程库操作')
      }
    } catch (error) {
      reply(error instanceof ProjectRepositoryError ? error.status : 503,
        { error: error instanceof ProjectRepositoryError ? error.message.slice(0, 1000) : '本机工程库服务暂时不可用；请保留草稿或导出工程。' })
    }
  }
}

export function projectRepositoryPlugin(options: Options = {}): Plugin {
  const install = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use(createProjectRepositoryMiddleware(options))
  }
  return { name: 'persistent-local-project-repository', configureServer: install, configurePreviewServer: install }
}
