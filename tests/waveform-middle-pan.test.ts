import assert from 'node:assert/strict'
import test from 'node:test'
import {act,createElement} from 'react'
import {JSDOM} from 'jsdom'
import WaveformWorkspace from '../src/components/WaveformWorkspace'
import {editableProject} from '../src/core/editor'
import {processResult} from '../src/core/results'
import {defaultWaveformPanels,waveformSignals} from '../src/core/waveform-workspace'
import type {WaveformViewState} from '../src/core/canvas-waveform-store'

test('middle drag pans the shared horizontal domain and current vertical axes without moving cursors or leaking to the canvas',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),doc=dom.window.document,prior=new Map<string,PropertyDescriptor|undefined>(),observers=new Map<Element,(width:number,height:number)=>void>()
  class Observer {
    constructor(private callback:(entries:{contentRect:{width:number;height:number}}[])=>void){}
    observe(element:Element){observers.set(element,(width,height)=>this.callback([{contentRect:{width,height}}]))}
    disconnect(){}
  }
  for(const[key,value]of Object.entries({window:dom.window,document:doc,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ResizeObserver:Observer,IS_REACT_ACT_ENVIRONMENT:true})){
    prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  const project=editableProject();project.analysis='tran'
  const result=processResult({dataType:'real',numPoints:5,data:[{name:'time',values:[0,.001,.002,.003,.004]},{name:'v(vin)',values:[0,1,2,3,4]},{name:'v(vout)',values:[0,.4,.7,.8,1]},{name:'i(V1)',values:[0,-.001,-.0003,-.0002,0]}]},project,'* pan fixture',0,'UI fixture','',[])
  const panels=defaultWaveformPanels(result,waveformSignals(result).signals)
  let saved:WaveformViewState={analysis:'tran',layout:2,panels,domain:[.25,.75],cursors:{a:.002,b:null}}
  const {createRoot}=await import('react-dom/client'),root=createRoot(doc.getElementById('root')!)
  let outerPointers=0,captured:number|undefined,released:number|undefined
  doc.body.addEventListener('pointerdown',()=>outerPointers++)
  doc.body.addEventListener('pointermove',()=>outerPointers++)
  const pointer=async(element:Element,type:string,x:number,y:number,button=1,id=7)=>{
    const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,button,buttons:type==='pointerup'?0:button===1?4:1,clientX:x,clientY:y})
    Object.defineProperty(event,'pointerId',{value:id});await act(async()=>element.dispatchEvent(event));return event
  }
  try{
    await act(async()=>root.render(createElement(WaveformWorkspace,{embedded:true,result,comparison:null,initialView:saved,onViewChange:next=>{saved=next}})))
    await act(async()=>observers.get(doc.querySelector('.wave-workspace')!)!(980,700))
    const plots=[...doc.querySelectorAll<SVGSVGElement>('.wave-plot')];assert.equal(plots.length,2)
    await act(async()=>{for(const plot of plots)observers.get(plot)!(800,260)})
    const plot=plots[0]
    Object.assign(plot,{getBoundingClientRect:()=>({left:0,top:0,width:800,height:260}),setPointerCapture:(id:number)=>{captured=id},hasPointerCapture:(id:number)=>captured===id,releasePointerCapture:(id:number)=>{released=id;captured=undefined}})
    const cursors={...saved.cursors},axis=plot.querySelector('[data-wave-axis]')!,originalY=Number(axis.getAttribute('data-y-min'))
    assert.equal((await pointer(plot,'pointerdown',400,100)).defaultPrevented,true)
    assert.equal(captured,7);assert.equal(plot.classList.contains('is-panning'),true)
    const start=[...saved.domain]
    await pointer(plot,'pointermove',200,120,1,8);assert.deepEqual(saved.domain,start,'another pointer cannot steal the drag')
    outerPointers=0
    assert.equal((await pointer(plot,'pointermove',340,120)).defaultPrevented,true)
    assert.ok(saved.domain[0]>.25);assert.ok(Math.abs(saved.domain[1]-saved.domain[0]-.5)<1e-12)
    assert.equal(plots[0].getAttribute('data-x-start'),plots[1].getAttribute('data-x-start'),'all plots share the horizontal domain')
    assert.ok(Number(axis.getAttribute('data-y-min'))>originalY)
    assert.ok(saved.panels[0].axisRanges);assert.equal(saved.panels[1].axisRanges,undefined,'vertical motion belongs to the dragged plot')
    assert.equal(saved.autoFit,false);assert.deepEqual(saved.cursors,cursors)
    await pointer(plot,'pointerup',340,120);assert.equal(released,7);assert.equal(plot.classList.contains('is-panning'),false);assert.equal(outerPointers,0)
    await pointer(plot,'pointerdown',300,100);await pointer(plot,'pointercancel',300,100);assert.equal(plot.classList.contains('is-panning'),false)
    const cursor=plot.querySelector('[data-wave-cursor="a"]')!
    await pointer(cursor,'pointerdown',400,100,0);await pointer(plot,'pointermove',750,100,0);await pointer(plot,'pointerup',750,100,0)
    assert.notEqual(saved.cursors.a,cursors.a,'left-button cursor dragging still works after middle-button panning')
    for(const[width,height]of [[280,120],[960,560],[1800,900]]){
      await act(async()=>observers.get(plot)!(width,height))
      assert.equal(plot.getAttribute('viewBox'),`0 0 ${width} ${height}`)
      const boundary=plot.querySelector('.wave-plot-boundary')!
      assert.ok(Number(boundary.getAttribute('y'))+Number(boundary.getAttribute('height'))<height-17)
      assert.ok(plot.querySelector('[data-wave-x-unit="s"]'));assert.ok(plot.querySelector('[data-wave-axis="V"]'))
      for(const text of plot.querySelectorAll('.wave-axis text,text.wave-axis')){
        assert.ok(Number(text.getAttribute('x'))>=0&&Number(text.getAttribute('x'))<=width)
        assert.ok(Number(text.getAttribute('y'))>=0&&Number(text.getAttribute('y'))<=height)
        assert.equal(text.closest('[clip-path]'),null,'coordinates must remain outside the curve clipping region')
      }
    }
    await act(async()=>observers.get(plot)!(0,0));assert.equal(plot.getAttribute('viewBox'),'0 0 1800 900','hidden transitions retain the last valid geometry')
  }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,value]of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
})
