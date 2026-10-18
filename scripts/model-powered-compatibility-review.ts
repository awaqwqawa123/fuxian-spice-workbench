import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {join,resolve} from 'node:path'
import {Worker} from 'node:worker_threads'
import {readCompiledAuditModels} from '../server/model-electrical-audit'
import {preferredModelLibrary} from '../src/core/model-source-policy'
import {poweredModelFixture,type PoweredFixture} from './powered-model-fixtures'
const args=process.argv.slice(2),option=(name:string,fallback:string)=>args.includes(name)?args[args.indexOf(name)+1]:fallback
const root=resolve(option('--root','model-library')),baselinePath=resolve(option('--baseline',join(root,'audits/20261004-final/engine/audit.json'))),output=resolve(option('--report',join(root,'audits/powered-compatibility'))),filter=option('--filter',''),statuses=option('--statuses','needs-device-test').split(',')
const baseline=JSON.parse(await readFile(baselinePath,'utf8')),snapshot=await readCompiledAuditModels(root)
const old=new Map<string,{id:string;status:string;codeHash:string;reason:string}>(baseline.rows.map((row:any)=>[row.key,row]))
const oldByIdentity=new Map<string,typeof baseline.rows[number]>()
for(const row of baseline.rows)oldByIdentity.set(`${row.library}:${row.id.toUpperCase()}:${row.source}`,row)
const records=snapshot.records.filter(record=>{const model=record.model,prior=old.get(record.key)??oldByIdentity.get(`${preferredModelLibrary(model.source)}:${model.id.toUpperCase()}:${model.source.label}`);return preferredModelLibrary(model.source)==='pspice'&&prior&&statuses.includes(prior.status)&&(!filter||`${model.id} ${model.source.label}`.toLowerCase().includes(filter.toLowerCase()))})
await mkdir(output,{recursive:true})
type EngineResult={points?:number;vectors?:{name?:string;values:(number|{real:number;img:number})[]}[];errors?:string[];log?:string;exception?:string;timeout?:boolean}
async function run(netlist:string):Promise<EngineResult>{
 const worker=new Worker(new URL('./powered-model-worker.mjs',import.meta.url),{stdout:true,stderr:true});worker.stdout.resume();worker.stderr.resume()
 try{
  await new Promise<void>((accept,reject)=>{const timer=setTimeout(()=>reject(new Error('engine startup timeout')),20000);worker.once('error',reject);worker.once('message',message=>{clearTimeout(timer);message.ready?accept():reject(new Error('Unexpected startup response'))})})
  return await new Promise<EngineResult>(accept=>{const done=(response:EngineResult)=>{clearTimeout(timer);worker.off('message',receive);accept(response)},receive=(message:EngineResult)=>done(message),timer=setTimeout(()=>done({timeout:true,exception:'Powered fixture solver timeout (10 s)'}),10000);worker.once('message',receive);worker.once('error',error=>done({exception:(error as Error).message}));worker.postMessage({netlist})})
 }catch(error){return {exception:(error as Error).message}}finally{await worker.terminate()}
}
const fatal=/unrecognized\s+(?:parameter|device|model)|unknown\s+(?:parameter|device|model|subckt)|syntax error|no such function|undefined\s+(?:parameter|model)/i
const failure=/error:|doAnalyses:|failed|timestep too small|aborted/i
function classify(result:EngineResult,fixture:PoweredFixture,analysis:'op'|'ac'){
 const log=[result.log,...result.errors??[],result.exception].filter(Boolean).join('\n')
 const finite=(value:number|{real:number;img:number})=>typeof value==='number'?Number.isFinite(value):Number.isFinite(value.real)&&Number.isFinite(value.img)
 const data=result.vectors?.find(vector=>vector.name?.toLowerCase()===fixture.observable.toLowerCase())
 const observed=!!data&&data.values.length>0&&data.values.every(finite)
 let consistency:Record<string,unknown>|undefined
 const first=data?.values[0]
 if(observed&&analysis==='op'&&typeof first==='number'&&fixture.expectedResistance!==undefined){const resistance=-.01/first,relativeError=Math.abs(resistance-fixture.expectedResistance)/fixture.expectedResistance;consistency={measuredResistance:resistance,sourceExpectedResistance:fixture.expectedResistance,relativeError,passed:Number.isFinite(resistance)&&resistance>0&&relativeError<=.02,criterion:'27 °C low-power resistance versus unchanged source equation, within 2%; not datasheet accuracy'}}
 if(observed&&fixture.family==='amplifier'){
  if(analysis==='op'&&typeof first==='number')consistency={output:first,expectedOutput:fixture.expectedDc,absoluteError:Math.abs(first-fixture.expectedDc!),passed:Math.abs(first-fixture.expectedDc!)<=.1,criterion:'Unity-feedback 10 mV response within conservative 100 mV, supply fixture may be outside rated limits; not offset certification'}
  if(analysis==='ac'&&typeof first==='object') {const gain=Math.hypot(first.real,first.img)/fixture.inputAc!;consistency={lowFrequencyGain:gain,expectedGain:1,passed:gain>=.5&&gain<=1.5,criterion:'10 Hz unity-feedback gain 0.5–1.5; numerical response sanity only, not bandwidth/stability certification'}}
 }
 const status=fatal.test(log)?'powered-compatibility-error':result.exception||result.timeout||!result.points||!observed||failure.test(log)?'powered-test-incomplete':consistency?.passed===false?'powered-response-needs-review':/warning|ignored|not recognized/i.test(log)?'powered-passed-with-warning':'powered-load-passed'
 return {status,observed,points:result.points??0,reason:status==='powered-load-passed'?'Known-port powered fixture produced a finite device observable and passed stated response sanity checks; no precision certification':consistency?.passed===false?'Finite response differs from fixture sanity expectation; review operating conditions before judging source model':log.split(/\r?\n/).filter(line=>/warning|error|unknown|unrecognized|ignored|singular|converg|timestep|aborted|failed|undefined/i.test(line)).slice(0,16).join(' | ')||result.exception||'Device observable absent or nonfinite',consistency,measurement:data?{name:data.name,first:data.values[0],last:data.values.at(-1),count:data.values.length}:undefined}
}
const rows:any[]=[],jobs=records.map(record=>({record,decision:poweredModelFixture(record.model)}))
let next=0,completed=0
await Promise.all(Array.from({length:2},async()=>{while(next<jobs.length){const {record,decision}=jobs[next++],{model,key}=record,prior=old.get(key)??oldByIdentity.get(`${preferredModelLibrary(model.source)}:${model.id.toUpperCase()}:${model.source.label}`),codeHash=createHash('sha256').update(model.spice).digest('hex')
 const row:any={key,id:model.id,source:model.source.label,library:'pspice',codeHash,baselineStatus:prior.status,baselineReason:prior.reason,baselineCodeUnchanged:codeHash===prior.codeHash,checks:[]}
 if(!decision.fixture){row.status='pending-port-or-condition-evidence';row.reason=decision.reason}
 else{const base=decision.fixture;row.family=base.family;row.evidence=base.evidence;row.conditions=base.conditions;row.solverHints=base.solverHints
  for(const analysis of ['op','ac'] as const){const fixture=poweredModelFixture(model,analysis).fixture!;await writeFile(join(output,`${key}-${analysis}.cir`),fixture.netlist);const result=await run(fixture.netlist),review=classify(result,fixture,analysis);row.checks.push({analysis,...review});await writeFile(join(output,`${key}-${analysis}.json`),JSON.stringify(result,null,2));if(!review.status.startsWith('powered-load-passed')&&!review.status.startsWith('powered-passed-with-warning'))break}
  row.status=row.checks.some((check:any)=>check.status==='powered-compatibility-error')?'powered-compatibility-error':row.checks.some((check:any)=>check.status==='powered-test-incomplete')?'powered-test-incomplete':row.checks.some((check:any)=>check.status==='powered-response-needs-review')?'powered-response-needs-review':row.checks.some((check:any)=>check.status==='powered-passed-with-warning')?'powered-passed-with-warning':'powered-load-passed';row.reason=row.checks.map((check:any)=>`${check.analysis}: ${check.reason}`).join(' | ')
 }
 rows.push(row);completed++;if(completed%25===0)console.log(JSON.stringify({completed,total:jobs.length}))
}}))
rows.sort((a,b)=>a.id.localeCompare(b.id));const counts=Object.fromEntries([...new Set(rows.map(row=>row.status))].map(status=>[status,rows.filter(row=>row.status===status).length]))
const report={recordedAt:new Date().toISOString(),generation:snapshot.generation,baseline:baselinePath,baselineGeneration:baseline.generation,total:rows.length,counts,scope:'Supplemental known-port powered device compatibility fixtures; immutable unpowered baseline remains separate. Fixtures are mathematical operating conditions, not claimed datasheet-rated conditions, accuracy, temperature or dynamic certification. Numerical pins without functional evidence remain pending. No project data or model bytes modified.',rows}
await writeFile(join(output,'audit.json'),JSON.stringify(report,null,2))
const fields=['key','id','source','codeHash','baselineStatus','baselineCodeUnchanged','family','status','reason'] as const,csv=(v:unknown)=>`"${String(v??'').replaceAll('"','""')}"`
await writeFile(join(output,'devices.csv'),'\uFEFF'+[fields.join(','),...rows.map(row=>fields.map(field=>csv(row[field])).join(','))].join('\r\n'))
console.log(JSON.stringify({output,total:rows.length,counts}))
