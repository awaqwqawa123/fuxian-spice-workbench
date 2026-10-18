import { generateNetlist, newProject, validateProject, type Project } from './circuit'
import { compileDrawing, connect, emptyDrawing, nextId, parseDrawing, terminal, terminalKey, type DeviceKind, type Drawing, type NetLabelStyle, type Terminal, type XY } from './drawing'
import { editableProject } from './editor'
import { isConfiguredSource } from './sources'

type Kind = 'R' | 'C' | 'L' | 'V' | 'I'
interface Element { id: string; kind: Kind; nodes: [string, string]; value: string }
interface Circuit { elements: Element[]; directives: string[]; title: string; warnings: string[]; netSymbols?:{node:string; name:string; style:NetLabelStyle}[]; signalGround?:boolean }
interface Source { dc: number; ac?: number; waveform?: Project['source']['waveform']; offset?: number; amplitude?: number; frequency?: number }
const MAX_TEXT = 1024 * 1024
function fail(message: string): never { throw new Error(`格式兼容：${message}`) }
const numeric = (text: string): number => {
  // SPICE suffixes are case insensitive: M is milli, MEG is mega.
  const match = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-zµμ]*)$/i)
  if (!match) return fail(`不支持表达式或数值“${text}”，请先展开参数。`)
  const suffix = match[2].toLowerCase().replace(/[µμ]/g, 'u')
  const scales: Record<string, number> = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, mil: 25.4e-6 }
  const prefix = suffix.startsWith('meg') ? 'meg' : suffix.startsWith('mil') ? 'mil' : suffix[0]
  const factor = suffix === '' || /^(v|a|hz|s|ohm|ohms)$/.test(suffix) ? 1 : scales[prefix]
  const value = Number(match[1]) * factor
  if (!Number.isFinite(value)) return fail(`无法识别 SPICE 数值“${text}”。`)
  return value
}
const equalNumber = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1e-30) * 1e-8
const cleanLine = (line: string) => line.split(';')[0].trim()

function parseSource(value: string): Source {
  let rest = value.trim(), dc: number | undefined, ac: number | undefined
  let waveform: Source['waveform'], offset: number | undefined, amplitude: number | undefined, frequency: number | undefined
  const wave = rest.match(/\b(SIN|SINE|PULSE)\s*\(([^()]*)\)/i)
  if (wave) {
    const args = wave[2].trim().split(/[\s,]+/).map(numeric)
    if (/^sin/i.test(wave[1])) {
      if (args.length < 3 || args.length > 6 || args.slice(3).some(n => n !== 0)) fail('SIN 仅支持偏置、幅度、频率；延迟、阻尼和相位必须为 0。')
      ;[offset, amplitude, frequency] = args; waveform = 'sine'
    } else {
      if (args.length !== 7) fail('PULSE 需要 7 个参数，且仅支持 50% 占空比、零延迟、周期 1/1000 的上升/下降时间。')
      const [low, high, delay, rise, fall, width, period] = args
      if (delay !== 0 || period <= 0 || !equalNumber(rise, period / 1000) || !equalNumber(fall, period / 1000) || !equalNumber(width, period / 2)) fail('此 PULSE 时序无法被当前方波设置精确表达，导入已停止。')
      offset = low; amplitude = high - low; frequency = 1 / period; waveform = 'square'
    }
    rest = `${rest.slice(0, wave.index)} ${rest.slice(wave.index! + wave[0].length)}`.trim()
  }
  const parts = rest.split(/\s+/).filter(Boolean)
  for (let i = 0; i < parts.length;) {
    const token = parts[i++].toUpperCase()
    if (token === 'DC') {
      if (dc !== undefined || i === parts.length) fail('DC 源参数缺失或重复。')
      dc = numeric(parts[i++])
    } else if (token === 'AC') {
      if (ac !== undefined || i === parts.length) fail('AC 源参数缺失或重复。')
      ac = numeric(parts[i++])
      if (i < parts.length && !/^(DC|AC)$/i.test(parts[i])) { if (numeric(parts[i++]) !== 0) fail('当前不支持非零 AC 相位。') }
    } else if (dc === undefined && i === 1) dc = numeric(token)
    else fail(`不支持的电源参数“${token}”。`)
  }
  if (!value.trim()) fail('电源缺少数值。')
  return { dc: dc ?? offset ?? 0, ac, waveform, offset, amplitude, frequency }
}

