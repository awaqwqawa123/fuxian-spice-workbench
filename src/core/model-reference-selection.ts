import {hasDatasheetPartEvidence} from './datasheet-model-identity'
import { extractDatasheetParameters, inferDatasheetType, selectAutomaticDatasheetParameters, type DatasheetParameter } from './datasheet-model'
import type { DatasheetText } from './datasheet-text'
import { manufacturerReferenceInfo, type ModelReferenceInfo } from './model-reference'
import type { ImportedModelType, ImportedSpiceModel } from './spice-models'
import { comparePreferredCatalogModels } from './model-source-policy'
import { spiceParameterNumber as numericValue } from './model-parameter-values'

export type ReferenceTechnology = 'MOS' | 'VDMOS'
export interface ModelReferenceEvidence {
  type?: ImportedModelType
  technology?: ReferenceTechnology
  parameters: DatasheetParameter[]
  knownData: DatasheetParameter[]
  missingData: string[]
  reason?: string
}
export interface ModelReferenceParameterComparison {
  key: string
  unit: string
  targetValue: string
  referenceValue: string
  targetNumeric: number
  referenceNumeric: number
  relativeDistance: number
  similarity: number
  page: number
  evidence: string
  basis: string
  note: string
}
export interface RankedModelReference {
  model: ImportedSpiceModel
  provenance: ModelReferenceInfo
  /** Similarity of evidenced constants, penalized for missing source constants; not accuracy or rated equivalence. */
  score?: number
  comparisons: ModelReferenceParameterComparison[]
  reasons: string[]
  knownData: DatasheetParameter[]
  missingData: string[]
  type: ImportedModelType
  technology?: ReferenceTechnology
  targetPart?: string
  eligibleForAutomaticDraft: boolean
}

const units: Record<string, string> = { BV: 'V', IBV: 'A', CJO: 'F', BF: '', VTO: 'V',IS:'A',RS:'Ω',N:'',TT:'s',VJ:'V',M:'',VAF:'V',NF:'',TF:'s',CJE:'F',CJC:'F',KP:'A/V²',LAMBDA:'1/V',CGSO:'F/m',CGDO:'F/m',CGS:'F',CGD:'F',CGDMIN:'F',CGDMAX:'F',BETA:'A/V²',TNOM:'°C' }
const expectedKeys: Partial<Record<ImportedModelType, string[]>> = {
  D: ['BV', 'IBV', 'CJO', 'TT'], NPN: ['BF', 'VAF', 'CJE', 'CJC', 'TF'], PNP: ['BF', 'VAF', 'CJE', 'CJC', 'TF'],
  NMOS: ['VTO', 'KP', 'capacitance'], PMOS: ['VTO', 'KP', 'capacitance'], NJF: ['VTO', 'BETA', 'CGS', 'CGD'], PJF: ['VTO', 'BETA', 'CGS', 'CGD'],
}
const canonicalKey = (key: string) => key.toUpperCase() === 'VTH0' ? 'VTO' : key.toUpperCase() === 'CJ0' ? 'CJO' : key.toUpperCase()

function referenceConstants(model: ImportedSpiceModel): Map<string, string> {
  // Comments and quoted catalogue fields cannot supply electrical evidence.
  const masked = model.spice.replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, ' ').replace(/^\s*\*[^\r\n]*/gm, '').replace(/[;$][^\r\n]*/g, '')
  const line = masked.replace(/\r?\n\s*\+/g, ' ').split(/\r?\n/).find(item => /^\s*\.model\s/i.test(item)) ?? ''
  const result = new Map<string, string>()
  for (const match of line.matchAll(/\b([a-z][a-z0-9_]*)\s*=\s*([^\s(),]+)/gi)) {
    if (numericValue(match[2]) !== undefined) result.set(canonicalKey(match[1]), match[2])
  }
  return result
}

