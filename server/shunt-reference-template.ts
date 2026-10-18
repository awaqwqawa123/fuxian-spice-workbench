import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { decodeSpiceLibrary, type ImportedSpiceModel, type SpiceModelSource } from '../src/core/spice-models'
import { parseModelLibraryPreview as parseSpiceLibrary } from '../src/core/model-library-preview'
import { fetchModelBytes } from './model-search'

// The official product page links to this archive. Keep the copyrighted source
// at TI; the workbench downloads it only when a user requests a reference.
export const TLV431_ARCHIVE_URL = 'https://www.ti.com/lit/zip/SLVM088'
const LIB_SHA256 = 'c09dc591e17dd1631c15d08d5451edf1ca3ec45ba94d002b6bdb8417023958d0'
const LEGACY_ADAPTED_SHA256 = 'fb38fcdf5d8d4f1732a4ec3fb628daf91319a8001c57ce6d8eec1f6a5fbeba17'
const ADAPTED_SHA256 = '103692112464dc68633897769a8dceaab59843e7aac07da76d96e58d56401dc9'
const LIB_PATH = 'TLV431_TINA/TLV431.LIB'
const originalSource: SpiceModelSource = {
  label: 'Texas Instruments TLV431 官方 TINA 模型（经 ngspice 语法适配）',
  url: TLV431_ARCHIVE_URL,
  license: '© 2009 Texas Instruments；仅供客户辅助设计，原模型按原样提供。使用和再分发须遵守 TI 原文件条款。',
  attribution: `TI 官网 TLV431 产品页提供 SLVM088；原文件 ${LIB_PATH} SHA-256 ${LIB_SHA256}。仅将两处 TABLE 语法按原始节点、分段点适配为 ngspice 行为电流源；未修改电气数值。`,
}

function exactlyOne(text: string, pattern: RegExp, replacement: string): string {
  const matches = [...text.matchAll(pattern)]
  if (matches.length !== 1) throw new Error('TI TLV431 模型结构与已审定版本不符，已停止派生')
  return text.replace(pattern, replacement)
}

function tableExpression(input: string, points: [number, number][]): string {
  let expression = String(points.at(-1)![1])
  for (let index = points.length - 2; index >= 0; index--) {
    const [x, y] = points[index], [nextX, nextY] = points[index + 1]
    expression = `((${input}) < ${nextX} ? (${y}+(${nextY - y})*((${input})-(${x}))/(${nextX - x})) : ${expression})`
  }
  return `((${input}) <= ${points[0][0]} ? ${points[0][1]} : ${expression})`
}

/** Adapt one pinned TI release without accepting a merely similar-looking file. */
export function adaptOfficialTlv431(source: Uint8Array, expectedHash = LIB_SHA256): ImportedSpiceModel {
  if (createHash('sha256').update(source).digest('hex') !== expectedHash) throw new Error('TI TLV431 源码指纹变化，须重新审核后才能使用')
  // Translate the fingerprinted original before the shared parser normalizes
  // behavioral expressions. Parsing first would consume these TABLE records.
  let code = decodeSpiceLibrary(source)
  if (!/^\.SUBCKT TLV431 A K Fdbk\s*$/im.test(code)
    || !/^V_V2\s+N59715 A 1\.24\s*$/im.test(code)
    || !/^G_G1\s+A STAGE1 Fdbk N59715 4\s*$/im.test(code)
    || !/^\.subckt DC_1mV_1A_1V_1nA A C\s*$/im.test(code)) throw new Error('TI TLV431 厂商参考的引脚或内部基准拓扑不符')
  // These two fixed PSpice TABLE sources require translation for the bundled
  // ngspice build. The point lists and electrical connections stay unchanged.
  code = exactlyOne(code, /^G_G4\s+K A TABLE \{ V\(STAGE2, A\) \}\s*\+\s*\( \(-10,0\)\(0,0\)\(15m,15m\)\(10,16m\) \)\s*$/gim,
    `B_G4 K A I={${tableExpression('V(STAGE2,A)', [[-10, 0], [0, 0], [0.015, 0.015], [10, 0.016]])}}`)
  code = exactlyOne(code, /^G1 A C TABLE \{ V\(A, C\) \} \( \(-1,-1n\)\(0,0\)\(1m,1\) \(2m,10\) \(3m,1000\) \)\s*$/gim,
    `B1 A C I={${tableExpression('V(A,C)', [[-1, -1e-9], [0, 0], [0.001, 1], [0.002, 10], [0.003, 1000]])}}`)
  const preview = parseSpiceLibrary(code, originalSource)
  const model = preview.models.find(item => item.id === 'TLV431')
  if (!model || model.type !== 'SUBCKT' || JSON.stringify(model.pins) !== JSON.stringify(['A', 'K', 'Fdbk'])
    || preview.diagnostics.some(item => item.severity === 'error')
    || createHash('sha256').update(model.spice).digest('hex') !== ADAPTED_SHA256)
    throw new Error(`TI TLV431 模型未通过固定拓扑校验：${preview.diagnostics.map(item => item.message).join('；')}`)
  return model
}

