import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, CircleHelp, Cpu, ExternalLink, FileCode2, ListChecks } from 'lucide-react'
import type { ImportedSpiceModel } from '../core/spice-models'
import type { Device } from '../core/drawing'
import { localPin } from '../core/devices'
import { modelPinLabels, modelSymbolOriginLabel } from '../core/model-symbol'
import { reviewedPinMapping, reviewDeviceLabel, reviewDisplayValue, reviewModelParameters, reviewPrimaryParameters, reviewSubcircuitImplementation, type ModelReviewFact, type ModelReviewPinMapping, type ModelReviewParameter } from '../core/model-review'
import { presentedModelSymbol } from '../core/model-symbol-presentation'
import { DeviceSymbol } from './DeviceSymbol'
import { modelParameterAdjustments, type ModelReferenceAdjustment, type ModelReferenceIdentity } from '../core/model-reference'
import type { ModelAssessment } from '../core/modeling-assessment'
import ModelingScopePanel, { equivalentReviewValues, legacyModelingAssessment } from './ModelingScopePanel'

export interface ModelReviewProps {
  model:ImportedSpiceModel
  evidence?:string[]
  limitations?:string[]
  origin?:'downloaded'|'derived'
  pinMapping?:ModelReviewPinMapping[]
  facts?:ModelReviewFact[]
  referenceModel?:ImportedSpiceModel
  reference?:ModelReferenceIdentity
  adjustments?:ModelReferenceAdjustment[]
  inheritedCount?:number
  children?:ReactNode
  display?:'full'|'assistant'
  assessment?:ModelAssessment
}

// Older saved assistant results included same-value mappings as adjustments.
// Keep their evidence visible, but never count them as changes to the model.
function reviewAdjustments(items: ModelReferenceAdjustment[] = []) {
  return {
    changes: items.filter(item => !equivalentReviewValues(item.before,item.after)),
    unchanged: items.filter(item => equivalentReviewValues(item.before,item.after)),
  }
}

function PinDiagram({model,selected,onSelect}:{model:ImportedSpiceModel;selected:number;onSelect:(index:number)=>void}) {
  const diagram=useRef<SVGSVGElement>(null)
  const symbol=presentedModelSymbol(model)
  const device:Device={id:'review',kind:model.kind,value:model.id,x:0,y:0,rotation:0,pins:model.pins,...(symbol?.shape==='ltspice'?{pinPositions:symbol.pins.map(pin=>({x:pin.x!,y:pin.y!}))}:{})}
  const points=model.pins.map((_,index)=>({...localPin(model.kind,index,device),index}))
  const geometry=symbol?.geometry??[]
  const xs=[-40,40,...points.map(point=>point.x),...geometry.flatMap(item=>item.coords.filter((_,index)=>index%2===0))]
  const ys=[-40,40,...points.map(point=>point.y),...geometry.flatMap(item=>item.coords.filter((_,index)=>index%2===1))]
  const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys)
  // Keep terminal hit targets and labels at readable pixel sizes. A wide or
  // dense symbol grows the scrollable diagram instead of shrinking its pins.
  const labels=points.map(point=>(symbol?.pins[point.index]?.label??modelPinLabels(model.kind,model.pins)[point.index]).slice(0,7))
  let scale=1.6
  for(let index=0;index<points.length;index++)for(let other=index+1;other<points.length;other++){
    const dx=Math.abs(points[index].x-points[other].x),dy=Math.abs(points[index].y-points[other].y)
    const distance=Math.hypot(dx,dy)
    if(distance>0)scale=Math.max(scale,36/distance)
    // Labels extend sideways from each anchor. Ports arranged in a row need
    // enough horizontal room for the label as well as the numbered circle.
    if(dx>0&&dy<18/scale)scale=Math.max(scale,150/dx)
  }
  const labelPadding=Math.max(70,...labels.map(label=>[...label].reduce((width,char)=>width+(char.charCodeAt(0)>255?16:10),35)))
  const width=Math.max(320,Math.ceil((right-left)*scale+labelPadding*2)),height=Math.max(252,Math.ceil((bottom-top)*scale+90))
  const offsetX=width/2-(left+right)*scale/2,offsetY=height/2-(top+bottom)*scale/2
  const selectedX=points[selected]?.x*scale+offsetX,selectedY=points[selected]?.y*scale+offsetY
  useEffect(()=>{
    const viewport=diagram.current?.parentElement
    if(!viewport||!viewport.clientWidth||!viewport.clientHeight)return
    // Selecting a distant pin in the list should reveal it within the diagram,
    // without scrolling the surrounding model assistant or document.
    viewport.scrollLeft=Math.max(0,Math.min(width-viewport.clientWidth,selectedX-viewport.clientWidth/2))
    viewport.scrollTop=Math.max(0,Math.min(height-viewport.clientHeight,selectedY-viewport.clientHeight/2))
  },[selectedX,selectedY,width,height])
  return <svg ref={diagram} className="model-review-diagram" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{width,height,minWidth:width}} role="group" aria-label={`${model.id} 原理图符号及逻辑端口`}>
    <title>{`${model.id} · 点击端口序号查看引脚`}</title>
    <g className="model-review-shape" transform={`translate(${offsetX} ${offsetY}) scale(${scale})`} aria-hidden="true"><DeviceSymbol device={device} modelType={model.type} symbol={symbol} showPinLabels={false}/></g>
    {points.map(point=><g key={point.index} className={`model-review-terminal${selected===point.index?' is-selected':''}`} transform={`translate(${point.x*scale+offsetX} ${point.y*scale+offsetY})`} role="button" tabIndex={0} aria-label={`选择逻辑端口 ${point.index+1} ${model.pins[point.index]}`} aria-pressed={selected===point.index} onClick={()=>onSelect(point.index)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(point.index)}}} data-pin-index={point.index}>
      <circle className="model-review-terminal-hit" r="17"/><circle r="12"/><text className="model-review-port-index" textAnchor="middle" dominantBaseline="central">{point.index+1}</text><text className="model-review-port-label" x={point.x<0?-19:19} y="-7" textAnchor={point.x<0?'end':'start'}>{labels[point.index]}<title>{symbol?.pins[point.index]?.label??model.pins[point.index]}</title></text>
    </g>)}
  </svg>
}

