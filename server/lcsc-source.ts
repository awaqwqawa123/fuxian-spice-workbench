import { lookup } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { publicAddress } from './public-network'
import { approvedProxyFor, assertPublicDatasheetHost, loopbackProxyAgent } from './datasheet-proxy'

const searchOrigin = 'https://so.szlcsc.com'
const maxPageBytes = 512 * 1024
const itemOrigin = 'https://item.szlcsc.com'

export interface LcscSourceStatus {
  source: 'lcsc'
  label: '立创商城'
  state: 'searched' | 'restricted' | 'unavailable'
  searchUrl: string
  detail: string
  resultCount?: number
}

export interface LcscPage {
  status: number
  contentType: string
  body: string
}

export interface LcscProductEvidence {
  url: string
  mpn: string
  brand: string
  sku: string
  exactPart: boolean
  datasheetUrl?: string
  detail: string
}

export function allowedLcscProductUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 300 || /[\x00-\x1f]/.test(raw)) throw new Error('请粘贴立创商城商品页完整地址')
  const url = new URL(raw)
  if (url.origin !== itemOrigin || !/^\/\d{1,12}\.html$/.test(url.pathname) || url.username || url.password) throw new Error('只接受 item.szlcsc.com 的公开商品页地址')
  // Copied product links may contain tracking parameters; never send them.
  return new URL(url.pathname, itemOrigin)
}

export function allowedLcscDatasheetUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.origin !== 'https://atta.szlcsc.com' || !/^\/upload\/public\/pdf\/[a-z0-9_./-]+\.pdf$/i.test(url.pathname) || url.search || url.hash || url.username || url.password || url.pathname.split('/').includes('..')) throw new Error('立创资料不是公开 PDF 规格书地址')
  return url
}

/** The site publishes this SearchAction URL in its homepage JSON-LD. */
export function lcscSearchUrl(query: string): string {
  const part = query.trim()
  if (!/^[a-z0-9][a-z0-9_. +\/-]{1,47}$/i.test(part)) throw new Error('立创商城搜索只接受 2–48 位器件型号')
  return `${searchOrigin}/global.html?k=${encodeURIComponent(part)}`
}

/** Read only the documented search page. Never follow redirects or accept caller URLs. */
export async function fetchLcscPage(raw: string): Promise<LcscPage> {
  const url = new URL(raw)
  if (url.origin !== searchOrigin || url.pathname !== '/global.html' || url.searchParams.size !== 1 || !url.searchParams.has('k') || url.username || url.password || url.hash) throw new Error('立创商城搜索地址不受支持')
  const proxy = await approvedProxyFor(url.hostname)
  if (proxy) await assertPublicDatasheetHost(url.hostname)
  const tunnel = proxy ? loopbackProxyAgent(proxy, url.hostname) : undefined
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      agent: tunnel?.agent,
      headers: { 'User-Agent': 'SPICE-Workbench/0.25', Accept: 'text/html' },
      lookup(host, options, done) {
        lookup(host, { all: true }, (error, addresses) => {
          if (error) { done(error, '', 4); return }
          if (!addresses.length || addresses.some(address => !publicAddress(address.address))) { done(new Error('立创商城域名解析到非公网地址'), '', 4); return }
          if (options.all) (done as unknown as (error: null, records: { address: string; family: number }[]) => void)(null, addresses)
          else done(null, addresses[0].address, addresses[0].family)
        })
      },
    }, response => {
      response.on('error', reject)
      const status = response.statusCode ?? 0
      const contentType = String(response.headers['content-type'] ?? '')
      if (Number(response.headers['content-length'] ?? 0) > maxPageBytes) { response.destroy(new Error('立创商城搜索页超过大小限制')); return }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxPageBytes) { response.destroy(new Error('立创商城搜索页超过大小限制')); return }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8') }))
    })
    const timer = setTimeout(() => { const error = new Error('立创商城搜索连接超时'); request.destroy(error); tunnel?.destroy(error) }, 8_000)
    request.on('close', () => { clearTimeout(timer); tunnel?.destroy() })
    request.on('error', reject)
    request.end()
  })
}

