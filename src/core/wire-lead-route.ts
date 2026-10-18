import { DRAWING_BOUNDS, GRID, pinPosition, rawWirePoints, simplifyWirePoints, terminalKey, terminalPosition } from './drawing-geometry'
import type { Device, Drawing, Terminal, Wire, XY } from './drawing'
import { deviceCaptionRects } from './device-caption-geometry'
import { localPin } from './devices'
import { pointOnSpan, spansOverlap } from './wire-net-topology'

function localXLead(part:Device,pin:number):XY {
  const point=localPin('X',pin,part)
  if(!part.pinPositions)return {x:Math.sign(point.x),y:0}
  const anchors=part.pinPositions
  // Repeated outer side anchors belong to a box edge even when a tall
  // pin row is farther from the origin vertically. Centered supply and
  // two-terminal shunt anchors instead keep their vertical lead axis.
  const side=point.x!==0&&Math.abs(point.x)>=Math.max(...anchors.map(p=>Math.abs(p.x)))&&anchors.filter(p=>p.x===point.x).length>1
  return side||Math.abs(point.x)>=Math.abs(point.y)?{x:Math.sign(point.x),y:0}:{x:0,y:Math.sign(point.y)}
}

/** The lead's axis is defined by the symbol, not by its radial distance from the origin. */
export function terminalLeadDirection(drawing:Drawing,terminal:Terminal):XY|undefined {
  if(!('device' in terminal))return undefined
  const part=drawing.devices.find(device=>device.id===terminal.device)
  if(!part)return undefined
  if(part.kind==='GND'){
    const angle=part.rotation*Math.PI/180
    return {x:Math.round(Math.sin(angle))||0,y:-Math.round(Math.cos(angle))||0}
  }
  if(part.kind==='X'){
    const local=localXLead(part,terminal.pin),angle=part.rotation*Math.PI/180,x=local.x*(part.mirrored?-1:1)
    return {x:Math.round(x*Math.cos(angle)-local.y*Math.sin(angle))||0,y:Math.round(x*Math.sin(angle)+local.y*Math.cos(angle))||0}
  }
  const vertical=((part.kind==='Q'||part.kind==='M'||part.kind==='J')&&terminal.pin!==1)||((part.kind==='OPA'||part.kind==='CMP')&&terminal.pin>=3)||(part.kind==='VSW'&&terminal.pin>=2)||(part.kind==='LDO'&&terminal.pin===1)
  const point=pinPosition(part,terminal.pin),axisVertical=vertical!==(part.rotation===90||part.rotation===270)
  return axisVertical?{x:0,y:Math.sign(point.y-part.y)}:{x:Math.sign(point.x-part.x),y:0}
}

export interface SymbolBodyRect {left:number;top:number;right:number;bottom:number}
/** Conservative bounds of the painted body, excluding the legal external pin leads. */
export function symbolBodyRect(part:Device,padding=2):SymbolBodyRect {
  let local:SymbolBodyRect
  switch(part.kind){
    case 'R':local={left:-24,top:-10,right:24,bottom:10};break
    case 'C':local={left:-7,top:-22,right:7,bottom:22};break
    case 'L':local={left:-28,top:-24,right:28,bottom:0};break
    case 'D':local={left:-18,top:-22,right:25,bottom:22};break
    case 'Q':case 'J':local={left:-29,top:-29,right:29,bottom:29};break
    case 'M':local={left:-18,top:-24,right:20,bottom:24};break
    case 'OPA':case 'CMP':local={left:-26,top:-42,right:40,bottom:42};break
    case 'OP':local={left:-26,top:-36,right:30,bottom:36};break
    case 'SW':local={left:-19,top:-20,right:19,bottom:3};break
    case 'VSW':local={left:-29,top:-34,right:29,bottom:22};break
    case 'RELAY':local={left:-48,top:-49,right:46,bottom:49};break
    case 'LDO':local={left:-38,top:-30,right:38,bottom:30};break
    case 'XFMR':local={left:-24,top:-40,right:24,bottom:40};break
    case 'GND':local={left:-18,top:14,right:18,bottom:28};break
    case 'X':{
      const anchors=(part.pins??[]).map((_,pin)=>localPin('X',pin,part))
      const inner=anchors.map((point,pin)=>{const direction=localXLead(part,pin);return{x:point.x-direction.x*GRID,y:point.y-direction.y*GRID}})
      // Persisted drawings have electrical anchors but not the original
      // graphics. Reserve the envelope inside their external lead segments;
      // this covers tall boxes and functional opamps without blocking pins.
      local={left:Math.min(-25,...inner.map(p=>p.x)),right:Math.max(25,...inner.map(p=>p.x)),top:Math.min(-25,...inner.map(p=>p.y)),bottom:Math.max(25,...inner.map(p=>p.y))}
      break
    }
    default:local={left:-25,top:-25,right:25,bottom:25}
  }
  const angle=part.rotation*Math.PI/180,cos=Math.round(Math.cos(angle)),sin=Math.round(Math.sin(angle))
  const points=[{x:local.left,y:local.top},{x:local.left,y:local.bottom},{x:local.right,y:local.top},{x:local.right,y:local.bottom}].map(point=>{
    const x=point.x*(part.mirrored?-1:1)
    return {x:part.x+x*cos-point.y*sin,y:part.y+x*sin+point.y*cos}
  })
  return {left:Math.min(...points.map(p=>p.x))-padding,right:Math.max(...points.map(p=>p.x))+padding,top:Math.min(...points.map(p=>p.y))-padding,bottom:Math.max(...points.map(p=>p.y))+padding}
}

