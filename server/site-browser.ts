import { homedir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { ModelSearchSourceStatus } from '../src/core/model-search'
import { siteSessionSites, type SiteBrowserStatus, type SiteSessionId, type SiteSessionStatus } from '../src/core/site-sessions'
import { semieeLookupUrl, semieeSearchUrl } from './semiee-source'
import { lcscSearchUrl, allowedLcscProductUrl } from './lcsc-source'
import { googleSearchUrl, parseGoogleResults } from './google-discovery'

const marker = '.spice-workbench-site-session.json'
const maxHtml = 512 * 1024
const navigationMs = 15_000
const operationMs = 20_000
const sites: Record<SiteSessionId, { home: string; origin: string; probe: string }> = {
  semiee: { home: 'https://www.semiee.com/', origin: 'https://www.semiee.com', probe: '1N4148' },
  lcsc: { home: 'https://www.szlcsc.com/', origin: 'https://so.szlcsc.com', probe: '1N4148' },
  google: { home: 'https://www.google.com/', origin: 'https://www.google.com', probe: '1N4148 datasheet' },
  alldatasheet: { home: 'https://www.alldatasheet.com/', origin: 'https://www.alldatasheet.com', probe: '1N4148' },
}

interface BrowserPage {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>
  url(): string
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>
  close(): Promise<void>
  bringToFront(): Promise<void>
}
function effectiveSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}
interface BrowserContext {
  pages(): BrowserPage[]
  newPage(): Promise<BrowserPage>
  close(): Promise<void>
  on(event: 'close', listener: () => void): void
}
export interface SiteBrowserDriver {
  launch(profile: string, executable: string): Promise<BrowserContext>
}
const playwrightDriver: SiteBrowserDriver = {
  async launch(profile, executable) {
    const { chromium } = await import('playwright-core')
    return chromium.launchPersistentContext(profile, {
      executablePath: executable, headless: false, chromiumSandbox: true,
      timeout: 20_000, acceptDownloads: false,
    }) as unknown as BrowserContext
  },
}

