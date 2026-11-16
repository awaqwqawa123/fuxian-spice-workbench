import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, Link2, LoaderCircle, RefreshCw } from 'lucide-react'
import type { DesktopCircuitConnection } from '../core/desktop-circuit-client'
import { activateWorkbenchMcpBridge, getWorkbenchMcpInfo, type WorkbenchMcpInfo } from '../core/workbench-mcp-client'
import { workbenchMcpConfiguration, type WorkbenchMcpClient } from '../core/workbench-mcp-config'

const clientLabels: Record<WorkbenchMcpClient, string> = {
  codex: 'Codex', cursor: 'Cursor', dsh: 'DSH / Harness', generic: '其他 MCP 客户端',
}
const capabilityLabels: Record<string, string> = {
  projects: '项目读取', 'circuit-design': '电路绘制', 'model-search': '模型搜索',
  'local-model-library': '本地模型库', simulation: '电路仿真',
  'task-status': '任务进度', cancel: '取消任务', 'schematic-preview': '电路预览',
  'workbench-status': '工作台状态',
}

interface Props {
  projectId?: string
  desktopCircuit?: Pick<DesktopCircuitConnection, 'state' | 'status' | 'error'>
}

export default function WorkbenchMcpSettings({ projectId, desktopCircuit }: Props) {
  const [info, setInfo] = useState<WorkbenchMcpInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [revision, setRevision] = useState(0)
  const [client, setClient] = useState<WorkbenchMcpClient>('codex')
  const configuration = useRef<HTMLTextAreaElement>(null)
  const preview = useRef<HTMLDetailsElement>(null)
  const feedback = useRef(0)
  const activation = useRef<AbortController | null>(null)
  useEffect(() => () => { activation.current?.abort(); activation.current = null }, [])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 10_000)
    setLoading(true); setError(''); setInfo(null); setStatus('')
    void getWorkbenchMcpInfo(controller.signal).then(value => {
      if (active && !controller.signal.aborted) setInfo(value)
    }).catch(cause => {
      if (active) setError(controller.signal.aborted ? '接口检查超时，可重新检测。' : (cause as Error).message)
    }).finally(() => {
      window.clearTimeout(timeout)
      if (active) setLoading(false)
    })
    return () => { active = false; feedback.current++; window.clearTimeout(timeout); controller.abort() }
  }, [revision])

  const bridgeStatus = info?.bridgeStatus
  const exported = !loading && !activating && info?.ready && bridgeStatus !== 'relink-required' ? workbenchMcpConfiguration(info, client) : null
  const snapshot = desktopCircuit?.state?.snapshot
  const currentSnapshot = info?.ready && desktopCircuit?.status === 'ready' && snapshot?.projectId === projectId ? snapshot : null
  const projectSyncError = projectId && (desktopCircuit?.status === 'conflict' || desktopCircuit?.status === 'error')
  const projectLabel = !projectId ? '未打开工程'
    : projectSyncError ? '同步待处理'
    : loading || desktopCircuit?.status === 'connecting' || desktopCircuit?.status === 'syncing' ? '等待同步'
    : currentSnapshot ? '当前工程已同步' : '当前工程待确认'

  async function copy() {
    if (!exported) return
    const request = ++feedback.current
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(exported.text)
      if (request === feedback.current) setStatus('接入配置已复制。请按下方说明合并到客户端。')
    } catch {
      if (request !== feedback.current) return
      if (preview.current) preview.current.open = true
      const input = configuration.current
      if (input) { input.focus(); input.select() }
      setStatus('请复制下方已选中的接入配置，或下载配置文件。')
    }
  }

  function download() {
    if (!exported) return
    feedback.current++
    const url = URL.createObjectURL(new Blob([exported.text], { type: exported.mediaType }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = exported.filename; anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setStatus('接入配置已下载。请按下方说明合并到客户端。')
  }

  async function enableBridge() {
    if (activation.current || !info?.ready || bridgeStatus !== 'unlinked') return
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 30_000)
    activation.current = controller
    setActivating(true); setError(''); setStatus('')
    try {
      const value = await activateWorkbenchMcpBridge(controller.signal)
      if (!controller.signal.aborted) {
        setInfo(value)
        setStatus('固定入口已启用。请复制更新后的配置到 AI 客户端。')
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message)
      else if (activation.current === controller) setError('启用结果尚未确认，请重新检测。')
    } finally {
      window.clearTimeout(timeout)
      if (activation.current === controller) { activation.current = null; setActivating(false) }
    }
  }

  return <section className="workbench-mcp-settings" aria-label="外部助手接入">
    <div className="settings-section-title"><div><h3>AI 工具连接 · MCP</h3><p>在 AI 客户端对话，回到伏线审阅和应用电路方案。</p></div></div>
    <ol className="workbench-mcp-steps">
      <li className="settings-connection-card">
        <div className="settings-connection-title"><strong><b>1</b>准备接入配置</strong><span data-ready={exported ? true : undefined}>{loading ? '检测中' : exported ? '配置已准备' : '配置暂不可用'}</span></div>
        <label>AI 客户端<select aria-label="MCP 配置客户端" value={client} onChange={event => { feedback.current++; setClient(event.target.value as WorkbenchMcpClient); setStatus('') }}>
          {Object.entries(clientLabels).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <p role="status">{loading ? '正在检查本机工具接口…' : bridgeStatus === 'linked' ? '固定入口已关联此工作区。移动伏线后，重新关联即可继续使用原 AI 配置。'
          : bridgeStatus === 'relink-required' ? '原关联已不可用。请参照下方步骤重新关联原工作区。'
            : info?.ready ? '伏线工具接口已就绪。启用固定入口后，移动软件无需更改 AI 配置。' : info?.message || '请保持伏线运行，然后重新检测。'}</p>
        <div className="workbench-mcp-actions">
          {bridgeStatus === 'unlinked' && info?.workspaceId && <button type="button" disabled={loading || activating || !info.ready} onClick={() => void enableBridge()}>{activating ? <LoaderCircle size={15} className="local-device-spinner"/> : <Link2 size={15}/>}启用固定入口</button>}
          <button type="button" disabled={!exported} onClick={() => void copy()}><Copy size={15}/>复制接入配置</button>
          <button type="button" disabled={!exported} onClick={download}><Download size={15}/>下载配置</button>
          <button type="button" disabled={loading || activating} onClick={() => { feedback.current++; setRevision(value => value + 1) }}>{loading ? <LoaderCircle size={15} className="local-device-spinner"/> : <RefreshCw size={15}/>}重新检测</button>
        </div>
        {bridgeStatus === 'relink-required' && <details className="workbench-mcp-config" open>
          <summary>如何重新关联</summary>
          <p>保留原工作区的数据，从新目录启动伏线。在新目录的终端运行以下命令，把示例中的路径换成实际路径，再点击“重新检测”。Windows 离线包可用 <code>./runtime/node.exe</code> 替换 <code>node</code>。</p>
          <textarea aria-label="重新关联命令" readOnly spellCheck={false} rows={3} value={`node scripts/workbench-bridge-install.mjs --relink --workspace ${info?.workspaceId} --connection "新的绝对路径/.desktop-circuit/connection.json"`}/>
        </details>}
        {error && <p className="settings-error" role="alert">{error}</p>}
        {status && <p className="settings-notice" role="status">{status}</p>}
        {exported && <div className="workbench-mcp-config">
          <p><strong>{exported.destination}：</strong>{exported.instructions}</p>
          <details ref={preview}>
            <summary>查看配置 / 手动复制</summary>
            <label>接入配置<textarea ref={configuration} aria-label="MCP 接入配置" readOnly spellCheck={false} rows={client === 'codex' ? 4 : 9} value={exported.text}/></label>
            <small>配置包含启动程序和参数。工作台会自行读取连接凭据。</small>
          </details>
        </div>}
      </li>
      <li className="settings-connection-card">
        <div className="settings-connection-title"><strong><b>2</b>检查客户端工具</strong><span>在客户端确认</span></div>
        <p>在 {clientLabels[client]} 的 MCP 工具列表中检查 <code>fuxian</code>，确认可用后，让助手调用 <code>list_projects</code>。网页的接口检查只反映伏线本机状态。</p>
      </li>
      <li className="settings-connection-card">
        <div className="settings-connection-title"><strong><b>3</b>核对当前工程</strong><span data-ready={currentSnapshot ? true : undefined}>{currentSnapshot && <Check size={12} aria-hidden="true"/>}{projectLabel}</span></div>
        <div aria-label="当前工程同步状态" role="status">
          {currentSnapshot ? <p><strong>{currentSnapshot.project.title}</strong> · 修订 {currentSnapshot.revision}。请核对助手读到的工程及修订，避免在其他工程上操作。</p>
            : projectSyncError ? <p>{desktopCircuit?.error || '当前工程同步未完成。请回到画布检查同步状态。'}</p>
            : !projectId ? <p>先打开或新建一个工程，再让助手读取项目列表。</p>
            : <p>等待画布完成同步后重新读取项目列表。其他工程出现在列表里时，请先核对目标工程。</p>}
        </div>
        {info && <details className="workbench-mcp-details">
          <summary>工作台工具与同步记录</summary>
          <div aria-label="项目与任务状态">
            {info.synchronizedProjectCount !== undefined && <p>{info.synchronizedProjectCount === 0
              ? '尚无已同步项目。请先打开并保存电路项目。'
              : `已同步 ${info.synchronizedProjectCount} 个项目。`}</p>}
            {info.runningTaskCount !== undefined && <p>正在运行的任务：{info.runningTaskCount} 个。</p>}
            {info.interruptedTaskCount !== undefined && info.interruptedTaskCount > 0 && <p>保留了 {info.interruptedTaskCount} 个中断任务。检查当前项目后可重新发起任务。</p>}
          </div>
          <div className="workbench-mcp-capabilities" aria-label="可调用的能力">{info.capabilities.map(capability => <span key={capability}>{capabilityLabels[capability] ?? capability}</span>)}</div>
        </details>}
      </li>
    </ol>
    <details className="workbench-mcp-details">
      <summary>工具找不到或软件移动了</summary>
      <p>客户端没启动或未登录时，请先在客户端完成操作。移动或重新解压伏线后，请从新位置启动、重新复制配置，并替换客户端原有的 <code>fuxian</code> 条目。</p>
      <p>工具能加载但没有收到工程时，请保持对应的伏线窗口运行，打开目标工程并检查同步状态，然后让助手再次读取工程列表。</p>
    </details>
  </section>
}
