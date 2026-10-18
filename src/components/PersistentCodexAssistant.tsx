import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Check, LoaderCircle, MessageSquarePlus, RefreshCw, Square, Undo2 } from 'lucide-react'
import { aiProjectFingerprint } from '../core/ai'
import { candidateWithWaveformSetup } from '../core/candidate-waveform-setup'
import { resolveCandidateProject } from '../core/candidate-resolution'
import { isSchematicRedrawRequest } from '../core/redraw-intent'
import { redrawDrawingLayout } from '../core/redraw-layout'
import { assertLayoutElectricalEquivalent } from '../core/layout-electrical-equivalence'
import { autoPlaceMeasurementProbes } from '../core/probe-layout'
import { inspectDrawingQuality } from '../core/drawing-quality'
import { formatSI, parseProject, type Project } from '../core/circuit'
import type { CodexStatus } from '../core/codex-client'
import type { AgentToolEvent } from '../core/agent-client'
import { bindCodexWorkbench, cancelCodexSession, checkCodexSessionWriteAccess, CodexSessionClientError, createCodexSession, getCodexSession, loadCodexProjectSession, refreshCodexDesktopSession, saveCodexProjectSession, sendCodexSession, type CodexSessionCandidate, type CodexSessionRevision, type CodexSessionState } from '../core/codex-session-client'
import AssistantMarkdown from './AssistantMarkdown'
import AgentProposalPreview from './AgentProposalPreview'
import AgentTaskProgress from './AgentTaskProgress'
import type { AgentModelAcquisition } from '../core/agent-models'

const statusLabels = { idle: '已连接', running: '正在处理', completed: '本轮完成', interrupted: '本轮中断', error: '本轮未完成', cancelled: '本轮已停止' }
const toolLabels: Record<string, string> = {configure_waveforms:'配置波形图',set_measurement_probes:'放置测量探针',  inspect_circuit: '读取电路', replace_candidate: '更新候选', set_component_value: '调整参数', validate_circuit: '检查连接', simulate_circuit: '运行 ngspice', search_spice_models: '搜索器件模型', download_spice_model: '下载模型源码', import_spice_model: '导入候选模型' }
function consolidateSteps(events: AgentToolEvent[]) {
  const steps: AgentToolEvent[] = []
  for (const event of events) {
    let index = steps.length - 1
    while (index >= 0 && (steps[index].name !== event.name || steps[index].status !== 'running')) index--
    if (event.status !== 'running' && index >= 0) steps[index] = event
    else steps.push(event)
  }
  return steps
}
export function persistentCandidateState(candidate: CodexSessionCandidate, project: Project) {
  if (candidate.discarded) return 'discarded'
  return resolveCandidateProject(candidate.baseline, candidate.project, project,
    candidate.lastApply ? aiProjectFingerprint(candidate.lastApply.after) : undefined).status
}

export interface PersistentCodexAssistantProps {
  projectId: string; project: Project; onApply: (project: Project, options?: { undo?: boolean; replace?: boolean }) => Project | void
  initialSessionId?: string
  /** Archive mode never starts/resumes a native runtime; saved candidates remain usable. */
  readOnly?: boolean
  externalTask?: { id: string; prompt: string }
  onExternalTaskConsumed?: (id: string) => void
  onModelAcquisitions?: (items:AgentModelAcquisition[])=>void
  onOpenModels?: ()=>void
  connection: CodexStatus | null; checking: boolean; connectionError: string; onRefresh: () => void
  onBusyChange?: (busy: boolean) => void
}

