import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Code2, Download, Play, RotateCcw, Square, X } from 'lucide-react'
import { formatSI } from '../core/circuit'
import { prepareRawNetlist, type RawNetlistResult } from '../core/raw-netlist'
import { useWorkbenchDialog } from './AssistantWindow'

export interface SpiceNetlistEditorProps {visible:boolean;onClose:()=>void;projectId?:string;title:string;netlist:string;generationError?:string}
const draftKey=(id:string)=>`fuxian:netlist-draft:${encodeURIComponent(id)}`
function loadDraft(id:string,generated:string){
  try{const saved=JSON.parse(localStorage.getItem(draftKey(id))??'null');if(saved&&typeof saved.source==='string'&&typeof saved.generated==='string')return saved as {source:string;generated:string}}
  catch{/* Storage may be unavailable; the visible editor still keeps its in-memory draft. */}
  return{source:generated,generated}
}
function exportText(text:string,title:string){
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})),link=document.createElement('a')
  link.href=url;link.download=`${title.replace(/[<>:"/\\|?*]/g,'_')||'circuit'}.cir`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
function exportMeasurements(result:RawNetlistResult){
  const cell=(v:unknown)=>`"${String(v??'').replaceAll('"','""')}"`
  const rows=(result.sweepResults??[result]).flatMap(run=>(run.measurements??[]).map(m=>[run.sweepLabel??'single run',run.analysis,m.name,m.value,m.error??'']))
  const text='step,analysis,measurement,value,error\n'+rows.map(row=>row.map(cell).join(',')).join('\n')
  const url=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/csv;charset=utf-8'})),link=document.createElement('a')
  link.href=url;link.download='netlist-measurements.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}

export default function SpiceNetlistEditor(props:SpiceNetlistEditorProps){
  const identity=props.projectId||'unsaved-project'
  return <NetlistDraft key={identity} {...props} projectId={identity}/>
}
function NetlistDraft({visible,onClose,projectId,title,netlist,generationError}:SpiceNetlistEditorProps&{projectId:string}){
  const panel=useRef<HTMLElement>(null),worker=useRef<Worker|null>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
  const [draft,setDraft]=useState(()=>loadDraft(projectId,netlist)),[storageError,setStorageError]=useState(''),[confirmReset,setConfirmReset]=useState(false)
  const [result,setResult]=useState<RawNetlistResult|null>(null),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('')
  const validation=useMemo(()=>{try{return{prepared:prepareRawNetlist(draft.source),error:''}}catch(e){return{prepared:null,error:(e as Error).message}}},[draft.source])
  useWorkbenchDialog(panel,visible,onClose)
  function dispose(){if(timer.current)clearTimeout(timer.current);timer.current=undefined;worker.current?.terminate();worker.current=null}
  useEffect(()=>()=>dispose(),[])
  function save(source:string,generated=draft.generated){
    const next={source,generated};setDraft(next);setError('');setStatus('');setConfirmReset(false)
    try{localStorage.setItem(draftKey(projectId),JSON.stringify(next));setStorageError('')}
    catch{setStorageError('浏览器无法保存草稿；关闭此窗口仍保留，刷新前请导出 .cir。')}
  }
  // A newly loaded/unfinished schematic may only become generatable after mount.
  // Refresh untouched generated text, while preserving every distinct hand draft.
  useEffect(()=>{
    if(netlist&&draft.source===draft.generated&&draft.generated!==netlist&&!busy&&!result)save(netlist,netlist)
  },[netlist,busy,draft.source,draft.generated,result])
  function cancel(){dispose();setBusy(false);setStatus('已取消仿真；网表草稿保留。')}
  function run(){
    if(!validation.prepared)return
    dispose();setBusy(true);setError('');setStatus('正在启动独立 ngspice…')
    try{
      const task=new Worker(new URL('../raw-netlist.worker.ts',import.meta.url),{type:'module'});worker.current=task
      const finish=()=>{if(worker.current!==task)return false;dispose();setBusy(false);return true}
      const limit=validation.prepared.step?120000:30000
      timer.current=setTimeout(()=>{if(finish()){setError(`网表仿真超过 ${limit/1000} 秒，已停止。请检查收敛、缩短扫描范围或增大步长。`);setStatus('')}},limit)
      task.onmessage=event=>{
        if(worker.current!==task)return
        if(event.data.type==='progress')setStatus(event.data.message)
        if(event.data.type==='result'&&finish()){setResult(event.data.result);setStatus(`仿真完成${event.data.result.sweepResults?` · ${event.data.result.sweepResults.length} 组`:''} · ${event.data.result.points} 点/当前组`)}
        if(event.data.type==='error'&&finish()){setError(event.data.message);setStatus('')}
      }
      task.onerror=event=>{if(finish()){setError(event.message||'ngspice Worker 启动失败。');setStatus('')}}
      task.postMessage({netlist:draft.source})
    }catch(e){dispose();setBusy(false);setError((e as Error).message);setStatus('')}
  }
  return <div className="workbench-window-backdrop netlist-editor-backdrop" hidden={!visible} onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
    <section ref={panel} className="workbench-window netlist-editor-window" role={visible?'dialog':undefined} aria-modal={visible?'true':undefined} aria-label="编辑 SPICE 网表" tabIndex={-1}>
      <header className="workbench-window-heading"><div><span className="workbench-window-kicker">SPICE NETLIST</span><h2><Code2 size={20}/>编辑 SPICE 网表</h2><p>{title} · 手工网表独立仿真，草稿按项目保存。</p></div><button type="button" aria-label="关闭网表编辑器" onClick={onClose}><X size={18}/></button></header>
      <div className="netlist-editor-toolbar"><button type="button" onClick={run} disabled={busy||!!validation.error}><Play size={14}/>验证并仿真</button>{busy&&<button type="button" onClick={cancel}><Square size={14}/>停止</button>}<button type="button" disabled={!draft.source} onClick={()=>exportText(draft.source,title)}><Download size={14}/>导出 .cir</button><button type="button" disabled={busy||!netlist} onClick={()=>setConfirmReset(true)}><RotateCcw size={14}/>从原理图重新生成</button><span>{draft.source===draft.generated?'原理图生成稿':'手工编辑稿'}{busy?' · 仿真中':''}</span></div>
      <div className="netlist-editor-body">
        <p className="netlist-editor-note">可编辑元件、模型、节点和分析指令。此处结果仅属于手工网表，不回写原理图或原图探针。</p>
        {confirmReset&&<div className="netlist-reset-confirm" role="alert">替换为当前原理图生成的网表？现有手工修改会被丢弃。<button type="button" onClick={()=>save(netlist,netlist)}>丢弃修改并重新生成</button><button type="button" onClick={()=>setConfirmReset(false)}>保留草稿</button></div>}
        {draft.generated!==netlist&&<p className="netlist-editor-note" role="status">原理图已变化；当前手工草稿仍保留，可导出后再重新生成。</p>}
        {generationError&&<p className="netlist-editor-note">当前原理图暂不能生成网表：{generationError}。仍可编辑已有草稿。</p>}
        {storageError&&<p role="alert" className="netlist-editor-error">{storageError}</p>}
        <label className="netlist-source-label">网表代码<textarea aria-label="SPICE 网表代码" spellCheck={false} value={draft.source} disabled={busy} onChange={event=>save(event.target.value)}/></label>
        <div className="netlist-validation" role={validation.error?'alert':'status'}>{validation.error||<><Check size={14}/>语法范围检查通过 · {validation.prepared?.analysis.toUpperCase()}；运行时由 ngspice 检查电路和参数。</>}</div>
        {validation.prepared?.notes.map(note=><p key={note} className="netlist-editor-note">{note}</p>)}
        {validation.prepared?.notes.length? <details className="netlist-executed-code"><summary>查看规范化后的实际运行网表</summary><pre>{validation.prepared.executable}</pre></details>:null}
        <details className="netlist-editor-help"><summary>支持的网表语法</summary><p>每次运行一个 AC、TRAN、OP、单源 DC 或 NOISE 分析。支持 .model 和内联 .subckt；.control 内支持 save、ac、tran、op、dc、noise、meas，会转换为等价点指令。外部 .include / .lib、文件数据源、shell、脚本控制命令暂不支持。单次运行限 30 秒，STEP 批次限 120 秒；每组限 100,000 点。</p><p>参数扫描：.step param RVAL list 1k 2k 5k，元件使用 R1 in out &#123;RVAL&#125;。线性扫描：.step param RVAL 1k 5k 1k。温度扫描：.step temp list -40 27 85。仅支持一个顶层扫描，最多 24 组；温度设置采用摄氏度。</p><p>测量：.meas tran output_rms RMS v(out) FROM=1m TO=5m。支持 ac / tran / dc 的 MAX、MIN、PP、AVG、RMS、INTEG、FIND、WHEN 和 TRIG/TARG，由 ngspice 实际执行并输出表格；测量失败保留原因。PARAM 表达式和 OP / NOISE 测量暂不支持。</p><p>噪声格式：.noise v(输出节点[,参考节点]) 输入源 dec|oct|lin 点数 起始频率 终止频率 [汇总间隔]。例如：.noise v(out) V1 dec 20 10 1Meg。输入源为独立电压源或电流源；输出显示 V/√Hz，输入折算显示 V/√Hz 或 A/√Hz。M 表示毫，Meg 表示兆。</p></details>
        {status&&<p role="status" className="netlist-run-status">{status}</p>}{error&&<pre role="alert" className="netlist-editor-error">{error}</pre>}
        {result&&<><div className="netlist-result-heading"><strong>手工网表仿真结果</strong><span>{result.engine} · {result.analysis.toUpperCase()} · {result.sweepResults?`${result.sweepResults.length} 组 · `:''}{(result.elapsed/1000).toFixed(2)} 秒</span></div>{result.netlist!==draft.source&&<p className="netlist-editor-note" role="status">代码已修改，下方仍是上一次运行的结果。</p>}<RawNetlistRuns key={result.timestamp} result={result}/></>}
      </div>
    </section>
  </div>
}

function RawNetlistRuns({result}:{result:RawNetlistResult}){
  const runs=result.sweepResults??[result],[index,setIndex]=useState(0),run=runs[index]??runs[0]
  const hasMeasurements=runs.some(item=>item.measurements?.length)
  return <>
    {result.sweepResults&&<label className="netlist-vector-controls">扫描结果<select aria-label="手工网表扫描结果" value={index} onChange={event=>setIndex(Number(event.target.value))}>{runs.map((item,i)=><option key={i} value={i}>{i+1}. {item.sweepLabel}</option>)}</select><span>每组由 ngspice 独立求解；切换查看对应波形、测量和实际网表。</span></label>}
    {hasMeasurements&&<section aria-label="手工网表自动测量"><div className="netlist-result-heading"><strong>ngspice 自动测量</strong><button type="button" onClick={()=>exportMeasurements(result)}>导出测量 CSV</button></div><div className="netlist-data-table"><table><thead><tr><th>扫描条件</th><th>测量名称</th><th>数值</th><th>状态</th></tr></thead><tbody>{runs.flatMap((item,i)=>(item.measurements??[]).map(measurement=><tr key={`${i}-${measurement.name}`}><td>{item.sweepLabel??'单次运行'}</td><td>{measurement.name}</td><td>{measurement.value===null?'未能测量':measurement.value.toPrecision(7)}</td><td>{measurement.error??'ngspice 测量完成'}</td></tr>))}</tbody></table></div><p className="netlist-editor-note">测量数值采用 ngspice 原始单位（秒、伏、安、赫兹及其组合），详情见实际测量指令与日志。</p></section>}
    <RawNetlistPlot key={`${index}-${run.timestamp}`} result={run}/>
    <details className="netlist-executed-code"><summary>此次运行的原始网表、实际网表与日志</summary><pre>{result.netlist}</pre>{run.executedNetlist&&<pre>{run.executedNetlist}</pre>}<pre>{run.log}{run.warnings.length?`\n${run.warnings.join('\n')}`:''}</pre></details>
  </>
}

function RawNetlistPlot({result}:{result:RawNetlistResult}){
  const [selected,setSelected]=useState(result.analysis==='noise'?result.vectors.find(v=>v.name==='onoise_spectrum')?.name??result.vectors[0].name:result.vectors[0].name),[mode,setMode]=useState<'magnitude'|'phase'|'real'|'imaginary'>('magnitude'),clip=useId()
  const vector=result.vectors.find(v=>v.name===selected)??result.vectors[0],ac=result.analysis==='ac'
  const logarithmic=ac||(result.analysis==='noise'&&result.noise?.sweep!=='lin')
  const values=vector.values.map((value,i)=>!ac?value:mode==='phase'?Math.atan2(vector.imaginary?.[i]??0,value)*180/Math.PI:mode==='magnitude'?Math.hypot(value,vector.imaginary?.[i]??0):mode==='imaginary'?vector.imaginary?.[i]??0:value)
  const unit=vector.unit??(ac&&mode==='phase'?'°':/^v\(/i.test(vector.name)?'V':/^i\(|#branch|\[(?:i|id|ic|ib|is)\]$/i.test(vector.name)?'A':'')
  const W=900,H=260,left=72,right=20,top=22,bottom=38
  const x=result.x.map(value=>logarithmic?Math.log10(value):value),minX=Math.min(x[0],x.at(-1)!),maxX=Math.max(x[0],x.at(-1)!)
  let minY=values.reduce((a,b)=>Math.min(a,b),Infinity),maxY=values.reduce((a,b)=>Math.max(a,b),-Infinity)
  const pad=Math.max((maxY-minY)*.1,Math.abs(maxY)*.01,1e-12);minY-=pad;maxY+=pad
  const px=(index:number)=>left+(x[index]-minX)/(maxX-minX||1)*(W-left-right),py=(value:number)=>top+(maxY-value)/(maxY-minY)*(H-top-bottom)
  const indices:number[]=[]
  for(let start=0,step=Math.max(1,Math.ceil(values.length/1000));start<values.length;start+=step){let lo=start,hi=start;for(let i=start+1;i<Math.min(start+step,values.length);i++){if(values[i]<values[lo])lo=i;if(values[i]>values[hi])hi=i}indices.push(...(lo===hi?[lo]:lo<hi?[lo,hi]:[hi,lo]))}
  const path=indices.map((index,i)=>`${i?'L':'M'}${px(index).toFixed(2)},${py(values[index]).toFixed(2)}`).join(' ')
  const xUnit=result.analysis==='ac'||result.analysis==='noise'?'Hz':result.analysis==='tran'?'s':result.xName==='i-sweep'?'A':result.analysis==='dc'?'V':''
  return <section className="netlist-raw-result" aria-label="手工网表原始向量">
    <div className="netlist-vector-controls"><label>向量<select aria-label="手工网表波形向量" value={selected} onChange={event=>setSelected(event.target.value)}>{result.vectors.map(v=><option key={v.name} value={v.name}>{v.name}</option>)}</select></label>{ac&&<label>显示<select aria-label="手工网表复数显示" value={mode} onChange={event=>setMode(event.target.value as typeof mode)}><option value="magnitude">幅值</option><option value="phase">相位</option><option value="real">实部</option><option value="imaginary">虚部</option></select></label>}<span>{vector.name}{unit?` · ${unit}`:''}</span></div>
    {result.noise&&<p className="netlist-editor-note">输出：{result.noise.output} · 输入折算源：{result.noise.source} · 频率 {logarithmic?'对数':'线性'}坐标{result.noise.totalOutput!==undefined&&result.noise.totalInput!==undefined?` · 频带积分总噪声 RMS：输出 ${formatSI(result.noise.totalOutput,'V',5)}，输入 ${formatSI(result.noise.totalInput,result.noise.inputUnit,5)}`:''}</p>}
    {result.points>1?<svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`手工网表波形 ${vector.name}`}><defs><clipPath id={clip}><rect x={left} y={top} width={W-left-right} height={H-top-bottom}/></clipPath></defs>{Array.from({length:5},(_,i)=>{const y=minY+(maxY-minY)*i/4;return <g key={`y${i}`}><line x1={left} x2={W-right} y1={py(y)} y2={py(y)}/><text x={left-8} y={py(y)+4} textAnchor="end">{formatSI(y,unit,3)}</text></g>})}{Array.from({length:6},(_,i)=>{const coordinate=minX+(maxX-minX)*i/5,p=left+(W-left-right)*i/5;return <g key={`x${i}`}><line x1={p} x2={p} y1={top} y2={H-bottom}/><text x={p} y={H-12} textAnchor="middle">{formatSI(logarithmic?10**coordinate:coordinate,xUnit,3)}</text></g>})}<path clipPath={`url(#${clip})`} d={path} stroke="#237cce" fill="none" strokeWidth="2"/></svg>:<p className="netlist-op-value">{vector.name} = {formatSI(values[0],unit,6)}</p>}
    <details><summary>原始采样数据{result.points>500?'（前 500 点）':''}</summary><div className="netlist-data-table"><table><thead><tr><th>{result.xName}</th><th>{vector.name}{ac?' 实部':''}</th>{ac&&<th>虚部</th>}</tr></thead><tbody>{result.x.slice(0,500).map((coordinate,i)=><tr key={i}><td>{coordinate.toPrecision(7)}</td><td>{vector.values[i].toPrecision(7)}</td>{ac&&<td>{(vector.imaginary?.[i]??0).toPrecision(7)}</td>}</tr>)}</tbody></table></div></details>
  </section>
}
