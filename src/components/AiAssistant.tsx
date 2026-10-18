import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Bot, Check, Eye, EyeOff, RefreshCw, Send, Square, X, MessageSquarePlus, Undo2, Settings2 } from 'lucide-react'
import { formatSI, type Project } from '../core/circuit'
import { aiProjectFingerprint, aiConversationContext, appendAiConversation, parseAiProposal, providerUrl, requestAi, type AiMode, type AiProposal, type AiProvider, type AiConversationMessage } from '../core/ai'
import { aiProviderPresets, inferProviderId, listAiModels, providerUrls, testAiConnection, type AiModelInfo, type AiProviderId, type AiProtocol } from '../core/ai-provider'
import { requestAgent, type AgentProgressEvent, type AgentResult, type AgentSimulation, type AgentToolEvent } from '../core/agent-client'
import { getCodexStatus, requestCodexAgent } from '../core/codex-client'
import { CODEX_CLIENT_TIMEOUT_MS } from '../core/agent-timeouts'
import type { AgentTaskStatus } from '../core/agent-progress'
import { getCursorStatus, requestCursorAgent } from '../core/cursor-client'
import CursorLocalAssistant from './CursorLocalAssistant'
import { requestDshLocalAgent } from '../core/dsh-local-client'
import type { DshLocalSelection, DshLocalStatus } from '../core/dsh-local'
import AssistantMarkdown from './AssistantMarkdown'
import AgentProposalPreview from './AgentProposalPreview'
import AgentTaskProgress from './AgentTaskProgress'
import DshLocalSettings from './DshLocalSettings'
import DesktopControlAssistant from './DesktopControlAssistant'
import type { DesktopCircuitConnection } from '../core/desktop-circuit-client'
import type { AgentModelAcquisition } from '../core/agent-models'
import type { AssistantExternalTask } from '../core/model-search-task'
import { refreshSharedDshStatus, updateAssistantSettings, useAssistantSettings } from '../core/assistant-settings'
import { candidateWithWaveformSetup } from '../core/candidate-waveform-setup'
import { resolveCandidateProject } from '../core/candidate-resolution'