export function segmentEntersBody(a:XY,b:XY,rect:SymbolBodyRect):boolean {
  if(a.x===b.x)return a.x>rect.left&&a.x<rect.right&&Math.max(Math.min(a.y,b.y),rect.top)<Math.min(Math.max(a.y,b.y),rect.bottom)
  if(a.y===b.y)return a.y>rect.top&&a.y<rect.bottom&&Math.max(Math.min(a.x,b.x),rect.left)<Math.min(Math.max(a.x,b.x),rect.right)
  return true
}
export function followsLead(at:XY,next:XY,direction:XY|undefined):boolean {
  return !direction||!direction.x&&!direction.y||(next.x-at.x)*direction.x+(next.y-at.y)*direction.y>0&&((direction.x!==0&&next.y===at.y)||(direction.y!==0&&next.x===at.x))
}
const distance=(a:XY,b:XY)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y)
/** Imported pin anchors can lie between grid lanes; stored corners cannot. */
export function leadExitPoint(at:XY,direction?:XY):XY {
  if(!direction)return at
  const lane=(value:number,sign:number)=>sign>0?Math.ceil((value+GRID)/GRID)*GRID:Math.floor((value-GRID)/GRID)*GRID
  return {x:direction.x?lane(at.x,direction.x):at.x,y:direction.y?lane(at.y,direction.y):at.y}
}
const inward=(at:XY,next:XY,direction:XY|undefined)=>!!direction&&(next.x-at.x)*direction.x+(next.y-at.y)*direction.y<0
/** Prefer the single corner that leaves and reaches the actual pin axes. */
export function pinAlignedWireBend(drawing:Drawing,from:Terminal,to:Terminal,preferred:'hv'|'vh'):'hv'|'vh' {
  const a=terminalPosition(drawing,from),b=terminalPosition(drawing,to)
  const fromDirection=terminalLeadDirection(drawing,from),toDirection=terminalLeadDirection(drawing,to)
  for(const bend of [preferred,preferred==='hv'?'vh':'hv'] as const){
    const corner=bend==='hv'?{x:b.x,y:a.y}:{x:a.x,y:b.y},path=simplifyWirePoints([a,corner,b])
    if(path.length<2||followsLead(a,path[1],fromDirection)&&followsLead(b,path.at(-2)!,toDirection))return bend
  }
  return preferred
}
export const routeRetraces=(path:XY[])=>path.slice(1).some((point,index)=>path.slice(index+2).some((other,offset)=>spansOverlap(path[index],point,path[index+1+offset],other)))
function occupiedWireSpans(drawing:Drawing,wireId?:string){
  const owned=drawing.wires.find(wire=>wire.id===wireId),ownEnds=new Set(owned?[terminalKey(owned.from),terminalKey(owned.to)]:[])
  const reserved=wireId?drawing.wires.filter(wire=>wire.id!==wireId).flatMap(wire=>[wire.from,wire.to].flatMap(terminal=>{
    const direction=terminalLeadDirection(drawing,terminal)
    if(!direction||ownEnds.has(terminalKey(terminal)))return []
    const point=terminalPosition(drawing,terminal)
    return [[point,{x:point.x+direction.x*GRID,y:point.y+direction.y*GRID}] as const]
  })):[]
  return [...reserved,...(wireId?drawing.wires.filter(wire=>wire.id!==wireId).flatMap(wire=>{
    const path=rawWirePoints(drawing,wire)
    // Another lead awaiting rotation repair is not a fixed route obstacle yet.
    if(path.length<2||inward(path[0],path[1],terminalLeadDirection(drawing,wire.from))||inward(path.at(-1)!,path.at(-2)!,terminalLeadDirection(drawing,wire.to)))return []
    return path.slice(1).map((point,index)=>[path[index],point] as const)
  }):[])]
}
export function routeOverlapsWires(drawing:Drawing,path:XY[],wireId:string):boolean {
  const occupied=occupiedWireSpans(drawing,wireId)
  return path.slice(1).some((point,index)=>occupied.some(([a,b])=>spansOverlap(path[index],point,a,b)))
}

