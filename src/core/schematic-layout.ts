import { deviceCaptionRects, type LayoutRect } from './device-caption-geometry'
import { clampCoordinate, DRAWING_BOUNDS, GRID, MAX_WIRE_WAYPOINTS, terminalKey, terminalPosition, wirePoints, type Device, type Drawing, type NetLabel, type Terminal, type Wire, type XY } from './drawing'
import { localPin } from './devices'
import { visibleNetLabels } from './visible-net-labels'
import { netSymbolBounds } from './net-symbol-geometry'
import { followsLead, leadCaptionObstacles, leadExitPoint, routeLeadPath, routeRetraces, symbolBodyRect, terminalLeadDirection } from './wire-lead-route'
import { pointOnSpan, wireNetTopology } from './wire-net-topology'

/** A conservative visual rectangle around a symbol and its two captions. */
export type { LayoutRect } from './device-caption-geometry'
export { deviceCaptionRects } from './device-caption-geometry'

const rect = (left:number, top:number, right:number, bottom:number):LayoutRect => ({ left, top, right, bottom })
const grow = (value:LayoutRect, amount:number):LayoutRect => rect(value.left-amount,value.top-amount,value.right+amount,value.bottom+amount)
const overlaps = (a:LayoutRect,b:LayoutRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const width = (kind:Device['kind']) => kind === 'GND' ? 52 : ['RELAY','LDO','XFMR'].includes(kind) ? 132 : 116
const height = (kind:Device['kind']) => kind === 'GND' ? 66 : ['RELAY','LDO','XFMR'].includes(kind) ? 146 : 108

/** All visible symbol and caption bounds used by the router and label placer. */
export function deviceLayoutObstacles(device:Device, padding = 8):LayoutRect[] {
  return [deviceLayoutRect(device,padding), ...deviceCaptionRects(device,Math.min(4,padding))]
}

/**
 * Return the space occupied by a symbol plus its reference/value text. The
 * editor intentionally uses a little more space than the SVG stroke bounds;
 * this keeps generated labels readable at normal zoom and avoids symbol text
 * touching a neighbouring device.
 */
export function deviceLayoutRect(device:Device, padding = 8):LayoutRect {
  const vertical = device.rotation === 90 || device.rotation === 270
  const anchors=device.kind==='X'?(device.pins??[]).map((_,index)=>localPin('X',index,device)):[]
  const w=device.kind==='X'?Math.max(width('X'),...anchors.map(pin=>2*(Math.abs(pin.x)+18))):width(device.kind)
  const h=device.kind==='X'?Math.max(height('X'),...anchors.map(pin=>2*(Math.abs(pin.y)+18))):height(device.kind)
  const halfW = vertical ? h / 2 : w / 2
  const halfH = vertical ? w / 2 : h / 2
  // Ground captions sit to the right of the ground symbol.
  const left = device.kind === 'GND' ? device.x - 24 : device.x - halfW
  const right = device.kind === 'GND' ? device.x + 74 : device.x + halfW
  return grow(rect(left,device.y-halfH,right,device.y+halfH),padding)
}

const segmentLength = (a:XY,b:XY) => Math.abs(a.x-b.x)+Math.abs(a.y-b.y)
const axisAligned = (points:readonly XY[]) => points.every((point,index) => index === 0 || point.x === points[index-1].x || point.y === points[index-1].y)
const simplify = (points:readonly XY[]):XY[] => {
  const result:XY[] = []
  for(const point of points){
    const previous=result.at(-1)
    if(previous && previous.x===point.x && previous.y===point.y)continue
    while(result.length>=2){
      const a=result[result.length-2],b=result[result.length-1]
      if(a.x===b.x&&b.x===point.x || a.y===b.y&&b.y===point.y)result.pop()
      else break
    }
    result.push({x:point.x,y:point.y})
  }
  return result
}

function segmentIntersects(a:XY,b:XY,obstacle:LayoutRect):boolean {
  if(a.x===b.x){
    if(a.x < obstacle.left || a.x > obstacle.right)return false
    return Math.max(Math.min(a.y,b.y),obstacle.top) < Math.min(Math.max(a.y,b.y),obstacle.bottom)
  }
  if(a.y===b.y){
    if(a.y < obstacle.top || a.y > obstacle.bottom)return false
    return Math.max(Math.min(a.x,b.x),obstacle.left) < Math.min(Math.max(a.x,b.x),obstacle.right)
  }
  return true
}

function pathIntersects(points:readonly XY[],obstacles:readonly LayoutRect[]) {
  return obstacles.reduce((sum,obstacle)=>sum+points.slice(1).reduce((n,point,index)=>n+(segmentIntersects(points[index],point,obstacle)?1:0),0),0)
}

function pathCrosses(points:readonly XY[],others:readonly XY[][]):number {
  const horizontal = (a:XY,b:XY) => a.y===b.y
  const vertical = (a:XY,b:XY) => a.x===b.x
  let score=0
  for(const other of others)for(let i=1;i<points.length;i++)for(let j=1;j<other.length;j++){
    const a=points[i-1],b=points[i],c=other[j-1],d=other[j]
    if(horizontal(a,b)&&horizontal(c,d)&&a.y===c.y&&Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))<Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x)))score++
    else if(vertical(a,b)&&vertical(c,d)&&a.x===c.x&&Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y))<Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y)))score++
    // Ordinary perpendicular crossings are electrically separate. They do
    // not justify adding two bends to an otherwise clear straight wire.
  }
  return score
}

