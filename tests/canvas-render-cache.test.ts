import assert from 'node:assert/strict'
import test from 'node:test'
import {act,createElement,type ComponentProps} from 'react'
import {JSDOM} from 'jsdom'
import {editorTemplate} from '../src/core/editor'
import type EditorCanvas from '../src/components/EditorCanvas'

test('unrelated parent updates skip the actual canvas scene and events still use the newest callbacks',async()=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/'}),doc=dom.window.document
  const saved=new Map<string,PropertyDescriptor|undefined>()
  for(const [key,value] of Object.entries({window:dom.window,document:doc,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  Object.assign(dom.window.SVGElement.prototype,{getScreenCTM:()=>({a:1})})
  const source=process.env.CANVAS_RENDER_BASELINE?'../src/components/_EditorCanvasBaseline.tsx':'../src/components/EditorCanvas.tsx'
  const {default:Canvas}=await import(source),{createRoot}=await import('react-dom/client'),root=createRoot(doc.getElementById('root')!)
  const drawing=editorTemplate('rc-lowpass').drawing!,devices=drawing.devices
  let reads=0,latest=-1
  Object.defineProperty(drawing,'devices',{enumerable:true,get(){reads++;return devices}})
  const nothing=()=>{},selection:string[]=[],markers:[]=[]
  const props:ComponentProps<typeof EditorCanvas>={drawing,selection,onSelect:nothing,tool:'select',onTool:nothing,rotation:0,onChange:nothing,onStatus:nothing,zoom:1,onZoom:nothing,resetView:0,fitSelection:0,showNodes:true,wireBend:'hv',onWireBend:nothing,clipboard:null,onPaste:nothing,probeMarkers:markers}
  try{
    await act(async()=>root.render(createElement(Canvas,{...props,onEditDevice:()=>{latest=0}})))
    reads=0
    const started=performance.now()
    for(let index=1;index<=24;index++)await act(async()=>root.render(createElement(Canvas,{...props,onSelect:()=>{},onTool:()=>{},onStatus:()=>{},onEditDevice:()=>{latest=index}})))
    const repeatedReads=reads
    console.log(JSON.stringify({measurement:'actual-canvas-unrelated-parent-refresh',baseline:!!process.env.CANVAS_RENDER_BASELINE,updates:24,drawingDeviceReads:repeatedReads,elapsedMs:performance.now()-started}))
    if(process.env.CANVAS_RENDER_BASELINE)assert.ok(repeatedReads>0)
    else assert.equal(repeatedReads,0,'unchanged circuit must not execute scene traversal, geometry, or JSX mapping')
    const part=doc.querySelector<SVGGElement>('[data-context-device="R1"]')!
    await act(async()=>part.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true})))
    assert.equal(latest,24,'memoized artwork dispatches to latest parent action')
    const changed={...drawing,devices:devices.map(part=>part.id==='R1'?{...part,value:'22k',x:part.x+20}:part)}
    await act(async()=>root.render(createElement(Canvas,{...props,drawing:changed})))
    assert.match(doc.querySelector('[data-context-device="R1"] .device-value')!.textContent! ,/22k/)
    assert.match(doc.querySelector('[data-context-device="R1"]')!.getAttribute('transform')!,new RegExp(String(changed.devices.find(part=>part.id==='R1')!.x)))
    await act(async()=>root.render(createElement(Canvas,{...props})))
    assert.doesNotMatch(doc.querySelector('[data-context-device="R1"] .device-value')!.textContent!,/22k/,'undo restores the prior exact scene')
  }finally{
    await act(async()=>root.unmount());dom.window.close()
    for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
  }
})
