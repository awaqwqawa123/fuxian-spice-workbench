import { pinAlignedWireBend, repairAutomaticWireRoute } from './wire-lead-route'
import { deviceCatalog, pinsFor } from './devices'
import { DRAWING_BOUNDS, GRID, indexDrawingRenderSnapshot, pinPosition, rawWirePoints, simplifyWirePoints, terminalKey, terminalPosition } from './drawing-geometry'
export { DRAWING_BOUNDS, GRID, pinPosition, rawWirePoints, simplifyWirePoints, terminalKey, terminalPosition } from './drawing-geometry'
import { validateDeviceParameters } from './device-parameters'
import { spiceNodeName } from './spice-parameters'
import { connectionShorts } from './connection-shorts'
export type DeviceKind = 'R' | 'C' | 'L' | 'V' | 'I' | 'D' | 'Q' | 'M' | 'J' | 'X' | 'OPA' | 'CMP' | 'OP' | 'SW' | 'VSW' | 'RELAY' | 'LDO' | 'XFMR' | 'GND'
export type Pin = number
export type Rotation = 0 | 90 | 180 | 270
export type GroundStyle = 'earth' | 'signal' | 'chassis'
export type NetLabelStyle = 'text' | 'power' | 'input' | 'output' | 'bidirectional'
export interface Device { id: string; kind: DeviceKind; value: string; x: number; y: number; rotation: Rotation; groundStyle?:GroundStyle; mirrored?: boolean; params?:Record<string,string>; /** Immutable ordered .subckt ports. */ pins?:string[]; /** Local, unrotated symbol anchors matching ports. */ pinPositions?:XY[] }
export type Terminal = { device: string; pin: Pin } | { junction: string }
export interface Junction { id: string; x: number; y: number }
export interface Wire { id: string; from: Terminal; to: Terminal; bend: 'hv' | 'vh'; waypoints?: XY[] }
export interface NetLabel { id: string; name: string; at: Terminal; style?:NetLabelStyle; rotation?:Rotation }
export interface Drawing { labels?: NetLabel[]; devices: Device[]; junctions: Junction[]; wires: Wire[]; sourceId: string; output: Terminal | null }
export type XY = { x: number; y: number }
export const MAX_WIRE_WAYPOINTS = 32
export const CANVAS = { width: 1200, height: 640 }
// The viewport is independent of the editable world. Keep old projects at their
// original coordinates while allowing placement in every direction after panning.
export const clampCoordinate = (value:number,margin=0) => Math.max(DRAWING_BOUNDS.min+margin,Math.min(DRAWING_BOUNDS.max-margin,value))
export const deviceNames = Object.fromEntries(Object.entries(deviceCatalog).map(([kind, spec]) => [kind, spec.name])) as Record<DeviceKind, string>
export const terminal = (device: string, pin: Pin = 0): Terminal => ({ device, pin })
export const snap = (v: number) => Math.round(v / GRID) * GRID
export const sameTerminal = (a: Terminal, b: Terminal) => terminalKey(a) === terminalKey(b)
export const emptyDrawing = (): Drawing => ({ devices: [], junctions: [], wires: [], labels: [], sourceId: '', output: null })
export function nextId(prefix: string, items: { id: string }[]): string { let n = 1; while (items.some(p => p.id === `${prefix}${n}`)) n++; return `${prefix}${n}` }

export interface DrawingRenderCacheStats {snapshots:number;routeComputations:number;routeHits:number;explicitReuses:number}
interface DrawingRenderRouteCache {
  routes:WeakMap<Wire,XY[]>
  explicit:WeakMap<Wire,{from:Device|Junction|undefined;to:Device|Junction|undefined;points:XY[]}>
  devices:Map<string,Device>;junctions:Map<string,Junction>
  stats:DrawingRenderCacheStats
}
const drawingRenderRoutes=new WeakMap<Drawing,DrawingRenderRouteCache>()

/** Exact geometry reuse for one mounted renderer. Sources and nested objects
 * must be immutable snapshots. Only the returned shallow, read-only view is
 * cached; normal Drawing inputs and mutation/solver helpers remain uncached.
 * Weak keys allow former drag previews and undo snapshots to be collected. */
