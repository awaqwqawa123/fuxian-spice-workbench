import { request as httpsRequest } from 'node:https'
import { lookup } from 'node:dns'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { publicAddress } from './public-network'
import { allowedLcscDatasheetUrl } from './lcsc-source'
import { DATASHEET_LIMITS } from '../src/core/datasheet-limits'
import type { DatasheetCandidate, DatasheetDownload, DatasheetSearchResults } from '../src/core/datasheet-search'
import { opAmpModelFor } from '../src/core/opamp-models'
import { approvedProxyFor, assertPublicDatasheetHost, loopbackProxyAgent } from './datasheet-proxy'
import { searchGoogle } from './google-discovery'
import { searchAllDatasheet } from './alldatasheet-discovery'
import { createSiteSearchSource } from './site-access'
import type { ModelSearchSourceStatus } from '../src/core/model-search'
import { discoverOfficialPdfs, probeOfficialPdf, type OfficialPdfLead } from './official-pdf-discovery'
import { jlcCatalogSourceStatus, searchJlcCatalog, type JlcCatalogStatus } from './jlc-catalog'
import { searchStPublicCatalog, type StProductDiscovery } from './st-public-catalog'

const manufacturers: Record<string, string> = {
  'ti.com': 'Texas Instruments', 'analog.com': 'Analog Devices', 'onsemi.com': 'onsemi',
  'st.com': 'STMicroelectronics', 'infineon.com': 'Infineon', 'nexperia.com': 'Nexperia',
  'diodes.com': 'Diodes Incorporated', 'vishay.com': 'Vishay', 'microchip.com': 'Microchip',
  'toshiba.com': 'Toshiba', 'toshiba.semicon-storage.com': 'Toshiba', 'rohm.com': 'ROHM',
  'www.lrc.cn': '乐山无线电（LRC）',
  'atta.szlcsc.com': '立创商城资料库（请核对原厂型号）',
}
function manufacturer(host: string) { return Object.entries(manufacturers).find(([domain]) => host === domain || !['atta.szlcsc.com', 'www.lrc.cn'].includes(domain) && host.endsWith(`.${domain}`))?.[1] }
function queryVariants(raw: string): string[] {
  const query = raw.trim().toUpperCase()
  const alias = opAmpModelFor('OPA', query)?.id
  return [...new Set([query, alias].filter((value): value is string => Boolean(value)))]
}
export function allowedDatasheetUrl(raw: string, discovery = false): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || raw.length > 1800 || /[\x00-\x1f]/.test(raw)) throw new Error('规格书地址须为公开厂商的 HTTPS 网址')
  if (discovery && ['www.bing.com', 'cn.bing.com'].includes(url.hostname) && url.pathname === '/search' && url.searchParams.get('format') === 'rss') return url
  if (discovery && url.hostname === 'html.duckduckgo.com' && url.pathname === '/html/' && url.searchParams.size === 1 && url.searchParams.has('q')) return url
  if (url.hostname === 'atta.szlcsc.com') return allowedLcscDatasheetUrl(raw)
  if (!manufacturer(url.hostname)) throw new Error('目前仅下载已登记厂商官网的规格书；其他来源请手工下载后拖入')
  return url
}
interface DownloadedBytes { bytes: Buffer; url: string }
type FetchBytes = (url: string, limit: number, discovery?: boolean, signal?: AbortSignal) => Promise<DownloadedBytes>
export async function fetchDatasheetBytes(raw: string, limit: number, discovery = false, signal?: AbortSignal, redirects = 0): Promise<DownloadedBytes> {
  signal?.throwIfAborted()
  const url = allowedDatasheetUrl(raw, discovery)
  const proxy = await approvedProxyFor(url.hostname, signal)
  if (proxy) await assertPublicDatasheetHost(url.hostname, signal)
  signal?.throwIfAborted()
  const tunnel = proxy ? loopbackProxyAgent(proxy, url.hostname) : undefined
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { agent: tunnel?.agent, headers: { 'User-Agent': 'SPICE-Workbench/0.20', Accept: 'application/pdf,application/rss+xml,text/html,text/plain' }, lookup(host, options, done) {
      lookup(host, { all: true }, (error, addresses) => {
        if (error) { done(error, '', 4); return }
        if (!addresses.length || addresses.some(item => !publicAddress(item.address))) { done(new Error('规格书来源解析到非公网地址'), '', 4); return }
        if (options.all) (done as unknown as (error: null, records: { address: string; family: number }[]) => void)(null, addresses)
        else done(null, addresses[0].address, addresses[0].family)
      })
    } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume()
        if (redirects >= 3) { reject(new Error('规格书下载跳转次数过多')); return }
        try { const target = allowedDatasheetUrl(new URL(response.headers.location, url).href, discovery); resolve(fetchDatasheetBytes(target.href, limit, discovery, signal, redirects + 1)) } catch (error) { reject(error) }
        return
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`规格书来源返回 HTTP ${response.statusCode}，可手工下载后拖入`)); return }
      if (Number(response.headers['content-length'] ?? 0) > limit) { response.resume(); reject(new Error('规格书超过下载大小限制（PDF 最大 12 MB）')); return }
      const chunks: Buffer[] = []; let size = 0
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) { response.destroy(new Error('规格书超过下载大小限制（PDF 最大 12 MB）')); return } chunks.push(chunk) })
      response.on('error', reject); response.on('end', () => resolve({ bytes: Buffer.concat(chunks), url: url.href }))
    })
    // Deadline is per hop; at most three redirects (four hops, <= 60 seconds).
    const timer = setTimeout(() => { const error = new Error('规格书来源连接超时，请稍后重试或手工导入'); request.destroy(error); tunnel?.destroy(error) }, 15_000)
    const abort = () => { const error = new Error('规格书请求已取消'); request.destroy(error); tunnel?.destroy(error) }
    signal?.addEventListener('abort', abort, { once: true })
    request.on('close', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); tunnel?.destroy() }); request.on('error', reject); request.end()
  })
}
const decodeXml = (text: string) => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, dec) => String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
function titleText(raw: string) { return decodeXml(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220) }
function familyName(part: string) { return part.replace(/[^a-z0-9]/gi, '').toUpperCase().match(/^[A-Z]{1,6}\d{2,5}/)?.[0] }
function relevantSheet(part: string, title: string, url: URL): boolean {
  const terms = `${title} ${decodeURIComponent(url.pathname)}`.replace(/[^a-z0-9]/gi, '').toUpperCase()
  const exact = part.replace(/[^a-z0-9]/gi, '').toUpperCase()
  const family = familyName(part)
  return terms.includes(exact) || Boolean(family && terms.includes(family))
}
function duckDuckGoResults(html: string): { url: string; title: string }[] {
  const results: { url: string; title: string }[] = []
  for (const match of html.matchAll(/<a\b([^>]*?)>([\s\S]*?)<\/a>/gi)) {
    if (!/\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["']/i.test(match[1])) continue
    const href = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
    if (!href) continue
    try {
      // Read the indexed destination only; never fetch the search engine's
      // redirect or treat an arbitrary result title as a download link.
      const redirect = new URL(decodeXml(href), 'https://html.duckduckgo.com')
      if (redirect.hostname !== 'duckduckgo.com' || redirect.pathname !== '/l/') continue
      const target = redirect.searchParams.get('uddg')
      if (target) results.push({ url: target, title: titleText(match[2]) })
    } catch { /* Ignore malformed search result links. */ }
  }
  return results
}
function partMatchNote(part: string, url: URL): string {
  const sought = part.replace(/[^a-z0-9]/gi, '').toUpperCase()
  const file = decodeURIComponent(url.pathname.split('/').at(-1) ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase()
  if (file.includes(sought)) return '文件名包含所搜型号；请核对 PDF 中的订货型号、封装和修订版。'
  const family = familyName(part)
  if (family && file.includes(family)) return '同系列资料：文件名与所搜型号不同，订货后缀尚未核实。'
  return '搜索命中待核对：文件名未包含所搜型号。'
}
type WebDiscovery = (query: string) => Promise<ModelSearchSourceStatus>
export function createDatasheetService(fetchBytes: FetchBytes = fetchDatasheetBytes, googleSource: WebDiscovery | undefined = fetchBytes === fetchDatasheetBytes ? createSiteSearchSource('google', searchGoogle, query => `${query} datasheet PDF`) : undefined, allDatasheetSource: WebDiscovery | undefined = fetchBytes === fetchDatasheetBytes ? createSiteSearchSource('alldatasheet', searchAllDatasheet) : undefined, officialSource: ((query: string, signal?: AbortSignal) => Promise<OfficialPdfLead[]>) | undefined = fetchBytes === fetchDatasheetBytes ? ((query, signal) => discoverOfficialPdfs(query, probeOfficialPdf, signal)) : undefined, jlcSource: ((query: string) => Promise<JlcCatalogStatus>) | undefined = fetchBytes === fetchDatasheetBytes ? searchJlcCatalog : undefined, stSource: ((query: string) => Promise<StProductDiscovery>) | undefined = fetchBytes === fetchDatasheetBytes ? searchStPublicCatalog : undefined) {
  const registry = new Map<string, DatasheetCandidate>()
  const register = (url: string, title: string, part: string) => {
    const approved = allowedDatasheetUrl(url), id = createHash('sha256').update(approved.href).digest('hex')
    const candidate = { id, title, url: approved.href, manufacturer: manufacturer(approved.hostname)!, matchNote: partMatchNote(part, approved) }
    if (registry.size >= 160) registry.delete(registry.keys().next().value!)
    registry.set(id, candidate); return candidate
  }
  return {
    async search(query: string, signal?: AbortSignal): Promise<DatasheetSearchResults> {
      signal?.throwIfAborted()
      if (typeof query !== 'string' || !/^[a-z0-9][a-z0-9_. +\/-]{1,47}$/i.test(query.trim())) throw new Error('请输入 2–48 位器件型号')
      const candidates: DatasheetCandidate[] = [], notices: string[] = []
      const webSources = [
        { source: googleSource, id: 'google' as const, label: 'Google 搜索', searchUrl: `https://www.google.com/search?q=${encodeURIComponent(query.trim() + ' datasheet PDF')}` },
        { source: allDatasheetSource, id: 'alldatasheet' as const, label: 'AllDataSheet', searchUrl: `https://www.alldatasheet.com/view.jsp?Searchword=${encodeURIComponent(query.trim())}` },
      ].filter((item): item is { source: WebDiscovery; id: 'google' | 'alldatasheet'; label: string; searchUrl: string } => Boolean(item.source))
      const webResults = Promise.all(webSources.map(async item => {
        try { return await item.source(query.trim()) }
        catch (error) { return { source: item.id, label: item.label, state: 'unavailable' as const, searchUrl: item.searchUrl, detail: `${item.label} 搜索暂不可用：${(error as Error).message}` } }
      }))
      // The HTTP client can disconnect while the sequential Bing/DDG path is
      // running. This parallel task must settle locally: rethrowing AbortError
      // here leaves an unobserved rejected promise and kills the Node process.
      // The sequential path checks the same signal and exits the request.
      const officialResults = officialSource
        ? Promise.resolve().then(() => officialSource(query.trim(), signal)).catch(error => {
          if (!signal?.aborted) notices.push(`厂商直链探测暂不可用：${(error as Error).message}`)
          return [] as OfficialPdfLead[]
        })
        : Promise.resolve([] as OfficialPdfLead[])
      const jlcResult = jlcSource ? Promise.resolve().then(() => jlcSource(query.trim())).catch((error): JlcCatalogStatus => ({ source: 'jlc', label: 'JLCPCB 器件目录', state: 'unavailable', searchUrl: `https://jlcpcb.com/parts/componentSearch?isSearch=true&searchTxt=${encodeURIComponent(query.trim())}`, detail: `JLCPCB 目录暂不可用：${(error as Error).message}`, results: [] })) : undefined
      const stResult = stSource && /^[a-z0-9][a-z0-9_.-]{1,47}$/i.test(query.trim()) ? Promise.resolve().then(() => stSource(query.trim())).catch(error => ({ source: 'st' as const, label: 'STMicroelectronics 原厂产品目录', state: 'unavailable' as const, query: query.trim(), resources: [], detail: `ST 原厂目录暂不可用：${(error as Error).message}` })) : undefined
      // Discover TI document URLs from product pages, never guess a document ID.
      // Orderable/package suffixes such as LM321T5 are first retried through
      // their known electrical base (LM321), while the exact query is kept for
      // manufacturers that publish package-specific pages.
      for (const part of queryVariants(query)) if (/^(?:OPA|TLV|TLC|TL|LM|TPS|REF|INA|UCC|NE)[A-Z0-9-]{1,35}$/i.test(part)) {
        try {
          const product = `https://www.ti.com/product/${part}`, html = (await fetchBytes(product, 2 * 1024 * 1024, false, signal)).bytes.toString('utf8')
          for (const match of html.matchAll(/<a\b([^>]*?)>([\s\S]*?)<\/a>/gi)) {
            const href = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1], title = titleText(match[2])
            if (!href || !/data\s*sheet/i.test(title)) continue
            const url = new URL(decodeXml(href), product); url.hash = ''
            if (url.hostname !== 'www.ti.com' || !/^\/lit\/(?:ds\/|gpn\/)/i.test(url.pathname)) continue
            candidates.push(register(url.href, title || `${part} datasheet`, part))
          }
        } catch (error) { signal?.throwIfAborted(); notices.push(`TI 官网检索 ${part}：${(error as Error).message}`) }
      }
      for (const part of queryVariants(query)) try {
        const discovery = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(`"${part}" datasheet filetype:pdf`)}`
        const rss = (await fetchBytes(discovery, 1024 * 1024, true, signal)).bytes.toString('utf8')
        if (!/<(?:rss|channel)\b/i.test(rss)) throw new Error('搜索服务没有返回可读取的结果')
        for (const item of rss.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
          const raw = item[1].match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1], title = titleText(item[1].match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
          if (!raw) continue
          try {
            const url = allowedDatasheetUrl(decodeXml(raw.trim())); url.hash = ''
            if (!/\.pdf(?:$|\/)/i.test(url.pathname) && !(url.hostname.endsWith('ti.com') && /^\/lit\/(?:ds\/|gpn\/)/i.test(url.pathname))) continue
            if (!relevantSheet(part, title, url)) continue
            // A search hit is only a candidate. The user checks package/revision/part before download.
            candidates.push(register(url.href, title || url.pathname.split('/').at(-1)!, part))
          } catch { /* Ignore advertisements, non-manufacturer mirrors and unsafe URLs. */ }
        }
      } catch (error) { signal?.throwIfAborted(); notices.push(`公开网页检索 ${part}：${(error as Error).message}`) }
      // Bing RSS sometimes returns unrelated pages even for an exact part.
      // Use one bounded query against a second public index only when no
      // allowed source was found. Prefer the electrical family for orderable
      // suffixes, and still label the result against the complete model.
      if (!candidates.length) {
        const original = query.trim().toUpperCase()
        const part = familyName(original) ?? original
        const deadline = AbortSignal.timeout(5_000)
        const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline
        try {
          const discovery = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${part} datasheet`)}`
          const html = (await fetchBytes(discovery, 1024 * 1024, true, bounded)).bytes.toString('utf8')
          if (!/result__a/.test(html)) throw new Error('搜索服务没有返回可读取的结果')
          for (const result of duckDuckGoResults(html)) {
            try {
              const url = allowedDatasheetUrl(result.url)
              if (!/\.pdf$/i.test(url.pathname) || !relevantSheet(part, result.title, url)) continue
              candidates.push(register(url.href, result.title || url.pathname.split('/').at(-1)!, original))
            } catch { /* Ignore mirrors, unrelated results and unsafe URLs. */ }
          }
        } catch (error) {
          signal?.throwIfAborted()
          const message = (error as Error).message
          if (deadline.aborted) notices.push('备用网页检索超过 5 秒，已停止等待；可粘贴厂商 PDF 地址。')
          else if (/HTTP (?:202|403|429)/.test(message)) notices.push('备用搜索服务限制自动访问；可粘贴厂商 PDF 地址或稍后重试。')
          else notices.push(`备用网页检索 ${part}：${message}`)
        }
      }
      const sourceStatuses = await webResults
      signal?.throwIfAborted()
      const jlcStatus = await jlcResult
      if (jlcStatus) sourceStatuses.push(jlcCatalogSourceStatus(jlcStatus))
      for (const status of sourceStatuses) for (const result of status.results ?? []) {
        try {
          const url = allowedDatasheetUrl(result.url)
          if (!/\.pdf$/i.test(url.pathname) || !relevantSheet(query.trim(), result.title, url)) continue
          candidates.push(register(url.href, result.title || url.pathname.split('/').at(-1)!, query.trim()))
        } catch { /* Search engine and mirror links are evidence until an approved manufacturer PDF is found. */ }
      }
      for (const result of await officialResults) {
        try {
          const url = allowedDatasheetUrl(result.url)
          if (!/\.pdf$/i.test(url.pathname) || !relevantSheet(query.trim(), result.title, url) ||
            url.hostname !== 'www.lrc.cn' && candidates.some(item => item.manufacturer === manufacturer(url.hostname))) continue
          candidates.push(register(url.href, `${result.title}（PDF 地址已验证，型号与内容仍需核对）`, query.trim()))
        } catch { /* Ignore a malformed or unrelated vendor route, even if a probe claimed success. */ }
      }
      // JLCPCB's exact product MPN may carry a vendor-owned document URL.
      // Seller copies and nearby order codes remain catalogue evidence only.
      for (const part of jlcStatus?.results ?? []) {
        if (!part.exactPart || part.mpn.trim().toUpperCase() !== query.trim().toUpperCase() || !part.officialDatasheetUrl) continue
        try {
          const url = allowedDatasheetUrl(part.officialDatasheetUrl)
          if (!/\.pdf$/i.test(url.pathname) && !/^(?:\/cn)?\/lit\/(?:ds|gpn)\//i.test(url.pathname)) continue
          candidates.push(register(url.href, `${part.mpn} · ${part.manufacturer || '厂商'}目录标注的厂商资料（尚未下载核验）`, query.trim()))
        } catch { /* Do not promote arbitrary catalogue or seller URLs into downloads. */ }
      }
      if (stResult) {
        const st = await stResult
        if (st.state === 'unavailable') notices.push(st.detail)
        if (st.state === 'found' && st.query.toLowerCase() === query.trim().toLowerCase()) {
          for (const resource of st.resources.filter(item => item.kind === 'datasheet').slice(0, 3)) {
            try {
              const url = allowedDatasheetUrl(resource.url)
              if (url.hostname !== 'www.st.com' || url.search || !/^\/resource\/en\/datasheet\/[a-z0-9_.-]+\.pdf$/i.test(url.pathname) || !relevantSheet(query.trim(), resource.title, url)) continue
              candidates.push(register(url.href, `STMicroelectronics ${query.trim()} 官方规格书 · 原厂产品页`, query.trim()))
            } catch { /* Product evidence never relaxes the download source allowlist. */ }
          }
        }
      }
      const unique = [...new Map(candidates.map(item => [item.id, item])).values()].slice(0, 12)
      signal?.throwIfAborted()
      if (!unique.length && !notices.some(note => note.startsWith('备用搜索服务限制') || note.startsWith('备用网页检索'))) notices.push('公开搜索索引未返回可核对的厂商规格书；这不代表厂商官网没有资料。可粘贴厂商 PDF 地址，或手工下载 PDF / TXT 后导入。')
      return { candidates: unique, notices, sourceStatuses }
    },
    async download(input: { id: string } | { url: string }, signal?: AbortSignal): Promise<DatasheetDownload> {
      signal?.throwIfAborted()
      const candidate = 'id' in input ? registry.get(input.id) : undefined
      if ('id' in input && !candidate) throw new Error('规格书搜索结果已过期，请重新搜索')
      const url = candidate?.url ?? ('url' in input ? allowedDatasheetUrl(input.url).href : '')
      const result = await fetchBytes(url, DATASHEET_LIMITS.fileBytes, false, signal)
      allowedDatasheetUrl(result.url)
      if (result.bytes.length > DATASHEET_LIMITS.fileBytes) throw new Error('规格书超过 12 MB 限制')
      const pdf = result.bytes.subarray(0, 5).toString('ascii') === '%PDF-'
      const txt = new URL(result.url).pathname.toLowerCase().endsWith('.txt') && !/^\s*</.test(result.bytes.toString('utf8', 0, 100))
      if (!pdf && !txt) throw new Error('厂商未返回 PDF / TXT 规格书，可能是登录或验证页面；请手工下载后拖入')
      let fileName = decodeURIComponent(new URL(result.url).pathname.split('/').at(-1) || 'datasheet').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 120)
      if (!fileName.toLowerCase().endsWith(pdf ? '.pdf' : '.txt')) fileName += pdf ? '.pdf' : '.txt'
      return { id: createHash('sha256').update(result.url).update(result.bytes).digest('hex'), fileName, url: result.url, bytesBase64: result.bytes.toString('base64'), byteLength: result.bytes.length }
    },
  }
}
export function createDatasheetMiddleware(service = createDatasheetService(), bodyDeadlineMs = 10_000) {
  let active = 0
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split('?')[0]
    if (!['/api/model-library/datasheet/search', '/api/model-library/datasheet/download'].includes(path ?? '')) { next(); return }
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    const send = (status: number, value: object) => { res.statusCode = status; res.end(JSON.stringify(value)) }
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(req.headers.host ?? '') || req.headers.origin !== `http://${req.headers.host}` || req.headers['sec-fetch-site'] === 'cross-site') { send(403, { error: '规格书服务只接受本机工作台同源请求' }); return }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(405, { error: '仅接受 POST' }); return }
    if (req.url?.includes('?') || !req.headers['content-type']?.startsWith('application/json')) { send(400, { error: '需要 JSON 请求，不接受网址参数' }); return }
    if (active >= 2) { send(429, { error: '规格书请求正在处理中，请稍后重试' }); return }
    active++
    const controller = new AbortController()
    const disconnect = () => { if (!res.writableEnded) controller.abort() }
    res.on('close', disconnect)
    const bodyDeadline = setTimeout(() => req.destroy(new Error('规格书请求读取超时')), bodyDeadlineMs)
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 3000) throw new Error('请求超过大小限制') }
      clearTimeout(bodyDeadline)
      const data = JSON.parse(body)
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1) throw new Error('规格书请求参数不正确')
      if (path!.endsWith('/search')) { if (typeof data.query !== 'string') throw new Error('请输入器件型号'); send(200, await service.search(data.query, controller.signal)) }
      else { if (!(typeof data.id === 'string' && /^[a-f0-9]{64}$/.test(data.id) || typeof data.url === 'string' && data.url.length <= 1800)) throw new Error('需要搜索结果或厂商原始下载网址'); send(200, await service.download(data, controller.signal)) }
    } catch (error) { if (!res.destroyed) send(400, { error: (error as Error).message || '规格书请求失败' }) }
    finally { clearTimeout(bodyDeadline); res.off('close', disconnect); active-- }
  }
}
