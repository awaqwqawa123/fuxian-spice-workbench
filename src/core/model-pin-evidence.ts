import type { ImportedSpiceModel } from './spice-models'
import type { FunctionalSymbolFamilyId } from './model-symbol'
import reviewed from './reviewed-model-pin-evidence.json'

/** Positive terminal evidence from model headers; no package-number inference. */
export interface FunctionalPinEvidence { ports: string[]; comments: string[]; roles?: string[]; text: string; family?:FunctionalSymbolFamilyId }
export type FunctionalPinEvidenceIndex = ReadonlyMap<string, FunctionalPinEvidence>

export function namedFunctionalPinRole(raw: string): string | undefined {
  const pin = raw.trim().toUpperCase().replace(/[ _]/g, '')
  const aliases: Record<string, string> = {
    K: 'cathode', CAT: 'cathode', CATHODE: 'cathode', A: 'anode', AN: 'anode', ANODE: 'anode',
    R: 'reference', REF: 'reference', REFERENCE: 'reference', REFIN: 'reference', ADJ: 'reference', FDBK: 'reference',
    C: 'collector', COL: 'collector', COLLECTOR: 'collector', B: 'base', BASE: 'base', E: 'emitter', EMITTER: 'emitter',
    D: 'drain', DRAIN: 'drain', G: 'gate', GATE: 'gate', S: 'source', SOURCE: 'source', BODY: 'body', BULK: 'body', SUBSTRATE: 'body',
    VCC: 'positive-supply', VDD: 'positive-supply', 'V+': 'positive-supply', VP: 'positive-supply', VSUP: 'positive-supply',
    '+V': 'positive-supply', '-V': 'negative-supply', '+VS': 'positive-supply', '-VS': 'negative-supply', VSP: 'positive-supply', VSN: 'negative-supply', '+IN': 'input-plus', '-IN': 'input-minus',
    VEE: 'negative-supply', VSS: 'negative-supply', 'V-': 'negative-supply', VN: 'negative-supply',
    GND: 'ground', GROUND: 'ground', COM: 'ground', COMMON: 'ground',
    GNDF: 'ground-force', GNDS: 'ground-sense', PGND:'power-ground', SGND:'signal-ground',
    VIN: 'input', INPUT: 'input', IN: 'input', VOUT: 'output', OUTPUT: 'output', OUT: 'output',
    VO:'output', OUTF:'output-force', OUTS:'output-sense', VOUTF:'output-force', VOUTS:'output-sense',
    TRIM:'trim', TEMP:'temperature', NR:'noise-reduction', BYPASS:'bypass',
    EN: 'enable', ENABLE: 'enable', SHDN: 'shutdown', SHUTDOWN: 'shutdown', SD: 'shutdown',
    NSD:'shutdown-low', NSHDN:'shutdown-low', SHTDN:'shutdown',
    FB: 'feedback', FEEDBACK: 'feedback', VREF: 'reference', SENSE: 'sense', SENS: 'sense',
    'RG+':'gain-positive','RG-':'gain-negative', RG1:'gain-positive',RG2:'gain-negative',
    VOCM:'output-common-mode', 'VOUT+':'output-plus','VOUT-':'output-minus',
    P: 'positive', PLUS: 'positive', N: 'negative', MINUS: 'negative',
    CP: 'control-positive', CN: 'control-negative', CTRLP: 'control-positive', CTRLN: 'control-negative',
    LEDA: 'led-anode', LEDANODE: 'led-anode', LEDK: 'led-cathode', LEDCATHODE: 'led-cathode',
    PRI1: 'primary-positive', PRI2: 'primary-negative', PRIMARY1: 'primary-positive', PRIMARY2: 'primary-negative',
    'PRI+': 'primary-positive', 'PRI-': 'primary-negative', P1: 'primary-positive', P2: 'primary-negative',
    SEC1: 'secondary-positive', SEC2: 'secondary-negative', SECONDARY1: 'secondary-positive', SECONDARY2: 'secondary-negative',
    'SEC+': 'secondary-positive', 'SEC-': 'secondary-negative', S1: 'secondary-positive', S2: 'secondary-negative',
  }
  if (aliases[pin]) return aliases[pin]
  // Channel identifiers are retained, never assigned from pin sequence.
  const plus = pin.match(/^(?:INP|VINP|INPLUS|NONINV|NONINVERTING|INPUT\+|IN\+|VIN\+|\+IN)([A-H1-8]?)$/) ?? pin.match(/^(?:IN|INPUT)([A-H1-8])(?:\+|P)$/)??pin.match(/^([A-H1-8])IN\+$/)
  if (plus) return `input-plus${plus[1] ? `:${plus[1]}` : ''}`
  const minus = pin.match(/^(?:INN|VINN|INMINUS|INV|INVERTING|INPUT-|IN-|VIN-|-IN)([A-H1-8]?)$/) ?? pin.match(/^(?:IN|INPUT)([A-H1-8])(?:-|N)$/)??pin.match(/^([A-H1-8])IN-$/)
  if (minus) return `input-minus${minus[1] ? `:${minus[1]}` : ''}`
  const out = pin.match(/^(?:OUT|OUTPUT|VOUT)([A-H1-8])$/)??pin.match(/^([A-H1-8])(?:OUT|OUTPUT)$/)
  return out ? `output:${out[1]}` : undefined
}

