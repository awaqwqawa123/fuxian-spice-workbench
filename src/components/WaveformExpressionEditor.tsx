import { useState } from 'react'
import type { Result } from '../core/results'
import { evaluateWaveformExpression, type WaveformExpression } from '../core/waveform-expression'
import { removePanelExpression, upsertPanelExpression, type WaveformPanel } from '../core/waveform-workspace'

export default function WaveformExpressionEditor({panel,result,index,onChange,embedded=false,availableHeight=500}:{panel:WaveformPanel;result:Result;index:number;onChange:(panel:WaveformPanel)=>void;embedded?:boolean;availableHeight?:number}) {
  const [editing,setEditing]=useState<string|null>(null),[name,setName]=useState(''),[expression,setExpression]=useState(''),[error,setError]=useState('')
  const [page,setPage]=useState(0)
  const [subpage,setSubpage]=useState(0)
  const expressions=panel.expressions??[],currentPage=Math.min(page,Math.max(0,expressions.length-1))
  const clear=()=>{setEditing(null);setName('');setExpression('');setError('')}
  const save=()=>{
    if(result.analysis==='noise')return
    try {
      const definition:WaveformExpression={id:editing??crypto.randomUUID(),...(name.trim()?{name:name.trim()}:{}),expression:expression.trim()}
      evaluateWaveformExpression(result,definition)
      onChange(upsertPanelExpression(panel,definition));clear()
    }catch(error){setError((error as Error).message)}
  }
  if(embedded&&availableHeight<350){
    const labels=['已保存曲线','曲线名称','表达式','应用与提示'],active=Math.min(subpage,3)
    return <section className="wave-expression-inline wave-bounded-form" aria-label={`视图 ${index+1} 数学曲线`}>
      <div className="wave-form-page-nav"><button type="button" disabled={!active} onClick={()=>setSubpage(active-1)}>上一页</button><select aria-label="数学曲线页面" value={active} onChange={event=>setSubpage(Number(event.target.value))}>{labels.map((label,i)=><option value={i} key={label}>{label} · {i+1}/4</option>)}</select><button type="button" disabled={active===3} onClick={()=>setSubpage(active+1)}>下一页</button></div>
      <div hidden={active!==0} className="wave-form-actions">{expressions.length?<><div className="wave-expression-item"><span title={expressions[currentPage].expression}><b>{expressions[currentPage].name??expressions[currentPage].expression}</b></span><button type="button" aria-label={`编辑表达式 ${expressions[currentPage].name??expressions[currentPage].expression}`} onClick={()=>{const item=expressions[currentPage];setEditing(item.id);setName(item.name??'');setExpression(item.expression);setError('');setSubpage(2)}}>编辑</button><button type="button" aria-label={`删除表达式 ${expressions[currentPage].name??expressions[currentPage].expression}`} onClick={()=>{onChange(removePanelExpression(panel,expressions[currentPage].id));if(editing===expressions[currentPage].id)clear()}}>删除</button></div><div className="wave-form-page-nav"><button type="button" disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>上一个</button><span>{currentPage+1}/{expressions.length}</span><button type="button" disabled={currentPage>=expressions.length-1} onClick={()=>setPage(currentPage+1)}>下一个</button></div></>:<p>尚无数学曲线，请填写名称与表达式。</p>}</div>
      <div hidden={active!==1} className="wave-form-fields wave-form-single"><label>名称（可选）<input aria-label={`视图 ${index+1} 表达式名称`} value={name} maxLength={80} onChange={event=>setName(event.target.value)}/></label></div>
      <div hidden={active!==2} className="wave-form-fields wave-form-single"><label>表达式<input aria-label={`视图 ${index+1} 数学表达式`} value={expression} maxLength={1000} placeholder="V(vout) / V(vin)" onChange={event=>{setExpression(event.target.value);setError('')}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();save()}}}/></label></div>
      <div hidden={active!==3} className="wave-form-actions"><button type="button" disabled={!expression.trim()||result.analysis==='noise'} onClick={save}>{editing?'保存表达式':'添加表达式'}</button>{editing&&<button type="button" onClick={clear}>取消编辑</button>}<p title="支持 abs、sqrt、real、imag 等函数；AC 使用复数相量，V×I 不代表平均功率。">例如 V(vin,vout)、V(vout)/V(vin)</p>{result.analysis==='noise'&&<p role="status">噪声分析暂不支持数学表达式。</p>}{error&&<p className="wave-expression-error" role="alert" title={error}>{error}</p>}</div>
    </section>
  }
  const content=<div className="wave-expression-content">
      <strong>视图 {index+1} · 数学曲线</strong>
      <p>{embedded?'例如 V(vin,vout)、V(vout) / V(vin)，支持 abs、sqrt、real、imag 等函数。':'例如 V(vin,vout)、V(vout) / V(vin)、V(vout) * I(R1)。可使用 abs、sqrt、min、max、real、imag、conj 和科学计数值。'}</p>
      {result.analysis==='ac'&&<p>{embedded?'AC 使用复数相量；V × I 数学曲线不代表平均功率。':'AC 使用复数相量：比值显示 dB / 相位；电压与电流的复数乘积仅是数学曲线，不能当作实际平均功率。'}</p>}
      {result.analysis==='noise'?<p role="status">噪声分析暂不支持数学表达式。</p>:<>
        {embedded&&<div className="wave-embedded-pagination"><span>已保存 {expressions.length} 个表达式</span><button type="button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>上一个</button><span>{expressions.length?currentPage+1:0} / {expressions.length}</span><button type="button" disabled={currentPage>=expressions.length-1} onClick={()=>setPage(currentPage+1)}>下一个</button></div>}
        {(embedded?expressions.slice(currentPage,currentPage+1):expressions).map(item=><div className="wave-expression-item" key={item.id}><span title={item.expression}><b>{item.name??item.expression}</b>{item.name&&<small>{item.expression}</small>}</span><button type="button" aria-label={`编辑表达式 ${item.name??item.expression}`} onClick={()=>{setEditing(item.id);setName(item.name??'');setExpression(item.expression);setError('')}}>编辑</button><button type="button" aria-label={`删除表达式 ${item.name??item.expression}`} onClick={()=>{onChange(removePanelExpression(panel,item.id));if(editing===item.id)clear()}}>删除</button></div>)}
        <label>名称（可选）<input aria-label={`视图 ${index+1} 表达式名称`} value={name} maxLength={80} onChange={event=>setName(event.target.value)}/></label>
        <label>表达式<input aria-label={`视图 ${index+1} 数学表达式`} value={expression} maxLength={1000} placeholder="V(vout) / V(vin)" onChange={event=>{setExpression(event.target.value);setError('')}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();save()}}}/></label>
        {error&&<p className="wave-expression-error" role="alert">{error}</p>}
        <div className="wave-expression-actions"><button type="button" disabled={!expression.trim()} onClick={save}>{editing?'保存表达式':'添加表达式'}</button>{editing&&<button type="button" onClick={clear}>取消编辑</button>}</div>
      </>}
    </div>
  return embedded?<section className="wave-expression-inline" aria-label={`视图 ${index+1} 数学曲线`}>{content}</section>:<details className="wave-expression-editor"><summary>数学表达式 <span>{expressions.length}</span></summary>{content}</details>
}
