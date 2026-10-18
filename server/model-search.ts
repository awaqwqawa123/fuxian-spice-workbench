import { request as httpsRequest } from 'node:https'
import { lookup } from 'node:dns'
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { decodeSpiceLibrary, parseSpiceLibrary, type SpiceModelSource } from '../src/core/spice-models'
import type { ModelDownloadPreview, ModelSearchCandidate, ModelSearchResults, ModelSearchSourceStatus } from '../src/core/model-search'
import declarationIndex from './model-declaration-index.json'
import modelFileExtensions from './model-file-extensions.json'
import { WURTH_MODEL_CATALOGS, registeredWurthModelPath } from './wurth-model-catalog'
import { QUCS_MODEL_CATALOG, registeredQucsModelPath } from './qucs-model-catalog'
import { adaptQucsSpiceLibrary } from './qucs-model-adapter'
import { parseAcquiredModelLibrary } from '../src/core/agent-models'
import { posix } from 'node:path'
import { publicAddress } from './public-network'
import { searchLcsc, type LcscSourceStatus } from './lcsc-source'
import { searchSemiee, type SemieeSourceStatus } from './semiee-source'
import { searchStPublicCatalog, previewStSpiceModel, type StProductDiscovery } from './st-public-catalog'
import { searchGoogle } from './google-discovery'
import { searchAllDatasheet } from './alldatasheet-discovery'
import { jlcCatalogSearchUrl, jlcCatalogSourceStatus, searchJlcCatalog, type JlcCatalogStatus } from './jlc-catalog'
import { createSiteSearchSource } from './site-access'
import { readMaterializedModelPreview, readMaterializedSourceText } from './local-model-store'
import { modelFilenameMatches, selectModelDeclarations } from '../src/core/model-search-match'
import { createModelRequestScheduler, currentModelRequestSignal, ModelRequestError, withoutModelRequestCancellation } from './model-request-scheduler'
export { publicAddress } from './public-network'