const STORAGE = 'fuxian.ai-provider.v1'
type ProviderSettings = AiProvider & { preset: AiProviderId }
type AssistantMode = AiMode | 'agent'
type AssistantEngine = 'codex' | 'cursor' | 'dsh'
type DshConnection = 'api' | 'local'
type CodexStatus = Awaited<ReturnType<typeof getCodexStatus>>
interface AgentRunView {id:number;prompt:string;source:AssistantEngine;dshConnection?:DshConnection;baseline:Project;status:AgentTaskStatus;steps:AgentToolEvent[];startedAt:number;finishedAt?:number;engine?:string;version?:string;result?:AgentResult;error?:string;everApplied?:boolean;discarded?:boolean;proposalOnly?:boolean;lastApply?:{before:Project;after:Project}}
type CandidateState='applied'|'ready'|'mergeable'|'already-present'|'conflict'|'discarded'
function candidateState(run:AgentRunView,project:Project):CandidateState {
  if(run.discarded)return'discarded'
  if(!run.result)return'conflict'
  return resolveCandidateProject(run.baseline,run.result.proposal.project,project,run.lastApply?aiProjectFingerprint(run.lastApply.after):undefined).status
}
function candidateLabel(run:AgentRunView,state:CandidateState){
  return state==='discarded'?'候选方案已丢弃，任务记录保留。':state==='applied'?'候选方案已应用，当前画布与此方案一致。':state==='mergeable'?'后续编辑可与此方案合并；应用前请查看合并预览。':state==='already-present'?'方案中的修改已在当前画布，无需重复应用。':state==='conflict'?'方案与后续编辑存在冲突；请预览并选择保留其他改动或恢复方案起点。':run.everApplied?'画布可再次应用此方案。':'候选电路已生成，等待你审阅后应用。'
}
const toolNames:Record<string,string>={configure_waveforms:'配置波形图',set_measurement_probes:'放置测量探针', inspect_circuit:'读取当前电路',set_component_value:'调整器件参数',replace_candidate:'更新候选电路',validate_circuit:'检查电气连接',simulate_circuit:'运行 ngspice',search_spice_models:'搜索器件模型',download_spice_model:'下载模型源码',import_spice_model:'导入候选模型'}
function simulationSummary(result:AgentSimulation){
  const measured=result.analysis==='noise'
    ?`输出噪声密度 ${formatSI(result.output.minimum,'V/√Hz')}～${formatSI(result.output.maximum,'V/√Hz')}${result.noise?`，输入等效噪声密度 ${formatSI(result.noise.input.minimum,`${result.noise.inputUnit}/√Hz`)}～${formatSI(result.noise.input.maximum,`${result.noise.inputUnit}/√Hz`)}`:''}`
    :result.analysis==='ac'
    ?`幅频 / 相频响应${result.peakDb!=null?`，峰值增益 ${Number(result.peakDb.toFixed(2))} dB${result.peakFrequencyHz!=null?`，对应频率 ${formatSI(result.peakFrequencyHz,'Hz')}`:''}`:'，未返回峰值增益'}`
    :`输出 ${formatSI(result.output.minimum,'V')}～${formatSI(result.output.maximum,'V')}，末值 ${formatSI(result.output.last,'V')}`
  return `${result.analysis.toUpperCase()} · ${result.points} 个采样点；${measured}${result.stale?'。此后候选电路已修改，需重新仿真。':''}`
}
function AgentRunCard({run,latest,onConfigure,onRetry,project,busy,onReview,onApply,onUndo}:{run:AgentRunView;latest:boolean;onConfigure:()=>void;onRetry:()=>void;project:Project;busy:boolean;onReview:()=>void;onApply:()=>void;onUndo:()=>void}){
  const result=run.result,simulation=result?.simulation
  const state=candidateState(run,project)
  return <details className={`agent-run agent-run-${run.status}`} open={latest}>
    <summary><span className="agent-run-indicator" aria-hidden="true"/><span>{run.proposalOnly?'修改方案已生成':run.status==='running'?'任务执行中':run.status==='done'?'任务已完成':run.status==='interrupted'?'方案已保留 · 最终说明超时':run.status==='stopped'?'任务已停止':'任务未完成'}</span><small>{run.proposalOnly?'模型 API':`${run.steps.length} 个工具步骤`}</small></summary>
    <div className="agent-run-content">
      <p className="agent-run-prompt">{run.prompt}</p>
      {run.engine&&<p className="agent-run-engine">{run.engine} · {run.version}</p>}
      {run.status!=='running'&&<AgentTaskProgress status={run.status} steps={run.steps} startedAt={run.startedAt} finishedAt={run.finishedAt}/>}
      <ol className="agent-steps" aria-label="Agent 执行步骤" aria-live="polite">{run.steps.map((step,index)=><li key={index} data-status={step.status}><span className="agent-step-index">{index+1}</span><div><strong>{toolNames[step.name]??step.name}</strong><small>{step.status==='completed'?'已完成':step.status==='error'?'失败':run.status==='running'?'执行中…':'已中止'}</small><p>{step.detail}</p></div></li>)}</ol>
      {run.status==='running'&&!run.steps.length&&<p className="agent-waiting">正在规划任务并准备调用电路工具…</p>}
      {run.error&&<div className="agent-failure" role={run.status==='error'?'alert':'status'}><p className="ai-error">{run.error}</p>{run.status==='error'&&<><small>{run.steps.length?'候选修改未应用。已执行步骤保留在上方。':'尚未执行电路工具，画布没有被修改。'}</small><button type="button" disabled={busy} onClick={run.steps.length?onRetry:onConfigure}>{run.steps.length?'编辑任务后重试':run.source==='dsh'?'检查模型配置':`检查 ${run.source==='cursor'?'Cursor':'Codex'} 连接`}</button></>}</div>}
      {result&&<>
        <AssistantMarkdown className="agent-result-summary">{result.summary}</AssistantMarkdown>
        {simulation?<section className="agent-simulation" aria-label="Agent 仿真结果">
          <h4>{simulation.engine} · {simulation.analysis.toUpperCase()} 仿真记录</h4>
          <p className="agent-simulation-meta">{simulation.points} 个采样点 · {(simulation.elapsedMs/1000).toFixed(2)} 秒</p>
          {!!simulation.sweepRuns?.length&&<details className="agent-samples"><summary>参数扫描 · {simulation.sweepRuns.length} 次（下方采样为首个取值）</summary><table><thead><tr><th>扫描取值</th><th>温度</th><th>输出范围</th></tr></thead><tbody>{simulation.sweepRuns.map((leaf,index)=><tr key={index}><td>{leaf.label}</td><td>{leaf.temperature} °C</td><td>{formatSI(leaf.output.minimum,simulation.outputUnit??'V')}～{formatSI(leaf.output.maximum,simulation.outputUnit??'V')}</td></tr>)}</tbody></table></details>}
          {simulation.stale&&<p className="agent-stale" role="status">仿真后候选电路又有修改。以下数据对应此前版本，最终方案仍需重新仿真。</p>}
          <dl className="agent-measurements">{simulation.analysis==='noise'&&simulation.noise&&<><div><dt>输出噪声密度</dt><dd>{formatSI(simulation.output.minimum,'V/√Hz')}～{formatSI(simulation.output.maximum,'V/√Hz')}</dd></div><div><dt>输入等效噪声密度</dt><dd>{formatSI(simulation.noise.input.minimum,`${simulation.noise.inputUnit}/√Hz`)}～{formatSI(simulation.noise.input.maximum,`${simulation.noise.inputUnit}/√Hz`)}</dd></div>{simulation.noise.totalOutput!==undefined&&<div><dt>积分输出噪声 RMS</dt><dd>{formatSI(simulation.noise.totalOutput,'V')}</dd></div>}{simulation.noise.totalInput!==undefined&&<div><dt>积分输入噪声 RMS</dt><dd>{formatSI(simulation.noise.totalInput,simulation.noise.inputUnit)}</dd></div>}</>}{simulation.analysis!=='ac'&&simulation.analysis!=='noise'&&<><div><dt>输出最小值</dt><dd>{formatSI(simulation.output.minimum,'V')}</dd></div><div><dt>输出最大值</dt><dd>{formatSI(simulation.output.maximum,'V')}</dd></div><div><dt>输出末值</dt><dd>{formatSI(simulation.output.last,'V')}</dd></div></>}{simulation.analysis==='ac'&&<><div><dt>峰值增益</dt><dd>{simulation.peakDb!=null?`${Number(simulation.peakDb.toFixed(2))} dB`:'—'}</dd></div><div><dt>峰值频率</dt><dd>{simulation.peakFrequencyHz!=null?formatSI(simulation.peakFrequencyHz,'Hz'):'—'}</dd></div></>}</dl>
          {simulation.warnings.length>0&&<ul className="agent-simulation-warnings">{simulation.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>}
          {simulation.samples.length>0&&<details className="agent-samples"><summary>{simulation.analysis==='ac'?'查看幅频 / 相频采样':simulation.analysis==='noise'?'查看噪声密度采样':'查看采样数据'}（{simulation.samples.length} 点）</summary><div><table><thead><tr><th>{simulation.analysis==='ac'||simulation.analysis==='noise'?'频率 / Hz':simulation.analysis==='tran'?'时间 / s':simulation.analysis==='dc'?'扫描 / V':'点'}</th>{simulation.analysis==='noise'?<><th>输出噪声 / V/√Hz</th><th>输入等效噪声 / {simulation.noise?.inputUnit}/√Hz</th></>:simulation.analysis==='ac'?<><th>增益 / dB</th><th>相位 / °</th></>:<><th>Vin / V</th><th>Vout / V</th><th>I / A</th></>}</tr></thead><tbody>{simulation.samples.map((sample,index)=><tr key={index}><td>{Number(sample.x.toPrecision(5))}</td>{simulation.analysis==='noise'?<><td>{sample.outputNoise==null?'—':Number(sample.outputNoise.toPrecision(5))}</td><td>{sample.inputNoise==null?'—':Number(sample.inputNoise.toPrecision(5))}</td></>:simulation.analysis==='ac'?<><td>{sample.gainDb!=null?Number(sample.gainDb.toPrecision(5)):'—'}</td><td>{sample.phaseDeg!=null?Number(sample.phaseDeg.toPrecision(5)):'—'}</td></>:<><td>{sample.vin==null?'—':Number(sample.vin.toPrecision(5))}</td><td>{sample.vout==null?'—':Number(sample.vout.toPrecision(5))}</td><td>{sample.current==null?'—':Number(sample.current.toPrecision(5))}</td></>}</tr>)}</tbody></table></div></details>}
        </section>:<p className="agent-no-simulation">本次任务未返回仿真结果，不能据此确认电路性能。</p>}
        <p className="agent-candidate-state" data-candidate-state={state}>{result.changed?candidateLabel(run,state):'本次任务没有生成电路修改。'}</p>
        {result.changed&&!run.discarded&&<div className="ai-actions" aria-label={`任务 ${run.id} 方案操作`}>
          <button type="button" onClick={onReview} disabled={busy}>查看方案</button>
          <button type="button" onClick={onApply} disabled={busy||state!=='ready'&&state!=='mergeable'&&state!=='conflict'}>{state==='applied'?'当前已应用':state==='mergeable'?'合并方案':state==='conflict'?'处理冲突':run.everApplied?'再次应用':'应用此方案'}</button>
          <button type="button" onClick={onUndo} disabled={busy||state!=='applied'}><Undo2 size={14}/>撤销此方案</button>
        </div>}
      </>}
    </div>
  </details>
}
function savedProvider(): ProviderSettings {
  const fallback: ProviderSettings = { endpoint: 'https://api.openai.com/v1', model: '', apiKey: '', preset: 'openai', protocol: 'chat-completions' }
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE) ?? 'null')
    return raw && typeof raw.endpoint === 'string' && typeof raw.model === 'string' ? { endpoint: raw.endpoint, model: raw.model, apiKey: '', protocol: raw.protocol === 'responses' ? 'responses' : 'chat-completions', preset: aiProviderPresets.some(item => item.id === raw.preset) ? raw.preset : inferProviderId(raw.endpoint) } : fallback
  } catch { return fallback }
}