function directPoints(from:XY,to:XY,bend:'hv'|'vh'):XY[] {
  return simplify([from,bend==='hv'?{x:to.x,y:from.y}:{x:from.x,y:to.y},to])
}

function detourPoints(from:XY,to:XY,offset:number,axis:'x'|'y',side:'from'|'to'):XY[] {
  if(axis==='x'){
    const x = Math.round((side==='from' ? from.x+offset : to.x+offset)/GRID)*GRID
    return simplify([from,{x,y:from.y},{x,y:to.y},to])
  }
  const y = Math.round((side==='from' ? from.y+offset : to.y+offset)/GRID)*GRID
  return simplify([from,{x:from.x,y},{x:to.x,y},to])
}

function terminalDevice(terminal:Terminal):string|undefined { return 'device' in terminal ? terminal.device : undefined }

const outwardDirection=terminalLeadDirection

/** Earlier branches on this electrical net may share a straight bus. */
function otherNetPaths(drawing:Drawing,wire:Wire,paths:readonly XY[][]):readonly XY[][] {
  if(!paths.length)return paths
  const topology=wireNetTopology(drawing,wire),net=topology.net(wire.from)
  const pointKey=(point:XY)=>`${point.x},${point.y}`
  const ends=drawing.wires.filter(item=>item.id!==wire.id).map(item=>({a:pointKey(terminalPosition(drawing,item.from)),b:pointKey(terminalPosition(drawing,item.to)),net:topology.net(item.from)}))
  return paths.filter(path=>{
    if(!path.length)return true
    const a=pointKey(path[0]),b=pointKey(path.at(-1)!)
    const owners=ends.filter(item=>item.a===a&&item.b===b||item.a===b&&item.b===a)
    // Coincident terminals of different nets are not a shared bus. An
    // unowned path also stays an obstacle rather than inheriting a nearby net.
    return !owners.length||owners.some(owner=>owner.net!==net)
  })
}

function collisionBetween(a:Device,b:Device,paintedOnly=false):{overlapX:number;overlapY:number}|undefined {
  // The layout envelope reserves empty lead space too. Only a painted body
  // or caption collision should move an otherwise readable local cluster.
  const painted=(device:Device)=>[symbolBodyRect(device,4),...deviceCaptionRects(device,4)]
  if(paintedOnly&&!painted(a).some(left=>painted(b).some(right=>Math.min(left.right,right.right)-Math.max(left.left,right.left)>=GRID&&Math.min(left.bottom,right.bottom)-Math.max(left.top,right.top)>=GRID)))return undefined
  let best:{overlapX:number;overlapY:number}|undefined
  for (const left of deviceLayoutObstacles(a)) for (const right of deviceLayoutObstacles(b)) {
    if (!overlaps(left,right)) continue
    const overlapX=Math.min(left.right,right.right)-Math.max(left.left,right.left)
    const overlapY=Math.min(left.bottom,right.bottom)-Math.max(left.top,right.top)
    // Prefer the deepest collision. Captions are narrow, so a shallow text
    // halo does not cause a device to jump across a clean schematic.
    if (!best || Math.min(overlapX,overlapY)>Math.min(best.overlapX,best.overlapY)) best={overlapX,overlapY}
  }
  return best
}

