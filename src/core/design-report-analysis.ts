import { analysisSignals, circuitGraph, dcSweep, formatSI, parseQuantity, templates, type Project } from './circuit'
import { compileDrawing, deviceNames, type Device } from './drawing'
import { deviceCatalog, modelFor } from './devices'
import { editableProject } from './editor'
import { schematicSvg } from './export-svg'
import { resolveMeasurement } from './probes'
import type { Result } from './results'
import { sourceSpice, referenceSourceSpice } from './spice-elements'
import type { ReportTestSettings } from './report-settings'

export const reportEscape = (value:unknown):string => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]!)
export type { ReportDetails } from './report-settings'
export interface ReportChart { title:string; svg:string; caption:string; xBounds?:[number,number]; yBounds?:[number,number]; xUnit?:string; yUnit?:string; logarithmic?:boolean; signals?:string[] }
export interface CircuitDescription {
  introduction:string; principle:string; signalPath:string; schematic:string
  components:{id:string;type:string;value:string;connections:string;role:string}[]
  models:{name:string;source:string;detail:string}[]
  functionalBlocks:{name:string;devices:string[];description:string;evidence:string}[]
  calculations:{name:string;formula:string;value:number;unit:string;assumptions:string;evidence:string}[]
  designNotes:string[]
}
const roles:Record<string,string>={R:'限制电流并参与偏置、负载或阻尼；具体作用由连接决定。',C:'储存电场能量，直流稳态下理想电容开路。',L:'储存磁场能量，直流稳态下理想电感短路。',V:'定义端间电压；电流正方向按网表正端到负端。',I:'定义支路电流，方向按网表端口顺序。',D:'模型决定正向导通及反向行为。',Q:'模型与偏置共同决定放大或开关状态。',M:'栅压与器件模型决定导通状态。',X:'内部行为由所选子电路模型决定。'}

