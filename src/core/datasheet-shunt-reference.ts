import type { DatasheetText } from './datasheet-text'
import { type ImportedSpiceModel, type SpiceModelSource } from './spice-models'
import { parseModelLibraryPreview as parseSpiceLibrary } from './model-library-preview'

export interface ShuntReferenceVariant {
  part: string
  nominal: number
  page: number
  evidence: string
}

export interface ShuntReferenceEvidence {
  family: string
  variants: ShuntReferenceVariant[]
  impedanceOhms?: number
  impedanceEvidence?: string
  impedancePage?: number
  pinEvidence?: string
  pinPage?: number
  referenceCurrentA?: number
  referenceConditionEvidence?: string
  referenceConditionPage?: number
  reason?: string
}

/** Read only the manufacturer's explicit order-code table and DC characteristic.
 * A family PDF title or filename is never an exact order-code match. */
export function inspectShuntReference(document: DatasheetText): ShuntReferenceEvidence | undefined {
  const front = document.pages.slice(0, 3).map(page => page.text).join('\n')
  if (!/programmable\s+precision\s+reference|adjustable\s+shunt\s+(?:regulator|reference)/i.test(front)) return undefined
  const result: ShuntReferenceEvidence = { family: '', variants: [] }
  for (const page of document.pages.slice(0, 4)) {
    const lines = page.text.split(/\r?\n/).map(line => line.trim())
    let inVariantTable = false
    for (const line of lines) {
      if (/\bV\s*REF\s*\(\s*V\s*\)/i.test(line) && /\b(?:Device|Marking|Rank)\b/i.test(line)) inVariantTable = true
      const referenceCondition = line.match(/\bV\s*KA\s*=\s*V\s*REF\b.*\bI\s*KA\s*=\s*(\d+(?:\.\d+)?)\s*mA\b/i)
      if (referenceCondition && !result.referenceConditionEvidence) {
        result.referenceCurrentA = Number(referenceCondition[1]) / 1000
        result.referenceConditionEvidence = line; result.referenceConditionPage = page.number
      }
      const pin = line.match(/\b1\s*:\s*Ref\s*;\s*2\s*:\s*Cathode\s*;\s*3\s*:\s*Anode\b/i)
      if (pin) { result.pinEvidence = line; result.pinPage = page.number }
      const impedance = line.match(/\b(\d+(?:\.\d+)?)\s*[ΩΩ]\s*Typical\s+(?:Output|Dynamic)\s+Impedance\b/i)
        ?? line.match(/\bTypical\s+(?:Output|Dynamic)\s+Impedance\s*[:=]?\s*(\d+(?:\.\d+)?)\s*[ΩΩ]/i)
      if (impedance) {
        result.impedanceOhms = Number(impedance[1]); result.impedanceEvidence = line; result.impedancePage = page.number
      }
      // PDF text extraction keeps each classification row together. Require the
      // nominal in that row, rather than guessing from a nearby 1.24/1.25 number.
      const columns = line.split(/\t+/), part = columns[0]?.toUpperCase()
      const rank = columns.findIndex(column => /^\d+(?:\.\d+)?%$/.test(column))
      const nominalText = columns[rank + 1], nominal = Number(nominalText)
      if (inVariantTable && part && /^[A-Z]{1,8}\d{2,5}[A-Z0-9]{0,20}$/.test(part) && rank > 0
        && /^\d+(?:\.\d+)?$/.test(nominalText ?? '') && nominal > 0.1 && nominal < 10) {
        if (!result.variants.some(variant => variant.part === part)) result.variants.push({ part, nominal, page: page.number, evidence: line.slice(0, 160) })
      }
    }
  }
  const families = new Set(result.variants.map(item => item.part.match(/^[A-Z]{1,8}\d{2,5}/)?.[0]).filter((item): item is string => Boolean(item)))
  if (families.size === 1) result.family = [...families][0]
  if (!result.family || !front.toUpperCase().includes(result.family) || !result.pinEvidence || !result.impedanceOhms || !result.referenceCurrentA || !result.variants.length) {
    result.reason = '规格书尚未同时给出可核对的封装引脚顺序、型号对应的典型基准电压、测试电流与典型动态阻抗，不能生成三端基准近似模型。'
  }
  return result
}

export interface ShuntReferenceDraft {
  model?: ImportedSpiceModel
  reason?: string
  familyOnly: boolean
  evidence: string[]
  limitations: string[]
}