/**
 * Pick a Manhattan route for a generated wire. Direct routes remain exactly
 * the compact one-corner path used by the editor; a detour is stored only when
 * a symbol blocks both direct choices or an earlier wire would be overlapped.
 */
export function routeGeneratedWire(drawing:Drawing, wire:Wire, previous?:readonly XY[][]):Wire {
  const from=terminalPosition(drawing,wire.from),to=terminalPosition(drawing,wire.to)
  const excluded=new Set([terminalDevice(wire.from),terminalDevice(wire.to)].filter((id):id is string=>!!id))
  const obstacles=drawing.devices.filter(device=>!excluded.has(device.id)).flatMap(device=>deviceLayoutObstacles(device,4))
  const bodies=drawing.devices.map(device=>symbolBodyRect(device,0)),otherPaths=otherNetPaths(drawing,wire,previous??drawing.wires.filter(item=>item.id!==wire.id).map(item=>wirePoints(drawing,item)))
  const first=outwardDirection(drawing,wire.from),last=outwardDirection(drawing,wire.to)
  const topology=wireNetTopology(drawing,wire),net=topology.net(wire.from),foreignTerminals=topology.foreignTerminals(wire)
  const reserved=drawing.wires.filter(item=>item.id!==wire.id&&topology.net(item.from)!==net).flatMap(item=>[item.from,item.to].flatMap(terminal=>{
    const direction=terminalLeadDirection(drawing,terminal)
    if(!direction||!direction.x&&!direction.y)return []
    const at=terminalPosition(drawing,terminal)
    return [[at,leadExitPoint(at,direction)] as const]
  }))
  const occupied=[...otherPaths.flatMap(path=>path.slice(1).map((point,index)=>[path[index],point] as const)),...reserved]
  const routedDrawing=drawing.wires.some(item=>item.id===wire.id)?drawing:{...drawing,wires:[...drawing.wires,wire]}
  const captions=[...drawing.devices.filter(device=>!excluded.has(device.id)).flatMap(device=>deviceCaptionRects(device,3)),...leadCaptionObstacles(routedDrawing,wire.id)]
  const hardObstacles=[...bodies,...captions]
  const candidates:XY[][]=[directPoints(from,to,'hv'),directPoints(from,to,'vh')]
  for(const offset of [-4*GRID,-3*GRID,-2*GRID,-GRID,GRID,2*GRID,3*GRID,4*GRID])for(const axis of ['x','y'] as const)for(const side of ['from','to'] as const)candidates.push(detourPoints(from,to,offset,axis,side))
  const start=leadExitPoint(from,first),end=leadExitPoint(to,last)
  for(const bend of ['hv','vh'] as const)candidates.push(simplify([from,...directPoints(start,end,bend),to]))
  for(const offset of [-4*GRID,-2*GRID,-GRID,GRID,2*GRID,4*GRID])for(const axis of ['x','y'] as const)for(const side of ['from','to'] as const)candidates.push(simplify([from,...detourPoints(start,end,offset,axis,side),to]))
  if(wire.waypoints?.length){const existing=wirePoints(drawing,wire);if(axisAligned(existing))candidates.push(existing)}
  const legal=(points:XY[])=>points.length>0&&points.length-2<=MAX_WIRE_WAYPOINTS&&axisAligned(points)&&!routeRetraces(points)
    &&points.every(p=>p.x>=DRAWING_BOUNDS.min&&p.x<=DRAWING_BOUNDS.max&&p.y>=DRAWING_BOUNDS.min&&p.y<=DRAWING_BOUNDS.max)
    &&points.slice(1,-1).every(p=>p.x%GRID===0&&p.y%GRID===0)
    &&(points.length===1||followsLead(from,points[1],first)&&followsLead(to,points.at(-2)!,last))
    &&!pathIntersects(points,hardObstacles)&&!pathCrosses(points,occupied.map(span=>[...span]))
    &&!points.slice(1).some((p,index)=>foreignTerminals.some(terminal=>pointOnSpan(terminal,points[index],p)))
  const ranked=candidates.filter(legal).map(points=>({points,obstacles:pathIntersects(points,obstacles),length:points.slice(1).reduce((n,p,i)=>n+segmentLength(points[i],p),0)})).sort((a,b)=>(a.length+(a.points.length-2)*GRID/2)-(b.length+(b.points.length-2)*GRID/2)||a.obstacles-b.obstacles||a.points.length-b.points.length)
  // A body, caption, foreign terminal or shared foreign span is never a
  // tradeoff against path length. Search more lanes before rejecting a draft.
  const winner=ranked[0]?.points??routeLeadPath(routedDrawing,from,to,first,last,wire.bend,wire.id,{occupied,obstacles:hardObstacles.map(rect=>grow(rect,1)),foreignTerminals})
  if(!winner||!legal(winner))throw new Error(`${wire.id} 无法在保持引脚连接的同时避开器件、文字与其他网络，请拉开器件或调整连接点。`)
  const bend=winner.length>1&&winner[0].y===winner[1].y?'hv':'vh'
  const waypoints=winner.length>2?winner.slice(1,-1):undefined
  const {waypoints:_old,...clean}=wire
  return {...clean,bend,...(waypoints?.length?{waypoints}:{})}
}

