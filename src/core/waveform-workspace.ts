import { analysisSignals } from './circuit'
import { probeColors, resolveMeasurement, type Measurement } from './probes'
import { compatibleResults, type Complex, type Result } from './results'
import { evaluateWaveformExpression, parseWaveformExpression, type WaveformExpression } from './waveform-expression'
import type { WaveformAxisRanges } from './waveform-axis-settings'
import { waveformSignalColor, waveformSampleWindow } from './waveform-plot-details'

export type WaveformQuantity = 'voltage' | 'current' | 'transfer' | 'noise' | 'expression'
export type WaveformDisplay = 'magnitude' | 'phase'
export type WaveformDomain = readonly [number, number]
export interface WaveformSignal {
  id: string; name: string; kind: WaveformQuantity; color: string; measurementId?: string
  values: number[]; magnitude?: number[]; phase?: number[]
  unit?:string; complex?:Complex[]; expression?:string; powerPhasor?:boolean
}
export interface WaveformTrace extends WaveformSignal { x: number[]; y: number[]; unit: string; comparison?: boolean; sweep?:boolean; sourceResultId?:string }
export interface WaveformPanel {
  ids: string[]; primary?: string; display: WaveformDisplay; source: 'signals' | 'transfer'
  expressions?:WaveformExpression[]
  axisRanges?:WaveformAxisRanges
  solo?:boolean
  overlayIds?:string[]
}

export function upsertPanelExpression(panel:WaveformPanel,definition:WaveformExpression):WaveformPanel {
  parseWaveformExpression(definition.expression)
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(definition.id)||definition.name!==undefined&&(typeof definition.name!=='string'||definition.name.length>80||/[\u0000-\u001f]/.test(definition.name)))throw new Error('表达式编号或名称格式无效')
  const expressions=[...(panel.expressions??[]).filter(item=>item.id!==definition.id),{...definition}]
  if(expressions.length>24)throw new Error('每个视图最多 24 个表达式')
  const id=`expression:${definition.id}`
  return {...panel,source:'signals',expressions,ids:panel.solo?[id]:[...new Set([...panel.ids,id])],primary:id}
}

export function removePanelExpression(panel:WaveformPanel,id:string):WaveformPanel {
  const signalId=`expression:${id}`,ids=panel.ids.filter(value=>value!==signalId)
  return {...panel,expressions:(panel.expressions??[]).filter(item=>item.id!==id),ids,...(panel.primary===signalId?{primary:ids[0]}:{})}
}

const complete = (values: number[] | undefined, result: Result): values is number[] =>
  !!values && values.length === result.x.length && values.length > 0 && values.every(Number.isFinite)

function complexSeries(values: Complex[] | undefined, result: Result) {
  if (!values || values.length !== result.x.length || values.some(v => !Number.isFinite(v.real) || !Number.isFinite(v.img))) return null
  const phase: number[] = []
  for (const value of values) {
    let angle = Math.atan2(value.img, value.real) * 180 / Math.PI
    const previous = phase.at(-1)
    if (previous !== undefined) {
      while (angle - previous > 180) angle -= 360
      while (angle - previous < -180) angle += 360
    }
    phase.push(angle)
  }
  return { magnitude: values.map(v => 20 * Math.log10(Math.max(Math.hypot(v.real, v.img), 1e-15))), phase }
}