/** A project binds to one durable native thread; candidates remain separate from the editor. */
export default function PersistentCodexAssistant(props: PersistentCodexAssistantProps) {
  // Reset every request, draft and candidate scope even if a parent forgets its key.
  return <ProjectCodexAssistant key={props.projectId} {...props}/>
}
function ProjectCodexAssistant({ projectId, project, initialSessionId, readOnly = false, externalTask, onExternalTaskConsumed, onModelAcquisitions, onOpenModels, onApply, connection, checking, connectionError, onRefresh, onBusyChange }: PersistentCodexAssistantProps) {
  const saved = useRef(loadCodexProjectSession(projectId))
  const [state, setState] = useState<CodexSessionState | null>(null)
  const [message, setMessage] = useState(saved.current.draft)
  const draft = useRef(message); draft.current = message
  const [candidates, setCandidates] = useState<CodexSessionCandidate[]>(saved.current.candidates)
  const [openedCandidate, setOpenedCandidate] = useState('')
  const [restoreId, setRestoreId] = useState(initialSessionId ?? saved.current.sessionId)
  const [loading, setLoading] = useState(!!(initialSessionId ?? saved.current.sessionId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [mergeErrors, setMergeErrors] = useState<Record<string, string>>({})
  const [conflictChoice,setConflictChoice] = useState<{requestId:string;mode:'merge'|'replace';canvas:string;proposal:string}|null>(null)
  const latest = useRef<CodexSessionState | null>(null)
  const current = useRef(project); current.current = project
  const request = useRef<AbortController | null>(null)
  const pendingSend = useRef<{ message: string; id: string; project: Project; context: string; revision?: CodexSessionRevision } | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const scrollArea = useRef<HTMLDivElement>(null)
  const scrollContent = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true)
  const lastVisibleMessage = useRef('')
  const [unread, setUnread] = useState(false)
  const recoveredQuestions = useRef(new Set<string>())
  const externalAttempt = useRef('')
  const [externalFailed, setExternalFailed] = useState(false)
  const [completedExternal, setCompletedExternal] = useState('')
  const running = !readOnly && state?.status === 'running'
  const locked = busy || loading || running
  const available = !readOnly && !checking && connection?.available && connection.authenticated !== false
  const scrollToLatest = useCallback(() => {
    followBottom.current = true; setUnread(false)
    const area = scrollArea.current
    if (area) area.scrollTop = Math.max(0, area.scrollHeight - area.clientHeight)
  }, [])

  const accept = useCallback((next: CodexSessionState) => {
    if (next.workbench && next.workbench.projectId !== projectId) throw new Error('返回的对话属于其他项目，已阻止显示或应用；请连接当前项目会话。')
    if (latest.current?.id === next.id && next.updatedAt < latest.current.updatedAt) return
    if (!latest.current && next.id === saved.current.sessionId) setCandidates(saved.current.candidates)
    if (latest.current?.id !== next.id) followBottom.current = true
    latest.current = next; setState(next); setRestoreId(next.id); setError('')
    if (next.status === 'error') {
      const question = next.messages.filter(item => item.role === 'user').at(-1)
      if (question?.delivery === 'notSent' && !recoveredQuestions.current.has(question.requestId) && !next.messages.some(item => item.role === 'assistant' && item.requestId === question.requestId)) {
        recoveredQuestions.current.add(question.requestId)
        if (!draft.current.trim()) { setMessage(question.content); setNotice(readOnly ? '上轮未送达问题已保留；发送请切到桌面共享。' : '上轮问题已填回输入框；连接恢复后可编辑并重新发送。') }
      }
    }
    if (next.result?.changed) {
      const result = next.result, requestId = next.resultRequestId ?? next.messages.filter(item => item.role === 'assistant' && item.content === result.summary).at(-1)?.requestId
      if (!requestId) return
      try {
        const baseline = parseProject(JSON.parse(result.base), { allowDraft: true })
        setCandidates(previous => previous.some(item => item.requestId === requestId) ? previous : [...previous, { requestId, summary: result.summary, project: result.project, baseline, base: result.base, everApplied: false, discarded: false }].slice(-6))
      } catch { setNotice('候选基准无法恢复，请在会话中重新生成方案。画布保持当前版本。') }
    }
  }, [projectId, readOnly])

  useLayoutEffect(() => {
    const lastMessage = state?.messages.at(-1)?.id ?? ''
    if (followBottom.current) scrollToLatest()
    else if (lastMessage && lastMessage !== lastVisibleMessage.current) setUnread(true)
    lastVisibleMessage.current = lastMessage
  }, [state?.updatedAt, state?.messages.at(-1)?.id, candidates, error, notice, scrollToLatest])
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !scrollContent.current || !scrollArea.current) return
    const observer = new ResizeObserver(() => { if (followBottom.current) scrollToLatest() })
    observer.observe(scrollContent.current); observer.observe(scrollArea.current)
    return () => observer.disconnect()
  }, [scrollToLatest])

  useEffect(() => {
    onBusyChange?.(!!locked)
    return () => onBusyChange?.(false)
  }, [locked, onBusyChange])
  useEffect(() => {
    if (!saveCodexProjectSession(projectId, { sessionId: state?.id ?? saved.current.sessionId, draft: message, candidates })) setNotice('浏览器未能保存会话绑定和输入草稿；可在会话详情中复制 ID 以便恢复。')
  }, [projectId, state?.id, message, candidates])

  const restore = useCallback(async (id: string) => {
    if (!id.trim()) return
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    setLoading(true); setError('')
    try {
      let next: CodexSessionState
      try { next = readOnly ? await getCodexSession(id.trim(), controller.signal) : await bindCodexWorkbench(id.trim(), projectId, controller.signal) }
      catch (reason) {
        if (readOnly) throw reason
        if (!(reason instanceof CodexSessionClientError) || reason.status !== 409 || controller.signal.aborted) throw reason
        // A stale/deep-linked ID never adopts another project's transcript. The
        // server resolves this project's canonical session without sending a turn.
        next = await createCodexSession(current.current, controller.signal, projectId)
        if (!controller.signal.aborted) setNotice('链接中的会话不属于当前项目，已连接当前项目的专属对话；原聊天记录保留。')
      }
      if (!controller.signal.aborted) {
        if ((latest.current?.id ?? saved.current.sessionId) && (latest.current?.id ?? saved.current.sessionId) !== next.id) { setCandidates([]); pendingSend.current = null }
        accept(next)
      }
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
    finally { if (request.current === controller) { request.current = null; setLoading(false) } }
  }, [accept,projectId,readOnly])
  useEffect(() => { const id=initialSessionId??saved.current.sessionId; if (id) void restore(id); return () => request.current?.abort() }, [restore,initialSessionId])
  useEffect(() => {
    if (readOnly || !state) return
    const id = state.id, controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const next = await getCodexSession(id, controller.signal)
        if (!controller.signal.aborted && latest.current?.id === id) accept(next)
      } catch (reason) { if (!controller.signal.aborted) setError(`连接暂时中断：${(reason as Error).message}。任务记录保存在本机，可重新连接。`) }
      if (!controller.signal.aborted && latest.current?.id === id) timer = setTimeout(refresh, latest.current.status === 'running' ? 1000 : 5000)
    }
    timer = setTimeout(refresh, running ? 500 : 5000)
    return () => { clearTimeout(timer); controller.abort() }
  }, [state?.id, running, accept, readOnly])

  async function create() {
    if (readOnly || locked || !available) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      const next = await createCodexSession(current.current, controller.signal, projectId)
      if (!controller.signal.aborted) { if (latest.current && latest.current.id !== next.id) { setCandidates([]); pendingSend.current = null }; accept(next); setNotice('已连接此项目的专属会话，后续继续使用同一段对话。') }
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
    finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }
  async function send(event: FormEvent) {
    event.preventDefault()
    if (readOnly || !message.trim()) return
    if (locked || !available) return
    await sendMessage(message.trim(), true)
  }
  async function sendMessage(sent: string, clearDraft: boolean, stableRequestId?: string): Promise<boolean> {
    if (readOnly || locked || !available || request.current || !sent.trim()) return false
    scrollToLatest()
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      let session = latest.current
      if (!session) { session = await createCodexSession(current.current, controller.signal, projectId); if (controller.signal.aborted) return false; accept(session) }
      // Explicitly retry a rejected turn with its original ID. The server can
      // distinguish notSent from an accepted turn whose acknowledgement was lost.
      const rejected = [...session.messages].reverse().find(item => item.role === 'user' && item.delivery === 'notSent' && item.content.trim() === sent)
      const requestId = stableRequestId ?? rejected?.requestId
      // Retain the request ID after a lost acknowledgement to avoid duplicate turns.
      if (pendingSend.current?.message !== sent || requestId && pendingSend.current?.id !== requestId) {
        const snapshot = structuredClone(current.current)
        const redrawSource = isSchematicRedrawRequest(sent) ? [...candidates].reverse().find(item => persistentCandidateState(item, snapshot) === 'ready') : undefined
        pendingSend.current = { message: sent, id: requestId ?? crypto.randomUUID(), project: snapshot, context: candidates.map(item => { const status = persistentCandidateState(item, snapshot); return `方案 ${item.requestId}：${status === 'applied' || status === 'already-present' ? '当前已包含方案改动' : status === 'ready' ? item.everApplied ? '已撤销，保留待再次应用' : '待审阅，尚未应用' : status === 'discarded' ? '已丢弃' : status === 'mergeable' ? '可与后续编辑合并，尚未应用' : '与后续编辑有冲突，尚未应用'}` }).join('\n'), ...(redrawSource ? { revision: { requestId: redrawSource.requestId, project: structuredClone(redrawSource.project), base: redrawSource.base } } : {}) }
      }
      const pending = pendingSend.current
      recoveredQuestions.current.delete(pending.id)
      const next = await sendCodexSession(session.id, sent, pending.id, controller.signal, pending.project, pending.context, projectId, pending.revision)
      if (!controller.signal.aborted) {
        accept(next); pendingSend.current = null
        if (clearDraft && next.status !== 'error') setMessage(value => value.trim() === sent ? '' : value)
        return !next.messages.some(item => item.role === 'user' && item.requestId === pending.id && item.delivery === 'notSent')
      }
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
    finally { if (request.current === controller) { request.current = null; setBusy(false) } }
    return false
  }
  useEffect(() => {
    if (readOnly || !externalTask || externalAttempt.current === externalTask.id || locked || !available || request.current) return
    externalAttempt.current = externalTask.id; setExternalFailed(false)
    // The caller retains this task across remounts. Reusing its request ID also
    // covers a completed server send whose acknowledgement was lost on navigation.
    void sendMessage(externalTask.prompt, false, `model-${externalTask.id}`).then(accepted => {
      if (accepted) { setCompletedExternal(externalTask.id); onExternalTaskConsumed?.(externalTask.id) }
      else setExternalFailed(true)
    })
  }, [externalTask, externalFailed, locked, available, onExternalTaskConsumed, readOnly])
  async function cancel() {
    if (readOnly || !state || busy || !running) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError('')
    try { const next = await cancelCodexSession(state.id, controller.signal); if (!controller.signal.aborted) accept(next) }
    catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
    finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }
  async function syncDesktop() {
    if (readOnly || !state || locked) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError('')
    try { const next = await refreshCodexDesktopSession(state.id, controller.signal); if (!controller.signal.aborted) { accept(next); setNotice(next.desktop?.message ?? '已同步同一 Codex 会话中的公开对话。') } }
    catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
    finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }
  async function checkWriteAccess() {
    if (readOnly || !state?.threadId || locked) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError(''); setNotice('正在检查同一会话的执行权，不会发送问题或启动模型。')
    try { const next = await checkCodexSessionWriteAccess(state.id, controller.signal); if (!controller.signal.aborted) { accept(next); setNotice('') } }
    catch (reason) { if (!controller.signal.aborted) { setNotice(''); setError((reason as Error).message) } }
    finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }
  function apply(candidate: CodexSessionCandidate, undo = false, conflictMode?:'merge'|'replace') {
    const resolution = resolveCandidateProject(candidate.baseline, candidate.project, current.current,
      candidate.lastApply ? aiProjectFingerprint(candidate.lastApply.after) : undefined)
    const status = candidate.discarded ? 'discarded' : resolution.status
    if (locked || undo && status !== 'applied' || !undo && status !== 'ready' && status !== 'mergeable' && !(status === 'conflict' && conflictMode)) return
    const before = structuredClone(current.current)
    if (conflictMode && (conflictChoice?.requestId !== candidate.requestId || conflictChoice.mode !== conflictMode || conflictChoice.canvas !== aiProjectFingerprint(before) || conflictChoice.proposal !== aiProjectFingerprint(candidate.project))) {
      setConflictChoice(null);setMergeErrors(previous=>({...previous,[candidate.requestId]:'画布或方案发生变化，请重新选择应用方式并查看预览。'}));return
    }
    const forced=conflictMode==='merge'?resolveCandidateProject(candidate.baseline,candidate.project,before,undefined,'prefer-candidate'):null
    if(forced&&(!forced.project||forced.status!=='mergeable')){setMergeErrors(previous=>({...previous,[candidate.requestId]:'合并后项目无法通过校验，请检查方案或选择恢复起点。'}));return}
    try {
      let target: Project
      if (undo) target = structuredClone(candidate.lastApply?.before ?? { ...candidate.baseline, ...(candidate.project.probes !== undefined && candidate.baseline.probes === undefined ? { probes: [] } : {}) })
      else target = structuredClone(conflictMode==='merge'?forced!.project!:conflictMode==='replace'?candidateWithWaveformSetup(candidate.baseline,candidate.project):resolution.project!)
      const applied = onApply(target, { undo, replace:conflictMode==='replace' })
      setMergeErrors(previous => { const next = { ...previous }; delete next[candidate.requestId]; return next })
      if (!undo) setCandidates(previous => previous.map(item => item.requestId === candidate.requestId ? { ...item, everApplied: true, lastApply: { before, after: structuredClone(applied ?? candidateWithWaveformSetup(before, target)) } } : item))
      setConflictChoice(null)
      setNotice(undo ? '已恢复本次应用前的电路；后续编辑的快照仍保存在候选记录和撤销历史中。' : status === 'mergeable' ? '方案已与后续编辑合并，当前项目会自动保存；Ctrl+Z 可撤销。' : '方案已应用到画布，可以继续追问或撤销。')
    } catch (reason) { setMergeErrors(previous => ({ ...previous, [candidate.requestId]: `未应用方案：${(reason as Error).message}` })) }
  }
  function createLocalRedraw(source: Project, baseline: Project): 'changed' | 'unchanged' | 'error' {
    if (!source.drawing) return 'error'
    try {
      const drawing = redrawDrawingLayout(source.drawing)
      const next: Project = { ...source, drawing, ...(source.probes !== undefined ? { probes: autoPlaceMeasurementProbes(drawing, source.probes, { preserveOffsets: false }) } : {}) }
      // Compare the real source project, including model/configuration invariants,
      // before making a candidate visible. Keep pre-existing incomplete electrical
      // drafts editable; structural parsing still rejects malformed references.
      // Probe placement changes only geometry.
      assertLayoutElectricalEquivalent(source, next)
      parseProject(next, { allowDraft: true })
      const quality = inspectDrawingQuality(drawing, { models: source.models })
      const examples = quality.issues.slice(0, 3).map(issue => issue.message).join('；')
      const remaining = quality.issueCount - Math.min(quality.issues.length, 3)
      const geometry = `几何估计检查${quality.complete ? '已完成' : '未完成'}，发现 ${quality.issueCount} 项待审阅问题${examples ? `：${examples}` : ''}${remaining > 0 ? `；另有 ${remaining} 项` : ''}。此计数不含探针标牌与波形图框，图面仍需人工审阅。`
      if (JSON.stringify(next) === JSON.stringify(source)) { setNotice(`本地排版没有找到更清晰的新位置，原候选已保留。${geometry}`); return 'unchanged' }
      const requestId = `local-redraw-${crypto.randomUUID()}`
      setCandidates(previous => [...previous, { requestId, summary: `本地重新排版；已核对器件参数、电气连接和仿真配置保持原样。${geometry}`, project: next, baseline, base: aiProjectFingerprint(baseline), everApplied: false, discarded: false }].slice(-6))
      setOpenedCandidate(requestId)
      setNotice(`本地重排已生成新候选，未发送给 Codex。请预览后应用；原方案仍保留。${geometry}`)
      return 'changed'
    } catch (reason) {
      setNotice(`本地重排未完成：${(reason as Error).message}。输入内容已保留。`)
      return 'error'
    }
  }
  function redrawLocally(candidate: CodexSessionCandidate): 'changed' | 'unchanged' | 'error' {
    if (persistentCandidateState(candidate, current.current) !== 'ready') return 'error'
    return createLocalRedraw(candidate.project, candidate.baseline)
  }
  function redrawCurrentLocally() {
    if (locked || !current.current.drawing) return
    const source = [...candidates].reverse().find(item => persistentCandidateState(item, current.current) === 'ready')
    if (source) redrawLocally(source)
    else createLocalRedraw(current.current, current.current)
  }

  useEffect(()=>{const items=state?.result?.modelAcquisitions;if(items?.length)onModelAcquisitions?.(items)},[state?.result?.modelAcquisitions,onModelAcquisitions])

  const steps = consolidateSteps(state?.events ?? [])
  const lastUser = state?.messages.filter(item => item.role === 'user').at(-1)
  const waitingForWriter = state?.status === 'error' && lastUser?.delivery === 'notSent'
  const resultMessage = state?.result ? state.messages.filter(item => item.role === 'assistant' && (state.resultRequestId ? item.requestId === state.resultRequestId : item.content === state.result?.summary)).at(-1) : null
  const resultIsCurrentTurn = !!resultMessage && resultMessage.requestId === lastUser?.requestId
  const simulation = state?.result?.simulation ?? state?.lastSimulation
  const progressStatus = state?.status === 'completed' ? 'done' : state?.status === 'cancelled' ? 'stopped' : state?.status === 'idle' ? null : state?.status
  return <section className="persistent-assistant" aria-label="项目 Codex 持久对话">
    <div className="persistent-status">{readOnly ? <><span>旧网页会话 · 历史记录</span><button type="button" aria-label="刷新已存记录" disabled={busy || loading || !(state?.id ?? saved.current.sessionId)} onClick={() => void restore(state?.id ?? saved.current.sessionId)}><RefreshCw size={13}/></button></> : <><span data-running={running || undefined}><i/>{loading ? '正在恢复' : waitingForWriter ? '问题待发送' : state ? statusLabels[state.status] : checking ? '正在连接 Codex' : available ? 'Codex 已就绪' : connectionError || connection?.message || 'Codex 尚未连接'}</span><button type="button" aria-label="刷新 Codex 连接" disabled={busy || checking} onClick={onRefresh}><RefreshCw size={13}/></button><button type="button" disabled={!!locked || !available} onClick={() => void create()} title="每个项目固定使用一段专属对话"><MessageSquarePlus size={14}/>连接项目会话</button></>}</div>
    {readOnly && <p className="ai-notice" role="status">这里只读取已保存的对话、未送达草稿与候选，不启动旧执行器。发送请切到桌面共享。</p>}
    {!readOnly && externalTask && externalTask.id !== completedExternal && <div className="ai-notice" role="status">{externalFailed ? '模型搜索任务尚未发送，原输入草稿已保留。' : externalAttempt.current === externalTask.id ? '正在发送模型搜索任务…' : '模型搜索任务已排队，连接就绪且当前回复结束后执行。'}{externalFailed && <button type="button" disabled={!!locked || !available} onClick={() => { externalAttempt.current = ''; setExternalFailed(false) }}>重试模型搜索任务</button>}</div>}
    {!readOnly && state?.threadId && <div className="persistent-desktop" title={state.desktop?.message || '同步桌面公开对话；桌面占用会话时需释放后才能在网页继续发送。'}><a href={`codex://threads/${encodeURIComponent(state.threadId)}`}>在桌面打开</a><button type="button" disabled={!!locked} onClick={() => void syncDesktop()}><RefreshCw size={13}/>同步桌面对话</button><button type="button" disabled={!!locked} onClick={() => void checkWriteAccess()}>检查网页续聊</button>{state.desktop?.syncStatus === 'synced' && <Check size={13} aria-label="桌面对话已同步"/>}</div>}
    <details className="persistent-session-details"><summary>会话详情{state?.model ? ` · ${state.model}` : ''}</summary>{readOnly ? <p>此处显示本机保存的历史快照，不同步或接管原生会话。原草稿和候选继续保留。</p> : <p>此项目绑定一段持久 Codex 会话，刷新或收起后可继续。网页侧支持模型搜索、下载与候选导入；桌面续聊遇到工具不支持时，请在对应项目网页继续执行。同步可读取桌面对话；桌面占用会话时需释放后才能在网页发送，完成桌面回复并不代表已经释放。</p>}{state?.desktop?.message && <p>{state.desktop.message}</p>}{!readOnly && <p>{connection?.installed ? `本机 Codex ${connection.version}` : '未检测到本机 Codex'} · {connection?.authenticated === true ? '已登录' : connection?.authenticated === false ? '未登录' : '登录状态未确认'}</p>}{state && <dl><dt>Session</dt><dd>{state.id}</dd><dt>Thread</dt><dd data-testid="persistent-thread-id">{state.threadId || '首轮发送后创建'}</dd><dt>推理强度</dt><dd>{state.reasoningEffort}</dd>{state.workbench&&<><dt>项目网页</dt><dd><a href={state.workbench.url} target="_blank" rel="noreferrer">打开此电路与对话</a></dd></>}{state.desktop?.projectName && <><dt>桌面项目</dt><dd>{state.desktop.projectName}</dd></>}</dl>}{!readOnly && <><label>恢复已有会话<input aria-label="恢复项目 Codex 会话 ID" value={restoreId} onChange={event => setRestoreId(event.target.value)} disabled={!!locked}/></label><button type="button" disabled={!!locked || !restoreId.trim()} onClick={() => void restore(restoreId)}>连接此会话</button></>}</details>
    <div ref={scrollArea} className="persistent-scroll" onScroll={() => { const area = scrollArea.current; if (!area) return; followBottom.current = area.scrollHeight - area.clientHeight - area.scrollTop <= 48; if (followBottom.current) setUnread(false) }}><div ref={scrollContent} className="persistent-scroll-content">
    {error && <div className="ai-error" role="alert"><p>{error}</p>{!readOnly && pendingSend.current && <button type="button" disabled={!!locked || !available} onClick={() => { const pending = pendingSend.current; if (pending) void sendMessage(pending.message, true, pending.id) }}>重试发送</button>}</div>}{notice && <p className="ai-notice" role="status">{notice}</p>}
    {!readOnly && (waitingForWriter || state?.writeAccess) && <div className="persistent-handoff" data-access={state?.writeAccess?.status ?? 'busy'} role="status"><strong>{state?.writeAccess?.status === 'available' ? '检查时可在网页续聊' : '尚未取得会话执行权'}</strong><p>{state?.writeAccess?.message ?? '问题已保留在输入框。请检查占用状态；同步历史不会解除桌面占用。'}</p>{state?.writeAccess?.checkedAt && <small>检测时间 {new Date(state.writeAccess.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · 只检查，不自动发送</small>}</div>}
    <div className="persistent-messages" aria-label="Codex 持久对话记录" aria-live="polite">
      {!state?.messages.length && (readOnly ? <p className="persistent-empty">暂无已保存的对话记录；浏览器中的原草稿和候选仍保留。</p> : <div className="persistent-empty"><strong>从电路目标开始，接着问为什么。</strong><p>我会读取当前画布、给出候选方案，并按需调用 ngspice。修改由你审阅后应用。</p><div><button type="button" onClick={() => setMessage('解释当前电路的工作原理、关键参数选择和模型局限；先不要修改电路。')}>解释当前电路</button><button type="button" onClick={() => setMessage('检查当前电路，运行适合的仿真并解释结果。')}>检查并仿真</button></div></div>)}
      {state?.messages.map(item => <article key={item.id} className={`persistent-message is-${item.role}`}><header><strong>{item.role === 'user' ? '你' : 'Codex'}</strong><time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></header>{item.role === 'assistant' ? <AssistantMarkdown>{item.content}</AssistantMarkdown> : <p>{item.content}</p>}{item.delivery === 'notSent' && <div className="persistent-not-sent"><small>未送达 Codex · 问题已保留</small><p>{readOnly ? '未送达内容已保留，发送请切到桌面共享。' : item.requestId === lastUser?.requestId ? state.error || state.writeAccess?.message || '此消息尚未发送，点击重试后才会提交给 Codex。' : '这条问题尚未发送。重试会携带当前画布及仍有效的候选。'}</p>{!readOnly && <button type="button" disabled={!!locked || !available} onClick={() => void sendMessage(item.content.trim(), true, item.requestId)}>重试发送</button>}</div>}</article>)}
    </div>
    {!!state?.result?.modelAcquisitions?.length&&onOpenModels&&<button type="button" className="assistant-model-shortcut" onClick={onOpenModels}>查看已下载模型（{state.result.modelAcquisitions.length}）</button>}
    {!readOnly && state && !waitingForWriter && progressStatus && (running || resultIsCurrentTurn || state.status === 'cancelled' || state.status === 'error') && <details className="persistent-progress" open={state.status !== 'completed'}><summary>{state.status === 'completed' ? `本轮完成 · ${steps.length} 次工具调用` : '本轮任务进度'}</summary><AgentTaskProgress status={progressStatus} steps={steps} startedAt={lastUser?.createdAt ?? state.createdAt} finishedAt={running ? undefined : state.updatedAt}/>{steps.length > 0 && <details open={running}><summary>本轮工具 · {steps.length} 步</summary><ol>{steps.map((step, index) => <li key={index} data-status={step.status}><strong>{toolLabels[step.name] ?? step.name}</strong><span>{step.status === 'completed' ? <><Check size={12}/>已完成</> : step.status === 'error' ? '失败' : running ? <><LoaderCircle className="step-loading-icon" size={13}/>执行中</> : '已中止'}</span><p>{step.detail}</p></li>)}</ol></details>}{state.error && <p className="ai-error" role="status">{state.error}</p>}</details>}
    {simulation && <details className="persistent-simulation" open={!!state?.result?.simulation && resultIsCurrentTurn} aria-label="保留的真实仿真">
      <summary><Check size={13}/>{simulation.engine} · {simulation.analysis.toUpperCase()} · {simulation.points} 点</summary><p>{state?.result?.simulation && resultIsCurrentTurn ? '本轮仿真记录' : '此前仿真记录 · 本轮未重新运行'} · {(simulation.elapsedMs / 1000).toFixed(2)} 秒</p>
      {simulation.stale && <p className="ai-error">电路在此后发生修改，结果需要重新验证。</p>}
      <dl>{simulation.analysis === 'noise' && simulation.noise ? <>
        <dt>输出噪声密度</dt><dd>{formatSI(simulation.output.minimum, 'V/√Hz')}～{formatSI(simulation.output.maximum, 'V/√Hz')}</dd>
        <dt>输入等效噪声密度</dt><dd>{formatSI(simulation.noise.input.minimum, `${simulation.noise.inputUnit}/√Hz`)}～{formatSI(simulation.noise.input.maximum, `${simulation.noise.inputUnit}/√Hz`)}</dd>
        {simulation.noise.totalOutput !== undefined && <><dt>积分输出噪声 RMS</dt><dd>{formatSI(simulation.noise.totalOutput, 'V')}</dd></>}
        {simulation.noise.totalInput !== undefined && <><dt>积分输入噪声 RMS</dt><dd>{formatSI(simulation.noise.totalInput, simulation.noise.inputUnit)}</dd></>}
      </> : simulation.analysis === 'ac' ? <><dt>峰值增益</dt><dd>{simulation.peakDb == null ? '—' : `${Number(simulation.peakDb.toFixed(3))} dB`}</dd><dt>对应频率</dt><dd>{simulation.peakFrequencyHz == null ? '—' : formatSI(simulation.peakFrequencyHz, 'Hz')}</dd></> : <><dt>输出范围</dt><dd>{formatSI(simulation.output.minimum, 'V')}～{formatSI(simulation.output.maximum, 'V')}</dd><dt>输出末值</dt><dd>{formatSI(simulation.output.last, 'V')}</dd></>}</dl>
      {simulation.warnings.length > 0 && <ul>{simulation.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    </details>}
    {candidates.map((candidate, index) => {
      const status = persistentCandidateState(candidate, project)
      const resolution = candidate.discarded ? null : resolveCandidateProject(candidate.baseline, candidate.project, project,
        candidate.lastApply ? aiProjectFingerprint(candidate.lastApply.after) : undefined)
      const choice = status==='conflict'&&conflictChoice?.requestId===candidate.requestId&&conflictChoice.canvas===aiProjectFingerprint(project)&&conflictChoice.proposal===aiProjectFingerprint(candidate.project)?conflictChoice:null
      const forced=choice?.mode==='merge'?resolveCandidateProject(candidate.baseline,candidate.project,project,undefined,'prefer-candidate'):null
      const choiceProject=choice?.mode==='replace'?candidateWithWaveformSetup(candidate.baseline,candidate.project):forced?.project
      const preview = choiceProject??(status === 'mergeable' ? resolution!.project! : resolution?.project ?? candidate.project)
      const conflictDetail = resolution?.conflicts?.length ? `冲突位置：${resolution.conflicts.slice(0, 4).join('、')}${resolution.conflicts.length > 4 ? ' 等' : ''}。` : ''
      return <details key={candidate.requestId} className="persistent-candidate" open={(candidate.requestId === lastUser?.requestId || candidate.requestId === openedCandidate) && status !== 'applied' && status !== 'discarded'} data-candidate-state={status}>
        <summary>{candidate.requestId.startsWith('local-redraw-') ? '本地排版' : '方案'} {index + 1} · {status === 'applied' ? '已应用' : status === 'ready' ? candidate.everApplied ? '已撤销，可再次应用' : '等待审阅' : status === 'discarded' ? '已丢弃' : status === 'mergeable' ? '可合并后续编辑' : status === 'already-present' ? '改动已在画布中' : '存在冲突'}</summary>
        {status !== 'discarded' && <>
          {candidate.requestId.startsWith('local-redraw-') && <p className="ai-notice">本地排版，未发送给 Codex；仅调整图形位置、走线和探针标牌。{candidate.summary}</p>}
          <AgentProposalPreview project={preview} baseline={choice||status === 'mergeable' ? project : candidate.baseline} proposalLabel={choice?'应用后原理图':status === 'mergeable' ? '合并后原理图' : undefined} baselineLabel={choice||status === 'mergeable' ? '当前画布' : undefined}/>
          {status === 'mergeable' && <p className="ai-notice">预览已包含后续编辑；确认后才会写入当前项目。</p>}
          {status === 'conflict' && <p className="ai-error">{conflictDetail}方案与后续编辑有冲突，请预览并选择应用方式。</p>}
          {status === 'conflict' && <div className="ai-actions" aria-label="方案冲突处理">
            <button type="button" disabled={!!locked} aria-pressed={choice?.mode==='merge'} onClick={()=>setConflictChoice({requestId:candidate.requestId,mode:'merge',canvas:aiProjectFingerprint(project),proposal:aiProjectFingerprint(candidate.project)})}>保留其他改动并应用</button>
            <button type="button" disabled={!!locked} aria-pressed={choice?.mode==='replace'} onClick={()=>setConflictChoice({requestId:candidate.requestId,mode:'replace',canvas:aiProjectFingerprint(project),proposal:aiProjectFingerprint(candidate.project)})}>恢复方案起点并应用</button>
            {choice&&<><p>{choice.mode==='merge'?'冲突字段使用方案值，其余手动编辑保留。':'方案生成后的手动编辑会被替换。'}上方预览是应用后的画布；应用前快照可用于撤销。</p><button type="button" className="primary" disabled={!!locked||!choiceProject} onClick={()=>apply(candidate,false,choice.mode)}>确认应用</button><button type="button" onClick={()=>setConflictChoice(null)}>取消</button></>}
            {choice?.mode==='merge'&&!choiceProject&&<p className="ai-error">合并后项目校验未通过，请检查方案或选择恢复起点。</p>}
          </div>}
          {mergeErrors[candidate.requestId]&&<p className="ai-error" role="alert">{mergeErrors[candidate.requestId]}</p>}
          <div className="ai-actions"><button type="button" className="primary" disabled={!!locked || status !== 'ready' && status !== 'mergeable'} onClick={() => apply(candidate)}><Check size={14}/>{status === 'applied' ? '当前已应用' : status === 'mergeable' ? '合并方案到当前画布' : candidate.everApplied ? '再次应用方案' : '应用方案（可撤销）'}</button>{!readOnly && <button type="button" disabled={!!locked || status !== 'ready'} title="只整理此候选的位置与走线，不调用 Codex" onClick={() => { void redrawLocally(candidate) }}><RefreshCw size={14}/>本地重排</button>}<button type="button" disabled={!!locked || status !== 'applied'} onClick={() => apply(candidate, true)}><Undo2 size={14}/>撤销应用</button><button type="button" disabled={!!locked} onClick={() => setCandidates(previous => previous.map(item => item.requestId === candidate.requestId ? { ...item, discarded: true } : item))}>丢弃候选</button></div>
        </>}
      </details>
    })}
    </div></div>
    {unread && <button className="persistent-new-message" type="button" onClick={scrollToLatest}><ArrowDown size={13}/>新消息 · 回到底部</button>}
    {readOnly ? <section className="persistent-compose"><label htmlFor={`codex-history-draft-${projectId}`}>保留的未送达草稿</label><textarea id={`codex-history-draft-${projectId}`} aria-label="旧网页会话草稿" value={message} readOnly rows={2}/><small>发送请切到桌面共享。</small></section> : <form ref={form} className="persistent-compose" onSubmit={send}><label htmlFor={`codex-prompt-${projectId}`}>继续这段对话</label><textarea id={`codex-prompt-${projectId}`} aria-label="AI 问题" value={message} onChange={event => setMessage(event.target.value)} rows={2} maxLength={8000} placeholder="说说目标，或说：画得不好看，请重新画" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); form.current?.requestSubmit() } }}/><div><button type="button" disabled={!!locked || !project.drawing} title="只运行本地排版，不调用 Codex；优先整理待审阅候选" onClick={redrawCurrentLocally}><RefreshCw size={13}/>本地整理</button><small title="将问题与当前画布一起发送给 Codex">Ctrl + Enter</small>{running ? <button type="button" disabled={busy} onClick={() => void cancel()}><Square size={14}/>停止本轮</button> : <button type="submit" className="primary" disabled={!!locked || !available || !message.trim()}><ArrowUp size={15}/>{busy ? '提交中' : '发送给 Codex'}</button>}</div></form>}
  </section>
}
