import { useEffect, useRef, useState, type FormEvent } from 'react'
import { RefreshCw, Send, Square } from 'lucide-react'
import { aiConversationContext, aiProjectFingerprint, type AiConversationMessage } from '../core/ai'
import { parseProject, type Project } from '../core/circuit'
import { getCursorStatus, requestCursorAgent, type CursorStatus } from '../core/cursor-client'
import { parseAgentSimulation, type AgentResult, type AgentToolEvent } from '../core/agent-client'
import { parseAgentProposal, parseAgentModelAcquisitions, type AgentModelAcquisition } from '../core/agent-models'
import { resolveCandidateProject } from '../core/candidate-resolution'
import { projectWithCandidateProbes } from '../core/project-probes'
import { useAssistantSettings } from '../core/assistant-settings'
import type { AssistantExternalTask } from '../core/model-search-task'
import AssistantMarkdown from './AssistantMarkdown'
import AgentProposalPreview from './AgentProposalPreview'

type Candidate = { baseline: Project; result: AgentResult; discarded?: boolean; applied?: { before: Project; after: string } }
type Saved = { draft: string; messages: AiConversationMessage[]; candidate?: Candidate; previous?: Candidate[] }
export const cursorConversationKey = (id: string) => `fuxian.cursor-conversation.v1:${encodeURIComponent(id)}`
function restoredCandidate(entry: Candidate): Candidate {
  const baseline = parseProject(entry.baseline, { allowDraft: true }), result = entry.result, acquisitions = parseAgentModelAcquisitions(result.modelAcquisitions)
  if (typeof result.summary !== 'string' || result.summary.length > 8000 || typeof result.changed !== 'boolean') throw new Error('invalid')
  return { baseline, discarded: entry.discarded === true, result: { summary: result.summary, changed: result.changed,
    proposal: parseAgentProposal(result.summary, result.proposal.project, baseline, acquisitions), simulation: parseAgentSimulation(result.simulation), modelAcquisitions: acquisitions },
    ...(entry.applied && typeof entry.applied.after === 'string' ? { applied: { before: parseProject(entry.applied.before, { allowDraft: true }), after: entry.applied.after } } : {}) }
}
function readSaved(id: string): Saved {
  const empty: Saved = { draft: '', messages: [] }
  try {
    const raw = localStorage.getItem(cursorConversationKey(id))
    if (!raw || raw.length > 2_000_000) return empty
    const value = JSON.parse(raw)
    const messages = Array.isArray(value.messages) ? value.messages.slice(-60).filter((item: AiConversationMessage) => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string' && item.content.length <= 8000) : []
    const draft = typeof value.draft === 'string' ? value.draft.slice(0, 8000) : ''
    let candidate: Candidate | undefined
    try { if (value.candidate) candidate = restoredCandidate(value.candidate) } catch { /* A corrupt candidate cannot delete the user's draft or conversation. */ }
    const previous = Array.isArray(value.previous) ? value.previous.slice(-5).flatMap((entry: Candidate) => { try { return [restoredCandidate(entry)] } catch { return [] } }) : []
    return { draft, messages, candidate, previous }
  } catch { return empty }
}

export default function CursorLocalAssistant({ projectId, project, onApply, onBusyChange, onModelAcquisitions, externalTask, onExternalTaskConsumed }: {
  projectId: string; project: Project; onApply: (project: Project, options?: { undo?: boolean; replace?: boolean }) => Project | void;
  onBusyChange?: (busy: boolean) => void; onModelAcquisitions?: (items: AgentModelAcquisition[]) => void;
  externalTask?: AssistantExternalTask; onExternalTaskConsumed?: (id: string) => void;
}) {
  const [saved, setSaved] = useState(() => readSaved(projectId))
  const [status, setStatus] = useState<CursorStatus | null>(null), [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [storageError, setStorageError] = useState(false)
  const [steps, setSteps] = useState<AgentToolEvent[]>([]), [stream, setStream] = useState(''), [pendingPrompt, setPendingPrompt] = useState('')
  const pending = useRef<AbortController | null>(null), statusPending = useRef<AbortController | null>(null), alive = useRef(true), current = useRef(project)
  const scroll = useRef<HTMLDivElement | null>(null), follow = useRef(true)
  current.current = project
  const settings = useAssistantSettings()
  const candidate = saved.candidate, resolution = candidate ? resolveCandidateProject(candidate.baseline, candidate.result.proposal.project, project, candidate.applied?.after) : null
  useEffect(() => {
    try { localStorage.setItem(cursorConversationKey(projectId), JSON.stringify(saved)); setStorageError(false) }
    catch { setStorageError(true) }
  }, [saved, projectId])
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [saved.messages.length, pendingPrompt, stream, steps.length])
  useEffect(() => {
    alive.current = true; void refresh()
    return () => { alive.current = false; pending.current?.abort(); statusPending.current?.abort(); onBusyChange?.(false) }
  }, [])
  useEffect(() => {
    if (!externalTask || busy || saved.draft.trim()) return
    setSaved(old => ({ ...old, draft: externalTask.prompt })); onExternalTaskConsumed?.(externalTask.id)
  }, [externalTask, busy, saved.draft, onExternalTaskConsumed])
  async function refresh() {
    statusPending.current?.abort(); const controller = new AbortController(); statusPending.current = controller; setChecking(true)
    try { const next = await getCursorStatus(controller.signal); if (alive.current && !controller.signal.aborted) { setStatus(next); setError('') } }
    catch (reason) { if (alive.current && !controller.signal.aborted) { setStatus(null); setError(reason instanceof Error ? reason.message : 'Cursor 状态检查失败') } }
    finally { if (alive.current && statusPending.current === controller) setChecking(false) }
  }
  async function send(event: FormEvent) {
    event.preventDefault()
    const text = saved.draft.trim()
    if (!text || busy || !status?.available) return
    const baseline = structuredClone(current.current), controller = new AbortController(); pending.current = controller
    setBusy(true); onBusyChange?.(true); setError(''); setSteps([]); setStream(''); setPendingPrompt(text)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 115000)
    try {
      const model = settings.nativeModels.cursor.trim()
      const result = await requestCursorAgent({ projectId, prompt: text, project: baseline, history: aiConversationContext(saved.messages), ...(model ? { model } : {}) }, event => {
        if (alive.current && event.type === 'tool') setSteps(old => [...old.slice(-34), event])
      }, controller.signal, text => { if (alive.current) setStream(text) })
      if (!alive.current || controller.signal.aborted) return
      setSaved(old => ({ ...old, draft: old.draft.trim() === text ? '' : old.draft,
        messages: [...old.messages, { role: 'user' as const, content: text }, { role: 'assistant' as const, content: result.summary }].slice(-60),
        ...(result.changed ? { candidate: { baseline, result }, previous: [...(old.previous ?? []), ...(old.candidate ? [old.candidate] : [])].slice(-5) } : {}) }))
      if (result.modelAcquisitions?.length) onModelAcquisitions?.(result.modelAcquisitions)
    } catch (reason) {
      if (alive.current) setError(timedOut ? 'Cursor 本轮超时，执行已停止。问题和原对话已保留，可重试。' : controller.signal.aborted ? '本轮已停止，问题和原对话已保留。' : reason instanceof Error ? reason.message : 'Cursor 本轮失败')
    } finally {
      clearTimeout(timer)
      if (alive.current) { setBusy(false); onBusyChange?.(false); setPendingPrompt(''); setStream('') }
      if (pending.current === controller) pending.current = null
    }
  }
  function apply() {
    if (!candidate || !resolution?.project) return
    try {
      const before = structuredClone(current.current), next = projectWithCandidateProbes(candidate.baseline, resolution.project).project
      const actual = onApply(next) ?? next
      setSaved(old => ({ ...old, candidate: { ...candidate, applied: { before, after: aiProjectFingerprint(actual) } } })); setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '候选应用失败，当前画布和候选已保留') }
  }
  function undo() {
    if (!candidate?.applied || candidate.applied.after !== aiProjectFingerprint(current.current)) return
    try { onApply(candidate.applied.before, { undo: true }); setSaved(old => ({ ...old, candidate: { ...candidate, applied: undefined } })); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '撤销失败，当前画布已保留') }
  }
  return <section className="desktop-control-assistant" aria-label="Cursor 项目对话">
    <div className="codex-status" role="status"><span>{checking ? '正在检查 Cursor…' : status?.message ?? '尚未连接 Cursor CLI'}</span><button type="button" disabled={busy || checking} onClick={() => { void refresh() }}><RefreshCw size={14}/>刷新连接</button></div>
    <small className="codex-session-note">每个项目保存独立的 Cursor CLI 对话，支持连续提问与电路工具；不会同步 Cursor 编辑器当前聊天。使用本机登录与配置。</small>
    {status && !status.available && <small><a href="https://cursor.com/docs/cli/installation" target="_blank" rel="noreferrer">安装 Cursor Agent CLI ↗</a> · 在终端运行 <code>agent login</code> 后刷新。</small>}
    <div className="desktop-control-scroll" ref={scroll} tabIndex={0} aria-label="Cursor 消息与电路任务" onScroll={() => { const area = scroll.current; if (area?.clientHeight) follow.current = area.scrollHeight - area.scrollTop - area.clientHeight < 48 }}>
    <div className="desktop-control-messages" aria-label="Cursor 对话记录" aria-live="polite">
      {!saved.messages.length && !busy && <p className="desktop-control-empty">可以直接问电路原理、讨论方案，或让 Cursor 读取当前电路、生成候选并运行 ngspice。</p>}
      {saved.messages.map((message, index) => <article className={`persistent-message is-${message.role}`} key={index}><header><strong>{message.role === 'user' ? '你' : 'Cursor'}</strong></header>{message.role === 'assistant' ? <AssistantMarkdown>{message.content}</AssistantMarkdown> : <p>{message.content}</p>}</article>)}
      {pendingPrompt && <article className="persistent-message is-user"><header><strong>你</strong></header><p>{pendingPrompt}</p></article>}
      {stream && <article className="persistent-message is-assistant"><header><strong>Cursor · 回复中</strong></header><AssistantMarkdown>{stream}</AssistantMarkdown></article>}
    </div>
    {!!steps.length && <details className="desktop-control-task"><summary>本轮电路工具 · {steps.length} 次更新</summary>{steps.map((step, index) => <p key={index}>{step.name} · {step.status} · {step.detail}</p>)}</details>}
    {saved.previous?.map((previous, index) => !previous.discarded && <details className="desktop-control-task" key={index}><summary>之前的电路候选 · {previous.result.summary}</summary><AgentProposalPreview project={previous.result.proposal.project} baseline={previous.baseline}/><button type="button" disabled={busy} onClick={() => setSaved(old => ({ ...old, candidate: previous, previous: [...(old.previous ?? []).filter((_, item) => item !== index), ...(old.candidate ? [old.candidate] : [])].slice(-5) }))}>继续审阅这份候选</button></details>)}
    {candidate && !candidate.discarded && <details className="desktop-control-task" open><summary>待审阅电路候选 · {resolution?.status === 'applied' ? '已应用' : resolution?.status === 'conflict' ? '与当前画布冲突' : '待应用'}</summary>
      <AgentProposalPreview project={candidate.result.proposal.project} baseline={candidate.baseline}/>
      {candidate.result.proposal.changes.map((change, index) => <p key={index}>{change}</p>)}
      {candidate.result.simulation && <p>真实 {candidate.result.simulation.engine} 仿真 · {candidate.result.simulation.points} 个数据点{candidate.result.simulation.stale || resolution?.simulationStale ? ' · 当前候选已改变，请重新仿真' : ''}</p>}
      {resolution?.conflicts?.map((conflict, index) => <p className="ai-error" key={index}>{conflict}</p>)}
      <button type="button" disabled={busy || !resolution?.project} onClick={apply}>审阅后应用候选</button>
      {candidate.applied && <button type="button" disabled={busy || candidate.applied.after !== aiProjectFingerprint(project)} onClick={undo}>撤销本次应用</button>}
      <button type="button" disabled={busy} onClick={() => setSaved(old => ({ ...old, candidate: { ...candidate, discarded: true } }))}>舍弃候选</button>
    </details>}
    {error && <p className="ai-error" role="alert">{error}</p>}
    {externalTask && saved.draft.trim() && <p role="status">新增助手任务正在等待当前草稿；发送或清空草稿后，会把新任务放入输入框。</p>}
    {busy && <p className="desktop-control-run-status" role="status">Cursor 正在继续此项目对话{steps.length ? '，已收到电路工具进度' : '，等待回复'}…</p>}
    </div>
    <form className="desktop-control-compose" onSubmit={send}><label htmlFor={`cursor-prompt-${projectId}`}>继续 Cursor 项目对话</label><textarea id={`cursor-prompt-${projectId}`} aria-label="Cursor 会话问题" value={saved.draft} onChange={event => setSaved(old => ({ ...old, draft: event.target.value }))} rows={3} maxLength={8000} placeholder="问原理、讨论方案，或描述电路修改目标" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }}/>
      {storageError && <small className="ai-error">浏览器未能保存草稿和对话，请保留输入内容。</small>}
      <div><small>{busy ? '本轮执行中，草稿保留' : 'Ctrl + Enter'}</small>{busy && <button type="button" onClick={() => pending.current?.abort()}><Square size={13}/>停止本轮</button>}<button type="submit" className="primary" disabled={busy || checking || !status?.available || !saved.draft.trim()}><Send size={14}/>发送给 Cursor</button></div>
    </form>
  </section>
}