/** Only vectors saved by this result are candidates; unavailable probes stay explicit. */
export function waveformSignals(result: Result, measurements: Measurement[] = [], expressions:readonly WaveformExpression[] = []) {
  const signals: WaveformSignal[] = [], unavailable: string[] = []
  if(result.analysis==='noise'){
    for(const [id,name,values] of [['output','输出噪声 · onoise_spectrum',result.noise?.output],['input','输入等效噪声 · inoise_spectrum',result.noise?.input]] as const){
      if(complete(values,result))signals.push({id:`noise:${id}`,name,kind:'noise',values,color:probeColors[signals.length]})
    }
    for(const expression of expressions)unavailable.push(`${expression.name??expression.expression}：噪声分析不支持数学表达式`)
    return {signals,unavailable}
  }
  for (const measurement of measurements) {
    const trace = resolveMeasurement(result, measurement)
    if (trace) signals.push({ ...trace, id: `probe:${trace.id}`, name: `${trace.id} · ${trace.name}`, measurementId: trace.id })
    else unavailable.push(measurement.id)
  }
  const source = analysisSignals(result.project)
  const voltages = result.voltages ?? { [`v(${source.inputNode})`]: result.vin, [`v(${source.outputNode})`]: result.vout }
  const currents = result.currents ?? { [`i(${source.sourceId.toLowerCase()})`]: result.current }
  for (const [kind, vectors, complex] of [
    ['voltage', voltages, result.complexVoltages],
    ['current', currents, result.complexCurrents],
  ] as const) {
    for (const [name, values] of Object.entries(vectors)) {
      if (!complete(values, result)) continue
      const ac = result.analysis === 'ac' ? complexSeries(complex?.[name], result) : null
      if (result.analysis === 'ac' && !ac) continue
      signals.push({ id: `${kind}:${name}`, name, kind, values, ...(ac ? {...ac,complex:complex?.[name]} : {}), color: waveformSignalColor(`${kind}:${name}`) })
    }
  }
  if (result.analysis === 'ac' && complete(result.magnitude, result) && complete(result.phase, result)) {
    signals.push({ id: 'transfer', name: `V(${source.outputNode}) / V(${source.inputNode})`, kind: 'transfer', values: result.magnitude, magnitude: result.magnitude, phase: result.phase, color: probeColors[0] })
  }
  for(const definition of expressions){
    try {
      const evaluated=evaluateWaveformExpression(result,definition),ac=evaluated.complex?complexSeries(evaluated.complex,result):null
      signals.push({id:`expression:${definition.id}`,name:definition.name?.trim()||definition.expression,kind:'expression',expression:definition.expression,color:waveformSignalColor(`expression:${definition.id}`),...evaluated,...(ac??{})})
    }catch(error){unavailable.push(`${definition.name??definition.expression}：${(error as Error).message}`)}
  }
  return { signals, unavailable }
}

export function defaultWaveformPanels(result: Result, signals: WaveformSignal[], hasMeasurements = false): WaveformPanel[] {
  if(result.analysis==='noise')return [['noise:output','noise:input'],['noise:input'],[],[]].map(ids=>({ids:ids.filter(id=>signals.some(s=>s.id===id)),primary:ids[0],display:'magnitude',source:'signals'}))
  const probes = signals.filter(s => s.measurementId)
  const output = `voltage:v(${analysisSignals(result.project).outputNode})`.toLowerCase()
  const signalDefaults = probes.length || hasMeasurements ? probes.map(s => s.id) : signals.filter(s => s.kind === 'voltage').sort((a, b) => Number(b.id.toLowerCase() === output) - Number(a.id.toLowerCase() === output)).slice(0, 2).map(s => s.id)
  const source = !probes.length && !hasMeasurements && result.analysis === 'ac' && signals.some(s => s.id === 'transfer') ? 'transfer' : 'signals'
  const panel=(ids:string[],display:WaveformDisplay='magnitude',kind:WaveformPanel['source']='signals'):WaveformPanel=>({ids,primary:ids[0],display,source:kind})
  if(result.analysis==='ac')return source==='transfer'
    ? [panel(signalDefaults,'magnitude','transfer'),panel(signalDefaults,'phase','transfer'),panel(signalDefaults),panel([])]
    : [panel(signalDefaults),panel(signalDefaults,'phase'),panel([],'magnitude','transfer'),panel([])]
  const currents=signals.filter(s=>s.kind==='current'&&!s.measurementId).map(s=>s.id)
  return [panel(signalDefaults),panel(currents),panel([]),panel([])]
}

export function waveformUnit(result: Result, signal: WaveformSignal, display: WaveformDisplay): string {
  if(result.analysis==='noise')return signal.id==='noise:input'?`${result.noise?.inputUnit??'V'}/√Hz`:'V/√Hz'
  if(signal.kind==='expression'){
    const unit=signal.unit??'1'
    return result.analysis==='ac'?display==='phase'?'°':unit==='1'?'dB':unit==='V'?'dBV':unit==='A'?'dBA':unit==='W'?'dB(V·A)':`dB(${unit})`:unit
  }
  if (result.analysis === 'ac') return display === 'phase' ? '°' : signal.kind === 'transfer' ? 'dB' : signal.kind === 'current' ? 'dBA' : 'dBV'
  return signal.kind === 'current' ? 'A' : 'V'
}