function descriptorRole(raw: string): string | undefined {
  const value = raw.trim().replace(/[|]/g, ' ').trim()
  const direct = namedFunctionalPinRole(value)
  if (direct) return direct
  const terms: [RegExp, string][] = [
    [/^NON[- ]?INVERTING (?:INPUT|IN)(?:\s+([A-H1-8]))?$/i, 'input-plus'],
    [/^INVERTING (?:INPUT|IN)(?:\s+([A-H1-8]))?$/i, 'input-minus'],
    [/^(?:POSITIVE POWER SUPPLY|POSITIVE SUPPLY|VCC|VDD)$/i, 'positive-supply'],
    [/^(?:NEGATIVE POWER SUPPLY|NEGATIVE SUPPLY|VEE|VSS)$/i, 'negative-supply'],
    [/^(?:OUTPUT|OUT)(?:\s+([A-H1-8]))?$/i, 'output'],
    [/^(?:REFERENCE|FEEDBACK INPUT|ADJUST(?:MENT)? PIN)$/i, 'reference'],
    [/^COLLECTOR$/i, 'collector'], [/^BASE$/i, 'base'], [/^EMITTER$/i, 'emitter'],
    [/^DRAIN$/i, 'drain'], [/^GATE$/i, 'gate'], [/^SOURCE$/i, 'source'], [/^(?:SUBSTRATE|BULK|BODY)$/i, 'body'],
    [/^(?:GROUND|COMMON)$/i, 'ground'], [/^(?:INPUT VOLTAGE|INPUT)$/i, 'input'],
    [/^(?:GROUND FORCE|FORCE GROUND)$/i,'ground-force'],[/^(?:GROUND SENSE|SENSE GROUND)$/i,'ground-sense'],
    [/^(?:OUTPUT FORCE|FORCE OUTPUT)$/i,'output-force'],[/^(?:OUTPUT SENSE|SENSE OUTPUT)$/i,'output-sense'],
    [/^(?:TEMPERATURE|TEMPERATURE OUTPUT)$/i,'temperature'],[/^(?:TRIM|TRIM PIN)$/i,'trim'],
    [/^(?:ANODE|CATHODE)$/i, value.toLowerCase()],
  ]
  for (const [pattern, role] of terms) { const match = value.match(pattern); if (match) return role + (match[1] ? `:${match[1].toUpperCase()}` : '') }
  return undefined
}