const limitations = [
  '仅静态直流行为近似；按 REF 与阴极短接及规格书规定的阴极测试电流校准典型基准电压。',
  '不模拟最小稳压电流、关断漏电、REF 输入电流、温漂、容性负载稳定性或频率响应。',
  '典型动态阻抗只作直流斜率；超出数据表测试区间的电流与耐压限制未建模。',
  '典型值不是精度保证，未拟合曲线、验证实物或确认未列出的订货后缀。',
]

/** Generate a review-only static model; the caller must import it separately. */
export function draftShuntReference(document: DatasheetText, requestedPart: string, sourceUrl = '', familyNominal?: number): ShuntReferenceDraft {
  const empty = (reason: string): ShuntReferenceDraft => ({ reason, familyOnly: Boolean(familyNominal), evidence: [], limitations })
  const sheet = inspectShuntReference(document)
  if (!sheet) return empty('不是已识别的三端可调基准规格书。')
  if (sheet.reason) return empty(sheet.reason)
  const request = requestedPart.trim().toUpperCase()
  const exact = sheet.variants.find(variant => variant.part === request)
  if (!exact && familyNominal === undefined) return empty(`规格书的型号表未列出「${request}」。已列出 ${sheet.variants.map(variant => variant.part).join('、')}；可明确选择系列典型电压，生成不冒充该订货型号的系列近似模型。`)
  const variant = exact ?? sheet.variants.find(item => item.nominal === familyNominal)
  if (!variant || (familyNominal !== undefined && variant.nominal !== familyNominal)) return empty('所选典型电压未在规格书型号表中得到证实。')
  const familyOnly = !exact
  const nominal = variant.nominal, impedance = sheet.impedanceOhms!, current = sheet.referenceCurrentA!
  // The differential shunt slope equals the quoted typical DC impedance.
  // At REF=CATHODE and the sheet's IKA test current, this offset yields VREF.
  // These are deliberately simple, transparent behavioral assumptions.
  if (!(nominal > 0 && nominal < 10 && impedance > 0 && impedance < 10)) return empty('规格书数值超出三端基准近似模型的可检查范围。')
  const offset = Number((nominal - current * impedance).toFixed(9))
  const id = familyOnly ? `${sheet.family}_FAMILY_${nominal.toFixed(2).replace('.', 'V')}_APPROX` : `${variant.part}_APPROX`
  const spice = `.subckt ${id} REF CATHODE ANODE\nBREG CATHODE ANODE I = max(0, (V(REF,ANODE)-${offset})/${impedance})\n.ends ${id}`
  const evidence = [
    `第 ${variant.page} 页型号表：${variant.evidence}（典型 VREF=${nominal} V）`,
    `第 ${sheet.referenceConditionPage} 页：${sheet.referenceConditionEvidence}（校准 IKA=${current} A）`,
    `第 ${sheet.impedancePage} 页：${sheet.impedanceEvidence}（典型阻抗 ${impedance} Ω）`,
    `第 ${sheet.pinPage} 页：${sheet.pinEvidence}（子电路引脚顺序 REF、CATHODE、ANODE）`,
  ]
  let url: URL | undefined
  if (sourceUrl.trim()) {
    try { url = new URL(sourceUrl) } catch { return empty('规格书来源网址格式不正确。') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return empty('规格书来源须为无凭据的 HTTP / HTTPS 网址。')
  }
  const source: SpiceModelSource = {
    label: `规格书静态近似 · ${familyOnly ? `${sheet.family} 系列` : variant.part} · 非厂商 SPICE 模型`,
    ...(url ? { url: url.href } : {}),
    license: '依据规格书公开参数编写的工作台原创近似电路；原规格书版权归厂商所有',
    attribution: `规格书 ${document.fileName}。${evidence.join('；')}。假设：${limitations.join('；')}${familyOnly ? `；目标型号 ${request} 未列于型号表，绝非该订货型号的认证模型。` : ''}`.slice(0, 1000),
  }
  const preview = parseSpiceLibrary(spice, source)
  if (preview.models.length !== 1 || preview.diagnostics.some(item => item.severity === 'error')) return empty(`子电路未通过导入校验：${preview.diagnostics.map(item => item.message).join('；')}`)
  return { model: preview.models[0], familyOnly, evidence, limitations }
}
