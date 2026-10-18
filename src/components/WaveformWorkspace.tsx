import { Fragment, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { ChevronDown, Columns2, Grid2X2, Maximize2, Minus, Plus, RotateCcw, Ruler, ScanSearch, X, ArrowLeft, ArrowRight, ChartNoAxesCombined, SlidersHorizontal, FunctionSquare, Axis3D, Crosshair, Info, ScanLine, Expand } from 'lucide-react'
import { formatSI } from '../core/circuit'
import { nearestSample } from '../core/measurements'
import { waveformLinearAxis } from '../core/waveform-axis'
import type { Measurement } from '../core/probes'
import { resultXAxisUnit, type Result } from '../core/results'
import type { WaveformViewState } from '../core/canvas-waveform-store'
import WaveformExpressionEditor from './WaveformExpressionEditor'
import WaveformTraceBar from './WaveformTraceBar'
import WaveformAxisSettings from './WaveformAxisSettings'
import WaveformCursorNavigation from './WaveformCursorNavigation'
import { zoomWaveformAxisRanges, type WaveformAxisRanges } from '../core/waveform-axis-settings'
import { waveformSelectedCsv, waveformPlotSvg, waveformSvgPng, type WaveformExportApi, type WaveformExportContext, type WaveformExportMetadata } from '../core/waveform-export'
import { waveformSampleWindow } from '../core/waveform-plot-details'
export type { WaveformExportApi } from '../core/waveform-export'
import {
  defaultWaveformPanels, panWaveformDomain, waveformPath, waveformSignals, waveformTraces,
  waveformXBounds, waveformYBounds, zoomWaveformDomain,
  type WaveformDomain, type WaveformPanel, type WaveformSignal, type WaveformTrace,
} from '../core/waveform-workspace'

export interface ProbeWaveformRequest {id:string;sequence:number;panel?:number}
export interface WaveformInspectRequest {mode:'zoom'|'measure';sequence:number}
export interface WaveformFitRequest {sequence:number;kind?:'fit'|'reset'|'return'}
export interface WaveformInspectionState {
  resultId:string;panelIndex:number;domain:WaveformDomain;signal:WaveformTrace|null
  lensRange?:WaveformDomain;cursors:{a:number|null;b:number|null}
}
interface Props {
  /** Fixed main-page workspace; settings stay inside the region. */
  embedded?: boolean
  result: Result; comparison: Result | null; measurements?: Measurement[]
  sweepComparisons?:readonly Result[]
  probeRequest?:ProbeWaveformRequest|null; probeRequests?:readonly ProbeWaveformRequest[]
  selectedMeasurement?: string; onSelectMeasurement?: (id: string) => void
  onSnapshot?: (snapshot:WaveformSnapshot)=>void
  initialView?:WaveformViewState; onViewChange?:(view:WaveformViewState)=>void
  inspectRequest?:WaveformInspectRequest|null
  fitRequest?:WaveformFitRequest
  showRequest?:number
  onInspectionChange?:(state:WaveformInspectionState)=>void
  onSignalSelect?:(signal:WaveformSignal)=>void
  onExportReady?:(api:WaveformExportApi|null)=>void
  exportContext?:WaveformExportContext
  active?:boolean
}
export interface WaveformSnapshot {
  resultId:string; layout:1|2|4; domain:WaveformDomain; bounds:WaveformDomain
  panels:{traces:WaveformTrace[];primaryId?:string;axisRanges?:WaveformAxisRanges}[]
  cursors:{a:number|null;b:number|null}
  splitDirection?:'rows'|'columns';splitRatio?:number
}
interface SharedView {
  domain: WaveformDomain; bounds: WaveformDomain; hover: number | null
  cursors: { a: number | null; b: number | null }; active: 'a' | 'b' | null
  onHover: (x: number | null) => void; onPin: (x: number) => void
  onZoom: (factor: number, anchor?: number) => void; onPan: (fraction: number) => void
  onMoveCursor?: (name:'a'|'b',x:number)=>void
  onPanAxes?: (index:number,ranges:WaveformAxisRanges)=>void
}

const formatValue = (value: number, unit: string) => unit === 'A' || unit === 'V' || unit.endsWith('/√Hz') ? formatSI(value, unit, 5) : `${Number(value.toPrecision(5))} ${unit}`
const noMeasurements: Measurement[] = []
const noSweepComparisons:readonly Result[]=[]
const viewKey=(view:WaveformViewState)=>JSON.stringify({analysis:view.analysis,layout:view.layout,panels:view.panels,domain:view.domain,cursors:view.cursors,activePanel:view.activePanel??0,splitDirection:view.splitDirection??'rows',splitRatio:view.splitRatio??50,autoFit:view.autoFit??!view.panels.some(panel=>Object.keys(panel.axisRanges??{}).length)})

/** Grid labels should describe useful levels, not padded autoscale endpoints. */
function axisTicks([min,max]:WaveformDomain,target:number):number[] {
  const raw=(max-min)/Math.max(1,target),power=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].find(value=>value*power>=raw)!*power
  if(!Number.isFinite(step)||step<=0)return [min,max]
  const first=Math.ceil(min/step-1e-9),last=Math.floor(max/step+1e-9),ticks:number[]=[]
  for(let i=first;i<=last&&ticks.length<12;i++){const value=i*step;ticks.push(Math.abs(value)<step*1e-8?0:Number(value.toPrecision(15)))}
  return ticks.length>=2?ticks:[min,max]
}

