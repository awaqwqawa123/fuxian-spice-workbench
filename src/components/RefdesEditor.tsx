import { useState } from 'react'
import { deviceCatalog } from '../core/devices'
import type { Device } from '../core/drawing'

export default function RefdesEditor({device,onRename}:{device:Device;onRename:(id:string)=>void}) {
  const [value,setValue]=useState(device.id),[error,setError]=useState('')
  return <form className="refdes-editor" onSubmit={e=>{
    e.preventDefault()
    try {onRename(value);setValue(value.trim().toUpperCase());setError('')}
    catch(reason){setError((reason as Error).message)}
  }}>
    <label className="field"><span>器件编号</span><div className="refdes-input"><input aria-label="器件编号" value={value} maxLength={8} spellCheck={false} onChange={e=>{setValue(e.target.value);setError('')}}/><button type="submit" disabled={value.trim().toUpperCase()===device.id}>应用编号</button></div><small className="field-hint">{deviceCatalog[device.kind].prefix} + 1–99999，例如 {deviceCatalog[device.kind].prefix}10；连线和探针会同步更新。</small></label>
    {error&&<p className="refdes-error" role="alert">{error}</p>}
  </form>
}
