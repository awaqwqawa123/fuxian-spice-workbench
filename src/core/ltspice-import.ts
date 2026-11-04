import { parseProject, validateProject, type Project } from './circuit'
import { compileDrawing, emptyDrawing, parseDrawing, pinPosition, terminalKey, type Device, type Drawing, type NetLabelStyle, type Rotation, type Terminal, type XY } from './drawing'
import { parseLtspiceAsy, type LtspiceAsy } from './ltspice-symbol'
import { importSpiceDeck } from './spice-deck-import'

export interface LtspiceImportOptions {
  sourceName?: string
  /** Decoded ASY files keyed by relative path; lookup is case insensitive. */
  symbols?: Record<string, string>
  /** Already expanded .include / .lib model dependencies. */
  modelText?: string
}

type Kind = 'R' | 'C' | 'L' | 'V' | 'I' | 'D' | 'Q' | 'M' | 'J' | 'X'
interface SymbolDefinition { kind: Kind; pins: XY[]; attrs: Record<string, string>; asy?: LtspiceAsy; center?: XY; text?: string }
interface Part { name: string; at: XY; orientation: string; attrs: Record<string, string>; definition?: SymbolDefinition; id?: string; deckId?: string; pins?: XY[]; nodes?: string[] }
interface Flag { at: XY; name: string }
interface AscDocument { parts: Part[]; wires: [XY, XY][]; flags: Flag[]; ports: Map<string, NetLabelStyle>; directives: string[]; warnings: string[] }
const key = (p: XY) => `${p.x},${p.y}`
const normalizePath = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\.asy$/i, '').toLowerCase()
function fail(message: string): never { throw new Error(`LTspice 导入：${message}`) }
/** Synchronous browser-safe SHA-256 of the decoded UTF-8 ASY source. */
function sourceDigest(text: string): string {
  const input = new TextEncoder().encode(text), length = Math.ceil((input.length + 9) / 64) * 64, data = new Uint8Array(length)
  data.set(input); data[input.length] = 0x80
  const view = new DataView(data.buffer); view.setUint32(length - 8, Math.floor(input.length / 0x20000000)); view.setUint32(length - 4, input.length * 8)
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const k = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]
  const rotate = (value: number, bits: number) => value >>> bits | value << (32 - bits), words = new Uint32Array(64)
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) { const a = words[i - 15], b = words[i - 2]; words[i] = words[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ a >>> 3) + words[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ b >>> 10) }
    let [a, b, c, d, e, f, g, z] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (z + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + (e & f ^ ~e & g) + k[i] + words[i]) >>> 0
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + (a & b ^ a & c ^ b & c)) >>> 0
      z = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    ;[a, b, c, d, e, f, g, z].forEach((value, index) => { h[index] = (h[index] + value) >>> 0 })
  }
  return h.map(value => value.toString(16).padStart(8, '0')).join('')
}
const numericCoordinate = (text: string) => {
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Math.abs(Number(text)) > 1e7) fail(`坐标 ${text} 无效。`)
  return Number(text)
}
const point = (x: string, y: string): XY => ({ x: numericCoordinate(x), y: numericCoordinate(y) })
const transform = (p: XY, orientation: string, at: XY): XY => {
  const angle = Number(orientation.slice(1)) * Math.PI / 180
  const c = Math.round(Math.cos(angle)), s = Math.round(Math.sin(angle)), mirror = orientation[0] === 'M' ? -1 : 1
  return { x: at.x + mirror * (p.x * c - p.y * s), y: at.y + p.x * s + p.y * c }
}
const scaled = (p: XY, scale: number): XY => {
  const result = { x: p.x * scale, y: p.y * scale }
  if ([result.x, result.y].some(value => !Number.isInteger(value) || value % 20 !== 0 || Math.abs(value) > 20000)) fail(`原图坐标 (${p.x}, ${p.y}) 无法按统一比例保真映射到画布网格或超出 ±20000 范围；未移动或取整原走线。`)
  return result
}