function SignalPlot({ index, result, traces, primaryId, shared, interactive=true, selecting=false, selectionDomain, onSelectDomain, detail=false, reserveRightAxis=false, axisOrder, axisRanges, compact=false, active=true, onSelectTrace, suppressIdleReadout=false, pannable=interactive, onPanAxes=shared.onPanAxes? ranges=>shared.onPanAxes!(index,ranges):undefined }: {
  index: number; result: Result; traces: WaveformTrace[]; primaryId?: string; shared: SharedView; interactive?:boolean
  selecting?:boolean; selectionDomain?:WaveformDomain; onSelectDomain?:(domain:WaveformDomain,ranges?:WaveformAxisRanges)=>void; detail?:boolean
  reserveRightAxis?:boolean
  axisOrder?:readonly string[]
  axisRanges?:WaveformAxisRanges
  compact?:boolean
  suppressIdleReadout?:boolean
  pannable?:boolean; onPanAxes?:(ranges:WaveformAxisRanges)=>void
  active?:boolean;onSelectTrace?:(trace:WaveformTrace)=>void
}) {
  const svg = useRef<SVGSVGElement>(null), clipId = useId()
  const drag=useRef<{pointerId:number;kind:'range';start:number;startY:number;clientStart:number;clientStartY:number}|{pointerId:number;kind:'cursor';name:'a'|'b'}|{pointerId:number;kind:'pan';clientX:number;clientY:number}|null>(null)
  const [panning,setPanning]=useState(false),[selectionY,setSelectionY]=useState<WaveformDomain|null>(null)
  const suppressClick=useRef(false),[selection,setSelection]=useState<WaveformDomain|null>(null)
  // ResizeObserver reports the untransformed foreignObject layout. The parent
  // scales that entire layout once; a second fixed-width SVG scale made the
  // text in 2/4-plot frames much smaller than their legends and controls.
  const [size, setSize] = useState({ width: 800, height: 260 })
  const W = size.width
  const H = size.height
  const ac = result.analysis === 'ac' || result.analysis === 'noise', xUnit = ac ? 'Hz' : resultXAxisUnit(result)
  const units = useMemo(() => [...new Set(traces.map(t => t.unit))].sort((a,b)=>axisOrder?axisOrder.indexOf(a)-axisOrder.indexOf(b):0), [traces,axisOrder])
  const l = 68, r = units.length > 1||reserveRightAxis ? 70 : 22, top = 25, bottom = 36
  const plotWidth=Math.max(1,W-l-r),plotHeight=Math.max(1,H-top-bottom)
  const xTickCount=Math.max(2,Math.min(20,Math.floor(plotWidth/90)+1))
  const span = Math.max(shared.bounds[1] - shared.bounds[0], 1e-12)
  const xDomain: WaveformDomain = useMemo(() => [shared.bounds[0] + span * shared.domain[0], shared.bounds[0] + span * shared.domain[1]], [shared.bounds, shared.domain, span])
  const yDomains = useMemo(() => new Map(units.map(unit => [unit, axisRanges?.[unit] ?? waveformYBounds(traces, unit, xDomain, ac)])), [units, traces, xDomain, ac, axisRanges])
  const px = (x: number) => l + ((ac ? Math.log10(x) : x) - xDomain[0]) / (xDomain[1] - xDomain[0]) * plotWidth
  const py = (y: number, unit: string) => {
    const [min, max] = yDomains.get(unit)!
    return top + (max - y) / (max - min) * plotHeight
  }
  const xAxis = useMemo(() => {
    if (!ac) return waveformLinearAxis(xDomain, plotWidth, xUnit)
    const major = Array.from({ length: xTickCount }, (_, i) => xDomain[0] + (xDomain[1] - xDomain[0]) * i / (xTickCount - 1))
    const upper = 10 ** xDomain[1], spacing = (upper - 10 ** xDomain[0]) / (xTickCount - 1)
    const digits = Math.max(3, Math.min(12, Math.ceil(Math.log10(upper / spacing)) + 1))
    return { major, minor: [], labels: major.map(value => formatSI(10 ** value, xUnit, digits)) }
  }, [ac, xDomain, plotWidth, xTickCount, xUnit])
  const paths = useMemo(() => new Map(traces.map(trace => [trace.id, waveformPath(trace, px, y => py(y, trace.unit), Math.ceil(plotWidth), { left: l, right: W - r })])), [traces, xDomain, yDomains, W, H, l, r])
  const sampleMarks = useMemo(() => {
    const range:WaveformDomain=ac?[10**xDomain[0],10**xDomain[1]]:xDomain
    return new Map(traces.filter(trace=>!trace.comparison).map(trace=>{
      const window=waveformSampleWindow(trace,range)
      return [trace.id,window.count<=Math.min(180,plotWidth/5)?Array.from({length:window.count},(_,i)=>window.first+i):[]]
    }))
  },[traces,xDomain,ac,plotWidth])
  const fraction = (clientX: number) => {
    const box = svg.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, ((clientX - box.left) / box.width * W - l) / (W - l - r)))
  }
  const verticalFraction = (clientY: number) => {
    const box = svg.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, ((clientY - box.top) / box.height * H - top) / plotHeight))
  }
  const fromFraction = (f: number) => {
    const x = xDomain[0] + f * (xDomain[1] - xDomain[0])
    return ac ? 10 ** x : x
  }
  const normalized=(f:number)=>shared.domain[0]+f*(shared.domain[1]-shared.domain[0])
  const displaySelection=selection??selectionDomain
  const selectionX=(value:number)=>l+(value-shared.domain[0])/(shared.domain[1]-shared.domain[0])*(W-l-r)
  const clearDrag=()=>{drag.current=null;setSelection(null);setSelectionY(null);setPanning(false)}
  useEffect(()=>{if(!selecting&&drag.current?.kind==='range')clearDrag()},[selecting])
  useEffect(() => {
    if (!active || !svg.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect
      // A hidden plot reports zero while a dialog opens. Wait for usable layout.
      if(rect.width<=0||rect.height<=0)return
      setSize({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height || 260)),
      })
    })
    observer.observe(svg.current)
    return () => observer.disconnect()
  }, [traces.length > 0,active])
  useEffect(() => {
    const element = svg.current
    if (!element || !interactive || !active) return
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY) return
      event.preventDefault();event.stopPropagation()
      const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?element.getBoundingClientRect().height:1)
      const factor=Math.exp(-Math.max(-160,Math.min(160,delta))*.0025)
      // These plots are the expanded waveform view. Canvas previews retain frame resizing.
      if(!event.altKey)shared.onZoom(factor, fraction(event.clientX))
      if(!event.shiftKey&&onPanAxes)onPanAxes(zoomWaveformAxisRanges(Object.fromEntries(yDomains),factor,1-verticalFraction(event.clientY)))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  })
  const primary = traces.find(t => !t.comparison && t.id === primaryId) ?? traces.find(t => !t.comparison)
  const sample = (trace: WaveformTrace, target: number | null) => {
    if (target === null || target < Math.min(trace.x[0],trace.x.at(-1)!) || target > Math.max(trace.x[0],trace.x.at(-1)!)) return null
    const i = nearestSample(trace.x, target, ac)
    return { x: trace.x[i], y: trace.y[i] }
  }
  const a = primary ? sample(primary, shared.cursors.a) : null, b = primary ? sample(primary, shared.cursors.b) : null
  if (!traces.length) return <div className="wave-empty" role="status">此视图未显示曲线。打开“曲线”选择探针或已保存的节点。</div>
  return <>
    <svg ref={svg} className={`wave-plot${selecting?' is-selecting-range':''}${panning?' is-panning':''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`视图 ${index + 1} ${detail?'局部细节 ':''}${ac ? units[0] === '°' ? '相位频率波形' : '幅度频率波形' : '波形'}，${units.join(' / ')}`}
      data-x-start={xDomain[0]} data-x-end={xDomain[1]} tabIndex={interactive?0:undefined}
      onPointerDown={interactive||pannable?e=>{
        if(e.button===1&&pannable){
          e.preventDefault();e.stopPropagation();suppressClick.current=true;setPanning(true)
          drag.current={pointerId:e.pointerId,kind:'pan',clientX:e.clientX,clientY:e.clientY};e.currentTarget.setPointerCapture?.(e.pointerId);return
        }
        if(e.button!==0||!selecting)return
        e.preventDefault();suppressClick.current=true
        const start=normalized(fraction(e.clientX)),startY=verticalFraction(e.clientY);drag.current={pointerId:e.pointerId,kind:'range',start,startY,clientStart:e.clientX,clientStartY:e.clientY};setSelection([start,start]);setSelectionY([startY,startY]);e.currentTarget.setPointerCapture?.(e.pointerId)
      }:undefined}
      onPointerMove={interactive||pannable?e => {
        const current=drag.current,x=fromFraction(fraction(e.clientX))
        if(current&&current.pointerId!==e.pointerId)return
        if(current?.kind==='pan'){
          e.preventDefault();e.stopPropagation()
          const box=e.currentTarget.getBoundingClientRect(),dx=e.clientX-current.clientX,dy=e.clientY-current.clientY
          if(box.width>0&&dx)shared.onPan(-dx/box.width*W/plotWidth)
          if(box.height>0&&dy&&onPanAxes)onPanAxes(Object.fromEntries([...yDomains].map(([unit,[min,max]])=>{const shift=dy/box.height*H/plotHeight*(max-min);return [unit,[min+shift,max+shift]]})))
          current.clientX=e.clientX;current.clientY=e.clientY;return
        }
        if(interactive)shared.onHover(x)
        if(current?.kind==='range'){const end=normalized(fraction(e.clientX)),endY=verticalFraction(e.clientY);setSelection([Math.min(current.start,end),Math.max(current.start,end)]);setSelectionY([Math.min(current.startY,endY),Math.max(current.startY,endY)])}
        if(current?.kind==='cursor')shared.onMoveCursor?.(current.name,x)
      }:undefined}
      onPointerUp={interactive||pannable?e=>{
        const current=drag.current;if(!current||current.pointerId!==e.pointerId)return
        e.preventDefault();e.stopPropagation()
        if(current.kind==='range'&&(Math.abs(e.clientX-current.clientStart)>=4||Math.abs(e.clientY-current.clientStartY)>=4)){
          const end=normalized(fraction(e.clientX)),endY=verticalFraction(e.clientY)
          const selectedX:WaveformDomain=Math.abs(end-current.start)>1e-6&&Math.abs(e.clientX-current.clientStart)>=4?[Math.min(current.start,end),Math.max(current.start,end)]:shared.domain
          const yRange:WaveformDomain=Math.abs(e.clientY-current.clientStartY)>=4?[Math.min(current.startY,endY),Math.max(current.startY,endY)]:[0,1]
          const ranges:WaveformAxisRanges=Object.fromEntries([...yDomains].map(([unit,[min,max]])=>[unit,[min+(max-min)*(1-yRange[1]),min+(max-min)*(1-yRange[0])] as WaveformDomain]))
          if(yRange[1]-yRange[0]>1e-6)onSelectDomain?.(selectedX,ranges)
        }
        if(current.kind==='cursor')shared.onMoveCursor?.(current.name,fromFraction(fraction(e.clientX)))
        clearDrag();if(e.currentTarget.hasPointerCapture?.(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)
      }:undefined}
      onPointerCancel={interactive||pannable?clearDrag:undefined} onLostPointerCapture={interactive||pannable?clearDrag:undefined}
      onAuxClick={pannable?e=>{if(e.button===1){e.preventDefault();e.stopPropagation();suppressClick.current=false}}:undefined}
      onPointerLeave={interactive?() => {if(!drag.current)shared.onHover(null)}:undefined}
      onClick={interactive?e => {if(suppressClick.current){suppressClick.current=false;return}if(!selecting)shared.onPin(fromFraction(fraction(e.clientX)))}:undefined}
      onKeyDown={interactive?e => { if(e.key==='Escape'){clearDrag();return}if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); shared.onPan(e.key === 'ArrowLeft' ? -.25 : .25) } }:undefined}>
      <defs><clipPath id={clipId}><rect x={l} y={top} width={plotWidth} height={plotHeight} /></clipPath></defs>
      <rect className="wave-plot-boundary" x={l} y={top} width={plotWidth} height={plotHeight} fill="none"/>
      {units.map((unit, axis) => {
        const [min, max] = yDomains.get(unit)!, axisX = axis === 0 ? l - 7 : W - r + 7
        const ticks=axisTicks([min,max],H>=190?5:3)
        return <g key={unit} data-wave-axis={unit} data-y-min={min} data-y-max={max} data-axis-fixed={axisRanges?.[unit] ? 'true' : undefined} className={`wave-axis ${axis === 1 ? 'wave-axis-right' : ''}`}>
          <text x={axisX} y={13} textAnchor={axis === 0 ? 'end' : 'start'} className="wave-axis-unit">{unit}</text>
          {ticks.map(value => <g key={value}>
            {axis === 0 && <line x1={l} x2={W - r} y1={py(value, unit)} y2={py(value, unit)} className="wave-grid" />}
            <text x={axisX} y={py(value, unit) + 3} textAnchor={axis === 0 ? 'end' : 'start'}>{unit === 'A' || unit === 'V' ? formatSI(value, '', 3) : Number(value.toPrecision(3))}</text>
          </g>)}
        </g>
      })}
      {xAxis.minor.map(value => <line key={value} data-wave-x-minor="true" x1={px(value)} x2={px(value)} y1={top} y2={H - bottom} className="wave-grid wave-grid-minor" />)}
      {xAxis.major.map((value, i) => <g key={value} data-wave-x-tick="true" data-wave-x-value={value}>
        <line x1={ac ? px(10 ** value) : px(value)} x2={ac ? px(10 ** value) : px(value)} y1={top} y2={H - bottom} className="wave-grid" />
        <text className="wave-axis" x={ac ? px(10 ** value) : px(value)} y={H - 17} textAnchor={i===0?'start':i===xAxis.major.length-1?'end':'middle'}>{xAxis.labels[i]}</text>
      </g>)}
      <text className="wave-axis wave-axis-unit" data-wave-x-unit={xUnit} x={W-r} y={H-3} textAnchor="end">{xUnit}</text>
      <g clipPath={`url(#${clipId})`}>
        {displaySelection&&<rect data-wave-range="true" className="wave-range-selection" x={selectionX(displaySelection[0])} y={top+plotHeight*(selectionY?.[0]??0)} width={Math.max(0,selectionX(displaySelection[1])-selectionX(displaySelection[0]))} height={plotHeight*((selectionY?.[1]??1)-(selectionY?.[0]??0))}/>}
        {traces.map(trace => <g key={trace.id}>
          <path data-wave-trace={trace.id} d={paths.get(trace.id)} fill="none" stroke={trace.color} strokeWidth={trace.id === primary?.id ? 2.1 : 1.6} opacity={trace.comparison&&!trace.sweep ? .75 : 1} strokeDasharray={trace.comparison&&!trace.sweep ? '6 4' : undefined} strokeLinejoin="round" />
          {interactive&&!trace.comparison&&onSelectTrace&&<path d={paths.get(trace.id)} fill="none" stroke="transparent" strokeWidth={8} className="wave-trace-hit" onClick={event=>{if(shared.active||selecting)return;event.stopPropagation();onSelectTrace(trace)}}><title>{trace.name} [{trace.unit}] · 选择曲线并定位电路对象</title></path>}
          {sampleMarks.get(trace.id)?.map(i=>Number.isFinite(trace.y[i])&&<circle key={i} data-wave-sample={i} cx={px(trace.x[i])} cy={py(trace.y[i],trace.unit)} r={1.8} fill={trace.color} pointerEvents="none" />)}
        </g>)}
        {shared.hover !== null && <g className="wave-hover"><line x1={px(shared.hover)} x2={px(shared.hover)} y1={top} y2={H - bottom} />{traces.filter(t => !t.comparison).map(trace => {
          const point = sample(trace, shared.hover)
          return point && <circle key={trace.id} cx={px(point.x)} cy={py(point.y, trace.unit)} r={3} fill={trace.color} />
        })}</g>}
        {(['a', 'b'] as const).map(name => {
          const x = shared.cursors[name], point = primary ? sample(primary, x) : null
          return x !== null && <g key={name} className={`wave-cursor wave-cursor-${name}${interactive?' is-draggable':''}`} data-wave-cursor={name}
            role={interactive?'slider':undefined} tabIndex={interactive?0:undefined} aria-label={interactive?`游标 ${name.toUpperCase()} 位置`:undefined} aria-valuemin={interactive?Math.min(result.x[0],result.x.at(-1)!):undefined} aria-valuemax={interactive?Math.max(result.x[0],result.x.at(-1)!):undefined} aria-valuenow={interactive?x:undefined} aria-valuetext={interactive?formatSI(x,xUnit,5):undefined}
            onPointerDown={interactive?e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();suppressClick.current=true;drag.current={pointerId:e.pointerId,kind:'cursor',name};svg.current?.setPointerCapture?.(e.pointerId)}:undefined}
            onKeyDown={interactive?e=>{if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;e.preventDefault();e.stopPropagation();const i=nearestSample(result.x,x,ac)+(e.key==='ArrowLeft'?-1:1)*(result.x.at(-1)!<result.x[0]?-1:1);shared.onMoveCursor?.(name,result.x[Math.max(0,Math.min(result.x.length-1,i))])}:undefined}>
            {interactive&&<line className="wave-cursor-hit" x1={px(x)} x2={px(x)} y1={top} y2={H-bottom}/>}
            <line x1={px(x)} x2={px(x)} y1={top} y2={H - bottom} /><text x={px(x) + 5} y={top + 12}>{name.toUpperCase()}</text>
            {point && primary && <circle cx={px(point.x)} cy={py(point.y, primary.unit)} r={4} fill="white" />}
          </g>
        })}
      </g>
    </svg>
    {interactive&&(!suppressIdleReadout || shared.hover!==null || selecting || detail)&&<div className="wave-readout" aria-live="off">
      {shared.hover === null ? <span>{selecting?'拖出矩形，同时放大横轴和纵轴':'滚轮缩放双轴 · Shift 仅横轴 / Alt 仅纵轴 · 中键拖动平移'}</span> : <><strong>{formatSI(shared.hover, xUnit, 5)}</strong>{(compact?primary?[primary]:[]:traces).map(trace => {
        const point = sample(trace, shared.hover)
        return <span key={trace.id} style={{ color: trace.color }}>{trace.name} {point ? formatValue(point.y, trace.unit) : '此处无样本'}</span>
      })}</>}
    </div>}
    {interactive&&(shared.cursors.a !== null || shared.cursors.b !== null) && primary && <div className="wave-cursor-readout">
      {!compact&&<strong>{primary.name}</strong>}
      {(['A', 'B'] as const).map((name, i) => { const point = i === 0 ? a : b; return shared.cursors[name.toLowerCase() as 'a' | 'b'] !== null && <span key={name}>{name}: {point ? `${formatSI(point.x, xUnit, 5)} / ${formatValue(point.y, primary.unit)}` : '此处无样本'}</span> })}
      {a && b && <><b>Δ{xUnit === 's' ? 't' : ac ? 'f' : 'V'}: {formatSI(b.x - a.x, xUnit, 5)}</b><b>ΔY: {formatValue(b.y - a.y, primary.unit)}</b>{!compact&&xUnit === 's' && b.x !== a.x && <span>1/|Δt|: {formatSI(1 / Math.abs(b.x - a.x), 'Hz', 5)}</span>}</>}
    </div>}
  </>
}

