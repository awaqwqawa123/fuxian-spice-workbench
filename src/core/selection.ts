import { deviceCatalog, pinsFor } from './devices'
import {clampCanvasZoom,MAX_CANVAS_ZOOM} from './canvas-zoom'
import { followLeadJunctions, followWireEndpoints } from './wire-follow'
import { slideStraightJunctions } from './wire-slide'
import { netSymbolBounds } from './net-symbol-geometry'
import { CANVAS, DRAWING_BOUNDS, MAX_WIRE_WAYPOINTS, nextId, pinPosition, removeItem, simplifyWirePoints, snap, terminalKey, terminalPosition, wirePoints, type Drawing, type Rotation, type Terminal, type XY } from './drawing'

export interface Bounds { left:number; top:number; right:number; bottom:number }
const boundsOf=(points:XY[]):Bounds=>({left:Math.min(...points.map(p=>p.x)),top:Math.min(...points.map(p=>p.y)),right:Math.max(...points.map(p=>p.x)),bottom:Math.max(...points.map(p=>p.y))})
const corners=(b:Bounds):XY[]=>[{x:b.left,y:b.top},{x:b.right,y:b.bottom}]
export const rectangle=(a:XY,b:XY):Bounds=>boundsOf([a,b])
export const allItems=(d:Drawing)=>[...d.devices,...d.junctions,...d.wires,...(d.labels??[])].map(item=>item.id)
export function itemBounds(d:Drawing,id:string):Bounds|null {
  const device=d.devices.find(p=>p.id===id)
  if(device){const pins=pinsFor(device).map(pin=>pinPosition(device,pin));return boundsOf([...pins,{x:device.x-40,y:device.y-40},{x:device.x+40,y:device.y+40}])}
  const junction=d.junctions.find(p=>p.id===id)
  if(junction)return rectangle(junction,junction)
  const wire=d.wires.find(p=>p.id===id)
  if(wire)return boundsOf(wirePoints(d,wire))
  const label=d.labels?.find(p=>p.id===id)
  if(label){const p=terminalPosition(d,label.at);if((label.style??'text')!=='text'){const bounds=netSymbolBounds(label.name,label.style,label.rotation);return{left:p.x+bounds.left,top:p.y+bounds.top,right:p.x+bounds.right,bottom:p.y+bounds.bottom}}return{left:p.x,top:p.y-42,right:p.x+label.name.length*9+26,bottom:p.y}}
  return null
}
export function selectionBounds(d:Drawing,ids=allItems(d)):Bounds|null {
  const points=ids.flatMap(id=>{const b=itemBounds(d,id);return b?corners(b):[]})
  return points.length?boundsOf(points):null
}
export function selectRectangle(d:Drawing,area:Bounds,intersect=false):string[] {
  const contains=(p:XY)=>p.x>=area.left&&p.x<=area.right&&p.y>=area.top&&p.y<=area.bottom
  const overlaps=(b:Bounds)=>b.left<=area.right&&b.right>=area.left&&b.top<=area.bottom&&b.bottom>=area.top
  return allItems(d).filter(id=>{
    const wire=d.wires.find(w=>w.id===id)
    if(wire){const points=wirePoints(d,wire);return intersect?points.some((p,i)=>i>0&&overlaps(rectangle(points[i-1],p))):points.every(contains)}
    const b=itemBounds(d,id)!
    return intersect?overlaps(b):corners(b).every(contains)
  })
}
function movingIds(d:Drawing,ids:string[]) {
  const set=new Set(ids)
  // A standalone power/port symbol owns its junction anchor; attached component
  // pins stay with their component. Connected wires follow the moved junction.
  for(const label of d.labels??[])if(set.has(label.id)&&(label.style??'text')!=='text'&&'junction'in label.at)set.add(label.at.junction)
  // A selected wire may move its junction endpoints, never an unselected component.
  for(const w of d.wires)if(set.has(w.id))for(const t of [w.from,w.to])if('junction'in t)set.add(t.junction)
  return set
}
export function moveSelection(d:Drawing,ids:string[],delta:XY):Drawing {
  if(!snap(delta.x)&&!snap(delta.y))return d
  const selected=movingIds(d,ids)
  const moved=(t:Terminal)=>selected.has('device'in t?t.device:t.junction)
  // Explicit routes travel with their selected wire or when both endpoints move.
  // Selecting a wire alone also moves its body while keeping component pins fixed.
  const routes=new Map(d.wires.filter(w=>selected.has(w.id)||w.waypoints?.length&&moved(w.from)&&moved(w.to)).map(w=>[w.id,wirePoints(d,w)]))
  const positions=[...d.devices.filter(p=>selected.has(p.id)).map(p=>({...p,margin:80})),...d.junctions.filter(p=>selected.has(p.id)).map(p=>({...p,margin:0})),...[...routes.values()].flatMap(points=>points.map(p=>({...p,margin:0})))]
  if(!positions.length)return d
  // Clamp one shared displacement so a group never collapses against a sheet edge.
  const dx=Math.max(...positions.map(p=>DRAWING_BOUNDS.min+p.margin-p.x),Math.min(snap(delta.x),...positions.map(p=>DRAWING_BOUNDS.max-p.margin-p.x)))
  const dy=Math.max(...positions.map(p=>DRAWING_BOUNDS.min+p.margin-p.y),Math.min(snap(delta.y),...positions.map(p=>DRAWING_BOUNDS.max-p.margin-p.y)))
  if(!dx&&!dy)return d
  const next=slideStraightJunctions(d,followLeadJunctions(d,{...d,devices:d.devices.map(p=>selected.has(p.id)?{...p,x:p.x+dx,y:p.y+dy}:p),junctions:d.junctions.map(p=>selected.has(p.id)?{...p,x:p.x+dx,y:p.y+dy}:p)},selected),selected)
  // Include indirectly carried lead junctions. Unchanged endpoint owners need
  // no route repair or coordinate lookup during every pointer frame.
  const changed=new Set([...next.devices.filter((p,i)=>p!==d.devices[i]),...next.junctions.filter((p,i)=>p!==d.junctions[i])].map(p=>p.id))
  const follows=(t:Terminal)=>changed.has('device'in t?t.device:t.junction)
  return {...next,wires:d.wires.map(w=>{
    const route=routes.get(w.id)
    if(!route)return !follows(w.from)&&!follows(w.to)||moved(w.from)&&moved(w.to)?w:followWireEndpoints(d,next,w,selected)
    if(moved(w.from)&&moved(w.to)&&!w.waypoints?.length)return w
    const waypoints=simplifyWirePoints(route.slice(moved(w.from)?1:0,moved(w.to)?-1:undefined).map(p=>({x:p.x+dx,y:p.y+dy})))
    if(waypoints.length>MAX_WIRE_WAYPOINTS)throw new Error('导线拐点过多，请先恢复自动走线再移动。')
    return {...w,waypoints}
  })}
}
export function transformSelection(d:Drawing,ids:string[],operation:'rotate'|'mirror'):Drawing {
  const selected=movingIds(d,ids), points=[...d.devices,...d.junctions].filter(p=>selected.has(p.id))
  const labels=d.labels?.map(label=>{
    if((label.style??'text')==='text'||!selected.has(label.id)&&!selected.has('device'in label.at?label.at.device:label.at.junction))return label
    const rotation=label.rotation??0
    return {...label,rotation:(operation==='rotate'?(rotation+90)%360:((label.style==='power'?360:540)-rotation)%360) as Rotation}
  })
  if(!points.length)return labels?.some((label,index)=>label!==d.labels?.[index])?{...d,labels}:d
  const box=boundsOf(points),anchor=ids.map(id=>points.find(p=>p.id===id)).find(Boolean)??points[0]
  // Rotating around an existing grid point avoids cumulative half-grid rounding drift.
  const cx=operation==='rotate'?anchor.x:(box.left+box.right)/2,cy=operation==='rotate'?anchor.y:(box.top+box.bottom)/2
  const transform=(p:XY)=>operation==='rotate'?{x:cx-(p.y-cy),y:cy+(p.x-cx)}:{x:2*cx-p.x,y:p.y}
  const moved=(t:Terminal)=>selected.has('device'in t?t.device:t.junction)
  const next=followLeadJunctions(d,{...d,
    ...(labels?{labels}:{}),
    devices:d.devices.map(p=>!selected.has(p.id)?p:{...p,...transform(p),rotation:(operation==='rotate'?(p.rotation+90)%360:(360-p.rotation)%360) as Rotation,...(operation==='mirror'?{mirrored:!p.mirrored}:{})}),
    junctions:d.junctions.map(p=>selected.has(p.id)?{...p,...transform(p)}:p),
  },selected)
  next.wires=[...d.wires]
  d.wires.forEach((w,index)=>{next.wires[index]=moved(w.from)&&moved(w.to)?{...w,...(operation==='rotate'?{bend:w.bend==='hv'?'vh' as const:'hv' as const}:{}),...(w.waypoints?{waypoints:w.waypoints.map(transform)}:{})}:followWireEndpoints(d,next,w,selected)})
  if([...next.devices,...next.junctions,...next.wires.flatMap(w=>w.waypoints??[])].some(p=>p.x<DRAWING_BOUNDS.min||p.x>DRAWING_BOUNDS.max||p.y<DRAWING_BOUNDS.min||p.y>DRAWING_BOUNDS.max))throw new Error('旋转或镜像后会超出画布，请先把选区移向画布中央。')
  return next
}
export function removeSelection(d:Drawing,ids:string[]):Drawing { return ids.reduce(removeItem,d) }

