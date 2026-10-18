import type { Project } from './circuit'
import { resolveBranchCurrent } from './branch-currents'
import { nodeAnnotations } from './canvas-annotations'
import { dcNodeVoltages, dcVoltageResultMatches } from './dc-voltage'
import { deviceCatalog, pinsFor } from './devices'
import { compileDrawing, terminalKey, type Device, type Drawing, type Terminal, type XY } from './drawing'
import type { Result } from './results'
import { hasWireCurrentTarget, type WireCurrentTarget } from './wire-currents'

export interface BiasMeasurement {
  id:string; kind:'voltage'|'current'|'wire'; label:string; value:number|null; unit:'V'|'A'
  deviceId?:string; pin?:number; at?:Terminal; point?:XY; node?:string; wire?:WireCurrentTarget
  direction:string; source:string; reason?:string
}
// The simulator owns these optional fields. Structural typing also reads older saved results.
type TerminalResult = Result & {terminalCurrents?:Record<string,number[]>;terminalCurrentMethods?:Record<string,string>}
const sample = (values:number[]|undefined):number|null => values?.length===1&&Number.isFinite(values[0])?values[0]:null
export function biasTerminalCurrent(result:Result,device:Device,pin:number):{value:number|null;source:string} {
  if(result.analysis!=='op'||result.points!==1||!pinsFor(device).includes(pin))return{value:null,source:'未提供'}
  const extended=result as TerminalResult,key=`${device.id}:${pin}`
  const saved=sample(extended.terminalCurrents?.[key])
  if(saved!==null)return{value:saved,source:extended.terminalCurrentMethods?.[key]==='native'?'支路电流':extended.terminalCurrentMethods?.[key]==='sensed'?'外部端口电流':'引脚电流'}
  if(pinsFor(device).length===2&&device.kind!=='X'){
    const branch=sample(resolveBranchCurrent(result,device.id)?.values)
    if(branch!==null)return{value:pin===0?branch:-branch,source:'支路电流'}
  }
  return{value:null,source:'未提供'}
}
const pinName = (device:Device,pin:number) => device.kind==='Q'?['C','B','E'][pin]:device.kind==='M'||device.kind==='J'?['D','G','S'][pin]:device.pins?.[pin]??deviceCatalog[device.kind].pins[pin]

/** Electrical cuts use current-drawing terminals; layout-only edits never read old wire geometry. */
export function biasWireCurrent(result:Result,drawing:Drawing,target:WireCurrentTarget):{value:number|null;reason?:string} {
  if(!hasWireCurrentTarget(drawing,target))return{value:null,reason:'导线已删除或端点已改变'}
  const graph=new Map<string,Set<string>>()
  const edge=(a:string,b:string)=>{if(!graph.has(a))graph.set(a,new Set());if(!graph.has(b))graph.set(b,new Set());graph.get(a)!.add(b);graph.get(b)!.add(a)}
  for(const wire of drawing.wires)if(wire.id!==target.wireId)edge(terminalKey(wire.from),terminalKey(wire.to))
  const labels=new Map<string,string[]>()
  for(const label of drawing.labels??[])labels.set(label.name.toLowerCase(),[...(labels.get(label.name.toLowerCase())??[]),terminalKey(label.at)])
  const grounds=drawing.devices.filter(device=>device.kind==='GND').map(device=>`${device.id}:0`)
  for(const group of [...labels.values(),grounds])for(const key of group.slice(1))edge(group[0],key)
  const reach=(start:string)=>{const found=new Set([start]),queue=[start];for(let i=0;i<queue.length;i++)for(const next of graph.get(queue[i])??[])if(!found.has(next)){found.add(next);queue.push(next)}return found}
  const from=reach(terminalKey(target.from))
  if(from.has(terminalKey(target.to)))return{value:null,reason:'存在并联理想导线、同名网络或导线环路，电流分配不唯一'}
  const to=reach(terminalKey(target.to)),plans:number[]=[]
  for(const [side,sign] of [[from,-1],[to,1]] as const){
    let sum=0,complete=true
    const ground=grounds.some(key=>side.has(key))
    for(const device of drawing.devices){
      if(device.kind==='GND')continue
      // Behavioral OP/OPA/CMP models can return current to an implicit global ground.
      if(ground&&['OP','OPA','CMP'].includes(device.kind)){complete=false;break}
      for(const pin of pinsFor(device))if(side.has(`${device.id}:${pin}`)){
        const value=biasTerminalCurrent(result,device,pin).value
        if(value===null){complete=false;break}
        sum+=value
      }
      if(!complete)break
    }
    if(complete&&Number.isFinite(sum))plans.push(sum*sign*target.direction)
  }
  if(!plans.length)return{value:null,reason:'两侧缺少可靠的完整引脚电流，无法计算导线电流'}
  if(plans.length===2&&Math.abs(plans[0]-plans[1])>Math.max(1e-10,Math.max(...plans.map(Math.abs))*1e-4))return{value:null,reason:'两侧引脚电流不满足 KCL，请重新计算并检查模型'}
  return{value:Object.is(plans[0],-0)?0:plans[0]}
}

