import { lookup } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { approvedProxyFor, assertPublicDatasheetHost, loopbackProxyAgent } from './datasheet-proxy'
import { publicAddress } from './public-network'
import type { ModelSearchSourceStatus } from '../src/core/model-search'

export interface JlcCatalogPart {
  mpn: string
  manufacturer: string
  code: string
  exactPart: boolean
  productUrl?: string
  datasheetUrl?: string
  officialDatasheetUrl?: string
}

export interface JlcCatalogStatus {
  source: 'jlc'
  label: string
  state: 'searched' | 'restricted' | 'unavailable'
  searchUrl: string
  detail: string
  total?: number
  results: JlcCatalogPart[]
}

const origin = 'https://jlcpcb.com'
const endpoint = `${origin}/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2`
const maxBytes = 512_000
const partPattern = /^[a-z0-9][a-z0-9_. +\/-]{1,47}$/i

export function jlcCatalogSearchUrl(part: string): string {
  const value = part.trim()
  if (!partPattern.test(value)) throw new Error('JLCPCB 器件搜索需要 2–48 位型号')
  return `${origin}/parts/componentSearch?isSearch=true&searchTxt=${encodeURIComponent(value)}`
}

function requestBody(part: string): string {
  jlcCatalogSearchUrl(part)
  return JSON.stringify({ currentPage: 1, pageSize: 20, keyword: part.trim(), componentLibraryType: null,
    preferredComponentFlag: null, stockFlag: null, stockSort: null, firstSortName: null, secondSortName: null,
    componentBrand: null, componentSpecification: null, componentAttributes: [], searchSource: 'search' })
}

/** The only network target is JLCPCB's public component catalogue JSON endpoint. */
export async function fetchJlcCatalog(part: string): Promise<unknown> {
  const body = requestBody(part)
  const url = new URL(endpoint)
  const proxy = await approvedProxyFor(url.hostname)
  if (proxy) await assertPublicDatasheetHost(url.hostname)
  const tunnel = proxy ? loopbackProxyAgent(proxy, url.hostname) : undefined
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: 'POST', agent: tunnel?.agent, headers: {
      'User-Agent': 'SPICE-Workbench/0.25 (component-catalog-discovery)', Accept: 'application/json',
      'Accept-Encoding': 'identity', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    }, lookup(host, options, done) {
      lookup(host, { all: true }, (error, addresses) => {
        if (error) { done(error, '', 4); return }
        if (!addresses.length || addresses.some(item => !publicAddress(item.address))) {
          done(new Error('JLCPCB 解析到非公网地址'), '', 4); return
        }
        if (options.all) (done as unknown as (error: null, records: { address: string; family: number }[]) => void)(null, addresses)
        else done(null, addresses[0].address, addresses[0].family)
      })
    } }, response => {
      if (response.statusCode !== 200) {
        response.resume(); reject(new Error(`HTTP ${response.statusCode}；不跟随重定向`)); return
      }
      if (!/^application\/json\b/i.test(String(response.headers['content-type'] ?? ''))) {
        response.resume(); reject(new Error('目录未返回 JSON 数据')); return
      }
      if (Number(response.headers['content-length'] ?? 0) > maxBytes) {
        response.destroy(); reject(new Error('目录响应超过大小限制')); return
      }
      const chunks: Buffer[] = []; let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) { response.destroy(new Error('目录响应超过大小限制')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { reject(new Error('目录数据不是有效 JSON')) }
      })
    })
    const timer = setTimeout(() => {
      const error = new Error('JLCPCB 器件查询超时')
      request.destroy(error); tunnel?.destroy(error)
    }, 5_000)
    request.on('close', () => { clearTimeout(timer); tunnel?.destroy() })
    request.on('error', reject)
    request.end(body)
  })
}

function publicHttps(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 1800 || /[\x00-\x1f]/.test(raw)) return undefined
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') ||
      (isIP(host) !== 0 && !publicAddress(host))) return undefined
    return url.href
  } catch { return undefined }
}

function catalogPart(value: unknown, query: string): JlcCatalogPart | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const mpn = typeof row.componentModelEn === 'string' ? row.componentModelEn.trim().slice(0, 100) : ''
  const manufacturer = typeof row.componentBrandEn === 'string' ? row.componentBrandEn.trim().slice(0, 100) : ''
  const code = typeof row.componentCode === 'string' ? row.componentCode : ''
  if (!mpn || !/^C\d{1,12}$/.test(code)) return undefined
  const productUrl = publicHttps(row.lcscGoodsUrl)
  const datasheetUrl = publicHttps(row.dataManualUrl)
  const officialDatasheetUrl = publicHttps(row.dataManualOfficialLink)
  return { mpn, manufacturer, code, exactPart: mpn.toUpperCase() === query.trim().toUpperCase(),
    ...(productUrl ? { productUrl } : {}), ...(datasheetUrl ? { datasheetUrl } : {}),
    ...(officialDatasheetUrl ? { officialDatasheetUrl } : {}) }
}

/** Catalogue links are leads to inspect; the response does not verify a PDF or SPICE model. */
export async function searchJlcCatalog(part: string, read: (part: string) => Promise<unknown> = fetchJlcCatalog): Promise<JlcCatalogStatus> {
  const searchUrl = jlcCatalogSearchUrl(part)
  const base = { source: 'jlc' as const, label: 'JLCPCB 器件目录', searchUrl }
  try {
    const response = await read(part.trim())
    if (!response || typeof response !== 'object') throw new Error('目录响应格式不正确')
    const data = response as { code?: unknown; message?: unknown; data?: { componentPageInfo?: { total?: unknown; list?: unknown } } }
    if (data.code === 403 || data.code === 429 || /captcha|访问受限|验证/i.test(String(data.message ?? ''))) {
      return { ...base, state: 'restricted', results: [], detail: 'JLCPCB 要求访问验证，当前无法读取目录结果。请打开原站搜索页核对。' }
    }
    const page = data.data?.componentPageInfo
    if (data.code !== 200 || !page || !Number.isSafeInteger(page.total) || Number(page.total) < 0 ||
      !(page.list === null || Array.isArray(page.list))) throw new Error('目录未返回可核验的器件列表')
    const results = Array.isArray(page.list) ? page.list.slice(0, 20).map(row => catalogPart(row, part)).filter((row): row is JlcCatalogPart => Boolean(row)) : []
    const total = Number(page.total)
    const exact = results.filter(row => row.exactPart).length
    return { ...base, state: 'searched', total, results,
      detail: `JLCPCB 返回 ${total} 条目录记录，展示前 ${results.length} 条，其中 ${exact} 条型号与查询完全一致。目录资料链接尚未下载核验，也不能证明存在 SPICE 模型。` }
  } catch (error) {
    return { ...base, state: 'unavailable', results: [],
      detail: `JLCPCB 目录查询暂不可用（${(error as Error).message}）。可打开原站搜索页；不能据此判断型号不存在。` }
  }
}

/** Product links remain catalogue evidence, separate from SPICE download candidates. */
export function jlcCatalogSourceStatus(status: JlcCatalogStatus): ModelSearchSourceStatus {
  return { source: 'jlc', label: status.label, state: status.state, searchUrl: status.searchUrl,
    detail: status.detail, ...(status.total !== undefined ? { resultCount: status.total } : {}),
    results: status.results.filter(part => Boolean(part.productUrl)).map(part => ({
      url: part.productUrl!,
      title: `${part.exactPart ? '型号一致' : '相近型号，非目标器件'} · ${part.mpn}${part.manufacturer ? ` · ${part.manufacturer}` : ''}（商品目录，未验证 SPICE 模型）`,
    })) }
}
