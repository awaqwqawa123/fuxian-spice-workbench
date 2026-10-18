import type { DeviceKind } from './drawing'

export interface OpAmpPreset {
  id: string
  kind: Extract<DeviceKind, 'OPA' | 'CMP'>
  name: string
  detail: string
  /** Open-loop gain used by the behavioral source (V/V). */
  gain: number
  /** Gain-bandwidth product for OPA, or dominant response bandwidth for CMP (Hz). */
  bandwidth: number
  inputR: number
  outputR: number
  headroom: number
  manufacturer: string
  datasheetUrl: string
  /** Human-readable source statement kept with the built-in preset. */
  spice: string
}

const referenceNote = '基于厂商公开规格书的行为近似，不是厂商发布的加密宏模型；不包含失调、噪声、转换速率、共模范围和热模型。'

/**
 * Common five-pin op-amp presets. The symbol has +IN, -IN, OUT, V+ and V−,
 * and the ngspice implementation remains a finite-gain, single-pole model.
 * Values are typical datasheet references so the part is immediately usable;
 * they should not be interpreted as guaranteed limits.
 */
export const opAmpModels: readonly OpAmpPreset[] = [
  { id: '100k', kind: 'OPA', name: '通用运放 · A≈100k', detail: '默认教学行为模型；单极点、有限增益、电源轨限幅。', gain: 100_000, bandwidth: 1_000_000, inputR: 1e9, outputR: 50, headroom: .5, manufacturer: 'Fuxian reference', datasheetUrl: 'https://ngspice.sourceforge.io/docs.html', spice: `* Fuxian generic op-amp reference\n* A=100k, GBW=1MHz, Rin=1GΩ, Rout=50Ω`, },
  { id: 'LM321', kind: 'OPA', name: 'TI LM321 · 单运放', detail: `Texas Instruments LM321 规格书参考；${referenceNote}`, gain: 100_000, bandwidth: 1_000_000, inputR: 1e9, outputR: 75, headroom: .2, manufacturer: 'Texas Instruments', datasheetUrl: 'https://www.ti.com/lit/ds/symlink/lm321.pdf', spice: `* TI LM321 datasheet-reference behavioral model\n* A=100k, GBW=1MHz, Rin=1GΩ, Rout=75Ω, headroom=0.2V`, },
  { id: 'LM358', kind: 'OPA', name: 'TI LM358 · 双运放单通道', detail: `Texas Instruments LM358 规格书参考；${referenceNote}`, gain: 100_000, bandwidth: 1_000_000, inputR: 1e9, outputR: 75, headroom: .2, manufacturer: 'Texas Instruments', datasheetUrl: 'https://www.ti.com/lit/ds/symlink/lm358.pdf', spice: `* TI LM358 datasheet-reference behavioral model\n* A=100k, GBW=1MHz, Rin=1GΩ, Rout=75Ω, headroom=0.2V`, },
  { id: 'LM358A', kind: 'OPA', name: 'TI LM358A · 双运放单通道', detail: `Texas Instruments LM358A 规格书参考；${referenceNote}`, gain: 100_000, bandwidth: 1_000_000, inputR: 1e9, outputR: 75, headroom: .2, manufacturer: 'Texas Instruments', datasheetUrl: 'https://www.ti.com/lit/ds/symlink/lm358a.pdf', spice: `* TI LM358A datasheet-reference behavioral model\n* A=100k, GBW=1MHz, Rin=1GΩ, Rout=75Ω, headroom=0.2V`, },
  { id: 'LM324', kind: 'OPA', name: 'TI LM324 · 四运放单通道', detail: `Texas Instruments LM324 规格书参考；${referenceNote}`, gain: 100_000, bandwidth: 1_000_000, inputR: 1e9, outputR: 75, headroom: .2, manufacturer: 'Texas Instruments', datasheetUrl: 'https://www.ti.com/lit/ds/symlink/lm324.pdf', spice: `* TI LM324 datasheet-reference behavioral model\n* A=100k, GBW=1MHz, Rin=1GΩ, Rout=75Ω, headroom=0.2V`, },
  { id: 'LM741', kind: 'OPA', name: 'TI LM741 · 通用运放', detail: `Texas Instruments LM741 规格书参考；${referenceNote}`, gain: 200_000, bandwidth: 1_000_000, inputR: 2e6, outputR: 75, headroom: 2, manufacturer: 'Texas Instruments', datasheetUrl: 'https://www.ti.com/lit/ds/symlink/lm741.pdf', spice: `* TI LM741 datasheet-reference behavioral model\n* A=200k, GBW=1MHz, Rin=2MΩ, Rout=75Ω, headroom=2V`, },
  { id: 'TL072', kind: 'OPA', name: 'TI TL072 · JFET 输入双运放', detail: `Texas Instruments TL072 规格书参考；${referenceNote}`, gain: 200_000, bandwidth: 3_000_000, inputR: 1e12, outputR: 100, headroom: 1.5, manufacturer: 'Texas Instruments', datasheetUrl: 'https://www.ti.com/lit/ds/symlink/tl072.pdf', spice: `* TI TL072 datasheet-reference behavioral model\n* A=200k, GBW=3MHz, Rin=1TΩ, Rout=100Ω, headroom=1.5V`, },
  { id: 'NE5532', kind: 'OPA', name: 'TI NE5532 · 低噪声双运放', detail: `Texas Instruments NE5532 规格书参考；${referenceNote}`, gain: 100_000, bandwidth: 10_000_000, inputR: 300_000, outputR: 50, headroom: 2, manufacturer: 'Texas Instruments', datasheetUrl: 'https://www.ti.com/lit/ds/symlink/ne5532.pdf', spice: `* TI NE5532 datasheet-reference behavioral model\n* A=100k, GBW=10MHz, Rin=300kΩ, Rout=50Ω, headroom=2V`, },
  { id: 'OPA197', kind: 'OPA', name: 'TI OPA197 · 精密运放', detail: `Texas Instruments OPA197 规格书参考；${referenceNote}`, gain: 1_000_000, bandwidth: 10_000_000, inputR: 1e12, outputR: 20, headroom: .1, manufacturer: 'Texas Instruments', datasheetUrl: 'https://www.ti.com/lit/ds/symlink/opa197.pdf', spice: `* TI OPA197 datasheet-reference behavioral model\n* A=1M, GBW=10MHz, Rin=1TΩ, Rout=20Ω, headroom=0.1V`, },
  { id: 'MCP6001', kind: 'OPA', name: 'Microchip MCP6001 · 低功耗运放', detail: `Microchip MCP6001 规格书参考；${referenceNote}`, gain: 100_000, bandwidth: 1_000_000, inputR: 1e13, outputR: 100, headroom: .1, manufacturer: 'Microchip', datasheetUrl: 'https://ww1.microchip.com/downloads/aemDocuments/documents/MSLD/ProductDocuments/DataSheets/MCP6001-1R-1U-1T-Data-Sheet-DS20001733.pdf', spice: `* Microchip MCP6001 datasheet-reference behavioral model\n* A=100k, GBW=1MHz, Rin=10TΩ, Rout=100Ω, headroom=0.1V`, },
  { id: 'CMP_GENERIC', kind: 'CMP', name: '通用比较器 · A≈100k', detail: '默认教学比较器行为模型；输出受电源轨限幅。', gain: 100_000, bandwidth: 1_000_000, inputR: 1e9, outputR: 50, headroom: .1, manufacturer: 'Fuxian reference', datasheetUrl: 'https://ngspice.sourceforge.io/docs.html', spice: `* Fuxian generic comparator reference\n* A=100k, BW=1MHz, Rin=1GΩ, Rout=50Ω`, },
]

export function opAmpModelFor(kind: 'OPA' | 'CMP', id: string): OpAmpPreset | undefined {
  const query = id.trim().toLowerCase()
  const exact = opAmpModels.find(model => model.kind === kind && model.id.toLowerCase() === query)
  if (exact) return exact
  // TI package/orderable suffixes (for example LM321T5, LM358P) use the
  // same electrical die. Resolve only a known base plus a conservative
  // suffix; never treat an arbitrary similar part as an exact model.
  return opAmpModels.find(model => model.kind === kind && query.startsWith(model.id.toLowerCase()) && /^(?:t5|mfx|mfb|p|d|n)$/.test(query.slice(model.id.length)))
}

export function opAmpParameters(kind: 'OPA' | 'CMP', id: string) {
  const model = opAmpModelFor(kind, id)
  return model ? { gain: model.gain, bandwidth: model.bandwidth, inputR: model.inputR, outputR: model.outputR, headroom: model.headroom } : undefined
}
