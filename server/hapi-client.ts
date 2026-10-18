import { readFile, stat } from 'node:fs/promises'
import type { HapiApproval, HapiMessage } from '../src/core/hapi-types'

export class HapiError extends Error {
  constructor(readonly status:number,message:string,readonly uncertain=false){super(message)}
}
export const record=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{}
export const short=(value:unknown,max=2000)=>typeof value==='string'?value.slice(0,max):''
export interface HapiConnection {url:string;token:string;version:string;executable:string}
export async function readHapiConnection(file:string):Promise<HapiConnection>{
  let raw:Record<string,any>
  try { if((await stat(file)).size>16000)throw new Error();raw=record(JSON.parse(await readFile(file,'utf8'))) }
  catch{throw new HapiError(503,'HAPI 尚未安装或配置本机连接')}
  let url:URL
  try{url=new URL(raw.url)}catch{throw new HapiError(503,'HAPI 本机连接地址无效')}
  if(url.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||typeof raw.token!=='string'||raw.token.length<16||raw.token.length>4096||typeof raw.executable!=='string')throw new HapiError(503,'HAPI 连接只允许本机 Hub')
  return {url:url.origin,token:raw.token,version:short(raw.version,80),executable:raw.executable}
}

/** Our adapter uses HAPI's public client REST API, never its internal /cli API. */
export class HapiClient {
  private jwt=''
  private expires=0
  private refreshing:Promise<void>|null=null
  constructor(readonly connection:HapiConnection,private readonly fetcher:typeof fetch=fetch,private readonly timeout=12000){}
  private async raw(path:string,body:unknown|undefined,jwt?:string,timeout=this.timeout):Promise<any>{
    let response:Response
    try{response=await this.fetcher(`${this.connection.url}${path}`,{method:body===undefined?'GET':'POST',headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),...(jwt?{Authorization:`Bearer ${jwt}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeout),redirect:'error'})}
    catch{throw new HapiError(503,'无法确认 HAPI 是否收到请求；连接恢复后只查询状态，不自动重复发送',body!==undefined)}
    let data:unknown
    try{
      if(Number(response.headers.get('content-length'))>8_000_000)throw new Error()
      const reader=response.body?.getReader();if(!reader)throw new Error()
      const chunks:Uint8Array[]=[];let size=0
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8_000_000)throw new Error();chunks.push(part.value)}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
      data=JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }catch{throw new HapiError(502,'HAPI 返回内容不完整或超过上限',body!==undefined&&response.ok)}
    if(!response.ok){const message=short(record(data).error)||`HAPI 请求失败 (${response.status})`;throw new HapiError(response.status,this.redact(message),body!==undefined&&response.status>=500)}
    return data
  }
  redact(message:string){return message.split(this.connection.token).join('[已隐藏凭据]').split(this.jwt||'\0').join('[已隐藏凭据]').slice(0,2000)}
  private async authenticate(){
    if(this.jwt&&this.expires>Date.now())return
    if(this.refreshing)return this.refreshing
    this.refreshing=(async()=>{const data=await this.raw('/api/auth',{accessToken:this.connection.token});if(typeof data.token!=='string'||!data.token)throw new HapiError(502,'HAPI 身份验证没有返回会话凭据');this.jwt=data.token;this.expires=Date.now()+3.5*3600000})().finally(()=>{this.refreshing=null})
    return this.refreshing
  }
  async request(path:string,body?:unknown,timeout?:number):Promise<any>{
    if(!path.startsWith('/api/')||path.includes('..'))throw new HapiError(400,'不支持的 HAPI 接口')
    await this.authenticate();const used=this.jwt
    try{return await this.raw(path,body,used,timeout)}catch(error){
      if(!(error instanceof HapiError)||error.status!==401)throw error
      if(this.jwt===used){this.jwt='';this.expires=0}await this.authenticate()
      return this.raw(path,body,this.jwt,timeout)
    }
  }
  health(){return this.raw('/health',undefined)}
}

function envelope(raw:unknown):Record<string,any>{
  const value=record(raw),data=record(value.data),payload=record(value.payload)
  for(const candidate of [value,record(value.message),record(data.message),record(payload.message)])if(typeof candidate.role==='string'&&Object.hasOwn(candidate,'content'))return candidate
  return {}
}
/** Decode documented HAPI role envelopes; do not turn tool traffic into assistant prose. */
export function parseHapiMessages(raw:unknown):HapiMessage[]{
  if(!Array.isArray(raw))throw new HapiError(502,'HAPI 聊天记录格式不正确')
  const messages:HapiMessage[]=[]
  // A latest page may also pin queued rows outside its 200 regular messages.
  for(const value of raw){
    const item=record(value),wrapped=envelope(item.content),payload=wrapped.content,data=record(record(payload).data)
    if(typeof item.id!=='string'||typeof item.createdAt!=='number')continue
    let role:'user'|'assistant'='assistant',content=''
    if(wrapped.role==='user'){role='user';content=typeof payload==='string'?payload:short(record(payload).text,24000)}
    else if(wrapped.role==='agent'&&record(payload).type==='codex'){
      if(data.type==='message')content=short(data.message,24000)
      else if(data.type==='error')content=`HAPI 执行错误：${short(data.message,4000)}`
      else continue
    }else if(wrapped.role==='agent'&&typeof payload==='string')content=payload.slice(0,24000)
    else continue
    if(!content.trim())continue
    const id=short(item.localId,180)||item.id
    const delivery=role==='user'?(item.deliveryState==='indeterminate'?'unknown':item.invokedAt===null&&item.localId?'queued':'sent'):undefined
    messages.push({id,role,content,createdAt:item.createdAt,...(delivery?{delivery}:{})})
  }
  return messages.sort((a,b)=>a.createdAt-b.createdAt)
}
export function parseHapiApprovals(raw:unknown):HapiApproval[]{
  return Object.entries(record(raw)).slice(0,40).map(([id,value])=>{
    const request=record(value),args=record(request.arguments),tool=short(request.tool,150)
    const questions=Array.isArray(args.questions)?args.questions.slice(0,8).map((entry:unknown,index:number)=>{const q=record(entry);return{id:short(q.id,120)||short(q.question,120)||String(index),question:short(q.question,3000),options:(Array.isArray(q.options)?q.options:[]).slice(0,20).map((opt:unknown)=>{const o=record(opt);return{label:short(o.label,300),description:short(o.description,1000)}}),...(typeof q.multiSelect==='boolean'?{multiSelect:q.multiSelect}:{})}}):[]
    return{id,title:tool||'Codex 请求批准',detail:short(args.command,5000)||short(args.description,5000)||JSON.stringify(args,null,2).slice(0,6000),kind:questions.length?'question':'approval',...(questions.length?{questions}:{})}
  })
}
