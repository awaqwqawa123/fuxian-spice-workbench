import {hasDatasheetPartEvidence,datasheetModelName} from './datasheet-model-identity'
import {identifyDatasheetParts} from './datasheet-part-identification'
import type { DatasheetText } from './datasheet-text'
import { parseSpiceLibrary, type ImportedSpiceModel } from './spice-models'
import { isManufacturerReference, type ModelReferenceAdjustment } from './model-reference'
import { isOwnedVendorModelSource } from './installed-model-source'
import { indexFunctionalPinEvidence, namedFunctionalPinRole } from './model-pin-evidence'
import { hasUnreadableDatasheetText } from './datasheet-encoding'

export interface OpAmpReferenceParameter {
  key: string
  quantity: 'open-loop-gain' | 'gain-bandwidth'
  before: string
  equation: string
}
export interface OpAmpReferenceInspection {
  eligible: boolean
  reason?: string
  pins: string[]
  parameters: OpAmpReferenceParameter[]
}
export interface OpAmpDatasheetParameter {
  quantity: OpAmpReferenceParameter['quantity']
  value: number
  unit: 'V/V' | 'Hz'
  page: number
  evidence: string
  conditions: string
  statistic: 'typical'|'curve'
}
export interface OpAmpDatasheetInspection {
  eligible: boolean
  reason?: string
  targetPart: string
  parameters: OpAmpDatasheetParameter[]
}
const numberPattern = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?'
const constantPattern = `${numberPattern}(?:meg|[tgkmunpf])?`
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function constant(value: string): number | undefined {
  const match = value.match(new RegExp(`^(${numberPattern})(meg|[tgkmunpf]?)$`, 'i'))
  if (!match) return undefined
  const scales: Record<string, number> = { '': 1, t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 }
  const result = Number(match[1]) * scales[match[2].toLowerCase()]
  return Number.isFinite(result) ? result : undefined
}

/** Deliberately narrow: prove the entire E -> R/C -> unity E signal path.
 * A parameter name alone never establishes its electrical meaning. Proprietary
 * LTspice A devices and multi-block parameter scopes are not approximated here. */
