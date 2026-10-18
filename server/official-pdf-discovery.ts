import { lookup } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { approvedProxyFor, assertPublicDatasheetHost, loopbackProxyAgent } from './datasheet-proxy'
import { publicAddress } from './public-network'

export interface OfficialPdfLead { url: string; title: string }
type Probe = (url: string, signal?: AbortSignal) => Promise<boolean>

/** Predict only documented, part-named vendor PDF routes; a HEAD must confirm PDF before listing one. */
export function officialPdfRoutes(part: string): OfficialPdfLead[] {
  const exact = part.trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(exact)) return []
  const leads: OfficialPdfLead[] = [
    { url: `https://www.ti.com/lit/ds/symlink/${exact.toLowerCase()}.pdf`, title: `Texas Instruments ${exact} 官方规格书` },
    { url: `https://www.analog.com/media/en/technical-documentation/data-sheets/${exact}.pdf`, title: `Analog Devices ${exact} 官方规格书` },
  ]
  // This is a known public family PDF, not a guessed document for each order code.
  // In particular, its order-code table does not establish LR432ALTL1G.
  if (/^LR432[A-Z0-9-]*$/.test(exact)) leads.push({
    url: 'https://www.lrc.cn/Upload/PDF/Product/IC/VOR/LR432XXTLT1G.pdf',
    title: '乐山无线电 LR432XXTLT1G 系列规格书（非所搜订货型号的精确资料）',
  })
  return leads
}

/** HEAD checks document existence and MIME without downloading or trusting a search result. */
export async function probeOfficialPdf(raw: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
    !(url.hostname === 'www.ti.com' && /^\/lit\/ds\/symlink\/[a-z0-9-]{2,40}\.pdf$/.test(url.pathname) ||
      url.hostname === 'www.analog.com' && /^\/media\/en\/technical-documentation\/data-sheets\/[A-Z0-9-]{2,40}\.pdf$/.test(url.pathname) ||
      url.hostname === 'www.lrc.cn' && url.pathname === '/Upload/PDF/Product/IC/VOR/LR432XXTLT1G.pdf')) {
    throw new Error('厂商规格书探测地址不受支持')
  }
  const proxy = await approvedProxyFor(url.hostname, signal)
  if (proxy) await assertPublicDatasheetHost(url.hostname, signal)
  signal?.throwIfAborted()
  const tunnel = proxy ? loopbackProxyAgent(proxy, url.hostname) : undefined
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: 'HEAD', agent: tunnel?.agent, headers: { 'User-Agent': 'SPICE-Workbench/0.25', Accept: 'application/pdf' }, lookup(host, options, done) {
      lookup(host, { all: true }, (error, addresses) => {
        if (error) { done(error, '', 4); return }
        if (!addresses.length || addresses.some(item => !publicAddress(item.address))) { done(new Error('厂商域名解析到非公网地址'), '', 4); return }
        if (options.all) (done as unknown as (error: null, records: { address: string; family: number }[]) => void)(null, addresses)
        else done(null, addresses[0].address, addresses[0].family)
      })
    } }, response => {
      response.resume()
      resolve(response.statusCode === 200 && /^application\/pdf\b/i.test(String(response.headers['content-type'] ?? '')) && Number(response.headers['content-length'] ?? 0) <= 12 * 1024 * 1024)
    })
    const timeout = setTimeout(() => { const error = new Error('厂商规格书探测超时'); request.destroy(error); tunnel?.destroy(error) }, 6_000)
    const abort = () => { const error = new Error('规格书探测已取消'); request.destroy(error); tunnel?.destroy(error) }
    signal?.addEventListener('abort', abort, { once: true })
    request.on('close', () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); tunnel?.destroy() })
    request.on('error', reject)
    request.end()
  })
}

export async function discoverOfficialPdfs(part: string, probe: Probe = probeOfficialPdf, signal?: AbortSignal): Promise<OfficialPdfLead[]> {
  const routes = officialPdfRoutes(part)
  const results = await Promise.all(routes.map(async item => {
    try { return await probe(item.url, signal) ? item : undefined }
    catch (error) { signal?.throwIfAborted(); if ((error as Error).name === 'AbortError') throw error; return undefined }
  }))
  return results.filter((item): item is OfficialPdfLead => Boolean(item))
}
