import type { IncomingMessage, ServerResponse } from 'node:http'
import { CodexInstallationError, CodexInstallationStore, validateCodexExecutable } from './codex-installation'

export interface CodexInstallationInfo {
  configuredPath: string | null
  effectivePath: string | null
  source: 'manual' | 'automatic'
  available: boolean
  message: string
}

function sameLocalOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') || req.headers['sec-fetch-site'] === 'cross-site' || req.headers['x-fuxian-codex-installation'] !== '1') return false
  if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) return false
  return req.method === 'GET' || req.headers.origin === `http://${host}`
}

function readBody(req: IncomingMessage, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, settled = false
    const timer = setTimeout(() => fail(new CodexInstallationError(408, 'Codex 路径请求接收超时')), timeoutMs)
    function cleanup() { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted) }
    function fail(error: Error) { if (settled) return; settled = true; cleanup(); req.pause(); reject(error) }
    function data(value: Buffer | string) { const chunk = Buffer.from(value); bytes += chunk.length; if (bytes > 8192) fail(new CodexInstallationError(413, 'Codex 路径请求超过上限')); else chunks.push(chunk) }
    function end() { if (settled) return; settled = true; cleanup(); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new CodexInstallationError(400, 'Codex 路径请求不是有效 JSON')) } }
    function aborted() { fail(new CodexInstallationError(400, 'Codex 路径请求已断开')) }
    if (Number(req.headers['content-length']) > 8192) { fail(new CodexInstallationError(413, 'Codex 路径请求超过上限')); return }
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted)
  })
}

export function createCodexInstallationMiddleware(options: { store: CodexInstallationStore; findAutomatic: () => Promise<string | null>; bodyTimeoutMs?: number }) {
  const info = async (): Promise<CodexInstallationInfo> => {
    const configuredPath = await options.store.read()
    if (configuredPath !== null) {
      try { return { configuredPath, effectivePath: await validateCodexExecutable(configuredPath), source: 'manual', available: true, message: '已使用手动指定的 Codex 程序；新连接和新任务使用此路径，登录状态需另行检测。' } }
      catch (cause) { return { configuredPath, effectivePath: null, source: 'manual', available: false, message: (cause as Error).message } }
    }
    const effectivePath = await options.findAutomatic()
    return { configuredPath: null, effectivePath, source: 'automatic', available: effectivePath !== null, message: effectivePath ? '使用环境变量、PATH 或默认安装位置自动检测到的 Codex 程序。' : '未自动找到 Codex，可粘贴程序的完整安装路径。' }
  }
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url?.split('?')[0] !== '/api/codex/installation') { next(); return }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    const reply = (status: number, value: unknown) => { if (!res.destroyed) { if (!req.complete) res.setHeader('Connection', 'close'); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) } }
    try {
      if (!sameLocalOrigin(req)) throw new CodexInstallationError(403, 'Codex 路径设置只接受本机工作台同源请求')
      if (req.url?.includes('?')) throw new CodexInstallationError(400, 'Codex 路径设置不接受 URL 参数')
      if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); throw new CodexInstallationError(405, 'Codex 路径设置使用 GET 或 POST') }
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new CodexInstallationError(415, 'Codex 路径设置必须使用 JSON')
        const body = await readBody(req, options.bodyTimeoutMs ?? 5000)
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'executable')) throw new CodexInstallationError(400, 'Codex 路径设置只接受 executable 字段')
        await options.store.update((body as { executable: unknown }).executable)
      }
      reply(200, await info())
    } catch (cause) { reply(cause instanceof CodexInstallationError ? cause.status : 500, { error: cause instanceof Error ? cause.message : 'Codex 路径设置失败' }) }
  }
}
