import { useMemo, useState } from 'react'
import type { Device } from '../core/drawing'
import type { Project } from '../core/circuit'
import { parseQuantity } from '../core/circuit'
import { buildSourcePreview, formatPreviewQuantity } from '../core/source-preview'

/** A configuration preview, not ngspice's result or the circuit's response. */
export default function SourceWaveformPreview({device,project}:{device:Device;project:Project}) {
  const [window,setWindow]=useState({start:'',stop:''})
  const automatic=useMemo(()=>buildSourcePreview(device,project),[device,project])
  let range:{start:number;stop:number}|undefined,windowError=''
  try{if(window.start||window.stop)range={start:parseQuantity(window.start||'0','time'),stop:parseQuantity(window.stop||String(automatic.stop),'time')}}catch{windowError='请填写有效的开始、结束时间，例如 0s、2ms。'}
  const preview=useMemo(()=>range?buildSourcePreview(device,project,range):automatic,[device,project,automatic,range?.start,range?.stop])
  const error=windowError||preview.error
  const left=56,right=314,top=14,bottom=132
  const x=(t:number)=>left+(t-preview.start)/(preview.stop-preview.start)*(right-left)
  const y=(v:number)=>bottom-(v-preview.min)/(preview.max-preview.min)*(bottom-top)
  const path=error?'':preview.points.map(([t,v],i)=>`${i?'L':'M'}${x(t).toFixed(2)},${y(v).toFixed(2)}`).join(' ')
  return <section className="source-waveform-preview" aria-label={`${device.id} 输出波形预览`}>
    <div className="source-preview-heading"><strong>输出波形 · {preview.unit}</strong><span>配置预览</span></div>
    <div className="source-preview-window"><label>开始<input aria-label={`${device.id} 预览开始时间`} placeholder="自动 · 0s" value={window.start} onChange={event=>setWindow({...window,start:event.target.value})}/></label><label>结束<input aria-label={`${device.id} 预览结束时间`} placeholder={`自动 · ${formatPreviewQuantity(preview.stop,'s')}`} value={window.stop} onChange={event=>setWindow({...window,stop:event.target.value})}/></label><button type="button" onClick={()=>setWindow({start:'',stop:''})}>自动</button></div>
    {error?<p className="parameter-error" role="alert">无法预览：{error}</p>:<svg viewBox="0 0 332 164" role="img" aria-label={`${device.id} 瞬态输出波形，纵轴 ${preview.unit}，横轴 s`} data-preview-start={preview.start} data-preview-stop={preview.stop} data-preview-min={preview.min} data-preview-max={preview.max}>
      {[0,1,2,3,4].map(i=>{const yy=top+i*(bottom-top)/4,value=preview.max-i*(preview.max-preview.min)/4;return <g key={`y${i}`}><line x1={left} x2={right} y1={yy} y2={yy} className="source-preview-grid"/><text x={left-5} y={yy+3} textAnchor="end">{formatPreviewQuantity(value,preview.unit)}</text></g>})}
      {[0,1,2,3,4].map(i=>{const xx=left+i*(right-left)/4,value=preview.start+i*(preview.stop-preview.start)/4;return <g key={`x${i}`}><line x1={xx} x2={xx} y1={top} y2={bottom} className="source-preview-grid"/><text x={xx} y={bottom+17} textAnchor="middle">{formatPreviewQuantity(value,'s')}</text></g>})}
      <path d={`M${left},${top}V${bottom}H${right}`} className="source-preview-axis"/><path d={path} className="source-preview-line"/>
    </svg>}
    {preview.note&&<small>{preview.note}</small>}
    <small>按瞬态源函数计算，V／I 为引脚 1 → 2 的电压／电流；不包含负载响应。DC、AC 使用各自设置。</small>
  </section>
}