function EmbeddedCurvePicker({index,panel,signals,onChange,onDefault,availableHeight=500}:{index:number;panel:WaveformPanel;signals:WaveformSignal[];onChange:(values:Partial<WaveformPanel>)=>void;onDefault:()=>void;availableHeight?:number}) {
  const [page,setPage]=useState(0),pageSize=availableHeight<220?1:availableHeight<350?2:5,total=Math.max(1,Math.ceil(signals.length/pageSize)),currentPage=Math.min(page,total-1)
  return <section className="wave-embedded-curves" aria-label={`视图 ${index+1} 曲线选择`}>
    <div className="wave-embedded-pagination"><strong>可用 {signals.length} 条 · 已选 {panel.ids.length} 条</strong><button type="button" onClick={onDefault}>恢复默认</button></div>
    <p>电压与电流使用独立纵轴；测量对象在绘图页选择。</p>
    {signals.slice(currentPage*pageSize,(currentPage+1)*pageSize).map(signal=><label key={signal.id}><input type="checkbox" aria-label={`视图 ${index+1} 曲线 ${signal.name}`} checked={panel.source==='signals'&&panel.ids.includes(signal.id)} onChange={event=>onChange({source:'signals',ids:event.target.checked?[...new Set([...panel.ids,signal.id])]:panel.ids.filter(id=>id!==signal.id)})}/><i style={{background:signal.color}}/><span title={signal.name}>{signal.name}</span><small>{signal.kind==='current'?'电流':signal.kind==='noise'?'噪声':'电压'}</small></label>)}
    {!signals.length&&<p>此结果没有可用的探针 / 节点数据。</p>}
    <div className="wave-embedded-pagination"><button type="button" aria-label="上一页曲线" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>上一页</button><span>第 {currentPage+1} / {total} 页 · 每页 {pageSize} 条</span><button type="button" aria-label="下一页曲线" disabled={currentPage===total-1} onClick={()=>setPage(currentPage+1)}>下一页</button></div>
  </section>
}

/** Native disclosure keeps secondary actions keyboard accessible without another toolbar row. */
function WaveformTools({ children, active=false }: {children:import('react').ReactNode;active?:boolean}) {
  const disclosure=useRef<HTMLDetailsElement>(null),menu=useRef<HTMLDivElement>(null)
  const [position,setPosition]=useState<CSSProperties>({left:8,top:40,width:300})
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(!disclosure.current?.contains(event.target as Node))disclosure.current?.removeAttribute('open')}
    document.addEventListener('pointerdown',close)
    return()=>document.removeEventListener('pointerdown',close)
  },[])
  return <details ref={disclosure} className="wave-toolbar-tools" data-active={active||undefined} onToggle={event=>{
    if(!event.currentTarget.open)return
    const rect=event.currentTarget.querySelector('summary')!.getBoundingClientRect(),width=Math.min(300,window.innerWidth-16)
    const height=menu.current?.getBoundingClientRect().height??280
    setPosition({width,left:Math.max(8,Math.min(rect.right-width,window.innerWidth-width-8)),top:Math.max(8,Math.min(rect.bottom+5,window.innerHeight-height-8))})
  }} onClick={event=>{if(!event.currentTarget.open&&(event.target as HTMLElement).closest('button'))event.currentTarget.querySelector('summary')?.focus()}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus()}}}>
    <summary aria-label="波形工具" title="波形工具：布局、数学、坐标与信息"><SlidersHorizontal size={16}/></summary>
    <div ref={menu} className="wave-toolbar-tools-menu" style={position}>{children}</div>
  </details>
}

