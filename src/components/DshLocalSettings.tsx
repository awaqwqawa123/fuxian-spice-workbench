import { useEffect, useRef, useState } from 'react'
import { Plug, ExternalLink, RefreshCw } from 'lucide-react'
import { connectLocalAssistant } from '../core/assistant-connection-client'
import { getDshLocalStatus, type DshLocalSelection, type DshLocalStatus } from '../core/dsh-local-client'

interface Props {
  selection: DshLocalSelection | null
  onChange: (selection: DshLocalSelection | null) => void
  onStatus: (status: DshLocalStatus | null) => void
  disabled?: boolean
  onConnected?: () => void
}

export default function DshLocalSettings({ selection, onChange, onStatus, disabled, onConnected }: Props) {
  const [status, setStatus] = useState<DshLocalStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [connecting, setConnecting] = useState(false), [configurationUrl, setConfigurationUrl] = useState('')
  const connectionRequest = useRef<AbortController | null>(null)
  useEffect(() => () => connectionRequest.current?.abort(), [])
  const latest = useRef({ selection, onChange, onStatus })
  latest.current = { selection, onChange, onStatus }
  useEffect(() => {
    const controller = new AbortController()
    setChecking(true); setError(''); latest.current.onStatus(null)
    void getDshLocalStatus(controller.signal).then(next => {
      if (controller.signal.aborted) return
      setStatus(next); latest.current.onStatus(next)
      const previous = latest.current.selection
      const provider = next.providers.find(item => item.configured && item.id === previous?.provider) ?? next.providers.find(item => item.configured)
      const model = provider?.models.includes(previous?.model ?? '') ? previous!.model : provider?.models[0]
      const selected = provider && model ? { provider: provider.id, model } : null
      if (selected?.provider !== previous?.provider || selected?.model !== previous?.model) latest.current.onChange(selected)
    }).catch(cause => {
      if (!controller.signal.aborted) { setStatus(null); setError(cause instanceof Error ? cause.message : 'DSH 状态读取失败'); latest.current.onStatus(null) }
    }).finally(() => { if (!controller.signal.aborted) setChecking(false) })
    return () => controller.abort()
  }, [refresh])
  async function connect(action: 'connect' | 'configure') {
    if (connectionRequest.current) return
    const controller = new AbortController(); connectionRequest.current = controller; setConnecting(true); setError('')
    let popup: Window | null = null
    if (action === 'configure') { try { popup = window.open('about:blank', '_blank') } catch { /* The explicit link remains available when popups are blocked. */ } }
    try {
      const result = await connectLocalAssistant('dsh', action, controller.signal)
      if (controller.signal.aborted) { popup?.close(); return }
      if (result.url) { setConfigurationUrl(result.url); if (popup) popup.location.href = result.url } else popup?.close()
      if (result.dsh) {
        const next = { ...result.dsh, message: result.message }; setStatus(next); latest.current.onStatus(next)
        const previous = latest.current.selection
        const provider = next.providers.find(item => item.configured && item.id === previous?.provider) ?? next.providers.find(item => item.configured)
        const model = provider?.models.includes(previous?.model ?? '') ? previous!.model : provider?.models[0]
        const selected = provider && model ? { provider: provider.id, model } : null
        if (selected?.provider !== previous?.provider || selected?.model !== previous?.model) latest.current.onChange(selected)
      }
      if (result.state === 'ready') onConnected?.()
    } catch (cause) { popup?.close(); if (!controller.signal.aborted) setError((cause as Error).message) }
    finally { if (connectionRequest.current === controller) { connectionRequest.current = null; setConnecting(false) } }
  }
  function cancelConnection() { connectionRequest.current?.abort(); connectionRequest.current = null; setConnecting(false); setError('连接已取消；已有本机凭据保持不变。') }
  const provider = status?.providers.find(item => item.id === selection?.provider)
  return <section className="dsh-local-settings" aria-label="DSH 本机登录配置">
    <div className="dsh-local-heading"><strong>DSH 本机登录</strong><button type="button" aria-label="刷新 DSH 状态" disabled={disabled || checking} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />刷新</button></div>
    <p role="status">{checking ? '正在读取本机 DSH 配置…' : error || status?.message}</p>
    <div className="settings-native-actions"><button type="button" aria-label="一键连接 DSH" disabled={disabled || checking || connecting} onClick={() => void connect('connect')}><Plug size={14}/>{connecting ? '连接中…' : '一键连接'}</button><button type="button" disabled={disabled || connecting} onClick={() => void connect('configure')}><ExternalLink size={14}/>官方模型设置</button>{connecting && <button type="button" onClick={cancelConnection}>取消连接</button>}{configurationUrl && <a href={configurationUrl} target="_blank" rel="noreferrer">打开 DSH 官方设置，完成后点一键连接</a>}</div>
    {status?.version && <small>DeepSeek Harness {status.version}</small>}
    {!!status?.providers.some(item => item.configured) && <div className="dsh-local-selects">
      <label>供应商<select aria-label="本机 DSH 供应商" value={selection?.provider ?? ''} disabled={disabled || checking} onChange={event => {
        const next = status.providers.find(item => item.id === event.target.value)
        onChange(next?.models[0] ? { provider: next.id, model: next.models[0] } : null)
      }}>
        {status.providers.filter(item => item.configured).map(item => <option key={item.id} value={item.id}>{item.label} · {item.auth === 'oauth' ? '本机登录凭据' : '本机密钥'}</option>)}
      </select></label>
      <label>模型<select aria-label="本机 DSH 模型" value={selection?.model ?? ''} disabled={disabled || checking} onChange={event => provider && onChange({ provider: provider.id, model: event.target.value })}>
        {provider?.models.map(model => <option key={model} value={model}>{model}</option>)}
      </select></label>
    </div>}
    <details className="dsh-local-help" open={!checking && !status?.available}><summary>登录与配置方式</summary>
      <p>在工作台项目目录的终端运行 <code>npx --no-install dsh web</code>，进入 DSH 的设置 → Models，选择供应商完成登录或配置密钥，然后回到这里刷新。</p>
      <p>DSH 没有统一账户登录。仅提供 OAuth 的供应商可网页登录；DeepSeek 官方供应商使用 API 密钥。这里复用 DSH 保存的凭据。</p>
      <a href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noreferrer">查看 DSH 官方说明</a>
    </details>
  </section>
}
