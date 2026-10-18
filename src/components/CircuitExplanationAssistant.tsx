import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, CircleAlert, LoaderCircle, Monitor, RefreshCw, Send, Square } from 'lucide-react'
import type { Project } from '../core/circuit'
import type { DesktopControlState } from '../core/desktop-control'
import type { DesktopCircuitConnection } from '../core/desktop-circuit-client'
import { desktopProjectsMatch } from '../core/desktop-circuit-client'
import { cancelExplanationTurn, DesktopControlRequestError, ensureExplanationThread, getExplanationState, handoffExplanationThread, reconnectExplanationControl, sendExplanationMessage } from '../core/desktop-control-client'
import AssistantMarkdown from './AssistantMarkdown'

const draftKey = (id: string) => `fuxian.explanation-draft.v1:${encodeURIComponent(id)}`
const pendingKey = (id: string) => `fuxian.explanation-pending.v1:${encodeURIComponent(id)}`
interface PendingQuestion { id: string; text: string; draft: string }
function savedDraft(id: string) { try { return localStorage.getItem(draftKey(id)) ?? '' } catch { return '' } }
function savedPending(id: string): PendingQuestion | null {
  try {
    const value = JSON.parse(localStorage.getItem(pendingKey(id)) ?? 'null')
    return value && typeof value.id === 'string' && typeof value.text === 'string' && typeof value.draft === 'string' ? value : null
  } catch { return null }
}