function installedBrowser(): { name: string; executable: string } | undefined {
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((item): item is string => Boolean(item))
  const local = process.env.LOCALAPPDATA
  const candidates = [
    ...programFiles.map(root => ({ name: 'Microsoft Edge', executable: join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') })),
    ...(local ? [{ name: 'Microsoft Edge', executable: join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') }] : []),
    ...programFiles.map(root => ({ name: 'Google Chrome', executable: join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') })),
    ...(local ? [{ name: 'Google Chrome', executable: join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') }] : []),
  ]
  return candidates.find(item => existsSync(item.executable))
}
function applicationDataRoot(): string {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(local, 'SpiceWorkbench', 'site-sessions', 'v1')
}
function partQuery(query: string): string {
  const value = query.trim()
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.+\/-]{1,79}$/u.test(value)) throw new Error('搜索词需要 2–80 位字母、数字或常见型号符号')
  return value
}
function allDatasheetUrl(query: string): string {
  const value = partQuery(query)
  if (value.length > 48) throw new Error('AllDataSheet 型号最多 48 位')
  return `https://www.alldatasheet.com/view.jsp?Searchword=${encodeURIComponent(value)}`
}
export function siteSearchUrl(site: SiteSessionId, query: string): string {
  switch (site) {
    case 'semiee': return semieeSearchUrl(query)
    case 'lcsc': return lcscSearchUrl(query)
    case 'google': return googleSearchUrl(query)
    case 'alldatasheet': return allDatasheetUrl(query)
  }
}
function cleanTitle(raw: string): string { return raw.replace(/<[^>]*>/g, ' ').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) }
function challengePage(html: string): boolean {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''
  return /^(?:captcha|verify you are human|unusual traffic|访问验证|安全验证|登录验证|请登录|cloudflare challenge)(?:\s*[-|—].*)?$/i.test(title.trim())
}
async function bounded<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal, onLate?: (value: T) => Promise<void>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: (() => void) | undefined
  let expired = false
  const observed = work.then(value => {
    if (expired && onLate) void onLate(value).catch(() => undefined)
    return value
  })
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error('站点浏览器操作超时')) }, timeoutMs)
    cancel = () => { expired = true; reject(signal?.reason ?? new Error('站点浏览器操作已取消')) }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
  try { return await Promise.race([observed, limit]) }
  finally { if (timer) clearTimeout(timer); if (cancel) signal?.removeEventListener('abort', cancel) }
}
function allDatasheetResults(html: string): { url: string; title: string }[] {
  const results: { url: string; title: string }[] = [], seen = new Set<string>()
  for (const match of html.matchAll(/<a\b([^>]{0,1500})>([\s\S]{0,2500}?)<\/a>/gi)) {
    const href = match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2]
    if (!href) continue
    try {
      const url = new URL(href.replace(/&amp;/gi, '&'), sites.alldatasheet.origin)
      if (url.origin !== sites.alldatasheet.origin || !/^\/datasheet-pdf\/(?:view|pdf)\/\d+\/[^/]+\/[^/?#]+\.html$/i.test(url.pathname)) continue
      url.search = ''; url.hash = ''
      const title = cleanTitle(match[2])
      if (!title || seen.has(url.href)) continue
      seen.add(url.href); results.push({ url: url.href, title })
      if (results.length === 12) break
    } catch { /* An unrelated page link is not a result. */ }
  }
  return results
}
function lcscResults(html: string): { url: string; title: string }[] {
  const results: { url: string; title: string }[] = [], seen = new Set<string>()
  for (const match of html.matchAll(/<a\b([^>]{0,1500})>([\s\S]{0,2500}?)<\/a>/gi)) {
    const href = match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2]
    if (!href) continue
    try {
      const url = allowedLcscProductUrl(new URL(href.replace(/&amp;/gi, '&'), sites.lcsc.origin).href).href
      const title = cleanTitle(match[2])
      if (!title || seen.has(url)) continue
      seen.add(url); results.push({ url, title })
      if (results.length === 12) break
    } catch { /* Catalog shell and ads do not establish a product hit. */ }
  }
  return results
}

function publicStatus(site: SiteSessionId, state: 'searched' | 'restricted' | 'unavailable', query: string, detail: string, results: { url: string; title: string }[] = []): ModelSearchSourceStatus {
  const label = siteSessionSites.find(item => item.id === site)!.label
  return { source: site, label, state, searchUrl: siteSearchUrl(site, query), detail,
    ...(state === 'searched' ? { resultCount: results.length, ...(results.length ? { results } : {}) } : {}) }
}

export interface SiteBrowserOptions {
  root?: string
  driver?: SiteBrowserDriver
  browser?: { name: string; executable: string }
}
export class SiteBrowserManager {
  private readonly root: string
  private readonly driver: SiteBrowserDriver
  private readonly browser?: { name: string; executable: string }
  private readonly contexts = new Map<SiteSessionId, BrowserContext>()
  private readonly actionPages = new Map<SiteSessionId, BrowserPage>()
  private readonly current = new Map<SiteSessionId, SiteSessionStatus>()
  private readonly siteQueue = new Map<SiteSessionId, Promise<void>>()
  private readonly searchWaiters: { resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort?: () => void }[] = []
  private readonly lifetime = new AbortController()
  private closing = false
  private closed = false
  private activeSearches = 0
  constructor(options: SiteBrowserOptions = {}) {
    this.root = resolve(options.root ?? applicationDataRoot())
    this.driver = options.driver ?? playwrightDriver
    this.browser = options.browser ?? installedBrowser()
  }
  private profile(site: SiteSessionId): string { return join(this.root, site) }
  get isClosed(): boolean { return this.closed }
  private async serial<T>(site: SiteSessionId, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.siteQueue.get(site) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.siteQueue.set(site, tail)
    void tail.then(() => { if (this.siteQueue.get(site) === tail) this.siteQueue.delete(site) })
    try {
      await bounded(previous.catch(() => undefined), operationMs, signal)
      signal?.throwIfAborted()
      return await work()
    }
    finally { release() }
  }
  private async searchSlot(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    if (this.activeSearches < 2) this.activeSearches++
    else await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: undefined as (() => void) | undefined }
      waiter.abort = () => {
        const index = this.searchWaiters.indexOf(waiter)
        if (index >= 0) this.searchWaiters.splice(index, 1)
        reject(signal?.reason ?? new Error('搜索已取消'))
      }
      this.searchWaiters.push(waiter)
      signal?.addEventListener('abort', waiter.abort, { once: true })
      if (signal?.aborted) waiter.abort()
    })
    return () => {
      while (this.searchWaiters.length) {
        const next = this.searchWaiters.shift()!
        next.signal?.removeEventListener('abort', next.abort!)
        if (next.signal?.aborted) { next.reject(next.signal.reason); continue }
        next.resolve(); return
      }
      this.activeSearches--
    }
  }
  private update(site: SiteSessionId, state: SiteSessionStatus['state'], detail: string): SiteSessionStatus {
    const status = { id: site, label: siteSessionSites.find(item => item.id === site)!.label, state, detail, updatedAt: new Date().toISOString() }
    this.current.set(site, status)
    return status
  }
  private async ownedProfile(site: SiteSessionId): Promise<boolean> {
    const profile = resolve(this.profile(site)), suffix = relative(this.root, profile)
    if (suffix !== site || isAbsolute(suffix) || suffix.startsWith('..')) throw new Error('专用浏览器资料目录不正确')
    try {
      if ((await lstat(this.root)).isSymbolicLink() || (await lstat(profile)).isSymbolicLink()) throw new Error('专用浏览器资料目录不能是链接')
      const actual = resolve(await realpath(profile))
      if ((process.platform === 'win32' ? actual.toLowerCase() : actual) !== (process.platform === 'win32' ? profile.toLowerCase() : profile)) throw new Error('专用浏览器资料目录已被重定向')
      if ((await lstat(join(profile, marker))).isSymbolicLink()) throw new Error('资料目录所有权标记不能是链接')
      const record: unknown = JSON.parse(await readFile(join(profile, marker), 'utf8'))
      if (!record || typeof record !== 'object' || (record as { owner?: unknown }).owner !== 'spice-workbench' || (record as { site?: unknown }).site !== site) throw new Error('资料目录所有权标记不一致')
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  private async ensureProfile(site: SiteSessionId): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('专用浏览器资料根目录不能是链接')
    const profile = this.profile(site)
    try { await stat(profile) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(profile, { mode: 0o700 }) }
    if (!(await this.ownedProfile(site))) {
      const entries = await (await import('node:fs/promises')).readdir(profile)
      if (entries.length) throw new Error('已有浏览器资料目录没有工作台标记，无法接管')
      await writeFile(join(profile, marker), JSON.stringify({ owner: 'spice-workbench', site, version: 1 }), { flag: 'wx', mode: 0o600 })
    }
    return profile
  }
  private async state(site: SiteSessionId): Promise<SiteSessionStatus> {
    const current = this.current.get(site)
    if (current) return current
    const saved = await this.ownedProfile(site)
    return this.update(site, saved ? 'saved' : 'not-connected', saved ? '已保存专用浏览器资料；打开登录窗口后可检测。' : '尚未打开该站点的专用登录窗口。')
  }
  async status(): Promise<SiteBrowserStatus> {
    return { available: Boolean(this.browser), ...(this.browser ? { browserName: this.browser.name } : {}), running: this.contexts.size > 0,
      sites: await Promise.all(siteSessionSites.map(item => this.state(item.id))) }
  }
  private async openContext(site: SiteSessionId, signal?: AbortSignal): Promise<SiteSessionStatus> {
    signal?.throwIfAborted()
    if (this.closing) throw new Error('站点浏览器正在关闭')
    if (!this.browser) return this.update(site, 'error', '未找到已安装的 Edge 或 Chrome。')
    const existing = this.contexts.get(site)
    if (existing) {
      try {
        const pages = existing.pages()
        const action = this.actionPages.get(site)
        if (action && !pages.includes(action)) this.actionPages.delete(site)
        const foreground = action && pages.includes(action) ? action : pages[0]
        if (foreground) {
          try { await bounded(foreground.bringToFront(), 3_000, signal); return this.state(site) }
          catch { /* The tab was closed while switching to it; open the site again. */ }
        }
        const page = await bounded(existing.newPage(), operationMs, signal, late => late.close())
        await bounded(page.goto(sites[site].home, { waitUntil: 'domcontentloaded', timeout: navigationMs }), operationMs, signal)
        await bounded(page.bringToFront(), 3_000, signal)
        return this.update(site, 'login-open', '站点窗口已重新打开；登录后可检查连接。')
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error
        return this.update(site, 'error', '无法重新打开站点窗口；请检查浏览器状态。')
      }
    }
    try {
      const profile = await this.ensureProfile(site)
      const context = await bounded(this.driver.launch(profile, this.browser.executable), operationMs, signal, late => late.close())
      if (this.closing || signal?.aborted) {
        await bounded(context.close(), 5_000).catch(() => undefined)
        throw signal?.reason ?? new Error('站点浏览器正在关闭')
      }
      this.contexts.set(site, context)
      context.on('close', () => { if (this.contexts.get(site) === context) { this.contexts.delete(site); this.actionPages.delete(site); this.update(site, 'saved', '浏览器已关闭；登录资料保存在专用目录，可重新打开检查。') } })
      const page = context.pages()[0] ?? await bounded(context.newPage(), operationMs, signal, late => late.close())
      await bounded(page.goto(sites[site].home, { waitUntil: 'domcontentloaded', timeout: navigationMs }), operationMs, signal)
      await bounded(page.bringToFront(), 3_000, signal)
      return this.update(site, 'login-open', '专用站点窗口已打开；请在窗口中自行登录，然后点击检查连接。')
    } catch (error) {
      const context = this.contexts.get(site)
      if (context) {
        try {
          await bounded(context.close(), 5_000)
          if (this.contexts.get(site) === context) this.contexts.delete(site)
        } catch { /* Keep the context tracked if the browser did not close. */ }
      }
      if (signal?.aborted) throw signal.reason ?? error
      return this.update(site, 'error', '无法打开专用浏览器窗口；请检查浏览器安装或网络连接。')
    }
  }
  async open(site: SiteSessionId, signal?: AbortSignal): Promise<SiteSessionStatus> {
    const limited = effectiveSignal(signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal, 40_000)
    return this.serial(site, () => this.openContext(site, limited), limited)
  }
  async check(site: SiteSessionId, signal?: AbortSignal): Promise<SiteSessionStatus> {
    await this.search(site, sites[site].probe, signal)
    return this.state(site)
  }
  async forget(site: SiteSessionId): Promise<SiteSessionStatus> {
    return this.serial(site, async () => {
      if (this.closing) throw new Error('站点浏览器正在关闭')
      try {
        const context = this.contexts.get(site)
        if (context) await bounded(context.close(), 5_000)
        if (this.contexts.get(site) === context) this.contexts.delete(site)
        this.actionPages.delete(site)
        if (await this.ownedProfile(site)) await rm(this.profile(site), { recursive: true, force: false })
        return this.update(site, 'not-connected', '该站点专用登录资料已清除。')
      } catch { return this.update(site, 'error', '无法安全清除该站点资料；目录所有权或浏览器状态需要检查。') }
    })
  }
  async search(site: SiteSessionId, query: string, signal?: AbortSignal): Promise<ModelSearchSourceStatus | undefined> {
    const limited = effectiveSignal(signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal, 30_000)
    limited.throwIfAborted()
    const value = partQuery(query), url = siteSearchUrl(site, value)
    return this.serial(site, async () => {
      limited.throwIfAborted()
      if (!this.contexts.has(site)) {
        if (!(await this.ownedProfile(site))) return undefined
        await this.openContext(site, limited)
      }
      const context = this.contexts.get(site)
      if (!context) return publicStatus(site, 'unavailable', value, '专用浏览器暂不可用；请检查浏览器安装并重新打开。')
      const release = await this.searchSlot(limited)
      try { return await this.searchInContext(site, value, url, context, limited) }
      finally { release() }
    }, limited)
  }
  private async searchInContext(site: SiteSessionId, value: string, url: string, context: BrowserContext, signal?: AbortSignal): Promise<ModelSearchSourceStatus> {
    let page: BrowserPage | undefined
    let keepForAction = false
    const requireAction = async (detail: string): Promise<ModelSearchSourceStatus> => {
      this.update(site, 'needs-action', '站点要求在专用窗口中完成登录或验证。')
      if (page) {
        const previous = this.actionPages.get(site)
        this.actionPages.set(site, page)
        keepForAction = true
        if (previous && previous !== page) await bounded(previous.close(), 3_000).catch(() => undefined)
        await bounded(page.bringToFront(), 3_000, signal).catch(() => undefined)
      }
      return publicStatus(site, 'restricted', value, detail)
    }
    const clearPreviousAction = async (): Promise<void> => {
      const previous = this.actionPages.get(site)
      this.actionPages.delete(site)
      if (previous && previous !== page) await bounded(previous.close(), 3_000).catch(() => undefined)
    }
    try {
      page = await bounded(context.newPage(), operationMs, signal, late => late.close())
      await bounded(page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationMs }), operationMs, signal)
      if (!page.url().startsWith(sites[site].origin + '/')) {
        return requireAction('站点转到登录或验证页面；请在专用窗口中自行完成。')
      }
      if (site === 'semiee') {
        const response = await bounded(page.evaluate(async endpoint => {
          try {
            // Matches the site's publicly served ddAjax headers. The credential
            // stays inside this origin and never returns to Node or the UI.
            const token = localStorage.getItem('token') ?? ''
            const deviceId = localStorage.getItem('deviceid') ?? ''
            const result = await fetch(endpoint, { credentials: 'same-origin', signal: AbortSignal.timeout(8_000), headers: {
              token, deviceId, source: '1', os: '2', Accept: 'application/json', 'Content-Type': 'application/json',
            } })
            const data: unknown = await result.json()
            const body = data && typeof data === 'object' ? data as { code?: unknown; result?: unknown; remark?: unknown; message?: unknown } : {}
            return { status: result.status, code: body.code, count: Array.isArray(body.result) ? body.result.filter(item => item && typeof item === 'object' && Number((item as { type?: unknown }).type) === 5).length : 0,
              restricted: /登录|验证|captcha|限制/i.test(String(body.remark ?? body.message ?? '')) }
          } catch { return { status: 0, code: -1, count: 0, restricted: false } }
        }, semieeLookupUrl(value)), operationMs, signal)
        if (response.restricted || [401, 403, 429].includes(response.status)) {
          return requireAction('Semiee 要求登录或浏览器验证；请在专用窗口中自行完成。')
        }
        if (response.code === 0 && response.count > 0) {
          await clearPreviousAction()
          this.update(site, 'ready', '已验证站内器件结果；登录资料保存在专用浏览器中。')
          return { ...publicStatus(site, 'searched', value, `Semiee 返回 ${response.count} 条器件记录；尚未验证 SPICE 模型。`), resultCount: response.count }
        }
        this.update(site, 'saved', '专用窗口已保存；尚未取得可验证的站内器件结果。')
        return publicStatus(site, 'unavailable', value, 'Semiee 尚未返回可验证的器件记录；不能据此判断型号不存在。')
      }
      for (let attempt = 0; attempt < 24; attempt++) {
        signal?.throwIfAborted()
        // Read only link text, headings and challenge indicators. Large script bundles,
        // session cookies and page storage never leave the site's browser context.
        const snapshot = await bounded(page.evaluate(({ maxChars }) => {
          const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
          const heading = document.title.slice(0, 200)
          let html = `<title>${escape(heading)}</title>`
          const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href]')
          for (let index = 0; index < Math.min(anchors.length, 1200); index++) {
            const anchor = anchors[index]
            const href = anchor.getAttribute('href') ?? ''
            const h3 = anchor.querySelector('h3')?.textContent?.trim().slice(0, 220)
            const label = anchor.textContent?.trim().slice(0, 220) ?? ''
            const item = `<a href="${escape(href)}">${h3 ? `<h3>${escape(h3)}</h3>` : escape(label)}</a>`
            if (html.length + item.length > maxChars) break
            html += item
          }
          const challenge = Array.from(document.querySelectorAll<HTMLElement>('[id*="captcha" i], [class*="captcha" i], [id*="challenge" i], [class*="challenge" i], [id*="geetest" i]'))
            .some(element => { const style = getComputedStyle(element); return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0 }) ||
            /our systems have detected unusual traffic|verify you are human|检测到异常流量|请完成安全验证|访问验证/i.test(document.body?.innerText.slice(0, 3000) ?? '')
          return { html, challenge }
        }, { maxChars: maxHtml }), operationMs, signal)
        if (snapshot.challenge || challengePage(snapshot.html)) return requireAction('站点要求登录或验证；请在专用窗口中自行完成。')
        const results = site === 'google' ? parseGoogleResults(snapshot.html) : site === 'lcsc' ? lcscResults(snapshot.html) : allDatasheetResults(snapshot.html)
        if (results.length) {
          await clearPreviousAction()
          this.update(site, 'ready', '已验证站内搜索结果；登录资料保存在专用浏览器中。')
          return publicStatus(site, 'searched', value, `已读取 ${results.length} 条可核对的站内结果；尚未验证 SPICE 模型。`, results)
        }
        if (attempt < 23) await bounded(new Promise<void>(resolve => setTimeout(resolve, 350)), 1_000, signal)
      }
      this.update(site, 'saved', '专用窗口已保存；尚未取得可验证的站内搜索结果。')
      return publicStatus(site, 'unavailable', value, '站点没有返回可核对的结果；请在专用窗口查看页面，不能据此判断型号不存在。')
    } catch {
      this.update(site, 'error', '站点搜索暂不可用；浏览器窗口和已保存资料可继续使用。')
      return publicStatus(site, 'unavailable', value, '专用站点搜索暂不可用；请在窗口中检查网络和站点状态。')
    } finally {
      if (page && !keepForAction) await bounded(page.close(), 3_000).catch(() => undefined)
    }
  }
  async close(): Promise<void> {
    this.closing = true
    this.lifetime.abort(new Error('站点浏览器正在关闭'))
    const contexts = [...this.contexts.entries()]
    await Promise.allSettled(contexts.map(async ([site, context]) => {
      try {
        await bounded(context.close(), 5_000)
        if (this.contexts.get(site) === context) this.contexts.delete(site)
        this.actionPages.delete(site)
        this.update(site, 'saved', '浏览器已关闭；专用登录资料已保留。')
      } catch { this.update(site, 'error', '浏览器未能确认关闭；请先关闭专用窗口。') }
    }))
    this.closed = true
  }
}

let singleton: SiteBrowserManager | undefined
export function getSiteBrowserManager(): SiteBrowserManager {
  if (!singleton || singleton.isClosed) singleton = new SiteBrowserManager()
  return singleton
}
