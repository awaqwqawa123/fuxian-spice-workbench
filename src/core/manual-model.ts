import { parseImportedModels, SPICE_LIBRARY_LIMITS, type ImportedSpiceModel, type SpiceModelDiagnostic, type SpiceModelSource } from './spice-models'
import { parseModelLibraryPreview } from './model-library-preview'
import { assessmentAfterModelEdit } from './model-assessment-persistence'
import { assessModeling } from './modeling-assessment-builder'
import { modelParameterAdjustments } from './model-reference'

export const MANUAL_MODEL_LIMITS={characters:SPICE_LIBRARY_LIMITS.subcircuitCharacters,savedCharacters:320*1024} as const
export interface ManualModelDraft { version:1; text:string; reference?:ImportedSpiceModel; updatedAt:number }
export interface ManualModelPreview { model:ImportedSpiceModel; diagnostics:SpiceModelDiagnostic[] }
export const manualModelStorageKey=(projectId?:string)=>`fuxian-manual-model-v1:${encodeURIComponent(projectId||'workspace')}`
export const emptyManualModelDraft=():ManualModelDraft=>({version:1,text:'',updatedAt:Date.now()})

function manualSource(reference?:ImportedSpiceModel):SpiceModelSource {
  if(!reference)return {label:'用户编辑模型 · 手动创建 · 未验证',attribution:'源码由用户手动输入；工作台仅检查可导入语法，未验证器件精度或工作条件。'}
  return {...reference.source,label:`用户修改 · ${reference.id} · ${reference.source.label}`.slice(0,200),attribution:reference.source.attribution??`复制自 ${reference.id}；保留原来源与条款。用户修改后的模型尚未验证。`}
}

/** A single explicit definition only; no circuit writes, simulation or source guessing. */
export function checkManualModel(text:string,reference?:ImportedSpiceModel):ManualModelPreview {
  if(!text.trim())throw new Error('请先输入一个 .model 或自包含的 .subckt 定义。')
  if(text.length>MANUAL_MODEL_LIMITS.characters||new TextEncoder().encode(text).byteLength>MANUAL_MODEL_LIMITS.characters)throw new Error('手动模型源码最多支持 128 KB；当前内容仍保留在编辑框中。')
  const parsed=parseModelLibraryPreview(text,manualSource(reference))
  const errors=parsed.diagnostics.filter(item=>item.severity==='error')
  if(errors.length)throw new Error(errors.slice(0,8).map(item=>`第 ${item.line} 行：${item.message}`).join('\n'))
  if(parsed.models.length!==1)throw new Error(parsed.models.length?'每次只编辑一个模型；请保留一个 .model 或一个自包含的 .subckt 定义。':'没有找到可导入的模型定义，请检查 .model 或 .subckt / .ends。')
  let model=parsed.models[0]
  if(reference&&model.kind===reference.kind&&model.type===reference.type&&JSON.stringify(model.pins)===JSON.stringify(reference.pins)){
    model={...model,metadata:{...reference.metadata,...model.metadata},...(reference.symbol?{symbol:{...reference.symbol,title:model.id.slice(0,32)}}:{})}
  }
  // Apply the same saved-project checks used by every other import path.
  const assessment=reference&&model.kind===reference.kind&&model.type===reference.type&&JSON.stringify(model.pins)===JSON.stringify(reference.pins)?assessmentAfterModelEdit(reference,model):undefined
  const compatibleReference=reference&&model.kind===reference.kind&&model.type===reference.type?reference:undefined
  model.assessment=assessment??assessModeling({model,reference:compatibleReference,origin:'derived',adjustments:compatibleReference?modelParameterAdjustments(compatibleReference,model).adjustments:[],reason:'用户手动输入或修改的源码；参数的目标器件依据仍需核对。'})
  model=parseImportedModels([model])[0]
  return {model,diagnostics:parsed.diagnostics}
}

export function copyManualModel(reference:ImportedSpiceModel,models:ImportedSpiceModel[]=[]):ManualModelDraft {
  const checked=parseImportedModels([reference])[0]
  const ids=new Set(models.map(model=>model.id.toLowerCase()))
  const base=checked.id.slice(0,30)
  let next=`${base}_CUSTOM`,index=2
  while(ids.has(next.toLowerCase()))next=`${base}_CUSTOM${index++}`
  const escaped=checked.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
  const text=checked.spice.replace(new RegExp(`^(\\.(?:model|subckt)\\s+)${escaped}(?=\\s)`,'im'),`$1${next}`).replace(new RegExp(`^(\\.ends\\s+)${escaped}(?=\\s|$)`,'im'),`$1${next}`)
  return {version:1,text,reference:checked,updatedAt:Date.now()}
}

export function readManualModelDraft(storage:Pick<Storage,'getItem'>,projectId?:string):{draft:ManualModelDraft;error?:string} {
  try{
    const text=storage.getItem(manualModelStorageKey(projectId))
    if(!text)return {draft:emptyManualModelDraft()}
    if(text.length>MANUAL_MODEL_LIMITS.savedCharacters)throw new Error('保存内容超出大小限制')
    const raw=JSON.parse(text)
    if(raw?.version!==1||typeof raw.text!=='string'||raw.text.length>MANUAL_MODEL_LIMITS.characters)throw new Error('保存内容格式不正确')
    const reference=raw.reference?parseImportedModels([raw.reference])[0]:undefined
    return {draft:{version:1,text:raw.text,...(reference?{reference}:{}),updatedAt:Number.isFinite(raw.updatedAt)?raw.updatedAt:Date.now()}}
  }catch(error){return {draft:emptyManualModelDraft(),error:`本机手动草稿未能读取：${(error as Error).message}。原保存记录未被删除。`}}
}

export function saveManualModelDraft(storage:Pick<Storage,'setItem'>,projectId:string|undefined,draft:ManualModelDraft):void {
  if(draft.text.length>MANUAL_MODEL_LIMITS.characters)throw new Error('草稿超出 128 KB 源码限制')
  const saved=JSON.stringify(draft)
  if(saved.length>MANUAL_MODEL_LIMITS.savedCharacters)throw new Error('草稿与参考模型超出保存大小限制')
  // A storage-quota failure preserves the previous record atomically. Other
  // projects' drafts are never evicted to make room for this one.
  storage.setItem(manualModelStorageKey(projectId),saved)
}