function readSpice(text: string): Circuit {
  const raw = text.replace(/^\uFEFF/, '').split(/\r?\n/), lines: string[] = []
  let title = '导入 SPICE 电路', ended = false
  for (let i = 0; i < raw.length; i++) {
    const line = cleanLine(raw[i])
    if (!line || line.startsWith('*')) continue
    if (i === 0 && !line.startsWith('.') && !/^[RCLVI]\S*\s+\S+\s+\S+\s+/i.test(line) && !/^[a-z]+\d\S*\s+\S+\s+\S+/i.test(line)) { title = line.slice(0, 80); continue }
    if (ended) fail('.end 后还有电路内容，不支持多个电路段。')
    if (line.toLowerCase() === '.end') { ended = true; continue }
    if (line.startsWith('+')) { if (!lines.length) fail('续行前缺少内容。'); lines[lines.length - 1] += ` ${line.slice(1).trim()}` }
    else lines.push(line)
  }
  const elements: Element[] = [], directives: string[] = []
  for (const line of lines) {
    if (line.startsWith('.')) { directives.push(line); continue }
    const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/)
    if (!match || !/^[RCLVI]/i.test(match[1])) fail(`不支持的器件或语句：${line.slice(0, 100)}。目前交换支持 R/C/L/V/I。`)
    elements.push({ id: match![1], kind: match![1][0].toUpperCase() as Kind, nodes: [match![2].toLowerCase(), match![3].toLowerCase()], value: match![4] })
  }
  return { elements, directives, title, warnings: [] }
}

