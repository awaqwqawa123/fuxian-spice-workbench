import type { ImportedSpiceModel } from './spice-models'
import { defaultModelSymbol, parseModelSymbol, type FunctionalSymbolFamilyId, type ModelSymbol } from './model-symbol'
import { functionalPinEvidenceForModel, indexFunctionalPinEvidence, type FunctionalPinEvidence, type FunctionalPinEvidenceIndex } from './model-pin-evidence'
import { additionalFunctionalFamilies } from './model-standard-functions'
import type { SpiceLibraryPreview } from './spice-models'

export type ShuntReferencePinRole = 'cathode' | 'anode' | 'reference'
export interface FunctionalSymbolFamily {
  id: FunctionalSymbolFamilyId
  label: string
  matches: (model: ImportedSpiceModel, evidence?: FunctionalPinEvidence) => boolean
  roles: (model: ImportedSpiceModel, evidence?: FunctionalPinEvidence) => readonly string[] | undefined
  draw: (model: ImportedSpiceModel, roles: readonly string[], evidence?: FunctionalPinEvidence) => ModelSymbol
}

const shuntFamilyName = /^(?:TL431|TL432|TLV431|TLV432|ATL431|ATL432|KA431|LM431|LMV431|AZ431|AS431|LR431|LR432)(?:[a-z0-9_.-]*)(?:\/[a-z0-9_][a-z0-9_.-]*)*$/i
function isShuntReference(model:ImportedSpiceModel,evidence?:FunctionalPinEvidence):boolean {
  if(model.kind!=='X'||model.type!=='SUBCKT')return false
  if(shuntFamilyName.test(model.id))return true
  if(evidence?.roles?.length===3&&['anode','reference','cathode'].every(role=>evidence.roles!.includes(role)))return true
  // Legacy AWB library names alone cannot supply a type or port map. Their
  // original creation annotations identify the device being modeled explicitly.
  const originalPart=evidence?.text.match(/Device model created by \S+ for (\S+) on /i)?.[1]
  return !!originalPart&&shuntFamilyName.test(originalPart)
}
const semanticAliases: Readonly<Record<string, ShuntReferencePinRole>> = {
  K: 'cathode', CATHODE: 'cathode',
  A: 'anode', ANODE: 'anode',
  R: 'reference', REF: 'reference', REFERENCE: 'reference', REFIN: 'reference', ADJ: 'reference', FDBK: 'reference',
}
interface ReviewedNumericPorts {
  modelId: string
  path: string
  ports: readonly string[]
  roles: readonly ShuntReferencePinRole[]
  evidence: string
}

/** Numeric nodes carry no semantics on their own. These source-specific
 * registrations come from explicit terminal comments in the actual originals. */
export const reviewedShuntReferencePorts: readonly ReviewedNumericPorts[] = [
  { modelId: 'TL431', path: 'Models/uncategorized/spice_complete/smps_cb.lib', ports: ['7', '6', '11'], roles: ['cathode', 'anode', 'reference'], evidence: '.SUBCKT TL431 7 6 11 followed by * K A FDBK (original lines 701–702)' },
  { modelId: 'TL431_MC', path: 'Models/uncategorized/spice_complete/m_ic.lib', ports: ['7', '6', '11'], roles: ['cathode', 'anode', 'reference'], evidence: '.SUBCKT TL431_MC 7 6 11 followed by * K A FDBK (original lines 177–178; repeated at 389–390)' },
  { modelId: 'TL431_TI', path: 'Models/uncategorized/spice_complete/ti.lib', ports: ['1', '2', '3'], roles: ['reference', 'anode', 'cathode'], evidence: 'Original aligned terminal comments REFERENCE / ANODE / CATHODE immediately precede .SUBCKT TL431_TI 1 2 3 (lines 857–861)' },
] as const
const communityRepo = 'kicad-spice-library/KiCad-Spice-Library', communityRevision = 'a8688952bcaab19f567bc4db237b60bde03ef310'

function registeredCommunityPath(raw?: string): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return undefined
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (url.hostname === 'raw.githubusercontent.com' && segments.slice(0, 2).join('/') === communityRepo && segments[2] === communityRevision) return segments.slice(3).join('/')
    if (url.hostname === 'github.com' && segments.slice(0, 2).join('/') === communityRepo && segments[2] === 'blob' && segments[3] === communityRevision) return segments.slice(4).join('/')
  } catch { /* Saved malformed URLs cannot supply terminal evidence. */ }
  return undefined
}

