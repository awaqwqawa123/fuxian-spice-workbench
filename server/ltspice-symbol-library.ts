import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { Plugin } from 'vite'
import { decodeSpiceLibrary } from '../src/core/spice-models'
import { parseLtspiceAsy, type LtspiceAsy } from '../src/core/ltspice-symbol'
import type { SpiceModelSource } from '../src/core/spice-models'
import { createOfflineSymbolMiddleware, indexOfflineSymbols, readOfflineSymbolModel } from './offline-symbol-library'
import { asyModelFile, asyModelNames, createSymbolModelFileIndex, originalSymbolForDeclaration, parseSymbolModelHeaders, symbolPathWithin, SYMBOL_MODEL_EXTENSIONS } from './original-symbol-link'
import { indexOwnedPspiceSymbols } from './owned-pspice-symbols'
import { ownedModelLibraryRoot } from './owned-model-library'

const sourceUrl='https://www.analog.com/en/resources/design-tools-and-calculators/ltspice-simulator.html'
export const ltspiceSymbolSource={label:'本机 LTspice 符号与模型',url:sourceUrl,license:'来自用户本机 LTspice 安装；依原厂条款使用，工作台不附带或分发此库',attribution:'器件与模型作者见本机 LTspice 原始文件'}
export interface LocalSymbolEntry { id:string; name:string; description:string; pinCount:number; prefix:string; modelFile:string; status:'linked'|'symbol-only'|'unsupported'; reason:string; format?:'asy'|'olb' }
export interface IndexedSymbol extends LocalSymbolEntry { path:string; modelPath?:string; source?:SpiceModelSource; symbolSource?:SpiceModelSource; sourceRoot?:string; originalSha256?:string; convertedAsy?:LtspiceAsy; physicalPinNumbers?:string[] }
export interface LocalSymbolCatalog { total:number; items:LocalSymbolEntry[] }
export interface LocalSymbolDetail { item:LocalSymbolEntry; asy:LtspiceAsy; modelText?:string; modelError?:string; sourceFile?:string; source:SpiceModelSource; symbolSource?:SpiceModelSource; physicalPinNumbers?:string[] }