// Terminal coordinates checked against the locally installed original LTspice
// lib/sym ASY files. Only these positively identified standard symbols can use
// the workbench's standard functional graphics without an accompanying ASY.
const stock: Record<string, { kind: Kind; pins: number[][] }> = {
  res: { kind: 'R', pins: [[16, 16], [16, 96]] },
  cap: { kind: 'C', pins: [[16, 0], [16, 64]] },
  polcap: { kind: 'C', pins: [[16, 0], [16, 64]] },
  ind: { kind: 'L', pins: [[16, 16], [16, 96]] },
  voltage: { kind: 'V', pins: [[0, 16], [0, 96]] },
  current: { kind: 'I', pins: [[0, 0], [0, 80]] },
  diode: { kind: 'D', pins: [[16, 0], [16, 64]] },
  zener: { kind: 'D', pins: [[16, 0], [16, 64]] },
  schottky: { kind: 'D', pins: [[16, 0], [16, 64]] },
  led: { kind: 'D', pins: [[16, 0], [16, 64]] },
  npn: { kind: 'Q', pins: [[64, 0], [0, 48], [64, 96]] },
  pnp: { kind: 'Q', pins: [[64, 0], [0, 48], [64, 96]] },
  nmos: { kind: 'M', pins: [[48, 0], [0, 80], [48, 96]] },
  pmos: { kind: 'M', pins: [[48, 0], [0, 80], [48, 96]] },
  nmos4: { kind: 'M', pins: [[48, 0], [0, 80], [48, 96], [48, 48]] },
  pmos4: { kind: 'M', pins: [[48, 0], [0, 80], [48, 96], [48, 48]] },
  njf: { kind: 'J', pins: [[48, 0], [0, 64], [48, 96]] },
  pjf: { kind: 'J', pins: [[48, 0], [0, 64], [48, 96]] },
}