function shuntReferenceRoles(model: ImportedSpiceModel,evidence?:FunctionalPinEvidence): readonly ShuntReferencePinRole[] | undefined {
  if (model.pins.length !== 3) return undefined
  const named = model.pins.map(pin => semanticAliases[pin.trim().toUpperCase()])
  if (named.every(Boolean) && new Set(named).size === 3) return named
  if(evidence?.roles?.length===3&&new Set(evidence.roles).size===3&&evidence.roles.every(role=>['cathode','anode','reference'].includes(role)))return evidence.roles as ShuntReferencePinRole[]
  const path = registeredCommunityPath(model.source.url)
  return reviewedShuntReferencePorts.find(entry => entry.path === path && entry.modelId.toUpperCase() === model.id.toUpperCase() && entry.ports.every((port, index) => port === model.pins[index]))?.roles
}

function drawShuntReference(model: ImportedSpiceModel, roles: readonly string[]): ModelSymbol {
  const terminals: Record<ShuntReferencePinRole, { label: string; x: number; y: number }> = {
    cathode: { label: 'K', x: 0, y: -40 }, anode: { label: 'A', x: 0, y: 40 }, reference: { label: 'REF', x: -40, y: 0 },
  }
  // Standard three-terminal adjustable shunt reference convention. This is
  // an authored functional symbol, never a claim of imported vendor graphics.
  const lines = [
    [0, -40, 0, -14], [0, 16, 0, 40], [-40, 0, -8, 0],
    [-16, 16, 0, -14], [0, -14, 16, 16], [16, 16, -16, 16],
    [-16, -14, 16, -14], [-16, -14, -22, -20], [16, -14, 22, -8],
  ]
  return parseModelSymbol({ version: 1, shape: 'ltspice', origin: 'standard', title: model.id.slice(0, 32), pins: roles.map((role, index) => ({ index, ...terminals[role as ShuntReferencePinRole] })), geometry: lines.map(coords => ({ type: 'line', coords })) }, 'X', model.pins)
}

/** Add future functional families with their own positive identification,
 * reviewed terminal semantics and actual drawing, never a pin-count rule. */
export const functionalSymbolFamilies: readonly FunctionalSymbolFamily[] = [
  { id: 'adjustable-shunt-reference', label: '三端可调并联稳压基准', matches: isShuntReference, roles: shuntReferenceRoles, draw: drawShuntReference },
  ...additionalFunctionalFamilies,
]

export interface ModelFunctionalClassification {
  family?:FunctionalSymbolFamilyId
  label:string
  roles?:readonly string[]
  mapping:'verified'|'missing'
  reason:string
}
const nativeFamilies={D:'diode',Q:'discrete-bjt',M:'discrete-mosfet',J:'discrete-jfet'} as const
const nativeRoles={D:['anode','cathode'],Q:['collector','base','emitter'],M:['drain','gate','source'],J:['drain','gate','source']} as const
const nativeLabels={D:'二极管',Q:'双极型晶体管',M:'MOSFET',J:'JFET'} as const
const classificationCache=new WeakMap<ImportedSpiceModel,ModelFunctionalClassification>()
/** Function recognition and drawing availability are distinct. No classification
 * result changes a saved model's electrical order or existing wired anchors. */
