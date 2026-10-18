import { useEffect, useState } from 'react'
import { Check, Circle, CirclePause, Clock3, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { AgentToolEvent } from '../core/agent-client'
import { agentElapsedLabel, agentProgressView, type AgentTaskStatus } from '../core/agent-progress'

export interface AgentTaskProgressProps {
  status: AgentTaskStatus
  steps: AgentToolEvent[]
  startedAt: number
  finishedAt?: number
}

export default function AgentTaskProgress({ status, steps, startedAt, finishedAt }: AgentTaskProgressProps) {
  const [now, setNow] = useState(() => finishedAt ?? Date.now())
  useEffect(() => {
    setNow(finishedAt ?? Date.now())
    if (status !== 'running') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [status, startedAt, finishedAt])
  const view = agentProgressView(status, steps)
  const labels = { idle: status === 'running' ? '未调用' : '未执行', running: '执行中', completed: '已完成', error: '失败', stopped: '已中止' }
  return <section className="agent-task-progress" data-status={status} aria-label="任务进度">
    <div className="agent-progress-heading"><strong aria-live="polite">{status === 'running' ? <LoaderCircle className="agent-progress-spinner" size={14}/> : status === 'done' ? <Check size={14}/> : status === 'stopped'||status === 'interrupted' ? <CirclePause size={14}/> : <TriangleAlert size={14}/>}<span>{view.label}</span></strong><span className="agent-progress-elapsed"><Clock3 size={12}/>已耗时 {agentElapsedLabel(startedAt, finishedAt ?? now)}</span></div>
    <div className="agent-progress-track" role="progressbar" aria-label="Agent 任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status === 'done' ? 100 : undefined} aria-valuetext={view.label}><span/></div>
    <ol className="agent-progress-stages" aria-label="电路工具阶段">{view.stages.map(stage => <li key={stage.id} data-state={stage.state} title={`${stage.label}：${labels[stage.state]}`}>
      {stage.state === 'completed' ? <Check size={12}/> : stage.state === 'running' ? <LoaderCircle className="agent-progress-spinner" size={12}/> : stage.state === 'error' ? <TriangleAlert size={12}/> : stage.state === 'stopped' ? <CirclePause size={12}/> : <Circle size={9}/>}<span>{stage.label}</span><span className="agent-progress-sr">：{labels[stage.state]}</span>
    </li>)}</ol>
    <p>{view.completed > 0 ? `已完成 ${view.completed} 次工具调用` : '尚无已完成的工具调用'}{view.failed > 0 ? ` · ${view.failed} 次失败记录` : ''}{status === 'running' ? view.active ? ' · 正在执行电路工具' : ' · 正在等待模型响应' : status === 'done' ? ' · 结果已返回' : status === 'interrupted' ? ' · 候选电路与仿真已保留，任务未完整结束' : ' · 执行已结束'}</p>
  </section>
}