function FullModelReview({model,evidence=[],limitations=[],origin,pinMapping=[],facts=[],referenceModel,reference,adjustments,inheritedCount,children,assessment}:ModelReviewProps) {
  const symbol=presentedModelSymbol(model)
  const [selection,setSelection]=useState<{id:string;index:number}>({id:model.id,index:0})
  const selected=selection.id===model.id&&selection.index<model.pins.length?selection.index:0
  const select=(index:number)=>setSelection({id:model.id,index})
  const titleId=useId()
  const parameters=useMemo(()=>reviewModelParameters(model),[model])
  const internal=useMemo(()=>reviewSubcircuitImplementation(model),[model])
  const mapping=reviewedPinMapping(model,pinMapping)
  const labels=modelPinLabels(model.kind,model.pins)
  const selectedMapping=mapping.find(item=>item.index===selected)
  const selectedLabel=symbol?.pins[selected]?.label??labels[selected]
  const groups=[...new Set(parameters.map(parameter=>parameter.group))]
  const comparison=useMemo(()=>referenceModel?modelParameterAdjustments(referenceModel,model):undefined,[referenceModel,model])
  const {changes,unchanged}=reviewAdjustments(adjustments??comparison?.adjustments),inherited=inheritedCount??(model.kind==='X'?undefined:comparison?.inheritedCount)
  const template=reference??(referenceModel?{id:referenceModel.id,source:referenceModel.source}:undefined)
  const changedKeys=new Set(changes.map(change=>change.key))
  const knownOrigin=origin==='derived'?'近似模型 · 待验证':origin==='downloaded'?'下载模型':'待审阅模型'
  return <section className="model-review" aria-labelledby={titleId}>
    <header className="model-review-heading"><div><span className={`model-review-badge${origin==='derived'?' is-approximate':''}`}>{knownOrigin}</span><h3 id={titleId}><Cpu size={20}/>{model.name||model.id}</h3><p><code>{model.id}</code><span>{model.technology??model.type}</span><span>{model.pins.length} 个逻辑端口</span></p></div><span className="model-review-status"><ListChecks size={16}/>待核对引脚与适用条件</span></header>
    <ModelingScopePanel assessment={assessment ?? model.assessment ?? legacyModelingAssessment(model,origin,adjustments??comparison?.adjustments)} legacy={!assessment&&!model.assessment}/>
    {template&&<details className="model-review-reference"><summary><span>参考 <strong>{template.id}</strong> → 调整 {changes.length} 项 → 待验证</span><small>{inherited!==undefined?`保留 ${inherited} 项显式参数 · `:''}查看改动</small></summary><div><p>参考来源：{template.source.url?<a href={template.source.url} target="_blank" rel="noreferrer noopener">{template.source.label}</a>:template.source.label}</p>{changes.length>0?<table><thead><tr><th>参数</th><th>模板值</th><th>调整后</th><th>依据</th></tr></thead><tbody>{changes.map((change,index)=><tr key={`${change.key}-${index}`}><th scope="row">{change.key}</th><td><code>{change.before}</code></td><td><code>{change.after}</code></td><td>{change.source}<small>{change.explanation}</small></td></tr>)}</tbody></table>:<p>没有检测到显式参数变化；沿用模板不代表目标型号已经验证。</p>}<p>其余模型结构与参数沿用参考模板；参数调整后仍需核对目标器件的工作条件与仿真表现。</p></div></details>}
    {unchanged.length>0&&<p className="model-review-caption">已核对并沿用：{unchanged.map(item=>`${item.key} = ${item.after}`).join('；')}。数值一致，不计为参数修改。</p>}
    <div className="model-review-main">
      <section className="model-review-pin-panel" aria-label="符号与引脚审阅"><h4>符号与引脚 · {modelSymbolOriginLabel(symbol)}</h4><p className="model-review-caption">点击图上的序号或下方引脚，查看对应关系。{symbol?.origin==='standard'&&'标准功能图形按已确认的电气端口映射绘制。'}</p><div className="model-review-diagram-wrap"><PinDiagram model={model} selected={selected} onSelect={select}/></div>
        <div className="model-review-pin-focus" aria-live="polite"><strong>端口 {selected+1} · {selectedLabel}</strong><span>{model.pins[selected]}</span><small>{selectedMapping?`封装脚号 ${selectedMapping.packagePin} · ${selectedMapping.evidence}`:'封装脚号待核对 · 当前仅确认模型的逻辑连接顺序'}</small></div>
        <ol className="model-review-pins">{model.pins.map((pin,index)=>{const mapped=mapping.find(item=>item.index===index),label=symbol?.pins[index]?.label??labels[index];return <li key={index}><button type="button" className={selected===index?'is-selected':''} aria-pressed={selected===index} aria-label={`引脚列表 端口 ${index+1} ${pin}`} onClick={()=>select(index)}><span className="model-review-pin-number">{index+1}</span><span><strong>{label}</strong>{pin!==label&&<small>{pin}</small>}</span><small>{mapped?`封装 ${mapped.packagePin}`:'封装待核对'}</small></button></li>})}</ol>
        <p className="model-review-pin-note"><CircleHelp size={15}/>图中序号对应 SPICE 连接顺序；封装脚号须以具体型号和封装的规格书为准。</p>
        {model.kind==='M'&&model.technology!=='VDMOS'&&<p className="model-review-pin-note">当前三端符号将体端内部连接到源极；生成网表时按 D、G、S、体端顺序连接。</p>}
      </section>
      <section className="model-review-parameter-panel" aria-label="参数审阅"><h4>参数与适用范围</h4><p className="model-review-caption">{origin==='derived'?'近似参数需要在目标工作条件下验证。':'源码参数用于描述仿真方程；额定值和测试条件应另行核对。'}</p>
        {facts.length>0&&<section className="model-review-facts" aria-label="规格书提取指标"><h5>规格书提取指标 · 待核对</h5><div className="model-review-parameter-grid">{facts.map((fact,index)=><article className="model-review-parameter" key={`${fact.label}-${index}`}><span>{fact.label}</span><strong>{fact.value}<small>{fact.unit}</small></strong>{fact.note&&<p>{fact.note}</p>}{fact.evidence&&<details><summary>查看依据</summary><p>{fact.evidence}</p></details>}</article>)}</div></section>}
        {groups.map(group=><section className="model-review-parameter-group" key={group}><h5>{group}</h5><div className="model-review-parameter-grid">{parameters.filter(parameter=>parameter.group===group).map(parameter=><article className={`model-review-parameter${changedKeys.has(parameter.key)?' is-adjusted':''}`} key={parameter.key}><span>{parameter.label}<code>{parameter.key}</code>{changedKeys.has(parameter.key)&&<em>已调整</em>}</span><strong>{parameter.displayValue}<small>{parameter.displayUnit||(parameter.group==='其他显式参数'?'单位未确认':'无量纲')}</small></strong><p>{parameter.note}</p><small className="model-review-raw">源码 {parameter.key}={parameter.value}</small></article>)}</div></section>)}
        {model.kind==='X'&&<div className="model-review-subcircuit-note"><strong>子电路模型 · {model.pins.length} 端口</strong><p>内部电阻、常数及行为表达式共同定义器件行为，不能直接当作整体器件的实测参数。关键指标以规格书依据和仿真验证为准。</p></div>}
        {internal.length>0&&<details className="model-review-details"><summary>内部实现参数与表达式 · {internal.length} 项</summary><div className="model-review-internals">{internal.map((row,index)=>{const display=reviewDisplayValue(row.value,row.unit);return <article key={`${row.id}-${index}`}><header><strong>{row.id}</strong><span>{row.label}</span></header><code>{display.displayValue}{display.displayUnit&&` ${display.displayUnit}`}</code><p>{row.note}</p></article>})}</div></details>}
        {!parameters.length&&!facts.length&&model.kind!=='X'&&<p className="model-review-empty">没有可直接呈现的显式参数，请展开源码核对。</p>}
        <details className="model-review-details"><summary>来源、依据与适用限制{evidence.length+limitations.length>0?` · ${evidence.length+limitations.length} 项`:''}</summary><div className="model-review-provenance"><p><strong>来源</strong> {model.source.url?<a href={model.source.url} target="_blank" rel="noreferrer noopener">{model.source.label}<ExternalLink size={13}/></a>:model.source.label}</p>{model.source.license&&<p><strong>许可说明</strong> {model.source.license}</p>}{evidence.length>0&&<section><h5>建模依据</h5><ul>{evidence.map((item,index)=><li key={index}>{item}</li>)}</ul></section>}{limitations.length>0&&<section><h5>适用限制</h5><ul>{limitations.map((item,index)=><li key={index}>{item}</li>)}</ul></section>}{model.detail&&<p>{model.detail}</p>}{model.source.attribution&&<p>{model.source.attribution}</p>}</div></details>
        <details className="model-review-details"><summary><FileCode2 size={15}/>高级：查看完整 SPICE 定义</summary><pre><code>{model.spice}</code></pre></details>
      </section>
    </div>
    {children&&<footer className="model-review-actions">{children}</footer>}
  </section>
}

