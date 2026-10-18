import { parseProject, type Project } from './circuit'
import { mergeImportedModels, type ImportedSpiceModel } from './spice-models'

/** An import only adds a model. Applying it to a component is a separate explicit action. */
export function importSearchedModel(project:Project,model:ImportedSpiceModel):Project {
  return parseProject({...project,models:mergeImportedModels(project.models,[model])},{allowDraft:true})
}

export function assignProjectModel(project:Project,deviceId:string,modelId:string):Project {
  const model=project.models?.find(item=>item.id===modelId)
  const device=project.drawing?.devices.find(item=>item.id===deviceId)
  if(!model)throw new Error('这个模型已不在当前工程中，请重新导入或选择。')
  if(!device)throw new Error('这个器件已不在当前工程中，请重新选择。')
  if(device.kind!==model.kind)throw new Error(`模型 ${model.id} 的器件类型与 ${device.id} 不匹配。`)
  return parseProject({...project,drawing:{...project.drawing!,devices:project.drawing!.devices.map(item=>item.id===deviceId?{...item,value:model.id,...(model.kind==='X'?{pins:[...model.pins],...(model.symbol?.shape==='ltspice'?{pinPositions:model.symbol.pins.map(pin=>({x:pin.x!,y:pin.y!}))}:{pinPositions:undefined})}:{})}:item)}},{allowDraft:true})
}
