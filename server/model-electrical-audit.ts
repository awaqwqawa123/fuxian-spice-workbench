import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { importedModelNetlist, parseImportedModels, parseSpiceLibrary, type ImportedSpiceModel } from '../src/core/spice-models'
import { preferredModelLibrary } from '../src/core/model-source-policy'

const hash=(raw:Uint8Array|string)=>createHash('sha256').update(raw).digest('hex')
export interface ElectricalAuditRow {
  key:string;id:string;library:string;source:string;kind:string;type:string;ports:string[]
  status:'passed'|'error';checks:string[];warnings:string[];errors:string[];codeHash:string
}
/** Read the immutable generation actually used by the browser. Check every
 * index, summary and definition byte before calling it a reviewed record. */
export async function readCompiledAuditModels(libraryRoot:string) {
  const root=join(libraryRoot,'.cache','device-library-v1')
  const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'))
  if(![1,2,3].includes(manifest.schema)||!/^\d{13}-[a-f0-9-]{36}$/.test(manifest.generation)||!Array.isArray(manifest.chunks)||manifest.chunks.length>1000||!Number.isSafeInteger(manifest.versions))throw new Error('编译库清单格式错误，未继续审查')
  const indexBytes=await readFile(join(root,manifest.generation,'index.json'))
  if(hash(indexBytes)!==manifest.indexHash)throw new Error('编译库索引校验失败，未继续审查')
  const index=JSON.parse(indexBytes.toString('utf8'))
  if(index.schema!==manifest.schema||index.scope!==manifest.scope||!Array.isArray(index.entries)||index.entries.length!==manifest.versions)throw new Error('编译库索引与清单不一致')
  const records:{key:string;model:ImportedSpiceModel}[]=[],seen=new Set<string>()
  for(let chunk=0;chunk<manifest.chunks.length;chunk++){
    const [modelBytes,summaryBytes]=await Promise.all(['models','summaries'].map(suffix=>readFile(join(root,manifest.generation,`${chunk}.${suffix}.json`))))
    if(hash(modelBytes)!==manifest.chunks[chunk].models||hash(summaryBytes)!==manifest.chunks[chunk].summaries)throw new Error(`分块 ${chunk} 的模型或摘要校验失败`)
    const models=JSON.parse(modelBytes.toString('utf8')) as ImportedSpiceModel[],summaries=JSON.parse(summaryBytes.toString('utf8'))
    const entries=index.entries.filter((entry:{chunk:number})=>entry.chunk===chunk)
    if(!Array.isArray(models)||!Array.isArray(summaries)||models.length>128||models.length!==entries.length||summaries.length!==entries.length)throw new Error(`分块 ${chunk} 的记录数量不一致`)
    for(const model of models){
      const key=hash(JSON.stringify(model)),entry=entries.find((item:{key:string})=>item.key===key),summary=summaries.find((item:{key:string})=>item.key===key)
      if(!entry||seen.has(key)||entry.id!==model.id||!summary||summary.id!==model.id||!isDeepStrictEqual(summary.pins,model.pins)||!isDeepStrictEqual(summary.source,model.source))throw new Error(`模型 ${model.id} 的索引、展示摘要或端口不一致`)
      seen.add(key);records.push({key,model})
    }
  }
  if(records.length!==manifest.versions)throw new Error('完整记录数与库清单不一致')
  return {generation:manifest.generation,builtAt:manifest.builtAt,uniqueDevices:manifest.total,records}
}
/** Syntax, full dependency closure, save/reload and export are separate from
 * electrical precision. No runtime test or datasheet match is implied here. */
export function auditElectricalModel(model:ImportedSpiceModel,key=hash(JSON.stringify(model))):ElectricalAuditRow {
  const checks:string[]=[],warnings:string[]=[],errors:string[]=[]
  try {
    const parsed=parseSpiceLibrary(model.spice,model.source)
    errors.push(...parsed.diagnostics.filter(item=>item.severity==='error').map(item=>item.message))
    warnings.push(...parsed.diagnostics.filter(item=>item.severity==='warning').map(item=>item.message))
    const root=parsed.models.find(item=>item.id===model.id)
    if(!root||root.kind!==model.kind||root.type!==model.type||root.technology!==model.technology||JSON.stringify(root.pins)!==JSON.stringify(model.pins))throw new Error('完整源码中的器件身份、类型或端口与记录不一致')
    if(!errors.length)checks.push('syntax-and-dependencies')
    const restored=parseImportedModels(JSON.parse(JSON.stringify([model])))[0]
    if(restored.spice!==model.spice||!isDeepStrictEqual(restored.pins,model.pins)||!isDeepStrictEqual(restored.source,model.source))throw new Error('保存恢复改变了电气定义、端口或来源')
    if(!isDeepStrictEqual(restored.symbol,model.symbol)||!isDeepStrictEqual(restored.deviceInfo,model.deviceInfo)||!isDeepStrictEqual(restored.assessment,model.assessment))throw new Error('保存恢复改变了符号或已核对资料')
    checks.push('save-reload-identity')
    const exported=parseSpiceLibrary(importedModelNetlist(restored),restored.source)
    errors.push(...exported.diagnostics.filter(item=>item.severity==='error').map(item=>`导出：${item.message}`))
    const emitted=exported.models.find(item=>item.id===restored.id)
    if(!emitted||JSON.stringify(emitted.pins)!==JSON.stringify(restored.pins)||emitted.kind!==restored.kind)throw new Error('导出模型的身份或电气端口不一致')
    if(!exported.diagnostics.some(item=>item.severity==='error'))checks.push('export-dependency-closure')
  } catch(error){errors.push((error as Error).message)}
  return {key,id:model.id,library:preferredModelLibrary(model.source)??'other',source:model.source.label,kind:model.kind,type:model.technology??model.type,ports:model.pins,status:errors.length?'error':'passed',checks,warnings:[...new Set(warnings)],errors:[...new Set(errors)],codeHash:hash(model.spice)}
}
