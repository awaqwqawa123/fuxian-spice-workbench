import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { LocalModelCatalog, LocalModelFile } from '../src/core/model-catalog'
import type { ModelDownloadPreview, ModelSearchCandidate } from '../src/core/model-search'
import { decodeSpiceLibrary, type SpiceModelSource } from '../src/core/spice-models'
import { parseModelLibraryPreview } from '../src/core/model-library-preview'
import { modelDeclarationMatch, selectModelDeclarations } from '../src/core/model-search-match'
import { ownedModelLibraryRoot } from './owned-model-library'

export const TINA_MODEL_SOURCE_URL='https://www.ti.com/tool/TINA-TI'
export interface TinaSymbolEvidence {name:string;pins:string[];electricalPins:string[];portMapping:{electricalPin:string;alias:string;label:string}[];category:string;deviceReference:string;indexFile:string;portsVerified:boolean;terminalComments:string[]}
interface TinaFile {path:string;relative:string;size:number;mtimeMs:number;source:SpiceModelSource;names:string[];declarations:Map<string,string[]>;symbols:Map<string,TinaSymbolEvidence>;sha256:string;unsupportedReason?:string}
interface TinaIndex {root:string;modelRoot:string;macroRoot:string;databaseRoot:string;files:TinaFile[];byId:Map<string,{file:TinaFile;name:string}>;formats:Record<string,number>;symbolCategories:Record<string,number>}
interface ParsedFile {file:TinaFile;text:string;preview:ModelDownloadPreview}
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const within=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||!rel.startsWith('..')&&!isAbsolute(rel)}
const fileId=(file:TinaFile,name:string)=>hash(`owned:tina\0${file.relative.toLowerCase()}\0${name.toLowerCase()}`)
let completedIndex:TinaIndex|undefined,indexCompletedAt=0,indexPending:Promise<TinaIndex>|undefined
const previews=new Map<string,Promise<ParsedFile>>()
async function installedLayout(){
  const root=join(ownedModelLibraryRoot(),'vendor','tina')
  try{const directory=join(root,'SPICELIB');if((await stat(directory)).isDirectory())return{root:await realpath(root),modelRoot:await realpath(directory),macroRoot:join(root,'MACROLIB'),databaseRoot:root}}catch{/* An absent owned snapshot never falls back to another software installation. */}
  return undefined
}
async function listFiles(root:string,pattern:RegExp,limit=2500):Promise<string[]>{
  const result:string[]=[],stack=[root]
  while(stack.length){const directory=stack.pop()!;for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=join(directory,entry.name)
    if(entry.isDirectory())stack.push(path)
    else if(entry.isFile()&&pattern.test(entry.name)){
      if(result.length>=limit)throw new Error('本机 TINA 文件数超过目录扫描上限')
      const canonical=await realpath(path);if(within(root,canonical))result.push(canonical)
    }
  }}return result.sort((a,b)=>a.localeCompare(b))
}
function declarationPorts(text:string){
  const declarations=new Map<string,string[]>()
  for(const match of text.replace(/\r?\n\s*\+/g,' ').matchAll(/^\s*\.(subckt|model)\s+(\S+)\s+([^\r\n]*)/gim)){
    const parts=match[3].trim().split(/\s+/),boundary=parts.findIndex(part=>/^params?:?$/i.test(part)||part.includes('=')||/^[;$]/.test(part))
    declarations.set(match[2],match[1].toLowerCase()==='subckt'?(boundary<0?parts:parts.slice(0,boundary)):[])
  }return declarations
}
function commentsForRoot(text:string,name:string){
  const lines=text.split(/\r?\n/),index=lines.findIndex(line=>{const match=line.match(/^\s*\.subckt\s+(\S+)/i);return match?.[1].toLowerCase()===name.toLowerCase()})
  if(index<0)return []
  const comments:string[]=[]
  for(let position=index-1;position>=0&&comments.length<120;position--){if(lines[position].trim()&&!/^\s*\*/.test(lines[position]))break;comments.unshift(lines[position])}
  return comments
}
function terminalCommentIndex(original:string){
  const result=new Map<string,string[]>(),lines=original.split(/\r?\n/);let preceding:string[]=[]
  for(const line of lines){
    const match=line.match(/^\s*\.subckt\s+(\S+)/i)
    if(match)result.set(match[1].toLowerCase(),preceding.filter(comment=>/pinout|connect|input|output|anode|cathode|reference|supply|positive|negative|non.invert|invert/i.test(comment)))
    if(!line.trim()||/^\s*\*/.test(line)){preceding.push(line);if(preceding.length>120)preceding.shift()}else preceding=[]
  }return result
}
function sidecarEvidence(text:string,indexFile:string,declarations:Map<string,string[]>,original:string){
  const result=new Map<string,TinaSymbolEvidence>()
  const comments=terminalCommentIndex(original),declaredByName=new Map([...declarations].map(([name,pins])=>[name.toLowerCase(),pins]))
  for(const line of text.split(/\r?\n/)){
    const match=line.match(/^\s*(SUBCKT|MODEL)\s+(\S+)\s+(.*?)\s*\[([^\]]+)\]/i)
    if(!match||match[4].toLowerCase()==='internal')continue
    const parts=match[3].trim().split(/\s+/).filter(Boolean),reference=parts.find(part=>part.includes(':'))??'',ports=match[1].toUpperCase()==='SUBCKT'?parts.filter(part=>!part.includes(':')&&!/^<.*>$/.test(part)):[]
    const declared=declaredByName.get(match[2].toLowerCase())
    const sameCount=!!declared&&declared.length===ports.length
    // Numeric index nodes are electrical identities, not display aliases: a
    // reordered row must never be approved merely because its length matches.
    const numericNodes=ports.some(pin=>/^\d+$/.test(pin))
    const verified=sameCount&&(!numericNodes||ports.every((pin,index)=>pin.toLowerCase()===declared[index].toLowerCase()))
    // A paired TLD lists display aliases in the original SUBCKT port order;
    // Q1=Ref is a label, never a replacement electrical node.
    const portMapping=verified?declared.map((electricalPin,index)=>{const pair=ports[index].split('=');return{electricalPin,alias:pair[0],label:pair.slice(1).join('=')||pair[0]}}):[]
    result.set(match[2].toLowerCase(),{name:match[2],pins:ports,electricalPins:declared??[],portMapping,category:match[4],deviceReference:reference,indexFile,portsVerified:verified,terminalComments:comments.get(match[2].toLowerCase())??[]})
  }return result
}
async function buildIndex():Promise<TinaIndex>{
  const layout=await installedLayout(),files:TinaFile[]=[],byId=new Map<string,{file:TinaFile;name:string}>(),formats:Record<string,number>={},symbolCategories:Record<string,number>={}
  if(!layout)return{root:'',modelRoot:'',macroRoot:'',databaseRoot:'',files,byId,formats,symbolCategories}
  const paths=await listFiles(layout.modelRoot,/\.(?:lib|mod|cir|spice|sub)$/i)
  for(const path of paths){
    const info=await stat(path),relativeFile=relative(layout.modelRoot,path).replace(/\\/g,'/'),ext=path.split('.').at(-1)!.toLowerCase();formats[ext]=(formats[ext]??0)+1
    const source:SpiceModelSource={label:`TINA 本地库 / SPICELIB/${relativeFile}`,url:TINA_MODEL_SOURCE_URL,license:'TINA 厂商模型本地副本；沿用原作者与厂商条款，原件保留完整版权和免责声明',attribution:'伏安软件自有目录内的 TINA 原件副本；模型的来源、限制、有效条件及仿真选项见原文件注释'}
    let text='',sha256='',unsupportedReason:string|undefined
    try{
      if(info.size>4*1024*1024)throw new Error('TINA 原件超过 4 MB 导入上限；原件完整保留')
      const bytes=await readFile(path);sha256=hash(bytes)
      if(bytes.subarray(0,256).toString('ascii').trimStart().startsWith('<Encrypted Library>'))throw new Error('TINA 原件是厂商加密库（<Encrypted Library>）；已保存原件和索引，不能作为明文 SPICE 导入')
      text=decodeSpiceLibrary(bytes)
      if(/^\s*\.protect\b/im.test(text))throw new Error('TINA 原件含 .protect 加密模型；已保存原件，不能作为明文 SPICE 导入')
    }catch(error){unsupportedReason=(error as Error).message}
    const declarations=declarationPorts(text),indexPath=path.replace(/\.[^.]+$/,'.tld')
    let symbols=new Map<string,TinaSymbolEvidence>()
    try{if((await stat(indexPath)).size<=1024*1024){symbols=sidecarEvidence(decodeSpiceLibrary(await readFile(indexPath)),`SPICELIB/${relativeFile.replace(/\.[^.]+$/,'.tld')}`,declarations,text);formats.tld=(formats.tld??0)+1}}catch{/* No sidecar never licenses guessing a symbol or pin order. */}
    for(const evidence of symbols.values())symbolCategories[evidence.category]=(symbolCategories[evidence.category]??0)+1
    const names=symbols.size?[...symbols.values()].map(symbol=>symbol.name):[...declarations.keys()]
    const file:TinaFile={path,relative:`SPICELIB/${relativeFile}`,size:info.size,mtimeMs:info.mtimeMs,source:{...source,attribution:`${source.attribution}。原文件 SHA-256：${sha256||'文件超限，仍保留原件'}`},names,declarations,symbols,sha256,unsupportedReason}
    files.push(file);for(const name of names){
      const entry={file,name};byId.set(fileId(file,name),entry)
      // Previously displayed results used an installation-absolute identity.
      // Resolve those IDs to the owned copy without reading the installation.
      for(const legacyPath of [join('E:/TINA',file.relative),join('E:/spice-workbench-library/tina-extracted/Spice_Libraries_(Texas)',relativeFile),file.path])byId.set(hash(`${legacyPath}\0${name.toLowerCase()}`),entry)
    }
  }
  return{...layout,files,byId,formats,symbolCategories}
}
export function refreshTinaLibraryIndex(){indexCompletedAt=0;previews.clear()}
async function index(){
  if(indexPending)return indexPending
  if(completedIndex&&Date.now()-indexCompletedAt<5*60_000)return completedIndex
  const pending=buildIndex().then(value=>{completedIndex=value;indexCompletedAt=Date.now();return value}).finally(()=>{if(indexPending===pending)indexPending=undefined})
  indexPending=pending;return pending
}
async function expandedText(path:string,root:string,expectedHash:string){
  const seen=new Set<string>(),active=new Set<string>(),dependencies:string[]=[];let total=0
  async function visit(current:string,depth:number):Promise<string>{
    const canonical=await realpath(current)
    if(!within(root,canonical))throw new Error('TINA 依赖超出同一安装 SPICELIB 目录')
    if(depth>8||seen.size>=16||active.has(canonical)||seen.has(canonical))throw new Error('TINA 依赖循环、重复或超过 8 层 / 16 文件限制；原件已保留')
    seen.add(canonical);active.add(canonical);dependencies.push(relative(root,canonical).replace(/\\/g,'/'))
    const bytes=await readFile(canonical);total+=bytes.length;if(bytes.length>4*1024*1024||total>4*1024*1024)throw new Error('TINA 原件及依赖超过当前 4 MB 导入上限，未裁剪网络')
    if(depth===0&&expectedHash&&hash(bytes)!==expectedHash)throw new Error('TINA 原件在索引后发生更改；请刷新本地库后重试，未使用旧校验信息')
    if(bytes.subarray(0,256).toString('ascii').trimStart().startsWith('<Encrypted Library>'))throw new Error('TINA 原件或依赖是厂商加密库（<Encrypted Library>）；保留原件，不能作为明文 SPICE 导入')
    const original=decodeSpiceLibrary(bytes)
    if(/^\s*\.protect\b/im.test(original))throw new Error('TINA 原件或依赖含 .protect 加密模型；保留原件，不能作为明文 SPICE 导入')
    const lines:string[]=[]
    for(const line of original.split(/\r?\n/)){
      if(!/^\s*\.(?:include|inc)\b/i.test(line)){lines.push(line);continue}
      const match=line.match(/^\s*\.(?:include|inc)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;]+))\s*(?:[;$].*)?$/i),target=match?.[1]??match?.[2]??match?.[3]
      if(!target||isAbsolute(target)||/[:\x00-\x1f{}$%?#]/.test(target))throw new Error('TINA 依赖是动态、绝对或未登记路径，不能自动展开')
      lines.push(`* TINA included original: ${target}`,await visit(resolve(dirname(canonical),target.replace(/\\/g,'/')),depth+1))
    }active.delete(canonical);return lines.join('\n')
  }return{text:await visit(path,0),dependencies}
}
async function parsedFile(file:TinaFile):Promise<ParsedFile>{
  if(file.unsupportedReason)throw new Error(file.unsupportedReason)
  const info=await stat(file.path),key=`${file.path}:${info.size}:${info.mtimeMs}`
  let pending=previews.get(key)
  if(!pending){
    if(previews.size>=12)previews.delete(previews.keys().next().value!)
    pending=(async()=>{const library=await index(),expanded=await expandedText(file.path,library.modelRoot,file.sha256),source={...file.source,attribution:`${file.source.attribution}。同目录依赖：${expanded.dependencies.join('、')}`.slice(0,1000)},text=expanded.text;return{file,text,preview:{...parseModelLibraryPreview(text,source),source,text}}})().catch(error=>{previews.delete(key);throw error})
    previews.set(key,pending)
  }return pending
}
export async function lookupTinaModels(query:string):Promise<ModelSearchCandidate[]>{
  const library=await index(),matches:ModelSearchCandidate[]=[]
  for(const file of library.files){
    const selected=selectModelDeclarations(file.names,query)
    if(!selected.names.length)continue
    let parsed:ParsedFile|undefined,error:string|undefined
    try{parsed=await parsedFile(file)}catch(reason){error=(reason as Error).message}
    for(const name of selected.names){
      const model=parsed?.preview.models.find(model=>model.id.toLowerCase()===name.toLowerCase()),evidence=file.symbols.get(name.toLowerCase())
      const reason=error??parsed?.preview.diagnostics.filter(item=>item.severity==='error'&&(!item.model||item.model.toLowerCase()===name.toLowerCase())).slice(0,3).map(item=>item.message).join('；')??''
      const portsMismatch=model&&evidence&&!evidence.portsVerified
      matches.push({id:fileId(file,name),name,path:file.relative,source:file.source,matchedModels:[name],origin:'local-library',match:modelDeclarationMatch(name,query),availability:model&&!portsMismatch?'ready':'unsupported',reason:portsMismatch?'TINA 原索引端口与同文件电气定义不一致，未猜测符号映射':model?undefined:reason||'原件中未找到自包含且兼容的完整模型定义'})
    }
  }return matches.sort((a,b)=>Number(b.match==='exact')-Number(a.match==='exact')||Number(b.availability==='ready')-Number(a.availability==='ready')).slice(0,40)
}
/** Return one selected root's full canonical dependency closure, never hundreds
 * of unrelated devices from a large original manufacturer library. */