export function describeCircuit(project:Project):CircuitDescription {
  const signals=analysisSignals(project), drawing=project.template==='custom'?project.drawing!:editableProject(project).drawing!
  const elements:{device:Device;nodes:string[]}[]=project.template==='custom'?compileDrawing(drawing).elements:circuitGraph(project).parts.map(part=>({device:{...part,rotation:0 as const},nodes:part.nodes}))
  const components=elements.map(({device,nodes})=>({id:device.id,type:deviceNames[device.kind],
    value:['V','I'].includes(device.kind)?sourceSpice(project,device,signals.sourceId,referenceSourceSpice(project)):device.value+(device.params?`；${Object.entries(device.params).map(([name,value])=>`${name}=${value}`).join('；')}`:''),
    connections:nodes.map((node,index)=>`${device.kind==='X'?('pins' in device?device.pins?.[index]:undefined)??`端口 ${index+1}`:deviceCatalog[device.kind].pins[index]??`端口 ${index+1}`} → ${node}`).join('；'),
    role:roles[device.kind]??'功能按器件定义、端口连接和模型参数判读。'}))
  const models=elements.flatMap(({device})=>{
    const model=modelFor(device.kind,device.value,project.models)
    if(!model)return []
    const imported=project.models?.find(item=>item.id.toLowerCase()===device.value.toLowerCase())
    return [{name:model.id,source:imported?`${imported.source.label}${imported.source.url?` · ${imported.source.url}`:''}${imported.source.license?`；许可：${imported.source.license}`:''}`:'内置教学 / 行为模型',detail:model.detail}]
  }).filter((model,index,all)=>all.findIndex(item=>item.name===model.name)===index)
  let topology=project.template
  const functionalBlocks:CircuitDescription['functionalBlocks']=[],calculations:CircuitDescription['calculations']=[],designNotes:string[]=[]
  const assumptions='理想基本元件、理想输入源，未包含额外寄生或未列出的负载；数值取自当前电路参数。'
  const calculate=(name:string,formula:string,value:number,unit:string,evidence:string)=>{if(Number.isFinite(value))calculations.push({name,formula,value,unit,assumptions,evidence})}
  const resistor=elements.find(item=>item.device.kind==='R'),capacitor=elements.find(item=>item.device.kind==='C')
  const spans=(nodes:string[],a:string,b:string)=>nodes.length===2&&nodes.includes(a)&&nodes.includes(b)
  const basicPassive=elements.filter(item=>['R','C','L'].includes(item.device.kind)).every(item=>!Object.keys(item.device.params??{}).length)
  const idealInput=elements.filter(item=>item.device.kind==='V').length===1&&elements.some(item=>item.device.id===signals.sourceId&&item.device.kind==='V'&&item.nodes[0]===signals.inputNode&&item.nodes[1]==='0')
  // Infer only the complete, unambiguous three-element RC network; a title is never evidence.
  if(topology==='custom'&&basicPassive&&idealInput&&elements.length===3&&resistor&&capacitor){
    if(spans(resistor.nodes,signals.inputNode,signals.outputNode)&&spans(capacitor.nodes,signals.outputNode,'0'))topology='rc-lowpass'
    else if(spans(capacitor.nodes,signals.inputNode,signals.outputNode)&&spans(resistor.nodes,signals.outputNode,'0'))topology='rc-highpass'
  }
  const inductor=elements.find(item=>item.device.kind==='L')
  if(topology==='custom'&&basicPassive&&idealInput&&elements.length===4&&resistor&&capacitor&&inductor&&spans(capacitor.nodes,signals.outputNode,'0')){
    const middle=resistor.nodes.find(node=>node!==signals.inputNode&&node!==signals.outputNode&&node!=='0')??inductor.nodes.find(node=>node!==signals.inputNode&&node!==signals.outputNode&&node!=='0')
    if(middle&&(spans(resistor.nodes,signals.inputNode,middle)&&spans(inductor.nodes,middle,signals.outputNode)||spans(inductor.nodes,signals.inputNode,middle)&&spans(resistor.nodes,middle,signals.outputNode)))topology='rlc-lowpass'
  }
  let principle='本电路为自由绘制电路。以下器件与连接表来自实际电路拓扑；仅凭器件名称、参考源和输出节点不能确定整体设计目的。请在“原理说明”中补充功能分区、主通道、反馈、偏置及保护关系。'
  if(topology==='rc-lowpass'||topology==='rc-highpass'){
    const r=parseQuantity(resistor!.device.value,'resistance'),c=parseQuantity(capacitor!.device.value,'capacitance'),rId=resistor!.device.id,cId=capacitor!.device.id
    principle=topology==='rc-lowpass'?`${rId} 串联在输入与输出之间，${cId} 从输出接地。理想小信号传递函数 H(s)=1/(1+sRC)，保留低频并衰减高频。`:`${cId} 串联在输入与输出之间，${rId} 从输出接地。理想小信号传递函数 H(s)=sRC/(1+sRC)，抑制直流和低频并保留高频。`
    principle+=` 理论时间常数 RC=${formatSI(r*c,'s',6)}，理论截止频率 1/(2πRC)=${formatSI(1/(2*Math.PI*r*c),'Hz',6)}；其中 R=${rId}、C=${cId}，该关系假设理想源和无额外负载。`
    const evidence=`${rId}=${resistor!.device.value}，${cId}=${capacitor!.device.value}；端口见连接表`
    calculate('时间常数','τ=RC',r*c,'s',evidence);calculate('截止频率','fc=1/(2πRC)',1/(2*Math.PI*r*c),'Hz',evidence)
    functionalBlocks.push({name:topology==='rc-lowpass'?'一阶低通网络':'一阶高通网络',devices:[rId,cId],description:principle,evidence:`${signals.inputNode} / ${signals.outputNode} / 0 的完整 RC 端口关系`})
  }else if(topology==='rlc-lowpass'){
    const r=parseQuantity(resistor!.device.value,'resistance'),l=parseQuantity(inductor!.device.value,'inductance'),c=parseQuantity(capacitor!.device.value,'capacitance'),zeta=r/2*Math.sqrt(c/l),f0=1/(2*Math.PI*Math.sqrt(l*c))
    principle=`${resistor!.device.id}、${inductor!.device.id} 串联驱动接地的 ${capacitor!.device.id}，理想传递函数 H(s)=1/(LCs²+RCs+1)。无阻尼固有频率 f0=${formatSI(f0,'Hz',6)}，阻尼比 ζ=${Number(zeta.toPrecision(6))}；无阻尼固有频率不等同于实测峰值或截止频率。`
    const evidence=`${resistor!.device.id}=${resistor!.device.value}，${inductor!.device.id}=${inductor!.device.value}，${capacitor!.device.id}=${capacitor!.device.value}`
    calculate('无阻尼固有频率','f0=1/(2π√(LC))',f0,'Hz',evidence);calculate('阻尼比','ζ=(R/2)√(C/L)',zeta,'',evidence)
    if(zeta<1/Math.sqrt(2))calculate('理论谐振峰频率','fp=f0√(1−2ζ²)',f0*Math.sqrt(1-2*zeta*zeta),'Hz',evidence)
    functionalBlocks.push({name:'二阶 RLC 低通网络',devices:[resistor!.device.id,inductor!.device.id,capacitor!.device.id],description:principle,evidence:'唯一串联 RL 主通道与输出接地电容的完整端口关系'})
  }
  // A shunt load changes both DC gain and the RC pole; recognize that complete network separately.
  if(topology==='custom'&&basicPassive&&idealInput&&elements.length===4&&capacitor&&spans(capacitor.nodes,signals.outputNode,'0')){
    const series=elements.find(item=>item.device.kind==='R'&&spans(item.nodes,signals.inputNode,signals.outputNode)),load=elements.find(item=>item.device.kind==='R'&&spans(item.nodes,signals.outputNode,'0'))
    if(series&&load&&elements.filter(item=>item.device.kind==='V').length===1){
      const rs=parseQuantity(series.device.value,'resistance'),rl=parseQuantity(load.device.value,'resistance'),c=parseQuantity(capacitor.device.value,'capacitance'),req=rs*rl/(rs+rl),gain=rl/(rs+rl)
      principle=`${series.device.id} 为串联电阻，${load.device.id} 与 ${capacitor.device.id} 并联接地，形成带电阻负载的一阶低通网络。H(s)=[RL/(RS+RL)]/[1+s(RS∥RL)C]。负载改变直流增益及极点，不能继续采用无负载 RC 截止公式。`
      const evidence=`RS=${series.device.value}，RL=${load.device.value}，C=${capacitor.device.value}；端口见连接表`
      calculate('直流传递增益','H(0)=RL/(RS+RL)',gain,'V/V',evidence);calculate('等效电阻','Req=RS∥RL',req,'Ω',evidence);calculate('时间常数','τ=(RS∥RL)C',req*c,'s',evidence);calculate('截止频率','fc=1/[2π(RS∥RL)C]',1/(2*Math.PI*req*c),'Hz',evidence)
      functionalBlocks.push({name:'带负载一阶低通网络',devices:[series.device.id,load.device.id,capacitor.device.id],description:principle,evidence:'RS串联，RL与C并联，且无其他电气元件的完整拓扑'})
    }
  }
  const sources=elements.filter(item=>item.device.kind==='V'||item.device.kind==='I')
  if(sources.length)functionalBlocks.push({name:'激励与偏置定义',devices:sources.map(item=>item.device.id),description:sources.map(item=>`${item.device.id}：${sourceSpice(project,item.device,signals.sourceId,referenceSourceSpice(project))}`).join('；'),evidence:'独立源参数及真实端口连接；每项测试的源定义另列于运行条件'})
  const active=elements.filter(item=>!['R','C','L','V','I'].includes(item.device.kind))
  if(active.length)functionalBlocks.push({name:'有源、非线性与行为器件',devices:active.map(item=>item.device.id),description:active.map(item=>`${item.device.id}：${deviceNames[item.device.kind]}，${item.device.value}`).join('；')+'。功能边界按模型说明及电气连接核对。',evidence:'器件类型、模型及端口表；未从器件名称猜测闭环功能'})
  const deviceEvidence=new Set(functionalBlocks.flatMap(block=>block.devices)),unclassified=elements.filter(item=>!deviceEvidence.has(item.device.id))
  if(unclassified.length)functionalBlocks.push({name:'待补充的功能分区',devices:unclassified.map(item=>item.device.id),description:'已列出实际器件及连接。请结合设计目的说明主通道、反馈、保护及器件选型依据。',evidence:'连接表；当前没有足以确定完整模块功能的结构证据'})
  designNotes.push('设计选型需对照器件数据手册、额定值和模型适用条件。自动理论计算只对明确识别的完整理想网络成立。')
  if(!calculations.length)designNotes.push('当前电路未匹配已验证的理论网络，理论计算及反馈稳定性论证需由设计人员补充。')
  if(active.some(item=>['OPA','CMP','OP','LDO','XFMR'].includes(item.device.kind)))designNotes.push('通用行为器件的供电、带宽、限流或耦合等参数只体现模型所含行为；转换速率、热效应和实物保护能力需单独核对。')
  return {introduction:`${templates.find(item=>item.id===project.template)?.name??'自定义电路'}，共 ${components.length} 个电气器件。所有节点电压以节点 0（GND）为参考。`,principle,
    signalPath:`参考源 ${signals.sourceId}；输入节点 ${signals.inputNode}；参考输出节点 ${signals.outputNode}。两者为仿真观察端点，不能单独证明真实信号传播或反馈路径。`,components,models,functionalBlocks,calculations,designNotes,
    schematic:schematicSvg(drawing,{title:project.title,sourceSummary:referenceSourceSpice(project),models:project.models,probes:project.template==='custom'?project.probes:undefined})}
}

