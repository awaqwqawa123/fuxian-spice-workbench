import { deviceCatalog } from './devices'
import { compileDrawing, terminalKey, terminalPosition, type Drawing, type Terminal } from './drawing'

/** Change an instance reference without disconnecting its pins, labels or probe. */
export function renameDevice(d: Drawing, id: string, newId: string): Drawing {
  const device = d.devices.find(part => part.id === id)
  if (!device) throw new Error('要重命名的器件不存在')
  const prefix = deviceCatalog[device.kind].prefix
  newId = newId.trim().toUpperCase()
  if (!new RegExp(`^${prefix}[1-9]\\d{0,4}$`).test(newId)) throw new Error(`器件编号须为 ${prefix} 加 1 至 99999，例如 ${prefix}1`)
  if (newId === id) return d
  if ([...d.devices, ...d.junctions, ...d.wires, ...(d.labels ?? [])].some(item => item.id === newId)) throw new Error(`编号 ${newId} 已存在，请使用其他编号`)
  const renameTerminal = (at: Terminal): Terminal => 'device' in at && at.device === id ? { ...at, device: newId } : at
  return {
    ...d,
    devices: d.devices.map(part => part.id === id ? { ...part, id: newId } : part),
    wires: d.wires.map(wire => ({ ...wire, from: renameTerminal(wire.from), to: renameTerminal(wire.to) })),
    ...(d.labels === undefined ? {} : { labels: d.labels.map(label => ({ ...label, at: renameTerminal(label.at) })) }),
    sourceId: d.sourceId === id ? newId : d.sourceId,
    output: d.output ? renameTerminal(d.output) : null,
  }
}

export interface InspectedNet {
  name: string
  terminalKeys: string[]
  wireIds: string[]
  labelIds: string[]
}

/** Use the solver's connectivity, including remote labels and all ground symbols. */
export function inspectNet(d: Drawing, at: Terminal, nodes=compileDrawing(d).nodes): InspectedNet {
  terminalPosition(d, at)
  const name = nodes.get(terminalKey(at))
  if(name===undefined)throw new Error(`网络端点 ${terminalKey(at)} 不存在，请重新选择真实引脚或连接点`)
  const terminalKeys = [...nodes].filter(([, node]) => node === name).map(([key]) => key)
  const terminals = new Set(terminalKeys)
  return {
    name,
    terminalKeys,
    wireIds: d.wires.filter(wire => terminals.has(terminalKey(wire.from))).map(wire => wire.id),
    labelIds: (d.labels ?? []).filter(label => terminals.has(terminalKey(label.at))).map(label => label.id),
  }
}