function explicitRoles(comments: string[], ports: string[]): string[] | undefined {
  const mapped = new Map<string, string>(), conflicting = new Set<string>()
  for (const line of comments) {
    const match = line.match(/^(?:PIN|NODE|TERMINAL|PORT)?\s*([\w.+-]+)\s*(?:=|:|\bis\b|->)\s*(.+)$/i)
    const port=match&&ports.find(port=>port.toUpperCase()===match[1].toUpperCase())
    if (!match || !port) continue
    const role = descriptorRole(match[2])
    if (role) { if (mapped.has(port) && mapped.get(port) !== role || namedFunctionalPinRole(port) && namedFunctionalPinRole(port)!==role) conflicting.add(port); mapped.set(port, role) }
  }
  if(conflicting.size)return undefined
  const combined=ports.map(port=>mapped.get(port)??namedFunctionalPinRole(port))
  if(combined.every(Boolean))return combined as string[]
  for(let index=0;index<comments.length-1;index++){
    const named=comments[index].match(/^PINOUT(?:\s+ORDER)?\s+(.+)$/i),numbered=comments[index+1].match(/^PINOUT(?:\s+ORDER)?\s+(.+)$/i)
    if(!named||!numbered)continue
    const labels=named[1].trim().split(/\s+/),numbers=numbered[1].trim().split(/\s+/)
    const amplifierRow=labels.some(label=>/^(?:OUT|OUTPUT)$/i.test(label))&&labels.some(label=>/^(?:V\+|\+V)$/i.test(label))&&labels.some(label=>/^(?:V-|-V)$/i.test(label))
    const roles=labels.map(label=>amplifierRow&&label==='+'?'input-plus':amplifierRow&&label==='-'?'input-minus':namedFunctionalPinRole(label))
    if(labels.length===ports.length&&roles.every(Boolean)&&numbers.length===ports.length&&numbers.every((number,index)=>number.toUpperCase()===ports[index].toUpperCase()))return roles as string[]
  }
  // Compact role rows explicitly introduce their ordered terminals.
  for (const line of comments) {
    const match = line.match(/^(?:PINS?|NODES?|CONNECTIONS?|TERMINALS?|PORTS?)\s*:\s*(.+)$/i)
    if (!match) continue
    const words = match[1].trim().split(/\s*[,;|]\s*|\s+/).filter(Boolean), roles = words.map(namedFunctionalPinRole)
    if (roles.length === ports.length && roles.every(Boolean)) return roles as string[]
  }
  // A complete standalone role row adjacent to the header is explicit order
  // evidence (e.g. '* Collector Base Emitter'), rather than an inferred type.
  const orderedRows=comments.map(line=>line.trim().split(/\s+/)).filter(words=>words.length===ports.length).map(words=>words.map(namedFunctionalPinRole)).filter(roles=>roles.every(Boolean))
  const uniqueRows=new Set(orderedRows.map(roles=>JSON.stringify(roles)))
  if(uniqueRows.size===1)return orderedRows[0] as string[]
  // An unheaded, fully aligned diagram is also explicit source evidence:
  // REFERENCE / | ANODE / | | CATHODE / | | |, then .SUBCKT 1 2 3.
  for(let start=0;start<comments.length;start++){
    const first=descriptorRole(comments[start])
    if(!first||comments[start].includes('|'))continue
    const roles:string[]=[]
    for(let cursor=start;cursor<comments.length;cursor++){
      const value=comments[cursor].trim()
      if(!value)continue
      const bars=(value.match(/\|/g)??[]).length,clean=value.replace(/\|/g,'').trim()
      if(!clean){if(roles.length===ports.length&&bars===ports.length)return roles;break}
      const role=descriptorRole(value)
      if(!role||bars!==roles.length)break
      roles.push(role)
      if(roles.length>ports.length)break
    }
  }
  // Legacy vendor ASCII diagrams show one named role on each line and vertical
  // bars carrying earlier roles to the following .SUBCKT declaration.
  const start = comments.findIndex(line => /^CONNECTIONS?\s*:/i.test(line))
  if (start >= 0) {
    const lines = comments.slice(start), roles: string[] = []
    let diagram = false
    for (const line of lines) {
      if (line.includes('|')) diagram = true
      const clean = line.replace(/^CONNECTIONS?\s*:\s*/i, '').replace(/[|]/g, '').trim()
      if (!clean) continue
      const role = descriptorRole(clean)
      if (!role) return undefined
      if((line.match(/\|/g)??[]).length!==roles.length)return undefined
      roles.push(role)
    }
    if (diagram && roles.length === ports.length) return roles
  }
  return undefined
}

