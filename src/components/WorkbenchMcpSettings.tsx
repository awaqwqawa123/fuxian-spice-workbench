import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, LoaderCircle, Plug, RefreshCw } from 'lucide-react'
import { getWorkbenchMcpInfo, type WorkbenchMcpInfo } from '../core/workbench-mcp-client'

const capabilityLabels: Record<string, string> = {
  projects: '项目读取', 'circuit-design': '电路绘制', 'model-search': '模型搜索',
  'local-model-library': '本地模型库', simulation: '电路仿真',
  'task-status': '任务进度', cancel: '取消任务', 'schematic-preview': '电路预览',
  'workbench-status': '工作台状态',
}

export default function WorkbenchMcpSettings() {
  const [info, setInfo] = useState<WorkbenchMcpInfo | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [status, setStatus] = useState(''), [revision, setRevision] = useState(0)
  const configuration = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 10_000)
    setLoading(true); setError(''); setInfo(null); setStatus('')
    void getWorkbenchMcpInfo(controller.signal).then(value => { if (active && !controller.signal.aborted) setInfo(value) }).catch(cause => { if (active) setError(controller.signal.aborted ? '接口检查超时，可重新检测。' : (cause as Error).message) }).finally(() => { window.clearTimeout(timeout); if (active) setLoading(false) })
    return () => { active = false; window.clearTimeout(timeout); controller.abort() }
  }, [revision])
  const config = info ? JSON.stringify(info.config, null, 2) : ''
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(config)
      setStatus('接入配置已复制，在外部助手的 MCP 设置中粘贴。')
    } catch {
      const input = configuration.current
      if (input) { input.closest('details')?.setAttribute('open', ''); input.focus(); input.select() }
      setStatus('请复制下方已选中的接入配置，或下载配置文件。')
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([config + '\n'], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'fuxian-mcp.json'; anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setStatus('已导出接入配置。添加到外部助手的 MCP 设置即可。')
  }
  return <section className="workbench-mcp-settings" aria-label="外部助手接入">
    <div className="settings-section-title"><div><h3>外部助手 · MCP</h3><p>让支持 MCP 的助手使用伏安的电路、模型库和仿真工具。</p></div></div>
    <div className="settings-connection-card">
      <div className="settings-connection-title"><strong><Plug size={16}/>伏安工具接口</strong><span data-ready={!loading && info?.ready || undefined}>{loading ? '检测中' : info?.ready ? '接口已就绪' : '暂不可用'}</span></div>
      <p role="status">{loading ? '正在检查本机工具接口…' : error || info?.message}</p>
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
      <li><strong>1. 添加到助手</strong><p>复制或下载接入配置，在外部助手的 MCP 设置中添加“伏安”。</p></li>
      <li><strong>2. 选择项目</strong><p>保持工作台运行并打开电路项目，让助手读取项目列表，选择要操作的电路。</p></li>
      <li><strong>3. 预览并应用</strong><p>助手绘图和仿真后，方案会回到当前项目。预览后可应用、合并或撤销。</p></li>
    </ol>
    {info && <><div className="workbench-mcp-capabilities" aria-label="可调用的能力">{info.capabilities.map(capability => <span key={capability}>{capabilityLabels[capability] ?? capability}</span>)}</div><details className="workbench-mcp-config"><summary>查看接入配置 · {info.toolCount} 个工具</summary><label>通用 stdio MCP 配置<textarea ref={configuration} aria-label="MCP 接入配置" readOnly spellCheck={false} rows={9} value={config}/></label><small>配置只包含本机程序路径，连接凭据由程序读取。不同助手的设置格式可能需要调整；其他已有 MCP 服务配置可继续保留。</small></details></>}
  </section>
}