/** Use the same reviewed mappings as datasheet generation. Ratings, ambiguous columns and cutoff measurements remain visible but unmapped. */
export function extractModelReferenceEvidence(document: DatasheetText, targetPart?: string): ModelReferenceEvidence {
  const text = document.pages.slice(0, 3).map(page => page.text).join('\n')
  const empty = (reason: string): ModelReferenceEvidence => ({ parameters: [], knownData: [], missingData: [reason], reason })
  if (targetPart) {
    if (!hasDatasheetPartEvidence(document,targetPart))
      return empty('规格书正文尚未确认目标完整型号，不能据此选择相似模板。')
  }
  const type = inferDatasheetType(document)
  if (!type || type === 'SUBCKT') return empty('规格书未识别为可映射的单器件类型；需要同类厂商子电路或人工核对。')
  const isMos = type === 'NMOS' || type === 'PMOS'
  const isJfet = type === 'NJF' || type === 'PJF'
  const explicitFamily = type === 'D' ? /\bdiode\b|二极管/i.test(text)
    : isMos ? /\bMOSFET\b|\bVDMOS\b|\bMOS\s+(?:transistor|model|LEVEL)\b|MOS\s*管/i.test(text)
      : isJfet ? /\bJFET\b|junction field.effect|结型场效应/i.test(text) : /\btransistor\b|\bBJT\b|三极管/i.test(text)
  const mixedPolarity = (type === 'NPN' || type === 'PNP') && /\bNPN\b/i.test(text) && /\bPNP\b/i.test(text)
    || (isMos || isJfet) && /\bN[- ]channel\b|N\s*沟道/i.test(text) && /\bP[- ]channel\b|P\s*沟道/i.test(text)
  if (!explicitFamily || mixedPolarity) return empty('器件类别或极性描述不明确，不能自动沿用单一类型模板。')
  // Physical device descriptions such as planar/trench alone do not establish a SPICE equation family.
  const vdmos = isMos && /\bVDMOS\b|vertical\s+(?:double[- ]diffused\s+)?MOS/i.test(text)
  const mos = isMos && /\bMOS\s+(?:model\s+)?LEVEL\s*[=:]?\s*[123]\b|\.model\s+\S+\s+[NP]MOS\b/i.test(text)
  if (vdmos && mos) return empty('规格书同时出现 MOS 与 VDMOS 方程族，需确认目标建模技术。')
  const technology: ReferenceTechnology | undefined = vdmos ? 'VDMOS' : mos ? 'MOS' : undefined
  const knownData = extractDatasheetParameters(document, type)
  const {parameters,conflicts}=selectAutomaticDatasheetParameters(knownData,type)
  const missingData = [...conflicts,...(expectedKeys[type] ?? []).filter(key => !parameters.some(item=>item.key===key)).map(key => `规格书缺少可可靠映射的 ${key} 典型值及测试条件。`)]
  for (const item of knownData) if (!parameters.some(accepted=>item.key===accepted.key&&numericValue(item.value)===numericValue(accepted.value))) missingData.push(`${item.label}（第 ${item.page} 页）仅保留为核对依据：${item.note}`)
  if (isMos && !technology) missingData.push('目标 SPICE 方程族尚未确认（MOS / VDMOS）；初始近似沿用所选原厂模板方程族，这项继承假设需要后续验证，不能凭阈值相近证明技术等效。')
  if (!parameters.length) missingData.push('没有可比较的映射参数，候选仅具有类型与来源信息，尚无数值相似度。')
  return { type, technology, parameters, knownData, missingData }
}

