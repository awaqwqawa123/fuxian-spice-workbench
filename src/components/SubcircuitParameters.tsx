import {useEffect,useState} from 'react'
import type {Device} from '../core/drawing'
import type {ImportedSpiceModel} from '../core/spice-models'
import {subcircuitParameterDefinitions,subcircuitInstanceParameterTail} from '../core/subcircuit-parameters'

export default function SubcircuitParameters({device,model,onChange}:{device:Device;model:ImportedSpiceModel;onChange:(device:Device)=>void}){
 const appliedSignature=JSON.stringify(Object.entries(device.params??{}).sort(([a],[b])=>a.localeCompare(b)))
 const [draft,setDraft]=useState(device.params??{}),[draftError,setDraftError]=useState('')
 useEffect(()=>{setDraft(device.params??{});setDraftError('')},[device.id,appliedSignature,model.id])
 let definitions:ReturnType<typeof subcircuitParameterDefinitions>=[],error=''
 try{definitions=subcircuitParameterDefinitions(model)}catch(reason){error=(reason as Error).message}
 try{subcircuitInstanceParameterTail(device,model)}catch(reason){error=(reason as Error).message}
 if(!definitions.length&&!error)return null
 return <section aria-label="子电路实例参数" className="subcircuit-instance-parameters"><h4>实例参数</h4><p className="field-hint">仅覆盖这个器件，不修改厂商模型。数值使用 SPICE 单位，例如 50k；兆使用 Meg；常量表达式会校验并换算后应用。</p>{definitions.map(definition=>{
 const existing=Object.keys(draft).find(key=>key.toLowerCase()===definition.name.toLowerCase())
 return <label className="field" key={definition.name}><span>{definition.name}</span><input aria-label={`${device.id} 参数 ${definition.name}`} value={existing?draft[existing]:''} placeholder={`默认 ${definition.value}`} onChange={event=>{const params={...draft};if(existing)delete params[existing];if(event.target.value.trim())Object.defineProperty(params,definition.name,{value:event.target.value,enumerable:true,configurable:true,writable:true});setDraft(params);const next={...device,params:Object.keys(params).length?params:undefined};try{subcircuitInstanceParameterTail(next,model);setDraftError('');onChange(next)}catch(reason){setDraftError(`此输入尚未应用：${(reason as Error).message}`)}}} spellCheck={false}/><small>模型默认：{definition.value}</small></label>
 })}{(draftError||error)&&<><p role="alert" className="error-banner">{draftError||error}</p>{Object.keys(device.params??{}).length>0&&<button type="button" onClick={()=>{setDraft({});setDraftError('');onChange({...device,params:undefined})}}>恢复模型默认实例参数</button>}</>}</section>
}
