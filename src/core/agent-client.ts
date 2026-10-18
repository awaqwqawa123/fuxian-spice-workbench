import { aiProjectFingerprint, parseAiProposal, parseAiRequest, type AiConversationMessage, type AiProposal, type AiProvider } from './ai'
import type { Analysis, Project } from './circuit'
import { parseAgentModelAcquisitions, parseAgentProposal, type AgentModelAcquisition } from './agent-models'

export interface AgentRequest extends AiProvider { prompt:string; project:Project; history?:AiConversationMessage[] }
export interface AgentToolEvent { type:'tool'; name:string; status:'running'|'completed'|'error'; detail:string }
export type AgentProgressEvent = {type:'started';engine:string;version:string} | AgentToolEvent
export interface AgentMeasurement {minimum:number;maximum:number;last:number}
export interface AgentNoiseSummary {
  input:AgentMeasurement;output:AgentMeasurement;inputUnit:'V'|'A';totalInput?:number;totalOutput?:number
}
export interface AgentSimulationSample {x:number;vin?:number;vout?:number;current?:number;gainDb?:number;phaseDeg?:number;inputNoise?:number;outputNoise?:number}
export interface AgentSimulation {
  engine:string;analysis:Analysis;points:number;elapsedMs:number;warnings:string[]
  output:AgentMeasurement;peakDb?:number|null;peakFrequencyHz?:number|null
  samples:AgentSimulationSample[]
  outputUnit?:'V/√Hz';noise?:AgentNoiseSummary
  nodes:Record<string,AgentMeasurement>;stale:boolean
  sweepRuns?:{label:string;temperature:number;points:number;output:AgentMeasurement}[]
}
export interface AgentResult {summary:string;proposal:AiProposal;changed:boolean;simulation:AgentSimulation|null;modelAcquisitions?:AgentModelAcquisition[];interruption?:{reason:'timeout';message:string}}

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max
async function responseError(response:Response):Promise<string>{
  if(!response.body)return ''
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true})
  let body='',bytes=0
  try{
    for(;;){
      const {done,value}=await reader.read()
      if(done)break
      bytes+=value.byteLength
      if(bytes>32000)return ''
      body+=decoder.decode(value,{stream:true})
    }
    const result:unknown=JSON.parse(body+decoder.decode())
    return record(result)&&text(result.error,8000)?result.error:''
  }catch{return ''}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
}
function measurement(raw:unknown):AgentMeasurement {
  if(!record(raw)||!finite(raw.minimum)||!finite(raw.maximum)||!finite(raw.last))throw new Error('Agent 仿真数据格式不正确')
  return{minimum:raw.minimum,maximum:raw.maximum,last:raw.last}
}
export function parseAgentSimulation(raw:unknown):AgentSimulation|null {
  if(raw===null)return null
  if(!record(raw)||!text(raw.engine,200)||!['ac','tran','op','dc','noise'].includes(String(raw.analysis))||!finite(raw.points)||raw.points<0||!Number.isInteger(raw.points)||!finite(raw.elapsedMs)||raw.elapsedMs<0||typeof raw.stale!=='boolean')throw new Error('Agent 仿真结果格式不正确')
  if(!Array.isArray(raw.warnings)||raw.warnings.length>100||raw.warnings.some(value=>!text(value,8000)))throw new Error('Agent 仿真警告格式不正确')
  if(!Array.isArray(raw.samples)||raw.samples.length>2000||!record(raw.nodes)||Object.keys(raw.nodes).length>1000)throw new Error('Agent 仿真结果过大或格式不正确')
  const isNoise=raw.analysis==='noise'
  let noise:AgentNoiseSummary|undefined
  if(isNoise){
    if(!record(raw.noise)||!['V','A'].includes(String(raw.noise.inputUnit))||raw.outputUnit!=='V/√Hz'||raw.points<=0||raw.samples.length===0||raw.samples.length>raw.points)throw new Error('Agent 噪声结果格式不正确')
    const input=measurement(raw.noise.input),output=measurement(raw.noise.output)
    const validDensity=(range:AgentMeasurement)=>range.minimum>=0&&range.maximum>=range.minimum&&range.last>=range.minimum&&range.last<=range.maximum
    if(!validDensity(input)||!validDensity(output))throw new Error('Agent 噪声密度格式不正确')
    for(const key of ['totalInput','totalOutput'])if(raw.noise[key]!==undefined&&(!finite(raw.noise[key])||raw.noise[key]<0))throw new Error('Agent 积分噪声格式不正确')
    noise={input,output,inputUnit:raw.noise.inputUnit as 'V'|'A',...(raw.noise.totalInput!==undefined?{totalInput:raw.noise.totalInput as number}:{}),...(raw.noise.totalOutput!==undefined?{totalOutput:raw.noise.totalOutput as number}:{})}
    if(JSON.stringify(measurement(raw.output))!==JSON.stringify(output))throw new Error('Agent 噪声输出范围不一致')
    if(Object.keys(raw.nodes).length||raw.peakDb!=null||raw.peakFrequencyHz!=null)throw new Error('Agent 噪声结果不能包含电压节点或增益')
  }else if(raw.noise!==undefined||raw.outputUnit!==undefined)throw new Error('Agent 仿真结果含不匹配的噪声数据')
  const samples:AgentSimulationSample[]=raw.samples.map((item,index)=>{
    if(isNoise){
      if(!record(item)||!finite(item.x)||item.x<=0||index>0&&item.x<=((raw.samples as Record<string,unknown>[])[index-1].x as number)||!finite(item.inputNoise)||item.inputNoise<0||!finite(item.outputNoise)||item.outputNoise<0||['vin','vout','current','gainDb','phaseDeg'].some(key=>item[key]!==undefined))throw new Error('Agent 噪声采样点格式不正确')
      if(item.inputNoise<noise!.input.minimum||item.inputNoise>noise!.input.maximum||item.outputNoise<noise!.output.minimum||item.outputNoise>noise!.output.maximum)throw new Error('Agent 噪声采样范围不一致')
      return{x:item.x,inputNoise:item.inputNoise,outputNoise:item.outputNoise}
    }
    if(!record(item)||!finite(item.x)||!finite(item.vin)||!finite(item.vout)||!finite(item.current)||(item.gainDb!==undefined&&!finite(item.gainDb))||(item.phaseDeg!==undefined&&!finite(item.phaseDeg)))throw new Error('Agent 仿真采样点格式不正确')
    return{x:item.x,vin:item.vin,vout:item.vout,current:item.current,...(item.gainDb!==undefined?{gainDb:item.gainDb as number}:{}),...(item.phaseDeg!==undefined?{phaseDeg:item.phaseDeg as number}:{})}
  })
  const nodes=Object.fromEntries(Object.entries(raw.nodes).map(([key,value])=>[key,measurement(value)]))
  let sweepRuns:AgentSimulation['sweepRuns']
  if (raw.sweepRuns !== undefined) {
    if (!Array.isArray(raw.sweepRuns)||raw.sweepRuns.length<1||raw.sweepRuns.length>24) throw new Error('Agent 扫描结果格式不正确')
    sweepRuns=raw.sweepRuns.map(leaf=>{
      if(!record(leaf)||!text(leaf.label,200)||!finite(leaf.temperature)||leaf.temperature<=-273.15||leaf.temperature>1000||!Number.isInteger(leaf.points)||!finite(leaf.points)||leaf.points<1)throw new Error('Agent 扫描取值格式不正确')
      return{label:leaf.label,temperature:leaf.temperature,points:leaf.points,output:measurement(leaf.output)}
    })
  }
  for(const key of ['peakDb','peakFrequencyHz'])if(raw[key]!==undefined&&raw[key]!==null&&!finite(raw[key]))throw new Error('Agent 频域结果格式不正确')
  return{engine:raw.engine,analysis:raw.analysis as Analysis,points:raw.points,elapsedMs:raw.elapsedMs,warnings:raw.warnings as string[],output:measurement(raw.output),samples,nodes,stale:raw.stale,
    ...(sweepRuns?{sweepRuns}:{}),
    ...(noise?{noise,outputUnit:'V/√Hz' as const}:{}),...(raw.peakDb!==undefined?{peakDb:raw.peakDb as number|null}:{}),...(raw.peakFrequencyHz!==undefined?{peakFrequencyHz:raw.peakFrequencyHz as number|null}:{})}
}

