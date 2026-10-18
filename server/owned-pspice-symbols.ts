import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { SpiceModelSource } from '../src/core/spice-models'
import type { ModelSymbol } from '../src/core/model-symbol'
import type { IndexedSymbol } from './ltspice-symbol-library'
import type { OfflineSymbolInventory } from './offline-symbol-library'
import { readConvertedOlb, type ConvertedOlbPart } from './olb-library'
import { createSymbolModelFileIndex, originalSymbolForDeclaration, sameSymbolModelPorts, symbolPathWithin } from './original-symbol-link'
import { ownedModelLibraryRoot } from './owned-model-library'

const cadenceURL='https://www.cadence.com/en_US/home/tools/system-design-and-verification/analog-mixed-signal-simulation/pspice.html'
export function ownedPspiceSymbolRoots(libraryRoot=ownedModelLibraryRoot()) {
  return {libraryRoot,sourceRoot:join(libraryRoot,'vendor','pspice'),convertedRoot:join(libraryRoot,'converted-symbols','pspice')}
}
export interface PspiceSnapshotSourceContext {
  scope:'selected-files'|'installed-library'|'mixed'|'unknown'
  tiOriginalModels:Set<string>
  fileScopes?:Map<string,'selected-files'|'installed-library'|'unknown'>
}
/** One provenance read per index build, never one manifest read per symbol. */
export async function readPspiceSnapshotSourceContext(sourceRoot:string):Promise<PspiceSnapshotSourceContext> {
  const fallback:PspiceSnapshotSourceContext={scope:'unknown',tiOriginalModels:new Set()}
  try {
    const path=join(sourceRoot,'paths_manifest.json'),info=await stat(path)
    if(info.size>32*1024*1024)return fallback
    const manifest=JSON.parse(await readFile(path,'utf8'))
    if(manifest?.vendor!=='pspice'||!manifest.source||typeof manifest.source!=='object')return fallback
    if(manifest.schemaVersion===2&&manifest.mergePolicy==='byte-preserving-snapshot-union'&&Array.isArray(manifest.files)) {
      const fileScopes=new Map<string,'selected-files'|'installed-library'|'unknown'>(),tiOriginalModels=new Set<string>()
      for(const file of manifest.files) {
        if(typeof file?.path!=='string'||!Array.isArray(file.provenance))continue
        const key=file.path.replaceAll('\\','/').toLowerCase(),scopes=new Set<'selected-files'|'installed-library'|'unknown'>()
        for(const entry of file.provenance) {
          const source=entry?.source,record=entry?.originalRecord
          if(!source||!record||!/^[a-f0-9]{64}$/i.test(file.sha256??'')||record.sha256!==file.sha256)continue
          if(source.selectionKind==='user-selected-local-capture-files') {
            scopes.add('selected-files')
            if(typeof source.product==='string'&&/\bTI\b/.test(source.product)&&record.kind==='electrical-model'&&record.origin?.entry==='vca821.lib'&&typeof record.origin.archive==='string'&&/^[a-f0-9]{64}$/i.test(record.origin.archiveSha256??''))tiOriginalModels.add(key)
          } else if(source.selectionKind===undefined&&typeof source.installationRoot==='string'&&source.installationRoot.trim())scopes.add('installed-library')
        }
        fileScopes.set(key,scopes.has('selected-files')?'selected-files':scopes.has('installed-library')?'installed-library':'unknown')
      }
      return {scope:'mixed',tiOriginalModels,fileScopes}
    }
    if(manifest.schemaVersion!==1)return fallback
    if(manifest.source.selectionKind==='user-selected-local-capture-files') {
      const tiOriginalModels=new Set<string>()
      // Attribution follows the selected download's recorded archive entry;
      // a directory or device name alone never establishes manufacturer authorship.
      if(typeof manifest.source.product==='string'&&/\bTI\b/.test(manifest.source.product)&&Array.isArray(manifest.files)) {
        for(const file of manifest.files)if(typeof file?.path==='string'&&file.kind==='electrical-model'&&file.origin?.entry==='vca821.lib'&&typeof file.origin.archive==='string'&&/^[a-f0-9]{64}$/i.test(file.origin.archiveSha256??''))tiOriginalModels.add(file.path.replaceAll('\\','/').toLowerCase())
      }
      return {scope:'selected-files',tiOriginalModels}
    }
    if(manifest.source.selectionKind===undefined&&typeof manifest.source.installationRoot==='string'&&manifest.source.installationRoot.trim())return {scope:'installed-library',tiOriginalModels:new Set()}
  } catch { /* Missing or unreadable provenance cannot establish an installation. */ }
  return fallback
}
/** Stable label/URL identity is retained for source grouping and saved projects. */
export function pspiceSnapshotSource(path:string,context:PspiceSnapshotSourceContext,kind:'model'|'symbol'):SpiceModelSource {
  const identity={label:`PSpice 本地库 / ${path}`,url:cadenceURL}
  const scope=context.scope==='mixed'?(context.fileScopes?.get(path.replaceAll('\\','/').toLowerCase())??'unknown'):context.scope
  if(scope==='installed-library')return {...identity,...(kind==='model'?{
    license:'本机安装的 PSpice 原件已完整复制到软件自有库；原始厂商许可与版权仍适用，不随工作台公开分发',
    attribution:'原始参数、依赖与厂商备注完整保留；兼容性仅代表静态检查，不代表仿真精度认证',
  }:{license:'用户本机保存的 Cadence 原始库，沿用原厂授权条款。',attribution:'保留原始 OLB 和 SHA-256，图形与电气端口映射取自原件。'})}
  const tiModel=kind==='model'&&context.tiOriginalModels.has(path.replaceAll('\\','/').toLowerCase())
  const selected=scope==='selected-files',subject=kind==='symbol'?'Capture 符号文件':tiModel?'TI 原始 PSpice 模型':'PSpice 模型文件'
  return {...identity,
    license:`${selected?'用户选定的本机':'用户本机保存的'} ${subject}；${selected?'非整套 Cadence 安装库':'未确认安装快照来源'}。原作者许可与版权见原件，不随工作台公开分发。`,
    attribution:`${tiModel?'TI 原始下载 ZIP 中的 vca821.lib 按原字节恢复；':''}${kind==='symbol'?'原始 OLB 和 SHA-256 保留，图形与明确电气端口映射取自原件':'原始参数、依赖与厂商备注保留；兼容性仅代表静态检查，不代表仿真精度认证'}。${selected?'来源为用户选定文件集合；':''}原作者版权见原件。`,
  }
}
async function hashFile(path:string) {
  const hash=createHash('sha256')
  for await(const chunk of createReadStream(path))hash.update(chunk)
  return hash.digest('hex')
}
async function files(root:string):Promise<string[]> {
  const result:string[]=[],queue=[root]
  while(queue.length) {
    const entries=await readdir(queue.pop()!,{withFileTypes:true})
    for(const entry of entries) {
      const path=join(entry.parentPath,entry.name)
      if(entry.isSymbolicLink())continue
      if(entry.isDirectory())queue.push(path)
      else if(entry.isFile()&&/\.(?:olb|lib|mod|sub|cir|spice|spi|inc)$/i.test(entry.name))result.push(path)
      if(result.length>100000)throw new Error('软件自有 PSpice 库超过文件上限')
    }
  }
  return result.sort()
}
interface ModelDeclaration {headers:Map<string,string[]>;issue:string}
const declarationCache=new Map<string,{stamp:string;promise:Promise<ModelDeclaration>}>()
async function modelHeaders(path:string):Promise<ModelDeclaration> {
  const info=await stat(path),key=resolve(path).toLowerCase(),stamp=`${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  const cached=declarationCache.get(key)
  if(cached?.stamp===stamp)return cached.promise
  const promise=(async()=>{
    const {readPspicePublicDeclarationHeaders}=await import('./pspice-model-library')
    const declarations=await readPspicePublicDeclarationHeaders(path),headers=new Map<string,string[]>(),ambiguous=new Set<string>()
    for(const entry of declarations) {
      if(entry.kind!=='subckt'||entry.encrypted)continue
      const id=entry.name.toLowerCase()
      if(headers.has(id))ambiguous.add(id)
      headers.set(id,entry.pins)
    }
    for(const id of ambiguous)headers.delete(id)
    return {headers,issue:''}
  })()
  declarationCache.set(key,{stamp,promise})
  promise.catch(()=>{if(declarationCache.get(key)?.promise===promise)declarationCache.delete(key)})
  return promise
}
const modelKey=(path:string,id:string)=>`${resolve(path).toLowerCase()}\0${id.toLowerCase()}`
interface OwnedInventory extends OfflineSymbolInventory {modelHeaders:Map<string,ModelDeclaration>;byModel:Map<string,IndexedSymbol[]>}
let cached:{root:string;signature:string;readAt:number;promise:Promise<OwnedInventory>}|undefined

async function indexOriginals(libraryRoot:string):Promise<OwnedInventory> {
  const roots=ownedPspiceSymbolRoots(libraryRoot)
  const result:OwnedInventory={symbols:[],assets:[],sources:[],notices:[],paths:new Map(),modelHeaders:new Map(),byModel:new Map()}
  let paths:string[],canonicalRoot:string
  try {canonicalRoot=await realpath(roots.sourceRoot);paths=await files(canonicalRoot)}
  catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')result.notices.push((error as Error).message);return result}
  const sourceContext=await readPspiceSnapshotSourceContext(canonicalRoot)
  const modelPaths=paths.filter(path=>! /\.olb$/i.test(path)),modelFiles=createSymbolModelFileIndex(modelPaths)
  const owners=new Map<string,string[]>()
  for(const path of modelPaths) {
    try {
      const declaration=await modelHeaders(path);result.modelHeaders.set(path,declaration)
      for(const id of declaration.headers.keys())owners.set(id,[...(owners.get(id)??[]),path])
    } catch { /* Original files remain stored; an unreadable file cannot prove linkage. */ }
  }
  for(const path of paths.filter(path=>/\.olb$/i.test(path))) {
    const rel=relative(canonicalRoot,path).replaceAll('\\','/'),id=`owned:pspice:${rel}`,provenance=pspiceSnapshotSource(rel,sourceContext,'symbol')
    const asset:OfflineSymbolInventory['assets'][number]={id,sourceKey:'owned-pspice',relativePath:rel,name:basename(path),format:'olb',sha256:'',bytes:0,originalStored:true,symbolsAvailable:false,status:'unsupported',reason:''}
    result.assets.push(asset);result.paths.set(id,{path,source:provenance})
    let parts:ConvertedOlbPart[]|undefined
    try {
      asset.bytes=(await stat(path)).size;asset.sha256=await hashFile(path)
      parts=await readConvertedOlb(roots.libraryRoot,'pspice',rel,asset.sha256)
      asset.status=parts?.length?'converted':'unsupported';asset.symbolsAvailable=!!parts?.length;asset.convertedParts=parts?.length??0
      const cachePath=resolve(roots.convertedRoot,`${rel}.json`)
      let issues:string[]=[]
      if(symbolPathWithin(roots.convertedRoot,cachePath)) {
        try {
          const raw=JSON.parse(await readFile(cachePath,'utf8')) as {originalSha256?:string;issues?:{reason?:string}[];parts?:{unsupportedElectricalMapping?:boolean}[]}
          if(raw.originalSha256===asset.sha256) {
            issues=[...new Set((raw.issues??[]).map(issue=>issue.reason).filter((reason):reason is string=>typeof reason==='string'))].slice(0,4)
            const unresolved=raw.parts?.filter(part=>part.unsupportedElectricalMapping).length??0
            if(unresolved)issues.push(`${unresolved} 个多单元图形保留原始数据，未推断单元电气映射`)
          }
        } catch { /* No cache is not a reason to hide the stored original. */ }
      }
      asset.reason=parts?.length?`原件已保存，${parts.length} 个真实符号已转换；电气关联逐器件核对。`:'原件已保存；图形格式、单元选择或界面引脚范围暂不支持，不能冒充已导入。'
      if(issues.length)asset.reason+=` ${issues.join('；')}`
    } catch(error) {asset.reason=(error as Error).message;continue}
    for(const part of parts??[]) {
      let linked:string|undefined,reason='',status:IndexedSymbol['status']='symbol-only'
      if(!part.electricalOrderVerified) {status='unsupported';reason='原始图形可查看；缺少完整、唯一的 PSpiceTemplate 电气端口映射'}
      else {
        const explicit=part.modelFile,preferred=explicit||basename(path).replace(/\.olb$/i,'.lib')
        let candidates=modelFiles.resolve(preferred,path,canonicalRoot)
        candidates=candidates.filter(candidate=>result.modelHeaders.get(candidate)?.headers.has(part.modelId.toLowerCase()))
        if(!candidates.length&&!explicit)candidates=owners.get(part.modelId.toLowerCase())??[]
        if(candidates.length!==1) {status='unsupported';reason=candidates.length?'相同型号存在多个原始模型来源，未自动选择':'未找到模板明确指定的原始 .SUBCKT 声明'}
        else {
          const headers=result.modelHeaders.get(candidates[0])!.headers,pins=headers.get(part.modelId.toLowerCase())!
          try {
            if(!originalSymbolForDeclaration(part.asy,part.modelId,pins,headers,false))throw new Error('原始符号与确切模型接口不匹配')
            linked=candidates[0];status='linked';reason='确切型号、原始 PSpiceTemplate 和实际 .SUBCKT 接口已核对'
          } catch(error) {status='unsupported';reason=(error as Error).message}
        }
      }
      result.symbols.push({id:`${id}#${encodeURIComponent(part.id)}`,name:part.name,description:part.asy.description,pinCount:part.asy.symbol.pins.length,prefix:part.asy.prefix,modelFile:linked?relative(canonicalRoot,linked).replaceAll('\\','/'):part.modelFile,status,reason:part.issues.length?`${reason}；${part.issues.join('；')}`:reason,path,format:'olb',convertedAsy:part.asy,physicalPinNumbers:part.physicalPinNumbers,originalSha256:asset.sha256,sourceRoot:canonicalRoot,source:linked?pspiceSnapshotSource(relative(canonicalRoot,linked).replaceAll('\\','/'),sourceContext,'model'):provenance,symbolSource:provenance,...(linked?{modelPath:linked}:{})})
    }
  }
  result.symbols.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}))
  for(const entry of result.symbols)if(entry.status==='linked'&&entry.modelPath&&entry.convertedAsy){
    const key=modelKey(entry.modelPath,entry.convertedAsy.spiceModel)
    result.byModel.set(key,[...(result.byModel.get(key)??[]),entry])
  }
  return result
}
const originalHashes=new Map<string,{stamp:string;promise:Promise<string>}>()
async function currentOriginalHash(path:string):Promise<string>{
  const info=await stat(path),stamp=`${info.size}:${info.mtimeMs}:${info.ctimeMs}`,key=resolve(path).toLowerCase()
  const cached=originalHashes.get(key)
  if(cached?.stamp===stamp)return cached.promise
  const promise=hashFile(path);originalHashes.set(key,{stamp,promise})
  promise.catch(()=>{if(originalHashes.get(key)?.promise===promise)originalHashes.delete(key)})
  return promise
}
async function inventory(libraryRoot=ownedPspiceSymbolRoots().libraryRoot):Promise<OwnedInventory> {
  let signature=''
  for(const path of [join(libraryRoot,'vendor','pspice','paths_manifest.json'),join(libraryRoot,'converted-symbols','pspice','conversion-summary.json')]) {
    try {const info=await stat(path);signature+=`${path}:${info.size}:${info.mtimeMs};`}catch {signature+='missing;'}
  }
  if(!cached||cached.root!==libraryRoot||cached.signature!==signature||Date.now()-cached.readAt>5*60_000) {
    const promise=indexOriginals(libraryRoot);cached={root:libraryRoot,signature,readAt:Date.now(),promise}
    promise.catch(()=>{if(cached?.promise===promise)cached=undefined})
  }
  return cached.promise
}
/** Includes every original OLB asset, even when its graphics cannot be decoded. */
export async function indexOwnedPspiceSymbolAssets(libraryRoot?:string):Promise<OfflineSymbolInventory> {return inventory(libraryRoot)}
export async function indexOwnedPspiceSymbols(libraryRoot?:string):Promise<IndexedSymbol[]> {return (await inventory(libraryRoot)).symbols}

