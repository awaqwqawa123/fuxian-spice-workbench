import type { Result } from './results'

export type SimulationFeedbackState = 'empty' | 'running' | 'failed' | 'interrupted' | 'stale' | 'recovered' | 'warning' | 'complete'

/** Describe the displayed run without treating solver completion as design acceptance. */
export function simulationFeedback({ result, running = false, progress = '', failure = '', stale = false, interrupted = false }: {
  result?: Result | null; running?: boolean; progress?: string; failure?: string; stale?: boolean; interrupted?: boolean
}): { state: SimulationFeedbackState; label: string; detail: string } {
  const retained = result ? '；当前显示上次运行数据' : '；尚无可显示的运行数据'
  if (running) return { state: 'running', label: '正在仿真', detail: (progress || '正在启动求解器') + retained }
  if (failure) return { state: 'failed', label: '仿真未完成', detail: failure + retained }
  if (interrupted) return { state: 'interrupted', label: '仿真已停止', detail: '本次运行已停止' + retained }
  if (stale && result) return { state: 'stale', label: '结果已过期', detail: '电路或配置已修改；保留上次运行数据，请重新仿真' }
  if (!result) return { state: 'empty', label: '尚未运行', detail: '运行当前配置以获取结果' }
  const recovery = result.warnings.find(message => /^工作点已恢复：/.test(message))
  if (recovery) return { state: 'recovered', label: '恢复求解完成', detail: recovery }
  if (result.warnings.length) return { state: 'warning', label: `完成 · ${result.warnings.length} 条提示`, detail: result.warnings.join('\n') }
  return { state: 'complete', label: '仿真已完成', detail: '求解器已完成本次运行；设计指标请结合测量与测试报告判断' }
}