/** Read only bounded, complete NDJSON runs; a dropped connection is never a proposal. */
export async function requestAgent(request:AgentRequest,onProgress:(event:AgentProgressEvent)=>void,signal?:AbortSignal):Promise<AgentResult>{
  const {mode:_mode,...payload}=parseAiRequest({...request,mode:'explain'})
  const response=await fetch('/api/agent/run',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/x-ndjson'},body:JSON.stringify(payload),signal})
  return readAgentResponse(response,{project:request.project,baseline:payload.project},onProgress,signal)
}

/** Shared transport validation for the native Codex and optional DSH runtimes. */
export async function readAgentResponse(response:Response,request:{project:Project;baseline:Project},onProgress:(event:AgentProgressEvent)=>void,signal?:AbortSignal):Promise<AgentResult>{
  if(!response.ok){
    const error=await responseError(response)
    throw new Error(error||`Agent 服务请求失败（${response.status}），请检查本地工作台服务`)
  }
  if(!response.body)throw new Error('Agent 服务未返回执行流')
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true})
  let buffer='',bytes=0,started=false,result:AgentResult|null=null,eventCount=0
  const abort=()=>{void reader.cancel().catch(()=>{})}
  signal?.addEventListener('abort',abort,{once:true})
  function consume(line:string){
    if(!line.trim())return
    if(result)throw new Error('Agent 结束事件之后仍返回数据，结果未应用')
    if(++eventCount>100)throw new Error('Agent 执行事件超过上限')
    let event:unknown
    try{event=JSON.parse(line)}catch{throw new Error('Agent 返回的执行数据不完整或格式错误')}
    if(!record(event))throw new Error('Agent 返回的执行事件格式错误')
    if(event.type==='error')throw new Error(text(event.error,8000)&&event.error.trim()?event.error:'Agent 执行失败')
    if(event.type==='started'){
      if(started||!text(event.engine,200)||!event.engine.trim()||!text(event.version,100))throw new Error('Agent 开始事件格式错误')
      started=true;onProgress({type:'started',engine:event.engine,version:event.version});return
    }
    if(!started)throw new Error('Agent 缺少开始事件，无法验证执行结果')
    if(event.type==='tool'){
      if(!text(event.name,100)||!event.name.trim()||!['running','completed','error'].includes(String(event.status))||!text(event.detail,8000))throw new Error('Agent 工具事件格式错误')
      onProgress({type:'tool',name:event.name,status:event.status as AgentToolEvent['status'],detail:event.detail});return
    }
    if(event.type==='done'||event.type==='interrupted'){
      if(!text(event.summary,8000)||typeof event.changed!=='boolean'||event.base!==aiProjectFingerprint(request.baseline))throw new Error('Agent 返回的电路基线不匹配，请重新执行任务')
      const modelAcquisitions=parseAgentModelAcquisitions(event.modelAcquisitions)
      const proposal=parseAgentProposal(event.summary,event.project,request.project,modelAcquisitions)
      const changed=aiProjectFingerprint(proposal.project)!==aiProjectFingerprint(parseAiProposal(JSON.stringify({summary:'',project:request.baseline}),request.project).project)
      if(changed!==event.changed)throw new Error('Agent 返回的修改状态不一致，候选方案未接受')
      const measured=parseAgentSimulation(event.simulation)
      if(event.type==='interrupted'&&(event.reason!=='timeout'||!event.summary.trim()||!changed||!measured||measured.stale||measured.points<=0))throw new Error('Agent 超时保留方案缺少当前候选电路的有效仿真，候选方案未接受')
      result={summary:event.summary,proposal,changed,simulation:measured,...(modelAcquisitions.length?{modelAcquisitions}:{}),...(event.type==='interrupted'?{interruption:{reason:'timeout' as const,message:event.summary}}:{})};return
    }
    throw new Error('Agent 返回了不支持的执行事件')
  }
  try{
    if(signal?.aborted)throw new DOMException('Aborted','AbortError')
    while(true){
      const chunk=await reader.read()
      if(signal?.aborted)throw new DOMException('Aborted','AbortError')
      if(chunk.done)break
      bytes+=chunk.value.byteLength
      if(bytes>2_000_000)throw new Error('Agent 返回内容超过上限')
      buffer+=decoder.decode(chunk.value,{stream:true})
      let newline:number
      while((newline=buffer.indexOf('\n'))!==-1){consume(buffer.slice(0,newline));buffer=buffer.slice(newline+1)}
      if(buffer.length>1_000_000)throw new Error('Agent 执行事件过长')
    }
    buffer+=decoder.decode()
    if(buffer.trim())consume(buffer)
    if(!result)throw new Error('Agent 执行流提前结束，未收到完整结果；电路保持不变')
    return result
  }finally{
    signal?.removeEventListener('abort',abort)
    await reader.cancel().catch(()=>{})
    reader.releaseLock()
  }
}