/**
 * Arrange an AI generated drawing without changing its electrical topology.
 * Device terminals are references, so moving a device automatically carries
 * its wires and labels. Existing, already readable drawings are returned by
 * identity to keep undo/history and proposal comparisons stable.
 */
export function autoLayoutDrawing(source:Drawing,options:{alignLeads?:boolean}={}):Drawing {
  if(source.devices.length<2 && !source.wires.length)return source
  const devices=source.devices.map(device=>({...device}))
  let changed=false
  const preserveLocalSpacing=!!options.alignLeads&&!devices.some((device,index)=>devices.slice(index+1).some(other=>collisionBetween(device,other,true)))
  if(options.alignLeads)for(const wire of source.wires){
    if(!('device'in wire.from)||!('device'in wire.to)||wire.from.device===wire.to.device)continue
    const drawing={...source,devices},from=terminalPosition(drawing,wire.from),to=terminalPosition(drawing,wire.to)
    const first=terminalLeadDirection(drawing,wire.from),last=terminalLeadDirection(drawing,wire.to)
    const delta=to.y-from.y,part=devices.find(device=>device.id===('device'in wire.from?wire.from.device:''))!
    // Keep the receiving block in place. A one-grid adjustment of a lightly
    // connected upstream symbol removes the little jog between facing pins.
    if(!first?.x||last?.x!==-first.x||(to.x-from.x)*first.x<4*GRID||!delta||Math.abs(delta)>GRID||delta%GRID!==0||part.id===source.sourceId)continue
    if(source.wires.filter(item=>[item.from,item.to].some(t=>'device'in t&&t.device===part.id)).length>3)continue
    let candidate={...part,y:clampCoordinate(part.y+delta)},clear=false
    // Long source captions may occupy the desired baseline. Open a small
    // horizontal gap while preserving the facing pins' common baseline.
    for(let step=0;step<=8;step++){
      candidate={...candidate,x:clampCoordinate(part.x+first.x*step*GRID)}
      if((to.x-(from.x+first.x*step*GRID))*first.x<4*GRID)break
      if(!devices.some(other=>other.id!==part.id&&(()=>{const hit=collisionBetween(candidate,other,true);return !!hit&&hit.overlapX>=GRID&&hit.overlapY>=GRID})())){clear=true;break}
    }
    if(!clear)continue
    const proposed={...drawing,devices:devices.map(device=>device.id===part.id?candidate:device)}
    if(wirePoints(proposed,routeGeneratedWire(proposed,wire)).length!==2)continue
    part.x=candidate.x;part.y=candidate.y;changed=true
  }
  for(let pass=0;pass<120;pass++){
    let moved=false
    for(let i=0;i<devices.length;i++)for(let j=i+1;j<devices.length;j++){
      const collision=collisionBetween(devices[i],devices[j],preserveLocalSpacing)
      if(!collision)continue
      const {overlapX,overlapY}=collision
      // A small stroke/caption halo touch is acceptable at a normal grid
      // spacing. Only a full grid cell of penetration is a real collision;
      // this keeps clean hand-authored layouts stable while still separating
      // visibly stacked generated symbols.
      if(overlapX < GRID || overlapY < GRID)continue
      const target=devices[j]
      if(overlapX<=overlapY){
        // Push the later item in a deterministic direction. Always moving
        // forward avoids the oscillation that occurs when a crowded stack is
        // alternately pushed left and right by neighboring symbols.
        target.x=clampCoordinate(target.x+(Math.ceil(overlapX/GRID)*GRID+GRID),80)
      }else{
        target.y=clampCoordinate(target.y+(Math.ceil(overlapY/GRID)*GRID+GRID),80)
      }
      moved=true;changed=true
    }
    if(!moved)break
  }
  let junctions=source.junctions
  if(options.alignLeads){
    // Plan the shared junction as a whole. In particular, an inline connector
    // between a vertical RC branch and a horizontal amplifier lead should sit
    // at their common corner, not one grid to the side with a return jog.
    for(const junction of [...junctions].sort((a,b)=>a.id.localeCompare(b.id))){
      const incident=source.wires.filter(wire=>[wire.from,wire.to].some(t=>'junction'in t&&t.junction===junction.id))
      if(incident.length<2)continue
      const current={...source,devices,junctions}
      const neighbors=incident.map(wire=>terminalPosition(current,'junction'in wire.from&&wire.from.junction===junction.id?wire.to:wire.from))
      const candidates=[...new Set(neighbors.map(p=>p.x))].flatMap(x=>[...new Set(neighbors.map(p=>p.y))].map(y=>({x,y})))
        .filter(p=>p.x%GRID===0&&p.y%GRID===0&&segmentLength(p,junction)<=2*GRID&&segmentLength(p,junction)>0)
      let best=current,bestScore=Infinity
      const score=(drawing:Drawing)=>{
        let length=0,bends=0
        for(const wire of incident){
          const path=wirePoints(drawing,routeGeneratedWire(drawing,wire))
          length+=path.slice(1).reduce((sum,p,i)=>sum+segmentLength(path[i],p),0);bends+=Math.max(0,path.length-2)
        }
        return length+bends*GRID/2
      }
      try{bestScore=score(current)}catch{/* A later route pass can still reject an invalid draft. */}
      for(const point of candidates){
        const proposed={...current,junctions:junctions.map(j=>j.id===junction.id?{...j,...point}:j)}
        try{const cost=score(proposed);if(cost<bestScore){best=proposed;bestScore=cost}}catch{/* This shared corner has no legal route. */}
      }
      if(best!==current){junctions=best.junctions;changed=true}
    }
  }
  // A proposal can contain well-separated symbols but a wire that runs
  // through a caption or another symbol. Repair only those paths so clean
  // hand-authored drawings retain their exact coordinates and history.
  const wirePaths=source.wires.map(wire=>wirePoints(source,wire))
  const needsWireRepair=source.wires.some((wire,index)=>{
    const excluded=new Set([terminalDevice(wire.from),terminalDevice(wire.to)].filter((id):id is string=>!!id))
    const obstacles=source.devices.filter(device=>!excluded.has(device.id)).flatMap(device=>deviceLayoutObstacles(device,4))
    const others=otherNetPaths(source,wire,wirePaths.filter((_,otherIndex)=>otherIndex!==index))
    const topology=wireNetTopology(source),foreign=topology.foreignTerminals(wire)
    const captions=[...source.devices.filter(device=>!excluded.has(device.id)).flatMap(device=>deviceCaptionRects(device,3)),...leadCaptionObstacles(source,wire.id)]
    const path=wirePaths[index]
    if(pathIntersects(path,obstacles)>0||pathIntersects(path,source.devices.map(device=>symbolBodyRect(device,0)))>0||pathIntersects(path,captions)>0||pathCrosses(path,others)>0)return true
    if(path.length>1&&(!followsLead(path[0],path[1],terminalLeadDirection(source,wire.from))||!followsLead(path.at(-1)!,path.at(-2)!,terminalLeadDirection(source,wire.to))))return true
    if(path.slice(1).some((p,i)=>foreign.some(terminal=>pointOnSpan(terminal,path[i],p))))return true
    // Generated proposals can retain an old detour after their endpoints
    // become aligned. Only replace it when an unobstructed straight span wins.
    if(path.length<=2||path[0].x!==path.at(-1)!.x&&path[0].y!==path.at(-1)!.y)return false
    return wirePoints(source,routeGeneratedWire(source,wire,others)).length===2
  })
  // Do not rewrite clean user drawings. This is also what makes the helper
  // safe for proposal fingerprints and existing undo history.
  if(!changed&&!needsWireRepair)return source
  const laidOut={...source,devices,junctions}
  const routes:XY[][]=[]
  const wires=laidOut.wires.map(wire=>{
    const next=routeGeneratedWire(laidOut,wire,routes)
    routes.push(wirePoints(laidOut,next));
    return next
  })
  if(wires.some((wire,index)=>JSON.stringify(wire)!==JSON.stringify(source.wires[index])))changed=true
  return changed?{...laidOut,wires}:source
}