function parseAsc(text: string): AscDocument {
  if (typeof text !== 'string' || text.length > 4 * 1024 * 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) fail('需要 4 MB 以内的文本 ASC，不能导入二进制或控制字符。')
  text = text.replace(/^\uFEFF/, '')
  if (!/^Version 4(?:\.1)?\s*$/im.test(text.replace(/\r/g, ''))) fail('仅支持 LTspice Version 4 / 4.1 文本原理图。')
  const result: AscDocument = { parts: [], wires: [], flags: [], ports: new Map(), directives: [], warnings: [] }
  let current: Part | undefined, graphics = false
  const seen = new Map<string, number>()
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim(); if (!line) continue
    const tokens = line.split(/\s+/), command = tokens[0].toUpperCase()
    if (command === 'VERSION' && /^Version 4(?:\.1)?$/i.test(line)) continue
    if (command === 'SHEET') { if (!/^SHEET\s+1\s+\d+\s+\d+$/i.test(line)) fail(`第 ${index + 1} 行：仅支持单页 SHEET 1。`); continue }
    if (command === 'WIRE') {
      if (tokens.length !== 5) fail(`第 ${index + 1} 行 WIRE 缺少四个坐标。`)
      const a = point(tokens[1], tokens[2]), b = point(tokens[3], tokens[4])
      if (a.x !== b.x && a.y !== b.y) fail(`第 ${index + 1} 行为斜线 WIRE；当前画布只能表示正交导线，无法保真导入该原图。请导出网表，或在 LTspice 中手动改为正交走线。`)
      if (key(a) === key(b)) fail(`第 ${index + 1} 行 WIRE 长度为零。`)
      result.wires.push([a, b]); continue
    }
    if (command === 'FLAG') {
      if (tokens.length !== 4 || !/^[a-z0-9_.$:+!-]{1,128}$/i.test(tokens[3])) fail(`第 ${index + 1} 行 FLAG 节点名不受支持。`)
      result.flags.push({ at: point(tokens[1], tokens[2]), name: tokens[3] }); continue
    }
    if (command === 'IOPIN') {
      const style: Record<string, NetLabelStyle> = { in: 'input', out: 'output', bidir: 'bidirectional' }
      if (tokens.length !== 4 || !style[tokens[3].toLowerCase()]) fail(`第 ${index + 1} 行 IOPIN 方向无效。`)
      const at = key(point(tokens[1], tokens[2])), old = result.ports.get(at)
      if (old && old !== style[tokens[3].toLowerCase()]) fail(`第 ${index + 1} 行 IOPIN 与同位置端口方向冲突。`)
      result.ports.set(at, style[tokens[3].toLowerCase()]); continue
    }
    if (command === 'SYMBOL') {
      if (tokens.length !== 5 || !/^[RM](0|90|180|270)$/.test(tokens[4])) fail(`第 ${index + 1} 行 SYMBOL 名称或朝向无效。`)
      current = { name: tokens[1], at: point(tokens[2], tokens[3]), orientation: tokens[4], attrs: {} }
      result.parts.push(current); continue
    }
    if (command === 'SYMATTR') {
      const match = line.match(/^SYMATTR\s+(\S+)\s+(.+)$/i)
      if (!current || !match) fail(`第 ${index + 1} 行 SYMATTR 缺少所属 SYMBOL 或值。`)
      const attr = match![1].toLowerCase(), value = match![2] === '""' ? '' : match![2]
      if (current.attrs[attr] !== undefined) fail(`第 ${index + 1} 行 ${current.attrs.instname ?? current.name}.SYMATTR ${attr} 重复。`)
      if (!['instname', 'value', 'value2', 'prefix', 'spiceline', 'spiceline2', 'spicemodel', 'modelfile', 'description'].includes(attr)) fail(`第 ${index + 1} 行不支持属性 ${match![1]}，不能静默删除其电气含义。`)
      current.attrs[attr] = value
      if (attr === 'instname') {
        if (!/^[a-z][a-z0-9_.-]{0,79}$/i.test(value)) fail(`第 ${index + 1} 行 InstName ${value} 格式无效。`)
        const old = seen.get(value.toLowerCase())
        if (old !== undefined) fail(`第 ${index + 1} 行 InstName ${value} 与第 ${old} 行重复，不能猜测重复编号的连接关系。`)
        seen.set(value.toLowerCase(), index + 1)
      }
      continue
    }
    if (command === 'TEXT') {
      const match = line.match(/^TEXT\s+-?\d+\s+-?\d+\s+\S+\s+\d+\s+([!;])(.*)$/i)
      if (!match) fail(`第 ${index + 1} 行 TEXT 格式无效。`)
      if (match![1] === '!') result.directives.push(...match![2].split(/\\n/).map(value => value.trim()).filter(Boolean))
      else graphics = true
      continue
    }
    if (['WINDOW', 'LINE', 'RECTANGLE', 'CIRCLE', 'ARC'].includes(command)) { graphics = true; continue }
    if (command === 'DATAFLAG') { result.warnings.push('原图 DATAFLAG 工作点数值标注未转换为静态数值；导入后请使用真实仿真探针。'); continue }
    fail(`第 ${index + 1} 行不支持 ASC 记录 ${tokens[0]}。`)
  }
  if (!result.parts.length) fail('ASC 没有器件。')
  if (result.parts.length > 79 || result.wires.length > 1000 || result.flags.length > 100) fail('超出导入上限：79 个器件、1000 条原始导线或 100 个 FLAG。')
  for (const at of result.ports.keys()) if (!result.flags.some(flag => key(flag.at) === at)) fail(`IOPIN (${at}) 缺少同位置 FLAG。`)
  if (graphics) result.warnings.push('原图注释、装饰图形及 WINDOW 文字偏移尚不能保存在当前工程中；器件相对位置、旋转、镜像及电气走线按原图导入。')
  return result
}

