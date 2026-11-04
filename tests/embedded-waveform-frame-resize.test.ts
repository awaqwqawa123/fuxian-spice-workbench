import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import EmbeddedWaveformResults from '../src/components/EmbeddedWaveformResults'
import { editableProject } from '../src/core/editor'
import { processResult } from '../src/core/results'
import { initialSimulationProfiles } from '../src/core/simulation-profiles'
import { defaultWaveformPanels, waveformSignals } from '../src/core/waveform-workspace'
import type { CanvasWaveform } from '../src/core/canvas-waveform-store'

test('docked result wheel zooms coordinates reversibly while its host and samples stay fixed; tools share one header', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' }), doc = dom.window.document
  const prior = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({window:dom.window,document:doc,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,IS_REACT_ACT_ENVIRONMENT:true})) {
    prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  const project=editableProject();project.analysis='tran'
  const result=processResult({dataType:'real',numPoints:3,data:[{name:'time',values:[0,.001,.002]},{name:'v(vin)',values:[0,1,1]},{name:'v(vout)',values:[0,.4,.7]},{name:'i(V1)',values:[0,-.001,-.0003]}]},project,'* resize fixture',0,'UI fixture','',[])
  const profile=initialSimulationProfiles(project).profiles[0]
  const view={analysis:'tran',layout:1 as const,panels:defaultWaveformPanels(result,waveformSignals(result).signals),domain:[0,1] as [number,number],cursors:{a:null,b:null}}
  let current:CanvasWaveform={id:'frame',title:'输出响应',profileId:profile.id,x:0,y:0,width:640,height:330,view}
  const originalSamples=[...result.x],resizes:number[]=[],snapshots:unknown[]=[]
  let outerWheels=0
  doc.getElementById('root')!.addEventListener('wheel',()=>outerWheels++)
  const {createRoot}=await import('react-dom/client'),root=createRoot(doc.getElementById('root')!)
  function Harness() {
    const [width,setWidth]=useState(640),[diagram,setDiagram]=useState(current)
    current=diagram
    return createElement('div',{'data-host':true,style:{width}},createElement(EmbeddedWaveformResults,{
      diagram,visible:true,active:true,profiles:[profile],result,history:[],running:false,busy:false,progress:'',failure:'',stale:false,measurements:[],
      onSelectMeasurement:()=>{},onPatch:(_id,patch)=>setDiagram(old=>({...old,...patch})),onSnapshot:value=>snapshots.push(value),onRun:()=>{},onClose:()=>{},onSettings:()=>{},onAdd:()=>{},onCopy:()=>{},onRemove:()=>{},canAdd:true,
      deviceSummary:createElement('span',null,'R1 · 1k'),onFrameResize:factor=>{resizes.push(factor);setWidth(old=>old*factor)},
    }))
  }
  try {
    await act(async()=>root.render(createElement(Harness)))
    const plot=doc.querySelector('.wave-plot')!
    assert.ok(plot)
    assert.doesNotMatch(doc.body.textContent!,/滚轮调整波形区大小/)
    Object.assign(plot,{getBoundingClientRect:()=>({left:0,top:0,width:800,height:260,right:800,bottom:260})})
    const domain=structuredClone(current.view!.domain)
    const range=()=>[...plot.querySelectorAll('[data-wave-axis]')].flatMap(axis=>[Number(axis.getAttribute('data-y-min')),Number(axis.getAttribute('data-y-max'))])
    const axes=range(),stateRows=doc.querySelectorAll('.wave-embedded-state').length
    const near=(actual:readonly number[],expected:readonly number[])=>actual.forEach((value,index)=>assert.ok(Math.abs(value-expected[index])<Math.max(1e-12,Math.abs(expected[index])*1e-10)))
    const wheel=async(deltaY:number)=>{const event=new dom.window.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY,clientX:400,clientY:125});await act(async()=>plot.dispatchEvent(event));assert.equal(event.defaultPrevented,true)}
    for(let i=0;i<6;i++)await wheel(-120)
    assert.ok(current.view!.domain[1]-current.view!.domain[0]<1)
    assert.equal(doc.querySelectorAll('.wave-embedded-state').length,stateRows,'zoom must not insert a header row that moves the pointer anchor')
    for(let i=0;i<6;i++)await wheel(120)
    near(current.view!.domain,domain);near(range(),axes)
    assert.equal(Number.parseFloat((doc.querySelector('[data-host]') as HTMLElement).style.width),640)
    assert.equal(resizes.length,0,'a legacy host resize callback cannot hijack coordinate zoom')
    assert.equal(outerWheels,0,'the outer schematic cannot receive this wheel')
    assert.deepEqual(result.x,originalSamples)
    assert.ok(snapshots.length)
    const toolbar=doc.querySelector('.page-result-toolbar')!
    assert.ok(toolbar.querySelector('.page-result-tabs'),'result actions share the identity header')
    assert.equal(doc.querySelector('.page-waveform-results > .page-result-tabs'),null)
    const summary=doc.querySelector<HTMLElement>('.page-device-summary')!
    assert.equal(summary.hidden,true,'device summary uses no permanent result row')
    await act(async()=>doc.querySelector<HTMLButtonElement>('[aria-label="当前器件参数"]')!.click())
    assert.equal(summary.hidden,false)
    await act(async()=>doc.querySelector<HTMLButtonElement>('[aria-label="当前器件参数"]')!.click())
    assert.equal(summary.hidden,true)
  } finally {
    await act(async()=>root.unmount());dom.window.close()
    for(const [key,value] of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)
  }
})
