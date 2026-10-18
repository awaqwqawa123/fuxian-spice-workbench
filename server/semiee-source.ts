import { request as httpsRequest } from 'node:https'
import { lookup } from 'node:dns'
import { publicAddress } from './public-network'
import { approvedProxyFor, assertPublicDatasheetHost, loopbackProxyAgent } from './datasheet-proxy'

export interface SemieeSourceStatus {
  source:'semiee'
  label:string
  state:'searched'|'restricted'|'unavailable'
  searchUrl:string
  detail:string
  resultCount?:number
}

const origin='https://www.semiee.com'
const partPattern=/^[a-z0-9][a-z0-9_. +\/-]{1,47}$/i

export function semieeSearchUrl(part:string):string {
  const value=part.trim()
  if(!partPattern.test(value))throw new Error('Semiee 搜索需要 2–48 位器件型号')
  return `${origin}/search?searchModel=${encodeURIComponent(value)}`
}

/** The site's public search page is a shell; its own script requests this JSON endpoint. */
export function semieeLookupUrl(part:string):string {
  semieeSearchUrl(part)
  const url=new URL('/bdxx-api/chip/v5/rich/search',origin)
  url.searchParams.set('pageIndex','0')
  url.searchParams.set('pageSize','30')
  url.searchParams.set('model',part.trim())
  return url.href
}

export async function fetchSemieeLookup(url:string):Promise<unknown> {
  const target=new URL(url)
  if(target.origin!==origin||target.pathname!=='/bdxx-api/chip/v5/rich/search'||target.username||target.password||target.hash||
    [...target.searchParams.keys()].sort().join(',')!=='model,pageIndex,pageSize'||target.searchParams.get('pageIndex')!=='0'||target.searchParams.get('pageSize')!=='30'){
    throw new Error('Semiee 查询地址不受支持')
  }
  semieeSearchUrl(target.searchParams.get('model')??'')
  const proxy=await approvedProxyFor(target.hostname)
  if(proxy)await assertPublicDatasheetHost(target.hostname)
  const tunnel=proxy?loopbackProxyAgent(proxy,target.hostname):undefined
  return new Promise((resolve,reject)=>{
    const request=httpsRequest(target,{agent:tunnel?.agent,headers:{'User-Agent':'SPICE-Workbench/0.25 (model-source-discovery)','Accept':'application/json'},lookup(host,options,done){
      lookup(host,{all:true},(error,addresses)=>{
        if(error){done(error,'',4);return}
        if(!addresses.length||addresses.some(item=>!publicAddress(item.address))){done(new Error('Semiee 解析到非公网地址'),'',4);return}
        if(options.all)(done as unknown as (error:null,records:{address:string;family:number}[])=>void)(null,addresses)
        else done(null,addresses[0].address,addresses[0].family)
      })
    }},response=>{
      if(response.statusCode!==200){response.resume();reject(new Error(`HTTP ${response.statusCode}；不跟随重定向`));return}
      if(!/^application\/json\b/i.test(String(response.headers['content-type']??''))){response.resume();reject(new Error('站点未返回 JSON 搜索结果'));return}
      if(Number(response.headers['content-length']??0)>256_000){response.destroy();reject(new Error('站点响应超过大小限制'));return}
      const chunks:Buffer[]=[];let size=0
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>256_000){response.destroy(new Error('站点响应超过大小限制'));return}chunks.push(chunk)})
      response.on('error',reject)
      response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{reject(new Error('站点搜索响应不是有效 JSON'))}})
    })
    const timer=setTimeout(()=>{const error=new Error('Semiee 查询超时');request.destroy(error);tunnel?.destroy(error)},8_000)
    request.on('close',()=>{clearTimeout(timer);tunnel?.destroy()});request.on('error',reject);request.end()
  })
}

/** Semiee indexes parts and datasheets; a part hit is never an importable SPICE model. */
export async function searchSemiee(part:string,fetchLookup:(url:string)=>Promise<unknown>=fetchSemieeLookup):Promise<SemieeSourceStatus> {
  const searchUrl=semieeSearchUrl(part)
  const base={source:'semiee' as const,label:'半导小芯 Semiee',searchUrl}
  try{
    const response=await fetchLookup(semieeLookupUrl(part))
    if(!response||typeof response!=='object')throw new Error('站点返回无法识别的响应')
    const data=response as {code?:unknown;remark?:unknown;message?:unknown;result?:unknown;total?:unknown}
    if(data.code===1&&/请登录|登录|浏览限制/.test(String(data.remark??data.message??'')))return {...base,state:'restricted',detail:'站点搜索接口返回“请登录”或浏览限制；请打开 Semiee 搜索页核对器件和资料。尚未核实该型号有公开 SPICE 模型。'}
    if(data.code===0&&Array.isArray(data.result)){
      const count=data.result.filter(item=>item&&typeof item==='object'&&Number((item as {type?:unknown}).type)===5).length
      return {...base,state:'searched',resultCount:count,detail:`Semiee 当前搜索页返回 ${count} 条本页器件记录。它们可能提供规格书；尚未核实可下载的 SPICE 模型，请在原站核对。`}
    }
    throw new Error('站点未提供可识别的公开搜索结果')
  }catch(error){return {...base,state:'unavailable',detail:`Semiee 自动查询暂不可用（${(error as Error).message}）。可打开原站搜索页手动核对；不能据此判断该型号没有模型。`}}
}
