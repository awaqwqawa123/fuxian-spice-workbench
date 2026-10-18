import type { Result } from './results'
import { evaluateWaveformExpression } from './waveform-expression'
import { analysisSignals } from './circuit'
import { waveformSampleWindow } from './waveform-plot-details'
import type { WaveformDomain, WaveformTrace } from './waveform-workspace'

export interface WaveformExportContext {groupName?:string;profileName?:string;status?:string;stale?:boolean}
export interface WaveformExportArtifact {blob:Blob;filename:string}
export interface WaveformExportApi {exportCurrent:(format:'svg'|'png'|'csv')=>Promise<WaveformExportArtifact>}
export interface WaveformExportMetadata extends WaveformExportContext {
  runId:string;timestamp:number;engine:string;analysis:string;panel:number;range:WaveformDomain;xUnit:string
  traces:{id:string;name:string;unit:string;runId:string;color:string}[]
}
const quote=(value:unknown)=>`"${String(value??'').replace(/"/g,'""')}"`
/** Long rows retain independent comparison/sweep grids and full precision. */
export function waveformSelectedCsv(traces:readonly WaveformTrace[],sources:readonly Result[],metadata:WaveformExportMetadata):string {
  const header=['group','profile','status','stale','analysis','view','range_start','range_end','x_unit','trace_id','trace_name','y_unit','run_id','run_timestamp','engine','sample_index','x','y','real','imag','complex_unit','sample_policy']
  const rows=[header.join(',')]
  for(const trace of traces){
    const source=sources.find(result=>result.id===trace.sourceResultId)??(!trace.comparison?sources.find(result=>result.id===metadata.runId):undefined)
    if(!source)throw new Error(`曲线 ${trace.name} 的原始运行不可用，无法导出。`)
    let complex=trace.complex
    if(!complex&&source.analysis==='ac'&&trace.kind==='transfer'){
      const signal=analysisSignals(source.project)
      complex=evaluateWaveformExpression(source,{id:'export-transfer',expression:`V(${signal.outputNode}) / V(${signal.inputNode})`}).complex
    }
    const window=waveformSampleWindow(trace,metadata.range)
    const complexUnit=trace.kind==='current'?'A':trace.kind==='voltage'?'V':trace.kind==='transfer'?'1':trace.expression?evaluateWaveformExpression(source,{id:'export-unit',expression:trace.expression}).unit:trace.unit
    for(let index=window.first;index<window.end;index++)rows.push([
      metadata.groupName,metadata.profileName,metadata.status,metadata.stale??false,source.analysis,metadata.panel+1,metadata.range[0],metadata.range[1],metadata.xUnit,
      trace.id,trace.name,trace.unit,source.id,source.timestamp,source.engine,index,trace.x[index],trace.y[index],complex?.[index]?.real,complex?.[index]?.img,complex?complexUnit:'','original_saved_samples',
    ].map(quote).join(','))
  }
  return rows.join('\r\n')
}

const svgNamespace='http://www.w3.org/2000/svg'
/** Inline resolved styles so the exported file has no dependency on page CSS. */
export function waveformPlotSvg(plot:SVGSVGElement,metadata:WaveformExportMetadata):string {
  const rect=plot.getBoundingClientRect(),width=Math.max(1,Math.round(rect.width)),height=Math.max(1,Math.round(rect.height))
  const doc=plot.ownerDocument,root=doc.createElementNS(svgNamespace,'svg'),copy=plot.cloneNode(true) as SVGSVGElement
  const legendRows=metadata.traces.flatMap(trace=>{
    const label=`${trace.name} [${trace.unit}] | ${trace.runId}`,limit=Math.max(24,Math.floor((width-40)/7))
    return Array.from({length:Math.ceil(label.length/limit)},(_,i)=>({color:trace.color,text:label.slice(i*limit,(i+1)*limit),first:i===0}))
  })
  const headingHeight=104+legendRows.length*17
  root.setAttribute('width',String(width));root.setAttribute('height',String(height+headingHeight));root.setAttribute('viewBox',`0 0 ${width} ${height+headingHeight}`)
  const data=doc.createElementNS(svgNamespace,'metadata');data.textContent=JSON.stringify(metadata);root.append(data)
  const background=doc.createElementNS(svgNamespace,'rect');background.setAttribute('width','100%');background.setAttribute('height','100%');background.setAttribute('fill','#ffffff');root.append(background)
  const lines=[`${metadata.groupName??'波形'} · 视图 ${metadata.panel+1} · ${metadata.analysis.toUpperCase()}`,`${metadata.profileName??''} | ${new Date(metadata.timestamp).toISOString()} | ${metadata.engine} | ${metadata.stale?'过期结果':metadata.status??'当前结果'}`,`X: ${metadata.range[0]} — ${metadata.range[1]} ${metadata.xUnit} | 运行 ${metadata.runId}`,`当前可见绘图 · ${metadata.traces.length} 条曲线 · 原始数值可另行导出 CSV`]
  lines.forEach((line,index)=>{const text=doc.createElementNS(svgNamespace,'text');text.setAttribute('x','12');text.setAttribute('y',String(18+index*20));text.setAttribute('font-family','Arial, sans-serif');text.setAttribute('font-size',index===0?'13':'10');text.setAttribute('fill','#304f40');text.textContent=line;root.append(text)})
  legendRows.forEach((row,index)=>{
    const y=96+index*17
    if(row.first){const mark=doc.createElementNS(svgNamespace,'line');mark.setAttribute('x1','12');mark.setAttribute('x2','26');mark.setAttribute('y1',String(y-3));mark.setAttribute('y2',String(y-3));mark.setAttribute('stroke',row.color);mark.setAttribute('stroke-width','2');root.append(mark)}
    const text=doc.createElementNS(svgNamespace,'text');text.setAttribute('x','32');text.setAttribute('y',String(y));text.setAttribute('font-family','Arial, sans-serif');text.setAttribute('font-size','10');text.setAttribute('fill','#304f40');text.textContent=row.text;root.append(text)
  })
  const originals=[plot,...plot.querySelectorAll('*')],copies=[copy,...copy.querySelectorAll('*')]
  const styleProperties=['fill','fill-opacity','stroke','stroke-width','stroke-opacity','stroke-dasharray','font-size','font-family','font-weight','opacity','visibility']
  originals.forEach((element,index)=>{const style=doc.defaultView!.getComputedStyle(element);for(const property of styleProperties){const value=style.getPropertyValue(property);if(value)copies[index].setAttribute(property,value)}})
  copy.setAttribute('x','0');copy.setAttribute('y',String(headingHeight));copy.setAttribute('width',String(width));copy.setAttribute('height',String(height));copy.removeAttribute('xmlns');copy.removeAttribute('class');copy.removeAttribute('tabindex');root.append(copy)
  return new doc.defaultView!.XMLSerializer().serializeToString(root)
}

export async function waveformSvgPng(svg:string):Promise<Blob> {
  const blob=new Blob([svg],{type:'image/svg+xml;charset=utf-8'}),url=URL.createObjectURL(blob)
  try{
    const image=new Image()
    await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('波形图片生成失败'));image.src=url})
    const canvas=document.createElement('canvas'),scale=2
    canvas.width=image.width*scale;canvas.height=image.height*scale
    const context=canvas.getContext('2d');if(!context)throw new Error('浏览器无法生成波形图片')
    context.scale(scale,scale);context.drawImage(image,0,0)
    return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('波形图片编码失败')),'image/png'))
  }finally{URL.revokeObjectURL(url)}
}
