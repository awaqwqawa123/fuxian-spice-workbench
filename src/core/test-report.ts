import {dcSource,noiseNegativeNode} from './simulation-options'
import { analysisSignals, dcSweep, formatSI } from './circuit'
import type { Result } from './results'
import { analyzeWaveform } from './waveform-analysis'
import { validReportSamples } from './design-report-analysis'
import { resolveMeasurement } from './probes'
import { referenceSourceSpice, sourceSpice } from './spice-elements'

export interface TestReportMeasurement { name:string; value:string; source:string }
export interface CircuitTestReport {
  runId:string; title:string; timestamp:number; analysis:string; engine:string; points:number; elapsedMs:number
  settings:{name:string;value:string}[]; measurements:TestReportMeasurement[]
  warnings:string[]; netlist:string; log:string; resultKey:string
  conclusion:'未判定'
}

const analysisName={ac:'交流扫描',noise:'噪声分析',tran:'瞬态分析',op:'直流工作点',dc:'直流扫描'} as const

function range(values:number[], unit:string, label:string, source:string):TestReportMeasurement[] {
  if (!values.length || values.some(value=>!Number.isFinite(value))) return []
  let minimum=Infinity,maximum=-Infinity
  for(const value of values){minimum=Math.min(minimum,value);maximum=Math.max(maximum,value)}
  return [
    {name:`${label}最小值`,value:formatSI(minimum,unit,6),source},
    {name:`${label}最大值`,value:formatSI(maximum,unit,6),source},
    {name:`${label}末次采样`,value:formatSI(values.at(-1)!,unit,6),source},
  ]
}