// Pin origins verified against the installed official LTspice res/cap/ind/voltage/current .asy files.
const symbols: Record<string, { kind: Kind; pins: [XY, XY] }> = {
  res: { kind: 'R', pins: [{ x: 16, y: 16 }, { x: 16, y: 96 }] },
  cap: { kind: 'C', pins: [{ x: 16, y: 0 }, { x: 16, y: 64 }] },
  ind: { kind: 'L', pins: [{ x: 16, y: 16 }, { x: 16, y: 96 }] },
  voltage: { kind: 'V', pins: [{ x: 0, y: 16 }, { x: 0, y: 96 }] },
  current: { kind: 'I', pins: [{ x: 0, y: 0 }, { x: 0, y: 80 }] },
}
function transform(p: XY, orientation: string, at: XY): XY {
  // LTspice M orientations mirror the rotated symbol across the vertical axis.
  const angle = Number(orientation.slice(1)) * Math.PI / 180, mirror = orientation[0] === 'M' ? -1 : 1
  return { x: at.x + mirror * Math.round(p.x * Math.cos(angle) - p.y * Math.sin(angle)), y: at.y + Math.round(p.x * Math.sin(angle) + p.y * Math.cos(angle)) }
}
const coordinate = (x: string, y: string): XY => {
  const p = { x: Number(x), y: Number(y) }
  if (!Number.isSafeInteger(p.x) || !Number.isSafeInteger(p.y) || Math.abs(p.x) > 1e7 || Math.abs(p.y) > 1e7) fail('ASC 坐标超出范围。')
  return p
}
const pointKey = (p: XY) => `${p.x},${p.y}`
function readAsc(text: string): Circuit {
  if (!/^Version 4\s*$/m.test(text.replace(/\r/g, ''))) fail('仅支持 LTspice Version 4 文本 ASC；Multisim 原生二进制文件请先导出 SPICE 网表。')
  const parts: { symbol: string; at: XY; orientation: string; attrs: Record<string, string> }[] = []
  const wires: [XY, XY][] = [], flags: { at: XY; name: string; caption:string }[] = [], ports:{at:XY;style:NetLabelStyle}[] = [], directives: string[] = [], warnings: string[] = []
  let current: typeof parts[number] | undefined, graphics = false
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue
    const tokens = line.split(/\s+/), command = tokens[0].toUpperCase()
    if (command === 'VERSION' || command === 'SHEET') continue
    if (command === 'WIRE') { if (tokens.length !== 5) fail('WIRE 语法错误。'); const a = coordinate(tokens[1], tokens[2]), b = coordinate(tokens[3], tokens[4]); if (a.x !== b.x && a.y !== b.y) fail('暂不支持 ASC 斜线导线。'); wires.push([a, b]); continue }
    if (command === 'FLAG') { if (tokens.length !== 4) fail('FLAG 语法错误。'); flags.push({ at: coordinate(tokens[1], tokens[2]), name: tokens[3].toLowerCase(),caption:tokens[3] }); continue }
    if (command === 'IOPIN') {
      const styles:Record<string,NetLabelStyle>={in:'input',out:'output',bidir:'bidirectional'}
      if(tokens.length!==4||!styles[tokens[3]?.toLowerCase()])fail('IOPIN 语法错误；端口方向须为 In / Out / BiDir。')
      ports.push({at:coordinate(tokens[1],tokens[2]),style:styles[tokens[3].toLowerCase()]});continue
    }
    if (command === 'SYMBOL') {
      const name = tokens[1]?.toLowerCase()
      if (tokens.length !== 5 || !symbols[name] || !/^[RM](0|90|180|270)$/.test(tokens[4])) fail(`不支持 ASC 符号或变换：${tokens[1]} ${tokens[4] ?? ''}。`)
      current = { symbol: name, at: coordinate(tokens[2], tokens[3]), orientation: tokens[4], attrs: {} }; parts.push(current); continue
    }
    if (command === 'SYMATTR') {
      const attr = tokens[1]?.toLowerCase(), value = tokens.slice(2).join(' ')
      if (!current || !['instname', 'value', 'value2', 'prefix', 'description'].includes(attr)) fail(`不支持 ASC 属性 ${tokens[1] ?? ''}；例如寄生参数、模型文件不能被忽略。`)
      if (current.attrs[attr] !== undefined) fail(`ASC 属性 ${attr} 重复。`)
      current.attrs[attr] = value === '""' ? '' : value; continue
    }
    if (command === 'TEXT') {
      const match = line.match(/^TEXT\s+-?\d+\s+-?\d+\s+\S+\s+\d+\s+([!;])(.*)$/)
      if (!match) fail('ASC TEXT 语法错误。')
      if (match![1] === '!') directives.push(...match![2].split('\\n').map(cleanLine).filter(Boolean))
      else graphics = true
      continue
    }
    if (['WINDOW', 'LINE', 'RECTANGLE', 'CIRCLE', 'ARC'].includes(command)) { graphics = true; continue }
    fail(`不支持 ASC 记录 ${tokens[0]}。`)
  }
  if (wires.length > 1000 || flags.length > 500 || parts.length > 79) fail('ASC 超出限制（79 个器件、1000 条导线、500 个标记）。')
  const portAt=new Map<string,NetLabelStyle>()
  for(const port of ports){
    const key=pointKey(port.at)
    if(!flags.some(flag=>pointKey(flag.at)===key))fail('IOPIN 缺少同位置 FLAG 节点名，不能完整导入端口。')
    if(portAt.has(key)&&portAt.get(key)!==port.style)fail('同一 FLAG 的 IOPIN 方向冲突。')
    portAt.set(key,port.style)
  }
  const points = new Map<string, XY>(), parent = new Map<string, string>()
  const add = (p: XY) => { const k = pointKey(p); points.set(k, p); if (!parent.has(k)) parent.set(k, k); return k }
  const root = (k: string): string => { const p = parent.get(k)!; if (p === k) return k; const r = root(p); parent.set(k, r); return r }
  const union = (a: string, b: string) => parent.set(root(a), root(b))
  const pinKeys = parts.map(p => symbols[p.symbol].pins.map(pin => add(transform(pin, p.orientation, p.at))) as [string, string])
  wires.forEach(([a, b]) => { add(a); add(b) }); flags.forEach(f => add(f.at))
  // A wire endpoint, symbol pin or FLAG joins wires at that point. Unmarked crossings stay separate.
  for (const [a, b] of wires) for (const [k, p] of points) {
    if (a.x === b.x ? p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y) : p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)) union(pointKey(a), k)
  }
  const named = new Map<string, string>()
  for (const flag of flags) { const key = pointKey(flag.at), other = named.get(flag.name); if (other) union(key, other); else named.set(flag.name, key) }
  const names = new Map<string, string>()
  for (const flag of flags) {
    const r = root(pointKey(flag.at)), old = names.get(r)
    if (old && old !== flag.name) fail(`同一导线包含冲突节点标签 ${old} / ${flag.name}。请在原软件统一标签。`)
    names.set(r, flag.name)
  }
  let net = 1
  const node = (key: string) => { const r = root(key); if (!names.has(r)) { while (named.has(`asc_n${net}`)) net++; names.set(r, `asc_n${net++}`) } return names.get(r)! }
  const netSymbols:Circuit['netSymbols']=[]
  for(const flag of flags){
    if(flag.name==='0')continue
    const style=portAt.get(pointKey(flag.at))??(/^(?:vcc|vdd|vss|vee|vbat|vbus|vref|avcc|avdd|dvcc|dvdd)(?:_?[a-z0-9]+)?$/i.test(flag.name)?'power':'text')
    // FLAG records repeat on each pin during flag-only exports. Keep each
    // distinct presentation on the net, without multiplying identical captions.
    if(!netSymbols.some(symbol=>symbol.node===flag.name&&symbol.style===style))netSymbols.push({node:flag.name,name:flag.caption,style})
  }
  if (graphics) warnings.push('ASC 注释文字、图形和文字位置未保留；电路按工作台网格重新排版。')
  return { title: '导入 LTspice 电路', warnings, directives, netSymbols:netSymbols.filter(symbol=>symbol.style!=='text'||!netSymbols.some(other=>other.node===symbol.node&&other.style!=='text')),signalGround:flags.some(flag=>flag.name==='0'),elements: parts.map((p, i) => {
    const kind = symbols[p.symbol].kind
    if (!p.attrs.instname || p.attrs.instname[0].toUpperCase() !== kind || p.attrs.prefix && p.attrs.prefix.toUpperCase() !== kind) fail(`ASC ${p.symbol} 缺少合法 InstName / Prefix。`)
    return { id: p.attrs.instname, kind, nodes: pinKeys[i].map(node) as [string, string], value: [p.attrs.value, p.attrs.value2].filter(Boolean).join(' ') }
  }) }
}