/** Rank all eligible source models before a caller truncates results. Never invent absent source constants or infer component ratings from a match. */
export function rankModelReferences(models: readonly ImportedSpiceModel[], document: DatasheetText, targetPart?: string): RankedModelReference[] {
  const target = extractModelReferenceEvidence(document, targetPart)
  if (!target.type || target.reason) return []
  const ranked: RankedModelReference[] = []
  for (const model of models) {
    if (model.type !== target.type || model.kind === 'X') continue
    const provenance = manufacturerReferenceInfo(model)
    if (!provenance) continue
    const technology = model.kind === 'M' ? model.technology === 'VDMOS' ? 'VDMOS' : 'MOS' : undefined
    if (target.technology && target.technology !== technology) continue
    const constants = referenceConstants(model), comparisons: ModelReferenceParameterComparison[] = [], missingData = [...target.missingData]
    const measuredTemperature=target.parameters.some(item=>item.key==='TNOM')&&!constants.has('TNOM')
    for (const item of target.parameters) {
      const key = canonicalKey(item.key!), referenceValue = constants.get(key), targetNumeric = numericValue(item.value)!
      if (referenceValue === undefined) { missingData.push(key==='TNOM'?'原模板未显式标注 TNOM，原校准温度未知；仅按目标曲线明确温度新增 TNOM，不猜测模拟器默认温度。':`参考模型没有显式 ${key}，不使用模拟器默认值补齐。`); continue }
      const referenceNumeric = numericValue(referenceValue)!
      const relativeDistance = Math.abs(referenceNumeric - targetNumeric) / Math.max(Math.abs(referenceNumeric), Math.abs(targetNumeric), Number.MIN_VALUE)
      const sameSign = key==='TNOM'||Math.sign(referenceNumeric) === Math.sign(targetNumeric)
      const similarity = referenceNumeric === targetNumeric ? 1 : !sameSign ? 0 : 1 / (1 + Math.abs(Math.log(Math.abs(referenceNumeric)) - Math.log(Math.abs(targetNumeric))))
      comparisons.push({ key, unit: units[key] ?? '', targetValue: item.value, referenceValue, targetNumeric, referenceNumeric, relativeDistance, similarity, page: item.page, evidence: item.evidence, basis: item.basis, note: item.note })
    }
    const score = comparisons.length ? comparisons.reduce((sum, item) => sum + item.similarity, 0) / (target.parameters.length-Number(measuredTemperature))*(measuredTemperature ? .95 : 1) : undefined
    const reasons = [`同类同极性：${model.type}；来源：${provenance.label}。`, ...comparisons.map(item => `${item.key}：目标 ${item.targetValue}${item.unit}，参考 ${item.referenceValue}${item.unit}（第 ${item.page} 页）。`)]
    if (technology) reasons.push(`参考模型方程族为 ${technology}${target.technology ? '，与目标证据一致。' : '，初始近似沿用此方程族；目标规格书未确认该技术，属于需验证的继承假设。'}`)
    if (score === undefined) reasons.push('没有共同的可靠参数，无法给出数值相似度。')
    reasons.push('相似度仅比较有依据的初始模型参数，不证明额定值、噪声、动态响应或整体仿真精度等效；修改后需要验证。')
    const signsCompatible = comparisons.every(item => item.key==='TNOM'||Math.sign(item.referenceNumeric) === Math.sign(item.targetNumeric))
    if (!signsCompatible) missingData.push('参考参数与目标参数的符号不一致，需核对器件工作模式后再修改。')
    if(measuredTemperature)reasons.push('TNOM 仅来自目标曲线的明确温度，不是来源参数相似度证据；原参考温度未注明，相似度扣减 5%。')
    ranked.push({ model, provenance, score, comparisons, reasons, knownData: target.knownData, missingData, type: target.type, technology, targetPart, eligibleForAutomaticDraft: comparisons.length === target.parameters.length-Number(measuredTemperature) && comparisons.length > 0 && signsCompatible })
  }
  // Evidence/technology suitability wins; equally suitable templates use the
  // same library preference as browsing and exact-model acquisition.
  return ranked.sort((a, b) => Number(b.eligibleForAutomaticDraft)-Number(a.eligibleForAutomaticDraft)||(b.score ?? -1) - (a.score ?? -1) || b.comparisons.length - a.comparisons.length || comparePreferredCatalogModels(a.model,b.model) || a.model.id.localeCompare(b.model.id) || (a.model.source.url ?? '').localeCompare(b.model.source.url ?? ''))
}
