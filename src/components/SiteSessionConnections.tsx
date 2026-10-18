import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleAlert, ExternalLink, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react'
import { siteSessionSites, type SiteBrowserStatus, type SiteSessionId, type SiteSessionState, type SiteSessionStatus } from '../core/site-sessions'

type SiteAction = 'open' | 'check' | 'forget'

const stateLabels: Record<SiteSessionState, string> = {
  'not-connected': '尚未连接',
  'login-open': '等待浏览器登录',
  saved: '已保存，待检查',
  ready: '连接可用',
  'needs-action': '需要登录或验证',
  error: '连接检查失败',
}

const actionLabels: Record<SiteAction, string> = {
  open: '正在打开浏览器…',
  check: '正在检查连接…',
  forget: '正在清除会话…',
}

const actionTimeouts: Record<SiteAction, number> = { open: 45_000, check: 35_000, forget: 35_000 }

async function postSession<T>(body: { action: 'status' | SiteAction; site?: SiteSessionId }, timeoutMs: number, controller: AbortController): Promise<T> {
  const signal = controller.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('站点连接操作已取消', 'AbortError'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`等待站点响应超过 ${Math.round(timeoutMs / 1000)} 秒，请稍后重试`))
      controller.abort(new DOMException('站点连接超时', 'TimeoutError'))
    }, timeoutMs)
  })
  try {
    const response = await Promise.race([fetch('/api/model-library/site-sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    }), deadline, interrupted])
    const value = await Promise.race([response.json(), deadline, interrupted]) as T & { error?: string }
    if (!response.ok) throw new Error(value.error || '站点连接操作失败')
    return value
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

export default function SiteSessionConnections({ focusSite }: { focusSite?: SiteSessionId }) {
  const pending = useRef<AbortController | undefined>(undefined)
  const [status, setStatus] = useState<SiteBrowserStatus>()
  const [busy, setBusy] = useState<{ action: SiteAction; site: SiteSessionId }>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function loadStatus() {
    const controller = new AbortController()
    pending.current = controller
    setLoading(true); setStatus(undefined); setError('')
    try {
      const value = await postSession<SiteBrowserStatus>({ action: 'status' }, 10_000, controller)
      if (!Array.isArray(value.sites)) throw new Error('无法读取站点连接状态')
      if (!controller.signal.aborted) setStatus(value)
    } catch (reason) {
      if (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError') setError((reason as Error).message || '无法连接本机服务，请稍后重试')
    } finally {
      if (pending.current === controller) pending.current = undefined
      if (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError') setLoading(false)
    }
  }

  useEffect(() => {
    void loadStatus()
    return () => pending.current?.abort()
  }, [])

  async function run(action: SiteAction, site: SiteSessionId) {
    if (busy || loading) return
    const controller = new AbortController()
    pending.current = controller
    setBusy({ action, site }); setError('')
    try {
      const value = await postSession<SiteSessionStatus>({ action, site }, actionTimeouts[action], controller)
      if (value.id !== site || !value.state) throw new Error('站点连接操作失败')
      if (!controller.signal.aborted) setStatus(previous => previous && { ...previous, sites: [...previous.sites.filter(item => item.id !== site), value] })
    } catch (reason) {
      if (controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError') return
      const message = (reason as Error).message || '无法连接本机服务，请稍后重试'
      setError(`${siteSessionSites.find(item => item.id === site)?.label}：${message}`)
      setStatus(previous => previous && { ...previous, sites: previous.sites.map(item => item.id === site ? { ...item, state: 'error', detail: message } : item) })
    } finally {
      if (pending.current === controller) pending.current = undefined
      if (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError') setBusy(undefined)
    }
  }

  return <section className="site-session-connections" aria-label="搜索站点连接">
    <div className="site-session-heading"><div><strong>搜索站点连接</strong><p>在专用浏览器窗口自行登录所需站点，完成后返回这里检查连接。</p></div><button type="button" disabled={Boolean(busy) || loading} onClick={() => void loadStatus()}><RefreshCw size={14}/>刷新状态</button></div>
    <p className="site-session-note">登录信息只保留在本机，密码不经过工作台；验证码请在原站完成。专用浏览器与日常浏览器的账号互不继承，首次需自行登录。保存后可复用，过期时会提示重新登录。</p>
    {status && !status.available && <p className="site-session-warning" role="status">专用浏览器暂不可用，请查看本站连接操作的提示并刷新状态。</p>}
    {error && <p className="site-session-error" role="alert"><CircleAlert size={15}/>{error}</p>}
    {loading && <p className="site-session-loading" role="status"><LoaderCircle size={15} className="site-session-spin"/>正在读取站点连接状态…</p>}
    <div className="site-session-grid">{siteSessionSites.map(site => {
      const current = status?.sites.find(item => item.id === site.id)
      const isBusy = busy?.site === site.id
      return <article key={site.id} data-site={site.id} data-state={current?.state || (status ? 'unreported' : 'loading')} className={focusSite === site.id ? 'site-session-focused' : ''}>
        <div className="site-session-card-title"><strong>{site.label}</strong><span>{current?.state === 'ready' ? <CheckCircle2 size={14}/> : current?.state === 'needs-action' || current?.state === 'error' ? <CircleAlert size={14}/> : null}{current ? stateLabels[current.state] : status ? '状态未报告' : '读取中'}</span></div>
        <p role="status">{isBusy && busy ? <><LoaderCircle size={14} className="site-session-spin"/>{actionLabels[busy.action]}</> : current?.detail || (current?.state === 'saved' ? '会话已保存，尚未核验当前是否可用。' : '连接后可检查本站的访问状态。')}</p>
        <div className="site-session-actions"><button type="button" disabled={!status || Boolean(busy) || loading} onClick={() => void run('open', site.id)}><ExternalLink size={13}/>打开浏览器登录</button><button type="button" disabled={!status || Boolean(busy) || loading} onClick={() => void run('check', site.id)}><RefreshCw size={13}/>我已完成，检查连接</button><button type="button" disabled={!status || Boolean(busy) || loading || current?.state === 'not-connected'} onClick={() => void run('forget', site.id)}><Trash2 size={13}/>清除本站会话</button></div>
      </article>
    })}</div>
  </section>
}