/** Captions stay horizontal when the symbol turns. Reuse the same rectangles
 * as generated-layout checks, without imposing new obstacles on remote wiring. */
export function leadCaptionObstacles(drawing:Drawing,wireId?:string):SymbolBodyRect[] {
  const wire=drawing.wires.find(w=>w.id===wireId)
  if(!wire)return []
  const terminals=[wire.from,wire.to],ids=new Set(terminals.flatMap(t=>'device'in t?[t.device]:[]))
  const leads=terminals.flatMap(t=>{
    const direction=terminalLeadDirection(drawing,t)
    if(!direction)return []
    const at=terminalPosition(drawing,t)
    return [[at,{x:at.x+direction.x*GRID,y:at.y+direction.y*GRID}] as const]
  })
  // Some legacy multi-pin captions already cover a physical pin. Routing cannot
  // move that pin: only forbid captions outside the required pin exit segment.
  return drawing.devices.filter(d=>ids.has(d.id)).flatMap(d=>deviceCaptionRects(d,4)).filter(rect=>!leads.some(([a,b])=>segmentEntersBody(a,b,rect)))
}

/** A bounded local detour: fixed anchors never move, and illegal fallback paths are rejected. */
export function routeLeadPath(drawing:Drawing,from:XY,to:XY,fromDirection?:XY,toDirection?:XY,preferred:'hv'|'vh'='hv',wireId?:string,context?:{occupied:readonly (readonly [XY,XY])[];obstacles:readonly SymbolBodyRect[];foreignTerminals:readonly XY[]}):XY[]|null {
  const start=leadExitPoint(from,fromDirection),end=leadExitPoint(to,toDirection)
  const bodies=context?.obstacles??[...drawing.devices.map(device=>symbolBodyRect(device)),...leadCaptionObstacles(drawing,wireId)],occupied=context?.occupied??occupiedWireSpans(drawing,wireId)
  const blockedTerminal=(a:XY,b:XY)=>context?.foreignTerminals.some(point=>pointOnSpan(point,a,b))??false
  const near=bodies.filter(body=>body.right>=Math.min(start.x,end.x)-GRID*2&&body.left<=Math.max(start.x,end.x)+GRID*2&&body.bottom>=Math.min(start.y,end.y)-GRID*2&&body.top<=Math.max(start.y,end.y)+GRID*2)
  const xs=[...new Set([start.x,end.x,...near.flatMap(body=>[Math.floor(body.left/GRID)*GRID,Math.ceil(body.right/GRID)*GRID])])]
  const ys=[...new Set([start.y,end.y,...near.flatMap(body=>[Math.floor(body.top/GRID)*GRID,Math.ceil(body.bottom/GRID)*GRID])])]
  // Extra lanes permit a U-shaped detour when both pins lie on the same line.
  xs.push(Math.min(start.x,end.x)-GRID,Math.max(start.x,end.x)+GRID)
  ys.push(Math.min(start.y,end.y)-GRID,Math.max(start.y,end.y)+GRID)
  for(const [a,b]of occupied)for(const p of [a,b])if(p.x>=Math.min(start.x,end.x)-GRID*4&&p.x<=Math.max(start.x,end.x)+GRID*4&&p.y>=Math.min(start.y,end.y)-GRID*4&&p.y<=Math.max(start.y,end.y)+GRID*4){xs.push(p.x-GRID,p.x+GRID);ys.push(p.y-GRID,p.y+GRID)}
  const candidates:XY[][]=[
    [start,{x:end.x,y:start.y},end],[start,{x:start.x,y:end.y},end],
    ...xs.map(x=>[start,{x,y:start.y},{x,y:end.y},end]),
    ...ys.map(y=>[start,{x:start.x,y},{x:end.x,y},end]),
  ]
  // Keep this a local repair, with a bounded number of alternate corner lanes.
  const localX=[...new Set(xs)].sort((a,b)=>Math.min(Math.abs(a-start.x),Math.abs(a-end.x))-Math.min(Math.abs(b-start.x),Math.abs(b-end.x))).slice(0,12)
  const localY=[...new Set(ys)].sort((a,b)=>Math.min(Math.abs(a-start.y),Math.abs(a-end.y))-Math.min(Math.abs(b-start.y),Math.abs(b-end.y))).slice(0,12)
  for(const x of localX)for(const y of localY)candidates.push([start,{x,y:start.y},{x,y},{x:end.x,y},end],[start,{x:start.x,y},{x,y},{x,y:end.y},end])
  let best:XY[]|null=null,bestScore=Infinity
  for(const connector of candidates){
    const path=simplifyWirePoints([from,...connector,to])
    if(path.slice(1,-1).some(p=>p.x%GRID!==0||p.y%GRID!==0))continue
    if(path.length<2||!followsLead(from,path[1],fromDirection)||!followsLead(to,path.at(-2)!,toDirection))continue
    if(routeRetraces(path))continue
    if(path.some(p=>p.x<DRAWING_BOUNDS.min||p.x>DRAWING_BOUNDS.max||p.y<DRAWING_BOUNDS.min||p.y>DRAWING_BOUNDS.max))continue
    if(path.slice(1).some((point,index)=>bodies.some(body=>segmentEntersBody(path[index],point,body))))continue
    if(path.slice(1).some((point,index)=>blockedTerminal(path[index],point)))continue
    if(path.slice(1).some((point,index)=>occupied.some(([a,b])=>spansOverlap(path[index],point,a,b))))continue
    const turn=path.length>2&&fromDirection?fromDirection.x*(path[2].y-path[1].y)-fromDirection.y*(path[2].x-path[1].x):0
    const score=path.slice(1).reduce((length,point,index)=>length+distance(path[index],point),0)+(path.length-2)*GRID/4+((path[0].y===path[1].y)===(preferred==='hv')?0:1)+(turn<0?.25:0)
    if(score<bestScore){best=path;bestScore=score}
  }
  if(best)return best
  if([start.x,start.y,end.x,end.y].some(value=>value%GRID!==0))return null
  // Dense groups need more than four corners. Search the local orthogonal
  // visibility grid while retaining the same collision and lead constraints.
  const xx=[...new Set(xs)].sort((a,b)=>a-b),yy=[...new Set(ys)].sort((a,b)=>a-b),width=xx.length
  if(width*yy.length>40000)return null
  const point=(id:number):XY=>({x:xx[Math.floor(id/2)%width],y:yy[Math.floor(Math.floor(id/2)/width)]})
  const node=(p:XY)=>(yy.indexOf(p.y)*width+xx.indexOf(p.x))*2,startNode=node(start),endNode=node(end)
  const cost=new Map<number,number>(),parent=new Map<number,number>(),queue:{id:number;score:number}[]=[]
  const push=(item:{id:number;score:number})=>{let i=queue.length;queue.push(item);while(i){const p=(i-1)>>1;if(queue[p].score<=item.score)break;queue[i]=queue[p];i=p}queue[i]=item}
  const pop=()=>{const first=queue[0],last=queue.pop()!;if(queue.length){let i=0;while(i*2+1<queue.length){let c=i*2+1;if(c+1<queue.length&&queue[c+1].score<queue[c].score)c++;if(queue[c].score>=last.score)break;queue[i]=queue[c];i=c}queue[i]=last}return first}
  const blocked=(a:XY,b:XY)=>b.x<DRAWING_BOUNDS.min||b.x>DRAWING_BOUNDS.max||b.y<DRAWING_BOUNDS.min||b.y>DRAWING_BOUNDS.max||bodies.some(body=>segmentEntersBody(a,b,body))||blockedTerminal(a,b)||occupied.some(([c,d])=>spansOverlap(a,b,c,d))
  if(blocked(from,start)||blocked(end,to))return null
  for(const axis of fromDirection?[fromDirection.x?0:1]:[0,1]){cost.set(startNode+axis,0);push({id:startNode+axis,score:distance(start,end)})}
  const visited=new Set<number>()
  while(queue.length){
    const current=pop().id
    if(visited.has(current))continue
    visited.add(current)
    const a=point(current),index=Math.floor(current/2),x=index%width,y=Math.floor(index/width)
    if(Math.floor(current/2)===Math.floor(endNode/2)){
      const path:XY[]=[];let at:number|undefined=current
      while(at!==undefined){path.push(point(at));at=parent.get(at)}
      const full=simplifyWirePoints([from,...path.reverse(),to])
      if(full.length>=2&&followsLead(from,full[1],fromDirection)&&followsLead(to,full.at(-2)!,toDirection)&&!routeRetraces(full))return full
    }
    for(const [nx,ny,axis]of [[x-1,y,0],[x+1,y,0],[x,y-1,1],[x,y+1,1]]){
      if(nx<0||nx>=width||ny<0||ny>=yy.length)continue
      const next=(ny*width+nx)*2+axis,b=point(next)
      if(blocked(a,b))continue
      if(index===Math.floor(startNode/2)&&fromDirection&&(b.x-a.x)*fromDirection.x+(b.y-a.y)*fromDirection.y<0)continue
      if(Math.floor(next/2)===Math.floor(endNode/2)&&toDirection&&(b.x-a.x)*toDirection.x+(b.y-a.y)*toDirection.y>0)continue
      const score=cost.get(current)!+distance(a,b)+(current%2!==axis?GRID/4:0)
      if(score>=(cost.get(next)??Infinity))continue
      cost.set(next,score);parent.set(next,current);push({id:next,score:score+distance(b,end)})
    }
  }
  return null
}