export function localLtspiceRoots(){
  const local=process.env.LOCALAPPDATA||join(homedir(),'AppData','Local')
  const owned=join(ownedModelLibraryRoot(),'vendor','ltspice','lib'),installed=join(local,'LTspice','lib')
  // Owned originals are authoritative, including unsupported symbols. Only a
  // missing directory falls back; parser failures never substitute geometry.
  return {symbolRoot:join(existsSync(join(owned,'sym'))?owned:installed,'sym'),modelRoot:join(existsSync(join(owned,'sub'))?owned:installed,'sub')}
}
async function filesWithin(root:string,extension:RegExp,limit:number):Promise<string[]>{
  const found:string[]=[],stack=[root]
  while(stack.length){
    const directory=stack.pop()!
    let entries;try{entries=await readdir(directory,{withFileTypes:true})}catch{continue}
    for(const entry of entries){
      const path=join(directory,entry.name)
      if(entry.isDirectory())stack.push(path)
      else if(entry.isFile()&&extension.test(entry.name)){found.push(path);if(found.length>=limit)return found}
    }
  }
  return found
}
function publicEntry(entry:IndexedSymbol):LocalSymbolEntry {const {id,name,description,pinCount,prefix,modelFile,status,reason,format}=entry;return{id,name,description,pinCount,prefix,modelFile,status,reason,...(format?{format}:{})}}
export async function indexLocalLtspiceSymbols(roots=localLtspiceRoots()):Promise<IndexedSymbol[]> {
  const [symbolPaths,modelPaths]=await Promise.all([filesWithin(roots.symbolRoot,/\.asy$/i,12000),filesWithin(roots.modelRoot,SYMBOL_MODEL_EXTENSIONS,12000)])
  const models=createSymbolModelFileIndex(modelPaths)
  const entries:IndexedSymbol[]=[]
  const unbound:{entry:IndexedSymbol;asy:LtspiceAsy}[]=[]
  const modelInfo=new Map<string,{issue:string;headers:Map<string,string[]>}>()
  async function declarations(path:string){
    let result=modelInfo.get(path)
    if(result)return result
    result={issue:'',headers:new Map()}
    const actual=await realpath(path),root=await realpath(roots.modelRoot)
    if(!symbolPathWithin(root,actual))result.issue='关联模型原件超出同一本机安装目录'
    else if((await stat(actual)).size>4*1024*1024)result.issue='关联 SPICE 文件超过 4 MB，不能导入'
    else{
      const text=decodeSpiceLibrary(await readFile(actual))
      if(/<binary file>|\x00|\.protect\b|BEGIN\s+ENCRYPTED/i.test(text))result.issue='关联模型受保护或加密，不能导入 ngspice'
      else result.headers=parseSymbolModelHeaders(text)
    }
    modelInfo.set(path,result);return result
  }
  for(const path of symbolPaths){
    try{
      const info=await stat(path);if(info.size>128*1024)continue
      const symbolBytes=await readFile(path),asy=parseLtspiceAsy(decodeSpiceLibrary(symbolBytes),path.slice(path.lastIndexOf(sep)+1).replace(/\.asy$/i,''))
      const id=relative(roots.symbolRoot,path).replaceAll('\\','/').replace(/\.asy$/i,'')
      const modelFile=asyModelFile(asy),linked=models.resolve(modelFile,path,roots.modelRoot)
      let status:LocalSymbolEntry['status']='symbol-only',reason='未找到关联的本机 .subckt 模型文件'
      if(asy.prefix.toUpperCase()!=='X'){status='unsupported';reason='此符号不是 .subckt 实例（Prefix 不是 X）；不能当成多引脚子电路导入'}
      else if(modelFile&&linked.length===1){
        const model=await declarations(linked[0])
        const names=asyModelNames(asy),matching=names.some(name=>{const pins=model.headers.get(name);return !!pins&&!!originalSymbolForDeclaration(asy,name,pins,model.headers,false)})
        const issue=model.issue||(!matching?'关联原件缺少 ASY 指定的唯一 .subckt 声明，或 SpiceOrder 端口不匹配':'')
        status=issue?'unsupported':'linked';reason=issue||'找到关联文件；还需通过 SPICE 兼容性及端口顺序检查'
      }
      else if(linked.length>1){status='unsupported';reason='关联文件重名，无法安全确定模型来源'}
      const entry:IndexedSymbol={id,name:asy.value||asy.value2||id.split('/').at(-1)!,description:asy.description,pinCount:asy.symbol.pins.length,prefix:asy.prefix,modelFile,status,reason,path,originalSha256:createHash('sha256').update(symbolBytes).digest('hex'),sourceRoot:roots.modelRoot,...(status==='linked'?{modelPath:linked[0]}:{})}
      entries.push(entry)
      if(asy.prefix.toUpperCase()==='X'&&!modelFile&&!asy.modelFile&&!SYMBOL_MODEL_EXTENSIONS.test(asy.spiceModel)&&asyModelNames(asy).length)unbound.push({entry,asy})
    }catch{/* Invalid installed symbols are skipped; neither files nor paths escape to clients. */}
  }
  if(unbound.length){
    const names=new Set(unbound.flatMap(item=>asyModelNames(item.asy))),owners=new Map<string,string[]>()
    for(const path of modelPaths){
      try{
        const model=await declarations(path)
        if(model.issue)continue
        for(const name of model.headers.keys())if(names.has(name))owners.set(name,[...(owners.get(name)??[]),path])
      }catch{/* A missing model cannot supply proof for a physical symbol. */}
    }
    for(const {entry,asy} of unbound){
      const paths=[...new Set(asyModelNames(asy).flatMap(name=>owners.get(name)??[]))]
      if(paths.length!==1)continue
      const headers=(await declarations(paths[0])).headers
      if(!asyModelNames(asy).some(name=>{const pins=headers.get(name);return pins&&originalSymbolForDeclaration(asy,name,pins,headers,false)}))continue
      entry.status='linked';entry.modelPath=paths[0];entry.modelFile=relative(roots.modelRoot,paths[0]).replaceAll('\\','/')
      entry.reason='ASY 明确型号对应同安装库中的唯一 .subckt 声明，原始 SpiceOrder 已核对；还需模型兼容检查'
    }
  }
  return entries.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}))
}
export function searchLocalLtspiceSymbols(entries:IndexedSymbol[],query:string,offset=0,limit=40):LocalSymbolCatalog {
  const terms=query.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0,8)
  const matches=entries.filter(entry=>terms.every(term=>`${entry.name} ${entry.id} ${entry.description} ${entry.modelFile}`.toLowerCase().includes(term)))
  return{total:matches.length,items:matches.slice(offset,offset+limit).map(publicEntry)}
}
export async function readLocalLtspiceSymbol(entries:IndexedSymbol[],id:string):Promise<LocalSymbolDetail>{
  const entry=entries.find(item=>item.id===id);if(!entry)throw new Error('本机符号不存在，请重新扫描')
  const symbolBytes=await readFile(entry.path)
  if(entry.originalSha256&&createHash('sha256').update(symbolBytes).digest('hex')!==entry.originalSha256)throw new Error('符号原件已变更，请重新扫描')
  const asy=entry.convertedAsy??parseLtspiceAsy(decodeSpiceLibrary(symbolBytes),entry.name)
  const result:LocalSymbolDetail={item:publicEntry(entry),asy,source:entry.source??ltspiceSymbolSource,...(entry.symbolSource?{symbolSource:entry.symbolSource}:{}),...(entry.physicalPinNumbers?{physicalPinNumbers:entry.physicalPinNumbers}:{})}
  if(entry.id.startsWith('owned:pspice:')&&entry.modelPath){
    // Use the same selected root and bounded dependency closure as local-model
    // lookup. An unrelated encrypted root in a large LIB cannot block this one.
    try{
      const {readPspiceModelPreviewForDeclaration}=await import('./pspice-model-library')
      const preview=await readPspiceModelPreviewForDeclaration(entry.modelPath,asy.spiceModel)
      const model=preview?.models.find(model=>model.kind==='X'&&model.id.toLowerCase()===asy.spiceModel.toLowerCase())
      if(model){result.modelText=model.spice;result.sourceFile=entry.modelFile}
      else result.modelError=preview?.diagnostics.find(diagnostic=>diagnostic.severity==='error')?.message??'此原始符号对应的电气模型尚不兼容，原件和图形已保留'
    }catch(error){result.modelError=(error as Error).message}
    return result
  }
  if(entry.modelPath){
    const info=await stat(entry.modelPath)
    if(info.size>4*1024*1024){result.modelError='关联 SPICE 文件超过 4 MB，不能导入';return result}
    let modelText:string
    try {modelText=entry.sourceRoot?await readOfflineSymbolModel(entry.modelPath,entry.sourceRoot):decodeSpiceLibrary(await readFile(entry.modelPath))}
    catch(error){result.modelError=(error as Error).message;return result}
    if(/<binary file>|\x00|\.protect\b|BEGIN\s+ENCRYPTED/i.test(modelText)){result.modelError='关联模型受保护或加密，不能导入 ngspice';return result}
    result.modelText=modelText;result.sourceFile=entry.modelFile
  }
  return result
}
function sameLocalOrigin(req:IncomingMessage){const host=req.headers.host;return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')&&!!host&&/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)&&req.headers.origin===`http://${host}`&&req.headers['sec-fetch-site']!=='cross-site'}
export function createLtspiceSymbolMiddleware(roots=localLtspiceRoots()){
  let cache:Promise<IndexedSymbol[]>|undefined,readAt=0
  return async(req:IncomingMessage,res:ServerResponse,next:()=>void)=>{
    const pathname=req.url?.split('?')[0]
    if(pathname!=='/api/ltspice-symbols/search'&&pathname!=='/api/ltspice-symbols/detail'){next();return}
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff')
    const send=(code:number,value:object)=>{res.statusCode=code;res.end(JSON.stringify(value))}
    if(!sameLocalOrigin(req)){send(403,{error:'本机符号库只接受本机工作台同源请求'});return}
    if(req.method!=='POST'){res.setHeader('Allow','POST');send(405,{error:'只接受 POST 请求'});return}
    if(req.url?.includes('?')||Number(req.headers['content-length']??0)>2048){send(400,{error:'请求参数不合法'});return}
    let input:Record<string,unknown>={};try{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2048)throw new Error()}input=JSON.parse(raw||'{}');if(!input||typeof input!=='object'||Array.isArray(input))throw new Error()}catch{send(400,{error:'请求内容不合法'});return}
    try{
      if(!cache||Date.now()-readAt>5*60_000||input.refresh===true){readAt=Date.now();cache=Promise.all([indexLocalLtspiceSymbols(roots),indexOfflineSymbols(),indexOwnedPspiceSymbols()]).then(([local,offline,owned])=>[...new Map([...local,...offline.symbols,...owned].map(entry=>[entry.id,entry])).values()].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true})));cache.catch(()=>{cache=undefined})}
      const entries=await cache
      if(pathname.endsWith('/search')){
        if(typeof input.query!=='string'||input.query.length>100){send(400,{error:'搜索词最多 100 字'});return}
        const offset=typeof input.offset==='number'&&Number.isInteger(input.offset)&&input.offset>=0&&input.offset<=100000?input.offset:0
        send(200,searchLocalLtspiceSymbols(entries,input.query,offset))
      }else{
        if(typeof input.id!=='string'||input.id.length>1200){send(400,{error:'符号编号不合法'});return}
        send(200,await readLocalLtspiceSymbol(entries,input.id))
      }
    }catch(error){send(422,{error:(error as Error).message||'读取 LTspice 符号失败'})}
  }
}
export function ltspiceSymbolPlugin():Plugin{return{name:'fuxian-ltspice-symbols',configureServer(server){server.middlewares.use(createLtspiceSymbolMiddleware());server.middlewares.use(createOfflineSymbolMiddleware())},configurePreviewServer(server){server.middlewares.use(createLtspiceSymbolMiddleware());server.middlewares.use(createOfflineSymbolMiddleware())}}}