export async function readTinaModelPreview(id:string):Promise<ModelDownloadPreview|undefined>{
  if(!/^[a-f0-9]{64}$/.test(id))return undefined
  const entry=(await index()).byId.get(id);if(!entry)return undefined
  const parsed=await parsedFile(entry.file),model=parsed.preview.models.find(model=>model.id.toLowerCase()===entry.name.toLowerCase())
  if(!model)throw new Error(parsed.preview.diagnostics.filter(issue=>issue.model?.toLowerCase()===entry.name.toLowerCase()).map(issue=>issue.message).join('；')||'TINA 模型未通过完整原件兼容性检查')
  const evidence=entry.file.symbols.get(entry.name.toLowerCase())
  if(evidence&&!evidence.portsVerified)throw new Error('TINA 索引引脚与同文件原始声明不一致；禁止猜测端口')
  const originalComments=commentsForRoot(parsed.text,entry.name)
  const copyright=parsed.text.split(/\r?\n/).slice(0,100).filter(line=>/^\s*\*/.test(line))
  const text=[`* TINA selected original ${entry.file.relative} / ${entry.name}`,`* Original SHA-256 ${entry.file.sha256}`,`* Canonical self-contained electrical definition; original parameters and dependencies retained.`,...copyright,...originalComments,model.spice].join('\n')
  const preview={...parseModelLibraryPreview(text,parsed.preview.source),source:parsed.preview.source,text}
  if(!preview.models.some(item=>item.id===model.id&&item.spice===model.spice)||preview.diagnostics.some(issue=>issue.severity==='error'))throw new Error('TINA 选中模型的完整依赖闭包无法无损重放，原件保留')
  return preview
}
export async function readTinaModelCatalog():Promise<LocalModelCatalog>{
  const library=await index(),catalog:LocalModelCatalog={models:[],files:[]}
  if(!library.root){catalog.files.push({file:'TINA SPICELIB',label:'TINA 本地库',source:TINA_MODEL_SOURCE_URL,packageId:'tina',available:false,accepted:0,rejected:0,issues:[{message:'伏安软件本地目录缺少 TINA 库副本；其他本地库继续可用',count:1}]});return catalog}
  for(const file of library.files){
    const record:LocalModelFile={file:file.relative,label:file.source.label,source:TINA_MODEL_SOURCE_URL,packageId:'tina',available:true,accepted:0,rejected:0,issues:[]}
    try{
      const parsed=await parsedFile(file),publicNames=new Set(file.names.map(name=>name.toLowerCase())),models=parsed.preview.models.filter(model=>publicNames.has(model.id.toLowerCase())&&file.symbols.get(model.id.toLowerCase())?.portsVerified!==false)
      catalog.models.push(...models);record.accepted=models.length;record.rejected=file.names.filter(name=>!models.some(model=>model.id.toLowerCase()===name.toLowerCase())).length
      const reasons=new Map<string,number>()
      for(const issue of parsed.preview.diagnostics.filter(item=>item.severity==='error'))reasons.set(issue.message,(reasons.get(issue.message)??0)+1)
      const mismatched=parsed.preview.models.filter(model=>publicNames.has(model.id.toLowerCase())&&file.symbols.get(model.id.toLowerCase())?.portsVerified===false).length
      if(mismatched)reasons.set('TINA 配对 TLD 的端口数量与原始电气定义不一致；原件保留，未猜测符号映射',mismatched)
      record.issues=[...reasons].slice(0,8).map(([message,count])=>({message,count}))
    }catch(error){record.rejected=Math.max(1,file.names.length);record.issues=[{message:(error as Error).message,count:1}]}
    catalog.files.push(record)
  }return catalog
}
export async function readTinaSymbolEvidence(sourceLabel:string,modelId:string):Promise<TinaSymbolEvidence|undefined>{
  const normalized=sourceLabel.replace(/^本机 TINA \/ /,'TINA 本地库 / ')
  const file=(await index()).files.find(file=>file.source.label===normalized)
  return file?.symbols.get(modelId.toLowerCase())
}
export async function readTinaLibraryInventory(){
  const library=await index(),formats={...library.formats},nativeSymbols:{file:string;bytes:number;signature:string;status:string}[]=[]
  for(const[root,pattern]of(library.root?[[library.macroRoot,/\.(?:tsm|ms)$/i],[library.databaseRoot,/\.ddb$/i]]:[]) as readonly (readonly [string,RegExp])[]){
    try{for(const file of await listFiles(root,pattern,300)){
      const bytes=await readFile(file),ext=basename(file).split('.').at(-1)!.toLowerCase();formats[ext]=(formats[ext]??0)+1
      nativeSymbols.push({file:relative(library.root,file).replace(/\\/g,'/'),bytes:bytes.length,signature:bytes.subarray(0,4).toString('ascii'),status:bytes.subarray(0,4).toString('ascii')==='OBSS'?'TINA OBSS 原生二进制；原件已保存，尚未核实完整图形/电气端口序列格式，未伪造为已导入图形':'原生符号格式尚未支持，原件已保存'})
    }}catch{/* A library without macro/database folders still provides SPICE. */}
  }
  return{installed:!!library.root,root:library.root,modelFiles:library.files.length,encryptedFiles:library.files.filter(file=>file.unsupportedReason?.includes('加密')).length,publicDeclarations:library.files.reduce((n,file)=>n+file.names.length,0),formats,symbolCategories:library.symbolCategories,nativeSymbols}
}
