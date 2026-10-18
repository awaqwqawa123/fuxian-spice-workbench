import { pinPosition, snap, terminalKey, type Device, type Drawing, type XY } from './drawing'
import { deviceLayoutObstacles } from './schematic-layout'
import { terminalLeadDirection } from './wire-lead-route'

interface Links { net:Map<string,string>; groundNets:Set<string> }
interface Step { device:Device; from:string; to:string; input:number; output:number }
const passive = (device:Device) => ['R','C','L'].includes(device.kind)
const amplifier = (device:Device) => device.kind==='OPA'||device.kind==='OP'
const byId = (a:Device,b:Device) => a.id.localeCompare(b.id,undefined,{numeric:true})
const originPin = (device:Device,pin:number) => pinPosition({...device,x:0,y:0},pin)

/** Recognize only an explicit source/output path and its proven local branches.
 * Unsupported residual edges (bridges, control loops, unknown multiport parts)
 * reject the specialization as a whole and retain the deterministic fallback.
 * Pin identities, model data and symbol transforms are never rewritten. */
export function arrangeSignalStructure(source:Drawing,links:Links,ids:readonly string[],column:number,row:number,top:number):Map<string,Device>|undefined {
  const devices=source.devices.filter(device=>ids.includes(device.id)).sort(byId)
  const seed=devices.find(device=>device.id===source.sourceId)
  if(!seed||!['V','I'].includes(seed.kind)||!source.output)return
  const net=(device:Device,pin:number)=>links.net.get(`${device.id}:${pin}`)!
  const grounded=(name:string)=>links.groundNets.has(name)
  const seedPins=[0,1].filter(pin=>!grounded(net(seed,pin)))
  const target=links.net.get(terminalKey(source.output))
  if(seedPins.length!==1||!target||grounded(target))return
  const start=net(seed,seedPins[0]),amps=devices.filter(amplifier)
  if(amps.length>1)return
  const feedback=new Map<string,{amp:Device;input:number}>()
  for(const amp of amps)for(const device of devices.filter(passive)){
    const ends=[net(device,0),net(device,1)],out=net(amp,2)
    for(const input of [0,1])if(!grounded(net(amp,input))&&net(amp,input)!==out&&ends.includes(out)&&ends.includes(net(amp,input)))feedback.set(device.id,{amp,input})
  }
  const edges=new Map<string,Step[]>()
  const add=(step:Step)=>edges.set(step.from,[...(edges.get(step.from)??[]),step])
  for(const device of devices){
    if(passive(device)&&!feedback.has(device.id)){
      const a=net(device,0),b=net(device,1)
      if(a===b||grounded(a)||grounded(b))continue
      add({device,from:a,to:b,input:0,output:1});add({device,from:b,to:a,input:1,output:0})
    }else if(amplifier(device))for(const input of [0,1]){
      const from=net(device,input),to=net(device,2)
      if(!grounded(from)&&!grounded(to)&&from!==to)add({device,from,to,input,output:2})
    }
  }
  const previous=new Map<string,Step>(),seen=new Set([start]),queue=[start]
  for(let index=0;index<queue.length&&!seen.has(target);index++)for(const edge of edges.get(queue[index])??[]){
    if(seen.has(edge.to))continue
    seen.add(edge.to);previous.set(edge.to,edge);queue.push(edge.to)
  }
  if(!seen.has(target))return
  const path:Step[]=[]
  for(let current=target;current!==start;){const edge=previous.get(current)!;path.unshift(edge);current=edge.from}
  // Wrapping a recognized path would hide the functional ordering; long drafts
  // keep the existing bounded-band placement instead.
  if(!path.length||path.length>7)return
  const pathIds=new Set([seed.id,...path.map(step=>step.device.id)])
  if(pathIds.size!==path.length+1||amps.some(amp=>!pathIds.has(amp.id)))return
  const pathNets=new Set([start,...path.map(step=>step.to)])
  for(const amp of amps)for(const pin of [0,1])if(!grounded(net(amp,pin)))pathNets.add(net(amp,pin))
  const shunts:Array<{device:Device;input:number;at:string}>=[],supplies:Array<{device:Device;input:number;amp:Device;pin:number}>=[]
  for(const device of devices){
    if(pathIds.has(device.id)||feedback.has(device.id))continue
    if(!passive(device)&&!['V','I'].includes(device.kind))return
    const ends=[net(device,0),net(device,1)],input=ends.findIndex(name=>!grounded(name))
    if(input<0||!grounded(ends[1-input]))return
    const at=ends[input]
    if(passive(device)&&pathNets.has(at)){shunts.push({device,input,at});continue}
    const supply=amps.flatMap(amp=>amp.kind==='OPA'?[3,4].filter(pin=>net(amp,pin)===at).map(pin=>({amp,pin})):[])
    if(supply.length===1){supplies.push({device,input,...supply[0]});continue}
    return
  }
  // Use the actual entry/exit pin vector. A vertical or reversed chain remains
  // vertical/reversed. Mixed directions retain the general fallback.
  const vectors=path.map(step=>{const a=originPin(step.device,step.input),b=originPin(step.device,step.output);return {x:b.x-a.x,y:b.y-a.y}})
  const primary=vectors[0],horizontal=Math.abs(primary.x)>=Math.abs(primary.y),sign=Math.sign(horizontal?primary.x:primary.y)
  if(!sign||vectors.some(v=>(horizontal?Math.abs(v.x)<Math.abs(v.y):Math.abs(v.y)<Math.abs(v.x))||Math.sign(horizontal?v.x:v.y)!==sign))return
  const along=horizontal?{x:sign,y:0}:{x:0,y:sign},cross=horizontal?{x:0,y:1}:{x:1,y:0}
  const spacing=horizontal?column:row,lane=horizontal?row:column
  const placed=new Map<string,Device>(),anchors=new Map<string,XY>()
  const at=(distance:number,offset:number):XY=>({x:snap(200+along.x*distance+cross.x*offset),y:snap(top+along.y*distance+cross.y*offset)})
  const move=(device:Device,point:XY)=>({...device,x:snap(point.x),y:snap(point.y)})
  const put=(device:Device,point:XY,direction=1,step=lane)=>{
    let candidate=move(device,point)
    for(let attempt=0;attempt<128;attempt++){
      const collision=[...placed.values()].some(other=>deviceLayoutObstacles(candidate).some(a=>deviceLayoutObstacles(other).some(b=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)))
      if(!collision){placed.set(device.id,candidate);return candidate}
      candidate=move(candidate,{x:candidate.x+cross.x*step*direction,y:candidate.y+cross.y*step*direction})
    }
    return undefined
  }
  const baseline=supplies.length?lane:0,signalStart=at(0,baseline),lead=terminalLeadDirection(source,{device:seed.id,pin:seedPins[0]}),seedOffset=originPin(seed,seedPins[0])
  // A source whose lead is perpendicular to the chain belongs beside the
  // signal lane. Leave its outward lead a clear approach to that lane.
  const perpendicular=lead&&(horizontal?lead.x===0:lead.y===0)
  const seedAnchor=perpendicular?{x:signalStart.x-lead!.x*lane/2,y:signalStart.y-lead!.y*lane/2}:signalStart
  const sourceDevice=put(seed,{x:seedAnchor.x-seedOffset.x,y:seedAnchor.y-seedOffset.y})
  if(!sourceDevice)return
  anchors.set(start,signalStart)
  let offset=baseline
  for(const [index,step]of path.entries()){
    const entry=originPin(step.device,step.input),point=at((index+1)*spacing,offset)
    // Align the actual entry pin with its predecessor's signal lane, rather
    // than aligning symbol centers and adding a compulsory dogleg.
    const candidate=put(step.device,{x:point.x-(horizontal?0:entry.x),y:point.y-(horizontal?entry.y:0)})
    if(!candidate)return
    const end=pinPosition(candidate,step.output);anchors.set(step.to,end)
    offset=horizontal?end.y-top:end.x-200
    if(amplifier(step.device))for(const pin of [0,1])anchors.set(net(step.device,pin),pinPosition(candidate,pin))
  }
  for(const {device,input,at:name}of shunts){
    const anchor=anchors.get(name)!,relative=originPin(device,input),distance=amps.some(amp=>[0,1].some(pin=>net(amp,pin)===name))?-spacing/3:spacing/2
    const point={x:anchor.x+along.x*distance+cross.x*lane/2,y:anchor.y+along.y*distance+cross.y*lane/2}
    if(!put(device,{x:point.x-relative.x,y:point.y-relative.y}))return
  }
  for(const [id,{amp,input}]of feedback){
    const device=devices.find(d=>d.id===id)!,actual=placed.get(amp.id)!,inputPin=pinPosition(actual,input),outputPin=pinPosition(actual,2)
    const side=Math.sign(horizontal?inputPin.y-outputPin.y:inputPin.x-outputPin.x)||-1
    if(!put(device,{x:snap((inputPin.x+outputPin.x)/2+cross.x*lane/2*side),y:snap((inputPin.y+outputPin.y)/2+cross.y*lane/2*side)},side,lane/2))return
  }
  for(const [index,{device}]of supplies.entries())if(!put(device,at(index*spacing,0)))return
  return placed
}
