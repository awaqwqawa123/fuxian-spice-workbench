import { lookup } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { approvedProxyFor, assertPublicDatasheetHost, loopbackProxyAgent } from './datasheet-proxy'
import { publicAddress } from './public-network'

export interface GoogleDiscoveryStatus {
  source: 'google'
  label: string
  state: 'searched' | 'restricted' | 'unavailable'
  searchUrl: string
  detail: string
  resultCount?: number
  results: { url: string; title: string }[]
}

const origin = 'https://www.google.com'
const maxBytes = 512_000
const queryPattern = /^[\p{L}\p{N}][\p{L}\p{N} _.+\/-]{1,79}$/u

export function googleSearchUrl(query: string): string {
  const value = query.trim()
  if (!queryPattern.test(value)) throw new Error('Google 搜索需要 2–80 位器件型号或搜索词')
  return `${origin}/search?q=${encodeURIComponent(value)}`
}

/** Fetch only the fixed Google search endpoint. Never follow redirects or fetch result URLs. */
export async function fetchGoogleHtml(raw: string): Promise<string> {
  const url = new URL(raw)
  if (url.origin !== origin || url.pathname !== '/search' || url.username || url.password ||
    url.hash || url.searchParams.size !== 1 || !url.searchParams.has('q') ||
    googleSearchUrl(url.searchParams.get('q') ?? '') !== url.href) {
    throw new Error('Google 查询地址不受支持')
  }
  const proxy = await approvedProxyFor(url.hostname)
  if (proxy) await assertPublicDatasheetHost(url.hostname)
  const tunnel = proxy ? loopbackProxyAgent(proxy, url.hostname) : undefined
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { agent: tunnel?.agent, headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SPICE-Workbench/0.25; model-discovery)',
      Accept: 'text/html', 'Accept-Encoding': 'identity',
    }, lookup(host, options, done) {
      lookup(host, { all: true }, (error, addresses) => {
        if (error) { done(error, '', 4); return }
        if (!addresses.length || addresses.some(item => !publicAddress(item.address))) {
          done(new Error('Google 解析到非公网地址'), '', 4); return
        }
        if (options.all) (done as unknown as (error: null, records: { address: string; family: number }[]) => void)(null, addresses)
        else done(null, addresses[0].address, addresses[0].family)
      })
    } }, response => {
      if (response.statusCode !== 200) {
        response.resume(); reject(new Error(`HTTP ${response.statusCode}；不跟随重定向`)); return
      }
      if (!/^text\/html\b/i.test(String(response.headers['content-type'] ?? ''))) {
        response.resume(); reject(new Error('站点未返回 HTML 搜索页')); return
      }
      if (Number(response.headers['content-length'] ?? 0) > maxBytes) {
        response.destroy(); reject(new Error('搜索页超过大小限制')); return
      }
      const chunks: Buffer[] = []; let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) { response.destroy(new Error('搜索页超过大小限制')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    const timer = setTimeout(() => {
      const error = new Error('Google 查询超时')
      request.destroy(error); tunnel?.destroy(error)
    }, 5_000)
    request.on('close', () => { clearTimeout(timer); tunnel?.destroy() })
    request.on('error', reject)
    request.end()
  })
}

function decodeHtml(raw: string): string {
  return raw.replace(/&#(?:x([\da-f]+)|(\d+));/gi, (entity, hex: string | undefined, dec: string | undefined) => {
    const value = Number.parseInt(hex ?? dec ?? '', hex ? 16 : 10)
    return value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity
  }).replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
}

function resultUrl(raw: string): string | undefined {
  try {
    const href = decodeHtml(raw)
    const link = new URL(href, origin)
    let target = link
    if (link.origin === origin) {
      if (link.pathname !== '/url') return undefined
      const destination = link.searchParams.get('q') ?? link.searchParams.get('url')
      if (!destination) return undefined
      target = new URL(destination)
    }
    const host = target.hostname.toLowerCase()
    if (target.protocol !== 'https:' || target.username || target.password || target.port || target.hash ||
      target.href.length > 1800 || /[\x00-\x1f]/.test(target.href) ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host === 'www.google.com' || host === 'google.com' || host.endsWith('.google.com') ||
      !host.includes('.') || (isIP(host) !== 0 && !publicAddress(host))) return undefined
    return target.href
  } catch { return undefined }
}

export function parseGoogleResults(html: string): { url: string; title: string }[] {
  const results: { url: string; title: string }[] = []
  const seen = new Set<string>()
  for (const match of html.slice(0, maxBytes).matchAll(/<a\b([^>]{0,2048})>([\s\S]{0,12000}?)<\/a>/gi)) {
    const href = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
    const heading = match[2].match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1]
    if (!href || !heading) continue
    const url = resultUrl(href)
    const title = decodeHtml(heading.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 220)
    if (!url || !title || seen.has(url)) continue
    seen.add(url); results.push({ url, title })
    if (results.length >= 10) break
  }
  return results
}

/** Search results are discovery evidence, never verified SPICE models or downloadable datasheets. */
export async function searchGoogle(query: string, fetchHtml: (url: string) => Promise<string> = fetchGoogleHtml): Promise<GoogleDiscoveryStatus> {
  const searchUrl = googleSearchUrl(query)
  const base = { source: 'google' as const, label: 'Google 搜索', searchUrl }
  try {
    const html = await fetchHtml(searchUrl)
    if (typeof html !== 'string' || html.length > maxBytes) throw new Error('搜索页内容不受支持')
    const results = parseGoogleResults(html)
    if (/\/httpservice\/retry\/enablejs|(?:unusual traffic|verify you are human|captcha|需要启用 JavaScript|enable JavaScript)/i.test(html)) {
      return { ...base, state: 'restricted', results: [], detail: 'Google 返回访问验证或 JavaScript 限制页，自动搜索无法读取结果。请打开 Google 搜索页手动核对；不能据此判断型号不存在。' }
    }
    if (!results.length) return { ...base, state: 'unavailable', results: [], detail: 'Google 未返回可识别的公开搜索结果。可打开搜索页手动核对；不能据此判断型号不存在。' }
    return { ...base, state: 'searched', resultCount: results.length, results, detail: `Google 返回 ${results.length} 条可核对的网页结果；尚未下载规格书，也未验证 SPICE 模型。` }
  } catch (error) {
    if (/^HTTP (?:403|429)\b/.test((error as Error).message)) {
      return { ...base, state: 'restricted', results: [], detail: `Google 限制自动查询（${(error as Error).message}）。可打开搜索页手动核对；不能据此判断型号不存在。` }
    }
    return { ...base, state: 'unavailable', results: [], detail: `Google 自动查询暂不可用（${(error as Error).message}）。可打开搜索页手动核对；不能据此判断型号不存在。` }
  }
}