function Workspace({ result, comparison, sweepComparisons=noSweepComparisons, measurements = noMeasurements, selectedMeasurement, probeRequest, probeRequests, onSelectMeasurement, onSnapshot, initialView, onViewChange, inspectRequest, embedded=false, active:workspaceActive=true, fitRequest, showRequest, onInspectionChange, onSignalSelect, onExportReady, exportContext }: Props) {
  const embeddedRegion=useRef<HTMLElement>(null)
  const fullRegion=useRef<HTMLElement>(null)
  const [embeddedSize,setEmbeddedSize]=useState({width:600,height:500})
  const [embeddedTab,setEmbeddedTab]=useState<'plot'|'curves'|'expression'|'axes'|'cursor'|'info'|'navigation'>('plot')
  useEffect(()=>{if(showRequest)setEmbeddedTab('plot')},[showRequest])
  const [infoPage,setInfoPage]=useState(0)
  const [navigationPage,setNavigationPage]=useState(0)
  useEffect(()=>{
    if(!workspaceActive||!embedded||!embeddedRegion.current||typeof ResizeObserver==='undefined')return
    const observer=new ResizeObserver(entries=>{const rect=entries[0].contentRect;setEmbeddedSize({width:rect.width,height:rect.height})})
    observer.observe(embeddedRegion.current);return()=>observer.disconnect()
  },[embedded,workspaceActive])
  const catalogueCache=useRef<ReturnType<typeof waveformSignals>>({signals:[],unavailable:[]})
  const catalogue = useMemo(() => {
    if(workspaceActive)catalogueCache.current=waveformSignals(result, measurements)
    return catalogueCache.current
  }, [result, measurements,workspaceActive])
  const explicitProbeRouting=probeRequests!==undefined||probeRequest!==undefined
  const defaults = useMemo(() => defaultWaveformPanels(result, explicitProbeRouting?catalogue.signals.filter(signal=>!signal.measurementId):catalogue.signals, !explicitProbeRouting&&measurements.length > 0), [result, catalogue.signals, measurements.length,explicitProbeRouting])
  const [panels, setPanels] = useState<WaveformPanel[]>(initialView?.analysis===result.analysis?initialView.panels:defaults), [layout, setLayout] = useState<1 | 2 | 4>(initialView?.layout??1)
  const initialized=useRef(workspaceActive||initialView?.analysis===result.analysis)
  useEffect(()=>{if(workspaceActive&&!initialized.current){initialized.current=true;setPanels(defaults)}},[workspaceActive,defaults])
  const [domain, setDomain] = useState<WaveformDomain>(initialView?.analysis===result.analysis?initialView.domain:[0, 1]), [hover, setHover] = useState<number | null>(null)
  const [active, setActive] = useState<'a' | 'b' | null>(null), [cursors, setCursors] = useState<{ a: number | null; b: number | null }>(initialView?.analysis===result.analysis?initialView.cursors:{ a: null, b: null })
  const localSelection = useRef<string | null>(null),processedRequests=useRef(new Set<number>())
  const [activePanel,setActivePanel]=useState(initialView?.activePanel??0)
  const [splitDirection,setSplitDirection]=useState<'rows'|'columns'>(initialView?.splitDirection??'rows')
  const [splitRatio,setSplitRatio]=useState(initialView?.splitRatio??50)
  const [autoFit,setAutoFit]=useState(initialView?.autoFit??!panels.some(panel=>Object.keys(panel.axisRanges??{}).length))
  const [autoFitExplicit,setAutoFitExplicit]=useState(initialView?.autoFit!==undefined)
  const [draggingSplit,setDraggingSplit]=useState(false)
  // A magnifier is temporary inspection state. It must not change the saved
  // overview domain, plot arrangement, or the diagram's canvas geometry.
  const [inspectMode,setInspectMode]=useState<'zoom'|'measure'|null>(null)
  const [lens,setLens]=useState<{panel:number;domain:WaveformDomain;axisRanges?:WaveformAxisRanges}|null>(null)
  const [includeComparison,setIncludeComparison]=useState(false)
  const [previousCoordinates,setPreviousCoordinates]=useState<{domain:WaveformDomain;lens:typeof lens;ranges:(WaveformAxisRanges|undefined)[]}|null>(null)
  const handledFitRequest=useRef<number|null>(null)
  const handledInspectRequest=useRef<number|null>(null)
  const lastPublishedView=useRef<string|null>(null),pendingExternalView=useRef<string|null>(null)
  const initialViewKey=initialView?viewKey(initialView):null
  useEffect(()=>{
    if(!initialView||initialView.analysis!==result.analysis||initialViewKey===lastPublishedView.current)return
    pendingExternalView.current=viewKey(initialView)
    setPanels(initialView.panels);setLayout(initialView.layout);setDomain(initialView.domain);setCursors(initialView.cursors);setActivePanel(initialView.activePanel??0);setSplitDirection(initialView.splitDirection??'rows');setSplitRatio(initialView.splitRatio??50);setAutoFit(initialView.autoFit??!initialView.panels.some(panel=>Object.keys(panel.axisRanges??{}).length))
  },[initialViewKey,result.analysis])
  const bounds = useMemo(() => waveformXBounds(result, comparison,sweepComparisons), [result, comparison,sweepComparisons])
  const panelCatalogueCache=useRef<ReturnType<typeof waveformSignals>[]>(panels.map(()=>({signals:[],unavailable:[]})))
  const panelCatalogues=useMemo(()=>{
    if(workspaceActive)panelCatalogueCache.current=panels.map(panel=>waveformSignals(result,measurements,panel.expressions))
    return panelCatalogueCache.current
  },[panels,result,measurements,workspaceActive])
  const traceCache=useRef<WaveformTrace[][]>(panels.map(()=>[]))
  const traceGroups = useMemo(() => {
    if(workspaceActive)traceCache.current=panels.map((panel,index) => waveformTraces(result, comparison, panelCatalogues[index].signals, comparison?waveformSignals(comparison,measurements,panel.expressions).signals:[], panel,sweepComparisons,measurements))
    return traceCache.current
  }, [panels, result, comparison, panelCatalogues, measurements,sweepComparisons,workspaceActive])
  useEffect(()=>{if(workspaceActive)onSnapshot?.({resultId:result.id,layout,domain,bounds,cursors,splitDirection,splitRatio,panels:panels.slice(0,layout).map((panel,index)=>({traces:traceGroups[index],primaryId:panel.primary,axisRanges:panel.axisRanges}))})},[result.id,layout,domain,bounds,cursors,splitDirection,splitRatio,panels,traceGroups,onSnapshot,workspaceActive])
  useEffect(()=>{
    if(!workspaceActive)return
    const view={analysis:result.analysis,layout,panels,domain,cursors,activePanel,splitDirection,splitRatio,...(autoFitExplicit?{autoFit}:{})},key=viewKey(view)
    if(pendingExternalView.current&&pendingExternalView.current!==key)return
    pendingExternalView.current=null
    if(lastPublishedView.current===key)return
    lastPublishedView.current=key;onViewChange?.(view)
  },[result.analysis,layout,panels,domain,cursors,activePanel,splitDirection,splitRatio,autoFit,autoFitExplicit,onViewChange,workspaceActive])
  const ac = result.analysis === 'ac', frequency = ac || result.analysis === 'noise'
  const sampleAt=(x:number)=>result.x[nearestSample(result.x,Math.max(Math.min(result.x[0],result.x.at(-1)!),Math.min(Math.max(result.x[0],result.x.at(-1)!),x)),frequency)]
  const xAt=(value:number)=>{const x=bounds[0]+value*(bounds[1]-bounds[0]);return frequency?10**x:x}
  const actualRange=(value:WaveformDomain):WaveformDomain=>[xAt(value[0]),xAt(value[1])]
  const selectedPanel=Math.max(0,Math.min(layout-1,activePanel))
  const selectedTraces=traceGroups[selectedPanel]??[]
  const selectedSignal=selectedTraces.find(trace=>!trace.comparison&&trace.id===panels[selectedPanel].primary)??selectedTraces.find(trace=>!trace.comparison)??null
  const visibleRange=actualRange(domain),lensRange=lens?.panel===selectedPanel?actualRange(lens.domain):undefined
  const resolution=useMemo(()=>workspaceActive&&selectedSignal?waveformSampleWindow(selectedSignal,lensRange??visibleRange):null,[workspaceActive,selectedSignal,domain,bounds,lens,selectedPanel])
  useEffect(()=>{
    if(workspaceActive)onInspectionChange?.({resultId:result.id,panelIndex:selectedPanel,domain:visibleRange,signal:selectedSignal,lensRange,cursors})
  },[workspaceActive,result.id,selectedPanel,domain,bounds,selectedSignal,lens,cursors,onInspectionChange])
  function fitCoordinates(kind:'fit'|'reset'|'return'='fit') {
    if(kind==='return'){
      if(!previousCoordinates)return
      setDomain(previousCoordinates.domain);setLens(previousCoordinates.lens)
      setPanels(old=>old.map((panel,i)=>({...panel,axisRanges:previousCoordinates.ranges[i]})))
      setPreviousCoordinates(null)
    }else{
      setPreviousCoordinates({domain,lens,ranges:panels.map(panel=>panel.axisRanges)})
      const mainBounds=waveformXBounds(result,null)
      const span=bounds[1]-bounds[0]
      setDomain(includeComparison?[0,1]:[(mainBounds[0]-bounds[0])/span,(mainBounds[1]-bounds[0])/span])
      setLens(null);setHover(null)
      setPanels(old=>old.map((panel,i)=>kind==='fit'||i===selectedPanel?{...panel,axisRanges:undefined}:panel))
    }
    if(embedded)setEmbeddedTab('plot')
  }
  useEffect(()=>{
    if(!workspaceActive||!fitRequest||handledFitRequest.current===fitRequest.sequence)return
    handledFitRequest.current=fitRequest.sequence;fitCoordinates(fitRequest.kind)
  },[fitRequest?.sequence,fitRequest?.kind,workspaceActive])
  const exportCurrent=async(format:'svg'|'png'|'csv')=>{
    if(!workspaceActive)throw new Error('请展开当前波形后再导出。')
    const range=lensRange??visibleRange
    const metadata:WaveformExportMetadata={...exportContext,runId:result.id,timestamp:result.timestamp,engine:result.engine,analysis:result.analysis,panel:selectedPanel,range,xUnit:frequency?'Hz':resultXAxisUnit(result),traces:selectedTraces.map(trace=>({id:trace.id,name:trace.name,unit:trace.unit,runId:trace.sourceResultId??result.id,color:trace.color}))}
    const filename=`${(exportContext?.groupName??'waveform').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_')}-view${selectedPanel+1}.${format}`
    if(format==='csv')return {blob:new Blob(['\ufeff',waveformSelectedCsv(selectedTraces,[result,...comparison?[comparison]:[],...sweepComparisons],metadata)],{type:'text/csv;charset=utf-8'}),filename}
    const region=embedded?embeddedRegion.current:fullRegion.current
    const view=region?.querySelector(`[aria-label="波形视图 ${selectedPanel+1}"]`)
    const plot=(lensRange?view?.querySelector('.wave-detail .wave-plot'):null)??view?.querySelector('.wave-plot')
    if(!plot)throw new Error('请返回绘图页，再导出当前波形图。')
    const svg=waveformPlotSvg(plot as SVGSVGElement,metadata)
    return {blob:format==='svg'?new Blob([svg],{type:'image/svg+xml;charset=utf-8'}):await waveformSvgPng(svg),filename}
  }
  const exportHandler=useRef(exportCurrent);exportHandler.current=exportCurrent
  useEffect(()=>{
    if(!workspaceActive){onExportReady?.(null);return}
    onExportReady?.({exportCurrent:format=>exportHandler.current(format)})
    return()=>onExportReady?.(null)
  },[onExportReady,workspaceActive])
  function startInspect(mode:'zoom'|'measure') {
    setInspectMode(mode);setHover(null)
    if(embedded)setEmbeddedTab('plot')
    if(mode==='zoom')setActive(null)
    else {
      const span=domain[1]-domain[0]
      setCursors(old=>({a:old.a??sampleAt(xAt(domain[0]+span*.25)),b:old.b??sampleAt(xAt(domain[0]+span*.75))}));setActive(null)
    }
  }
  useEffect(()=>{
    if(!workspaceActive||!inspectRequest||handledInspectRequest.current===inspectRequest.sequence)return
    handledInspectRequest.current=inspectRequest.sequence;startInspect(inspectRequest.mode)
  },[inspectRequest?.sequence,inspectRequest?.mode,workspaceActive])
  useEffect(() => {
    const explicit=probeRequests!==undefined||probeRequest!==undefined
    const requests=probeRequests??(probeRequest?[probeRequest]:[])
    const pending=requests.filter(request=>!processedRequests.current.has(request.sequence)).flatMap(request=>{
      const signal=catalogue.signals.find(s=>s.measurementId===request.id)
      if(!signal)return [] // Keep waiting for actual vectors from the selected profile.
      processedRequests.current.add(request.sequence)
      return [{signal,index:Math.max(0,Math.min(3,Math.trunc(request.panel??activePanel)))}]
    })
    if(!explicit&&selectedMeasurement){
      if(selectedMeasurement===localSelection.current){localSelection.current=null;return}
      const signal=catalogue.signals.find(s=>s.measurementId===selectedMeasurement)
      if(signal)pending.push({signal,index:activePanel})
    }
    if(!pending.length)return
    setPanels(old=>old.map((panel,index)=>{
      const additions=pending.filter(item=>item.index===index)
      return additions.length?{...panel,source:'signals',primary:additions.at(-1)!.signal.id,ids:panel.solo?[additions.at(-1)!.signal.id]:[...new Set([...(panel.source==='signals'?panel.ids:[]),...additions.map(item=>item.signal.id)])]}:panel
    }))
  }, [selectedMeasurement,probeRequest,probeRequests,catalogue.signals,activePanel])
  const patch = (index: number, values: Partial<WaveformPanel>) => setPanels(old => old.map((panel, i) => {
    if(i!==index)return panel
    const next={...panel,...values,...(values.ids&&values.solo===undefined?{solo:false,overlayIds:undefined}:{})}
    // Hiding the measured trace or selecting the transfer plot must never
    // publish a primary ID that the saved panel does not contain.
    return next.primary!==undefined&&!next.ids.includes(next.primary)?{...next,primary:next.ids[0]}:next
  }))
  const zoom = (factor: number, anchor = .5) => setDomain(old => zoomWaveformDomain(old, factor, anchor))
  const zoomAll = (factor:number) => {
    zoom(factor);setAutoFitExplicit(true);setAutoFit(false)
    const visibleX:WaveformDomain=[bounds[0]+(bounds[1]-bounds[0])*domain[0],bounds[0]+(bounds[1]-bounds[0])*domain[1]]
    setPanels(old=>old.map((panel,index)=>{
      if(index>=layout)return panel
      const traces=traceGroups[index],units=[...new Set(traces.map(trace=>trace.unit))]
      const ranges=Object.fromEntries(units.map(unit=>[unit,panel.axisRanges?.[unit]??waveformYBounds(traces,unit,visibleX,frequency)]))
      return {...panel,axisRanges:zoomWaveformAxisRanges(ranges,factor)}
    }))
  }
  const pan = (fraction: number) => setDomain(old => panWaveformDomain(old, fraction))
  const shared: SharedView = { domain, bounds, hover, cursors, active, onHover: setHover, onZoom: zoom, onPan: pan,
    onPanAxes:(index,ranges)=>{setAutoFitExplicit(true);setAutoFit(false);patch(index,{axisRanges:ranges})},
    onMoveCursor:(name,x)=>{setCursors(old=>({...old,[name]:sampleAt(x)}));setActive(null)},
    onPin: x => {
      if (!active || x < Math.min(result.x[0],result.x.at(-1)!) || x > Math.max(result.x[0],result.x.at(-1)!)) return
      const sample = result.x[nearestSample(result.x, x, frequency)]
      setCursors(old => ({ ...old, [active]: sample })); setActive(active === 'a' ? 'b' : 'a')
    },
  }
  function choose(index: number, signal: WaveformSignal) {
    setActivePanel(index)
    // The bottom trace bar can add an unplotted probe directly. Preserve the target
    // panel's existing curves, axis settings and temporary detail window.
    setPanels(old=>old.map((panel,i)=>i!==index?panel:signal.kind==='transfer'
      ?{...panel,primary:panel.ids.includes(signal.id)?signal.id:panel.ids[0]}
      :{...panel,primary:signal.id,source:'signals',ids:panel.solo?[signal.id]:[...new Set([...(panel.source==='signals'?panel.ids:[]),signal.id])],...(autoFit?{axisRanges:undefined}:{})}))
    onSignalSelect?.(signal)
    if (signal.measurementId) { localSelection.current = signal.measurementId; onSelectMeasurement?.(signal.measurementId) }
  }
  function focusTrace(index:number,signal:WaveformSignal) {
    setPanels(old=>old.map((panel,i)=>i===index?{...panel,solo:true,overlayIds:panel.overlayIds??[...panel.ids],source:signal.kind==='transfer'?'transfer':'signals',ids:[signal.id],primary:signal.id,...(autoFit?{axisRanges:undefined}:{})}:panel))
    setActivePanel(index);onSignalSelect?.(signal)
    if(signal.measurementId){localSelection.current=signal.measurementId;onSelectMeasurement?.(signal.measurementId)}
  }
  function restoreOverlay(index:number) {
    setPanels(old=>old.map((panel,i)=>i===index?{...panel,solo:false,overlayIds:undefined,ids:[...new Set([...(panel.overlayIds??[]),...panel.ids])].slice(-128)}:panel))
  }
  function toggleAutoFit() {
    setAutoFitExplicit(true)
    if(autoFit){
      setPanels(old=>old.map((panel,i)=>{const range=lens?.panel===i?lens.domain:domain,xDomain=range.map(value=>bounds[0]+value*(bounds[1]-bounds[0])) as unknown as WaveformDomain;return {...panel,axisRanges:Object.fromEntries([...new Set((traceGroups[i]??[]).map(trace=>trace.unit))].map(unit=>[unit,waveformYBounds(traceGroups[i]??[],unit,xDomain,frequency)]))}}))
      setAutoFit(false)
    }else{setAutoFit(true);setPanels(old=>old.map(panel=>({...panel,axisRanges:undefined})));fitCoordinates()}
  }
  const updateSplit=(event:ReactPointerEvent<HTMLDivElement>)=>{
    const bounds=event.currentTarget.parentElement?.getBoundingClientRect()
    if(!bounds)return
    const length=splitDirection==='rows'?bounds.height:bounds.width
    if(length<=0)return
    const offset=splitDirection==='rows'?event.clientY-bounds.top:event.clientX-bounds.left
    setSplitRatio(Math.max(25,Math.min(75,Math.round(offset/length*100))))
  }
  if(embedded) {
    // A short results region keeps inspection actions on an in-place page,
    // leaving plot space intact without shrinking labels or creating a dialog.
    const condensed = embeddedSize.height < 390 || embeddedSize.width < 440
    const tight = embeddedSize.height < 280
    const formHeight = embeddedSize.height - 55
    const index=Math.max(0,Math.min(layout-1,activePanel)),panel=panels[index],traces=traceGroups[index]
    const current=traces.filter(trace=>!trace.comparison),primary=current.find(trace=>trace.id===panel.primary)??current[0]
    const xUnit=frequency?'Hz':resultXAxisUnit(result)
    const multi=layout>1&&((embeddedSize.width>=900&&embeddedSize.height>=470)||(embeddedSize.width>=620&&embeddedSize.height>=650))
    const allFour=layout===4&&embeddedSize.width>=950&&embeddedSize.height>=650
    const visible=allFour?[0,1,2,3]:multi?layout===4?(index<2?[0,1]:[2,3]):[0,1]:[index]
    const notices=[...new Set([...catalogue.unavailable,...panelCatalogues[index].unavailable])]
    for(const id of panel.ids.filter(id=>id.startsWith('expression:')))if(!panel.expressions?.some(item=>`expression:${item.id}`===id))notices.push(`${id}：缺少已保存的数学表达式定义`)
    if(comparison)notices.push('虚线为固定对比结果，仅显示两次仿真均有数据的同一对象。')
    if(ac&&panel.source==='signals'&&panel.display==='magnitude')notices.push('电压 0 dBV = 1 V；电流 0 dBA = 1 A。')
    if(current.some(trace=>trace.powerPhasor))notices.push('AC 电压与电流复数乘积的幅度相对 1 V·A，不代表实际平均功率。')
    if(traces.some(trace=>trace.sweep))notices.push(...traces.filter(trace=>trace.sweep||!trace.comparison).map(trace=>`${trace.name} [${trace.unit}]`))
    const infoItems=[...notices]
    if(resolution)infoItems.unshift(`当前曲线保留 ${resolution.count} 个真实样本，最大间距 ${formatSI(resolution.maximumStep,xUnit,4)}。若细节不足，请缩短仿真最大步长后重新运行。`)
    const infoPageSize=formHeight<350?1:3
    const infoTotal=Math.max(1,Math.ceil(infoItems.length/infoPageSize)),page=Math.min(infoPage,infoTotal-1)
    return <section ref={embeddedRegion} className="wave-workspace wave-workspace-embedded" aria-label="波形工作台" data-embedded-waveform="true" data-embedded-condensed={condensed} data-embedded-size={`${embeddedSize.width}x${embeddedSize.height}`} onKeyDown={event=>{if((event.target as HTMLElement).closest('input,select,textarea,button,[role=tab]'))event.stopPropagation()}}>
      <div className="wave-embedded-tabs wave-embedded-header" aria-label="波形顶部控件">
        <select hidden={layout===1} aria-label="当前波形视图" value={index} onChange={event=>setActivePanel(Number(event.target.value))}>{Array.from({length:layout},(_,i)=><option key={i} value={i}>视图 {i+1}</option>)}</select>
        <div role="tablist" aria-label="波形工作区页面">{([['plot','绘图',ChartNoAxesCombined],['curves','曲线',SlidersHorizontal],['cursor','游标',Crosshair]] as const).map(([value,label,Icon])=><button key={value} type="button" className="wave-icon-button" role="tab" aria-label={label} title={label} aria-selected={embeddedTab===value} aria-controls={`wave-embedded-page-${result.id}`} onClick={()=>{if(value==='cursor'&&inspectMode!=='measure')startInspect('measure');setEmbeddedTab(value)}}><Icon size={16}/></button>)}</div>
        {embeddedSize.width>=320&&<button type="button" className="wave-icon-button" title="局部放大：框选横轴和纵轴矩形范围" aria-label="局部放大" aria-pressed={inspectMode==='zoom'} onClick={()=>inspectMode==='zoom'?setInspectMode(null):startInspect('zoom')}><ScanSearch size={16}/></button>}
        {embeddedSize.width>=260&&<button type="button" className="wave-icon-button" title={autoFit?'自动适配已开启：新结果适配横轴，纵轴跟随可见曲线；点击固定当前视图':'开启自动适配视图'} aria-label="自动适配视图" aria-pressed={autoFit} onClick={toggleAutoFit}><ScanLine size={16}/></button>}
        {embeddedSize.width>=500&&<div className="wave-embedded-quick-zoom" role="group" aria-label="快捷缩放"><button type="button" className="wave-icon-button" title="放大横轴和各视图纵轴" aria-label="放大所有波形" onClick={()=>zoomAll(2)} disabled={domain[1]-domain[0]<=1e-6}><Plus size={16}/></button><button type="button" className="wave-icon-button" title="缩小横轴和各视图纵轴" aria-label="缩小所有波形" onClick={()=>zoomAll(.5)} ><Minus size={16}/></button></div>}
        <WaveformTools active={!['plot','curves','cursor'].includes(embeddedTab)}>
          <div className="wave-toolbar-tools-heading">视图与显示</div>
          <div className="wave-toolbar-tools-row"><select aria-label="波形视图布局" value={layout} onChange={event=>{const value=Number(event.target.value) as 1|2|4;setLayout(value);setActivePanel(old=>Math.min(old,value-1))}}><option value="1">单图</option><option value="2">双图</option><option value="4">四图</option></select>{ac&&<button type="button" aria-label="设置 Bode 增益相位双图" onClick={event=>{setLayout(2);setActivePanel(0);setEmbeddedTab('plot');setPanels(old=>old.map((item,i)=>i<2?{...item,source:'transfer',display:i===0?'magnitude':'phase'}:item));event.currentTarget.closest('details')!.open=false}}>Bode 双图</button>}</div>
          <div role="tablist" aria-label="波形详细工具">{([['expression','数学',FunctionSquare],['axes','坐标',Axis3D],['info',`信息${notices.length?` ${notices.length}`:''}`,Info]] as const).map(([value,label,Icon])=><button key={value} type="button" role="tab" aria-label={label} aria-selected={embeddedTab===value} aria-controls={`wave-embedded-page-${result.id}`} onClick={event=>{setEmbeddedTab(value);event.currentTarget.closest('details')!.open=false}}><Icon size={16}/>{label}</button>)}</div>
          <div className="wave-toolbar-tools-heading">共享横轴 / 游标</div>
          {embeddedSize.width<260&&<button type="button" aria-label="自动适配视图" aria-pressed={autoFit} onClick={toggleAutoFit}><ScanLine size={16}/>自动适配视图</button>}
          {embeddedSize.width<320&&<button type="button" aria-label="局部放大" aria-pressed={inspectMode==='zoom'} onClick={event=>{inspectMode==='zoom'?setInspectMode(null):startInspect('zoom');setEmbeddedTab('plot');event.currentTarget.closest('details')!.open=false}}><ScanSearch size={16}/>局部放大</button>}
          <div className="wave-embedded-zoom" role="group" aria-label="共享波形横轴"><button type="button" className="wave-icon-button" title="波形向左平移" aria-label="波形向左平移" disabled={domain[0]<=0} onClick={()=>pan(-.5)}><ArrowLeft size={16}/></button>{embeddedSize.width<500&&<><button type="button" className="wave-icon-button" title="放大横轴和各视图纵轴" aria-label="放大所有波形" onClick={()=>zoomAll(2)} disabled={domain[1]-domain[0]<=1e-6}><Plus size={16}/></button><button type="button" className="wave-icon-button" title="缩小横轴和各视图纵轴" aria-label="缩小所有波形" onClick={()=>zoomAll(.5)} ><Minus size={16}/></button></>}<button type="button" className="wave-icon-button" title="波形向右平移" aria-label="波形向右平移" disabled={domain[1]>=1} onClick={()=>pan(.5)}><ArrowRight size={16}/></button><button type="button" className="wave-icon-button" title="适配所有波形" aria-label="适配所有波形" onClick={()=>fitCoordinates()}><Expand size={16}/></button><button type="button" className="wave-icon-button" title="返回原范围" aria-label="返回原范围" disabled={!previousCoordinates} onClick={()=>fitCoordinates('return')}><RotateCcw size={16}/></button></div>
          <div className="wave-toolbar-tools-row"><button type="button" aria-label="A/B 测量" onClick={event=>{startInspect('measure');setEmbeddedTab('plot');event.currentTarget.closest('details')!.open=false}}><Ruler size={16}/>A/B 测量</button><button type="button" className="wave-embedded-navigation-toggle" aria-label="视图操作" aria-pressed={embeddedTab==='navigation'} onClick={event=>{setEmbeddedTab(embeddedTab==='navigation'?'plot':'navigation');event.currentTarget.closest('details')!.open=false}}>视图操作</button></div>
        </WaveformTools>
      </div>
      <div id={`wave-embedded-page-${result.id}`} className="wave-embedded-body" role="tabpanel" aria-label={`${{plot:'绘图',curves:'曲线',expression:'数学',axes:'坐标',cursor:'游标',info:'信息',navigation:'视图操作'}[embeddedTab]} · 视图 ${index+1}`}>
        {embeddedTab==='navigation'&&<section className="wave-embedded-navigation-page" aria-label="共享波形横轴操作"><p hidden={tight}>滚轮缩放双轴；Shift 仅横轴，Alt 仅纵轴；中键拖动平移。横轴同步，纵轴只调整当前视图。</p>{tight&&<select aria-label="视图操作页面" value={navigationPage} onChange={event=>setNavigationPage(Number(event.target.value))}><option value="0">布局与测量</option><option value="1">平移与缩放</option></select>}{tight&&<div className="wave-embedded-zoom" hidden={navigationPage!==0}><select aria-label="波形视图布局" value={layout} onChange={event=>{const value=Number(event.target.value) as 1|2|4;setLayout(value);setActivePanel(old=>Math.min(old,value-1))}}><option value="1">单图</option><option value="2">双图</option><option value="4">四图</option></select>{ac&&<button type="button" aria-label="设置 Bode 增益相位双图" onClick={()=>{setLayout(2);setActivePanel(0);setEmbeddedTab('plot');setPanels(old=>old.map((item,i)=>i<2?{...item,source:'transfer',display:i===0?'magnitude':'phase'}:item))}}>Bode</button>}<button type="button" aria-pressed={inspectMode==='zoom'} onClick={()=>{inspectMode==='zoom'?setInspectMode(null):startInspect('zoom');setEmbeddedTab('plot')}}><ScanSearch size={12}/>局部放大</button><button type="button" onClick={()=>{startInspect('measure');setEmbeddedTab('plot')}}><Ruler size={12}/>A/B 测量</button></div>}<div className="wave-embedded-zoom" hidden={tight&&navigationPage!==1} role="group" aria-label="共享波形横轴"><button type="button" className="wave-icon-button" title="波形向左平移" aria-label="波形向左平移" disabled={domain[0]<=0} onClick={()=>pan(-.5)}><ArrowLeft size={16}/></button><button type="button" className="wave-icon-button" title="放大横轴和各视图纵轴" aria-label="放大所有波形" onClick={()=>zoomAll(2)} disabled={domain[1]-domain[0]<=1e-6}><Plus size={16}/></button><button type="button" className="wave-icon-button" title="缩小横轴和各视图纵轴" aria-label="缩小所有波形" onClick={()=>zoomAll(.5)} ><Minus size={16}/></button><button type="button" className="wave-icon-button" title="波形向右平移" aria-label="波形向右平移" disabled={domain[1]>=1} onClick={()=>pan(.5)}><ArrowRight size={16}/></button><button type="button" className="wave-icon-button" title="适配所有波形" aria-label="适配所有波形" onClick={()=>{fitCoordinates();setEmbeddedTab('plot')}}><Expand size={16}/></button></div><button type="button" hidden={tight} onClick={()=>setEmbeddedTab('plot')}>返回绘图</button></section>}
        {embeddedTab!=='plot'&&<div className="wave-embedded-return"><button type="button" onClick={()=>setEmbeddedTab('plot')}>返回波形</button>{Object.keys(panel.axisRanges??{}).length>0&&<span data-wave-y-locked="true">纵轴已固定</span>}</div>}
        {embeddedTab==='plot'&&<>
          {(inspectMode==='zoom' || active || visible.length<layout || Object.keys(panel.axisRanges??{}).length>0)&&<div className="wave-embedded-state"><span title={resolution?`当前曲线有 ${resolution.count} 个真实保留样本，最大间距 ${formatSI(resolution.maximumStep,xUnit,4)}。放大后小圆点标记真实采样；若尖峰或边沿细节不足，请缩短仿真最大步长后重新运行，图形不会补造采样。`:undefined}>{lens?'局部细节':inspectMode==='zoom'?'横纵框选区间':active?`放置游标 ${active.toUpperCase()}`:resolution?`真实 ${resolution.count} 点 · 最大间距 ${formatSI(resolution.maximumStep,xUnit,3)}`:'X 轴 / 游标同步'}</span>{Object.keys(panel.axisRanges??{}).length>0&&<small data-wave-y-locked="true" title="适配所有波形可恢复横纵轴；坐标页可重置">纵轴已固定</small>}{visible.length<layout&&<small>显示 {visible.map(i=>i+1).join('、')} / {layout} 图</small>}</div>}
          <div className={`wave-embedded-plots wave-embedded-count-${visible.length}${embeddedSize.width>=900?' wave-embedded-wide':''}`}>
            {visible.map(i=>{
              const p=panels[i],group=traceGroups[i],own=group.filter(trace=>!trace.comparison),selected=own.find(trace=>trace.id===p.primary)??own[0],detail=lens?.panel===i
              return <section key={i} className={`wave-view wave-embedded-view${index===i?' is-probe-target':''}`} aria-label={`波形视图 ${i+1}`} onPointerDown={()=>setActivePanel(i)}>
                <SignalPlot suppressIdleReadout={tight} active={workspaceActive} onSelectTrace={trace=>choose(i,trace)} compact index={i} result={result} traces={group} primaryId={selected?.id} axisRanges={detail?lens!.axisRanges??p.axisRanges:p.axisRanges} detail={detail} shared={detail?{...shared,domain:lens!.domain,onPanAxes:(_index,ranges)=>setLens(old=>old?{...old,axisRanges:ranges}:null),onZoom:(factor,anchor=.5)=>setLens(old=>old?{...old,domain:zoomWaveformDomain(old.domain,factor,anchor)}:null),onPan:fraction=>setLens(old=>old?{...old,domain:panWaveformDomain(old.domain,fraction)}:null)}:shared} selecting={inspectMode==='zoom'} onSelectDomain={(next,ranges)=>{setLens({panel:i,domain:next,axisRanges:ranges});setInspectMode(null)}}/>
                <WaveformTraceBar index={i} result={result} panel={p} signals={panelCatalogues[i].signals} traces={group} measurements={measurements} onChange={next=>patch(i,next)} onSelect={trace=>choose(i,trace)} onTarget={()=>setActivePanel(i)} target={index===i} onSoloToggle={()=>p.solo?restoreOverlay(i):selected&&focusTrace(i,selected)} onReturnOverview={detail?()=>setLens(null):undefined} onDefault={()=>patch(i,{...defaults[i],source:'signals',solo:false,overlayIds:undefined})}/>
              </section>
            })}
          </div>
        </>}
        {embeddedTab==='curves'&&<><div className="wave-embedded-source">{ac&&<><select value={panel.source} aria-label={`视图 ${index+1} 图源`} onChange={event=>patch(index,{source:event.target.value as WaveformPanel['source']})}><option value="signals">探针 / 节点</option><option value="transfer">VOUT / VIN</option></select><select value={panel.display} aria-label={`视图 ${index+1} 显示内容`} onChange={event=>patch(index,{display:event.target.value as WaveformPanel['display']})}><option value="magnitude">幅度 / 增益</option><option value="phase">相位</option></select></>}</div><EmbeddedCurvePicker availableHeight={formHeight-(ac?36:0)} key={index} index={index} panel={panel} signals={panelCatalogues[index].signals.filter(signal=>signal.kind!=='transfer')} onChange={values=>patch(index,values)} onDefault={()=>patch(index,{...defaults[index],source:'signals'})}/></>}
        {embeddedTab==='expression'&&<WaveformExpressionEditor embedded availableHeight={formHeight} key={index} panel={panel} result={result} index={index} onChange={next=>patch(index,next)}/>}
        {embeddedTab==='axes'&&<><div className="wave-coordinate-actions" hidden={formHeight<350}><label><input type="checkbox" checked={includeComparison} onChange={event=>setIncludeComparison(event.target.checked)}/>适配时包含对比运行</label><button type="button" onClick={()=>fitCoordinates('reset')}>重置坐标</button><button type="button" disabled={!previousCoordinates} onClick={()=>fitCoordinates('return')}>返回原范围</button></div><WaveformAxisSettings embedded availableHeight={formHeight} includeComparison={includeComparison} onIncludeComparison={setIncludeComparison} onResetCoordinates={()=>fitCoordinates('reset')} onRestoreCoordinates={()=>fitCoordinates('return')} canRestoreCoordinates={!!previousCoordinates} key={index} index={index} panel={panel} traces={traces} bounds={bounds} domain={domain} xUnit={xUnit} logarithmic={frequency} onApply={(next,ranges)=>{setAutoFitExplicit(true);setAutoFit(false);setDomain(next);patch(index,{axisRanges:ranges});setEmbeddedTab('plot')}}/></>}
        {embeddedTab==='cursor'&&<div className="wave-embedded-cursors"><div className="wave-embedded-cursor-buttons" hidden={formHeight<350}>{(['a','b'] as const).map(name=><button type="button" key={name} aria-pressed={active===name} onClick={()=>{setActive(name);setEmbeddedTab('plot')}}>放置游标 {name.toUpperCase()}</button>)}<button type="button" onClick={()=>{setCursors({a:null,b:null});setActive(null)}}>清除游标</button></div><WaveformCursorNavigation availableHeight={formHeight} onPlace={name=>{setActive(name);setEmbeddedTab('plot')}} onClear={()=>{setCursors({a:null,b:null});setActive(null)}} index={index} traces={current} primaryId={primary?.id} cursors={cursors} range={lens?.panel===index?[xAt(lens.domain[0]),xAt(lens.domain[1])]:[xAt(domain[0]),xAt(domain[1])]} xUnit={xUnit} detail={lens?.panel===index} onSelect={trace=>choose(index,trace)} onMove={(name,x)=>{setCursors(old=>({...old,[name]:x}));setActive(null)}}/><p hidden={formHeight<350}>定位后切回绘图页查看读数；A / B 光标可拖动，左右方向键逐点移动。</p></div>}
        {embeddedTab==='info'&&<section className="wave-embedded-info"><p>本次结果 {notices.length} 条说明</p>{infoItems.slice(page*infoPageSize,(page+1)*infoPageSize).map((notice,i)=><p key={i} role="status">{notice}</p>)}{!infoItems.length&&<p>所有已选曲线均有有效数据。</p>}<div className="wave-embedded-pagination"><button type="button" disabled={page===0} onClick={()=>setInfoPage(page-1)}>上一页</button><span>{page+1} / {infoTotal} 页</span><button type="button" disabled={page===infoTotal-1} onClick={()=>setInfoPage(page+1)}>下一页</button></div></section>}
      </div>
    </section>
  }
  return <section ref={fullRegion} className="wave-workspace" aria-label="波形工作台">
    <div className="wave-toolbar">
      <div className="wave-inspection-buttons" role="group" aria-label="波形检查工具">
        <button type="button" aria-label="局部放大" title="局部放大" aria-pressed={inspectMode==='zoom'} onClick={()=>inspectMode==='zoom'?setInspectMode(null):startInspect('zoom')}><ScanSearch size={14}/><span>局部放大</span></button>
        <button type="button" aria-label="A/B 测量" title="A/B 测量" aria-pressed={inspectMode==='measure'} onClick={()=>startInspect('measure')}><Ruler size={14}/><span>A/B 测量</span></button>
      </div>
      <button className="wave-icon-button" title="自动适配视图" aria-label="自动适配视图" aria-pressed={autoFit} onClick={toggleAutoFit}><ScanLine size={16}/></button>
      <WaveformTools>
        <div className="wave-layout-buttons" role="group" aria-label="波形视图布局">
          {([1, 2, 4] as const).map(n => <button key={n} aria-pressed={layout === n} onClick={() => {setLayout(n);setActivePanel(old=>Math.min(old,n-1))}} title={`${n} 个视图`}>{n === 1 ? <Maximize2 size={13} /> : n === 2 ? <Columns2 size={13} /> : <Grid2X2 size={13} />}{n} 图</button>)}
          {ac&&<button type="button" aria-label="设置 Bode 增益相位双图" title="同频率轴显示 VOUT / VIN 的增益和相位" onClick={()=>{setLayout(2);setSplitDirection('rows');setSplitRatio(50);setActivePanel(0);setPanels(old=>old.map((panel,index)=>index<2?{...panel,source:'transfer',display:index===0?'magnitude':'phase'}:panel))}}>Bode 双图</button>}
          {layout===2&&<><button type="button" aria-pressed={splitDirection==='rows'} onClick={()=>setSplitDirection('rows')} title="两图上下排列并拖动分隔条">上下分隔</button><button type="button" aria-pressed={splitDirection==='columns'} onClick={()=>setSplitDirection('columns')} title="两图左右排列并拖动分隔条">左右分隔</button></>}
        </div>
        <span className="wave-link-note">X 轴 / 游标同步</span>
        <div className="wave-navigation" role="group" aria-label="共享波形横轴">
          <button onClick={() => pan(-.5)} disabled={domain[0] <= 0} aria-label="波形向左平移">←</button>
          <button onClick={() => zoomAll(2)} disabled={domain[1] - domain[0] <= 1e-6} aria-label="放大所有波形"><Plus size={13} /></button>
          <button onClick={() => zoomAll(.5)}  aria-label="缩小所有波形"><Minus size={13} /></button>
          <button onClick={() => pan(.5)} disabled={domain[1] >= 1} aria-label="波形向右平移">→</button>
          <button aria-label="适配所有波形" onClick={() => fitCoordinates()}><RotateCcw size={12} />适配</button>
          <button onClick={() => fitCoordinates('reset')}>重置坐标</button>
          <button disabled={!previousCoordinates} onClick={() => fitCoordinates('return')}>返回原范围</button>
          <label><input type="checkbox" checked={includeComparison} onChange={event=>setIncludeComparison(event.target.checked)}/>包含对比运行</label>
        </div>
      </WaveformTools>
      <div className="wave-cursor-buttons" role="group" aria-label="共享波形游标">
        {(['a', 'b'] as const).map(name => <button key={name} aria-pressed={active === name} onClick={() => {setInspectMode('measure');setActive(active === name ? null : name)}}>游标 {name.toUpperCase()}</button>)}
        <button onClick={() => { setCursors({ a: null, b: null }); setActive(null);setInspectMode(null) }} disabled={cursors.a === null && cursors.b === null && active === null}>清除</button>
      </div>
    </div>
    {catalogue.unavailable.length > 0 && <p className="wave-notice" role="status">{catalogue.unavailable.join('、')} 在本次结果中没有有效数据，未生成替代曲线；请重新放置或运行仿真。</p>}
    {inspectMode==='zoom'&&<p className="wave-inspection-hint" role="status"><ScanSearch size={14}/>在任一波形中拖出矩形，同时放大横轴与纵轴；细节窗支持双轴滚轮缩放，Shift 仅横轴、Alt 仅纵轴。</p>}
    {inspectMode==='measure'&&!active&&<p className="wave-inspection-hint" role="status"><Ruler size={14}/>拖动 A / B 光标测量；左右方向键逐点移动。点击曲线名称选择测量对象。</p>}
    {active && <p className="wave-hint">点击任一图放置游标 {active.toUpperCase()}，各视图同步到相同横轴位置。</p>}
    {comparison && <p className="wave-hint">虚线为固定的对比结果；仅显示两次仿真均有数据的同一测量对象。</p>}
    <div className={`wave-view-grid wave-layout-${layout}${layout===2?` wave-split-${splitDirection}`:''}`} style={layout===2?splitDirection==='rows'?{gridTemplateRows:`minmax(0,${splitRatio}fr) 14px minmax(0,${100-splitRatio}fr)`}:{gridTemplateColumns:`minmax(0,${splitRatio}fr) 14px minmax(0,${100-splitRatio}fr)`}:undefined}>
      {panels.slice(0, layout).map((panel, index) => {
        const traces = traceGroups[index]
        const expressionErrors=panelCatalogues[index].unavailable.filter(error=>!catalogue.unavailable.includes(error))
        for(const id of panel.ids.filter(id=>id.startsWith('expression:')))if(!panel.expressions?.some(item=>`expression:${item.id}`===id))expressionErrors.push(`${id}：缺少已保存的数学表达式定义`)
        const current = traces.filter(t => !t.comparison), primary = current.find(t => t.id === panel.primary) ?? current[0]
        return <Fragment key={index}><section className={`wave-view${activePanel===index?' is-probe-target':''}`} aria-label={`波形视图 ${index + 1}`} onPointerDown={()=>setActivePanel(index)}>
          <header className="wave-view-header">
            <button type="button" className="wave-pane-target" aria-label={`将探针加入视图 ${index+1}`} aria-pressed={activePanel===index} onClick={()=>setActivePanel(index)}><span>{String(index + 1).padStart(2, '0')}</span>视图 {index+1}{activePanel===index&&<small>接收探针</small>}</button>
            {ac && <><select value={panel.source} aria-label={`视图 ${index + 1} 图源`} onChange={e => patch(index, { source: e.target.value as WaveformPanel['source'] })}><option value="signals">探针 / 节点</option><option value="transfer">VOUT / VIN</option></select><select value={panel.display} aria-label={`视图 ${index + 1} 显示内容`} onChange={e => patch(index, { display: e.target.value as WaveformPanel['display'] })}><option value="magnitude">{panel.source === 'transfer' ? '增益' : '幅度'}</option><option value="phase">相位</option></select></>}
            <WaveformAxisSettings index={index} panel={panel} traces={traces} bounds={bounds} domain={domain} xUnit={frequency?'Hz':resultXAxisUnit(result)} logarithmic={frequency} onApply={(next,ranges)=>{setAutoFitExplicit(true);setAutoFit(false);setDomain(next);patch(index,{axisRanges:ranges})}}/>
          </header>
          {expressionErrors.length>0&&<p className="wave-notice" role="status">{expressionErrors.join('；')}</p>}
          {ac && panel.source === 'signals' && panel.display === 'magnitude' && <div className="wave-reference">电压 0 dBV = 1 V · 电流 0 dBA = 1 A</div>}
          {current.some(trace=>trace.powerPhasor)&&<div className="wave-reference">AC 电压与电流复数乘积 · 幅度相对 1 V·A，不代表实际平均功率</div>}
          {inspectMode==='measure'&&activePanel===index&&current.length>0&&<WaveformCursorNavigation index={index} traces={current} primaryId={primary?.id} cursors={cursors}
            range={lens?.panel===index?[xAt(lens.domain[0]),xAt(lens.domain[1])]:[xAt(domain[0]),xAt(domain[1])]} xUnit={frequency?'Hz':resultXAxisUnit(result)} detail={lens?.panel===index}
            onSelect={trace=>choose(index,trace)} onMove={(name,x)=>{setCursors(old=>({...old,[name]:x}));setActive(null)}}/>}
          <SignalPlot active={workspaceActive} onSelectTrace={trace=>choose(index,trace)} index={index} result={result} traces={traces} primaryId={primary?.id} axisRanges={panel.axisRanges} shared={shared} selecting={inspectMode==='zoom'} selectionDomain={lens?.panel===index?lens.domain:undefined} onSelectDomain={(next,ranges)=>{setLens({panel:index,domain:next,axisRanges:ranges});setInspectMode(null)}}/>
          {lens?.panel===index&&<section className="wave-detail" data-wave-detail={index} aria-label={`视图 ${index+1} 局部放大细节窗`}>
            <header><div><ScanSearch size={15}/><strong>局部细节</strong><span>{formatSI(xAt(lens.domain[0]),frequency?'Hz':resultXAxisUnit(result),4)} — {formatSI(xAt(lens.domain[1]),frequency?'Hz':resultXAxisUnit(result),4)}</span></div><div><small>{Number(((domain[1]-domain[0])/(lens.domain[1]-lens.domain[0])).toPrecision(3))}× 横轴 · 纵轴可独立缩放</small><button type="button" aria-label="重新框选放大区间" onClick={()=>startInspect('zoom')}><ScanSearch size={13}/>重选</button><button type="button" aria-label="关闭局部细节窗" onClick={()=>setLens(null)}><X size={14}/></button></div></header>
            <SignalPlot active={workspaceActive} onSelectTrace={trace=>choose(index,trace)} index={index} result={result} traces={traces} primaryId={primary?.id} axisRanges={lens.axisRanges??panel.axisRanges} detail shared={{...shared,domain:lens.domain,onPanAxes:(_index,ranges)=>setLens(old=>old?{...old,axisRanges:ranges}:null),onZoom:(factor,anchor=.5)=>setLens(old=>old?{...old,domain:zoomWaveformDomain(old.domain,factor,anchor)}:null),onPan:fraction=>setLens(old=>old?{...old,domain:panWaveformDomain(old.domain,fraction)}:null)}}/>
          </section>}
          <WaveformTraceBar index={index} result={result} panel={panel} signals={panelCatalogues[index].signals} traces={traces} measurements={measurements} onChange={next=>patch(index,next)} onSelect={trace=>choose(index,trace)} onSoloToggle={()=>panel.solo?restoreOverlay(index):primary&&focusTrace(index,primary)} onDefault={()=>patch(index,{...defaults[index],source:'signals',solo:false,overlayIds:undefined})}/>
        </section>{layout===2&&index===0&&<div className={`wave-splitter${draggingSplit?' is-dragging':''}`} role="separator" aria-label={splitDirection==='rows'?'上下波形分隔条':'左右波形分隔条'} aria-orientation={splitDirection==='rows'?'horizontal':'vertical'} aria-valuemin={25} aria-valuemax={75} aria-valuenow={splitRatio} tabIndex={0} title="拖动调整两个波形视图的大小；双击恢复均分" onPointerDown={event=>{event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture?.(event.pointerId);setDraggingSplit(true);updateSplit(event)}} onPointerMove={event=>{if(draggingSplit)updateSplit(event)}} onPointerUp={event=>{if(draggingSplit)updateSplit(event);event.currentTarget.releasePointerCapture?.(event.pointerId);setDraggingSplit(false)}} onPointerCancel={()=>setDraggingSplit(false)} onDoubleClick={()=>setSplitRatio(50)} onKeyDown={event=>{const negative=splitDirection==='rows'?'ArrowUp':'ArrowLeft',positive=splitDirection==='rows'?'ArrowDown':'ArrowRight';if(event.key===negative||event.key===positive){event.preventDefault();setSplitRatio(old=>Math.max(25,Math.min(75,old+(event.key===positive?1:-1)*(event.shiftKey?10:5))))}else if(event.key==='Home'||event.key==='End'){event.preventDefault();setSplitRatio(event.key==='Home'?25:75)}}}><span className="wave-splitter-grip" aria-hidden="true"/><span className="wave-splitter-value">{splitRatio}%</span></div>}</Fragment>
      })}
    </div>
  </section>
}

