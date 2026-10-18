import qucs from '../../server/qucs-model-catalog.json'
import type { SpiceModelSource } from './spice-models'

/** A registered part may acquire a namespaced public ID after conversion. */
export function acquiredModelMatches(modelId:string,matchedNames:readonly string[],source:SpiceModelSource):boolean {
  const names=new Set(matchedNames.map(name=>name.toLowerCase()))
  if(names.has(modelId.toLowerCase()))return true
  if(source.label!==qucs.label||!source.url||!registeredAdditionalModelSource(source.url))return false
  const path=decodeURIComponent(new URL(source.url).pathname).split('/').slice(4).join('/')
  return qucs.files.find(file=>file.path===path)?.models.some(model=>model.adaptedId.toLowerCase()===modelId.toLowerCase()&&names.has(model.name.toLowerCase()))??false
}

/** Public root IDs, never helper definitions, for reviewed on-demand Qucs files. */
export function additionalPublicModelIds(source:SpiceModelSource):string[]|undefined {
  if(source.label!==qucs.label||!source.url||!registeredAdditionalModelSource(source.url))return undefined
  const url=new URL(source.url),parts=decodeURIComponent(url.pathname.slice(1)).split('/')
  if(parts.slice(0,2).join('/')!==qucs.repo||parts[2]!==qucs.revision)return undefined
  return qucs.files.find(file=>file.path===parts.slice(3).join('/'))?.models.map(model=>model.adaptedId)
}

/** Client record validation uses immutable source identities; the server also
 * checks the exact file manifest and the downloaded SHA-256 before import. */
export function registeredAdditionalModelSource(raw:string):boolean {
  try{
    const url=new URL(raw)
    if(url.protocol!=='https:'||url.hostname!=='raw.githubusercontent.com'||url.username||url.password||url.port||url.search||url.hash)return false
    const parts=decodeURIComponent(url.pathname.slice(1)).split('/'),repo=parts.slice(0,2).join('/'),revision=parts[2],path=parts.slice(3).join('/')
    if(!path||/[\x00-\x1f\\?#%]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))return false
    if(repo===qucs.repo&&revision===qucs.revision)return qucs.files.some(file=>file.path===path)
    const roots=[
      ['WurthElektronik/LTspice-Library','4e1fb4ce5fc31d500206e100647a82abf36a0d71','sub/'],
      ['WurthElektronik/Pspice-Library','5168590e698b5c90aa3f0bab458198f2c30168d9','library/'],
    ]
    return roots.some(([registeredRepo,pin,root])=>repo===registeredRepo&&revision===pin&&path.startsWith(root)&&path.length<500&&/\.lib$/i.test(path))
  }catch{return false}
}
