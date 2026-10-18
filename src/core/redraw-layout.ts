import { DRAWING_BOUNDS, GRID, MAX_WIRE_WAYPOINTS, parseDrawing, pinPosition, simplifyWirePoints, snap, terminalKey, terminalPosition, wirePoints, type Device, type Drawing, type Terminal, type Wire, type XY } from './drawing'
import { pinsFor } from './devices'
import { deviceCaptionRects, deviceLayoutObstacles, routeGeneratedWire, type LayoutRect } from './schematic-layout'
import { leadCaptionObstacles, segmentEntersBody, symbolBodyRect, terminalLeadDirection } from './wire-lead-route'
import { materializeLocalNetWires } from './local-net-wires'
import { arrangeSignalStructure } from './redraw-structure'

const byId = (a:{id:string},b:{id:string}) => a.id.localeCompare(b.id,undefined,{numeric:true})
const key = (point:XY) => `${point.x},${point.y}`
const mean = (values:number[]) => values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0
const overlap = (a:LayoutRect,b:LayoutRect) => a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top
const contains = (box:LayoutRect,p:XY) => p.x>=box.left&&p.x<=box.right&&p.y>=box.top&&p.y<=box.bottom
const bounds = (device:Device):LayoutRect => {
  const boxes=deviceLayoutObstacles(device)
  return {left:Math.min(...boxes.map(b=>b.left)),right:Math.max(...boxes.map(b=>b.right)),top:Math.min(...boxes.map(b=>b.top)),bottom:Math.max(...boxes.map(b=>b.bottom))}
}

/** Electrical connectivity and physical wire adjacency have different jobs:
 * equal labels/grounds belong to one net, but should not pull every ground
 * symbol or junction to the same position on the page. */
function connectivity(drawing:Drawing) {
  const parent=new Map<string,string>(), terminals=new Map<string,Terminal>(), adjacent=new Map<string,Terminal[]>()
  for(const device of drawing.devices)for(const pin of pinsFor(device))terminals.set(`${device.id}:${pin}`,{device:device.id,pin})
  for(const junction of drawing.junctions)terminals.set(junction.id,{junction:junction.id})
  for(const id of terminals.keys())parent.set(id,id)
  const root=(id:string):string=>{const p=parent.get(id)!;if(p===id)return id;const r=root(p);parent.set(id,r);return r}
  const union=(a:string,b:string)=>{const x=root(a),y=root(b);if(x!==y)parent.set(y,x)}
  for(const wire of drawing.wires){
    const a=terminalKey(wire.from),b=terminalKey(wire.to)
    union(a,b);adjacent.set(a,[...(adjacent.get(a)??[]),wire.to]);adjacent.set(b,[...(adjacent.get(b)??[]),wire.from])
  }
  const labels=new Map<string,string>()
  for(const label of drawing.labels??[]){const name=label.name.toLowerCase(),id=terminalKey(label.at),previous=labels.get(name);if(previous)union(previous,id);else labels.set(name,id)}
  const grounds=drawing.devices.filter(d=>d.kind==='GND')
  for(const ground of grounds.slice(1))union(`${grounds[0].id}:0`,`${ground.id}:0`)
  const net=new Map([...terminals.keys()].map(id=>[id,root(id)])),groundNets=new Set(grounds.map(d=>net.get(`${d.id}:0`)!))
  const members=new Map<string,Set<string>>()
  for(const [id,terminal]of terminals)if('device'in terminal){const n=net.get(id)!;if(!members.has(n))members.set(n,new Set());members.get(n)!.add(terminal.device)}
  const graph=new Map(drawing.devices.filter(d=>d.kind!=='GND').map(d=>[d.id,new Set<string>()]))
  for(const [name,devices]of members)if(!groundNets.has(name))for(const a of devices)for(const b of devices)if(a!==b&&graph.has(a)&&graph.has(b))graph.get(a)!.add(b)
  const neighbors=(start:Terminal):Terminal[]=>{
    const visited=new Set([terminalKey(start)]),queue=[start],result:Terminal[]=[]
    for(let i=0;i<queue.length;i++)for(const next of adjacent.get(terminalKey(queue[i]))??[]){
      const id=terminalKey(next);if(visited.has(id))continue;visited.add(id)
      if('junction'in next)queue.push(next)
      else if(!grounds.some(d=>d.id===next.device))result.push(next)
    }
    return result.sort((a,b)=>terminalKey(a).localeCompare(terminalKey(b),undefined,{numeric:true}))
  }
  return {net,groundNets,graph,neighbors,terminals}
}