export default function WaveformWorkspace(props: Props) {
  const lastRun=useRef(props.result.id)
  const changedView=useRef<{runId:string;key:string|null}|null>(null)
  if(lastRun.current!==props.result.id){
    lastRun.current=props.result.id
    changedView.current={runId:props.result.id,key:props.initialView?viewKey(props.initialView):null}
  }
  // A reload restores its saved coordinates. A new run preserves selections
  // and fixed Y axes, but starts with its own complete X range.
  const sameOldView=changedView.current?.runId===props.result.id&&changedView.current.key===(props.initialView?viewKey(props.initialView):null)
  const initialView=sameOldView&&props.initialView&&props.initialView.autoFit!==false?{...props.initialView,domain:[0,1] as WaveformDomain}:props.initialView
  return <Workspace key={props.result.id} {...props} initialView={initialView} />
}

function CompactLegend({traces,index,target}:{traces:WaveformTrace[];index:number;target:boolean}) {
  const list=useRef<HTMLDivElement>(null)
  useEffect(()=>{
    const element=list.current;if(!element)return
    const wheel=(event:WheelEvent)=>event.stopPropagation()
    element.addEventListener('wheel',wheel,{passive:true})
    return()=>element.removeEventListener('wheel',wheel)
  },[])
  const current=traces.filter(trace=>!trace.comparison||trace.sweep)
  const shortName=(trace:WaveformTrace)=>{
    const name=trace.name.replace(/^P\d+\s*·\s*/,'').replace(/^V\(([^,]+)\)$/i,'$1')
    return trace.measurementId?`${trace.measurementId} ${name}`:name
  }
  const caption=current.map(trace=>`${trace.name} [${trace.unit}]`).join('\n')
  return <header className="canvas-waveform-plot-heading">
    <span className="canvas-waveform-panel-target" title={`视图 ${index+1}${target?' · 接收探针':''}`} aria-label={`视图 ${index+1}${target?' · 接收探针':''}`}>{String(index+1).padStart(2,'0')}</span>
    <div className="canvas-waveform-legend" title={caption} aria-label={`视图 ${index+1} 曲线摘要`}>
      {current.slice(0,2).map(trace=><span key={trace.id} title={`${trace.name} · ${trace.unit}`}><i style={{background:trace.color}}/><b>{shortName(trace)}</b></span>)}
      {!current.length&&<span className="canvas-waveform-no-traces">未选择曲线</span>}
    </div>
    <details className="canvas-waveform-legend-menu" data-waveform-control="true" onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape')event.currentTarget.open=false}}>
      <summary aria-label={`视图 ${index+1} 查看全部 ${current.length} 条曲线`} title="查看完整曲线名称、单位与颜色"><span>{current.length>2?`+${current.length-2}`:`${current.length}`}</span><ChevronDown size={11}/></summary>
      <div ref={list} className="canvas-waveform-legend-details"><strong>视图 {index+1} · {current.length} 条曲线</strong>{current.map(trace=><div key={trace.id}><i style={{background:trace.color}}/><span>{trace.name}</span><small>{trace.unit}</small></div>)}{!current.length&&<span>双击图框，在此视图中添加曲线。</span>}</div>
    </details>
  </header>
}

