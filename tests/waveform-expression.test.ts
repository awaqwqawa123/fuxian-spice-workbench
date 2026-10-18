import assert from 'node:assert/strict'
import test from 'node:test'
import { act,createElement } from 'react'
import { JSDOM } from 'jsdom'
import { newProject } from '../src/core/circuit'
import { evaluateWaveformExpression,parseWaveformExpression,validateWaveformExpression } from '../src/core/waveform-expression'
import { defaultWaveformPanels,removePanelExpression,upsertPanelExpression,waveformSignals,waveformTraces,type WaveformPanel } from '../src/core/waveform-workspace'
import type { Result } from '../src/core/results'
import type { WaveformViewState } from '../src/core/canvas-waveform-store'
import { simulate } from './simulate'

const cache=new Map<string,Promise<Result>>()
function result(analysis:'tran'|'ac'|'op') {
  if(!cache.has(analysis)){
    const project=newProject();project.analysis=analysis;project.values.R1='1k';project.values.C1='100nF';project.ac={start:'10Hz',stop:'10kHz',points:10};project.tran={stop:'2ms',step:'10us'}
    cache.set(analysis,simulate(project))
  }
  return cache.get(analysis)!
}
const evaluate=(r:Result,expression:string)=>evaluateWaveformExpression(r,{id:'m1',expression})
const near=(actual:number,expected:number,tolerance=1e-10)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} versus ${expected}`)

test('bounded math parser supports SPICE suffixes, units, differential voltages and branch references',()=>{
  assert.deepEqual(parseWaveformExpression('V(VIN,vout) * I(R1)').references,[{kind:'voltage',nodes:['vin','vout']},{kind:'current',device:'r1'}])
  for(const [expression,unit]of [['V(vout)*I(R1)','W'],['V(vout)/V(vin)','1'],['V(vout)/I(V1)','Ω'],['sqrt(V(vout)^2)','V'],['V(vout)+1mV','V'],['max(abs(I(R1)),1uA)','A']])assert.equal(parseWaveformExpression(expression).unit,unit)
  assert.doesNotThrow(()=>validateWaveformExpression('V(vin,0)*I(R1)',{voltage:['v(vin)'],current:['i(r1)']}))
  assert.throws(()=>validateWaveformExpression('V(missing)',{voltage:['v(vin)'],current:[]}),/没有可用数据/)
  for(const invalid of ['V(vout)+I(V1)','min(V(vout),1A)','sin(V(vout))','globalThis.process.exit()','V(vout);alert(1)','V(vout)\n.end','V(a,b,c)','I(a,b)','V(vin)^V(vout)','1e999','abs()','sqrt('.repeat(30)+'1'+')'.repeat(30)])assert.throws(()=>parseWaveformExpression(invalid),invalid)
})

test('production transient worker: differential voltages and instantaneous resistor power retain actual samples and units',async()=>{
  const r=await result('tran'),difference=evaluate(r,'V(vin,vout)'),power=evaluate(r,'V(vin,vout)*I(R1)')
  assert.equal(difference.unit,'V');assert.equal(power.unit,'W');assert.equal(power.powerPhasor,false)
  assert.equal(power.values.length,r.points)
  for(let index=0;index<r.points;index++){
    near(difference.values[index],r.vin[index]-r.vout[index])
    const current=r.currents!['i(r1)'][index]
    near(power.values[index],1000*current*current,1e-8)
  }
  assert.deepEqual(evaluate(r,'-2^2 + 1k/500').values,Array(r.points).fill(-2))
  assert.deepEqual(evaluate(r,'max(1mV,2mV)').values,Array(r.points).fill(.002))
})

test('production AC worker: expressions use complex ratios, passive branch phasors and honest units',async()=>{
  const r=await result('ac'),ratio=evaluate(r,'V(vout)/V(vin)'),current=evaluate(r,'I(R1)'),product=evaluate(r,'V(vin,vout)*conj(I(R1))')
  assert.equal(ratio.unit,'1');assert.ok(ratio.complex);assert.ok(product.powerPhasor)
  for(let index=0;index<r.points;index++){
    const out=r.complexVoltages!['v(vout)'][index],input=r.complexVoltages!['v(vin)'][index],i=current.complex![index]
    near(ratio.complex![index].real,out.real);near(ratio.complex![index].img,out.img)
    near(i.real,(input.real-out.real)/1000);near(i.img,(input.img-out.img)/1000)
    near(product.complex![index].real,1000*(i.real*i.real+i.img*i.img));near(product.complex![index].img,0)
  }
  const panel=upsertPanelExpression({ids:[],source:'signals',display:'magnitude'},{id:'gain',name:'传递比',expression:'V(vout)/V(vin)'})
  const signals=waveformSignals(r,[],panel.expressions).signals,traces=waveformTraces(r,null,signals,[],panel)
  assert.equal(traces[0].unit,'dB')
  assert.equal(waveformTraces(r,null,waveformSignals(r).signals,[],panel)[0].id,'expression:gain','legacy preview handoff resolves saved math definitions')
  traces[0].y.forEach((value,index)=>near(value,r.magnitude[index]))
  const phase=waveformTraces(r,null,signals,[],{...panel,display:'phase'})
  assert.equal(phase[0].unit,'°');phase[0].y.forEach((value,index)=>near(value,r.phase[index]))
  const powerPanel=upsertPanelExpression(panel,{id:'power',expression:'V(vout)*I(R1)'})
  assert.equal(waveformTraces(r,null,waveformSignals(r,[],powerPanel.expressions).signals,[],powerPanel).find(trace=>trace.id==='expression:power')!.unit,'dB(V·A)')
})

test('expressions reject unavailable vectors, zero division, real domain violations and nonfinite math',async()=>{
  const r=await result('op')
  for(const expression of ['V(missing)','I(R99)','V(vin)/(V(vin)-V(vin))','sqrt(-1)','ln(0)','exp(1000)','(-1)^0.5'])assert.throws(()=>evaluate(r,expression))
  const missing={...r,voltages:{}}
  const catalogue=waveformSignals(missing,[],[{id:'missing',expression:'V(vout)'}])
  assert.ok(catalogue.unavailable.some(error=>error.includes('v(vout)')))
  assert.ok(!catalogue.signals.some(signal=>signal.id==='expression:missing'))
  assert.throws(()=>evaluate({...r,analysis:'noise'},'V(vout)'),/噪声/)
})

test('expression add/edit/remove preserve independent saved panel selections and old panels without expressions',()=>{
  const panel:WaveformPanel={ids:['voltage:v(vout)'],primary:'voltage:v(vout)',source:'signals',display:'magnitude'},before=structuredClone(panel)
  const added=upsertPanelExpression(panel,{id:'power',name:'耗散',expression:'V(vout)*I(R1)'}),edited=upsertPanelExpression(added,{id:'power',name:'电阻耗散',expression:'V(vin,vout)*I(R1)'})
  assert.deepEqual(panel,before);assert.equal(edited.expressions!.length,1);assert.equal(edited.ids.filter(id=>id==='expression:power').length,1);assert.equal(edited.primary,'expression:power')
  assert.equal(added.expressions![0].name,'耗散');assert.deepEqual(removePanelExpression(edited,'power').ids,panel.ids)
  assert.equal(removePanelExpression(edited,'power').primary,panel.primary)
})

test('DOM: bottom trace controls add, edit, restore and hide saved math curves without mutating incoming configuration',async()=>{
  const r=await result('tran'),dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost:3030/'}),prior=new Map<string,PropertyDescriptor|undefined>()
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,IS_REACT_ACT_ENVIRONMENT:true})){
    prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  const {createRoot}=await import('react-dom/client'),{default:WaveformWorkspace}=await import('../src/components/WaveformWorkspace'),root=createRoot(dom.window.document.getElementById('root')!)
  const view:WaveformViewState={analysis:r.analysis,layout:1,panels:defaultWaveformPanels(r,waveformSignals(r).signals),domain:[0,1],cursors:{a:null,b:null}},before=structuredClone(view),published:WaveformViewState[]=[]
  const render=(initialView:WaveformViewState,result=r)=>act(async()=>root.render(createElement(WaveformWorkspace,{result,comparison:null,initialView,onViewChange:next=>published.push(structuredClone(next))})))
  const input=async(label:string,value:string)=>act(async()=>{
    const element=dom.window.document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(element,value)
    element.dispatchEvent(new dom.window.Event('input',{bubbles:true}))
  })
  const click=async(label:string)=>act(async()=>{
    const element=[...dom.window.document.querySelectorAll('button')].find(button=>button.textContent===label||button.getAttribute('aria-label')===label)
    assert.ok(element,label);element.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}))
  })
  const select=async(label:string,value:string)=>act(async()=>{
    const element=dom.window.document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
    assert.ok(element,label);element.value=value; element.dispatchEvent(new dom.window.Event('change',{bubbles:true}))
  })
  try {
    await render(view);await click('视图 1 添加公式');await input('视图 1 曲线公式','V(vin,vout)*I(R1)');await click('视图 1 应用曲线公式')
    assert.ok(dom.window.document.querySelector('[data-wave-trace^="expression:"]'))
    const added=published.at(-1)!,id=added.panels[0].expressions![0].id
    assert.deepEqual(view,before);assert.equal(added.panels[0].expressions![0].expression,'V(vin,vout)*I(R1)');assert.equal(added.panels[1].expressions,undefined)
    await click('视图 1 编辑公式 V(vin,vout)*I(R1)');await input('视图 1 曲线公式','V(missing)');await click('视图 1 应用曲线公式')
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!,/v\(missing\).*没有有效数据/)
    assert.deepEqual(published.at(-1),added,'invalid edits retain the saved definition and view')
    await input('视图 1 曲线公式','V(vin,vout)');await click('视图 1 应用曲线公式')
    const edited=published.at(-1)!;assert.equal(edited.panels[0].expressions![0].id,id);assert.equal(edited.panels[0].expressions![0].expression,'V(vin,vout)')
    assert.equal(added.panels[0].expressions![0].expression,'V(vin,vout)*I(R1)','editing preserves earlier configuration snapshots')
    const saved:WaveformViewState=JSON.parse(JSON.stringify(edited)),savedBefore=structuredClone(saved)
    await render(saved,{...r,id:'restored-expression-result'})
    assert.ok(dom.window.document.querySelector('[data-wave-trace^="expression:"]'))
    assert.match(dom.window.document.querySelector(`.wave-trace-chip[data-trace-id="expression:${id}"]`)!.textContent!,/V\(vin,vout\)/)
    await click('视图 1 移除曲线 V(vin,vout)');assert.equal(dom.window.document.querySelector('[data-wave-trace^="expression:"]'),null)
    const hidden=published.at(-1)!
    assert.deepEqual(hidden.panels[0].expressions,edited.panels[0].expressions,'hiding retains the formula definition')
    assert.ok(!hidden.panels[0].ids.includes(`expression:${id}`))
    await click('视图 1 添加曲线');await select('视图 1 可添加曲线',`expression:${id}`);await click('视图 1 添加所选曲线')
    assert.ok(dom.window.document.querySelector(`[data-wave-trace="expression:${id}"]`),'hidden saved formula can be restored through the bottom picker')
    assert.equal(published.at(-1)!.panels[0].primary,`expression:${id}`)
    assert.deepEqual(published.at(-1)!.panels[0].expressions,edited.panels[0].expressions)
    assert.deepEqual(view,before);assert.deepEqual(saved,savedBefore);assert.equal(published.at(-1)!.panels[1].expressions,undefined)
  }finally {
    await act(async()=>root.unmount());dom.window.close();for(const[key,value]of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)
  }
})
