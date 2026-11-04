import assert from 'node:assert/strict'
import test from 'node:test'
import { act,createElement,useState } from 'react'
import { JSDOM } from 'jsdom'
import EditorCanvas,{type EditorTool} from '../src/components/EditorCanvas'
import { canvasDiagramBounds,changeCanvasDiagram,defaultCanvasDiagram,fitCanvasView,normalizeCanvasDiagram,type CanvasDiagramGeometry } from '../src/core/canvas-diagrams'
import { emptyDrawing,type Drawing } from '../src/core/drawing'
import { fitView,selectionBounds } from '../src/core/selection'

const drawing:Drawing={...emptyDrawing(),devices:[{id:'R1',kind:'R',value:'1k',x:200,y:200,rotation:0}]}

test('diagram placement and fitting include sheet objects without altering electrical drawing',()=>{
  const before=structuredClone(drawing),frame=defaultCanvasDiagram(drawing),circuit=selectionBounds(drawing)!
  assert.equal(frame.width,640);assert.equal(frame.height,330);assert.ok(frame.y>circuit.bottom)
  assert.deepEqual(fitCanvasView(drawing),fitView(drawing))
  const bounds=canvasDiagramBounds([frame])!,view=fitCanvasView(drawing,[frame],{width:1200,height:800})
  const left=view.center.x-600/view.zoom,right=view.center.x+600/view.zoom,top=view.center.y-400/view.zoom,bottom=view.center.y+400/view.zoom
  assert.ok(left<Math.min(circuit.left,bounds.left)&&right>Math.max(circuit.right,bounds.right))
  assert.ok(top<circuit.top&&bottom>bounds.bottom)
  assert.deepEqual(drawing,before)
  assert.ok(fitCanvasView(emptyDrawing(),[frame]).zoom>0)
})

test('diagram geometry rejects nonfinite bounds and limits move/resize to a usable sheet rectangle',()=>{
  const initial=normalizeCanvasDiagram({id:'P1',x:Infinity,y:NaN,width:-40,height:5000})
  assert.deepEqual(initial,{id:'P1',x:120,y:560,width:320,height:1600})
  assert.equal(changeCanvasDiagram(initial,{x:-50000,y:50000},'move').x,-20000)
  assert.equal(changeCanvasDiagram(initial,{x:50000,y:50000},'move').y,18400)
  const sized=changeCanvasDiagram(initial,{x:-500,y:-5000},'resize')
  assert.equal(sized.width,320);assert.equal(sized.height,200)
})

