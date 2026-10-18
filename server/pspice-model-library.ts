import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { LocalModelCatalog, LocalModelFile } from '../src/core/model-catalog'
import type { ModelDownloadPreview, ModelSearchCandidate } from '../src/core/model-search'
import { bjtInstanceModelIndex, decodeSpiceLibrary, type SpiceModelSource } from '../src/core/spice-models'
import { parseSpiceParameterAssignments, parseSubcircuitHeader, parseSubcircuitInstance } from '../src/core/spice-parameters'
import { parseModelLibraryPreview } from '../src/core/model-library-preview'
import { modelDeclarationMatch, selectModelDeclarations } from '../src/core/model-search-match'
import { ownedModelLibraryRoot } from './owned-model-library'
import { readOwnedPspiceSymbolForModel, readPspiceSnapshotSourceContext, pspiceSnapshotSource } from './owned-pspice-symbols'
import { enrichDeviceInfoFromLibrary, sharedDeviceInfoHeaderLines } from '../src/core/model-device-info'
import {enrichPspicePortProperties} from './pspice-device-properties'

export const PSPICE_MODEL_SOURCE_URL='https://www.cadence.com/en_US/home/tools/system-design-and-verification/analog-mixed-signal-simulation/pspice.html'
const OWNED_ROOT=join(ownedModelLibraryRoot(),'vendor/pspice')
const ELECTRICAL_ROOTS=['tools/pspice/library','pspice/library']
const MAX_ORIGINAL_BYTES=16*1024*1024,MAX_PREVIEW_BYTES=4*1024*1024
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const within=(root:string,path:string)=>{const part=relative(root,path);return !isAbsolute(part)&&part!=='..'&&!part.startsWith(`..\\`)&&!part.startsWith('../')}
const encryption=/\$CD[NK](?:ENC)?|<Encrypted Library>|^\s*\.(?:protect|unprotect)\b|BEGIN\s+ENCRYPTED/im
interface Declaration{name:string;kind:'model'|'subckt';text:string;comments:string[];line:number;encrypted:boolean}
interface RawLibrary{declarations:Declaration[];includes:string[];globalIssues:string[];copyright:string[];header:string[];encrypted:boolean}
interface FileEntry{path:string;relative:string;sha256:string;size:number;mtimeMs:number;names:string[];encryptedNames:Set<string>;source:SpiceModelSource;reason?:string}
interface LibraryIndex{root:string;files:FileEntry[];byId:Map<string,{file:FileEntry;name:string}>}
const identity=(file:FileEntry,name:string)=>sha(`${file.relative}\0${name.toLowerCase()}`)
let completed:LibraryIndex|undefined,completedAt=0,pendingIndex:Promise<LibraryIndex>|undefined
const rawCache=new Map<string,Promise<RawLibrary>>()
const rootCache=new Map<string,Promise<ModelDownloadPreview>>()

/** Keep original root boundaries. An encrypted root remains unavailable; a
 * separate plaintext root in the same physical file does not become encrypted.
 * Outside conditional/parameter scopes are rejected, never silently removed. */