/** A diagram is a read-only view of the same selected traces, zoom and cursors. */
export function CanvasWaveformPreview({result,snapshot,activePanel=0,onSelectPanel,showProbeTarget=true,onWheelResize,onWheelZoom}:{result:Result;snapshot:WaveformSnapshot|null;activePanel?:number;onSelectPanel?:(index:number)=>void;showProbeTarget?:boolean;onWheelResize?:(factor:number,anchor?:{x:number;y:number})=>void;/** @deprecated use onWheelResize; retained for embedded callers during migration. */onWheelZoom?:(factor:number,anchor?:number)=>void}) {
  const preview=useRef<HTMLDivElement>(null)
  useEffect(()=>{
    const element=preview.current
    if(!element||(!onWheelResize&&!onWheelZoom))return
    const selectedFrame=()=>element.closest('[data-canvas-diagram]')
      ?? [...element.ownerDocument.querySelectorAll('[data-canvas-diagram]')].find(candidate=>candidate.contains(element))
    const insideFrame=(event:WheelEvent,frame:Element|null)=>{
      if(event.target&&frame?.contains(event.target as Node))return true
      // Chromium can retarget a wheel from a foreignObject's HTML subtree to
      // the surrounding SVG. Coordinates still identify the selected frame,
      // including its title and controls.
      const bounds=(frame??element).getBoundingClientRect()
      return bounds.width>0&&bounds.height>0&&event.clientX>=bounds.left&&event.clientX<=bounds.right&&event.clientY>=bounds.top&&event.clientY<=bounds.bottom
    }
    const wheel=(event:WheelEvent)=>{
      if(event.defaultPrevented)return
      if((event.target as Element|null)?.closest?.('dialog,[role="dialog"],[aria-modal="true"],.canvas-waveform-legend-details'))return
      const frame=selectedFrame()
      // An unselected frame deliberately leaves the event for EditorCanvas,
      // whose wheel handler zooms/pans the schematic as usual.
      if(frame?.getAttribute('data-diagram-selected')!=='true'||!event.deltaY||!insideFrame(event,frame))return
      // JSDOM does not always expose Element on the global object, and
      // Chromium may retarget a foreignObject wheel to an SVG element. Use
      // the capability we need instead of an instanceof check so both paths
      // share the same hit testing logic.
      const hitElement=event.target&&typeof (event.target as {closest?:unknown}).closest==='function'
        ? event.target as Element
        : null
      const plot=[...element.querySelectorAll<SVGElement>('.wave-plot')].find(candidate=>{
        if(hitElement?.closest('.wave-plot')===candidate)return true
        const plotBounds=candidate.getBoundingClientRect()
        return plotBounds.width>0&&plotBounds.height>0&&event.clientX>=plotBounds.left&&event.clientX<=plotBounds.right&&event.clientY>=plotBounds.top&&event.clientY<=plotBounds.bottom
      })
      const frameBounds=frame?.getBoundingClientRect()??element.getBoundingClientRect()
      const plotBounds=plot?.getBoundingClientRect()??frameBounds
      const bounds=plot?plotBounds:frameBounds
      const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?(frameBounds.height||element.clientHeight):1)
      const factor=Math.exp(-Math.max(-160,Math.min(160,delta))*.0025)
      if(plot&&(onWheelResize||onWheelZoom)){
        event.preventDefault();event.stopPropagation()
        const anchorBounds=onWheelResize?frameBounds:bounds
        const anchor=anchorBounds.width>0?Math.max(0,Math.min(1,(event.clientX-anchorBounds.left)/anchorBounds.width)):.5
        if(onWheelResize)onWheelResize(factor,{x:anchor,y:anchorBounds.height>0?Math.max(0,Math.min(1,(event.clientY-anchorBounds.top)/anchorBounds.height)):.5})
        else onWheelZoom?.(factor,anchor)
        return
      }
      // Wheel over a frame title/background still resizes the sheet object.
      // Keep the legacy callback as a fallback for embedded callers without a
      // plot callback, while plot events always take the internal path above.
      if(!plot&&onWheelResize){
        event.preventDefault();event.stopPropagation()
        const anchor={x:bounds.width>0?Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)):.5,
          y:bounds.height>0?Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height)):.5}
        onWheelResize(factor,anchor)
        return
      }
    }
    // Capture inside the foreignObject before the SVG editor's wheel listener
    // can see the event.  A bubbling listener is unreliable in Chromium when
    // an HTML descendant of an SVG foreignObject is the wheel target: the
    // outer schematic may receive the event first and zoom the whole canvas.
    element.addEventListener('wheel',wheel,{capture:true,passive:false})
    // Keep a window capture guard as well. Some Chromium versions retarget
    // the event to the outer SVG, bypassing the HTML node's capture phase.
    window.addEventListener('wheel',wheel,{capture:true,passive:false})
    return()=>{element.removeEventListener('wheel',wheel,true);window.removeEventListener('wheel',wheel,true)}
  },[onWheelResize,onWheelZoom])
  if(result.analysis==='op')return <div ref={preview} className="canvas-op-preview"><strong>直流工作点</strong>{Object.entries(result.voltages??{}).slice(0,8).map(([name,values])=><div key={name}><span>{name}</span><b>{formatSI(values[0],'V',5)}</b></div>)}<small>双击查看完整结果</small></div>
  if(!snapshot||snapshot.resultId!==result.id)return <div ref={preview} className="canvas-waveform-empty">正在准备波形…</div>
  const shared:SharedView={...snapshot,hover:null,active:null,onHover:()=>{},onPin:()=>{},onZoom:()=>{},onPan:()=>{}}
  const reserveRightAxis=snapshot.panels.some(panel=>new Set(panel.traces.map(trace=>trace.unit)).size>1)
  const axisOrder=[...new Set(snapshot.panels.flatMap(panel=>panel.traces.map(trace=>trace.unit)))].sort((a,b)=>['V','A','dBV','dBA','dB','°'].indexOf(a)-['V','A','dBV','dBA','dB','°'].indexOf(b))
  const previewDirection=snapshot.splitDirection??'rows',previewRatio=snapshot.splitRatio??50
  const previewStyle:CSSProperties|undefined=snapshot.layout===2?previewDirection==='rows'
    ?{gridTemplateRows:`minmax(0,${previewRatio}fr) minmax(0,${100-previewRatio}fr)`}
    :{gridTemplateColumns:`minmax(0,${previewRatio}fr) minmax(0,${100-previewRatio}fr)`,gridTemplateRows:'minmax(0,1fr)'}:undefined
  return <div ref={preview} className={`canvas-waveform-preview canvas-waveform-layout-${snapshot.layout}${snapshot.layout===2?` canvas-waveform-split-${previewDirection}`:''}`} style={previewStyle} aria-label="画布中的波形预览">
    {snapshot.panels.map((panel,index)=><section key={index} className={`canvas-waveform-preview-panel${onSelectPanel&&showProbeTarget&&activePanel===index?' is-probe-target':''}`} aria-label={`画布波形视图 ${index+1}`} data-waveform-panel={index} role={onSelectPanel?'button':undefined} tabIndex={onSelectPanel?0:undefined} aria-pressed={onSelectPanel?showProbeTarget&&activePanel===index:undefined} onClick={()=>onSelectPanel?.(index)} onKeyDown={event=>{if(event.target===event.currentTarget&&onSelectPanel&&(event.key==='Enter'||event.key===' ')){event.preventDefault();event.stopPropagation();onSelectPanel(index)}}}>
      <CompactLegend traces={panel.traces} index={index} target={!!onSelectPanel&&showProbeTarget&&activePanel===index}/>
      <SignalPlot index={index} result={result} traces={panel.traces} primaryId={panel.primaryId} axisRanges={panel.axisRanges} shared={shared} interactive={false} reserveRightAxis={reserveRightAxis} axisOrder={axisOrder}/>
    </section>)}
  </div>
}
