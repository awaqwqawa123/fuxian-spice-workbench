import { strToU8, zipSync } from 'fflate'
import { dcSweep,type Project } from './circuit'
import type { Result } from './results'
import type { SimulationProfile } from './simulation-profiles'
import { testCoverage, type FinalTestReport } from './final-test-report'
import { importedModelNetlist } from './spice-models'

function crc32(bytes:Uint8Array):string {
  let crc=0xffffffff
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
  return((crc^0xffffffff)>>>0).toString(16).padStart(8,'0')
}
const csvText=(text:string)=>`"${text.replace(/"/g,'""')}"`
/** Preserve all available parsed vectors, including complex AC samples and noise density. */
export function archivedSamplesCsv(result:Result):string {
  const columns:{name:string;values:number[]}[]=[{name:result.analysis==='ac'||result.analysis==='noise'?'frequency_Hz':result.analysis==='tran'?'time_s':result.analysis==='dc'?(/^I/i.test(dcSweep(result.project).sourceId??result.project.drawing?.sourceId??'V1')?'sweep_A':'sweep_V'):'point',values:result.x}]
  if(result.analysis==='noise')columns.push({name:'output_noise_V_per_sqrt_Hz',values:result.noise!.output},{name:`input_noise_${result.noise!.inputUnit}_per_sqrt_Hz`,values:result.noise!.input})
  else{
    columns.push({name:'input_V',values:result.vin},{name:'output_V',values:result.vout},{name:'reference_source_current_A',values:result.current})
    if(result.analysis==='ac')columns.push({name:'transfer_gain_dB',values:result.magnitude},{name:'transfer_phase_deg',values:result.phase})
    for(const [name,values] of Object.entries(result.voltages??{}))if(values.length===result.points&&values.every(Number.isFinite))columns.push({name:`${name}_real_V`,values})
    for(const [name,values] of Object.entries(result.currents??{}))if(values.length===result.points&&values.every(Number.isFinite))columns.push({name:`${name}_real_A`,values})
    for(const [name,values] of Object.entries({...result.complexVoltages,...result.complexCurrents})){
      if(values.length!==result.points||values.some(value=>!Number.isFinite(value.real)||!Number.isFinite(value.img)))continue
      const unit=name.toLowerCase().startsWith('v(')?'V':'A'
      columns.push({name:`${name}_complex_real_${unit}`,values:values.map(value=>value.real)},{name:`${name}_complex_imag_${unit}`,values:values.map(value=>value.img)})
    }
  }
  return '\uFEFF'+columns.map(column=>csvText(column.name)).join(',')+'\n'+result.x.map((_,index)=>columns.map(column=>column.values[index]).join(',')).join('\n')+'\n'
}

/** Archive only actual, current run evidence; paths never depend on user text. */
export function reportArchive(project:Project,profiles:readonly SimulationProfile[],results:Readonly<Record<string,Result>>,report:FinalTestReport,documents:{html:string;markdown:string}):Uint8Array {
  const actualRuns=profiles.flatMap(profile=>{const parent=results[profile.id];return parent?(parent.sweepResults??[parent]).map((result,index)=>({profile,result,reportProfileId:parent.sweepResults?`${profile.id}::sweep:${index+1}`:profile.id,name:`${profile.name}${result.sweepLabel?` · ${result.sweepLabel}`:''}`})):[]})
  if(actualRuns.length!==report.runs.length||!profiles.length)throw new Error('归档配置与报告不一致，请重新生成报告')
  if(!Number.isFinite(report.generatedAt)||testCoverage(project,profiles,results).some(run=>run.status!=='complete'))throw new Error('归档需要当前电路和探针的完整有效仿真结果，请重新运行')
  const files:Record<string,Uint8Array>={},manifestFiles:{path:string;bytes:number;crc32:string}[]=[]
  const put=(path:string,value:string)=>{const bytes=strToU8(value);files[path]=bytes;manifestFiles.push({path,bytes:bytes.length,crc32:crc32(bytes)})}
  const json=(value:unknown)=>JSON.stringify(value,null,2)
  put('report.html',documents.html);put('report.md',documents.markdown);put('report.json',json(report))
  put('project.json',json(project));put('simulation-profiles.json',json(profiles))
  put('simulation-results.json',json(Object.fromEntries(profiles.map(profile=>[profile.id,results[profile.id]]))))
  const runs=actualRuns.map(({profile,result,reportProfileId,name},index)=>{
    const record=report.runs[index]
    if(record.sourceProfileId!==profile.id||record.profileId!==reportProfileId||record.report.runId!==result.id||record.profileName!==name)throw new Error(`配置“${profile.name}”缺少与报告一致的有效运行，请重新生成报告`)
    const base=`runs/${String(index+1).padStart(2,'0')}`
    put(`${base}/project.json`,json(result.project));put(`${base}/result.json`,json(result));put(`${base}/samples.csv`,archivedSamplesCsv(result));put(`${base}/netlist.cir`,result.netlist);put(`${base}/solver.log`,result.log)
    const models=(result.project.models??[]).map((model,modelIndex)=>{
      const path=`${base}/models/${String(modelIndex+1).padStart(3,'0')}.lib`
      put(path,importedModelNetlist(model));return{id:model.id,path,source:model.source,metadata:model.metadata,pins:model.pins,spiceCrc32:crc32(strToU8(model.spice))}
    })
    put(`${base}/model-sources.json`,json(models))
    return{profileId:profile.id,reportProfileId,profileName:name,sweepLabel:result.sweepLabel,runId:result.id,analysis:result.analysis,timestamp:result.timestamp,engine:result.engine,points:result.points,directory:base,models}
  })
  put('README.txt',[
    '伏线 · 电路设计与仿真验证归档',
    `工程：${report.title}`,`报告生成时间：${new Date(report.generatedAt).toISOString()}`,`报告版本：${report.details.revision??'未填写'}`,
    'report.html：离线完整报告及图表；report.md：可编辑文本；report.json：生成时的报告快照。',
    'project.json：生成时工程；simulation-profiles.json：仿真配置。runs/下逐项保存该运行实际工程、网表、日志、解析后的求解器数据和CSV采样。',
    'AC CSV复数实部、虚部以及传递增益分别标明；noise CSV为幅度谱密度，积分噪声总量在result.json。',
    'models/与model-sources.json保存工程包含的模型定义、来源和元数据；模型参数及所有嵌入依赖以实际网表为准。',
    'manifest.json列出配置与实际运行ID、文件字节数和CRC32，可用于核对归档内容完整性。CRC32是完整性校验，不是数字签名。',
    '结果可复现性还取决于相同求解器版本及网表中的模型、温度、初始条件和求解器选项。未设置的条件使用求解器默认值。',
  ].join('\n'))
  files['manifest.json']=strToU8(json({schemaVersion:1,title:report.title,generatedAt:report.generatedAt,documentRevision:report.details.revision,conclusion:report.conclusion,dataKind:'parsed-solver-results',integrityAlgorithm:'CRC32',runs,files:manifestFiles}))
  return zipSync(files,{level:6})
}