function scanLibrary(text:string):RawLibrary{
  const declarations:Declaration[]=[],includes:string[]=[],globalIssues:string[]=[],lines=text.replace(/^\uFEFF/,'').split(/\r?\n/)
  let comments:string[]=[],block:string[]=[],blockComments:string[]=[],start=0,depth=0,model:Declaration|undefined
  const flushModel=()=>{if(model){declarations.push(model);model=undefined}}
  for(let index=0;index<lines.length;index++){
    const raw=lines[index],trimmed=raw.trim()
    if(depth){
      block.push(raw)
      if(/^\.subckt\b/i.test(trimmed))depth++
      if(/^\.ends\b/i.test(trimmed)&&--depth===0){const content=block.join('\n'),name=block[0].trim().split(/\s+/)[1]??'';declarations.push({name,kind:'subckt',text:content,comments:blockComments,line:start+1,encrypted:encryption.test(content)});block=[]}
      continue
    }
    if(!trimmed||trimmed.startsWith('*')){comments.push(raw);if(comments.length>140)comments.shift();continue}
    if(trimmed.startsWith('+')&&model){model.text+=`\n${raw}`;continue}
    flushModel()
    if(/^\.subckt\s+\S+/i.test(trimmed)){depth=1;block=[raw];blockComments=comments;comments=[];start=index;continue}
    if(/^\.model\s+\S+/i.test(trimmed)){model={name:trimmed.split(/\s+/)[1],kind:'model',text:raw,comments,line:index+1,encrypted:encryption.test(raw)};comments=[];continue}
    if(/^\.(?:include|inc|lib)\b/i.test(trimmed)){
      const match=trimmed.match(/^\.(?:include|inc|lib)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;]+))\s*(?:[;$].*)?$/i)
      const target=match?.[1]??match?.[2]??match?.[3]
      if(!target||/^\.lib\b/i.test(trimmed)&&!/[.\\/]/.test(target))globalIssues.push(`库区段或动态依赖尚未支持：${trimmed.slice(0,120)}`)
      else includes.push(target)
    }else if(/^\.(?:if|elseif|else|endif|control|endc|endl|param|func|global)\b/i.test(trimmed))globalIssues.push(`原件含全局条件、参数或控制上下文，不能单独提取模型：${trimmed.slice(0,120)}`)
    else if(encryption.test(trimmed))globalIssues.push('原件包含顶层加密或受保护内容；已完整保存，不能作为明文模型导入')
    else globalIssues.push(`原件含未知的顶层语句，不能忽略其模型语义：${trimmed.slice(0,120)}`)
    comments=[]
  }
  flushModel()
  if(depth){const content=block.join('\n');declarations.push({name:block[0]?.trim().split(/\s+/)[1]??'',kind:'subckt',text:content,comments:blockComments,line:start+1,encrypted:encryption.test(content)})}
  const firstDeclaration=lines.findIndex(line=>/^\s*\.(?:model|subckt)\b/i.test(line))
  return{declarations,includes,globalIssues:[...new Set(globalIssues)],copyright:lines.slice(0,100).filter(line=>/^\s*\*/.test(line)&&!encryption.test(line)),header:lines.slice(0,firstDeclaration<0?0:firstDeclaration).filter(line=>/^\s*\*/.test(line)&&!encryption.test(line)),encrypted:encryption.test(text)}
}

