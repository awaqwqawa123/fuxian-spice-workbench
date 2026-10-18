import { parseProject } from './circuit'
import { pinsFor } from './devices'
import type { Result } from './results'

const prefix='fuxian.bias-history.v1:'
const MAX_BYTES=2_000_000
const scalar=(value:unknown):value is number[]=>Array.isArray(value)&&value.length===1&&typeof value[0]==='number'&&Number.isFinite(value[0])
const vectors=(value:unknown,pattern:RegExp):value is Record<string,number[]>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).every(([name,samples])=>pattern.test(name)&&scalar(samples))

/** History is display data, never a source for changing a saved circuit. */
export function readBiasHistory(projectId:string,storage?:Pick<Storage,'getItem'>):Result[] {
  try{
    const raw=(storage??globalThis.localStorage).getItem(prefix+encodeURIComponent(projectId))
    if(!raw||raw.length>MAX_BYTES)return []
    const parsed:unknown=JSON.parse(raw)
    if(!Array.isArray(parsed))return []
    return parsed.slice(0,6).flatMap((item):Result[]=>{
      try{
        if(!item||typeof item!=='object')return []
        const result=item as Result
        if(result.analysis!=='op'||result.points!==1||result.sweepResults?.length||result.experiment?.sweep||
          typeof result.id!=='string'||result.id.length>100||!Number.isFinite(result.timestamp)||result.timestamp<=0||
          typeof result.engine!=='string'||result.engine.length>100||typeof result.netlist!=='string'||typeof result.key!=='string'||
          typeof result.log!=='string'||!Number.isFinite(result.elapsed)||!Array.isArray(result.warnings)||
          result.warnings.some(value=>typeof value!=='string')||!scalar(result.x)||!scalar(result.vin)||!scalar(result.vout)||!scalar(result.current)||
          !vectors(result.voltages,/^v\([a-z_][a-z0-9_]*\)$/i)||!vectors(result.currents??{},/^i\([a-z][a-z0-9_]*\)$/i))return []
        const project=parseProject(result.project,{allowDraft:true})
        if(project.analysis!=='op'||project.sweep||!project.drawing)return []
        const terminals=new Set(project.drawing.devices.flatMap(device=>pinsFor(device).map(pin=>`${device.id}:${pin}`)))
        if(result.terminalCurrents!==undefined&&(!vectors(result.terminalCurrents,/^[a-z][a-z0-9_]*:\d+$/i)||Object.keys(result.terminalCurrents).some(key=>!terminals.has(key))))return []
        if(result.terminalCurrentMethods!==undefined&&(!result.terminalCurrentMethods||typeof result.terminalCurrentMethods!=='object'||Array.isArray(result.terminalCurrentMethods)||Object.entries(result.terminalCurrentMethods).some(([key,value])=>!terminals.has(key)||typeof value!=='string'||value.length>500)))return []
        return [{...result,project}]
      }catch{return []}
    })
  }catch{return []}
}

export function saveBiasHistory(projectId:string,history:Result[],storage?:Pick<Storage,'setItem'>):boolean {
  try{
    const recent=history.slice(0,6)
    while(recent.length){
      const text=JSON.stringify(recent)
      if(text.length<=MAX_BYTES){(storage??globalThis.localStorage).setItem(prefix+encodeURIComponent(projectId),text);return true}
      recent.pop()
    }
    return false
  }catch{return false}
}
