import {subcircuitInstanceParameterTail} from './subcircuit-parameters'
import { deviceSpice, referenceSourceSpice } from "./spice-elements"
import { branchCurrentSaveVectors } from './branch-current-vectors'
import { prepareRuntimeNetlist } from './spice-runtime-compatibility'
import { legacyDiodeRootsForModels } from './legacy-diode-provenance'
import { modelFor } from './devices'
import { deviceParameterValues } from './device-parameters'
import { importedModelNetlist, parseImportedModels, type ImportedSpiceModel } from './spice-models'
import { isConfiguredSource, sourceValues } from './sources'
import type { Measurement } from './probes'
import { parseProjectProbes } from './project-probes'
import { parseWaveformSetup, type WaveformSetup } from './waveform-setup'
import { parseReportConfiguration, type ReportConfiguration } from './report-settings'
import { parseSolverOptions, parseNodeVoltageSettings, validateSimulationOptions, solverOptionsDirective, nodeVoltageDirectives, dcSource, noiseNegativeNode, type SolverOptions, type NodeVoltageSetting } from './simulation-options'
import { parseProjectSweep, parseTemperature, simulationTemperature, type ProjectSweep } from './simulation-experiment'
export type TemplateId = 'rc-lowpass' | 'rc-highpass' | 'rlc-lowpass'
export type Analysis = 'ac' | 'tran' | 'op' | 'dc' | 'noise'
export type Quantity = 'resistance' | 'capacitance' | 'inductance' | 'frequency' | 'time' | 'voltage' | 'current' | 'gain'
export interface Project {
  schemaVersion: 1 | 2
  template: TemplateId | 'custom'
  drawing?: Drawing
  models?: ImportedSpiceModel[]
  probes?: Measurement[]
  waveformSetup?: WaveformSetup
  report?: ReportConfiguration
  temperature?: number
  sweep?: ProjectSweep
  title: string
  values: { R1: string; C1: string; L1: string }
  source: { amplitude: string; frequency: string; offset: string; dc: string; waveform: 'sine' | 'square' }
  analysis: Analysis
  ac: { start: string; stop: string; points: number; sweep?:'dec'|'oct'|'lin' }
  tran: { stop: string; step: string; start?:string; outputStep?:string; uic?:boolean }
  dc?: { start: string; stop: string; step: string; sourceId?:string }
  noise?: { negative?:Terminal|null; summaryInterval?:number }
  solver?:SolverOptions
  initialConditions?:NodeVoltageSetting[]
  nodeSets?:NodeVoltageSetting[]
}
export const defaultDc = { start:'0V',stop:'5V',step:'50mV' }
export const dcSweep = (p:Project):NonNullable<Project['dc']> => p.dc ?? defaultDc
export const templates = [
  { id: 'rc-lowpass' as const, name: 'RC 低通滤波器', english: 'LOW-PASS FILTER', short: 'RC · 低通', description: '保留低频，衰减高频信号。', order: '一阶 · 无源', letter: '01' },
  { id: 'rc-highpass' as const, name: 'RC 高通滤波器', english: 'HIGH-PASS FILTER', short: 'RC · 高通', description: '隔离直流，观察高频信号。', order: '一阶 · 无源', letter: '02' },
  { id: 'rlc-lowpass' as const, name: 'RLC 谐振电路', english: 'RESONANT LOW-PASS', short: 'RLC · 谐振', description: '探索谐振、阻尼与频率响应。', order: '二阶 · 无源', letter: '03' },
]
export function newProject(template: TemplateId = 'rc-lowpass'): Project {
  const t = templates.find(t => t.id === template)!
  return { schemaVersion: 1, template, title: t.name,
    values: { R1: template === 'rlc-lowpass' ? '120' : '1.6k', C1: '100nF', L1: '10mH' },
    source: { amplitude: '1V', frequency: '1kHz', offset: '0V', dc: '5V', waveform: 'sine' },
    analysis: 'ac', ac: { start: '10Hz', stop: '100kHz', points: 100 }, tran: { stop: '5ms', step: '2us' } }
}
const units: Record<Quantity, RegExp> = {
  resistance: /(?:ohms?|Ω|欧姆)$/i, capacitance: /(?:F|法拉)$/i,
  inductance: /(?:H|亨利)$/i, frequency: /(?:Hz|赫兹)$/i,
  time: /(?:s|秒)$/i, voltage: /(?:V|伏)$/i, current: /(?:A|安培)$/i, gain: /^$/,
}
export function parseQuantity(value: string, kind: Quantity): number {
  if (typeof value !== 'string' || value.length > 40) throw new Error('请输入有效数值')
  const clean = value.trim().replace(/\s+/g, '').replace(units[kind], '')
  const match = clean.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[TGMkKmunpfFµμ]?)$/i)
  if (!match) throw new Error(`无法识别“${value}”，请使用 1.6k、100nF、5ms 等格式`)
  const suffix = match[2]
  const scale: Record<string, number> = { '': 1, T: 1e12, G: 1e9, M: 1e6, k: 1e3, K: 1e3, m: 1e-3, u: 1e-6, µ: 1e-6, μ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, F: 1e-15 }
  const factor = suffix.toLowerCase() === 'meg' ? 1e6 : scale[suffix]
  const n = Number(match[1]) * factor
  if (!Number.isFinite(n)) throw new Error(`数值“${value}”无效`)
  return n
}
export function formatSI(n: number, unit = '', digits = 3): string {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return `0${unit ? ' ' + unit : ''}`
  const scales = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']] as const
  const [scale, prefix] = scales.find(([s]) => Math.abs(n) >= s) ?? scales[scales.length - 1]
  return `${Number((n / scale).toPrecision(digits))} ${prefix}${unit}`.trim()
}
export function validateProject(p: Project): string[] {
  const errors: string[] = validateSimulationOptions(p)
  try { if(p.temperature!==undefined)parseTemperature(p.temperature) } catch(error) { errors.push((error as Error).message) }
  try { if(p.sweep!==undefined)parseProjectSweep(p.sweep,p) } catch(error) { errors.push((error as Error).message) }
  let imported:ImportedSpiceModel[]=[]
  try { if(p.models!==undefined)imported=parseImportedModels(p.models) } catch(error) { errors.push(`模型库：${(error as Error).message}`) }
  const check = (label: string, value: string, kind: Quantity, min: number, max: number) => {
    try { const n = parseQuantity(value, kind); if (n < min || n > max) throw new Error(`允许范围 ${min}～${max}（基本单位）`); return n }
    catch (e) { errors.push(`${label}：${(e as Error).message}`); return NaN }
  }
  if (p.template === 'custom') {
    if (!p.drawing) errors.push('缺少自由原理图')
    else {
      for (const part of p.drawing.devices) {
        try { deviceParameterValues(part) } catch(e) { errors.push(`${part.id}：${(e as Error).message}`) }
        if(isConfiguredSource(part))try{
          const source=sourceValues(part)
          if((p.analysis==='ac'||p.analysis==='noise')&&part.id===p.drawing.sourceId&&source.acAmplitude===0)errors.push(`${part.id}：输入参考源的 AC 幅度须大于零，才能计算传递函数或输入等效噪声`)
          const frequency=source.waveform==='sine'?source.values.frequency:source.waveform==='pulse'?1/source.values.period:undefined
          if(p.analysis==='tran'&&frequency&&parseQuantity(p.tran.step,'time')*frequency>.05)errors.push(`${part.id}：最大步长应不大于激励周期的 1/20`)
        }catch{/* Parameter errors are reported above. */}
        if (part.kind === 'R') check(part.id,part.value,'resistance',0.01,1e9)
        if (part.kind === 'C') check(part.id,part.value,'capacitance',1e-12,1)
        if (part.kind === 'L') check(part.id,part.value,'inductance',1e-9,1e3)
        if (part.kind === 'I') check(part.id,part.value,'current',-1000,1000)
        if (part.kind === 'OP') check(part.id,part.value,'gain',1,1e9)
        if (['D','Q','M','J','X'].includes(part.kind) && !modelFor(part.kind,part.value,imported)) errors.push(`${part.id}：请选择受支持的器件模型`)
        if(part.kind==='X'){
          const model=imported.find(item=>item.kind==='X'&&item.id.toLowerCase()===part.value.toLowerCase())
          if(model)try{subcircuitInstanceParameterTail(part,model)}catch(error){errors.push((error as Error).message)}
          if(model&&JSON.stringify(part.pins)!==JSON.stringify(model.pins))errors.push(`${part.id}：画布引脚与 .subckt ${model.id} 的端口顺序不一致，请重新放置器件`)
          if(model?.symbol?.shape==='ltspice'&&JSON.stringify(part.pinPositions)!==JSON.stringify(model.symbol.pins.map(pin=>({x:pin.x,y:pin.y}))))errors.push(`${part.id}：画布引脚坐标与 LTspice 符号不一致，请重新放置器件`)
        }
        if (part.kind === 'V' && part.id !== p.drawing.sourceId) check(part.id,part.value,'voltage',-1000,1000)
      }
      try { errors.push(...compileDrawing(p.drawing).errors) } catch (e) { errors.push((e as Error).message) }
    }
  } else {
    check('R1', p.values.R1, 'resistance', 0.01, 1e9)
    check('C1', p.values.C1, 'capacitance', 1e-12, 1)
    if (p.template === 'rlc-lowpass') check('L1', p.values.L1, 'inductance', 1e-9, 1e3)
  }
  const legacyInput=p.template!=='custom'||!p.drawing?.devices.some(part=>part.id===p.drawing?.sourceId&&isConfiguredSource(part))
  let frequency=NaN
  if(legacyInput){
    check('输入幅度', p.source.amplitude, 'voltage', 1e-6, 1000)
    frequency = check('信号频率', p.source.frequency, 'frequency', 0.01, 1e9)
    check('直流偏置', p.source.offset, 'voltage', -1000, 1000)
    check('直流电压', p.source.dc, 'voltage', -1000, 1000)
  }
  const start = check('起始频率', p.ac.start, 'frequency', 1e-6, 1e12)
  const stop = check('终止频率', p.ac.stop, 'frequency', 1e-6, 1e12)
  if (start >= stop) errors.push('终止频率必须大于起始频率')
  const acSweep=p.ac.sweep??'dec'
  if(!['dec','oct','lin'].includes(acSweep))errors.push('project.ac.sweep：只支持 dec、oct 或 lin')
  const minimum=acSweep==='lin'?2:1
  if (!Number.isInteger(p.ac.points) || p.ac.points < minimum || p.ac.points > 500) errors.push(`project.ac.points：${acSweep==='lin'?'总采样点数':acSweep==='oct'?'每倍频程采样点数':'每十倍频程采样点数'}应为 ${minimum}～500 的整数`)
  const duration = check('仿真时长', p.tran.stop, 'time', 1e-9, 100)
  const step = check('最大步长', p.tran.step, 'time', 1e-12, 1)
  if (step > duration / 10) errors.push('最大步长应不大于仿真时长的 1/10')
  if (duration / step > 30000) errors.push('时长 / 步长最多为 30,000，请增大步长或缩短时长')
  if (p.analysis === 'tran' && legacyInput && step * frequency > 0.05) errors.push('最大步长应不大于输入周期的 1/20')
  if(p.tran.start!==undefined){const start=check('project.tran.start',p.tran.start,'time',0,100);if(start>=duration)errors.push('project.tran.start：保存起点必须小于仿真终点')}
  if(p.tran.outputStep!==undefined)check('project.tran.outputStep',p.tran.outputStep,'time',1e-12,100)
  if(p.tran.uic!==undefined&&typeof p.tran.uic!=='boolean')errors.push('project.tran.uic：需要布尔值')
  if (p.analysis === 'dc') {
    try{
      const source=dcSource(p),sweep=dcSweep(p),low=check('project.dc.start',sweep.start,source.kind,-1000,1000),high=check('project.dc.stop',sweep.stop,source.kind,-1000,1000),increment=check('project.dc.step',sweep.step,source.kind,-1000,1000)
      if(high===low)errors.push('project.dc.stop：扫描终点不能等于起点')
      if(increment===0||Math.sign(increment)!==Math.sign(high-low))errors.push('project.dc.step：步进须非零，且方向与起点到终点一致')
      if(Math.abs(increment)>Math.abs(high-low))errors.push('project.dc.step：扫描步进不能大于扫描范围')
      if(Math.abs((high-low)/increment)>10000)errors.push('DC 扫描最多支持 10,001 点，请增大步进')
    }catch(error){errors.push((error as Error).message)}
  }
  return errors
}
export function parseProject(input: unknown, options: { allowDraft?: boolean } = {}): Project {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('project：需要项目 JSON 对象')
  const p = input as Record<string, unknown>
  const custom = p.schemaVersion === 2 && p.template === 'custom'
  if (!custom && (p.schemaVersion !== 1 || !templates.some(t => t.id === p.template))) throw new Error('project.schemaVersion / project.template：自由原理图需要 schemaVersion:2 和 template:"custom"；不支持该项目版本或电路类型')
  const base = newProject(custom ? 'rc-lowpass' : p.template as TemplateId)
  const values = p.values as Project['values']; const source = p.source as Project['source']; const ac = p.ac as Project['ac']; const tran = p.tran as Project['tran']
  for(const field of ['values','source','ac','tran'] as const)if(!p[field]||typeof p[field]!=='object'||Array.isArray(p[field]))throw new Error(`project.${field}：需要参数对象；项目缺少电路或分析设置`)
  if(!['ac','tran','op','dc','noise'].includes(String(p.analysis)))throw new Error('project.analysis：只支持 "ac"、"tran"、"op"、"dc" 或 "noise"')
  const strings:[string,unknown,string][]=[['title',p.title,'二阶低通滤波器'],['values.R1',values.R1,'1k'],['values.C1',values.C1,'100nF'],['values.L1',values.L1,'10mH'],['source.amplitude',source.amplitude,'1V'],['source.frequency',source.frequency,'1kHz'],['source.offset',source.offset,'0V'],['source.dc',source.dc,'5V'],['ac.start',ac.start,'10Hz'],['ac.stop',ac.stop,'100kHz'],['tran.stop',tran.stop,'5ms'],['tran.step',tran.step,'2us']]
  const invalid=strings.filter(([,value])=>typeof value!=='string'||value.length>80)
  if(invalid.length)throw new Error(`项目参数格式错误：${invalid.map(([field,,example])=>`project.${field} 需要最多 80 字符的字符串，例如 ${JSON.stringify(example)}`).join('；')}`)
  if(!['sine','square'].includes(source.waveform))throw new Error('project.source.waveform：只支持小写 "sine" 或 "square"')
  const clean: Project = { ...base, title: p.title as string, analysis: p.analysis as Analysis,
    values: { R1: values.R1, C1: values.C1, L1: values.L1 },
    source: { amplitude: source.amplitude, frequency: source.frequency, offset: source.offset, dc: source.dc, waveform: source.waveform },
    ac: { start: ac.start, stop: ac.stop, points: ac.points }, tran: { stop: tran.stop, step: tran.step } }
  if (p.dc !== undefined) {
    const dc=p.dc as Project['dc']
    if(!dc||typeof dc!=='object'||Array.isArray(dc))throw new Error('project.dc：DC 扫描参数需要对象')
    for(const field of ['start','stop','step'] as const)if(typeof dc[field]!=='string'||dc[field].length>40)throw new Error(`project.dc.${field}：DC 扫描参数需要最多 40 字符的数值字符串`)
    if(dc.sourceId!==undefined&&(typeof dc.sourceId!=='string'||!/^([VI])[A-Za-z0-9_]*$/.test(dc.sourceId)))throw new Error('project.dc.sourceId：需要独立电压或电流源编号')
    clean.dc={start:dc.start,stop:dc.stop,step:dc.step,...(dc.sourceId!==undefined?{sourceId:dc.sourceId}:{})}
  }
  if (custom) { clean.schemaVersion = 2; clean.template = 'custom'; clean.drawing = parseDrawing(p.drawing) }
  if(ac.sweep!==undefined){if(!['dec','oct','lin'].includes(ac.sweep))throw new Error('project.ac.sweep：只支持 dec、oct 或 lin');clean.ac.sweep=ac.sweep}
  for(const field of ['start','outputStep'] as const)if(tran[field]!==undefined){if(typeof tran[field]!=='string'||tran[field].length>40||/[\r\n]/.test(tran[field]))throw new Error(`project.tran.${field}：需要最多 40 字符的数值字符串`);clean.tran[field]=tran[field]}
  if(tran.uic!==undefined){if(typeof tran.uic!=='boolean')throw new Error('project.tran.uic：需要布尔值');clean.tran.uic=tran.uic}
  if(p.solver!==undefined)clean.solver=parseSolverOptions(p.solver,options)
  for(const field of ['initialConditions','nodeSets'] as const)if(p[field]!==undefined)clean[field]=parseNodeVoltageSettings(p[field],field,clean.drawing,options)
  if(p.noise!==undefined){
    if(!p.noise||typeof p.noise!=='object'||Array.isArray(p.noise))throw new Error('project.noise：需要参数对象')
    const noise=p.noise as NonNullable<Project['noise']>;clean.noise={}
    if(noise.summaryInterval!==undefined){if(!Number.isInteger(noise.summaryInterval)||noise.summaryInterval<0||noise.summaryInterval>10000)throw new Error('project.noise.summaryInterval：需要 0～10000 的整数');clean.noise.summaryInterval=noise.summaryInterval}
    if(noise.negative!==undefined)clean.noise.negative=noise.negative===null?null:parseNodeVoltageSettings([{at:noise.negative,value:'0'}],'nodeSets',clean.drawing,options)[0].at
  }
  if(p.models!==undefined)clean.models=parseImportedModels(p.models)
  if(p.probes!==undefined)clean.probes=parseProjectProbes(p.probes,clean.drawing)
  if(p.waveformSetup!==undefined)clean.waveformSetup=parseWaveformSetup(p.waveformSetup,clean)
  if(p.report!==undefined)clean.report=parseReportConfiguration(p.report)
  if(p.temperature!==undefined)clean.temperature=parseTemperature(p.temperature)
  if(p.sweep!==undefined)clean.sweep=parseProjectSweep(p.sweep,options.allowDraft?undefined:clean)
  if (custom && options.allowDraft) {
    if (typeof ac.points !== 'number' || !Number.isFinite(ac.points)) throw new Error('project.ac.points：采样点数需要有限数字，例如 100（不要写成字符串）')
    return clean
  }
  const errors = validateProject(clean)
  if (errors.length) throw new Error(errors[0])
  return clean
}
export type Point = [number, number]
export interface Part { id: string; kind: 'R' | 'C' | 'L' | 'V'; nodes: [string, string]; value: string; x: number; y: number; vertical: boolean }
export function circuitGraph(p: Project) {
  if (p.template === 'custom') throw new Error('自由原理图应使用 drawing 数据绘制')
  const source: Part = { id: 'V1', kind: 'V', nodes: ['vin', '0'], value: p.analysis === 'op' ? p.source.dc : p.analysis === 'ac' ? '1V' : p.source.amplitude, x: 130, y: 190, vertical: true }
  const groundY = 250
  if (p.template === 'rlc-lowpass') return {
    parts: [source, { id: 'R1', kind: 'R', nodes: ['vin', 'mid'], value: p.values.R1, x: 280, y: 130, vertical: false },
      { id: 'L1', kind: 'L', nodes: ['mid', 'vout'], value: p.values.L1, x: 465, y: 130, vertical: false },
      { id: 'C1', kind: 'C', nodes: ['vout', '0'], value: p.values.C1, x: 670, y: 190, vertical: true }] as Part[],
    wires: [[130,130,230,130],[330,130,415,130],[515,130,670,130]] as [number,number,number,number][], outX: 670, groundY,
  }
  const high = p.template === 'rc-highpass'
  return { parts: [source,
    { id: high ? 'C1' : 'R1', kind: high ? 'C' : 'R', nodes: ['vin', 'vout'], value: high ? p.values.C1 : p.values.R1, x: 350, y: 130, vertical: false },
    { id: high ? 'R1' : 'C1', kind: high ? 'R' : 'C', nodes: ['vout', '0'], value: high ? p.values.R1 : p.values.C1, x: 630, y: 190, vertical: true }] as Part[],
    wires: [[130,130,300,130],[400,130,630,130]] as [number,number,number,number][], outX: 630, groundY }
}
/** Analysis directive is independent of schematic completion. */
export function analysisDirective(p:Project):string {
  const sweep=dcSweep(p), mode=p.ac.sweep??'dec'
  if(p.analysis==='noise'){
    const {outputNode,sourceId}=analysisSignals(p),negative=noiseNegativeNode(p)
    return `.noise V(${outputNode}${negative==='0'?'':','+negative}) ${sourceId} ${mode} ${p.ac.points} ${parseQuantity(p.ac.start,'frequency')} ${parseQuantity(p.ac.stop,'frequency')}${p.noise?.summaryInterval!==undefined?' '+p.noise.summaryInterval:''}`
  }
  if(p.analysis==='ac')return `.ac ${mode} ${p.ac.points} ${parseQuantity(p.ac.start,'frequency')} ${parseQuantity(p.ac.stop,'frequency')}`
  if(p.analysis==='tran')return `.tran ${parseQuantity(p.tran.outputStep??p.tran.step,'time')} ${parseQuantity(p.tran.stop,'time')} ${parseQuantity(p.tran.start??'0','time')} ${parseQuantity(p.tran.step,'time')}${p.tran.uic?' uic':''}`
  if(p.analysis==='dc'){const source=dcSource(p);return `.dc ${source.id} ${parseQuantity(sweep.start,source.kind)} ${parseQuantity(sweep.stop,source.kind)} ${parseQuantity(sweep.step,source.kind)}`}
  return '.op'
}
/** Temporary solver instrumentation; never changes drawing topology or saved nodes. */
export interface NetlistInstrumentation {
  deviceNodes?: ReadonlyMap<string, readonly string[]>
  additionalElements?: readonly string[]
  saveVectors?: readonly string[]
}
export function generateNetlist(p: Project, instrumentation: NetlistInstrumentation = {}): string {
  const errors = validateProject(p)
  if (errors.length) throw new Error(errors.join('\n'))
  const source = referenceSourceSpice(p)
  const kinds = { R: 'resistance', C: 'capacitance', L: 'inductance' } as const
  const topology = p.template === 'custom' ? compileDrawing(p.drawing!) : null
  const usedModels=new Set<string>()
  const elements = topology ? topology.elements.map(({device:part,nodes})=>{
    const generated=deviceSpice(p,part,[...(instrumentation.deviceNodes?.get(part.id)??nodes)],topology.sourceId,source)
    for(const model of generated.models)usedModels.add(model)
    return generated.code
  }) : circuitGraph(p).parts.map(part=>part.kind==='V'?`V1 vin 0 ${source}`:`${part.id} ${part.nodes.join(' ')} ${parseQuantity(part.value,kinds[part.kind])}`)
  // Different imported ICs may share the same helper .subckt. Emit each helper
  // once, but reject conflicting definitions instead of silently selecting one.
  const subcircuits=new Map<string,string>(),subcircuitSources:string[]=[]
  for(const part of topology?.elements.map(item=>item.device).filter(device=>device.kind==='X')??[]){
    const model=p.models?.find(item=>item.kind==='X'&&item.id.toLowerCase()===part.value.toLowerCase())
    if(!model)continue
    const documented=importedModelNetlist(model)
    usedModels.delete(documented)
    // Execution adapters can change text length. Source attribution ends at the
    // first declaration, independently of whether the definition was lowered.
    const comments=documented.slice(0,documented.search(/^\.subckt\b/im)).trim()
    if(comments)subcircuitSources.push(comments)
    for(const block of model.spice.split(/\n(?=\.subckt\b)/i)){
      const name=block.match(/^\.subckt\s+(\S+)/i)?.[1]
      if(!name)throw new Error(`子电路 ${model.id} 源码结构无效`)
      const key=name.toLowerCase(),previous=subcircuits.get(key)
      if(previous&&previous!==block)throw new Error(`子电路依赖 ${name} 在多个模型中定义不同，请分别核对来源`)
      subcircuits.set(key,block)
    }
  }
  const analysis=analysisDirective(p)
  const signals = analysisSignals(p)
  const nodes=topology ? [...new Set(topology.nodes.values())].filter(n=>n!=='0') : [...new Set(circuitGraph(p).parts.flatMap(part=>part.nodes))].filter(n=>n!=='0')
  const sourceIds = topology ? topology.elements.filter(({device})=>device.kind==='V').map(({device})=>device.id) : [signals.sourceId]
  // ngspice runs both spectral and integrated noise plots. Named spectrum-only
  // saves suppress the integrated plot and abort the analysis; save all lets
  // the worker select and validate the actual noise spectrum afterward.
  const save = p.analysis==='noise' ? 'all' : [...new Set([...nodes.map(n=>`v(${n})`),...sourceIds.map(id=>`i(${id})`),...branchCurrentSaveVectors(p),...(instrumentation.saveVectors??[])])].join(' ')
  const sweepComments=p.sweep?[`* 扫描配置：${p.sweep.target} = ${p.sweep.values.join(', ')}`, '* 本文件为基础值单次网表；扫描由工作台逐值生成独立网表。']:[]
  return prepareRuntimeNetlist([`Fuxian - ${p.template}`,...(topology?.warnings??[]).map(message=>`* Connection warning: ${message}`),...sweepComments, ...elements,...(instrumentation.additionalElements??[]), ...usedModels,...new Set(subcircuitSources),...subcircuits.values(), solverOptionsDirective(p.solver),...nodeVoltageDirectives(p),...(p.temperature!==undefined?[`.temp ${p.temperature}`]:[]), analysis, `.save ${save}`, '.end'].join('\n'),legacyDiodeRootsForModels(p.models??[]))
}
export function analysisSignals(p: Project) {
  if (p.template !== 'custom') return { inputNode:'vin',outputNode:'vout',sourceId:'V1' }
  const { inputNode,outputNode,sourceId } = compileDrawing(p.drawing!)
  return { inputNode,outputNode,sourceId }
}
export function theoreticalFrequency(p: Project) {
  if (p.template === 'custom') return NaN
  const c = parseQuantity(p.values.C1, 'capacitance')
  return p.template === 'rlc-lowpass' ? 1 / (2 * Math.PI * Math.sqrt(parseQuantity(p.values.L1, 'inductance') * c)) : 1 / (2 * Math.PI * parseQuantity(p.values.R1, 'resistance') * c)
}
export function projectKey(p: Project) {
  const config={schemaVersion:p.schemaVersion,template:p.template,analysis:p.analysis,temperature:simulationTemperature(p),...(p.sweep?{sweep:p.sweep}:{}),source:{amplitude:p.source.amplitude,frequency:p.source.frequency,offset:p.source.offset,dc:p.source.dc,waveform:p.source.waveform},ac:{start:p.ac.start,stop:p.ac.stop,points:p.ac.points,sweep:p.ac.sweep??'dec'},tran:{stop:p.tran.stop,step:p.tran.step,start:p.tran.start??'0',outputStep:p.tran.outputStep??p.tran.step,uic:p.tran.uic??false},dc:{...dcSweep(p)},...(p.noise?{noise:p.noise}:{}),...(p.solver?{solver:parseSolverOptions(p.solver,{allowDraft:true})}:{}),...(p.initialConditions?.length?{initialConditions:p.initialConditions}:{}),...(p.nodeSets?.length?{nodeSets:p.nodeSets}:{})}
  if (p.template !== 'custom' || !p.drawing) return JSON.stringify({ ...config,values:{R1:p.values.R1,C1:p.values.C1,L1:p.values.L1} })
  // Layout and wire bend changes do not change the electrical experiment.
  const { devices,junctions,wires,sourceId,output,labels } = p.drawing
  const usedModelIds=new Set(devices.filter(device=>['D','Q','M','J','X'].includes(device.kind)).map(device=>device.value.toLowerCase()))
  const modelDefinitions=(p.models??[]).filter(model=>usedModelIds.has(model.id.toLowerCase())).map(model=>model.spice).sort()
  return JSON.stringify({ ...config,...(modelDefinitions.length?{models:modelDefinitions}:{}),drawing:{
    labels:(labels ?? []).map(({name,at})=>({name:name.toLowerCase(),at})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    devices:devices.map(({id,kind,value,params,pins}) => ({id,kind,value,...(pins?{pins}:{}),...(params?{params:Object.fromEntries(Object.entries(params).sort(([a],[b])=>a.localeCompare(b)))}:{})})).sort((a,b) => a.id.localeCompare(b.id)),
    junctions:junctions.map(j => j.id).sort(),
    wires:wires.map(({id,from,to}) => ({id,from,to})).sort((a,b) => a.id.localeCompare(b.id)),sourceId,output,
  } })
}
import { compileDrawing, parseDrawing, type Drawing, type Terminal } from './drawing'