/** A report is available only from a completed solver result, never from a drawing or proposal. */
export function buildTestReport(result:Result):CircuitTestReport {
  if (!result.id || !result.netlist || !result.engine || !Number.isFinite(result.timestamp) || !validReportSamples(result) ||
      !Number.isInteger(result.points) || result.points < 1 || result.x.length !== result.points ||
      (result.analysis==='noise' ? !result.noise || result.noise.input.length!==result.points || result.noise.output.length!==result.points || [...result.noise.input,...result.noise.output].some(v=>!Number.isFinite(v)||v<0) :
      result.vin.length !== result.points || result.vout.length !== result.points || result.current.length !== result.points))
    throw new Error('仿真结果不完整，无法生成测试报告')
  const {project,analysis}=result,signals=analysisSignals(project)
  const settings:{name:string;value:string}[]=[
    {name:'分析类型',value:analysisName[analysis]},
    {name:'输入节点',value:signals.inputNode},
    {name:'输出节点',value:signals.outputNode},
    {name:'参考电源',value:signals.sourceId},
    {name:'仿真温度',value:`${project.temperature??27} °C`},
  ]
  if(result.sweepLabel)settings.push({name:'扫描取值',value:result.sweepLabel})
  const sources=project.drawing?.devices.filter(device=>device.kind==='V'||device.kind==='I')
  if(sources?.length)for(const device of sources)settings.push({name:`${device.id} 激励`,value:sourceSpice(project,device,signals.sourceId,referenceSourceSpice(project))})
  else settings.push({name:`${signals.sourceId} 激励`,value:referenceSourceSpice(project)})
  if (analysis==='ac'||analysis==='noise') settings.push(
    {name:'起始频率',value:project.ac.start},{name:'终止频率',value:project.ac.stop},
    {name:project.ac.sweep==='lin'?'线性总点数':project.ac.sweep==='oct'?'每倍频程点数':'每十倍频点数',value:String(project.ac.points)},
  )
  if (analysis==='tran') settings.push({name:'终止时间',value:project.tran.stop},{name:'最大步长',value:project.tran.step},...(project.tran.start?[{name:'开始记录时间',value:project.tran.start}]:[]),...(project.tran.outputStep?[{name:'输出间隔',value:project.tran.outputStep}]:[]),...(project.tran.uic?[{name:'初始工作点',value:'跳过（UIC）'}]:[]))
  if (analysis==='dc') {const sweep=dcSweep(project);settings.push({name:'DC 扫描源',value:dcSource(project).id},{name:'扫描起点',value:sweep.start},{name:'扫描终点',value:sweep.stop},{name:'扫描步长',value:sweep.step})}
  if(analysis==='noise'&&project.noise?.summaryInterval!==undefined)settings.push({name:'噪声贡献明细间隔',value:String(project.noise.summaryInterval)})
  if(project.solver)for(const [name,value] of Object.entries(project.solver))settings.push({name:`求解器 ${name}`,value:String(value)})
  if(project.initialConditions?.length)settings.push({name:'节点初始电压',value:`${project.initialConditions.length} 个已配置端点`})
  if(project.nodeSets?.length)settings.push({name:'收敛初值提示',value:`${project.nodeSets.length} 个已配置端点`})
  const measurements:TestReportMeasurement[]=[]
  if (analysis==='noise') {
    const noise=result.noise!
    measurements.push(...range(noise.output,'V/√Hz','输出噪声密度',`ngspice onoise_spectrum；输出 V(${signals.outputNode},${noiseNegativeNode(project)})`))
    measurements.push(...range(noise.input,`${noise.inputUnit}/√Hz`,'输入等效噪声密度','ngspice inoise_spectrum；折算到参考源'))
    if(noise.totalOutput!==undefined&&Number.isFinite(noise.totalOutput))measurements.push({name:'输出噪声总量',value:formatSI(noise.totalOutput,'V RMS',6),source:'ngspice onoise_total；所设频段内的积分噪声'})
    if(noise.totalInput!==undefined&&Number.isFinite(noise.totalInput))measurements.push({name:'输入等效噪声总量',value:formatSI(noise.totalInput,`${noise.inputUnit} RMS`,6),source:'ngspice inoise_total；所设频段内的积分噪声'})
  } else if (analysis==='ac') {
    if (result.magnitude.length===result.points && result.magnitude.every(Number.isFinite)) {
      let peak=-Infinity,index=-1
      for(let i=0;i<result.magnitude.length;i++)if(result.magnitude[i]>peak){peak=result.magnitude[i];index=i}
      measurements.push({name:'扫描内峰值增益',value:`${peak.toFixed(6)} dB`,source:`传递函数 V(${signals.outputNode}) / V(${signals.inputNode})；采样点 ${index+1}，${formatSI(result.x[index],'Hz',6)}`})
      if(result.phase.length===result.points && Number.isFinite(result.phase[index])) measurements.push({name:'峰值处相位',value:`${result.phase[index].toFixed(6)} °`,source:`同一 AC 采样点 ${index+1}`})
    }
    if (result.cutoff!==null && Number.isFinite(result.cutoff)) measurements.push({name:'-3 dB 截止频率',value:formatSI(result.cutoff,'Hz',6),source:'相邻 AC 采样点插值；仅适用预置滤波器'})
  } else if (analysis==='op') {
    const voltages=Object.entries({[`v(${signals.inputNode})`]:result.vin,[`v(${signals.outputNode})`]:result.vout,...result.voltages})
    for(const [name,values] of voltages.sort(([a],[b])=>a.localeCompare(b)))if(values.length===1&&Number.isFinite(values[0]))
      measurements.push({name:`V(${name.slice(2,-1)})`,value:formatSI(values[0],'V',6),source:'直流工作点求解器节点电压'})
    const currents=Object.entries(result.currents??{})
    if(!currents.some(([name])=>name.toLowerCase()===`i(${signals.sourceId.toLowerCase()})`))currents.push([`I(${signals.sourceId})`,result.current])
    for(const [name,values] of currents.sort(([a],[b])=>a.localeCompare(b)))if(values.length===1&&Number.isFinite(values[0]))
      measurements.push({name:`I(${name.slice(2,-1).toLowerCase()===signals.sourceId.toLowerCase()?signals.sourceId:name.slice(2,-1)})`,value:formatSI(values[0],'A',6),source:'直流工作点求解器支路电流；正方向以网表定义为准'})
  } else {
    measurements.push(...range(result.vin,'V',`V(${signals.inputNode})`,'求解器输入节点电压采样'))
    measurements.push(...range(result.vout,'V',`V(${signals.outputNode})`,'求解器输出节点电压采样'))
    measurements.push(...range(result.current,'A',`I(${signals.sourceId})`,'求解器电源支路电流采样'))
  }
  if(analysis!=='noise')for(const probe of project.probes??[]){
    const trace=resolveMeasurement(result,probe)
    if(!trace)continue
    const label=`${probe.id} · ${trace.name}`,unit=trace.kind==='current'?'A':'V'
    if(analysis==='ac'){
      const values=trace.magnitude!
      let index=0;for(let i=1;i<values.length;i++)if(values[i]>values[index])index=i
      measurements.push({name:`${label}幅值峰值`,value:`${values[index].toFixed(6)} dB re 1 ${unit}`,source:`探针复数幅值取 20 log10(|X|/1 ${unit})；${formatSI(result.x[index],'Hz',6)}；非传递增益`})
      measurements.push({name:`${label}峰值处相位`,value:`${trace.phase![index].toFixed(6)} °`,source:'同一实际探针复数采样点'})
    }else if(analysis==='op')measurements.push({name:label,value:formatSI(trace.values[0],unit,6),source:'实际探针端点 / 方向下的工作点值'})
    else measurements.push(...range(trace.values,unit,label,'实际探针端点 / 方向下的完整采样统计'))
  }
  if(analysis==='tran'||analysis==='dc'){
    const measured=analyzeWaveform(result)
    for(const record of measured.records)measurements.push({name:`${measured.signalName} · ${record.name}`,value:record.value===null?`不可用：${record.reason??'没有满足条件的采样'}`:formatSI(record.value,record.unit,6),source:record.source})
  }
  return {runId:result.id,title:project.title,timestamp:result.timestamp,analysis:analysisName[analysis],engine:result.engine,
    points:result.points,elapsedMs:result.elapsed,settings,measurements,warnings:result.warnings,
    netlist:result.netlist,log:result.log,resultKey:result.key,conclusion:'未判定'}
}

