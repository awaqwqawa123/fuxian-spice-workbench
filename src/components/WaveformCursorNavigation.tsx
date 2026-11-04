import { useEffect, useState } from 'react'
import { formatSI } from '../core/circuit'
import { parseWaveformAxisValue } from '../core/waveform-axis-settings'
import { findWaveformCursorSample, nearestWaveformCursorSample, type CursorSearch } from '../core/waveform-cursor-navigation'
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
  const [target,setTarget]=useState<'a'|'b'>('a'),[message,setMessage]=useState(''),[position,setPosition]=useState('')
  const primary=traces.find(trace=>trace.id===primaryId)??traces[0],prefix=`视图 ${index+1}`
  useEffect(()=>setMessage(''),[primary?.id,target,range[0],range[1]])
  const report=(point:{x:number;y:number}|null)=>{
    if(!point){setMessage('当前显示区间内没有符合条件的原始采样点。');return}
    onMove(target,point.x);setMessage(`${target.toUpperCase()}：${formatSI(point.x,xUnit,6)} / ${formatSI(point.y,primary!.unit,6)}`)
  }
  const find=(mode:CursorSearch)=>{if(primary)report(findWaveformCursorSample(primary,range,cursors[target],mode))}
  const locate=()=>{
    if(!primary)return
    try{
      const value=parseWaveformAxisValue(position,xUnit)
      if(value<range[0]||value>range[1])throw new Error(`位置须在 ${formatSI(range[0],xUnit,5)} 至 ${formatSI(range[1],xUnit,5)} 之间。`)
      report(nearestWaveformCursorSample(primary,value,range,xUnit==='Hz'))
    }catch(cause){setMessage((cause as Error).message)}
  }
  const point=(name:'a'|'b')=>{
    if(!primary||cursors[name]===null||!primary.x.length)return null
    return nearestWaveformCursorSample(primary,cursors[name]!,[Math.min(primary.x[0],primary.x.at(-1)!),Math.max(primary.x[0],primary.x.at(-1)!)],xUnit==='Hz')
  }
  const a=point('a'),b=point('b'),deltaLabel=xUnit==='s'?'Δt':xUnit==='Hz'?'Δf':`Δ${xUnit}`
  return <div className="wave-cursor-navigation wave-cursor-console" role="group" aria-label={`${prefix} 游标定位`} data-compact={availableHeight<350||undefined}>
    <header className="wave-cursor-intro"><strong>A / B 游标测量</strong><p>选择测量曲线，放置 A、B 后比较两点。绘图中可拖动游标，用左右方向键逐个原始采样点移动。</p></header>
    <div className="wave-cursor-selectors"><label>测量曲线<select aria-label={`${prefix} 游标曲线`} disabled={!primary} value={primary?.id??''} onChange={event=>{const trace=traces.find(item=>item.id===event.target.value);if(trace)onSelect(trace)}}>{!primary&&<option value="">当前视图没有曲线</option>}{traces.map(trace=><option key={trace.id} value={trace.id}>{trace.name} [{trace.unit}]</option>)}</select></label><label>定位对象<select aria-label={`${prefix} 定位游标`} value={target} onChange={event=>setTarget(event.target.value as 'a'|'b')}><option value="a">游标 A</option><option value="b">游标 B</option></select></label></div>
    {onPlace&&<div className="wave-cursor-place-actions">{(['a','b'] as const).map(name=><button type="button" key={name} disabled={!primary} onClick={()=>onPlace(name)}>放置游标 {name.toUpperCase()}</button>)}{onClear&&<button type="button" disabled={cursors.a===null&&cursors.b===null} onClick={()=>{onClear();setMessage('')}}>清除游标</button>}</div>}
    <dl className="wave-cursor-values" aria-label={`${prefix} 游标读数`}>
      {(['a','b'] as const).map((name,i)=>{const sample=i===0?a:b;return <div key={name}><dt><i className={`wave-cursor-key wave-cursor-key-${name}`}>{name.toUpperCase()}</i></dt><dd>{cursors[name]===null?<span className="wave-cursor-unset">未放置</span>:sample?<><b>{formatSI(sample.x,xUnit,6)}</b><span>{formatSI(sample.y,primary!.unit,6)}</span></>:<span className="wave-cursor-unset">此曲线没有对应采样</span>}</dd></div>})}
      <div className="wave-cursor-delta"><dt>差值 B − A</dt><dd>{a&&b?<><b>{deltaLabel} {formatSI(b.x-a.x,xUnit,6)}</b><span>ΔY {formatSI(b.y-a.y,primary!.unit,6)}</span>{xUnit==='s'&&a.x!==b.x&&<span>1/|Δt| {formatSI(1/Math.abs(b.x-a.x),'Hz',6)}</span>}</>:<span className="wave-cursor-unset">放置 A 和 B 后显示差值</span>}</dd></div>
    </dl>
    <section className="wave-cursor-locate"><strong>定位游标 {target.toUpperCase()}</strong><div className="wave-cursor-exact-position"><input type="text" aria-label={`${prefix} 游标位置`} value={position} onChange={event=>setPosition(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();locate()}}} placeholder={xUnit==='s'?'输入位置，例如 2ms':xUnit==='Hz'?'输入频率，例如 1kHz':`输入位置 (${xUnit})`}/><button type="button" disabled={!primary||!position.trim()} onClick={locate}>定位</button></div><div className="wave-cursor-find-actions">{actions.map(([mode,label])=><button key={mode} type="button" aria-label={`${prefix} 游标${target.toUpperCase()}定位${label}`} disabled={!primary} onClick={()=>find(mode)}>{label}</button>)}</div></section>
    <div className="wave-cursor-navigation-status"><small>{detail?'在局部细节范围内查找':'在当前显示范围内查找'} · 定位到原始采样点</small><span role="status">{message||'放置游标返回绘图页；精确定位和峰谷读数会显示在上方。'}</span></div>
  </div>
}
