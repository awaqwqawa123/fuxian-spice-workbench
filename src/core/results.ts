import { type Analysis, type Project, projectKey, analysisSignals } from './circuit'
import { normalizeCurrentVector } from './branch-current-vectors'
import { compileDrawing } from './drawing'
import { dcSource } from './simulation-options'

export interface Complex { real: number; img: number }
export interface RawResult { dataType: 'real' | 'complex'; numPoints: number; data: { name: string; values: (number | Complex)[] }[]; noiseTotals?: { input: number; output: number } }
export interface NoiseResult { input: number[]; output: number[]; inputUnit: 'V' | 'A'; totalInput?: number; totalOutput?: number }
export interface Result {
  id: string; project: Project; key: string; analysis: Analysis; netlist: string; timestamp: number; elapsed: number
  engine: string; log: string; warnings: string[]; x: number[]; vin: number[]; vout: number[]; current: number[]
  voltages?: Record<string,number[]>;
  currents?: Record<string,number[]>;
  /** External pin current in amperes, positive into the device; DeviceId:zeroBasedPin. */
  terminalCurrents?: Record<string,number[]>;
  terminalCurrentMethods?: Record<string,string>;
  complexVoltages?: Record<string,Complex[]>;
  complexCurrents?: Record<string,Complex[]>;
  noise?: NoiseResult;
  experiment?: Project;
  sweepResults?: Result[];
  sweepLabel?: string;
  magnitude: number[]; phase: number[]; cutoff: number | null; peakDb: number | null; peakFrequency: number | null; points: number
}
export const dcSweepUnit = (project:Project):'V'|'A' => dcSource(project).kind==='current'?'A':'V'
export function resultXAxisUnit(result:Pick<Result,'analysis'|'project'>):'Hz'|'s'|'V'|'A'|'' {
  return result.analysis==='ac'||result.analysis==='noise'?'Hz':result.analysis==='dc'?dcSweepUnit(result.project):result.analysis==='tran'?'s':''
}
function real(v: number | Complex): number { return typeof v === 'number' ? v : v.real }
export function processResult(raw: RawResult, project: Project, netlist: string, elapsed: number, engine: string, log: string, warnings: string[]): Result {
  warnings=[...new Set([...warnings,...(project.template==='custom'&&project.drawing?compileDrawing(project.drawing).warnings:[])])]
  if (!raw || !Array.isArray(raw.data) || !Number.isInteger(raw.numPoints) || raw.numPoints < 1) throw new Error('ngspice 没有返回有效数据，请查看运行日志')
  if (raw.numPoints > 100000) throw new Error('自适应采样超过 100,000 点，请缩短时长或增大步长')
  const vector = (name: string) => raw.data.find(d => d.name.toLowerCase() === name.toLowerCase())?.values
  if(project.analysis==='noise'){
    const frequency=vector('frequency'),input=vector('inoise_spectrum'),output=vector('onoise_spectrum')
    if(raw.dataType!=='real'||!frequency||!input||!output||[frequency,input,output].some(values=>values.length!==raw.numPoints||values.some(value=>typeof value!=='number'||!Number.isFinite(value))))throw new Error('噪声分析缺少有效的频率、输入等效噪声或输出噪声谱密度')
    const x=frequency as number[],inputNoise=input as number[],outputNoise=output as number[]
    if(x.some((value,index)=>value<=0||index>0&&value<=x[index-1])||[inputNoise,outputNoise].some(values=>values.some(value=>value<0)))throw new Error('噪声分析返回了无效的频率或负噪声谱密度')
    const totals=raw.noiseTotals
    if(totals&&[totals.input,totals.output].some(value=>!Number.isFinite(value)||value<0))throw new Error('噪声分析返回了无效的积分噪声')
    return {id:crypto.randomUUID(),project:structuredClone(project),key:projectKey(project),analysis:'noise',netlist,elapsed,engine,log,warnings,timestamp:Date.now(),x:[...x],vin:[],vout:[],current:[],magnitude:[],phase:[],cutoff:null,peakDb:null,peakFrequency:null,points:raw.numPoints,
      noise:{input:[...inputNoise],output:[...outputNoise],inputUnit:'V',...(totals?{totalInput:totals.input,totalOutput:totals.output}:{})}}
  }
  const signals = analysisSignals(project)
  const a = vector(`v(${signals.inputNode})`), b = vector(`v(${signals.outputNode})`)
  if (!a || !b || a.length !== raw.numPoints || b.length !== raw.numPoints) throw new Error('仿真数据缺少 VIN 或 VOUT')
  const current = vector(`i(${signals.sourceId})`) ?? vector(`${signals.sourceId}#branch`)
  if (!current || current.length !== raw.numPoints) throw new Error('仿真数据缺少电源支路电流')
  const r: Result = { id: crypto.randomUUID(), project: structuredClone(project), key: projectKey(project), analysis: project.analysis, netlist, elapsed,
    engine, log, warnings, timestamp: Date.now(), x: [], vin: a.map(real), vout: b.map(real), current: current.map(real),
    magnitude: [], phase: [], cutoff: null, peakDb: null, peakFrequency: null, points: raw.numPoints }
  r.voltages=Object.fromEntries(raw.data.filter(d=>/^v\([a-zA-Z_][a-zA-Z0-9_]*\)$/.test(d.name)&&d.values.length===raw.numPoints&&d.name.toLowerCase()!=='v(v-sweep)').map(d=>[d.name.toLowerCase(),d.values.map(real)]))
  const currentVectors=raw.data.flatMap(d=>{const name=normalizeCurrentVector(d.name);return name&&name!=='i(i-sweep)'&&d.values.length===raw.numPoints?[{name,values:d.values}]:[]})
  r.currents=Object.fromEntries(currentVectors.map(d=>[d.name,d.values.map(real)]))
  if(project.analysis==='ac'){
    const complex=(v:number|Complex):Complex=>typeof v==='number'?{real:v,img:0}:{real:v.real,img:v.img}
    r.complexVoltages=Object.fromEntries(raw.data.filter(d=>Object.hasOwn(r.voltages!,d.name.toLowerCase())).map(d=>[d.name.toLowerCase(),d.values.map(complex)]))
    r.complexCurrents=Object.fromEntries(currentVectors.map(d=>[d.name,d.values.map(complex)]))
  }
  if (project.analysis === 'op') { if (raw.numPoints !== 1) throw new Error('直流工作点应只有一个采样点'); r.x = [0] }
  else {
    const coordinate=project.analysis==='dc'?(dcSweepUnit(project)==='A'?'i-sweep':'v-sweep'):project.analysis==='ac'?'frequency':'time'
    const x = vector(coordinate) ?? (project.analysis==='dc'?vector(`${dcSweepUnit(project)==='A'?'i':'v'}(${coordinate})`):undefined)
    if (!x || x.length !== raw.numPoints) throw new Error('仿真数据缺少扫描坐标')
    r.x = x.map(real)
    const direction=project.analysis==='dc'&&r.x.length>1?Math.sign(r.x[1]-r.x[0]):1
    if (r.x.some((v, i) => !Number.isFinite(v) || (project.analysis === 'ac' ? v <= 0 : project.analysis==='tran' && v < 0) || (i > 0 && (v-r.x[i-1])*direction <= 0))) throw new Error('仿真坐标无效')
  }
  if (project.analysis === 'ac') {
    if (raw.dataType !== 'complex') throw new Error('AC 分析没有返回复数电压')
    for (let i = 0; i < raw.numPoints; i++) {
      const input = a[i] as Complex, output = b[i] as Complex
      const denominator = input.real ** 2 + input.img ** 2
      if (denominator <= 0) throw new Error('AC 输入幅度为零，无法计算传递函数')
      const re = (output.real * input.real + output.img * input.img) / denominator
      const im = (output.img * input.real - output.real * input.img) / denominator
      r.magnitude.push(20 * Math.log10(Math.max(Math.hypot(re, im), 1e-15)))
      let phase = Math.atan2(im, re) * 180 / Math.PI
      if (i > 0) { while (phase - r.phase[i - 1] > 180) phase -= 360; while (phase - r.phase[i - 1] < -180) phase += 360 }
      r.phase.push(phase)
    }
    const threshold = -10 * Math.log10(2)
    for (let i = 1; i < r.x.length; i++) {
      const previous = r.magnitude[i - 1], next = r.magnitude[i]
      const crossed = project.template === 'rc-highpass' ? previous <= threshold && next >= threshold : previous >= threshold && next <= threshold
      if (crossed && previous !== next) {
        const t = (threshold - previous) / (next - previous)
        r.cutoff = 10 ** (Math.log10(r.x[i - 1]) + t * Math.log10(r.x[i] / r.x[i - 1]))
      }
    }
    r.peakDb = Math.max(...r.magnitude)
    r.peakFrequency = r.x[r.magnitude.indexOf(r.peakDb)]
    if (project.template === 'custom') r.cutoff = null
  }
  const arrays = [r.vin, r.vout, r.x, r.current, r.magnitude, r.phase, ...Object.values(r.voltages ?? {}),...Object.values(r.currents ?? {}),...Object.values({...r.complexVoltages,...r.complexCurrents}).map(values=>values.flatMap(v=>[v.real,v.img]))]
  if (arrays.some(a => a.some(v => !Number.isFinite(v)))) throw new Error('仿真返回非有限数值，结果不可用')
  return r
}
export function toCsv(r: Result): string {
  if(r.analysis==='noise'){
    if(!r.noise)throw new Error('噪声分析结果缺少噪声数据')
    return `frequency_Hz,output_noise_V_per_sqrt_Hz,input_noise_${r.noise.inputUnit}_per_sqrt_Hz\n`+r.x.map((x,index)=>[x,r.noise!.output[index],r.noise!.input[index]].join(',')).join('\n')
  }
  const ac = r.analysis === 'ac'
  const signals=analysisSignals(r.project)
  const extra=Object.entries(r.voltages ?? {}).filter(([name])=>![`v(${signals.inputNode})`,`v(${signals.outputNode})`].includes(name))
  const header = ac ? 'frequency_Hz,gain_dB,phase_deg' : `${r.analysis === 'op' ? 'point' : r.analysis==='dc' ? `sweep_${dcSweepUnit(r.project)}` : 'time_s'},vin_V,vout_V,source_current_A${extra.map(([name])=>`,${name}_V`).join('')}`
  const rows = r.x.map((x, i) => ac ? [x, r.magnitude[i], r.phase[i]] : [x, r.vin[i], r.vout[i], r.current[i] ?? '',...extra.map(([,values])=>values[i])])
  return header + '\n' + rows.map(row => row.join(',')).join('\n')
}
export function compatibleResults(a: Result, b: Result): boolean { return a.analysis === b.analysis && a.analysis !== 'op' && resultXAxisUnit(a)===resultXAxisUnit(b) }

/** Selecting a leaf preserves the experiment identity used by stale-result checks. */
export function experimentHistory(result: Result): Result[] {
  if (!result.sweepResults?.length) return [result]
  return result.sweepResults.map(leaf => ({ ...leaf, key: result.key, experiment: result.experiment, sweepResults: result.sweepResults }))
}

export function sweepCsv(result: Result): string {
  if (!result.sweepResults?.length) return toCsv(result)
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`
  const tables=result.sweepResults.map(leaf=>({leaf,lines:toCsv(leaf).split('\n')}))
  const columns=[...new Set(tables.flatMap(table=>table.lines[0].split(',')))]
  const rows=tables.flatMap(({leaf,lines})=>{
    const names=lines[0].split(',')
    return lines.slice(1).map(line=>{
      const values=line.split(',')
      return [quote(leaf.sweepLabel??''),String(leaf.project.temperature??27),...columns.map(name=>{const index=names.indexOf(name);return index<0?'':values[index]})].join(',')
    })
  })
  return ['sweep_label,temperature_C,'+columns.join(','),...rows].join('\n')
}
