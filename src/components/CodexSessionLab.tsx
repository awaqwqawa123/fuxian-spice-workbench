import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUp, Check, CirclePause, CircleStop, FlaskConical, MessageSquarePlus, RefreshCw, Square, TriangleAlert, Unplug } from 'lucide-react'
import { formatSI, type Project } from '../core/circuit'
import { editorTemplate } from '../core/editor'
import { CODEX_SESSION_STORAGE, cancelCodexSession, createCodexSession, getCodexSession, sendCodexSession, type CodexSessionState } from '../core/codex-session-client'
import type { AgentToolEvent } from '../core/agent-client'
import AssistantMarkdown from './AssistantMarkdown'
import AgentProposalPreview from './AgentProposalPreview'
import AgentTaskProgress from './AgentTaskProgress'

const labels = { idle: '会话已就绪', running: 'Codex 正在处理', completed: '本轮已完成', interrupted: '本轮已中断', error: '本轮未完成', cancelled: '本轮已停止' }
const toolLabels: Record<string, string> = {configure_waveforms:'配置波形图',set_measurement_probes:'放置测量探针',  inspect_circuit: '读取电路', replace_candidate: '更新候选', set_component_value: '调整参数', validate_circuit: '检查连接', simulate_circuit: '运行 ngspice' }
function savedSession() { try { return localStorage.getItem(CODEX_SESSION_STORAGE) ?? '' } catch { return '' } }
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

