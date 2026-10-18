import { parseQuantity, type Project, type Quantity } from './circuit'
import { editableSource } from './sources'
import { editableProject } from './editor'
import type { Device } from './drawing'

export interface ProjectSweep { target:string; values:string[] }
export const maxSweepRuns=24
export const simulationTemperature=(project:Pick<Project,'temperature'>)=>project.temperature??27
export function parseTemperature(value:unknown):number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<=-273.15||value>1000)throw new Error('仿真温度须大于 −273.15°C 且不超过 1000°C')
  return value
}
export function parseTemperatureText(value:string):number {
  const clean=value.trim().replace(/\s*(?:°?C|℃)\s*$/i,'')
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(clean))throw new Error('温度请输入摄氏数值，例如 −40、27、85°C')
  return parseTemperature(Number(clean))
}
const quantities:Record<string,{kind:Quantity;unit:string;min:number;max:number}>= {
  R:{kind:'resistance',unit:'Ω',min:.01,max:1e9},C:{kind:'capacitance',unit:'F',min:1e-12,max:1},L:{kind:'inductance',unit:'H',min:1e-9,max:1e3},V:{kind:'voltage',unit:'V',min:-1000,max:1000},I:{kind:'current',unit:'A',min:-1000,max:1000},
}
export function sweepTargets(project:Project):{target:string;label:string;kind:string;value:string}[] {
  const devices:Pick<Device,'id'|'kind'|'value'|'params'>[]=project.template==='custom'?project.drawing?.devices??[]:[{id:'R1',kind:'R',value:project.values.R1},{id:'C1',kind:'C',value:project.values.C1},...(project.template==='rlc-lowpass'?[{id:'L1',kind:'L' as const,value:project.values.L1}]:[]),{id:'V1',kind:'V',value:project.source.dc}]
  return [{target:'temperature',label:'仿真温度 (°C)',kind:'temperature',value:String(simulationTemperature(project))},...devices.filter(device=>Object.hasOwn(quantities,device.kind)).map(device=>({target:`device:${device.id}`,label:`${device.id} · ${['V','I'].includes(device.kind)?'直流值': '器件值'} (${quantities[device.kind].unit})`,kind:device.kind,value:device.kind==='V'&&device.id===project.drawing?.sourceId&&!device.params?.waveform?project.source.dc:device.value}))]
}
export function sweepNumericValue(project:Project,target:string,value:string):number {
  const selected=sweepTargets(project).find(item=>item.target===target)
  if(!selected)throw new Error('扫描对象不存在；请选择温度或当前电路中的 R、C、L、V、I')
  if(selected.kind==='temperature')return parseTemperatureText(value)
  const quantity=quantities[selected.kind],n=parseQuantity(value,quantity.kind)
  if(n<quantity.min||n>quantity.max)throw new Error(`${selected.label} 扫描值允许范围 ${quantity.min}～${quantity.max}（基本单位）`)
  return n
}
/** Shape-only parsing also supports configuration restoration before its devices exist. */
export function parseProjectSweep(input:unknown,project?:Project):ProjectSweep {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('参数扫描需要对象，包含 target 与 values')
  const value=input as Record<string,unknown>
  if(Object.keys(value).some(key=>key!=='target'&&key!=='values'))throw new Error('参数扫描只支持 target 与 values 字段')
  if(typeof value.target!=='string'||!(value.target==='temperature'||/^device:[A-Za-z][A-Za-z0-9_]*$/.test(value.target))||value.target.length>100)throw new Error('扫描对象应为 temperature 或 device:R1 等器件标识')
  if(!Array.isArray(value.values)||value.values.length<1||value.values.length>maxSweepRuns||Array.from(value.values).some(item=>typeof item!=='string'||!item.trim()||item.length>40||/[\u0000-\u001f\u007f]/.test(item)))throw new Error(`扫描列表需要 1～${maxSweepRuns} 个数值，可带单位，例如 1k、2k、5k`)
  const sweep={target:value.target,values:value.values.map(item=>(item as string).trim())}
  if(project)for(const entry of sweep.values)sweepNumericValue(project,sweep.target,entry)
  return sweep
}
export function linearSweepValues(project:Project,target:string,start:string,stop:string,count:number):string[] {
  if(!Number.isInteger(count)||count<2||count>maxSweepRuns)throw new Error(`线性扫描点数须为 2～${maxSweepRuns} 的整数`)
  const low=sweepNumericValue(project,target,start),high=sweepNumericValue(project,target,stop)
  if(low===high)throw new Error('扫描起点与终点须不同')
  return Array.from({length:count},(_,index)=>String(Number((low+(high-low)*index/(count-1)).toPrecision(12))))
}
export function expandProjectSweep(project:Project):{project:Project;label:string}[] {
  if(!project.sweep)return[{project:structuredClone(project),label:''}]
  const sweep=parseProjectSweep(project.sweep,project)
  return sweep.values.map(value=>{
    let leaf=structuredClone(project)
    delete leaf.sweep
    if(sweep.target==='temperature')leaf.temperature=parseTemperatureText(value)
    else if(leaf.template!=='custom'){
      const id=sweep.target.slice(7)
      if(id==='V1'){
        leaf=editableProject(leaf)
        leaf.drawing!.devices=leaf.drawing!.devices.map(part=>part.id===id?{...editableSource(part,leaf),value}:part)
      }
      else leaf.values[id as keyof Project['values']]=value
    }else{
      const id=sweep.target.slice(7)
      leaf.drawing!.devices=leaf.drawing!.devices.map(part=>{
        if(part.id!==id)return part
        // Materialize legacy sources before changing DC, retaining independent
        // sine/pulse/PWL/AC parameters instead of replacing their waveform.
        return {...(['V','I'].includes(part.kind)?editableSource(part,leaf):part),value}
      })
    }
    const unit=sweep.target==='temperature'?'°C':quantities[sweepTargets(project).find(item=>item.target===sweep.target)!.kind].unit
    return {project:leaf,label:`${sweep.target==='temperature'?'温度':sweep.target.slice(7)} = ${value}${/[A-Za-zΩ℃°]$/.test(value)?'':` ${unit}`}`}
  })
}
