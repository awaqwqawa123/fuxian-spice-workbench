import { formatSI, type Project } from './circuit'
import { layoutElectricallyEquivalent } from './layout-electrical-equivalence'
import type { Result } from './results'
import { applySimulationProfile, simulationReferenceWarning, type SimulationProfile } from './simulation-profiles'
import { buildTestReport, type CircuitTestReport } from './test-report'
import { analyzeRun, describeCircuit, reportChart, reportEscape, type CircuitDescription, type ReportChart } from './design-report-analysis'
import { reportDocx, type ReportBlock } from './report-docx'
import { defaultReportConfiguration, parseReportConfiguration, reportMetricNames, type ReportConfiguration, type ReportDetails } from './report-settings'
import { evaluateReportMetrics, resolveReportSignal, type ReportMeasurement, type CriterionEvaluation } from './report-metrics'
import { reportArchive } from './report-archive'
import { expandProjectSweep } from './simulation-experiment'
export type { ReportDetails } from './report-settings'

export interface TestCoverage { profile:SimulationProfile; result:Result|null; status:'complete'|'missing'|'outdated'|'invalid' }
export interface FinalTestReport {
  title:string; generatedAt:number; details:ReportDetails; circuit:CircuitDescription
  runs:{profileId:string;sourceProfileId:string;profileName:string;report:CircuitTestReport;circuit:Pick<CircuitDescription,'components'|'principle'|'functionalBlocks'|'calculations'>;observations:string[];charts:ReportChart[];limitations:string[];testPurpose:string;conditions:string;measurementWindow:string}[]
  config:ReportConfiguration; metrics:ReportMeasurement[]; criteria:CriterionEvaluation[]
  coverageSummary:{planned:number;covered:number;notApplicable:number;complete:boolean;items:{id:string;name:string;profileIds:string[];status:'已覆盖'|'待验证'|'不适用';reason:string}[]}
  conclusion:'未判定'|'所测指标满足'|'存在不满足指标'|'部分指标无法评价'; summary:string; recommendations:string[]
}
const probeEvidence=(project:Project)=>JSON.stringify((project.probes??[]).map(probe=>probe.kind==='current'
  ?{id:probe.id,kind:probe.kind,device:probe.device,wire:probe.wire}
  :{id:probe.id,kind:probe.kind,positive:probe.positive,negative:probe.negative}).sort((a,b)=>a.id.localeCompare(b.id)))

/** One fresh run for every profile; layout-only edits retain their electrical evidence. */
export function testCoverage(project:Project,profiles:readonly SimulationProfile[],results:Readonly<Record<string,Result>>):TestCoverage[]{
  return profiles.map(profile=>{
    const result=results[profile.id]??null
    if(!result)return{profile,result,status:'missing'}
    if(simulationReferenceWarning(project,profile))return{profile,result,status:'invalid'}
    try{if(!layoutElectricallyEquivalent(result.experiment??result.project,applySimulationProfile(project,profile))||probeEvidence(result.project)!==probeEvidence(project))return{profile,result,status:'outdated'}}catch{return{profile,result,status:'outdated'}}
    try{
      if(result.experiment?.sweep){
        const expected=expandProjectSweep(result.experiment)
        if(!result.sweepResults||result.sweepResults.length!==expected.length||expected.some((run,index)=>!layoutElectricallyEquivalent(run.project,result.sweepResults![index].project)||probeEvidence(run.project)!==probeEvidence(result.sweepResults![index].project)))return{profile,result,status:'invalid'}
      }
      for(const leaf of result.sweepResults??[result])buildTestReport(leaf)
    }catch{return{profile,result,status:'invalid'}}
    return{profile,result,status:'complete'}
  })
}

