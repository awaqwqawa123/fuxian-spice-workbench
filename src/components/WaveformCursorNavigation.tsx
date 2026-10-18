import { useEffect, useState } from 'react'
import { formatSI } from '../core/circuit'
import { findWaveformCursorSample, type CursorSearch } from '../core/waveform-cursor-navigation'
import type { WaveformDomain, WaveformTrace } from '../core/waveform-workspace'

interface Props {
  availableHeight?: number
  onPlace?: (name:'a'|'b')=>void; onClear?:()=>void
  index: number; traces: WaveformTrace[]; primaryId?: string; range: WaveformDomain; xUnit: string; detail: boolean
  cursors: { a: number | null; b: number | null }
  onSelect: (trace: WaveformTrace) => void; onMove: (name: 'a' | 'b', x: number) => void
}
const actions: [CursorSearch, string][] = [
  ['maximum', '最大值'], ['minimum', '最小值'], ['previous-peak', '上一峰'], ['next-peak', '下一峰'], ['previous-trough', '上一谷'], ['next-trough', '下一谷'],
]
export default function WaveformCursorNavigation({ index, traces, primaryId, range, xUnit, detail, cursors, onSelect, onMove, availableHeight=500, onPlace, onClear }: Props) {
  const [target, setTarget] = useState<'a' | 'b'>('a'), [message, setMessage] = useState('')
  const [page,setPage]=useState(0)
  const primary = traces.find(trace => trace.id === primaryId) ?? traces[0]
  useEffect(() => setMessage(''), [primary?.id, target, range[0], range[1]])
  const find = (mode: CursorSearch) => {
    if (!primary) return
    const point = findWaveformCursorSample(primary, range, cursors[target], mode)
    if (!point) { setMessage('此方向的显示区间内没有符合条件的采样点。'); return }
    onMove(target, point.x)
    setMessage(`${target.toUpperCase()}：${formatSI(point.x, xUnit, 6)} / ${formatSI(point.y, primary.unit, 6)}`)
  }
  if(availableHeight<350){
    const labels=['选择游标与曲线','最大值与最小值','峰值定位','谷值定位','定位读数','放置与清除']
    return <div className="wave-cursor-navigation wave-bounded-form" role="group" aria-label={`视图 ${index+1} 游标定位`}>
      <div className="wave-form-page-nav"><button type="button" disabled={!page} onClick={()=>setPage(page-1)}>上一页</button><select aria-label="游标定位页面" value={page} onChange={event=>setPage(Number(event.target.value))}>{labels.map((label,i)=><option key={label} value={i}>{label} · {i+1}/6</option>)}</select><button type="button" disabled={page===5} onClick={()=>setPage(page+1)}>下一页</button></div>
      <div hidden={page!==0} className="wave-form-fields"><label>定位游标<select aria-label={`视图 ${index+1} 定位游标`} value={target} onChange={event=>setTarget(event.target.value as 'a'|'b')}><option value="a">游标 A</option><option value="b">游标 B</option></select></label><label>测量曲线<select aria-label={`视图 ${index+1} 游标曲线`} value={primary?.id??''} onChange={event=>{const trace=traces.find(item=>item.id===event.target.value);if(trace)onSelect(trace)}}>{traces.map(trace=><option key={trace.id} value={trace.id}>{trace.name} [{trace.unit}]</option>)}</select></label></div>
      {[1,2,3].map(value=><div key={value} hidden={page!==value} className="wave-form-actions">{actions.slice((value-1)*2,value*2).map(([mode,label])=><button key={mode} type="button" aria-label={`视图 ${index+1} 游标${target.toUpperCase()}定位${label}`} disabled={!primary} onClick={()=>{find(mode);setPage(4)}}>{label}</button>)}</div>)}
      <div hidden={page!==4} className="wave-form-actions"><p>{detail?'在局部细节范围内查找':'在当前显示范围内查找'} · 定位到原始采样点</p><p role="status" title={message}>{message||'选择定位动作后显示读数。'}</p></div>
      <div hidden={page!==5} className="wave-form-actions">{onPlace&&(['a','b'] as const).map(name=><button type="button" key={name} onClick={()=>onPlace(name)}>放置游标 {name.toUpperCase()}</button>)}{onClear&&<button type="button" onClick={onClear}>清除游标</button>}</div>
    </div>
  }
  return <div className="wave-cursor-navigation" role="group" aria-label={`视图 ${index + 1} 游标定位`}>
    <div className="wave-cursor-navigation-controls"><strong>游标定位</strong>
      <select aria-label={`视图 ${index + 1} 定位游标`} value={target} onChange={event => setTarget(event.target.value as 'a' | 'b')}><option value="a">游标 A</option><option value="b">游标 B</option></select>
      <select aria-label={`视图 ${index + 1} 游标曲线`} value={primary?.id ?? ''} onChange={event => { const trace = traces.find(item => item.id === event.target.value); if (trace) onSelect(trace) }}>
        {traces.map(trace => <option key={trace.id} value={trace.id}>{trace.name} [{trace.unit}]</option>)}
      </select>
      {actions.map(([mode, label]) => <button key={mode} type="button" aria-label={`视图 ${index + 1} 游标${target.toUpperCase()}定位${label}`} disabled={!primary} onClick={() => find(mode)}>{label}</button>)}
    </div>
    <div className="wave-cursor-navigation-status"><small>{detail ? '在局部细节范围内查找' : '在当前显示范围内查找'} · 定位到原始采样点</small>{message && <span role="status">{message}</span>}</div>
  </div>
}