async function environment(scale=1,withWheelResize=false){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/'}),doc=dom.window.document
  const prior=new Map<string,PropertyDescriptor|undefined>(),captured=new Set<number>(),captureOwners=new Map<number,Element>()
  for(const [name,value]of Object.entries({window:dom.window,document:doc,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,IS_REACT_ACT_ENVIRONMENT:true,DOMPoint:class{constructor(public x:number,public y:number){}matrixTransform(m:{a:number;d:number;e:number;f:number}){return{x:this.x*m.a+m.e,y:this.y*m.d+m.f}}}})){
    prior.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,writable:true,value})
  }
  const captureLost=(element:Element,id:number)=>{const event=new dom.window.Event('lostpointercapture',{bubbles:true});Object.defineProperty(event,'pointerId',{value:id});element.dispatchEvent(event)}
  Object.assign(dom.window.SVGElement.prototype,{
    getScreenCTM:()=>({a:scale,inverse:()=>({a:1/scale,d:1/scale,e:-31/scale,f:-17/scale})}),
    setPointerCapture(this:Element,id:number){const previous=captureOwners.get(id);if(previous&&previous!==this){captureOwners.delete(id);captured.delete(id);captureLost(previous,id)}captureOwners.set(id,this);captured.add(id)},
    releasePointerCapture(this:Element,id:number){if(captureOwners.get(id)!==this)return;captureOwners.delete(id);captured.delete(id);captureLost(this,id)},
    hasPointerCapture(this:Element,id:number){return captureOwners.get(id)===this},
  })
  const {createRoot}=await import('react-dom/client'),root=createRoot(doc.getElementById('root')!)
  let current=defaultCanvasDiagram(drawing),tool:EditorTool='select',reset=()=>{},activate=(_value:boolean)=>{},setTool=(_value:EditorTool)=>{},disableCopy=(_value:boolean)=>{}
  const geometryChanges:CanvasDiagramGeometry[]=[],drawingChanges:Drawing[]=[],expanded:string[]=[],copied:string[]=[],zooms:number[]=[],context:string[]=[],probes:string[]=[],pastes:string[]=[],selectedDiagrams:(string|null)[]=[],wheelResizes:{factor:number;anchor?:{x:number;y:number}}[]=[],bubbledKeys:{key:string;prevented:boolean;target:string}[]=[]
  dom.window.addEventListener('keydown',event=>bubbledKeys.push({key:event.key,prevented:event.defaultPrevented,target:(event.target as Element).tagName}))
  function Harness(){
    const [geometry,update]=useState(current),[currentTool,changeTool]=useState<EditorTool>('select'),[resetView,resetNow]=useState(0),[active,changeActive]=useState(true),[copyDisabled,setCopyDisabled]=useState(false),[selectedDiagramId,selectDiagram]=useState<string|null>(null)
    current=geometry;tool=currentTool;setTool=changeTool;reset=()=>resetNow(value=>value+1);activate=changeActive;disableCopy=setCopyDisabled
    return createElement(EditorCanvas,{active,drawing,selection:['R1'],onSelect:()=>{},tool:currentTool,onTool:changeTool,rotation:0,onChange:next=>drawingChanges.push(next),onStatus:()=>{},zoom:scale,onZoom:next=>zooms.push(next),resetView,fitSelection:0,showNodes:false,wireBend:'hv',onWireBend:()=>{},clipboard:null,onPaste:()=>pastes.push('paste'),onProbe:()=>probes.push('probe'),onContextMenu:()=>context.push('context'),
      selectedDiagramId,onDiagramSelect:id=>{selectedDiagrams.push(id);selectDiagram(id)},canvasDiagrams:[{...geometry,...(withWheelResize?{onWheelResize:(factor:number,anchor?:{x:number;y:number})=>{wheelResizes.push({factor,anchor});update(previous=>({...previous,width:Math.max(320,previous.width*factor),height:Math.max(200,previous.height*factor)}))}}:{}),title:'瞬态波形',onCopy:()=>copied.push(geometry.id),copyDisabled,content:createElement('div',{'data-test-plot':true},createElement('svg',{className:'wave-plot',viewBox:'0 0 400 200'},createElement('path',{d:'M 0 100 L 400 50'})),createElement('input',{'data-embedded-input':true,defaultValue:'wave name'}),createElement('div',{'data-embedded-editable':true,contentEditable:true,suppressContentEditableWarning:true},'editable'))}],
      onDiagramChange:(id,next)=>{assert.equal(id,next.id);geometryChanges.push(next);update(next)},onDiagramExpand:id=>expanded.push(id)})
  }
  const get=(selector:string)=>{const element=doc.querySelector(selector);assert.ok(element,selector);return element}
  const pointer=async(selector:string,type:string,x:number,y:number,options:MouseEventInit={})=>{await act(async()=>{
    const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x*scale+31,clientY:y*scale+17,...options});Object.defineProperty(event,'pointerId',{value:1})
    const owner=captureOwners.get(1),target=['pointermove','pointerup','pointercancel'].includes(type)&&owner?owner:get(selector)
    target.dispatchEvent(event)
  })}
  const key=async(selector:string,value:string,options:KeyboardEventInit={})=>{await act(async()=>get(selector).dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...options})))}
  await act(async()=>root.render(createElement(Harness)))
  return{doc,get,pointer,key,captured,captureOwners,geometryChanges,drawingChanges,expanded,copied,zooms,context,probes,pastes,selectedDiagrams,wheelResizes,bubbledKeys,get geometry(){return current},get tool(){return tool},
    async reset(){await act(async()=>reset())},async active(value:boolean){await act(async()=>activate(value))},async choose(value:EditorTool){await act(async()=>setTool(value))},async copyDisabled(value:boolean){await act(async()=>disableCopy(value))},
    async cleanup(){await act(async()=>root.unmount());dom.window.close();for(const[name,value]of prior){if(value)Object.defineProperty(globalThis,name,value);else Reflect.deleteProperty(globalThis,name)}}}
}

