import type { Device } from '../core/drawing'
import { availableModels, deviceCatalog } from '../core/devices'
import { deviceParameterDefinitions, deviceModelNotes, validateDeviceParameters } from '../core/device-parameters'
import { opAmpModelFor } from '../core/opamp-models'

/** Main value and physical model parameters for switches, relays, LDOs and transformers. */
export default function DeviceParameters({device,onChange}:{device:Device;onChange:(device:Device)=>void}) {
  const definitions=deviceParameterDefinitions[device.kind]
  if(!definitions)return null
  let error=''
  try{validateDeviceParameters(device)}catch(cause){error=cause instanceof Error?cause.message:String(cause)}
  const setValue=(value:string)=>onChange({...device,value})
  return <section className="device-parameters" aria-label={`${device.id} 器件参数`}>
    {(device.kind==='OPA'||device.kind==='CMP')&&<><label>运放型号 / 行为模型<select aria-label={`${device.id} 运放型号`} value={device.value} onChange={event=>setValue(event.target.value)}>{availableModels(device.kind).map(model=><option key={model.id} value={model.id}>{model.name}</option>)}</select></label>{opAmpModelFor(device.kind,device.value)&&<p className="model-limit-note">{opAmpModelFor(device.kind,device.value)!.detail} <a href={opAmpModelFor(device.kind,device.value)!.datasheetUrl} target="_blank" rel="noreferrer">查看官方规格书</a></p>}</>}
    {device.kind==='SW'&&<label>触点状态<select aria-label={`${device.id} 触点状态`} value={device.value} onChange={event=>setValue(event.target.value)}><option value="ON">闭合 ON</option><option value="OFF">断开 OFF</option></select></label>}
    {device.kind==='LDO'&&<label>输出设定电压<input aria-label={`${device.id} 输出设定电压`} value={device.value} onChange={event=>setValue(event.target.value)} placeholder="3.3V"/></label>}
    {device.kind==='XFMR'&&<label>匝数比 Ns / Np<input aria-label={`${device.id} 匝数比 Ns / Np`} value={device.value} onChange={event=>setValue(event.target.value)} placeholder="1"/><small>副边 / 原边，例如 0.5 表示降压至一半。</small></label>}
    {definitions.map(parameter=><label key={parameter.key}>{parameter.label}<input aria-label={`${device.id} ${parameter.label}`} value={device.params?.[parameter.key]??parameter.defaultValue} onChange={event=>onChange({...device,params:{...device.params,[parameter.key]:event.target.value}})} spellCheck={false}/></label>)}
    {error&&<p className="parameter-error" role="alert">{error}</p>}
    <p className="model-limit-note">{deviceModelNotes[device.kind]}</p>
    {device.kind==='RELAY'&&<p className="model-limit-note">符号显示未吸合状态：COM 接 NC；线圈达到吸合电压后切换至 NO。</p>}
    <button type="button" className="parameter-reset" onClick={()=>onChange({...device,value:deviceCatalog[device.kind].value,params:undefined})}>恢复器件默认值</button>
  </section>
}