function makeProject(c: Circuit): { project: Project; warnings: string[] } {
  if (!c.elements.length || c.elements.length > 79) fail('导入需要 1～79 个器件，另预留 1 个接地符号。')
  const p: Project = { ...newProject(), schemaVersion: 2, template: 'custom', title: c.title, analysis: 'op', drawing: emptyDrawing() }
  const warnings = [...c.warnings], originalIds = new Set<string>(), assignedIds = new Set<string>(), idMap = new Map<string, string>(), nodeNames = new Map<string, string>()
  for (const e of c.elements) {
    const key = e.id.toLowerCase(); if (originalIds.has(key)) fail(`重复器件编号 ${e.id}。`); originalIds.add(key)
    if (/^[RCLVI][1-9]\d{0,4}$/i.test(e.id)) { idMap.set(key, e.id.toUpperCase()); assignedIds.add(e.id.toUpperCase()) }
  }
  for (const e of c.elements) {
    const key = e.id.toLowerCase()
    if (!idMap.has(key)) { let n = 1; while (assignedIds.has(`${e.kind}${n}`)) n++; const id = `${e.kind}${n}`; idMap.set(key, id); assignedIds.add(id); warnings.push(`器件编号 ${e.id} 已映射为 ${id}。`) }
    for (const node of e.nodes) {
      if (!/^[a-z0-9_.$:+-]{1,128}$/i.test(node)) fail(`不支持节点名称 ${node}。`)
      if (node !== '0' && /^[a-z_][a-z0-9_]{0,31}$/i.test(node)) nodeNames.set(node, node)
    }
  }
  const usedNames = new Set(nodeNames.values())
  const nameFor = (node: string): string => {
    if (node === '0') return '0'
    if(!nodeNames.has(node)&&/^[a-z_][a-z0-9_]{0,31}$/i.test(node)&&!usedNames.has(node)){nodeNames.set(node,node);usedNames.add(node)}
    if (!nodeNames.has(node)) { let n = 1; while (usedNames.has(`net_${n}`)) n++; const name = `net_${n}`; nodeNames.set(node, name); usedNames.add(name); warnings.push(`节点 ${node} 已映射为 ${name}。`) }
    return nodeNames.get(node)!
  }
  let analysisSeen = false, sweepSource: string | undefined, requestedOutput: string | undefined, noiseNegative:string|undefined
  const nodeSettings:{kind:'initialConditions'|'nodeSets';node:string;value:string}[]=[]
  for (const line of c.directives) {
    const a = line.split(/\s+/), command = a[0].toLowerCase()
    if (['.ac', '.noise', '.tran', '.dc', '.op'].includes(command)) {
      if (analysisSeen) fail('一次导入仅支持一条分析指令，请在原软件仅启用需要的 AC/TRAN/DC/OP 分析。')
      analysisSeen = true
      if (command === '.op' && a.length === 1) p.analysis = 'op'
      else if (command === '.ac' && a.length === 5 && ['dec','oct','lin'].includes(a[1].toLowerCase())) { p.analysis = 'ac'; p.ac = { points: numeric(a[2]), start: String(numeric(a[3])), stop: String(numeric(a[4])),...(a[1].toLowerCase()!=='dec'?{sweep:a[1].toLowerCase() as 'oct'|'lin'}:{}) } }
      else if (command === '.dc' && a.length === 5) { p.analysis = 'dc'; sweepSource = a[1].toLowerCase(); p.dc = { start: String(numeric(a[2])), stop: String(numeric(a[3])), step: String(numeric(a[4])) } }
      else if(command==='.noise'&&(a.length===7||a.length===8)){
        const nodes=a[1].match(/^v\(([^,()]+)(?:,([^()]+))?\)$/i)
        if(!nodes||!['dec','oct','lin'].includes(a[3].toLowerCase()))fail('NOISE 输出或扫描方式不正确。')
        p.analysis='noise';requestedOutput=nodes[1].toLowerCase();noiseNegative=nodes[2]?.toLowerCase();sweepSource=a[2].toLowerCase()
        p.ac={points:numeric(a[4]),start:String(numeric(a[5])),stop:String(numeric(a[6])),...(a[3].toLowerCase()!=='dec'?{sweep:a[3].toLowerCase() as 'oct'|'lin'}:{})}
        if(a[7]!==undefined)p.noise={summaryInterval:numeric(a[7])}
      } else if(command==='.tran'&&a.length>=2&&a.length<=6){
        p.analysis='tran';const uic=a.at(-1)!.toLowerCase()==='uic',values=a.slice(1,uic?-1:undefined).map(numeric)
        if(values.length<1||values.length>4)fail('TRAN 格式需要输出间隔、终止时间、可选开始时间和最大步长。')
        const stop=values.length===1?values[0]:values[1],step=values.length===4?values[3]:values.length>=2&&values[0]>0?values[0]:stop/2000
        p.tran={stop:String(stop),step:String(step),...(values.length>=3&&values[2]!==0?{start:String(values[2])}:{}),...(values.length>=2&&values[0]!==step?{outputStep:String(values[0])}:{}),...(uic?{uic:true}:{})}
        if(values.length===1||values[0]===0&&values.length<4)warnings.push(`TRAN 未指定步长，已设置最大步长 ${step} s。`)
      }else fail(`暂不支持分析指令 ${line}；STARTUP 等专用行为请使用网表编辑器核对。`)
    }else if(command==='.options'){
      const options:Record<string,string>={}
      for(const token of line.replace(/^\.options\s+/i,'').replace(/\s*=\s*/g,'=').split(/\s+/)){
        const pair=token.match(/^(method|maxord|reltol|abstol|vntol|chgtol|gmin|trtol|itl1|itl4)=(\S+)$/i)
        if(!pair)fail(`不支持求解器选项 ${token}。`)
        const key=pair[1].toLowerCase();options[key]=key==='method'?pair[2].toLowerCase():String(numeric(pair[2]))
      }
      if(!(Object.keys(options).length===1&&options.reltol==='0.00001'&&p.solver?.reltol===undefined))p.solver={...p.solver,...options} as Project['solver']
    }else if(command==='.temp'&&a.length===2){p.temperature=numeric(a[1])
    }else if(command==='.ic'||command==='.nodeset'){
      const content=line.replace(/^\.(ic|nodeset)\s+/i,'').replace(/\s*=\s*/g,'=')
      for(const token of content.split(/\s+/)){
        const pair=token.match(/^v\(([^()]+)\)=(\S+)$/i)
        if(!pair)fail(`节点电压设置格式不支持：${token}。`)
        nodeSettings.push({kind:command==='.ic'?'initialConditions':'nodeSets',node:pair[1].toLowerCase(),value:String(numeric(pair[2]))})
      }
    } else if (command === '.save') {
      if (a.length < 2 || a.slice(1).some(s => s.toLowerCase()!=='all'&&!/^(v\([a-z0-9_.$:+-]+\)|i\([a-z0-9_]+\))$/i.test(s))) fail(`不支持保存表达式 ${line}。`)
      const savedNodes = a.slice(1).map(s => s.match(/^v\(([^)]+)\)$/i)?.[1].toLowerCase()).filter((n): n is string => Boolean(n))
      if(p.analysis!=='noise')requestedOutput = savedNodes[0] ?? requestedOutput
      warnings.push('原 .save 选择已转换为工作台节点采集；导入后可在波形列表重新选择显示曲线。')
    } else if (command === '.backanno' && a.length === 1) {
      warnings.push('LTspice .backanno 仅用于原软件回标，已转换为工作台网络与器件映射。')
    } else fail(`不支持指令 ${a[0]}，导入已停止；请先展开模型、参数或子电路。`)
  }
  if (!analysisSeen) warnings.push('文件未指定分析类型，已选择 DC 工作点。')
  const sources = new Map<string, Source>()
  for (const e of c.elements) if (e.kind === 'V' || e.kind === 'I') sources.set(e.id.toLowerCase(), parseSource(e.value))
  const dynamic = [...sources].filter(([, s]) => s.waveform || s.ac !== undefined && s.ac !== 0)
  if (dynamic.length > 1) fail('当前仅支持一个动态激励源，其余源必须为 DC。')
  const sweepVoltage=sweepSource&&c.elements.find(e=>e.id.toLowerCase()===sweepSource&&e.kind==='V')
  const source = sweepVoltage ?? (dynamic.length ? c.elements.find(e => e.id.toLowerCase() === dynamic[0][0] && e.kind === 'V') : c.elements.find(e => e.kind === 'V' && e.nodes[1] === '0'))
  if (!source || source.nodes[1] !== '0') fail('当前需要一个负端接节点 0 的电压源作为输入参考；电流源激励或浮地电压源暂不支持。')
  if (dynamic.length && dynamic[0][0] !== source.id.toLowerCase()) fail('扫描电源与动态激励源不同，当前不能同时保留这些配置。')
  const sourceSpec = sources.get(source.id.toLowerCase())!
  if (sourceSpec.ac !== undefined && sourceSpec.ac !== 0 && sourceSpec.ac !== 1) fail('当前 AC 输入幅度固定为 1，无法精确导入该 AC 幅度。')
  if (p.analysis === 'ac' && sourceSpec.ac !== 1) fail('AC 分析需要 AC 1 的输入电压源。')
  if (p.analysis === 'tran' && sourceSpec.waveform && sourceSpec.dc !== sourceSpec.offset) fail('瞬态源的 DC 值与波形初始偏置不同，当前工作台不能精确保留该工作点。')
  p.source.dc = String(sourceSpec.dc)
  if (sourceSpec.waveform) p.source = { dc: String(sourceSpec.dc), offset: String(sourceSpec.offset), amplitude: String(sourceSpec.amplitude), frequency: String(sourceSpec.frequency), waveform: sourceSpec.waveform }
  let drawing: Drawing = { ...emptyDrawing(), sourceId: idMap.get(source.id.toLowerCase())! }
  const groups = new Map<string, Terminal[]>(), columns = c.elements.length <= 20 ? 5 : 10, spacing = columns === 5 ? 220 : 100, rows = Math.ceil(c.elements.length / columns)
  c.elements.forEach((e, index) => {
    const id = idMap.get(e.id.toLowerCase())!, value = e.kind === 'V' || e.kind === 'I' ? sources.get(e.id.toLowerCase())!.dc : numeric(e.value)
    drawing.devices.push({ id, kind: e.kind, value: String(value), x: 100 + index % columns * spacing, y: 60 + Math.floor(index / columns) * (rows <= 4 ? 140 : 60), rotation: 0 })
    e.nodes.forEach((node, pin) => { const name = nameFor(node); groups.set(name, [...(groups.get(name) ?? []), terminal(id, pin as 0 | 1)]) })
  })
  if (!groups.has('0')) fail('电路没有节点 0（GND）。')
  if(p.analysis==='tran'&&!sourceSpec.waveform){const part=drawing.devices.find(device=>device.id===drawing.sourceId)!;part.params={waveform:'dc',acAmplitude:String(sourceSpec.ac??0),acPhase:'0'}}
  drawing.devices.push({ id: 'G1', kind: 'GND', value: '', x: 1120, y: 580, rotation: 0,...(c.signalGround?{groundStyle:'signal' as const}:{}) })
  groups.get('0')!.push(terminal('G1'))
  // A disconnected FLAG/IOPIN remains a real, editable network symbol. It is
  // never represented as a voltage source or assigned to an unrelated pin.
  for(const symbol of c.netSymbols??[]){
    const name=nameFor(symbol.node)
    if(groups.has(name))continue
    const id=nextId('J',drawing.junctions)
    drawing.junctions.push({id,x:-200-drawing.junctions.length*120,y:-200-drawing.junctions.length*80})
    groups.set(name,[{junction:id}])
  }
  let labelId = 1
  for (const [name, terminals] of groups) {
    for (const t of terminals.slice(1)) drawing = connect(drawing, terminals[0], t)
    if (name !== '0') {
      const symbols=c.netSymbols?.filter(symbol=>nameFor(symbol.node)===name)??[]
      if(!symbols.length)drawing.labels!.push({ id: `N${labelId++}`, name, at: terminals[0] })
      else for(const [index,symbol] of symbols.entries()){
        if(index>=terminals.length){
          const id=nextId('J',drawing.junctions),at={junction:id}
          drawing.junctions.push({id,x:-200-drawing.junctions.length*120,y:-200-drawing.junctions.length*80})
          drawing=connect(drawing,terminals[0],at);terminals.push(at)
        }
        drawing.labels!.push({id:`N${labelId++}`,name:symbol.name.toLowerCase()===name?symbol.name:name,at:terminals[index],style:symbol.style,...(symbol.style!=='text'?{rotation:0 as const}:{})})
      }
    }
  }
  if(p.analysis==='noise'&&requestedOutput&&!groups.has(nameFor(requestedOutput)))fail(`噪声输出节点 ${requestedOutput} 不存在。`)
  const savedOutput = requestedOutput && requestedOutput !== '0' ? nodeNames.get(requestedOutput) : undefined
  const output = savedOutput && groups.has(savedOutput) ? savedOutput : [...groups.keys()].find(n => n === 'vout' || n === 'out') ?? [...groups.keys()].find(n => n !== '0' && n !== nameFor(source.nodes[0])) ?? nameFor(source.nodes[0])
  drawing.output = groups.get(output)![0]
  p.drawing = parseDrawing(drawing)
  if(p.analysis==='dc'&&sweepSource){const id=idMap.get(sweepSource);if(!id||!drawing.devices.some(device=>device.id===id&&['V','I'].includes(device.kind)))fail('DC 扫描源不是已存在的独立 V/I 源。');if(id!==drawing.sourceId)p.dc={...p.dc!,sourceId:id}}
  if(p.analysis==='noise'&&sweepSource!==source.id.toLowerCase())fail('噪声源与当前输入参考不一致；请在网表编辑器核对。')
  if(noiseNegative&&noiseNegative!=='0'){const at=groups.get(nameFor(noiseNegative))?.[0];if(!at)fail(`噪声负参考节点 ${noiseNegative} 不存在。`);p.noise={...p.noise,negative:at}}
  for(const setting of nodeSettings){const at=groups.get(nameFor(setting.node))?.[0];if(!at)fail(`节点电压设置 ${setting.node} 没有实际端点。`);p[setting.kind]=[...(p[setting.kind]??[]),{at,value:setting.value}]}

  const errors = validateProject(p)
  if (errors.length) fail(`电路不能被当前工作台完整表达：${errors.join('；')}`)
  warnings.push('器件按网格自动排版，电气连接保留；请检查输出探针位置。')
  return { project: p, warnings: [...new Set(warnings)] }
}

