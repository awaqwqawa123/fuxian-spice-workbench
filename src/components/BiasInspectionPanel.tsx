import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ChevronUp, Copy, Download, Grip, LocateFixed, Maximize2, Pin, RotateCcw, Search } from 'lucide-react'
import { biasCsv, biasMeasurements, type BiasMeasurement } from '../core/bias-inspection'
import { biasMeasurementText, type BiasDisplayPreferences } from '../core/bias-display'
import { dcVoltageResultMatches } from '../core/dc-voltage'
import { formatSI, type Project } from '../core/circuit'
import { isConfiguredSource } from '../core/sources'
import type { Result } from '../core/results'
import type { useDcVoltages } from '../core/use-dc-voltages'

type State = ReturnType<typeof useDcVoltages>
type Sort = 'label' | 'value'
interface Props {
  state: State
  project: Project
  selection: readonly string[]
  onLocate: (measurement: BiasMeasurement) => void
  onExportSvg: (result: Result, measurements: BiasMeasurement[], stale: boolean) => void
}

function saveCsv(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = name
  document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Selection uses terminal identities rather than node names, which may be renumbered. */
export function biasRowSelected(m: BiasMeasurement, selected: readonly string[]): boolean {
  return selected.includes(m.id) || !!m.deviceId && selected.includes(m.deviceId)
    || !!m.wire && selected.includes(m.wire.wireId)
    || m.kind === 'voltage' && selected.some(id => m.id.split(/[|:]/).includes(id))
}

export function biasDirectionText(m: BiasMeasurement, mode: BiasDisplayPreferences['directionMode']): string {
  let direction = m.wire ? `${terminalName(m.wire.direction === 1 ? m.wire.from : m.wire.to)} → ${terminalName(m.wire.direction === 1 ? m.wire.to : m.wire.from)}` : m.direction
  if (m.kind === 'voltage' || mode === 'reference' || m.value === null) return direction
  if (m.value === 0) return '无净电流'
  if (m.value < 0) {
    if (direction.includes(' → ')) direction = direction.split(' → ').reverse().join(' → ')
    else direction = direction.replace(/^流入 /, '流出 ')
  }
  return direction
}

function terminalName(at: NonNullable<BiasMeasurement['at']>): string {
  return 'device' in at ? `${at.device} 引脚 ${at.pin + 1}` : at.junction
}

export function BiasInspectionPanel({ state, project, selection, onLocate, onExportSvg }: Props) {
  const panelRef = useRef<HTMLElement>(null)
  const [box, setBox] = useState<{x:number;y:number;width:number;height:number}|null>(null)
  const drag = useRef<{pointerId:number;clientX:number;clientY:number;box:NonNullable<typeof box>;mode:'move'|'resize';element:HTMLElement}|null>(null)
  function bound(next: NonNullable<typeof box>) {
    const parent = panelRef.current?.parentElement?.getBoundingClientRect()
    if (!parent?.width || !parent.height) return next
    const margin = Math.min(10, parent.width / 10, parent.height / 10)
    const width = Math.max(Math.min(320,parent.width-2*margin),Math.min(next.width,parent.width-2*margin))
    const height = Math.max(Math.min(240,parent.height-2*margin),Math.min(next.height,parent.height-2*margin))
    return {x:Math.max(margin,Math.min(next.x,parent.width-width-margin)),y:Math.max(margin,Math.min(next.y,parent.height-height-margin)),width,height}
  }
  useLayoutEffect(() => {
    const element=panelRef.current, parent=element?.parentElement
    if (!element||!parent||!state.tableOpen) return
    const fit=()=>{
      const area=parent.getBoundingClientRect()
      if(!area.width||!area.height)return
      setBox(previous=>{
        const next=bound(previous??{x:area.width-614,y:14,width:600,height:Math.min(640,area.height-28)})
        return previous&&Object.keys(next).every(key=>next[key as keyof typeof next]===previous[key as keyof typeof next])?previous:next
      })
    }
    fit()
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(fit)
    observer?.observe(parent)
    window.addEventListener('resize',fit)
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&drag.current){event.preventDefault();event.stopPropagation();cancelDrag()}}
    window.addEventListener('keydown',escape,true)
    window.addEventListener('blur',cancelDrag)
    return()=>{observer?.disconnect();window.removeEventListener('resize',fit);window.removeEventListener('keydown',escape,true);window.removeEventListener('blur',cancelDrag);const active=drag.current;drag.current=null;if(active?.element.hasPointerCapture?.(active.pointerId))active.element.releasePointerCapture(active.pointerId)}
  },[state.tableOpen])
  function startDrag(event:ReactPointerEvent<HTMLElement>,mode:'move'|'resize') {
    if(event.button!==0||mode==='move'&&(event.target as Element).closest('button,input,select,summary'))return
    const element=panelRef.current, parent=element?.parentElement
    if(!element||!parent)return
    const rect=element.getBoundingClientRect(),area=parent.getBoundingClientRect()
    const initial=box??{x:rect.left-area.left,y:rect.top-area.top,width:rect.width,height:rect.height}
    drag.current={pointerId:event.pointerId,clientX:event.clientX,clientY:event.clientY,box:initial,mode,element:event.currentTarget}
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault();event.stopPropagation()
  }
  function moveDrag(event:ReactPointerEvent<HTMLElement>) {
    const active=drag.current
    if(!active||active.pointerId!==event.pointerId)return
    const dx=event.clientX-active.clientX,dy=event.clientY-active.clientY
    setBox(bound(active.mode==='move'?{...active.box,x:active.box.x+dx,y:active.box.y+dy}:{...active.box,width:active.box.width+dx,height:active.box.height+dy}))
    event.stopPropagation()
  }
  function cancelDrag() {
    const active=drag.current
    if(!active)return
    drag.current=null
    setBox(bound(active.box))
    if(active.element.hasPointerCapture?.(active.pointerId))active.element.releasePointerCapture(active.pointerId)
  }
  function endDrag(event:ReactPointerEvent<HTMLElement>) {
    if(drag.current?.pointerId!==event.pointerId)return
    drag.current=null
    if(event.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)
    event.stopPropagation()
  }
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all')
  const [onlySelected, setOnlySelected] = useState(false), [sort, setSort] = useState<Sort>('label')
  const [descending, setDescending] = useState(false), [feedback, setFeedback] = useState('')
  const result = state.viewedResult ?? null
  const stale = !!result && !dcVoltageResultMatches(result, project)
  const exportStale = stale || !!state.failure || state.running
  const historical = !!result && result.id !== state.result?.id
  const canEdit = !!result && !stale && !state.running && !state.failure
  // Historical values always belong to the saved circuit, never to the edited canvas.
  const measurements = useMemo(() => biasMeasurements(result, historical ? result!.project : project, state.prefs.wireTargets ?? []), [result, historical, project, state.prefs.wireTargets])
  const rows = useMemo(() => measurements.filter(m =>
    (kind === 'all' || (kind === 'current' ? m.kind !== 'voltage' : m.kind === kind))
    && (!onlySelected || !stale && biasRowSelected(m, selection))
    && `${m.label} ${m.direction} ${m.source} ${m.reason ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())
  ).sort((a, b) => {
    // Unavailable values stay last in either sort direction.
    if (sort === 'value' && (a.value === null || b.value === null)) return Number(a.value === null) - Number(b.value === null)
    const delta = sort === 'value' ? (a.value! - b.value!) : a.label.localeCompare(b.label, 'zh-CN', { numeric: true })
    return (descending ? -1 : 1) * (delta || a.id.localeCompare(b.id))
  }), [measurements, kind, onlySelected, stale, selection, query, sort, descending])
  const sources = result?.project.drawing?.devices.filter(d => d.kind === 'V' || d.kind === 'I').map(d => ({
    id: d.id, dc: d.kind === 'V' && d.id === result.project.drawing?.sourceId && !isConfiguredSource(d) ? result.project.source.dc : d.value,
  })) ?? []
  const history = [result, ...state.history].filter((item): item is Result => !!item).filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)
  function order(column: Sort) {
    if (sort === column) setDescending(value => !value)
    else { setSort(column); setDescending(false) }
  }
  async function copy(m: BiasMeasurement) {
    if (m.value === null) return
    try { await navigator.clipboard.writeText(`${m.value} ${m.unit}`); setFeedback(`已复制 ${m.label} 的参考方向数值`) }
    catch { setFeedback('复制未完成，请选中数值后手动复制。') }
  }
  function reverse(m: BiasMeasurement) {
    if (!m.wire) return
    const nextId = m.id.slice(0, m.id.lastIndexOf(':') + 1) + (m.wire.direction === 1 ? '-1' : '1')
    const offsets = { ...state.prefs.offsets }
    if (offsets[m.id]) { offsets[nextId] = offsets[m.id]; delete offsets[m.id] }
    state.patchPrefs({
      wireTargets: (state.prefs.wireTargets ?? []).map(wire => wire.wireId === m.wire!.wireId ? { ...wire, direction: wire.direction === 1 ? -1 : 1 } : wire),
      pinned: state.prefs.pinned.map(id => id === m.id ? nextId : id), hidden: state.prefs.hidden.map(id => id === m.id ? nextId : id), offsets,
    })
    if (state.selectedId === m.id) state.setSelectedId(nextId)
  }
  if (!state.tableOpen) return null
  return <section ref={panelRef} id="bias-inspection-results" className="bias-inspection-panel" role="region" aria-label="直流工作点结果表" style={box?{left:box.x,top:box.y,width:box.width,height:box.height,right:'auto',bottom:'auto'}:undefined}>

    <header className="bias-panel-header" onPointerDown={e=>startDrag(e,'move')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={event=>{event.stopPropagation();cancelDrag()}} onLostPointerCapture={()=>{drag.current=null}}><div className="bias-panel-title"><Grip size={15} aria-hidden="true"/><div><strong>直流工作点</strong><span>电压与电流 · 拖动标题移动</span></div></div><div className="bias-panel-window-actions"><button type="button" aria-label="展开直流工作点结果表" title="展开到当前画布大小" onClick={()=>{const area=panelRef.current?.parentElement?.getBoundingClientRect();if(area?.width&&area.height)setBox(bound({x:10,y:10,width:area.width-20,height:area.height-20}))}}><Maximize2 size={16}/></button><button type="button" aria-label="关闭直流工作点结果表" title="收起详情 · 电压电流标注仍保留" onClick={() => state.setTableOpen(false)}><ChevronUp size={18} /></button></div></header>
    <div className="bias-panel-controls">
      <div className="bias-control-row"><label><input type="checkbox" checked={state.enabled} onChange={e => state.toggle(e.target.checked)} />直流电压</label><label><input type="checkbox" checked={state.currentsEnabled} onChange={e => state.toggleCurrents(e.target.checked)} />直流电流</label><button type="button" onClick={state.running ? state.stop : state.calculate}>{state.running ? '停止计算' : '重新计算'}</button></div>
      <div className="bias-control-row"><label>画布显示<select aria-label="工作点标注显示范围" value={state.prefs.scope} onChange={e => state.patchPrefs({ scope: e.target.value as BiasDisplayPreferences['scope'] })}><option value="all">全部</option><option value="selected">选中与固定</option><option value="pinned">仅固定</option></select></label><label>电流方向<select aria-label="工作点电流方向模式" value={state.prefs.directionMode} onChange={e => state.patchPrefs({ directionMode: e.target.value as BiasDisplayPreferences['directionMode'] })}><option value="reference">参考方向 · 带正负号</option><option value="actual">实际方向 · 绝对值</option></select></label></div>
      <p className="bias-direction-help">{state.prefs.directionMode === 'reference' ? '箭头表示参考方向；负值表示电流反向。多引脚器件以流入该引脚为正。' : '箭头随实际电流方向变化，数值显示绝对值；零电流不画箭头。复制与导出保留参考方向的正负号。'} 电压均相对全局地 0。</p>
      <div className="bias-control-row bias-layout-actions"><button type="button" aria-pressed={state.placingWire} onClick={() => state.setPlacingWire(!state.placingWire)}>{state.placingWire ? '取消放置' : '添加导线电流'}</button><button type="button" onClick={() => state.patchPrefs({ offsets: {} })}><RotateCcw size={13} />重置标注位置</button><button type="button" disabled={!state.prefs.hidden.length} onClick={() => state.patchPrefs({ hidden: [] })}>恢复隐藏（{state.prefs.hidden.length}）</button><button type="button" disabled={!state.canUndoDisplay} onClick={state.undoDisplay}>撤销标牌调整</button><button type="button" disabled={!state.canRedoDisplay} onClick={state.redoDisplay}>重做标牌调整</button></div>
      {state.placingWire && <p className="bias-direction-help">点击画布上的一段导线。电流无法唯一确定时，会显示原因。</p>}
    </div>
    <div className="bias-panel-status" role={state.failure ? 'alert' : 'status'} data-state={state.failure ? 'error' : state.running ? 'running' : stale ? 'stale' : result ? 'ready' : 'empty'}>
      <strong>{state.failure ? state.failure.includes('计算已停止') ? '计算已停止' : '本次计算失败' : state.running ? '正在计算' : stale ? '历史结果 · 电路已改变' : historical ? '历史结果 · 与当前电路一致' : result ? '当前电路工作点' : '尚未计算'}</strong>
      <span>{state.failure || (state.running ? state.progress : stale ? '以下数值属于保存的电路。重新计算后才能用于当前原理图。' : '按电源的 DC 值计算；瞬态和扫描结果请查看波形图。')}</span>
      {result && (state.running || state.failure) && <span>下表保留此前计算结果，时间见结果信息；本次成功前不作为最新结果显示或导出。</span>}
      {state.storageWarning && <span className="bias-storage-warning">{state.storageWarning}</span>}
    </div>
    <div className="bias-panel-results">
      <label className="bias-history-select">查看结果<select aria-label="查看工作点历史结果" value={result?.id ?? ''} onChange={e => state.setViewedRunId(e.target.value || undefined)}><option value="" disabled>尚无计算结果</option>{history.map(run => <option key={run.id} value={run.id}>{new Date(run.timestamp).toLocaleString('zh-CN')} · {run.id.slice(0, 8)}</option>)}</select></label>
      {result && <details className="bias-result-metadata"><summary>结果信息 · {new Date(result.timestamp).toLocaleTimeString('zh-CN')} · {result.project.temperature ?? 27} °C</summary><dl><dt>计算编号</dt><dd>{result.id}</dd><dt>计算时间</dt><dd>{new Date(result.timestamp).toLocaleString('zh-CN')}</dd><dt>温度</dt><dd>{result.project.temperature ?? 27} °C</dd><dt>计算引擎</dt><dd>{result.engine}</dd><dt>耗时</dt><dd>{result.elapsed} ms</dd><dt>电源 DC 值</dt><dd>{sources.length ? sources.map(s => `${s.id}: ${s.dc}`).join('；') : `参考源: ${result.project.source.dc}`}</dd></dl></details>}
      <div className="bias-table-filters"><label className="bias-search"><Search size={14} /><input aria-label="搜索工作点结果" placeholder="搜索节点、器件、原因" value={query} onChange={e => setQuery(e.target.value)} /></label><select aria-label="筛选工作点测量类型" value={kind} onChange={e => setKind(e.target.value)}><option value="all">全部测量</option><option value="voltage">节点电压</option><option value="current">所有电流</option><option value="wire">导线电流</option></select><label><input type="checkbox" checked={onlySelected} disabled={stale} onChange={e => setOnlySelected(e.target.checked)} />仅选中</label></div>
      <div className="bias-table-scroll"><table><thead><tr><th scope="col" aria-sort={sort === 'label' ? descending ? 'descending' : 'ascending' : 'none'}><button type="button" onClick={() => order('label')}>测量 {sort === 'label' ? descending ? '↓' : '↑' : ''}</button></th><th scope="col" aria-sort={sort === 'value' ? descending ? 'descending' : 'ascending' : 'none'}><button type="button" onClick={() => order('value')}>数值 {sort === 'value' ? descending ? '↓' : '↑' : ''}</button></th><th scope="col">{state.prefs.directionMode === 'reference' ? '参考方向' : '实际方向'}</th><th scope="col">操作</th></tr></thead><tbody>{rows.map(m => {
        const editable = canEdit && state.measurements.some(current => current.id === m.id)
        const hidden = state.prefs.hidden.includes(m.id), pinned = state.prefs.pinned.includes(m.id)
        const value = m.value === null ? '不可用' : (m.kind !== 'voltage' && state.prefs.directionMode === 'reference' && m.value > 0 ? '+' : '') + formatSI(state.prefs.directionMode === 'actual' && m.kind !== 'voltage' ? Math.abs(m.value) : m.value, m.unit, 5)
        return <tr key={m.id} data-measurement-id={m.id} data-unavailable={m.value === null || undefined} data-selected={state.selectedId === m.id || undefined} data-hidden={hidden || undefined}>
          <th scope="row"><button type="button" className="bias-row-label" disabled={!editable} onClick={() => { state.setSelectedId(m.id); onLocate(m) }}>{m.label}</button><span className="bias-row-source">{m.source}{hidden ? ' · 已隐藏' : ''}{pinned ? ' · 已固定' : ''}</span></th>
          <td title={m.value === null ? m.reason : biasMeasurementText(m, 'reference')}><span className="bias-value">{value}</span>{m.value === null && <span className="bias-unavailable-reason">{m.reason ?? '本次计算未提供该值'}</span>}</td>
          <td className="bias-row-direction">{biasDirectionText(m, state.prefs.directionMode)}</td>
          <td><div className="bias-row-actions"><button type="button" title="定位到原理图" aria-label={`定位 ${m.label}`} disabled={!editable} onClick={() => { state.setSelectedId(m.id); onLocate(m) }}><LocateFixed size={14} /></button><button type="button" title={pinned ? '取消固定' : '固定显示'} aria-label={`${pinned ? '取消固定' : '固定'} ${m.label}`} aria-pressed={pinned} disabled={!editable} onClick={() => state.pin(m.id)}><Pin size={14} /></button><button type="button" aria-label={`${hidden ? '显示' : '隐藏'} ${m.label}`} disabled={!editable} onClick={() => state.hide(m.id)}>{hidden ? '显示' : '隐藏'}</button><button type="button" title="复制参考方向原始数值" aria-label={`复制 ${m.label} 数值`} disabled={m.value === null} onClick={() => void copy(m)}><Copy size={13} /></button>{m.wire && <><button type="button" aria-label={`反向 ${m.label}`} disabled={!editable} onClick={() => reverse(m)}>反向</button><button type="button" aria-label={`移除 ${m.label}`} disabled={!editable} onClick={() => state.patchPrefs({ wireTargets: (state.prefs.wireTargets ?? []).filter(wire => wire.wireId !== m.wire!.wireId) })}>移除</button></>}</div></td>
        </tr>
      })}</tbody></table>{!rows.length && <p className="bias-empty-results">{measurements.length ? '没有符合筛选条件的测量。' : '点击“重新计算”，获取电压和电流。'}</p>}</div>
      <div className="bias-export-actions"><span>{rows.length} / {measurements.length} 项</span><button type="button" disabled={!result} onClick={() => saveCsv(`直流工作点-${result!.id.slice(0, 8)}.csv`, biasCsv(result, rows, exportStale))}><Download size={14} />导出表格 CSV</button><button type="button" disabled={!result} onClick={() => onExportSvg(result!, measurements, exportStale)}>导出标注图 SVG</button></div>
      <div className="bias-copy-feedback" role="status">{feedback}</div>
      {result && <div className="bias-result-details">{!!result.warnings.length && <details><summary>计算提示（{result.warnings.length}）</summary>{result.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details>}<details><summary>计算日志</summary><pre>{result.log || '本次计算没有额外日志。'}</pre></details><details><summary>本次计算电路</summary><pre>{result.netlist}</pre></details></div>}
    </div>
    <button className="bias-panel-resize" type="button" aria-label="调整直流工作点窗口大小" title="拖动调整大小；方向键微调，Shift 加速" onPointerDown={e=>startDrag(e,'resize')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={event=>{event.stopPropagation();cancelDrag()}} onLostPointerCapture={()=>{drag.current=null}} onKeyDown={event=>{
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return
      event.preventDefault();event.stopPropagation()
      const rect=panelRef.current?.getBoundingClientRect(),area=panelRef.current?.parentElement?.getBoundingClientRect()
      if(!rect||!area)return
      const initial=box??{x:rect.left-area.left,y:rect.top-area.top,width:rect.width,height:rect.height},delta=event.shiftKey?40:10
      setBox(bound({...initial,width:initial.width+(event.key==='ArrowRight'?delta:event.key==='ArrowLeft'?-delta:0),height:initial.height+(event.key==='ArrowDown'?delta:event.key==='ArrowUp'?-delta:0)}))
    }}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m5 13 8-8m-3 8 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></button>
  </section>
}

export default BiasInspectionPanel
