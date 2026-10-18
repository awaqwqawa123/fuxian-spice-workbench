import { compileDrawing, DRAWING_BOUNDS, GRID, MAX_WIRE_WAYPOINTS, nextId, simplifyWirePoints, terminalKey, terminalPosition, wirePoints, type Drawing, type Terminal, type Wire, type XY } from './drawing'
import { pinsFor } from './devices'
import { deviceCaptionRects } from './device-caption-geometry'
import { followsLead, segmentEntersBody, symbolBodyRect, terminalLeadDirection } from './wire-lead-route'

const distance = (a:XY,b:XY) => Math.abs(a.x-b.x)+Math.abs(a.y-b.y)
const onSegment = (p:XY,a:XY,b:XY) => a.x===b.x ? p.x===a.x && p.y>=Math.min(a.y,b.y) && p.y<=Math.max(a.y,b.y) : p.y===a.y && p.x>=Math.min(a.x,b.x) && p.x<=Math.max(a.x,b.x)
const segmentsOverlap = (a:XY,b:XY,c:XY,d:XY) => {
  if(a.x===b.x&&c.x===d.x)return a.x===c.x&&Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y))<=Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y))
  if(a.y===b.y&&c.y===d.y)return a.y===c.y&&Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))<=Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))
  // Unmarked perpendicular crossings are separate nets in the editor.
  return false
}

/** Nearby name-only links may become conductors; distant links keep their names.
 * Existing labels are retained as electrical records and for saved references. */
export function materializeLocalNetWires(source:Drawing):Drawing {
  const labels=source.labels??[]
  if(labels.length<2||source.wires.length>=200)return source
  const nodes=compileDrawing(source).nodes,parent=new Map<string,string>()
  const root=(key:string):string=>{const p=parent.get(key);if(!p){parent.set(key,key);return key}if(p===key)return key;const r=root(p);parent.set(key,r);return r}
  const union=(a:Terminal,b:Terminal)=>parent.set(root(terminalKey(a)),root(terminalKey(b)))
  for(const wire of source.wires)union(wire.from,wire.to)
  // A label can sit at the far end of an existing conductor. Its whole
  // physical component, rather than just its annotation anchor, is available
  // for a local connection. Only explicit wires establish these components;
  // neither geometric crossings nor device bodies imply connectivity.
  const ports=new Map<string,Terminal>()
  for(const wire of source.wires)for(const at of [wire.from,wire.to])ports.set(terminalKey(at),at)
  for(const label of labels)ports.set(terminalKey(label.at),label.at)
  const componentPorts=new Map<string,Terminal[]>()
  for(const [key,at] of ports){const component=root(key);componentPorts.set(component,[...(componentPorts.get(component)??[]),at])}
  const groups=new Map<string,Set<string>>()
  for(const label of labels){const name=label.name.toLowerCase(),components=groups.get(name)??new Set<string>();components.add(root(terminalKey(label.at)));groups.set(name,components)}
  const positions=new Map([...ports].map(([key,at])=>[key,terminalPosition(source,at)]))
  const candidates=new Map<string,{from:Terminal;to:Terminal;length:number}>()
  for(const components of groups.values()){
    const entries=[...components]
    for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
      for(const from of componentPorts.get(entries[i])!)for(const to of componentPorts.get(entries[j])!){
        const a=terminalKey(from),b=terminalKey(to),length=distance(positions.get(a)!,positions.get(b)!)
        if(length>0&&length<=480)candidates.set([a,b].sort().join('|'),{from,to,length})
      }
    }
  }
  const pairs=[...candidates.values()].sort((a,b)=>a.length-b.length||terminalKey(a.from).localeCompare(terminalKey(b.from))||terminalKey(a.to).localeCompare(terminalKey(b.to)))
  let drawing=source
  for(const {from,to,length} of pairs){
    if(drawing.wires.length>=200)break
    if(root(terminalKey(from))===root(terminalKey(to)))continue
    const path=localPath(drawing,from,to,nodes)
    if(!path||path.length-2>MAX_WIRE_WAYPOINTS||path.slice(1,-1).some(p=>p.x%GRID!==0||p.y%GRID!==0)||path.slice(1).reduce((sum,p,index)=>sum+distance(path[index],p),0)>length+200)continue
    const wire:Wire={id:nextId('W',[...drawing.devices,...drawing.junctions,...drawing.wires,...labels]),from,to,bend:path[0].y===path[1].y?'hv':'vh',...(path.length>2?{waypoints:path.slice(1,-1)}:{})}
    drawing={...drawing,wires:[...drawing.wires,wire]}
    union(from,to)
  }
  return drawing
}

