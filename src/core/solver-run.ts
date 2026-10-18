import type { Simulation } from 'eecircuit-engine'
import type { Analysis } from './circuit'
import type { RawResult } from './results'
import { runNoiseSimulation } from './noise-simulation'
import { prepareRuntimeNetlist } from './spice-runtime-compatibility'
import { parseSpiceLibrary } from './spice-models'
import { thermalModelStart } from './model-thermal-start'

export interface SolverRun { raw:RawResult; netlist:string; log:string; runLog:string; warnings:string[] }
const fatal=(message:string)=>/^\s*(?:error|fatal|panic|abort)/i.test(message)&&!/^\s*error:\s*measure\b/i.test(message)
const convergence=/(?:operating point.*(?:could not|fail)|transient op failed|timestep too small|(?:dc|ac|noise|tran).*simulation.*aborted|no convergence)/i
const nodeName=/^[-+a-z0-9_.:#\[\]]+$/i

function number(text:string):number {
  const match=text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/i)
  if(!match)return NaN
  const suffix=match[2].toLowerCase(),prefix=suffix.startsWith('meg')?'meg':suffix.startsWith('mil')?'mil':suffix[0]
  const scales:Record<string,number>={t:1e12,g:1e9,meg:1e6,k:1e3,mil:25.4e-6,m:1e-3,u:1e-6,n:1e-9,p:1e-12,f:1e-15}
  return Number(match[1])*(scales[prefix]??1)
}

/** Refuse a truncated curve even when the engine exports a partial plot. */
export function solverCompletionIssue(raw:RawResult,netlist:string,analysis:Analysis):string|undefined {
  if(!raw?.numPoints||!Array.isArray(raw.data))return '求解器未返回有效采样点'
  if(analysis==='op')return raw.numPoints===1?undefined:'工作点采样数量不完整'
  const axis=raw.data.find(vector=>analysis==='dc'?/^(?:v\()?v-sweep\)?$|^(?:i\()?i-sweep\)?$/i.test(vector.name):vector.name.toLowerCase()===(analysis==='tran'?'time':'frequency'))
  if(!axis||axis.values.length!==raw.numPoints)return '求解器未返回完整扫描坐标'
  const x=axis.values.map(value=>typeof value==='number'?value:value.real)
  if(x.some(value=>!Number.isFinite(value)))return '求解器返回了无效扫描坐标'
  const near=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-14,Math.abs(a)*1e-7,Math.abs(b)*1e-7)
  const directive=netlist.match(new RegExp(`^\\s*\\.${analysis}\\s+([^\\r\\n]+)$`,'im'))?.[1].trim().split(/\s+/)
  if(!directive)return undefined
  if(analysis==='dc'&&directive.length===4){
    const [start,stop,step]=directive.slice(1).map(number),count=Math.floor((stop-start)/step+1e-9)+1
    if([start,stop,step,count].every(Number.isFinite)&&step!==0&&count>0&&(raw.numPoints!==count||!near(x[0],start)||!near(x.at(-1)!,start+(count-1)*step)))return `直流扫描未完成：需要 ${count} 点，实际 ${raw.numPoints} 点`
  }else if(analysis==='tran'){
    const stop=number(directive[1])
    if(Number.isFinite(stop)&&!near(x.at(-1)!,stop))return `瞬态仿真未达到终止时间 ${stop} s`
  }else if(analysis==='ac'||analysis==='noise'){
    // NOISE begins with an output probe and input source, then the AC sweep.
    const sweep=analysis==='noise'?netlist.match(/^\s*\.noise\s+v\([^)]*\)\s+\S+\s+([^\r\n]+)$/im)?.[1].trim().split(/\s+/):directive
    const [kind,countText,startText,stopText]=sweep??[]
    const [count,start,stop]=[countText,startText,stopText].map(text=>number(text??''))
    if([count,start,stop].every(Number.isFinite)&&count>0&&start>0&&stop>start){
      const linear=kind?.toLowerCase()==='lin',base=kind?.toLowerCase()==='oct'?2:10
      const fullCount=linear?count:Math.floor(count*Math.log(stop/start)/Math.log(base)+1e-9)+1
      // ngspice saves the first noise point and then each pts_per_summary-th
      // frequency. Zero/omitted summaries still save the full spectrum.
      const requestedInterval=analysis==='noise'?number(sweep?.[4]??'0'):0
      const stride=Number.isInteger(requestedInterval)&&requestedInterval>0?requestedInterval:1
      const expected=Math.ceil(fullCount/stride)
      if(raw.numPoints!==expected||!near(x[0],start))return `频率扫描未完成：需要 ${expected} 点，实际 ${raw.numPoints} 点`
      if(analysis==='noise'&&x.some((value,index)=>!near(value,linear?start+(stop-start)*index*stride/(count-1):start*base**(index*stride/count))))return '噪声频率扫描坐标与请求的频点输出间隔不一致'
    }
  }
  return undefined
}