interface AiAssistantProps {
  project: Project; projectId?: string; desktopCircuit?: DesktopCircuitConnection
  onModelAcquisitions?: (items: AgentModelAcquisition[]) => void; onOpenModels?: () => void; onOpenSettings?: () => void
  externalTask?: AssistantExternalTask; onExternalTaskConsumed?: (id: string) => void
  onApply: (project: Project, options?: { undo?: boolean; replace?: boolean }) => Project | void; onClose: () => void; embedded?: boolean
}

export default function AiAssistant(props: AiAssistantProps) {
  return props.projectId ? <ProjectDesktopAssistant key={props.projectId} {...props} projectId={props.projectId}/> : <StandaloneAiAssistant {...props}/>
}

function ProjectDesktopAssistant(props: AiAssistantProps & { projectId: string }) {
  const { project, projectId, desktopCircuit, onModelAcquisitions, externalTask, onExternalTaskConsumed, onApply, onClose, embedded = false } = props
  const [engine, setEngine] = useState<AssistantEngine>(() => {
    try { const saved = localStorage.getItem(`fuxian.project-assistant-engine.v1:${encodeURIComponent(projectId)}`); return saved === 'cursor' || saved === 'dsh' ? saved : 'codex' } catch { return 'codex' }
  }), [cursorBusy, setCursorBusy] = useState(false)
  useEffect(() => { try { localStorage.setItem(`fuxian.project-assistant-engine.v1:${encodeURIComponent(projectId)}`, engine) } catch { /* Choice remains in memory. */ } }, [projectId, engine])
  if (engine === 'dsh') return <StandaloneAiAssistant {...props} initialEngine="dsh" onProjectEngineChange={setEngine}/>
  return <aside className={`ai-assistant ai-assistant-persistent ai-assistant-desktop${embedded ? ' ai-assistant-embedded' : ''}`} aria-label="AI 电路助手">
    <header className="ai-header"><div><Bot size={20}/><strong>{engine === 'cursor' ? 'Cursor 项目对话' : 'Codex 电路绘制'}</strong></div><button type="button" aria-label="关闭 AI 助手" onClick={onClose}><X size={18}/></button></header>
    <label className="ai-engine-selector">助手<select aria-label="AI 运行方式" value={engine} disabled={cursorBusy} onChange={event => setEngine(event.target.value as AssistantEngine)}><option value="codex">Codex · 桌面项目对话</option><option value="cursor">Cursor · 持续项目对话</option><option value="dsh">DSH · 本机 / API</option></select></label>
    <div className="desktop-control-panel">{engine === 'cursor' ? <CursorLocalAssistant key={projectId} projectId={projectId} project={project} onApply={onApply} onBusyChange={setCursorBusy} externalTask={externalTask} onExternalTaskConsumed={onExternalTaskConsumed} onModelAcquisitions={onModelAcquisitions}/> : <DesktopControlAssistant projectId={projectId} project={project} circuit={desktopCircuit} onApply={onApply} externalTask={externalTask} onExternalTaskConsumed={onExternalTaskConsumed} onModelAcquisitions={onModelAcquisitions}/>}</div>
  </aside>
}

