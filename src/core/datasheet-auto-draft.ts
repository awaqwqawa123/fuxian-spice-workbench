import {hasDatasheetPartEvidence,datasheetModelName} from './datasheet-model-identity'
import type { DatasheetText } from './datasheet-text'
import { extractDatasheetParameters, inferDatasheetType, unsupportedDatasheetReason, selectAutomaticDatasheetParameters, type DatasheetParameter } from './datasheet-model'
import { createApproximateModel } from './model-search'
import { inspectShuntReference } from './datasheet-shunt-reference'
import { isCompatibleManufacturerTemplate } from './model-reference'
import type { ImportedModelKind, ImportedSpiceModel } from './spice-models'
import { rankModelReferences } from './model-reference-selection'
import { equivalentModelParameterValues } from './model-parameter-values'
import { assessModeling } from './modeling-assessment-builder'

export interface AutomaticDatasheetDraft {
  model?: ImportedSpiceModel
  template?: ImportedSpiceModel
  parameters: DatasheetParameter[]
  reason?: string
  warnings?:string[]
}

/** A downloaded file name or a related family number is not evidence for the requested orderable part. */
export function datasheetContainsExactPart(document: DatasheetText, part: string): boolean {
  return hasDatasheetPartEvidence(document,part)
}

/** Only unambiguous typical values with their extraction conditions may enter an automatic draft. */
export function draftFromDatasheet(document: DatasheetText, part: string, templates: ImportedSpiceModel[], sourceUrl = '', selectedKind?: ImportedModelKind): AutomaticDatasheetDraft {
  if (inspectShuntReference(document)) {
    return { parameters: [], reason: '已识别为三端可调基准，但尚未取得可修改的同类厂商子电路模板及参数映射。请交给模型助手查找厂商现有模型；规格书参数已保留，不会从零生成简化电路。' }
  }
  const blocked = unsupportedDatasheetReason(document)
  if (blocked) return { parameters: [], reason: blocked }
  if (!datasheetContainsExactPart(document, part)) return { parameters: [], reason: `规格书标题或订货信息未确认完整型号「${part.trim() || '未填写'}」；同系列资料或文件名不能代替型号证据。` }
  const type = inferDatasheetType(document)
  if (!type) return { parameters: [], reason: '规格书未明确识别为受支持的二极管、BJT、MOS 或 JFET 类型；不能沿用默认模板猜测。' }
  const identity = document.pages.slice(0, 3).map(page => page.text).join('\n')
  const explicitFamily = type === 'D' ? /\bdiode\b|二极管/i.test(identity)
    : type === 'NPN' || type === 'PNP' ? /\b(?:transistor|BJT)\b|三极管/i.test(identity) && !(/\bNPN\b/i.test(identity) && /\bPNP\b/i.test(identity))
      : type === 'NMOS' || type === 'PMOS' ? /\bMOSFET\b|\bMOS\s+transistor\b|MOS\s*管/i.test(identity) && !(/\bN[- ]channel\b/i.test(identity) && /\bP[- ]channel\b/i.test(identity))
        : /\bJFET\b|junction field.effect|结型场效应/i.test(identity)
  if (!explicitFamily) return { parameters: [], reason: '规格书中的器件类别描述不够明确，或同时包含不同极性；请人工确认后选择同类模板。' }
  const matching=templates.filter(item=>isCompatibleManufacturerTemplate(item,type))
  const extracted = extractDatasheetParameters(document, type)
  const {parameters,conflicts}=selectAutomaticDatasheetParameters(extracted,type)
  const ranked=rankModelReferences(matching,document,part)
  const selected=ranked.find(item=>item.eligibleForAutomaticDraft&&(!selectedKind||item.model.kind===selectedKind))??ranked.find(item=>item.eligibleForAutomaticDraft)
  const template=selected?.model??ranked[0]?.model??matching[0]
  if (!parameters.length) return { template, parameters: [],warnings:conflicts, reason: `没有同时具备可映射数值、测试条件、页码和明确典型值的参数；请核对原文后手动填写。${conflicts.join('；')}` }
  if(!selected)return {template,parameters,warnings:conflicts,reason:`尚未找到与 ${type} 同类、同极性且具备全部已映射显式参数的可追溯厂商模板；${ranked[0]?.missingData.join('；')??'需要同类厂商模板。'}`}
  const changed=parameters.filter(item=>{const comparison=selected.comparisons.find(row=>row.key===item.key);return !comparison||!equivalentModelParameterValues(comparison.referenceValue,item.value)})
  if(!changed.length)return {template,parameters,warnings:conflicts,reason:'全部安全映射参数与最佳厂商模板数值相同，本轮没有可报告的参数修改；其余行为仍继承模板。'}
  try {
    const model = createApproximateModel({ template:template!, name: datasheetModelName(part), datasheetUrl: sourceUrl, datasheetFile: document.fileName.slice(0, 180), parameters: changed.map(item => ({ key: item.key!, value: item.value, evidence: `${item.evidence}；${item.basis}；${item.note}` })) })
    model.source={...model.source,attribution:`目标完整型号 ${part}；SPICE 声明别名 ${model.id}。${model.source.attribution??''}`.slice(0,1000)}
    model.assessment = assessModeling({ model, reference: template, origin: 'derived', document, part })
    return { model, template, parameters,warnings:conflicts }
  } catch (error) {
    return { template, parameters, reason: `提取值未通过模型校验：${(error as Error).message}。请核对原文并手动修订。` }
  }
}
