/** Discovery through ST's published sitemap and product pages, without guessed file paths. */
import {unzipSync} from 'fflate'
import {decodeSpiceLibrary,parseSpiceLibrary, type ImportedSpiceModel} from '../src/core/spice-models'
import type {ModelDownloadPreview} from '../src/core/model-search'
export interface StResource { kind:'datasheet'|'spice-model';url:string;title:string }
export interface StProductDiscovery { source:'st';label:string;state:'found'|'not-found'|'unavailable';query:string;productUrl?:string;resources:StResource[];detail:string }

const host='https://www.st.com'
const sitemapIndex=`${host}/content/st_com/sitemap-index.xml`
const maxIndex=100_000,maxSitemap=3_000_000,maxProduct=2_000_000
type ReadText=(url:string,limit:number)=>Promise<string>

function approvedUrl(raw:string,kind:'sitemap'|'product'|'resource'):URL{
  const url=new URL(raw,host)
  if(url.origin!==host||url.username||url.password||url.hash||url.search)throw new Error('ST 来源地址不在允许范围内')
  const valid=kind==='sitemap'?url.pathname==='/content/st_com/sitemap-index.xml'||/^\/content\/st_com\/sitemap\d{1,2}\.xml$/.test(url.pathname):
    kind==='product'?/^\/en\/[a-z0-9-]+\/[a-z0-9_.-]+\.html$/i.test(url.pathname):
    /^\/resource\/en\/(?:datasheet\/[a-z0-9_.-]+\.pdf|spice_model\/[a-z0-9_.-]+\.zip)$/i.test(url.pathname)
  if(!valid)throw new Error('ST 来源地址类型不受支持')
  return url
}
async function readStText(raw:string,limit:number):Promise<string>{
  const kind=raw===sitemapIndex||raw.includes('/content/st_com/sitemap')?'sitemap':'product'
  const url=approvedUrl(raw,kind)
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(8_000),headers:{'Accept':kind==='sitemap'?'application/xml,text/xml':'text/html','User-Agent':'SPICE-Workbench/0.26 (manufacturer catalog discovery)'}})
  if(response.status!==200)throw new Error(`ST 官网返回 HTTP ${response.status}`)
  if(Number(response.headers.get('content-length')||0)>limit)throw new Error('ST 页面超过大小限制')
  const type=response.headers.get('content-type')||''
  if(!/xml|html|text\/plain/i.test(type))throw new Error('ST 官网返回非文本页面')
  const reader=response.body?.getReader();if(!reader)throw new Error('ST 页面内容为空')
  const chunks:Uint8Array[]=[];let size=0
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit)throw new Error('ST 页面超过大小限制');chunks.push(part.value)}}finally{reader.releaseLock()}
  const buffer=new Uint8Array(size);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length}
  return new TextDecoder('utf-8',{fatal:true}).decode(buffer)
}
function locations(xml:string){return [...xml.matchAll(/<loc>\s*([^<]{1,400})\s*<\/loc>/gi)].map(match=>match[1].trim().replace(/&amp;/g,'&'))}
function sitemapProducts(contents:string[]){
  const products=new Map<string,string>()
  for(const xml of contents)for(const raw of locations(xml)){
    try{const url=approvedUrl(raw,'product');const name=url.pathname.split('/').at(-1)!.replace(/\.html$/i,'').toLowerCase();if(!products.has(name))products.set(name,url.href)}catch{/* Ignore non-product and translated pages. */}
  }
  return products
}
function productResources(html:string){
  const found:StResource[]=[],seen=new Set<string>()
  for(const match of html.matchAll(/<a\b([^>]{0,2000})>/gi)){
    const href=match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2]
    if(!href)continue
    try{
      const url=approvedUrl(href,'resource')
      if(seen.has(url.href))continue
      seen.add(url.href)
      const kind=url.pathname.includes('/spice_model/')?'spice-model':'datasheet'
      const title=match[1].match(/\bdata-file-name\s*=\s*(["'])(.*?)\1/i)?.[2]?.replace(/<[^>]*>/g,'').slice(0,120)||url.pathname.split('/').at(-1)!
      found.push({kind,url:url.href,title})
      if(found.length>=12)break
    }catch{/* Not an approved ST datasheet or SPICE archive. */}
  }
  return found
}

/** Caller may inject a bounded fixture reader; default reader never follows redirects. */
export function createStPublicCatalog(readText:ReadText=readStText){
  let saved:Promise<Map<string,string>>|undefined,expires=0
  async function catalog(){
    if(saved&&Date.now()<expires)return saved
    saved=(async()=>{
      const index=await readText(sitemapIndex,maxIndex)
      const sitemapUrls=locations(index).map(raw=>approvedUrl(raw,'sitemap').href)
      if(!sitemapUrls.length||sitemapUrls.length>20)throw new Error('ST sitemap 索引结构异常')
      const xml=await Promise.all(sitemapUrls.map(url=>readText(url,maxSitemap)))
      return sitemapProducts(xml)
    })()
    expires=Date.now()+6*60*60*1000
    saved.catch(()=>{saved=undefined;expires=0})
    return saved
  }
  return async(query:string):Promise<StProductDiscovery>=>{
    const part=typeof query==='string'?query.trim():''
    if(!/^[a-z0-9][a-z0-9_.-]{1,47}$/i.test(part))throw new Error('ST 产品搜索需要 2–48 位器件型号')
    const base={source:'st' as const,label:'STMicroelectronics 原厂产品目录',query:part,resources:[] as StResource[]}
    try{
      const page=(await catalog()).get(part.toLowerCase())
      if(!page)return{...base,state:'not-found',detail:'ST 官方 sitemap 中没有该准确型号；不能由此判断其他厂家没有资料。'}
      const html=await readText(page,maxProduct),resources=productResources(html)
      return{...base,state:'found',productUrl:page,resources,detail:resources.length?`ST 官方产品页列出 ${resources.length} 个可核对的资料文件；SPICE ZIP 仍需验证语法与引脚。`:'ST 官方目录有此产品页，但页面未列出可识别的 PDF 或 SPICE ZIP。'}
    }catch(error){return{...base,state:'unavailable',detail:`ST 官方目录暂不可用：${(error as Error).message}`}}
  }
}

export const searchStPublicCatalog=createStPublicCatalog()

type ReadBytes=(url:string,limit:number)=>Promise<Uint8Array>
async function readStModelZip(raw:string,limit:number):Promise<Uint8Array>{
  const url=approvedUrl(raw,'resource')
  if(!url.pathname.startsWith('/resource/en/spice_model/'))throw new Error('仅接受 ST 原厂 SPICE ZIP')
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(8_000),headers:{Accept:'application/zip','User-Agent':'SPICE-Workbench/0.26 (manufacturer model download)'}})
  if(response.status!==200)throw new Error(`ST 模型文件返回 HTTP ${response.status}`)
  if(Number(response.headers.get('content-length')||0)>limit)throw new Error('ST 模型 ZIP 超过大小限制')
  const reader=response.body?.getReader();if(!reader)throw new Error('ST 模型文件内容为空')
  const chunks:Uint8Array[]=[];let size=0
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit)throw new Error('ST 模型 ZIP 超过大小限制');chunks.push(part.value)}}finally{reader.releaseLock()}
  const buffer=new Uint8Array(size);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length}
  return buffer
}

