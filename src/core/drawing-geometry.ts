import { localPin, pinsFor } from './devices'
import type { Device, Drawing, Pin, Terminal, Wire, XY } from './drawing'

export const GRID = 20
export const DRAWING_BOUNDS = { min: -20000, max: 20000 }
export const terminalKey = (t: Terminal) => 'device' in t ? `${t.device}:${t.pin}` : t.junction

// Only renderer-owned immutable wrappers are registered. General Drawing inputs
// remain mutable and keep the normal lookup semantics used by editing helpers.
const renderTerminalOwners = new WeakMap<Drawing, {devices:Map<string,Device>;junctions:Map<string,Drawing['junctions'][number]>}>()
export function indexDrawingRenderSnapshot(drawing:Drawing):void {
  const devices=new Map<string,Device>(),junctions=new Map<string,Drawing['junctions'][number]>()
  for(const device of drawing.devices)if(!devices.has(device.id))devices.set(device.id,device)
  for(const junction of drawing.junctions)if(!junctions.has(junction.id))junctions.set(junction.id,junction)
  renderTerminalOwners.set(drawing,{devices,junctions})
}

export function pinPosition(d: Device, pin: Pin): XY {
  const local = localPin(d.kind, pin, d)
  const x = local.x * (d.mirrored ? -1 : 1), y = local.y
  const angle = d.rotation * Math.PI / 180
  return { x: d.x + Math.round(x * Math.cos(angle) - y * Math.sin(angle)), y: d.y + Math.round(x * Math.sin(angle) + y * Math.cos(angle)) }
}
export function terminalPosition(d: Drawing, t: Terminal): XY {
  const owners=renderTerminalOwners.get(d)
  if ('junction' in t) { const j = owners?owners.junctions.get(t.junction):d.junctions.find(j => j.id === t.junction); if (!j) throw new Error('连接点不存在'); return j }
  const part = owners?owners.devices.get(t.device):d.devices.find(p => p.id === t.device)
  if (!part || !pinsFor(part).includes(t.pin)) throw new Error('引脚不存在')
  return pinPosition(part, t.pin)
}
/** Remove zero-length and redundant straight spans without changing terminal anchors. */
export function simplifyWirePoints(points: readonly XY[]): XY[] {
  const compact:XY[]=[]
  for(const point of points){
    const last=compact.at(-1)
    if(last&&last.x===point.x&&last.y===point.y)continue
    while(compact.length>=2){
      const a=compact[compact.length-2],b=compact[compact.length-1]
      if((a.x===b.x&&b.x===point.x)||(a.y===b.y&&b.y===point.y))compact.pop()
      else break
    }
    if(compact.at(-1)?.x===point.x&&compact.at(-1)?.y===point.y)continue
    compact.push({x:point.x,y:point.y})
  }
  return compact
}
export function rawWirePoints(d: Drawing, w: Wire): XY[] {
  const from = terminalPosition(d,w.from), to = terminalPosition(d,w.to)
  if(!w.waypoints?.length){
    const corner = w.bend === 'hv' ? { x: to.x, y: from.y } : { x: from.x, y: to.y }
    return simplifyWirePoints([from,corner,to])
  }
  const route:XY[]=[from]
  let preferred=w.bend
  for(const target of [...w.waypoints,to]){
    const previous=route.at(-1)!
    // Moving a device must not detach its wire or create a diagonal segment.
    if(previous.x!==target.x&&previous.y!==target.y)route.push(preferred==='hv'?{x:target.x,y:previous.y}:{x:previous.x,y:target.y})
    const penultimate=route.at(-1)!
    if(penultimate.x!==target.x||penultimate.y!==target.y){
      route.push({x:target.x,y:target.y})
      preferred=penultimate.y===target.y?'vh':'hv'
    }
  }
  return simplifyWirePoints(route)
}
