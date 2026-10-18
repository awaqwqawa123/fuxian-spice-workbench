import { useEffect, useRef, useState } from 'react'
import { Blocks, Check, Eye, EyeOff, Globe2, KeyRound, Palette, Plug, RefreshCw, Settings2, SlidersHorizontal, X } from 'lucide-react'
import { aiProviderPresets, listAiModels, parseAiProvider, providerUrls, testAiConnection, type AiModelInfo, type AiProviderId } from '../core/ai-provider'
import { getCodexStatus, type CodexStatus } from '../core/codex-client'
import { changeDesktopControlSetup, getDesktopControlSetup, getDesktopControlState, reconnectDesktopControl, type DesktopControlSetupAction, type DesktopControlSetupStage } from '../core/desktop-control-client'
import { getDesktopConversationFolder, setDesktopConversationFolder } from '../core/desktop-conversation-folder-client'
import { getCursorStatus } from '../core/cursor-client'
import { updateAssistantSettings, useAssistantSettings, type AssistantApiSettings } from '../core/assistant-settings'
import type { AcquisitionEngine } from '../core/model-acquisition'
import { connectLocalAssistant, type AssistantConnectionAction } from '../core/assistant-connection-client'
import DshLocalSettings from './DshLocalSettings'
import DesktopConnectionGuide from './DesktopConnectionGuide'
import SiteSessionConnections from './SiteSessionConnections'
import { useWorkbenchDialog } from './AssistantWindow'
import WorkbenchMcpSettings from './WorkbenchMcpSettings'