export async function fetchLcscProductPage(raw: string): Promise<LcscPage> {
  const url = allowedLcscProductUrl(raw)
  const proxy = await approvedProxyFor(url.hostname)
  if (proxy) await assertPublicDatasheetHost(url.hostname)
  const tunnel = proxy ? loopbackProxyAgent(proxy, url.hostname) : undefined
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      agent: tunnel?.agent,
      headers: { 'User-Agent': 'SPICE-Workbench/0.25', Accept: 'text/html' },
      lookup(host, options, done) {
        lookup(host, { all: true }, (error, addresses) => {
          if (error) { done(error, '', 4); return }
          if (!addresses.length || addresses.some(address => !publicAddress(address.address))) { done(new Error('立创商城域名解析到非公网地址'), '', 4); return }
          if (options.all) (done as unknown as (error: null, records: { address: string; family: number }[]) => void)(null, addresses)
          else done(null, addresses[0].address, addresses[0].family)
        })
      },
    }, response => {
      response.on('error', reject)
      const status = response.statusCode ?? 0
      const contentType = String(response.headers['content-type'] ?? '')
      if (Number(response.headers['content-length'] ?? 0) > maxPageBytes) { response.destroy(new Error('立创商品页超过大小限制')); return }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxPageBytes) { response.destroy(new Error('立创商品页超过大小限制')); return }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8') }))
    })
    const timer = setTimeout(() => { const error = new Error('立创商品页连接超时'); request.destroy(error); tunnel?.destroy(error) }, 8_000)
    request.on('close', () => { clearTimeout(timer); tunnel?.destroy() })
    request.on('error', reject)
    request.end()
  })
}