export function waveformTraces(result: Result, comparison: Result | null, signals: WaveformSignal[], comparisonSignals: WaveformSignal[], panel: WaveformPanel, sweepComparisons:readonly Result[]=[], measurements:Measurement[]=[]): WaveformTrace[] {
  // Embedded previews and legacy callers may still supply only the base
  // catalogue. Resolve the panel's saved math definitions at the same handoff.
  const missing=(panel.expressions??[]).filter(item=>!signals.some(signal=>signal.id===`expression:${item.id}`))
  if(missing.length)signals=[...signals,...waveformSignals(result,[],missing).signals.filter(signal=>signal.kind==='expression')]
  if(comparison){
    const previousMissing=(panel.expressions??[]).filter(item=>!comparisonSignals.some(signal=>signal.id===`expression:${item.id}`))
    if(previousMissing.length)comparisonSignals=[...comparisonSignals,...waveformSignals(comparison,[],previousMissing).signals.filter(signal=>signal.kind==='expression')]
  }
  const selected = signals.filter(s => panel.source === 'transfer' ? s.id === 'transfer' : panel.ids.includes(s.id) && s.kind !== 'transfer')
  const trace = (signal: WaveformSignal, data: Result, comparison = false): WaveformTrace | null => {
    const y = data.analysis === 'ac' ? signal[panel.display] : signal.values
    return complete(y, data) ? { ...signal, id: comparison ? `comparison:${signal.id}` : signal.id, name: comparison ? `对比 · ${signal.name}` : signal.name, x: data.x, y, unit: waveformUnit(data, signal, panel.display), comparison, sourceResultId:data.id } : null
  }
  const traces = selected.flatMap(s => { const value = trace(s, result); return value ? [value] : [] })
  const sweepLeaves=sweepComparisons.filter(leaf=>leaf.id!==result.id&&compatibleResults(result,leaf))
  if(sweepComparisons.length){
    traces.forEach(value=>{value.name=`${result.sweepLabel??'当前参数'} · ${value.name}`;value.color=waveformSignalColor(`${result.sweepLabel??result.id}:${value.id}`)})
    sweepLeaves.forEach((leaf,leafIndex)=>{
      // A leaf carries the actual stepped project. Its aggregate experiment
      // describes the requested sweep and must never replace these values.
      const leafSignals=waveformSignals(leaf,measurements,panel.expressions).signals
      selected.forEach(signal=>{
        const resolved=leafSignals.find(candidate=>candidate.id===signal.id)
        if(!resolved)return
        const value=trace(resolved,leaf,true)
        if(value)traces.push({...value,id:`sweep:${leaf.id}:${resolved.id}`,name:`${leaf.sweepLabel??`参数 ${leafIndex+2}`} · ${resolved.name}`,color:waveformSignalColor(`${leaf.sweepLabel??leaf.id}:${resolved.id}`),sweep:true})
      })
    })
  }
  if (comparison && compatibleResults(result, comparison)) {
    for (const signal of selected) {
      const previous = comparisonSignals.find(s => s.id === signal.id)
      if (!previous) continue
      // Same measurement ID may resolve to a different named node after an edit;
      // resolveMeasurement above intentionally follows the saved circuit in each run.
      const value = trace({ ...previous, color: traces.find(value=>value.id===signal.id)?.color??signal.color }, comparison, true)
      if (value) traces.push(value)
    }
  }
  return traces
}

/** Shared normalized X window supports both linear time and logarithmic frequency. */
export function zoomWaveformDomain(domain: WaveformDomain, factor: number, anchor = .5): WaveformDomain {
  anchor = Math.max(0, Math.min(1, anchor))
  const width = Math.min(1, Math.max(1e-6, (domain[1] - domain[0]) / factor))
  const target = domain[0] + (domain[1] - domain[0]) * Math.max(0, Math.min(1, anchor))
  const start = Math.max(0, Math.min(1 - width, target - width * anchor))
  return [start, start + width]
}

export function panWaveformDomain(domain: WaveformDomain, fraction: number): WaveformDomain {
  const width = domain[1] - domain[0], start = Math.max(0, Math.min(1 - width, domain[0] + fraction * width))
  return [start, start + width]
}

export function waveformXBounds(result: Result, comparison: Result | null, sweepComparisons:readonly Result[]=[]): WaveformDomain {
  const logarithmic = result.analysis === 'ac' || result.analysis === 'noise'
  const transform = (x: number) => logarithmic ? Math.log10(x) : x
  const endpoints=(data:Result):WaveformDomain=>{const first=transform(data.x[0]),last=transform(data.x.at(-1)!);return [Math.min(first,last),Math.max(first,last)]}
  const current = endpoints(result)
  const others=[...(comparison?[comparison]:[]),...sweepComparisons].filter(candidate=>compatibleResults(result,candidate)&&candidate.x.length)
  const bounds=others.reduce<WaveformDomain>((bounds,candidate)=>[Math.min(bounds[0],endpoints(candidate)[0]),Math.max(bounds[1],endpoints(candidate)[1])],current)
  if(bounds[0]===bounds[1]){const padding=logarithmic?.05:Math.max(Math.abs(bounds[0])*.02,1e-6);return [bounds[0]-padding,bounds[1]+padding]}
  return bounds
}

