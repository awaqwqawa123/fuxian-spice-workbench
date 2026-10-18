import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative } from 'node:path'
import { decodeSpiceLibrary } from '../src/core/spice-models'
import { parseLtspiceAsy, type LtspiceAsy } from '../src/core/ltspice-symbol'
import type { ModelSymbol } from '../src/core/model-symbol'
import { asyModelFile, asyModelNames, createSymbolModelFileIndex, modelPathIdentity as identity, originalSymbolForDeclaration, parseSymbolModelHeaders, symbolPathWithin as within, SYMBOL_MODEL_EXTENSIONS } from './original-symbol-link'

interface LinkedSymbol {path:string;modelPath:string;asy:LtspiceAsy;sha256:string;stamp:string}
export interface InstalledSymbolResult {symbol?:ModelSymbol;sourceFile?:string;originalSha256?:string;reason?:string}
type Resolver=(modelPath:string,id:string,pins:readonly string[],sourceText:string)=>Promise<InstalledSymbolResult>
interface SourceFile {path:string;actual:string;size:number;stamp:string}
interface CacheEntry {signature?:string;resolver?:Resolver;pending?:Promise<Resolver>}
const indexes=new Map<string,CacheEntry>()
const MAX_INSTALLATIONS=3,MAX_HEADERS=256,IO_CONCURRENCY=16
const fileStamp=(info:Stats)=>`${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.dev}:${info.ino}`
async function mapFiles<T,R>(items:readonly T[],visit:(item:T)=>Promise<R>):Promise<R[]>{
  const results:R[]=new Array(items.length);let next=0
  await Promise.all(Array.from({length:Math.min(IO_CONCURRENCY,items.length)},async()=>{
    while(next<items.length){const index=next++;results[index]=await visit(items[index])}
  }))
  return results
}
function trimIndexes(){for(const[key,entry]of indexes){if(indexes.size<=MAX_INSTALLATIONS)break;if(!entry.pending)indexes.delete(key)}}
/** Explicit refresh discards associations. An old in-flight scan cannot put
 * its entry back into this map after invalidation. */
export function refreshInstalledModelSymbolIndexes():void{indexes.clear()}
/** This reads display files from the same installed lib tree only. It never
 * expands the set of electrical files accepted by the model catalogue. */
