import type { AgentIdRename } from './agent-drawing-ids'
import type { Project } from './circuit'

/**
 * Automatic node names depend on sorted terminal IDs. Even a curve name still
 * present after an ID rewrite may now name a different physical net. Until a
 * pin-membership migration exists for all profiles, reject this combination
 * rather than guessing. Check the effective setup, including inherited plans.
 */
export function assertWaveformSetupIdNormalization(current: Project, patch: { waveformSetup?: unknown }, renamedIds: readonly AgentIdRename[]): void {
  const setup = patch.waveformSetup === undefined ? current.waveformSetup : patch.waveformSetup
  if (setup === undefined || !renamedIds.length) return
  const changes = renamedIds.slice(0, 6).map(rename => `${rename.from} → ${rename.to}`).join('；')
  throw new Error(`project.waveformSetup：已有波形配置时不能自动规范化器件或连接编号（${changes}${renamedIds.length > 6 ? `；另 ${renamedIds.length - 6} 项` : ''}）。编号变化可能让 voltage:v(n1) 等自动节点名指向另一网络，也会影响配置的 sourceId / output 和电流曲线。请保留 inspect_circuit 中的现有规范编号；新器件直接使用对应前缀的唯一正整数编号，并通过 inspect_circuit.waveformOptions 核对后显式 configure_waveforms。候选和原波形配置均未改变，不会猜测或删除曲线。`)
}
