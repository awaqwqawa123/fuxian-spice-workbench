import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { blankProject } from '../src/core/editor'
import { connect, setNetLabel, terminal } from '../src/core/drawing'
import { createEntry, loadProjectCollection, PROJECTS_STORAGE } from '../src/core/project-store'
import { parseSpiceLibrary } from '../src/core/spice-models'
import { codexStatusFixture } from './codex-status-fixture'

test('Ctrl+C and Ctrl+V carry a schematic selection across project switches', {timeout:15000}, async()=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost:3032/#editor'}),{document:doc}=dom.window
  const original=new Map<string,PropertyDescriptor|undefined>()
  const install=(key:string,value:unknown)=>{original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true})}
  for(const [key,value] of Object.entries({window:dom.window,document:doc,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,IS_REACT_ACT_ENVIRONMENT:true}))install(key,value)
  Object.defineProperty(dom.window,'innerWidth',{value:1440,configurable:true})
  install('DOMPoint',class{constructor(public x:number,public y:number){}matrixTransform(){return{x:this.x,y:this.y}}})
  Object.assign(dom.window.SVGElement.prototype,{getScreenCTM:()=>({inverse:()=>({a:1,d:1})}),setPointerCapture:()=>{},releasePointerCapture:()=>{},hasPointerCapture:()=>false})
  install('fetch',async(url:string)=>Response.json(url==='/api/codex/status'?codexStatusFixture:{models:[],candidates:[],notices:[]}))
  const a=blankProject(),b=blankProject()
  a.title='带模型的源工程';b.title='粘贴目标工程'
  const model=parseSpiceLibrary('.subckt CLIP_BLOCK IN OUT PARAMS: GAIN=1\nR1 IN OUT {GAIN*1000}\n.ends CLIP_BLOCK',{label:'Example.asy'}).models[0]
  const pinPositions=[{x:-40,y:0},{x:40,y:0}]
  model.symbol={version:1,shape:'ltspice',origin:'imported',title:'原始符号',pins:model.pins.map((label,index)=>({label,index,...pinPositions[index]})),geometry:[{type:'rectangle',coords:[-24,-12,24,12]}]}
  a.models=[model]
  a.drawing!.devices=[
    {id:'X1',kind:'X',value:model.id,pins:model.pins,pinPositions,params:{GAIN:'2'},x:220,y:240,rotation:0},
    {id:'R1',kind:'R',value:'8.2k',x:420,y:240,rotation:0},
    {id:'R2',kind:'R',value:'1k',x:620,y:240,rotation:0},
  ]
  a.drawing=connect(connect(a.drawing!,terminal('X1',1),terminal('R1',0)),terminal('R1',1),terminal('R2',0))
  a.drawing=setNetLabel(a.drawing,terminal('X1',0),'signal')
  a.probes=[{id:'P1',kind:'voltage',positive:terminal('R1',0)}]
  b.drawing!.devices=[
    {id:'R1',kind:'R',value:'1k',x:420,y:240,rotation:0},
    {id:'R2',kind:'R',value:'3k',x:220,y:240,rotation:0},
  ]
  b.drawing=setNetLabel(b.drawing!,terminal('R1',0),'signal')
  const entries=[createEntry(a),createEntry(b)]
  localStorage.setItem(PROJECTS_STORAGE,JSON.stringify({version:1,entries,activeId:entries[0].id}))
  const {createRoot}=await import('react-dom/client'),{default:App}=await import('../src/App')
  const root=createRoot(doc.getElementById('root')!)
  const query=(selector:string)=>{const el=doc.querySelector(selector);assert.ok(el,selector);return el}
  const click=async(el:Element)=>act(async()=>el.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})))
  const key=async(el:Element,key:string,init:KeyboardEventInit={})=>{
    const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,ctrlKey:true,...init})
    await act(async()=>el.dispatchEvent(event))
    return event.defaultPrevented
  }
  const pointer=async(el:Element,type:string,x:number,y:number,shiftKey=false)=>act(async()=>el.dispatchEvent(new dom.window.MouseEvent(type,{bubbles:true,clientX:x,clientY:y,button:0,shiftKey})))
  const saved=(index:number)=>loadProjectCollection(localStorage,blankProject()).collection.entries[index].project
  try{
    await act(async()=>root.render(createElement(App)))
    await click(query('[aria-label="项目侧栏"]'))
    const canvas=()=>query('.editor-canvas')
    for(const [id,x] of [['X1',220],['R1',420]] as const){
      await pointer(query(`.editor-device[aria-label^="${id} "]`),'pointerdown',x,240,id==='R1')
      await pointer(canvas(),'pointerup',x,240)
    }
    assert.equal(await key(canvas(),'c'),true)
    await click(doc.querySelectorAll('.project-sidebar-entry')[1])
    const activeProject=query('.project-sidebar-entry[aria-current="page"]') as HTMLButtonElement
    activeProject.focus()
    const input=query('input[aria-label="项目名称"]') as HTMLInputElement
    input.focus();input.select()
    assert.equal(await key(input,'c'),false,'text remains copyable')
    assert.equal(await key(input,'v'),false,'text remains pasteable')
    activeProject.focus()
    assert.equal(await key(activeProject,'v'),true,'paste works immediately after project switch')
    query('.paste-preview')
    assert.equal(await key(canvas(),'r',{ctrlKey:false}),true)
    await pointer(canvas(),'pointerdown',840,360)
    const target=saved(1)
    assert.deepEqual(target.models?.[0].symbol,model.symbol)
    assert.equal(target.models?.[0].spice,model.spice)
    const pastedBlock=target.drawing!.devices.find(device=>device.id==='X1')
    assert.deepEqual(pastedBlock?.params,{GAIN:'2'})
    assert.equal(pastedBlock?.rotation,90,'placement matches the rotated preview')
    assert.equal(target.drawing!.devices.find(device=>device.id==='R3')?.value,'8.2k')
    assert.deepEqual(target.drawing!.wires.map(({from,to})=>[from,to]),[[terminal('X1',1),terminal('R3',0)]],'the unselected external wire is not pasted')
    assert.deepEqual(target.drawing!.labels!.map(label=>label.name),['signal','signal_copy'])
    assert.deepEqual(target.probes?.[0].kind==='voltage'&&target.probes[0].positive,terminal('R3',0))
    assert.equal(saved(0).drawing!.devices.length,3)
    assert.equal(await key(canvas(),'z'),true)
    assert.equal(saved(1).drawing!.devices.length,2)
    assert.equal(saved(1).models?.length??0,0,'undo also discards the copied model')
  }finally{
    await act(async()=>root.unmount());dom.window.close()
    for(const [key,descriptor] of original){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
  }
})
