import type { SpiceModelSource } from './spice-models'
import { matchesPublicModel,publicModelId } from './model-public-identity'

/** Declaration identity preserves grades, punctuation and numeric part codes.
 * A short generic model must never match a longer requested device backwards. */
export function modelDeclarationMatch(name:string,query:string,source?:SpiceModelSource):'exact'|'related'|undefined{
  const value=name.trim().toLowerCase(),needle=query.trim().toLowerCase()
  if(!value||!needle)return undefined
  if(value===needle||source&&matchesPublicModel(name,query,source))return 'exact'
  if(needle.length<2)return undefined
  // Forward prefix supports typing a family/partial part and distinct suffixes;
  // it does not imply those electrical models are interchangeable.
  if(value.startsWith(needle)||source&&publicModelId(name,source).toLowerCase().startsWith(needle))return 'related'
  // Some registered declarations contain a full product number as a separate
  // token, such as a package size followed by the manufacturer's article ID.
  if(value.split(/[_. +/()\-]+/).some(token=>token===needle))return 'related'
  return undefined
}
export function selectModelDeclarations(names:readonly string[],query:string,limit=8,source?:SpiceModelSource){
  const exact=names.filter(name=>modelDeclarationMatch(name,query,source)==='exact')
  const related=exact.length?[]:names.filter(name=>modelDeclarationMatch(name,query,source)==='related').slice(0,limit)
  return{names:exact.length?exact:related,match:exact.length?'exact' as const:related.length?'related' as const:undefined}
}
/** Filename evidence can discover an archive/file, never claim that its
 * electrical declarations implement the requested part. */
export function modelFilenameMatches(path:string,query:string):boolean{
  const name=path.replace(/\\/g,'/').split('/').at(-1)??''
  return modelDeclarationMatch(name.replace(/\.[^.]+$/,''),query)!==undefined
}
