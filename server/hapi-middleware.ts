import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { parseProject } from '../src/core/circuit'
import { HapiError } from './hapi-client'
import { HapiManager, type HapiManagerOptions } from './hapi-manager'

const prefix='/api/hapi/'
function sameOrigin(req:IncomingMessage){
  const host=req.headers.host,origin=req.headers.origin
  if(!host||!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')||req.headers['sec-fetch-site']==='cross-site'||req.headers['x-fuxian-hapi']!=='1')return false
  if(origin&&origin!==`http://${host}`&&origin!==`https://${host}`)return false
  return req.method==='GET'||!!origin
}
function object(raw:unknown,keys:string[]){if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!keys.includes(k)))throw new HapiError(400,'HAPI 请求字段不正确');return raw as Record<string,any>}
function readBody(req:IncomingMessage,timeout:number):Promise<unknown>{return new Promise((resolve,reject)=>{
  const chunks:Buffer[]=[];let bytes=0,settled=false
  const timer=setTimeout(()=>fail(new HapiError(408,'请求正文接收超时')),timeout)
  function clean(){clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',fail);req.off('aborted',abort)}
  function fail(error:Error){if(settled)return;settled=true;clean();req.pause();reject(error)}
  function data(part:Buffer|string){const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>2_000_000)fail(new HapiError(413,'项目请求内容超过上限'));else chunks.push(chunk)}
  function end(){if(settled)return;settled=true;clean();try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{reject(new HapiError(400,'请求不是有效 JSON'))}}
  function abort(){fail(new HapiError(400,'请求已断开'))}
  if(Number(req.headers['content-length'])>2_000_000){fail(new HapiError(413,'项目请求内容超过上限'));return}
  req.on('data',data);req.once('end',end);req.once('error',fail);req.once('aborted',abort)
})}
export function createHapiMiddleware(options:HapiManagerOptions&{bodyTimeoutMs?:number;manager?:HapiManager}){
  const manager=options.manager??new HapiManager(options)
  const middleware=async(req:IncomingMessage,res:ServerResponse,next:()=>void)=>{
    if(!(req.url??'').split('?')[0].startsWith(prefix)){next();return}
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff')
    const reply=(status:number,value:unknown)=>{if(!res.destroyed){if(!req.complete)res.setHeader('Connection','close');res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value))}}
    try{
      if(!sameOrigin(req))throw new HapiError(403,'HAPI 连接只接受本机同源工作台请求')
      const url=new URL(req.url!,'http://localhost'),action=url.pathname.slice(prefix.length)
      if(action==='status'||action==='session'){
        if(req.method!=='GET')throw new HapiError(405,'状态接口使用 GET')
        if([...url.searchParams.keys()].some(k=>action==='status'||k!=='projectId'))throw new HapiError(400,'状态查询参数不正确')
        reply(200,action==='status'?await manager.status():await manager.session(url.searchParams.get('projectId')??''));return
      }
      if(!['connect','send','cancel','approval'].includes(action))throw new HapiError(404,'未找到 HAPI 接口')
      if(req.method!=='POST')throw new HapiError(405,'操作接口使用 POST')
      if(!req.headers['content-type']?.toLowerCase().startsWith('application/json'))throw new HapiError(415,'请求必须使用 application/json')
      const raw=await readBody(req,options.bodyTimeoutMs??10000)
      if(action==='connect'){const b=object(raw,['projectId','project']);let project;try{project=parseProject(b.project,{allowDraft:true})}catch(error){throw new HapiError(400,error instanceof Error?error.message:'项目格式错误')}reply(200,await manager.connect(b.projectId,project))}
      else if(action==='send'){const b=object(raw,['projectId','message','requestId']);reply(200,await manager.send(b.projectId,b.message,b.requestId))}
      else if(action==='cancel'){const b=object(raw,['projectId']);reply(200,await manager.cancel(b.projectId))}
      else {const b=object(raw,['projectId','id','decision','answers']);reply(200,await manager.approval(b.projectId,b.id,b.decision,b.answers))}
    }catch(error){reply(error instanceof HapiError?error.status:500,{error:error instanceof HapiError?error.message:'本机 HAPI 适配服务失败，请检查本地服务'})}
  }
  return Object.assign(middleware,{manager,close:()=>manager.close()})
}
export function hapiGatewayPlugin(options:Partial<HapiManagerOptions>={}):Plugin{
  let root=process.cwd()
  const install=(server:{middlewares:{use:(middleware:ReturnType<typeof createHapiMiddleware>)=>unknown};httpServer?:{once:(event:string,callback:()=>void)=>unknown}|null})=>{
    const middleware=createHapiMiddleware({...options,directory:options.directory??join(root,'.hapi-local'),projectDirectory:options.projectDirectory??root})
    server.middlewares.use(middleware);server.httpServer?.once('close',()=>{void middleware.close()})
  }
  return{name:'local-hapi-gateway',configResolved(config){root=config.root},configureServer:install,configurePreviewServer:install}
}