export function classifyModelFunctionalSymbol(model:ImportedSpiceModel,libraryTextOrIndex?:string|FunctionalPinEvidenceIndex):ModelFunctionalClassification{
  if(libraryTextOrIndex!==undefined)return classifyFunctionalSymbol(model,libraryTextOrIndex)
  const cached=classificationCache.get(model)
  if(cached)return cached
  const result=classifyFunctionalSymbol(model)
  classificationCache.set(model,result)
  return result
}
function classifyFunctionalSymbol(model:ImportedSpiceModel,libraryTextOrIndex?:string|FunctionalPinEvidenceIndex):ModelFunctionalClassification{
  if(model.kind!=='X')return {family:model.kind==='D'?nativeDiodeFamily(model):nativeFamilies[model.kind],label:nativeLabels[model.kind],roles:nativeRoles[model.kind],mapping:'verified',reason:'原生 SPICE 器件类型明确规定端口顺序'}
  const index=typeof libraryTextOrIndex==='string'?indexFunctionalPinEvidence(libraryTextOrIndex):libraryTextOrIndex
  const evidence=functionalPinEvidenceForModel(model,index)
  const matches=functionalSymbolFamilies.filter(family=>family.matches(model,evidence)||family.id===evidence?.family)
  for(const family of matches){
    const roles=family.roles(model,evidence)
    if(!roles)continue
    let id:FunctionalSymbolFamilyId=family.id
    try{id=family.draw(model,roles,evidence).family??id}catch{/* Classification does not fabricate rejected geometry. */}
    return {family:id,label:family.label,roles,mapping:'verified',reason:evidence?.roles?'原件的明确有序端口定义已核对':'模型接口的完整命名端口已核对'}
  }
  // Embedded transistor/diode/switch models are implementation details; without
  // complete top-level roles they do not classify the enclosing IC as discrete.
  const identifiable=matches.filter(family=>!['discrete-bjt','discrete-mosfet','discrete-jfet','diode-subcircuit','passive-subcircuit','voltage-controlled-switch'].includes(family.id))
  const nameOnly={...model,name:model.id,detail:'',metadata:{}}
  const known=identifiable.find(family=>family.id===evidence?.family)??identifiable.find(family=>family.matches(nameOnly))??identifiable[0]
  return known?{family:known.id,label:known.label,mapping:'missing',reason:'已识别器件功能；原件中尚缺全部端口的明确功能对应关系，保留连接示意'}:{label:'未确认功能的子电路',mapping:'missing',reason:'缺少可核对的器件功能或完整端口含义，保留电气引脚连接示意'}
}

/** Keep electrical pin array/order untouched; this only supplies a diagram.
 * Verified imported geometry always takes priority over a functional fallback. */
export function resolveModelFunctionalSymbol(model: ImportedSpiceModel, libraryTextOrIndex?: string | FunctionalPinEvidenceIndex): ModelSymbol | undefined {
  let imported:ModelSymbol|undefined
  if (model.symbol?.shape === 'ltspice' && model.symbol.geometry?.length && model.symbol.origin !== 'standard') {
    try { imported=parseModelSymbol({ ...model.symbol, origin: 'imported' }, model.kind, model.pins) } catch { return undefined }
  }
  if(model.kind==='D'){
    const family=nativeDiodeFamily(model)
    if(!family)return undefined
    return parseModelSymbol({...defaultModelSymbol('D',model.id),origin:'standard',family},'D',model.pins)
  }
  if(model.kind!=='X')return imported??parseModelSymbol({...defaultModelSymbol(model.kind,model.id),origin:'standard',family:nativeFamilies[model.kind]},model.kind,model.pins)
  const index=typeof libraryTextOrIndex==='string'?indexFunctionalPinEvidence(libraryTextOrIndex):libraryTextOrIndex
  const evidence=functionalPinEvidenceForModel(model,index)
  for (const family of functionalSymbolFamilies) {
    if (!family.matches(model,evidence)&&family.id!==evidence?.family) continue
    const roles = family.roles(model,evidence)
    if (roles) {
      try{const symbol=family.draw(model, roles,evidence);return {...(imported??symbol),family:symbol.family??family.id}}catch{/* Unsupported coordinates/pins remain visibly unmapped. */}
    }
  }
  return imported
}

/** Catalogued device type is explicit evidence. BV alone never means zener. */
export function nativeDiodeFamily(model:ImportedSpiceModel):FunctionalSymbolFamilyId|undefined{
  if(model.kind!=='D')return undefined
  const type=model.metadata.type?.trim()
  if(!type)return 'diode'
  if(/\b(?:photodiode|photo diode)\b|光电二极管/i.test(type))return 'photodiode'
  if(/\bzener\b|稳压二极管/i.test(type))return 'zener-diode'
  if(/\bschottky\b|肖特基/i.test(type))return 'schottky-diode'
  if(/\b(?:varactor|varicap|tuning diode)\b|变容/i.test(type))return 'varactor'
  if(/\b(?:LED|light[- ]emitting)\b|发光/i.test(type))return 'led'
  return 'diode'
}

/** New previews only. Callers retain the original parser for saved project and
 * acquisition validation, so existing wired devices never acquire new anchors. */
export function enrichModelSymbols<T extends SpiceLibraryPreview>(preview:T,libraryText:string):T {
  const index=indexFunctionalPinEvidence(libraryText)
  return {...preview,models:preview.models.map(model=>{const symbol=resolveModelFunctionalSymbol(model,index);return symbol?{...model,symbol}:model})}
}