export async function loadOfficialTlv431(fetchBytes: (url: string, limit?: number) => Promise<Uint8Array> = fetchModelBytes): Promise<ImportedSpiceModel> {
  const archive = await fetchBytes(TLV431_ARCHIVE_URL, 1024 * 1024)
  if (archive.length > 1024 * 1024 || archive[0] !== 0x50 || archive[1] !== 0x4b) throw new Error('TI 未返回有效的 SLVM088 模型压缩包')
  const files = unzipSync(archive, { filter(file) {
    if (file.name === LIB_PATH) {
      if (file.originalSize > 64 * 1024 || ![0, 8].includes(file.compression)) throw new Error('TI TLV431 模型文件大小或压缩方式异常')
      return true
    }
    return false
  } })
  const source = files[LIB_PATH]
  if (!source) throw new Error('TI SLVM088 包中缺少已审定的 TLV431.LIB')
  return adaptOfficialTlv431(source)
}

export interface ShuntReferenceCalibration { impedanceOhms:number; referenceCurrentA:number }

/** In the pinned topology the linear output TABLE has unit slope, both stage
 * resistors and G_G3 have unit gain: dV(K)/dI(K)=1/G_G1 at DC. This maps a
 * typical low-frequency impedance; it does not fit the retained RC dynamics. */
export function tlv431Calibration(nominal:number, calibration:ShuntReferenceCalibration) {
  const {impedanceOhms,referenceCurrentA}=calibration
  if(!Number.isFinite(nominal)||nominal<0.5||nominal>5||!Number.isFinite(impedanceOhms)||impedanceOhms<0.001||impedanceOhms>10
    ||!Number.isFinite(referenceCurrentA)||referenceCurrentA<0.001||referenceCurrentA>0.014)
    throw new Error('基准校准需要有效典型阻抗和 1～14 mA 的测试电流；不得把额定最大电流当作限流参数')
  return {offset:Number((nominal-referenceCurrentA*impedanceOhms).toPrecision(12)), transconductance:Number((1/impedanceOhms).toPrecision(12))}
}

export function deriveTlv431Reference(reference: ImportedSpiceModel, target: string, nominal: number, datasheetUrl = '', fileName = '', calibration?:ShuntReferenceCalibration): ImportedSpiceModel {
  if (reference.id !== 'TLV431' || reference.kind !== 'X' || reference.type !== 'SUBCKT'
    || reference.source.url !== TLV431_ARCHIVE_URL || JSON.stringify(reference.pins) !== JSON.stringify(['A', 'K', 'Fdbk'])
    || ![ADAPTED_SHA256, LEGACY_ADAPTED_SHA256].includes(createHash('sha256').update(reference.spice).digest('hex'))
    || !/^\.SUBCKT TLV431 A K Fdbk\s*$/im.test(reference.spice)
    || !/^V_V2\s+N59715 A 1\.24\s*$/im.test(reference.spice)) throw new Error('参考模型不是已审定的 TI TLV431 拓扑')
  if (!/^[A-Z][A-Z0-9]{2,30}$/.test(target) || !Number.isFinite(nominal) || nominal < 0.5 || nominal > 5) throw new Error('目标型号或典型基准值无效')
  const mapped=calibration?tlv431Calibration(nominal,calibration):undefined
  const name = `${target}_APPROX`
  let spice = exactlyOne(reference.spice, /^\.SUBCKT TLV431 A K Fdbk\s*$/gim, `.SUBCKT ${name} A K Fdbk`)
  spice = exactlyOne(spice, /^V_V2\s+N59715 A 1\.24\s*$/gim, `V_V2 N59715 A ${mapped?.offset??nominal}`)
  if(mapped)spice=exactlyOne(spice,/^G_G1\s+A STAGE1 Fdbk N59715 4\s*$/gim,`G_G1 A STAGE1 Fdbk N59715 ${mapped.transconductance}`)
  spice = exactlyOne(spice, /^\.ENDS TLV431\s*$/gim, `.ENDS ${name}`)
  const source: SpiceModelSource = {
    label: `TI TLV431 拓扑派生近似 · ${target} · 未经目标器件验证`,
    url: reference.source.url,
    license: reference.source.license,
    attribution: `原始厂商模型 ${reference.id}，${LIB_PATH} SHA-256 ${LIB_SHA256}；${mapped?`按典型低频阻抗 ${calibration!.impedanceOhms} Ω 将 G_G1 由 4 调为 ${mapped.transconductance} A/V，内部源 V_V2 由 1.24 调为 ${mapped.offset} V，在 IKA=${calibration!.referenceCurrentA} A 时校准 VREF=${nominal} V`:`内部基准源 V_V2 由 1.24 V 调为 ${nominal} V`}。端口、拓扑、RC、钳位和电流分段表沿用 TI TLV431；增益变化后的频率响应未按目标拟合。目标规格书 ${datasheetUrl || fileName}。该模型不是 ${target} 的厂商模型。`.slice(0, 1000),
  }
  const preview = parseSpiceLibrary(spice, source)
  const model = preview.models.find(item => item.id === name)
  if (!model || preview.diagnostics.some(item => item.severity === 'error') || JSON.stringify(model.pins) !== JSON.stringify(['A', 'K', 'Fdbk'])) throw new Error(`近似子电路未通过兼容解析：${preview.diagnostics.map(item => item.message).join('；')}`)
  return model
}