async function filesWithin(root:string){
  const files:string[]=[],stack=[root]
  while(stack.length){const directory=stack.pop()!;for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=join(directory,entry.name)
    if(entry.isDirectory())stack.push(path)
    else if(entry.isFile()&&/\.(?:lib|mod|cir|spice|sub)$/i.test(entry.name)){
      if(files.length>=3000)throw new Error('本地 PSpice 电气库超出 3000 文件索引上限；原件保留')
      const actual=await realpath(path);if(within(root,actual))files.push(actual)
    }
  }}return files.sort((a,b)=>a.localeCompare(b))
}
async function buildIndex():Promise<LibraryIndex>{
  let root:string
  try{root=await realpath(OWNED_ROOT)}catch{return{root:'',files:[],byId:new Map()}}
  const sourceContext=await readPspiceSnapshotSourceContext(root)
  const files:FileEntry[]=[],byId=new Map<string,{file:FileEntry;name:string}>(),seenPaths=new Set<string>()
  for(const child of ELECTRICAL_ROOTS){
    let electricalRoot:string
    try{electricalRoot=await realpath(join(root,child));if(!within(root,electricalRoot))continue}catch{continue}
    for(const path of await filesWithin(electricalRoot)){
      if(seenPaths.has(path))continue;seenPaths.add(path)
      const relativeFile=relative(root,path).replace(/\\/g,'/'),source=pspiceSnapshotSource(relativeFile,sourceContext,'model')
      let file:FileEntry={path,relative:relativeFile,sha256:'',size:0,mtimeMs:0,names:[],encryptedNames:new Set(),source}
      try{
        const info=await stat(path);file={...file,size:info.size,mtimeMs:info.mtimeMs}
        if(info.size>MAX_ORIGINAL_BYTES)throw new Error('PSpice 原件超过 16 MB 读取上限；原件完整保留')
        const bytes=await readFile(path),raw=scanLibrary(decodeSpiceLibrary(bytes));file.sha256=sha(bytes);file.names=[...new Set(raw.declarations.map(item=>item.name).filter(Boolean))];file.encryptedNames=new Set(raw.declarations.filter(item=>item.encrypted).map(item=>item.name.toLowerCase()))
        if(raw.globalIssues.length)file.reason=raw.globalIssues.slice(0,3).join('；')
        if(!file.names.length&&raw.encrypted)file.reason='厂商加密原件无公开电气定义；已完整保存，不能作为明文模型导入'
        file.source={...source,attribution:`${source.attribution}${source.attribution?.endsWith('。')?'':'。'}原文件 SHA-256：${file.sha256}`}
      }catch(error){file.reason=(error as Error).message}
      files.push(file);for(const name of file.names)byId.set(identity(file,name),{file,name})
    }
  }return{root,files,byId}
}
async function index(){
  if(pendingIndex)return pendingIndex
  if(completed&&Date.now()-completedAt<5*60_000)return completed
  const pending=buildIndex().then(value=>{completed=value;completedAt=Date.now();return value}).finally(()=>{if(pendingIndex===pending)pendingIndex=undefined});pendingIndex=pending;return pending
}
export function refreshPspiceLibraryIndex(){completedAt=0;rawCache.clear();rootCache.clear()}
async function rawFile(file:FileEntry){
  const info=await stat(file.path),key=`${file.path}:${info.size}:${info.mtimeMs}`
  let pending=rawCache.get(key)
  if(!pending){
    if(rawCache.size>=16)rawCache.delete(rawCache.keys().next().value!)
    pending=(async()=>{if(info.size>MAX_ORIGINAL_BYTES)throw new Error('PSpice 原件超过 16 MB 读取上限；原件保留');const bytes=await readFile(file.path);if(sha(bytes)!==file.sha256)throw new Error('PSpice 原件在索引后更改，请刷新本地库；没有沿用旧来源或引脚证据');return scanLibrary(decodeSpiceLibrary(bytes))})().catch(error=>{rawCache.delete(key);throw error});rawCache.set(key,pending)
  }return pending
}
async function declarationsFor(file:FileEntry){
  const library=await index(),active=new Set<string>(),visited=new Set<string>(),declarations=new Map<string,Declaration[]>(),roots:Declaration[]=[],copyright:string[]=[],sources:string[]=[];let totalBytes=0
  async function visit(current:FileEntry,depth:number){
    if(depth>8||visited.size>=32)throw new Error('PSpice 依赖超过 8 层或 32 文件上限；原件保留')
    if(active.has(current.path))throw new Error('PSpice 原件存在循环库依赖，未自动裁剪')
    if(visited.has(current.path))return
    if(current.reason)throw new Error(current.reason)
    totalBytes+=current.size;if(totalBytes>32*1024*1024)throw new Error('PSpice 依赖原件累计超过 32 MB 读取上限')
    visited.add(current.path);active.add(current.path);sources.push(`${current.relative} (${current.sha256})`)
    const raw=await rawFile(current);copyright.push(...raw.copyright)
    if(current===file)roots.push(...raw.declarations)
    for(const declaration of raw.declarations){const key=declaration.name.toLowerCase(),existing=declarations.get(key)??[];existing.push(declaration);declarations.set(key,existing)}
    for(const target of raw.includes){
      if(isAbsolute(target)||/[:\x00-\x1f{}$%?#]/.test(target))throw new Error(`PSpice 依赖是绝对或动态路径，不能自动展开：${target}`)
      const proposed=resolve(dirname(current.path),target.replace(/\\/g,'/')),actual=await realpath(proposed)
      if(!within(library.root,actual))throw new Error('PSpice 依赖超出软件自有的同一厂商库范围')
      const dependency=library.files.find(item=>item.path.toLowerCase()===actual.toLowerCase())
      if(!dependency)throw new Error(`PSpice 依赖没有登记为电气库原件：${target}`)
      await visit(dependency,depth+1)
    }active.delete(current.path)
  }
  await visit(file,0);return{declarations,roots,copyright:[...new Set(copyright)],sources,header:(await rawFile(file)).header}
}
function closureFor(name:string,data:Awaited<ReturnType<typeof declarationsFor>>){
  const ordered:Declaration[]=[],visited=new Set<string>(),active=new Set<string>()
  function visit(target:string){
    const key=target.toLowerCase();if(active.has(key))throw new Error(`PSpice 子电路循环引用 ${target}`);if(visited.has(key))return
    const definitions=data.declarations.get(key)
    if(!definitions?.length)throw new Error(`PSpice 子电路引用缺失的原始定义 ${target}`)
    if(definitions.length!==1)throw new Error(`PSpice 依赖中 ${target} 有多个同名定义，不能猜测版本`)
    const declaration=definitions[0];if(declaration.encrypted)throw new Error(`PSpice ${target} 是厂商 $CDNENC 加密模型；已完整保存，无法作为明文模型导入`)
    active.add(key)
    if(declaration.kind==='subckt'){
      const text=declaration.text.replace(/\r?\n\s*\+/g,' '),localModels=new Set<string>()
      for(const match of text.matchAll(/^\s*\.model\s+(\S+)/gim))localModels.add(match[1].toLowerCase())
      const modelIds=new Set([...data.declarations].filter(([,definitions])=>definitions.some(item=>item.kind==='model')).map(([name])=>name))
      const header=parseSubcircuitHeader(text.split(/\r?\n/)[0]),scope=new Set(header.parameters.map(parameter=>parameter.name.toLowerCase()))
      for(const match of text.matchAll(/^\s*\.param\s+([^\r\n]+)/gim))for(const parameter of parseSpiceParameterAssignments(match[1]))scope.add(parameter.name.toLowerCase())
      for(const match of text.matchAll(/^\s*[DQJM]\S*\s+[^\r\n]*/gim)){
        const parts=match[0].trim().split(/\s+/),kind=parts[0][0].toUpperCase()
        const position=kind==='Q'?bjtInstanceModelIndex(parts,new Set([...modelIds,...localModels]),scope):kind==='D'?3:kind==='M'?5:4
        const reference=position===undefined?undefined:parts[position]?.toLowerCase()
        if(reference&&!localModels.has(reference))visit(reference)
      }
      for(const match of text.matchAll(/^\s*X\S*\s+[^\r\n]*/gim)){
      // The instance target precedes PARAMS/default assignments; its last token
      // can be an override expression rather than the dependency name.
      // Share the electrical parser's grammar instead of dropping that edge.
      visit(parseSubcircuitInstance(match[0].trim()).target)
      }
    }
    active.delete(key);visited.add(key);ordered.push(declaration)
  }
  visit(name);return ordered
}
function makePreview(file:FileEntry,name:string,data:Awaited<ReturnType<typeof declarationsFor>>):ModelDownloadPreview{
  const blocks=closureFor(name,data),source={...file.source,attribution:`${file.source.attribution}。独立依赖闭包来自 ${data.sources.join('；')}`.slice(0,1000)}
  const text=[`* PSpice original ${file.relative} / ${name}`,`* Original SHA-256 ${file.sha256}`,...data.copyright,...blocks.flatMap(block=>[...block.comments.filter(comment=>!encryption.test(comment)),block.text])].join('\n')
  if(new TextEncoder().encode(text).length>MAX_PREVIEW_BYTES)throw new Error('PSpice 所选模型及原始依赖超过 4 MB 预览上限；未删除参数或依赖')
  const parsed=parseModelLibraryPreview(text,source),model=parsed.models.find(item=>item.id.toLowerCase()===name.toLowerCase())
  if(!model)throw new Error(parsed.diagnostics.filter(issue=>!issue.model||issue.model.toLowerCase()===name.toLowerCase()).slice(0,4).map(issue=>issue.message).join('；')||'PSpice 原件未通过完整电气兼容检查')
  if(parsed.diagnostics.some(issue=>issue.severity==='error'))throw new Error(parsed.diagnostics.filter(issue=>issue.severity==='error').slice(0,4).map(issue=>issue.message).join('；'))
  // Canonical code drops comments. Retain root evidence separately, excluding
  // dependency descriptions and other devices' comments from the broad preview.
  const root=blocks.find(block=>block.name.toLowerCase()===name.toLowerCase())!
  delete model.deviceInfo
  enrichDeviceInfoFromLibrary([model],[...sharedDeviceInfoHeaderLines(data.header,source),...root.comments,root.text].join('\n'),source,file.sha256)
  // The parser's canonical spice already contains every electrical dependency.
  // Replaying this focused text uses the same original nodes and parameters.
  return{...parsed,source,text}
}
async function attachOriginalSymbol(file:FileEntry,name:string,preview:ModelDownloadPreview){
  const model=preview.models.find(item=>item.id.toLowerCase()===name.toLowerCase())
  if(model?.kind==='X'){
    await enrichPspicePortProperties(model,file.path,(await index()).root)
    const symbol=await readOwnedPspiceSymbolForModel(file.relative,model.id,model.pins)
    if(symbol)model.symbol=symbol
  }return preview
}
export async function readPspiceModelPreview(id:string):Promise<ModelDownloadPreview|undefined>{
  if(!/^[a-f0-9]{64}$/.test(id))return undefined
  const entry=(await index()).byId.get(id);if(!entry)return undefined
  const info=await stat(entry.file.path),key=`${id}:${entry.file.sha256}:${info.size}:${info.mtimeMs}:${completedAt}`;let pending=rootCache.get(key)
  if(!pending){if(rootCache.size>=96)rootCache.delete(rootCache.keys().next().value!);pending=declarationsFor(entry.file).then(data=>attachOriginalSymbol(entry.file,entry.name,makePreview(entry.file,entry.name,data))).catch(error=>{rootCache.delete(key);throw error});rootCache.set(key,pending)}
  return pending
}
async function registeredFile(sourcePath:string){
  const library=await index();if(!library.root||!sourcePath)return undefined
  let actual:string
  try{actual=await realpath(isAbsolute(sourcePath)?sourcePath:resolve(library.root,sourcePath.replace(/\\/g,'/')))}catch{return undefined}
  if(!within(library.root,actual))return undefined
  return library.files.find(file=>file.path.toLowerCase()===actual.toLowerCase())
}
/** Symbol review and electrical import share these exact original headers. */
export async function readPspicePublicDeclarationHeaders(sourcePath:string):Promise<{name:string;kind:'model'|'subckt';pins:string[];encrypted:boolean;id:string;source:SpiceModelSource}[]>{
  const file=await registeredFile(sourcePath);if(!file)return []
  const raw=await rawFile(file)
  return raw.declarations.map(declaration=>{
    const header=declaration.text.replace(/\r?\n\s*\+/g,' ').split(/\r?\n/,1)[0].trim()
    let pins:string[]=[]
    // Retain unsupported original declarations in inventory, but never infer
    // electrical ports from a header the shared parser cannot understand.
    if(declaration.kind==='subckt')try{pins=parseSubcircuitHeader(header).pins}catch{ /* Original remains available with no verified pin map. */ }
    return{name:declaration.name,kind:declaration.kind,pins,encrypted:declaration.encrypted,id:identity(file,declaration.name),source:file.source}
  })
}
export async function readPspiceModelPreviewForDeclaration(sourcePath:string,name:string):Promise<ModelDownloadPreview|undefined>{
  const file=await registeredFile(sourcePath);if(!file||!file.names.some(item=>item.toLowerCase()===name.toLowerCase()))return undefined
  return readPspiceModelPreview(identity(file,name))
}
export async function lookupPspiceModels(query:string):Promise<ModelSearchCandidate[]>{
  const matches:ModelSearchCandidate[]=[],library=await index()
  for(const file of library.files){const selection=selectModelDeclarations(file.names,query,8,file.source);if(!selection.names.length)continue
    let data:Awaited<ReturnType<typeof declarationsFor>>|undefined,fileReason:string|undefined
    try{data=await declarationsFor(file)}catch(error){fileReason=(error as Error).message}
    for(const name of selection.names){
      let reason=fileReason,ready=false
      // Checking electrical availability must never trigger a cold all-OLB scan.
      // The selected preview and catalog both attach original symbols afterward.
      if(data)try{makePreview(file,name,data);ready=true}catch(error){reason=(error as Error).message}
      matches.push({id:identity(file,name),name,path:file.relative,source:file.source,matchedModels:[name],origin:'local-library',match:modelDeclarationMatch(name,query,file.source),availability:ready?'ready':'unsupported',reason})
    }
  }return matches.sort((a,b)=>Number(b.match==='exact')-Number(a.match==='exact')||Number(b.availability==='ready')-Number(a.availability==='ready')).slice(0,40)
}
export async function readPspiceModelCatalog():Promise<LocalModelCatalog>{
  const library=await index(),catalog:LocalModelCatalog={models:[],files:[]}
  if(!library.files.length){catalog.files.push({file:'PSpice 电气库',label:'本地 PSpice',source:PSPICE_MODEL_SOURCE_URL,packageId:'pspice',available:false,accepted:0,rejected:0,issues:[{message:'软件自有目录尚未复制 PSpice 电气原件；其他来源继续可用',count:1}]});return catalog}
  for(const file of library.files){
    const record:LocalModelFile={file:file.relative,label:file.source.label,source:PSPICE_MODEL_SOURCE_URL,packageId:'pspice',available:true,accepted:0,rejected:0,issues:[]},reasons=new Map<string,number>()
    if(!file.names.length&&!file.reason){catalog.files.push(record);continue}
    try{
      const data=await declarationsFor(file)
      for(const name of file.names){try{const preview=await attachOriginalSymbol(file,name,makePreview(file,name,data)),model=preview.models.find(item=>item.id.toLowerCase()===name.toLowerCase())!;catalog.models.push(model);record.accepted++}catch(error){record.rejected++;const reason=(error as Error).message;reasons.set(reason,(reasons.get(reason)??0)+1)}}
    }catch(error){record.rejected=file.names.length;reasons.set((error as Error).message,Math.max(1,record.rejected))}
    record.issues=[...reasons].slice(0,12).map(([message,count])=>({message,count}));catalog.files.push(record)
  }return catalog
}
export async function readPspiceLibraryInventory(){const library=await index();return{installed:!!library.files.length,root:library.root,modelFiles:library.files.length,publicDeclarations:library.files.reduce((sum,file)=>sum+file.names.length,0),encryptedDeclarations:library.files.reduce((sum,file)=>sum+file.encryptedNames.size,0),unreadableFiles:library.files.filter(file=>file.reason).length}}
