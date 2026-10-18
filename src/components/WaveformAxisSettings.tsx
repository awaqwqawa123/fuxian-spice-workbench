import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SlidersHorizontal } from 'lucide-react'
import { useWorkbenchDialog } from './AssistantWindow'
import { formatSI } from '../core/circuit'
import { parseWaveformAxisRange, waveformRangeDomain, type WaveformAxisRanges } from '../core/waveform-axis-settings'
import { waveformYBounds, type WaveformDomain, type WaveformPanel, type WaveformTrace } from '../core/waveform-workspace'

interface Props {
  embedded?: boolean
  availableHeight?: number
  includeComparison?: boolean; onIncludeComparison?: (value: boolean) => void
  onResetCoordinates?: () => void; onRestoreCoordinates?: () => void; canRestoreCoordinates?: boolean
  index: number; traces: WaveformTrace[]; panel: WaveformPanel; bounds: WaveformDomain; domain: WaveformDomain
  xUnit: string; logarithmic: boolean; onApply: (domain: WaveformDomain, ranges: WaveformAxisRanges) => void
}
export default function WaveformAxisSettings({ index, traces, panel, bounds, domain, xUnit, logarithmic, onApply, embedded=false, availableHeight=500, includeComparison=false, onIncludeComparison, onResetCoordinates, onRestoreCoordinates, canRestoreCoordinates=false }: Props) {
  const window = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  useWorkbenchDialog(window, open && !embedded, () => setOpen(false))
  const [xStart, setXStart] = useState(''), [xEnd, setXEnd] = useState('')
  const [axes, setAxes] = useState<Record<string, { fixed: boolean; start: string; end: string }>>({})
  const [error, setError] = useState('')
  const [selectedUnit, setSelectedUnit] = useState('')
  const [subpage, setSubpage] = useState(0)
  const loadedX = useRef<{ start: string; end: string; domain: WaveformDomain; bounds: WaveformDomain } | null>(null)
  const units = [...new Set(traces.map(trace => trace.unit))]
  const displayed = (value: number, unit: string) => ['s', 'Hz', 'V', 'A'].includes(unit) ? formatSI(value, unit, 12) : `${Number(value.toPrecision(12))} ${unit}`
  const xBounds: WaveformDomain = [bounds[0] + (bounds[1] - bounds[0]) * domain[0], bounds[0] + (bounds[1] - bounds[0]) * domain[1]]
  const actual = (value: number) => logarithmic ? 10 ** value : value
  const load = () => {
    const start = displayed(actual(xBounds[0]), xUnit), end = displayed(actual(xBounds[1]), xUnit)
    loadedX.current = { start, end, domain, bounds }
    setXStart(start); setXEnd(end); setError('')
    setAxes(Object.fromEntries(units.map(unit => {
      const range = panel.axisRanges?.[unit] ?? waveformYBounds(traces, unit, xBounds, logarithmic)
      return [unit, { fixed: !!panel.axisRanges?.[unit], start: displayed(range[0], unit), end: displayed(range[1], unit) }]
    })))
  }
  const apply = () => {
    try {
      const previous = loadedX.current
      const unchanged = previous && previous.start === xStart && previous.end === xEnd && previous.bounds[0] === bounds[0] && previous.bounds[1] === bounds[1]
      const next = unchanged ? previous.domain : waveformRangeDomain(parseWaveformAxisRange(xStart, xEnd, xUnit), bounds, logarithmic)
      const ranges = { ...panel.axisRanges }
      for (const unit of units) {
        const axis = axes[unit]
        if (axis?.fixed) ranges[unit] = parseWaveformAxisRange(axis.start, axis.end, unit)
        else delete ranges[unit]
      }
      onApply(next, ranges); setError(''); setOpen(false)
    } catch (cause) { setError((cause as Error).message) }
  }
  useEffect(() => { if (embedded) load() }, [embedded, index, bounds[0], bounds[1], domain[0], domain[1], panel.axisRanges])
  useEffect(() => {
    if(!embedded)return
    setAxes(old=>({...old,...Object.fromEntries(units.filter(unit=>!old[unit]).map(unit=>{
      const range=panel.axisRanges?.[unit]??waveformYBounds(traces,unit,xBounds,logarithmic)
      return [unit,{fixed:!!panel.axisRanges?.[unit],start:displayed(range[0],unit),end:displayed(range[1],unit)}]
    }))}))
  },[embedded,units.join('|')])
  const unit = units.includes(selectedUnit) ? selectedUnit : units[0]
  if (embedded && availableHeight < 350) {
    const labels = ['横轴范围', '纵轴选择', '纵轴范围', '适配与重置', '应用设置']
    const page = Math.min(subpage, labels.length - 1)
    return <section className="wave-axis-inline wave-bounded-form" aria-label={`视图 ${index + 1} 坐标轴设置`}>
      <div className="wave-form-page-nav"><button type="button" aria-label="上一页坐标设置" disabled={!page} onClick={() => setSubpage(page - 1)}>上一页</button><select aria-label="坐标设置页面" value={page} onChange={event => setSubpage(Number(event.target.value))}>{labels.map((label, i) => <option key={label} value={i}>{label} · {i + 1}/{labels.length}</option>)}</select><button type="button" aria-label="下一页坐标设置" disabled={page === labels.length - 1} onClick={() => setSubpage(page + 1)}>下一页</button></div>
      <div hidden={page !== 0} className="wave-form-fields"><label>开始 ({xUnit})<input aria-label={`视图 ${index + 1} 横轴开始`} value={xStart} onChange={event => setXStart(event.target.value)} /></label><label>结束 ({xUnit})<input aria-label={`视图 ${index + 1} 横轴结束`} value={xEnd} onChange={event => setXEnd(event.target.value)} /></label></div>
      <div hidden={page !== 1} className="wave-form-fields"><label>纵轴单位<select aria-label={`视图 ${index + 1} 纵轴单位`} value={unit ?? ''} onChange={event => setSelectedUnit(event.target.value)}>{units.map(value => <option key={value}>{value}</option>)}</select></label>{unit && <label className="wave-form-checkbox"><input type="checkbox" aria-label={`视图 ${index + 1} 固定 ${unit} 纵轴`} checked={axes[unit]?.fixed ?? false} onChange={event => setAxes(old => ({ ...old, [unit]: { ...old[unit], fixed: event.target.checked } }))} />固定量程</label>}</div>
      <div hidden={page !== 2} className="wave-form-fields">{unit && <><label>下限 ({unit})<input aria-label={`视图 ${index + 1} ${unit} 纵轴下限`} value={axes[unit]?.start ?? ''} disabled={!axes[unit]?.fixed} onChange={event => setAxes(old => ({ ...old, [unit]: { ...old[unit], start: event.target.value } }))} /></label><label>上限 ({unit})<input aria-label={`视图 ${index + 1} ${unit} 纵轴上限`} value={axes[unit]?.end ?? ''} disabled={!axes[unit]?.fixed} onChange={event => setAxes(old => ({ ...old, [unit]: { ...old[unit], end: event.target.value } }))} /></label></>}</div>
      <div hidden={page !== 3} className="wave-form-actions">{onIncludeComparison && <label className="wave-form-checkbox"><input type="checkbox" checked={includeComparison} onChange={event => onIncludeComparison(event.target.checked)} />适配时包含对比运行</label>}<button type="button" onClick={() => { setXStart(displayed(actual(bounds[0]), xUnit)); setXEnd(displayed(actual(bounds[1]), xUnit)) }}>完整横轴范围</button>{onResetCoordinates && <button type="button" onClick={onResetCoordinates}>重置坐标</button>}{onRestoreCoordinates && <button type="button" disabled={!canRestoreCoordinates} onClick={onRestoreCoordinates}>返回原范围</button>}</div>
      <div hidden={page !== 4} className="wave-form-actions"><button type="button" onClick={() => setAxes(old => Object.fromEntries(Object.entries(old).map(([key, value]) => [key, { ...value, fixed: false }]))) }>恢复自动纵轴</button><button type="button" aria-label={`视图 ${index + 1} 应用坐标轴设置`} onClick={apply}>应用设置</button>{error && <p className="wave-expression-error" role="alert">{error}</p>}</div>
    </section>
  }
  if (embedded) return <section className="wave-axis-inline" aria-label={`视图 ${index + 1} 坐标轴设置`}>
    <p>横轴同步所有视图；纵轴分别设置，数值可输入 ms、kHz、mA 等单位。</p>
    <fieldset><legend>横轴 ({xUnit})</legend>
      <label>开始<input aria-label={`视图 ${index + 1} 横轴开始`} value={xStart} onChange={event=>setXStart(event.target.value)}/></label>
      <label>结束<input aria-label={`视图 ${index + 1} 横轴结束`} value={xEnd} onChange={event=>setXEnd(event.target.value)}/></label>
      <button type="button" onClick={()=>{setXStart(displayed(actual(bounds[0]),xUnit));setXEnd(displayed(actual(bounds[1]),xUnit))}}>完整横轴范围</button>
    </fieldset>
    {unit && <fieldset><legend>纵轴 <select aria-label={`视图 ${index + 1} 纵轴单位`} value={unit} onChange={event=>setSelectedUnit(event.target.value)}>{units.map(value=><option key={value}>{value}</option>)}</select></legend>
      <label className="wave-axis-fixed"><input type="checkbox" aria-label={`视图 ${index + 1} 固定 ${unit} 纵轴`} checked={axes[unit]?.fixed??false} onChange={event=>setAxes(old=>({...old,[unit]:{...old[unit],fixed:event.target.checked}}))}/>固定量程</label>
      <label>下限<input aria-label={`视图 ${index + 1} ${unit} 纵轴下限`} value={axes[unit]?.start??''} disabled={!axes[unit]?.fixed} onChange={event=>setAxes(old=>({...old,[unit]:{...old[unit],start:event.target.value}}))}/></label>
      <label>上限<input aria-label={`视图 ${index + 1} ${unit} 纵轴上限`} value={axes[unit]?.end??''} disabled={!axes[unit]?.fixed} onChange={event=>setAxes(old=>({...old,[unit]:{...old[unit],end:event.target.value}}))}/></label>
    </fieldset>}
    {error&&<p className="wave-axis-error" role="alert">{error}</p>}
    <footer><button type="button" onClick={()=>setAxes(old=>Object.fromEntries(Object.entries(old).map(([key,value])=>[key,{...value,fixed:false}]))) }>恢复自动纵轴</button><button type="button" aria-label={`视图 ${index + 1} 应用坐标轴设置`} onClick={apply}>应用设置</button></footer>
  </section>
  return <><button type="button" className="wave-axis-settings-toggle" aria-label={`视图 ${index + 1} 坐标轴设置`} onClick={() => { load(); setOpen(true) }}><SlidersHorizontal size={12} />坐标轴{units.some(unit => panel.axisRanges?.[unit]) && <small>固定</small>}</button>
    {createPortal(<div className="workbench-window-backdrop wave-axis-backdrop" hidden={!open} onMouseDown={event => { if(event.target === event.currentTarget) setOpen(false) }}>
    <section ref={window} className="workbench-window wave-axis-window" role={open ? 'dialog' : undefined} aria-modal={open ? true : undefined} aria-label={`视图 ${index + 1} 坐标轴设置`} onKeyDown={event => event.stopPropagation()}>
    <header className="workbench-window-heading"><div><h2><SlidersHorizontal size={18} />坐标轴 · 视图 {index + 1}</h2></div><button type="button" aria-label="关闭坐标轴设置" onClick={() => setOpen(false)}>关闭</button></header>
    <div className="wave-axis-settings-body">
      <p>横轴范围同步到所有视图。纵轴量程只用于本视图，缩放后保持固定。</p>
      <fieldset><legend>横轴 ({xUnit})</legend><label>开始<input aria-label={`视图 ${index + 1} 横轴开始`} value={xStart} onChange={event => setXStart(event.target.value)} /></label>
        <label>结束<input aria-label={`视图 ${index + 1} 横轴结束`} value={xEnd} onChange={event => setXEnd(event.target.value)} /></label>
        <small>已有范围：{displayed(actual(bounds[0]), xUnit)} — {displayed(actual(bounds[1]), xUnit)}</small>
        <button type="button" onClick={() => { setXStart(displayed(actual(bounds[0]), xUnit)); setXEnd(displayed(actual(bounds[1]), xUnit)) }}>填入完整横轴范围</button>
      </fieldset>
      {units.map(unit => <fieldset key={unit}><legend>纵轴 ({unit})</legend>
        <label className="wave-axis-fixed"><input type="checkbox" aria-label={`视图 ${index + 1} 固定 ${unit} 纵轴`} checked={axes[unit]?.fixed ?? false} onChange={event => setAxes(old => ({ ...old, [unit]: { ...old[unit], fixed: event.target.checked } }))} />固定量程</label>
        <label>下限<input aria-label={`视图 ${index + 1} ${unit} 纵轴下限`} disabled={!axes[unit]?.fixed} value={axes[unit]?.start ?? ''} onChange={event => setAxes(old => ({ ...old, [unit]: { ...old[unit], start: event.target.value } }))} /></label>
        <label>上限<input aria-label={`视图 ${index + 1} ${unit} 纵轴上限`} disabled={!axes[unit]?.fixed} value={axes[unit]?.end ?? ''} onChange={event => setAxes(old => ({ ...old, [unit]: { ...old[unit], end: event.target.value } }))} /></label>
      </fieldset>)}
      {error && <p className="wave-axis-error" role="alert">{error}</p>}
    </div>
    <footer className="workbench-window-footer"><button type="button" onClick={() => setAxes(old => Object.fromEntries(Object.entries(old).map(([unit, value]) => [unit, { ...value, fixed: false }]))) }>恢复自动纵轴</button>
      <div><button type="button" onClick={() => setOpen(false)}>取消</button><button type="button" className="primary" aria-label={`视图 ${index + 1} 应用坐标轴设置`} onClick={apply}>应用</button></div></footer>
    </section></div>, document.body)}
  </>
}