/** One persistent, project-bound Codex child conversation. It has no circuit writing tools. */
export default function CircuitExplanationAssistant({ projectId, project, circuit }: { projectId: string; project: Project; circuit?: DesktopCircuitConnection }) {
  const [state, setState] = useState<DesktopControlState | null>(null)
  const [draft, setDraft] = useState(() => savedDraft(projectId))
  const latestDraft = useRef(draft); latestDraft.current = draft
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [reconnect, setReconnect] = useState<{phase:'connecting'|'waiting'|'success'|'error';message:string}|null>(null)
  const actionInFlight = useRef(false)
  const reconnectRequest = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  const pending = useRef<PendingQuestion | null>(savedPending(projectId))
  const [awaitingReceipt, setAwaitingReceipt] = useState(!!pending.current)
  const latestTitle = useRef(project.title); latestTitle.current = project.title
  const currentProject = useRef(project); currentProject.current = project
  const snapshot = circuit?.state?.snapshot
  const canvasReady = circuit?.status === 'ready' && snapshot?.projectId === projectId && desktopProjectsMatch(snapshot.project, project)
  const latestSent = state?.messages.filter(message => message.role === 'user' && message.delivery === 'sent').at(-1)
  const duplicateDraft = !awaitingReceipt && !!draft.trim() && latestSent?.content === draft.trim()
  useEffect(() => { try { localStorage.setItem(draftKey(projectId), draft) } catch { /* Draft remains in the composer. */ } }, [projectId, draft])
  useEffect(() => () => reconnectRequest.current?.abort(), [])
  function reconcileReceipt(next: DesktopControlState) {
    const question = pending.current
    if (!question) return
    const receipt = next.messages.find(message => message.id === question.id && message.role === 'user' && message.content === question.text)
    if (receipt?.delivery !== 'sent' && receipt?.delivery !== 'failed') return
    if (receipt.delivery === 'sent') {
      if (latestDraft.current === question.draft) {
        latestDraft.current = ''
        try { localStorage.setItem(draftKey(projectId), '') } catch { /* React state still clears the composer. */ }
      }
      setDraft(old => old === question.draft ? '' : old)
    }
    pending.current = null
    setAwaitingReceipt(false)
    try { localStorage.removeItem(pendingKey(projectId)) } catch { /* Memory state still prevents a duplicate send. */ }
  }
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (actionInFlight.current) { timer = setTimeout(poll, 1800); return }
      const requestSequence = sequence.current
      try {
        const next = await getExplanationState(projectId, controller.signal)
        if (!controller.signal.aborted && requestSequence === sequence.current) {
          setState(next)
          if (next.threadId && next.connected && next.ready) setError('')
          reconcileReceipt(next)
        }
      } catch (reason) { if (!controller.signal.aborted && requestSequence === sequence.current) setError((reason as Error).message) }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1800)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [projectId])
  async function act(operation: () => Promise<DesktopControlState>) {
    if (actionInFlight.current) return
    actionInFlight.current = true
    sequence.current++
    setWorking(true); setError('')
    try { const next = await operation(); setState(next); reconcileReceipt(next) }
    catch (reason) { setError((reason as Error).message) }
    finally { actionInFlight.current = false; setWorking(false) }
  }
  async function connectExplanation() {
    if (actionInFlight.current) return
    const controller = new AbortController(); reconnectRequest.current = controller
    actionInFlight.current = true; sequence.current++; setWorking(true); setError('')
    setReconnect({phase:'connecting',message:'正在恢复桌面共享和此项目的解释子对话…'})
    try {
      const result = await reconnectExplanationControl(projectId, latestTitle.current, controller.signal)
      if (controller.signal.aborted) return
      if (result.state) { setState(result.state); reconcileReceipt(result.state) }
      if (result.stage === 'restart-required' || result.stage === 'waiting-desktop') {
        setReconnect({phase:'waiting',message:result.message}); return
      }
      const next = result.state
      if (result.stage !== 'connected' || !next?.threadId || !next.connected || !next.ready || !next.desktopConnected) {
        setReconnect({phase:'error',message:result.message || '解释子对话尚未连接，原问题已保留。'}); return
      }
      const canvas = await circuit?.retry()
      if (controller.signal.aborted) return
      if (!canvas || canvas.status !== 'ready' || canvas.state?.snapshot?.projectId !== projectId || !desktopProjectsMatch(canvas.state.snapshot.project, currentProject.current)) {
        setReconnect({phase:'error',message:canvas?.error || '解释子对话已连接，当前画布尚未同步。'}); return
      }
      setReconnect({phase:'success',message:next.pendingOwner ? '解释子对话已连接，等待当前任务结束后切回网页。' : next.owner === 'web' ? '解释子对话和画布已连接，可以继续提问。' : '解释子对话和画布已连接，切到网页后可提问。'})
    } catch (reason) {
      if (!controller.signal.aborted) setReconnect({phase:'error',message:(reason as Error).message})
    } finally {
      if (reconnectRequest.current === controller) reconnectRequest.current = null
      actionInFlight.current = false
      if (!controller.signal.aborted) setWorking(false)
    }
  }
  useEffect(() => {
    if (reconnect?.phase === 'waiting' && state?.connected && state.ready && state.desktopConnected) void connectExplanation()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnect?.phase, state?.connected, state?.ready, state?.desktopConnected])
  useEffect(() => {
    if (!state?.connected || !state.ready || !state.desktopConnected || state.threadId) return
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const attempt = async (delay: number) => {
      if (actionInFlight.current) { timer = setTimeout(() => void attempt(delay), 1000); return }
      actionInFlight.current = true; setWorking(true); setError('')
      try {
        const next = await ensureExplanationThread(projectId, latestTitle.current)
        if (!cancelled) setState(next)
      } catch (reason) {
        if (!cancelled) {
          setError((reason as Error).message)
          // Unknown creation outcomes remain guarded by the server's binding
          // journal. A later 409 stops retrying without creating another chat.
          if (!(reason instanceof DesktopControlRequestError) || [408, 501, 502, 503].includes(reason.status))
            timer = setTimeout(() => void attempt(Math.min(delay * 2, 30000)), delay)
        }
      } finally {
        actionInFlight.current = false
        setWorking(false)
      }
    }
    timer = setTimeout(() => void attempt(2500), 500)
    return () => { cancelled = true; clearTimeout(timer) }
  // The connection flags are stable across polls; the scheduled attempt owns
  // retries until a thread appears or connectivity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, !!state?.connected, !!state?.ready, !!state?.desktopConnected, !!state?.threadId])
  async function dispatchQuestion(entry: PendingQuestion) {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setWorking(true); setError('')
    try {
      const next = await sendExplanationMessage(projectId, entry.text, entry.id)
      setState(next)
      reconcileReceipt(next)
    } catch (reason) {
      setError((reason as Error).message)
      // These errors reject the request before a turn can start. Transport and
      // server errors may arrive after delivery, so retain their request ID.
      if (reason instanceof DesktopControlRequestError && [400, 409, 413].includes(reason.status)) {
        pending.current = null; setAwaitingReceipt(false)
        try { localStorage.removeItem(pendingKey(projectId)) } catch { /* The draft is still visible. */ }
      }
    } finally { actionInFlight.current = false; setWorking(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!state?.threadId || state.owner !== 'web' || state.busy || working || !canvasReady || !draft.trim() || pending.current) return
    const entry = { id: crypto.randomUUID(), text: draft.trim(), draft }
    pending.current = entry
    setAwaitingReceipt(true)
    try { localStorage.setItem(draftKey(projectId), draft); localStorage.setItem(pendingKey(projectId), JSON.stringify(entry)) } catch { /* Keep the in-memory receipt guard. */ }
    await dispatchQuestion(entry)
  }
  function clearDuplicateDraft() {
    if (!duplicateDraft || pending.current) return
    latestDraft.current = ''; setDraft('')
    try { localStorage.setItem(draftKey(projectId), '') } catch { /* React state still clears the composer. */ }
  }
  return <section className="circuit-explanation" aria-label="电路解释子对话">
    <div className="circuit-explanation-intro"><strong>电路解释</strong><p>这是当前项目的独立子对话。每次提问会附上最新画布快照，解释不会生成或应用绘图方案。</p></div>
    <div className="circuit-explanation-controls"><span>{reconnect?.phase === 'connecting' ? '正在恢复连接…' : reconnect?.phase === 'waiting' ? '等待桌面接入' : state?.connected && state.ready && state.desktopConnected ? '解释对话已连接' : '桌面连接未就绪'}</span><button type="button" disabled={working} onClick={() => void connectExplanation()}>{reconnect?.phase === 'connecting' ? <LoaderCircle className="desktop-control-spinner" size={14}/> : <RefreshCw size={14}/>} {reconnect?.phase === 'connecting' ? '连接中…' : '重新连接'}</button></div>
    {reconnect && <div className="desktop-control-reconnect-result" role="status" data-phase={reconnect.phase === 'connecting' ? 'checking' : reconnect.phase}>{reconnect.phase === 'connecting' ? <LoaderCircle className="desktop-control-spinner" size={16}/> : reconnect.phase === 'success' ? <Check size={16}/> : reconnect.phase === 'waiting' ? <Monitor size={16}/> : <CircleAlert size={16}/>}<span>{reconnect.message}{reconnect.phase === 'waiting' && <small>桌面接入后会自动继续，原问题和对话已保留。</small>}</span></div>}
    {reconnect?.phase !== 'connecting' && reconnect?.phase !== 'waiting' && (error || state?.error) && <p className="ai-error" role="alert">{error || state?.error}</p>}
    {!state?.threadId && <div className="circuit-explanation-start"><p>{state?.desktopConnected ? '正在建立专属解释对话…' : '点击重新连接，恢复桌面共享并连接专属解释对话。'}</p><button type="button" disabled={working} onClick={() => void connectExplanation()}>连接解释子对话</button></div>}
    {state?.threadId && <>
      <div className="circuit-explanation-controls"><span><i className={`state-dot ${state.owner === 'web' ? '' : 'amber'}`}/>{state.busy ? '正在解释…' : state.owner === 'web' ? '网页可提问' : '桌面控制中'}</span>{state.owner !== 'web' && <button type="button" disabled={working || !state.connected || state.busy} onClick={() => void act(() => handoffExplanationThread(projectId, 'web'))}><Monitor size={13}/>切到网页</button>}</div>
      <div className="circuit-explanation-messages" aria-live="polite">{state.messages.length ? state.messages.map(message => <article key={message.id} className={message.role === 'user' ? 'ai-message-user' : 'ai-message-assistant'}><strong>{message.role === 'user' ? '你' : '电路解释'}</strong><AssistantMarkdown>{message.content}</AssistantMarkdown>{message.delivery === 'unknown' && <small>送达状态待核对</small>}{message.delivery === 'failed' && <small>发送失败，问题仍保留在输入框</small>}</article>) : <p>可以问电流路径、器件作用、参数选择或仿真结果的含义。</p>}</div>
      <form className="circuit-explanation-compose" onSubmit={submit}><label htmlFor={`circuit-explanation-${projectId}`}>提问当前电路</label><textarea id={`circuit-explanation-${projectId}`} aria-label="电路解释问题" value={draft} maxLength={8000} rows={3} onChange={event => { latestDraft.current = event.target.value; setDraft(event.target.value) }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="例如：这条电流路径为什么这样连接？"/><div>{!canvasReady && <small>等待当前画布同步后可提问</small>}{awaitingReceipt && <small>正在核对上一条消息的送达状态，草稿已保留；重试会沿用原消息编号</small>}{awaitingReceipt && <button type="button" disabled={working || !canvasReady || !state.connected || !state.ready || state.owner !== 'web' || state.busy} onClick={() => { if (pending.current) void dispatchQuestion(pending.current) }}>重试原消息</button>}{duplicateDraft && <button type="button" onClick={clearDuplicateDraft}>清空已发送内容</button>}{state.busy && <span><LoaderCircle className="desktop-control-spinner" size={14}/>正在回答</span>}{state.busy && state.owner === 'web' && <button type="button" disabled={working} onClick={() => void act(() => cancelExplanationTurn(projectId))}><Square size={13}/>停止</button>}<button type="submit" className="primary" disabled={!draft.trim() || !canvasReady || state.owner !== 'web' || state.busy || working || awaitingReceipt}><Send size={14}/>发送</button></div></form>
    </>}
  </section>
}
