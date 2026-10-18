import { useCallback, useMemo, useState } from 'react'
import { ArrowDownToLine, ChartNoAxesCombined, Check, Code2, Copy, Pin, Play, Plus, Ruler, ScanSearch, Trash2, X } from 'lucide-react'
import { analysisSignals, formatSI } from '../core/circuit'
import { compatibleResults, sweepCsv, toCsv, type Result } from '../core/results'
import { buildTestReport } from '../core/test-report'
import { simulationNames, type SimulationProfile } from '../core/simulation-profiles'
import type { CanvasWaveform, WaveformViewState } from '../core/canvas-waveform-store'
import type { Measurement } from '../core/probes'
import { waveformSignals } from '../core/waveform-workspace'
import WaveformDialog from './WaveformDialog'
import WaveformAnalysisTools from './WaveformAnalysisTools'
import WaveformWorkspace, { type ProbeWaveformRequest, type WaveformInspectRequest, type WaveformSnapshot } from './WaveformWorkspace'

interface Props {
  diagram:CanvasWaveform; visible:boolean; docked?:boolean; onDockChange?:(docked:boolean)=>void; profiles:SimulationProfile[]; result:Result|null; history:Result[]
  running:boolean; busy:boolean; progress:string; failure:string; stale:boolean
  measurements:Measurement[]; selectedMeasurement?:string; followProbes?:boolean
  probeRequest?:ProbeWaveformRequest|null; probeRequests?:readonly ProbeWaveformRequest[]
  inspectRequest?:WaveformInspectRequest|null
  onSelectMeasurement:(id:string)=>void; onClose:()=>void; onPatch:(id:string,patch:Partial<CanvasWaveform>)=>void
  onSnapshot:(id:string,snapshot:WaveformSnapshot)=>void; onRun:()=>void
  onAddProfile?:()=>void; onAdd:()=>void; onCopy:()=>void; onRemove:()=>void; canAdd:boolean
}
/** Lightweight controls stay inside the sheet frame; plot settings remain independent. */
export function CanvasWaveformControls({diagram,profiles,result,measurements=[],onPatch,onActivate,running=false,onRun,onAddProfile,onInspect,onEditTraces,onAddDiagram,canAddDiagram=true}:{
  diagram:CanvasWaveform;profiles:SimulationProfile[];onPatch:(id:string,patch:Partial<CanvasWaveform>)=>void
  result?:Result|null;measurements?:Measurement[];onAddProfile?:()=>void;onActivate?:()=>void;running?:boolean;onRun?:()=>void
  onEditTraces?:()=>void;onAddDiagram?:()=>void;canAddDiagram?:boolean
  onInspect?:(mode:WaveformInspectRequest['mode'])=>void
}) {
  const profile=profiles.find(item=>item.id===diagram.profileId),view=diagram.view
  const patch=(values:Partial<CanvasWaveform>)=>{onActivate?.();onPatch(diagram.id,values)}
  const available=result?waveformSignals(result,measurements).signals:[]
  const probes=available.filter(signal=>signal.measurementId)
  const choices=(probes.length?probes:available.filter(signal=>signal.kind==='voltage'||signal.kind==='noise')).slice(0,128)
  function arrange(kind:'overlay'|'split'){
    if(!view||!choices.length)return
    const ids=(kind==='split'?choices.slice(0,4):choices).map(signal=>signal.id)
    if(kind==='overlay'){
      const panels=[...view.panels]
      panels[0]={...panels[0],source:'signals',display:'magnitude',ids,primary:ids[0]}
      patch({view:{...view,layout:1,activePanel:0,panels}})
      return
    }
    const layout=ids.length>2?4:ids.length>1?2:1
    const panels=view.panels.map((panel,index)=>({...panel,source:'signals' as const,display:'magnitude' as const,ids:ids[index]?[ids[index]]:[],primary:ids[index]}))
    patch({view:{...view,layout,activePanel:0,panels}})
  }
  return <div className="canvas-waveform-controls" data-waveform-control="true" onFocusCapture={()=>onActivate?.()} onPointerDown={event=>{event.stopPropagation();onActivate?.()}} onDoubleClick={event=>event.stopPropagation()}>
    <label className="canvas-waveform-profile-control"><span>配置</span><select aria-label={`${diagram.title} 仿真配置`} title={profile?`${profile.name} · ${simulationNames[profile.settings.analysis]}`:'请选择仿真配置'} value={diagram.profileId} onChange={event=>patch({profileId:event.target.value,resultId:undefined,view:undefined})}>
      {!profile&&<option value={diagram.profileId}>配置已删除</option>}{profiles.map(item=><option key={item.id} value={item.id}>{item.name===simulationNames[item.settings.analysis]?item.name:`${item.name} · ${simulationNames[item.settings.analysis]}`}</option>)}
    </select></label>
    {onAddProfile&&<button type="button" aria-label={`${diagram.title} 添加仿真配置`} title="添加仿真配置" aria-haspopup="dialog" disabled={profiles.length>=24} onClick={onAddProfile}><Plus size={12}/>添加仿真</button>}
    <label className="canvas-waveform-layout-control"><select aria-label={`${diagram.title} 视图数量`} value={view?.layout??1} disabled={!view} title={view?'图内视图数量；各视图保留已选曲线':'运行此配置后可设置视图'} onChange={event=>view&&patch({view:{...view,layout:Number(event.target.value) as 1|2|4,activePanel:Math.min(view.activePanel??0,Number(event.target.value)-1)}})}>
      <option value="1">1 图</option><option value="2">2 图</option><option value="4">4 图</option>
    </select></label>
    {!!view&&view.layout>1&&<label className="canvas-waveform-target-control"><select title="新探针加入哪个视图；也可直接点击下方图表" aria-label={`${diagram.title} 接收探针视图`} value={view.activePanel??0} onChange={event=>patch({view:{...view,activePanel:Number(event.target.value)}})}>{Array.from({length:view.layout},(_,index)=><option key={index} value={index}>探针 → {index+1}</option>)}</select></label>}
    {onRun&&<button type="button" aria-label={`${diagram.title} 运行此配置`} disabled={running||!profile} onClick={onRun}><Play size={12}/>{running?'运行中':'运行'}</button>}
    <div className="canvas-waveform-arrange" role="group" aria-label="波形曲线排列">
      <button type="button" aria-label={`${diagram.title} 叠加曲线到一张图`} title="把已放置的探针叠加在一张图；没有探针时叠加电压节点" disabled={!view||!choices.length} onClick={()=>arrange('overlay')}>叠加曲线</button>
      <button type="button" aria-label={`${diagram.title} 按探针分图`} title="每个探针或电压节点单独占一个视图" disabled={!view||choices.length<2} onClick={()=>arrange('split')}>按探针分图</button>
      {onEditTraces&&<button type="button" aria-label={`${diagram.title} 选择曲线`} title="逐条选择每个视图的曲线" onClick={onEditTraces}>选曲线</button>}
      {onAddDiagram&&<button type="button" aria-label={`${diagram.title} 新建独立图窗`} title="新增一个可独立配置的画布波形图" disabled={!canAddDiagram} onClick={onAddDiagram}><Plus size={12}/>新图窗</button>}
    </div>
    {onInspect&&<div className="canvas-waveform-inspection"><button type="button" aria-label={`${diagram.title} 局部放大`} title="放大镜：框选区间，在细节窗局部放大" onClick={()=>onInspect('zoom')}><ScanSearch size={12}/>放大</button><button type="button" aria-label={`${diagram.title} A/B 测量`} title="拖动 A/B 光标测量" onClick={()=>onInspect('measure')}><Ruler size={12}/>A/B</button></div>}
  </div>
}
function download(name:string,text:string,type='text/plain'){
  const url=URL.createObjectURL(new Blob([text],{type})),link=document.createElement('a')
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
export default function CanvasWaveformResults({diagram,visible,docked,onDockChange,profiles,result,history,running,busy,progress,failure,stale,measurements,selectedMeasurement,probeRequest,probeRequests,inspectRequest,followProbes=false,onSelectMeasurement,onClose,onPatch,onSnapshot,onRun,onAddProfile,onAdd,onCopy,onRemove,canAdd}:Props) {
  const [comparison,setComparison]=useState<Result|null>(null)
  const [overlaySweep,setOverlaySweep]=useState(false)
  const snapshot=useCallback((value:WaveformSnapshot)=>onSnapshot(diagram.id,value),[diagram.id,onSnapshot])
  const view=useCallback((value:WaveformViewState)=>onPatch(diagram.id,{view:value}),[diagram.id,onPatch])
  const profile=profiles.find(p=>p.id===diagram.profileId),matches=result&&comparison&&compatibleResults(result,comparison)?comparison:null
  const tail=result?.vout.slice(Math.floor(result.vout.length*.6))??[],pp=tail.length?tail.reduce((max,value)=>Math.max(max,value),-Infinity)-tail.reduce((min,value)=>Math.min(min,value),Infinity):0
  const currentSource=result?analysisSignals(result.project).sourceId:''
  const report=useMemo(()=>result?buildTestReport(result):null,[result])
  const toolSignals=useMemo(()=>result?waveformSignals(result,measurements,diagram.view?.panels[diagram.view?.activePanel??0]?.expressions).signals:[],[result,measurements,diagram.view])
  return <WaveformDialog visible={visible} docked={docked} onDockChange={onDockChange} onClose={onClose}><section className="free-results panel" aria-label="仿真结果" hidden={!visible} data-waveform-settings={diagram.id} data-empty={!result&&!running?'true':undefined}>
    <div className="diagram-settings-toolbar">
      <div className="diagram-settings-fields">
        <label><span>图框名称</span><input aria-label="波形图名称" value={diagram.title} maxLength={80} onChange={event=>onPatch(diagram.id,{title:event.target.value})}/></label>
        <div className="diagram-profile-setting"><label><span>仿真配置</span><select aria-label="波形图仿真配置" value={diagram.profileId} onChange={event=>onPatch(diagram.id,{profileId:event.target.value,resultId:undefined,view:undefined})}>
          {!profile&&<option value={diagram.profileId}>原配置已删除，请重新选择</option>}{profiles.map(p=><option key={p.id} value={p.id}>{p.name} · {simulationNames[p.settings.analysis]}</option>)}
        </select></label>
        {onAddProfile&&<button type="button" aria-label="为此图框添加仿真配置" disabled={profiles.length>=24} onClick={onAddProfile}><Plus size={14}/>新建配置</button>}</div>
        <label><span>显示结果</span><select aria-label="波形图显示结果" value={diagram.resultId??''} onChange={event=>onPatch(diagram.id,{resultId:event.target.value||undefined})}><option value="">此配置的最新运行</option>{history.map(h=><option key={h.id} value={h.id}>{new Date(h.timestamp).toLocaleTimeString('zh-CN')} · {simulationNames[h.analysis]}{h.sweepLabel?` · ${h.sweepLabel}`:''}</option>)}{diagram.resultId&&!history.some(h=>h.id===diagram.resultId)&&<option value={diagram.resultId}>所选运行已不在历史中</option>}</select></label>
        {!!result?.sweepResults?.length&&<label><span>扫描取值</span><select aria-label="扫描取值" value={result.id} onChange={event=>onPatch(diagram.id,{resultId:event.target.value})}>{result.sweepResults.map(leaf=><option key={leaf.id} value={leaf.id}>{leaf.sweepLabel}</option>)}</select></label>}
        {!!result?.sweepResults?.length&&result.analysis!=='op'&&<label><span>扫描对比</span><span><input type="checkbox" checked={overlaySweep} onChange={event=>setOverlaySweep(event.target.checked)}/>叠加扫描曲线</span></label>}
      </div>
      <div className="diagram-settings-actions"><button type="button" onClick={onAdd} disabled={!canAdd}><Plus size={14}/>新增图框</button><button type="button" onClick={onCopy} disabled={!canAdd}><Copy size={14}/>复制图框</button><button type="button" onClick={onRemove}><Trash2 size={14}/>删除图框</button></div>
    </div>
    <div className="results-toolbar"><div className="free-results-title"><strong>{diagram.title||'波形图'}</strong><small>{profile?.name??'未绑定配置'}</small></div><div className="result-actions">
      <button className="primary" disabled={busy||!profile} onClick={onRun}><Play size={14}/>运行此配置</button>
      <button disabled={!result||result.analysis==='op'} onClick={()=>result&&setComparison(structuredClone(result))}><Pin size={14}/>固定对比</button>
      <button disabled={!result} onClick={()=>result&&download(`${diagram.title||'waveform'}.csv`,toCsv(result),'text/csv')}><ArrowDownToLine size={15}/>CSV</button>
      {!!result?.sweepResults?.length&&<button onClick={()=>download('sweep.csv',sweepCsv(result),'text/csv')}>全部扫描 CSV</button>}
      {result&&<button onClick={()=>download('fuxian-last-run.cir',result.netlist)}><Code2 size={15}/>本次网表</button>}
    </div></div>
    {comparison&&<div className="editor-comparison"><Pin size={12}/>已固定：{simulationNames[comparison.analysis]} · {new Date(comparison.timestamp).toLocaleTimeString('zh-CN')}{result&&!matches&&<span>（分析类型不同，暂不叠加）</span>}<button onClick={()=>setComparison(null)} aria-label="移除固定对比"><X size={13}/></button></div>}
    {failure&&<div className="error-banner" role="alert"><strong>仿真未完成</strong><span>{failure}</span></div>}
    {running&&<div className="running-banner" role="status"><span className="spinner"/>{progress}</div>}
    {stale&&<div className="stale-banner"><span className="state-dot amber"/>电路或此配置已修改，当前显示上次运行结果。<button disabled={busy||!profile} onClick={onRun}>重新运行此配置</button></div>}
    {result?<><details className={`circuit-test-report${stale?' is-stale':''}`} aria-label="本次测量结果" key={result.id}>
        <summary><span>{result.analysis==='op'?'直流测试点':'本次测量结果'}</span><small>{report?.measurements.length??0} 项 · {stale?'结果已过期':diagram.resultId?'历史运行':'最新运行'} · {result.engine}</small></summary>
        <div className="circuit-test-report-content"><p>{stale?'电路或配置已修改，这些数值来自上次运行。':'以下数值来自本次求解器采样。'} 正式报告请在项目顶栏完成所有测试后生成。</p>
        <div className="circuit-test-report-meta"><span>{new Date(result.timestamp).toLocaleString('zh-CN')}</span><span>运行 ID：{report?.runId}</span></div>
        <table><thead><tr><th>测量项目</th><th>数值</th><th>依据</th></tr></thead><tbody>{report?.measurements.map((item,index)=><tr key={`${item.name}-${index}`}><td>{item.name}</td><td>{item.value}</td><td>{item.source}</td></tr>)}</tbody></table></div>
      </details><details className="result-summary"><summary>仿真摘要 · {result.points.toLocaleString()} 点 · {result.engine}</summary><div className="metrics-row"><div className="metric"><span>{result.analysis==='noise'?'输出噪声总量':result.analysis==='ac'?'扫描内峰值增益':result.analysis==='tran'?'输出峰峰值':'输出电压'}</span><strong>{result.analysis==='noise'?(result.noise?.totalOutput!==undefined?formatSI(result.noise.totalOutput,'V RMS',4):'未返回积分值'):result.analysis==='ac'?`${result.peakDb!.toFixed(2)} dB`:formatSI(result.analysis==='tran'?pp:result.vout.at(-1)!,'V',4)}</strong><small>{result.analysis==='noise'?`${formatSI(result.x[0],'Hz')} → ${formatSI(result.x.at(-1)!,'Hz')}`:result.analysis==='ac'?`位于 ${formatSI(result.peakFrequency!,'Hz')}`:result.analysis==='tran'?'仿真时间后 40% 的样本':'相对 GND'}</small></div><div className="metric"><span>实际采样点</span><strong>{result.points.toLocaleString()}</strong><small>{simulationNames[result.analysis]}</small></div><div className="metric"><span>本次计算</span><strong>{(result.elapsed/1000).toFixed(2)} s</strong><small>{result.engine}</small></div></div></details>
      {result.analysis==='op'?<div className="op-table"><table><thead><tr><th>测量对象</th><th>数值</th></tr></thead><tbody>{Object.entries(result.voltages??{VIN:result.vin,VOUT:result.vout}).map(([name,values])=><tr key={name}><td>{name}</td><td>{formatSI(values[0],'V',6)}</td></tr>)}<tr><td>I({currentSource}) · 流入正端</td><td>{formatSI(result.current[0],'A',6)}</td></tr></tbody></table></div>:<WaveformWorkspace key={diagram.profileId} onSnapshot={snapshot} initialView={diagram.view} onViewChange={view} result={result} comparison={matches} sweepComparisons={overlaySweep?result.sweepResults:undefined} measurements={measurements} probeRequest={probeRequest} probeRequests={probeRequests} inspectRequest={inspectRequest} selectedMeasurement={visible||followProbes?selectedMeasurement:undefined} onSelectMeasurement={onSelectMeasurement}/>}
      <WaveformAnalysisTools result={result} signals={toolSignals}/>
      <div className="result-footer"><span><Check size={13}/>由画布连接生成网表 · 真实 ngspice 求解 · {result.project.temperature??27} °C {result.sweepLabel??''}</span><details><summary>运行日志</summary><pre>{result.warnings.join('\n')}{'\n'}{result.log}</pre></details></div>
    </>:!running&&<div className="free-empty-results"><div><ChartNoAxesCombined size={24} aria-hidden="true"/><strong>此图框还没有仿真结果</strong><p>选择配置并点击“运行此配置”。运行完成后可选择曲线、调整布局和查看历史。</p></div></div>}
  </section></WaveformDialog>
}
