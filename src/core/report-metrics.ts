import { analysisSignals, circuitGraph, projectKey } from './circuit'
import { compileDrawing } from './drawing'
import { resolveMeasurement } from './probes'
import { resolveBranchCurrent } from './branch-currents'
import { resolveWireCurrent } from './wire-currents'
import { terminalKey } from './drawing'
import type { Result, Complex } from './results'
import type { ReportConfiguration, ReportCriterion, ReportMetric, ReportTestSettings } from './report-settings'
import { buildTestReport } from './test-report'

export interface ReportMeasurement {
  id:string; profileId:string; signal:string; metric:ReportMetric; value:number|null; unit:string; method:string
  window:{start:number;end:number}|null; reason?:string; evidence:string
  markers?:{x:number;y:number;label:string}[]
}
export interface CriterionEvaluation {
  criterion:ReportCriterion; measurement:ReportMeasurement; status:'满足'|'不满足'|'无法评价'; deviation:number|null; limit:string
}
interface Series { values:number[]; unit:string; method:string; phase?:number[] }
interface Samples { x:number[]; y:number[]; window:{start:number;end:number} }
const basic:ReportMetric[]=['minimum','maximum','last','mean','rms','peakToPeak']
const acMetrics:ReportMetric[]=['gainPeak','phaseAtPeak','gainAtReference','cutoffLow','cutoffHigh','bandwidth']
const dynamic:ReportMetric[]=['riseTime','fallTime','overshoot','settlingTime']
const valid=(values:number[]|undefined,count:number):values is number[]=>!!values&&values.length===count&&values.every(Number.isFinite)
const validComplex=(values:Complex[]|undefined,count:number):values is Complex[]=>!!values&&values.length===count&&values.every(v=>Number.isFinite(v.real)&&Number.isFinite(v.img))
const span=(x:number[])=>({start:x[0],end:x.at(-1)!})

function complexSeries(values:Complex[],unit:string,method:string):Series|null {
  const magnitudes=values.map(v=>Math.hypot(v.real,v.img))
  if(magnitudes.some(v=>!Number.isFinite(v)||v<=0))return null
  const phase:number[]=[]
  for(const v of values){let angle=Math.atan2(v.img,v.real)*180/Math.PI;const previous=phase.at(-1);if(previous!==undefined){while(angle-previous>180)angle-=360;while(angle-previous< -180)angle+=360}phase.push(angle)}
  return{values:magnitudes.map(v=>20*Math.log10(v)),unit,method,phase}
}