function definitionFor(part: Part, supplied: Record<string, string>): SymbolDefinition {
  const name = normalizePath(part.name), entries = Object.entries(supplied).map(([path, text]) => ({ path: normalizePath(path), text }))
  let matches = entries.filter(entry => entry.path === name)
  if (!matches.length) matches = entries.filter(entry => entry.path.split('/').at(-1) === name.split('/').at(-1))
  if (matches.length > 1) fail(`符号 ${part.name} 对应多个 ASY，请保留唯一的相对路径匹配。`)
  if (matches.length) {
    const text = matches[0].text
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) fail(`符号 ${part.name} 包含控制字符。`)
    const asy = parseLtspiceAsy(text, part.name), pins: { at: XY; order?: number }[] = [], attrs: Record<string, string> = {}, graphicPoints: XY[] = []
    let pin: typeof pins[number] | undefined
    for (const raw of text.split(/\r?\n/)) {
      const tokens = raw.trim().split(/\s+/), command = tokens[0].toUpperCase()
      if (command === 'PIN') { pin = { at: point(tokens[1], tokens[2]) }; pins.push(pin) }
      if (command === 'PINATTR' && tokens[1]?.toLowerCase() === 'spiceorder' && pin) pin.order = numericCoordinate(tokens[2])
      if (['LINE', 'RECTANGLE', 'CIRCLE', 'ARC'].includes(command)) {
        const count = command === 'ARC' ? 8 : 4
        for (let index = 2; index < count + 2; index += 2) graphicPoints.push(point(tokens[index], tokens[index + 1]))
      }
      if (command === 'SYMATTR') {
        const attr = tokens[1]?.toLowerCase()
        if (!['prefix', 'value', 'value2', 'spicemodel', 'modelfile', 'spiceline', 'spiceline2', 'description', 'modelname'].includes(attr)) fail(`符号 ${part.name} 的 ASY 属性 ${tokens[1]} 不受支持。`)
        if (attrs[attr] !== undefined) fail(`符号 ${part.name} 的 ASY 属性 ${tokens[1]} 重复。`)
        attrs[attr] = tokens.slice(2).join(' ')
      }
    }
    pins.sort((a, b) => a.order! - b.order!)
    if (pins.some((pin, index) => pin.order !== index + 1)) fail(`符号 ${part.name} 的 SpiceOrder 必须从 1 连续且唯一；不能按物理引脚号猜测端口顺序。`)
    const prefix = (part.attrs.prefix ?? attrs.prefix ?? '').toUpperCase()
    const kind = prefix[0] as Kind
    if (!['R', 'C', 'L', 'V', 'I', 'D', 'Q', 'M', 'J', 'X'].includes(kind)) fail(`符号 ${part.name} 的 Prefix ${prefix || '(缺失)'} 不受支持。`)
    const all = [...pins.map(pin => pin.at), ...graphicPoints]
    const center = { x: Math.round((Math.min(...all.map(p => p.x)) + Math.max(...all.map(p => p.x))) / 32) * 16, y: Math.round((Math.min(...all.map(p => p.y)) + Math.max(...all.map(p => p.y))) / 32) * 16 }
    return { kind, pins: pins.map(pin => pin.at), attrs, asy, center, text }
  }
  const known = !name.includes('/') && stock[name]
  if (!known) fail(`缺少原始符号 ${part.name}.asy；请一并选择该 ASY 及其模型文件，不能仅凭名称猜测私有符号的引脚。`)
  return { kind: known.kind, pins: known.pins.map(([x, y]) => ({ x, y })), attrs: {} }
}

function establishTopology(doc: AscDocument, symbols: Record<string, string>) {
  const points = new Map<string, XY>(), parents = new Map<string, string>()
  const add = (p: XY) => { const k = key(p); points.set(k, p); if (!parents.has(k)) parents.set(k, k); return k }
  const root = (k: string): string => { const p = parents.get(k)!; if (p === k) return k; const r = root(p); parents.set(k, r); return r }
  const union = (a: string, b: string) => parents.set(root(a), root(b))
  for (const part of doc.parts) {
    part.definition = definitionFor(part, symbols)
    if (!part.attrs.instname) fail(`SYMBOL ${part.name} (${part.at.x}, ${part.at.y}) 缺少 InstName。`)
    part.id = part.attrs.instname
    part.pins = part.definition.pins.map(pin => transform(pin, part.orientation, part.at))
    part.pins.forEach(add)
  }
  doc.wires.forEach(([a, b]) => { add(a); add(b) }); doc.flags.forEach(flag => add(flag.at))
  const onSpan = (p: XY, a: XY, b: XY) => a.x === b.x ? p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y) : p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
  // Only actual endpoints, pins and FLAGs split a span. A bare X crossing
  // contributes no point and therefore cannot connect the crossing nets.
  for (const [a, b] of doc.wires) for (const [k, p] of points) if (onSpan(p, a, b)) union(key(a), k)
  const named = new Map<string, string>()
  for (const flag of doc.flags) {
    const name = flag.name.toLowerCase(), old = named.get(name)
    if (old) union(key(flag.at), old); else named.set(name, key(flag.at))
  }
  const names = new Map<string, string>()
  for (const flag of doc.flags) {
    const r = root(key(flag.at)), old = names.get(r)
    if (old && old.toLowerCase() !== flag.name.toLowerCase()) fail(`节点 (${flag.at.x}, ${flag.at.y}) 同时有冲突 FLAG ${old} / ${flag.name}。`)
    names.set(r, flag.name)
  }
  let n = 1
  const node = (p: XY) => {
    const r = root(key(p))
    if (!names.has(r)) { while (named.has(`asc_n${n}`)) n++; names.set(r, `asc_n${n++}`) }
    return names.get(r)!
  }
  for (const part of doc.parts) part.nodes = part.pins!.map(node)
  return { points, node, onSpan }
}