function escapeHtml(value:unknown):string {return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!))}

/** Export captures the exact selected run and whether its circuit/configuration has since changed. */
export function testReportHtml(report:CircuitTestReport,stale:boolean):string {
  const row=(name:string,value:string)=>`<tr><th scope="row">${escapeHtml(name)}</th><td>${escapeHtml(value)}</td></tr>`
  const measurementRows=report.measurements.map(item=>`<tr><th scope="row">${escapeHtml(item.name)}</th><td>${escapeHtml(item.value)}</td><td>${escapeHtml(item.source)}</td></tr>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(report.title)} · 测试报告</title><style>body{font:14px/1.6 system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 20px;color:#24362c}h1{font-size:24px}h2{font-size:17px;margin-top:28px}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #ddd}th{width:30%}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7f4;padding:14px}.status{padding:10px;background:${stale?'#fff2df':'#edf5ed'}}@media print{body{margin:0;max-width:none}.no-print{display:none}}</style></head><body><h1>${escapeHtml(report.title)} · 电路测试报告</h1><p class="status">${stale?'历史结果：电路或仿真配置已修改，请重新运行后判读。':'仿真已完成。'} 验收结论：${report.conclusion}（未设置验收标准）</p><h2>运行来源</h2><table>${row('运行 ID',report.runId)}${row('运行时间',new Date(report.timestamp).toLocaleString('zh-CN'))}${row('分析类型',report.analysis)}${row('求解器',report.engine)}${row('实际采样点',String(report.points))}${row('耗时',`${(report.elapsedMs/1000).toFixed(3)} s`)}</table><h2>运行配置</h2><table>${report.settings.map(item=>row(item.name,item.value)).join('')}</table><h2>实测数据</h2><table><thead><tr><th>测量</th><th>结果</th><th>计算依据</th></tr></thead><tbody>${measurementRows||'<tr><td colspan="3">没有可用的派生测量值；请查看原始结果。</td></tr>'}</tbody></table><p>这些是仿真采样或其派生统计量；未设验收阈值，不给出通过或失败判断。</p><h2>求解器警告</h2><pre>${escapeHtml(report.warnings.length?report.warnings.join('\n'):'无')}</pre><h2>实际运行网表</h2><pre>${escapeHtml(report.netlist)}</pre><h2>运行日志</h2><pre>${escapeHtml(report.log)}</pre><details><summary>结果配置标识</summary><pre>${escapeHtml(report.resultKey)}</pre></details><p class="no-print"><button onclick="window.print()">打印或保存 PDF</button></p></body></html>`
}