/** Signals are resolved only against the saved experiment, never the current drawing. */
function signalSeries(result:Result,signal:string):Series|null {
  const count=result.points,ac=result.analysis==='ac',nodes=analysisSignals(result.project)
  if(signal==='noise:output'||signal==='noise:input'){
    if(result.analysis!=='noise'||!result.noise)return null
    const input=signal==='noise:input',values=input?result.noise.input:result.noise.output
    return valid(values,count)&&values.every(v=>v>=0)?{values,unit:`${input?result.noise.inputUnit:'V'}/√Hz`,method:`ngspice ${input?'inoise':'onoise'}_spectrum 实际噪声谱密度`}:null
  }
  if(signal.startsWith('power:')){
    if(ac||result.analysis==='noise')return null
    const id=signal.slice(6)
    const element=result.project.drawing?compileDrawing(result.project.drawing).elements.find(e=>e.device.id===id):circuitGraph(result.project).parts.find(e=>e.id===id)
    if(!element||element.nodes.length!==2)return null
    const current=result.currents?.[`i(${id.toLowerCase()})`]
    const voltage=(node:string)=>node==='0'?Array<number>(count).fill(0):result.voltages?.[`v(${node.toLowerCase()})`]
    const a=voltage(element.nodes[0]),b=voltage(element.nodes[1])
    if(!valid(a,count)||!valid(b,count)||!valid(current,count))return null
    const values=a.map((v,index)=>(v-b[index])*current[index])
    return values.every(Number.isFinite)?{values,unit:'W',method:`${id} 实际端压 × 求解器有方向支路电流；正值表示吸收，方向为网表第一端到第二端；功率采样间线性插值`}:null
  }
  if(signal.startsWith('probe:')){
    const probe=result.project.probes?.find(probe=>probe.id===signal.slice(6));if(!probe)return null
    const trace=resolveMeasurement(result,probe);if(!trace)return null
    if(ac){
      let complex:Complex[]|undefined
      if(probe.kind==='current')complex=(probe.wire?resolveWireCurrent(result,probe.wire):resolveBranchCurrent(result,probe.device))?.complex
      else if(result.project.drawing){
        const graph=compileDrawing(result.project.drawing),positive=graph.nodes.get(terminalKey(probe.positive)),negative=probe.negative?graph.nodes.get(terminalKey(probe.negative)):'0'
        const node=(name:string|undefined)=>name==='0'?Array.from({length:count},()=>({real:0,img:0})):name?result.complexVoltages?.[`v(${name.toLowerCase()})`]:undefined
        const a=node(positive),b=node(negative)
        if(validComplex(a,count)&&validComplex(b,count))complex=a.map((v,i)=>({real:v.real-b[i].real,img:v.img-b[i].img}))
      }
      return validComplex(complex,count)?complexSeries(complex,`dB re 1 ${trace.kind==='current'?'A':'V'}`,`${trace.name} 实际复数幅值 20 log10(|X| / 1 ${trace.kind==='current'?'A':'V'})；绝对幅值，并非传递增益`):null
    }
    return valid(trace.values,count)?{values:trace.values,unit:trace.kind==='current'?'A':'V',method:`${trace.name} 实际探针采样；采用保存的探针端点和方向`}:null
  }
  if(signal==='input'||signal==='output'||signal==='sourceCurrent'){
    if(result.analysis==='noise')return null
    if(!ac){const values=signal==='input'?result.vin:signal==='output'?result.vout:result.current;return valid(values,count)?{values,unit:signal==='sourceCurrent'?'A':'V',method:`求解器 ${signal==='sourceCurrent'?`I(${nodes.sourceId}) 有方向支路电流`:`V(${signal==='input'?nodes.inputNode:nodes.outputNode}) 节点电压`}实际采样`}:null}
    const a=result.complexVoltages?.[`v(${nodes.inputNode.toLowerCase()})`],b=result.complexVoltages?.[`v(${nodes.outputNode.toLowerCase()})`]
    if(signal==='sourceCurrent'){const current=result.complexCurrents?.[`i(${nodes.sourceId.toLowerCase()})`];return validComplex(current,count)?complexSeries(current,'dB re 1 A',`I(${nodes.sourceId}) 真实复数电流绝对幅值，并非传递增益`):null}
    if(signal==='input')return validComplex(a,count)?complexSeries(a,'dB re 1 V',`V(${nodes.inputNode}) 真实复数电压绝对幅值，并非传递增益`):null
    if(!validComplex(a,count)||!validComplex(b,count)||a.some(v=>Math.hypot(v.real,v.img)<=0))return null
    const ratios=b.map((v,i)=>{const den=a[i].real**2+a[i].img**2;return{real:(v.real*a[i].real+v.img*a[i].img)/den,img:(v.img*a[i].real-v.real*a[i].img)/den}})
    return complexSeries(ratios,'dB',`真实复数传递函数 V(${nodes.outputNode}) / V(${nodes.inputNode})`)
  }
  return null
}

export function resolveReportSignal(result:Result,signal:string):Series|null {
  try{return signalSeries(result,signal)}catch{return null}
}

