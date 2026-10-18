import type { SpiceModelSource } from './spice-models'
import type { PreferredModelLibrary } from './model-source-policy'
import { isOwnedPspiceSource } from './installed-model-source'
import { spiceModelName } from './spice-model-name'
import reviewed from './reviewed-pspice-public-identities.json'

const identities=new Map(reviewed.files.flatMap(file=>file.models.map(model=>[`${file.path.toUpperCase()}:${file.sha256}:${model.id.toUpperCase()}`,model.part] as const)))

/** Reviewed vendor qualifiers in the owned PSpice catalogue identify model
 * sources, not part grades or packages. This changes public grouping only;
 * actual declarations, keys, port order and saved models remain untouched. */
export function publicModelId(id:string,source:SpiceModelSource|PreferredModelLibrary):string {
  const registered=typeof source==='string'?source==='pspice':isOwnedPspiceSource(source)
  if(!registered||!spiceModelName.test(id))return id
  const qualified=id.match(/^([^/]+)(?:\/\d{1,5})?\/(?:TI|NS)$/i)
  if(qualified)return qualified[1]
  // AWB is an implementation prefix only when the exact original creation
  // annotation identified the public part. Never strip a user model's prefix.
  if(typeof source!=='string'){
    const path=source.label.match(/^PSpice 本地库 \/ (.+)$/)?.[1]
    const hash=source.attribution?.match(/(?:SHA-?256)[^a-f0-9]{0,8}([a-f0-9]{64})/i)?.[1]?.toLowerCase()
    const part=path&&hash?identities.get(`${path.toUpperCase()}:${hash}:${id.toUpperCase()}`):undefined
    if(part)return part
  }
  return id
}

/** Only the registered source qualifier may make a public part an exact hit.
 * The original declaration stays intact for preview, import and simulation. */
export function matchesPublicModel(id:string,query:string,source?:SpiceModelSource):boolean {
  const needle=query.trim().toUpperCase()
  return id.toUpperCase()===needle||!!source&&publicModelId(id,source).toUpperCase()===needle
}
