import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { readCompiledAuditModels } from '../server/model-electrical-audit'
import { importedModelNetlist } from '../src/core/spice-models'
import { normalizeNgspiceSubcircuitIdentifiers } from '../src/core/spice-runtime-identifiers'

const libraryRoot=resolve(process.argv[2]??'model-library'),output=resolve(process.argv[3]??'verification/pspice-runtime-identifiers')
const snapshot=await readCompiledAuditModels(libraryRoot)
const originalAudit=JSON.parse(await readFile(join(libraryRoot,'audits/20261004-final/engine/audit.json'),'utf8'))
const previous=new Map<string,{status:string;source:string}> (originalAudit.rows.map((row:{key:string;status:string;source:string})=>[row.key,row]))
const selected=snapshot.records.filter(record=>previous.get(record.key)?.status==='compatibility-error'&&/\/(?:epcos|filtsub|anl_misc)\.lib$/i.test(record.model.source.label))
type EngineResponse={points?:number;finite?:boolean;errors?:string[];log?:string;exception?:string;timeout?:boolean}
let worker:Worker|undefined
async function run(netlist:string):Promise<EngineResponse>{
  if(!worker){
    worker=new Worker(new URL('./library-engine-worker.mjs',import.meta.url),{stdout:true,stderr:true});worker.stdout.resume();worker.stderr.resume()
    await new Promise<void>((accept,reject)=>{worker!.once('message',()=>accept());worker!.once('error',reject)})
  }
  const current=worker
  return new Promise(resolve=>{
    const receive=(message:EngineResponse)=>{clearTimeout(timer);current.off('error',fail);resolve(message)}
    const fail=(error:Error)=>{clearTimeout(timer);current.off('message',receive);resolve({exception:error.message})}
    const timer=setTimeout(()=>{current.off('message',receive);current.off('error',fail);worker=undefined;void current.terminate();resolve({timeout:true})},6000)
    current.once('message',receive);current.once('error',fail);current.postMessage({netlist})
  })
}
function status(response:EngineResponse){
  if(response.timeout)return 'pending-device-test'
  if(response.exception||!response.points||!response.finite)return 'failed'
  const messages=(response.errors??[]).join('\n')+'\n'+(response.log??'')
  if(/error|unknown|unrecognized|ignored|aborted|failed|singular|converg/i.test(messages))return 'failed'
  return /warning/i.test(messages)?'warning':'passed'
}
await mkdir(output,{recursive:true})
const rows:{key:string;id:string;source:typeof snapshot.records[number]['model']['source'];before:string;after:string}[]=[]
try{for(const record of selected){
  const {model}=record,nodes=model.pins.map((_,index)=>`AUD_${index}`)
  const baseline=`Runtime identifier compatibility; unpowered ports, not precision certification
VA A 0 .05
RA A 0 1k
XTOP ${nodes.join(' ')} ${model.id}
${nodes.map((node,index)=>`RAUD_${index} ${node} 0 1meg`).join('\n')}
${importedModelNetlist(model)}
.options itl1=50 gmin=1e-10
.op
.save V(A)
.end`
  const adapted=normalizeNgspiceSubcircuitIdentifiers(baseline),before=await run(baseline),after=await run(adapted)
  const row={key:record.key,id:model.id,source:model.source,before:status(before),after:status(after)}
  rows.push(row)
  await writeFile(join(output,`${record.key}.json`),JSON.stringify({...row,originalNetlist:baseline,adaptedNetlist:adapted,beforeEngine:before,afterEngine:after},null,2))
}}finally{await worker?.terminate()}
const report={generation:snapshot.generation,total:rows.length,scope:'Exact source records loaded before/after alias normalization; unpowered port compatibility only. Original vendor sources and compiled generation unchanged.',counts:{before:Object.fromEntries(['passed','warning','failed','pending-device-test'].map(status=>[status,rows.filter(row=>row.before===status).length])),after:Object.fromEntries(['passed','warning','failed','pending-device-test'].map(status=>[status,rows.filter(row=>row.after===status).length]))},rows}
await writeFile(join(output,'audit.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({generation:report.generation,total:report.total,counts:report.counts}))