/** An isolated app-owned Codex thread; never reads or changes the editor's project storage. */
export default function CodexSessionLab({ initialProject }: { initialProject?: Project }) {
  const seed = useRef(initialProject ?? editorTemplate('rc-lowpass'))
  const [state, setState] = useState<CodexSessionState | null>(null)
  const [restoreId, setRestoreId] = useState(savedSession)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(!!restoreId)
  const request = useRef<AbortController | null>(null)
  const latest = useRef<CodexSessionState | null>(null)
  const restoring = useRef(restoreId)
  const form = useRef<HTMLFormElement>(null)
  const running = state?.status === 'running'
  const accept = useCallback((next: CodexSessionState) => {
    // A late polling response must not overwrite a newer submit/cancel response.
    if (latest.current?.id === next.id && next.updatedAt < latest.current.updatedAt) return
    latest.current = next; setState(next); setRestoreId(next.id); setError('')
    try { localStorage.setItem(CODEX_SESSION_STORAGE, next.id) } catch { setNotice('浏览器未能记住会话 ID；请复制下方 ID，以便刷新后手动恢复。') }
  }, [])

  const restore = useCallback(async (id: string) => {
    if (!id.trim()) return
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    setLoading(true); setError(''); setNotice('')
    try { const next = await getCodexSession(id.trim(), controller.signal); if (!controller.signal.aborted) accept(next) }
    catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
    finally { if (request.current === controller) { request.current = null; setLoading(false) } }
  }, [accept])
  useEffect(() => { if (restoring.current) void restore(restoring.current); return () => request.current?.abort() }, [restore])

  useEffect(() => {
    if (!state || state.status !== 'running') return
    const id = state.id, controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try { const next = await getCodexSession(id, controller.signal); if (!controller.signal.aborted && latest.current?.id === id) accept(next) }
      catch (reason) { if (!controller.signal.aborted) setError(`状态刷新失败：${(reason as Error).message}。服务器任务不会因页面断开而停止。`) }
      if (!controller.signal.aborted && latest.current?.id === id && latest.current.status === 'running') timer = setTimeout(refresh, 1000)
    }
    timer = setTimeout(refresh, 500)
    return () => { clearTimeout(timer); controller.abort() }
  }, [state?.id, state?.status, accept])

  async function create() {
    if (busy || running || loading) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError(''); setNotice('')
    try { const next = await createCodexSession(seed.current, controller.signal); if (!controller.signal.aborted) { accept(next); setNotice('已新建独立测试会话，初始电路为 RC 低通；原工作台项目不受影响。') } }
    catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
    finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }
  async function send(event: FormEvent) {
    event.preventDefault()
    if (!state || busy || loading || running || !message.trim()) return
    const sent = message.trim(), controller = new AbortController(); request.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      const next = await sendCodexSession(state.id, sent, crypto.randomUUID(), controller.signal)
      if (!controller.signal.aborted) { accept(next); setMessage(value => value.trim() === sent ? '' : value) }
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
    finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }
  async function cancel() {
    if (!state || busy || !running) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError('')
    try { const next = await cancelCodexSession(state.id, controller.signal); if (!controller.signal.aborted) accept(next) }
    catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
    finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }

  const lastUser = state?.messages.filter(item => item.role === 'user').at(-1)
  const simulation = state?.result?.simulation ?? state?.lastSimulation
  const steps = toolSteps(state?.events ?? [])
  const progressStatus = state?.status === 'completed' ? 'done' : state?.status === 'cancelled' ? 'stopped' : state?.status === 'idle' ? null : state?.status
  return <main className="codex-session-lab">
    <header className="session-lab-header"><div><span className="session-lab-eyebrow"><FlaskConical size={14}/> WORKBENCH LAB · 01</span><h1>Codex 持久会话测试</h1><p>这是工作台自己的 Codex 会话，沿用本机 Codex 配置；与当前 Codex 桌面聊天分开。</p></div><a className="session-lab-back" href="/">返回电路工作台</a></header>
    <div className="session-lab-layout">
      <section className="session-lab-conversation" aria-label="持久会话对话区">
        <div className="session-lab-identity"><div><span className={`session-lab-status ${running ? 'is-running' : ''}`}>{running ? <span className="session-lab-pulse"/> : state?.status === 'error' ? <TriangleAlert size={13}/> : state?.status === 'interrupted' ? <CirclePause size={13}/> : state?.status === 'cancelled' ? <CircleStop size={13}/> : state ? <Check size={13}/> : <Unplug size={13}/>} {loading ? '正在恢复会话' : state ? labels[state.status] : '尚未连接会话'}</span>{state && <span className="session-lab-model">{state.model} · {state.reasoningEffort}</span>}</div><button type="button" disabled={busy || !!running || loading} onClick={() => void create()}><MessageSquarePlus size={15}/>{state ? '新建测试会话' : '创建测试会话'}</button></div>
        <details className="session-lab-connection" open={!state}><summary>会话连接与恢复</summary><p>页面刷新后会恢复消息与任务。只有发送问题会启动模型，状态刷新不会创建新任务。</p><label>会话 ID<div><input aria-label="恢复会话 ID" value={restoreId} onChange={event => setRestoreId(event.target.value)} disabled={busy || !!running || loading} placeholder="创建后自动记住，也可粘贴已有 ID"/><button type="button" disabled={busy || !!running || loading || !restoreId.trim()} onClick={() => void restore(restoreId)}><RefreshCw size={14}/>恢复</button></div></label>{state && <dl><div><dt>Session</dt><dd>{state.id}</dd></div><div><dt>Thread</dt><dd data-testid="session-thread-id">{state.threadId || '首轮发送后创建'}</dd></div></dl>}</details>
        {error && <p className="session-lab-error" role="alert">{error}</p>}{notice && <p className="session-lab-notice" role="status">{notice}</p>}
        <div className="session-lab-messages" aria-label="会话消息" aria-live="polite">
          {!state?.messages.length && <div className="session-lab-empty"><span>01 / 连接 · 02 / 仿真 · 03 / 追问</span><h2>让同一段对话持续下去。</h2><p>先创建会话，再要求调整 RC 电路并仿真；随后追问设计理由。Thread ID 保持相同，刷新后继续。</p><button type="button" disabled={!!running || busy} onClick={() => setMessage('先读取当前 RC 电路，把 R1 调到 2k，运行 AC 仿真，并解释截止频率为什么变化。')}>填入电路测试问题</button></div>}
          {state?.messages.map(item => <article key={item.id} className={`session-lab-message is-${item.role}`}><header><strong>{item.role === 'user' ? '你' : 'Codex'}</strong><time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></header>{item.role === 'assistant' ? <AssistantMarkdown>{item.content}</AssistantMarkdown> : <p>{item.content}</p>}</article>)}
          {state && progressStatus && <div className="session-lab-current-turn"><AgentTaskProgress status={progressStatus} steps={steps} startedAt={lastUser?.createdAt ?? state.createdAt} finishedAt={running ? undefined : state.updatedAt}/>{steps.length > 0 && <details open={running}><summary>本轮电路工具 · {steps.length} 次调用</summary><ol>{steps.map((item, index) => <li key={index} data-status={item.status}><strong>{toolLabels[item.name] ?? item.name}</strong><span>{item.status === 'completed' ? '已完成' : item.status === 'error' ? '失败' : running ? '执行中' : '已中止'}</span><p>{item.detail}</p></li>)}</ol></details>}{state.error && <p className="session-lab-error" role="status">{state.error}</p>}</div>}
        </div>
        <form className="session-lab-compose" ref={form} onSubmit={send}><label htmlFor="session-lab-prompt">继续这段会话</label><textarea id="session-lab-prompt" aria-label="持久会话问题" value={message} onChange={event => setMessage(event.target.value)} maxLength={8000} rows={3} placeholder="问原理、修改电路，或继续追问上一轮的选择…" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); form.current?.requestSubmit() } }}/><div><small>{running ? '模型处理期间可准备下一条问题；刷新不会中断服务器任务。' : 'Ctrl + Enter 发送 · 记录保存在本机测试服务'}</small>{running ? <button type="button" disabled={busy} onClick={() => void cancel()}><Square size={14}/>停止本轮</button> : <button type="submit" disabled={!state || busy || loading || !message.trim()}><ArrowUp size={16}/>{busy ? '正在提交' : '发送'}</button>}</div></form>
      </section>
      <aside className="session-lab-project" aria-label="测试电路与仿真"><header><span className="session-lab-eyebrow">CIRCUIT & EVIDENCE</span><h2>同一会话里的电路</h2><p>此处候选仅用于测试和审阅，没有覆盖原工作台的项目。</p></header><AgentProposalPreview project={state?.project ?? seed.current} baseline={seed.current}/>
        {simulation && !state?.result?.simulation && <p className="session-lab-evidence-note">保留的仿真记录 · 本轮尚未生成新的仿真结果</p>}
        {simulation ? <section className="session-lab-simulation" aria-label="持久会话仿真结果">
          <header><Check size={15}/><strong>{simulation.engine} · {simulation.analysis.toUpperCase()}</strong></header><p>{simulation.points} 个采样点 · {(simulation.elapsedMs / 1000).toFixed(2)} 秒</p>
          {simulation.stale && <p className="session-lab-error">仿真后电路有修改，结果已过期，需要重新运行。</p>}
          <dl>{simulation.analysis === 'noise' && simulation.noise ? <>
            <div><dt>输出噪声密度</dt><dd>{formatSI(simulation.output.minimum, 'V/√Hz')}～{formatSI(simulation.output.maximum, 'V/√Hz')}</dd></div>
            <div><dt>输入等效噪声密度</dt><dd>{formatSI(simulation.noise.input.minimum, `${simulation.noise.inputUnit}/√Hz`)}～{formatSI(simulation.noise.input.maximum, `${simulation.noise.inputUnit}/√Hz`)}</dd></div>
            {simulation.noise.totalOutput !== undefined && <div><dt>积分输出噪声 RMS</dt><dd>{formatSI(simulation.noise.totalOutput, 'V')}</dd></div>}
            {simulation.noise.totalInput !== undefined && <div><dt>积分输入噪声 RMS</dt><dd>{formatSI(simulation.noise.totalInput, simulation.noise.inputUnit)}</dd></div>}
          </> : simulation.analysis === 'ac' ? <><div><dt>峰值增益</dt><dd>{simulation.peakDb == null ? '—' : `${Number(simulation.peakDb.toFixed(3))} dB`}</dd></div><div><dt>峰值频率</dt><dd>{simulation.peakFrequencyHz == null ? '—' : formatSI(simulation.peakFrequencyHz, 'Hz')}</dd></div></> : <><div><dt>输出最小值</dt><dd>{formatSI(simulation.output.minimum, 'V')}</dd></div><div><dt>输出最大值</dt><dd>{formatSI(simulation.output.maximum, 'V')}</dd></div><div><dt>输出末值</dt><dd>{formatSI(simulation.output.last, 'V')}</dd></div></>}</dl>
          {simulation.warnings.length > 0 && <ul>{simulation.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul>}
          <details><summary>查看真实采样 · {simulation.samples.length} 点</summary><div className="session-lab-table"><table><thead><tr>
            <th>{simulation.analysis === 'ac' || simulation.analysis === 'noise' ? '频率 / Hz' : 'x'}</th>
            {simulation.analysis === 'noise' ? <><th>输出噪声 / V/√Hz</th><th>输入等效噪声 / {simulation.noise?.inputUnit}/√Hz</th></> : <th>{simulation.analysis === 'ac' ? '增益 / dB' : 'Vout / V'}</th>}
          </tr></thead><tbody>{simulation.samples.map((sample, index) => <tr key={index}><td>{Number(sample.x.toPrecision(5))}</td>
            {simulation.analysis === 'noise' ? <><td>{sample.outputNoise == null ? '—' : Number(sample.outputNoise.toPrecision(5))}</td><td>{sample.inputNoise == null ? '—' : Number(sample.inputNoise.toPrecision(5))}</td></> : <td>{simulation.analysis === 'ac' ? sample.gainDb == null ? '—' : Number(sample.gainDb.toPrecision(5)) : sample.vout == null ? '—' : Number(sample.vout.toPrecision(5))}</td>}
          </tr>)}</tbody></table></div></details>
        </section> : <div className="session-lab-no-simulation"><CirclePause size={17}/><p>{running ? '正在等待本轮的真实仿真结果。' : '本轮没有可展示的 ngspice 仿真记录。可以在对话中要求运行仿真。'}</p></div>}
        <details className="session-lab-project-data"><summary>查看测试项目数据</summary><pre>{JSON.stringify(state?.project ?? seed.current, null, 2)}</pre></details>
      </aside>
    </div>
  </main>
}


