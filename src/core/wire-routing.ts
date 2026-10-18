import { pinsFor } from './devices'
import { clampCoordinate, pinPosition, snap, wirePoints, type Drawing, type Terminal, type XY } from './drawing'
import { terminalLeadDirection } from './wire-lead-route'

export interface WireSnapTarget { point:XY; terminal?:Terminal; wireId?:string }
interface WireSegment { wireId:string; from:XY; to:XY }
export interface WireSnapIndex { terminals:WireSnapTarget[]; segments:WireSegment[] }

/** Follow the actual lead axis, including multi-pin symbols, rotation and mirroring. */
export function initialWireBend(drawing:Drawing,at:Terminal,fallback:'hv'|'vh'='hv'):'hv'|'vh' {
  const direction=terminalLeadDirection(drawing,at)
  return direction?direction.x?'hv':'vh':fallback
}

/** At an explicitly clicked waypoint, carry on in the arriving span's direction. */
export function continuedWireBend(from:XY,to:XY,bend:'hv'|'vh'):'hv'|'vh' {
  if(from.x===to.x)return'vh'
  if(from.y===to.y)return'hv'
  return bend==='hv'?'vh':'hv'
}

/** Build once per drawing change, not once per pointer event. */
export function createWireSnapIndex(drawing:Drawing):WireSnapIndex {
  return {
    terminals:[...drawing.devices.flatMap(part=>pinsFor(part).map(pin=>({point:pinPosition(part,pin),terminal:{device:part.id,pin}}))),...drawing.junctions.map(j=>({point:{x:j.x,y:j.y},terminal:{junction:j.id}}))],
    segments:drawing.wires.flatMap(w=>{const points=wirePoints(drawing,w);return points.slice(1).map((to,i)=>({wireId:w.id,from:points[i],to}))}),
  }
}

export function canvasPoint(point:XY):XY {return{x:clampCoordinate(point.x),y:clampCoordinate(point.y)}}
export function wireGridPoint(point:XY):XY {const p=canvasPoint(point);return{x:snap(p.x),y:snap(p.y)}}

function project(segment:WireSegment,point:XY,grid=false):XY {
  const {from:a,to:b}=segment
  return {
    x:a.x===b.x?a.x:Math.max(Math.min(a.x,b.x),Math.min(Math.max(a.x,b.x),grid?snap(point.x):point.x)),
    y:a.y===b.y?a.y:Math.max(Math.min(a.y,b.y),Math.min(Math.max(a.y,b.y),grid?snap(point.y):point.y)),
  }
}

/** Radius is measured on screen, so zooming never changes how close the user must aim. */
export function nearestWireTarget(index:WireSnapIndex,point:XY,screenScale:number,wireId?:string):WireSnapTarget|null {
  const scale=Number.isFinite(screenScale)&&screenScale>0?screenScale:1
  let distance=14/scale,result:WireSnapTarget|null=null
  if(!wireId)for(const candidate of index.terminals){
    const d=Math.hypot(point.x-candidate.point.x,point.y-candidate.point.y)
    if(d<=distance){distance=d;result=candidate}
  }
  // Pins and existing junctions are preferred to a branch a few pixels away.
  if(result)return result
  distance=wireId?Infinity:10/scale
  for(const segment of index.segments){
    if(wireId&&segment.wireId!==wireId)continue
    const projected=project(segment,point),d=Math.hypot(point.x-projected.x,point.y-projected.y)
    if(d<distance){distance=d;result={wireId:segment.wireId,point:project(segment,point,true)}}
  }
  return result
}
