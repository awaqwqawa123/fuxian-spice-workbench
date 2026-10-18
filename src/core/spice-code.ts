import { generateNetlist, type Project } from './circuit'
import { compileDrawing } from './drawing'
import { editableProject } from './editor'
import { importedModelNetlist } from './spice-models'
import { deviceSpice, referenceSourceSpice } from './spice-elements'

export interface SpiceCodePreview { title:string; code:string; note:string; incomplete:boolean }

/** Inspect the same device statements used by ngspice, including unfinished drawings. */
export function spiceCodePreview(project:Project,deviceId?:string,modelId?:string):SpiceCodePreview {
  if(modelId){
    const model=project.models?.find(item=>item.id===modelId)
    if(!model)throw new Error('该模型已不在当前工程中，请重新选择。')
    return{title:`${model.id} · SPICE 模型代码`,code:importedModelNetlist(model),note:'当前工程中保存的模型定义；可在下方编辑，修改经过验证后应用。',incomplete:false}
  }
  const p=editableProject(project),drawing=p.drawing!,topology=compileDrawing(drawing)
  const selected=deviceId?drawing.devices.find(part=>part.id===deviceId):undefined
  if(deviceId&&!selected)throw new Error('该器件已不在当前工程中，请重新选择。')
  if(selected?.kind==='GND')return{title:`${deviceId} · 接地参考`,code:`* ${deviceId} maps its connected net to SPICE node 0.`,note:'接地符号将相连网络指定为节点 0，没有独立的 .model 或器件语句。',incomplete:false}
  if(!deviceId){
    try{return{title:'当前工程 SPICE 网表',code:generateNetlist(p),note:'包含当前连接、器件参数、模型定义和仿真指令。',incomplete:false}}
    catch{/* An unfinished drawing can still expose real device/model statements. */}
  }
  const parts=selected?topology.elements.filter(item=>item.device.id===deviceId):topology.elements
  const generated=parts.map(({device,nodes})=>deviceSpice(p,device,nodes,topology.sourceId,device.kind==='V'&&device.id===topology.sourceId?referenceSourceSpice(p):''))
  const definitions=[...new Set([...generated.flatMap(item=>item.models),...(!selected?(p.models??[]).map(importedModelNetlist):[])])]
  const code=[...generated.map(item=>item.code),...definitions].join('\n')
  return{title:selected?`${selected.id} · SPICE 器件与模型代码`:'当前工程 SPICE 片段',code:code||'* No components or models in this project.',
    note:topology.errors.length?'显示当前连接下的器件语句与模型定义；电路尚有连接或参考设置待完成，不能直接作为完整仿真文件。':selected?'此代码与网表中的器件实现一致；参数在「器件编辑」修改，支持的 .model 可在下方编辑。':'当前参数或分析设置尚未完成；下列器件与模型代码可供查看。',incomplete:topology.errors.length>0||!selected}
}