/** Preserve ST's original source and comments; accept only a parser-supported exact declaration. */
export async function previewStSpiceModel(part:string,resourceUrl:string,readBytes:ReadBytes=readStModelZip):Promise<ModelDownloadPreview>{
  if(!/^[a-z0-9][a-z0-9_.-]{1,47}$/i.test(part.trim()))throw new Error('ST 模型需要准确器件型号')
  const approved=approvedUrl(resourceUrl,'resource')
  if(!approved.pathname.startsWith('/resource/en/spice_model/'))throw new Error('所选文件不是 ST SPICE 模型 ZIP')
  const archive=await readBytes(approved.href,1024*1024)
  if(archive.byteLength>1024*1024||archive[0]!==0x50||archive[1]!==0x4b)throw new Error('ST 未返回有效 ZIP 模型包')
  let count=0,total=0
  const contents=unzipSync(archive,{filter(file){
    if(!/\.(?:lib|mod|cir|spice|txt)$/i.test(file.name))return false
    if(file.name.length>250||file.name.startsWith('/')||/[\\\x00-\x1f]/.test(file.name)||file.name.split('/').some(piece=>piece==='..'||piece==='.')||file.compression!==0&&file.compression!==8)throw new Error('ST 模型 ZIP 含不支持的文件路径')
    if(++count>32||file.originalSize>500_000||(total+=file.originalSize)>1024*1024)throw new Error('ST 模型 ZIP 解压大小超出限制')
    return true
  }})
  if(!Object.keys(contents).length)throw new Error('ST ZIP 中没有可读取的 SPICE 文本')
  const source=Object.entries(contents).map(([name,bytes])=>`* Archive file: ${name}\n${decodeSpiceLibrary(bytes)}`).join('\n\n')
  const modelSource={label:'STMicroelectronics 原厂 SPICE 模型',url:approved.href,license:'来自 ST 官方产品页；使用范围与授权以 ST 原始下载文件条款为准',attribution:'STMicroelectronics；保留原始模型定义'}
  const preview=parseSpiceLibrary(source,modelSource)
  const exact=preview.models.find(model=>model.id.toLowerCase()===part.trim().toLowerCase())
  if(!exact)throw new Error(preview.diagnostics.find(item=>item.severity==='error')?.message||`ST 模型 ZIP 中没有准确型号 ${part.trim()} 的可导入定义`)
  return{models:[exact],diagnostics:preview.diagnostics,source:modelSource,text:source}
}

export async function importStSpiceModel(part:string,resourceUrl:string,readBytes:ReadBytes=readStModelZip):Promise<ImportedSpiceModel>{return(await previewStSpiceModel(part,resourceUrl,readBytes)).models[0]}