function VisualParameter({parameter,changed=false}:{parameter:ModelReviewParameter;changed?:boolean}) {
  return <article className={`model-review-parameter${changed?' is-adjusted':''}`} data-parameter={parameter.key}>
    <span>{parameter.label}<code>{parameter.key}</code>{changed&&<em>已调整</em>}</span>
    <strong>{parameter.displayValue}<small>{parameter.displayUnit||(parameter.group==='其他显式参数'?'单位未确认':'无量纲')}</small></strong>
    <p>{parameter.note}</p>
  </article>
}

function AssistantModelReview({model,evidence=[],limitations=[],origin,pinMapping=[],facts=[],referenceModel,reference,adjustments,inheritedCount,children,assessment}:ModelReviewProps) {
  const symbol=presentedModelSymbol(model)
  const [selection,setSelection]=useState<{id:string;index:number}>({id:model.id,index:0})
  const selected=selection.id===model.id&&selection.index<model.pins.length?selection.index:0
  const select=(index:number)=>setSelection({id:model.id,index}),titleId=useId()
  const comparison=useMemo(()=>referenceModel?modelParameterAdjustments(referenceModel,model):undefined,[referenceModel,model])
  const {changes,unchanged}=reviewAdjustments(adjustments??comparison?.adjustments),inherited=inheritedCount??(model.kind==='X'?undefined:comparison?.inheritedCount)
  const template=reference??(referenceModel?{id:referenceModel.id,source:referenceModel.source}:undefined)
  const changedKeys=new Set(changes.map(change=>change.key))
  const parameters=useMemo(()=>reviewModelParameters(model),[model])
  const internal=useMemo(()=>reviewSubcircuitImplementation(model),[model])
  const mainFacts=facts.slice(0,4),primary=reviewPrimaryParameters(model,changedKeys,4-mainFacts.length)
  const mapping=reviewedPinMapping(model,pinMapping),mapped=mapping.find(item=>item.index===selected)
  const selectedLabel=symbol?.pins[selected]?.label??modelPinLabels(model.kind,model.pins)[selected]
  const changeValue=(value:string,key:string)=>{
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i.test(value))return value
    const unit=parameters.find(item=>item.key===key)?.unit??'',display=reviewDisplayValue(value,unit)
    return `${display.displayValue}${display.displayUnit?` ${display.displayUnit}`:''}`
  }
  const sourceLabel=origin==='derived'?'近似模型':origin==='downloaded'?'下载模型':'待审阅模型'
  return <section className="model-review model-review-assistant" aria-labelledby={titleId}>
    <header className="model-review-heading"><div><span className={`model-review-badge${origin==='derived'?' is-approximate':''}`}>{sourceLabel}</span><h3 id={titleId}>{model.id}</h3><p className="model-review-device-kind"><Cpu size={15}/>{reviewDeviceLabel(model)}<span>· {model.pins.length} 个逻辑端口</span></p>{model.name&&model.name!==model.id&&<p>{model.name}</p>}</div><span className="model-review-verification"><CircleHelp size={15}/>电气行为未验证</span></header>
    <ModelingScopePanel assessment={assessment ?? model.assessment ?? legacyModelingAssessment(model,origin,adjustments??comparison?.adjustments)} legacy={!assessment&&!model.assessment}/>
    <div className="model-review-visual-main">
      <section className="model-review-visual-device" aria-label="模型符号与引脚"><div className="model-review-visual-label"><strong>{modelSymbolOriginLabel(symbol)}</strong><span>点击引脚查看对应关系</span></div><div className="model-review-diagram-wrap"><PinDiagram model={model} selected={selected} onSelect={select}/></div>
        <div className="model-review-visual-pin" aria-live="polite"><span className="model-review-pin-number">{selected+1}</span><div><strong>{selectedLabel}</strong><span>{mapped?`封装脚号 ${mapped.packagePin}`:'封装脚号尚未确认'}</span></div><label><span className="model-review-visually-hidden">查看逻辑引脚</span><select aria-label="查看逻辑引脚" value={selected} onChange={event=>select(Number(event.target.value))}>{model.pins.map((pin,index)=><option key={index} value={index}>{index+1} · {pin}</option>)}</select></label></div>
        <p className="model-review-caption">{mapped?mapped.evidence:'序号表示模型连接顺序；具体封装脚号以规格书为准。'}</p>
      </section>
      <section className="model-review-visual-summary" aria-label="模型结果摘要">
        {template&&<section className="model-review-model-change" aria-label="参考模型到目标模型"><div className="model-review-change-flow"><div><small>参考模型</small><strong>{template.id}</strong></div><ArrowRight size={20} aria-hidden="true"/><div><small>当前模型 · 待验证</small><strong>{model.id}</strong></div></div>
          {changes.length>0&&<div className="model-review-change-values">{changes.slice(0,3).map((change,index)=><div key={`${change.key}-${index}`}><code>{change.key}</code><span>{changeValue(change.before,change.key)}</span><ArrowRight size={13} aria-hidden="true"/><strong>{changeValue(change.after,change.key)}</strong></div>)}</div>}
          <p>{changes.length?`调整 ${changes.length} 项参数`:'未记录显式参数调整'}{inherited!==undefined?` · 沿用 ${inherited} 项显式参数`:''}</p>
          {unchanged.length>0&&<p>已核对并沿用：{unchanged.map(item=>`${item.key} = ${item.after}`).join('；')}。数值一致，不计为参数修改。</p>}
        </section>}
        {mainFacts.length>0&&<section className="model-review-primary-facts" aria-label="首要规格书指标"><h4>规格书提取指标 <span>待核对</span></h4><div className="model-review-parameter-grid">{mainFacts.map((fact,index)=><article className="model-review-parameter" key={`${fact.label}-${index}`}><span>{fact.label}</span><strong>{fact.value}<small>{fact.unit}</small></strong>{fact.note&&<p>{fact.note}</p>}</article>)}</div></section>}
        {primary.length>0&&<section className="model-review-primary-parameters" aria-label="首要模型参数"><h4>主要模型参数 <span>SPICE 方程参数</span></h4><div className="model-review-parameter-grid">{primary.map(parameter=><VisualParameter key={parameter.key} parameter={parameter} changed={changedKeys.has(parameter.key)}/>)}</div></section>}
        {model.kind==='X'&&!mainFacts.length&&<section className="model-review-unrated"><Cpu size={30}/><strong>{model.pins.length} 端口子电路已保留</strong><p>暂无可确认的器件整体指标。内部元件值和表达式属于仿真实现，不能当作规格书额定值。</p></section>}
        {!primary.length&&!mainFacts.length&&model.kind!=='X'&&<p className="model-review-empty">暂无可直接解释的主要参数，完整源码和参数保留在下方。</p>}
        <p className="model-review-validation-note">{limitations[0]?`${limitations[0].slice(0,180)}${limitations[0].length>180?'…':''}`:origin==='derived'?'改参结果仍需在目标工作条件下运行仿真并核对。':'模型来源和可导入语法不代表器件精度已经验证。'}</p>
      </section>
    </div>
    <details className="model-review-advanced"><summary><FileCode2 size={16}/><strong>完整参数与模型依据</strong><span>{parameters.length>0?`${parameters.length} 项显式参数 · `:''}来源、引脚、源码</span></summary><div className="model-review-advanced-body">
      {parameters.length>0&&<section><h4>全部模型参数</h4><p className="model-review-caption">只列出源码中的显式定义，不补充默认值或推测额定值。</p><div className="model-review-parameter-grid">{parameters.map(parameter=><VisualParameter key={parameter.key} parameter={parameter} changed={changedKeys.has(parameter.key)}/>)}</div></section>}
      {facts.length>0&&<section><h4>规格书提取依据</h4><dl className="model-review-fact-evidence">{facts.map((fact,index)=><div key={`${fact.label}-${index}`}><dt>{fact.label} · {fact.value} {fact.unit}</dt><dd>{fact.evidence||'尚未记录逐项依据'}{fact.note&&<p>{fact.note}</p>}</dd></div>)}</dl></section>}
      {changes.length>0&&<section><h4>完整参数调整</h4><div className="model-review-adjustment-records">{changes.map((change,index)=><article key={`${change.key}-${index}`}><strong>{change.key} · {change.before} → {change.after}</strong><p>{change.source}</p><small>{change.explanation}</small></article>)}</div></section>}
      {unchanged.length>0&&<section><h4>核对后沿用的参数</h4>{unchanged.map((item,index)=><article key={`${item.key}-${index}`}><strong>{item.key} = {item.after}</strong><p>{item.source}</p><small>与参考值一致；未修改模型参数。</small></article>)}</section>}
      <section><h4>逻辑引脚与封装映射</h4><ol className="model-review-pins">{model.pins.map((pin,index)=>{const packagePin=mapping.find(item=>item.index===index);return <li key={index}><button type="button" aria-pressed={selected===index} aria-label={`引脚列表 端口 ${index+1} ${pin}`} onClick={()=>select(index)}><span className="model-review-pin-number">{index+1}</span><span><strong>{symbol?.pins[index]?.label??pin}</strong><small>{pin}</small></span><small>{packagePin?`封装 ${packagePin.packagePin}`:'封装待核对'}</small></button>{packagePin&&<p className="model-review-caption">{packagePin.evidence}</p>}</li>})}</ol>{model.kind==='M'&&model.technology!=='VDMOS'&&<p className="model-review-caption">当前三端符号将体端内部连接到源极，网表按 D、G、S、体端顺序连接。</p>}</section>
      {internal.length>0&&<details className="model-review-details"><summary>内部实现与表达式 · {internal.length} 项</summary><div className="model-review-internals">{internal.map((row,index)=><article key={`${row.id}-${index}`}><header><strong>{row.id}</strong><span>{row.label}</span></header><code>{row.value} {row.unit}</code><p>{row.note}</p></article>)}</div></details>}
      <section className="model-review-provenance"><h4>来源与适用限制</h4><p><strong>来源：</strong>{model.source.url?<a href={model.source.url} target="_blank" rel="noreferrer noopener">{model.source.label}<ExternalLink size={13}/></a>:model.source.label}</p>{template&&<p><strong>参考模型：</strong>{template.id} · {template.source.url?<a href={template.source.url} target="_blank" rel="noreferrer noopener">{template.source.label}</a>:template.source.label}</p>}{model.source.license&&<p>{model.source.license}</p>}{evidence.length>0&&<><h5>建模依据</h5><ul>{evidence.map((item,index)=><li key={index}>{item}</li>)}</ul></>}{limitations.length>0&&<><h5>适用限制</h5><ul>{limitations.map((item,index)=><li key={index}>{item}</li>)}</ul></>}{model.detail&&<p>{model.detail}</p>}{model.source.attribution&&<p>{model.source.attribution}</p>}</section>
      <details className="model-review-details"><summary>完整 SPICE 定义</summary><pre><code>{model.spice}</code></pre></details>
    </div></details>
    {children&&<footer className="model-review-actions">{children}</footer>}
  </section>
}

export default function ModelReview(props:ModelReviewProps) {
  return props.display==='assistant'?<AssistantModelReview {...props}/>:<FullModelReview {...props}/>
}
