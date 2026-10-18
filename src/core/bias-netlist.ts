import { circuitGraph, generateNetlist, type Project } from './circuit'
import { compileDrawing } from './drawing'
import type { Result } from './results'

export interface BiasCurrentChannel {
  /** Original schematic identity; zero-based pin order is independent of symbol rotation. */
  key: string
  deviceId: string
  pin: number
  /** Normalized current vector name produced by processResult. */
  vector: string
  sign: 1 | -1
  method: 'native' | 'sensed'
}

/** DC bias uses native two-terminal currents and independent external-port senses.
 * Each zero-volt source is oriented original node -> private device node, so its
 * branch current is positive INTO the device. Separate senses preserve current
 * identities when several ports share the same external node (including ground).
 */
export function buildBiasNetlist(project: Project): { netlist: string; channels: BiasCurrentChannel[] } {
  if (project.analysis !== 'op' || project.sweep) throw new Error('直流工作点测量需要独立的 OP 项目，不能使用扫描结果')
  const baseline = generateNetlist(project)
  const elements = project.template === 'custom'
    ? compileDrawing(project.drawing!).elements
    : circuitGraph(project).parts.map(part => ({ device: part, nodes: part.nodes }))
  const channels: BiasCurrentChannel[] = []
  const deviceNodes = new Map<string, string[]>()
  const additionalElements: string[] = [], saveVectors: string[] = []
  // Reserve against the complete generated deck, including model/helper/internal
  // names and node names. A model named with our prefix must not shadow a sense.
  const lower = baseline.toLowerCase()
  let suffix = 0
  while (lower.includes(`__fx_bias_${suffix}_`)) suffix++
  const namespace = `__fx_bias_${suffix}_`
  let count = 0
  for (const { device, nodes } of elements) {
    if (['R', 'C', 'L', 'V', 'I', 'D'].includes(device.kind)) {
      if (nodes.length !== 2) throw new Error(`${device.id}：两端器件的引脚数量无效`)
      for (const pin of [0, 1]) channels.push({ key: `${device.id}:${pin}`, deviceId: device.id, pin, vector: `i(${device.id.toLowerCase()})`, sign: pin === 0 ? 1 : -1, method: 'native' })
      continue
    }
    const privateNodes = nodes.map((node, pin) => {
      const identity = `${namespace}${count++}`, privateNode = `n${identity}`, source = `v${identity}`
      additionalElements.push(`${source} ${node} ${privateNode} DC 0`)
      saveVectors.push(`i(${source})`)
      channels.push({ key: `${device.id}:${pin}`, deviceId: device.id, pin, vector: `i(${source})`, sign: 1, method: 'sensed' })
      return privateNode
    })
    deviceNodes.set(device.id, privateNodes)
  }
  return { netlist: additionalElements.length ? generateNetlist(project, { deviceNodes, additionalElements, saveVectors }) : baseline, channels }
}

/** Fail closed: a missing, truncated or invalid port measurement is never 0 A. */
export function attachBiasCurrents(result: Result, channels: readonly BiasCurrentChannel[]): Result {
  if (result.analysis !== 'op' || result.points !== 1) throw new Error('直流工作点电流必须来自单点 OP 计算')
  const terminalCurrents: Record<string, number[]> = {}, terminalCurrentMethods: Record<string, string> = {}
  for (const channel of channels) {
    if (Object.hasOwn(terminalCurrents, channel.key)) throw new Error(`直流电流测量身份重复：${channel.key}`)
    const values = result.currents?.[channel.vector.toLowerCase()]
    if (!values || values.length !== 1 || !Number.isFinite(values[0])) throw new Error(`${channel.deviceId} 引脚 ${channel.pin + 1} 缺少有效的直流电流测量值`)
    terminalCurrents[channel.key] = values.map(value => value * channel.sign)
    terminalCurrentMethods[channel.key] = channel.method
  }
  return { ...result, terminalCurrents, terminalCurrentMethods }
}