/** Split once per complete source library, not once per downloaded model. */
export function indexFunctionalPinEvidence(text: string): FunctionalPinEvidenceIndex {
  const entries = new Map<string, FunctionalPinEvidence>(), duplicates = new Set<string>()
  const lines = text.replace(/\r\n/g, '\n').replace(/\n\s*\+/g, ' ').split('\n')
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index].match(/^\s*\.subckt\s+(\S+)\s+([^;$\n]*)/i)
    if (!header) continue
    const parts = header[2].trim().split(/\s+/), parameterStart = parts.findIndex(port => /^params?:?$/i.test(port) || port.includes('='))
    const ports = parameterStart < 0 ? parts : parts.slice(0, parameterStart)
    const before: string[] = [], after: string[] = []
    for (let cursor = index - 1; cursor >= 0 && index - cursor <= 40; cursor--) { const line = lines[cursor].trim(); if (!line) continue; if (!/^[*;]/.test(line)) break; before.unshift(line.replace(/^[*;]\s*/, '')) }
    for (let cursor = index + 1; cursor < lines.length && cursor - index <= 32; cursor++) { const line = lines[cursor].trim(); if (!line) continue; if (!/^[*;]/.test(line)) break; after.push(line.replace(/^[*;]\s*/, '')) }
    const comments = [...before, ...after], key = header[1].toUpperCase()
    const evidence = { ports, comments, roles: explicitRoles(comments, ports), text: comments.join('\n') }
    if (entries.has(key)) duplicates.add(key)
    entries.set(key, evidence)
  }
  for (const key of duplicates) entries.delete(key)
  return entries
}

interface ReviewedFile {vendor:string;path:string;sha256:string;models:{id:string;ports:string[];roles?:string[];family?:string}[]}
const reviewedEntries=new Map((reviewed.files as ReviewedFile[]).flatMap(file=>file.models.map(model=>[`${file.vendor}:${file.path.toUpperCase()}:${file.sha256}:${model.id.toUpperCase()}`,model] as const)))
/** Restore reviewed interface semantics when saved canonical SPICE omitted the
 * original comments. Require the exact original path, checksum, ID and ordered
 * ports. A matching physical pin count or a nearby model never supplies proof. */
export function functionalPinEvidenceForModel(model:ImportedSpiceModel,index?:FunctionalPinEvidenceIndex):FunctionalPinEvidence|undefined{
  const entry=(index??indexFunctionalPinEvidence(model.spice)).get(model.id.toUpperCase())
  const samePorts=(ports:readonly string[])=>ports.length===model.pins.length&&ports.every((port,index)=>port.toUpperCase()===model.pins[index].toUpperCase())
  if(entry&&samePorts(entry.ports)&&entry.roles)return entry
  const portMapping=model.deviceInfo?.portMapping
  if(portMapping&&samePorts(portMapping.ports)){
    const roles=portMapping.labels.map(namedFunctionalPinRole)
    if(roles.every(Boolean))return {ports:[...portMapping.ports],roles:roles as string[],comments:[portMapping.text],text:portMapping.text}
  }
  const label=model.source.label.replaceAll('\\','/'),hash=model.source.attribution?.match(/(?:SHA-?256)[^a-f0-9]{0,8}([a-f0-9]{64})/i)?.[1]?.toLowerCase()
  const tina=label.match(/^(?:TINA 本地库|本地 TINA|本机 TINA)\s*\/\s*(SPICELIB\/.+)$/i),pspice=label.match(/^(?:PSpice 本地库|本地 PSpice|本机 PSpice)\s*\/\s*(tools\/pspice\/library\/.+)$/i)
  const vendor=tina?'tina':pspice?'pspice':undefined,path=tina?.[1]??pspice?.[1]
  const sourceMatches=vendor==='tina'?model.source.url==='https://www.ti.com/tool/TINA-TI':vendor==='pspice'?model.source.url==='https://www.cadence.com/en_US/home/tools/system-design-and-verification/analog-mixed-signal-simulation/pspice.html':false
  const registered=vendor&&path&&hash&&sourceMatches?reviewedEntries.get(`${vendor}:${path.toUpperCase()}:${hash}:${model.id.toUpperCase()}`):undefined
  if(registered&&samePorts(registered.ports))return {ports:[...registered.ports],...(registered.roles?{roles:[...registered.roles]}:{}),comments:[],text:registered.roles?'已核对原件的明确有序端口定义':'原件明确识别器件功能；未核对电气端口含义',...(registered.family?{family:registered.family as FunctionalSymbolFamilyId}:{})}
  return entry&&samePorts(entry.ports)?entry:undefined
}
