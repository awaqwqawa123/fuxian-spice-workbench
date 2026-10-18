import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import type { Plugin } from 'vite'
import { decodeSpiceLibrary, SPICE_LIBRARY_LIMITS } from '../src/core/spice-models'
import type { LocalModelCatalog, LocalModelFile } from '../src/core/model-catalog'
import { bundledModelFiles, bundledModelPackages } from '../src/core/bundled-models'
import { readMaterializedLibraryStatus, pageMaterializedModels } from './local-model-store'
import { parseModelLibraryPreview } from '../src/core/model-library-preview'
import { createInstalledModelSymbolResolver, refreshInstalledModelSymbolIndexes } from './installed-model-symbol'
import { readSharedModelCatalog, peekSharedModelCatalog } from './model-catalog-cache'
import { readTinaModelCatalog, refreshTinaLibraryIndex } from './tina-model-library'
import { readPspiceModelCatalog, refreshPspiceLibraryIndex } from './pspice-model-library'
import { selectPreferredCatalogModels } from '../src/core/model-source-policy'
import { parseDeviceLibraryBrowseRequest } from '../src/core/device-library-catalog'
import { browsePersistentDeviceLibrary, readPersistentDeviceLibraryModel, type PersistentDeviceLibraryOptions } from './persistent-device-library'
import { ownedModelLibraryRoot } from './owned-model-library'