/** Verify only the site's public Product JSON-LD; product pages are not model files. */
export function parseLcscProductPage(url: string, part: string, page: LcscPage): LcscProductEvidence {
  const approved = allowedLcscProductUrl(url)
  if (page.status !== 200 || !/^text\/html\b/i.test(page.contentType)) throw new Error(`立创商品页返回 HTTP ${page.status}，请在浏览器中核对`)
  if (/访问受限|_xvasu|_xvpfs|非法ACL-URL请求/.test(page.body)) throw new Error('立创商城要求浏览器验证，请手工打开商品页')
  for (const script of page.body.matchAll(/<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown
    try { data = JSON.parse(script[1]) } catch { continue }
    const graph = data && typeof data === 'object' ? (data as { '@graph'?: unknown })['@graph'] : undefined
    const nodes = Array.isArray(graph) ? graph : [data]
    for (const value of nodes) {
      if (!value || typeof value !== 'object') continue
      const product = value as Record<string, unknown>
      const types = Array.isArray(product['@type']) ? product['@type'] : [product['@type']]
      if (!types.includes('Product') || product.url !== approved.href) continue
      const mpn = typeof product.mpn === 'string' ? product.mpn.trim().slice(0, 100) : ''
      const sku = typeof product.sku === 'string' ? product.sku.trim().slice(0, 100) : ''
      const brandValue = product.brand && typeof product.brand === 'object' ? (product.brand as Record<string, unknown>).name : ''
      const brand = typeof brandValue === 'string' ? brandValue.trim().slice(0, 100) : ''
      if (!mpn) continue
      let datasheetUrl: string | undefined
      const documents = Array.isArray(product.subjectOf) ? product.subjectOf : [product.subjectOf]
      for (const document of documents) {
        const source = document && typeof document === 'object' ? (document as Record<string, unknown>).url : undefined
        if (typeof source === 'string') try { datasheetUrl = allowedLcscDatasheetUrl(source).href; break } catch { /* unrelated attachment */ }
      }
      const exactPart = mpn.toLowerCase() === part.trim().toLowerCase()
      return { url: approved.href, mpn, brand, sku, exactPart, datasheetUrl, detail: exactPart ? datasheetUrl ? '官网商品页型号一致，找到 PDF 规格书；未发现已验证的 SPICE 模型。' : '官网商品页型号一致，未找到公开 PDF 规格书或已验证的 SPICE 模型。' : `商品页型号为 ${mpn}，与所搜 ${part.trim()} 不同；请先核对厂家和订货后缀。` }
    }
  }
  throw new Error('商品页未返回可核验的 Product 资料；请手工核对，不视为无模型')
}

export async function inspectLcscProduct(url: string, part: string, readPage: (url: string) => Promise<LcscPage> = fetchLcscProductPage): Promise<LcscProductEvidence> {
  const approved = allowedLcscProductUrl(url)
  if (!/^[a-z0-9][a-z0-9_. +\/-]{1,47}$/i.test(part.trim())) throw new Error('请先填写 2–48 位器件型号')
  return parseLcscProductPage(approved.href, part, await readPage(approved.href))
}

export function createLcscProductMiddleware(inspect = inspectLcscProduct, bodyDeadlineMs = 10_000) {
  let active = 0
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url?.split('?')[0] !== '/api/model-library/lcsc/product') { next(); return }
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    const send = (status: number, value: object) => { res.statusCode = status; res.end(JSON.stringify(value)) }
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(req.headers.host ?? '') || req.headers.origin !== `http://${req.headers.host}` || req.headers['sec-fetch-site'] === 'cross-site') { send(403, { error: '仅接受本机工作台同源请求' }); return }
    if (req.method !== 'POST' || req.url?.includes('?') || !req.headers['content-type']?.startsWith('application/json')) { send(400, { error: '需要 POST JSON 请求' }); return }
    if (active >= 2) { send(429, { error: '立创商品页核验正在处理中，请稍后重试' }); return }
    active++
    const bodyDeadline = setTimeout(() => req.destroy(new Error('商品页请求读取超时')), bodyDeadlineMs)
    try {
      let body = ''
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1000) throw new Error('请求超过大小限制') }
      clearTimeout(bodyDeadline)
      const data = JSON.parse(body)
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 2 || typeof data.url !== 'string' || typeof data.part !== 'string') throw new Error('商品页请求参数不正确')
      send(200, await inspect(data.url, data.part))
    } catch (error) { if (!res.destroyed) send(400, { error: (error as Error).message || '商品页核验失败' }) }
    finally { clearTimeout(bodyDeadline); active-- }
  }
}

export async function searchLcsc(query: string, readPage: (url: string) => Promise<LcscPage> = fetchLcscPage): Promise<LcscSourceStatus> {
  const searchUrl = lcscSearchUrl(query)
  const base = { source: 'lcsc' as const, label: '立创商城' as const, searchUrl }
  try {
    const page = await readPage(searchUrl)
    if ([203, 403, 429].includes(page.status) || /_xvasu|_xvpfs|非法ACL-URL请求|禁止访问|访问受限|系统防火墙检测/.test(page.body)) {
      return { ...base, state: 'restricted', detail: '立创商城要求浏览器访问校验，工作台无法验证搜索结果。可打开官网搜索页核对型号、规格书及是否提供 SPICE 模型。' }
    }
    if (page.status !== 200 || !/^text\/html\b/i.test(page.contentType)) {
      return { ...base, state: 'unavailable', detail: `立创商城搜索页返回 HTTP ${page.status}，工作台未取得可核验的器件结果。可打开官网搜索页继续查找。` }
    }
    // The shopping catalogue is not a SPICE model index. A successful HTML
    // shell alone does not prove that results loaded or that a model exists.
    return { ...base, state: 'restricted', detail: '立创商城搜索页已响应，但器件结果需要在官网页面核对；工作台尚无法验证其 SPICE 模型下载。' }
  } catch (error) {
    return { ...base, state: 'unavailable', detail: `立创商城搜索暂不可用：${(error as Error).message}。可打开官网搜索页继续查找。` }
  }
}