test('visible diagram copy supports mouse and keyboard without moving, expanding or editing the circuit',async()=>{
  const page=await environment()
  try{
    const initial={...page.geometry},copy='.canvas-diagram-copy'
    assert.equal(page.get(copy).getAttribute('aria-label'),'复制画布波形图')
    await page.choose('wire')
    await page.pointer(copy,'pointerdown',500,350)
    assert.equal(page.captured.size,0,'copy must never start the title drag')
    await page.pointer(copy,'pointermove',540,390)
    await page.pointer(copy,'pointerup',540,390)
    await page.pointer(copy,'click',540,390)
    await page.pointer(copy,'dblclick',540,390)
    await page.key(copy,'Enter');await page.key(copy,' ')
    assert.deepEqual(page.copied,['waveforms','waveforms','waveforms'])
    assert.deepEqual(page.geometry,initial);assert.deepEqual(page.geometryChanges,[])
    assert.deepEqual(page.expanded,[]);assert.deepEqual(page.drawingChanges,[])
    await page.copyDisabled(true)
    assert.equal(page.get(copy).getAttribute('aria-disabled'),'true')
    await page.pointer(copy,'click',540,390);await page.key(copy,'Enter')
    await page.copyDisabled(false);await page.active(false)
    await page.pointer(copy,'click',540,390);await page.key(copy,' ')
    assert.equal(page.copied.length,3,'disabled or inactive frames cannot duplicate')
  }finally{await page.cleanup()}
})

test('diagram drag follows world scale, previews without committing and commits one geometry-only change',async()=>{
  for(const scale of [.2,1,2]){
    const page=await environment(scale)
    try{
      const initial={...page.geometry}
      await page.pointer('.canvas-diagram-title','pointerdown',100,350)
      await page.pointer('.canvas-diagram-title','pointermove',150,390)
      assert.equal(page.geometryChanges.length,0)
      assert.equal(page.get('[data-canvas-diagram]').getAttribute('transform'),`translate(${initial.x+50} ${initial.y+40})`)
      await page.pointer('.canvas-diagram-title','pointerup',180,410)
      assert.equal(page.geometryChanges.length,1);assert.equal(page.geometry.x,initial.x+80);assert.equal(page.geometry.y,initial.y+60)
      assert.equal(page.captured.size,0);assert.deepEqual(page.drawingChanges,[])
      assert.equal(page.get('.canvas-diagram-foreign').getAttribute('width'),'624')
    }finally{await page.cleanup()}
  }
})

test('selected waveform frame never steals wheel events to resize its geometry',async()=>{
  const page=await environment(1,true)
  try{
    const frame=page.get('[data-canvas-diagram]')
    Object.defineProperty(frame,'getBoundingClientRect',{configurable:true,value:()=>({left:0,top:0,width:1000,height:800,right:1000,bottom:800})})
    await page.pointer('[data-canvas-diagram]','pointerdown',100,350)
    await page.pointer('[data-canvas-diagram]','pointerup',100,350)
    // A loading/third-party plot has no CanvasWaveformPreview callback. The
    // frame must still own its whole footprint rather than skipping plot hits.
    Object.defineProperty(page.get('.wave-plot'),'getBoundingClientRect',{configurable:true,value:()=>({left:100,top:100,width:800,height:600,right:900,bottom:700})})
    const before={width:page.geometry.width,height:page.geometry.height}
    const wheel=new page.doc.defaultView!.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:120,clientX:500,clientY:400})
    await act(async()=>frame.dispatchEvent(wheel))
    assert.equal(page.wheelResizes.length,0)
    assert.deepEqual({width:page.geometry.width,height:page.geometry.height},before)
    assert.equal(wheel.defaultPrevented,true)
    await act(async()=>new Promise(resolve=>setTimeout(resolve,170)))
    assert.ok(page.zooms.length>0,'a frame without an interactive plot leaves ordinary canvas navigation available')
  }finally{await page.cleanup()}
})

