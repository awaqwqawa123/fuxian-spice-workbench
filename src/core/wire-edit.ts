import { DRAWING_BOUNDS, MAX_WIRE_WAYPOINTS, clampCoordinate, sameTerminal, simplifyWirePoints, snap, wirePoints, type Drawing, type Wire, type XY } from './drawing'
import { followWireEndpoints } from './wire-follow'

export interface WireSegment { index:number; from:XY; to:XY }
export function nearestWireSegment(drawing:Drawing,wireId:string,at:XY):WireSegment|null {
  const wire=drawing.wires.find(w=>w.id===wireId)
  if(!wire||!Number.isFinite(at.x)||!Number.isFinite(at.y))return null
  const points=wirePoints(drawing,wire)
  let nearest:WireSegment|null=null,distance=Infinity
  for(let index=0;index<points.length-1;index++){
    const from=points[index],to=points[index+1]
    const x=Math.max(Math.min(from.x,to.x),Math.min(Math.max(from.x,to.x),at.x))
    const y=Math.max(Math.min(from.y,to.y),Math.min(Math.max(from.y,to.y),at.y))
    const candidate=Math.hypot(at.x-x,at.y-y)
    if(candidate<distance){distance=candidate;nearest={index,from,to}}
  }
  return nearest
}

// A clicked elbow (including one carrying a net label) belongs to the route.
// Branch junctions and device pins remain fixed electrical anchors.
function slidingEnd(drawing:Drawing,wire:Wire,end:'from'|'to',target:XY):[string,XY][] {
  const terminal=wire[end]
  if(!('junction' in terminal)||sameTerminal(wire.from,wire.to))return []
  const degree=drawing.wires.reduce((count,other)=>count+Number(sameTerminal(other.from,terminal))+Number(sameTerminal(other.to,terminal)),0)
  return degree===2?[[terminal.junction,target]]:[]
}

function setRoute(drawing:Drawing,wire:Wire,points:XY[],ends:[string,XY][]=[]):Drawing {
  const route=simplifyWirePoints(points),waypoints=route.slice(1,-1)
  // A drag reaching the complexity/world limit leaves its last valid route intact.
  if(waypoints.length>MAX_WIRE_WAYPOINTS||waypoints.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<DRAWING_BOUNDS.min||p.x>DRAWING_BOUNDS.max||p.y<DRAWING_BOUNDS.min||p.y>DRAWING_BOUNDS.max))return drawing
  const old=wirePoints(drawing,wire)
  if(old.length===route.length&&old.every((point,i)=>point.x===route[i].x&&point.y===route[i].y))return drawing
  const bend=route[0]?.y===route[1]?.y?'hv':'vh'
  const next:Wire={...wire,bend,waypoints}
  if(!waypoints.length)delete next.waypoints
  if(!ends.length)return{...drawing,wires:drawing.wires.map(w=>w.id===wire.id?next:w)}
  const moved=new Map(ends)
  const after={...drawing,junctions:drawing.junctions.map(j=>moved.has(j.id)?{...j,...moved.get(j.id)!}:j)}
  // Stretch the adjacent conductor in the same preview/commit. Keeping its
  // original endpoint would leave an old stub when overlaps are normalized.
  try {
    const selected=new Set<string>()
    const touches=(w:Wire)=>[w.from,w.to].some(t=>'junction' in t&&moved.has(t.junction))
    return{...after,wires:drawing.wires.map(w=>w.id===wire.id?next:touches(w)?followWireEndpoints(drawing,after,w,selected):w)}
  }catch{return drawing}
}

/** Delta is measured from the drawing captured on pointer down, not the previous frame. */
export function moveWireSegment(drawing:Drawing,wireId:string,segmentIndex:number,delta:XY):Drawing {
  const wire=drawing.wires.find(w=>w.id===wireId)
  if(!wire||!Number.isInteger(segmentIndex)||!Number.isFinite(delta.x)||!Number.isFinite(delta.y))return drawing
  const points=wirePoints(drawing,wire),a=points[segmentIndex],b=points[segmentIndex+1]
  if(!a||!b)return drawing
  const horizontal=a.y===b.y
  const shift=horizontal?clampCoordinate(snap(a.y+delta.y))-a.y:clampCoordinate(snap(a.x+delta.x))-a.x
  if(!shift)return drawing
  const moved=(p:XY):XY=>horizontal?{x:p.x,y:p.y+shift}:{x:p.x+shift,y:p.y}
  const from=segmentIndex===0?slidingEnd(drawing,wire,'from',moved(a)):[]
  const to=segmentIndex+1===points.length-1?slidingEnd(drawing,wire,'to',moved(b)):[]
  return setRoute(drawing,wire,[...points.slice(0,segmentIndex),...(segmentIndex===0&&!from.length?[a]:[]),moved(a),moved(b),...(segmentIndex+1===points.length-1&&!to.length?[b]:[]),...points.slice(segmentIndex+2)],[...from,...to])
}

/** Move a route corner in both axes; stretch fixed pins/branches and slide clicked elbows. */
export function moveWireCorner(drawing:Drawing,wireId:string,pointIndex:number,delta:XY):Drawing {
  const wire=drawing.wires.find(w=>w.id===wireId)
  if(!wire||!Number.isInteger(pointIndex)||!Number.isFinite(delta.x)||!Number.isFinite(delta.y))return drawing
  const points=wirePoints(drawing,wire)
  if(pointIndex<=0||pointIndex>=points.length-1)return drawing
  const corner=points[pointIndex],previous=points[pointIndex-1],next=points[pointIndex+1]
  const target={x:clampCoordinate(snap(corner.x+delta.x)),y:clampCoordinate(snap(corner.y+delta.y))}
  if(target.x===corner.x&&target.y===corner.y)return drawing
  const before=previous.y===corner.y?{x:previous.x,y:target.y}:{x:target.x,y:previous.y}
  const after=next.y===corner.y?{x:next.x,y:target.y}:{x:target.x,y:next.y}
  const from=pointIndex===1?slidingEnd(drawing,wire,'from',before):[]
  const to=pointIndex===points.length-2?slidingEnd(drawing,wire,'to',after):[]
  return setRoute(drawing,wire,[...points.slice(0,pointIndex-1),...(pointIndex===1&&!from.length?[previous]:[]),before,target,after,...(pointIndex===points.length-2&&!to.length?[next]:[]),...points.slice(pointIndex+2)],[...from,...to])
}