export async function createInstalledModelSymbolResolver(subRoot:string,options:{refresh?:boolean}={}):Promise<Resolver>{
  const symbolRoot=join(dirname(subRoot),'sym')
  let canonicalSub:string,canonicalSym:string
  try{[canonicalSub,canonicalSym]=await Promise.all([realpath(subRoot),realpath(symbolRoot)])}
  catch{return async():Promise<InstalledSymbolResult>=>({reason:'本机同一安装目录没有可读取的 ASY 符号库；保留原始电气模型'})}
  const key=`${identity(canonicalSub)}\n${identity(canonicalSym)}`
  let entry=indexes.get(key)
  if(!entry){entry={};indexes.set(key,entry)}
  indexes.delete(key);indexes.set(key,entry)
  if(options.refresh){entry.signature=undefined;entry.resolver=undefined}
  if(entry.pending)return entry.pending
  const state=entry
  const pending=checkIndex(canonicalSub,canonicalSym,state).finally(()=>{if(state.pending===pending)state.pending=undefined;trimIndexes()})
  state.pending=pending
  return pending
}
async function checkIndex(canonicalSub:string,canonicalSym:string,state:CacheEntry):Promise<Resolver>{
  async function paths(root:string,pattern:RegExp):Promise<SourceFile[]>{
    const files:string[]=[],stack=[root]
    while(stack.length){
      const current=stack.pop()!
      for(const entry of await readdir(current,{withFileTypes:true})){
        const path=join(current,entry.name)
        if(entry.isDirectory())stack.push(path)
        else if(entry.isFile()&&pattern.test(entry.name)){
          if(files.length>=12000)throw new Error('本机符号关联文件超过 12000 个扫描上限')
          files.push(path)
        }
      }
    }
    const sources=await mapFiles(files.sort(),async path=>{
      try{const actual=await realpath(path),info=await stat(actual);return within(root,actual)&&info.isFile()?{path,actual,size:info.size,stamp:fileStamp(info)}:undefined}
      // Keep an unreadable candidate in the filename index: dropping it could
      // turn an ambiguous basename into an apparently unique association.
      catch{return{path,actual:path,size:Infinity,stamp:'unreadable'}}
    })
    return sources.filter((source):source is SourceFile=>!!source)
  }
  let symbols:SourceFile[],models:SourceFile[]
  try{[symbols,models]=await Promise.all([paths(canonicalSym,/\.asy$/i),paths(canonicalSub,SYMBOL_MODEL_EXTENSIONS)])}
  catch(error){return async():Promise<InstalledSymbolResult>=>({reason:`读取本机符号关联目录失败：${(error as Error).message}；保留原始电气模型`})}
  // A complete manifest check detects additions/removals and edits immediately;
  // ctime also detects writes that preserve mtime and size. No stale TTL result.
  const signature=createHash('sha256').update(JSON.stringify([...symbols,...models].map(source=>[source.path,source.actual,source.stamp]))).digest('hex')
  if(state.resolver&&state.signature===signature)return state.resolver
  const resolver=await buildResolver(canonicalSub,canonicalSym,symbols,models)
  state.signature=signature;state.resolver=resolver
  return resolver
}
async function buildResolver(canonicalSub:string,canonicalSym:string,symbols:SourceFile[],models:SourceFile[]):Promise<Resolver>{
  const linked=new Map<string,LinkedSymbol[]>(),notes:string[]=[]
  const files=createSymbolModelFileIndex(models.map(source=>source.path)),modelSources=new Map(models.map(source=>[identity(source.path),source]))
  const unbound:{path:string;asy:LtspiceAsy;sha256:string;stamp:string}[]=[]
  const parsed=await mapFiles(symbols,async source=>{
    const{path,actual,stamp}=source
    try{
      if(source.size>128*1024)return
      const symbolBytes=await readFile(actual),sha256=createHash('sha256').update(symbolBytes).digest('hex')
      if(fileStamp(await stat(actual))!==stamp)return
      const asy=parseLtspiceAsy(decodeSpiceLibrary(symbolBytes),basename(path,'.asy'))
      if(asy.prefix.toUpperCase()!=='X')return
      return{path:actual,asy,sha256,stamp}
    }catch(error){if(notes.length<8)notes.push((error as Error).message)}
  })
  for(const source of parsed){
      if(!source)continue
      const{path:actual,asy,sha256,stamp}=source
      const modelFile=asyModelFile(asy)
      if(!modelFile){
        if(!asy.modelFile&&!SYMBOL_MODEL_EXTENSIONS.test(asy.spiceModel)&&asyModelNames(asy).length)unbound.push({path:actual,asy,sha256,stamp})
        continue
      }
      const candidates=files.resolve(modelFile,actual,canonicalSub)
      // A same-name file in another installed directory is never guessed.
      if(candidates.length!==1)continue
      const target=modelSources.get(identity(candidates[0]))?.actual
      if(!target)continue
      const key=identity(target)
      const list=linked.get(key),item={path:actual,modelPath:target,asy,sha256,stamp}
      if(list)list.push(item);else linked.set(key,[item])
  }
  // Some original ASY files name a model explicitly without naming its file.
  // Resolve only a unique declaration in this exact installed tree; generic
  // empty packages and same-name models in multiple files remain unbound.
  if(unbound.length){
    const wanted=new Set(unbound.flatMap(entry=>asyModelNames(entry.asy))),owners=new Map<string,string[]>()
    const declarations=await mapFiles(models,async source=>{
      try{
        if(source.size>4*1024*1024)return[]
        const text=decodeSpiceLibrary(await readFile(source.actual))
        if(fileStamp(await stat(source.actual))!==source.stamp||/<binary file>|\x00|\.protect\b|BEGIN\s+ENCRYPTED/i.test(text))return[]
        return[...parseSymbolModelHeaders(text).keys()].filter(name=>wanted.has(name))
      }catch{return[]}
    })
    for(const[index,names]of declarations.entries())for(const name of names){
      const list=owners.get(name);if(list)list.push(models[index].actual);else owners.set(name,[models[index].actual])
    }
    for(const entry of unbound){
      const candidates=[...new Set(asyModelNames(entry.asy).flatMap(name=>owners.get(name)??[]))]
      if(candidates.length!==1)continue
      const modelPath=candidates[0],key=identity(modelPath)
      const list=linked.get(key);if(list)list.push({...entry,modelPath});else linked.set(key,[{...entry,modelPath}])
    }
  }
  // Bounded LRU retains hashes, not duplicate full model bodies.
  const headerCache=new Map<string,{hash:string;declarations:Map<string,string[]>}>()
  return async(modelPath:string,id:string,pins:readonly string[],sourceText:string):Promise<InstalledSymbolResult>=>{
    try{
      const actual=await realpath(modelPath)
      if(!within(canonicalSub,actual))return{reason:'符号关联目标不在同一本机安装模型目录，已保留电气模型'}
      const options=linked.get(identity(actual))??[],accepted:{symbol:ModelSymbol;path:string;exact:boolean;sha256:string}[]=[]
      if(!options.length)return{reason:`没有明确关联到同一原始模型文件的 ASY，保留电气模型${notes.length?'；部分 ASY 无法解析':''}`}
      const headerKey=identity(actual),hash=createHash('sha256').update(sourceText).digest('hex')
      let headers=headerCache.get(headerKey)
      if(!headers||headers.hash!==hash){
        headers={hash,declarations:parseSymbolModelHeaders(sourceText)}
      }
      headerCache.delete(headerKey);headerCache.set(headerKey,headers)
      if(headerCache.size>MAX_HEADERS)headerCache.delete(headerCache.keys().next().value!)
      for(const option of options){
        try{
          if(option.asy.symbol.pins.length!==pins.length)continue
          // The original bytes were SHA-verified at construction. Any later
          // file rewrite rejects the old geometry until manifest rebuild.
          if(fileStamp(await stat(option.path))!==option.stamp)continue
          const resolved=originalSymbolForDeclaration(option.asy,id,pins,headers.declarations,!!asyModelFile(option.asy))
          if(resolved)accepted.push({...resolved,path:option.path,sha256:option.sha256})
        }catch{/* One unsupported original must not suppress a valid sibling. */}
      }
      const exact=accepted.filter(option=>option.exact),eligible=exact.length?exact:accepted
      const unique=new Map(eligible.map(option=>[JSON.stringify(option.symbol),option]))
      if(unique.size!==1)return{reason:unique.size?'同一原始模型文件存在多个不同符号变体，未猜测图形':'ASY 的明确型号或同文件系列端口不匹配，保留电气模型'}
      const selected=[...unique.values()][0]
      return{symbol:selected.symbol,sourceFile:relative(canonicalSym,selected.path).replace(/\\/g,'/'),originalSha256:selected.sha256}
    }catch(error){return{reason:`关联本机符号失败：${(error as Error).message}；电气模型已保留`}}
  }
}