function arrangeDevices(source:Drawing,links:ReturnType<typeof connectivity>):Device[] {
  const placed=new Map<string,Device>(),remaining=new Set(links.graph.keys()),original=new Map(source.devices.map(d=>[d.id,d]))
  const ordered=[...source.devices].filter(d=>d.kind!=='GND').sort((a,b)=>Number(b.id===source.sourceId)-Number(a.id===source.sourceId)||Number(['V','I'].includes(b.kind))-Number(['V','I'].includes(a.kind))||byId(a,b))
  // Reserve enough room for long model names and source expressions; all
  // column centers and baselines stay on the actual drawing grid.
  const boxes=source.devices.map(d=>bounds({...d,x:0,y:0}))
  const column=snap(Math.max(260,...boxes.map(b=>b.right-b.left+100)))
  const row=snap(Math.max(220,...boxes.map(b=>b.bottom-b.top+100)))
  let top=200
  for(const seed of ordered){
    if(!remaining.has(seed.id))continue
    const distance=new Map([[seed.id,0]]),queue=[seed.id];remaining.delete(seed.id)
    for(let i=0;i<queue.length;i++)for(const next of [...links.graph.get(queue[i])!].sort())if(remaining.delete(next)){distance.set(next,distance.get(queue[i])!+1);queue.push(next)}
    const structured=arrangeSignalStructure(source,links,queue,column,row,top)
    if(structured){
      for(const [id,device]of structured)placed.set(id,device)
      top=snap(Math.max(...[...structured.values()].map(device=>bounds(device).bottom))+row+80)
      continue
    }
    const layers:Array<string[]>=[]
    for(const id of queue){const depth=distance.get(id)!;(layers[depth]??=[]).push(id)}
    const order=new Map<string,number>()
    for(const layer of layers){
      layer.sort((a,b)=>mean([...links.graph.get(a)!].filter(id=>order.has(id)).map(id=>order.get(id)!))-mean([...links.graph.get(b)!].filter(id=>order.has(id)).map(id=>order.get(id)!))||byId(original.get(a)!,original.get(b)!))
      layer.forEach((id,index)=>order.set(id,index))
    }
    // Long chains wrap into orderly bands, staying comfortably inside the
    // finite editable world even for the maximum 80-device draft.
    let bandTop=top
    for(let first=0;first<layers.length;first+=8){
      const band=layers.slice(first,first+8),height=Math.max(...band.map(layer=>layer.length))
      band.forEach((layer,col)=>layer.forEach((id,index)=>placed.set(id,{...original.get(id)!,x:200+col*column,y:bandTop+index*row})))
      bandTop+=height*row+120
    }
    top=bandTop+80
  }
  const temporary={...source,devices:source.devices.map(d=>placed.get(d.id)??d)}
  for(const ground of [...source.devices].filter(d=>d.kind==='GND').sort(byId)){
    const anchor=links.neighbors({device:ground.id,pin:0})[0]
    const p=anchor?terminalPosition(temporary,anchor):{x:200,y:top}
    let candidate={...ground,x:snap(p.x),y:snap(p.y+140)}
    let attempts=0
    while([...placed.values()].some(d=>overlap(bounds(candidate),bounds(d)))){
      if(attempts++>=2048)throw new Error('重排空间不足，请先减少器件或拆分原理图')
      candidate={...candidate,y:candidate.y+GRID}
    }
    placed.set(ground.id,candidate)
    if(!anchor)top=candidate.y+row
  }
  return source.devices.map(device=>placed.get(device.id)!)
}

function arrangeJunctions(drawing:Drawing,links:ReturnType<typeof connectivity>) {
  const obstacles=drawing.devices.map(bounds),occupied=new Set(drawing.devices.flatMap(d=>pinsFor(d).map(pin=>key(pinPosition(d,pin)))))
  const result=new Map<string,XY>()
  for(const junction of [...drawing.junctions].sort(byId)){
    const endpoints=links.neighbors({junction:junction.id}).map(t=>terminalPosition(drawing,t))
    const desired={x:snap(mean(endpoints.map(p=>p.x))),y:snap(mean(endpoints.map(p=>p.y)))}
    let point=desired,found=false
    for(let radius=0;!found&&radius<=256;radius++){
      // Try nearby horizontal/vertical lanes first, then the rest of this
      // square ring. Stable ordering means redrawing is reproducible.
      const offsets:XY[]=[{x:radius,y:0},{x:-radius,y:0},{x:0,y:radius},{x:0,y:-radius}]
      for(let n=-radius;n<=radius;n++)offsets.push({x:n,y:radius},{x:n,y:-radius},{x:radius,y:n},{x:-radius,y:n})
      for(const offset of offsets){
        const candidate={x:desired.x+offset.x*GRID,y:desired.y+offset.y*GRID}
        if(occupied.has(key(candidate))||obstacles.some(box=>contains(box,candidate)))continue
        point=candidate;found=true;break
      }
    }
    if(!found)throw new Error(`无法为连接点 ${junction.id} 找到空闲的布线位置`)
    result.set(junction.id,point);occupied.add(key(point))
  }
  return drawing.junctions.map(j=>({...j,...result.get(j.id)!}))
}