/** sourcePath is relative to vendor/pspice, or an absolute path within it.
 * Require the actual ordered source declaration and exact model name; never
 * associate a drawing based on its title, package numbers, or pin count alone. */
export async function readOwnedPspiceSymbolForModel(sourcePath:string,id:string,pins:readonly string[],libraryRoot?:string):Promise<ModelSymbol|undefined> {
  if(!sourcePath||!id||!pins.length)return undefined
  const roots=ownedPspiceSymbolRoots(libraryRoot)
  try {
    const root=await realpath(roots.sourceRoot),path=resolve(root,sourcePath.replaceAll('\\','/'))
    const canonical=await realpath(path)
    if(!symbolPathWithin(root,canonical))return undefined
    const indexed=await inventory(roots.libraryRoot),candidates=indexed.byModel.get(modelKey(canonical,id))??[]
    if(!candidates.length)return undefined
    const headers=(await modelHeaders(canonical)).headers
    if(!sameSymbolModelPorts(headers.get(id.toLowerCase()),pins))return undefined
    const resolved=new Map<string,ModelSymbol>(),hashes=new Map<string,string>()
    for(const entry of candidates) {
      const hash=hashes.get(entry.path)??await currentOriginalHash(entry.path);hashes.set(entry.path,hash)
      if(hash!==entry.originalSha256||!entry.convertedAsy)continue
      const match=originalSymbolForDeclaration(entry.convertedAsy,id,pins,headers,false)
      if(match)resolved.set(JSON.stringify({pins:match.symbol.pins,physicalPins:match.symbol.physicalPins,geometry:match.symbol.geometry,annotations:match.symbol.annotations}),{...match.symbol,source:{label:entry.symbolSource?.label??`PSpice 本地符号 / ${relative(root,entry.path).replaceAll('\\','/')}`,sha256:hash}})
    }
    return resolved.size===1?[...resolved.values()][0]:undefined
  } catch {return undefined}
}
