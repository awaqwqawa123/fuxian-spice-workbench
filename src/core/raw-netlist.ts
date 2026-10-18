import type { Complex, RawResult } from './results'
import { normalizeNoiseSaves, type NoiseSimulationResult } from './noise-simulation'

export type RawAnalysis = 'ac' | 'tran' | 'op' | 'dc' | 'noise'
export interface RawNoiseSettings { output:string; source:string; inputUnit:'V'|'A'; sweep:'dec'|'oct'|'lin' }
export interface RawStep { kind:'parameter'|'temperature'; name:string; values:number[] }
export interface RawMeasurement { name:string; analysis:'ac'|'tran'|'dc'; operation:string; directive:string }
export interface RawMeasurementValue { name:string; value:number|null; error?:string }
export interface PreparedNetlist { source:string; executable:string; analysis:RawAnalysis; notes:string[]; noise?:RawNoiseSettings; step?:RawStep; measurements?:RawMeasurement[]; sweepLabel?:string }
export interface RawNetlistResult {
  analysis:RawAnalysis; netlist:string; timestamp:number; engine:string; elapsed:number; log:string; warnings:string[]
  points:number; x:number[]; xName:string; vectors:{name:string; values:number[]; imaginary?:number[]; unit?:string}[]
  noise?:RawNoiseSettings & {totalInput?:number;totalOutput?:number}
  sweepResults?:RawNetlistResult[]; sweepLabel?:string; executedNetlist?:string; measurements?:RawMeasurementValue[]
}
const fail=(line:number,message:string):never=>{throw new Error(`第 ${line} 行：${message}`)}
const allowedOptions=new Set(['reltol','abstol','vntol','chgtol','gmin','pivtol','pivrel','itl1','itl2','itl4','method','maxord','trtol','temp','tnom'])
function spiceNumber(text:string):number {
  const match=text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/i)
  if(!match)return NaN
  const suffix=match[2].toLowerCase(),scales:Record<string,number>={t:1e12,g:1e9,meg:1e6,k:1e3,mil:25.4e-6,m:1e-3,u:1e-6,n:1e-9,p:1e-12,f:1e-15}
  const prefix=suffix.startsWith('meg')?'meg':suffix.startsWith('mil')?'mil':suffix[0]
  // SPICE ignores trailing unit letters (10kHz); M means milli, Meg means mega.
  return Number(match[1])*(scales[prefix]??1)
}

