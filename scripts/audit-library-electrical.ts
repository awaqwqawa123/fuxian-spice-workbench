import { mkdir,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { auditElectricalModel,readCompiledAuditModels } from '../server/model-electrical-audit'
const libraryRoot=resolve(process.argv[2]??'model-library'),output=resolve(process.argv[3]??join(libraryRoot,'audits','electrical'))
const snapshot=await readCompiledAuditModels(libraryRoot),rows=snapshot.records.map(({key,model})=>auditElectricalModel(model,key))
const count=(key:'library'|'type'|'status')=>Object.fromEntries([...new Set(rows.map(row=>row[key]))].sort().map(value=>[value,rows.filter(row=>row[key]===value).length]))
const result={recordedAt:new Date().toISOString(),generation:snapshot.generation,uniqueDevices:snapshot.uniqueDevices,versions:rows.length,byLibrary:count('library'),byType:count('type'),byStatus:count('status'),scope:'全部当前可选器件：库索引/摘要/模型校验、语法与依赖、保存恢复电气和符号身份、导出完整性。电气工作范围、温度、瞬态、噪声与规格书精度未由此检查认证。',rows}
await mkdir(output,{recursive:true});await writeFile(join(output,'audit.json'),JSON.stringify(result,null,2))
const fields=['key','id','library','source','kind','type','ports','status','checks','warnings','errors','codeHash'] as const
const csv=(value:unknown)=>`"${String(Array.isArray(value)?value.join(' | '):value).replaceAll('"','""')}"`
await writeFile(join(output,'devices.csv'),'\uFEFF'+[fields.join(','),...rows.map(row=>fields.map(field=>csv(row[field])).join(','))].join('\r\n'))
await writeFile(join(output,'report.md'),`# 全库电气结构检查\n\n${result.uniqueDevices} 个型号、${result.versions} 个来源版本；通过 ${result.byStatus.passed??0}，异常 ${result.byStatus.error??0}。\n\n${result.scope}\n\n逐项结果见 devices.csv 与 audit.json。\n`)
console.log(JSON.stringify({output,...Object.fromEntries(Object.entries(result).filter(([key])=>key!=='rows'))}))
if(result.byStatus.error)process.exitCode=1
