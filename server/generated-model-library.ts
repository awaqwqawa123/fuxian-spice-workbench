import {createHash} from 'node:crypto'
import type {AcquisitionCandidate} from '../src/core/model-acquisition'
import {parseImportedModels,type ImportedSpiceModel} from '../src/core/spice-models'
import {createUserLibraryEntry} from '../src/core/user-library'
import {UserLibraryStore} from './user-library-store'
import {isDeepStrictEqual} from 'node:util'

export interface GeneratedLibrarySave {candidateId:string;modelId:string;status:'saved'|'error';message:string}
function generatedVersion(model:ImportedSpiceModel):ImportedSpiceModel{
 const suffix=createHash('sha256').update(JSON.stringify(model)).digest('hex').slice(0,8),id=model.id.slice(0,30)+'_'+suffix
 const escaped=model.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
 const spice=model.spice.replace(new RegExp(`^(\\.(?:model|subckt|ends)\\s+)${escaped}(?=\\s|$)`,'gim'),`$1${id}`)
 return parseImportedModels([{...model,id,name:`${model.name} · ${suffix}`.slice(0,80),spice}])[0]
}
export async function saveGeneratedModels(candidates:readonly AcquisitionCandidate[],store:UserLibraryStore):Promise<GeneratedLibrarySave[]>{
 const results:GeneratedLibrarySave[]=[]
 for(const candidate of candidates.filter(candidate=>candidate.origin==='derived')){
  let model=candidate.model
  try{
   model=createUserLibraryEntry(parseImportedModels([candidate.model])[0]).model
   const previous=await store.load(),existing=previous.entries.find(entry=>entry.model.id.toLowerCase()===model.id.toLowerCase())
   if(existing&&!isDeepStrictEqual(existing.model,model))model=generatedVersion(model)
   try{await store.merge({schemaVersion:1,entries:[createUserLibraryEntry(model)]})}catch(error){
    if(!/与自建库.*冲突/.test((error as Error).message))throw error
    model=generatedVersion(model)
    await store.merge({schemaVersion:1,entries:[createUserLibraryEntry(model)]})
   }
   results.push({candidateId:candidate.id,modelId:model.id,status:'saved',message:`已自动保存至自建库：${model.id}`})
  }catch(error){results.push({candidateId:candidate.id,modelId:model.id,status:'error',message:`模型候选保留，自动入库未完成：${(error as Error).message}`})}
 }
 return results
}