/** This editor deliberately accepts a bounded, self-contained ngspice deck. */
export function prepareRawNetlist(source:string):PreparedNetlist {
  if(!source.trim())throw new Error('网表为空，请输入电路、分析指令和 .end。')
  if(source.length>250_000)throw new Error('网表超过 250 KB，请缩减模型内容。')
  const lines=source.replace(/\r\n?/g,'\n').split('\n'),out:string[]=[]
  if(!lines[0].trim()||/^[.*+]/.test(lines[0].trim()))fail(1,'第一行应为电路标题。')
  let control=false,ended=false,subcircuit=false,previousContinuation=false,analysis:RawAnalysis|undefined,converted=false,devices=0,noise:RawNoiseSettings|undefined,step:RawStep|undefined
  const measurements:RawMeasurement[]=[]
  const measure=(text:string,line:number)=>{
    if(subcircuit)fail(line,'测量指令不能放在 .subckt 内。')
    const match=text.match(/^\.meas(?:ure)?\s+(ac|tran|dc)\s+([a-z_][a-z0-9_]{0,63})\s+(MAX|MIN|PP|AVG|RMS|INTEG|FIND|WHEN|TRIG)\s+(.+)$/i)
    if(!match)fail(line,'MEAS 支持 .meas ac|tran|dc 名称 MAX|MIN|PP|AVG|RMS|INTEG|FIND|WHEN|TRIG ...；PARAM、OP、NOISE 暂不支持。')
    const [,kind,name,operation,body]=match!
    if(measurements.length>=64)fail(line,'每次最多 64 项 .meas 测量。')
    if(measurements.some(m=>m.name.toLowerCase()===name.toLowerCase()))fail(line,'测量名称必须唯一。')
    if(/\b(?:PARAM|PAR)\b|[{}]|["']/i.test(body))fail(line,'MEAS 暂不支持 PARAM、表达式或参数替换；请使用具体向量和数值。')
    if(operation.toUpperCase()==='TRIG'&&!/\bTARG\b/i.test(body))fail(line,'TRIG 测量需同时提供 TARG。')
    // The engine evaluates the rest of the native measurement grammar; it never becomes a command.
    measurements.push({name,analysis:kind.toLowerCase() as RawMeasurement['analysis'],operation:operation.toUpperCase(),directive:text})
  }
  const parseStep=(text:string,line:number)=>{
    if(step||subcircuit)fail(line,'每次仅支持一个顶层 .step 指令，不支持嵌套扫描。')
    const parts=text.trim().split(/\s+/),kind=parts[1]?.toLowerCase()
    const parameter=kind==='param',name=parameter?parts[2]:'temp',tail=parts.slice(parameter?3:2)
    if(!['param','temp'].includes(kind)||!name||!/^[a-z_][a-z0-9_]{0,39}$/i.test(name))fail(line,'STEP 格式：.step param 名称 list 数值... 或 起始 终止 步长；温度使用 .step temp。')
    let values:number[]
    if(tail[0]?.toLowerCase()==='list')values=tail.slice(1).map(spiceNumber)
    else{
      if(tail.length!==3)fail(line,'STEP 线性扫描需提供起始、终止和步长；对数扫描暂不支持。')
      const [start,stop,increment]=tail.map(spiceNumber)
      if(![start,stop,increment].every(Number.isFinite)||increment===0||(stop-start)*increment<0)fail(line,'STEP 步长必须非零且朝向终止值。')
      const count=Math.floor((stop-start)/increment+1e-10)+1
      if(count<1||count>24)fail(line,'STEP 每次最多 24 组，请缩小扫描范围。')
      values=Array.from({length:count},(_,i)=>Number((start+i*increment).toPrecision(15)))
    }
    if(!values.length||values.length>24||values.some(v=>!Number.isFinite(v)))fail(line,'STEP 需包含 1 至 24 个有限数值。')
    if(!parameter&&values.some(v=>v<=-273.15||v>1000))fail(line,'STEP 温度应高于 −273.15°C 且不超过 1000°C。')
    step={kind:parameter?'parameter':'temperature',name,values}
  }
  const analyse=(command:string,line:number)=>{
    const name=command.split(/\s+/)[0].toLowerCase() as RawAnalysis
    if(analysis)fail(line,'每次仅支持一个分析指令（AC / TRAN / OP / DC / NOISE）。')
    if(subcircuit)fail(line,'分析指令不能放在 .subckt 内。')
    const parts=command.trim().split(/\s+/)
    if(name==='op'&&parts.length!==1)fail(line,'OP 不接受额外参数。')
    if(name==='ac'&&(!/^(dec|oct|lin)$/i.test(parts[1]??'')||parts.length!==5))fail(line,'AC 格式：ac dec|oct|lin 点数 起始频率 终止频率。')
    if(name==='tran'&&(parts.length<3||parts.length>6))fail(line,'TRAN 格式：tran 步长 终止时间 [起始时间 [最大步长]] [uic]。')
    if(name==='dc'&&parts.length!==5)fail(line,'DC 格式：dc 源名称 起始值 终止值 步长；暂不支持嵌套扫描。')
    if(name==='noise'){
      const match=command.match(/^noise\s+(v\(\s*[^\s(),]+\s*(?:,\s*[^\s(),]+\s*)?\))\s+([vi][^\s()]+)\s+(dec|oct|lin)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/i)
      if(!match)fail(line,'NOISE 格式：noise v(输出节点[,参考节点]) 输入源 dec|oct|lin 点数 起始频率 终止频率 [汇总间隔]。')
      const [,output,source,sweep,countText,startText,stopText,intervalText]=match!
      const count=spiceNumber(countText),start=spiceNumber(startText),stop=spiceNumber(stopText)
      if(!Number.isInteger(count)||count<1||count>100_000)fail(line,'NOISE 点数应为 1 至 100,000 的正整数。')
      if(!Number.isFinite(start)||!Number.isFinite(stop)||start<=0||stop<=start)fail(line,'NOISE 频率应为正数，终止频率应大于起始频率（M 表示毫，Meg 表示兆）。')
      if(intervalText!==undefined&&(!Number.isInteger(spiceNumber(intervalText))||spiceNumber(intervalText)<0))fail(line,'NOISE 汇总间隔应为非负整数。')
      const points=sweep.toLowerCase()==='lin'?count:Math.floor(count*Math.log(stop/start)/Math.log(sweep.toLowerCase()==='oct'?2:10))+1
      if(!Number.isFinite(points)||points>100_000)fail(line,'NOISE 扫描超过 100,000 点，请减少点数或频率范围。')
      noise={output:output.replace(/\s/g,''),source,inputUnit:/^i/i.test(source)?'A':'V',sweep:sweep.toLowerCase() as RawNoiseSettings['sweep']}
    }
    analysis=name
  }
  for(let i=0;i<lines.length;i++){
    const original=lines[i],text=original.trim(),n=i+1
    if(i===0||!text||text.startsWith('*')){out.push(original);continue}
    if(ended)fail(n,'.end 后不能再有电路或命令。')
    // No command separators/substitution, file-backed source data, or external libraries.
    if(/[;`]|\$[({&]|(?:^|\s)!/.test(text))fail(n,'不支持命令分隔、shell 或变量命令替换；注释请单独使用 * 开头。')
    if(/\b(?:file|filename|file_name|infile|outfile)\s*=|\b(?:pwl|pwlfile)\s*\(\s*["']/i.test(text))fail(n,'不支持从文件读取源数据，请把数值和模型直接写入网表。')
    if(/^\.control\b/i.test(text)){
      if(control||subcircuit||text.toLowerCase()!=='.control')fail(n,'无效或嵌套的 .control。')
      control=true;converted=true;previousContinuation=false;out.push('* .control commands normalized to analysis directives');continue
    }
    if(/^\.endc\b/i.test(text)){
      if(!control||text.toLowerCase()!=='.endc')fail(n,'.endc 没有匹配的 .control。')
      control=false;previousContinuation=false;out.push('* .endc');continue
    }
    if(control){
      const command=text.split(/\s+/)[0].toLowerCase()
      if(['ac','tran','op','dc','noise'].includes(command)){analyse(text,n);out.push(`.${text}`)}
      else if(command==='save'&&/^save\s+[^\r\n]+$/i.test(text))out.push(`.${text}`)
      else if(['meas','measure'].includes(command)){measure(`.${text}`,n);out.push(`.${text}`)}
      else fail(n,`控制命令“${command}”不受支持；仅支持 save、ac、tran、op、dc、noise、meas。`)
      continue
    }
    if(text.startsWith('+')){
      if(!previousContinuation)fail(n,'续行必须紧接元件、.model、.param、.func 或 .subckt 定义。')
      out.push(original);continue
    }
    previousContinuation=false
    if(text.startsWith('.')){
      const command=text.split(/\s+/)[0].toLowerCase(),body=text.slice(command.length).trim()
      if(['.ac','.tran','.op','.dc','.noise'].includes(command))analyse(text.slice(1),n)
      else if(command==='.step'){parseStep(text,n);out.push(`* ${text} (expanded into independent solver runs)`);continue}
      else if(command==='.meas'||command==='.measure')measure(text,n)
      else if(command==='.end'){
        if(body||subcircuit)fail(n,'请先关闭 .subckt，并单独使用 .end。')
        ended=true
      }else if(command==='.subckt'){
        if(subcircuit||!body)fail(n,'不支持嵌套或空 .subckt。')
        subcircuit=true;previousContinuation=true
      }else if(command==='.ends'){
        if(!subcircuit)fail(n,'.ends 没有匹配的 .subckt。')
        subcircuit=false
      }else if(['.model','.param','.func'].includes(command)){
        if(!body)fail(n,`${command} 缺少定义。`)
        previousContinuation=true
      }else if(command==='.options'){
        for(const option of body.split(/\s+/)){
          const key=option.split('=')[0].toLowerCase()
          if(!allowedOptions.has(key)||!option.includes('='))fail(n,`暂不支持选项“${option}”；使用 key=value 格式。`)
        }
      }else if(!['.save','.ic','.nodeset','.global','.temp'].includes(command))fail(n,`不支持 ${command}；外部 .include / .lib 请先内联模型代码。`)
    }else{
      if(!/^[rclvidqjmexfghbkswzt][^\s]*\s+\S+/i.test(text))fail(n,'不支持的元件或命令。支持常规 ngspice 元件及内联 X 子电路，不支持外部代码模型。')
      devices++;previousContinuation=true
    }
    out.push(original)
  }
  if(control)fail(lines.length,'缺少 .endc。')
  if(subcircuit)fail(lines.length,'缺少 .ends。')
  if(!ended)fail(lines.length,'缺少 .end。')
  if(!analysis)throw new Error('缺少分析指令，请添加 .ac、.tran、.op、.dc 或 .noise。')
  if(!devices)throw new Error('网表没有可仿真的元件。')
  if(measurements.some(m=>m.analysis!==analysis))throw new Error('MEAS 的分析类型必须与本次网表分析相同。')
  let executable=out.join('\n')
  const notes=converted?['.control 内的 save / 分析命令按原参数转换为等价点指令执行；元件及模型参数保持原文。']:[]
  if(noise){const normalized=normalizeNoiseSaves(executable);if(normalized!==executable)notes.push('噪声分析将 .save 规范为 .save all，以同时保存噪声频谱和积分总噪声。');executable=normalized}
  if(step)notes.push(`STEP ${step.name} 将展开为 ${step.values.length} 次独立 ngspice 仿真；原始草稿保持完整。`)
  if(measurements.length)notes.push('.meas 由 ngspice 在本次分析后执行；未找到事件或求值失败会明确标记，不替换为零。')
  return{source,executable,analysis,notes,noise,...(step?{step}:{}),...(measurements.length?{measurements}:{})}
}

export function expandRawNetlist(prepared:PreparedNetlist):PreparedNetlist[]{
  if(!prepared.step)return[prepared]
  const {step,...base}=prepared
  return step.values.map(value=>{
    let executable=base.executable
    if(step.kind==='temperature'){
      executable=executable.replace(/^\s*\.temp\b[^\r\n]*$/gim,'* temperature overridden by .step temp')
      executable=executable.replace(/^([ \t]*\.options[ \t]+)([^\r\n]*)$/gim,(_whole,head:string,body:string)=>{const remaining=body.split(/\s+/).filter(item=>!/^temp=/i.test(item)).join(' ');return remaining.trim()?head+remaining:'* .options temp overridden by .step temp'})
    }
    const override=step.kind==='temperature'?`.temp ${value}`:`.param ${step.name}=${value}`
    executable=executable.replace(/^([ \t]*)\.end\s*$/im,`${override}\n$1.end`)
    return{...base,executable,sweepLabel:`${step.name} = ${value}${step.kind==='temperature'?' °C':''}`}
  })
}
export function parseRawMeasurements(log:string,definitions:readonly RawMeasurement[]):RawMeasurementValue[]{
  return definitions.map(definition=>{
    const escaped=definition.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),match=log.match(new RegExp(`^\\s*${escaped}\\s*=\\s*([+\\-\\d.eE]+)(?:\\s|$)`,'im')),value=match?Number(match[1]):NaN
    if(Number.isFinite(value))return{name:definition.name,value}
    const reason=log.match(new RegExp(`^.*(?:measure\\s+${escaped}\\b|\\b${escaped}\\b.*failed).*$`,'im'))?.[0].trim()
    return{name:definition.name,value:null,error:reason??'ngspice 未返回此测量的有限结果；请检查向量、阈值和区间。'}
  })
}

export function rawNetlistResult(raw:RawResult,prepared:PreparedNetlist,meta:{engine:string;elapsed:number;log:string;warnings:string[];measurementLog?:string}):RawNetlistResult{
  if(!raw||!Array.isArray(raw.data)||!Number.isInteger(raw.numPoints)||raw.numPoints<1)throw new Error('ngspice 没有返回有效向量，请检查网表与日志。')
  if(raw.numPoints>100_000||raw.data.length>512)throw new Error('结果超过 100,000 点或 512 个向量，请缩小扫描范围或用 .save 限定节点。')
  const real=(value:number|Complex)=>typeof value==='number'?value:value.real
  const frequency=prepared.analysis==='ac'||prepared.analysis==='noise'
  const scale=frequency?raw.data.find(v=>v.name.toLowerCase()==='frequency'):prepared.analysis==='tran'?raw.data.find(v=>v.name==='time'):prepared.analysis==='dc'?raw.data.find(v=>/^(?:v\()?v-sweep\)?$|^(?:i\()?i-sweep\)?$/i.test(v.name)):undefined
  if(prepared.analysis!=='op'&&!scale)throw new Error('结果缺少扫描坐标。')
  const x=scale?scale.values.map(real):[0]
  if(x.length!==raw.numPoints||x.some((v,i)=>!Number.isFinite(v)||(frequency&&v<=0)||(i>0&&(frequency?v<=x[i-1]:v===x[i-1]))))throw new Error('扫描坐标无效。')
  if(prepared.noise&&(raw.dataType!=='real'||!['onoise_spectrum','inoise_spectrum'].every(name=>raw.data.some(v=>v.name.toLowerCase()===name))))throw new Error('结果缺少噪声频谱向量；积分总噪声不能作为频谱显示。')
  const vectors=raw.data.filter(v=>v!==scale).map(v=>{
    if(v.values.length!==raw.numPoints)throw new Error(`向量 ${v.name} 长度与采样点不符。`)
    const values=v.values.map(real),imaginary=raw.dataType==='complex'?v.values.map(value=>typeof value==='number'?0:value.img):undefined
    if([...values,...imaginary??[]].some(value=>!Number.isFinite(value)))throw new Error(`向量 ${v.name} 含非有限值。`)
    if(prepared.noise&&values.some(value=>value<0))throw new Error(`噪声向量 ${v.name} 含负值。`)
    const unit=prepared.noise?`${/^inoise/i.test(v.name)?prepared.noise.inputUnit:'V'}/√Hz`:undefined
    return{name:v.name,values,imaginary,unit}
  })
  if(!vectors.length)throw new Error('没有保存可显示的向量，请检查 .save 指令。')
  const totals=(raw as NoiseSimulationResult).noiseTotals
  const noise=prepared.noise?{...prepared.noise,...(totals&&[totals.input,totals.output].every(v=>Number.isFinite(v)&&v>=0)?{totalInput:totals.input,totalOutput:totals.output}:{})}:undefined
  const {measurementLog,...details}=meta
  return{...details,analysis:prepared.analysis,netlist:prepared.source,timestamp:Date.now(),points:raw.numPoints,x,xName:scale?.name??'工作点',vectors,noise,
    ...(prepared.sweepLabel?{sweepLabel:prepared.sweepLabel}:{}),...(prepared.executable!==prepared.source?{executedNetlist:prepared.executable}:{}),...(prepared.measurements?{measurements:parseRawMeasurements(measurementLog??meta.log,prepared.measurements)}:{})}
}