function interpolate(x:number[],y:number[],point:number,log=false):number|null {
  if(!Number.isFinite(point)||point<x[0]||point>x.at(-1)!)return null
  let lo=0,hi=x.length-1
  while(lo<hi){const middle=Math.floor((lo+hi)/2);if(x[middle]<point)lo=middle+1;else hi=middle}
  if(x[lo]===point)return y[lo]
  if(lo===0)return null
  const t=log?Math.log(point/x[lo-1])/Math.log(x[lo]/x[lo-1]):(point-x[lo-1])/(x[lo]-x[lo-1])
  const value=y[lo-1]+t*(y[lo]-y[lo-1]);return Number.isFinite(value)?value:null
}
function windowed(result:Result,series:Series,settings:ReportTestSettings|undefined):Samples|null {
  const descending=result.analysis==='dc'&&result.x.length>1&&result.x[0]>result.x.at(-1)!
  const x=descending?[...result.x].reverse():result.x,y=descending?[...series.values].reverse():series.values,w=settings?.window??span(x)
  if(!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<x[0]||w.end>x.at(-1)!||w.end<w.start)return null
  if(result.analysis==='op')return !settings?.window&&x.length===1?{x:[x[0]],y:[y[0]],window:span(x)}:null
  if(w.end<=w.start||x.length<2)return null
  const log=result.analysis==='ac',start=interpolate(x,y,w.start,log),end=interpolate(x,y,w.end,log)
  if(start===null||end===null)return null
  const inner=x.flatMap((value,i)=>value>w.start&&value<w.end?[i]:[])
  return{x:[w.start,...inner.map(i=>x[i]),w.end],y:[start,...inner.map(i=>y[i]),end],window:{start:w.start,end:w.end}}
}
function integrate(samples:Samples,square=false):number {
  if(samples.x.length===1)return square?samples.y[0]**2:samples.y[0]
  let sum=0
  for(let i=1;i<samples.x.length;i++){const a=samples.y[i-1],b=samples.y[i],dt=samples.x[i]-samples.x[i-1];sum+=dt*(square?(a*a+a*b+b*b)/3:(a+b)/2)}
  return sum/(samples.window.end-samples.window.start)
}
function crossing(samples:Samples,level:number,direction:1|-1,after:number):number|null {
  for(let i=1;i<samples.x.length;i++){
    const a=samples.y[i-1],b=samples.y[i]
    if((direction===1?a<level&&b>=level||a===level&&b>level:a>level&&b<=level||a===level&&b<level)&&a!==b){const time=samples.x[i-1]+(level-a)/(b-a)*(samples.x[i]-samples.x[i-1]);if(time>=after)return time}
  }
  // A last sample exactly at the threshold is evidence of reaching that level.
  if(samples.y.at(-1)===level&&samples.x.at(-1)!>=after)return samples.x.at(-1)!
  return null
}

