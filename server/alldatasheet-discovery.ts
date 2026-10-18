import { lookup } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { approvedProxyFor, assertPublicDatasheetHost, loopbackProxyAgent } from './datasheet-proxy'
import { publicAddress } from './public-network'

/** AllDataSheet discovery returns page links only. A result is neither a PDF nor a SPICE model. */
export interface AllDatasheetDiscovery {
  source:'alldatasheet'
  label:string
  state:'searched'|'restricted'|'unavailable'
  searchUrl:string
  detail:string
  resultCount?:number
  results:{url:string;title:string}[]
}

const ORIGIN='https://www.alldatasheet.com'
const LIMIT=512*1024
const TIMEOUT=5_000
type FetchHtml=(url:string,signal?:AbortSignal)=>Promise<string|{status:number;html:string;url?:string}>

function decodeEntities(text:string){return text.replace(/&#(x[\da-f]+|\d+);/gi,(_,number)=>{const code=number[0]?.toLowerCase()==='x'?parseInt(number.slice(1),16):parseInt(number,10);return code>0&&code<=0x10ffff?String.fromCodePoint(code):''}).replace(/&(?:amp|quot|apos|lt|gt|nbsp);/gi,entity=>({'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' '}[entity.toLowerCase()]||entity))}
function plainText(html:string){return decodeEntities(html.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim().slice(0,180)}
function safeResult(raw:string,base:string):string|undefined{
  try{
    const url=new URL(decodeEntities(raw),base)
    if(url.protocol!=='https:'||url.hostname!=='www.alldatasheet.com'||url.username||url.password||url.port)return
    if(!/^\/datasheet-pdf\/(?:view|pdf)\/\d+\/[^/]+\/[^/?#]+\.html$/i.test(url.pathname))return
    url.search='';url.hash='';return url.href
  }catch{return undefined}
}
function parseResults(html:string,base:string){
  const results:{url:string;title:string}[]=[],seen=new Set<string>()
  for(const match of html.matchAll(/<a\b([^>]{0,1200})>([\s\S]{0,2000}?)<\/a>/gi)){
    const href=match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2]
    if(!href)continue
    const url=safeResult(href,base),title=plainText(match[2])
    if(url&&title&&!seen.has(url)){seen.add(url);results.push({url,title});if(results.length===20)break}
  }
  return results
}
async function fetchAllDatasheetHtml(url:string,signal?:AbortSignal):Promise<{status:number;html:string;url?:string}>{
  const target=new URL(url)
  if(target.origin!==ORIGIN||target.pathname!=='/view.jsp'||target.username||target.password||
    target.hash||target.searchParams.size!==1||!target.searchParams.has('Searchword'))throw new Error('AllDataSheet 查询地址不受支持')
  signal?.throwIfAborted()
  const proxy=await approvedProxyFor(target.hostname,signal)
  if(proxy)await assertPublicDatasheetHost(target.hostname,signal)
  signal?.throwIfAborted()
  const tunnel=proxy?loopbackProxyAgent(proxy,target.hostname):undefined
  return new Promise((resolve,reject)=>{
    // Use the same approved local proxy as the other datasheet sources. Do not
    // follow redirects or request URLs discovered in the returned page.
    const request=httpsRequest(target,{agent:tunnel?.agent,headers:{'User-Agent':'SPICE-Workbench/0.25 (local datasheet discovery)',Accept:'text/html','Accept-Encoding':'identity'},lookup(host,options,done){
      lookup(host,{all:true},(error,addresses)=>{
        if(error){done(error,'',4);return}
        if(!addresses.length||addresses.some(item=>!publicAddress(item.address))){done(new Error('AllDataSheet 解析到非公网地址'),'',4);return}
        if(options.all)(done as unknown as (error:null,records:{address:string;family:number}[])=>void)(null,addresses)
        else done(null,addresses[0].address,addresses[0].family)
      })
    }},response=>{
      const status=response.statusCode??503
      if(status!==200){response.resume();resolve({status,html:''});return}
      if(!/^text\/html\b/i.test(String(response.headers['content-type']??''))){response.resume();resolve({status:415,html:''});return}
      if(Number(response.headers['content-length']??0)>LIMIT){response.resume();resolve({status:413,html:''});return}
      const chunks:Buffer[]=[];let length=0
      response.on('data',(chunk:Buffer)=>{
        length+=chunk.length
        if(length>LIMIT){response.destroy(new Error('搜索页面超过大小限制'));return}
        chunks.push(chunk)
      })
      response.on('error',reject)
      response.on('end',()=>resolve({status:200,html:Buffer.concat(chunks).toString('utf8'),url}))
    })
    const abort=()=>{const error=new Error('AllDataSheet 查询已取消');request.destroy(error);tunnel?.destroy(error)}
    signal?.addEventListener('abort',abort,{once:true})
    request.on('close',()=>{signal?.removeEventListener('abort',abort);tunnel?.destroy()})
    request.on('error',reject)
    request.end()
  })
}

export async function searchAllDatasheet(query:string,fetchHtml:FetchHtml=fetchAllDatasheetHtml):Promise<AllDatasheetDiscovery>{
  const trimmed=typeof query==='string'?query.trim():''
  if(!/^[a-z0-9][a-z0-9_. +\/-]{1,47}$/i.test(trimmed))throw new Error('AllDataSheet 搜索需要 2–48 位器件型号')
  const searchUrl=`${ORIGIN}/view.jsp?Searchword=${encodeURIComponent(trimmed)}`
  const base={source:'alldatasheet' as const,label:'AllDataSheet 规格书索引',searchUrl,results:[] as {url:string;title:string}[]}
  const timeout=AbortSignal.timeout(TIMEOUT)
  try{
    const returned=await Promise.race([fetchHtml(searchUrl,timeout),new Promise<never>((_,reject)=>timeout.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}))])
    const payload=typeof returned==='string'?{status:200,html:returned}:returned
    if([202,403,429,503].includes(payload.status)||/just a moment|cf-chl|cloudflare challenge|captcha/i.test(payload.html.slice(0,10_000)))return{...base,state:'restricted',detail:`AllDataSheet 限制自动访问（HTTP ${payload.status} 或验证页面）；可在浏览器打开搜索页后手工下载规格书。`}
    if(payload.status!==200)return{...base,state:'unavailable',detail:`AllDataSheet 搜索暂不可用（HTTP ${payload.status}）；可稍后重试或打开搜索页。`}
    if(payload.html.length>LIMIT)return{...base,state:'unavailable',detail:'AllDataSheet 搜索页面超过大小限制；未提取候选链接。'}
    const results=parseResults(payload.html,searchUrl)
    return{...base,state:'searched',detail:results.length?'找到资料页线索；型号、规格书版本及下载内容仍需核对。':'搜索页没有可读取的匹配资料页；可在浏览器打开页面手工确认。',resultCount:results.length,results}
  }catch(error){return{...base,state:'unavailable',detail:timeout.aborted?'AllDataSheet 搜索超过 5 秒，已停止等待。':`AllDataSheet 搜索暂不可用：${(error as Error).message}`}}
}
