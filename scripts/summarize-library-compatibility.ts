import {readFile,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'

type Row={key:string;id:string;library:string;source:string;codeHash:string;status:string;reason:string}
type Audit={recordedAt:string;generation:string;total:number;rows:Row[]}
const root=resolve(process.argv[2]??'model-library'),folder=join(root,'audits','20261004-compatibility')
const load=async(path:string)=>JSON.parse(await readFile(path,'utf8'))
const before:Audit=await load(join(root,'audits','20261004-final','engine','audit.json'))
const after:Audit=await load(join(folder,'engine','audit.json'))
const powered=await load(join(folder,'powered','audit.json'))
if(before.generation!==after.generation||powered.generation!==after.generation||before.total!==after.total)throw new Error('Reports have different library snapshots; no aggregate claim made')
const old=new Map(before.rows.map(row=>[row.key,row]))
if(old.size!==before.total||new Set(after.rows.map(row=>row.key)).size!==after.total||after.rows.some(row=>!old.has(row.key)||old.get(row.key)!.codeHash!==row.codeHash))throw new Error('Original model records changed or audit keys are incomplete')
const count=(rows:{status:string}[],status:string)=>rows.filter(row=>row.status===status).length
const statuses=['load-passed','compatibility-error','compatibility-warning','needs-device-test']
const libraries=['pspice','ltspice','tina']
const comparisons=libraries.map(library=>({library,total:after.rows.filter(row=>row.library===library).length,statuses:statuses.map(status=>({status,before:count(before.rows.filter(row=>row.library===library),status),after:count(after.rows.filter(row=>row.library===library),status)}))}))
const transitions=new Map<string,number>()
for(const row of after.rows.filter(row=>row.library==='pspice')){const key=`${old.get(row.key)!.status} → ${row.status}`;transitions.set(key,(transitions.get(key)??0)+1)}
const groups=new Map<string,{status:string;source:string;count:number;examples:string[]}>()
for(const row of after.rows.filter(row=>row.library==='pspice'&&row.status!=='load-passed')){
  const key=`${row.status}:${row.source}`,group=groups.get(key)??{status:row.status,source:row.source,count:0,examples:[]}
  group.count++;if(group.examples.length<4)group.examples.push(row.id);groups.set(key,group)
}
const remaining=[...groups.values()].sort((a,b)=>b.count-a.count)
const poweredCounts=Object.fromEntries([...new Set(powered.rows.map((row:Row)=>row.status))].map(status=>[String(status),count(powered.rows,status as string)]))
const result={recordedAt:new Date().toISOString(),generation:after.generation,sourceDefinitionsUnchanged:true,baselineDate:before.recordedAt,engineDate:after.recordedAt,comparisons,transitions:Object.fromEntries(transitions),remaining,powered:{recordedAt:powered.recordedAt,total:powered.total,counts:poweredCounts},limitations:['通用工作点不是规格书精度认证','专测只核对记录中的供电、负载和观察量；未覆盖全部温度及动态范围','原生 PSpice 对照仅覆盖相应报告中的器件和激励，不代表全库跨引擎认证']}
await writeFile(join(folder,'comparison.json'),JSON.stringify(result,null,2))
const title:Record<string,string>={'load-passed':'加载通过','compatibility-error':'兼容错误','compatibility-warning':'兼容警告','needs-device-test':'通用检查仍需专测'}
const escape=(raw:string)=>raw.replaceAll('|','\\|').replaceAll('\n',' ')
const report=[
  '# 本地模型库兼容补充结果','',`日期：${result.recordedAt}；库快照：\`${after.generation}\`。`,
  '',`全部 ${after.total} 个来源版本已重新运行真实引擎；与基线逐条核对，原模型定义校验值全部保持一致。`,
  '', '本次通用检查保存并核对全部返回节点电压和电压源支路电流；旧基线仅保存独立锚点。供电、端口接地及工作点条件相同，有限值观察范围扩大，因此新增待测项不能直接解释为模型退化。',
  '','## 前后对比','','| 来源 | 来源版本 | 项目 | 之前 | 本次 |','|---|---:|---|---:|---:|',
  ...comparisons.flatMap(item=>item.statuses.map(status=>`| ${item.library} | ${item.total} | ${title[status.status]} | ${status.before} | ${status.after} |`)),
  '','## 本次实现','',
  '- 全网表转换参数化子电路的特殊名称，同时更新定义、结束声明和所有调用；原始名称、符号与保存数据保留。',
  '- 二极管明确的 IKF=0 使用引擎等价的零默认值；非零和未知表达式不转换。',
  '- 已核对的 PSpice di.lib 单二极管默认 STATE=1 写法在完整调用范围内转换；非默认 STATE/IC、未知表达式、UIC 和缺默认参数的定义拒绝转换。原生五族对照见 docs/pspice-legacy-diode-state-results.json。',
  '- 独立源 Adc/Vdc 单位按电流/电压值位置转换，避免 1Adc 被误读为 1e-18 A；不全局替换参数或时间单位。',
  '- 画布、原始网表、导出及审计共用执行转换；热模型恢复仅补充由原方程得到的 NODESET 数值初猜，保留用户初始条件。',
  '- 专测增加热敏电阻的测得电阻/源公式核对，以及放大器的闭环 DC/低频 AC 数值核对；有限结果本身不再代表响应合理。',
  '','## PSpice 状态迁移','','| 之前 → 本次 | 数量 |','|---|---:|',
  ...[...transitions].map(([key,value])=>`| ${key} | ${value} |`),
  '','## 269 项原待测器件的补充检查','',
  `实际检查 ${powered.total} 项；原未供电基线单独保留。`,
  '','| 专测状态 | 数量 |','|---|---:|',...Object.entries(poweredCounts).map(([status,n])=>`| ${status} | ${n} |`),
  '', '供电、负载、温度、节点初猜、原引脚证据、源参数预期与实测值均写入 powered/audit.json；原始网表和引擎日志也逐项保留。通过只代表这些具体检查完成，不代替规格书、宽温、额定值、开关瞬态、稳定性或噪声认证。',
  '','## 剩余 PSpice 项目','','| 状态 | 来源文件 | 数量 | 型号示例 |','|---|---|---:|---|',
  ...remaining.map(item=>`| ${title[item.status]} | ${escape(item.source)} | ${item.count} | ${escape(item.examples.join(', '))} |`),
  '','## 可复核文件','',
  '- engine/audit.json、engine/devices.csv：全部实际引擎加载结果。',
  '- powered/audit.json、powered/devices.csv：带源证据和定量响应核对的补充检查。',
  '- electrical/audit.json、electrical/devices.csv：语法、依赖、保存恢复与导出身份检查。',
  '- comparison.json：来源计数、状态迁移及未改变源定义的逐项比较结论。',
  '- 补充库清单：docs/library-supplement-priorities-2026-10-04.md。',
  '',...result.limitations.map(value=>`- ${value}`),'',
].join('\n')
await writeFile(join(folder,'report.md'),report)
console.log(JSON.stringify({output:folder,comparisons,powered:result.powered}))
