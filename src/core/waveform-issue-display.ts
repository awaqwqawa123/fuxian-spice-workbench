import type { WaveformSetup } from './waveform-setup'

const fieldLabels:Record<string,string>={
  'ac.start':'起始频率','ac.stop':'终止频率','ac.points':'频率采样点数',
  'tran.stop':'仿真时长','tran.step':'最大时间步长',
  dc:'直流扫描','dc.start':'扫描起点','dc.stop':'扫描终点','dc.step':'扫描步进',
  analysis:'分析类型',sourceId:'参考源',output:'输出端点',temperature:'温度',sweep:'参数扫描',
  profileId:'仿真配置',source:'信号来源',display:'显示方式',ids:'曲线选择',primary:'主曲线',
  layout:'视图布局',domain:'显示范围',cursors:'测量游标',activePanel:'当前视图',
  splitDirection:'分隔方向',splitRatio:'分隔比例',name:'名称',title:'标题',
}
function fieldDescription(path:string):string {
  path=path.replace(/^\.settings\./,'.').replace(/^\.view(?=\.|$)/,'')
  const panel=path.match(/^\.panels\[(\d+)\]/)
  const labels:string[]=[]
  if(panel){labels.push(`视图 ${Number(panel[1])+1}`);path=path.slice(panel[0].length)}
  path=path.replace(/^\./,'')
  if(path.startsWith('expressions.'))labels.push(`表达式 ${path.slice('expressions.'.length)}`)
  else if(path){
    const indexed=path.match(/^(ids)\[(\d+)\]$/)
    labels.push(indexed?`${fieldLabels[indexed[1]]} ${Number(indexed[2])+1}`:fieldLabels[path]??path)
  }
  return labels.length?` · ${labels.join(' · ')}`:''
}

/** Translate only the diagnostic location; preserve the original cause and signal evidence. */
export function waveformIssueMessages(issues:string[],setup:WaveformSetup):string[] {
  const owners=[
    ...setup.profiles.profiles.map(profile=>({path:`project.waveformSetup.profiles.${profile.id}`,label:`仿真配置「${profile.name}」`})),
    ...setup.diagrams.map(diagram=>({path:`project.waveformSetup.diagrams.${diagram.id}`,label:`波形图「${diagram.title||'未命名波形图'}」`})),
  ].sort((a,b)=>b.path.length-a.path.length)
  return issues.map(issue=>{
    const separator=issue.indexOf('：')
    if(separator<0)return issue
    const location=issue.slice(0,separator),cause=issue.slice(separator+1)
    const owner=owners.find(item=>location===item.path||location.startsWith(`${item.path}.`))
    if(!owner)return issue
    return `${owner.label}${fieldDescription(location.slice(owner.path.length))}：${cause}`
  })
}