/** Search a bounded visibility grid so the shortest safe route wins. Contacts
 * with other nets are forbidden, including a route ending on another pin. */
function localPath(drawing:Drawing,from:Terminal,to:Terminal,nodes:Map<string,string>):XY[]|null {
  const a=terminalPosition(drawing,from),b=terminalPosition(drawing,to),net=nodes.get(terminalKey(from))
  const fromDirection=terminalLeadDirection(drawing,from),toDirection=terminalLeadDirection(drawing,to)
  const exit=(at:XY,direction:XY|undefined):XY=>!direction?at:direction.x?{x:(direction.x>0?Math.ceil((at.x+GRID)/GRID):Math.floor((at.x-GRID)/GRID))*GRID,y:at.y}:{x:at.x,y:(direction.y>0?Math.ceil((at.y+GRID)/GRID):Math.floor((at.y-GRID)/GRID))*GRID}
  const start=exit(a,fromDirection),end=exit(b,toDirection)
  const window={left:Math.max(DRAWING_BOUNDS.min,Math.min(a.x,b.x)-100),right:Math.min(DRAWING_BOUNDS.max,Math.max(a.x,b.x)+100),top:Math.max(DRAWING_BOUNDS.min,Math.min(a.y,b.y)-100),bottom:Math.min(DRAWING_BOUNDS.max,Math.max(a.y,b.y)+100)}
  if(start.x<window.left||start.x>window.right||start.y<window.top||start.y>window.bottom||end.x<window.left||end.x>window.right||end.y<window.top||end.y>window.bottom)return null
  const near=(rect:{left:number;right:number;top:number;bottom:number})=>rect.right>=window.left&&rect.left<=window.right&&rect.bottom>=window.top&&rect.top<=window.bottom
  const leads=[[a,start],[b,end]]
  const bodies=drawing.devices.map(device=>symbolBodyRect(device,3)).filter(near)
  const captions=drawing.devices.flatMap(device=>deviceCaptionRects(device,3)).filter(near).filter(rect=>!leads.some(([first,last])=>segmentEntersBody(first,last,rect)))
  const obstacles=[...bodies,...captions]
  const foreignTerminals=drawing.devices.flatMap(device=>pinsFor(device).map((pin):Terminal=>({device:device.id,pin}))).concat(drawing.junctions.map(junction=>({junction:junction.id}) as Terminal)).filter(terminal=>nodes.get(terminalKey(terminal))!==net)
  const foreignPins=foreignTerminals.map(terminal=>terminalPosition(drawing,terminal)).filter(p=>p.x>=window.left&&p.x<=window.right&&p.y>=window.top&&p.y<=window.bottom)
  // Keep each foreign pin's first exit lane open for its later local branch.
  // A shorter bias connection must not strand a nearby summing capacitor.
  const foreignLeads=foreignTerminals.flatMap(terminal=>{
    const point=terminalPosition(drawing,terminal),direction=terminalLeadDirection(drawing,terminal)
    return direction?[[point,exit(point,direction)] as const]:[]
  })
  const foreignSpans=drawing.wires.filter(wire=>nodes.get(terminalKey(wire.from))!==net).flatMap(wire=>{const path=wirePoints(drawing,wire);return path.slice(1).map((p,index)=>[path[index],p] as const)}).filter(([first,last])=>near({left:Math.min(first.x,last.x),right:Math.max(first.x,last.x),top:Math.min(first.y,last.y),bottom:Math.max(first.y,last.y)}))
  const blocked=(first:XY,last:XY)=>obstacles.some(rect=>segmentEntersBody(first,last,rect))||foreignPins.some(pin=>onSegment(pin,first,last))||[...foreignSpans,...foreignLeads].some(([c,d])=>segmentsOverlap(first,last,c,d))
  if(blocked(a,start)||blocked(b,end))return null
  const xs=[start.x,end.x,window.left,window.right],ys=[start.y,end.y,window.top,window.bottom]
  for(const rect of obstacles){xs.push(Math.floor(rect.left/GRID)*GRID,Math.ceil(rect.right/GRID)*GRID);ys.push(Math.floor(rect.top/GRID)*GRID,Math.ceil(rect.bottom/GRID)*GRID)}
  for(const p of [...foreignPins,...foreignSpans.flatMap(span=>[...span])]){xs.push(p.x-GRID,p.x+GRID);ys.push(p.y-GRID,p.y+GRID)}
  const xx=[...new Set(xs.filter(x=>x>=window.left&&x<=window.right))].sort((x,y)=>x-y),yy=[...new Set(ys.filter(y=>y>=window.top&&y<=window.bottom))].sort((x,y)=>x-y),width=xx.length
  if(width*yy.length>20000)return null
  const node=(p:XY)=>(yy.indexOf(p.y)*width+xx.indexOf(p.x))*2,point=(id:number):XY=>({x:xx[Math.floor(id/2)%width],y:yy[Math.floor(id/2/width)]})
  const startId=node(start),endId=node(end),cost=new Map<number,number>(),parents=new Map<number,number>(),queue:{id:number;score:number}[]=[]
  const push=(item:{id:number;score:number})=>{let index=queue.length;queue.push(item);while(index){const parent=(index-1)>>1;if(queue[parent].score<=item.score)break;queue[index]=queue[parent];index=parent}queue[index]=item}
  const pop=()=>{const first=queue[0],last=queue.pop()!;if(queue.length){let index=0;while(index*2+1<queue.length){let child=index*2+1;if(child+1<queue.length&&queue[child+1].score<queue[child].score)child++;if(queue[child].score>=last.score)break;queue[index]=queue[child];index=child}queue[index]=last}return first}
  for(const axis of fromDirection?[fromDirection.x?0:1]:[0,1]){cost.set(startId+axis,0);push({id:startId+axis,score:distance(start,end)})}
  const visited=new Set<number>()
  while(queue.length){
    const current=pop().id
    if(visited.has(current))continue
    visited.add(current)
    if(Math.floor(current/2)===Math.floor(endId/2)){
      const path:XY[]=[];let at:number|undefined=current
      while(at!==undefined){path.push(point(at));at=parents.get(at)}
      const full=simplifyWirePoints([a,...path.reverse(),b])
      if(full.length>=2&&followsLead(a,full[1],fromDirection)&&followsLead(b,full.at(-2)!,toDirection))return full
    }
    const p=point(current),cell=Math.floor(current/2),x=cell%width,y=Math.floor(cell/width)
    for(const [nx,ny,axis] of [[x-1,y,0],[x+1,y,0],[x,y-1,1],[x,y+1,1]]){
      if(nx<0||nx>=width||ny<0||ny>=yy.length)continue
      const next=(ny*width+nx)*2+axis,q=point(next)
      if(blocked(p,q))continue
      if(cell===Math.floor(startId/2)&&fromDirection&&(q.x-p.x)*fromDirection.x+(q.y-p.y)*fromDirection.y<0)continue
      if(Math.floor(next/2)===Math.floor(endId/2)&&toDirection&&(q.x-p.x)*toDirection.x+(q.y-p.y)*toDirection.y>0)continue
      const score=cost.get(current)!+distance(p,q)+(current%2===axis?0:.01)
      if(score>=(cost.get(next)??Infinity))continue
      cost.set(next,score);parents.set(next,current);push({id:next,score:score+distance(q,end)})
    }
  }
  return null
}