/** Numerical guesses only: no IC/UIC, shunts, source edits or model changes.
 * Explicit user IC/NODESET values always win. Unknown syntax is not emitted. */
export function recoveryNetlist(netlist:string,raw?:RawResult):string|undefined {
  const reserved=new Set<string>(),nodes=new Map<string,string>()
  const logicalLines=netlist.replace(/\r?\n[ \t]*\+/g,' ').split(/\r?\n/)
  for(const line of logicalLines)if(/^\s*\.(?:ic|nodeset)\b/i.test(line))for(const match of line.matchAll(/\bv\(\s*([^()\s]+)\s*\)\s*=/gi))reserved.add(match[1].toLowerCase())
  const add=(name:string)=>{const key=name.toLowerCase();if(key!=='0'&&key!=='gnd'&&key!=='v-sweep'&&nodeName.test(name)&&!reserved.has(key)&&nodes.size<512)nodes.set(key,name)}
  for(const line of logicalLines)if(/^\s*\.save\b/i.test(line))for(const match of line.matchAll(/\bv\(\s*([^()]+)\s*\)/gi))for(const name of match[1].split(','))add(name.trim())
  for(const vector of raw?.data??[]){const match=vector.name.match(/^v\(([^()]+)\)$/i);if(match)add(match[1])}
  // Hand-written decks may have no SAVE and fail before returning any vector.
  // Collect only unambiguous top-level two-terminal devices and BJT terminals.
  let depth=0
  for(const line of netlist.split(/\r?\n/).slice(1)){
    if(/^\s*\.subckt\b/i.test(line)){depth++;continue}
    if(/^\s*\.ends\b/i.test(line)){depth=Math.max(0,depth-1);continue}
    if(depth)continue
    const parts=line.trim().split(/\s+/)
    if(/^[rclvdib]\S*$/i.test(parts[0])&&!line.trim().startsWith('*'))parts.slice(1,3).forEach(add)
    else if(/^q\S*$/i.test(parts[0]))parts.slice(1,4).forEach(add)
  }
  const hints=[...nodes.values()].map(name=>`V(${name})=0`)
  // A thermal behavioral resistor can divide by its internal resistance node.
  // Use only recognized source equations, with no guessed ports or coefficients.
  // NODESET is released by the solver; it does not hold a physical temperature
  // or resistance fixed. Explicit user guesses and IC always take precedence.
  try {
    const temperatures=[...netlist.matchAll(/^\s*\.temp\s+(\S+)\s*$/gmi)]
    const optionTemperature=netlist.match(/^\s*\.options\s+[^\n]*\btemp\s*=\s*(\S+)/im)?.[1]
    const temperature=temperatures.length===1?Number(temperatures[0][1]):temperatures.length>1?NaN:optionTemperature?Number(optionTemperature):27
    const models=parseSpiceLibrary(netlist,{label:'Existing runtime source equation'}).models
    let subcircuitDepth=0
    for(const line of logicalLines.slice(1)){
      if(/^\s*\.subckt\b/i.test(line)){subcircuitDepth++;continue}
      if(/^\s*\.ends\b/i.test(line)){subcircuitDepth=Math.max(0,subcircuitDepth-1);continue}
      if(subcircuitDepth||!/^\s*x\S+\s/i.test(line))continue
      const tokens=line.split(/\s[;$]/)[0].trim().split(/\s+/)
      const model=models.find(model=>model.kind==='X'&&tokens[model.pins.length+1]?.toLowerCase()===model.id.toLowerCase())
      // Instance overrides may change thermal coefficients. Leave those decks
      // to explicit initial guesses until their expressions can be verified.
      if(!model||tokens.length!==model.pins.length+2)continue
      const start=thermalModelStart(model,temperature)
      for(const node of start?.nodes??[]){
        const name=`${tokens[0].toLowerCase()}.${node.path}`
        if(nodeName.test(name)&&!reserved.has(name.toLowerCase())&&hints.length<512)hints.push(`V(${name})=${node.value}`)
      }
    }
  }catch{/* Unrecognized source syntax never supplies speculative thermal hints. */}
  if(!hints.length)return undefined
  const lines=[]
  for(let i=0;i<hints.length;i+=8)lines.push(`.nodeset ${hints.slice(i,i+8).join(' ')}`)
  if(!/^\s*\.end\s*$/im.test(netlist))return undefined
  return netlist.replace(/^([ \t]*)\.end\s*$/im,`* Workbench convergence recovery: NODESET is released after the initial guess\n${lines.join('\n')}\n$1.end`)
}

