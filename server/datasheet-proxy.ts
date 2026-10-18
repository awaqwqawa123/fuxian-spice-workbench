import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { promisify } from 'node:util'
import { publicAddress } from './public-network'

const runFile = promisify(execFile)

/** Only a configured loopback HTTP CONNECT proxy may carry an approved HTTPS request. */
export function loopbackProxyUrl(raw: string | undefined): URL | undefined {
  if (!raw || raw.length > 200 || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}\/?$/.test(raw)) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.port || Number(url.port) < 1 || Number(url.port) > 65535 ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined
    return url
  } catch { return undefined }
}

export async function approvedProxyFor(hostname: string, signal?: AbortSignal): Promise<URL | undefined> {
  signal?.throwIfAborted()
  if (!/^[a-z0-9.-]{1,253}$/i.test(hostname)) throw new Error('规格书来源域名不正确')
  const configured = loopbackProxyUrl(process.env.HTTPS_PROXY ?? process.env.https_proxy)
  if (configured) return configured
  if (process.platform !== 'win32') return undefined
  // PowerShell resolves the current Windows proxy/PAC decision for this exact
  // already-approved hostname. A static command and restricted hostname keep
  // the search term, URL path and document contents out of the shell.
  const script = `$target=[uri]'https://${hostname}/';$proxy=[System.Net.WebRequest]::DefaultWebProxy.GetProxy($target);if($proxy.AbsoluteUri -ne $target.AbsoluteUri){[Console]::Write($proxy.AbsoluteUri)}`
  try {
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 2500, maxBuffer: 512, windowsHide: true, signal,
    })
    return loopbackProxyUrl(stdout.trim())
  } catch (error) {
    signal?.throwIfAborted()
    // Proxy discovery is optional; direct HTTPS remains available.
    return undefined
  }
}

/** Keep the original public-DNS guard even when the proxy resolves the target. */
export async function assertPublicDatasheetHost(hostname: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const lookupTask = lookup(hostname, { all: true })
  const addresses = signal ? await new Promise<Awaited<typeof lookupTask>>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('规格书请求已取消'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    lookupTask.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  }) : await lookupTask
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('规格书来源解析到非公网地址')
}

export function loopbackProxyAgent(proxy: URL, targetHostname: string): { agent: HttpsAgent; destroy: (error?: Error) => void } {
  if (!loopbackProxyUrl(proxy.href)) throw new Error('仅允许本机代理')
  if (!/^[a-z0-9.-]{1,253}$/i.test(targetHostname)) throw new Error('规格书来源域名不正确')
  const agent = new HttpsAgent({ keepAlive: false })
  const pending = new Set<ClientRequest>()
  const active = new Set<TLSSocket>()
  let closingError: Error | undefined
  agent.createConnection = ((_, callback) => {
    if (!callback) throw new Error('本机代理需要异步连接回调')
    let completed = false
    const finish = (error: Error | null, socket?: ReturnType<typeof tlsConnect>) => {
      if (completed) return
      completed = true
      if (error) callback(error, undefined as unknown as ReturnType<typeof tlsConnect>)
      else if (socket) callback(null, socket)
    }
    const tunnel = httpRequest({ hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port), method: 'CONNECT',
      path: `${targetHostname}:443`, headers: { Host: `${targetHostname}:443` }, agent: false })
    pending.add(tunnel)
    tunnel.on('connect', (response, socket, head) => {
      pending.delete(tunnel)
      if (response.statusCode !== 200 || head.length) {
        socket.destroy(); finish(new Error(`本机代理无法连接规格书来源（HTTP ${response.statusCode}）`)); return
      }
      const secure = tlsConnect({ socket, servername: targetHostname, ALPNProtocols: ['http/1.1'] })
      active.add(secure)
      secure.once('close', () => active.delete(secure))
      secure.once('secureConnect', () => finish(null, secure))
      secure.once('error', finish)
    })
    tunnel.once('error', () => { pending.delete(tunnel); finish(closingError ?? new Error('本机网络代理连接失败，请检查网络设置')) })
    tunnel.end()
    return undefined as unknown as ReturnType<HttpsAgent['createConnection']>
  }) as HttpsAgent['createConnection']
  return { agent, destroy(error) { closingError = error; for (const tunnel of pending) tunnel.destroy(error); pending.clear(); for (const socket of active) socket.destroy(error); active.clear(); agent.destroy() } }
}
