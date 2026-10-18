import type { NetLabelStyle, Rotation } from './drawing'

export interface NetworkSymbolPreset {
  id: string
  name: string
  netName: string
  style: Exclude<NetLabelStyle, 'text'>
  rotation: Rotation
}

/** Standard schematic ports. These name a net; they do not create a voltage source. */
export const networkSymbolPresets: readonly NetworkSymbolPreset[] = [
  { id: 'power-vcc', name: 'VCC 电源端口', netName: 'VCC', style: 'power', rotation: 0 },
  { id: 'power-vdd', name: 'VDD 电源端口', netName: 'VDD', style: 'power', rotation: 0 },
  { id: 'power-vss', name: 'VSS 电源端口', netName: 'VSS', style: 'power', rotation: 180 },
  { id: 'power-vee', name: 'VEE 电源端口', netName: 'VEE', style: 'power', rotation: 180 },
  { id: 'port-input', name: '输入网络端口', netName: 'IN', style: 'input', rotation: 0 },
  { id: 'port-output', name: '输出网络端口', netName: 'OUT', style: 'output', rotation: 0 },
  { id: 'port-bidirectional', name: '双向网络端口', netName: 'IO', style: 'bidirectional', rotation: 0 },
]