type Section = 'connections' | 'api' | 'sources' | 'workspace' | 'integrations'
interface Props { onClose: () => void; onOpenAppearance: () => void; onOpenSimulation?: () => void; onOpenDesktopChat?: () => void; projectId?: string; initialSection?: Section }
export default function SettingsDialog({ onClose, onOpenAppearance, onOpenSimulation, onOpenDesktopChat, projectId, initialSection = 'connections' }: Props) {
  const shared = useAssistantSettings()
  const [section, setSection] = useState<Section>(initialSection)
  const [api, setApi] = useState<AssistantApiSettings>(() => ({ ...shared.api }))
  const [nativeModels, setNativeModels] = useState(() => ({ ...shared.nativeModels }))
  const [modelEngine, setModelEngine] = useState<AcquisitionEngine>(shared.modelEngine)
  const [conversationFolder, setConversationFolder] = useState(''), [savedConversationFolder, setSavedConversationFolder] = useState<string | null>(null)
  const [defaultConversationFolder, setDefaultConversationFolder] = useState(''), [folderLoading, setFolderLoading] = useState(true), [folderError, setFolderError] = useState(''), [folderRefresh, setFolderRefresh] = useState(0)
  const [saving, setSaving] = useState(false)
  const [native, setNative] = useState<{ codex: CodexStatus | null; cursor: CodexStatus | null }>({ codex: null, cursor: null })
  const [sharing, setSharing] = useState<{ stage: DesktopControlSetupStage | null; connected: boolean; threadId: string | null; error: string }>({ stage: null, connected: false, threadId: null, error: '' })
  const [setupBusy, setSetupBusy] = useState<DesktopControlSetupAction | 'auto' | null>(null), [setupError, setSetupError] = useState(''), [autoStatus, setAutoStatus] = useState('')
  const [localBusy, setLocalBusy] = useState<'codex' | 'cursor' | null>(null), [localMessages, setLocalMessages] = useState({ codex: '', cursor: '' })
  const localRequest = useRef<AbortController | null>(null)
  const [connectionErrors, setConnectionErrors] = useState({ codex: '', cursor: '' })
  const [checking, setChecking] = useState(true), [refresh, setRefresh] = useState(0)
  const [showKey, setShowKey] = useState(false), [models, setModels] = useState<AiModelInfo[]>([])
  const [busy, setBusy] = useState<'models' | 'test' | 'connect' | null>(null), [status, setStatus] = useState(''), [error, setError] = useState('')
  const request = useRef<AbortController | null>(null), setupRequest = useRef<AbortController | null>(null), panel = useRef<HTMLElement>(null)
  useWorkbenchDialog(panel, true, onClose)
  useEffect(() => () => { request.current?.abort(); setupRequest.current?.abort(); localRequest.current?.abort() }, [])
  useEffect(() => {
    const controller = new AbortController()
    setFolderLoading(true); setFolderError('')
    void getDesktopConversationFolder(controller.signal).then(value => {
      if (controller.signal.aborted) return
      setSavedConversationFolder(value.directory); setConversationFolder(value.directory ?? ''); setDefaultConversationFolder(value.defaultDirectory)
    }).catch(cause => { if (!controller.signal.aborted) setFolderError((cause as Error).message) }).finally(() => { if (!controller.signal.aborted) setFolderLoading(false) })
    return () => controller.abort()
  }, [folderRefresh])
  useEffect(() => {
    if (setupBusy || localBusy) { setChecking(false); return }
    const controller = new AbortController()
    setChecking(true); setConnectionErrors({ codex: '', cursor: '' })
    void Promise.allSettled([getCodexStatus(controller.signal), getCursorStatus(controller.signal), getDesktopControlSetup(controller.signal), getDesktopControlState(projectId ?? 'default', controller.signal)]).then(results => {
      if (controller.signal.aborted) return
      const [codex, cursor, setup, desktop] = results
      setNative({ codex: codex.status === 'fulfilled' ? codex.value : null, cursor: cursor.status === 'fulfilled' ? cursor.value : null })
      setConnectionErrors({ codex: codex.status === 'rejected' ? String(codex.reason?.message || '状态读取失败') : '', cursor: cursor.status === 'rejected' ? String(cursor.reason?.message || '状态读取失败') : '' })
      setSharing({ stage: setup.status === 'fulfilled' ? setup.value : null, connected: desktop.status === 'fulfilled' && desktop.value.connected && desktop.value.ready && desktop.value.desktopConnected, threadId: desktop.status === 'fulfilled' ? desktop.value.threadId : null, error: setup.status === 'rejected' ? String(setup.reason?.message || '安装状态读取失败') : desktop.status === 'rejected' ? String(desktop.reason?.message || '桌面连接状态读取失败') : '' })
      setChecking(false)
    })
    return () => controller.abort()
  }, [refresh, projectId, setupBusy, localBusy])
  useEffect(() => {
    if (sharing.stage !== 'activated' || sharing.connected || setupBusy) return
    const timer = setInterval(() => setRefresh(value => value + 1), 2500)
    return () => clearInterval(timer)
  }, [sharing.stage, sharing.connected, setupBusy])
  useEffect(() => { if (sharing.connected && autoStatus && autoStatus !== 'Codex 桌面共享已连接，当前项目对话会自动绑定。') setAutoStatus('Codex 桌面共享已连接，当前项目对话会自动绑定。') }, [sharing.connected, autoStatus])
  const folderDirty = !folderLoading && !folderError && (conversationFolder.trim() || null) !== savedConversationFolder
  const dirty = JSON.stringify(api) !== JSON.stringify(shared.api) || JSON.stringify(nativeModels) !== JSON.stringify(shared.nativeModels) || modelEngine !== shared.modelEngine || folderDirty
  let urls: ReturnType<typeof providerUrls> | undefined
  try { urls = providerUrls(api.endpoint) } catch { /* Validation shown on apply. */ }
  function patchApi(patch: Partial<AssistantApiSettings>) { setApi(previous => ({ ...previous, ...patch })); setError(''); setStatus(''); if ('endpoint' in patch || 'apiKey' in patch) setModels([]) }
  function preset(id: AiProviderId) {
    const selected = aiProviderPresets.find(item => item.id === id)!
    patchApi({ preset: id, endpoint: selected.endpoint || api.endpoint, protocol: selected.protocol ?? 'chat-completions', model: '', apiKey: '' }); setShowKey(false)
  }
  async function save() {
    if (saving) return
    setSaving(true)
    try {
      let validated: ReturnType<typeof parseAiProvider>
      try { validated = parseAiProvider(api, false) }
      catch (cause) { setSection('api'); throw cause }
      if (folderDirty) {
        try {
          const updated = await setDesktopConversationFolder(conversationFolder.trim() || null)
          setSavedConversationFolder(updated.directory); setConversationFolder(updated.directory ?? ''); setDefaultConversationFolder(updated.defaultDirectory)
        } catch (cause) { setSection('workspace'); throw cause }
      }
      updateAssistantSettings({ api: { ...validated, preset: api.preset }, nativeModels, modelEngine })
      setApi({ ...validated, preset: api.preset }); setStatus(folderDirty ? '设置已保存；新建电路对话将使用指定文件夹，已有对话保持原位置。' : '设置已保存，对话与模型搜索共用此连接；现有输入和任务记录已保留。'); setError('')
    } catch (cause) { setError((cause as Error).message) }
    finally { setSaving(false) }
  }
  async function runSetupAction(action: DesktopControlSetupAction) {
    if (setupRequest.current) return
    const controller = new AbortController(); setupRequest.current = controller; setSetupBusy(action); setSetupError('')
    try {
      const stage = await changeDesktopControlSetup(action, controller.signal)
      if (!controller.signal.aborted) { setSharing(previous => ({ ...previous, stage, error: '' })); setRefresh(value => value + 1) }
    } catch (cause) { if (!controller.signal.aborted) setSetupError((cause as Error).message) }
    finally { if (setupRequest.current === controller) setupRequest.current = null; if (!controller.signal.aborted) setSetupBusy(null) }
  }
  async function autoConnect() {
    if (setupRequest.current) return
    const controller = new AbortController(); setupRequest.current = controller; setSetupBusy('auto'); setSetupError(''); setAutoStatus('正在检查并恢复 Codex 桌面共享连接…')
    try {
      const result = await reconnectDesktopControl(projectId, undefined, controller.signal)
      if (controller.signal.aborted) return
      setSharing(previous => ({ stage: result.setupStage ?? previous.stage, connected: result.connected, threadId: result.state?.threadId ?? previous.threadId, error: '' }))
      if (result.stage === 'failed') { setSetupError(result.message); setAutoStatus('') }
      else setAutoStatus(result.message)
    } catch (cause) { if (!controller.signal.aborted) { setSetupError((cause as Error).message); setAutoStatus('') } }
    finally { if (setupRequest.current === controller) setupRequest.current = null; if (!controller.signal.aborted) setSetupBusy(null) }
  }
  async function checkApi(action: 'models' | 'test' | 'connect') {
    if (request.current) return
    const controller = new AbortController(); request.current = controller; setBusy(action); setError(''); setStatus('')
    const timer = setTimeout(() => controller.abort(), 65_000)
    try {
      if (action === 'models' || action === 'connect') { const response = await listAiModels(api, controller.signal); if (!controller.signal.aborted) { setModels(response.models); if (action === 'connect' && api.model.trim() && !response.models.some(item => item.id === api.model.trim())) throw new Error('服务已响应，但配置的模型不在返回目录中；请核对模型 ID 后连接。'); setStatus(action === 'connect' ? '模型 API 已连接，模型目录可访问；未发送付费推理，任务能力仍由实际模型验证。' : `读取到 ${response.models.length} 个模型；尚未验证模型推理。`) } }
      else { const response = await testAiConnection(api, controller.signal); if (!controller.signal.aborted) setStatus(`模型推理通过 · ${response.model} · ${(response.elapsedMs / 1000).toFixed(1)} 秒；工具调用需在任务中验证。`) }
    } catch (cause) { setError(controller.signal.aborted ? '配置检查已停止或超时，可重新检查。' : (cause as Error).message) }
    finally { clearTimeout(timer); request.current = null; setBusy(null) }
  }
  async function connectNative(engine: 'codex' | 'cursor', action: AssistantConnectionAction = 'connect') {
    if (localRequest.current) return
    const controller = new AbortController(); localRequest.current = controller; setLocalBusy(engine)
    setConnectionErrors(previous => ({ ...previous, [engine]: '' })); setLocalMessages(previous => ({ ...previous, [engine]: action === 'login' ? '等待官方浏览器登录；完成后自动核对连接，可以取消。' : engine === 'cursor' ? '正在检测官方 CLI；缺少时安装到本工作区，再核对登录和 ACP 协议。' : '正在核对本机登录与工具协议；不会发送模型任务。' }))
    try {
      const result = await connectLocalAssistant(engine, action, controller.signal)
      if (controller.signal.aborted) return
      if (result.native) setNative(previous => ({ ...previous, [engine]: result.native! }))
      setLocalMessages(previous => ({ ...previous, [engine]: result.message }))
      if (result.state === 'ready') { setModelEngine(engine); updateAssistantSettings({ modelEngine: engine }) }
    } catch (cause) { if (!controller.signal.aborted) setConnectionErrors(previous => ({ ...previous, [engine]: (cause as Error).message })) }
    finally { if (localRequest.current === controller) { localRequest.current = null; setLocalBusy(null) } }
  }
  function cancelNative() { if (!localBusy) return; const engine = localBusy; localRequest.current?.abort(); localRequest.current = null; setLocalBusy(null); setLocalMessages(previous => ({ ...previous, [engine]: '连接已取消；原配置和登录凭据保留。' })) }
  return <div className="workbench-window-backdrop settings-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !dirty) onClose() }}>
    <section ref={panel} className="workbench-window settings-dialog" role="dialog" aria-modal="true" aria-label="工作台设置" tabIndex={-1}>
      <header className="workbench-window-heading"><div><span className="workbench-window-kicker">WORKBENCH SETTINGS</span><h2><Settings2 size={21}/>工作台设置</h2><p>连接、模型与画布偏好，集中在这里管理。</p></div><button type="button" aria-label="关闭工作台设置" onClick={onClose}><X size={18}/></button></header>
      <div className="settings-layout"><nav className="settings-navigation" aria-label="设置分类">{([{ id: 'connections', label: '本机连接', Icon: Plug }, { id: 'integrations', label: '外部助手', Icon: Blocks }, { id: 'api', label: '模型 API', Icon: KeyRound }, { id: 'sources', label: '资料来源', Icon: Globe2 }, { id: 'workspace', label: '工作区', Icon: SlidersHorizontal }] as const).map(item => <button type="button" key={item.id} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}><item.Icon size={17}/>{item.label}</button>)}<small>对话与搜索独立运行，连接设置共用。</small></nav>
        <div className="settings-content">
          {section === 'integrations' && <WorkbenchMcpSettings/>}
          {section === 'connections' && <><div className="settings-section-title"><div><h3>本机连接</h3><p>先按向导连接桌面共享；下方的 CLI 设置用于独立任务。</p></div></div>
            <DesktopConnectionGuide codex={native.codex} stage={sharing.stage} connected={sharing.connected} threadId={sharing.threadId} checking={checking} statusError={[connectionErrors.codex, sharing.error].filter(Boolean).join('；')} actionError={setupError} autoStatus={autoStatus} busy={setupBusy} onAutoConnect={() => { void autoConnect() }} onAction={action => { void runSetupAction(action) }} onRefresh={() => setRefresh(value => value + 1)} onOpenChat={onOpenDesktopChat}/>
            <section className="settings-connection-card" aria-label="模型搜索运行方式设置"><div className="settings-connection-title"><strong>模型搜索与建模</strong></div><label>运行方式<select aria-label="设置模型搜索运行方式" value={modelEngine} onChange={event => setModelEngine(event.target.value as AcquisitionEngine)}><option value="codex">Codex 本机登录</option><option value="cursor">Cursor 本机登录</option><option value="dsh-local">DSH 本机登录</option><option value="dsh-api">模型 API · DSH 工具循环</option></select></label><small>保存后用于所有项目的器件模型任务；当前任务记录会保留。</small></section>
            <div className="settings-section-title"><div><h3>独立任务连接</h3><p>这里的 CLI 只供临时电路与模型任务使用，不代表桌面共享已连接。</p></div><button type="button" disabled={checking || !!setupBusy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14}/>{checking ? '正在检测' : '刷新状态'}</button></div>
            {(['codex', 'cursor'] as const).map(engine => { const state = native[engine], name = engine === 'codex' ? 'Codex CLI' : 'Cursor CLI'; return <section className="settings-connection-card" key={engine} aria-label={`${name} 连接设置`}><div className="settings-connection-title"><strong>{name}</strong><span data-ready={!checking && state?.available || undefined}>{localBusy === engine ? '连接中' : checking ? '检测中' : connectionErrors[engine] ? '检测失败' : !state?.installed ? '未安装' : state.authenticated === false ? '未登录' : state.available ? 'CLI 已检测' : '不可用'}</span></div><p role="status">{connectionErrors[engine] || localMessages[engine] || (checking ? `正在读取 ${name} 状态…` : state?.message)}</p><div className="settings-native-actions"><button type="button" aria-label={`一键连接 ${name}`} disabled={!!localBusy || !!setupBusy} onClick={() => void connectNative(engine)}><Plug size={14}/>{localBusy === engine ? '连接中…' : '一键连接'}</button>{state?.installed && state.authenticated === false && <button type="button" aria-label={`网页登录 ${name}`} disabled={!!localBusy || !!setupBusy} onClick={() => void connectNative(engine, 'login')}>官方网页登录</button>}{localBusy === engine && <button type="button" onClick={cancelNative}>取消连接</button>}</div>{!checking && state && <dl><div><dt>安装</dt><dd>{state.installed ? state.version || '已安装' : '未检测到'}</dd></div><div><dt>授权</dt><dd>{state.authenticated === true ? '已登录' : state.authenticated === false ? '未登录' : '未确认'}</dd></div><div><dt>本机模型</dt><dd>{state.model || '由本机配置决定'}</dd></div></dl>}<label>工具任务模型（可选）<input aria-label={`${name} 工具任务模型`} value={nativeModels[engine]} maxLength={200} placeholder="留空使用本机配置" onChange={event => setNativeModels(previous => ({ ...previous, [engine]: event.target.value }))}/></label><small>用于临时电路与模型搜索任务；已有持久对话沿用该会话模型。</small>{!checking && state?.authenticated === false && <p>在本机终端运行 <code>{engine === 'codex' ? 'codex login' : 'agent login'}</code> 完成登录，再刷新状态。</p>}</section> })}
            <DshLocalSettings onConnected={() => { setModelEngine('dsh-local'); updateAssistantSettings({ modelEngine: 'dsh-local' }) }} selection={shared.dshSelection} onChange={dshSelection => updateAssistantSettings({ dshSelection })} onStatus={dshStatus => updateAssistantSettings({ dshStatus })}/><p className="settings-note">DSH 的供应商选择立即生效；本机登录凭据由 DSH 管理。</p></>}
          {section === 'api' && <><div className="settings-section-title"><div><h3>模型 API</h3><p>供电路对话与模型搜索中的 DSH API 模式使用。</p></div></div>
            <div className="settings-field-pair"><label>服务商<select aria-label="设置 API 服务商" value={api.preset} disabled={!!busy} onChange={event => preset(event.target.value as AiProviderId)}>{aiProviderPresets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>协议<select aria-label="设置 API 协议" value={api.protocol} disabled={!!busy} onChange={event => patchApi({ protocol: event.target.value as AssistantApiSettings['protocol'] })}><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option></select></label></div>
            <label>API 基础地址<input aria-label="设置 API 地址" type="url" value={api.endpoint} disabled={!!busy} onChange={event => patchApi({ endpoint: event.target.value, preset: 'custom' })}/></label>
            <label>API 密钥<span className="settings-secret"><input aria-label="设置 API 密钥" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} maxLength={4096} value={api.apiKey} disabled={!!busy} placeholder="本机无鉴权服务可留空" onChange={event => patchApi({ apiKey: event.target.value })}/><button type="button" aria-label={showKey ? '隐藏设置 API 密钥' : '显示设置 API 密钥'} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff size={16}/> : <Eye size={16}/>}</button></span></label><p className="settings-note">密钥仅保存在本次页面内存中；收起侧栏仍可用，刷新页面后需重新填写。</p>
            <div className="settings-section-title"><label>模型 ID<input aria-label="设置 API 模型 ID" value={api.model} maxLength={200} disabled={!!busy} onChange={event => patchApi({ model: event.target.value })}/></label><button type="button" disabled={!!busy || !urls} onClick={() => void checkApi('models')}><RefreshCw size={14}/>{busy === 'models' ? '获取中…' : '获取模型列表'}</button></div>
            {models.length > 0 && <label>服务返回的模型<select aria-label="设置 API 已发现模型" value={models.some(item => item.id === api.model) ? api.model : ''} onChange={event => { if (event.target.value) patchApi({ model: event.target.value }) }}><option value="">选择模型</option>{models.map(item => <option key={item.id}>{item.id}</option>)}</select></label>}
            {urls && <details className="settings-endpoints"><summary>实际请求地址</summary><code>{urls.models}</code><code>{api.protocol === 'responses' ? urls.responses : urls.chat}</code></details>}
            <div className="settings-test"><button type="button" disabled={!!busy || !urls} onClick={() => void checkApi('connect')}><Plug size={14}/>{busy === 'connect' ? '连接中…' : '一键连接 API'}</button><button type="button" disabled={!!busy || !urls || !api.model.trim()} onClick={() => void checkApi('test')}>{busy === 'test' ? '测试中…' : '测试模型推理'}</button>{busy && <button type="button" onClick={() => request.current?.abort()}>取消检查</button>}<small>测试发送固定短提示，可能产生 API 费用，不发送当前电路。</small></div></>}
          {section === 'sources' && <><div className="settings-section-title"><div><h3>资料来源</h3><p>管理半导小芯、立创、Google 和 AllDataSheet 等搜索站点的专用浏览器连接。连接状态只说明站点访问情况，搜索结果仍需核对器件型号和模型文件。</p></div></div><SiteSessionConnections/></>}
          {section === 'workspace' && <><div className="settings-section-title"><div><h3>工作区偏好</h3><p>按任务配置画布、显示与仿真。</p></div></div>
            <section className="settings-connection-card" aria-label="电路对话文件夹设置"><div className="settings-connection-title"><strong>Codex 电路对话文件夹</strong></div><label>文件夹绝对路径<input aria-label="设置 Codex 电路对话文件夹" value={conversationFolder} disabled={folderLoading || !!folderError || saving} maxLength={2048} placeholder={defaultConversationFolder || '正在读取默认工作目录…'} onChange={event => { setConversationFolder(event.target.value); setError(''); setStatus('') }}/></label><div className="settings-folder-actions"><button type="button" disabled={folderLoading || !!folderError || saving || !conversationFolder} onClick={() => setConversationFolder('')}>使用默认目录</button><small>默认：{defaultConversationFolder || '读取中'}</small></div><small>Codex 按工作目录归组对话。保存后，新建的电路绘制和解释对话使用此文件夹；已有项目对话及绑定保持原位置。请输入本机已有且可写的文件夹。</small>{folderError && <p className="settings-error" role="alert">{folderError} <button type="button" onClick={() => setFolderRefresh(value => value + 1)}>重试读取</button></p>}</section>
            <button className="settings-workspace-link" type="button" onClick={onOpenAppearance}><Palette size={21}/><span><strong>外观与画布</strong><small>界面风格、栅格间距、导线与器件颜色</small></span></button>{onOpenSimulation && <button className="settings-workspace-link" type="button" onClick={onOpenSimulation}><SlidersHorizontal size={21}/><span><strong>当前项目仿真配置</strong><small>添加或编辑 AC、瞬态、DC 与工作点配置</small></span></button>}<p className="settings-note">仿真配置保存在当前项目；外观和连接偏好在此浏览器中复用。</p></>}
          {error && <p className="settings-error" role="alert">{error}</p>}{status && <p className="settings-notice" role="status">{status}</p>}
        </div></div>
      <footer className="workbench-window-footer"><span>{dirty ? '有未保存的设置' : '设置仅在本机工作台中使用'}</span><div><button type="button" onClick={onClose}>{dirty ? '取消' : '完成'}</button><button type="button" className="primary" disabled={!dirty || !!busy || saving} onClick={() => void save()}><Check size={15}/>{saving ? '保存中…' : '保存设置'}</button></div></footer>
    </section>
  </div>
}