export function buildFinalTestReport(project:Project,coverage:readonly TestCoverage[],generatedAt=Date.now(),details:ReportDetails={}):FinalTestReport{
  if(!coverage.length||coverage.some(item=>item.status!=='complete'||!item.result)||testCoverage(project,coverage.map(item=>item.profile),Object.fromEntries(coverage.map(item=>[item.profile.id,item.result!]))).some(item=>item.status!=='complete'))
    throw new Error('所有当前仿真配置必须完成有效运行，才能生成最终测试报告')
  const config=parseReportConfiguration((project as Project&{report?:ReportConfiguration}).report??defaultReportConfiguration())
  config.details={...config.details,...details}
  // Validate legacy detail overrides too; every export follows the same persisted-input rules.
  parseReportConfiguration(config)
  const expanded=coverage.flatMap(item=>(item.result!.sweepResults??[item.result!]).map((result,index)=>({profile:{...item.profile,id:item.result!.sweepResults?`${item.profile.id}::sweep:${index+1}`:item.profile.id,name:`${item.profile.name}${result.sweepLabel?` · ${result.sweepLabel}`:''}`},result,status:item.status,sourceProfileId:item.profile.id})))
  // Apply a profile's rules independently to every actual sweep run. Never certify a sweep from only its first result.
  const expandedConfig={...config,tests:expanded.flatMap(item=>{const test=config.tests.find(test=>test.profileId===item.sourceProfileId);return test?[{...test,profileId:item.profile.id}]:[]}),criteria:config.criteria.flatMap(criterion=>{const bound=expanded.filter(item=>item.sourceProfileId===criterion.profileId);return bound.length?bound.map(item=>({...criterion,id:item.profile.id===item.sourceProfileId?criterion.id:`${criterion.id}::${item.profile.id}`,profileId:item.profile.id})):[criterion]})}
  const evaluated=evaluateReportMetrics(expanded,expandedConfig)
  const runs=expanded.map(item=>{
    const test=config.tests.find(test=>test.profileId===item.sourceProfileId),result=item.result,unit=result.analysis==='tran'?'s':result.analysis==='dc'?'V':result.analysis==='op'?'':'Hz'
    const analyzed=analyzeRun(result),metrics=evaluated.measurements.filter(metric=>metric.profileId===item.profile.id)
    const circuit=describeCircuit(result.project)
    return{profileId:item.profile.id,sourceProfileId:item.sourceProfileId,profileName:item.profile.name,circuit:{components:circuit.components,principle:circuit.principle,functionalBlocks:circuit.functionalBlocks,calculations:circuit.calculations},report:buildTestReport(result),...analyzed,charts:[...analyzed.charts.map(chart=>markWindow(chart,result,test?.window)),...(test?.window||test?.step||config.criteria.some(criterion=>criterion.profileId===item.sourceProfileId)?measuredCharts(result,metrics):[])],
      testPurpose:test?.purpose||'未填写；请说明本项运行验证的设计目标。',conditions:test?.conditions||'未填写；实际电源、激励与电气参数以运行网表为准。',
      measurementWindow:test?.window?`${formatSI(test.window.start,unit,6)} 至 ${formatSI(test.window.end,unit,6)}${test.window.steady?'（用户指定稳态窗口；稳态性质仍需核查）':''}`:`完整采样区间 ${formatSI(result.x[0],unit,6)} 至 ${formatSI(result.x.at(-1)!,unit,6)}${result.analysis==='tran'?'（包含启动；未指定稳态窗口）':''}`}
  })
  const freshIds=new Set(coverage.filter(item=>item.status==='complete').map(item=>item.profile.id))
  const items=config.coverage.map(item=>{
    const validProfiles=item.profiles.length>0&&item.profiles.every(id=>freshIds.has(id)),notApplicable=item.status==='not-applicable'&&!!item.reason?.trim()
    const status=notApplicable?'不适用':item.status==='covered'&&validProfiles?'已覆盖':'待验证'
    const reason=notApplicable?item.reason!:item.status==='covered'&&!validProfiles?'覆盖声明没有绑定有效的当前仿真配置。':item.status==='not-applicable'?'不适用声明缺少理由。':item.reason||'用户规划的验证要求；工况含义需结合实际网表审核。'
    return{id:item.id,name:item.name,profileIds:item.profiles,status:status as '已覆盖'|'待验证'|'不适用',reason}
  })
  const coverageSummary={planned:items.length,covered:items.filter(item=>item.status==='已覆盖').length,notApplicable:items.filter(item=>item.status==='不适用').length,complete:items.length>0&&items.every(item=>item.status!=='待验证'),items}
  const warnings=runs.reduce((sum,run)=>sum+run.report.warnings.length,0),analyses=new Set(coverage.map(item=>item.result!.analysis))
  const recommendations=[
    ...(config.criteria.length?[]:['将各项测量值与设计要求逐项对照，补充明确的数值阈值、容差及验收方法。当前未设置验收标准，验收结论为未判定。']),
    '依据器件数据手册核对额定电压、电流、功耗及安全工作区；仿真模型不能代替额定值与热设计核算。',
    '补充电源、负载、温度、器件容差等边界条件测试，并进行样机或实物验证。',
  ]
  if(!analyses.has('tran'))recommendations.push('当前没有瞬态测试，建议按设计目标补充启动、阶跃、纹波及大信号响应验证。')
  if(!analyses.has('ac'))recommendations.push('当前没有 AC 测试，若设计涉及滤波或放大，建议补充频率响应。稳定性评价还需正确的环路测量方法。')
  if(warnings)recommendations.unshift('优先核查所有求解器警告，再确定哪些测量结果可用于设计结论。')
  if(!coverageSummary.complete)recommendations.push(items.length?'完成测试覆盖表中的待验证要求，核查用户工况声明与实际激励、负载及模型相符。':'尚未规划测试覆盖要求；建议分别列出电源、负载、温度和器件容差边界，并绑定对应测试配置。')
  return{title:project.title,generatedAt,details:{...config.details},config,circuit:describeCircuit(project),runs,metrics:evaluated.measurements,criteria:evaluated.criteria,coverageSummary,conclusion:evaluated.conclusion,
    summary:`本报告覆盖 ${runs.length} 项当前配置的有效仿真运行，共 ${runs.reduce((sum,run)=>sum+run.report.points,0)} 个采样点，求解器警告 ${warnings} 条。指标结论：${evaluated.conclusion}；${config.criteria.length?`已设置 ${config.criteria.length} 项数值验收规则。`:'未设置验收标准，不能据此断言设计指标全部满足。'}验证覆盖：${coverageSummary.complete?'用户规划条目已覆盖或注明不适用；工况完整性仍需评审。':items.length?'存在待验证条目。':'尚未规划。'}`,recommendations}
}
const date=(time:number)=>new Date(time).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false})
const h=(text:string,level:1|2|3=2):ReportBlock=>({kind:'heading',text,level})
const p=(text:string):ReportBlock=>({kind:'paragraph',text})
const table=(headers:string[],rows:string[][]):ReportBlock=>({kind:'table',headers,rows})
const metricDisplay=(value:number,unit:string)=>unit.startsWith('dB')||['°','%',''].includes(unit)?`${Number(value.toPrecision(6))}${unit?' '+unit:''}`:formatSI(value,unit,6)