interface Entry { state:number; score:number; cost:number }
class MinHeap {
  private items:Entry[]=[]
  push(value:Entry){let i=this.items.length;this.items.push(value);while(i>0){const p=(i-1)>>1;if(this.items[p].score<=value.score)break;this.items[i]=this.items[p];i=p}this.items[i]=value}
  pop(){const first=this.items[0],last=this.items.pop();if(this.items.length&&last){let i=0;while(i*2+1<this.items.length){let j=i*2+1;if(j+1<this.items.length&&this.items[j+1].score<this.items[j].score)j++;if(this.items[j].score>=last.score)break;this.items[i]=this.items[j];i=j}this.items[i]=last}return first}
  get size(){return this.items.length}
}

function routeAll(drawing:Drawing,links:ReturnType<typeof connectivity>):Wire[] {
  const boxes=drawing.devices.map(d=>symbolBodyRect(d,3)),captions=drawing.devices.flatMap(d=>deviceCaptionRects(d).map(box=>({owner:d.id,box})))
  const points=[...drawing.devices,...drawing.junctions]
  if(!points.length)return drawing.wires
  const minX=snap(Math.min(...points.map(p=>p.x),...boxes.map(b=>b.left))-160),minY=snap(Math.min(...points.map(p=>p.y),...boxes.map(b=>b.top))-160)
  const maxX=snap(Math.max(...points.map(p=>p.x),...captions.map(c=>c.box.right))+160),maxY=snap(Math.max(...points.map(p=>p.y),...boxes.map(b=>b.bottom))+160)
  const width=(maxX-minX)/GRID+1,height=(maxY-minY)/GRID+1
  const encode=(p:XY)=>((p.y-minY)/GRID)*width+(p.x-minX)/GRID
  const decode=(n:number):XY=>({x:minX+n%width*GRID,y:minY+Math.floor(n/width)*GRID})
  const mark=(set:Set<number>,box:LayoutRect)=>{for(let y=Math.ceil((box.top-minY)/GRID);y<=Math.floor((box.bottom-minY)/GRID);y++)for(let x=Math.ceil((box.left-minX)/GRID);x<=Math.floor((box.right-minX)/GRID);x++)if(x>=0&&x<width&&y>=0&&y<height)set.add(y*width+x)}
  const bodies=new Set<number>();boxes.forEach(box=>mark(bodies,box))
  const usedEdges=new Map<string,string|undefined>(),routes:XY[][]=[]
  const edgeKey=(a:number,b:number)=>a<b?`${a}:${b}`:`${b}:${a}`
  const result=new Map<string,Wire>()
  // Short branches are routed before longer feedback/return paths.
  const wires=[...drawing.wires].sort((a,b)=>{const length=(w:Wire)=>{const a=terminalPosition(drawing,w.from),b=terminalPosition(drawing,w.to);return Math.abs(a.x-b.x)+Math.abs(a.y-b.y)};return length(a)-length(b)||byId(a,b)})
  for(const wire of wires){
    const a=terminalPosition(drawing,wire.from),b=terminalPosition(drawing,wire.to),start=encode(a),goal=encode(b)
    // Original imported symbols may have anchors between grid lanes. The
    // generated router keeps those exact endpoints and stores grid corners;
    // the cell search is only valid when both endpoints are on its grid.
    const gridAligned=[a.x,a.y,b.x,b.y].every(value=>value%GRID===0)
    const owners=new Set([wire.from,wire.to].flatMap(t=>'device'in t?[t.device]:[])),blocked=new Set(bodies),net=links.net.get(terminalKey(wire.from))
    const wireCaptions=[...captions.filter(caption=>!owners.has(caption.owner)).map(caption=>caption.box),...leadCaptionObstacles(drawing,wire.id)]
    for(const caption of wireCaptions)mark(blocked,caption)
    for(const [id,terminal]of links.terminals)if(links.net.get(id)!==net)blocked.add(encode(terminalPosition(drawing,terminal)))
    blocked.delete(start);blocked.delete(goal)
    const first=terminalLeadDirection(drawing,wire.from),last=terminalLeadDirection(drawing,wire.to)
    const heap=new MinHeap(),costs=new Map<number,number>(),parent=new Map<number,number>()
    const initial=start*3+2;heap.push({state:initial,cost:0,score:Math.abs(a.x-b.x)+Math.abs(a.y-b.y)});costs.set(initial,0)
    let final:number|undefined,expanded=0
    const directions=[{x:1,y:0},{x:0,y:1},{x:-1,y:0},{x:0,y:-1}]
    while(gridAligned&&heap.size&&expanded++<60000){
      const entry=heap.pop()!;if(costs.get(entry.state)!==entry.cost)continue
      const cell=Math.floor(entry.state/3),axis=entry.state%3,p=decode(cell)
      if(cell===goal){final=entry.state;break}
      for(const direction of directions){
        if(cell===start&&first&&(direction.x!==first.x||direction.y!==first.y))continue
        const next={x:p.x+direction.x*GRID,y:p.y+direction.y*GRID}
        if(next.x<minX||next.x>maxX||next.y<minY||next.y>maxY)continue
        const n=encode(next),nextAxis=direction.x?0:1
        if(blocked.has(n)||n===goal&&last&&(direction.x!==-last.x||direction.y!==-last.y))continue
        // Thin text can sit between grid cells. Check the entire step rather
        // than allowing a conductor through its owning device's caption.
        if(wireCaptions.some(caption=>segmentEntersBody(p,next,caption)))continue
        const edge=edgeKey(cell,n)
        // Branches of one net may use the same bus. Reserve spans, rather
        // than crossing cells, so an unrelated perpendicular crossing does
        // not force a longer route or silently become a shared conductor.
        if(usedEdges.has(edge)&&usedEdges.get(edge)!==net)continue
        const state=n*3+nextAxis,cost=entry.cost+GRID+(axis!==2&&axis!==nextAxis?30:0)
        if(cost>=(costs.get(state)??Infinity))continue
        costs.set(state,cost);parent.set(state,entry.state);heap.push({state,cost,score:cost+Math.abs(next.x-b.x)+Math.abs(next.y-b.y)})
      }
    }
    let path:XY[]=[]
    if(final!==undefined){for(let state:number|undefined=final;state!==undefined;state=parent.get(state))path.push(decode(Math.floor(state/3)));path=simplifyWirePoints(path.reverse())}
    const {waypoints:_old,...clean}=wire
    const next=path.length>=2&&path.length-2<=MAX_WIRE_WAYPOINTS?{...clean,bend:(path[0].y===path[1].y?'hv':'vh') as Wire['bend'],...(path.length>2?{waypoints:path.slice(1,-1)}:{})}:routeGeneratedWire(drawing,clean,routes)
    const routed=wirePoints(drawing,next);routes.push(routed);result.set(wire.id,next)
    for(let i=1;i<routed.length;i++){
      const from=routed[i-1],to=routed[i],steps=Math.ceil((Math.abs(to.x-from.x)+Math.abs(to.y-from.y))/GRID)
      // A finite segment walk also stays safe if a future symbol acquires a
      // lead offset that is not an exact grid multiple.
      for(let step=0;step<steps;step++){
        const a=encode({x:snap(from.x+(to.x-from.x)*step/steps),y:snap(from.y+(to.y-from.y)*step/steps)})
        const b=encode({x:snap(from.x+(to.x-from.x)*(step+1)/steps),y:snap(from.y+(to.y-from.y)*(step+1)/steps)})
        usedEdges.set(edgeKey(a,b),net)
      }
    }
  }
  return drawing.wires.map(wire=>result.get(wire.id)!)
}

