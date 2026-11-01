import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import SinglePageWorkspace from '../src/components/SinglePageWorkspace'

test('docked waveform scale and full splitter boundary resize the host while retaining plot and camera nodes', async () => {
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'})
  const saved=new Map<string,PropertyDescriptor|undefined>()
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  Object.assign(dom.window.HTMLElement.prototype,{setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}})
  const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!)
  let request:(factor:number)=>void=()=>{}
  function Harness(){
    const [scale,setScale]=useState<{sequence:number;logScale:number}>()
    request=factor=>setScale(old=>({sequence:(old?.sequence??0)+1,logScale:(old?.logScale??0)+Math.log(factor)}))
    return createElement(SinglePageWorkspace,{layoutKey:'resize-test',mode:'split',sidebarScaleRequest:scale,
      properties:createElement('div',null,'properties'),schematic:createElement('svg',{className:'editor-canvas',viewBox:'0 0 1200 600'}),
      waveform:createElement('svg',{className:'wave-plot','data-domain':'0,1'})})
  }
  try{
    await act(async()=>root.render(createElement(Harness)))
    const host=dom.window.document.querySelector<HTMLElement>('.single-page-workspace')!
    const plot=dom.window.document.querySelector('.wave-plot'),canvas=dom.window.document.querySelector('.editor-canvas')!
    const width=()=>parseFloat(dom.window.document.querySelector<HTMLElement>('.single-page-workspace')!.style.getPropertyValue('--page-schematic-width'))
    assert.equal(width(),450)
    await act(async()=>request(1.1));assert.ok(Math.abs(width()-395)<.01)
    await act(async()=>request(100));assert.equal(width(),300,'reserve a usable schematic width')
    await act(async()=>request(.001));assert.equal(width(),650,'respect the minimum waveform width')
    const handle=host.querySelector<HTMLElement>('[role="separator"]')!
    async function pointer(type:string,x:number){const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,button:0,buttons:type==='pointerup'?0:1,clientX:x});Object.defineProperty(event,'pointerId',{value:4});await act(async()=>handle.dispatchEvent(event))}
    await pointer('pointerdown',650);await pointer('pointermove',500);await pointer('pointerup',500)
    assert.equal(width(),500,'dragging separator background works, not just its icon')
    await act(async()=>{request(.9);request(.9)})
    assert.ok(Math.abs(width()-595)<.001,'batched wheel events both resize the footprint')
    assert.equal(dom.window.document.querySelector('.wave-plot'),plot)
    assert.equal(plot?.getAttribute('data-domain'),'0,1')
    assert.equal(canvas.getAttribute('viewBox'),'0 0 1200 600')
    await act(async()=>root.render(null))
    await act(async()=>root.render(createElement(Harness)))
    assert.ok(Math.abs(width()-595)<.001,'saved ratio survives remount')
  }finally{
    await act(async()=>root.unmount());dom.window.close()
    for(const[key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
  }
})
