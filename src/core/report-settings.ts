export interface ReportDetails {
  author?:string; reviewer?:string; documentId?:string; revision?:string; projectRevision?:string
  purpose?:string; principle?:string; requirements?:string; notes?:string
}
export const reportMetricNames={minimum:'最小值',maximum:'最大值',last:'末次采样',mean:'平均值',rms:'RMS',peakToPeak:'峰峰值',riseTime:'上升时间（10–90%）',fallTime:'下降时间（90–10%）',overshoot:'过冲（相对阶跃幅度）',settlingTime:'稳定时间',gainPeak:'峰值增益',phaseAtPeak:'峰值处相位',gainAtReference:'参考频率增益',cutoffLow:'下限截止频率（相对参考增益 −3 dB）',cutoffHigh:'上限截止频率（相对参考增益 −3 dB）',bandwidth:'带宽',noiseTotal:'积分 RMS 噪声',devicePower:'器件功耗',efficiency:'效率',phaseMargin:'相位裕度',gainMargin:'增益裕度'} as const
export type ReportMetric=keyof typeof reportMetricNames
export interface ReportTestSettings {
  profileId:string; purpose?:string; conditions?:string; notes?:string
  window?:{start:number;end:number;steady?:boolean}
  step?:{start:number;initial:number;target:number;bandPercent:number;holdTime:number}
  acReferenceHz?:number
}
export interface ReportCriterion {
  id:string; profileId:string; name:string; signal:string; metric:ReportMetric
  lower?:number; upper?:number; target?:number; tolerance?:number
}
export interface ReportCoverageRequirement {
  id:string; name:string; profiles:string[]; status:'planned'|'covered'|'not-applicable'; reason?:string
}
export interface ReportRevision {
  id:string; revision:string; generatedAt:number; format:string; conclusion:string; runIds:string[]
}
export interface ReportConfiguration {
  version:1; details:ReportDetails; tests:ReportTestSettings[]; criteria:ReportCriterion[]
  coverage:ReportCoverageRequirement[]; revisions:ReportRevision[]
}
export const defaultReportConfiguration=():ReportConfiguration=>({version:1,details:{revision:'1.0'},tests:[],criteria:[],coverage:[],revisions:[]})

