import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, LoaderCircle, Plug, RefreshCw } from 'lucide-react'
import { getWorkbenchMcpInfo, type WorkbenchMcpInfo } from '../core/workbench-mcp-client'
import { workbenchMcpConfiguration, type WorkbenchMcpClient } from '../core/workbench-mcp-config'

const capabilityLabels: Record<string, string> = {
  projects: '项目读取', 'circuit-design': '电路绘制', 'model-search': '模型搜索',
  'local-model-library': '本地模型库', simulation: '电路仿真',
  'task-status': '任务进度', cancel: '取消任务', 'schematic-preview': '电路预览',
  'workbench-status': '工作台状态',
}

export default function WorkbenchMcpSettings() {
  const [info, setInfo] = useState<WorkbenchMcpInfo | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [status, setStatus] = useState(''), [revision, setRevision] = useState(0)
  const [client, setClient] = useState<WorkbenchMcpClient>('codex')
  const configuration = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 10_000)
    setLoading(true); setError(''); setInfo(null); setStatus('')
    void getWorkbenchMcpInfo(controller.signal).then(value => { if (active && !controller.signal.aborted) setInfo(value) }).catch(cause => { if (active) setError(controller.signal.aborted ? '接口检查超时，可重新检测。' : (cause as Error).message) }).finally(() => { window.clearTimeout(timeout); if (active) setLoading(false) })
    return () => { active = false; window.clearTimeout(timeout); controller.abort() }
  }, [revision])
  const exported = info ? workbenchMcpConfiguration(info, client) : null
  const config = exported?.text ?? ''
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(config)
      setStatus('接入配置已复制，请合并到所选 AI 客户端的 MCP 配置中。')
    } catch {
      const input = configuration.current
      if (input) { input.focus(); input.select() }
      setStatus('请复制下方已选中的接入配置，或下载配置文件。')
    }
  }
  function download() {
    if (!exported) return
    const url = URL.createObjectURL(new Blob([config], { type: exported.mediaType }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = exported.filename; anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setStatus('已导出接入配置。添加到外部助手的 MCP 设置即可。')
  }
  return <section className="workbench-mcp-settings" aria-label="外部助手接入">
    <div className="settings-section-title"><div><h3>AI 工具连接 · MCP</h3><p>把伏线作为工具添加到 AI 客户端，由客户端对话并执行，网页同步工程和候选方案。</p></div></div>
    <label>AI 客户端<select aria-label="MCP 配置客户端" value={client} onChange={event=>{setClient(event.target.value as WorkbenchMcpClient);setStatus('')}}><option value="codex">Codex</option><option value="cursor">Cursor</option><option value="dsh">DSH / Harness</option><option value="generic">其他 MCP 客户端</option></select></label>
    <div className="settings-connection-card">
      <div className="settings-connection-title"><strong><Plug size={16}/>伏线工具接口</strong><span data-ready={!loading && info?.ready || undefined}>{loading ? '检测中' : info?.ready ? '接口已就绪' : '暂不可用'}</span></div>
      <p role="status">{loading ? '正在检查本机工具接口…' : error || info?.message}</p>
      <small>这里只检测工作台服务是否就绪。外部 AI 是否已加载工具，请在对应客户端中确认。</small>
      {info && <div aria-label="项目与任务状态">
        {info.synchronizedProjectCount !== undefined && <p>{info.synchronizedProjectCount === 0
          ? '尚无已同步项目。请先打开并保存电路项目，再让助手读取项目列表。'
          : `已同步 ${info.synchronizedProjectCount} 个项目，助手可读取项目列表并选择电路。`}</p>}
        {info.runningTaskCount !== undefined && <p>正在运行的任务：{info.runningTaskCount} 个。</p>}
        {info.interruptedTaskCount !== undefined && info.interruptedTaskCount > 0 && <p>保留了 {info.interruptedTaskCount} 个中断任务。请让助手检查当前项目并重新发起任务；原任务不会自动继续。</p>}
      </div>}
      <div className="workbench-mcp-actions">
        <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>{loading ? <LoaderCircle size={15} className="local-device-spinner"/> : <RefreshCw size={15}/>}重新检测</button>
        <button type="button" disabled={loading || !info?.ready} onClick={() => void copy()}><Copy size={15}/>复制接入配置</button>
        <button type="button" disabled={loading || !info?.ready} onClick={download}><Download size={15}/>下载配置</button>
      </div>
      {error && <p className="settings-error" role="alert">{error}</p>}
      {status && <p className="settings-notice" role="status"><Check size={14}/>{status}</p>}
    </div>
    <ol className="workbench-mcp-steps">
      <li><strong>1. 添加到助手</strong><p>选择客户端，复制或下载配置，在 AI 的 MCP 设置中添加“伏线”。</p></li>
      <li><strong>2. 选择项目</strong><p>保持工作台运行并打开电路项目，让助手读取项目列表，选择要操作的电路。</p></li>
      <li><strong>3. 预览并应用</strong><p>助手绘图和仿真后，方案会回到当前项目。预览后可应用、合并或撤销。</p></li>
    </ol>
    {info && exported && <><div className="workbench-mcp-capabilities" aria-label="可调用的能力">{info.capabilities.map(capability => <span key={capability}>{capabilityLabels[capability] ?? capability}</span>)}</div><div className="workbench-mcp-config"><label>{exported.destination}<textarea ref={configuration} aria-label="MCP 接入配置" readOnly spellCheck={false} rows={client==='codex'?5:10} value={config}/></label><p>{exported.instructions}</p><small>{info.toolCount} 个工具 · stdio · 配置只包含本机程序路径，连接凭据由程序读取。软件移到其他目录后请重新复制配置。</small></div></>}
  </section>
}
