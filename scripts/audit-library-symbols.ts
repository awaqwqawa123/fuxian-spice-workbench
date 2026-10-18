import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { auditCompiledLibrarySymbols } from '../server/model-symbol-audit'
const libraryRoot=resolve(process.argv[2]??'model-library')
const output=resolve(process.argv[3]??join(libraryRoot,'audits','symbols'))
const audit=await auditCompiledLibrarySymbols(libraryRoot)
await mkdir(output,{recursive:true})
await writeFile(join(output,'audit.json'),JSON.stringify(audit,null,2))
const fields=['id','library','kind','family','symbol','status','ports','source','reason'] as const
const csv=(value:unknown)=>`"${String(value??'').replaceAll('"','""')}"`
await writeFile(join(output,'devices.csv'),'\uFEFF'+[fields.join(','),...audit.rows.map(row=>fields.map(field=>csv(row[field])).join(','))].join('\r\n'))
const labels={'original-verified':'原厂图形与实际模型接口已核对','standard-verified':'标准符号与器件功能已核对','connection-only':'仅连接示意，端口功能或图形待核对','original-unverified':'原始符号结构通过，本次未核对该来源原件','error':'发现不一致，需要修复'}
const byLibrary=new Map<string,Map<string,number>>()
for(const row of audit.rows){const counts=byLibrary.get(row.library)??new Map();counts.set(row.status,(counts.get(row.status)??0)+1);byLibrary.set(row.library,counts)}
const rows=[...byLibrary].map(([library,counts])=>`| ${library} | ${Object.keys(labels).map(status=>counts.get(status)??0).join(' | ')} |`).join('\n')
const pending=new Map<string,typeof audit.rows>()
for(const row of audit.rows.filter(row=>row.status==='connection-only'||row.status==='original-unverified'||row.status==='error')){
  const family=row.family||'未明确功能类别',entries=pending.get(family)??[];entries.push(row);pending.set(family,entries)
}
const pendingTable=[...pending].sort((a,b)=>b[1].length-a[1].length).map(([family,entries])=>`| ${family} | ${entries.length} | ${entries.slice(0,6).map(row=>row.id.replaceAll('|','\\|')).join('、')} |`).join('\n')
const note=`# 本地器件符号核对\n\n核对时间：${audit.recordedAt}。共 ${audit.uniqueDevices} 个型号、${audit.versions} 个来源版本。\n\n${audit.scope}\n\n| 来源 | 原厂图形已核对 | 标准符号已核对 | 连接示意待核对 | 原件未复核 | 不一致 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n“连接示意待核对”不代表引脚已经错接，表示没有足够证据把占位框称为正确器件符号；不一致项必须修复后才能确认。全部逐项记录见同目录 devices.csv，结构化结果见 audit.json。\n\n${Object.entries(audit.counts).map(([status,count])=>`- ${labels[status as keyof typeof labels]}：${count}`).join('\n')}\n`
await writeFile(join(output,'report.md'),note+(pending.size?`\n## 仍需原件或引脚证据的类别\n\n以下条目保留实际电气端口顺序；未猜测端口用途或声称占位框是原厂图形。型号仅列样例，完整列表见 devices.csv。\n\n| 功能类别 | 版本数 | 型号样例 |\n| --- | ---: | --- |\n${pendingTable}\n`:''))
console.log(JSON.stringify({output,generation:audit.generation,uniqueDevices:audit.uniqueDevices,versions:audit.versions,counts:audit.counts}))
if(audit.counts.error)process.exitCode=1
