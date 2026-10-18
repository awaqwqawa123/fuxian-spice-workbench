import type { DatasheetText } from './datasheet-pdf-text'
import { mentionedModelParts } from './model-tasks'

export interface DatasheetPartCandidate { part: string; page: number; evidence: string }
export interface DatasheetPartIdentification { part?: string; candidates: DatasheetPartCandidate[]; reason?: string }

const deviceDescription = /(?:MOSFET|JFET|transistor|diode|rectifier|amplifier|op[- ]?amp|comparator|regulator|controller|driver|sensor|switch|converter|thyristor|IGBT|N[- ]?channel|P[- ]?channel|晶体管|三极管|场效应|二极管|放大器|稳压|比较器|控制器|驱动|传感器)/i
const orderingHeading = /(?:ordering(?:\s+(?:information|data|guide))?|orderable\s+(?:device|part)|part\s+(?:number|no\.?|name)|device\s+(?:name|type)|型号|订购信息|订货型号)/i
const contextualMention = /(?:compared?\s+(?:with|to)|compatible\s+with|replac(?:e|ement|ing)|similar\s+to|alternative|see\s+(?:also|the)|for\s+example|such\s+as|e\.g\.|using\s+(?:an?\s+)?|相比|替代|类似|例如|配合|参考器件)/i
const sectionHeading = /^(?:\d[\d.]*\s+)?(?:applications?|features?|absolute\s+maximum|electrical\s+characteristics|typical\s+characteristics|pin\s+(?:configuration|description)|functional\s+block|package\s+(?:information|outline)|应用|特点|特性|极限参数|电气参数)/i
const metadata = /(?:https?:\/\/|www\.|©|copyright|revision|\brev\.?\s*[.:\d]|document\s*(?:no|number|id)|literature\s*(?:no|number)|\bdocid\b|文档编号|版本|修订)/i