test('diagram resizing respects limits, keyboard handles work and cancelled gestures leave no changes',async()=>{
  const page=await environment(.5)
  try{
    const initial={...page.geometry}
    await page.pointer('.canvas-diagram-resize','pointerdown',500,600)
    await page.pointer('.canvas-diagram-resize','pointermove',600,670)
    assert.equal(page.get('.canvas-diagram-frame').getAttribute('width'),'740')
    await page.key('.canvas-diagram-resize','Escape')
    assert.deepEqual(page.geometry,initial);assert.equal(page.geometryChanges.length,0);assert.equal(page.captured.size,0)
    await page.pointer('.canvas-diagram-resize','pointerdown',500,600)
    await page.pointer('.canvas-diagram-resize','pointerup',0,0)
    assert.equal(page.geometry.width,320);assert.equal(page.geometry.height,200)
    await page.key('.canvas-diagram-resize','ArrowRight',{shiftKey:true})
    assert.equal(page.geometry.width,340)
    await page.key('.canvas-diagram-title','ArrowDown')
    assert.equal(page.geometry.y,initial.y+10)
    const commits=page.geometryChanges.length
    await page.pointer('.canvas-diagram-title','pointerdown',100,350)
    await page.pointer('.canvas-diagram-title','pointermove',180,410)
    await page.active(false)
    await page.pointer('.canvas-diagram-title','pointerup',180,410)
    assert.equal(page.geometryChanges.length,commits);assert.equal(page.captured.size,0)
    assert.deepEqual(page.drawingChanges,[])
  }finally{await page.cleanup()}
})

test('canvas diagram captures edit tools while supporting double click, Enter and normal canvas navigation',async()=>{
  const page=await environment()
  try{
    const initial={...page.geometry}
    for(const tool of ['wire','probe','paste','R'] as EditorTool[]){
      await page.choose(tool)
      await page.pointer('[data-test-plot]','pointerdown',200,400)
      await page.pointer('[data-test-plot]','pointerup',200,400)
    }
    assert.deepEqual(page.drawingChanges,[]);assert.deepEqual(page.probes,[]);assert.deepEqual(page.pastes,[])
    await page.pointer('[data-test-plot]','dblclick',200,400)
    await page.key('.canvas-diagram-title','Enter')
    await page.pointer('.canvas-diagram-expand','click',200,400)
    assert.deepEqual(page.expanded,['waveforms','waveforms','waveforms'])
    await page.choose('select')
    const view=page.get('.editor-canvas').getAttribute('viewBox')
    await page.pointer('[data-test-plot]','pointerdown',200,400,{button:2})
    await page.pointer('.editor-canvas','pointermove',250,450,{button:2})
    await page.pointer('.editor-canvas','pointerup',250,450,{button:2})
    assert.notEqual(page.get('.editor-canvas').getAttribute('viewBox'),view)
    assert.deepEqual(page.context,[]);assert.deepEqual(page.geometry,initial)
    await act(async()=>page.get('[data-test-plot]').dispatchEvent(new page.doc.defaultView!.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100,clientX:231,clientY:417})))
    await act(async()=>new Promise(resolve=>setTimeout(resolve,170)))
    assert.ok(page.zooms.at(-1)!<1)
    await page.reset()
    const fit=fitCanvasView(drawing,[page.geometry]);assert.equal(page.zooms.at(-1),fit.zoom)
    assert.deepEqual(page.drawingChanges,[])
  }finally{await page.cleanup()}
})

test('middle zoom mode and right pan on nested plots run before diagram bubble handlers',async()=>{
  const page=await environment(.5)
  try{
    const geometry={...page.geometry}
    for(const button of [1,2]){
      const view=page.get('.editor-canvas').getAttribute('viewBox')
      const zoomCalls=page.zooms.length
      await page.pointer('[data-test-plot] path','pointerdown',200,400,{button})
      if(button===1){
        await page.pointer('[data-test-plot] path','pointerup',200,400,{button})
        assert.ok(page.get('.editor-canvas').classList.contains('is-middle-zooming'))
        await page.pointer('[data-test-plot] path','pointermove',260,440,{button:0})
        await act(async()=>new Promise(resolve=>setTimeout(resolve,170)))
        assert.ok(page.zooms.length>zoomCalls);assert.ok(page.zooms.at(-1)!<.5)
        await page.pointer('[data-test-plot] path','pointerdown',260,440,{button})
        await page.pointer('[data-test-plot] path','pointerup',260,440,{button})
      }else{
        assert.equal(page.captureOwners.get(1),page.get('.editor-canvas'))
        // Captured moves follow the true owner after leaving the plot.
        await page.pointer('[data-test-plot] path','pointermove',260,440,{button})
        await page.pointer('[data-test-plot] path','pointerup',260,440,{button})
        assert.notEqual(page.get('.editor-canvas').getAttribute('viewBox'),view)
      }
      assert.equal(page.captured.size,0)
      assert.deepEqual(page.geometry,geometry)
    }
    await page.choose('wire')
    await page.pointer('[data-test-plot] path','pointerdown',200,400,{button:2})
    await page.pointer('[data-test-plot] path','pointerup',200,400,{button:2})
    assert.equal(page.tool,'select','short right click still exits the canvas wire tool')
    assert.deepEqual(page.context,[]);assert.deepEqual(page.drawingChanges,[]);assert.deepEqual(page.geometryChanges,[])
  }finally{await page.cleanup()}
})

