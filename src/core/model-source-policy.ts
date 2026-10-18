import type { ImportedSpiceModel, SpiceModelSource } from './spice-models'
import type { ModelSearchCandidate } from './model-search'
import { isInstalledTinaSource, isOwnedPspiceSource } from './installed-model-source'
import { publicModelId } from './model-public-identity'

export type PreferredModelLibrary = 'tina' | 'pspice' | 'ltspice'
/** Default versions come from PSpice; keep compatible alternatives available. */
export const preferredModelLibraries:readonly PreferredModelLibrary[] = ['pspice','ltspice','tina']
export const ltspiceSourceUrl = 'https://www.analog.com/en/resources/design-tools-and-calculators/ltspice-simulator.html'
const vendorSnapshots = [
  {library:'ltspice',repo:'WurthElektronik/LTspice-Library',revision:'4e1fb4ce5fc31d500206e100647a82abf36a0d71',root:'sub/',label:'Würth Elektronik 官方 LTspice 模型'},
  {library:'pspice',repo:'WurthElektronik/Pspice-Library',revision:'5168590e698b5c90aa3f0bab458198f2c30168d9',root:'library/',label:'Würth Elektronik 官方 PSpice 模型'},
] as const
function boundedPath(path:string):boolean {
  return !!path&&!/[\\:\x00-\x1f?#]/.test(path)&&path.split('/').every(part=>!!part&&part!=='.'&&part!=='..')&&/\.(?:lib|mod|sub|cir|spice|spi|inc|txt|dio|bjt|mos|jft)$/i.test(path)
}
/** Library provenance is not a manufacturer's certification. Unknown or
 * community-hosted collections never inherit LTspice status by default. */
export function preferredModelLibrary(source:SpiceModelSource):PreferredModelLibrary|null {
  if(isInstalledTinaSource(source))return 'tina'
  if(isOwnedPspiceSource(source))return 'pspice'
  const prefix=['本机 LTspice / ','LTspice 本地库 / '].find(value=>source.label.startsWith(value))
  if(source.url===ltspiceSourceUrl&&prefix&&boundedPath(source.label.slice(prefix.length)))return 'ltspice'
  for(const snapshot of vendorSnapshots){
    const prefix=`https://raw.githubusercontent.com/${snapshot.repo}/${snapshot.revision}/`
    if(source.label!==snapshot.label||!source.url?.startsWith(prefix))continue
    try{const path=decodeURIComponent(source.url.slice(prefix.length));if(path.startsWith(snapshot.root)&&boundedPath(path))return snapshot.library}catch{/* malformed provenance is not preferred */}
  }
  return null
}
export function isPreferredModelCandidate(candidate:ModelSearchCandidate):boolean {return preferredModelLibrary(candidate.source)!==null}
/** Official web acquisitions remain usable in the assistant without becoming
 * a fourth default library or relabelling arbitrary collections as vendors. */
export function isManufacturerModelCandidate(candidate:ModelSearchCandidate):boolean {
  if(isPreferredModelCandidate(candidate))return true
  try{
    const url=new URL(candidate.source.url??'')
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)return false
    if(url.hostname==='www.ti.com'&&candidate.source.label==='Texas Instruments 官方模型')return /^\/lit\/(?:zip\/[a-z0-9]{3,20}|mo\/[a-z0-9]{3,20}\/[a-z0-9]{3,20}\.zip)$/i.test(url.pathname)
    return url.hostname==='www.st.com'&&candidate.source.label==='STMicroelectronics 原厂 SPICE 模型'&&/^\/resource\//i.test(url.pathname)
  }catch{return false}
}
function sourceRank(source:SpiceModelSource):number {return vendorSnapshots.some(item=>source.label===item.label&&preferredModelLibrary(source)===item.library)?0:1}
export function preferredModelSourceRank(source:SpiceModelSource):number {
  const library=preferredModelLibrary(source)
  return library?preferredModelLibraries.indexOf(library):preferredModelLibraries.length
}
export function comparePreferredCatalogModels(a:ImportedSpiceModel,b:ImportedSpiceModel):number {
  return preferredModelSourceRank(a.source)-preferredModelSourceRank(b.source)||sourceRank(a.source)-sourceRank(b.source)||a.source.label.localeCompare(b.source.label,'en')
}
type CandidatePreference=Pick<ModelSearchCandidate,'source'|'availability'> & Partial<Pick<ModelSearchCandidate,'path'|'id'>>
/** Same exact part: prefer a compatible version, then the default library,
 * registered manufacturer provenance, then stable original path/identity. */
export function comparePreferredModelCandidates(a:CandidatePreference,b:CandidatePreference):number {
  const availability=(item:Pick<ModelSearchCandidate,'availability'>)=>item.availability==='ready'?0:item.availability==='unsupported'?2:1
  return availability(a)-availability(b)||preferredModelSourceRank(a.source)-preferredModelSourceRank(b.source)||sourceRank(a.source)-sourceRank(b.source)||(a.path??'').localeCompare(b.path??'','en')||(a.id??'').localeCompare(b.id??'','en')
}
export function selectPreferredModelCandidates(candidates:readonly ModelSearchCandidate[]):ModelSearchCandidate[] {
  const selected=new Map<string,{candidate:ModelSearchCandidate;name:string}>()
  for(const candidate of candidates){
    const library=preferredModelLibrary(candidate.source);if(!library)continue
    for(const name of candidate.matchedModels){
      const key=`${library}:${publicModelId(name,candidate.source).toLowerCase()}`,previous=selected.get(key)
      if(!previous||comparePreferredModelCandidates(candidate,previous.candidate)<0)selected.set(key,{candidate,name})
    }
  }
  const files=new Map<string,ModelSearchCandidate>()
  for(const {candidate,name}of selected.values()){
    const previous=files.get(candidate.id)
    if(previous)previous.matchedModels.push(name)
    else files.set(candidate.id,{...candidate,matchedModels:[name]})
  }
  return [...files.values()].sort((a,b)=>Number(b.match==='exact')-Number(a.match==='exact')||comparePreferredModelCandidates(a,b))
}
export function selectPreferredCatalogModels(models:readonly ImportedSpiceModel[]):ImportedSpiceModel[] {
  const selected=new Map<string,ImportedSpiceModel>()
  for(const model of models){
    const library=preferredModelLibrary(model.source);if(!library)continue
    const key=`${library}:${publicModelId(model.id,model.source).toLowerCase()}`,previous=selected.get(key)
    const rank=(item:ImportedSpiceModel)=>[sourceRank(item.source),item.metadata.mfg?0:1,item.symbol?.origin==='imported'?0:1] as const
    const better=!previous||rank(model).reduce((difference,value,index)=>difference||value-rank(previous)[index],0)<0
      ||rank(model).every((value,index)=>value===rank(previous)[index])&&model.source.label.localeCompare(previous.source.label,'en')<0
    if(better)selected.set(key,model)
  }
  return [...selected.values()].sort((a,b)=>publicModelId(a.id,a.source).toLowerCase().localeCompare(publicModelId(b.id,b.source).toLowerCase(),'en',{numeric:true})||comparePreferredCatalogModels(a,b))
}
