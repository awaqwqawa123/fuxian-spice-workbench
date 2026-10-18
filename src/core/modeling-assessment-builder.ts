import type { DatasheetText } from './datasheet-text'
import { extractDatasheetParameters, inferDatasheetType, selectAutomaticDatasheetParameters } from './datasheet-model'
import { parseSpiceLibrary, type ImportedSpiceModel } from './spice-models'
import type { ModelReferenceAdjustment } from './model-reference'
import type { ModelReviewFact } from './model-review'
import { parseModelAssessment, type ModelAssessment, type ModelAssessmentItem } from './modeling-assessment'
import { inspectOpAmpDatasheet, inspectOpAmpReference } from './datasheet-opamp-reference'

export interface ModelingAssessmentInput {
  model?: ImportedSpiceModel; reference?: ImportedSpiceModel; origin?: 'downloaded' | 'derived'
  document?: DatasheetText; part?: string; adjustments?: ModelReferenceAdjustment[]; facts?: ModelReviewFact[]; reason?: string
}
export function modelingNumber(raw: string): number | undefined {
  const match = raw.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?(?:\s+(?:V|A|F|s|Hz|Ω|A\/V|V\/V))?$/i)
  if (!match) return undefined
  const scales: Record<string, number> = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 }
  const value = Number(match[1]) * (match[2] ? scales[match[2].toLowerCase()] : 1)
  return Number.isFinite(value) ? value : undefined
}
export function sameModelingValue(before: string, after: string): boolean {
  const a = modelingNumber(before), b = modelingNumber(after)
  return a !== undefined && b !== undefined ? a === b || Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * Number.EPSILON * 4 : before.trim() === after.trim()
}
function explicit(model?: ImportedSpiceModel): Map<string, string> {
  const result = new Map<string, string>()
  if (!model || model.kind === 'X') return result
  for (const match of model.spice.matchAll(/\b([a-z][a-z0-9_]*)\s*=\s*([^\s(),]+)/gi)) result.set(match[1].toUpperCase().replace(/^CJ0$/, 'CJO').replace(/^VTH0$/, 'VTO'), match[2])
  return result
}
type Quantity = { label: string; key?: string; pattern: RegExp }
const q = (label: string, pattern: RegExp, key?: string): Quantity => ({ label, pattern, key })
const shared = [q('温度变化与温漂', /temperature|tempco|温漂|温度/i), q('噪声', /noise|噪声/i)]
const profiles: Record<string, Quantity[]> = {
  D: [q('正向电流与电压曲线', /forward voltage|forward current|正向压降/i), q('反向漏电流', /reverse current|leakage|反向漏电/i), q('击穿电压及测试电流', /breakdown|V\s*\(?BR\)?|击穿/i, 'BV'), q('结电容与反偏曲线', /junction capacitance|\bCJO?\b|结电容/i, 'CJO'), q('反向恢复与开关行为', /reverse recovery|\btrr\b|反向恢复/i), ...shared],
  BJT: [q('直流增益与电流曲线', /h\s*FE|current gain|电流增益/i, 'BF'), q('基极发射极电压曲线', /base.emitter voltage|\bVBE\b|基极.*电压/i), q('输出特性与 Early 电压', /early|output characteristics|输出特性/i, 'VAF'), q('结电容', /capacitance|电容/i), q('特征频率与动态行为', /transition frequency|\bfT\b|switching|特征频率|开关/i), ...shared],
  MOS: [q('栅源阈值与测试条件', /threshold|V\s*GS\s*\(?th\)?|阈值/i, 'VTO'), q('导通电阻及工作条件', /R\s*DS\s*\(?on\)?|on.state resistance|导通电阻/i), q('转移特性与跨导', /transconductance|transfer characteristics|跨导|转移特性/i), q('输入输出与反馈电容', /\bCiss\b|\bCoss\b|\bCrss\b|capacitance|电容/i), q('栅极电荷与开关行为', /gate charge|\bQg\b|switching|栅极电荷|开关/i), q('体二极管与反向恢复', /body diode|reverse recovery|体二极管|恢复/i), ...shared],
  JFET: [q('截止电压与测试条件', /cutoff|V\s*GS\s*\(?off\)?|截止电压/i, 'VTO'), q('零栅压漏极电流', /\bIDSS\b|zero.gate|零栅压/i), q('跨导与转移曲线', /transconductance|transfer|跨导/i), q('结电容', /capacitance|电容/i), ...shared],
  shunt: [q('基准电压与测试电流', /reference voltage|\bVref\b|基准电压/i), q('低频动态阻抗', /impedance|阻抗/i), q('REF 输入电流', /reference input current|\bIref\b|输入电流/i), q('最小稳压电流', /minimum.*current|\bImin\b|最小.*电流/i), q('工作电流范围与限流', /cathode current|maximum.*current|阴极电流|100\s*mA/i), q('频率响应与容性负载稳定性', /stability|capacitive|frequency|稳定|容性|频率/i), ...shared],
  opamp: [q('开环增益', /open.loop gain|\bAOL\b|开环增益/i), q('增益带宽', /gain.bandwidth|\bGBW\b|增益带宽/i), q('输入失调电压', /offset voltage|失调电压/i), q('输入偏置电流', /bias current|偏置电流/i), q('压摆率', /slew rate|压摆率/i), q('共模输入范围', /common.mode|共模/i), q('输出摆幅与电流', /output swing|output current|输出摆幅|输出电流/i), q('供电范围与静态电流', /supply voltage|quiescent current|供电|静态电流/i), q('稳定性与负载响应', /stability|phase margin|capacitive|稳定|相位裕量|容性/i), ...shared],
  LDO: [q('输出电压与精度', /output voltage|accuracy|输出电压|精度/i), q('压差与负载条件', /dropout|压差/i), q('静态及关断电流', /quiescent|shutdown current|静态电流|关断电流/i), q('输出电流与保护', /output current|current limit|输出电流|限流/i), q('线性与负载调整率', /line regulation|load regulation|调整率/i), q('瞬态响应', /transient|瞬态/i), q('输出电容与稳定性', /capacitor|stability|输出电容|稳定/i), ...shared],
  IC: [q('供电范围与工作电流', /supply|quiescent|供电|静态电流/i), q('输入输出功能与阈值', /threshold|input|output|阈值|输入|输出/i), q('动态时序与响应', /delay|switching|bandwidth|transient|延迟|时序|带宽|瞬态/i), q('保护与工作边界', /current limit|protection|maximum|保护|限流|最大/i), ...shared],
}
function familyFor(input: ModelingAssessmentInput): string {
  const text = input.document?.pages.slice(0, 3).map(page => page.text).join('\n') ?? ''
  if (/shunt|programmable precision reference|三端|分流稳压/i.test(text) || input.model?.kind === 'X' && /^(?:TLV?43[12]|LR43[12])/i.test(input.model.id)) return 'shunt'
  if (/operational amplifier|op[- ]?amp|运放|运算放大器/i.test(text)) return 'opamp'
  if (/low.dropout|\bLDO\b|低压差/i.test(text)) return 'LDO'
  const type = input.document ? inferDatasheetType(input.document) : input.model?.type ?? input.reference?.type
  return type === 'D' ? 'D' : type === 'NPN' || type === 'PNP' ? 'BJT' : type === 'NMOS' || type === 'PMOS' ? 'MOS' : type === 'NJF' || type === 'PJF' ? 'JFET' : 'IC'
}
export function assessModeling(input: ModelingAssessmentInput): ModelAssessment {
  const family = familyFor(input), before = explicit(input.reference), after = explicit(input.model), items: ModelAssessmentItem[] = []
  let appliedForwardFit = false
  const represented = new Set<string>(), lines = input.document?.pages.flatMap(page => page.text.split(/\r?\n/).filter(line => line.trim()).map(line => ({ page: page.number, text: line.trim() }))) ?? []
  const opampReference = family === 'opamp' && input.reference ? inspectOpAmpReference(input.reference) : undefined
  for (const adjustment of input.adjustments ?? []) {
    const status = sameModelingValue(adjustment.before, adjustment.after) ? 'unchanged' : 'adjusted'
    const opampQuantity = opampReference?.parameters.find(item => item.key === adjustment.key)?.quantity
    const label = opampQuantity === 'open-loop-gain' ? '开环增益' : opampQuantity === 'gain-bandwidth' ? '增益带宽' : adjustment.key
    items.push({ label, key: adjustment.key, status, before: adjustment.before, after: adjustment.after, evidence: adjustment.source.slice(0, 2000), reason: status === 'unchanged' ? '目标数值与参考相同，未发生数值调整；仍需验证适用条件。' : adjustment.explanation.slice(0, 1000) })
    represented.add(adjustment.key.toUpperCase())
  }
  const type = input.document ? inferDatasheetType(input.document) : undefined
  if (input.document && type && type !== 'SUBCKT') {
    const extracted = extractDatasheetParameters(input.document, type)
    const selection = selectAutomaticDatasheetParameters(extracted, type), safe = selection.parameters
    appliedForwardFit = type === 'D' && ['IS','N','RS','TNOM'].every(key => safe.some(row => row.id === `diode-fit-${key}` && after.has(key) && sameModelingValue(after.get(key)!, row.value)))
    for (const row of extracted) {
      if (appliedForwardFit && row.curvePoint) continue // Full point evidence is retained with every jointly fitted parameter.
      if (row.key && represented.has(row.key.toUpperCase())) continue
      const mapped = safe.some(item => item.key === row.key && sameModelingValue(item.value, row.value)), old = row.key && before.get(row.key.toUpperCase()), value = row.key && after.get(row.key.toUpperCase())
      const applied = mapped && input.model && value && sameModelingValue(value, row.value)
      const conflict = row.key && selection.conflicts.find(item => item.startsWith(`${row.key} `))
      const status = input.origin === 'downloaded' ? 'inherited' : applied && old && sameModelingValue(old, value!) ? 'unchanged' : applied ? 'adjusted' : mapped && !input.model ? 'missing' : 'unmapped'
      items.push({ label: row.label.slice(0, 120), ...(row.key ? { key: row.key } : {}), status, ...(row.value ? { targetValue: row.value } : {}), ...(old ? { before: old } : {}), ...(value ? { after: value } : {}), evidence: row.evidence.slice(0, 2000),
        reason: status === 'inherited' ? '保留原始来源模型行为；尚未与该规格书工作条件或曲线交叉验证。' : status === 'unchanged' ? '可靠映射值与参考相同；不计为参数修改。' : status === 'adjusted' ? row.note.slice(0, 1000) : status === 'missing' ? '已识别可靠映射，但尚未取得适用模板或生成可用模型。' : `${conflict || row.note} 数值依据：${row.basis}。`.slice(0, 1000) })
      if (row.key) represented.add(row.key.toUpperCase())
    }
  }
  if (family === 'opamp' && input.document && input.part) for (const row of inspectOpAmpDatasheet(input.document, input.part).parameters) {
    const knob = opampReference?.parameters.find(item => item.quantity === row.quantity), label = row.quantity === 'open-loop-gain' ? '开环增益' : '增益带宽'
    if (knob && represented.has(knob.key.toUpperCase())) continue
    items.push({ label, ...(knob ? { key: knob.key, before: knob.before } : {}), status: knob && sameModelingValue(knob.before, String(row.value)) ? 'unchanged' : 'unmapped', targetValue: `${row.value} ${row.unit}`, evidence: `第 ${row.page} 页：${row.evidence}；${row.conditions}`.slice(0, 2000), reason: knob ? '该已审核指标未形成新的修改；其他动态及工作范围仍需核对。' : '有典型值和测试条件，但该参考尚缺已审核的参数方程映射。' })
  }
  for (const fact of input.facts ?? []) if (!items.some(item => item.label === fact.label)) {
    const nominalUnchanged = /与模板.*相同/.test(fact.note ?? '')
    const shuntKey = family === 'shunt' && /低频阻抗/.test(fact.label) ? 'G_G1 低频增益' : undefined
    const mapped = shuntKey && items.find(item => item.key === shuntKey)
    const calibration = family === 'shunt' && input.reference?.id.toUpperCase() === 'TLV431' && input.model && (input.adjustments ?? []).some(item => /V_V2|G_G1/.test(item.key))
    const condition = calibration && /校准测试电流/.test(fact.label), nominalMapped = calibration && /典型基准电压/.test(fact.label)
    items.push({ label: fact.label.slice(0, 120), ...(mapped ? { key: mapped.key } : nominalMapped ? { key: 'V_V2 校准偏置' } : {}), status: nominalUnchanged ? 'unchanged' : mapped ? mapped.status : nominalMapped ? 'adjusted' : condition ? 'unchanged' : 'unmapped', targetValue: `${fact.value}${fact.unit ? ` ${fact.unit}` : ''}`.slice(0, 160), ...(fact.evidence ? { evidence: fact.evidence.slice(0, 2000) } : {}), reason: (condition ? '已作为 VREF−IKA×Z 校准的测试条件采用；这是测试条件，并非模型限流参数的修改。' : fact.note ?? '资料事实；不等于已验证的独立模型参数映射。').slice(0, 1000) })
  }
  for (const [key, value] of after) if (input.reference && !represented.has(key) && before.has(key)) items.push({ label: `参考电气参数 ${key}`, key, status: 'inherited', before: before.get(key)!, after: value, reason: '这一显式电气参数从参考继承，尚未用目标数据确认；不能由其他指标推断其准确性。' })
  for (const quantity of profiles[family]) {
    if (appliedForwardFit && quantity.label === '正向电流与电压曲线') continue
    if (quantity.key && represented.has(quantity.key) || items.some(item => quantity.pattern.test(item.label))) continue
    const row = lines.find(line => quantity.pattern.test(line.text) && /\d/.test(line.text))
    const old = quantity.key && before.get(quantity.key), value = quantity.key && after.get(quantity.key)
    const knownParameter = quantity.key && (before.has(quantity.key) || after.has(quantity.key))
    const auditedShuntInheritance = family === 'shunt' && input.reference?.id.toUpperCase() === 'TLV431' && /工作电流范围|频率响应/.test(quantity.label)
    const inherited = input.model && (knownParameter || auditedShuntInheritance) && (!row || input.origin === 'downloaded')
    items.push({ label: quantity.label, ...(quantity.key ? { key: quantity.key } : {}), status: inherited ? 'inherited' : row ? 'unmapped' : 'missing', ...(row ? { targetValue: row.text.slice(0, 160), evidence: `第 ${row.page} 页：${row.text}`.slice(0, 2000) } : {}), ...(old ? { before: old } : {}), ...(value ? { after: value } : {}),
      reason: inherited ? '此行为继承来源模型，尚未按目标器件资料拟合或验证；没有资料不代表数值相同。' : row ? '已找到相关规格；尚无审核过的方程映射或所需曲线/测试条件，不能任意改动模型中的数字。' : '尚缺可核对的目标典型值、测试条件或曲线，需要继续查资料或测量。' })
  }
  if (!input.document) items.push({ label: '目标规格书与完整型号证据', status: 'missing', reason: '尚未绑定可核对的目标规格书；不能证明其余模型行为符合目标器件。' })
  items.push({ label: '器件曲线与实际使用条件验证', status: 'missing', reason: '尚未运行该候选的器件曲线、温度、动态或实际电路对照仿真。静态语法通过不代表电气精度。' })
  const changed = new Set(items.filter(item => item.status === 'adjusted').map(item => item.key ?? item.label)).size, unchanged = new Set(items.filter(item => item.status === 'unchanged').map(item => item.key ?? item.label)).size
  const gaps = items.filter(item => ['unmapped', 'missing', 'inherited'].includes(item.status)).slice(0, 3).map(item => item.label).join('、')
  const syntax = input.model ? (() => { const parsed = parseSpiceLibrary(input.model.spice, input.model.source); return parsed.models.some(model => model.id === input.model!.id && JSON.stringify(model.pins) === JSON.stringify(input.model!.pins)) && !parsed.diagnostics.some(item => item.severity === 'error') ? 'passed' : 'failed' })() : 'unchecked'
  return parseModelAssessment({ version: 1, status: input.model ? input.origin === 'downloaded' ? 'original' : 'partial' : 'blocked', family,
    summary: `${input.model ? input.origin === 'downloaded' ? '已取得来源模型，未针对目标重新拟合。' : `当前仅覆盖 ${changed} 项调整、${unchanged} 项相同值，仍属部分建模。` : '尚未形成可用模型。'}${input.reason ? `${input.reason.slice(0, 300)} ` : ''}下一步核对：${gaps || '实际工作条件与曲线'}。`, items: items.slice(0, 80), validation: { syntax, simulation: 'not-run' } })
}