/** Strict import: unsupported semantics reject the entire operation without mutating the current project. */
export function importCircuit(text: string, format: 'asc' | 'spice'): { project: Project; warnings: string[] } {
  if (typeof text !== 'string' || text.length > MAX_TEXT || /[\x00-\x08\x0e-\x1f]/.test(text)) fail('仅支持 1 MB 以内的文本 ASC / SPICE 网表；Multisim .ms14 等原生二进制请先导出 SPICE。')
  if (format !== 'asc' && format !== 'spice') fail('仅支持 ASC 和文本 SPICE。')
  return makeProject(format === 'asc' ? readAsc(text.replace(/^\uFEFF/, '')) : readSpice(text))
}

/** Emits stock LTspice symbols with pin-accurate FLAGs. Names carry connectivity without ambiguous crossings. */
export function exportLtspice(project: Project): { text: string; warnings: string[] } {
  const p = editableProject(project), topology = compileDrawing(p.drawing!)
  const unsupported = topology.elements.filter(e => !['R', 'C', 'L', 'V', 'I'].includes(e.device.kind))
  if (unsupported.length) fail(`ASC 导出暂不支持 ${unsupported.map(e => e.device.id).join('、')}；请使用 SPICE 网表导出模型电路。`)
  const netlist = generateNetlist(p), lines = netlist.split('\n'), values = new Map(lines.slice(1).filter(l => /^[RCLVI]/.test(l)).map(l => { const a = l.split(/\s+/); return [a[0], a.slice(3).join(' ')] }))
  const symbolFor: Partial<Record<DeviceKind, string>> = { R: 'res', C: 'cap', L: 'ind', V: 'voltage', I: 'current' }
  const height = 120 + Math.ceil(topology.elements.length / 6) * 176
  const ports=(p.drawing!.labels??[]).filter(label=>['input','output','bidirectional'].includes(label.style??''))
  const out = ['Version 4', `SHEET 1 1600 ${Math.max(960, height + 200,120+(p.drawing!.labels?.length??0)*32)}`]
  const emitted=new Set<string>(),pinKeys=new Set(topology.elements.flatMap(({device,nodes})=>nodes.map((_,pin)=>terminalKey(terminal(device.id,pin)))))
  // Put the selected reference first so an OP import keeps it among several DC supplies.
  const elements = [...topology.elements].sort((a, b) => Number(b.device.id === topology.sourceId) - Number(a.device.id === topology.sourceId))
  elements.forEach(({ device, nodes }, i) => {
    const name = symbolFor[device.kind]!, symbol = symbols[name], x = 96 + i % 6 * 240, y = 80 + Math.floor(i / 6) * 176
    const at = { x: x - symbol.pins[0].x, y: y - symbol.pins[0].y }
    out.push(`SYMBOL ${name} ${at.x} ${at.y} R0`, `SYMATTR InstName ${device.id}`, `SYMATTR Value ${values.get(device.id)}`)
    symbol.pins.forEach((pin, j) => {
      const x=at.x+pin.x,y=at.y+pin.y,key=terminalKey(terminal(device.id,j))
      out.push(`FLAG ${x} ${y} ${nodes[j]}`)
      const port=ports.find(label=>!emitted.has(label.id)&&(terminalKey(label.at)===key||!pinKeys.has(terminalKey(label.at))&&topology.nodes.get(terminalKey(label.at))===nodes[j]))
      if(port){out.push(`IOPIN ${x} ${y} ${port.style==='input'?'In':port.style==='output'?'Out':'BiDir'}`);emitted.add(port.id)}
    })
  })
  const elementNodes=new Set(topology.elements.flatMap(element=>element.nodes))
  let extraFlag=0
  for(const label of p.drawing!.labels??[]){
    const node=topology.nodes.get(terminalKey(label.at))!
    if(emitted.has(label.id)||!ports.includes(label)&&elementNodes.has(node))continue
    const x=1480,y=80+extraFlag++*32
    out.push(`FLAG ${x} ${y} ${node}`)
    if(ports.includes(label))out.push(`IOPIN ${x} ${y} ${label.style==='input'?'In':label.style==='output'?'Out':'BiDir'}`)
    emitted.add(label.id)
  }
  const directives = lines.filter(l => /^\.(ac|noise|tran|dc|op|options|temp|ic|nodeset)\b/i.test(l))
  const savedNodes = [...new Set([topology.outputNode, ...topology.nodes.values()])].filter(n => n !== '0')
  directives.push(p.analysis==='noise'?'.save all':`.save ${savedNodes.map(n => `v(${n})`).join(' ')} i(${topology.sourceId})`)
  directives.forEach((line, i) => out.push(`TEXT 64 ${height + i * 32} Left 2 !${line}`))
  const styleWarnings:string[]=[]
  if(p.drawing!.devices.some(device=>device.kind==='GND'&&(device.groundStyle??'earth')!=='signal'))styleWarnings.push('ASC 节点 0 使用 LTspice 标准信号地；保护地、机壳地外观请保存工程 JSON。')
  if(p.drawing!.labels?.some(label=>(label.rotation??0)!==0))styleWarnings.push('ASC 端口随重新排版调整方向；自定义旋转角度请保存工程 JSON。')
  if(p.drawing!.labels?.some(label=>label.style==='power'&&!/^(?:vcc|vdd|vss|vee|vbat|vbus|vref|avcc|avdd|dvcc|dvdd)(?:_?[a-z0-9]+)?$/i.test(label.name)))styleWarnings.push('ASC 自定义电源网络保留名称；电源符号外观请保存工程 JSON。')
  return { text: out.join('\r\n') + '\r\n', warnings: ['ASC 按器件重新排版，使用同名 FLAG 保留连接，In / Out / BiDir 端口保留为 IOPIN；原画布走线、注释和探针显示样式不保留。',...styleWarnings,...(topology.elements.some(({device})=>isConfiguredSource(device))?['ASC 仅包含当前分析使用的激励；保留全部 DC / AC / 瞬态设置请保存工程 JSON。当前工作台文本导入器尚不支持 PWL、非标准 PULSE、多动态源和非零 AC 相位，包含这些配置的 ASC 暂不能重新导入。']:[])] }
}