function measuredCharts(result:Result,metrics:ReportMeasurement[]):ReportChart[]{
  const groups=new Map<string,ReportMeasurement[]>()
  for(const metric of metrics){if(!metric.markers?.length)continue;const key=JSON.stringify([metric.signal,metric.window]);const group=groups.get(key)??[];group.push(metric);groups.set(key,group)}
  return [...groups.values()].flatMap(group=>{
    const metric=group[0],trace=resolveReportSignal(result,metric.signal)
    if(!trace)return[]
    const start=metric.window?.start??result.x[0],end=metric.window?.end??result.x.at(-1)!,log=result.analysis==='ac'||result.analysis==='noise',unit=result.analysis==='tran'?'s':result.analysis==='dc'?'V':'Hz'
    if(end<=start||start<result.x[0]||end>result.x.at(-1)!)return[]
    const tx=(n:number)=>log?Math.log10(n):n
    const measurementAxis=(n:number)=>result.analysis==='ac'?Math.log10(n):n
    const interpolate=(at:number)=>{let left=0,right=result.x.length-1;while(right-left>1){const mid=Math.floor((left+right)/2);if(result.x[mid]>at)right=mid;else left=mid}const fraction=(measurementAxis(at)-measurementAxis(result.x[left]))/(measurementAxis(result.x[right])-measurementAxis(result.x[left]));return trace.values[left]+fraction*(trace.values[right]-trace.values[left])}
    const x=[start,...result.x.filter(at=>at>start&&at<end),end],values=x.map(interpolate)
    const chart=reportChart(`${metric.signal} · 测量点与窗口局部图`,x,[{name:metric.signal,unit:trace.unit,values}],unit,log)
    const x0=tx(x[0]),x1=tx(x.at(-1)!)
    let low=Infinity,high=-Infinity;for(const value of values){low=Math.min(low,value);high=Math.max(high,value)}
    const padding=high===low?Math.max(Math.abs(high)*.05,1e-12):(high-low)*.07;low-=padding;high+=padding
    const px=(n:number)=>90+(tx(n)-x0)/(x1-x0||1)*706,py=(n:number)=>38+(high-n)/(high-low)*207
    const markers=new Map<string,{x:number;y:number;labels:string[]}>()
    for(const marker of group.flatMap(item=>item.markers??[]).filter(marker=>marker.x>=x[0]&&marker.x<=x.at(-1)!&&Number.isFinite(marker.y))){const key=`${px(marker.x).toFixed(2)},${py(marker.y).toFixed(2)}`,previous=markers.get(key);if(previous){if(!previous.labels.includes(marker.label))previous.labels.push(marker.label)}else markers.set(key,{x:marker.x,y:marker.y,labels:[marker.label]})}
    const occupied:{x:number;y:number;width:number}[]=[]
    const annotations=[...markers.values()].map(marker=>{
      const label=marker.labels.join(' / '),width=Math.min(270,label.length*11),left=Math.max(95,Math.min(790-width,px(marker.x)+7))
      const positions=[-8,-25,20,37,-42,54].map(offset=>Math.max(52,Math.min(230,py(marker.y)+offset)))
      const top=positions.find(y=>!occupied.some(box=>Math.abs(y-box.y)<14&&left<box.x+box.width+8&&left+width+8>box.x))??positions[0]
      occupied.push({x:left,y:top,width})
      return `<circle cx="${px(marker.x).toFixed(2)}" cy="${py(marker.y).toFixed(2)}" r="4" fill="#bd652d"/><text x="${left.toFixed(2)}" y="${top.toFixed(2)}" fill="#8f4c22">${reportEscape(label)}</text>`
    }).join('')
    chart.svg=chart.svg.replace('</g>',annotations+'</g>')
    chart.caption=chart.caption.replace(`${x.length} 个实际采样点`,`${x.length} 个绘图点（窗口内部真实采样及插值边界）`)+` 测量标记依据：${group.map(item=>`${reportMetricNames[item.metric]}（${item.method}）`).join('；')}。局部图边界按${result.analysis==='ac'?'log10 频率':'实际横轴'}线性插值，数值依据见测量表。`
    return[chart]
  })
}