function card(part: Part, modelText: string): string {
  const definition = part.definition!, attrs = { ...definition.attrs, ...part.attrs }, kind = definition.kind, nodes = [...part.nodes!]
  const prefix = attrs.prefix?.toUpperCase()
  if (prefix && prefix[0] !== kind) fail(`${part.id} Prefix ${prefix} 与符号真实器件类型 ${kind} 不一致。`)
  if (part.id![0].toUpperCase() !== kind && kind !== 'X') fail(`${part.id}.InstName 与符号 Prefix ${kind} 不一致，请在 LTspice 修正。`)
  part.deckId = kind === 'X' && part.id![0].toUpperCase() !== 'X' ? `X${part.id}` : part.id
  const expected = ['Q', 'J'].includes(kind) ? 3 : kind === 'M' ? [3, 4] : kind === 'X' ? undefined : 2
  if (expected !== undefined && !(Array.isArray(expected) ? expected.includes(nodes.length) : nodes.length === expected)) fail(`${part.id} 的 ${kind} 符号端口数量 ${nodes.length} 无法表达。`)
  // LTspice stock 3-pin MOS exposes D/G/S; a normal four-terminal MOS card
  // explicitly ties B to S, while VDMOS's native three-terminal card is left
  // to the deck parser after reading its model definition.
  const value = [attrs.value ?? attrs.spicemodel ?? '', attrs.value2 ?? ''].filter(Boolean).join(' ').trim()
  if (!value) fail(`${part.id} 缺少 Value / SpiceModel，不能创建默认器件替代。`)
  if (/[\r\n;]/.test(value) || /[\r\n;]/.test(attrs.spiceline ?? '') || /[\r\n;]/.test(attrs.spiceline2 ?? '')) fail(`${part.id} 的值或 SpiceLine 含嵌入语句。`)
  const tail = [value, attrs.spiceline, attrs.spiceline2].filter(Boolean).join(' ')
  if (kind === 'M' && nodes.length === 3) {
    const model = value.split(/\s+/)[0], escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`^\\s*\\.model\\s+${escaped}\\s+VDMOS\\b`, 'im').test(modelText)) nodes.push(nodes[2])
  }
  return `${part.deckId} ${nodes.join(' ')} ${tail}`
}

function worldOrientation(orientation: string, localRotation = 0): { rotation: Rotation; mirrored?: boolean } {
  const angle = Number(orientation.slice(1))
  // ASC mirrors after rotation; canvas mirrors before it: F R(a)=R(-a) F.
  return { rotation: ((orientation[0] === 'M' ? -angle : angle) + localRotation + 720) % 360 as Rotation, ...(orientation[0] === 'M' ? { mirrored: true } : {}) }
}

/** Import an ASC as one transaction. Unknown electrical semantics reject the
 * candidate before any caller replaces the user's current project. */
