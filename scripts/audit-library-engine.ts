import {mkdir,writeFile,rename} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {join,resolve} from 'node:path'
import {Worker} from 'node:worker_threads'
import {readCompiledAuditModels} from '../server/model-electrical-audit'
import {importedModelNetlist,type ImportedSpiceModel} from '../src/core/spice-models'
import {preferredModelLibrary} from '../src/core/model-source-policy'
import {reviewRuntimeNetlist} from '../src/core/spice-runtime-compatibility'
import {legacyDiodeRootsForModels} from '../src/core/legacy-diode-provenance'
import {primitiveModelCompatibility} from '../src/core/spice-primitive-compatibility'

const root=resolve(process.argv[2]??'model-library'),output=resolve(process.argv[3]??join(root,'audits','engine'))
const snapshot=await readCompiledAuditModels(root)
type RecordItem=typeof snapshot.records[number]
type Response={points?:number;finite?:boolean;log?:string;errors?:string[];exception?:string;timeout?:boolean}
type Row={key:string;id:string;source:string;library:string;kind:string;codeHash:string;status:'load-passed'|'compatibility-error'|'compatibility-warning'|'needs-device-test';test:string;reason:string}
const rows:Row[]=[],jobs:RecordItem[][]=[],primitives=snapshot.records.filter(row=>row.model.kind!=='X')
for(let i=0;i<primitives.length;i+=64)jobs.push(primitives.slice(i,i+64))
if(!process.argv.includes('--primitives-only'))jobs.push(...snapshot.records.filter(row=>row.model.kind==='X').map(row=>[row]))
function netlist(records:RecordItem[]){
 const lines=['Independent device compatibility load test; NOT performance characterization','VAUDIT ANCHOR 0 .05','RAUDIT ANCHOR 0 1k']
 for(const [index,{model}] of records.entries()){
  if(model.kind==='X'){
   const nodes=model.pins.map((_,pin)=>`AUD_${index}_${pin}`)
   lines.push(`XAUD${index} ${nodes.join(' ')} ${model.id}`, ...nodes.map((node,pin)=>`RAUD_${index}_${pin} ${node} 0 1meg`),importedModelNetlist(model))
  } else {
   const id=`AUD_MODEL_${index}`,name=`AUD_NODE_${index}`,gate=`AUD_GATE_${index}`,negative=['PNP','PMOS','PJF'].includes(model.type),sign=negative?-1:1
   lines.push(`VAUD_${index} ${name} 0 ${.05*sign}`)
   if(model.kind==='D')lines.push(`DAUD${index} ${name} 0 ${id}`)
   else {lines.push(`VGAUD_${index} ${gate} 0 ${model.kind==='J'?0:.05*sign}`);lines.push(model.kind==='Q'?`QAUD${index} ${name} ${gate} 0 ${id}`:model.kind==='J'?`JAUD${index} ${name} ${gate} 0 ${id}`:`MAUD${index} ${name} ${gate} 0 ${model.technology==='VDMOS'?'':'0 '}${id}`)}
   lines.push(model.spice.replace(/^(\.model\s+)\S+/i,(_,prefix)=>prefix+id))
  }
 }
 // Saving only the independent ANCHOR can conceal a nonfinite device node.
 // Inspect the actual circuit's node voltages and source branch currents too.
 lines.push('.options itl1=50 gmin=1e-10','.op','.save all','.end');return reviewRuntimeNetlist(lines.join('\n'),legacyDiodeRootsForModels(records.map(record=>record.model))).netlist
}
class Runtime {
 worker?:Worker
 private boot?:Promise<void>
 async run(text:string):Promise<Response>{
  if(!this.worker){
   this.worker=new Worker(new URL('./library-engine-worker.mjs',import.meta.url),{stdout:true,stderr:true})
   this.worker.stdout.resume();this.worker.stderr.resume()
   const worker=this.worker
   this.boot=new Promise<void>((accept,reject)=>{const timer=setTimeout(()=>reject(new Error('engine startup timeout')),20000);worker.once('error',reject);worker.once('message',message=>{clearTimeout(timer);if(message.ready)accept();else reject(new Error('unexpected engine response'))})})
  }
  try{await this.boot}catch(error){await this.close();return{exception:(error as Error).message}}
  const worker=this.worker!
  return new Promise<Response>(accept=>{
   let finished=false
   const done=(response:Response)=>{if(finished)return;finished=true;clearTimeout(timer);worker.off('message',receive);worker.off('error',fail);accept(response)}
   const receive=(message:Response)=>done(message),fail=(error:Error)=>done({exception:error.message})
   const timer=setTimeout(()=>{done({timeout:true,exception:'该未供电连接测试超时，需器件专用测试条件'});void this.close()},4000)
   worker.once('message',receive);worker.once('error',fail);worker.postMessage({netlist:text})
  })
 }
 async close(){const previous=this.worker;this.worker=undefined;this.boot=undefined;if(previous)await previous.terminate()}
}
const fatal=/unrecognized\s+(?:parameter|device|model)|unknown\s+(?:parameter|device|model|subckt)|could not find a valid model|undefined\s+(?:parameter|model)|syntax error|no such function|too few (?:parameters|nodes)|too many parameters/i
function classify(records:RecordItem[],result:Response){
 const log=[...(result.errors??[]),result.log??'',result.exception??''].join('\n')
 const warnings=/warning|ignored|not recognized/i.test(log)
 const lines=log.split(/\r?\n/),selected=new Set<number>()
 for(let i=0;i<lines.length;i++)if(/warning|error|unknown|unrecognized|ignored|singular|converg|timestep|aborted|undefined|not recognized/i.test(lines[i]))for(let j=i;j<Math.min(i+3,lines.length);j++)selected.add(j)
 const reason=[...selected].slice(0,14).map(index=>lines[index]).join(' | ')||result.exception||'测试未返回有限结果'
 const actualMessages=(result.errors??[]).filter(item=>item.trim()&&!/^Note:/i.test(item))
 const status=fatal.test(log)?'compatibility-error':result.timeout||result.exception||!result.points||!result.finite||actualMessages.some(item=>/error|failed|aborted|singular|converg/i.test(item))?'needs-device-test':warnings||actualMessages.length?'compatibility-warning':'load-passed'
 return records.map(({key,model})=>({key,id:model.id,source:model.source.label,library:preferredModelLibrary(model.source)??'other',kind:model.kind,codeHash:createHash('sha256').update(model.spice).digest('hex'),status,test:model.kind==='X'?'All ordered ports separately terminated by 1 Mohm; unpowered load test':'Independent primitive 50 mV load test',reason:status==='load-passed'?'引擎加载与该有限工作点通过；不证明目标器件电气精度':[reason,...primitiveModelCompatibility(model.spice).findings.filter(item=>item.kind==='engine-domain-limit').map(item=>item.message)].join(' | ').slice(0,1600)} satisfies Row))
}
await mkdir(output,{recursive:true})
let next=0,completed=0
await Promise.all(Array.from({length:3},async()=>{
 const runtime=new Runtime()
 try {while(next<jobs.length){
  const records=jobs[next++],result=await runtime.run(netlist(records)),classified=classify(records,result)
  if(records.length>1&&classified.some(row=>row.status!=='load-passed'))for(const record of records)rows.push(...classify([record],await runtime.run(netlist([record]))))
  else rows.push(...classified)
  completed+=records.length
  if(completed%512<records.length)console.log(JSON.stringify({reviewed:completed,total:jobs.reduce((sum,job)=>sum+job.length,0)}))
 }} finally{await runtime.close()}
}))
rows.sort((a,b)=>a.key.localeCompare(b.key))
const counts=Object.fromEntries(['load-passed','compatibility-error','compatibility-warning','needs-device-test'].map(status=>[status,rows.filter(row=>row.status===status).length]))
const report={recordedAt:new Date().toISOString(),generation:snapshot.generation,total:rows.length,counts,scope:'所有所列来源版本均真正实例化后运行引擎。原生器件为50mV兼容性工作点；子电路端口独立以1MΩ接地、未供电。检查所有返回的节点电压和电压源支路电流为有限值，不仅检查独立锚点。警告/不收敛/超时需要专用器件测试，不能据此称原模型错误；通过也不等于规格书精度、额定值、温度或动态认证。',rows}
await writeFile(join(output,'audit.json'),JSON.stringify(report,null,2))
const fields=['key','id','library','source','kind','status','test','reason'] as const,csv=(raw:unknown)=>`"${String(raw).replaceAll('"','""')}"`
await writeFile(join(output,'devices.csv'),'\uFEFF'+[fields.join(','),...rows.map(row=>fields.map(field=>csv(row[field])).join(','))].join('\r\n'))
if(process.argv.includes('--publish')){
 if(rows.length!==snapshot.records.length)throw new Error('只能发布全部当前来源版本的完整检查')
 const reviewRoot=join(root,'audits');await mkdir(reviewRoot,{recursive:true})
 const pending=join(reviewRoot,`engine-review-${randomUUID()}.pending`)
 await writeFile(pending,JSON.stringify(report),'utf8');await rename(pending,join(reviewRoot,'engine-review.json'))
}
console.log(JSON.stringify({output,generation:snapshot.generation,total:rows.length,counts}))