const FILES=[['standard.dio','二极管'],['standard.bjt','双极晶体管'],['standard.mos','MOSFET'],['standard.jft','JFET 结型场效应管']] as const
const official='https://www.analog.com/en/resources/design-tools-and-calculators/ltspice-simulator.html'
// These roots are chosen by the server, never by an HTTP path or request body.
export function localLibraryRoots():string[] {
  const localAppData=process.env.LOCALAPPDATA||join(homedir(),'AppData','Local')
  return [join(ownedModelLibraryRoot(),'vendor','ltspice','lib','cmp'),join(localAppData,'LTspice','lib','cmp'),join(homedir(),'Documents','LTspiceXVII','lib','cmp')]
}
export function localSubcircuitRoots(roots=localLibraryRoots()):string[] {
  return roots.map(root=>join(dirname(root),'sub'))
}
export async function readLocalModelCatalog(roots=localLibraryRoots()):Promise<LocalModelCatalog> {
  const catalog:LocalModelCatalog={models:[],files:[]},ids=new Set<string>()
  for(const[file,label]of FILES){
    const entry:LocalModelFile={file,label,available:false,accepted:0,rejected:0,issues:[]}
    for(const root of roots){
      try{
        const path=join(root,file),info=await stat(path)
        if(!info.isFile())continue
        entry.available=true
        if(info.size>SPICE_LIBRARY_LIMITS.fileBytes)throw new Error('模型文件超过 4 MB 限制')
        const preview=parseModelLibraryPreview(decodeSpiceLibrary(await readFile(path)),{
          label:`本机 LTspice / ${file}`,url:official,
          license:'来自用户本机 LTspice 安装；按原厂模型条款使用，工作台不附带分发此库',
          attribution:'模型作者与厂家见本机原始文件；目录厂家字段已保留',
        })
        const issues=new Map<string,number>()
        for(const issue of preview.diagnostics.filter(item=>item.severity==='error'))issues.set(issue.message,(issues.get(issue.message)??0)+1)
        entry.rejected=preview.diagnostics.filter(item=>item.severity==='error').length
        for(const model of preview.models){
          const key=model.id.toLowerCase()
          if(ids.has(key)){entry.rejected++;issues.set('与另一目录型号重名，未自动覆盖',(issues.get('与另一目录型号重名，未自动覆盖')??0)+1);continue}
          ids.add(key);catalog.models.push(model);entry.accepted++
        }
        entry.issues=[...issues].map(([message,count])=>({message,count})).sort((a,b)=>b.count-a.count)
        break
      }catch(error){
        if((error as NodeJS.ErrnoException).code==='ENOENT')continue
        entry.issues.push({message:'读取或解析失败，请从“导入模型”手动选择文件。',count:1});break
      }
    }
    catalog.files.push(entry)
  }
  catalog.models.sort((a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true}))
  return catalog
}
// Only the installed vendor directories whose self-contained files were audited
// are scanned. File-level errors exclude the whole file so a model never loses
// its surrounding directives or dependencies silently.
const LOCAL_SUBCIRCUIT_GROUPS=[
  {directory:join('Contrib','CHEMI-CON'),label:'CHEMI-CON',rights:'Nippon Chemi-Con Corporation'},
  {directory:join('Contrib','Wurth'),label:'Würth Elektronik',rights:'Würth Elektronik eiSos GmbH & Co. KG'},
] as const
const MAX_SUBCIRCUIT_FILES=2000
const MAX_SUBCIRCUIT_BYTES=32*1024*1024
async function subcircuitFiles(root:string):Promise<string[]> {
  const files:string[]=[]
  async function visit(dir:string){
    for(const entry of await readdir(dir,{withFileTypes:true})){
      if(files.length>=MAX_SUBCIRCUIT_FILES)throw new Error('本机子电路文件数量超过扫描上限')
      const path=join(dir,entry.name)
      if(entry.isDirectory())await visit(path)
      else if(entry.isFile()&&/\.(?:lib|sub)$/i.test(entry.name))files.push(path)
    }
  }
  await visit(root)
  return files.sort((a,b)=>a.localeCompare(b))
}
function topLevelDeclarations(text:string):number {
  let declarations=0,inSubcircuit=false
  for(const line of text.split(/\r?\n/)){
    if(/^\s*\.subckt\b/i.test(line)){declarations++;inSubcircuit=true}
    else if(/^\s*\.ends\b/i.test(line))inSubcircuit=false
    else if(!inSubcircuit&&/^\s*\.model\b/i.test(line))declarations++
  }
  return declarations
}
/** Read audited classes of installed vendor subcircuits in place, never ship their bytes. */
export async function readLocalSubcircuitCatalog(roots=localSubcircuitRoots()):Promise<LocalModelCatalog> {
  const catalog:LocalModelCatalog={models:[],files:[]},ids=new Set<string>()
  const symbolResolvers=new Map<string,ReturnType<typeof createInstalledModelSymbolResolver>>()
  for(const group of LOCAL_SUBCIRCUIT_GROUPS){
    const entry:LocalModelFile={file:`sub/${group.directory.split(sep).join('/')}`,label:`本机 LTspice / ${group.label}`,packageId:'ltspice',source:official,available:false,accepted:0,rejected:0,issues:[]}
    for(const root of roots){
      const directory=join(root,group.directory)
      let paths:string[]
      try{paths=await subcircuitFiles(directory)}
      catch(error){
        if((error as NodeJS.ErrnoException).code==='ENOENT')continue
        entry.issues.push({message:'读取本机子电路目录失败或超过扫描上限',count:1});break
      }
      entry.available=true
      let bytes=0,skippedFiles=0,oversized=0,duplicates=0
      const symbolIssues=new Map<string,number>()
      let resolver=symbolResolvers.get(root)
      if(!resolver){resolver=createInstalledModelSymbolResolver(root);symbolResolvers.set(root,resolver)}
      const resolveSymbol=await resolver
      for(const path of paths){
        try{
          const info=await stat(path)
          if(!info.isFile())continue
          if(info.size>SPICE_LIBRARY_LIMITS.fileBytes){oversized++;skippedFiles++;continue}
          bytes+=info.size
          if(bytes>MAX_SUBCIRCUIT_BYTES){entry.issues.push({message:'本机子电路目录超过 32 MB 扫描上限',count:1});break}
          const text=decodeSpiceLibrary(await readFile(path)),declarations=topLevelDeclarations(text)
          const relativeFile=relative(root,path).split(sep).join('/')
          const parsed=parseModelLibraryPreview(text,{
            label:`本机 LTspice / ${relativeFile}`,url:official,
            license:`原文件标注 © ${group.rights} / All Rights Reserved；按原厂模型条款使用，工作台不附带分发此库。`,
            attribution:`${group.label}；原始文件 ${relativeFile} 保留完整版权、免责声明及适用条件。`,
          })
          if(parsed.diagnostics.some(item=>item.severity==='error')){entry.rejected+=declarations;skippedFiles++;continue}
          for(const model of parsed.models){
            const key=model.id.toLowerCase()
            if(ids.has(key)){entry.rejected++;duplicates++;continue}
            let displayed=model
            if(model.kind==='X'){
              const attached=await resolveSymbol(path,model.id,model.pins,text)
              if(attached.symbol)displayed={...model,symbol:{...attached.symbol,...(model.symbol?.family?{family:model.symbol.family}:{})},detail:`${model.detail} 原厂 ASY：${attached.sourceFile}，按原件 SpiceOrder 接线。`}
              else if(attached.reason)symbolIssues.set(attached.reason,(symbolIssues.get(attached.reason)??0)+1)
            }
            ids.add(key);catalog.models.push(displayed);entry.accepted++
          }
        }catch{skippedFiles++}
      }
      if(skippedFiles)entry.issues.push({message:'含不兼容语法、外部依赖或读取失败的文件整份跳过',count:skippedFiles})
      if(oversized)entry.issues.push({message:'超过 4 MB 单文件上限',count:oversized})
      if(duplicates)entry.issues.push({message:'与另一已收录本机子电路重名',count:duplicates})
      for(const[message,count]of symbolIssues)entry.issues.push({message,count})
      break
    }
    catalog.files.push(entry)
  }
  return catalog
}
/** Reads registered shipped data only. Available without LTspice or a network. */
export async function readBundledModelCatalog():Promise<LocalModelCatalog> {
  const catalog:LocalModelCatalog={models:[],files:[]}
  const root=join(process.cwd(),'public','models')
  for(const file of bundledModelFiles){
    const group=bundledModelPackages.find(item=>item.id===file.packageId)!
    const entry:LocalModelFile={file:file.file,label:group.name,packageId:file.packageId,source:file.source.url,available:false,accepted:0,rejected:0,issues:[]}
    try{
      const text=decodeSpiceLibrary(await readFile(join(root,file.file)))
      const parsed=parseModelLibraryPreview(text,file.source)
      const models=parsed.models.filter(model=>!file.excludedIds?.includes(model.id))
      catalog.models.push(...models);entry.available=true;entry.accepted=models.length
      entry.rejected=parsed.diagnostics.filter(item=>item.severity==='error').length
      entry.issues=parsed.diagnostics.filter(item=>item.severity==='error').map(item=>({message:item.message,count:1}))
    }catch{entry.issues=[{message:'随附模型文件读取失败，请检查安装是否完整。',count:1}]}
    catalog.files.push(entry)
  }
  return catalog
}
function catalogScope(roots:string[],kind='complete'){return JSON.stringify([kind,process.cwd(),roots])}
export function peekAvailableModelCatalog(roots=localLibraryRoots()):LocalModelCatalog|undefined{return peekSharedModelCatalog(catalogScope(roots))}
export function peekAvailableModelLookupCatalog(roots=localLibraryRoots()):LocalModelCatalog|undefined{return peekSharedModelCatalog(catalogScope(roots,'lookup'))}
function mergeCatalogs(first:LocalModelCatalog,second:LocalModelCatalog):LocalModelCatalog{
  return{models:selectPreferredCatalogModels([...first.models,...second.models]),files:[...first.files,...second.files]}
}
/** Query path: bounded bundled definitions and four fixed .MODEL files only.
 * No directory traversal, subcircuit macros or ASY/OLB scans are started here. */