export function importLtspiceSchematic(text: string, options: LtspiceImportOptions = {}): { project: Project; warnings: string[] } {
  const doc = parseAsc(text), topology = establishTopology(doc, options.symbols ?? {})
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : Math.abs(a)
  const grid = [...topology.points.values(), ...doc.parts.map(part => part.at)].flatMap(p => [p.x, p.y]).reduce(gcd, 16) || 16
  const scale = 20 / grid, canvasPoint = (p: XY) => scaled(p, scale)
  const cards = doc.parts.map(part => card(part, `${doc.directives.join('\n')}\n${options.modelText ?? ''}`))
  const directives = doc.directives.filter(line => !/^\.backanno\s*$/i.test(line))
  if (directives.length !== doc.directives.length) doc.warnings.push('LTspice .backanno 回标记录已转换为工作台网络引用。')
  if (directives.some(line => /^\.(?:include|inc|lib)\b/i.test(line))) fail('仍有未展开的 .include / .lib 依赖；请同时选择模型文件，不能忽略外部模型。')
  const modelText = options.modelText ?? ''
  // The deck parser validates definitions, sources, analyses and executable
  // syntax once for both ASC and textual netlist imports.
  const imported = importSpiceDeck(['Imported LTspice schematic', ...cards, ...directives, modelText, '.end'].join('\n'), { sourceName: options.sourceName, title: options.sourceName?.replace(/\.[^.]+$/, '') ?? '导入 LTspice 原理图' })
  const project = imported.project, old = compileDrawing(project.drawing!), warnings = [...doc.warnings, ...imported.warnings.filter(warning => !warning.startsWith('文本网表不含原始图面；'))]
  const references = imported.references, nodeNames = { ...imported.nodeNames }
  const usedNames = new Set(Object.values(nodeNames))
  for (const flag of doc.flags) if (nodeNames[flag.name.toLowerCase()] === undefined) {
    let name = flag.name.toLowerCase(), n = 1
    if (!/^[a-z_][a-z0-9_]{0,31}$/i.test(name)) { while (usedNames.has(`asc_label_${n}`)) n++; name = `asc_label_${n}`; warnings.push(`游离 FLAG 节点 ${flag.name} 映射为 ${name}。`) }
    nodeNames[flag.name.toLowerCase()] = name; usedNames.add(name)
  }
  const drawing = emptyDrawing(), newByNode = new Map<string, Terminal>(), pointTerminals = new Map<string, Terminal>(), ids = new Set<string>()
  const actualNode = (name: string) => nodeNames?.[name.toLowerCase()] ?? name.toLowerCase()
  const reserve = (prefix: string) => { let n = 1; while (ids.has(`${prefix}${n}`)) n++; const id = `${prefix}${n}`; ids.add(id); return id }
  for (const device of project.drawing!.devices) if (device.kind !== 'GND') ids.add(device.id)
  const pointAt = (p: XY): Terminal => {
    const k = key(p), existing = pointTerminals.get(k)
    if (existing) return existing
    const id = reserve('J'), at = { junction: id }
    drawing.junctions.push({ id, ...canvasPoint(p) }); pointTerminals.set(k, at)
    const node = actualNode(topology.node(p)); if (!newByNode.has(node)) newByNode.set(node, at)
    return at
  }
  const addWire = (from: Terminal, to: Terminal, waypoints: XY[]) => {
    if (terminalKey(from) === terminalKey(to)) return
    drawing.wires.push({ id: reserve('W'), from, to, bend: 'hv', waypoints })
  }
  let adapted = false
  for (const part of doc.parts) {
    const id = references?.[part.deckId!.toLowerCase()] ?? part.deckId!.toUpperCase()
    const source = project.drawing!.devices.find(device => device.id === id)
    if (!source) fail(`${part.id} 的解析后器件 ${id} 缺失，导入中止。`)
    const pinCoordinates = part.pins!.map(canvasPoint), definition = part.definition!
    let placed: Device
    if (source.kind === 'X' && definition.asy && definition.kind === 'X') {
      const model = project.models?.find(model => model.kind === 'X' && model.id.toLowerCase() === source.value.toLowerCase())
      if (!model || model.pins.length !== definition.pins.length) fail(`${part.id} 的 ASY SpiceOrder 与 .subckt 端口数量不一致。`)
      // Keep exact raw pin offsets; the library ASY parser otherwise rounds
      // its 10-unit previews, which would move pins on an 8-unit source grid.
      const native = definition.asy.symbol, center = definition.center!, factor = scale / 0.625
      const pinPositions = definition.pins.map(pin => ({ x: (pin.x - center.x) * scale, y: (pin.y - center.y) * scale }))
      const position = canvasPoint(transform(center, part.orientation, part.at))
      const symbol = { ...native, title: model.id.slice(0, 32), origin: 'imported' as const, source: { label: `${part.name}.asy`, sha256: sourceDigest(definition.text!) }, pins: native.pins.map((pin, index) => ({ ...pin, label: model.pins[index], ...pinPositions[index] })), geometry: native.geometry.map(item => ({ ...item, coords: item.coords.map(value => value * factor) })), ...(native.annotations ? { annotations: native.annotations.map(item => ({ ...item, x: item.x * factor, y: item.y * factor, size: item.size * factor })) } : {}) }
      const existing = drawing.devices.find(device => device.kind === 'X' && device.value.toLowerCase() === model.id.toLowerCase())
      if (existing && (JSON.stringify(existing.pinPositions) !== JSON.stringify(pinPositions) || JSON.stringify(model.symbol?.geometry) !== JSON.stringify(symbol.geometry))) fail(`同一子电路 ${model.id} 在原图使用不同 ASY 几何；当前模型只能绑定一个符号，请统一符号后导入。`)
      model.symbol = symbol
      placed = { ...source, ...position, ...worldOrientation(part.orientation), pins: [...model.pins], pinPositions }
    } else if (source.kind === 'X') {
      // A primitive wrapped by the deck adapter (for example a four-pin MOS)
      // can keep exact ASC anchors. A generic two-sided adapter box would
      // otherwise run the body/source leads through an unrelated body flag.
      const rawPins = definition.kind === 'M' && definition.pins.length === 3 && source.pins?.length === 4 ? [...definition.pins, definition.pins[2]] : definition.pins
      const pivot = { x: Math.round((Math.min(...rawPins.map(p => p.x)) + Math.max(...rawPins.map(p => p.x))) / 32) * 16, y: Math.round((Math.min(...rawPins.map(p => p.y)) + Math.max(...rawPins.map(p => p.y))) / 32) * 16 }
      placed = { ...source, ...canvasPoint(transform(pivot, part.orientation, part.at)), ...worldOrientation(part.orientation), pinPositions: rawPins.map(pin => ({ x: (pin.x - pivot.x) * scale, y: (pin.y - pivot.y) * scale })) }
      warnings.push(`${part.id} 的实例参数/额外端口由电气子电路适配器保留；画布显示端口连接示意，并按原 ASY 端序及坐标保留引脚。`)
    } else {
      // Standard functional symbols have fixed workbench dimensions. Keep
      // their original region/orientation and connect exact original anchors
      // using local adapters; never rebuild the schematic as a grid of parts.
      const center = { x: Math.round(pinCoordinates.reduce((sum, p) => sum + p.x, 0) / pinCoordinates.length / 20) * 20, y: Math.round(pinCoordinates.reduce((sum, p) => sum + p.y, 0) / pinCoordinates.length / 20) * 20 }
      const binary = definition.pins.length === 2, baseRotation = binary ? (part.orientation[0] === 'M' ? 270 : 90) : 0
      placed = { ...source, ...center, ...worldOrientation(part.orientation, baseRotation) }
      adapted = true
    }
    drawing.devices.push(placed)
    const electricalPins = source.kind === 'X' && definition.kind === 'M' && part.pins!.length === 3 && source.pins?.length === 4 ? [...part.pins!, part.pins![2]] : part.pins!
    if ((source.kind === 'X' ? source.pins!.length : part.pins!.length) !== electricalPins.length) fail(`${part.id} 的解析后端口数量与 ASY 不一致。`)
    for (const [pin, p] of electricalPins.entries()) {
      const at: Terminal = { device: id, pin }, wanted = canvasPoint(p), actual = pinPosition(placed, pin)
      if (key(actual) === key(wanted) && !pointTerminals.has(key(p))) pointTerminals.set(key(p), at)
      else { const external = pointAt(p); addWire(at, external, [actual, wanted]) }
      const node = actualNode(part.nodes![pin] ?? part.nodes![2]); if (!newByNode.has(node)) newByNode.set(node, at)
    }
  }
  // Splitting at known points preserves T branches. Keeping all unmarked
  // crossings absent from the point set preserves their electrical separation.
  const emitted = new Set<string>()
  for (const [a, b] of doc.wires) {
    const points = [...topology.points.values()].filter(p => topology.onSpan(p, a, b)).sort((p, q) => a.x === b.x ? p.y - q.y : p.x - q.x)
    for (let index = 1; index < points.length; index++) {
      const from = points[index - 1], to = points[index], segment = [key(from), key(to)].sort().join('|')
      if (emitted.has(segment)) continue
      emitted.add(segment); addWire(pointAt(from), pointAt(to), [canvasPoint(from), canvasPoint(to)])
    }
  }
  for (const flag of doc.flags) {
    const at = pointAt(flag.at), node = actualNode(flag.name)
    if (node === '0') {
      const id = reserve('G'); drawing.devices.push({ id, kind: 'GND', value: '', ...canvasPoint(flag.at), rotation: 0, groundStyle: 'signal' }); addWire(at, { device: id, pin: 0 }, [canvasPoint(flag.at)])
    } else {
      const style = doc.ports.get(key(flag.at)) ?? (/^(?:vcc|vdd|vss|vee|vbat|vbus|vref)(?:_?[a-z0-9]+)?$/i.test(flag.name) ? 'power' : 'text')
      drawing.labels!.push({ id: reserve('N'), at, name: flag.name.toLowerCase() === node ? flag.name : node, style })
    }
    newByNode.set(node, at)
  }
  // Anonymous and remapped nets need one stable label to reproduce the deck
  // parser's names, including its chosen input/output and numeric-net mapping.
  const labeled = new Set(drawing.labels!.map(label => label.name.toLowerCase()))
  for (const [node, at] of newByNode) if (node !== '0' && !labeled.has(node)) { drawing.labels!.push({ id: reserve('N'), name: node, at }); labeled.add(node) }
  drawing.sourceId = project.drawing!.sourceId
  const remap = (at: Terminal): Terminal => {
    const node = old.nodes.get(terminalKey(at)), replacement = node ? newByNode.get(node) : undefined
    if (!replacement) fail(`无法迁移节点引用 ${terminalKey(at)}，未应用导入。`)
    return replacement!
  }
  drawing.output = project.drawing!.output ? remap(project.drawing!.output) : null
  if (project.initialConditions) project.initialConditions = project.initialConditions.map(setting => ({ ...setting, at: remap(setting.at) }))
  if (project.nodeSets) project.nodeSets = project.nodeSets.map(setting => ({ ...setting, at: remap(setting.at) }))
  if (project.noise?.negative) project.noise = { ...project.noise, negative: remap(project.noise.negative) }
  if (project.probes) project.probes = project.probes.map(probe => probe.kind === 'voltage' ? { ...probe, positive: remap(probe.positive), ...(probe.negative ? { negative: remap(probe.negative) } : {}) } : probe)
  if (project.waveformSetup) project.waveformSetup = { ...project.waveformSetup, profiles: { ...project.waveformSetup.profiles, profiles: project.waveformSetup.profiles.profiles.map(profile => ({ ...profile, settings: { ...profile.settings, ...(profile.settings.output ? { output: remap(profile.settings.output) } : {}), ...(profile.settings.initialConditions ? { initialConditions: profile.settings.initialConditions.map(setting => ({ ...setting, at: remap(setting.at) })) } : {}), ...(profile.settings.nodeSets ? { nodeSets: profile.settings.nodeSets.map(setting => ({ ...setting, at: remap(setting.at) })) } : {}), ...(profile.settings.noise?.negative ? { noise: { ...profile.settings.noise, negative: remap(profile.settings.noise.negative) } } : {}) } })) } }
  project.drawing = parseDrawing(drawing)
  const clean = parseProject(project), errors = validateProject(clean)
  if (errors.length) fail(`原图无法被当前画布完整表示：${errors.join('；')}`)
  const after = compileDrawing(clean.drawing!)
  for (const { device, nodes } of old.elements) {
    const current = after.elements.find(element => element.device.id === device.id)
    if (!current || JSON.stringify(current.nodes) !== JSON.stringify(nodes)) fail(`${device.id} 的端口网络在几何转换后不一致，导入中止。`)
  }
  if (adapted) warnings.push(`已保留 ASC 的器件相对位置、旋转/镜像、原始导线及 FLAG。已确认的标准器件使用工作台标准功能符号，并以局部引线适配原始引脚位置；符号尺寸和文字位置可能与 LTspice 不同。坐标按 ${grid}→20 统一缩放。`)
  return { project: clean, warnings: [...new Set(warnings)] }
}
