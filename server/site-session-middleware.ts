import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSiteSessionId, siteSessionSites, type SiteBrowserStatus, type SiteSessionId, type SiteSessionState, type SiteSessionStatus } from '../src/core/site-sessions'

const states = new Set<SiteSessionState>(['not-connected', 'login-open', 'saved', 'ready', 'needs-action', 'error'])
class InvalidSiteRequest extends Error {}

function publicSiteStatus(site: typeof siteSessionSites[number], value: SiteSessionStatus | undefined): SiteSessionStatus {
  return {
    id: site.id, label: site.label,
    state: value && states.has(value.state) ? value.state : 'error',
    detail: typeof value?.detail === 'string' ? value.detail.slice(0, 300) : '网站连接状态暂不可用',
    ...(typeof value?.updatedAt === 'string' ? { updatedAt: value.updatedAt.slice(0, 40) } : {}),
  }
}
function publicStatus(status: SiteBrowserStatus): SiteBrowserStatus {
  return {
    available: status.available === true,
    ...(typeof status.browserName === 'string' ? { browserName: status.browserName.slice(0, 80) } : {}),
    running: status.running === true,
    sites: siteSessionSites.map(site => publicSiteStatus(site, status.sites.find(item => item.id === site.id))),
  }
}

export interface SiteSessionController {
  status(): SiteBrowserStatus | Promise<SiteBrowserStatus>
  open(site: SiteSessionId, signal?: AbortSignal): Promise<SiteSessionStatus>
  check(site: SiteSessionId, signal?: AbortSignal): Promise<SiteSessionStatus>
  forget(site: SiteSessionId): Promise<SiteSessionStatus>
}

/** Keep the browser profile behind a local, same-origin, fixed-action API. */
export function createSiteSessionMiddleware(controller: SiteSessionController, bodyDeadlineMs = 10_000) {
  let active = 0
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url?.split('?')[0] !== '/api/model-library/site-sessions') { next(); return }
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const send = (code: number, payload: object) => {
      if (!res.destroyed && !res.writableEnded) { res.statusCode = code; res.end(JSON.stringify(payload)) }
    }
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    const host = req.headers.host ?? ''
    if (!local || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host) || req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] === 'cross-site') {
      send(403, { error: '网站连接只接受本机工作台同源请求' }); return
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(405, { error: '仅接受 POST' }); return }
    if (req.url?.includes('?') || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { send(400, { error: '需要 JSON 请求，不接受网址参数' }); return }
    if (active >= 2) { send(429, { error: '网站连接操作正在处理中，请稍后重试' }); return }
    active++
    const cancellation = new AbortController()
    const disconnect = () => { if (!res.writableEnded) cancellation.abort() }
    res.on('close', disconnect)
    const deadline = setTimeout(() => req.destroy(new Error('网站连接请求读取超时')), bodyDeadlineMs)
    try {
      let body = ''
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 512) throw new InvalidSiteRequest('请求超过大小限制') }
      clearTimeout(deadline)
      let data: unknown
      try { data = JSON.parse(body) } catch { throw new InvalidSiteRequest('需要有效的 JSON 请求') }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InvalidSiteRequest('网站连接请求参数不正确')
      const input = data as Record<string, unknown>
      const action = input.action
      if (action === 'status' && Object.keys(input).length === 1) { send(200, publicStatus(await controller.status())); return }
      if (!['open', 'check', 'forget'].includes(String(action)) || Object.keys(input).length !== 2 || !isSiteSessionId(input.site)) throw new InvalidSiteRequest('网站连接请求参数不正确')
      const result = action === 'open' ? await controller.open(input.site, cancellation.signal) : action === 'check' ? await controller.check(input.site, cancellation.signal) : await controller.forget(input.site)
      send(200, publicSiteStatus(siteSessionSites.find(site => site.id === input.site)!, result))
    } catch (error) {
      send(error instanceof InvalidSiteRequest ? 400 : 503, { error: error instanceof InvalidSiteRequest ? error.message : '网站连接操作失败；请检查浏览器连接状态后重试' })
    }
    finally { clearTimeout(deadline); res.off('close', disconnect); active-- }
  }
}
