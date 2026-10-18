import { useId, useMemo, useState } from 'react'
import { analysisSignals, formatSI } from '../core/circuit'
import { measureCursors, nearestSample } from '../core/measurements'
import { compatibleResults, resultXAxisUnit, type Result } from '../core/results'
import { probeColors, resolveMeasurement, type Measurement } from '../core/probes'

type Trace = { id?:string; name:string; x:number[]; y:number[]; color:string; dashed?:boolean }
const colors=probeColors
export default function Waveform({result,comparison,phase,measurements,selectedMeasurement,onSelectMeasurement}:{result:Result;comparison:Result|null;phase:boolean;measurements?:Measurement[];selectedMeasurement?:string;onSelectMeasurement?:(id:string)=>void}) {
  const ac=result.analysis==='ac', dc=result.analysis==='dc'
  const signals=analysisSignals(result.project)
  const available=result.voltages??{[`v(${signals.inputNode})`]:result.vin,[`v(${signals.outputNode})`]:result.vout}
  const [chosen,setChosen]=useState(()=>[...new Set([`v(${signals.outputNode})`,`v(${signals.inputNode})`])])
  const [localMode,setMode]=useState<'voltage'|'current'>('voltage')
  const [localPrimary,setLocalPrimary]=useState<string>()
  const [hover,setHover]=useState<number|null>(null),[zoom,setZoom]=useState(1)
  const [active,setActive]=useState<'a'|'b'|null>(null)
  const [cursorA,setCursorA]=useState<number|null>(null),[cursorB,setCursorB]=useState<number|null>(null)
  const clipId=useId()
  const measured=useMemo(()=>measurements?.length?measurements.map(m=>resolveMeasurement(result,m)).filter(t=>t!==null):null,[result,measurements])
  const selectedId=selectedMeasurement??localPrimary
  const selectedTrace=measured?.find(t=>t.id===selectedId)
  const mode=selectedTrace?.kind??(measured?.length&&!measured.some(t=>t.kind===localMode)?measured[0].kind:localMode)
  const allTraces:Trace[]=measured?measured.filter(t=>t.kind===mode).map(t=>({id:t.id,name:t.name,x:result.x,y:ac?(phase?t.phase!:t.magnitude!):t.values,color:t.color}))
    :ac?[{name:phase?'VOUT / VIN · 相位':'VOUT / VIN · 增益',x:result.x,y:phase?result.phase:result.magnitude,color:colors[0]}]
    :mode==='current'?[{name:`I(${signals.sourceId})`,x:result.x,y:result.current,color:'#c47b26'}]
    :chosen.filter(name=>available[name]).map((name,i)=>({name,x:result.x,y:available[name],color:colors[i%colors.length]}))
  if(!allTraces.length){if(measured)return <div className="waveform probe-unavailable" role="status">当前仿真没有这些探针的数据，请重新运行仿真或选择已保存的节点。</div>;allTraces.push({name:'VOUT',x:result.x,y:result.vout,color:colors[0]})}
  const primary=allTraces.find(t=>t.id===selectedId)??allTraces[0]
  if(comparison&&compatibleResults(result,comparison)){
    if(measured){const measurement=measurements?.find(m=>m.id===primary.id),trace=measurement?resolveMeasurement(comparison,measurement):null;if(trace)allTraces.push({name:`对比 · ${trace.name}`,x:comparison.x,y:ac?phase?trace.phase!:trace.magnitude!:trace.values,color:'#a16d31',dashed:true})}
    else allTraces.push({name:`对比 · ${comparison.project.title}`,x:comparison.x,y:ac?phase?comparison.phase:comparison.magnitude:mode==='current'?comparison.current:comparison.vout,color:'#a16d31',dashed:true})
  }
  const W=1000,H=255,l=65,r=22,top=20,bottom=40
  const log=(x:number)=>ac?Math.log10(x):x
  const allMin=Math.min(...allTraces.map(t=>Math.min(log(t.x[0]),log(t.x.at(-1)!)))),allMax=Math.max(...allTraces.map(t=>Math.max(log(t.x[0]),log(t.x.at(-1)!))))
  const minX=allMin,maxX=allMin+Math.max(allMax-allMin,1e-12)/zoom
  const values=allTraces.flatMap(t=>t.y.filter((_,i)=>log(t.x[i])>=minX&&log(t.x[i])<=maxX))
  let minY=values.reduce((v,n)=>Math.min(v,n),Infinity),maxY=values.reduce((v,n)=>Math.max(v,n),-Infinity)
  if(!values.length){minY=0;maxY=1}
  const pad=Math.max((maxY-minY)*.12,ac?1:mode==='current'?1e-9:.001)
  minY-=pad;maxY+=pad
  const px=(x:number)=>l+(log(x)-minX)/(maxX-minX)*(W-l-r),py=(y:number)=>top+(maxY-y)/(maxY-minY)*(H-top-bottom)
  const xTicks=Array.from({length:6},(_,i)=>minX+(maxX-minX)*i/5),yTicks=Array.from({length:5},(_,i)=>minY+(maxY-minY)*i/4)
  const tracePath=(t:Trace)=>{
    const indices=[0],size=Math.max(1,Math.ceil(t.x.length/1200))
    for(let start=1;start<t.x.length-1;start+=size){
      let min=start,max=start
      for(let i=start+1;i<Math.min(start+size,t.x.length-1);i++){if(t.y[i]<t.y[min])min=i;if(t.y[i]>t.y[max])max=i}
      indices.push(...(min===max?[min]:min<max?[min,max]:[max,min]))
    }
    indices.push(t.x.length-1)
    return indices.map((i,n)=>`${n?'L':'M'}${px(t.x[i]).toFixed(2)},${py(t.y[i]).toFixed(2)}`).join(' ')
  }
  const unit=ac?phase?'°':measured?mode==='current'?'dBA':'dBV':'dB':mode==='current'?'A':'V',xUnit=resultXAxisUnit(result)
  const fromFraction=(fraction:number)=>ac?10**(minX+fraction*(maxX-minX)):minX+fraction*(maxX-minX)
  const fraction=(clientX:number,svg:SVGSVGElement)=>{
    const box=svg.getBoundingClientRect(),x=(clientX-box.left)/box.width*W
    return Math.max(0,Math.min(1,(x-l)/(W-l-r)))
  }
  const hoverX=hover===null?null:fromFraction(hover)
  const validCursor=(index:number|null)=>index!==null&&index<primary.x.length?index:null
  const a=validCursor(cursorA),b=validCursor(cursorB)
  const delta=a!==null&&b!==null?measureCursors(primary.x,primary.y,a,b):null
  const yFormat=(n:number)=>ac?`${Number(n.toPrecision(5))} ${unit}`:formatSI(n,unit,5)
  function pin(f:number){if(!active)return;const index=nearestSample(result.x,fromFraction(f),ac);if(active==='a'){setCursorA(index);setActive('b')}else{setCursorB(index);setActive('a')}}
  function resetCursors(){setCursorA(null);setCursorB(null);setActive(null)}
  function selectTrace(id:string){setLocalPrimary(id);onSelectMeasurement?.(id);resetCursors()}
  return <div className="waveform">
    {(!ac||measured)&&<div className="trace-controls"><label>测量<select aria-label="波形测量类型" value={mode} onChange={e=>{const kind=e.target.value as 'voltage'|'current';setMode(kind);const first=measured?.find(t=>t.kind===kind);if(first)selectTrace(first.id);else resetCursors()}}><option value="voltage" disabled={!!measured&&!measured.some(t=>t.kind==='voltage')}>节点 / 差分电压</option><option value="current" disabled={!!measured&&!measured.some(t=>t.kind==='current')}>{measured?'导线 / 器件电流':'输入源电流'}</option></select></label>{measured?<small>{ac?phase?'探针相位，单位 °':mode==='current'?'电流幅度，0 dBA = 1 A':'电压幅度，0 dBV = 1 V':mode==='current'?'正方向：沿图中箭头；器件探针为 1 → 2':'差分电压 = 正端 − 负端'} · 点击曲线名称选择游标测量对象</small>:mode==='voltage'?<div className="trace-options">{Object.keys(available).map(name=><label key={name}><input type="checkbox" checked={chosen.includes(name)} disabled={chosen.length===1&&chosen.includes(name)} onChange={e=>{setChosen(old=>e.target.checked?[...old,name]:old.filter(n=>n!==name));resetCursors()}}/>{name}</label>)}</div>:<small>正方向：流入 {signals.sourceId} 正端</small>}</div>}
    {measured&&measured.length!==measurements!.length&&<p className="cursor-hint" role="status">部分探针不在这次仿真的数据中，未显示缺失曲线。</p>}
    <div className="plot-legend">{allTraces.map(t=>t.id?<button key={t.id} className="probe-trace-button" aria-pressed={primary.id===t.id} onClick={()=>selectTrace(t.id!)}><i style={{background:t.color}}/>{t.name}</button>:<span key={t.id??t.name}><i style={{background:t.color}}/>{t.name}</span>)}<div className="plot-zoom"><button aria-pressed={active==='a'} onClick={()=>setActive(active==='a'?null:'a')}>游标 A</button><button aria-pressed={active==='b'} onClick={()=>setActive(active==='b'?null:'b')}>游标 B</button><button onClick={resetCursors} disabled={cursorA===null&&cursorB===null&&active===null}>清除游标</button><button onClick={()=>setZoom(z=>Math.min(z*2,8))} disabled={zoom===8}>放大</button><button onClick={()=>setZoom(1)} disabled={zoom===1}>重置</button></div></div>
    {active&&<p className="cursor-hint">在波形上点击放置游标 {active.toUpperCase()}，测量曲线：{primary.name}</p>}
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ac?phase?'相位频率响应':measured?'探针幅度频率响应':'增益频率响应':dc?'直流扫描波形':measured?'探针瞬态波形':'输入和输出的瞬态波形'} onPointerMove={e=>setHover(fraction(e.clientX,e.currentTarget))} onPointerLeave={()=>setHover(null)} onClick={e=>pin(fraction(e.clientX,e.currentTarget))}>
      <defs><clipPath id={clipId}><rect x={l} y={top} width={W-l-r} height={H-top-bottom}/></clipPath></defs>
      {yTicks.map(v=><g key={v}><line className="plot-grid" x1={l} x2={W-r} y1={py(v)} y2={py(v)}/><text className="plot-label" x={l-10} y={py(v)+4} textAnchor="end">{Math.abs(v)<(maxY-minY)*1e-12?'0':mode==='current'&&!ac?formatSI(v,'',3):Number(v.toPrecision(3))}</text></g>)}
      {xTicks.map(v=><g key={v}><line className="plot-grid" x1={l+(v-minX)/(maxX-minX)*(W-l-r)} x2={l+(v-minX)/(maxX-minX)*(W-l-r)} y1={top} y2={H-bottom}/><text className="plot-label" x={l+(v-minX)/(maxX-minX)*(W-l-r)} y={H-12} textAnchor="middle">{formatSI(ac?10**v:v,xUnit,3)}</text></g>)}
      <text className="plot-label" x={l} y="12">{unit}</text>
      <g clipPath={`url(#${clipId})`}>
        {ac&&!measured&&!phase&&minY< -3.0103&&maxY> -3.0103&&<line x1={l} x2={W-r} y1={py(-3.0103)} y2={py(-3.0103)} stroke="#8a97a7" strokeDasharray="3 5"/>}
        {allTraces.map(t=><path key={t.id??t.name} d={tracePath(t)} fill="none" stroke={t.color} strokeWidth="2.1" strokeLinejoin="round" strokeDasharray={t.dashed?'6 4':undefined}/>)}
        {hoverX!==null&&<><line x1={px(hoverX)} x2={px(hoverX)} y1={top} y2={H-bottom} stroke="#7c8999" strokeDasharray="3 4"/>{allTraces.map(t=>{const i=nearestSample(t.x,hoverX,ac);return <circle key={t.id??t.name} cx={px(t.x[i])} cy={py(t.y[i])} r="3.5" fill={t.color}/>})}</>}
        {([['A',a],['B',b]] as const).map(([name,index])=>index!==null&&<g key={name} className="pinned-cursor"><line x1={px(result.x[index])} x2={px(result.x[index])} y1={top} y2={H-bottom} stroke={name==='A'?'#c57e20':'#9457b4'} strokeDasharray="5 3"/><text x={px(result.x[index])+5} y={top+13} fill={name==='A'?'#c57e20':'#9457b4'}>{name}</text><circle cx={px(result.x[index])} cy={py(primary.y[index])} r="4" fill="white" stroke={primary.color}/></g>)}
      </g>
    </svg>
    <div className="cursor-readout">{hoverX===null?<span>移动鼠标读取波形 · {ac?'对数频率轴':dc?`扫描 ${result.project.dc?.sourceId??signals.sourceId} ${xUnit==='A'?'电流':'电压'}`:'线性时间轴'}</span>:<><strong>{formatSI(hoverX,xUnit,5)}</strong>{allTraces.map(t=><span key={t.id??t.name} style={{color:t.color}}>{t.name}　{yFormat(t.y[nearestSample(t.x,hoverX,ac)])}</span>)}</>}</div>
    {(a!==null||b!==null)&&<div className="measurement-readout"><strong>{primary.name}</strong>{a!==null&&<span>A: {formatSI(primary.x[a],xUnit,5)} / {yFormat(primary.y[a])}</span>}{b!==null&&<span>B: {formatSI(primary.x[b],xUnit,5)} / {yFormat(primary.y[b])}</span>}{delta&&<><b>Δ{xUnit==='s'?'t':ac?'f':xUnit}: {formatSI(delta.dx,xUnit,5)}</b><b>ΔY: {yFormat(delta.dy)}</b>{xUnit==='s'&&delta.dx!==0&&<span>1/|Δt|: {formatSI(1/Math.abs(delta.dx),'Hz',5)}</span>}</>}</div>}
  </div>
}