const community='kicad-spice-library/KiCad-Spice-Library'
const official='KiCad/kicad-source-mirror'
const officialRevision='b4eadf61cca001c6285c3706d207606558cd4c97'
const commonLibraries=['Models/Diode/diode.lib','Models/Diode/DIODE2.lib','Models/Transistor/BJT/BJT.lib','Models/Transistor/FET/MOS.lib']
const officialLibraries=[
  {path:'demos/simulation/power_supplies/LM317_power_supply/1N4002.lib',names:['1N4002']},
  {path:'demos/simulation/laser_driver/fzt1049a.lib',names:['FZT1049A']},
  {path:'demos/simulation/power_supplies/buck_conv/IRF-Power-VDMOS.mod',names:['IRF540','IRF540N','IRF9540']},
]
function safePath(path:string){return path.length<500&&!/[\x00-\x1f\\?#%]/.test(path)&&!path.split('/').some(segment=>segment==='.'||segment==='..'||!segment)}
const modelFilePattern=new RegExp(`\\.(?:${modelFileExtensions.join('|')})$`,'i')
function registeredGithubPath(repo:string,path:string,revision=''){return safePath(path)&&((repo===community&&path.startsWith('Models/')&&modelFilePattern.test(path))||(repo===official&&officialLibraries.some(item=>item.path===path))||registeredWurthModelPath(repo,revision,path)||registeredQucsModelPath(repo,revision,path))}
export function allowedModelUrl(raw:string):URL {
  const url=new URL(raw)
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)throw new Error('模型下载地址不受支持')
  if(url.hostname==='www.ti.com'&&!url.search&&(/^\/product\/[a-z0-9-]{3,40}$/i.test(url.pathname)||/^\/lit\/zip\/[a-z0-9]{3,20}$/i.test(url.pathname)||/^\/lit\/mo\/[a-z0-9]{3,20}\/[a-z0-9]{3,20}\.zip$/i.test(url.pathname)))return url
  if(url.hostname==='api.github.com'&&url.pathname===`/repos/${community}/git/trees/master`&&url.search==='?recursive=1')return url
  if(url.hostname==='api.github.com'){
    const parts=decodeURIComponent(url.pathname.slice(1)).split('/'),repo=parts.slice(1,3).join('/'),path=parts.slice(4).join('/'),revision=url.searchParams.get('ref')
    if(parts[0]==='repos'&&parts[3]==='contents'&&/^[a-f0-9]{40}$/.test(revision??'')&&url.searchParams.size===1&&registeredGithubPath(repo,path,revision!)&&url.pathname===`/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`)return url
  }
  if(url.hostname==='raw.githubusercontent.com'&&!url.search){
    const decoded=decodeURIComponent(url.pathname.slice(1)),parts=decoded.split('/'),repo=parts.slice(0,2).join('/'),revision=parts[2],path=parts.slice(3).join('/')
    if(/^[a-f0-9]{40}$/.test(revision)&&registeredGithubPath(repo,path,revision))return url
  }
  throw new Error('只允许已登记的公开模型仓库地址')
}
export async function fetchModelBytes(raw:string,limit=1024*1024,redirects=0):Promise<Buffer> {
  const url=allowedModelUrl(raw)
  return new Promise((resolve,reject)=>{
    const request=httpsRequest(url,{signal:currentModelRequestSignal(),headers:{'User-Agent':'SPICE-Workbench/0.13','Accept':'application/vnd.github+json, text/plain'},lookup(host,options,done){
      lookup(host,{all:true},(error,addresses)=>{
        if(error){done(error,'',4);return}
        if(!addresses.length||addresses.some(item=>!publicAddress(item.address))){done(new Error('模型源解析到非公网地址'),'',4);return}
        // Pin the checked address for this connection, preventing DNS rebinding.
        if(options.all)(done as unknown as (error:null,records:{address:string;family:number}[])=>void)(null,addresses)
        else done(null,addresses[0].address,addresses[0].family)
      })
    }},response=>{
      if([301,302,303,307,308].includes(response.statusCode??0)&&url.hostname==='www.ti.com'&&redirects<2&&response.headers.location){
        response.resume()
        try{
          const target=new URL(response.headers.location,url)
          if(target.hostname!=='www.ti.com'||!/^\/lit\/mo\/[a-z0-9]+\/[a-z0-9]+\.zip$/i.test(target.pathname)||[...target.searchParams.keys()].some(key=>!['ts','ref_url'].includes(key)))throw new Error('厂商下载跳转地址不受支持')
          target.search='';allowedModelUrl(target.href)
          resolve(fetchModelBytes(target.href,limit,redirects+1))
        }catch(error){reject(error)}
        return
      }
      if(response.statusCode!==200){response.resume();reject(new Error(response.statusCode===403||response.statusCode===429?'模型源请求限额或访问限制，请稍后重试':`模型源返回 HTTP ${response.statusCode}；未登记的重定向不会自动跟随`));return}
      if(Number(response.headers['content-length']??0)>limit){response.destroy();reject(new Error('远程模型文件超过大小限制'));return}
      const chunks:Buffer[]=[];let size=0
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>limit){response.destroy(new Error('远程模型文件超过大小限制'));return}chunks.push(chunk)})
      response.on('error',reject)
      response.on('end',()=>resolve(Buffer.concat(chunks)))
    })
    const timer=setTimeout(()=>request.destroy(new Error('模型源连接超时，请重试')),15_000)
    request.on('close',()=>clearTimeout(timer));request.on('error',reject);request.end()
  })
}
/** Fall back only from an allowed immutable raw path to the same GitHub file at the same commit. */
export async function fetchPinnedGithubText(raw:string,fetchBytes:(url:string,limit?:number)=>Promise<Uint8Array>=fetchModelBytes,limit=1024*1024):Promise<string>{
  const source=allowedModelUrl(raw)
  const rawParts=source.hostname==='raw.githubusercontent.com'?decodeURIComponent(source.pathname.slice(1)).split('/'):undefined
  const expected=rawParts?[...WURTH_MODEL_CATALOGS,QUCS_MODEL_CATALOG].find(catalog=>catalog.repo===rawParts.slice(0,2).join('/')&&catalog.revision===rawParts[2])?.files.find(file=>file.path===rawParts.slice(3).join('/')):undefined
  const checkedText=(bytes:Uint8Array)=>{
    if(expected&&(bytes.length!==expected.size||createHash('sha256').update(bytes).digest('hex')!==expected.sha256))throw new Error('厂商模型内容与登记版本的 SHA-256 不符')
    return decodeSpiceLibrary(bytes)
  }
  try{return checkedText(await fetchBytes(source.href,limit))}
  catch(primary){
    if(source.hostname!=='raw.githubusercontent.com')throw primary
    const parts=decodeURIComponent(source.pathname.slice(1)).split('/'),repo=parts.slice(0,2).join('/'),revision=parts[2],path=parts.slice(3).join('/')
    const api=allowedModelUrl(`https://api.github.com/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${revision}`)
    try{
      const body=JSON.parse(decodeSpiceLibrary(await fetchBytes(api.href,Math.ceil(limit*1.5)+8192))) as Record<string,unknown>
      if(body.type!=='file'||body.path!==path||body.encoding!=='base64'||typeof body.content!=='string'||typeof body.sha!=='string'||!/^[a-f0-9]{40}$/.test(body.sha)||!Number.isSafeInteger(body.size)||Number(body.size)>limit||Number(body.size)<0)throw new Error('备用接口返回的文件身份或大小不符')
      const encoded=body.content.replace(/[\r\n]/g,'')
      if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw new Error('备用接口返回的模型编码无效')
      const bytes=Buffer.from(encoded,'base64')
      const hash=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      if(bytes.length!==body.size||hash!==body.sha)throw new Error('备用接口返回的模型内容与 Git 哈希不符')
      return checkedText(bytes)
    }catch(secondary){throw new Error(`模型原始地址获取失败，GitHub 备用接口也未能验证文件：${(secondary as Error).message}`,{cause:primary})}
  }
}
export async function fetchModelText(raw:string,limit=1024*1024):Promise<string>{return fetchPinnedGithubText(raw,fetchModelBytes,limit)}

