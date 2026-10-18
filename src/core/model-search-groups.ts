import type { ModelSearchCandidate } from './model-search'
import { comparePreferredModelCandidates, isPreferredModelCandidate, preferredModelLibrary } from './model-source-policy'
import { publicModelId } from './model-public-identity'

export interface DeviceModelVariant {id:string;candidate:ModelSearchCandidate;matchedNames:string[]}
export interface DeviceModelGroup {id:string;name:string;variants:DeviceModelVariant[]}
const key=(value:string)=>value.trim().toUpperCase()
const rank=(candidate:ModelSearchCandidate)=>candidate.availability==='unsupported'?3:candidate.origin==='local-library'&&candidate.availability==='ready'?0:candidate.origin==='local-library'?1:2
/** Group reviewed source qualifiers under their public part. Punctuation,
 * grades and package suffixes remain distinct electrical identities. */
export function groupDeviceModelCandidates(candidates:readonly ModelSearchCandidate[],query:string,rejectedVersions:ReadonlySet<string>=new Set()):DeviceModelGroup[]{
  const unique=new Map<string,ModelSearchCandidate>()
  for(const candidate of candidates.filter(isPreferredModelCandidate)){
    const prior=unique.get(candidate.id)
    const preferred=prior&&rank(prior)<=rank(candidate)?prior:candidate
    unique.set(candidate.id,{...preferred,matchedModels:[...new Set([...(prior?.matchedModels??[]),...candidate.matchedModels])]})
  }
  const groups=new Map<string,DeviceModelGroup>()
  for(const candidate of unique.values()){
    const names=candidate.matchedModels.length?candidate.matchedModels:[candidate.name]
    const publicNames=[...new Set(names.map(name=>publicModelId(name,candidate.source)))]
    for(const publicName of publicNames){
      const groupId=key(publicName),group=groups.get(groupId)??{id:groupId,name:publicName,variants:[]}
      const matchedNames=names.filter(other=>key(publicModelId(other,candidate.source))===groupId)
      group.variants.push({id:`${candidate.id}:${groupId}`,candidate,matchedNames})
      groups.set(groupId,group)
    }
  }
  const result=[...groups.values()]
  for(const group of result){
    group.variants.sort((a,b)=>Number(rejectedVersions.has(a.id))-Number(rejectedVersions.has(b.id))||comparePreferredModelCandidates(a.candidate,b.candidate))
    // Keep one recommended version from each library. The declaration remains
    // the identity: family prefixes and real suffixes are never collapsed.
    const sources=new Set<string>()
    group.variants=group.variants.filter(variant=>{
      const source=preferredModelLibrary(variant.candidate.source)
      if(!source||sources.has(source))return false
      sources.add(source);return true
    })
  }
  return result.sort((a,b)=>Number(key(b.name)===key(query))-Number(key(a.name)===key(query))||rank(a.variants[0].candidate)-rank(b.variants[0].candidate)||a.name.localeCompare(b.name,undefined,{numeric:true}))
}
