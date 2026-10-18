import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, isAbsolute } from 'node:path'
import type { ModelDownloadPreview, ModelSearchCandidate } from '../src/core/model-search'
import { decodeSpiceLibrary } from '../src/core/spice-models'
import { modelDeclarationMatch, modelFilenameMatches, selectModelDeclarations } from '../src/core/model-search-match'
import { parseAcquiredModelLibrary } from '../src/core/agent-models'
import { acquiredModelMatches } from '../src/core/model-download-sources'
import { indexOfflineSymbols, readOfflineSymbolForModel, type OfflineSymbolInventory } from './offline-symbol-library'
import { preferredModelLibrary, comparePreferredModelCandidates } from '../src/core/model-source-policy'

export interface MaterializedSource { key?:string; repo:string; revision:string; directory:string; archiveSha256?:string; extensions?:Record<string,number> }
export interface MaterializedManifest { version:1; sources:MaterializedSource[] }
export interface MaterializedModelRecord { name:string; kind:string; type:string; pins:string[] }
export interface MaterializedFileRecord {
  id:string; repo:string; revision:string; path:string; source:ModelSearchCandidate['source'];
  names:string[]; models:MaterializedModelRecord[]; rejected:number; reason?:string;
  textSha256?:string; originalSha256?:string; dependencies?:string[];
}
export interface MaterializedLibraryIndex {
  version:1; manifestSha256:string; builtAt:string; files:MaterializedFileRecord[];
  artifacts:{files:number;modelFiles:number;olb:number;asy:number};
}
export function materializedLibraryRoot(){return resolve(process.env.SPICE_MODEL_LIBRARY_DIR||'E:/spice-workbench-library')}
export const materializedFileId=(url:string)=>createHash('sha256').update(url).digest('hex')
export const immutableModelUrl=(repo:string,revision:string,path:string)=>`https://raw.githubusercontent.com/${repo}/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`
let cache:{key:string;index:MaterializedLibraryIndex}|undefined
let pending:{key:string;promise:Promise<MaterializedLibraryIndex>}|undefined
const symbolInventories=new Map<string,{expires:number;pending?:Promise<OfflineSymbolInventory>;value?:OfflineSymbolInventory}>()
async function cachedSymbolInventory(file:MaterializedFileRecord):Promise<OfflineSymbolInventory|undefined>{
  const root=materializedLibraryRoot()
  const manifest=JSON.parse(await readFile(join(root,'sources','manifest.json'),'utf8')) as MaterializedManifest
  const source=manifest.sources.find(item=>item.repo===file.repo&&item.revision===file.revision)
  if(!source?.key)return undefined
  // Electrical-only snapshots have no original symbol to look up. Opening a
  // TL431 model must not scan unrelated Würth ASY/OLB libraries.
  if(source.extensions&&!source.extensions.asy&&!source.extensions.olb)return undefined
  const key=`${root}:${source.repo}:${source.revision}`
  let state=symbolInventories.get(key)
  if(state?.pending)return state.pending
  if(state?.value&&state.expires>Date.now())return state.value
  if(!state){state={expires:0};symbolInventories.set(key,state)}
  const entry=state
  const promise=indexOfflineSymbols(root,[source.key]).then(value=>{
    entry.value=value;entry.expires=Date.now()+30_000;return value
  }).finally(()=>{if(entry.pending===promise)entry.pending=undefined})
  entry.pending=promise
  return promise
}
/** Names/pins only; complete electrical definitions remain in separate disk files. */
export async function readMaterializedLibraryIndex():Promise<MaterializedLibraryIndex|undefined>{
  const root=materializedLibraryRoot(),path=join(root,'catalog.json')
  try{
    const [info,manifest]=await Promise.all([stat(path),readFile(join(root,'sources','manifest.json'))])
    const manifestHash=createHash('sha256').update(manifest).digest('hex'),key=`${root}:${info.mtimeMs}:${info.size}:${manifestHash}`
    if(cache?.key===key)return cache.index
    if(pending?.key===key)return pending.promise
    const promise=readFile(path,'utf8').then(text=>{
      const index=JSON.parse(text) as MaterializedLibraryIndex
      if(index.version!==1||index.manifestSha256!==manifestHash||!Array.isArray(index.files))throw new Error('本地模型目录与原件清单不一致，请重新构建目录')
      cache={key,index};return index
    }).finally(()=>{if(pending?.key===key)pending=undefined})
    pending={key,promise};return promise
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error}
}
export async function readMaterializedLibraryStatus(){
  const index=await readMaterializedLibraryIndex()
  const files=index?.files.filter(file=>preferredModelLibrary(file.source))??[]
  return index?{installed:files.length>0,builtAt:index.builtAt,files:files.length,models:files.reduce((n,file)=>n+file.models.length,0),unsupported:files.reduce((n,file)=>n+file.rejected,0),unsupportedFiles:files.filter(file=>!file.models.length).length}:{installed:false,files:0,models:0,unsupported:0,unsupportedFiles:0}
}
export async function lookupMaterializedModels(query:string,limit=40):Promise<ModelSearchCandidate[]>{
  const index=await readMaterializedLibraryIndex()
  if(!index)return []
  if(!query.trim())return []
  const matches:ModelSearchCandidate[]=[]
  for(const file of index.files){
    if(!preferredModelLibrary(file.source))continue
    const names=[...new Set([...file.names,...file.models.map(model=>model.name)])]
    const selected=selectModelDeclarations(names,query)
    if(!selected.names.length&&!modelFilenameMatches(file.path,query))continue
    const available=file.models.some(model=>acquiredModelMatches(model.name,selected.names,file.source))
    matches.push({id:file.id,name:file.path.split('/').at(-1)!,path:file.path,source:file.source,matchedModels:selected.names,origin:'local-library',match:selected.match??'filename',availability:available?'ready':'unsupported',reason:available?undefined:file.reason??'原件已保存；该定义暂不兼容当前 ngspice 导入器'})
  }
  return matches.sort((a,b)=>Number(b.match==='exact')-Number(a.match==='exact')||comparePreferredModelCandidates(a,b)).slice(0,Math.min(Math.max(limit,1),100))
}
/** Read only server-selected immutable snapshot paths; never an HTTP filesystem path. */
export async function readMaterializedSourceText(raw:string,limit=4*1024*1024):Promise<string|undefined>{
  const url=new URL(raw)
  if(url.protocol!=='https:'||url.hostname!=='raw.githubusercontent.com'||url.username||url.password||url.search||url.hash)return undefined
  const parts=decodeURIComponent(url.pathname.slice(1)).split('/'),repo=parts.slice(0,2).join('/'),revision=parts[2],path=parts.slice(3).join('/')
  if(!/^[a-f0-9]{40}$/.test(revision)||!path||/[\\\x00-\x1f]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))return undefined
  let manifest:MaterializedManifest
  try{manifest=JSON.parse(await readFile(join(materializedLibraryRoot(),'sources','manifest.json'),'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error}
  const source=manifest.version===1?manifest.sources.find(item=>item.repo===repo&&item.revision===revision):undefined
  if(!source)return undefined
  const directory=resolve(materializedLibraryRoot(),'sources',source.directory),target=resolve(directory,...path.split('/')),local=relative(directory,target)
  if(local.startsWith('..')||isAbsolute(local))throw new Error('本地模型路径超出固定来源目录')
  const info=await stat(target)
  if(!info.isFile()||info.size>limit)throw new Error('本地模型原件超过导入大小限制；原件仍已保存')
  return decodeSpiceLibrary(await readFile(target))
}
export async function readMaterializedModelPreview(id:string):Promise<ModelDownloadPreview|undefined>{
  if(!/^[a-f0-9]{64}$/.test(id))return undefined
  const index=await readMaterializedLibraryIndex(),file=index?.files.find(item=>item.id===id)
  if(!file)return undefined
  if(!file.textSha256)throw new Error(file.reason??'模型原件已保存；当前格式尚不可仿真')
  const text=await readFile(join(materializedLibraryRoot(),'parsed',`${id}.lib`),'utf8')
  if(createHash('sha256').update(text).digest('hex')!==file.textSha256)throw new Error('本地模型解析副本校验失败，请重建目录；原件已保留')
  const preview={...parseAcquiredModelLibrary(text,file.source),source:file.source,text}
  // Keep the electrical library and its original symbol together on every
  // placement path. Saved projects retain the verified geometry and anchors.
  if(preview.models.some(model=>model.kind==='X')){
    try{
      const inventory=await cachedSymbolInventory(file)
      for(const model of preview.models){
        if(model.kind!=='X'||!file.source.url||!inventory)continue
        const symbol=await readOfflineSymbolForModel(file.source.url,model.id,model.pins,inventory)
        if(symbol)model.symbol={...symbol,origin:'imported',...(model.symbol?.family?{family:model.symbol.family}:{})}
      }
    }catch(error){preview.diagnostics.push({line:0,severity:'warning',message:`原件符号库暂不可读取：${(error as Error).message}；电气模型仍保留。`})}
  }
  return preview
}
export async function pageMaterializedModels(query='',offset=0,limit=100){
  const index=await readMaterializedLibraryIndex(),needle=query.trim()
  const files=index?.files.filter(file=>preferredModelLibrary(file.source)&&(!needle||modelFilenameMatches(file.path,needle)||file.names.some(name=>modelDeclarationMatch(name,needle))||file.models.some(model=>modelDeclarationMatch(model.name,needle))))??[]
  return {total:files.length,offset,files:files.slice(offset,offset+Math.min(limit,100))}
}
