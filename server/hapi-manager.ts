import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { parseProject, type Project } from '../src/core/circuit'
import { validWorkbenchProjectId } from '../src/core/codex-workbench-link'
import type { HapiSessionState, HapiStatus, HapiMessage } from '../src/core/hapi-types'
import { HapiClient, HapiError, parseHapiApprovals, readHapiConnection, record, short } from './hapi-client'
import { syncHapiHistory, type HapiHistory } from './hapi-history'
import { compactHapiReceipts, HapiReceiptStore, type HapiReceipt } from './hapi-receipts'

type Binding={projectId:string;sessionId:string|null;threadId:string|null;machineId:string;directory:string;connecting:boolean;receipts:HapiReceipt[];cache:HapiSessionState;history?:HapiHistory}
export interface HapiManagerOptions {directory:string;projectDirectory:string;fetcher?:typeof fetch;timeoutMs?:number}
const blank=(projectId:string):HapiSessionState=>({projectId,sessionId:null,threadId:null,status:'idle',messages:[],approvals:[],error:null,updatedAt:Date.now()})
const encoded=(id:string)=>encodeURIComponent(id)
const messageHash=(message:string)=>createHash('sha256').update(message).digest('hex')
const validId=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/.test(value)

export class HapiManager{
  private bindings=new Map<string,Binding>()
  private locks=new Map<string,Promise<unknown>>()
  private saving:Promise<unknown>=Promise.resolve()
  private ready:Promise<void>
  private client:HapiClient|null=null
  private receiptStore:HapiReceiptStore
  constructor(readonly options:HapiManagerOptions){this.receiptStore=new HapiReceiptStore(options.directory);this.ready=this.restore();void this.ready.catch(()=>{})}
  private async restore(){
    try{
      const file=join(this.options.directory,'bindings.json');if((await stat(file)).size>64_000_000)throw new Error('绑定记录超过上限')
      const data=JSON.parse(await readFile(file,'utf8'))
      if(data.version!==1||!Array.isArray(data.bindings)||data.bindings.length>100)throw new Error('绑定记录格式无效')
      for(const b of data.bindings){
        if(!validWorkbenchProjectId(b.projectId)||b.directory!==this.projectDirectory(b.projectId)||!Array.isArray(b.receipts)||b.sessionId!==null&&!validId(b.sessionId))throw new Error('项目会话绑定格式无效')
        for(let i=0;i<b.receipts.length;i++){const receipt=b.receipts[i];if(!validId(receipt.id)||!validId(receipt.hash))throw new Error('发送凭据格式无效');const durable=await this.receiptStore.read(b.projectId,receipt.id);if(durable)b.receipts[i]=durable;else await this.receiptStore.write(b.projectId,receipt)}
        b.receipts=compactHapiReceipts(b.receipts);this.bindings.set(b.projectId,b)
      }
    }catch(error){if(record(error).code!=='ENOENT')throw new HapiError(500,'HAPI 项目绑定文件不可读；未重建会话以避免丢失原绑定')}
  }
  private projectDirectory(id:string){return resolve(this.options.directory,'projects',id)}
  private validateProjectId(id:unknown):asserts id is string {if(!validWorkbenchProjectId(id)||id==='.'||id==='..')throw new HapiError(400,'项目编号格式不正确')}
  private async save(){
    const operation=this.saving.catch(()=>{}).then(async()=>{const text=JSON.stringify({version:1,bindings:[...this.bindings.values()]});if(Buffer.byteLength(text)>64_000_000)throw new HapiError(507,'HAPI 本地会话缓存超过上限');await mkdir(this.options.directory,{recursive:true});const file=join(this.options.directory,'bindings.json'),tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,text,{mode:0o600});await rename(tmp,file)})
    this.saving=operation;await operation
  }
  private async locked<T>(projectId:string,fn:()=>Promise<T>):Promise<T>{
    this.validateProjectId(projectId);await this.ready
    const previous=this.locks.get(projectId)??Promise.resolve(),current=previous.catch(()=>{}).then(fn)
    this.locks.set(projectId,current);try{return await current}finally{if(this.locks.get(projectId)===current)this.locks.delete(projectId)}
  }
  private async hub(){const c=await readHapiConnection(join(this.options.directory,'connection.json'));if(!this.client||JSON.stringify(this.client.connection)!==JSON.stringify(c))this.client=new HapiClient(c,this.options.fetcher,this.options.timeoutMs);return this.client}
  async status():Promise<HapiStatus>{
    let installed=false,version='',hubUrl:string|undefined
    try{
      const client=await this.hub();version=client.connection.version;hubUrl=client.connection.url
      installed=isAbsolute(client.connection.executable)&&(await stat(client.connection.executable)).isFile()
      if(!installed)return{installed:false,available:false,version,message:'HAPI 可执行文件不存在',hubUrl}
      const health=await client.health();if(health.status!=='ok')throw new HapiError(503,'HAPI Hub 未就绪')
      const machines=await client.request('/api/machines'),online=Array.isArray(machines.machines)?machines.machines.filter((m:any)=>m.active&&validId(m.id)):[]
      for(const m of online){if(m.runnerState?.capabilities?.codexSharedRuntime!==true)continue;const availability=await client.request(`/api/machines/${encoded(m.id)}/agent-availability`);if(Array.isArray(availability.agents)&&availability.agents.some((a:any)=>a.agent==='codex'&&a.available===true))return{installed:true,available:true,version,hubUrl,machineId:m.id,message:'HAPI Hub、共享会话 Runner 和 Codex 可用'}}
      return{installed:true,available:false,version,hubUrl,message:online.length?'Runner 未发现可用 Codex':'Hub 已连接，尚无在线 Runner'}
    }catch(error){return{installed,available:false,version,...(hubUrl?{hubUrl}:{}),message:this.error(error)}}
  }
  private error(error:unknown){return this.client?.redact(error instanceof HapiError?error.message:'HAPI 本地服务暂时不可用')??(error instanceof HapiError?error.message:'HAPI 本地服务暂时不可用')}
  private binding(id:string){const b=this.bindings.get(id);if(!b?.sessionId)throw new HapiError(409,'请先为当前项目连接 HAPI');return b}
  private async projectInstructions(projectId:string,project:Project){
    const directory=this.projectDirectory(projectId);await mkdir(directory,{recursive:true})
    const root=resolve(this.options.projectDirectory),cli=join(root,'scripts','desktop-circuit.mjs')
    const guide=join(root,'docs','drawing-guide.md'),patterns=join(root,'docs','drawing-patterns.md'),acceptance=join(root,'docs','drawing-acceptance.md')
    const text=`# 电路工作台项目\n\n这是项目 ${projectId} 的专用 Codex 工作目录。项目标题：${project.title.replace(/[\r\n]/g,' ')}。用户在 HAPI 终端或网页发送消息，均属于此项目。\n\n## 电路工具\n\n只通过当前工作台工具读取和修改电路候选，不直接写浏览器存储或自动应用候选。CLI 路径：${cli}\n\n先运行：node "${cli}" inspect --project "${projectId}"\n\n该结果是网页最新快照；每轮修改前重新读取。运行 node "${cli}" --help 获取 start / call / finish 参数。start 使用当前 projectId 和 revision，重画任务指定 layout-only；调用 replace_candidate、validate_circuit，电气变化必须 simulate_circuit（真实 ngspice），最后 finish 给出说明与可审阅候选。不能把本地排版冒充模型重画，不能声称已应用。仿真和下载只报告真实工具结果。\n\n## 绘图依据\n\n绘制或重排前读取 "${guide}"，按电路结构查 "${patterns}"，完成后按 "${acceptance}" 验收。纯重画保留电气拓扑、真实引脚、参数、模型、测量与波形图框。用户反馈不好时解释具体问题并生成新的布局候选。\n\n这是电路操作任务；不要修改工作台源码、其他项目或登录凭据。遇到模型不足使用工具搜索/下载；无法精确匹配时说明并征求是否接受近似，不编造来源。\n`
    await writeFile(join(directory,'AGENTS.md'),text,'utf8')
  }
  private async verifySession(client:HapiClient,b:Binding,id:string){
    const data=await client.request(`/api/sessions/${encoded(id)}`),s=record(data.session),meta=record(s.metadata)
    if(s.id!==id||meta.flavor!=='codex'||typeof meta.path!=='string'||resolve(meta.path)!==b.directory)throw new HapiError(409,'HAPI 会话不属于当前项目，已拒绝操作')
    if(b.threadId&&meta.codexSessionId&&b.threadId!==meta.codexSessionId)throw new HapiError(409,'HAPI 原生会话编号发生变化，已保留原绑定')
    if(typeof meta.codexSessionId==='string')b.threadId=meta.codexSessionId
    return s
  }
  async connect(projectId:string,project:Project){return this.locked(projectId,async()=>{
    parseProject(project,{allowDraft:true});await this.projectInstructions(projectId,project)
    let b=this.bindings.get(projectId);const client=await this.hub()
    if(b?.sessionId){await this.ensureActive(client,b);return this.refresh(client,b)}
    if(b?.connecting){
      const listed=await client.request('/api/sessions?limit=500'),matches=(Array.isArray(listed.sessions)?listed.sessions:[]).filter((s:any)=>typeof s.metadata?.path==='string'&&resolve(s.metadata.path)===b!.directory)
      if(matches.length!==1||!validId(matches[0].id))throw new HapiError(409,'上次创建是否成功尚未确认；未重复创建会话，请稍后重新连接')
      await this.verifySession(client,b,matches[0].id);b.sessionId=matches[0].id;b.connecting=false;await this.save();return this.refresh(client,b)
    }
    if(this.bindings.size>=100)throw new HapiError(507,'本地 HAPI 项目数量已达上限')
    const status=await this.status();if(!status.available||!status.machineId)throw new HapiError(503,status.message)
    b={projectId,sessionId:null,threadId:null,machineId:status.machineId,directory:this.projectDirectory(projectId),connecting:true,receipts:[],cache:blank(projectId)};this.bindings.set(projectId,b);await this.save()
    try{
      const spawned=await client.request(`/api/machines/${encoded(b.machineId)}/spawn`,{directory:b.directory,agent:'codex',model:'gpt-6-sol',modelReasoningEffort:'medium',permissionMode:'default',startingMode:'remote',sessionType:'simple'},60000)
      if(spawned.type!=='success'||!validId(spawned.sessionId))throw new HapiError(502,short(spawned.message)||'HAPI 没有返回新会话编号')
      if([...this.bindings.values()].some(other=>other!==b&&other.sessionId===spawned.sessionId))throw new HapiError(409,'HAPI 会话已绑定其他项目')
      b.sessionId=spawned.sessionId;b.connecting=false;await this.save();return await this.refresh(client,b)
    }catch(error){if(error instanceof HapiError&&!error.uncertain&&!b.sessionId)b.connecting=false;b.cache.error=this.error(error);b.cache.status='error';await this.save();throw error}
  })}
  private async ensureActive(client:HapiClient,b:Binding){
    const s=await this.verifySession(client,b,b.sessionId!)
    if(s.active)return s
    const resumed=await client.request(`/api/sessions/${encoded(b.sessionId!)}/resume`,{},60000)
    if(resumed.type!=='success'||!validId(resumed.sessionId))throw new HapiError(502,'HAPI 未恢复当前会话')
    const next=await this.verifySession(client,b,resumed.sessionId)
    if([...this.bindings.values()].some(other=>other!==b&&other.sessionId===resumed.sessionId))throw new HapiError(409,'恢复的会话已经绑定其他项目')
    b.sessionId=resumed.sessionId;await this.save();return next
  }
  private async acceptRoutineApprovals(client:HapiClient,b:Binding,session:Record<string,any>){
    const requests=Object.entries(record(record(session.agentState).requests)).slice(0,40)
    let accepted=false,error:string|null=null
    for(const [id,value] of requests){
      const request=record(value),tool=short(request.tool,150),args=record(request.arguments)
      if(!id||id.length>500||/[\u0000-\u001f]/.test(id)||/request[_-]?user[_-]?input/i.test(tool)||Array.isArray(args.questions)&&args.questions.length>0)continue
      try{
        const result=await client.request(`/api/sessions/${encoded(b.sessionId!)}/permissions/${encoded(id)}/approve`,{decision:'approved'})
        if(result.ok!==true)throw new HapiError(502,'HAPI 未确认自动批准请求',true)
        accepted=true
      }catch(cause){error=`自动批准未完成：${this.error(cause)}`;break}
    }
    return {session:accepted?await this.verifySession(client,b,b.sessionId!):session,error}
  }
  private async refresh(client:HapiClient,b:Binding):Promise<HapiSessionState>{
    try{
      const current=await this.verifySession(client,b,b.sessionId!),automatic=await this.acceptRoutineApprovals(client,b,current)
      const session=automatic.session,history=await syncHapiHistory(client,b.sessionId!,b.history,b.cache.messages),messages=history.messages
      const previous=new Map(b.receipts.map(receipt=>[receipt.id,receipt.delivery]))
      const pending=b.receipts.filter(r=>r.delivery==='queued'||r.delivery==='unknown')
      for(let index=0;index<pending.length;index+=1000){const batch=pending.slice(index,index+1000),state=await client.request(`/api/sessions/${encoded(b.sessionId!)}/messages/queued-state`,{localIds:batch.map(r=>r.id)});for(const receipt of batch){if(state.invokedLocalMessages?.some((m:any)=>m.localId===receipt.id))receipt.delivery='sent';else if(state.indeterminateLocalIds?.includes(receipt.id))receipt.delivery='unknown';else if(state.queuedLocalIds?.includes(receipt.id))receipt.delivery='queued'}}
      for(const receipt of b.receipts){const live=messages.find(m=>m.id===receipt.id);if(live?.delivery==='sent')receipt.delivery='sent';else if(live?.delivery==='unknown')receipt.delivery='unknown';if(!live&&receipt.delivery!=='sent')messages.push({id:receipt.id,role:'user',content:receipt.message,createdAt:receipt.createdAt,delivery:receipt.delivery});else if(live)live.delivery=receipt.delivery}
      for(const receipt of b.receipts)if(previous.get(receipt.id)!==receipt.delivery)await this.receiptStore.write(b.projectId,receipt)
      b.receipts=compactHapiReceipts(b.receipts);b.history=history.history
      const unknown=b.receipts.some(r=>r.delivery==='unknown')
      b.cache={projectId:b.projectId,sessionId:b.sessionId,threadId:b.threadId,status:session.active?(session.thinking?'running':'idle'):'offline',messages:messages.sort((a,b)=>a.createdAt-b.createdAt),approvals:parseHapiApprovals(record(session.agentState).requests),error:automatic.error??(unknown?'部分消息送达状态尚未确认；未自动重复发送':[...b.receipts].reverse().find(r=>r.delivery==='failed')?.error??null),updatedAt:Date.now()};await this.save();return structuredClone(b.cache)
    }catch(error){b.cache={...b.cache,sessionId:b.sessionId,threadId:b.threadId,status:'offline',error:this.error(error),updatedAt:Date.now()};return structuredClone(b.cache)}
  }
  async session(projectId:string){return this.locked(projectId,async()=>{const b=this.bindings.get(projectId);if(!b)return blank(projectId);if(!b.sessionId)return {...b.cache,error:b.cache.error||'正在确认 HAPI 会话创建结果'};try{return await this.refresh(await this.hub(),b)}catch(error){return{...b.cache,status:'offline' as const,error:this.error(error)}}})}
  async send(projectId:string,message:string,requestId:string){return this.locked(projectId,async()=>{
    if(typeof message!=='string'||!message.trim()||message.length>8000||!validId(requestId))throw new HapiError(400,'消息为 1–8000 字符，且需要有效请求编号')
    const b=this.binding(projectId),client=await this.hub(),hash=messageHash(message),prior=b.receipts.find(r=>r.id===requestId)??await this.receiptStore.read(projectId,requestId)
    if(prior){if(prior.hash!==hash)throw new HapiError(409,'相同请求编号不能用于不同消息');if((prior.delivery==='queued'||prior.delivery==='unknown')&&!b.receipts.some(r=>r.id===requestId))b.receipts.push(prior);return this.refresh(client,b)}
    await this.ensureActive(client,b)
    const receipt:HapiReceipt={id:requestId,hash,message,createdAt:Date.now(),delivery:'unknown'};await this.receiptStore.write(projectId,receipt);b.receipts.push(receipt);await this.save()
    try{const result=await client.request(`/api/sessions/${encoded(b.sessionId!)}/messages`,{text:message,localId:requestId,deliveryMode:'queue'});if(result.ok!==true)throw new HapiError(502,'HAPI 未确认接收消息',true);receipt.delivery='queued'}
    catch(error){receipt.delivery=error instanceof HapiError&&!error.uncertain?'failed':'unknown';receipt.error=this.error(error);b.cache.error=receipt.error}
    await this.receiptStore.write(projectId,receipt);await this.save();return this.refresh(client,b)
  })}
  async cancel(projectId:string){return this.locked(projectId,async()=>{const b=this.binding(projectId),client=await this.hub();await this.verifySession(client,b,b.sessionId!);const result=await client.request(`/api/sessions/${encoded(b.sessionId!)}/abort`,{});if(result.ok!==true)throw new HapiError(502,'HAPI 未确认中断当前任务',true);return this.refresh(client,b)})}
  async approval(projectId:string,id:string,decision:'approve'|'deny',answers?:Record<string,string[]>){return this.locked(projectId,async()=>{
    if(typeof id!=='string'||!id||id.length>500||/[\u0000-\u001f]/.test(id)||!['approve','deny'].includes(decision))throw new HapiError(400,'批准请求格式不正确')
    if(answers!==undefined&&(!answers||typeof answers!=='object'||Array.isArray(answers)||Object.entries(answers).some(([key,value])=>key.length>120||!Array.isArray(value)||value.length>20||value.some(v=>typeof v!=='string'||v.length>4000))))throw new HapiError(400,'问题回答格式不正确')
    const b=this.binding(projectId),client=await this.hub(),s=await this.verifySession(client,b,b.sessionId!),request=record(record(s.agentState).requests)[id]
    if(!request)throw new HapiError(409,'此请求已被其他客户端处理或已失效')
    const nested=/request[_-]?user[_-]?input/i.test(String(request.tool)),payload=decision==='deny'?{decision:'denied'}:{decision:'approved',...(answers?{answers:nested?Object.fromEntries(Object.entries(answers).map(([key,value])=>[key,{answers:value}])):answers}:{})}
    const result=await client.request(`/api/sessions/${encoded(b.sessionId!)}/permissions/${encoded(id)}/${decision}`,payload);if(result.ok!==true)throw new HapiError(502,'HAPI 未确认接收此回答',true);return this.refresh(client,b)
  })}
  async close(){await this.ready;await Promise.allSettled([...this.locks.values()]);await this.saving}
}
