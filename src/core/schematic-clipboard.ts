import type { Project } from './circuit'
import { type Drawing, type Terminal, type XY } from './drawing'
import { copySelection, pasteSelection } from './selection'
import { mergeImportedModels, type ImportedSpiceModel } from './spice-models'
import { MAX_MEASUREMENT_PROBES, type Measurement } from './probes'
import type { ProbeLayout } from './probe-placement'

export interface SchematicClipboard { drawing:Drawing; source:Project['source']; models:ImportedSpiceModel[]; probes:Measurement[] }

export function copySchematicSelection(project:Project,ids:string[]):SchematicClipboard|null {
  const drawing=project.drawing&&copySelection(project.drawing,ids,project.source.dc)
  if(!drawing)return null
  const owns=(at:Terminal)=>'device'in at?drawing.devices.some(d=>d.id===at.device):drawing.junctions.some(j=>j.id===at.junction)
  const layout=(value:ProbeLayout|undefined):ProbeLayout|undefined=>value?{...value,...(value.anchor&&!drawing.wires.some(w=>w.id===value.anchor!.wireId)?{anchor:undefined}:{})}:undefined
  const probes=(project.probes??[]).flatMap((probe):Measurement[]=>{
    if(probe.kind==='voltage')return owns(probe.positive)&&(!probe.negative||owns(probe.negative))?[{...probe,positiveLayout:layout(probe.positiveLayout),negativeLayout:layout(probe.negativeLayout)}]:[]
    if(probe.wire){const wire=drawing.wires.find(w=>w.id===probe.wire!.wireId);return wire?[{...probe,wire:{...probe.wire,from:wire.from,to:wire.to},layout:layout(probe.layout)}]:[]}
    return drawing.devices.some(d=>d.id===probe.device)?[{...probe,layout:layout(probe.layout)}]:[]
  })
  return structuredClone({drawing,source:project.source,models:project.models?.filter(m=>drawing.devices.some(d=>d.kind===m.kind&&d.value.toLowerCase()===m.id.toLowerCase()))??[],probes})
}

export function pasteSchematicSelection(project:Project,clipboard:SchematicClipboard,at:XY):{project:Project;ids:string[]} {
  if(!project.drawing)throw new Error('粘贴需要自由原理图')
  const additions=clipboard.models.filter(model=>{
    const existing=project.models?.find(item=>item.id.toLowerCase()===model.id.toLowerCase())
    if(existing&&(existing.kind!==model.kind||existing.spice!==model.spice||JSON.stringify(existing.pins)!==JSON.stringify(model.pins)||JSON.stringify(existing.symbol)!==JSON.stringify(model.symbol)))throw new Error(`模型 ${model.id} 与当前工程定义或符号不同，请先在模型库处理重名。`)
    return !existing
  })
  const added=pasteSelection(project.drawing,clipboard.drawing,at),map=added.idMap
  const mapped=(id:string)=>{const next=map.get(id);if(!next)throw new Error(`粘贴引用 ${id} 没有选区内的编号映射`);return next}
  const terminal=(at:Terminal):Terminal=>'device'in at?{device:mapped(at.device),pin:at.pin}:{junction:mapped(at.junction)}
  const layout=(value:ProbeLayout|undefined)=>value?{...structuredClone(value),...(value.anchor?{anchor:{...value.anchor,wireId:mapped(value.anchor.wireId)}}:{})}:undefined
  const probes=[...(project.probes??[])],used=new Set(probes.map(p=>p.id))
  for(const probe of clipboard.probes){
    let n=1;while(used.has(`P${n}`))n++
    const id=`P${n}`;used.add(id)
    probes.push(probe.kind==='voltage'?{...structuredClone(probe),id,positive:terminal(probe.positive),...(probe.negative?{negative:terminal(probe.negative)}:{}),positiveLayout:layout(probe.positiveLayout),negativeLayout:layout(probe.negativeLayout)}:probe.wire?{...structuredClone(probe),id,wire:{...probe.wire,wireId:mapped(probe.wire.wireId),from:terminal(probe.wire.from),to:terminal(probe.wire.to)},layout:layout(probe.layout)}:{...structuredClone(probe),id,device:mapped(probe.device),layout:layout(probe.layout)})
  }
  if(probes.length>MAX_MEASUREMENT_PROBES)throw new Error(`粘贴后会超过 ${MAX_MEASUREMENT_PROBES} 个探针，请减少选区内的探针后重试。`)
  const models=additions.length?mergeImportedModels(project.models,additions):project.models
  const source=!project.drawing.sourceId&&clipboard.drawing.sourceId?structuredClone(clipboard.source):project.source
  return {project:{...project,drawing:added.drawing,source,...(models?{models}:{}),...(project.probes!==undefined||probes.length?{probes}:{})},ids:added.ids}
}