interface Trace {name:string;unit:string;values:number[];signal?:string}
function finite(values:number[],points:number){return values.length===points&&values.every(Number.isFinite)}

/** Piecewise-linear integration respects ngspice's adaptive, nonuniform time grid. */
export function timeStatistics(x:readonly number[],values:readonly number[]):{mean:number;rms:number}|null {
  if(x.length<2||values.length!==x.length||x.some((v,i)=>!Number.isFinite(v)||i>0&&v<=x[i-1])||values.some(v=>!Number.isFinite(v)))return null
  let integral=0,squares=0
  for(let i=1;i<x.length;i++){const dt=x[i]-x[i-1],a=values[i-1],b=values[i];integral+=dt*(a+b)/2;squares+=dt*(a*a+a*b+b*b)/3}
  const duration=x.at(-1)!-x[0]
  return {mean:integral/duration,rms:Math.sqrt(Math.max(0,squares/duration))}
}

function extrema(values:number[]){let min=Infinity,max=-Infinity,minIndex=0,maxIndex=0;values.forEach((v,i)=>{if(v<min){min=v;minIndex=i}if(v>max){max=v;maxIndex=i}});return{min,max,minIndex,maxIndex}}
const display=(value:number,unit:string,digits=6)=>unit.startsWith('dB')||unit==='°'?`${Number(value.toPrecision(digits))} ${unit}`:formatSI(value,unit,digits)
function sampledIndices(values:number[],limit=1200):number[]{
  if(values.length<=limit)return values.map((_,i)=>i)
  const indices=new Set([0,values.length-1]),bucket=Math.ceil(values.length/(limit/2))
  for(let start=0;start<values.length;start+=bucket){let low=start,high=start;for(let i=start+1;i<Math.min(start+bucket,values.length);i++){if(values[i]<values[low])low=i;if(values[i]>values[high])high=i}indices.add(low);indices.add(high)}
  return [...indices].sort((a,b)=>a-b)
}
export function reportChart(title:string,x:number[],traces:Trace[],xUnit:string,logarithmic=false):ReportChart {
  const width=820,height=310,left=90,right=24,top=38,bottom=65
  const transform=(n:number)=>logarithmic?Math.log10(n):n, x0=transform(x[0]),x1=transform(x.at(-1)!)
  let min=Infinity,max=-Infinity
  for(const trace of traces){const e=extrema(trace.values);min=Math.min(min,e.min);max=Math.max(max,e.max)}
  const padding=max===min?Math.max(Math.abs(max)*.05,1e-12):(max-min)*.07;min-=padding;max+=padding
  const px=(i:number)=>left+(transform(x[i])-x0)/(x1-x0||1)*(width-left-right)
  const py=(value:number)=>top+(max-value)/(max-min)*(height-top-bottom)
  const colors=['#286d53','#336bb3','#b46428','#894ab1','#c35065','#2f8492']
  const grid=Array.from({length:5},(_,i)=>{const y=top+i*(height-top-bottom)/4,v=max-i*(max-min)/4;return `<line x1="${left}" y1="${y}" x2="${width-right}" y2="${y}" stroke="#e2e9e4"/><text x="${left-9}" y="${y+4}" text-anchor="end">${reportEscape(display(v,traces[0].unit,4))}</text>`}).join('')
  const ticks=Array.from({length:5},(_,i)=>{const t=x0+(x1-x0)*i/4,v=logarithmic?10**t:t;return `<text x="${left+i*(width-left-right)/4}" y="${height-bottom+22}" text-anchor="middle">${reportEscape(formatSI(v,xUnit,4))}</text>`}).join('')
  const paths=traces.map((trace,index)=>`<path d="${sampledIndices(trace.values).map((i,n)=>`${n?'L':'M'}${px(i).toFixed(2)},${py(trace.values[i]).toFixed(2)}`).join(' ')}" stroke="${colors[index%colors.length]}" fill="none" stroke-width="1.6"/><text x="${left+index*230}" y="${height-10}" fill="${colors[index%colors.length]}">${reportEscape(trace.name)}</text>`).join('')
  return {title,svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${reportEscape(title)}"><rect width="100%" height="100%" fill="white"/><g font-family="Microsoft YaHei, sans-serif" font-size="11" fill="#52685b"><text x="${left}" y="20" font-size="14">${reportEscape(title)}</text>${grid}${ticks}${paths}</g></svg>`,caption:`横轴：${xUnit}${logarithmic?'（对数频率）':''}；纵轴：${traces[0].unit}。图形来自 ${x.length} 个实际采样点，绘图压缩保留分桶极值；测量和统计使用完整采样。`,xBounds:[x[0],x.at(-1)!],yBounds:[min,max],xUnit,yUnit:traces[0].unit,logarithmic,signals:traces.map(trace=>trace.signal??trace.name)}
}

export function analyzeRun(result:Result):{observations:string[];charts:ReportChart[];limitations:string[]} {
  const {analysis,x}=result, signals=analysisSignals(result.project),observations:string[]=[],charts:ReportChart[]=[],limitations:string[]=[]
  if(analysis==='ac'){
    const peak=extrema(result.magnitude),i=peak.maxIndex
    observations.push(`在实际扫描 ${formatSI(x[0],'Hz',6)} 至 ${formatSI(x.at(-1)!,'Hz',6)} 内，参考传递函数 V(${signals.outputNode})/V(${signals.inputNode}) 的峰值增益为 ${display(peak.max,'dB')}，位于 ${formatSI(x[i],'Hz',6)}，该点相位 ${display(result.phase[i],'°')}。扫描端点的增益分别为 ${display(result.magnitude[0],'dB')} 和 ${display(result.magnitude.at(-1)!,'dB')}。`)
    charts.push(reportChart('参考传递函数 · 增益',x,[{name:'输出 / 输入',unit:'dB',values:result.magnitude,signal:'output'}],'Hz',true),reportChart('参考传递函数 · 相位',x,[{name:'展开相位',unit:'°',values:result.phase,signal:'output'}],'Hz',true))
    limitations.push('AC 为工作点附近的小信号线性响应，不能直接证明大信号、启动或饱和行为。扫描内峰值不能代表扫描范围外的极值。')
  }else if(analysis==='noise'){
    const noise=result.noise!,peak=extrema(noise.output)
    observations.push(`输出噪声密度在所扫描频段内的最大采样值为 ${formatSI(peak.max,'V/√Hz',6)}，位于 ${formatSI(x[peak.maxIndex],'Hz',6)}。${noise.totalOutput===undefined?'求解器没有提供输出积分噪声总量。':`该频段输出积分噪声为 ${formatSI(noise.totalOutput,'V RMS',6)}。`}`)
    charts.push(reportChart('输出噪声谱密度',x,[{name:'输出噪声',unit:'V/√Hz',values:noise.output,signal:'noise:output'}],'Hz',true),reportChart('输入等效噪声谱密度',x,[{name:'输入等效噪声',unit:`${noise.inputUnit}/√Hz`,values:noise.input,signal:'noise:input'}],'Hz',true))
    limitations.push('噪声曲线为幅度谱密度；积分 RMS 总量仅引用求解器返回值。噪声密度不能当作波形幅值或直接相加成噪声总量。')
  }else if(analysis==='op'){
    observations.push(`直流工作点：V(${signals.inputNode})=${formatSI(result.vin[0],'V',6)}，V(${signals.outputNode})=${formatSI(result.vout[0],'V',6)}，I(${signals.sourceId})=${formatSI(result.current[0],'A',6)}。该数值是单一偏置条件下的静态解。`)
    limitations.push('工作点分析不验证瞬态启动、频率响应、纹波或环路稳定性。支路电流负值表示与网表定义正方向相反。')
  }else{
    const output=extrema(result.vout),unit=analysis==='tran'?'s':/^I/i.test(dcSweep(result.project).sourceId??result.project.drawing?.sourceId??'V1')?'A':'V'
    observations.push(`实际${analysis==='tran'?'时间':unit==='A'?'电流扫描':'电压扫描'}区间为 ${formatSI(x[0],unit,6)} 至 ${formatSI(x.at(-1)!,unit,6)}。V(${signals.outputNode}) 的采样范围为 ${formatSI(output.min,'V',6)} 至 ${formatSI(output.max,'V',6)}，峰峰值 ${formatSI(output.max-output.min,'V',6)}，末次采样 ${formatSI(result.vout.at(-1)!,'V',6)}。`)
    if(analysis==='tran'){
      const stats=timeStatistics(x,result.vout)
      if(stats)observations.push(`整个实际时间窗口内，输出时间加权平均值 ${formatSI(stats.mean,'V',6)}、RMS ${formatSI(stats.rms,'V',6)}。按相邻采样点线性插值积分，包含启动过程；这些数值不等同于稳态纹波。`)
      limitations.push('末次采样不等于已稳定；未自动假设周期、上升时间、过冲或稳态窗口。时域统计采用实际自适应时间网格。')
    }else limitations.push('DC 扫描为各偏置点的静态解；不反映动态迟滞、启动时间或器件开关瞬态。')
    charts.push(reportChart('输入与参考输出',x,[{name:`V(${signals.inputNode})`,unit:'V',values:result.vin,signal:'input'},{name:`V(${signals.outputNode})`,unit:'V',values:result.vout,signal:'output'}],unit),reportChart('参考源支路电流',x,[{name:`I(${signals.sourceId})`,unit:'A',values:result.current,signal:'sourceCurrent'}],unit))
  }
  for(const probe of result.project.probes??[]){
    const trace=resolveMeasurement(result,probe)
    if(!trace){limitations.push(`${probe.id}：该运行无可用探针数据${analysis==='noise'?'（噪声分析不提供普通波形探针）':''}，未生成测量或曲线。`);continue}
    const unit=trace.kind==='current'?'A':'V'
    if(analysis==='ac'){
      const values=trace.magnitude!,phase=trace.phase!,peak=extrema(values)
      observations.push(`${probe.id} · ${trace.name}：幅值峰值 ${display(peak.max,`dB re 1 ${unit}`)}，位于 ${formatSI(x[peak.maxIndex],'Hz',6)}；幅值以 1 ${unit} 为参考，区别于输出/输入传递增益。`)
      charts.push(reportChart(`${probe.id} · ${trace.name} 幅值`,x,[{name:trace.name,unit:`dB re 1 ${unit}`,values,signal:`probe:${probe.id}`}],'Hz',true),reportChart(`${probe.id} · ${trace.name} 相位`,x,[{name:trace.name,unit:'°',values:phase,signal:`probe:${probe.id}`}],'Hz',true))
    }else{
      const e=extrema(trace.values)
      observations.push(`${probe.id} · ${trace.name}：${analysis==='op'?`工作点 ${formatSI(trace.values[0],unit,6)}`:`采样最小值 ${formatSI(e.min,unit,6)}、最大值 ${formatSI(e.max,unit,6)}、末次采样 ${formatSI(trace.values.at(-1)!,unit,6)}`}。`)
      if(analysis!=='op')charts.push(reportChart(`${probe.id} · ${trace.name}`,x,[{name:trace.name,unit,values:trace.values,signal:`probe:${probe.id}`}],analysis==='tran'?'s':'V'))
    }
  }
  if(result.warnings.length)limitations.push(`本次求解器返回 ${result.warnings.length} 条警告，需结合下面完整警告确认结果可用性。`)
  return {observations,charts,limitations}
}

export function validReportSamples(result:Result):boolean {
  if(!Number.isFinite(result.elapsed)||result.elapsed<0||result.analysis!==result.project.analysis||!finite(result.x,result.points))return false
  if(result.analysis==='op')return result.points===1&&[result.vin,result.vout,result.current].every(values=>finite(values,result.points))
  const decreasing=result.analysis==='dc'&&result.x[0]>result.x.at(-1)!
  if(result.x.some((v,i)=>i>0&&(decreasing?v>=result.x[i-1]:v<=result.x[i-1])||['ac','noise'].includes(result.analysis)&&v<=0))return false
  if(result.analysis==='noise')return !!result.noise&&['V','A'].includes(result.noise.inputUnit)&&[result.noise.input,result.noise.output].every(values=>finite(values,result.points)&&values.every(v=>v>=0))&&[result.noise.totalInput,result.noise.totalOutput].every(v=>v===undefined||Number.isFinite(v)&&v>=0)
  return [result.vin,result.vout,result.current,...(result.analysis==='ac'?[result.magnitude,result.phase]:[])].every(values=>finite(values,result.points))
}