export function createDrawingRenderCache() {
  const snapshots=new WeakMap<Drawing,Drawing>(),explicit:DrawingRenderRouteCache['explicit']=new WeakMap()
  const stats:DrawingRenderCacheStats={snapshots:0,routeComputations:0,routeHits:0,explicitReuses:0}
  return {
    snapshot(source:Drawing):Drawing {
      const cached=snapshots.get(source)
      if(cached)return cached
      const drawing={...source},devices=new Map<string,Device>(),junctions=new Map<string,Junction>()
      for(const device of drawing.devices)if(!devices.has(device.id))devices.set(device.id,device)
      for(const junction of drawing.junctions)if(!junctions.has(junction.id))junctions.set(junction.id,junction)
      indexDrawingRenderSnapshot(drawing)
      drawingRenderRoutes.set(drawing,{routes:new WeakMap(),explicit,devices,junctions,stats})
      snapshots.set(source,drawing);stats.snapshots++
      return drawing
    },
    readStats:():DrawingRenderCacheStats=>({...stats}),
    resetStats:()=>{stats.snapshots=0;stats.routeComputations=0;stats.routeHits=0;stats.explicitReuses=0},
  }
}
export function wirePoints(d:Drawing,w:Wire):XY[] {
  const cache=drawingRenderRoutes.get(d),saved=cache?.routes.get(w)
  if(saved){cache!.stats.routeHits++;return saved}
  const owner=(at:Terminal)=>'device'in at?cache?.devices.get(at.device):cache?.junctions.get(at.junction)
  const from=cache?owner(w.from):undefined,to=cache?owner(w.to):undefined
  if(cache&&w.waypoints?.length){
    const previous=cache.explicit.get(w)
    if(previous&&previous.from===from&&previous.to===to){cache.routes.set(w,previous.points);cache.stats.explicitReuses++;return previous.points}
  }
  const points=rawWirePoints(d,w)
  const result=w.waypoints?.length?points:repairAutomaticWireRoute(d,w,points)
  if(cache){
    cache.stats.routeComputations++;cache.routes.set(w,result)
    if(w.waypoints?.length)cache.explicit.set(w,{from,to,points:result})
  }
  return result
}
export function wirePath(d: Drawing, w: Wire): string { return wirePoints(d,w).map((p,i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ') }
function onWire(d:Drawing,w:Wire,p:XY) {
  const points=wirePoints(d,w)
  return points.some((b,i)=>{if(!i)return false;const a=points[i-1];return a.x===b.x?p.x===a.x&&p.y>=Math.min(a.y,b.y)&&p.y<=Math.max(a.y,b.y):p.y===a.y&&p.x>=Math.min(a.x,b.x)&&p.x<=Math.max(a.x,b.x)})
}
export function addDevice(d: Drawing, kind: DeviceKind, at: XY, rotation?: Rotation): { drawing: Drawing; id: string } {
  if (d.devices.length >= 80) throw new Error('当前最多支持 80 个器件')
  const id = nextId(deviceCatalog[kind].prefix, d.devices)
  const device: Device = { id, kind, value: deviceCatalog[kind].value, x: clampCoordinate(snap(at.x),80), y: clampCoordinate(snap(at.y),80), rotation: rotation ?? (kind === 'V' || kind === 'C' ? 90 : 0) }
  return { drawing: { ...d, devices: [...d.devices, device], sourceId: !d.sourceId && kind === 'V' ? id : d.sourceId }, id }
}
export function connect(d: Drawing, from: Terminal, to: Terminal, bend: Wire['bend'] = 'hv'): Drawing {
  terminalPosition(d, from); terminalPosition(d,to)
  if (sameTerminal(from,to)) return d
  if (d.wires.some(w => sameTerminal(w.from,from) && sameTerminal(w.to,to) || sameTerminal(w.from,to) && sameTerminal(w.to,from))) return d
  if (d.wires.length >= 200) throw new Error('当前最多支持 200 段导线')
  return { ...d, wires: [...d.wires, { id: nextId('W', d.wires), from, to, bend:pinAlignedWireBend(d,from,to,bend) }] }
}
export function splitWire(d: Drawing, wireId: string, at: XY): { drawing: Drawing; terminal: Terminal } {
  const wire = d.wires.find(w => w.id === wireId)
  if (!wire) throw new Error('导线不存在')
  const points = wirePoints(d,wire)
  if (points.length < 2) return { drawing: d, terminal: wire.from }
  let closest = points[0], distance = Infinity, segment = 1
  for (let i = 1; i < points.length; i++) {
    const a = points[i-1], b = points[i]
    const p = { x: a.x === b.x ? a.x : Math.max(Math.min(a.x,b.x),Math.min(Math.max(a.x,b.x),snap(at.x))), y: a.y === b.y ? a.y : Math.max(Math.min(a.y,b.y),Math.min(Math.max(a.y,b.y),snap(at.y))) }
    const dist = Math.hypot(p.x-at.x,p.y-at.y)
    if (dist < distance) { closest = p; distance = dist; segment=i }
  }
  const first = points[0], last = points[points.length-1]
  if (closest.x === first.x && closest.y === first.y) return { drawing: d, terminal: wire.from }
  if (closest.x === last.x && closest.y === last.y) return { drawing: d, terminal: wire.to }
  if (d.junctions.length >= 100 || d.wires.length >= 200) throw new Error('连接点或导线数量已达上限')
  const id = nextId('J',d.junctions), point: Terminal = { junction: id }
  const firstHalf=simplifyWirePoints([...points.slice(0,segment),closest]),secondHalf=simplifyWirePoints([closest,...points.slice(segment)])
  if(Math.max(firstHalf.length,secondHalf.length)-2>MAX_WIRE_WAYPOINTS)throw new Error('导线拐点过多，请先简化走线再添加分支')
  const half=(path:XY[],from:Terminal,to:Terminal,id:string):Wire=>({id,from,to,bend:path[0].y===path[1]?.y?'hv':'vh',...(path.length>2?{waypoints:path.slice(1,-1)}:{})})
  const left=half(firstHalf,wire.from,point,wire.id),right=half(secondHalf,point,wire.to,nextId('W',d.wires))
  const next = { ...d, junctions: [...d.junctions,{ id,...closest }], wires: d.wires.flatMap(w=>w.id===wireId?[left,right]:[w]) }
  return { drawing: next, terminal: point }
}
export function removeItem(d: Drawing, id: string): Drawing {
  const isRemoved = (t: Terminal) => 'device' in t ? t.device === id : t.junction === id
  const next = { ...d, labels: (d.labels ?? []).filter(l => l.id !== id && !isRemoved(l.at)), devices: d.devices.filter(p => p.id !== id), junctions: d.junctions.filter(j => j.id !== id), wires: d.wires.filter(w => w.id !== id && !isRemoved(w.from) && !isRemoved(w.to)), output: d.output && !isRemoved(d.output) ? d.output : null, sourceId: d.sourceId === id ? '' : d.sourceId }
  const used = new Set(next.wires.flatMap(w => [terminalKey(w.from),terminalKey(w.to)]))
  for (const label of next.labels) if ('junction' in label.at) used.add(label.at.junction)
  next.junctions = next.junctions.filter(j => used.has(j.id))
  if (next.output && 'junction' in next.output && !used.has(next.output.junction)) next.output = null
  return next
}
// Creating a junction at an intersection is an explicit connection action.
// All wires through that marked point join; ordinary crossings remain separate.
export function joinAtWire(d:Drawing,wireId:string,at:XY):{drawing:Drawing;terminal:Terminal} {
  const first=splitWire(d,wireId,at), point=terminalPosition(first.drawing,first.terminal)
  let next=first.drawing
  for(const wire of d.wires){
    if(wire.id===wireId||!onWire(d,wire,point))continue
    const split=splitWire(next,wire.id,point)
    next=connect(split.drawing,first.terminal,split.terminal)
  }
  return{drawing:next,terminal:first.terminal}
}

// The importer accepts incomplete drawings, but never dangling references or arbitrary SPICE text.
export function parseDrawing(raw: unknown): Drawing {
  if (!raw || typeof raw !== 'object') throw new Error('缺少原理图数据')
  const d = raw as Drawing
  if (!Array.isArray(d.devices) || !Array.isArray(d.wires) || !Array.isArray(d.junctions) || d.devices.length > 80 || d.wires.length > 200 || d.junctions.length > 100) throw new Error('原理图结构或数量超出限制')
  const ids = new Map<string,string>()
  const checkId = (id: string, prefix:string,path:string) => {
    const shown=JSON.stringify(typeof id==='string'?id.slice(0,80):id)
    if (typeof id !== 'string' || id!==id.trim() || !new RegExp(`^${prefix}[1-9]\\d{0,4}$`).test(id)) throw new Error(`${path} = ${shown} 不合法；须用 ${prefix} 加 1～99999 的整数，例如 ${prefix}1（大写、无前导零）。器件、连接点、导线和标签的编号必须全局唯一。`)
    const previous=ids.get(id)
    if(previous)throw new Error(`${path} = ${shown} 与 ${previous} 重复；请使用不同编号并同步对应引用，例如下一个未使用的 ${prefix}2。`)
    ids.set(id,path)
  }
  const coord = (v: number) => { if (!Number.isFinite(v) || v < DRAWING_BOUNDS.min || v > DRAWING_BOUNDS.max || v % GRID !== 0) throw new Error('原理图坐标必须位于 ±20000 的画布网格上'); return v }
  const devices = d.devices.map((p,index) => {
    if (!p || !Object.hasOwn(deviceCatalog,p.kind)) throw new Error(`project.drawing.devices[${index}].kind：不支持此器件类型`)
    checkId(p.id,deviceCatalog[p.kind].prefix,`project.drawing.devices[${index}].id`)
    if (p.mirrored !== undefined && typeof p.mirrored !== 'boolean') throw new Error('镜像参数格式错误')
    if (p.groundStyle !== undefined && (p.kind !== 'GND' || !['earth','signal','chassis'].includes(p.groundStyle))) throw new Error(`${p.id}：接地符号样式无效`)
    if (![0,90,180,270].includes(p.rotation) || typeof p.value !== 'string' || p.value.length > 40) throw new Error('器件参数格式错误')
    const params=validateDeviceParameters(p)
    if(p.kind==='X'&&(!Array.isArray(p.pins)||p.pins.length<2||p.pins.length>32||p.pins.some(pin=>typeof pin!=='string'||pin.length>40||!spiceNodeName.test(pin))||new Set(p.pins.map(pin=>pin.toLowerCase())).size!==p.pins.length))throw new Error(`${p.id}：子电路须保存 2～32 个有序引脚`)
    if(p.pinPositions!==undefined&&(p.kind!=='X'||!Array.isArray(p.pinPositions)||p.pinPositions.length!==p.pins?.length||p.pinPositions.some(pin=>!pin||!Number.isInteger(pin.x)||!Number.isInteger(pin.y)||Math.abs(pin.x)>2560||Math.abs(pin.y)>2560)))throw new Error(`${p.id}：子电路符号引脚坐标无效`)
    return { id:p.id,kind:p.kind,value:p.value,x:coord(p.x),y:coord(p.y),rotation:p.rotation,...(p.groundStyle!==undefined?{groundStyle:p.groundStyle}:{}),...(p.mirrored ? {mirrored:true} : {}),...(params!==undefined?{params}:{}),...(p.kind==='X'?{pins:[...p.pins!],...(p.pinPositions?{pinPositions:p.pinPositions.map(pin=>({x:pin.x,y:pin.y}))}:{})}:{}) }
  })
  const junctions = d.junctions.map((j,index) => { if (!j) throw new Error(`project.drawing.junctions[${index}]：连接点格式错误`); checkId(j.id,'J',`project.drawing.junctions[${index}].id`); return { id:j.id,x:coord(j.x),y:coord(j.y) } })
  const endpoint = (t: Terminal,path:string): Terminal => {
    if (!t || typeof t !== 'object') throw new Error(`${path}：导线端点格式错误；使用 {device:"R1",pin:0} 或 {junction:"J1"}`)
    if ('device' in t && devices.some(p => p.id === t.device && pinsFor(p).includes(t.pin))) return { device:t.device,pin:t.pin }
    if ('junction' in t && junctions.some(j => j.id === t.junction)) return { junction:t.junction }
    if('device'in t){
      const part=devices.find(part=>part.id===t.device)
      if(!part)throw new Error(`${path}.device = ${JSON.stringify(t.device)}：引用了不存在的器件；请使用 devices 中的准确编号`)
      throw new Error(`${path}.pin = ${JSON.stringify(t.pin)}：${part.id}（${part.kind}）不存在此引脚；合法 pin 为 ${pinsFor(part).join('、')}`)
    }
    throw new Error(`${path}.junction = ${JSON.stringify('junction'in t?t.junction:undefined)}：引用了不存在的连接点；请使用 junctions 中的准确编号，例如 J1`)
  }
  const wires = d.wires.map((w,index) => {
    if (!w) throw new Error(`project.drawing.wires[${index}]：导线格式错误`); checkId(w.id,'W',`project.drawing.wires[${index}].id`); if (!['hv','vh'].includes(w.bend)) throw new Error('导线走向错误')
    if(w.waypoints!==undefined&&(!Array.isArray(w.waypoints)||w.waypoints.length>MAX_WIRE_WAYPOINTS))throw new Error(`导线最多支持 ${MAX_WIRE_WAYPOINTS} 个拐点`)
    const waypoints=w.waypoints?.map(p=>{if(!p||typeof p!=='object'||Array.isArray(p))throw new Error('导线拐点格式错误');return{x:coord(p.x),y:coord(p.y)}})
    return { id:w.id,from:endpoint(w.from,`project.drawing.wires[${index}].from`),to:endpoint(w.to,`project.drawing.wires[${index}].to`),bend:w.bend,...(waypoints?.length?{waypoints}:{}) }
  })
  if (typeof d.sourceId !== 'string' || d.sourceId !== '' && !devices.some(p => p.id === d.sourceId && p.kind === 'V')) throw new Error(`project.drawing.sourceId = ${JSON.stringify(d.sourceId)}：输入电源引用错误；使用存在的 V 类型器件编号，例如 V1，未完成草图可用空字符串`)
  if (d.labels !== undefined && (!Array.isArray(d.labels) || d.labels.length > 100)) throw new Error('节点标签最多支持 100 个')
  const labels = (d.labels ?? []).map((l,index) => {
    if (!l) throw new Error(`project.drawing.labels[${index}]：节点标签格式错误`)
    checkId(l.id,'N',`project.drawing.labels[${index}].id`)
    validateLabelName(l.name)
    validateLabelAppearance(l)
    return { id:l.id,name:l.name,at:endpoint(l.at,`project.drawing.labels[${index}].at`),...(l.style!==undefined?{style:l.style}:{}),...(l.rotation!==undefined?{rotation:l.rotation}:{}) }
  })
  return { devices,junctions,wires,labels,sourceId:d.sourceId,output:d.output === null ? null : endpoint(d.output,'project.drawing.output') }
}

export function validateLabelName(name:string) {
  if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/.test(name)) throw new Error('节点名请使用字母开头的字母、数字或下划线，最多 32 个字符')
}
function validateLabelAppearance(appearance:Pick<NetLabel,'style'|'rotation'>) {
  if(appearance.style!==undefined&&!['text','power','input','output','bidirectional'].includes(appearance.style))throw new Error('网络符号样式无效')
  if(appearance.rotation!==undefined&&![0,90,180,270].includes(appearance.rotation))throw new Error('网络符号旋转角度无效')
}
export function setNetLabel(d:Drawing, at:Terminal, name:string, appearance:Pick<NetLabel,'style'|'rotation'> = {}):Drawing {
  terminalPosition(d,at)
  validateLabelAppearance(appearance)
  const remaining=(d.labels ?? []).filter(l=>!sameTerminal(l.at,at))
  if (!name.trim()) return {...d,labels:remaining}
  name=name.trim(); validateLabelName(name)
  if (remaining.length>=100) throw new Error('节点标签最多支持 100 个')
  const existing=(d.labels ?? []).find(l=>sameTerminal(l.at,at))
  return {...d,labels:[...remaining,{...(existing??{}),id:existing?.id ?? nextId('N',d.labels ?? []),name,at,...(appearance.style!==undefined?{style:appearance.style}:{}),...(appearance.rotation!==undefined?{rotation:appearance.rotation}:{})}]}
}
export function compileDrawing(d: Drawing) {
  const errors: string[] = [], parent = new Map<string,string>(), connections = new Set<string>()
  const terminals: Terminal[] = d.devices.flatMap(p => pinsFor(p).map(pin=>terminal(p.id,pin))).concat(d.junctions.map(j => ({ junction:j.id })))
  terminals.forEach(t => parent.set(terminalKey(t),terminalKey(t)))
  function root(k: string): string { const p = parent.get(k); if (p === undefined) throw new Error('电路引用了无效引脚'); if (p === k) return k; const r = root(p); parent.set(k,r); return r }
  function union(a: string,b: string) { parent.set(root(a),root(b)) }
  d.wires.forEach(w => { const a=terminalKey(w.from),b=terminalKey(w.to); union(a,b); connections.add(a);connections.add(b) })
  const labelGroups=new Map<string,string[]>()
  for (const l of d.labels ?? []) {
    validateLabelName(l.name)
    const name=l.name.toLowerCase(), key=terminalKey(l.at)
    root(key)
    labelGroups.set(name,[...(labelGroups.get(name) ?? []),key])
  }
  for (const group of labelGroups.values()) if(group.length>1) for(const key of group){union(group[0],key);connections.add(key)}
  const grounds=d.devices.filter(p=>p.kind==='GND')
  grounds.slice(1).forEach(p=>union(`${grounds[0].id}:0`,`${p.id}:0`))
  const ground=grounds[0]?root(`${grounds[0].id}:0`):undefined
  const source=d.devices.find(p=>p.id===d.sourceId&&p.kind==='V')
  if(!grounds.length)errors.push('请放置 GND 并连接到电路')
  if(!source)errors.push('请放置电压源并指定输入激励')
  if(!d.output)errors.push('请选择输出探针，再点击一个引脚或导线')
  const inputRoot=source?root(`${source.id}:0`):undefined, outRoot=d.output?root(terminalKey(d.output)):undefined
  if(source&&ground&&root(`${source.id}:1`)!==ground)errors.push(`${source.id} 的负端须连接 GND（输入参考地）`)
  if(inputRoot&&inputRoot===ground)errors.push('输入电源正端被短接到 GND')
  if(outRoot&&outRoot===ground)errors.push('输出探针位于 GND，请选择需要测量的信号节点')
  const names=new Map<string,string>(), usedNames=new Set<string>(['0'])
  if(ground)names.set(ground,'0')
  for(const [name,group] of labelGroups){
    const key=root(group[0]), old=names.get(key)
    if(old&&old!==name&&old!=='0')errors.push(`同一节点存在冲突标签 ${old} / ${name}，请统一名称`)
    if(key!==ground)names.set(key,name)
    usedNames.add(name)
  }
  function assign(key:string|undefined,preferred:string){
    if(!key||names.has(key))return
    let name=preferred,i=1
    while(usedNames.has(name))name=`${preferred}_${i++}`
    names.set(key,name);usedNames.add(name)
  }
  assign(inputRoot,'vin');assign(outRoot,'vout')
  let nodeId=1
  for(const t of [...terminals].sort((a,b)=>terminalKey(a).localeCompare(terminalKey(b)))){
    const key=root(terminalKey(t));if(names.has(key))continue
    while(usedNames.has(`n${nodeId}`))nodeId++
    assign(key,`n${nodeId++}`)
  }
  const nodes=new Map(terminals.map(t=>[terminalKey(t),names.get(root(terminalKey(t)))!]))
  for(const j of d.junctions)if(d.wires.some(w=>nodes.get(terminalKey(w.from))!==nodes.get(j.id)&&onWire(d,w,j)))errors.push(`${j.id} 与未连接导线重叠，请在接线模式点击交点连接，或调整走线`)
  const elements=d.devices.filter(p=>p.kind!=='GND').map(device=>({device,nodes:pinsFor(device).map(pin=>nodes.get(`${device.id}:${pin}`)!)}))
  const graph=new Map<string,Set<string>>()
  for(const {device,nodes:ns} of elements){
    for(const pin of pinsFor(device))if(!connections.has(`${device.id}:${pin}`)&&device.kind!=='X'&&!(device.kind==='RELAY'&&(pin===3||pin===4)))errors.push(`${device.id} 的 ${pin+1} 号引脚未连接`)
    if(device.kind==='RELAY'&&![3,4].some(pin=>connections.has(`${device.id}:${pin}`)))errors.push(`${device.id} 至少需要连接 NO 或 NC 中的一个触点`)
    if(device.kind==='V'&&ns[0]===ns[1])errors.push(`${device.id} 的正负端被短接`)
    for(const n of ns){if(!graph.has(n))graph.set(n,new Set());for(const other of ns)if(other!==n)graph.get(n)!.add(other)}
  }
  const reached=new Set<string>(['0']),queue=['0']
  for(let i=0;i<queue.length;i++)for(const n of graph.get(queue[i])??[])if(!reached.has(n)){reached.add(n);queue.push(n)}
  if(elements.some(e=>e.nodes.some(n=>!reached.has(n))))errors.push('存在与接地电路分离的器件，请检查连线')
  const shorts=connectionShorts(d,nodes)
  const warnings=shorts.filter(short=>!d.devices.some(device=>device.id===short.deviceId&&device.kind==='V')).map(short=>short.message)
  return {errors:[...new Set(errors)],warnings,shorts,nodes,elements,inputNode:inputRoot?names.get(inputRoot)!:'vin',outputNode:outRoot?names.get(outRoot)!:'vout',sourceId:source?.id??'V1'}
}