/** Read only model text from a bounded archive; no filesystem extraction or execution. */
export function decodeModelArchive(bytes:Uint8Array):string{
  if(bytes.length>1024*1024||bytes[0]!==0x50||bytes[1]!==0x4b)throw new Error('厂商未返回有效 ZIP 模型包，或文件超过 1 MB')
  let total=0,count=0
  const files=unzipSync(bytes,{filter(file){
    if(!modelFilePattern.test(file.name))return false
    if(file.name.length>250||/[\x00-\x1f\\]/.test(file.name)||file.name.startsWith('/')||file.name.split('/').some(part=>part==='..'||part==='.')||file.compression!==0&&file.compression!==8)throw new Error('模型压缩包包含不支持的文件路径或压缩方式')
    if(++count>32||file.originalSize>500_000||(total+=file.originalSize)>1024*1024)throw new Error('解压后的模型源码超过大小限制')
    return true
  }})
  const entries=Object.entries(files)
  if(!entries.length)throw new Error('压缩包内没有可预览的 SPICE 文本模型')
  return entries.map(([name,content])=>`* Archive file: ${name}\n${decodeSpiceLibrary(content)}`).join('\n\n')
}
type FetchText=(url:string,limit?:number)=>Promise<string>
/** Expand only explicit text includes from registered paths at the same immutable
 * revision. Sectioned .lib/conditional/encrypted syntax remains for the parser to
 * reject; it must never be flattened by guessing a section or dropping physics. */