export function waveformYBounds(traces: WaveformTrace[], unit: string, domain: WaveformDomain, logarithmic: boolean): WaveformDomain {
  let min = Infinity, max = -Infinity
  for (const trace of traces.filter(t => t.unit === unit)) {
    let hasVisibleSamples = false
    const range:WaveformDomain=logarithmic?[10**domain[0],10**domain[1]]:domain
    const window=waveformSampleWindow(trace,range)
    for (let i = window.first; i < window.end; i++) {
      if(!Number.isFinite(trace.y[i]))continue
      hasVisibleSamples = true
      min = Math.min(min, trace.y[i]); max = Math.max(max, trace.y[i])
    }
    // A narrow zoom can lie between samples; include the two surrounding values.
    if (!hasVisibleSamples) {
      const middle = logarithmic ? 10 ** ((domain[0] + domain[1]) / 2) : (domain[0] + domain[1]) / 2
      const increasing=trace.x.at(-1)!>=trace.x[0]
      const index = trace.x.findIndex(x => increasing?x>=middle:x<=middle)
      for (const i of [Math.max(0, index - 1), index < 0 ? trace.x.length - 1 : index]) {
        if(!Number.isFinite(trace.y[i]))continue
        min = Math.min(min, trace.y[i]); max = Math.max(max, trace.y[i])
      }
    }
  }
  if (!Number.isFinite(min)) return [0, 1]
  const padding = Math.max((max - min) * .12, unit.endsWith('/√Hz') ? Math.max(Math.abs(max)*.05,1e-18) : unit === 'A' ? 1e-12 : unit === 'V' ? 1e-6 : .1)
  return [min - padding, max + padding]
}

/** Spend the rendering budget on visible samples, retaining each pixel's edges and extrema. */
export function waveformPath(trace: WaveformTrace, px: (x: number) => number, py: (y: number) => number, budget = 1600, viewport?: { left: number; right: number }): string {
  const length = Math.min(trace.x.length, trace.y.length)
  if (!length) return ''
  const firstPixel=px(trace.x[0]),lastPixel=px(trace.x[length-1]),increasing=lastPixel>=firstPixel
  const left = viewport?.left ?? Math.min(firstPixel,lastPixel), right = viewport?.right ?? Math.max(firstPixel,lastPixel)
  if (Math.max(firstPixel,lastPixel) < left || Math.min(firstPixel,lastPixel) > right) return ''
  const lowerBound = (value: number) => {
    let lo = 0, hi = length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (increasing?px(trace.x[mid]) < value:px(trace.x[mid])>value) lo = mid + 1; else hi = mid }
    return lo
  }
  // Include adjoining samples so a segment crossing the viewport is not lost.
  const start = Math.max(0, lowerBound(increasing?left:right) - 1), end = Math.min(length - 1, lowerBound(increasing?right:left))
  const indices: number[] = []
  if (end - start + 1 <= budget * 4) {
    for (let i = start; i <= end; i++) indices.push(i)
  } else {
    const pixelWidth = Math.max((right - left) / Math.max(1, budget), 1e-12)
    for (let first = start; first <= end;) {
      const column = Math.floor((px(trace.x[first]) - left) / pixelWidth)
      let last = first, min = first, max = first, minLast = first, maxLast = first
      const gaps:number[]=[]
      if(!Number.isFinite(trace.y[first]))gaps.push(first)
      while (last < end && Math.floor((px(trace.x[last + 1]) - left) / pixelWidth) === column) {
        last++
        if(!Number.isFinite(trace.y[last])){gaps.push(last);continue}
        if(!Number.isFinite(trace.y[min]))min=minLast=last
        if(!Number.isFinite(trace.y[max]))max=maxLast=last
        if (trace.y[last] < trace.y[min]) min = minLast = last
        else if (trace.y[last] === trace.y[min]) minLast = last
        if (trace.y[last] > trace.y[max]) max = maxLast = last
        else if (trace.y[last] === trace.y[max]) maxLast = last
      }
      indices.push(...[...new Set([first, min, minLast, max, maxLast, last,...gaps])].sort((a, b) => a - b))
      first = last + 1
    }
  }
  let pen=false
  return indices.flatMap(i=>{
    const x=px(trace.x[i]),y=py(trace.y[i])
    if(!Number.isFinite(x)||!Number.isFinite(y)){pen=false;return []}
    const segment=`${pen?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`;pen=true;return [segment]
  }).join(' ')
}
