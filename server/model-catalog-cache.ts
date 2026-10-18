import type { LocalModelCatalog } from '../src/core/model-catalog'

interface Entry {value?:LocalModelCatalog;completedAt:number;pending?:Promise<LocalModelCatalog>}
const entries=new Map<string,Entry>()
const CATALOG_TTL=5*60_000
/** One process-wide scan per installation scope, shared by HTTP and assistants.
 * Expiry starts when the scan finishes; callers during a scan join that scan. */
export function readSharedModelCatalog(key:string,load:()=>Promise<LocalModelCatalog>,refresh=false):Promise<LocalModelCatalog>{
  let entry=entries.get(key)
  if(!entry){entry={completedAt:0};entries.set(key,entry)}
  if(refresh)entry.completedAt=0
  if(entry.pending)return entry.pending
  if(entry.value&&Date.now()-entry.completedAt<CATALOG_TTL)return Promise.resolve(entry.value)
  const state=entry
  const pending=Promise.resolve().then(load).then(value=>{state.value=value;state.completedAt=Date.now();return value}).finally(()=>{if(state.pending===pending)state.pending=undefined})
  state.pending=pending
  return pending
}
/** Fast lookup may use an already-completed scan, but never start or await one. */
export function peekSharedModelCatalog(key:string):LocalModelCatalog|undefined{
  const entry=entries.get(key)
  return entry?.value&&Date.now()-entry.completedAt<CATALOG_TTL?entry.value:undefined
}
