import type { AgentToolEvent } from './agent-client'

export type AgentTaskStatus = 'running' | 'done' | 'interrupted' | 'stopped' | 'error'
export interface AgentProgressStage { id: string; label: string; state: 'idle' | 'running' | 'completed' | 'error' | 'stopped' }

const stageTools = [
  { id: 'inspect', label: '读取电路', tools: ['inspect_circuit'] },
  { id: 'edit', label: '修改方案', tools: ['replace_candidate', 'set_component_value'] },
  { id: 'validate', label: '连接检查', tools: ['validate_circuit'] },
  { id: 'simulate', label: '电路仿真', tools: ['simulate_circuit'] },
] as const
const toolLabels: Record<string, string> = {configure_waveforms:'配置波形图',set_measurement_probes:'放置测量探针',  inspect_circuit: '读取当前电路', replace_candidate: '更新候选电路', set_component_value: '调整器件参数', validate_circuit: '检查电气连接', simulate_circuit: '运行 ngspice 仿真' }

/** A tool can finish while the model is still working. Only the task's done event completes the run. */
export function agentProgressView(status: AgentTaskStatus, steps: readonly AgentToolEvent[]) {
  const newestFirst = [...steps].reverse()
  const active = newestFirst.find(step => step.status === 'running')
  const last = steps.at(-1)
  const label = status === 'done' ? '任务已完成'
    : status === 'interrupted' ? '方案已保留 · 最终说明超时'
    : status === 'stopped' ? '任务已停止'
    : status === 'error' ? '任务未完成'
    : active ? (toolLabels[active.name] ?? `执行 ${active.name}`)
    : last?.status === 'error' ? '等待模型修正并重试'
    : steps.length ? '等待模型继续处理' : '等待模型规划任务'
  const stages: AgentProgressStage[] = stageTools.map(stage => {
    const latest = newestFirst.find(step => (stage.tools as readonly string[]).includes(step.name))
    return { id: stage.id, label: stage.label, state: latest?.status === 'running' && status !== 'running' ? 'stopped' : latest?.status ?? 'idle' }
  })
  return { label, stages, active: status === 'running' && !!active, completed: steps.filter(step => step.status === 'completed').length, failed: steps.filter(step => step.status === 'error').length }
}

export function agentElapsedLabel(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000))
  if (!Number.isFinite(seconds)) return '0 秒'
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