/** Validate persisted report inputs without changing electrical simulation parameters. */
export function parseReportConfiguration(input:unknown):ReportConfiguration {
  const object=(value:unknown,path:string):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${path}：需要对象`);return value as Record<string,unknown>}
  const text=(value:unknown,path:string,limit=200,optional=false):string|undefined=>{if(value===undefined&&optional)return undefined;if(typeof value!=='string'||value.length>limit)throw new Error(`${path}：需要不超过 ${limit} 字符的文本`);return value}
  const finite=(value:unknown,path:string):number=>{if(typeof value!=='number'||!Number.isFinite(value))throw new Error(`${path}：需要有限数值`);return value}
  const array=(value:unknown,path:string,limit:number):unknown[]=>{if(!Array.isArray(value)||value.length>limit)throw new Error(`${path}：列表最多 ${limit} 项`);return value}
  const raw=object(input,'project.report');if(raw.version!==1)throw new Error('project.report.version：不支持的报告设置版本')
  const details=object(raw.details,'project.report.details'),cleanDetails:ReportDetails={}
  for(const field of ['author','reviewer','documentId','revision','projectRevision','purpose','principle','requirements','notes'] as const){const value=text(details[field],`report.details.${field}`,['purpose','principle','requirements','notes'].includes(field)?20000:200,true);if(value!==undefined)cleanDetails[field]=value}
  const tests=array(raw.tests,'report.tests',24).map((value,index)=>{
    const item=object(value,`report.tests[${index}]`),clean:ReportTestSettings={profileId:text(item.profileId,'report.test.profileId',100)!}
    for(const field of ['purpose','conditions','notes'] as const){const value=text(item[field],`report.test.${field}`,10000,true);if(value!==undefined)clean[field]=value}
    if(item.window!==undefined){const w=object(item.window,'report.test.window'),start=finite(w.start,'window.start'),end=finite(w.end,'window.end');if(end<=start)throw new Error('report.test.window：终点必须大于起点');if(w.steady!==undefined&&typeof w.steady!=='boolean')throw new Error('window.steady：需要布尔值');clean.window={start,end,...(w.steady!==undefined?{steady:w.steady as boolean}:{})}}
    if(item.step!==undefined){const s=object(item.step,'report.test.step'),start=finite(s.start,'step.start'),initial=finite(s.initial,'step.initial'),target=finite(s.target,'step.target'),bandPercent=finite(s.bandPercent,'step.bandPercent'),holdTime=finite(s.holdTime,'step.holdTime');if(initial===target||bandPercent<=0||bandPercent>=100||holdTime<=0)throw new Error('report.test.step：需要不同初值与目标值、0–100% 容差和正保持时间');clean.step={start,initial,target,bandPercent,holdTime}}
    if(item.acReferenceHz!==undefined){clean.acReferenceHz=finite(item.acReferenceHz,'acReferenceHz');if(clean.acReferenceHz<=0)throw new Error('acReferenceHz：须大于零')}
    return clean
  })
  const criteria=array(raw.criteria,'report.criteria',128).map((value,index)=>{
    const item=object(value,`report.criteria[${index}]`),clean:ReportCriterion={id:text(item.id,'criterion.id',100)!,profileId:text(item.profileId,'criterion.profileId',100)!,name:text(item.name,'criterion.name')!,signal:text(item.signal,'criterion.signal',200)!,metric:text(item.metric,'criterion.metric') as ReportMetric}
    if(!Object.hasOwn(reportMetricNames,clean.metric))throw new Error('criterion.metric：不支持的指标')
    for(const field of ['lower','upper','target','tolerance'] as const)if(item[field]!==undefined)clean[field]=finite(item[field],`criterion.${field}`)
    if(clean.lower!==undefined&&clean.upper!==undefined&&clean.lower>clean.upper)throw new Error('criterion：下限不能大于上限')
    if(clean.tolerance!==undefined&&(clean.tolerance<0||clean.target===undefined))throw new Error('criterion：绝对容差须非负并指定目标值')
    if(clean.lower===undefined&&clean.upper===undefined&&clean.target===undefined)throw new Error('criterion：请指定上下限或目标值')
    return clean
  })
  const coverage=array(raw.coverage,'report.coverage',64).map(value=>{const item=object(value,'report.coverage.item');if(!['planned','covered','not-applicable'].includes(String(item.status)))throw new Error('coverage.status：无效状态');return{id:text(item.id,'coverage.id',100)!,name:text(item.name,'coverage.name')!,profiles:array(item.profiles,'coverage.profiles',24).map(value=>text(value,'coverage.profile',100)!),status:item.status as ReportCoverageRequirement['status'],...(item.reason!==undefined?{reason:text(item.reason,'coverage.reason',10000)!}:{})}})
  const revisions=array(raw.revisions,'report.revisions',20).map(value=>{const item=object(value,'report.revision'),generatedAt=finite(item.generatedAt,'revision.generatedAt');if(generatedAt<0)throw new Error('revision.generatedAt：无效时间');return{id:text(item.id,'revision.id',100)!,revision:text(item.revision,'revision.revision')!,generatedAt,format:text(item.format,'revision.format',40)!,conclusion:text(item.conclusion,'revision.conclusion')!,runIds:array(item.runIds,'revision.runIds',576).map(value=>text(value,'revision.runId',100)!)}})
  for(const [name,items,key] of [['tests',tests,'profileId'],['criteria',criteria,'id'],['coverage',coverage,'id'],['revisions',revisions,'id']] as const){const ids=items.map(item=>(item as unknown as Record<string,string>)[key]);if(ids.some(id=>!id.trim())||new Set(ids).size!==ids.length)throw new Error(`report.${name}：标识不可为空或重复`)}
  return{version:1,details:cleanDetails,tests,criteria,coverage,revisions}
}