/** One bounded restart for numerical convergence failures, shared by all callers. */
export async function runSolver(simulation:Simulation,netlist:string,analysis:Analysis,onProgress?:(message:string)=>void):Promise<SolverRun> {
  netlist=prepareRuntimeNetlist(netlist)
  const attempt=async(code:string)=>{
    let raw:RawResult|undefined,caught:unknown
    try{if(analysis==='noise')raw=await runNoiseSimulation(simulation,code);else{simulation.setNetList(code);raw=await simulation.runSim()}}catch(error){caught=error}
    const warnings=[...simulation.getError()],log=simulation.getInfo()
    const failures=warnings.filter(fatal),issue=raw?solverCompletionIssue(raw,code,analysis):undefined
    const error=failures.length?failures.join('\n'):caught instanceof Error?caught.message:caught?String(caught):issue
    return {raw,warnings,log,error,issue,failures}
  }
  const original=await attempt(netlist)
  if(!original.error&&original.raw)return {raw:original.raw,netlist,log:original.log,runLog:original.log,warnings:original.warnings}
  // A late transient integration failure is not an initialization failure.
  // Do not restart it with different initial guesses and pretend it is fixed.
  const numerical=original.failures.length?original.failures.every(message=>convergence.test(message)):original.error&&convergence.test(original.error)||Boolean(original.issue&&analysis!=='tran')
  const lateTransient=analysis==='tran'&&(original.raw?.numPoints??0)>1
  const retry=numerical&&!lateTransient?recoveryNetlist(netlist,original.raw):undefined
  if(!retry)throw new Error(original.error??'ngspice 未返回有效结果')
  onProgress?.('工作点求解未完成，正在使用节点初值重新求解…')
  const recovered=await attempt(retry)
  if(recovered.error||!recovered.raw)throw new Error(`工作点恢复未成功；请检查电路连接、模型与初始条件。\n首次求解：${original.error}\n恢复求解：${recovered.error??'未返回数据'}`)
  const thermalHints=/\.nodeset[^\n]*v\([^)]*\.aout\)=/i.test(retry)
  const notice=thermalHints?'工作点已恢复：依据原模型热方程补充内部电阻的 NODESET 初始猜测；未修改电路、参数或积分方法，用户初始条件优先。':'工作点已恢复：自动补充零电压 NODESET 初始猜测；电路、模型、源设置、精度与积分方法保持原值，用户初始条件优先。'
  const warnings=[notice,...[...new Set(original.warnings)].map(message=>`恢复前：${message}`),...(original.issue?[`恢复前：${original.issue}`]:[]),...recovered.warnings]
  const log=`${notice}\n\n===== 首次求解（未完成，数据未采用） =====\n${original.log}\n\n===== NODESET 恢复求解 =====\n${recovered.log}`
  return {raw:recovered.raw,netlist:retry,log,runLog:recovered.log,warnings}
}
