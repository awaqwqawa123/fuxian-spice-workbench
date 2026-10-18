import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, Check, CircleAlert, LoaderCircle, Monitor, RefreshCw, Send, Square, Undo2 } from 'lucide-react'
import { parseProject, type Project } from '../core/circuit'
import type { DesktopControlState } from '../core/desktop-control'
import { getDesktopControlState, reconnectDesktopControl, handoffDesktopControl, sendDesktopControlMessage, cancelDesktopControlTurn, approveDesktopControlRequest, DesktopControlRequestError } from '../core/desktop-control-client'
import { desktopProjectsMatch, type DesktopCircuitConnection } from '../core/desktop-circuit-client'
import { resolveDesktopCandidate, type DesktopCandidateApplication } from '../core/desktop-candidate-application'
import { resolveCandidateProject } from '../core/candidate-resolution'
import { aiProjectFingerprint } from '../core/ai'
import { candidateWithWaveformSetup } from '../core/candidate-waveform-setup'
import { projectWithCandidateProbes } from '../core/project-probes'
import { LocalServiceUnavailableError } from '../core/local-service-request'
import type { DesktopCircuitTask } from '../core/desktop-circuit'
import type { AgentToolEvent } from '../core/agent-client'
import type { AgentModelAcquisition } from '../core/agent-models'
import { agentElapsedLabel } from '../core/agent-progress'
import type { AssistantExternalTask } from '../core/model-search-task'
import AssistantMarkdown from './AssistantMarkdown'
import AgentProposalPreview from './AgentProposalPreview'

type Draft = { text: string; pending?: { id: string; text: string } }
type CandidateReview = { discarded?: boolean; redraw?: Draft }
type ConflictChoice = { taskId: string; mode: 'merge' | 'replace'; canvas: string; proposal: string }
function restoredCandidate(task: DesktopCircuitTask): Project {
  const proposal = candidateWithWaveformSetup(task.baseline, task.result!.proposal.project)
  return projectWithCandidateProbes(task.baseline, proposal).project
}
const reviewsKey = (projectId: string) => `fuxian.desktop-candidate-reviews.v1:${encodeURIComponent(projectId)}`
function readReviews(projectId: string): Record<string, CandidateReview> {
  try {
    const raw = localStorage.getItem(reviewsKey(projectId))
    if (!raw || raw.length > 100_000) return {}
    const entries = JSON.parse(raw)
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return {}
    return Object.fromEntries(Object.entries(entries).slice(-50).flatMap(([id, entry]) => {
      const value = entry as CandidateReview
      if (!id || id.length > 100 || !value || typeof value !== 'object') return []
      const redraw = value.redraw
      return [[id, { discarded: value.discarded === true, ...(redraw && typeof redraw.text === 'string' ? { redraw: { text: redraw.text.slice(0, 8000), ...(redraw.pending && typeof redraw.pending.id === 'string' && typeof redraw.pending.text === 'string' ? { pending: redraw.pending } : {}) } } : {}) }]]
    }))
  } catch { return {} }
}
export const desktopControlDraftKey = (projectId: string, threadId: string | null) => `fuxian.desktop-control-draft.v1:${encodeURIComponent(projectId)}:${encodeURIComponent(threadId ?? 'unbound')}`
export function readDesktopControlDraft(projectId: string, threadId: string | null): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(desktopControlDraftKey(projectId, threadId)) ?? 'null')
    if (!value || typeof value.text !== 'string') return { text: '' }
    return { text: value.text.slice(0, 8000), ...(value.pending && typeof value.pending.id === 'string' && typeof value.pending.text === 'string' ? { pending: { id: value.pending.id, text: value.pending.text } } : {}) }
  } catch { return { text: '' } }
}
function saveDraft(projectId: string, threadId: string | null, draft: Draft) {
  try { localStorage.setItem(desktopControlDraftKey(projectId, threadId), JSON.stringify(draft)); return true } catch { return false }
}
const applicationsKey = (projectId: string) => `fuxian.desktop-control-applications.v1:${encodeURIComponent(projectId)}`
function readApplications(projectId: string): Record<string, DesktopCandidateApplication> {
  try {
    const raw = localStorage.getItem(applicationsKey(projectId))
    if (!raw || raw.length > 2_000_000) return {}
    const records = JSON.parse(raw)
    if (!records || typeof records !== 'object' || Array.isArray(records)) return {}
    return Object.fromEntries(Object.entries(records).slice(-12).flatMap(([id, value]) => {
      const record = value as DesktopCandidateApplication
      if (!id || id.length > 100 || !record || typeof record.after !== 'string' || !record.before) return []
      try { parseProject(record.before, { allowDraft: true }); return [[id, record]] }
      catch { return [] }
    }))
  } catch { return {} }
}
const toolNames: Record<string, string> = {configure_waveforms:'配置波形图',set_measurement_probes:'放置测量探针',  inspect_circuit: '读取当前电路', set_component_value: '调整器件参数', replace_candidate: '更新候选电路', validate_circuit: '检查电气连接', simulate_circuit: '运行 ngspice', search_spice_models: '搜索器件模型', download_spice_model: '下载模型源码', import_spice_model: '导入候选模型' }
function toolSteps(events: AgentToolEvent[]) {
  const steps: AgentToolEvent[] = []
  for (const event of events) {
    let index = steps.length - 1
    while (index >= 0 && (steps[index].name !== event.name || steps[index].status !== 'running')) index--
    if (event.status !== 'running' && index >= 0) steps[index] = event
    else steps.push(event)
  }
  return steps
}
function Approval({ item, disabled, onAnswer, onStop }: { item: DesktopControlState['approvals'][number]; disabled: boolean; onAnswer: (decision: 'approve' | 'deny', answers?: Record<string, string[]>) => void; onStop: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const known = item.supported && /(?:(?:commandExecution|fileChange)\/requestApproval|execCommandApproval|applyPatchApproval)$/.test(item.method)
  const question = item.supported && /requestUserInput$/.test(item.method) && !!item.questions?.length
  const denyPermissions = item.supported && item.method === 'item/permissions/requestApproval'
  if (denyPermissions && item.canGrantPermissions) return <section className="desktop-control-approval" aria-label={item.title}><strong>{item.title}</strong><pre>{item.detail}</pre><div className="ai-actions"><button type="button" disabled={disabled} onClick={() => onAnswer('approve')}>允许本次</button><button type="button" disabled={disabled} onClick={() => onAnswer('deny')}>拒绝</button></div></section>
  return <section className="desktop-control-approval" aria-label={item.title}><strong>{item.title}</strong><pre>{item.detail}</pre>{question && item.questions?.map(q => <label key={q.id}>{q.question}{q.options?.length ? <select aria-label={q.question} disabled={disabled} value={answers[q.id] ?? ''} onChange={event => setAnswers(old => ({ ...old, [q.id]: event.target.value }))}><option value="">请选择</option>{q.options.map(option => <option key={option.label} value={option.label}>{option.label}{option.description ? ` · ${option.description}` : ''}</option>)}</select> : <input aria-label={q.question} type={q.isSecret ? 'password' : 'text'} autoComplete="off" disabled={disabled} maxLength={2000} value={answers[q.id] ?? ''} onChange={event => setAnswers(old => ({ ...old, [q.id]: event.target.value }))}/>}</label>)}{known || question ? <div className="ai-actions"><button type="button" disabled={disabled || question && item.questions!.some(q => !answers[q.id]?.trim())} onClick={() => onAnswer('approve', question ? Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, [value.trim()]])) : undefined)}>{question ? '提交回答' : '允许本次'}</button>{question ? <button type="button" disabled={disabled} onClick={onStop}>停止本轮</button> : <button type="button" disabled={disabled} onClick={() => onAnswer('deny')}>拒绝</button>}</div> : denyPermissions ? <div className="ai-actions"><button type="button" disabled={disabled} onClick={() => onAnswer('deny')}>拒绝额外权限</button><button type="button" disabled={disabled} onClick={onStop}>停止本轮</button></div> : <><p>此请求尚不支持在网页回答。可停止本轮，再切回桌面继续。</p><button type="button" disabled={disabled} onClick={onStop}>停止本轮</button></>}</section>
}