export function biasMeasurements(result:Result|null,project:Project,wires:readonly WireCurrentTarget[]=[]):BiasMeasurement[] {
  if(!project.drawing)return[]
  const drawing=project.drawing,topology=compileDrawing(drawing),matches=!!result&&dcVoltageResultMatches(result,project)
  const voltages=matches?dcNodeVoltages(result!,project):new Map<string,number>()
  const missing=matches?'本次工作点未提供此测量值':result?'电路已改变，请重新计算直流工作点':'尚未计算直流工作点'
  const items:BiasMeasurement[]=nodeAnnotations(drawing,topology.nodes,{includeNamed:true}).map(annotation=>{
    const terminals=drawing.devices.filter(device=>device.kind!=='GND').flatMap(device=>pinsFor(device).map(pin=>({device:device.id,pin}))).filter(at=>topology.nodes.get(terminalKey(at))===annotation.name).sort((a,b)=>terminalKey(a).localeCompare(terminalKey(b)))
    const value=voltages.get(annotation.name)??null
    return{id:`voltage:${terminals.map(terminalKey).join('|')||'ground'}`,kind:'voltage',label:`V(${annotation.name})`,value,unit:'V',at:terminals[0],point:annotation.point,node:annotation.name,direction:'对全局地 0',source:annotation.name==='0'?'参考地':'节点电压',...(value===null?{reason:missing}:{})}
  })
  for(const device of [...drawing.devices].sort((a,b)=>a.id.localeCompare(b.id))){
    if(device.kind==='GND')continue
    const pins=pinsFor(device),two=pins.length===2&&device.kind!=='X'
    for(const pin of two?[0]:pins){
      const current=matches?biasTerminalCurrent(result!,device,pin):{value:null,source:'未提供'}
      items.push({id:`current:${device.id}:${pin}`,kind:'current',label:two?`I(${device.id})`:`I(${device.id}.${pinName(device,pin)})`,...current,unit:'A',deviceId:device.id,pin,at:{device:device.id,pin},direction:two?`${pinName(device,0)}（1）→ ${pinName(device,1)}（2）`:`流入 ${pinName(device,pin)}（SPICE ${pin+1} 号端口）`,...(current.value===null?{reason:missing}:{})})
    }
  }
  for(const wire of wires){
    // Display belongs to this drawing. Keep saved targets for drawing undo and
    // historical snapshots, but never leave a missing-conductor row in the view.
    if(!hasWireCurrentTarget(drawing,wire))continue
    const flow=matches?biasWireCurrent(result!,drawing,wire):{value:null,reason:missing}
    items.push({id:`wire:${wire.wireId}:${terminalKey(wire.from)}:${terminalKey(wire.to)}:${wire.direction}`,kind:'wire',label:`I(${wire.wireId})`,...flow,unit:'A',wire,direction:wire.direction===1?'导线 from → to':'导线 to → from',source:'引脚电流 KCL'})
  }
  return items
}

const csvCell = (value:unknown) => `"${String(value??'').replace(/"/g,'""')}"`
/** Missing numbers remain blank; all rows carry the same run identity and stale status. */
export function biasCsv(result:Result|null,measurements:readonly BiasMeasurement[],stale:boolean):string {
  const header=['result_id','timestamp','engine','temperature_C','status','measurement_id','kind','label','value','unit','reference_direction','source','reason']
  const status=!result?'unavailable':stale?'stale':'current'
  return '\uFEFF'+[header.map(csvCell).join(','),...measurements.map(m=>[result?.id,result?new Date(result.timestamp).toISOString():'',result?.engine,result?.project.temperature??27,status,m.id,m.kind,m.label,m.value,m.unit,m.direction,m.source,m.reason??''].map(csvCell).join(','))].join('\r\n')
}