function markWindow(chart:ReportChart,result:Result,window:ReportConfiguration['tests'][number]['window']):ReportChart{
  if(!window||result.analysis==='op')return chart
  if(window.start<result.x[0]||window.end>result.x.at(-1)!)return{...chart,caption:chart.caption+' 用户所选窗口超出实际数据区间，未绘制有效窗口遮罩；对应指标不能据此验收。'}
  const start=window.start,end=window.end
  if(end<=start)return chart
  const log=result.analysis==='ac'||result.analysis==='noise',tx=(n:number)=>log?Math.log10(n):n,a=tx(result.x[0]),b=tx(result.x.at(-1)!),px=(n:number)=>90+(tx(n)-a)/(b-a||1)*706
  const svg=chart.svg.replace('<path ',`<rect x="${px(start).toFixed(2)}" y="38" width="${(px(end)-px(start)).toFixed(2)}" height="207" fill="#dce6bb" opacity=".35"/><text x="${px(start)+5}" y="52" fill="#617427">测量窗口</text><path `)
  return{...chart,svg}
}

/** All formats share the same evidence and user-authored notes. */
export function finalTestReportBlocks(report:FinalTestReport):ReportBlock[]{
  const {details,circuit,config}=report
  let figure=0,tableNumber=0
  const numberedTable=(title:string,headers:string[],rows:string[][]):ReportBlock[]=>[p(`表 ${++tableNumber} · ${title}`),table(headers,rows)]
  const numberedFigure=(title:string,svg:string):ReportBlock=>({kind:'image',title:`图 ${++figure} · ${title}`,svg})
  const metricValue=(item:ReportMeasurement|null|undefined)=>!item||item.value===null?'无法评价':metricDisplay(item.value,item.unit)
  const window=(item:ReportMeasurement)=>item.window?`${item.window.start}–${item.window.end}（横轴单位见对应测试）`:'单点 / 见计算依据'
  const evidence=(item:ReportMeasurement)=>`测试 ${report.runs.findIndex(run=>run.profileId===item.profileId)+1}；${item.evidence}`
  const enhanced=circuit as CircuitDescription&{functionalBlocks?:{name:string;devices:string[];description:string;evidence:string}[];calculations?:{name:string;formula:string;value:number;unit:string;assumptions:string;evidence:string}[];designNotes?:string[]}
  const blocks:ReportBlock[]=[h(`${report.title} · 电路设计与仿真验证报告`,1),p('技术文档 · 基于当前电气等价电路与实际运行证据'),
    ...numberedTable('文档控制',['文档信息','内容'],[['文档编号',details.documentId||'未填写'],['报告版本',details.revision||'未填写'],['工程版本',details.projectRevision||'未填写'],['编写',details.author||'未填写'],['审核',details.reviewer||'未填写（待审核）'],['生成时间',`${date(report.generatedAt)}（UTC+8）`],['数据来源',[...new Set(report.runs.map(run=>run.report.engine))].join('；')]]),
    h('1. 摘要与测试总览'),p(report.summary),
    ...numberedTable('当前测试运行',['测试编号 / 配置','分析类型','运行时间（UTC+8）','采样点'],report.runs.map((run,index)=>[`测试 ${index+1} · ${run.profileName}`,run.report.analysis,date(run.report.timestamp),String(run.report.points)])),
    h('2. 设计目标与要求'),p(details.purpose?`设计目的（用户填写）：${details.purpose}`:'设计目的：未填写，请结合应用场景补充。'),p(details.requirements?`设计要求（用户说明；自动验收以第 6 节数值规则为准）：${details.requirements}`:'设计要求说明：未填写；数值验收规则见第 6 节。'),
    h('3. 电路介绍与工作原理'),p(circuit.introduction),p(circuit.signalPath),p(circuit.principle),
  ]
  if(details.principle)blocks.push(p(`原理说明（用户填写）：${details.principle}`))
  blocks.push(numberedFigure('电路原理图',circuit.schematic),p('图 1 展示生成时的电路布局；纯布局修改允许复用电气等价的运行。各项结果的确切电路、源参数及端口顺序以对应实际运行网表为准。'),
    h('3.1 器件参数与电气连接',3),...numberedTable('器件与电气连接',['位号','类型','参数 / 模型 / 激励','端口连接','器件说明'],circuit.components.map(item=>[item.id,item.type,item.value,item.connections,item.role])),
    h('3.2 模型来源与假设',3))
  if(circuit.models.length)blocks.push(...numberedTable('模型来源',['模型','来源','模型说明'],circuit.models.map(item=>[item.name,item.source,item.detail])))
  else blocks.push(p('本电路使用理想基本元件；具体参数和行为元件定义见实际运行网表。'))
  blocks.push(p('网表中的温度、初始条件和求解器选项仅以实际指令为准。未显式给出时使用该求解器的默认设置；仅包含下方已列出的实际测试；未列出的温度、器件容差或蒙特卡洛条件未被验证。寄生、非线性和热效应仅在所用模型包含时体现。'))
  if(enhanced.functionalBlocks?.length)blocks.push(h('3.3 功能模块与设计依据',3),...numberedTable('功能模块（依据连接与模型）',['模块','关联器件','作用','依据'],enhanced.functionalBlocks.map(item=>[item.name,item.devices.join('、'),item.description,item.evidence])))
  blocks.push(h('3.4 理论计算与适用假设',3))
  if(enhanced.calculations?.length)blocks.push(...numberedTable('理论指标',['指标','公式','理论值','假设','证据'],enhanced.calculations.map(item=>[item.name,item.formula,formatSI(item.value,item.unit,6),item.assumptions,item.evidence])))
  else blocks.push(p('该拓扑暂无自动核实的理论计算。请补充带器件位号、计算公式及适用假设的设计说明。'))
  blocks.push(...(enhanced.designNotes??[]).map(p),h('4. 测试方法与可复现条件'),p('每项测试使用对应实际运行网表和原始采样。用户工况描述属于设计说明，需要审核它与真实激励、负载和模型是否一致。窗口、阶跃目标、参考频率属于后处理测量输入，不改变仿真电路。'),
    ...numberedTable('测试计划与测量区间',['测试编号 / 配置','测试目的（用户说明）','工况（用户说明）','测量区间'],report.runs.map((run,index)=>[`测试 ${index+1} · ${run.profileName}`,run.testPurpose,run.conditions,run.measurementWindow])),h('5. 仿真结果与专业指标'))
  for(const [index,run] of report.runs.entries()){
    const directives=run.report.netlist.split(/\r?\n/).filter(line=>/^\s*\.(temp|ic|nodeset|options?)\b/i.test(line))
    const test=config.tests.find(test=>test.profileId===run.sourceProfileId),metrics=report.metrics.filter(item=>item.profileId===run.profileId)
    const contacts=run.circuit.components.filter(item=>/^SW[1-9]\d*$/.test(item.id))
    if(contacts.length)blocks.push(...numberedTable(`测试 ${index+1} 实际触点状态`,['触点','状态 / 参数'],contacts.map(item=>[item.id,item.value])))
    if(run.sourceProfileId!==run.profileId)blocks.push(h(`扫描工况 · ${run.profileName}`,3),p(run.circuit.principle),...numberedTable('该扫描点实际器件参数',['位号','参数 / 激励','端口'],run.circuit.components.map(item=>[item.id,item.value,item.connections])))
    blocks.push(h(`5.${index+1} 测试 ${index+1} · ${run.profileName} · ${run.report.analysis}`,3),p(`测试目的：${run.testPurpose}`),p(`工况（用户说明）：${run.conditions}`),
      ...numberedTable(`测试 ${index+1} 运行条件`,['项目','内容'],[['运行 ID',run.report.runId],['运行时间',`${date(run.report.timestamp)}（UTC+8）`],['求解器',run.report.engine],['采样点',String(run.report.points)],['计算耗时',`${(run.report.elapsedMs/1000).toFixed(3)} s`],...run.report.settings.map(item=>[item.name,item.value]),['温度 / 初始条件 / 求解器选项',directives.length?directives.join('\n'):'网表没有显式 .temp / .ic / .nodeset / .options 指令；使用该求解器默认设置。'],['测量窗口',run.measurementWindow],...(test?.step?[['阶跃测量定义（用户输入）',`起点 ${test.step.start} s；初值 ${test.step.initial}；目标 ${test.step.target}；误差带 ±${test.step.bandPercent}%；保持时间 ${test.step.holdTime} s`]]:[]),...(test?.acReferenceHz?[['AC 参考频率（用户输入）',`${test.acReferenceHz} Hz`]]:[])]),
      h('原始运行测量',3),...numberedTable(`测试 ${index+1} 基础测量`,['测量项目','测量值','计算依据'],run.report.measurements.map(item=>[item.name,item.value,item.source])),h('专业指标与测量依据',3))
    if(metrics.length)blocks.push(...numberedTable(`测试 ${index+1} 专业指标`,['指标 / 测量对象','测量值','取值区间','方法与限制','证据'],metrics.map(item=>[`${reportMetricNames[item.metric]} · ${item.signal}`,metricValue(item),window(item),[item.method,item.reason].filter(Boolean).join('；'),evidence(item)])))
    else blocks.push(p('本项测试没有可用的专业派生指标。'))
    blocks.push(h('仿真结果分析',3),...run.observations.map(p))
    for(const chart of run.charts){const current=figure+1;blocks.push(numberedFigure(`测试 ${index+1} · ${run.profileName} · ${chart.title}`,chart.svg),p(`见图 ${current}。${chart.caption} 工况说明：${run.conditions}；测量窗口：${run.measurementWindow}。`))}
    const markers=metrics.flatMap(item=>{const chart=run.charts.find(chart=>chart.signals?.includes(item.signal));return(item.markers??[]).map(marker=>[reportMetricNames[item.metric],item.signal,metricDisplay(marker.x,chart?.xUnit??''),Math.abs(marker.y)>0&&Math.abs(marker.y)<1e-12?`${marker.y.toExponential(5)} ${chart?.yUnit??''}`:metricDisplay(marker.y,chart?.yUnit??''),marker.label])})
    if(markers.length)blocks.push(...numberedTable(`测试 ${index+1} 关键测量点标注`,['关联指标','信号','横坐标（单位见图）','纵坐标','含义'],markers))
    const evaluations=report.criteria.filter(item=>item.criterion.profileId===run.profileId)
    blocks.push(p(`指标判定：${evaluations.length?evaluations.map(item=>`${item.criterion.name}：${item.status}（第 6 节验收表）`).join('；'):'本项没有数值验收规则，未判定。'}`))
    if(test?.notes)blocks.push(p(`测试补充说明（用户填写）：${test.notes}`))
    blocks.push(h('适用范围与结果限制',3),...run.limitations.map(p),h('求解器警告',3),p(run.report.warnings.length?run.report.warnings.join('\n'):'无'))
  }
  blocks.push(h(`5.${report.runs.length+1} 多工况对比`,3),p('对比仅汇集相同信号、单位、指标定义和取值区间的测量；不同窗口的数据不直接合并。对应工况由测试编号、运行网表及用户说明核查。'))
  const comparisons=new Map<string,ReportMeasurement[]>()
  for(const metric of report.metrics){if(metric.value===null)continue;const key=JSON.stringify([metric.signal,metric.metric,metric.unit,metric.method,metric.window]);const group=comparisons.get(key)??[];group.push(metric);comparisons.set(key,group)}
  const compareRows=[...comparisons.values()].filter(group=>new Set(group.map(item=>item.profileId)).size>1).flatMap(group=>group.map(item=>[report.runs.find(run=>run.profileId===item.profileId)?.profileName??item.profileId,item.signal,reportMetricNames[item.metric],metricValue(item),window(item),evidence(item)]))
  if(compareRows.length)blocks.push(...numberedTable('同定义多工况指标',['配置','测量对象','指标','测量值','窗口','证据'],compareRows))
  else blocks.push(p('当前没有同信号、同定义且同区间的多配置指标可直接对比。'))
  {
    const rows=report.metrics.filter(item=>item.value!==null&&item.signal==='output'&&['cutoffHigh','cutoffLow'].includes(item.metric)).flatMap(item=>{
      const run=report.runs.find(run=>run.profileId===item.profileId),circuit=run?.circuit
      const cutoffTheory=circuit?.calculations.find(item=>item.unit==='Hz'&&item.name.includes('截止频率'))
      const lowpass=circuit?.functionalBlocks.some(item=>item.name==='一阶低通网络'||item.name==='带负载一阶低通网络'),highpass=circuit?.functionalBlocks.some(item=>item.name==='一阶高通网络')
      const fRef=config.tests.find(test=>test.profileId===run?.sourceProfileId)?.acReferenceHz
      if(!fRef||!cutoffTheory||cutoffTheory.value<=0||!(lowpass&&item.metric==='cutoffHigh'||highpass&&item.metric==='cutoffLow'))return[]
      const k=10**(3/10),fc=cutoffTheory.value,theory=lowpass?fc*Math.sqrt(k*(1+(fRef/fc)**2)-1):fRef/Math.sqrt(k+(k-1)*(fRef/fc)**2)
      const formula=lowpass?'fc × √[10^(3/10) × (1+(fref/fc)²) − 1]':'fref / √[10^(3/10) + (10^(3/10)−1) × (fref/fc)²]'
      return[[report.runs.find(run=>run.profileId===item.profileId)?.profileName??item.profileId,reportMetricNames[item.metric],formatSI(theory,'Hz',6),metricValue(item),`${Number(((item.value!-theory)/theory*100).toPrecision(5))}%`,`fref=${fRef} Hz；同定义理论公式：${formula}；${cutoffTheory.assumptions}；${evidence(item)}`]]
    })
    if(rows.length)blocks.push(h(`5.${report.runs.length+2} 理论与仿真对照`,3),p('以指定参考频率处增益下降 3.000 dB 为同一测量定义，使用已识别完整 RC 拓扑推导理论值。该值区别于极点频率处的 −3.0103 dB；偏差可能来自有限频段、采样插值及模型差异。'),...numberedTable('同定义截止频率理论对照',['配置','测量定义','理论值','仿真值','相对偏差','假设与证据'],rows))
  }
  blocks.push(h('6. 指标验收与测试覆盖'),p(`数值验收结论：${report.conclusion}。指标是否满足与验证覆盖完整性分别评价。`))
  if(report.criteria.length)blocks.push(...numberedTable('设计指标验收',['设计指标 / 测试','要求（数值按基本单位）','仿真结果','数值偏差','判定','证据 / 限制'],report.criteria.map(item=>[`${item.criterion.name} · ${report.runs.find(run=>run.profileId===item.criterion.profileId)?.profileName??item.criterion.profileId}`,`${item.limit}${item.measurement?.unit?`；单位：${item.measurement.unit}`:''}`,metricValue(item.measurement),item.deviation===null?'—':metricDisplay(item.deviation,item.measurement?.unit??''),item.status,item.measurement?[evidence(item.measurement),item.measurement.reason].filter(Boolean).join('；'):'没有可用测量数据'])),p('数值偏差为测量值减目标值；仅设上下限时，超限显示相对最近限制的偏差，未超限显示 0。所有容差为绝对数值，百分比指标仍按 % 单位填写。'))
  else blocks.push(p('未设置验收标准；文字设计要求不自动成为数值规则。'))
  if(report.coverageSummary.items.length)blocks.push(...numberedTable('用户规划的测试覆盖',['验证边界','绑定配置','状态','依据 / 限制'],report.coverageSummary.items.map(item=>[item.name,item.profileIds.map(id=>report.runs.filter(run=>run.sourceProfileId===id).map(run=>run.profileName).join('、')||`${id}（无有效当前运行）`).join('；')||'未绑定',item.status,item.reason])))
  else blocks.push(p('测试覆盖要求尚未规划。当前运行完成不代表电源、负载、温度、容差等边界验证完整。'))
  blocks.push(p(`验证覆盖状态：${report.coverageSummary.complete?'用户规划条目已覆盖或注明不适用，仍需审核规划是否完整。':'未完成完整覆盖评价。'}覆盖表是用户声明与有效运行的关联，不自动证明温度或容差扫描已经执行。`),h('7. 综合结论与后续验证'),p(report.summary),...report.recommendations.map(p))
  if(details.notes)blocks.push(h('设计结论备注（用户填写）',3),p(details.notes))
  if(config.revisions.length)blocks.push(h('附录 A · 最近导出记录'),p('以下是最近导出的索引记录，不包含历史工程与报告内容快照。'),...numberedTable('最近导出记录',['报告版本','导出时间（UTC+8）','格式','当时结论','运行 ID'],config.revisions.map(item=>[item.revision,date(item.generatedAt),item.format,item.conclusion,item.runIds.join('；')])))
  blocks.push(h('附录 B · 实际运行网表与日志'))
  for(const run of report.runs)blocks.push(h(run.profileName,3),p(`运行 ID：${run.report.runId}`),p(`结果配置标识\n${run.report.resultKey}`),p(`网表\n${run.report.netlist}`),p(`运行日志\n${run.report.log||'（空）'}`))
  return blocks
}