export interface DesktopControlAssistantProps {
  projectId: string; project: Project; circuit?: DesktopCircuitConnection
  onApply: (project: Project, options?: { undo?: boolean; replace?: boolean }) => Project | void; onBusyChange?: (busy: boolean) => void
  onModelAcquisitions?: (items: AgentModelAcquisition[]) => void
  externalTask?: AssistantExternalTask; onExternalTaskConsumed?: (id: string) => void
}
export default function DesktopControlAssistant(props: DesktopControlAssistantProps) { return <ProjectDesktopControlAssistant key={props.projectId} {...props}/> }
function ProjectDesktopControlAssistant({ projectId, project, circuit, onApply, onBusyChange, onModelAcquisitions, externalTask, onExternalTaskConsumed }: DesktopControlAssistantProps) {
  const [state, setState] = useState<DesktopControlState | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [backendOffline, setBackendOffline] = useState(false)
  const [retryStatus,setRetryStatus]=useState<{attempt:number;checking:boolean;lastAt:number;nextAt:number}|null>(null)
  const [reconnectCheck,setReconnectCheck]=useState<{phase:'checking'|'syncing'|'waiting'|'success'|'error';message:string;restartRequired?:boolean}|null>(null)
  const [reconnectStartedAt, setReconnectStartedAt] = useState(0)
  const [operating, setOperating] = useState(false), [checking, setChecking] = useState(true)
  const [handoffTarget, setHandoffTarget] = useState<'desktop' | 'web' | null>(null)
  const [handoffFailure, setHandoffFailure] = useState<{ owner: 'desktop' | 'web'; threadId: string; message: string } | null>(null)
  const [bindingError, setBindingError] = useState('')
  const [applications, setApplications] = useState(() => readApplications(projectId))
  const [reviews, setReviews] = useState(() => readReviews(projectId))
  const [redrawOpen, setRedrawOpen] = useState<string | null>(null)
  const [conflictChoice, setConflictChoice] = useState<ConflictChoice | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const alive = useRef(true), operation = useRef<AbortController | null>(null), polling = useRef(false), sequence = useRef(0)
  const reconnectRequest=useRef<AbortController|null>(null)
  const checkingRef=useRef(true)
  const finishInitialCheck=useCallback(()=>{if(checkingRef.current){checkingRef.current=false;setChecking(false)}},[])
  const redrawSending=useRef(false)
  const retry=useRef({failures:0,nextAt:0})
  const latest = useRef(state), current = useRef(project); current.current = project
  const stateSignature=useRef<string|undefined>(undefined)
  if(stateSignature.current===undefined)stateSignature.current=state?JSON.stringify({...state,updatedAt:undefined}):''
  const needsConnectionReset=useRef(false)
  needsConnectionReset.current=!!error||backendOffline||!!retryStatus
  const scroll = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), following = useRef(true), lastTop = useRef(0)
  const [away, setAway] = useState(false)
  const snapshot = circuit?.state?.snapshot
  const canvasReady = circuit?.status === 'ready' && snapshot?.projectId === projectId && desktopProjectsMatch(snapshot.project, project)
  const tasks = (circuit?.state?.tasks ?? []).filter(task => task.projectId === projectId)
  const connected = !!state?.connected && !error
  const webOwner = connected && !!state?.ready && state.owner === 'web'
  const confirmedWeb = webOwner && !state?.pendingOwner
  const pending = !!state?.pendingOwner
  const control = !connected ? 'disconnected' : pending ? 'pending' : state?.owner ?? 'disconnected'
  const projectUnbound = connected && !!state?.ready && !!state?.desktopConnected && !state.threadId
  useEffect(() => {
    try { localStorage.setItem(applicationsKey(projectId), JSON.stringify(applications)) }
    catch { setNotice('候选已应用，但撤销记录无法持久保存；请导出当前工程备份。') }
  }, [projectId, applications])
  useEffect(() => {
    try { localStorage.setItem(reviewsKey(projectId), JSON.stringify(reviews)) }
    catch { setNotice('浏览器未能保存方案选择或重画要求，请暂时保留此页面。') }
  }, [projectId, reviews])
  useEffect(() => {
    if (!state?.messages.length) return
    setReviews(previous => {
      let changed = false
      const next = { ...previous }
      for (const [id, review] of Object.entries(previous)) {
        const pending = review.redraw?.pending
        const delivered = pending && state.messages.find(message => message.id === pending.id && message.role === 'user' && message.delivery !== 'unknown')
        if (!delivered) continue
        changed = true
        next[id] = { ...review, redraw: { text: delivered.delivery === 'failed' ? review.redraw!.text : review.redraw!.text.trim() === pending.text ? '' : review.redraw!.text } }
      }
      return changed ? next : previous
    })
  }, [state?.messages])
  const reconnectTiming=reconnectCheck?.phase==='checking'||reconnectCheck?.phase==='syncing'||reconnectCheck?.phase==='waiting'
  useEffect(() => {
    if (!state?.busy && !backendOffline && !reconnectTiming) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), backendOffline || reconnectTiming ? 1000 : 5000)
    return () => clearInterval(timer)
  }, [state?.busy,backendOffline,reconnectTiming])
  const accept = useCallback((next: DesktopControlState) => {
    if (!alive.current || next.projectId !== projectId) return
    if (next.threadId && !latest.current?.threadId) {
      // Carry an unbound draft into its first thread, without touching existing
      // thread drafts or any legacy/HAPI storage key.
      try {
        if (localStorage.getItem(desktopControlDraftKey(projectId, next.threadId)) === null) {
          const unbound = readDesktopControlDraft(projectId, null)
          if (unbound.text) saveDraft(projectId, next.threadId, { text: unbound.text })
        }
      } catch { /* The composer reports unavailable storage. */ }
    }
    latest.current = next
    const signature=JSON.stringify({...next,updatedAt:undefined})
    if(signature===stateSignature.current&&!needsConnectionReset.current&&!retry.current.failures)return
    if(signature!==stateSignature.current){stateSignature.current=signature;setState(next)}
    needsConnectionReset.current=false
    setError(''); setBackendOffline(false);setRetryStatus(null);retry.current={failures:0,nextAt:0}
    // A successful status poll does not prove the requested handoff succeeded.
    // Retain its failure until that same thread confirms the requested owner.
    setHandoffFailure(old => old && (old.threadId !== next.threadId || next.connected && next.ready && next.owner === old.owner && !next.pendingOwner) ? null : old)
  }, [projectId])
  const recordConnectionFailure=useCallback((reason:unknown)=>{
    needsConnectionReset.current=true
    setError((reason as Error).message)
    setReconnectCheck(old=>old?.phase==='success'?null:old)
    const offline=reason instanceof LocalServiceUnavailableError
    setBackendOffline(offline)
    if(offline){const failures=++retry.current.failures,delay=Math.min(15000,1800*2**Math.min(4,failures-1)),lastAt=Date.now();retry.current.nextAt=lastAt+delay;setRetryStatus({attempt:failures,checking:false,lastAt,nextAt:lastAt+delay})}
    else{retry.current={failures:0,nextAt:0};setRetryStatus(null)}
  },[])
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (polling.current || operation.current || reconnectRequest.current) return
    polling.current = true; const requestSequence = sequence.current
    if(retry.current.failures)setRetryStatus(old=>old?{...old,checking:true,nextAt:0}:old)
    try { const next = await getDesktopControlState(projectId, signal); if (!signal?.aborted && requestSequence === sequence.current) accept(next) }
    catch (reason) { if (!signal?.aborted && alive.current && requestSequence === sequence.current) recordConnectionFailure(reason) }
    finally { polling.current = false; if (alive.current && !signal?.aborted) finishInitialCheck() }
  }, [projectId, accept,recordConnectionFailure,finishInitialCheck])
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    async function poll() { await refresh(controller.signal); if (!controller.signal.aborted) timer = setTimeout(poll, retry.current.nextAt?Math.max(0,retry.current.nextAt-Date.now()):latest.current?.busy || latest.current?.pendingOwner ? 800 : 1800) }
    void poll()
    return () => { alive.current = false; controller.abort(); operation.current?.abort(); reconnectRequest.current?.abort(); clearTimeout(timer) }
  }, [refresh])
  useEffect(()=>{if(reconnectCheck?.phase==='error'&&connected&&state?.ready&&state.desktopConnected&&state.threadId&&canvasReady)setReconnectCheck({phase:'success',message:'连接已自动恢复，项目对话和当前画布均已就绪。'})},[reconnectCheck?.phase,connected,state?.ready,state?.desktopConnected,state?.threadId,canvasReady])
  useEffect(() => {
    // Once the restarted desktop reports readiness, finish the same project's
    // binding and canvas synchronization instead of asking for another click.
    if (reconnectCheck?.phase === 'waiting' && state?.connected && state.ready && state.desktopConnected) void reconnectAll()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectCheck?.phase, state?.connected, state?.ready, state?.desktopConnected])
  useEffect(() => { onBusyChange?.(operating || !!state?.busy); return () => onBusyChange?.(false) }, [operating, state?.busy, onBusyChange])
  const acquisitions = JSON.stringify(tasks.flatMap(task => task.result?.modelAcquisitions ?? []))
  useEffect(() => { const values = JSON.parse(acquisitions) as AgentModelAcquisition[]; if (values.length) onModelAcquisitions?.(values) }, [acquisitions, onModelAcquisitions])
  const followLatest = useCallback(() => {
    const area = scroll.current
    if (!area?.clientHeight) return
    if (following.current) area.scrollTop = Math.max(0, area.scrollHeight - area.clientHeight)
    lastTop.current = area.scrollTop; setAway(area.scrollHeight - area.scrollTop - area.clientHeight > 48)
  }, [])
  useLayoutEffect(followLatest)
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !scroll.current || !content.current) return
    const observer = new ResizeObserver(followLatest); observer.observe(scroll.current); observer.observe(content.current)
    return () => observer.disconnect()
  }, [followLatest])
  async function perform(action: (signal: AbortSignal) => Promise<DesktopControlState>, reportFailure = false, reportConnectionError = true) {
    if (operation.current) return null
    const controller = new AbortController(); operation.current = controller; sequence.current++; setOperating(true); setNotice('')
    try { const next = await action(controller.signal); if (!controller.signal.aborted && alive.current) { accept(next); return next } }
    catch (reason) { if (!controller.signal.aborted && alive.current) { if (reportConnectionError || reason instanceof LocalServiceUnavailableError) { setError((reason as Error).message); setBackendOffline(reason instanceof LocalServiceUnavailableError) } if (reportFailure) throw reason } }
    finally { if (operation.current === controller) { operation.current = null; if (alive.current) setOperating(false) } }
    return null
  }
  async function reconnectAll(){
    if(reconnectRequest.current||operation.current)return
    const controller=new AbortController();reconnectRequest.current=controller;sequence.current++
    setOperating(true); finishInitialCheck(); setBindingError(''); setNotice(''); setError(''); setReconnectStartedAt(Date.now()); setNow(Date.now())
    setReconnectCheck({phase:'checking',message:'正在检查并恢复 Codex 桌面共享连接和项目对话…'})
    try{
      const result = await reconnectDesktopControl(projectId,current.current.title,controller.signal)
      if(controller.signal.aborted||!alive.current)return
      const next = result.state
      if (!next) throw new Error('桌面共享服务未返回当前项目的连接结果。')
      accept(next)
      if (result.stage === 'restart-required' || result.stage === 'waiting-desktop') {
        setReconnectCheck({phase:'waiting',message:result.message,restartRequired:result.restartRequired}); return
      }
      if (result.stage !== 'connected' || !next.connected || !next.ready || !next.desktopConnected || !next.threadId) {
        setReconnectCheck({phase:'error',message:result.message || next.error || '项目对话尚未连接，原对话与草稿已保留。'}); return
      }
      setReconnectCheck({phase:'syncing',message:'桌面共享和项目对话已连接，正在同步当前画布…'})
      const canvas=await circuit?.retry()
      if(controller.signal.aborted||!alive.current)return
      if(!canvas){setReconnectCheck({phase:'error',message:'项目对话已连接，但画布同步尚未启动。'});return}
      if(canvas.status==='conflict'){setReconnectCheck({phase:'error',message:'项目对话已连接。另一页面保存了不同画布，请确认下方“以当前画布连接”后继续。'});return}
      if(canvas.status!=='ready'||canvas.state?.snapshot?.projectId!==projectId||!desktopProjectsMatch(canvas.state.snapshot.project,current.current)){
        setReconnectCheck({phase:'error',message:canvas.error||'项目对话已连接，当前画布仍在同步；完成后会更新状态。'});return
      }
      setReconnectCheck({phase:'success',message:next.pendingOwner ? '项目对话和画布已连接，等待当前任务结束后切回网页。' : next.owner==='desktop'?'项目对话和画布已连接，当前由桌面控制；点击“切到网页”后可发送。':'重新连接完成：项目对话已连接，当前画布已同步。'})
    }catch(reason){if(!controller.signal.aborted&&alive.current){recordConnectionFailure(reason);setReconnectCheck({phase:'error',message:`重新连接失败：${(reason as Error).message}`})}}
    finally{if(reconnectRequest.current===controller)reconnectRequest.current=null;if(alive.current&&!controller.signal.aborted)setOperating(false)}
  }
  function createProject() {
    void reconnectAll()
  }
  async function handoff(owner: 'desktop' | 'web', keepRequestOnNavigation = false) {
    if (!state?.threadId || !connected || operating || pending) return
    const threadId = state.threadId
    setHandoffTarget(owner); setHandoffFailure(null)
    try { await perform(signal => handoffDesktopControl(projectId, owner, keepRequestOnNavigation ? undefined : signal), true, false) }
    catch (reason) { if (alive.current) setHandoffFailure({ owner, threadId, message: (reason as Error).message }) }
    finally { if (alive.current) setHandoffTarget(null) }
  }
  function applyTask(task: DesktopCircuitTask, undo = false, conflictMode?: ConflictChoice['mode']) {
    const before = structuredClone(current.current), resolution = resolveDesktopCandidate(task, before, applications[task.id])
    if (operating || reviews[task.id]?.discarded || !task.result || (undo ? resolution.status !== 'applied' : conflictMode ? resolution.status !== 'conflict' : resolution.status !== 'ready' && resolution.status !== 'mergeable')) return
    if (conflictMode && (conflictChoice?.taskId !== task.id || conflictChoice.mode !== conflictMode || conflictChoice.canvas !== aiProjectFingerprint(before) || conflictChoice.proposal !== aiProjectFingerprint(task.result.proposal.project))) {
      setConflictChoice(null); setNotice('预览期间画布或方案发生变化，请重新选择应用方式并查看最新预览。'); return
    }
    const forced = conflictMode === 'merge' ? resolveCandidateProject(task.baseline, task.result.proposal.project, before, undefined, 'prefer-candidate') : null
    if (forced && (forced.status !== 'mergeable' || !forced.project)) {
      setConflictChoice(null); setNotice('当前画布已变化，无法按刚才的预览合并。请重新选择应用方式。'); return
    }
    const next = structuredClone(undo
      ? applications[task.id]?.before ?? { ...task.baseline, ...(task.result.proposal.project.probes !== undefined && task.baseline.probes === undefined ? { probes: [] } : {}) }
      : conflictMode === 'merge' ? forced!.project!
      : conflictMode === 'replace' ? restoredCandidate(task)
      : resolution.status === 'mergeable' ? resolution.project! : task.result.proposal.project)
    try {
      const saved = onApply(next, { undo, replace: conflictMode === 'replace' })
      current.current = saved ?? (conflictMode === 'replace' ? next : candidateWithWaveformSetup(before, next))
      if (!undo) {
        const record = { before, after: aiProjectFingerprint(current.current), simulationStale: conflictMode === 'merge' ? forced?.simulationStale : conflictMode === 'replace' ? false : resolution.simulationStale }
        setApplications(previous => {
          const updated = { ...previous }; delete updated[task.id]; updated[task.id] = record
          return Object.fromEntries(Object.entries(updated).slice(-12))
        })
      }
      setConflictChoice(null)
      setNotice(undo ? '已恢复本次应用前的画布；后续编辑保留在项目历史中。' : conflictMode === 'merge' ? forced?.simulationStale ? '方案已应用；非冲突手动编辑保留，冲突字段使用方案值。电气结果已变化，请重新仿真。Ctrl+Z 可撤销。' : '方案已应用；非冲突手动编辑保留，冲突字段使用方案值。Ctrl+Z 可撤销。' : conflictMode === 'replace' ? '已恢复到方案生成时的画布并应用方案；应用前画布可撤销恢复。' : resolution.status === 'mergeable' ? resolution.simulationStale ? '方案已与后续编辑合并并保存；电气结果已变化，请重新仿真。Ctrl+Z 可撤销。' : '方案已与后续编辑合并并保存；Ctrl+Z 可撤销。' : '候选已应用，可撤销后再次应用。')
    } catch (reason) { setNotice(`未应用方案：${(reason as Error).message}`) }
  }
  function updateReview(taskId: string, patch: Partial<CandidateReview>) {
    setReviews(previous => ({ ...previous, [taskId]: { ...previous[taskId], ...patch } }))
  }
  async function sendRedraw(task: DesktopCircuitTask, stopCurrent = false) {
    const draft = reviews[task.id]?.redraw, text = draft?.text.trim()
    if (!text || draft?.pending || !task.result?.changed || task.status !== 'completed' || reviews[task.id]?.discarded || !confirmedWeb || state?.pendingApprovals || operating || !canvasReady || redrawSending.current || state?.busy && !stopCurrent) return
    redrawSending.current = true
    try {
      let controlState = state!
      if (controlState.busy) {
        const stopped = await perform(signal => cancelDesktopControlTurn(projectId, signal), true)
        if (!stopped) return
        controlState = stopped
        for (let attempt = 0; controlState.busy && alive.current && attempt < 8; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 400))
          controlState = await getDesktopControlState(projectId)
          accept(controlState)
        }
        if (controlState.busy) { setNotice('已请求停止当前回合，但结束状态尚未确认。重画要求已保留，请在本轮结束后点击“按要求重画”。'); return }
      }
      if (!alive.current) return
      if (!controlState.connected || !controlState.ready || controlState.owner !== 'web' || controlState.pendingOwner || controlState.pendingApprovals) { setNotice('当前对话尚未就绪，重画要求已保留。'); return }
      const pending = { id: crypto.randomUUID(), text }
      updateReview(task.id, { redraw: { text: draft?.text ?? '', pending } })
      try { await perform(signal => sendDesktopControlMessage(projectId, `请以当前待审阅候选为起点重画。具体要求：${text}`, pending.id, signal, task.id), true) }
      catch (reason) {
        if (reason instanceof DesktopControlRequestError && [400, 403, 409].includes(reason.status)) updateReview(task.id, { redraw: { text: draft?.text ?? '' } })
      }
    } catch (reason) { setNotice(`重画尚未发送：${(reason as Error).message}。要求已保留。`) }
    finally { redrawSending.current = false }
  }
  const latestUserAt = Math.max(0, ...(state?.messages.filter(message => message.role === 'user').map(message => message.createdAt) ?? []))
  const lastTask = tasks.at(-1)
  const currentTask = lastTask && (!latestUserAt || Date.parse(lastTask.updatedAt) >= latestUserAt) ? lastTask : null
  const currentSteps = currentTask ? toolSteps(currentTask.events) : []
  const runningStep = [...currentSteps].reverse().find(step => step.status === 'running')
  const completedSteps = currentSteps.filter(step => step.status === 'completed').length
  const lastToolAt = currentTask?.status === 'running' ? Date.parse(currentTask.updatedAt) : NaN
  const runDetail = state?.pendingApprovals && currentTask?.status === 'interrupted' ? '电路任务已因服务重启中断；当前对话仍有请求待确认。处理后请从当前工程重试。'
    : state?.pendingApprovals && state.approvals.length ? `${state.pendingApprovals} 项请求待确认，请在下方查看并决定。`
    : state?.pendingApprovals ? '当前请求需在 Codex 桌面处理。'
    : runningStep ? `电路工具正在${toolNames[runningStep.name] ?? runningStep.name}。`
    : currentTask?.status === 'running' && currentSteps.length ? `${completedSteps}/${currentSteps.length} 个电路步骤已完成；Codex 回合仍未结束。`
    : currentTask?.status === 'completed' ? '电路工具已完成；等待 Codex 结束本轮并给出回复。'
    : 'Codex 回合尚未结束，等待下一步或回复。'
  const reconnectBusy = reconnectCheck?.phase === 'checking' || reconnectCheck?.phase === 'syncing'
  return <section className="desktop-control-assistant" aria-label="Codex 桌面共享会话" data-control={control} aria-busy={reconnectBusy}>
    <div className="desktop-control-status"><strong><i/>{(reconnectBusy||backendOffline&&retryStatus?.checking||connected && state?.busy && !state.pendingApprovals) && <LoaderCircle className="desktop-control-spinner" size={14} aria-hidden="true"/>}{reconnectBusy ? reconnectCheck.phase === 'syncing' ? '正在同步画布…' : '正在恢复桌面连接…' : reconnectCheck?.phase === 'waiting' ? reconnectCheck.restartRequired ? '配置已修复 · 等待重开 Codex' : '等待 Codex 桌面接入' : checking ? '检查桌面连接…' : handoffTarget ? `正在切到${handoffTarget === 'web' ? '网页' : '桌面'}…` : backendOffline ? retryStatus?.checking?`正在尝试连接本机后台 · 第 ${retryStatus.attempt+1} 次`:'本机工作台后台未连接' : connected && state?.pendingApprovals ? '本轮等待审批' : connected && state?.busy ? `本轮进行中 · ${state.owner === 'desktop' ? '桌面' : '网页'}控制` : control === 'web' ? `网页控制中${state?.messages.length ? ' · 本轮已结束' : ''}` : control === 'desktop' ? `桌面控制中${state?.messages.length ? ' · 本轮已结束' : ''}` : control === 'pending' ? `等待切到${state?.pendingOwner === 'web' ? '网页' : '桌面'}` : projectUnbound ? '桌面已连接 · 正在创建项目对话' : state?.threadId && state.desktopConnected ? '项目对话暂不可用' : '桌面连接未就绪'}</strong><button type="button" aria-label="重新连接桌面共享" disabled={operating||reconnectBusy} onClick={()=>{void reconnectAll()}}>{reconnectBusy ? <LoaderCircle className="desktop-control-spinner" size={14}/> : <RefreshCw size={14}/>} {reconnectBusy ? '连接中…' : '重新连接'}</button></div>
    {reconnectCheck&&<div className="desktop-control-reconnect-result" role="status" aria-live="polite" data-phase={reconnectCheck.phase}>{reconnectBusy?<LoaderCircle className="desktop-control-spinner" size={16} aria-hidden="true"/>:reconnectCheck.phase==='success'?<Check size={16} aria-hidden="true"/>:reconnectCheck.phase==='waiting'?<Monitor size={16} aria-hidden="true"/>:<CircleAlert size={16} aria-hidden="true"/>}<span>{reconnectCheck.restartRequired && <strong>配置已修复</strong>}{reconnectCheck.message}{reconnectBusy && <small>已进行 {Math.max(0,Math.floor((now-reconnectStartedAt)/1000))} 秒 · 正在处理，请稍候</small>}{reconnectCheck.phase === 'waiting' && <small>原项目对话和草稿已保留，桌面接入后会自动完成连接。</small>}</span></div>}
    {backendOffline&&retryStatus&&<div className="desktop-control-retry" role="status"><span>{retryStatus.checking?`第 ${retryStatus.attempt+1} 次连接正在进行…`:`已尝试 ${retryStatus.attempt} 次 · 上次检查 ${new Date(retryStatus.lastAt).toLocaleTimeString('zh-CN')} · ${Math.max(0,Math.ceil((retryStatus.nextAt-now)/1000))} 秒后再试`}</span></div>}
    <p className="desktop-control-intro">每个项目固定一段新建的 Codex 对话。切换项目会切换到它自己的聊天；桌面与网页可交接控制权。</p>
    {projectUnbound && <section className="desktop-control-start" aria-label="开始项目对话">
      <strong>正在连接此项目的专属对话</strong>
      <p>首次切到此项目时会自动新建并绑定一段对话，以后回来继续同一段。</p>
      <button type="button" disabled={operating || !!state?.busy || pending} onClick={createProject}>{operating ? '正在创建…' : bindingError || state?.error ? '重试创建项目对话' : '新建并连接项目对话'}</button>
      {bindingError && <p className="ai-error" role="alert">{bindingError}</p>}
    </section>}
    {!checking && !connected && !reconnectBusy && reconnectCheck?.phase !== 'waiting' && <details className="desktop-control-setup"><summary>{backendOffline ? '后台未连接 · 查看原因与处理方法' : state?.threadId && state.desktopConnected ? '项目对话无法读取 · 查看原因' : '连接未就绪 · 查看接入说明'}</summary><p>{backendOffline ? `${error} 请在软件目录双击 run-workbench.cmd 启动本机工作台；本页会自动恢复，草稿与聊天保留。` : '点击上方“重新连接”，工作台会检查并修复共享入口，恢复此项目的专属对话并同步画布。首次配置或 Codex 更新后，如需重开桌面，会明确显示下一步。项目对话与草稿会保留。'}</p>{!backendOffline && state?.error && <p>{state.error}</p>}</details>}
    {state?.threadId && <div className="desktop-control-handoff" aria-label="会话控制权" aria-busy={handoffTarget !== null}><button type="button" className={control === 'web' ? 'is-active' : ''} disabled={!connected || operating || pending || state.owner === 'web'} onClick={() => { void handoff('web') }}>{handoffTarget === 'web' ? '正在切到网页…' : '切到网页'}</button><a role="button" href={`codex://threads/${encodeURIComponent(state.threadId)}`} className={control === 'desktop' ? 'is-active' : ''} aria-disabled={!connected || operating || pending} onClick={event => { if (!connected || operating || pending) { event.preventDefault(); setNotice('当前无法切到桌面，请等待连接或交接完成后重试。'); return } if (state.owner === 'desktop') return; void handoff('desktop', true) }}><Monitor size={13}/>{handoffTarget === 'desktop' ? '正在切到桌面…' : '打开并切到桌面'}</a></div>}
    {state?.threadId && bindingError && <p className="ai-error" role="alert">{bindingError}</p>}
    {handoffFailure && <div className="desktop-control-handoff-feedback" role="alert"><p>尚未确认切到{handoffFailure.owner === 'web' ? '网页' : '桌面'}：{handoffFailure.message}</p><small>{connected && state?.owner ? `当前由${state.owner === 'web' ? '网页' : '桌面'}控制。` : '正在核对连接状态。'}草稿已保留。{connected && !pending ? `可再次点击“${handoffFailure.owner === 'web' ? '切到网页' : '打开并切到桌面'}”重试。` : '连接恢复并完成交接确认后可以重试。'}</small></div>}
    {pending && <p className="desktop-control-pending" role="status">{state?.busy || state?.pendingApprovals ? '当前回合或审批尚未结束，正在等待；草稿保留。' : '正在确认控制权交接…'} 确认前网页不会发送消息。</p>}
    {!!state?.pendingApprovals && !state.approvals.length && <p className="desktop-control-pending">有 {state.pendingApprovals} 个待处理请求，请在 Codex 桌面处理。</p>}
    <details className="desktop-control-details"><summary>项目对话与连接详情</summary>
      {state?.threadId ? <><p>这是此项目绑定的 Codex 对话。对话编号（Thread ID）只是定位用，切换项目或继续聊天都无需填写。</p><small>当前对话编号：{state.threadId}</small></> : <p>首次切换到此项目时会自动新建对话。桌面暂未连接时，连接恢复后会继续创建。</p>}
      <small>桌面客户端：{state?.desktopConnected ? '已连接' : '未连接'}</small>
    </details>
    <div className="desktop-control-canvas" role="status">{backendOffline ? '画布保留在当前页面，等待后台恢复同步。' : canvasReady ? '当前画布已同步到电路工具' : circuit?.status === 'conflict' ? '另一页面保存了不同画布，请确认使用当前画布。' : circuit?.error || '正在同步当前画布…'}{circuit?.status === 'conflict' && <button type="button" onClick={circuit.reconnect}>以当前画布连接</button>}</div>
    <div className="desktop-control-scroll" ref={scroll} tabIndex={0} aria-label="桌面共享消息与电路任务" onWheel={event => { if (event.deltaY < 0 && scroll.current && scroll.current.scrollHeight > scroll.current.clientHeight + 48) { following.current = false; setAway(true) } }} onScroll={() => { const area = scroll.current; if (!area?.clientHeight) return; const bottom = area.scrollHeight - area.scrollTop - area.clientHeight <= 48; if (bottom) following.current = true; else if (area.scrollTop < lastTop.current - 1) following.current = false; lastTop.current = area.scrollTop; setAway(!bottom) }}><div ref={content}>
      {error && !backendOffline && <p className="ai-error" role="alert">{error}</p>}{connected && state?.error && <p className="ai-error" role="status">{state.error}</p>}{notice && <p className="ai-notice" role="status">{notice}</p>}
      <div className="desktop-control-messages" aria-label="桌面共享对话记录" aria-live="polite">{!state?.messages.length && <p className="desktop-control-empty">连接项目对话后，在这里查看桌面消息；切到网页即可继续。</p>}{state?.messages.map(message => <article key={message.id} className={`persistent-message is-${message.role}`}><header><strong>{message.role === 'user' ? '你' : 'Codex'}</strong><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></header>{message.role === 'assistant' ? <AssistantMarkdown>{message.content}</AssistantMarkdown> : <p>{message.content}</p>}{message.delivery && message.delivery !== 'sent' && <small className="desktop-control-pending">{message.delivery === 'unknown' ? '送达状态待核对' : '发送失败'}</small>}</article>)}</div>
      {tasks.map(task => {
        const result = task.result, resolution = resolveDesktopCandidate(task, project, applications[task.id])
        const discarded = !!reviews[task.id]?.discarded
        const candidate = discarded ? 'discarded' : resolution.status, steps = toolSteps(task.events)
        const conflictMerge = candidate === 'conflict' && result ? resolveCandidateProject(task.baseline, result.proposal.project, project, undefined, 'prefer-candidate') : null
        const canPreserveEdits = conflictMerge?.status === 'mergeable' && !!conflictMerge.project
        const choice = candidate === 'conflict' && conflictChoice?.taskId === task.id && conflictChoice.canvas === aiProjectFingerprint(project) && conflictChoice.proposal === aiProjectFingerprint(result!.proposal.project) ? conflictChoice : null
        const choiceProject = choice?.mode === 'merge' ? canPreserveEdits ? conflictMerge.project : null : choice?.mode === 'replace' ? restoredCandidate(task) : null
        const mergedPreview = candidate === 'mergeable' || candidate === 'applied' && !!applications[task.id]
        const previewProject = choiceProject ?? (mergedPreview ? candidate === 'mergeable' ? resolution.project! : project : result?.proposal.project)
        const simulationStale = candidate === 'mergeable' ? resolution.simulationStale : candidate === 'applied' ? applications[task.id]?.simulationStale : false
        const conflictDetail = resolution.conflicts?.length ? `冲突位置：${resolution.conflicts.slice(0, 4).join('、')}${resolution.conflicts.length > 4 ? ' 等' : ''}。` : ''
        const candidateMessage = candidate === 'mergeable' ? '后续编辑可以与方案合并；上方预览已包含这些编辑。'
          : candidate === 'conflict' ? `${conflictDetail}方案和后续手动编辑改到了相同位置。选择保留其他编辑或恢复到方案生成时，再预览并确认；当前画布尚未改动。`
          : candidate === 'already-present' ? '方案的改动已在画布中，后续编辑也已保留。'
          : candidate === 'applied' ? '当前画布已应用此方案。'
          : applications[task.id] ? '方案已撤销，可以再次应用。' : '候选等待审阅，尚未修改画布。'
        const canReview = candidate === 'ready' || candidate === 'mergeable'
        return <details className="desktop-control-task" key={task.id} open={discarded || task === tasks.at(-1) && (task.status === 'running' || !(latestUserAt > Date.parse(task.updatedAt)))} data-candidate-state={candidate}>
          <summary>{task.status === 'running' && <LoaderCircle className="desktop-control-spinner" size={13} aria-hidden="true"/>}电路工具 · {discarded ? '方案已舍弃' : task.status === 'running' ? '执行中' : task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败' : task.status === 'cancelled' ? '已取消' : '已中断'} · {steps.length} 步</summary>
          {discarded ? <div className="desktop-control-discarded"><p>此方案已舍弃，当前画布和项目对话仍保留。{state?.busy ? 'Codex 当前回合仍在运行；如需停止，请使用下方“停止本轮”。' : ''}</p><button type="button" onClick={() => updateReview(task.id, { discarded: false })}>恢复方案</button></div> : <>
          <p>{task.request}</p>
          <ol>{steps.map((step, index) => <li key={index} data-status={step.status}><strong>{toolNames[step.name] ?? step.name}</strong><span>{step.status === 'completed' ? <><Check size={12}/>完成</> : step.status === 'error' ? '失败' : task.status === 'running' ? <><LoaderCircle className="desktop-control-spinner" size={12}/>进行中</> : '已中止'}</span><p>{step.detail}</p></li>)}</ol>
          {task.status === 'running' && !steps.some(step => step.status === 'running') && <p className="desktop-control-task-waiting"><LoaderCircle className="desktop-control-spinner" size={13} aria-hidden="true"/>工具步骤已完成，等待本轮对话结束。</p>}
          {task.error && <p className="ai-error">{task.error}</p>}
          {result && <><AssistantMarkdown>{result.summary}</AssistantMarkdown>
            {result.simulation && <p>{simulationStale ? '原候选仿真：' : ''}{result.simulation.engine} · {result.simulation.analysis.toUpperCase()} · {result.simulation.points} 个采样点{simulationStale ? ' · 合并后需重新仿真' : result.simulation.stale ? ' · 电路修改后需重新仿真' : ''}</p>}
            {result.changed && task.status === 'completed' && <>
              {previewProject && <AgentProposalPreview key={choice?.mode ?? candidate} project={previewProject} baseline={choice || candidate === 'mergeable' ? project : task.baseline} proposalLabel={choice ? '应用后原理图' : candidate === 'mergeable' ? '合并后原理图' : undefined} baselineLabel={choice || candidate === 'mergeable' ? '当前画布' : undefined}/>}
              {!!result.proposal.warnings.length && <ul>{result.proposal.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
              <p className={candidate === 'conflict' ? 'ai-error' : candidate === 'mergeable' ? 'ai-notice' : ''}>{candidateMessage}</p>
              {candidate !== 'conflict' && <div className="ai-actions"><button type="button" className="primary" disabled={operating || !canReview} onClick={() => applyTask(task)}><Check size={14}/>{candidate === 'mergeable' ? '合并方案到当前画布' : candidate === 'applied' ? '当前已应用' : applications[task.id] ? '再次应用方案' : '应用方案（可撤销）'}</button><button type="button" disabled={operating || candidate !== 'applied'} onClick={() => applyTask(task, true)}><Undo2 size={14}/>撤销应用</button>{candidate !== 'applied' && <><button type="button" disabled={!canReview} onClick={() => setRedrawOpen(redrawOpen === task.id ? null : task.id)}><RefreshCw size={14}/>重画</button><button type="button" onClick={() => updateReview(task.id, { discarded: true })}>舍弃方案</button></>}</div>}
              {candidate === 'conflict' && <section className="desktop-control-conflict-choice" aria-label="方案冲突处理">
                <strong>如何应用这份方案</strong>
                <div className="desktop-control-conflict-options">
                  <button type="button" aria-pressed={choice?.mode === 'merge'} disabled={operating || !canPreserveEdits} onClick={() => setConflictChoice({ taskId: task.id, mode: 'merge', canvas: aiProjectFingerprint(project), proposal: aiProjectFingerprint(result.proposal.project) })}>保留其他手动改动并应用</button>
                  <button type="button" aria-pressed={choice?.mode === 'replace'} disabled={operating} onClick={() => setConflictChoice({ taskId: task.id, mode: 'replace', canvas: aiProjectFingerprint(project), proposal: aiProjectFingerprint(result.proposal.project) })}>恢复到方案起点并应用</button>
                </div>
                {!canPreserveEdits && <p>当前改动无法安全合并：{conflictMerge?.conflicts?.slice(0, 3).join('、') || '合并后项目校验未通过'}。仍可检查完整方案后选择恢复到方案起点。</p>}
                {choice && choiceProject && <div className="desktop-control-conflict-confirm" role="group" aria-label="确认冲突处理方式">
                  <p>{choice.mode === 'merge' ? '上方预览是应用后的画布：无冲突的手动编辑会保留；冲突位置采用方案值。' : '上方预览是应用后的画布：会移除方案生成以后对当前项目的手动改动，并应用完整方案。'}</p>
                  <small>应用前的当前画布会留作撤销快照；如画布再次变化，请重新选择并预览。</small>
                  <div><button type="button" className="primary" disabled={operating} onClick={() => applyTask(task, false, choice.mode)}><Check size={14}/>确认{choice.mode === 'merge' ? '保留其他改动并应用' : '恢复起点并应用'}</button><button type="button" onClick={() => setConflictChoice(null)}>取消</button></div>
                </div>}
                <button type="button" className="desktop-control-conflict-discard" onClick={() => updateReview(task.id, { discarded: true })}>舍弃方案</button>
              </section>}
              {canReview && redrawOpen === task.id && <form className="desktop-control-redraw" onSubmit={event => { event.preventDefault(); void sendRedraw(task) }}><label htmlFor={`redraw-${task.id}`}>告诉 Codex 怎样重画这份候选</label><textarea id={`redraw-${task.id}`} aria-label="重画要求" maxLength={7800} rows={3} value={reviews[task.id]?.redraw?.text ?? ''} onChange={event => updateReview(task.id, { redraw: { text: event.target.value, ...(reviews[task.id]?.redraw?.pending ? { pending: reviews[task.id].redraw!.pending } : {}) } })} placeholder="例如：拉开反馈回路与主电流路径，减少交叉走线"/><p>重画会从这份候选继续；单纯调整布局时保留器件、参数和连接。</p>{reviews[task.id]?.redraw?.pending && <small role="status">上次重画请求正在核对送达，要求已保留，不会重复发送。</small>}{state?.busy && <small role="status">本轮仍在进行。可停止当前回合并重画这份候选。</small>}{state?.busy ? <button type="button" disabled={!reviews[task.id]?.redraw?.text.trim() || !!reviews[task.id]?.redraw?.pending || !confirmedWeb || !!state?.pendingApprovals || operating || !canvasReady} onClick={() => { void sendRedraw(task, true) }}><Square size={13}/>停止当前回合并重画</button> : <button type="submit" disabled={!reviews[task.id]?.redraw?.text.trim() || !!reviews[task.id]?.redraw?.pending || !confirmedWeb || !!state?.pendingApprovals || operating || !canvasReady}><Send size={13}/>{operating ? '提交中…' : '按要求重画'}</button>}</form>}
            </>}
          </>}
          </>}</details>
      })}
    </div></div>
    {away && <button className="desktop-control-latest" type="button" onClick={() => { following.current = true; followLatest() }}><ArrowDown size={13}/>回到最新</button>}
    {connected && state?.busy && <div className="desktop-control-run-status" role="status" aria-label="本轮运行状态" data-waiting={!!state.pendingApprovals}><div><strong><span className="desktop-control-run-icon">{state.pendingApprovals ? <CircleAlert size={18} strokeWidth={2.5} aria-hidden="true"/> : <LoaderCircle className="desktop-control-spinner" size={18} strokeWidth={2.5} aria-hidden="true"/>}</span>{state.pendingApprovals ? state.approvals.length ? '需要你确认' : '等待桌面处理' : '本轮仍在进行'}</strong>{latestUserAt > 0 && <small>{state.pendingApprovals ? '本轮开始' : '已用'} {agentElapsedLabel(latestUserAt, now)}{state.pendingApprovals ? '前' : ''}</small>}</div><p>{runDetail}{Number.isFinite(lastToolAt) && <span>最近工具更新：{agentElapsedLabel(lastToolAt, now)}前</span>}</p></div>}
    {!!state?.approvals.length && <section className="desktop-control-approval-dock" aria-label="待处理的 Codex 请求"><strong>Codex 等待你确认 · {state.approvals.length} 项</strong>{state.approvals.map(item => <Approval key={item.id} item={item} disabled={!webOwner || operating} onAnswer={(decision, answers) => { void perform(signal => approveDesktopControlRequest(projectId, item.id, decision, answers, signal)) }} onStop={() => { void perform(signal => cancelDesktopControlTurn(projectId, signal)) }}/>)}</section>}
    {!checking && <Composer key={state?.threadId ?? 'unbound'} projectId={projectId} state={state} canSend={confirmedWeb && !state?.busy && !state?.pendingApprovals && !operating && !!canvasReady} operating={operating} externalTask={externalTask} onExternalTaskConsumed={onExternalTaskConsumed} onSend={(message, requestId) => perform(signal => sendDesktopControlMessage(projectId, message, requestId, signal), true)} onRefresh={() => void refresh()} onStop={() => { void perform(signal => cancelDesktopControlTurn(projectId, signal)) }} canStop={webOwner && !!state?.busy && !operating}/>}
  </section>
}
function Composer({ projectId, state, canSend, operating, externalTask, onExternalTaskConsumed, onSend, onRefresh, onStop, canStop }: { projectId: string; state: DesktopControlState | null; canSend: boolean; operating: boolean; externalTask?: AssistantExternalTask; onExternalTaskConsumed?: (id: string) => void; onSend: (message: string, requestId: string) => Promise<DesktopControlState | null>; onRefresh: () => void; onStop: () => void; canStop: boolean }) {
  const threadId = state?.threadId ?? null
  const [draft, setDraft] = useState(() => readDesktopControlDraft(projectId, threadId))
  const [storageError, setStorageError] = useState(false)
  const externalSeen = useRef('')
  useEffect(() => { setStorageError(!saveDraft(projectId, threadId, draft)) }, [projectId, threadId, draft])
  useEffect(() => {
    if (!externalTask || externalSeen.current === externalTask.id) return
    externalSeen.current = externalTask.id
    setDraft(old => ({ ...old, text: old.text.trim() ? `${old.text}\n\n${externalTask.prompt}` : externalTask.prompt })); onExternalTaskConsumed?.(externalTask.id)
  }, [externalTask, onExternalTaskConsumed])
  useEffect(() => {
    if (!draft.pending) return
    const pending = draft.pending, delivered = state?.messages.find(message => message.id === pending.id && message.role === 'user')
    if (delivered && delivered.delivery !== 'unknown') setDraft(old => ({ text: delivered.delivery === 'failed' ? old.text : old.text.trim() === pending.text ? '' : old.text }))
  }, [draft.pending, state?.messages])
  async function send(event: FormEvent) {
    event.preventDefault()
    if (!canSend || !draft.text.trim() || draft.pending) return
    const request = { id: crypto.randomUUID(), text: draft.text.trim() }
    const next = { ...draft, pending: request }; setDraft(next); saveDraft(projectId, threadId, next)
    try { await onSend(request.text, request.id) }
    catch (reason) {
      // These statuses are guaranteed by the gateway to precede any forwarding.
      // Network/5xx errors remain pending until history confirms delivery.
      if (reason instanceof DesktopControlRequestError && [400, 403, 409].includes(reason.status)) setDraft(old => ({ text: old.text }))
    }
  }
  return <form className="desktop-control-compose" onSubmit={send}><label htmlFor={`desktop-control-prompt-${projectId}`}>继续项目对话</label><textarea id={`desktop-control-prompt-${projectId}`} aria-label="桌面共享会话问题" value={draft.text} onChange={event => setDraft(old => ({ ...old, text: event.target.value }))} rows={3} maxLength={8000} placeholder="描述电路目标，或说说希望怎样重画" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }}/>{storageError && <small className="ai-error">浏览器未能保存草稿，请保留输入内容。</small>}{draft.pending && <div className="desktop-control-pending" role="status">上次发送正在核对，草稿保留，不会自动重发。<button type="button" disabled={operating} onClick={onRefresh}>核对发送状态</button></div>}<div><small>{!state?.threadId ? '先连接项目对话' : state.pendingOwner ? '等待交接确认' : state.owner !== 'web' ? '先切到网页，再发送' : state.busy ? '等待本轮完成' : 'Ctrl + Enter'}</small>{canStop && <button type="button" onClick={onStop}><Square size={13}/>停止本轮</button>}<button type="submit" className="primary" disabled={!canSend || !draft.text.trim() || !!draft.pending}><Send size={14}/>{operating ? '提交中…' : '发送给 Codex'}</button></div></form>
}