/** Automatic routes follow pin axes, including old saved sideways approaches.
 * Repair their visible path without changing electrical or saved identities. */
export function repairAutomaticWireRoute(drawing:Drawing,wire:Wire,path:XY[]):XY[] {
  if(path.length<2)return path
  const from=terminalLeadDirection(drawing,wire.from),to=terminalLeadDirection(drawing,wire.to)
  if(followsLead(path[0],path[1],from)&&followsLead(path.at(-1)!,path.at(-2)!,to))return path
  const bend=pinAlignedWireBend(drawing,wire.from,wire.to,wire.bend)
  const a=path[0],b=path.at(-1)!,corner=bend==='hv'?{x:b.x,y:a.y}:{x:a.x,y:b.y}
  const alternate=simplifyWirePoints([a,corner,b])
  if(alternate.length>=2&&followsLead(a,alternate[1],from)&&followsLead(b,alternate.at(-2)!,to)
    &&!alternate.slice(1).some((point,index)=>drawing.devices.some(device=>segmentEntersBody(alternate[index],point,symbolBodyRect(device))))
    &&!alternate.slice(1).some((point,index)=>leadCaptionObstacles(drawing,wire.id).some(rect=>segmentEntersBody(alternate[index],point,rect)))
    &&!routeOverlapsWires(drawing,alternate,wire.id))return alternate
  const repaired=routeLeadPath(drawing,terminalPosition(drawing,wire.from),terminalPosition(drawing,wire.to),from,to,wire.bend,wire.id)
  if(repaired)return repaired
  // A bypass can share the mandatory exit stub with the normal wires at both
  // pins. Do not let those shared stubs force its fallback through the symbol.
  if('device'in wire.from&&'device'in wire.to&&wire.from.device===wire.to.device){
    const ends=[{at:terminalPosition(drawing,wire.from),direction:from},{at:terminalPosition(drawing,wire.to),direction:to}]
    const occupied=occupiedWireSpans(drawing,wire.id).flatMap(([a,b])=>{
      let first=a,last=b
      for(const {at,direction} of ends){
        const exit=leadExitPoint(at,direction)
        if(first.x===at.x&&first.y===at.y&&pointOnSpan(exit,first,last))first=exit
        if(last.x===at.x&&last.y===at.y&&pointOnSpan(exit,first,last))last=exit
      }
      return first.x===last.x&&first.y===last.y?[]:[[first,last] as const]
    })
    return routeLeadPath(drawing,ends[0].at,ends[1].at,from,to,wire.bend,wire.id,{occupied,obstacles:[...drawing.devices.map(device=>symbolBodyRect(device)),...leadCaptionObstacles(drawing,wire.id)],foreignTerminals:[]})??path
  }
  return path
}