/** Explicit, deterministic redraw. Connectivity determines placement; no
 * topology is inferred from crossings and no device/property is invented.
 * Call only when the user requested a new arrangement, not on ordinary edits. */
export function redrawDrawingLayout(source:Drawing):Drawing {
  // This helper is also called directly by the UI. Reject a malformed draft
  // before following references or entering the bounded routing search.
  parseDrawing(source)
  if(!source.devices.length&&!source.junctions.length)return source
  const links=connectivity(source),devices=arrangeDevices(source,links)
  let drawing={...source,devices}
  drawing={...drawing,junctions:arrangeJunctions(drawing,links)}
  // Recenter very large drawings without ever rescaling electrical symbols.
  const points=[...drawing.devices,...drawing.junctions],xs=points.map(p=>p.x),ys=points.map(p=>p.y)
  const translation=(values:number[])=>Math.max(...values)>DRAWING_BOUNDS.max-600?snap((Math.max(...values)+Math.min(...values))/2):0
  const dx=translation(xs),dy=translation(ys)
  if(dx||dy)drawing={...drawing,devices:drawing.devices.map(d=>({...d,x:d.x-dx,y:d.y-dy})),junctions:drawing.junctions.map(j=>({...j,x:j.x-dx,y:j.y-dy}))}
  return materializeLocalNetWires({...drawing,wires:routeAll(drawing,links)})
}