function measure(result:Result|null,profileId:string,signal:string,metric:ReportMetric,settings:ReportTestSettings|undefined,unavailable?:string):ReportMeasurement {
  const metricUnit:Partial<Record<ReportMetric,string>>={riseTime:'s',fallTime:'s',settlingTime:'s',overshoot:'%',cutoffLow:'Hz',cutoffHigh:'Hz',bandwidth:'Hz',phaseAtPeak:'°',phaseMargin:'°',gainMargin:'dB',devicePower:'W',efficiency:'%'}
  const m:ReportMeasurement={id:JSON.stringify([profileId,signal,metric]),profileId,signal,metric,value:null,unit:metricUnit[metric]??'',method:'',window:settings?.window?{start:settings.window.start,end:settings.window.end}:null,evidence:result?`运行 ${result.id}；分析 ${result.analysis}；${result.points} 个真实采样点`:'无实际运行证据'}
  const fail=(reason:string)=>({...m,reason})
  if(unavailable||!result)return fail(unavailable??'缺少当前配置的已完成仿真结果')
  if(metric==='efficiency')return fail('未配置完整输入/输出功率边界及端口方向，无法评价效率')
  if(metric==='phaseMargin'||metric==='gainMargin')return fail('缺少真实环路断开/注入测试和 loopGain 复数数据，闭环输出响应不能推算稳定裕度')
  let series:Series|null
  try{series=signalSeries(result,signal)}catch{return fail('保存的端点或器件连接无法解析')}
  if(!series)return fail('该信号缺少完整真实采样；功耗必须具备实际端压与求解器有方向支路电流')
  m.unit=metricUnit[metric]??series.unit;m.method=series.method
  const samples=windowed(result,series,settings)
  if(!samples)return fail('测量窗口超出实际采样范围、窗口无效或采样不足；禁止外推')
  m.window=samples.window
  const set=(value:number,method:string,unit=m.unit,markers?:ReportMeasurement['markers']):ReportMeasurement=>Number.isFinite(value)?{...m,value,unit,method:`${m.method}；${method}`,...(markers?{markers}:{})}:fail('计算产生非有限值，无法评价')
  if(metric==='noiseTotal'){
    if(result.analysis!=='noise'||!signal.startsWith('noise:'))return fail('积分噪声仅适用于实际噪声分析')
    m.unit=`${signal==='noise:input'?result.noise!.inputUnit:'V'} RMS`
    if(samples.window.start!==result.x[0]||samples.window.end!==result.x.at(-1))return fail('求解器积分噪声只覆盖完整扫描频段；局部窗口没有真实积分值')
    const total=signal==='noise:input'?result.noise!.totalInput:result.noise!.totalOutput
    if(total===undefined||!Number.isFinite(total)||total<0)return fail('求解器未返回有效的积分 RMS 噪声，不能根据谱密度伪造总量')
    return set(total,'直接引用 ngspice 全扫描频段 inoise_total / onoise_total；未重新积分',m.unit)
  }
  if(basic.includes(metric)){
    if(result.analysis==='ac'&&['mean','rms','peakToPeak'].includes(metric))return fail('AC 对数幅值的平均、RMS 或峰峰值不是时域物理指标')
    let minimum=samples.y[0],maximum=samples.y[0]
    for(const value of samples.y){minimum=Math.min(minimum,value);maximum=Math.max(maximum,value)}
    if(metric==='minimum'||metric==='maximum'){const value=metric==='minimum'?minimum:maximum,index=samples.y.indexOf(value);return set(value,'窗口内真实采样及边界插值极值',m.unit,[{x:samples.x[index],y:value,label:metric==='minimum'?'最小值':'最大值'}])}
    if(metric==='last'){const descending=result.analysis==='dc'&&result.x[0]>result.x.at(-1)!;return set(descending?samples.y[0]:samples.y.at(-1)!,'沿实际扫描方向的窗口末次值；边界未落在采样点时按相邻采样插值')}
    if(metric==='peakToPeak')return set(maximum-minimum,'窗口内最大值减最小值')
    if(result.analysis==='noise')return fail('噪声谱密度不适用时域平均/RMS；请使用求解器积分 RMS 噪声')
    const coordinate=result.analysis==='tran'?'时间':result.analysis==='dc'?'扫描坐标':'工作点'
    return set(metric==='rms'?Math.sqrt(integrate(samples,true)):integrate(samples),`${coordinate}加权${metric==='rms'?' RMS：对分段线性波形的平方精确积分后开方':'平均：相邻自适应采样分段线性积分'}；${settings?.window?.steady?'用户指定稳态窗口':'未声明稳态，所选窗口统计'}`)
  }
  if(metric==='devicePower'){
    m.unit='W'
    if(!signal.startsWith('power:')||!['op','tran','dc'].includes(result.analysis))return fail('器件功耗须选择 power:器件编号，并具有真实端压和有方向支路电流')
    return set(integrate(samples),'窗口内吸收功率的坐标加权平均（工作点为单点）；负值表示向外供能','W')
  }
  if(dynamic.includes(metric)){
    m.unit=metric==='overshoot'?'%':'s'
    if(result.analysis!=='tran'||signal.startsWith('power:'))return fail('动态响应指标仅适用于瞬态电压/电流')
    const step=settings?.step
    if(!step||![step.start,step.initial,step.target,step.bandPercent,step.holdTime].every(Number.isFinite)||step.initial===step.target||step.bandPercent<=0||step.bandPercent>=100||step.holdTime<=0)return fail('需要明确阶跃起点、初值、目标值、容差百分比和正保持时间')
    if(step.start<samples.window.start||step.start>=samples.window.end)return fail('阶跃起点须位于测量窗口内，且起点之后有有效采样')
    const startValue=interpolate(samples.x,samples.y,step.start)!
    const indices=samples.x.flatMap((x,i)=>x>step.start?[i]:[])
    const response:Samples={x:[step.start,...indices.map(i=>samples.x[i])],y:[startValue,...indices.map(i=>samples.y[i])],window:{start:step.start,end:samples.window.end}}
    const delta=step.target-step.initial,direction=delta>0?1:-1
    if(metric==='riseTime'||metric==='fallTime'){
      if(metric==='riseTime'&&direction<0||metric==='fallTime'&&direction>0)return fail('所配置阶跃方向与上升/下降指标不一致')
      const level10=step.initial+.1*delta,level90=step.initial+.9*delta
      if(direction*(startValue-level10)>0)return fail('阶跃起点时已越过 10% 阈值，采样无法完整证明 10–90% 过程')
      const t10=crossing(response,level10,direction,step.start),t90=t10===null?null:crossing(response,level90,direction,t10)
      if(t10===null||t90===null||t90<=t10)return fail('窗口内未完整观察到 10% 和 90% 阈值交叉')
      return set(t90-t10,`${metric==='riseTime'?'10–90% 上升':'90–10% 下降'}阈值基于明确初值 ${step.initial} 与目标 ${step.target}；首次同方向交叉线性插值`,'s',[{x:t10,y:level10,label:metric==='riseTime'?'10%':'90%'},{x:t90,y:level90,label:metric==='riseTime'?'90%':'10%'}])
    }
    if(metric==='overshoot'){
      let index=0;for(let i=1;i<response.y.length;i++)if(direction*response.y[i]>direction*response.y[index])index=i
      return set(Math.max(0,direction*(response.y[index]-step.target)/Math.abs(delta)*100),'相对阶跃幅度的扫描窗口内最大过冲；(同方向极值 − 目标) / |目标 − 初值|，无超出记为 0','%',[{x:response.x[index],y:response.y[index],label:'响应极值'}])
    }
    const band=Math.abs(delta)*step.bandPercent/100,inside=(y:number)=>Math.abs(y-step.target)<=band
    if(!inside(response.y.at(-1)!))return fail('窗口结束时仍在目标容差带外，未观察到稳定')
    let entry=step.start
    for(let i=1;i<response.x.length;i++){
      if(!inside(response.y[i-1])){
        if(inside(response.y[i])){const edge=step.target+(response.y[i-1]>step.target?band:-band);entry=response.x[i-1]+(edge-response.y[i-1])/(response.y[i]-response.y[i-1])*(response.x[i]-response.x[i-1])}
        else entry=response.x[i]
      }
    }
    if(response.window.end-entry<step.holdTime)return fail('进入容差带后剩余采样时长不足指定保持时间')
    return set(entry-step.start,`从激励起点计时，最后进入目标 ±${step.bandPercent}% 阶跃幅度容差带并保持至窗口终点，至少保持 ${step.holdTime} s；仅证明所观察窗口`,'s',[{x:entry,y:interpolate(response.x,response.y,entry)!,label:'最后进入容差带'}])
  }
  if(acMetrics.includes(metric)){
    if(result.analysis!=='ac'||!series.phase)return fail('该指标需要实际 AC 复数信号')
    let peakIndex=0;for(let i=1;i<samples.y.length;i++)if(samples.y[i]>samples.y[peakIndex])peakIndex=i
    if(metric==='gainPeak')return set(samples.y[peakIndex],'扫描窗口内采样及插值边界幅值峰值；不能证明扫描之外的峰值',m.unit,[{x:samples.x[peakIndex],y:samples.y[peakIndex],label:'幅值峰值'}])
    if(metric==='phaseAtPeak')return set(interpolate(result.x,series.phase,samples.x[peakIndex],true)!,'同一幅值峰值频率处实际复数相位；相位连续展开','°')
    const reference=settings?.acReferenceHz
    if(reference===undefined||!Number.isFinite(reference)||reference<=0)return fail('需要指定具有设计依据的 AC 参考频率，禁止默认假设通带')
    if(reference<samples.window.start||reference>samples.window.end)return fail('AC 参考频率须位于测量窗口内')
    const gain=interpolate(samples.x,samples.y,reference,true)!
    if(metric==='gainAtReference')return set(gain,`参考频率 ${reference} Hz；幅值按 log10(f) 线性插值`,m.unit,[{x:reference,y:gain,label:'参考幅值'}])
    m.unit='Hz'
    const threshold=gain-3,crossings:{frequency:number;direction:1|-1}[]=[]
    for(let i=1;i<samples.x.length;i++){
      const signValue=(value:number)=>Math.abs(value-threshold)<1e-10?0:value-threshold
      const a=signValue(samples.y[i-1]),b=signValue(samples.y[i])
      if(a===0&&b===0)return fail('存在阈值平台，截止交叉不唯一')
      if(a*b<0){const fraction=(threshold-samples.y[i-1])/(samples.y[i]-samples.y[i-1]),frequency=Math.exp(Math.log(samples.x[i-1])+fraction*Math.log(samples.x[i]/samples.x[i-1]));crossings.push({frequency,direction:samples.y[i]>samples.y[i-1]?1:-1})}
      else if(b===0&&i+1<samples.x.length){const next=signValue(samples.y[i+1]);if(a*next<0)crossings.push({frequency:samples.x[i],direction:next>a?1:-1})}
    }
    const lower=crossings.filter(c=>c.frequency<reference),upper=crossings.filter(c=>c.frequency>reference)
    const get=(side:'lower'|'upper')=>{const items=side==='lower'?lower:upper;return items.length===1&&items[0].direction===(side==='lower'?1:-1)?items[0].frequency:null}
    const low=get('lower'),high=get('upper'),description=`相对 ${reference} Hz 参考幅值下降 3.000 dB；频率对数插值`
    if(metric==='cutoffLow')return low===null?fail(lower.length?'参考频率以下存在多个或错误方向交叉，单一截止无法评价':'参考频率以下未观察到 −3 dB 交叉'):set(low,description,'Hz',[{x:low,y:threshold,label:'下限截止'}])
    if(metric==='cutoffHigh')return high===null?fail(upper.length?'参考频率以上存在多个或错误方向交叉，单一截止无法评价':'参考频率以上未观察到 −3 dB 交叉'):set(high,description,'Hz',[{x:high,y:threshold,label:'上限截止'}])
    return low===null||high===null?fail('带宽须具备参考频率两侧唯一有效截止；不得将扫描边界当作截止'):set(high-low,`${description}；带宽 = 上限截止 − 下限截止`,'Hz',[{x:low,y:threshold,label:'下限截止'},{x:high,y:threshold,label:'上限截止'}])
  }
  return fail('分析类型或所选信号不支持此指标')
}