export async function fetchGithubModelBundle(raw:string,fetchText:FetchText=fetchModelText):Promise<{text:string;paths:string[]}>{
  const source=allowedModelUrl(raw)
  if(source.hostname!=='raw.githubusercontent.com')throw new Error('依赖展开只支持已登记的固定版本模型文件')
  const parts=decodeURIComponent(source.pathname.slice(1)).split('/'),repo=parts.slice(0,2).join('/'),revision=parts[2],rootPath=parts.slice(3).join('/')
  const paths:string[]=[],active=new Set<string>(),seen=new Set<string>()
  let total=0
  async function visit(path:string,depth:number):Promise<string>{
    if(active.has(path))throw new Error(`模型依赖存在循环：${path}`)
    if(seen.has(path))throw new Error(`模型重复包含同一依赖：${path}；请审阅原始包含顺序`)
    if(depth>8||paths.length>=16)throw new Error('模型依赖超过 8 层或 16 个文件，请提供已展开的自包含模型')
    const url=allowedModelUrl(`https://raw.githubusercontent.com/${repo}/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`)
    active.add(path);seen.add(path);paths.push(path)
    const text=await fetchText(url.href,1024*1024)
    total+=Buffer.byteLength(text)
    if(Buffer.byteLength(text)>1024*1024||total>4*1024*1024-16_384)throw new Error('模型及依赖超过下载或导入大小限制')
    const lines:string[]=[]
    for(const line of text.split(/\r?\n/)){
      if(!/^\s*\.(?:include|inc)\b/i.test(line)){lines.push(line);continue}
      const include=line.match(/^\s*\.(?:include|inc)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;]+))\s*(?:[;$].*)?$/i)
      if(!include)throw new Error(`无法确定模型依赖文件：${path}；不执行动态路径或带参数的包含指令`)
      const relative=(include[1]??include[2]??include[3]).replace(/\\/g,'/')
      if(relative.startsWith('/')||/[:\x00-\x1f%?$#{}]/.test(relative)||!modelFilePattern.test(relative))throw new Error(`不支持模型依赖路径：${relative}`)
      const dependency=posix.normalize(posix.join(posix.dirname(path),relative))
      if(!registeredGithubPath(repo,dependency,revision))throw new Error(`依赖不在同版本登记的模型目录中：${relative}`)
      lines.push(`* Included from ${dependency} at ${revision}`,await visit(dependency,depth+1))
    }
    active.delete(path)
    return lines.join('\n')
  }
  return {text:await visit(rootPath,0),paths}
}
interface Index { revision:string; files:{path:string;size:number}[] }
interface DeclarationIndex { revision:string; files:[string,string[]][] }
interface SupplementalCatalog { repo:string;revision:string;label:string;license:string;attribution:string;files:readonly {path:string;names:string[]}[] }
const pinnedDeclarations:DeclarationIndex=declarationIndex as DeclarationIndex
type WebDiscovery = (query:string)=>Promise<ModelSearchSourceStatus>
export function createOnlineModelService(fetchText:FetchText=fetchModelText,fetchBytes:(url:string,limit?:number)=>Promise<Uint8Array>=fetchModelBytes,manifest:DeclarationIndex=pinnedDeclarations,lcscSource:WebDiscovery|undefined=fetchText===fetchModelText?createSiteSearchSource('lcsc',searchLcsc):undefined,semieeSource:WebDiscovery|undefined=fetchText===fetchModelText?createSiteSearchSource('semiee',searchSemiee):undefined,googleSource:WebDiscovery|undefined=fetchText===fetchModelText?createSiteSearchSource('google',searchGoogle,query=>`${query} SPICE model datasheet`):undefined,allDatasheetSource:WebDiscovery|undefined=fetchText===fetchModelText?createSiteSearchSource('alldatasheet',searchAllDatasheet):undefined,stSource:((query:string)=>Promise<StProductDiscovery>)|undefined=fetchText===fetchModelText?searchStPublicCatalog:undefined,stPreview:(query:string,url:string)=>Promise<ModelDownloadPreview>=previewStSpiceModel,jlcSource:((query:string)=>Promise<JlcCatalogStatus>)|undefined=fetchText===fetchModelText?searchJlcCatalog:undefined,supplementalCatalogs:readonly SupplementalCatalog[]=manifest===pinnedDeclarations?[...WURTH_MODEL_CATALOGS,QUCS_MODEL_CATALOG]:[]){
  // Community archives remain readable for saved acquisitions, but the active
  // production library searches only the registered vendor libraries and OEMs.
  const includeCommunity=fetchText!==fetchModelText
  const activeCatalogs=includeCommunity?supplementalCatalogs:supplementalCatalogs.filter(catalog=>WURTH_MODEL_CATALOGS.some(vendor=>vendor.repo===catalog.repo&&vendor.revision===catalog.revision))
  let indexPromise:Promise<Index>|undefined,indexTime=0
  const textCache=new Map<string,Promise<string>>(),candidates=new Map<string,ModelSearchCandidate>()
  const stPreviews=new Map<string,ModelDownloadPreview>()
  const rawUrl=(repo:string,revision:string,path:string)=>`https://raw.githubusercontent.com/${repo}/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`
  async function index():Promise<Index>{
    if(indexPromise&&Date.now()-indexTime<3600_000)return indexPromise
    indexTime=Date.now()
    indexPromise=withoutModelRequestCancellation(()=>fetchText(`https://api.github.com/repos/${community}/git/trees/master?recursive=1`,2*1024*1024)).then(text=>{
      const data=JSON.parse(text)
      if(data.truncated||!/^[a-f0-9]{40}$/.test(data.sha)||!Array.isArray(data.tree))throw new Error('在线模型索引不完整，请稍后重试')
      return {revision:data.sha,files:data.tree.filter((entry:{type:string;path:string;size:number})=>entry.type==='blob'&&typeof entry.path==='string'&&safePath(entry.path)&&entry.path.startsWith('Models/')&&modelFilePattern.test(entry.path)&&entry.size<=1024*1024)}
    }).catch(error=>{indexPromise=undefined;throw error})
    return indexPromise
  }
  function cachedText(url:string){
    let value=textCache.get(url)
    if(!value){if(textCache.size>=16)textCache.delete(textCache.keys().next().value!);value=withoutModelRequestCancellation(()=>(fetchText===fetchModelText?readMaterializedSourceText(url).then(local=>local??fetchText(url)):fetchText(url))).catch(error=>{textCache.delete(url);throw error});textCache.set(url,value)}
    return value
  }
  function candidate(repo:string,revision:string,path:string,names:string[],match?:ModelSearchCandidate['match'],catalog?:SupplementalCatalog):ModelSearchCandidate {
    const url=rawUrl(repo,revision,path),id=createHash('sha256').update(url).digest('hex'),isOfficial=repo===official
    const source:SpiceModelSource=catalog?{label:catalog.label,url,license:catalog.license,attribution:catalog.attribution}:{label:isOfficial?'KiCad 官方仿真示例':'KiCad-Spice-Library 社区收集库（非 KiCad 官方）',url,license:isOfficial?'CC BY-SA 4.0；KiCad demos/*，保留署名及相同方式共享':'模型各自适用原作者/厂商条款；仓库 GPL-3.0 仅覆盖 Scripts，下载不代表取得再分发授权',attribution:isOfficial?'KiCad project and contributors；模型电气参数保留':'社区收集库贡献者；原作者/厂商署名见原始模型文件，原始文件随预览提供'}
    const result={id,name:path.split('/').at(-1)!,path,source,matchedModels:names,match}
    if(candidates.size>=240)candidates.delete(candidates.keys().next().value!)
    candidates.set(id,result);return result
  }
  async function manufacturerCandidates(query:string):Promise<ModelSearchCandidate[]>{
    // The product page is the discoverable source of every download URL. No
    // guessed TI document IDs, search-engine redirects or arbitrary hosts.
    if(!/^(?:OPA|TLV|TLC|TL|LM|TPS|REF|INA|UCC|NE)[A-Z0-9-]{1,35}$/i.test(query))return []
    const productUrl=`https://www.ti.com/product/${query.toUpperCase()}`,html=await fetchText(productUrl,2*1024*1024),found:ModelSearchCandidate[]=[]
    for(const match of html.matchAll(/<a\b([^>]*?)>([\s\S]*?)<\/a>/gi)){
      const href=match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1],label=match[2].replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim()
      if(!href||!/(?:PSpice|TINA.{0,8}Spice|Spice)\s+Model/i.test(label))continue
      const url=new URL(href,productUrl)
      if(url.hostname!=='www.ti.com'||!/^\/lit\/zip\/[a-z0-9]{3,20}$/i.test(url.pathname)||url.search)continue
      allowedModelUrl(url.href)
      const id=createHash('sha256').update(url.href).digest('hex')
      if(found.some(item=>item.id===id))continue
      const source:SpiceModelSource={label:'Texas Instruments 官方模型',url:url.href,license:'Texas Instruments 厂商模型，保留原文件版权与使用条款；下载不代表获得再分发授权',attribution:`下载链接来自官方器件页 ${productUrl}；完整版权和免责声明见下载源码。`}
      const item={id,name:label.slice(0,180),path:url.pathname,source,matchedModels:[query.toUpperCase()],match:'related' as const}
      if(candidates.size>=240)candidates.delete(candidates.keys().next().value!)
      candidates.set(id,item);found.push(item)
      if(found.length>=4)break
    }
    return found
  }
  function indexedCandidates(query:string):ModelSearchCandidate[]{
    const results:ModelSearchCandidate[]=[]
    // The pinned declaration index covers all eligible files, including
    // models whose part number is absent from the filename. It is generated
    // from the original archive, and every result downloads that pinned file.
    const declarationHits=manifest.files.map(([path,names])=>{
      return {path,...selectModelDeclarations(names,query,4)}
    }).filter(hit=>hit.names.length).sort((a,b)=>Number(b.match==='exact')-Number(a.match==='exact')||a.path.length-b.path.length).slice(0,18)
    if(includeCommunity)for(const hit of declarationHits)results.push(candidate(community,manifest.revision,hit.path,hit.names,hit.match as ModelSearchCandidate['match']))
    for(const catalog of activeCatalogs){
      const hits=catalog.files.map(file=>{
        const names=catalog.repo===QUCS_MODEL_CATALOG.repo?[...file.names,...(QUCS_MODEL_CATALOG.files.find(item=>item.path===file.path)?.models.map(model=>model.adaptedId)??[])]:file.names
        return {file,...selectModelDeclarations(names,query,6)}
      }).filter(hit=>hit.names.length).sort((a,b)=>Number(b.match==='exact')-Number(a.match==='exact')||a.file.path.length-b.file.path.length).slice(0,12)
      for(const hit of hits)results.push(candidate(catalog.repo,catalog.revision,hit.file.path,hit.names,hit.match,catalog))
    }
    if(includeCommunity)for(const file of officialLibraries){const matched=selectModelDeclarations(file.names,query);if(matched.names.length)results.push(candidate(official,officialRevision,file.path,matched.names,matched.match))}
    return results
  }
  function rankedCandidates(results:ModelSearchCandidate[]):ModelSearchCandidate[]{
    const unique=new Map<string,ModelSearchCandidate>()
    const strength=(item:ModelSearchCandidate)=>item.match==='exact'?0:item.match==='related'?1:2
    for(const item of results){const old=unique.get(item.id);if(!old||strength(item)<strength(old))unique.set(item.id,item)}
    return [...unique.values()].sort((a,b)=>{
      const rank=(item:ModelSearchCandidate)=>item.match==='exact'?0:item.source.label==='Texas Instruments 官方模型'?1:item.match==='related'?2:3
      const vendor=(item:ModelSearchCandidate)=>supplementalCatalogs.some(catalog=>item.source.label===catalog.label)?0:1
      return rank(a)-rank(b)||vendor(a)-vendor(b)
    })
  }
  function validateQuery(query:string){
    if(typeof query!=='string'||!/^[a-z0-9][a-z0-9_. +\/-]{1,47}$/i.test(query.trim()))throw new Error('请输入 2–48 位器件型号，例如 2N3904、1N4148、IRF540')
  }
  return {
    async lookup(query:string):Promise<ModelSearchResults>{
      validateQuery(query)
      const results=rankedCandidates(indexedCandidates(query))
      return {candidates:results,notices:results.length?[]:['已检索三套来源库的登记模型索引；没有匹配型号，可让模型助手继续查找厂商官网或规格书。'],indexedFiles:(includeCommunity?manifest.files.length+officialLibraries.length:0)+activeCatalogs.reduce((total,catalog)=>total+catalog.files.filter(file=>file.names.length).length,0),coverage:'complete'}
    },
    async search(query:string):Promise<ModelSearchResults>{
      validateQuery(query)
      const needle=query.trim().toLowerCase(),notices:string[]=[],results:ModelSearchCandidate[]=[]
      const lcscPromise=lcscSource?Promise.resolve().then(()=>lcscSource(query.trim())).catch((error):LcscSourceStatus=>({source:'lcsc',label:'立创商城',state:'unavailable',searchUrl:`https://so.szlcsc.com/global.html?k=${encodeURIComponent(query.trim())}`,detail:`立创商城搜索暂不可用：${(error as Error).message}`})):undefined
      const semieePromise=semieeSource?Promise.resolve().then(()=>semieeSource(query.trim())).catch((error):SemieeSourceStatus=>({source:'semiee',label:'半导小芯 Semiee',state:'unavailable',searchUrl:`https://www.semiee.com/search?searchModel=${encodeURIComponent(query.trim())}`,detail:`Semiee 搜索暂不可用：${(error as Error).message}`})):undefined
      const googlePromise=googleSource?Promise.resolve().then(()=>googleSource(query.trim())).catch((error):ModelSearchSourceStatus=>({source:'google',label:'Google',state:'unavailable',searchUrl:`https://www.google.com/search?q=${encodeURIComponent(query.trim()+' SPICE model datasheet')}`,detail:`Google 搜索暂不可用：${(error as Error).message}`})):undefined
      const allDatasheetPromise=allDatasheetSource?Promise.resolve().then(()=>allDatasheetSource(query.trim())).catch((error):ModelSearchSourceStatus=>({source:'alldatasheet',label:'AllDataSheet',state:'unavailable',searchUrl:`https://www.alldatasheet.com/view.jsp?Searchword=${encodeURIComponent(query.trim())}`,detail:`AllDataSheet 搜索暂不可用：${(error as Error).message}`})):undefined
      const jlcPromise=jlcSource?Promise.resolve().then(()=>jlcSource(query.trim())).catch((error):JlcCatalogStatus=>({source:'jlc',label:'JLCPCB 器件目录',state:'unavailable',searchUrl:jlcCatalogSearchUrl(query.trim()),detail:`JLCPCB 目录暂不可用：${(error as Error).message}`,results:[]})):undefined
      // Attach the rejection handler before other catalogs and network work;
      // a fast ST failure must not become an unhandled detached promise.
      const stPromise=stSource&&/^[a-z0-9][a-z0-9_.-]{1,47}$/i.test(query.trim())?Promise.resolve().then(()=>stSource(query.trim())).catch(error=>({source:'st' as const,label:'STMicroelectronics 原厂产品目录',state:'unavailable' as const,query:query.trim(),resources:[],detail:`ST 原厂目录暂不可用：${(error as Error).message}`})):undefined
      let partial=false
      results.push(...indexedCandidates(query))
      const tiProduct=/^(?:OPA|TLV|TLC|TL|LM|TPS|REF|INA|UCC|NE)[A-Z0-9-]{1,35}$/i.test(query.trim())
      if(tiProduct)try{results.push(...await manufacturerCandidates(query.trim()))}catch(error){partial=true;notices.push(`TI 厂商目录暂不可用：${(error as Error).message}`)}
      if(stPromise)try{
        const product=await stPromise
        if(product.state==='unavailable'){partial=true;notices.push(product.detail)}
        if(product.state==='found')for(const resource of product.resources.filter(item=>item.kind==='spice-model').slice(0,3)){
          try{
            const preview=await stPreview(query.trim(),resource.url)
            const exact=preview.models.find(model=>model.id.toLowerCase()===needle)
            if(!exact)throw new Error('下载文件未包含准确型号')
            const id=createHash('sha256').update(resource.url).update(needle).digest('hex')
            if(stPreviews.size>=40)stPreviews.delete(stPreviews.keys().next().value!)
            stPreviews.set(id,preview)
            const item:ModelSearchCandidate={id,name:`${exact.id} · ST 原厂 SPICE 模型`,path:resource.url,source:preview.source,matchedModels:[exact.id],match:'exact'}
            if(candidates.size>=240)candidates.delete(candidates.keys().next().value!)
            candidates.set(id,item);results.push(item)
          }catch(error){notices.push(`ST 官网 ${resource.title} 尚不能导入：${(error as Error).message}`)}
        }
      }catch(error){partial=true;notices.push(`ST 官网公开目录暂不可用：${(error as Error).message}`)}
      let online:Index|undefined
      if(includeCommunity)try{online=await index()}catch(error){partial=true;notices.push(`实时社区索引暂不可用：${(error as Error).message}；仍已检索固定版本的 ${manifest.files.length} 份模型源码声明。`)}
      const paths=online?.files.filter(file=>modelFilenameMatches(file.path,query)).sort((a,b)=>a.path.length-b.path.length).slice(0,16)??[]
      for(const file of paths)results.push(candidate(community,online!.revision,file.path,[],'filename'))
      const catalogs=await Promise.allSettled(commonLibraries.map(async path=>{
        if(!online)return undefined
        const body=await cachedText(rawUrl(community,online.revision,path)),names=[...body.matchAll(/^\s*\.(?:model|subckt)\s+(\S+)/gim)].map(match=>match[1]),matched=selectModelDeclarations([...new Set(names)],query,20)
        return matched.names.length?candidate(community,online.revision,path,matched.names,matched.match):undefined
      }))
      for(const result of catalogs){if(result.status==='fulfilled'&&result.value)results.push(result.value);else if(result.status==='rejected'){partial=true;notices.push(`部分通用模型目录暂不可用：${(result.reason as Error).message}`)}}
      const sourceStatuses:ModelSearchSourceStatus[]=[]
      const semieeStatus=await semieePromise
      const lcscStatus=await lcscPromise
      const googleStatus=await googlePromise
      const allDatasheetStatus=await allDatasheetPromise
      for(const status of [semieeStatus,lcscStatus,googleStatus,allDatasheetStatus])if(status){
        sourceStatuses.push(status)
        if(status.state==='unavailable')partial=true
      }
      const jlcStatus=await jlcPromise
      if(jlcStatus){sourceStatuses.push(jlcCatalogSourceStatus(jlcStatus));if(jlcStatus.state==='unavailable')partial=true}
      if(!results.length)notices.push(partial?'已检索固定版本模型目录，但部分在线来源不可用；目前不能断言该型号没有公开模型。可重试、查看厂商官网或使用规格书建模。':'已检索可访问的登记来源，没有找到匹配项；这不代表全网没有模型。请核对完整型号与封装后缀，或查找厂商规格书。规格书建模只生成标明来源和局限的 APPROX 候选。')
      const ranked=rankedCandidates(results)
      return {candidates:ranked,notices:[...new Set(notices)],indexedFiles:(includeCommunity?(online?.files.length??manifest.files.length)+officialLibraries.length:0)+activeCatalogs.reduce((total,catalog)=>total+catalog.files.filter(file=>file.names.length).length,0),coverage:partial?'partial':'complete',sourceStatuses}
    },
    async download(id:string):Promise<ModelDownloadPreview>{
      if(fetchText===fetchModelText){const materialized=await readMaterializedModelPreview(id);if(materialized)return materialized}
      const item=candidates.get(id)
      if(!item)throw new Error('搜索结果已过期，请重新搜索；不接受自定义下载地址')
      const st=stPreviews.get(id)
      if(st)return structuredClone(st)
      const isQucs=item.source.url!.startsWith(`https://raw.githubusercontent.com/${QUCS_MODEL_CATALOG.repo}/${QUCS_MODEL_CATALOG.revision}/`)
      const adapted=isQucs?adaptQucsSpiceLibrary(await cachedText(item.source.url!),item.path):undefined
      const bundle=adapted?{text:adapted.text,paths:[item.path]}:item.source.url!.startsWith('https://www.ti.com/')?{text:decodeModelArchive(await fetchBytes(item.source.url!)),paths:[]}:await fetchGithubModelBundle(item.source.url!,cachedText)
      const text=bundle.text
      const comments=text.split(/\r?\n/).filter(line=>/^\s*\*/.test(line)&&/copyright|author|license|national|manufacturer|model by/i.test(line)).slice(0,5).map(line=>line.replace(/^\s*\*\s*/,'')).join('；').slice(0,600)
      const dependencies=bundle.paths.length>1?`。同版本依赖：${bundle.paths.slice(1).join('、')}`:''
      const adaptation=adapted?`。本机适配：模型及辅助定义以 _QUCS/独立命名空间区分；POLY 常数系数等价表达式转换，保留完整电气网络，未改参；原作者与厂商条款见原始下载文件。${adapted.adaptations.join('；')}`:''
      const source={...item.source,attribution:`${item.source.attribution}${adaptation}${comments?`。文件署名摘录：${comments}`:''}${dependencies}`.slice(0,1000)}
      const preview={...parseAcquiredModelLibrary(text,source),source,text}
      return preview
    },
  }
}
function localOrigin(req:IncomingMessage){return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')&&/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(req.headers.host??'')&&req.headers.origin===`http://${req.headers.host}`&&req.headers['sec-fetch-site']!=='cross-site'}
export function createModelSearchMiddleware(service:import('../src/core/agent-models').AgentModelService=createOnlineModelService(),bodyDeadlineMs=10_000){
  // Registered/local lookup remains available while online discovery or a
  // download is busy. Only distinct operations occupy these bounded lanes.
  const lookups=createModelRequestScheduler(2,32,20_000),online=createModelRequestScheduler(3,16,40_000)
  return async(req:IncomingMessage,res:ServerResponse,next:()=>void)=>{
    const path=req.url?.split('?')[0]
    if(!['/api/model-library/search','/api/model-library/lookup','/api/model-library/download'].includes(path??'')){next();return}
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff')
    const send=(status:number,value:object)=>{if(res.destroyed||res.writableEnded)return;res.statusCode=status;res.end(JSON.stringify(value))}
    if(!localOrigin(req)){send(403,{error:'在线模型服务只接受本机工作台同源请求'});return}
    if(req.method!=='POST'){res.setHeader('Allow','POST');send(405,{error:'仅接受 POST'});return}
    if(req.url?.includes('?')||!req.headers['content-type']?.startsWith('application/json')){send(400,{error:'需要 JSON 请求，不接受网址参数'});return}
    const consumer=new AbortController()
    const disconnected=()=>{if(!res.writableEnded)consumer.abort(new ModelRequestError('工作台已取消模型请求',499))}
    req.once('aborted',disconnected);res.once('close',disconnected)
    const bodyDeadline=setTimeout(()=>req.destroy(new Error('模型请求读取超时')),bodyDeadlineMs)
    try{
      let body=''
      for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>1024)throw new Error('请求超过大小限制')}
      clearTimeout(bodyDeadline)
      const data=JSON.parse(body),key=path?.endsWith('/download')?'id':'query'
      if(!data||typeof data!=='object'||Object.keys(data).length!==1||typeof data[key]!=='string'||data[key].length>100)throw new Error('请求参数不正确')
      consumer.signal.throwIfAborted()
      const value=data[key].trim(),operation=path!.split('/').at(-1)!
      if(!value)throw new Error('请求参数不能为空')
      const sharedKey=`${operation}:${key==='query'?value.toUpperCase():value}`
      if(path?.endsWith('/lookup')){
        if(!service.lookup)throw new Error('登记模型检索服务未启用，请重新启动工作台')
        send(200,await lookups.schedule(sharedKey,()=>service.lookup!(value),consumer.signal))
      }else send(200,await online.schedule<ModelSearchResults|ModelDownloadPreview>(sharedKey,()=>key==='query'?service.search(value):service.download(value),consumer.signal))
    }catch(error){if(!consumer.signal.aborted)send(error instanceof ModelRequestError?error.status:400,{error:(error as Error).message||'在线模型请求失败'})}finally{clearTimeout(bodyDeadline);req.removeListener('aborted',disconnected);res.removeListener('close',disconnected)}
  }
}
