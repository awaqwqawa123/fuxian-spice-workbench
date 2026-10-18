import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Pencil, Plus, X, Focus, Layers, RotateCcw } from 'lucide-react'
import type { Result } from '../core/results'
import { measurementName, type Measurement } from '../core/probes'
import { evaluateWaveformExpression } from '../core/waveform-expression'
import { upsertPanelExpression, waveformUnit, type WaveformPanel, type WaveformSignal, type WaveformTrace } from '../core/waveform-workspace'

interface Props {
  index: number; result: Result; panel: WaveformPanel; signals: WaveformSignal[]; traces: WaveformTrace[]
  onChange: (panel: WaveformPanel) => void; onSelect: (trace: WaveformSignal) => void
  measurements?: Measurement[]
  onTarget?: () => void; target?: boolean
  onSoloToggle?: () => void; onReturnOverview?: () => void; onDefault?: () => void
}

/** Plot selections are view preferences; removing a trace never removes its probe or samples. */
export default function WaveformTraceBar({ index, result, panel, signals, traces, measurements=[], onChange, onSelect, onTarget, target, onSoloToggle, onReturnOverview, onDefault }: Props) {
  const bar=useRef<HTMLDivElement>(null), popup=useRef<HTMLDivElement>(null), opener=useRef<HTMLButtonElement|null>(null)
  const [mode,setMode]=useState<'signal'|'formula'|null>(null)
  const [query,setQuery]=useState(''),[selected,setSelected]=useState(''),[formula,setFormula]=useState('')
  const [editing,setEditing]=useState<string|null>(null),[error,setError]=useState('')
  const [position,setPosition]=useState({left:8,top:8,width:400})
  const prefix=`视图 ${index+1}`
  const own=traces.filter(trace=>!trace.comparison), primary=own.find(trace=>trace.id===panel.primary)??own[0]
  const options=signals.filter(signal=>signal.kind!=='transfer'&&!own.some(trace=>trace.id===signal.id)&&`${signal.name} ${signal.expression??''}`.toLowerCase().includes(query.toLowerCase()))
  const candidate=options.find(signal=>signal.id===selected)??options[0]
  const unavailable=measurements.filter(measurement=>!signals.some(signal=>signal.measurementId===measurement.id))
  const close=()=>{setMode(null);opener.current?.focus()}
  const open=(next:'signal'|'formula',button:HTMLButtonElement,id?:string)=>{
    opener.current=button;setError('');setEditing(id??null)
    setFormula(id?panel.expressions?.find(item=>item.id===id)?.expression??'':'')
    setQuery('');setSelected('');setMode(next)
  }
  useLayoutEffect(()=>{
    if(!mode)return
    const update=()=>{
      const rect=bar.current?.getBoundingClientRect();if(!rect)return
      const width=Math.min(560,window.innerWidth-16),height=popup.current?.getBoundingClientRect().height??180
      setPosition({width,left:Math.max(8,Math.min(rect.left,window.innerWidth-width-8)),top:Math.max(8,Math.min(rect.top-height-6,window.innerHeight-height-8))})
    }
    update();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(update);if(popup.current)observer?.observe(popup.current)
    window.addEventListener('resize',update);window.addEventListener('scroll',update,true)
    return()=>{observer?.disconnect();window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true)}
  },[mode,error])
  useEffect(()=>{
    if(!mode)return
    popup.current?.querySelector<HTMLInputElement>('input')?.focus()
    const outside=(event:PointerEvent)=>{if(!bar.current?.contains(event.target as Node)&&!popup.current?.contains(event.target as Node))setMode(null)}
    document.addEventListener('pointerdown',outside)
    return()=>document.removeEventListener('pointerdown',outside)
  },[mode])
  useEffect(()=>{setMode(null);setError('')},[result.id])
  const remove=(trace:WaveformTrace)=>{
    const ids=panel.source==='transfer'?[]:panel.ids.filter(id=>id!==trace.id)
    onChange({...panel,source:'signals',ids,primary:panel.primary===trace.id||panel.source==='transfer'?ids[0]:panel.primary})
  }
  const add=()=>{
    if(!candidate)return
    onChange({...panel,source:'signals',ids:panel.solo?[candidate.id]:[...new Set([...(panel.source==='transfer'?[]:panel.ids),candidate.id])],primary:candidate.id})
    onSelect(candidate)
    close()
  }
  const calculate=()=>{
    if(result.analysis==='noise'){setError('噪声分析暂不支持数学表达式。');return}
    try{
      const previous=panel.expressions?.find(item=>item.id===editing)
      const definition={id:editing??crypto.randomUUID(),...(previous?.name?{name:previous.name}:{}),expression:formula.trim()}
      evaluateWaveformExpression(result,definition)
      onChange(upsertPanelExpression(panel.source==='transfer'?{...panel,ids:[]}:panel,definition));close()
    }catch(cause){setError((cause as Error).message)}
  }
  return <div ref={bar} className="wave-trace-bar" role="group" aria-label={`${prefix} 曲线列表`} onKeyDown={event=>{if(event.key==='Escape'&&mode){event.stopPropagation();close()}}}>
    {onTarget&&<button type="button" className="wave-trace-target" aria-label={`将探针加入视图 ${index+1}`} aria-pressed={target} onClick={onTarget}>图 {index+1}</button>}
    {panel.solo?<select className="wave-solo-picker" aria-label={`${prefix} 测量曲线`} title="单条模式：选择探针或节点以替换当前波形" value={primary?.id??''} onChange={event=>{const signal=signals.find(item=>item.id===event.target.value)??own.find(item=>item.id===event.target.value);if(signal)onSelect(signal)}}>
      {!primary&&<option value="">选择探针 / 曲线</option>}
      {primary?.kind==='transfer'&&<option value={primary.id}>{primary.name} [{primary.unit}]</option>}
      {signals.filter(signal=>signal.measurementId).length>0&&<optgroup label="电路探针">{signals.filter(signal=>signal.measurementId).map(signal=><option key={signal.id} value={signal.id}>{signal.name} [{waveformUnit(result,signal,panel.display)}]</option>)}</optgroup>}
      <optgroup label="节点 / 公式曲线">{signals.filter(signal=>!signal.measurementId&&signal.kind!=='transfer').map(signal=><option key={signal.id} value={signal.id}>{signal.name} [{waveformUnit(result,signal,panel.display)}]</option>)}</optgroup>
      {unavailable.length>0&&<optgroup label="未保存数据的探针">{unavailable.map(measurement=><option key={measurement.id} value={`unavailable:${measurement.id}`} disabled>{measurement.id} · {measurementName(result,measurement)??'目标不在本次电路中'} · 未保存数据，需重新运行</option>)}</optgroup>}
    </select>:<div className="wave-trace-list">
      {!own.length&&<span className="wave-trace-empty">尚无曲线，点击添加</span>}
      {own.map(trace=><div className={`wave-trace-chip${primary?.id===trace.id?' selected':''}`} key={trace.id} data-trace-id={trace.id}>
        <button type="button" className="wave-trace-select" aria-label={`${prefix} 选择曲线 ${trace.name}`} aria-pressed={primary?.id===trace.id} title={`${trace.name} [${trace.unit}]${trace.expression?' · '+trace.expression:''} · 设为游标测量对象`} onClick={()=>onSelect(trace)}><i style={{background:trace.color}}/><span>{trace.name}</span><small>{trace.unit}</small></button>
        {trace.kind==='expression'&&<button type="button" className="wave-trace-edit" aria-label={`${prefix} 编辑公式 ${trace.name}`} title="编辑公式" onClick={event=>open('formula',event.currentTarget,trace.id.slice('expression:'.length))}><Pencil size={12}/></button>}
        <button type="button" className="wave-hide-trace" aria-label={`${prefix} 移除曲线 ${trace.name}`} title="从此视图移除；保留探针和原始数据" onClick={()=>remove(trace)}><X size={12}/></button>
      </div>)}
      {traces.filter(trace=>trace.comparison).map(trace=><span className="wave-trace-reference" key={trace.id} title={`${trace.name} [${trace.unit}]`}><i style={{background:trace.color}}/>{trace.name}</span>)}
    </div>}
    <div className="wave-trace-actions">
      {onSoloToggle&&<button type="button" className="wave-icon-button" aria-label={panel.solo?'恢复叠加曲线':'只显示所选曲线'} title={panel.solo?'恢复叠加曲线':'只显示所选曲线：切换后选择单条波形'} aria-pressed={!!panel.solo} disabled={!primary&&!panel.solo} onClick={onSoloToggle}>{panel.solo?<Layers size={16}/>:<Focus size={16}/>}</button>}
      {onReturnOverview&&<button type="button" className="wave-icon-button" title="返回总览" aria-label="关闭局部细节窗" onClick={onReturnOverview}><RotateCcw size={16}/></button>}
      {!own.length&&onDefault&&<button type="button" className="wave-icon-button" title="恢复默认曲线" aria-label={`${prefix} 恢复默认曲线`} onClick={onDefault}><RotateCcw size={16}/></button>}
      <button type="button" className="wave-icon-button" title="添加曲线" aria-label={`${prefix} 添加曲线`} aria-expanded={mode==='signal'} onClick={event=>mode==='signal'?close():open('signal',event.currentTarget)}><Plus size={16}/></button><button type="button" className="wave-icon-button" aria-label={`${prefix} 添加公式`} aria-expanded={mode==='formula'} disabled={result.analysis==='noise'} title="添加公式：用当前运行的数据计算数学曲线" onClick={event=>mode==='formula'?close():open('formula',event.currentTarget)}><span className="wave-formula-icon">ƒx</span></button></div>
    {mode&&createPortal(<div ref={popup} className="wave-trace-popover" role="group" aria-label={`${prefix} ${mode==='signal'?'添加曲线面板':'公式计算'}`} style={position as CSSProperties} onPointerDown={event=>event.stopPropagation()} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();close()}if(event.key==='Enter'&&event.target instanceof HTMLInputElement){event.preventDefault();mode==='formula'?calculate():add()}}}>
      <header><strong>{mode==='signal'?'添加曲线':editing?'编辑曲线公式':'公式计算'}</strong><button type="button" aria-label={`${prefix} 关闭曲线面板`} onClick={close}><X size={15}/></button></header>
      {mode==='signal'?<>
        <label>筛选曲线<input aria-label={`${prefix} 筛选曲线`} value={query} placeholder="输入节点、探针或曲线名称" onChange={event=>setQuery(event.target.value)}/></label>
        <div className="wave-trace-form-row">
          <select aria-label={`${prefix} 可添加曲线`} disabled={!candidate} value={candidate?.id??''} onChange={event=>setSelected(event.target.value)}>
            {!candidate&&<option value="">没有匹配的可添加曲线</option>}
            {options.some(signal=>signal.measurementId)&&<optgroup label="电路探针">{options.filter(signal=>signal.measurementId).map(signal=><option key={signal.id} value={signal.id}>{signal.name} [{waveformUnit(result,signal,panel.display)}]</option>)}</optgroup>}
            {options.some(signal=>!signal.measurementId)&&<optgroup label="节点 / 公式曲线">{options.filter(signal=>!signal.measurementId).map(signal=><option key={signal.id} value={signal.id}>{signal.name} [{waveformUnit(result,signal,panel.display)}]</option>)}</optgroup>}
            {unavailable.length>0&&<optgroup label="未保存数据的探针">{unavailable.map(measurement=><option key={measurement.id} value={`unavailable:${measurement.id}`} disabled>{measurement.id} · {measurementName(result,measurement)??'目标不在本次电路中'} · 未保存数据，需重新运行</option>)}</optgroup>}
          </select>
          <button type="button" aria-label={`${prefix} 添加所选曲线`} disabled={!candidate} onClick={add}>添加到波形</button>
        </div>
      </>:<><label>曲线公式<div className="wave-trace-form-row"><input aria-label={`${prefix} 曲线公式`} value={formula} maxLength={1000} placeholder="例如 V(vin,vout) 或 V(vout)*I(R1)" onChange={event=>{setFormula(event.target.value);setError('')}}/><button type="button" aria-label={`${prefix} 应用曲线公式`} disabled={!formula.trim()} onClick={calculate}>{editing?'保存公式':'计算并添加'}</button></div></label><p className="wave-trace-form-help">支持电压、电流、差分和 abs、sqrt 等函数。{result.analysis==='ac'?' AC 使用复数相量；V×I 不代表平均功率。':''}</p>{error&&<p className="wave-trace-form-error" role="alert">{error}</p>}</>}
    </div>,document.body)}
  </div>
}
