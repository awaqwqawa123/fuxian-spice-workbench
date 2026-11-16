import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { lstat, readFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { MAX_PROJECT_FILE_BYTES } from '../src/core/project-file'

const route = '/api/open-project-handoff'
const ttl = 5 * 60_000
class Rejected extends Error {
  constructor(readonly status: number) { super('无法打开这份工程，请重新双击原文件。') }
}

export function createProjectOpenHandoff(directory?: string) {
  const inbox = directory && isAbsolute(directory) ? join(directory,'open-project-inbox') : undefined
  const claiming = new Set<string>()
  return async (req:IncomingMessage,res:ServerResponse,next:()=>void) => {
    if (req.url?.split('?')[0] !== route) { next(); return }
    res.setHeader('Cache-Control','no-store')
    res.setHeader('X-Content-Type-Options','nosniff')
    try {
      if (!inbox) throw new Rejected(404)
      const host = req.headers.host ?? ''
      if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') ||
        !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host) ||
        req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] === 'cross-site' ||
        req.headers['x-fuxian-project-open'] !== '1') throw new Rejected(403)
      if (req.method !== 'POST' || req.url !== route || req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Rejected(400)
      const chunks:Buffer[] = []
      let size = 0
      // A generated capability plus JSON envelope never needs more than 256 bytes.
      if (req.headers['transfer-encoding'] || !req.headers['content-length'] || Number(req.headers['content-length']) > 256) throw new Rejected(413)
      for await (const part of req) {
        const chunk = Buffer.from(part); size += chunk.length
        if (size > 256) throw new Rejected(413)
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || typeof body.token !== 'string' || !/^[a-f0-9]{32}$/.test(body.token)) throw new Rejected(400)
      const token = body.token as string
      // Concurrent contenders in the same server must not race the Windows
      // filesystem rename. The rename still consumes the request across restarts.
      if (claiming.has(token)) throw new Rejected(404)
      claiming.add(token)
      const source = join(inbox,body.token+'.fuxian'), claim = join(inbox,body.token+'.'+randomUUID()+'.claimed')
      try {
        try { await rename(source,claim) } catch { throw new Rejected(404) }
        try {
          const info = await lstat(claim)
          if (!info.isFile() || info.size < 1 || info.size > MAX_PROJECT_FILE_BYTES || Date.now()-info.mtimeMs > ttl || info.mtimeMs > Date.now()+60_000) throw new Rejected(410)
          const bytes = await readFile(claim)
          if (bytes.length !== info.size || bytes.length > MAX_PROJECT_FILE_BYTES) throw new Rejected(410)
          res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length})
          res.end(bytes)
        } finally { await unlink(claim).catch(()=>{}) }
      } finally { claiming.delete(token) }
    } catch (err) {
      if (!req.complete) { res.setHeader('Connection','close'); req.resume() }
      const status = err instanceof Rejected ? err.status : err instanceof SyntaxError ? 400 : 503
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'})
      res.end(JSON.stringify({error:'无法打开这份工程，请重新双击原文件。'}))
    }
  }
}

export function projectOpenHandoffPlugin(): Plugin {
  const handler = createProjectOpenHandoff(process.env.FUXIAN_SERVICE_DIRECTORY)
  return {name:'fuxian-open-project-handoff', configurePreviewServer(server) { server.middlewares.use(handler) }}
}
