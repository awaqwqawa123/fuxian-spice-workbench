import { pinsFor } from './devices'
import { pinPosition, terminalPosition, wirePoints, type Drawing, type Terminal, type XY } from './drawing'

/** View-only attachment to an existing conductor. Never creates a junction. */
export interface WireAnchor { wireId:string; fraction:number }
export interface ProbeTarget { at:Terminal; point:XY; anchor?:WireAnchor; distance:number }
export interface ProbeLayout { anchor?:WireAnchor; offset?:XY }

export function projectOnWire(drawing:Drawing,wireId:string,point:XY):ProbeTarget|null {
  const wire=drawing.wires.find(w=>w.id===wireId)
  if(!wire)return null
  const points=wirePoints(drawing,wire),lengths=points.slice(1).map((b,i)=>Math.hypot(b.x-points[i].x,b.y-points[i].y))
  const total=lengths.reduce((a,b)=>a+b,0)
  let target:ProbeTarget={at:wire.from,point:points[0],distance:Math.hypot(point.x-points[0].x,point.y-points[0].y),anchor:{wireId,fraction:0}},along=0
  for(let i=0;i<lengths.length;i++){
    const a=points[i],b=points[i+1],length=lengths[i]
    const t=length?Math.max(0,Math.min(1,((point.x-a.x)*(b.x-a.x)+(point.y-a.y)*(b.y-a.y))/(length*length))):0
    const projected={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t},distance=Math.hypot(point.x-projected.x,point.y-projected.y)
    if(distance<=target.distance)target={at:wire.from,point:projected,distance,anchor:{wireId,fraction:total?(along+length*t)/total:0}}
    along+=length
  }
  return target
}

export function probePoint(drawing:Drawing,at:Terminal,anchor?:WireAnchor):XY {
  const wire=anchor&&drawing.wires.find(w=>w.id===anchor.wireId)
  if(!wire)return terminalPosition(drawing,at)
  const points=wirePoints(drawing,wire),lengths=points.slice(1).map((b,i)=>Math.hypot(b.x-points[i].x,b.y-points[i].y))
  let remaining=lengths.reduce((a,b)=>a+b,0)*Math.max(0,Math.min(1,anchor!.fraction))
  for(let i=0;i<lengths.length;i++){
    if(remaining<=lengths[i]&&lengths[i]){const t=remaining/lengths[i];return{x:points[i].x+(points[i+1].x-points[i].x)*t,y:points[i].y+(points[i+1].y-points[i].y)*t}}
    remaining-=lengths[i]
  }
  return points.at(-1)!
}

export function nearestProbeTarget(drawing:Drawing,point:XY,radius:number):ProbeTarget|null {
  const targets:ProbeTarget[]=[...drawing.devices.flatMap(device=>pinsFor(device).map(pin=>{const p=pinPosition(device,pin);return{at:{device:device.id,pin},point:p,distance:Math.hypot(p.x-point.x,p.y-point.y)}})),...drawing.junctions.map(j=>({at:{junction:j.id},point:{x:j.x,y:j.y},distance:Math.hypot(j.x-point.x,j.y-point.y)}))]
  for(const wire of drawing.wires){const p=projectOnWire(drawing,wire.id,point);if(p)targets.push(p)}
  return targets.filter(t=>t.distance<=radius).sort((a,b)=>a.distance-b.distance)[0]??null
}

/** Wire-only snap for current clamps. At an exact branch/crossing, require a chosen segment. */
export function nearestWireProbeTarget(drawing:Drawing,point:XY,radius:number):ProbeTarget|null {
  const candidates=drawing.wires.map(w=>projectOnWire(drawing,w.id,point)).filter((p):p is ProbeTarget=>!!p&&p.distance<=radius).sort((a,b)=>a.distance-b.distance)
  if(candidates[1]&&Math.abs(candidates[0].distance-candidates[1].distance)<1e-6)return null
  return candidates[0]??null
}

/** Direction of the actual polyline segment under the clamp, in from → to order. */
export function wireProbeAngle(drawing:Drawing,anchor:WireAnchor,direction:1|-1=1):number {
  const wire=drawing.wires.find(w=>w.id===anchor.wireId)
  if(!wire)return 0
  const points=wirePoints(drawing,wire),lengths=points.slice(1).map((b,i)=>Math.hypot(b.x-points[i].x,b.y-points[i].y))
  let remaining=lengths.reduce((a,b)=>a+b,0)*Math.max(0,Math.min(1,anchor.fraction))
  for(let i=0;i<lengths.length;i++){
    if(remaining<=lengths[i]||i===lengths.length-1)return Math.atan2(points[i+1].y-points[i].y,points[i+1].x-points[i].x)*180/Math.PI+(direction===-1?180:0)
    remaining-=lengths[i]
  }
  return 0
}