export function readAvailableModelLookupCatalog(roots=localLibraryRoots(),options:{refresh?:boolean}={}):Promise<LocalModelCatalog>{
  return readSharedModelCatalog(catalogScope(roots,'lookup'),async()=>{
    const local=await readLocalModelCatalog(roots)
    return {...local,models:selectPreferredCatalogModels(local.models),files:local.files.map(file=>({...file,packageId:'ltspice'}))}
  },options.refresh)
}
async function scanAvailableModelCatalog(roots:string[],refresh=false):Promise<LocalModelCatalog> {
  if(refresh){refreshInstalledModelSymbolIndexes();refreshTinaLibraryIndex();refreshPspiceLibraryIndex()}
  const [lookup,subcircuits,tina,pspice]=await Promise.all([readAvailableModelLookupCatalog(roots,{refresh}),readLocalSubcircuitCatalog(localSubcircuitRoots(roots)),readTinaModelCatalog(),readPspiceModelCatalog()])
  return mergeCatalogs(mergeCatalogs(mergeCatalogs(lookup,subcircuits),tina),pspice)
}
export async function readAvailableModelCatalog(roots=localLibraryRoots(),options:{refresh?:boolean}={}):Promise<LocalModelCatalog>{
  const catalog=await readSharedModelCatalog(catalogScope(roots),()=>scanAvailableModelCatalog(roots,options.refresh),options.refresh)
  // The materialized index watches its own manifest/file identity and must not
  // become stale merely because the installed-library cache remains warm.
  return{...catalog,materialized:await readMaterializedLibraryStatus()}
}
function sameLocalOrigin(req:IncomingMessage){
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??''))return false
  const host=req.headers.host
  if(!host||!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host))return false
  return req.headers.origin===`http://${host}`||req.headers.origin===`https://${host}`
}
export function createModelLibraryMiddleware(options:{libraryRoots?:string[];deviceCacheRoot?:string}={}) {
  // Explicit server/test roots use a separate identity; HTTP clients never choose
  // roots, cache paths, generation filenames or model filesystem paths.
  const persistentOptions:PersistentDeviceLibraryOptions={...(options.deviceCacheRoot?{cacheRoot:options.deviceCacheRoot}:{}),...(options.libraryRoots?{scope:JSON.stringify(options.libraryRoots),stampPaths:options.libraryRoots.flatMap(root=>FILES.map(([file])=>join(root,file)))}:{})}
  const loadDeviceCatalog=()=>options.libraryRoots?readLocalModelCatalog(options.libraryRoots):readAvailableModelCatalog(undefined,{refresh:true})
  return async(req:IncomingMessage,res:ServerResponse,next:()=>void)=>{
    const route=req.url?.split('?')[0]
    if(!['/api/model-library/catalog','/api/model-library/materialized','/api/model-library/status','/api/model-library/browse','/api/model-library/device'].includes(route??'')){next();return}
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff')
    const send=(status:number,data:object)=>{res.statusCode=status;res.end(JSON.stringify(data))}
    if(!sameLocalOrigin(req)||req.headers['sec-fetch-site']==='cross-site'){send(403,{error:'本机模型目录仅接受本机工作台的同源请求'});return}
    if(req.method!=='POST'){res.setHeader('Allow','POST');send(405,{error:'模型目录仅接受 POST'});return}
    if(route==='/api/model-library/browse'||route==='/api/model-library/device'){
      if(Number(req.headers['content-length']??0)>2048||req.url?.includes('?')){send(400,{error:'器件库浏览参数过长或包含网址参数'});return}
      let bodyValue:unknown
      try{
        const chunks:Buffer[]=[];let bytes=0
        for await(const chunk of req){const buffer=Buffer.from(chunk);bytes+=buffer.length;if(bytes>2048)throw new Error('器件库浏览参数过长');chunks.push(buffer)}
        const body=Buffer.concat(chunks).toString('utf8')
        bodyValue=body?JSON.parse(body):{}
      }catch(error){send(400,{error:(error as Error).message});return}
      if(route==='/api/model-library/device'){
        if(!bodyValue||typeof bodyValue!=='object'||Array.isArray(bodyValue)||Object.keys(bodyValue).length!==1||!('key' in bodyValue)||typeof bodyValue.key!=='string'||!/^[a-f0-9]{64}$/.test(bodyValue.key)){send(400,{error:'器件选择仅接受当前目录的器件键'});return}
        try{send(200,{model:await readPersistentDeviceLibraryModel(bodyValue.key,persistentOptions)})}
        catch(error){send(404,{error:(error as Error).message})}
        return
      }
      let data
      try{data=parseDeviceLibraryBrowseRequest(bodyValue)}catch(error){send(400,{error:(error as Error).message});return}
      try{
        const result=await browsePersistentDeviceLibrary(data,loadDeviceCatalog,persistentOptions,req.headers['x-model-catalog-refresh']==='1')
        send(result.status,result.data)
      }catch(error){send(503,{state:'failed',message:'本地器件目录暂不可读，请重新整理目录',error:(error as Error).message||'读取本地器件目录失败',retryRequiresRebuild:true})}
      return
    }
    if(route==='/api/model-library/materialized'){
      if(Number(req.headers['content-length']??0)>2048||req.url?.includes('?')){send(400,{error:'本地目录分页参数过长'});return}
      try{
        let body=''
        for await(const chunk of req){body+=chunk.toString();if(body.length>2048)throw new Error('本地目录分页参数过长')}
        const data=body?JSON.parse(body):{},query=data.query??'',offset=data.offset??0,limit=data.limit??100
        if(typeof query!=='string'||query.length>100||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('本地目录分页参数无效')
        send(200,{...await pageMaterializedModels(query,offset,limit),status:await readMaterializedLibraryStatus()})
      }catch(error){send(400,{error:(error as Error).message})}
      return
    }
    // The request has no arguments. In particular, clients cannot select a path,
    // follow includes, read arbitrary files or ask the gateway to fetch a URL.
    if(req.headers['transfer-encoding']||Number(req.headers['content-length']??0)!==0||req.url?.includes('?')){send(400,{error:'模型目录不接受路径、网址或其他请求参数'});return}
    try{send(200,route==='/api/model-library/status'?await readMaterializedLibraryStatus():options.libraryRoots?await readLocalModelCatalog(options.libraryRoots):await readAvailableModelCatalog(undefined,{refresh:req.headers['x-model-catalog-refresh']==='1'}))}catch{send(500,{error:'读取本机模型目录失败，请稍后重试或手动导入文件'})}
  }
}
export function modelLibraryPlugin():Plugin {
  return {name:'fuxian-model-library',configureServer(server){server.middlewares.use(createModelLibraryMiddleware())},configurePreviewServer(server){server.middlewares.use(createModelLibraryMiddleware())}}
}