export function copySelection(d:Drawing,ids:string[],sourceDc?:string):Drawing|null {
  const selected=movingIds(d,ids)
  // Copy junction paths joining selected device bodies, pruning outside leads.
  const junctionIds=new Set(d.junctions.map(j=>j.id)),visited=new Set<string>()
  for(const junction of d.junctions){
    if(visited.has(junction.id))continue
    const component=new Set([junction.id]),queue=[junction.id],owners=new Set<string>()
    for(let i=0;i<queue.length;i++){
      visited.add(queue[i])
      for(const wire of d.wires)for(const [at,other] of [[wire.from,wire.to],[wire.to,wire.from]] as [Terminal,Terminal][]){
        if(!('junction'in at)||at.junction!==queue[i])continue
        if('device'in other){if(selected.has(other.device))owners.add(other.device)}
        else if(junctionIds.has(other.junction)&&!component.has(other.junction)){component.add(other.junction);queue.push(other.junction)}
      }
    }
    if(owners.size<2)continue
    let changed=true
    while(changed){
      changed=false
      for(const id of component){
        if(selected.has(id))continue
        const degree=d.wires.filter(w=>[w.from,w.to].some(t=>'junction'in t&&t.junction===id)&&[w.from,w.to].every(t=>'device'in t?selected.has(t.device):component.has(t.junction))).length
        if(degree<=1){component.delete(id);changed=true}
      }
    }
    for(const id of component)selected.add(id)
  }
  const owns=(t:Terminal)=>selected.has('device'in t?t.device:t.junction)
  const devices=d.devices.filter(p=>selected.has(p.id)).map(p=>({...structuredClone(p),...(p.id===d.sourceId&&sourceDc!==undefined&&!p.params?.waveform?{value:sourceDc}:{})}))
  const junctions=d.junctions.filter(p=>selected.has(p.id)).map(j=>({...j}))
  const boundary=new Map<string,Terminal>()
  const endpoint=(t:Terminal):Terminal=>{
    if(owns(t))return {...t}
    const key=terminalKey(t),existing=boundary.get(key)
    if(existing)return existing
    const id=nextId('J',[...d.junctions,...junctions]),p=terminalPosition(d,t),mapped={junction:id}
    junctions.push({id,...p});boundary.set(key,mapped);return mapped
  }
  // A wire between two pins of one selected device is external wiring, not
  // part of its symbol. Copy it only when the wire itself is selected.
  const wires=d.wires.filter(w=>selected.has(w.id)||owns(w.from)&&owns(w.to)&&!('device'in w.from&&'device'in w.to&&w.from.device===w.to.device)).map(w=>({...w,from:endpoint(w.from),to:endpoint(w.to),...(w.waypoints?{waypoints:w.waypoints.map(p=>({...p}))}:{})}))
  const labels=(d.labels??[]).filter(l=>owns(l.at)||selected.has(l.id)).map(l=>({...l,at:endpoint(l.at)}))
  if(!devices.length&&!wires.length&&!junctions.length)return null
  return {devices,junctions,wires,labels,sourceId:devices.some(p=>p.id===d.sourceId)?d.sourceId:'',output:d.output&&owns(d.output)?{...d.output}:null}
}
export function positionClipboard(fragment:Drawing,at:XY):Drawing {
  const points=[...fragment.devices,...fragment.junctions,...fragment.wires.flatMap(w=>w.waypoints??[])],box=boundsOf(points)
  return moveSelection(fragment,allItems(fragment),{x:at.x-snap((box.left+box.right)/2),y:at.y-snap((box.top+box.bottom)/2)})
}
export function pasteSelection(d:Drawing,fragment:Drawing,at:XY):{drawing:Drawing;ids:string[];idMap:Map<string,string>} {
  const fields=new Map<string,string>()
  for(const [field,items] of [['devices',fragment.devices],['junctions',fragment.junctions],['wires',fragment.wires],['labels',fragment.labels??[]]] as const)items.forEach((item,index)=>{
    const path=`${field}[${index}].id`,previous=fields.get(item.id)
    if(previous)throw new Error(`粘贴编号 ${item.id} 冲突：${previous} 与 ${path}；不能猜测重复编号的连接关系`)
    fields.set(item.id,path)
  })
  const check=(terminal:Terminal,path:string)=>{
    const exists='device'in terminal?fragment.devices.some(device=>device.id===terminal.device&&pinsFor(device).includes(terminal.pin)):fragment.junctions.some(junction=>junction.id===terminal.junction)
    if(!exists)throw new Error(`粘贴引用 ${path} ${terminalKey(terminal)} 没有选区内的真实端点映射`)
  }
  fragment.wires.forEach((wire,index)=>{check(wire.from,`wires[${index}].from`);check(wire.to,`wires[${index}].to`)})
  fragment.labels?.forEach((label,index)=>check(label.at,`labels[${index}].at`))
  if(fragment.output)check(fragment.output,'output')
  const placed=positionClipboard(structuredClone(fragment),at)
  if(d.devices.length+placed.devices.length>80||d.wires.length+placed.wires.length>200||d.junctions.length+placed.junctions.length>100||(d.labels?.length??0)+(placed.labels?.length??0)>100)throw new Error('粘贴后会超过器件、导线或标签数量限制。')
  const map=new Map<string,string>(),devices=[...d.devices],junctions=[...d.junctions],wires=[...d.wires],labels=[...(d.labels??[])],ids:string[]=[]
  for(const p of placed.devices){const id=nextId(deviceCatalog[p.kind].prefix,devices);map.set(p.id,id);devices.push({...p,id});ids.push(id)}
  for(const p of placed.junctions){const id=nextId('J',junctions);map.set(p.id,id);junctions.push({...p,id});ids.push(id)}
  const endpoint=(t:Terminal):Terminal=>{
    const old='device'in t?t.device:t.junction,id=map.get(old)
    if(!id)throw new Error(`粘贴端点 ${terminalKey(t)} 没有选区内的编号映射`)
    return 'device'in t?{device:id,pin:t.pin}:{junction:id}
  }
  for(const w of placed.wires){const id=nextId('W',wires);map.set(w.id,id);wires.push({...w,id,from:endpoint(w.from),to:endpoint(w.to)});ids.push(id)}
  const names=new Map<string,string>(),usedNames=new Set(labels.map(l=>l.name.toLowerCase()))
  for(const l of placed.labels??[]){
    const key=l.name.toLowerCase()
    if(!names.has(key)){
      let name=l.name,n=1
      while(usedNames.has(name.toLowerCase())){const suffix=`_copy${n===1?'':n}`;name=l.name.slice(0,32-suffix.length)+suffix;n++}
      names.set(key,name);usedNames.add(name.toLowerCase())
    }
    const id=nextId('N',labels);map.set(l.id,id);labels.push({...l,id,name:names.get(key)!,at:endpoint(l.at)});ids.push(id)
  }
  return {drawing:{...d,devices,junctions,wires,labels,sourceId:d.sourceId||map.get(placed.sourceId)||'',output:d.output||(placed.output?endpoint(placed.output):null)},ids,idMap:map}
}

export function fitView(d:Drawing,ids?:string[],viewport=CANVAS,maxZoom=ids?.length?MAX_CANVAS_ZOOM:1.5) {
  const b=selectionBounds(d,ids)
  if(!b)return {center:{x:600,y:320},zoom:1}
  // Padding is in screen pixels, so fitting remains legible on a narrow canvas.
  return {center:{x:(b.left+b.right)/2,y:(b.top+b.bottom)/2},zoom:clampCanvasZoom(Math.min(maxZoom,Math.max(80,viewport.width-128)/(b.right-b.left+60),Math.max(80,viewport.height-112)/(b.bottom-b.top+60)))}
}
