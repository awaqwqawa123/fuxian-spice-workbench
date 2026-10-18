import { type ComponentProps, type RefObject } from 'react'
import { Eye, EyeOff, Pin, Trash2, Waves, X } from 'lucide-react'
import type ProbeTray from './ProbeTray'
import { formatSI } from '../core/circuit'
import { terminalKey } from '../core/drawing'
import { measurementType, probeTypes, resolveMeasurement, type ProbeType } from '../core/probes'
import { wireCurrentName, wireCurrentUnavailableReason } from '../core/wire-currents'
import ProbeIcon from './ProbeIcon'

const modes: ProbeType[] = ['voltage', 'current', 'differential']
type Props = ComponentProps<typeof ProbeTray> & { toolbarRef: RefObject<HTMLDivElement | null>; onFocusMode: () => void; markersVisible?: boolean; onMarkersVisibleChange?: (visible: boolean) => void }

/** Inline controls share the drawing toolbar; no overlay or sidebar is opened. */
export default function ProbeToolbar({toolbarRef,onFocusMode,mode,onMode,active,onActivate,measurements,selected,onSelect,onRemove,onClear,pending,onCancelPending,result,stale,onViewResults,markersVisible=true,onMarkersVisibleChange}:Props) {
  const selectedId = measurements.some(item=>item.id===selected) ? selected! : measurements.at(-1)?.id ?? ''
  const records = measurements.map(item=>{
    const type=measurementType(item),trace=result&&!stale?resolveMeasurement(result,item):null
    const name=trace?.name??(item.kind==='current'?item.wire?wireCurrentName(item.wire):`I(${item.device})`:`${terminalKey(item.positive)}${item.negative?' − '+terminalKey(item.negative):''}`)
    const reading=trace&&result?.analysis==='op'?formatSI(trace.values[0],item.kind==='current'?'A':'V',5):stale?'待更新':!result?'待仿真':!trace?'无可用数据':''
    const reason=result&&!stale&&!trace&&item.kind==='current'&&item.wire?wireCurrentUnavailableReason(result,item.wire):null
    return {id:item.id,label:`${item.id} · ${probeTypes[type].symbol} ${name}${reading?' · '+reading:''}`,reason}
  })
  return <div className="probe-toolbar-inline" ref={toolbarRef} role="group" aria-label="顶栏探针">
    <button aria-label="测量探针 (P)" title="测量探针 (P)" aria-pressed={active} onClick={()=>{onActivate();onFocusMode()}}><Pin size={16}/><span>探针</span></button>
    <div className="probe-toolbar-modes" role="group" aria-label="探针类型" onKeyDown={event=>{
      const focused=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-probe-mode]')
      const index=modes.indexOf(focused?.dataset.probeMode as ProbeType)
      if(index<0)return
      const next=event.key==='ArrowRight'?modes[(index+1)%3]:event.key==='ArrowLeft'?modes[(index+2)%3]:event.key==='Home'?modes[0]:event.key==='End'?modes[2]:null
      if(!next)return
      event.preventDefault();onMode(next)
      event.currentTarget.querySelector<HTMLButtonElement>(`[data-probe-mode="${next}"]`)?.focus()
    }}>{modes.map(type=><button key={type} className={`probe-inline-mode probe-mode-${type}`} data-probe-mode={type} aria-label={`${probeTypes[type].name}探针`} title={`${probeTypes[type].name}探针 · ${probeTypes[type].target}`} aria-pressed={active&&mode===type} onClick={()=>onMode(type)}><ProbeIcon type={type} size={19}/><b>{probeTypes[type].symbol}</b></button>)}</div>
    {onMarkersVisibleChange&&<button aria-label={markersVisible?'隐藏全部探针图标':'显示全部探针图标'} title={markersVisible?'隐藏画布上的全部探针图标、标牌与引线；保留测量和波形':'显示画布上的全部探针图标、标牌与引线'} aria-pressed={markersVisible} onClick={()=>onMarkersVisibleChange(!markersVisible)}>{markersVisible?<Eye size={16}/>:<EyeOff size={16}/>}<span>标记</span></button>}
    {pending&&<button className="probe-toolbar-pending" aria-label="取消正端" title={`正端 ${terminalKey(pending)} 已选，点击负端完成差分测量；点击此处取消`} onClick={onCancelPending}><b>选负端</b><X size={13}/></button>}
    {records.length>0&&<div className="probe-toolbar-records">
      <select className="probe-record-select" aria-label="探针测量记录" title={records.find(item=>item.id===selectedId)?.reason??records.find(item=>item.id===selectedId)?.label} value={selectedId} onChange={event=>onSelect(event.target.value)}>{records.map(item=><option className="probe-record-option" key={item.id} value={item.id}>{item.label}</option>)}</select>
      <button aria-label={`移除测量 ${selectedId}`} title="移除选中的测量" onClick={()=>{const fallback=measurements.filter(item=>item.id!==selectedId).at(-1);onRemove(selectedId);if(fallback)onSelect(fallback.id)}}><X size={14}/></button>
      <button aria-label="清空测量" title="清空测量" onClick={onClear}><Trash2 size={14}/></button>
      <button aria-label="查看探针波形" title="查看探针波形" onClick={()=>{if(selectedId)onSelect(selectedId);onViewResults()}}><Waves size={16}/></button>
    </div>}
  </div>
}