export interface LabelPlacement { label:NetLabel; point:XY; x:number; y:number; width:number }
const labelWidth=(name:string) => Math.max(46,name.length*7+16)
const labelRect=(placement:{x:number;y:number;width:number}):LayoutRect => rect(placement.x,placement.y-22,placement.x+placement.width,placement.y)
const wireObstacleRects=(drawing:Drawing):LayoutRect[] => drawing.wires.flatMap(wire => {
  const points=wirePoints(drawing,wire)
  return points.slice(1).map((point,index) => {
    const previous=points[index], pad=3
    return previous.x===point.x
      ? rect(point.x-pad,Math.min(previous.y,point.y)-pad,point.x+pad,Math.max(previous.y,point.y)+pad)
      : rect(Math.min(previous.x,point.x)-pad,point.y-pad,Math.max(previous.x,point.x)+pad,point.y+pad)
  })
})

/** Place explicit net labels around their terminal while preserving a leader. */
export function placeNetLabels(drawing:Drawing):LabelPlacement[] {
  const labels=visibleNetLabels(drawing),used:LayoutRect[]=[]
  // Every label scores against the same drawing. Build its obstacles once,
  // and avoid routing any wires when only power/port glyphs are present.
  const hasText=labels.some(label=>(label.style??'text')==='text')
  const deviceObstacles=hasText?drawing.devices.flatMap(device=>deviceLayoutObstacles(device,2)):[]
  const wireObstacles=hasText?wireObstacleRects(drawing):[]
  return labels.map(label=>{
    const point=terminalPosition(drawing,label.at), width=labelWidth(label.name)
    if((label.style??'text')!=='text'){
      const bounds=netSymbolBounds(label.name,label.style,label.rotation)
      used.push(rect(point.x+bounds.left,point.y+bounds.top,point.x+bounds.right,point.y+bounds.bottom))
      return {label,point,x:bounds.left,y:bounds.bottom,width:bounds.right-bounds.left}
    }
    const candidates=[
      {x:8,y:-28}, {x:8,y:28}, {x:28,y:-54}, {x:28,y:54},
      {x:48,y:-80}, {x:48,y:80}, {x:72,y:-106}, {x:72,y:106},
      {x:-width-12,y:-28}, {x:-width-12,y:28},
      {x:-width-32,y:-54}, {x:-width-32,y:54}, {x:-width-52,y:-80}, {x:-width-52,y:80},
    ]
    // Include the owning symbol as well. A label leader may start at its pin,
    // but the caption itself should never paint across that symbol body.
    const absolute=(candidate:{x:number;y:number})=>labelRect({x:point.x+candidate.x,y:point.y+candidate.y,width})
    const winner=candidates.map(candidate=>({candidate,score:
      (deviceObstacles.some(obstacle=>overlaps(absolute(candidate),obstacle))?100000:0)+
      (used.some(obstacle=>overlaps(absolute(candidate),obstacle))?10000:0)+
      (wireObstacles.some(obstacle=>overlaps(absolute(candidate),obstacle))?5000:0)+
      Math.abs(candidate.x)+Math.abs(candidate.y),
    })).sort((a,b)=>a.score-b.score)[0].candidate
    const placement={label,point,x:winner.x,y:winner.y,width}
    used.push(absolute(winner))
    return placement
  })
}