export function finalTestReportHtml(report:FinalTestReport):string{
  const blocks=finalTestReportBlocks(report)
  const toc=blocks.flatMap((block,index)=>block.kind==='heading'&&block.level===2?[`<li><a href="#section-${index}">${reportEscape(block.text)}</a></li>`]:[]).join('')
  let addedToc=false
  const contents=blocks.map((block,index)=>{
    if(block.kind==='heading'){
      const nav=block.level===2&&!addedToc?`<nav aria-label="报告目录"><strong>目录</strong><ol>${toc}</ol></nav>`:''
      if(nav)addedToc=true
      return `${nav}<h${block.level} id="section-${index}">${reportEscape(block.text)}</h${block.level}>`
    }
    if(block.kind==='paragraph')return /^(网表|运行日志|结果配置标识)\n/.test(block.text)?`<pre>${reportEscape(block.text)}</pre>`:`<p>${reportEscape(block.text).replace(/\n/g,'<br>')}</p>`
    if(block.kind==='image')return `<figure>${block.svg}<figcaption>${reportEscape(block.title)}</figcaption></figure>`
    return `<div class="table-wrap"><table><thead><tr>${block.headers.map(item=>`<th scope="col">${reportEscape(item)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(items=>`<tr>${items.map(item=>`<td>${reportEscape(item).replace(/\n/g,'<br>')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  }).join('\n')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${reportEscape(report.title)} · 电路设计与仿真验证报告</title><style>
  :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#eef3ef;color:#263b30;font:14px/1.8 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1050px;margin:auto;background:white;padding:48px 55px;box-shadow:0 8px 40px #243b3012}h1{font-size:30px;border-top:6px solid #347b56;padding-top:35px}h2{font-size:21px;margin-top:44px;border-bottom:1px solid #d9e6dc;padding-bottom:8px}h3{font-size:16px;margin-top:28px}p{white-space:normal;overflow-wrap:anywhere}nav{padding:18px 25px;background:#f4f8f4}nav ol{margin:4px 0}a{color:#286c4a}figure{margin:25px 0;break-inside:avoid}figure svg{display:block;width:100%;height:auto;max-height:720px;border:1px solid #e2e9e3}figcaption{text-align:center;color:#6e8072;font-size:12px}table{border-collapse:collapse;table-layout:fixed;width:100%;font-size:12px}th,td{padding:10px;border-bottom:1px solid #dce7df;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#f1f6f2}tr{break-inside:avoid}.toolbar{position:sticky;top:0;background:#ecf3ed;padding:12px 20px;text-align:center}.toolbar button{border:0;background:#347b56;color:white;padding:10px 20px;border-radius:5px;cursor:pointer}.toolbar span{margin-left:15px;font-size:12px;color:#536d5c}@media(max-width:700px){main{padding:20px}.table-wrap{overflow:auto}table{font-size:11px}}@media print{@page{size:A4;margin:16mm}body{background:white}main{max-width:none;margin:0;padding:0;box-shadow:none}.toolbar{display:none}h2{break-before:page}h1,h2,h3{break-after:avoid}thead{display:table-header-group}table{font-size:10px}th,td{padding:6px}figure svg{max-height:230mm}}
  pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f8f5;padding:15px;font:11px/1.7 Consolas,monospace}nav ol{list-style:none;padding:0}
  @media print{@page{@bottom-center{content:"第 " counter(page) " 页";font:10px "Microsoft YaHei",sans-serif;color:#61746a}}nav{break-before:page;break-after:page}h1{margin-top:35mm}a{color:inherit;text-decoration:none}}
  </style></head><body><div class="toolbar"><button onclick="window.print()">打印 / 保存为 PDF</button><span>可离线打开 · 图表已内嵌</span></div><main>${contents}</main></body></html>`
}
const mdText=(text:string)=>reportEscape(text).replace(/([\\`*_\[\]#])/g,'\\$1')
export function finalTestReportMarkdown(report:FinalTestReport):string{
  const blocks=finalTestReportBlocks(report),toc=blocks.filter((block):block is Extract<ReportBlock,{kind:'heading'}>=>block.kind==='heading'&&block.level===2).map(block=>`- ${mdText(block.text)}`).join('\n')
  let addedToc=false
  return blocks.map(block=>{
    if(block.kind==='heading'){const nav=block.level===2&&!addedToc?`## 目录\n\n${toc}\n\n`:'';if(nav)addedToc=true;return `${nav}${'#'.repeat(block.level)} ${mdText(block.text)}`}
    if(block.kind==='paragraph')return mdText(block.text).replace(/\n/g,'  \n')
    if(block.kind==='image')return `![${mdText(block.title)}](data:image/svg+xml,${encodeURIComponent(block.svg)})\n\n图表已内嵌；查看需要支持 SVG 数据图片的 Markdown 编辑器，或使用 HTML / Word 文档。`
    const cell=(text:string)=>mdText(text).replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>')
    return `| ${block.headers.map(cell).join(' | ')} |\n| ${block.headers.map(()=>'---').join(' | ')} |\n${block.rows.map(items=>`| ${items.map(cell).join(' | ')} |`).join('\n')}`
  }).join('\n\n')+'\n'
}
export function finalTestReportWord(report:FinalTestReport):Uint8Array{return reportDocx({title:report.title,blocks:finalTestReportBlocks(report),toc:true})}
export function finalTestReportArchive(project:Project,profiles:readonly SimulationProfile[],results:Readonly<Record<string,Result>>,report:FinalTestReport):Uint8Array{return reportArchive(project,profiles,results,report,{html:finalTestReportHtml(report),markdown:finalTestReportMarkdown(report)})}

async function svgPng(svg:string):Promise<Uint8Array>{
  const xml=new DOMParser().parseFromString(svg,'image/svg+xml'),root=xml.documentElement
  if(xml.querySelector('parsererror'))throw new Error('报告图表格式无效，请使用 HTML 导出')
  const view=root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if(view?.length===4&&view.every(Number.isFinite)&&view[2]>0&&view[3]>0){root.setAttribute('width',String(view[2]));root.setAttribute('height',String(view[3]))}
  const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)],{type:'image/svg+xml'}))
  try{
    const img=new Image()
    await new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error('报告图表转换失败，请使用 HTML 导出'));img.src=url})
    const canvas=document.createElement('canvas'),scale=Math.min(2,2400/Math.max(img.naturalWidth,img.naturalHeight,1))
    canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale))
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('当前浏览器无法生成 Word 图像，请使用 HTML 导出')
    ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height)
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('报告图像生成失败')),'image/png'))
    return new Uint8Array(await blob.arrayBuffer())
  }finally{URL.revokeObjectURL(url)}
}
export async function finalTestReportWordWithImages(report:FinalTestReport):Promise<Uint8Array>{
  const blocks=finalTestReportBlocks(report)
  for(const block of blocks)if(block.kind==='image')block.png=await svgPng(block.svg)
  return reportDocx({title:report.title,blocks,toc:true})
}
