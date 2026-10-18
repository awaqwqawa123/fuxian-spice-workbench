import type { Project } from './circuit'
import { compileDrawing, terminalKey, type Drawing, type Pin, type Terminal } from './drawing'
import { pinsFor } from './devices'
import { canProbeCurrent } from './branch-currents'
import { MAX_MEASUREMENT_PROBES, deletedProbeAttachment, type Measurement } from './probes'
import type { ProbeLayout } from './probe-placement'
import { hasWireCurrentTarget, wireCurrentCut } from './wire-currents'
import { remapDrawingMeasurement, remapLayoutMeasurements } from './layout-probes'
import { layoutElectricallyEquivalent } from './layout-electrical-equivalence'

const object = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}：需要对象`)
  return value as Record<string, unknown>
}

/** Probe records are real measurement attachments, not decorative output labels. */
export function parseProjectProbes(input: unknown, drawing?: Drawing): Measurement[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input) || input.length > MAX_MEASUREMENT_PROBES) throw new Error(`project.probes：需要最多 ${MAX_MEASUREMENT_PROBES} 个探针的数组`)
  if (input.length && !drawing) throw new Error('project.probes：探针需要自由原理图的真实端点')
  const ids = new Set<string>(), nodes = drawing ? compileDrawing(drawing).nodes : new Map<string, string>()
  const terminal = (value: unknown, path: string): Terminal => {
    const at = object(value, path)
    if (typeof at.junction === 'string' && at.device === undefined && at.pin === undefined && drawing!.junctions.some(junction => junction.id === at.junction)) return { junction: at.junction }
    if (typeof at.device === 'string' && at.junction === undefined && Number.isInteger(at.pin)) {
      const device = drawing!.devices.find(device => device.id === at.device)
      if (device && pinsFor(device).includes(at.pin as Pin)) return { device: at.device, pin: at.pin as Pin }
    }
    throw new Error(`${path}：必须引用存在的器件引脚或连接点，不能猜测替代端点`)
  }
  const layout = (value: unknown, path: string, at: Terminal, wireId?: string): ProbeLayout | undefined => {
    if (value === undefined) return undefined
    const raw = object(value, path), result: ProbeLayout = {}
    if (raw.offset !== undefined) {
      const offset = object(raw.offset, `${path}.offset`)
      if (typeof offset.x !== 'number' || typeof offset.y !== 'number' || !Number.isFinite(offset.x) || !Number.isFinite(offset.y)) throw new Error(`${path}.offset：x / y 必须为有限数字`)
      result.offset = { x: offset.x, y: offset.y }
    }
    if (raw.anchor !== undefined) {
      const anchor = object(raw.anchor, `${path}.anchor`), wire = drawing!.wires.find(wire => wire.id === anchor.wireId)
      if (!wire || typeof anchor.fraction !== 'number' || !Number.isFinite(anchor.fraction) || anchor.fraction < 0 || anchor.fraction > 1) throw new Error(`${path}.anchor：需要存在的 wireId 和 0～1 的有限 fraction`)
      if (wireId ? wire.id !== wireId : nodes.get(terminalKey(wire.from)) !== nodes.get(terminalKey(at))) throw new Error(`${path}.anchor：导线与探针的真实测量端点不一致`)
      result.anchor = { wireId: wire.id, fraction: anchor.fraction }
    }
    return result
  }
  return input.map((value, index): Measurement => {
    const path = `project.probes[${index}]`, raw = object(value, path), id = raw.id
    if (typeof id !== 'string' || !/^P[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id.slice(1)))) throw new Error(`${path}.id：需要 P1、P2 等正整数编号`)
    if (ids.has(id)) throw new Error(`${path}.id：探针编号 ${id} 重复`)
    ids.add(id)
    if (raw.kind === 'voltage') {
      const incompatible = ['device', 'wire', 'layout'].find(field => raw[field] !== undefined)
      if (incompatible) throw new Error(`${path}.${incompatible}：不适用于 voltage 探针；电压使用 positive / negative 与对应 Layout`)
      const positive = terminal(raw.positive, `${path}.positive`), negative = raw.negative === undefined ? undefined : terminal(raw.negative, `${path}.negative`)
      if (!negative && raw.negativeLayout !== undefined) throw new Error(`${path}.negativeLayout：需要对应的差分负端 negative`)
      const positiveLayout = layout(raw.positiveLayout, `${path}.positiveLayout`, positive), negativeLayout = negative ? layout(raw.negativeLayout, `${path}.negativeLayout`, negative) : undefined
      return { id, kind: 'voltage', positive, ...(negative ? { negative } : {}), ...(positiveLayout ? { positiveLayout } : {}), ...(negativeLayout ? { negativeLayout } : {}) }
    }
    if (raw.kind !== 'current') throw new Error(`${path}.kind：只支持 voltage 或 current；差分使用 voltage + negative`)
    const incompatible = ['positive', 'negative', 'positiveLayout', 'negativeLayout'].find(field => raw[field] !== undefined)
    if (incompatible) throw new Error(`${path}.${incompatible}：不适用于 current 探针；电流使用 device 或 wire 与 layout`)
    if ((raw.device === undefined) === (raw.wire === undefined)) throw new Error(`${path}：电流探针必须且只能指定 device 或 wire`)
    if (raw.wire !== undefined) {
      const rawWire = object(raw.wire, `${path}.wire`)
      if (typeof rawWire.wireId !== 'string' || ![1, -1].includes(rawWire.direction as number)) throw new Error(`${path}.wire：需要 wireId 和 direction: 1 或 -1`)
      const wire = { wireId: rawWire.wireId, from: terminal(rawWire.from, `${path}.wire.from`), to: terminal(rawWire.to, `${path}.wire.to`), direction: rawWire.direction as 1 | -1 }
      if (!hasWireCurrentTarget(drawing!, wire)) throw new Error(`${path}.wire：导线已删除或 from / to 与真实导线不一致`)
      const cut = wireCurrentCut(drawing!, wire)
      if (!cut.ok) throw new Error(`${path}.wire：${cut.reason}`)
      const placement = layout(raw.layout, `${path}.layout`, wire.from, wire.wireId)
      return { id, kind: 'current', wire, ...(placement ? { layout: placement } : {}) }
    }
    const device = drawing!.devices.find(device => device.id === raw.device)
    if (!device || !canProbeCurrent(device.kind)) throw new Error(`${path}.device：需要支持电流测量的真实 R/C/L/V/I/D 器件`)
    const placement = layout(raw.layout, `${path}.layout`, { device: device.id, pin: 0 })
    return { id, kind: 'current', device: device.id, ...(placement ? { layout: placement } : {}) }
  })
}

/** A pure removal disconnects nets deliberately; surviving physical terminals keep their identity. */
function isRemovalOnly(before: Drawing, next: Drawing): boolean {
  const removed = before.wires.some(wire => !next.wires.some(item => item.id === wire.id))
    || before.devices.some(device => !next.devices.some(item => item.id === device.id))
    || before.junctions.some(junction => !next.junctions.some(item => item.id === junction.id))
  return removed
    && next.wires.every(wire => before.wires.some(old => old.id === wire.id && terminalKey(old.from) === terminalKey(wire.from) && terminalKey(old.to) === terminalKey(wire.to)))
    && next.devices.every(device => before.devices.some(old => old.id === device.id && old.kind === device.kind && JSON.stringify(pinsFor(old)) === JSON.stringify(pinsFor(device))))
    && next.junctions.every(junction => before.junctions.some(old => old.id === junction.id))
    && (next.labels ?? []).every(label => (before.labels ?? []).some(old => old.id === label.id && old.name === label.name && terminalKey(old.at) === terminalKey(label.at)))
}

/** Inherited probes follow an edit only when their electrical identity remains provable. */
export function reconcileProjectProbes(before: Project, next: Project): { project: Project; notices: string[] } {
  if (next.probes === undefined) return { project: next, notices: [] }
  if (next.probes !== before.probes || before.drawing === next.drawing) return { project: { ...next, probes: parseProjectProbes(next.probes, next.drawing) }, notices: [] }
  const notices: string[] = [], probes: Measurement[] = []
  const removalOnly = !!before.drawing && !!next.drawing && isRemovalOnly(before.drawing, next.drawing)
  for (const measurement of next.probes) {
    try {
      if (!before.drawing || !next.drawing) throw new Error('原测量端点已不存在')
      const deleted = deletedProbeAttachment(before.drawing, next.drawing, measurement)
      if (deleted) throw new Error(deleted)
      const mapped = removalOnly && measurement.kind === 'voltage' ? structuredClone(measurement) : remapDrawingMeasurement(before.drawing, next.drawing, measurement)
      probes.push(...parseProjectProbes([mapped], next.drawing)!)
    } catch (error) {
      notices.push(`已移除失效探针 ${measurement.id}：${(error as Error).message} 请在新电路上重新放置；撤销可恢复原图与探针。`)
    }
  }
  return { project: { ...next, probes }, notices }
}

/** Omitted probes preserve a layout's measurements; an explicit [] deliberately clears them. */
export function projectWithCandidateProbes(before: Project, candidate: Project): { project: Project; notices: string[] } {
  if (candidate.probes !== undefined) return { project: { ...candidate, probes: parseProjectProbes(candidate.probes, candidate.drawing) }, notices: [] }
  if (before.probes === undefined) return { project: candidate, notices: [] }
  if (layoutElectricallyEquivalent(before, candidate)) return { project: { ...candidate, probes: parseProjectProbes(remapLayoutMeasurements(before, candidate, before.probes), candidate.drawing) }, notices: [] }
  return reconcileProjectProbes(before, { ...candidate, probes: before.probes })
}
