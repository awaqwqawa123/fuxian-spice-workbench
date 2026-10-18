import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, Check, ExternalLink, RefreshCw, Send, Square, Undo2 } from 'lucide-react'
import type { Project } from '../core/circuit'
import type { HapiApproval, HapiSessionState, HapiStatus } from '../core/hapi-types'
import { answerHapiApproval, cancelHapiSession, connectHapiSession, getHapiSession, getHapiStatus, hapiTerminalCommand, readHapiDraft, saveHapiDraft, sendHapiMessage, type HapiDraft } from '../core/hapi-client'
import { cancelDesktopCircuitTask, desktopCandidateState, desktopProjectsMatch, type DesktopCircuitConnection } from '../core/desktop-circuit-client'
import type { DesktopCircuitTask } from '../core/desktop-circuit'
import type { AgentToolEvent } from '../core/agent-client'
import type { AgentModelAcquisition } from '../core/agent-models'
import type { AssistantExternalTask } from '../core/model-search-task'
import AssistantMarkdown from './AssistantMarkdown'
import AgentProposalPreview from './AgentProposalPreview'

const toolNames: Record<string, string> = {configure_waveforms:'配置波形图',set_measurement_probes:'放置测量探针',  inspect_circuit: '读取当前电路', set_component_value: '调整器件参数', replace_candidate: '更新候选电路', validate_circuit: '检查电气连接', simulate_circuit: '运行 ngspice', search_spice_models: '搜索器件模型', download_spice_model: '下载模型源码', import_spice_model: '导入候选模型' }
function stepsFor(events: AgentToolEvent[]) {
  const steps: AgentToolEvent[] = []
  for (const event of events) {
    let index = steps.length - 1
    while (index >= 0 && (steps[index].name !== event.name || steps[index].status !== 'running')) index--
    if (event.status !== 'running' && index >= 0) steps[index] = event
    else steps.push(event)
  }
  return steps
}
function ApprovalCard({ item, disabled, onAnswer }: { item: HapiApproval; disabled: boolean; onAnswer: (decision: 'approve' | 'deny', answers?: Record<string, string[]>) => void }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const result = Object.fromEntries((item.questions ?? []).map(q => [q.id, [...(answers[q.id] ?? []), ...(custom[q.id]?.trim() ? [custom[q.id].trim()] : [])]]))
  return <section className="hapi-approval" aria-label={item.title}><strong>{item.title}</strong><pre>{item.detail}</pre>{item.questions?.map(q => <fieldset key={q.id} disabled={disabled}><legend>{q.question}</legend>{q.options.map(option => <label key={option.label}><input type={q.multiSelect ? 'checkbox' : 'radio'} name={`hapi-${item.id}-${q.id}`} checked={answers[q.id]?.includes(option.label) ?? false} onChange={event => setAnswers(old => ({ ...old, [q.id]: q.multiSelect ? event.target.checked ? [...(old[q.id] ?? []), option.label] : (old[q.id] ?? []).filter(value => value !== option.label) : [option.label] }))}/><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}<input aria-label={`${q.question}：补充回答`} placeholder="补充回答" value={custom[q.id] ?? ''} maxLength={2000} onChange={event => setCustom(old => ({ ...old, [q.id]: event.target.value }))}/></fieldset>)}<div className="ai-actions"><button type="button" className="primary" disabled={disabled || item.kind === 'question' && Object.values(result).some(values => !values.length)} onClick={() => onAnswer('approve', item.kind === 'question' ? result : undefined)}>{item.kind === 'question' ? '提交回答' : '允许本次'}</button><button type="button" disabled={disabled} onClick={() => onAnswer('deny')}>拒绝</button></div></section>
}

export interface HapiAssistantProps {
  projectId: string; project: Project; circuit?: DesktopCircuitConnection
  onApply: (project: Project, options?: { undo?: boolean }) => void; onBusyChange?: (busy: boolean) => void
  onModelAcquisitions?: (items: AgentModelAcquisition[]) => void
  externalTask?: AssistantExternalTask; onExternalTaskConsumed?: (id: string) => void
}
export default function HapiAssistant(props: HapiAssistantProps) { return <ProjectHapiAssistant key={props.projectId} {...props}/> }
function ProjectHapiAssistant({ projectId, project, circuit, onApply, onBusyChange, onModelAcquisitions, externalTask, onExternalTaskConsumed }: HapiAssistantProps) {
  const saved = useRef(readHapiDraft(projectId))
  const [draft, setDraft] = useState(saved.current.draft)
  const [pending, setPending] = useState<HapiDraft['pending']>(saved.current.pending)
  const pendingRef = useRef(pending); pendingRef.current = pending
  const [state, setState] = useState<HapiSessionState | null>(null)
  const [status, setStatus] = useState<HapiStatus | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [stopError, setStopError] = useState('')
  const [busy, setBusy] = useState(false), [checking, setChecking] = useState(true)
  const [applied, setApplied] = useState<string[]>([])
  const latest = useRef(state), current = useRef(project); current.current = project
  const alive = useRef(true), operation = useRef<AbortController | null>(null), polling = useRef(false)
  const scroll = useRef<HTMLDivElement>(null), followBottom = useRef(true)
  const scrollContent = useRef<HTMLDivElement>(null), lastScrollTop = useRef(0)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const externalSeen = useRef('')
  const snapshot = circuit?.state?.snapshot
  const canvasReady = circuit?.status === 'ready' && snapshot?.projectId === projectId && desktopProjectsMatch(snapshot.project, project)
  const tasks = (circuit?.state?.tasks ?? []).filter(task => task.projectId === projectId)
  const latestUserAt = Math.max(0, ...(state?.messages.filter(message => message.role === 'user').map(message => message.createdAt) ?? []))
  const running = state?.status === 'running'
  const terminalCommand = state?.sessionId ? hapiTerminalCommand(circuit?.state?.cliPath, state.sessionId) : null
  const accept = useCallback((next: HapiSessionState) => {
    if (!alive.current || next.projectId !== projectId || latest.current && next.updatedAt < latest.current.updatedAt) return
    latest.current = next; setState(next); setError('')
    const expected = pendingRef.current, delivered = expected && next.messages.find(message => message.id === expected.id && message.role === 'user')
    if (delivered && (delivered.delivery === undefined || delivered.delivery === 'sent' || delivered.delivery === 'queued')) {
      setPending(undefined); pendingRef.current = undefined; setDraft(value => value.trim() === expected!.message ? '' : value)
    }
    if (delivered?.delivery === 'failed') { setPending(undefined); pendingRef.current = undefined; setNotice('HAPI 已确认发送失败，草稿保留；可编辑后重新发送。') }
  }, [projectId])
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (polling.current || operation.current) return
    polling.current = true
    try {
      const next = await getHapiSession(projectId, signal)
      if (!signal?.aborted && alive.current) accept(next)
    } catch (reason) { if (!signal?.aborted && alive.current) setError((reason as Error).message) }
    finally { polling.current = false }
  }, [projectId, accept])
  const refreshStatus = useCallback(async () => {
    setChecking(true)
    try { const next = await getHapiStatus(); if (alive.current) { setStatus(next); setError('') } }
    catch (reason) { if (alive.current) setError((reason as Error).message) }
    finally { if (alive.current) setChecking(false) }
  }, [])
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    void refreshStatus()
    async function poll() { await refresh(controller.signal); if (!controller.signal.aborted) timer = setTimeout(poll, latest.current?.status === 'running' ? 1000 : 2000) }
    void poll()
    return () => { alive.current = false; controller.abort(); operation.current?.abort(); clearTimeout(timer) }
  }, [refresh, refreshStatus])
  useEffect(() => { if (!saveHapiDraft(projectId, { draft, ...(pending ? { pending } : {}) })) setNotice('浏览器无法保存草稿，请在关闭页面前保留输入内容。') }, [projectId, draft, pending])
  useEffect(() => { onBusyChange?.(busy || !!running); return () => onBusyChange?.(false) }, [busy, running, onBusyChange])
  const followLatest = useCallback(() => {
    const area = scroll.current
    // A hidden tab has no viewport. Keep its follow preference until it reopens.
    if (!area || !area.clientHeight) return
    if (followBottom.current) area.scrollTop = Math.max(0, area.scrollHeight - area.clientHeight)
    lastScrollTop.current = area.scrollTop
    setAwayFromBottom(area.scrollHeight - area.scrollTop - area.clientHeight > 48)
  }, [])
  // Content can change without the HAPI timestamp changing (streamed text, tool
  // updates), so follow the committed DOM, not only the server's updatedAt field.
  useLayoutEffect(followLatest)
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !scroll.current || !scrollContent.current) return
    const observer = new ResizeObserver(followLatest)
    observer.observe(scroll.current); observer.observe(scrollContent.current)
    return () => observer.disconnect()
  }, [followLatest])
  function pauseFollowing() {
    const area = scroll.current
    if (area && area.scrollHeight > area.clientHeight + 48) { followBottom.current = false; setAwayFromBottom(true) }
  }
  function scrollChanged() {
    const area = scroll.current
    if (!area || !area.clientHeight) return
    const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight <= 48
    if (atBottom) followBottom.current = true
    // Content growth also fires scroll events. Only upward movement suspends
    // following; staying at the old top while content grows must not do that.
    else if (area.scrollTop < lastScrollTop.current - 1) followBottom.current = false
    lastScrollTop.current = area.scrollTop
    setAwayFromBottom(!atBottom)
  }
  function jumpToLatest() { followBottom.current = true; setAwayFromBottom(false); followLatest() }
  useEffect(() => {
    if (!externalTask || externalSeen.current === externalTask.id) return
    externalSeen.current = externalTask.id
    setDraft(old => old.trim() ? `${old}\n\n${externalTask.prompt}` : externalTask.prompt)
    setNotice('任务已填入当前项目草稿，点击发送后交给 HAPI；尚未发送。'); onExternalTaskConsumed?.(externalTask.id)
  }, [externalTask, onExternalTaskConsumed])
  const acquisitions = JSON.stringify(tasks.flatMap(task => task.result?.modelAcquisitions ?? []))
  useEffect(() => { const values = JSON.parse(acquisitions) as AgentModelAcquisition[]; if (values.length) onModelAcquisitions?.(values) }, [acquisitions, onModelAcquisitions])

  async function perform(action: (signal: AbortSignal) => Promise<HapiSessionState>) {
    if (operation.current) return false
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError('')
    try { const next = await action(controller.signal); if (alive.current && !controller.signal.aborted) { accept(next); return true } }
    catch (reason) { if (alive.current && !controller.signal.aborted) setError((reason as Error).message) }
    finally { if (operation.current === controller) { operation.current = null; if (alive.current) setBusy(false) } }
    return false
  }
  async function connect() {
    if (!canvasReady || !status?.available) return
    await perform(signal => connectHapiSession(projectId, structuredClone(current.current), signal))
  }
  async function send(event?: FormEvent) {
    event?.preventDefault()
    if (!state?.sessionId || busy || !canvasReady || !draft.trim() && !pendingRef.current) return
    const next = pendingRef.current ?? { id: crypto.randomUUID(), message: draft.trim() }
    pendingRef.current = next; setPending(next)
    saveHapiDraft(projectId, { draft, pending: next })
    await perform(signal => sendHapiMessage(projectId, next.message, next.id, signal))
  }
  async function stopAll() {
    if (operation.current) return
    const controller = new AbortController(); operation.current = controller; setBusy(true); setStopError(''); setNotice('')
    const actions: { label: string; run: () => Promise<unknown> }[] = []
    if (latest.current?.sessionId && latest.current.status === 'running') actions.push({ label: 'HAPI 会话', run: async () => { const next = await cancelHapiSession(projectId, controller.signal); if (!controller.signal.aborted) accept(next) } })
    for (const task of tasks.filter(item => item.status === 'running')) actions.push({ label: `电路任务 ${task.id}`, run: () => cancelDesktopCircuitTask(projectId, task.id, controller.signal) })
    try {
      const results = await Promise.allSettled(actions.map(action => action.run()))
      if (!alive.current || controller.signal.aborted) return
      const failures = results.flatMap((result, index) => result.status === 'rejected' ? [`${actions[index].label}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : [])
      if (failures.length) setStopError(`部分停止请求失败，请重试。${failures.join('；')}`)
      else setNotice('已提交停止请求；任务记录和候选保留。')
      circuit?.refresh()
    } finally {
      if (operation.current === controller) { operation.current = null; if (alive.current) setBusy(false) }
    }
  }
  function applyTask(task: DesktopCircuitTask, undo = false) {
    const target = desktopCandidateState(task, current.current)
    if (busy || undo && target !== 'applied' || !undo && target !== 'ready' || !task.result) return
    const next = structuredClone(undo ? { ...task.baseline, ...(task.result.proposal.project.probes !== undefined && task.baseline.probes === undefined ? { probes: [] } : {}) } : task.result.proposal.project)
    try { onApply(next, { undo }) } catch (reason) { setNotice(`未应用方案：${(reason as Error).message}`); return }
    current.current = next
    if (!undo) setApplied(old => old.includes(task.id) ? old : [...old, task.id])
    setNotice(undo ? '已恢复应用前的电路；候选保留，可以再次应用。' : '候选已应用，可撤销后再次应用。')
  }
  return <section className="hapi-assistant" aria-label="HAPI 共享电路会话">
    <div className="hapi-status"><span data-ready={!!status?.available}><i/>{checking ? '检查 HAPI…' : status?.available ? 'HAPI 已连接' : 'HAPI 暂不可用'}</span><button type="button" aria-label="刷新 HAPI 连接" disabled={checking || busy} onClick={() => { void refreshStatus(); void refresh() }}><RefreshCw size={14}/></button></div>
    <p className="hapi-intro">终端和网页继续同一个 HAPI 会话。Codex 执行任务，电路修改在这里预览后应用。</p>
    <details className="hapi-connection-details"><summary>连接与终端{status?.version ? ` · ${status.version}` : ''}</summary><p>{status?.message ?? '正在检查本机 Hub 和 Runner'}</p><p>这是 HAPI 管理的 Codex 会话，与官方 Codex 桌面旧聊天分开。</p>{state?.sessionId && <>{terminalCommand ? <><p>在本机 PowerShell 继续：</p><code>{terminalCommand}</code><small>启动器自动使用此工作台的 HAPI 配置。</small></> : <p>电路工具连接就绪后会显示本机终端启动命令；请保持同一 HAPI Hub 与登录配置。</p>}</>}{status?.hubUrl && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/.test(status.hubUrl) && <a href={status.hubUrl} target="_blank" rel="noreferrer">打开 HAPI <ExternalLink size={12}/></a>}{state?.threadId && <small>Codex Thread：{state.threadId}</small>}</details>
    <div className="hapi-canvas-sync" role="status">{canvasReady ? '当前画布已同步到电路工具' : circuit?.status === 'conflict' ? '另一页面保存了不同画布，请确认使用当前画布。' : circuit?.error || '正在同步当前画布…'}{(circuit?.status === 'conflict' || circuit?.status === 'error') && <button type="button" onClick={circuit.reconnect}>以当前画布连接</button>}</div>
    {!state?.sessionId && <button className="hapi-connect primary" type="button" disabled={!canvasReady || busy || checking || !status?.available} onClick={() => void connect()}>{busy ? '连接中…' : '连接 HAPI 会话'}</button>}
    <div className="hapi-scroll" ref={scroll} tabIndex={0} aria-label="HAPI 消息与电路任务" onScroll={scrollChanged} onWheel={event => { if (event.deltaY < 0) pauseFollowing() }} onKeyDown={event => { if (!(event.target instanceof HTMLElement) || event.target.matches('input, textarea, select, [contenteditable=true]')) return; if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) pauseFollowing() }}><div ref={scrollContent} className="hapi-scroll-content">
      {error && <p className="ai-error" role="alert">{error}</p>}{stopError && <p className="ai-error hapi-stop-error" role="alert">{stopError}</p>}{state?.error && <p className="ai-error" role="status">{state.error}</p>}{notice && <p className="ai-notice" role="status">{notice}</p>}
      <div className="hapi-messages" aria-label="HAPI 对话记录" aria-live="polite">{!state?.messages.length && <p className="hapi-empty">连接后描述电路目标，或要求重画并说明需要调整的位置。</p>}{state?.messages.map(message => <article key={message.id} className={`persistent-message is-${message.role}`}><header><strong>{message.role === 'user' ? '你' : 'Codex · HAPI'}</strong><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></header>{message.role === 'assistant' ? <AssistantMarkdown>{message.content}</AssistantMarkdown> : <p>{message.content}</p>}{message.delivery && message.delivery !== 'sent' && <small className="hapi-delivery">{message.delivery === 'queued' ? '已进入 HAPI 队列' : message.delivery === 'unknown' ? '送达状态待核对' : '发送失败'}</small>}</article>)}</div>
      {running && <p className="hapi-working" role="status">Codex 正在处理 · 等待真实回复或电路工具结果</p>}
      {state?.approvals.map(item => <ApprovalCard key={item.id} item={item} disabled={busy} onAnswer={(decision, answers) => { void perform(signal => answerHapiApproval(projectId, item.id, decision, answers, signal)) }}/>) }
      {tasks.map(task => {
        const result = task.result, candidate = desktopCandidateState(task, project), steps = stepsFor(task.events)
        return <details className="hapi-circuit-task" key={task.id} open={task === tasks.at(-1) && (task.status === 'running' || !(latestUserAt > Date.parse(task.updatedAt)))} data-candidate-state={candidate}><summary>电路工具 · {task.status === 'running' ? '执行中' : task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败' : task.status === 'cancelled' ? '已取消' : '已中断'} · {steps.length} 步</summary><p>{task.request}</p><ol className="hapi-tool-events">{steps.map((step, index) => <li key={index} data-status={step.status}><strong>{toolNames[step.name] ?? step.name}</strong><span>{step.status === 'completed' ? '完成' : step.status === 'error' ? '失败' : task.status === 'running' ? '进行中' : '已中止'}</span><p>{step.detail}</p></li>)}</ol>{task.error && <p className="ai-error">{task.error}</p>}{result && <><AssistantMarkdown>{result.summary}</AssistantMarkdown>{result.simulation && <p className="hapi-simulation">{result.simulation.engine} · {result.simulation.analysis.toUpperCase()} · {result.simulation.points} 个采样点{result.simulation.stale ? ' · 电路修改后需重新仿真' : ''}</p>}{result.changed && task.status === 'completed' && <><AgentProposalPreview project={result.proposal.project} baseline={task.baseline}/>{!!result.proposal.warnings.length && <ul>{result.proposal.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}<p className={candidate === 'conflict' ? 'ai-error' : 'hapi-candidate-state'}>{candidate === 'conflict' ? '画布已有后续编辑；重新生成方案，避免覆盖后续编辑。' : candidate === 'applied' ? '当前画布已应用此方案。' : applied.includes(task.id) ? '方案已撤销，可以再次应用。' : '候选等待审阅，尚未修改画布。'}</p><div className="ai-actions"><button type="button" className="primary" disabled={busy || candidate !== 'ready'} onClick={() => applyTask(task)}><Check size={14}/>{candidate === 'applied' ? '当前已应用' : applied.includes(task.id) ? '再次应用方案' : '应用方案（可撤销）'}</button><button type="button" disabled={busy || candidate !== 'applied'} onClick={() => applyTask(task, true)}><Undo2 size={14}/>撤销应用</button></div></>}</>}</details>
      })}
    </div></div>
    {awayFromBottom && <button className="hapi-jump-latest" type="button" onClick={jumpToLatest}><ArrowDown size={13}/>回到最新</button>}
    <form className="hapi-compose" onSubmit={send}><label htmlFor={`hapi-prompt-${projectId}`}>继续 HAPI 会话</label><textarea id={`hapi-prompt-${projectId}`} aria-label="HAPI 问题" value={draft} onChange={event => setDraft(event.target.value)} rows={3} maxLength={8000} placeholder="描述电路目标，或说说希望怎样重画" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }}/>{pending && <small className="hapi-pending" role="status">上次发送待确认；重试使用同一编号核对，不另发重复请求。{pending.message !== draft.trim() && ` 待确认内容：${pending.message.slice(0, 100)}`}</small>}<div><small>{state?.sessionId ? 'Ctrl + Enter' : '先连接项目会话'}</small>{(running || tasks.some(task => task.status === 'running')) && <button type="button" disabled={busy} onClick={() => void stopAll()}><Square size={13}/>停止本轮</button>}<button type="submit" className="primary" disabled={busy || !state?.sessionId || !canvasReady || !draft.trim() && !pending}><Send size={14}/>{busy ? '提交中…' : pending ? '核对并重试' : running ? '发送到队列' : '发送给 Codex'}</button></div></form>
  </section>
}