function StandaloneAiAssistant({ project, projectId, onModelAcquisitions, onOpenModels, onOpenSettings, externalTask, onExternalTaskConsumed, onApply, onClose, embedded = false, initialEngine = 'codex', onProjectEngineChange }: AiAssistantProps & { initialEngine?: AssistantEngine; onProjectEngineChange?: (engine: AssistantEngine) => void }) {
  const sharedSettings = useAssistantSettings()
  const [engine, setEngine] = useState<AssistantEngine>(initialEngine)
  const [dshConnection,setDshConnection] = useState<DshConnection>('api')
  const [localDshSelection,setDshSelection] = useState<DshLocalSelection|null>(null)
  const [localDshStatus,setDshStatus] = useState<DshLocalStatus|null>(null)
  const dshSelection = onOpenSettings ? sharedSettings.dshSelection : localDshSelection
  const dshStatus = onOpenSettings ? sharedSettings.dshStatus : localDshStatus
  const dshPanel = useRef<HTMLDivElement|null>(null)
  const dshLocalReady = !!dshStatus?.available&&!!dshSelection?.model&&!!dshStatus.providers.find(item=>item.id===dshSelection.provider&&item.configured)
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null)
  const [codexChecking, setCodexChecking] = useState(true)
  const [codexError, setCodexError] = useState('')
  const [nativeModels, setNativeModels] = useState({ codex: '', cursor: '' })
  const nativeName = engine === 'cursor' ? 'Cursor' : 'Codex'
  const codexModel = (onOpenSettings ? sharedSettings.nativeModels : nativeModels)[engine === 'cursor' ? 'cursor' : 'codex']
  const setCodexModel = (value: string) => setNativeModels(previous => ({ ...previous, [engine === 'cursor' ? 'cursor' : 'codex']: value }))
  const codexPending = useRef<AbortController | null>(null)
  const codexPanel = useRef<HTMLElement | null>(null)
  const [localProvider, setProvider] = useState(savedProvider)
  const provider = onOpenSettings ? sharedSettings.api : localProvider
  const [settingsOpen, setSettingsOpen] = useState(() => !savedProvider().model)
  const [configTarget,setConfigTarget] = useState<'native'|'dsh-local'|'dsh-api'|null>(null)
  const [mode, setMode] = useState<AssistantMode>('agent')
  const [prompt, setPrompt] = useState('')
  const promptInput = useRef<HTMLTextAreaElement | null>(null)
  const [history, setHistory] = useState<AiConversationMessage[]>([])
  const updateDshSelection=useCallback((selection:DshLocalSelection|null)=>{if(onOpenSettings) updateAssistantSettings({ dshSelection: selection }); else setDshSelection(selection);setHistory([])},[onOpenSettings])
  const [agentRuns,setAgentRuns] = useState<AgentRunView[]>([])
  useEffect(()=>{const items=agentRuns.flatMap(run=>run.result?.modelAcquisitions??[]);if(items.length)onModelAcquisitions?.(items)},[agentRuns,onModelAcquisitions])
  const [proposalAgentId,setProposalAgentId] = useState<number|null>(null)
  const [conflictChoice,setConflictChoice] = useState<{runId:number;mode:'merge'|'replace';canvas:string;proposal:string}|null>(null)
  const runSequence=useRef(0)
  const [proposal, setProposal] = useState<AiProposal | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [modelList, setModelList] = useState<AiModelInfo[]>([])
  const [configBusy, setConfigBusy] = useState<'models' | 'test' | null>(null)
  const [configStatus, setConfigStatus] = useState('')
  const [configError, setConfigError] = useState('')
  const locked = busy || !!configBusy
  const preset = aiProviderPresets.find(item => item.id === provider.preset)!
  let urls: ReturnType<typeof providerUrls> | undefined
  let urlError = ''
  try { urls = providerUrls(provider.endpoint) } catch (reason) { urlError = (reason as Error).message }
  const pending = useRef<AbortController | null>(null)
  const settingsPanel = useRef<HTMLDetailsElement | null>(null)
  const current = useRef(project); current.current = project
  const selectedRun=agentRuns.find(run=>run.id===proposalAgentId)
  const selectedState=selectedRun?candidateState(selectedRun,project):null
  const selectedResolution=selectedRun?.result?resolveCandidateProject(selectedRun.baseline,selectedRun.result.proposal.project,project,selectedRun.lastApply?aiProjectFingerprint(selectedRun.lastApply.after):undefined):null
  const choice=selectedRun?.result&&selectedState==='conflict'&&conflictChoice?.runId===selectedRun.id&&conflictChoice.canvas===aiProjectFingerprint(project)&&conflictChoice.proposal===aiProjectFingerprint(selectedRun.result.proposal.project)?conflictChoice:null
  const choiceMerge=choice?.mode==='merge'&&selectedRun?.result?resolveCandidateProject(selectedRun.baseline,selectedRun.result.proposal.project,project,undefined,'prefer-candidate'):null
  const choiceProject=choice?.mode==='replace'&&selectedRun?.result?candidateWithWaveformSetup(selectedRun.baseline,selectedRun.result.proposal.project):choiceMerge?.project
  const stale=selectedState==='conflict'
  useEffect(()=>{
    if(!configTarget)return
    const panel=configTarget==='native'?codexPanel.current:configTarget==='dsh-local'?dshPanel.current:settingsPanel.current
    if(panel){panel.scrollIntoView?.({block:'start',behavior:'smooth'});setConfigTarget(null)}
  },[configTarget,engine,dshConnection])
  useEffect(() => () => { pending.current?.abort(); pending.current = null }, [])
  useEffect(() => {
    if (engine === 'cursor' || engine === 'codex' && !projectId) void refreshCodex()
    return () => { codexPending.current?.abort(); codexPending.current = null }
  }, [engine, projectId])
  useEffect(() => {
    if (onOpenSettings) return
    try {
      // Do not persist an accidentally pasted URL containing credentials or query tokens.
      providerUrl(provider.endpoint)
      localStorage.setItem(STORAGE, JSON.stringify({ endpoint: provider.endpoint.trim(), model: provider.model, preset: provider.preset, protocol: provider.protocol }))
    } catch { /* Invalid URLs and disabled browser storage are left unsaved. */ }
  }, [provider.endpoint, provider.model, provider.preset, provider.protocol, onOpenSettings])
  useEffect(() => {
    if (!onOpenSettings || engine !== 'dsh' || dshConnection !== 'local') return
    const controller = new AbortController()
    void refreshSharedDshStatus(controller.signal).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
    return () => controller.abort()
  }, [engine, dshConnection, !!onOpenSettings])

  async function refreshCodex() {
    codexPending.current?.abort()
    const controller = new AbortController()
    codexPending.current = controller
    setCodexChecking(true); setCodexError('')
    try {
      const status = await (engine==='cursor'?getCursorStatus:getCodexStatus)(controller.signal)
      if (!controller.signal.aborted) setCodexStatus(status)
    } catch (reason) {
      if (!controller.signal.aborted) { setCodexStatus(null); setCodexError((reason as Error).message || `无法连接本机 ${nativeName}，请检查工作台服务`) }
    } finally {
      if (codexPending.current === controller) { codexPending.current = null; setCodexChecking(false) }
    }
  }

  function chooseEngine(next: AssistantEngine) {
    if (locked || next === engine) return
    if (!['codex','cursor','dsh'].includes(next)) return
    if (onProjectEngineChange) { onProjectEngineChange(next); return }
    setEngine(next); setMode('agent'); setHistory([]); setError(''); setCodexStatus(null); setCodexError(''); setCodexChecking(next!=='dsh')
    setNotice('已切换助手，输入和候选方案已保留；后续使用新的对话上下文。')
  }

  function chooseDshConnection(next:DshConnection) {
    if(locked||next===dshConnection)return
    setDshConnection(next);setMode('agent');setHistory([]);setError('')
    setNotice('已切换 DSH 连接方式，输入和候选方案已保留。')
  }

  function updateProvider(next: Partial<ProviderSettings>) {
    setProvider(previous => ({ ...previous, ...next }))
    setConfigStatus(''); setConfigError(''); setError('')
    if ('endpoint' in next || 'apiKey' in next) setModelList([])
    if ('endpoint' in next || 'model' in next || 'protocol' in next || 'apiKey' in next) { setHistory([]); setNotice('') }
  }

  function choosePreset(id: AiProviderId) {
    const next = aiProviderPresets.find(item => item.id === id)!
    updateProvider({ preset: id, endpoint: next.endpoint || provider.endpoint, model: '', apiKey: '', protocol: next.protocol ?? 'chat-completions' })
    setShowKey(false)
  }

  async function checkProvider(action: 'models' | 'test') {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setConfigBusy(action); setConfigStatus(''); setConfigError('')
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 65_000)
    try {
      if (action === 'models') {
        const result = await listAiModels(provider, controller.signal)
        if (controller.signal.aborted) return
        setModelList(result.models)
        setConfigStatus(`已获取 ${result.models.length} 个模型${result.truncated ? '（仅显示前 1000 个）' : ''}。列表访问成功；尚未验证所选模型能否推理。`)
      } else {
        const result = await testAiConnection(provider, controller.signal)
        if (controller.signal.aborted) return
        setConfigStatus(`推理测试成功 · ${result.model} · ${(result.elapsedMs / 1000).toFixed(1)} 秒。服务已返回文本；Agent 工具调用尚未验证。`)
      }
    } catch (reason) {
      if (timedOut) setConfigError('等待模型服务超时，请检查服务状态后重试')
      else if (controller.signal.aborted) setConfigStatus('配置检查已取消')
      else setConfigError((reason as Error).message || '模型配置检查失败')
    } finally {
      clearTimeout(timer)
      if (pending.current === controller) { pending.current = null; setConfigBusy(null) }
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    return execute(prompt,mode)
  }
  async function execute(prompt:string,mode:AssistantMode,taskId?:string) {
    if (pending.current || !prompt.trim()) return
    if (engine !== 'dsh' && (codexChecking || !codexStatus?.available || codexStatus.authenticated === false)) return
    if (engine === 'dsh' && dshConnection === 'local' && !dshLocalReady) return
    const snapshot = structuredClone(current.current), controller = new AbortController()
    pending.current = controller
    if(taskId){consumedTask.current=taskId;onExternalTaskConsumed?.(taskId)}
    setBusy(true); setError(''); setProposal(null); setProposalAgentId(null); setNotice('')
    const candidateId=++runSequence.current,runId=mode==='agent'?candidateId:null,startedAt=Date.now()
    setAgentRuns(previous=>{
      return runId!==null?[...previous,{id:runId,prompt,source:engine,dshConnection,baseline:snapshot,status:'running',steps:[],startedAt} as AgentRunView].slice(-6):previous
    })
    const updateRun=(update:(run:AgentRunView)=>AgentRunView)=>setAgentRuns(previous=>previous.map(run=>run.id===runId?update(run):run))
    function progress(event:AgentProgressEvent){
      if(controller.signal.aborted)return
      updateRun(run=>{
        if(event.type==='started')return{...run,engine:event.engine,version:event.version}
        const steps=[...run.steps]
        let index=steps.length-1
        while(index>=0&&(steps[index].name!==event.name||steps[index].status!=='running'))index--
        if(event.status!=='running'&&index>=0)steps[index]=event
        else steps.push(event)
        return{...run,steps}
      })
    }
    let timedOut = false
    const requestTimeout=mode==='agent'?(engine==='codex'?CODEX_CLIENT_TIMEOUT_MS:125_000):65_000
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, requestTimeout)
    try {
      if(mode==='agent'){
        const result=engine!=='dsh'
          ?await (engine==='cursor'?requestCursorAgent:requestCodexAgent)({prompt,project:snapshot,history:aiConversationContext(history),...(codexModel.trim()?{model:codexModel.trim()}:{})},progress,controller.signal)
          :dshConnection==='local'
            ?await requestDshLocalAgent({...dshSelection!,prompt,project:snapshot,history:aiConversationContext(history)},progress,controller.signal)
            :await requestAgent({...provider,prompt,project:snapshot,history:aiConversationContext(history)},progress,controller.signal)
        controller.signal.throwIfAborted()
        updateRun(run=>({...run,status:result.interruption?'interrupted':'done',result,finishedAt:Date.now()}))
        if(result.changed){setProposal(result.proposal);setProposalAgentId(runId)}
        const record=`${result.interruption?'任务未完整结束：最终说明超时；已保留已仿真的候选电路。\n':''}${result.summary}\n${result.changed?'候选电路尚未应用。':'本次没有修改电路。'}\n${result.simulation?`实际仿真记录：${simulationSummary(result.simulation)}`:'本次未返回仿真结果。'}`
        setHistory(previous=>appendAiConversation(previous,prompt,record))
        return
      }
      const text = await requestAi({ ...provider, mode, prompt, project: snapshot, history: aiConversationContext(history) }, controller.signal)
      controller.signal.throwIfAborted()
      if (mode === 'propose') {
        const next = parseAiProposal(text, snapshot)
        setAgentRuns(previous=>[...previous,{id:candidateId,prompt,source:engine,baseline:snapshot,status:'done',steps:[],startedAt,finishedAt:Date.now(),proposalOnly:true,result:{summary:next.summary,proposal:next,changed:aiProjectFingerprint(next.project)!==aiProjectFingerprint(snapshot),simulation:null}} as AgentRunView].slice(-6))
        setProposal(next);setProposalAgentId(candidateId)
        setHistory(previous => appendAiConversation(previous, prompt, `待审阅修改方案：${next.summary}`))
      } else setHistory(previous => appendAiConversation(previous, prompt, text))
    } catch (reason) {
      const message=timedOut?(mode==='agent'?`等待 ${engine==='codex'?'Codex':engine==='cursor'?'Cursor':'DSH'} 任务结果超过 ${requestTimeout/1000} 秒，未收到可验证的完整结果。执行已停止，候选修改未应用。`:'等待模型超时，请检查模型服务后重试'):controller.signal.aborted?(mode==='agent'?'任务已停止，候选修改未应用。':'请求已取消'):(reason as Error).message||'AI 请求失败'
      if(runId!==null)updateRun(run=>({...run,status:controller.signal.aborted&&!timedOut?'stopped':'error',error:message,finishedAt:Date.now()}))
      // Agent failures belong to their task record; avoid repeating the same error above it.
      if(runId===null){if(controller.signal.aborted&&!timedOut)setNotice(message);else setError(message)}
    } finally {
      clearTimeout(timer)
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }

  const consumedTask=useRef('')
  useEffect(()=>{
    if(!externalTask||consumedTask.current===externalTask.id||engine==='codex'&&projectId||locked)return
    const ready=engine==='dsh'?(dshConnection==='local'?dshLocalReady:!!urls&&!!provider.model.trim()):!codexChecking&&!!codexStatus?.available&&codexStatus.authenticated!==false
    if(!ready)return
    void execute(externalTask.prompt,'agent',externalTask.id)
  },[externalTask,engine,projectId,locked,codexChecking,codexStatus,dshConnection,dshLocalReady,provider.model,provider.endpoint,onExternalTaskConsumed])

  function review(run:AgentRunView){
    if(!run.result||run.discarded||busy)return
    setProposal(run.result.proposal);setProposalAgentId(run.id);setError('');setNotice('')
  }
  function restoreRunConnection(run:AgentRunView) {
    if(engine!==run.source)chooseEngine(run.source)
    if(run.source==='dsh')chooseDshConnection(run.dshConnection??'api')
  }
  function retry(run:AgentRunView) {
    if(locked)return
    restoreRunConnection(run);setPrompt(run.prompt)
    setNotice('已恢复任务描述，请根据上方具体错误修改后再开始。')
    promptInput.current?.focus();promptInput.current?.scrollIntoView?.({block:'center',behavior:'smooth'})
  }
  function configureRun(run:AgentRunView) {
    if (onOpenSettings) { onOpenSettings(); return }
    if(locked)return
    restoreRunConnection(run)
    if(run.source!=='dsh') {
      if(engine===run.source)void refreshCodex()
      setConfigTarget('native')
    } else if(run.dshConnection==='local')setConfigTarget('dsh-local')
    else {setSettingsOpen(true);setConfigTarget('dsh-api')}
  }
  function apply(run=selectedRun,conflictMode?:'merge'|'replace') {
    if (!run?.result||run.discarded||busy) return
    const before=structuredClone(current.current)
    const resolution=resolveCandidateProject(run.baseline,run.result.proposal.project,before,run.lastApply?aiProjectFingerprint(run.lastApply.after):undefined)
    const state=resolution.status
    if(state==='applied'){setNotice('当前电路已是此方案，无需重复应用。');return}
    if(state==='already-present'){setNotice('方案中的修改已经在当前画布，无需重复应用。');return}
    if(state==='conflict'&&!conflictMode){setProposal(run.result.proposal);setProposalAgentId(run.id);setNotice('请选择冲突处理方式，查看应用后的预览，再确认。');return}
    if(conflictMode&&(state!=='conflict'||!choice||choice.runId!==run.id||choice.mode!==conflictMode||choice.canvas!==aiProjectFingerprint(before)||choice.proposal!==aiProjectFingerprint(run.result.proposal.project))){setConflictChoice(null);setError('画布或方案发生变化，请重新选择并查看预览。');return}
    const forced=conflictMode==='merge'?resolveCandidateProject(run.baseline,run.result.proposal.project,before,undefined,'prefer-candidate'):null
    if(forced&&(!forced.project||forced.status!=='mergeable')){setError('合并后项目无法通过校验，请检查方案或选择恢复起点。');return}
    if(state!=='ready'&&state!=='mergeable'&&state!=='conflict')return
    const next=structuredClone(conflictMode==='merge'?forced!.project!:conflictMode==='replace'?candidateWithWaveformSetup(run.baseline,run.result.proposal.project):resolution.project!)
    let applied:Project
    try{applied=onApply(next,{replace:conflictMode==='replace'})??next}catch(reason){setError(`未应用方案：${(reason as Error).message}`);setNotice('');return}
    current.current=applied
    setProposal(run.result.proposal);setProposalAgentId(run.id);setError('')
    setAgentRuns(previous=>previous.map(item=>item.id===run.id?{...item,everApplied:true,lastApply:{before,after:structuredClone(applied)}}:item))
    setConflictChoice(null)
    setNotice(conflictMode==='replace'?'已恢复方案起点并应用；应用前的完整画布可撤销恢复。':conflictMode==='merge'?'冲突字段采用方案值，其余手动编辑保留；可撤销恢复应用前画布。':state==='mergeable'?'方案已与后续编辑合并；可撤销恢复应用前画布。':'候选电路已应用；方案保留，可撤销后再次应用。')
  }
  function undoApplication(run=selectedRun){
    if(!run?.result||!run.result.changed||run.discarded||busy)return
    const state=candidateState(run,current.current)
    if(state==='ready'){setNotice('当前电路已经恢复原始版本。');return}
    if(state!=='applied'){setError('方案应用后画布又有编辑；请先撤销后续改动，避免覆盖。');return}
    const baseline=structuredClone(run.lastApply?.before??run.baseline)
    let restored:Project
    try{restored=onApply(baseline,{undo:true})??baseline}catch(reason){setError(`未撤销方案：${(reason as Error).message}`);setNotice('');return}
    current.current=restored
    setProposal(run.result.proposal);setProposalAgentId(run.id);setError('');setNotice('已撤销此方案，恢复生成前的电路；可以再次应用，也可通过画布撤销恢复刚才的方案。')
  }

  return <aside className={`ai-assistant${embedded ? ' ai-assistant-embedded' : ''}`} aria-label="AI 电路助手">
    <header className="ai-header"><div><Bot size={20} /><strong>{engine!=='dsh'?`${nativeName} 电路助手`:'DSH 电路助手'}</strong></div><button type="button" aria-label="关闭 AI 助手" onClick={onClose}><X size={18} /></button></header>
    <p className="ai-intro">{engine!=='dsh'?`让 ${nativeName} 读取电路、调整器件与连线，并调用 ngspice 验证。`:'描述目标，让助手检查电路、调整候选方案并运行仿真。'}修改由你审阅后应用。</p>
    {externalTask&&consumedTask.current!==externalTask.id&&<p role="status" className="ai-notice">模型搜索任务已排队；请先完成助手连接，正在运行的任务结束后会继续。当前输入草稿会保留。</p>}
    <form onSubmit={send}>
      <label className="ai-engine-selector">助手<select aria-label="AI 运行方式" value={engine} disabled={locked} onChange={event=>chooseEngine(event.target.value as AssistantEngine)}><option value="codex">Codex · 本机登录</option><option value="cursor">Cursor · 本机登录</option><option value="dsh">DSH · 本机 / API</option></select></label>
      {engine==='dsh'&&<label className="ai-engine-selector">连接方式<select aria-label="DSH 连接方式" value={dshConnection} disabled={locked} onChange={event=>chooseDshConnection(event.target.value as DshConnection)}><option value="api">模型 API 配置</option><option value="local">本机 DSH 登录</option></select></label>}
    {engine==='dsh'&&dshConnection==='local'&&<div ref={dshPanel}>{onOpenSettings ? <div className="assistant-connection-shortcut"><span>DSH 本机连接 · {dshStatus?.message ?? '状态由工作台设置管理'}</span><button type="button" onClick={onOpenSettings}><Settings2 size={14}/>打开设置</button></div> : <DshLocalSettings selection={dshSelection} onChange={updateDshSelection} onStatus={setDshStatus} disabled={locked}/>}</div>}
      {engine!=='dsh'&&<section ref={codexPanel} className="codex-connection" aria-label={`本机 ${nativeName} 连接`} data-state={codexChecking?'checking':codexError?'error':!codexStatus?.installed?'missing':codexStatus.authenticated===false?'login':codexStatus.available?'ready':'error'}>
        <div className="codex-connection-heading"><strong><span className="codex-status-dot" aria-hidden="true"/>本机 {nativeName}</strong><button type="button" aria-label={`刷新 ${nativeName} 状态`} title={`刷新本机 ${nativeName} 连接状态`} disabled={codexChecking || busy} onClick={()=>void refreshCodex()}><RefreshCw size={14}/></button></div>
        <p role="status">{codexChecking?`正在连接本机 ${nativeName}…`:codexError||(!codexStatus?.installed?`未找到 ${nativeName}`:codexStatus.authenticated===false?`需要登录 ${nativeName}`:codexStatus.available?'已就绪':`${nativeName} 暂不可用`)}</p>
        {!codexChecking&&codexStatus&&<><small>{codexStatus.message}</small>{codexStatus.version&&<span className="codex-connection-meta">{codexStatus.version}{codexStatus.model?` · ${codexStatus.model}`:''}</span>}</>}
        <small className="codex-session-note">使用本机 {nativeName} 的登录与配置，无需在这里填写 API 密钥。这里是独立的电路会话，不会同步桌面聊天。</small>
        {engine==='cursor'&&<small><a href="https://cursor.com/docs/cli/installation" target="_blank" rel="noreferrer">安装 Cursor Agent CLI ↗</a> · 安装后在终端运行 <code>agent login</code>，然后刷新。</small>}
      </section>}
      {engine!=='dsh'&&<details className="ai-engine-options" open={false}>
        <summary>助手选项</summary>
        <label>模型（可选）<input aria-label={`${nativeName} 模型覆盖`} value={codexModel} onChange={event=>setCodexModel(event.target.value)} placeholder={`留空，使用本机 ${nativeName} 配置`} maxLength={200} disabled={locked}/><small>仅用于侧栏任务，不修改本机 {nativeName} 设置。</small></label>
      </details>}
      {engine==='dsh'&&dshConnection==='api'&&onOpenSettings&&<div className="assistant-connection-shortcut"><span>模型 API · {provider.model || '尚未选择模型'}</span><button type="button" onClick={onOpenSettings}><Settings2 size={14}/>打开设置</button></div>}
      {engine==='dsh'&&dshConnection==='api'&&!onOpenSettings&&<details ref={settingsPanel} className="ai-settings" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}>
        <summary>模型 API 配置{provider.model ? ` · ${provider.model}` : ''}</summary>
        <div className="ai-provider-heading"><span>{provider.protocol === 'responses' ? 'Responses' : 'Chat Completions'}</span><span>密钥仅保留本次会话</span></div>
        <div className="ai-provider-cards" role="group" aria-label="AI 服务商">{aiProviderPresets.map(item => <button type="button" key={item.id} data-provider-id={item.id} aria-pressed={provider.preset === item.id} disabled={locked} onClick={() => choosePreset(item.id)}><span>{item.name}</span><small>{item.protocol === 'responses' ? 'Responses API' : item.id === 'custom' ? '手动配置' : 'Chat API'}</small></button>)}</div>
        <label>API 协议<select aria-label="AI API 协议" value={provider.protocol ?? 'chat-completions'} disabled={locked} onChange={event => updateProvider({ protocol: event.target.value as AiProtocol })}><option value="chat-completions">Chat Completions</option><option value="responses">Responses · Codex 兼容</option></select></label>
        <small>{preset.hint} {preset.docs && <a href={preset.docs} target="_blank" rel="noreferrer">接口文档 ↗</a>}</small>
        <label>API 基础地址<input aria-label="AI API 地址" type="url" value={provider.endpoint} onChange={event => updateProvider({ endpoint: event.target.value, preset: 'custom' })} placeholder="https://api.example.com/v1" required disabled={locked} /></label>
        {urls ? <details className="ai-endpoints"><summary>查看实际请求地址</summary><div><span>模型列表 · GET</span><code>{urls.models}</code><span>推理 · POST</span><code>{provider.protocol === 'responses' ? urls.responses : urls.chat}</code></div></details> : <small className="ai-provider-url-error">{urlError}</small>}
        {urls && provider.endpoint.trim().startsWith('http:') && <small className="ai-http-hint">当前使用 HTTP 地址；如服务提供 HTTPS，建议使用 HTTPS。</small>}
        <label>API 密钥<div className="ai-secret-field"><input aria-label="AI API 密钥" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={provider.apiKey} onChange={event => updateProvider({ apiKey: event.target.value })} placeholder="本机无鉴权服务可留空" maxLength={4096} disabled={locked} /><button type="button" aria-label={showKey ? '隐藏 API 密钥' : '显示 API 密钥'} aria-pressed={showKey} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
        <div className="ai-model-heading"><span>选择模型</span><button type="button" disabled={locked || !urls} onClick={() => void checkProvider('models')}><RefreshCw size={14} />{configBusy === 'models' ? '正在获取…' : '获取模型列表'}</button></div>
        {modelList.length > 0 && <label>服务返回的模型<select aria-label="AI 已发现模型" disabled={locked} value={modelList.some(item => item.id === provider.model) ? provider.model : ''} onChange={event => { if (event.target.value) updateProvider({ model: event.target.value }) }}><option value="">选择模型，或在下方手填</option>{modelList.map(item => <option key={item.id} value={item.id}>{item.name && item.name !== item.id ? `${item.name} · ${item.id}` : item.id}</option>)}</select></label>}
        <label>模型 ID<input aria-label="AI 模型名称" value={provider.model} onChange={event => updateProvider({ model: event.target.value })} placeholder="填写服务商提供的模型 ID" maxLength={200} required disabled={locked} /></label>
        <small>列表可能包含非聊天模型。列表不可用时可以手填 ID，再测试推理。</small>
        <div className="ai-provider-test"><button type="button" disabled={locked || !urls || !provider.model.trim()} onClick={() => void checkProvider('test')}>{configBusy === 'test' ? '正在测试推理…' : '测试模型推理'}</button>{configBusy && <button type="button" onClick={() => pending.current?.abort()}>取消检查</button>}<small>测试会向服务发送固定短提示，可能产生 API 费用；不发送当前电路。</small></div>
        {configStatus && <p role="status" className="ai-provider-status">{configStatus}</p>}
        {configError && <p role="alert" className="ai-error">{configError}</p>}
        <small>地址、协议和模型 ID 会记住。密钥和对话仅存在本次会话，关闭助手即清除；切换服务会开启新对话。</small>
      </details>}
      <div className="ai-conversation-heading"><span>当前电路 · {history.length ? `${history.length / 2} 轮对话` : '新对话'}</span><button type="button" disabled={locked || !history.length&&!agentRuns.length} onClick={() => { setHistory([]); setAgentRuns([]); setProposalAgentId(null); setProposal(null); setNotice('已开启新对话'); setError('') }}><MessageSquarePlus size={14} />新对话</button></div>
      {history.length > 0 && <section className="ai-conversation" aria-label="AI 对话记录" aria-live="polite">{history.map((item, index) => <article key={index} className={`ai-message ai-message-${item.role}`}><strong>{item.role === 'user' ? '你' : '电路助手'}</strong>{item.role==='assistant'?<AssistantMarkdown>{item.content}</AssistantMarkdown>:<div>{item.content}</div>}</article>)}</section>}
      {engine==='dsh'&&dshConnection==='api'&&<div className="ai-mode" role="group" aria-label="AI 操作模式"><button type="button" aria-pressed={mode==='agent'} disabled={locked} onClick={()=>setMode('agent')}>Agent 执行</button><button type="button" aria-pressed={mode === 'explain'} disabled={locked} onClick={() => setMode('explain')}>解释 / 检查</button><button type="button" aria-pressed={mode === 'propose'} disabled={locked} onClick={() => setMode('propose')}>生成修改方案</button></div>}
      {engine==='dsh'&&mode==='agent'&&<div className="agent-mode-note"><strong>DeepSeek Harness · 电路 Agent</strong><p>{dshConnection==='local'?'使用本机 DSH 的供应商授权和所选模型执行任务。':'DSH 负责规划与工具循环，所选模型 API 负责推理。'}助手可以读取、检查、修改候选电路并调用 ngspice。</p><small>所选服务需支持工具调用；每个任务最多 3 次仿真、18 次工具调用，约 120 秒；候选修改不会自动覆盖画布。</small></div>}
      <label className="ai-prompt">{mode==='agent'?'这次要完成什么目标？':mode === 'explain' ? '你想了解什么？' : '希望怎样修改电路？'}<textarea ref={promptInput} aria-label="AI 问题" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={8000} rows={4} placeholder={mode==='agent'?'把低通截止频率调到约 2 kHz，运行 AC 仿真检查结果，并说明修改了哪些参数。':mode === 'explain' ? '分析这个电路的作用，并检查悬空节点和参数设置。' : '将低通截止频率改为约 2 kHz，保留原布局并说明选值。'} disabled={busy} required /></label>
      <small className="ai-disclosure">{engine!=='dsh'?`当前原理图、问题、最近 6 轮对话与工具结果会交给本机 ${nativeName} 配置的模型服务。侧栏对话与任务记录仅在本次会话保留。`:'发送当前原理图、问题和最近 6 轮对话给所选服务；Agent 还会发送工具执行结果。密钥、对话和任务记录只保留在本次会话。'}</small>
      <div className="ai-actions">{busy ? <button type="button" onClick={() => pending.current?.abort()}><Square size={14} />{mode==='agent'?'停止任务':'取消请求'}</button> : <button type="submit" className="primary" disabled={locked || !prompt.trim() || (engine!=='dsh' ? codexChecking || !codexStatus?.available || codexStatus.authenticated===false : dshConnection==='local' ? !dshLocalReady : !urls || !provider.model.trim())}><Send size={15} />{mode==='agent'?'开始任务':mode === 'explain' ? '发送问题' : '生成方案'}</button>}</div>
    </form>
    {busy&&agentRuns.filter(run=>run.status==='running').map(run=><AgentTaskProgress key={run.id} status={run.status} steps={run.steps} startedAt={run.startedAt}/>)}
    {busy&&mode!=='agent'&&<p role="status" className="ai-busy">正在等待模型回复…</p>}
    {error && <p role="alert" className="ai-error">{error}</p>}
    {notice && <p role="status" className="ai-notice">{notice}</p>}
    {agentRuns.some(run=>run.result?.modelAcquisitions?.length)&&onOpenModels&&<button type="button" className="assistant-model-shortcut" onClick={onOpenModels}>在本地库查看助手找到的模型</button>}
    {agentRuns.length>0&&<section className="agent-runs" aria-label="Agent 任务记录">{agentRuns.map((run,index)=><AgentRunCard key={run.id} run={run} latest={index===agentRuns.length-1} project={project} busy={busy} onReview={()=>review(run)} onApply={()=>apply(run)} onUndo={()=>undoApplication(run)} onRetry={()=>retry(run)} onConfigure={()=>configureRun(run)}/>)}</section>}
    {proposal&&selectedRun&&!selectedRun.discarded&&<section className="ai-proposal" aria-label="AI 修改方案" data-candidate-state={selectedState}><h3>{selectedState==='applied'?'已应用方案':selectedRun.everApplied?'保留的修改方案':'待应用方案'}</h3><AgentProposalPreview project={choiceProject??(selectedState==='mergeable'?selectedResolution?.project:undefined)??proposal.project} baseline={choice||selectedState==='mergeable'?project:selectedRun.baseline} proposalLabel={choice?'应用后原理图':selectedState==='mergeable'?'合并后原理图':undefined} baselineLabel={choice||selectedState==='mergeable'?'当前画布':undefined}/><AssistantMarkdown>{proposal.summary}</AssistantMarkdown><ul>{proposal.changes.map((change, index) => <li key={index}>{change}</li>)}</ul>
      {proposal.warnings.length > 0 && <div className="ai-warnings"><strong>仿真前还需处理</strong><ul>{proposal.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      <details><summary>查看完整项目数据</summary><pre style={{ overflow: 'auto', maxHeight: 260 }}>{JSON.stringify(proposal.project, null, 2)}</pre></details>
      <p className={stale?'ai-error':'agent-candidate-state'} role="status">{candidateLabel(selectedRun,selectedState!)}</p>
      {selectedState==='conflict'&&<div className="ai-actions" aria-label="方案冲突处理"><button type="button" disabled={busy} aria-pressed={choice?.mode==='merge'} onClick={()=>setConflictChoice({runId:selectedRun.id,mode:'merge',canvas:aiProjectFingerprint(project),proposal:aiProjectFingerprint(selectedRun.result!.proposal.project)})}>保留其他改动并应用</button><button type="button" disabled={busy} aria-pressed={choice?.mode==='replace'} onClick={()=>setConflictChoice({runId:selectedRun.id,mode:'replace',canvas:aiProjectFingerprint(project),proposal:aiProjectFingerprint(selectedRun.result!.proposal.project)})}>恢复方案起点并应用</button>{choice&&<><p>{choice.mode==='merge'?'冲突位置使用方案值，其余编辑保留。':'生成方案后手动更改的画布将被替换。'}上方预览是应用后的画布；应用前快照可用于撤销。</p><button type="button" className="primary" disabled={busy||!choiceProject} onClick={()=>apply(selectedRun,choice.mode)}>确认应用</button><button type="button" onClick={()=>setConflictChoice(null)}>取消</button></>}</div>}
      {choice?.mode==='merge'&&!choiceProject&&<p className="ai-error">合并后项目校验未通过，请检查方案或选择恢复起点。</p>}
      <div className="ai-actions"><button type="button" className="primary" onClick={()=>apply()} disabled={selectedState!=='ready'&&selectedState!=='mergeable'||busy}><Check size={15} />{selectedState==='applied'?'当前已应用':selectedState==='mergeable'?'合并方案到当前画布':selectedRun.everApplied?'再次应用方案':'应用方案（可撤销）'}</button><button type="button" onClick={()=>undoApplication()} disabled={selectedState!=='applied'||!selectedRun.result?.changed||busy}><Undo2 size={15}/>撤销应用</button><button type="button" disabled={busy} onClick={() => {setProposal(null);setAgentRuns(previous=>previous.map(run=>run.id===proposalAgentId?{...run,discarded:true}:run));setNotice('已丢弃保留的候选方案，当前画布保持不变。')}}>丢弃方案</button></div>
    </section>}
  </aside>
}
