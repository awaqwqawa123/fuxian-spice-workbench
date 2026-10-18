import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import WaveformWorkspace from '../src/components/WaveformWorkspace'
import { editableProject } from '../src/core/editor'
import { processResult } from '../src/core/results'
import { defaultWaveformPanels, waveformSignals } from '../src/core/waveform-workspace'
import type { WaveformViewState } from '../src/core/canvas-waveform-store'

for(const embedded of [true,false])test(`${embedded?'embedded':'full'} waveform supports XY wheel, per-unit Y, modifier axes and rectangle lens without altering canvas geometry`,async()=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/'}),doc=dom.window.document,prior=new Map<string,PropertyDescriptor|undefined>(),observers=new Map<Element,(width:number,height:number)=>void>()
  class Observer {constructor(private callback:(entries:{contentRect:{width:number;height:number}}[])=>void){}observe(element:Element){observers.set(element,(width,height)=>this.callback([{contentRect:{width,height}}]))}disconnect(){}}
  for(const [key,value]of Object.entries({window:dom.window,document:doc,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ResizeObserver:Observer,IS_REACT_ACT_ENVIRONMENT:true})){
    prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  const project=editableProject();project.analysis='tran'
  const result=processResult({dataType:'real',numPoints:5,data:[{name:'time',values:[0,.001,.002,.003,.004]},{name:'v(vin)',values:[0,1,2,3,4]},{name:'v(vout)',values:[0,.4,.7,.8,1]},{name:'i(V1)',values:[0,-.001,-.0003,-.0002,0]}]},project,'* XY zoom fixture',0,'UI fixture','',[])
  const signals=waveformSignals(result).signals,panels=defaultWaveformPanels(result,signals)
  panels[0]={...panels[0],ids:signals.filter(signal=>signal.kind==='voltage'||signal.kind==='current').map(signal=>signal.id)}
  panels[1]={...panels[1],axisRanges:{A:[-.002,.001]}}
  let saved:WaveformViewState={analysis:'tran',layout:2,panels,domain:[0,1],cursors:{a:null,b:null},autoFit:false}
  const {createRoot}=await import('react-dom/client'),root=createRoot(doc.getElementById('root')!)
  const pointer=async(element:Element,type:string,x:number,y:number,button=0)=>act(async()=>{const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,button,buttons:type==='pointerup'?0:button===1?4:1,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:7});element.dispatchEvent(event)})
  const wheel=async(element:Element,keys:{shiftKey?:boolean;altKey?:boolean}={})=>act(async()=>{const event=new dom.window.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-120,clientX:400,clientY:125,...keys});element.dispatchEvent(event);assert.equal(event.defaultPrevented,true)})
  const range=(plot:Element,unit:string)=>{const axis=plot.querySelector(`[data-wave-axis="${unit}"]`);assert.ok(axis,unit);return [Number(axis.getAttribute('data-y-min')),Number(axis.getAttribute('data-y-max'))]}
  const span=(range:number[])=>range[1]-range[0]
  let outerWheels=0;doc.body.addEventListener('wheel',()=>outerWheels++)
  try {
    await act(async()=>root.render(createElement(WaveformWorkspace,{embedded,result,comparison:null,initialView:saved,onViewChange:next=>saved=next})))
    if(embedded)await act(async()=>observers.get(doc.querySelector('.wave-workspace')!)!(1100,700))
    const plots=[...doc.querySelectorAll<SVGSVGElement>('.wave-plot')];assert.equal(plots.length,2)
    const plot=plots[0];for(const plot of plots){Object.assign(plot,{getBoundingClientRect:()=>({left:0,top:0,width:800,height:260}),setPointerCapture(){},releasePointerCapture(){},hasPointerCapture:()=>false});await act(async()=>observers.get(plot)!(800,260))}
    const baseV=range(plot,'V'),baseA=range(plot,'A'),otherY=range(plots[1],plots[1].querySelector('[data-wave-axis]')!.getAttribute('data-wave-axis')!)
    await wheel(plot)
    assert.ok(span(range(plot,'V'))<span(baseV));assert.ok(span(range(plot,'A'))<span(baseA),'separate V and A axes both zoom in their own units')
    assert.ok(saved.domain[1]-saved.domain[0]<1);assert.equal(plots[0].getAttribute('data-x-start'),plots[1].getAttribute('data-x-start'))
    assert.deepEqual(range(plots[1],plots[1].querySelector('[data-wave-axis]')!.getAttribute('data-wave-axis')!),otherY,'another plot keeps its Y range')
    const priorY=range(plot,'V');await wheel(plot,{shiftKey:true});assert.deepEqual(range(plot,'V'),priorY)
    const priorX=[...saved.domain];await wheel(plot,{altKey:true});assert.deepEqual(saved.domain,priorX);assert.ok(span(range(plot,'V'))<span(priorY))
    assert.equal(outerWheels,0,'internal coordinate gestures never resize/zoom the outer circuit canvas')
    const beforeLens={domain:[...saved.domain],ranges:structuredClone(saved.panels[0].axisRanges)},beforeLensY=range(plot,'V')
    await act(async()=>{const button=doc.querySelector<HTMLButtonElement>('[aria-label="局部放大"]');assert.ok(button);button.click()})
    await pointer(plot,'pointerdown',240,75);await pointer(plot,'pointermove',570,185);await pointer(plot,'pointerup',570,185)
    const detailPlot=embedded?plot:doc.querySelector<SVGSVGElement>('.wave-detail .wave-plot')!
    if(!embedded){assert.ok(detailPlot);Object.assign(detailPlot,{getBoundingClientRect:()=>({left:0,top:0,width:800,height:260}),setPointerCapture(){},releasePointerCapture(){},hasPointerCapture:()=>false});await act(async()=>observers.get(detailPlot)!(800,260))}
    assert.ok(span(range(detailPlot,'V'))<span(beforeLensY),'rectangle magnification must crop the vertical interval')
    assert.deepEqual(saved.domain,beforeLens.domain);assert.deepEqual(saved.panels[0].axisRanges,beforeLens.ranges,'a temporary lens never overwrites the saved overview')
    const lensX=detailPlot.getAttribute('data-x-start'),lensY=range(detailPlot,'V')
    await wheel(detailPlot,{altKey:true});assert.equal(detailPlot.getAttribute('data-x-start'),lensX);assert.ok(span(range(detailPlot,'V'))<span(lensY))
    assert.deepEqual(saved.panels[0].axisRanges,beforeLens.ranges,'detail Y adjustments stay independent of overview Y')
    const restoreButton=doc.querySelector<HTMLButtonElement>('[aria-label="关闭局部细节窗"]')
    assert.ok(restoreButton);await act(async()=>restoreButton.click());assert.deepEqual(range(plot,'V'),beforeLensY)
    const adapted=doc.querySelector<HTMLButtonElement>('[aria-label="适配所有波形"]');assert.ok(adapted);await act(async()=>adapted.click());assert.deepEqual(saved.domain,[0,1]);assert.equal(saved.panels[0].axisRanges,undefined)
    assert.deepEqual(range(plot,'V'),baseV)
  }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,value]of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
})