function possiblePart(part: string): boolean {
  return !(/^(?:[A-F0-9]{16,}|(?:SL[AOUS]|SN[LOV]|SP[RZ]|SB[AU])\w*\d\w*|AN\d+|TN\d+|DN\d+|IEC\d+[A-Z0-9._-]*|ISO\d+[A-Z0-9._-]*|JE(?:DEC|SD)\d+[A-Z0-9._-]*|AEC[-_]?Q\d+|ESD\d+|IP\d+|DOC(?:ID|NO)?\d+\w*|(?:JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\d{4}|REV\w*\d\w*)$/i.test(part)
    || /^(?:SOT|SOIC|SO|SOP|MSOP|TSSOP|SSOP|DIP|DFN|QFN|TO|SC|WSON|SON|DSBGA|BGA|LQFP|TQFP|HTSSOP|VSSOP|TSOP|SOTFL|HVSSOP)[-_]?\d+(?:[-_]\w+)?$/i.test(part)
    || /^(?:FIG(?:URE)?|TABLE|PAGE|SECTION|TYPE|GRADE|CLASS|PACKAGE|ROHS|REACH|JEDEC|VERSION|VER|V|REV|PIN|CH|CHANNEL)[-_]?\d+\w*$/i.test(part)
    || /^(?:D[23]PAK|D2PAK[-_]\d+|D3PAK[-_]\d+|X[234]SON(?:[-_]?\d+)?|SIP[-_]\d{1,2})$/.test(part)
    || /^\d+(?:\.\d+)?(?:C|K|DEGC|DEGK)$/.test(part)
    || /^(?:VERSION|VER|REV)[-_.]?\d+(?:[._-]\d+)*[A-Z]?$/.test(part)
    || /(?:\.PDF|\.COM|\.ORG|\.NET)$/i.test(part)
    || /^\d{4}[-_.]\d{1,2}(?:[-_.]\d{1,2})?$/.test(part))
}

/** Identify document subjects from literal identity evidence, never from a filename or repaired OCR. */
export function identifyDatasheetParts(document: Pick<DatasheetText, 'fileName' | 'pages'>, selectedPart?:string): DatasheetPartIdentification {
  let abbreviatedVariants = false
  const found = new Map<string, DatasheetPartCandidate & { rank: number; order: boolean }>()
  for (const page of document.pages.slice(0, 60)) {
    const lines = page.text.slice(0, 100_000).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    let orderingUntil = -1
    let bodySection = false
    let applicationSection = false
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (orderingHeading.test(line) && !contextualMention.test(line)) orderingUntil = index + 12
      if (sectionHeading.test(line)) { bodySection = true; applicationSection = /applications?|应用/i.test(line); if (index > orderingUntil - 12) orderingUntil = -1 }
      if (/\uFFFD/.test(line) || metadata.test(line) || contextualMention.test(line)) continue
      const parts = mentionedModelParts(line).filter(possiblePart)
      if (!parts.length) continue
      const neighbors = lines.slice(Math.max(0, index - 1), index + 3).join(' ')
      const tokenOnly = line.replace(/[\s,;/()|、，]+/g, ' ').split(' ').every(token => !token || parts.includes(token.toUpperCase()))
      const early = page.number <= 3 && index < 14 && !bodySection
      const order = index <= orderingUntil && !/^(?:notes?|note\s*\d|备注|说明)\b/i.test(line)
      const identitySentence = /(?:\b(?:the|device|type|model|part)\s+|器件|型号|产品)/i.test(line) && deviceDescription.test(line)
      let rank = order ? 16 : early && tokenOnly ? 14 : early && deviceDescription.test(neighbors) ? 13 : identitySentence && !applicationSection ? 9 : 0
      // A repeated page header corroborates an existing subject; it cannot introduce an application part.
      if (!rank && page.number > 1 && index < 6 && tokenOnly) rank = 7
      if (!rank) continue
      if (parts.some(part => new RegExp(`${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[/]\\s*[A-Z]{1,4}(?![A-Z0-9])`, 'i').test(line))) abbreviatedVariants = true
      for (const part of parts) {
        const offset = line.toUpperCase().indexOf(part)
        const evidence = line.slice(Math.max(0, offset - 100), Math.max(0, offset - 100) + 500)
        const previous = found.get(part)
        if (!previous || rank > previous.rank) found.set(part, { part, page: page.number, evidence, rank, order })
      }
    }
  }
  const items = [...found.values()].filter(candidate => candidate.rank >= 9)
  // Ordering rows specify the actual suffixes. Do not silently select a generic family when variants exist.
  const subjects = items.filter(candidate => !items.some(other => other.order && other.part !== candidate.part
    && other.part.startsWith(candidate.part) && /^[-_.]?[A-Z0-9][A-Z0-9._-]*$/.test(other.part.slice(candidate.part.length))))
  const highest = Math.max(0, ...subjects.map(candidate => candidate.rank))
  const primary = subjects.filter(candidate => candidate.rank >= Math.max(9, highest - 2))
  if(selectedPart){const exact=primary.find(candidate=>candidate.part.toUpperCase()===selectedPart.trim().toUpperCase());if(exact)return {part:exact.part,candidates:[{part:exact.part,page:exact.page,evidence:exact.evidence}]}}
  const candidates = primary.sort((a, b) => b.rank - a.rank || a.page - b.page || a.part.localeCompare(b.part))
    .slice(0, 24).map(({ part, page, evidence }) => ({ part, page, evidence }))
  if (primary.length === 1 && !abbreviatedVariants) return { part: primary[0].part, candidates }
  return { candidates, reason: primary.length > 24 ? '规格书包含超过 24 个器件型号，仅显示前 24 个；请明确选择或填写需要建立模型的完整型号。' : primary.length || abbreviatedVariants ? '规格书包含多个器件型号，请选择需要建立模型的完整型号。' : '规格书没有可核实的器件身份文字；请选择原始型号或补充清晰的规格书。' }
}
