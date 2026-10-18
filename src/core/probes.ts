import { compileDrawing, terminalKey, type Drawing, type Terminal } from './drawing'
import type { Complex, Result } from './results'
import type { ProbeLayout } from './probe-placement'
import { hasCurrentProbeDevice, resolveBranchCurrent } from './branch-currents'
import { hasWireCurrentTarget, resolveWireCurrent, wireCurrentName, type WireCurrentTarget } from './wire-currents'

/** Shared placement, clipboard, persistence and agent budget. */
export const MAX_MEASUREMENT_PROBES = 64

export type Measurement =
  | { id:string; kind:'voltage'; positive:Terminal; negative?:Terminal; positiveLayout?:ProbeLayout; negativeLayout?:ProbeLayout }
  | { id:string; kind:'current'; device:string; wire?:never; layout?:ProbeLayout }
  | { id:string; kind:'current'; wire:WireCurrentTarget; device?:never; layout?:ProbeLayout }
/** A deleted attachment is removed with its probe; voltage must not float to a surviving net. */
export function deletedProbeAttachment(before: Drawing, after: Drawing, measurement: Measurement): string | undefined {
  const removedWire = (id: string | undefined) => id && before.wires.some(wire => wire.id === id) && !after.wires.some(wire => wire.id === id)
  const removedTerminal = (at: Terminal | undefined) => at && ('device' in at
    ? before.devices.some(device => device.id === at.device) && !after.devices.some(device => device.id === at.device)
    : before.junctions.some(junction => junction.id === at.junction) && !after.junctions.some(junction => junction.id === at.junction))
  const layouts = measurement.kind === 'voltage' ? [measurement.positiveLayout, measurement.negativeLayout] : [measurement.layout]
  const wireId = measurement.kind === 'current' && measurement.wire ? measurement.wire.wireId : layouts.find(layout => removedWire(layout?.anchor?.wireId))?.anchor?.wireId
  if (removedWire(wireId)) return `依附的导线 ${wireId} 已删除`
  if (measurement.kind === 'voltage') {
    const at = [measurement.positive, measurement.negative].find(removedTerminal)
    if (at) return `测量端点 ${terminalKey(at)} 已删除`
  } else if (measurement.device && before.devices.some(device => device.id === measurement.device) && !after.devices.some(device => device.id === measurement.device)) {
    return `测量器件 ${measurement.device} 已删除`
  }
  return undefined
}

export type ProbeType = 'voltage'|'current'|'differential'
export const probeTypes:Record<ProbeType,{symbol:string;name:string;target:string}> = {
  voltage:{symbol:'V',name:'电压',target:'点击导线 / 引脚'},
  current:{symbol:'I',name:'电流',target:'点击导线 / 器件'},
  differential:{symbol:'ΔV',name:'差分',target:'依次选择 + / −'},
}
export function measurementType(measurement:Measurement):ProbeType {
  return measurement.kind==='current'?'current':measurement.negative?'differential':'voltage'
}
export interface ProbeTrace {
  id:string; name:string; kind:'voltage'|'current'; values:number[]; color:string
  magnitude?:number[]; phase?:number[]
  complex?:Complex[]
}
export const probeColors=['#2676d8','#17886d','#c47b26','#9b54be','#ca5269','#388e9a','#6c7630']

// Always resolve against the experiment that produced the samples. A missing
// terminal/vector is unavailable; it must never fall back to another waveform.
function measurementNodes(result:Result,measurement:Measurement):{positive:string;negative:string}|null {
  if(measurement.kind!=='voltage'||!result.project.drawing)return null
  try {
    const nodes=compileDrawing(result.project.drawing).nodes
    const positive=nodes.get(terminalKey(measurement.positive))
    const negative=measurement.negative?nodes.get(terminalKey(measurement.negative)):'0'
    return positive!==undefined&&negative!==undefined?{positive,negative}:null
  }catch{return null}
}
export function measurementName(result:Result,measurement:Measurement):string|null {
  if(measurement.kind==='current')return measurement.wire
    ?result.project.drawing&&hasWireCurrentTarget(result.project.drawing,measurement.wire)?wireCurrentName(measurement.wire):null
    :hasCurrentProbeDevice(result.project,measurement.device)?`I(${measurement.device})`:null
  const nodes=measurementNodes(result,measurement)
  return nodes?`V(${nodes.positive}${measurement.negative?`, ${nodes.negative}`:''})`:null
}
function complete(values:readonly unknown[]|undefined,result:Result):boolean{return !!values&&values.length===result.points}
export function resolveMeasurement(result:Result,measurement:Measurement,color=probeColors[(Math.max(1,Number(measurement.id.match(/^P(\d+)$/)?.[1])||1)-1)%probeColors.length]):ProbeTrace|null {
  if(result.analysis==='noise')return null
  const name=measurementName(result,measurement)
  if(!name)return null
  let values:number[]|undefined,complex:Complex[]|undefined
  if(measurement.kind==='current'){
    const branch=measurement.wire?resolveWireCurrent(result,measurement.wire):resolveBranchCurrent(result,measurement.device)
    if(!branch)return null
    values=branch.values;complex=branch.complex
  }else{
    const nodes=measurementNodes(result,measurement)!
    const realNode=(node:string)=>node==='0'?Array<number>(result.points).fill(0):result.voltages?.[`v(${node.toLowerCase()})`]
    const complexNode=(node:string)=>node==='0'?Array.from({length:result.points},()=>({real:0,img:0})):result.complexVoltages?.[`v(${node.toLowerCase()})`]
    const positive=realNode(nodes.positive),negative=realNode(nodes.negative)
    if(complete(positive,result)&&complete(negative,result))values=positive!.map((v,i)=>v-negative![i])
    if(result.analysis==='ac'){
      const a=complexNode(nodes.positive),b=complexNode(nodes.negative)
      if(complete(a,result)&&complete(b,result))complex=a!.map((v,i)=>({real:v.real-b![i].real,img:v.img-b![i].img}))
    }
  }
  if(!complete(values,result)||values!.some(v=>!Number.isFinite(v)))return null
  const trace:ProbeTrace={id:measurement.id,name,kind:measurement.kind,values:values!,color}
  if(result.analysis==='ac'){
    if(!complete(complex,result)||complex!.some(v=>!Number.isFinite(v.real)||!Number.isFinite(v.img)))return null
    trace.complex=complex!
    trace.magnitude=complex!.map(v=>20*Math.log10(Math.max(Math.hypot(v.real,v.img),1e-15)))
    trace.phase=[]
    for(const v of complex!){
      let phase=Math.atan2(v.img,v.real)*180/Math.PI
      const previous=trace.phase.at(-1)
      if(previous!==undefined){while(phase-previous>180)phase-=360;while(phase-previous< -180)phase+=360}
      trace.phase.push(phase)
    }
  }
  return trace
}