function criterionLimit(c:ReportCriterion):string {
  const rules:string[]=[]
  if(c.lower!==undefined)rules.push(`≥ ${c.lower}`)
  if(c.upper!==undefined)rules.push(`≤ ${c.upper}`)
  if(c.target!==undefined)rules.push(c.tolerance===undefined?`精确目标 = ${c.target}（未设置容差）`:`目标 ${c.target} ± ${c.tolerance}（绝对容差）`)
  return rules.join(' 且 ')||'未设置验收约束'
}

export function evaluateReportMetrics(runs:readonly {profile:{id:string;name:string};result:Result|null;status:string}[],config:ReportConfiguration):{
  measurements:ReportMeasurement[];criteria:CriterionEvaluation[];conclusion:'未判定'|'所测指标满足'|'存在不满足指标'|'部分指标无法评价'
} {
  const measurements:ReportMeasurement[]=[],byId=new Map<string,ReportMeasurement>(),validity=new Map<string,string|undefined>()
  const add=(profileId:string,signal:string,metric:ReportMetric)=>{
    const id=JSON.stringify([profileId,signal,metric]);if(byId.has(id))return byId.get(id)!
    const run=runs.find(run=>run.profile.id===profileId),result=run?.result??null,settings=config.tests.find(test=>test.profileId===profileId)
    if(!validity.has(profileId)){
      let unavailable=run?.status!=='complete'?'当前配置未完成、已过期或无效，不能用于验收':undefined
      if(!unavailable&&result)try{buildTestReport(result);if(result.key!==projectKey(result.project))unavailable='运行结果与保存的工程版本不一致';else if(result.analysis==='tran'&&result.x.some(x=>x<0))unavailable='瞬态坐标不能为负数'}catch{unavailable='运行结果缺少完整、有效的求解器证据'}
      validity.set(profileId,unavailable)
    }
    const unavailable=validity.get(profileId)
    let measurement=measure(result,profileId,signal,metric,settings,unavailable)
    if(measurement.value!==null&&!Number.isFinite(measurement.value))measurement={...measurement,value:null,reason:'非有限测量值不能验收'}
    byId.set(id,measurement);measurements.push(measurement);return measurement
  }
  for(const run of runs){
    const analysis=run.result?.analysis
    if(analysis==='ac')for(const metric of acMetrics)add(run.profile.id,'output',metric)
    else if(analysis==='noise'){for(const signal of ['noise:output','noise:input'])for(const metric of ['minimum','maximum','noiseTotal'] as const)add(run.profile.id,signal,metric)}
    else for(const metric of analysis==='op'?basic.slice(0,3):basic)add(run.profile.id,'output',metric)
    if(analysis==='tran'&&config.tests.some(t=>t.profileId===run.profile.id&&t.step))for(const metric of dynamic)add(run.profile.id,'output',metric)
  }
  const criteria=config.criteria.map(criterion=>{
    let measurement=add(criterion.profileId,criterion.signal,criterion.metric),status:CriterionEvaluation['status']='无法评价',deviation:number|null=null
    const limits=[criterion.lower,criterion.upper,criterion.target,criterion.tolerance].filter(v=>v!==undefined)
    const invalid=limits.some(v=>!Number.isFinite(v))||criterion.lower!==undefined&&criterion.upper!==undefined&&criterion.lower>criterion.upper||criterion.tolerance!==undefined&&(criterion.tolerance<0||criterion.target===undefined)||limits.length===0
    if(invalid)measurement={...measurement,value:null,reason:'验收约束缺失、非有限或相互矛盾'}
    else if(measurement.value!==null){
      const value=measurement.value,tolerance=criterion.tolerance??0
      const passes=(criterion.lower===undefined||value>=criterion.lower)&&(criterion.upper===undefined||value<=criterion.upper)&&(criterion.target===undefined||value>=criterion.target-tolerance&&value<=criterion.target+tolerance)
      status=passes?'满足':'不满足'
      deviation=criterion.target!==undefined?value-criterion.target:criterion.lower!==undefined&&value<criterion.lower?value-criterion.lower:criterion.upper!==undefined&&value>criterion.upper?value-criterion.upper:0
    }
    return{criterion,measurement,status,deviation,limit:criterionLimit(criterion)}
  })
  const conclusion=!criteria.length?'未判定':criteria.some(c=>c.status==='不满足')?'存在不满足指标':criteria.some(c=>c.status==='无法评价')?'部分指标无法评价':'所测指标满足'
  return{measurements,criteria,conclusion}
}