test('title capture survives leaving diagram, releases once, and preserves double-click activation',async()=>{
  const page=await environment()
  try{
    const initial={...page.geometry},title=page.get('.canvas-diagram-title')
    await page.pointer('.canvas-diagram-title','pointerdown',150,350)
    assert.equal(page.captureOwners.get(1),title)
    await page.pointer('.editor-canvas','pointermove',450,450)
    await page.pointer('.editor-canvas','pointerup',470,470)
    assert.equal(page.geometryChanges.length,1);assert.equal(page.geometry.x,initial.x+320);assert.equal(page.geometry.y,initial.y+120)
    assert.equal(page.captureOwners.size,0)
    for(let click=0;click<2;click++){
      await page.pointer('.canvas-diagram-title','pointerdown',470,470)
      await page.pointer('.canvas-diagram-title','pointerup',470,470)
      await page.pointer('.canvas-diagram-title','click',470,470)
    }
    await page.pointer('.canvas-diagram-title','dblclick',470,470)
    assert.equal(page.geometryChanges.length,1,'two stationary clicks do not create spurious undo records')
    assert.deepEqual(page.expanded,['waveforms'])
    await page.pointer('.canvas-diagram-title','pointerdown',470,470)
    await page.pointer('.editor-canvas','pointermove',570,570)
    await page.pointer('.editor-canvas','pointercancel',570,570)
    assert.equal(page.captureOwners.size,0);assert.equal(page.geometryChanges.length,1)
    assert.equal(page.get('[data-canvas-diagram]').getAttribute('transform'),`translate(${page.geometry.x} ${page.geometry.y})`)
    assert.deepEqual(page.drawingChanges,[])
  }finally{await page.cleanup()}
})


test('selected waveform forwards Ctrl/Cmd clipboard and undo keys to its owner and preserves native text controls',async()=>{
  const page=await environment()
  try{
    const frame='[data-canvas-diagram]'
    await page.pointer(frame,'pointerdown',100,350)
    assert.equal(page.get(frame).getAttribute('data-diagram-selected'),'true')
    assert.equal(page.selectedDiagrams.at(-1),'waveforms')
    for(const key of ['c','v','z','y']){
      await page.key('.canvas-diagram-title',key,{ctrlKey:true})
      await page.key(frame,key,{metaKey:true})
    }
    assert.deepEqual(page.bubbledKeys.map(event=>event.key),['c','c','v','v','z','z','y','y'])
    assert.ok(page.bubbledKeys.every(event=>!event.prevented),'the owner, not the frame, manages clipboard and history')
    assert.deepEqual(page.copied,[],'copy shortcut snapshots only; it must not immediately duplicate')
    for(const selector of ['[data-embedded-input]','[data-embedded-editable]']){
      for(const key of ['c','v','Enter','ArrowRight'])await page.key(selector,key,{ctrlKey:key.length===1})
      await page.pointer(selector,'dblclick',100,350)
    }
    assert.ok(page.bubbledKeys.slice(8).every(event=>!event.prevented))
    assert.deepEqual(page.expanded,[]);assert.deepEqual(page.geometryChanges,[])
    await page.pointer('.canvas-viewport-background','pointerdown',100,100)
    assert.equal(page.get(frame).hasAttribute('data-diagram-selected'),false)
    assert.equal(page.selectedDiagrams.at(-1),null)
  }finally{await page.cleanup()}
})