export function inspectOpAmpReference(model: ImportedSpiceModel): OpAmpReferenceInspection {
  const fail = (reason: string): OpAmpReferenceInspection => ({ eligible: false, reason, pins: [...model.pins], parameters: [] })
  if (model.kind !== 'X' || model.type !== 'SUBCKT') return fail('参考必须是已有运放子电路。')
  if (/APPROX|^TEMPLATE_/i.test(model.id) || /APPROX|近似|derived|用户修改|用户编辑/i.test(model.source.label)) return fail('已派生的近似模型不能作为原厂参考。')
  const localLtspice = model.source.url === 'https://www.analog.com/en/resources/design-tools-and-calculators/ltspice-simulator.html' && /^本机 LTspice \/ (?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.(?:lib|sub|cir)$/i.test(model.source.label) && !model.source.label.includes('..')
  if (!isManufacturerReference(model) && !isOwnedVendorModelSource(model.source) && !localLtspice) return fail('参考缺少可追溯的厂商或已登记本地库来源。')
  const preview = parseSpiceLibrary(model.spice, model.source)
  if (preview.diagnostics.some(item => item.severity === 'error') || !preview.models.some(item => item.id.toLowerCase() === model.id.toLowerCase())) return fail('原参考不兼容工作台的 ngspice 导入边界；不能通过改参数修复专有元件或未知指令。')
  const pinEvidence = indexFunctionalPinEvidence(model.spice).get(model.id.toUpperCase())
  const named = model.pins.map(namedFunctionalPinRole)
  const symbolRoles = model.symbol?.family === 'operational-amplifier' && model.symbol.pins.length === model.pins.length && model.symbol.pins.every((pin, index) => pin.index === index) ? model.symbol.pins.map(pin => namedFunctionalPinRole(pin.label)) : undefined
  const roles = named.every(Boolean) ? named : pinEvidence?.roles ?? (symbolRoles?.every(Boolean) ? symbolRoles : undefined)
  const expected = ['input-plus', 'input-minus', 'positive-supply', 'negative-supply', 'output']
  if (model.pins.length !== 5 || !roles || expected.some(role => roles.filter(value => value === role).length !== 1)) return fail('缺少单通道五端口的明确 SPICE 端序证据；封装脚号不能替代模型端序。')
  if (!/operational amplifier|op[- ]?amp|运算放大器|运放/i.test([model.name, model.detail, pinEvidence?.text ?? '', model.symbol?.family ?? ''].join(' ')) && model.symbol?.family !== 'operational-amplifier') return fail('参考未被明确识别为运算放大器。')
  const lines = model.spice.replace(/\r/g, '').split('\n').map(line => line.replace(/;.*$/, '').trim()).filter(line => line && !line.startsWith('*'))
  if (lines.filter(line => /^\.subckt\b/i.test(line)).length !== 1 || lines.some(line => /^\.model\b|^X/i.test(line))) return fail('参考含独立依赖或内部模型；当前适配器尚未审核这些拓扑和参数作用域。')
  const header = lines.find(line => /^\.subckt\b/i.test(line))!.split(/\s+/)
  if (header.slice(2).some((pin, index) => pin.toLowerCase() !== model.pins[index]?.toLowerCase())) return fail('保存的端口与实际子电路声明不一致。')
  const values = new Map<string, string>()
  for (const line of lines.filter(line => /^\.param\b/i.test(line))) for (const match of line.matchAll(new RegExp(`\\b([a-z_]\\w*)\\s*=\\s*(${constantPattern})(?=\\s|$)`, 'gi'))) {
    const key = match[1].toUpperCase()
    if (values.has(key)) return fail('参考含重复参数声明，不能确定修改作用域。')
    values.set(key, match[2])
  }
  const plus = model.pins[roles.indexOf('input-plus')], minus = model.pins[roles.indexOf('input-minus')], out = model.pins[roles.indexOf('output')]
  const elements = lines.filter(line => !line.startsWith('.')).map(line => ({ line, parts: line.split(/\s+/) }))
  const gainSource = elements.find(({ parts }) => /^E/i.test(parts[0]) && parts.length === 6 && parts[2] === '0' && parts[3].toLowerCase() === plus.toLowerCase() && parts[4].toLowerCase() === minus.toLowerCase() && /^\{(?:A0|AOL|AVOL|GAIN)\}$/i.test(parts[5]))
  if (!gainSource) return fail('未发现已审核的显式开环增益方程；不会替换模型中的任意数字。')
  const gainKey = gainSource.parts[5].slice(1, -1).toUpperCase(), gainValue = values.get(gainKey)
  if (!gainValue || !(constant(gainValue)! >= 10)) return fail('开环增益参数须为可核对的正数 V/V 常量。')
  const drive = gainSource.parts[1]
  const resistor = elements.find(({ parts }) => /^R/i.test(parts[0]) && parts.length === 4 && parts[1].toLowerCase() === drive.toLowerCase() && parts[2] !== '0')
  if (!resistor) return fail('尚未证明参考的主极点网络。')
  const pole = resistor.parts[2], resistanceText = resistor.parts[3], resistanceKey = resistanceText.match(/^\{(\w+)\}$/)?.[1]?.toUpperCase()
  const resistance = constant(resistanceKey ? values.get(resistanceKey) ?? '' : resistanceText)
  if (!resistance || resistance <= 0) return fail('主极点电阻不是已知正数。')
  const capacitor = elements.find(({ parts }) => /^C/i.test(parts[0]) && parts[1].toLowerCase() === pole.toLowerCase() && parts[2] === '0' && /^C\S+\s+\S+\s+0\s+(?:\{[^{}]+\}|\S+)$/i.test(parts.join(' ')))
  const buffer = elements.find(({ parts }) => /^E/i.test(parts[0]) && parts.length === 6 && parts[1].toLowerCase() === out.toLowerCase() && parts[2] === '0' && parts[3].toLowerCase() === pole.toLowerCase() && parts[4] === '0' && parts[5] === '1')
  if (!capacitor || !buffer) return fail('尚未证明主极点到输出的单位增益路径。')
  // Additional devices connected to the gain/pole/output nodes could introduce
  // gain scaling, feedback or additional poles. Refuse instead of guessing.
  const path = new Set([gainSource, resistor, capacitor, buffer])
  if (elements.some(element => !path.has(element) && (!/^R/i.test(element.parts[0]) || element.parts.length !== 4 || element.parts.slice(1, 3).some(node => [drive, pole, out].some(signal => node.toLowerCase() === signal.toLowerCase()))))) return fail('参考含尚未审核的反馈、输出级或附加动态方程。')
  const parameters: OpAmpReferenceParameter[] = [{ key: gainKey, quantity: 'open-loop-gain', before: gainValue, equation: gainSource.line }]
  const compact = capacitor.line.replace(/\s/g, '').toUpperCase()
  const resistanceExpression = resistanceKey ?? resistanceText.toUpperCase()
  const expression = `{${gainKey}/(2*PI*GBW*${resistanceExpression})}`
  if (values.has('GBW') && compact.endsWith(expression) && constant(values.get('GBW')!)! > 0 && Math.abs((constant(values.get('PI') ?? '') ?? 0) - Math.PI) < 1e-12) parameters.push({ key: 'GBW', quantity: 'gain-bandwidth', before: values.get('GBW')!, equation: `${resistor.line}; ${capacitor.line}` })
  else if (!(constant(capacitor.parts[3] ?? '')! > 0) || capacitor.parts.length !== 4) return fail('电容表达式不属于已审核的 A0/(2*pi*GBW*R) 主极点方程。')
  // Ensure the editable parameter cannot also control an unrelated equation.
  for (const parameter of parameters) {
    const allowed = parameter.quantity === 'open-loop-gain' ? [gainSource, capacitor] : [capacitor]
    if (elements.some(element => new RegExp(`\\b${escape(parameter.key)}\\b`, 'i').test(element.line) && !allowed.includes(element))) return fail(`${parameter.key} 还控制其他未审核方程。`)
  }
  return { eligible: true, pins: [...model.pins], parameters }
}

/** Curve evidence may replace missing table values, never device identity. */
export function opAmpDatasheetIdentityReason(document: DatasheetText, targetPart: string): string | undefined {
  const target = targetPart.trim().toUpperCase(), front = document.pages.slice(0, 3).map(page => page.text).join('\n')
  if (!/^[A-Z][A-Z0-9_.-]{1,47}$/.test(target)) return '目标型号格式不明确。'
  if (!hasDatasheetPartEvidence(document,target)) return '规格书正文没有精确目标型号；文件名或系列前缀不能证明匹配。'
  if (hasUnreadableDatasheetText(front)&&!identifyDatasheetParts(document).candidates.some(candidate=>candidate.part.toUpperCase()===target)) return '规格书身份文字含不可读字符，请重新提取或确认完整型号与器件类型。'
  if (!/operational amplifiers?|op[- ]?amps?|运算放大器|运放/i.test(front) || /\bcomparators?\b/i.test(front)) return '规格书没有明确的运放身份，或同时涉及比较器。'
}

/** Accept only explicitly typical numeric rows with units and measurement
 * conditions. Min/max columns or a number near a feature bullet are not fits. */
export function inspectOpAmpDatasheet(document: DatasheetText, targetPart: string): OpAmpDatasheetInspection {
  const target = targetPart.trim().toUpperCase()
  const fail = (reason: string): OpAmpDatasheetInspection => ({ eligible: false, reason, targetPart: target, parameters: [] })
  const identityReason = opAmpDatasheetIdentityReason(document, target)
  if (identityReason) return fail(identityReason)
  const parameters: OpAmpDatasheetParameter[] = []
  for (const page of document.pages) {
    const lines = page.text.split(/\r?\n/)
    let commonConditions = ''
    for (const raw of lines) {
      const line = raw.trim()
      if (/electrical characteristics|电气特性/i.test(line)) commonConditions = ''
      const quantity = /gain[- ]?bandwidth|\bGBW\b|增益带宽/i.test(line) ? 'gain-bandwidth' : /open[- ]?loop(?: voltage)? gain|\bAOL\b|开环增益/i.test(line) ? 'open-loop-gain' : undefined
      const condition = line.match(/(?:V\s*S|V\s*CC|V\s*DD|supply(?: voltage)?|T\s*A|R\s*L)\s*=\s*[^;]+/i)?.[0]
      if (!quantity && condition && /unless otherwise noted|test conditions|conditions:|测试条件|除非另有说明/i.test(line)) commonConditions = condition
      const conditions = condition ?? commonConditions
      if (hasUnreadableDatasheetText(line) || hasUnreadableDatasheetText(conditions) || !/\btyp(?:ical)?\b/i.test(line) || /\bmin(?:imum)?\b|\bmax(?:imum)?\b/i.test(line)) continue
      if ([...line.matchAll(/\b(?:OPA|LM|TL|AD|ADA|OP|MAX|MCP)\d+[A-Z0-9_.-]*\b/gi)].some(match => match[0].toUpperCase() !== target)) continue
      if (!quantity || !conditions || !/\d/.test(conditions)) continue
      const unitPattern = quantity === 'gain-bandwidth' ? '(MHz|kHz|Hz)' : '(dB|V\\s*\/\\s*V)'
      const values = [...line.matchAll(new RegExp(`(${numberPattern})\\s*${unitPattern}\\b`, 'gi'))]
      if (values.length !== 1) continue
      const value = Number(values[0][1]), unit = values[0][2].replace(/\s/g, '').toLowerCase()
      const normalized = quantity === 'gain-bandwidth' ? value * (unit === 'mhz' ? 1e6 : unit === 'khz' ? 1e3 : 1) : unit === 'db' ? 10 ** (value / 20) : value
      if (!Number.isFinite(normalized) || normalized <= 0 || (quantity === 'gain-bandwidth' ? normalized > 1e10 : normalized < 10 || normalized > 1e12)) continue
      parameters.push({ quantity, value: normalized, unit: quantity === 'gain-bandwidth' ? 'Hz' : 'V/V', page: page.number, evidence: line, conditions, statistic: 'typical' })
    }
  }
  if (!parameters.length) return fail('尚未找到含典型值、明确单位和测试条件的增益/带宽参数行；不从最大值或模糊表格猜测。')
  for (const quantity of ['open-loop-gain', 'gain-bandwidth']) {
    const rows = parameters.filter(parameter => parameter.quantity === quantity)
    if (new Set(rows.map(row => `${row.value}|${row.conditions}`)).size > 1) return fail('规格书包含不同数值或测试条件；须先明确采用哪一行。')
  }
  return { eligible: true, targetPart: target, parameters: parameters.filter((parameter, index) => parameters.findIndex(value => value.quantity === parameter.quantity) === index) }
}

export interface OpAmpReferenceDraft {
  model?: ImportedSpiceModel
  reason?: string
  adjustments: ModelReferenceAdjustment[]
  evidence: string[]
  limitations: string[]
}
export function deriveOpAmpReference(input: { reference: ImportedSpiceModel; document: DatasheetText; targetPart: string; datasheetUrl?: string;curve?:{gain:number;gbw:number;page:number;evidence:string;conditions:string} }): OpAmpReferenceDraft {
  const limitations = ['仅表示目标器件的一个通道，不包含双/四运放的其他通道或封装连接。', '只调整已证明作用的典型小信号增益或主极点；参考的供电、电流、共模、输出摆幅、噪声、压摆率、温漂和大信号限制全部继承，未针对目标验证。', '增益与带宽可能耦合：若参考电容为固定值，修改增益也会改变增益带宽，未匹配的指标仍待校准。', '典型值不代表保证界限；该模型不是目标厂商发布或认证的 SPICE 模型。']
  const fail = (reason: string): OpAmpReferenceDraft => ({ reason, adjustments: [], evidence: [], limitations })
  const reference = inspectOpAmpReference(input.reference)
  if (!reference.eligible) return fail(reference.reason!)
  let sheet = inspectOpAmpDatasheet(input.document, input.targetPart)
  if(input.curve){
    const identityReason=opAmpDatasheetIdentityReason(input.document,input.targetPart)
    if(identityReason)return fail(identityReason)
    const curve=input.curve,target=input.targetPart.toUpperCase(),text=input.document.pages.map(page=>page.text).join('\n')
    if(!/^[A-Z0-9][A-Z0-9_.-]{1,47}$/.test(target)||!new RegExp(`(^|[^A-Z0-9_.+-])${escape(target)}(?=$|[^A-Z0-9_.+-])`,'i').test(text)||!input.document.pages.some(page=>page.number===curve.page)||!Number.isFinite(curve.gain)||curve.gain<10||curve.gain>1e12||!Number.isFinite(curve.gbw)||curve.gbw<=0||curve.gbw>1e10||!curve.evidence.trim()||!curve.conditions.trim())return fail('幅频拟合缺少绑定型号、原图页码或有效工作条件。')
    if(!reference.parameters.some(parameter=>parameter.quantity==='open-loop-gain')||!reference.parameters.some(parameter=>parameter.quantity==='gain-bandwidth'))return fail('此厂商模板没有同时可审定的增益和主极点参数，不能从曲线修改任意内部数字。')
    sheet={eligible:true,targetPart:target,parameters:[{quantity:'open-loop-gain',value:curve.gain,unit:'V/V',page:curve.page,evidence:curve.evidence,conditions:curve.conditions,statistic:'curve'},{quantity:'gain-bandwidth',value:curve.gbw,unit:'Hz',page:curve.page,evidence:curve.evidence,conditions:curve.conditions,statistic:'curve'}]}
    limitations[1]='仅据所选幅频曲线拟合单主极点小信号增益与带宽；参考的供电、共模、输出摆幅、噪声、压摆率、温漂和大信号限制仍继承，未针对目标验证。'
    limitations[3]='曲线读图是近似数据，不等于保证典型值或厂商认证模型；目标封装和全部通道仍须核对。'
  }
  if (!sheet.eligible) return fail(sheet.reason!)
  if (input.datasheetUrl) try { const url = new URL(input.datasheetUrl); if (url.protocol !== 'https:' || url.username || url.password) return fail('规格书来源须为无凭据的 HTTPS 地址。') } catch { return fail('规格书来源地址不合法。') }
  const id = `${datasheetModelName(sheet.targetPart)}_APPROX`
  const adjustments: ModelReferenceAdjustment[] = [], evidence: string[] = []
  let spice = input.reference.spice
  for (const parameter of reference.parameters) {
    const row = sheet.parameters.find(item => item.quantity === parameter.quantity)
    if (!row) continue
    const after = String(Number(row.value.toPrecision(12)))
    if (constant(parameter.before) === Number(after)) continue
    const source = `第 ${row.page} 页：${row.evidence}；测试条件：${row.conditions}`
    const pattern = new RegExp(`(\\b${escape(parameter.key)}\\s*=\\s*)${constantPattern}(?=\\s|$)`, 'gi')
    spice = spice.split('\n').map(line => /^\s*\.param\b/i.test(line) ? line.replace(pattern, (_, prefix: string) => `${prefix}${after}`) : line).join('\n')
    adjustments.push({ key: parameter.key, before: parameter.before, after, source, explanation: `仅修改显式参数；已审核方程：${parameter.equation}` })
    evidence.push(source)
  }
  if (!adjustments.length&&!input.curve) return fail('规格书参数与参考的已审核可修改参数没有交集。')
  if(!adjustments.length&&input.curve)evidence.push(`第 ${input.curve.page} 页曲线拟合与模板增益/带宽相同，保留原方程参数；${input.curve.evidence}；${input.curve.conditions}`)
  spice = spice.replace(new RegExp(`(^\\s*\\.subckt\\s+)${escape(input.reference.id)}(?=\\s|$)`, 'gim'), `$1${id}`).replace(new RegExp(`(^\\s*\\.ends\\s+)${escape(input.reference.id)}(?=\\s|$)`, 'gim'), `$1${id}`)
  const source = { ...input.reference.source, label: `规格书近似 / ${id} / 参考 ${input.reference.id}`.slice(0, 200), attribution: [input.reference.source.attribution, `目标完整型号 ${input.targetPart}；SPICE 声明名 ${id}；目标规格书 ${input.datasheetUrl || input.document.fileName}`, `原参考 ${input.reference.id}；${evidence.join('；')}`, limitations.join('；')].filter(Boolean).join('\n').slice(0, 1000) }
  const parsed = parseSpiceLibrary(spice, source)
  const model = parsed.models.find(item => item.id === id)
  if (!model || parsed.diagnostics.some(item => item.severity === 'error')) return fail('修改后的模型没有通过工作台导入校验。')
  return { model: { ...model, name: `${sheet.targetPart} 单通道近似`, detail: `${model.detail} ${limitations.join(' ')}`, metadata: { ...input.reference.metadata }, ...(input.reference.symbol ? { symbol: structuredClone(input.reference.symbol) } : {}) }, adjustments, evidence, limitations }
}
