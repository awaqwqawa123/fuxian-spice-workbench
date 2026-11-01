import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { Project } from '../src/core/circuit'
import { editorTemplate } from '../src/core/editor'
import { createProjectArchive, readProjectFile } from '../src/core/project-file'
import { initialSimulationProfiles, saveSimulationProfiles } from '../src/core/simulation-profiles'
import { saveCanvasWaveforms } from '../src/core/canvas-waveform-store'
import ProjectSidebar from '../src/components/ProjectSidebar'

async function editor() {
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost:3032/#editor'}),doc=dom.window.document
  const previous=new Map<string,PropertyDescriptor|undefined>()
  const install=(key:string,value:unknown)=>{previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})}
  const downloads:{name:string;blob:Blob}[]=[],opened:{project:Project;notice?:string}[]=[],blobs=new Map<string,Blob>()
  let fileClicks=0,blobId=0,current:Project|undefined
  class TestURL extends URL {
    static createObjectURL(blob:Blob){const url=`blob:project-${++blobId}`;blobs.set(url,blob);return url}
    static revokeObjectURL(){}
  }
  class WorkerFixture {onmessage:unknown;onerror:unknown;postMessage(){}terminate(){}}
  for(const [key,value] of Object.entries({window:dom.window,document:doc,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true,Worker:WorkerFixture,URL:TestURL,fetch:async()=>Response.json({installed:false,available:false,authenticated:false,message:'UI fixture'}),DOMPoint:class{constructor(public x:number,public y:number){}matrixTransform(){return{x:this.x,y:this.y}}}}))install(key,value)
  Object.assign(dom.window.SVGElement.prototype,{getScreenCTM:()=>({inverse:()=>({a:1,d:1})}),setPointerCapture(){},releasePointerCapture(){},hasPointerCapture:()=>false})
  dom.window.HTMLAnchorElement.prototype.click=function(){downloads.push({name:this.download,blob:blobs.get(this.href)!})}
  dom.window.HTMLInputElement.prototype.click=function(){if(this.type==='file')fileClicks++}
  const baseline=editorTemplate('rc-lowpass');baseline.title='可分享的 RC 工程'
  const legacy=initialSimulationProfiles(baseline);legacy.profiles[0].name='迁移前 AC';saveSimulationProfiles(dom.window.localStorage,'standalone',legacy)
  saveCanvasWaveforms(dom.window.localStorage,'standalone',[{id:'shared-chart',title:'输出响应',profileId:legacy.activeId,x:180,y:600,width:480,height:280}])
  const {createRoot}=await import('react-dom/client'),{default:Editor}=await import('../src/EditorWorkbench'),root=createRoot(doc.getElementById('root')!)
  type EditorProps=Parameters<typeof Editor>[0]
  const baseProps:EditorProps={seed:baseline,onProjectChange:project=>{current=project},onOpenProject:(project,notice)=>opened.push({project,notice})}
  const render=async(props:Partial<EditorProps>={})=>act(async()=>root.render(createElement(Editor,{...baseProps,...props})))
  await render()
  const get=<T extends Element=HTMLElement>(selector:string)=>{const node=doc.querySelector<T>(selector);assert.ok(node,selector);return node}
  const click=async(label:string)=>act(async()=>get<HTMLButtonElement>(`button[aria-label="${label}"]`).click())
  const key=async(key:string,target:Element=doc.body)=>act(async()=>target.dispatchEvent(new dom.window.KeyboardEvent('keydown',{bubbles:true,cancelable:true,key,ctrlKey:true})))
  const open=async(file:unknown)=>act(async()=>{const input=get<HTMLInputElement>('input[type=file][accept*=".fuxian"]');Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  return{dom,doc,get,click,key,open,render,baseline,downloads,opened,get current(){return current!},get fileClicks(){return fileClicks},async close(){await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}}
}
const inputFile=(name:string,bytes:Uint8Array)=>({name,size:bytes.byteLength,arrayBuffer:async()=>new Uint8Array(bytes).buffer,text:async()=>new TextDecoder().decode(bytes)})

test('project file menu, shortcut and sidebar requests export latest edit plus migrated waveform configuration',async()=>{
  const ui=await editor()
  try{
    const canvas=ui.get<SVGElement>('.editor-canvas')
    await act(async()=>ui.get('.editor-device[aria-label^="R1 "]').dispatchEvent(new ui.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
    const value=ui.get<HTMLInputElement>('.device-value-fields input')
    await act(async()=>{Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype,'value')!.set!.call(value,'2.2k');value.dispatchEvent(new ui.dom.window.Event('input',{bubbles:true}))})
    await ui.click('保存工程文件')
    assert.equal(ui.downloads.length,1)
    assert.match(ui.downloads[0].name,/\.fuxian$/)
    const unpacked=await readProjectFile(inputFile(ui.downloads[0].name,new Uint8Array(await ui.downloads[0].blob.arrayBuffer())))
    assert.equal(unpacked.project.drawing!.devices.find(device=>device.id==='R1')!.value,'2.2k')
    assert.equal(unpacked.project.waveformSetup!.profiles.profiles[0].name,'迁移前 AC')
    assert.equal(unpacked.project.waveformSetup!.diagrams[0].title,'输出响应')
    await ui.key('s',canvas)
    assert.equal(ui.downloads.length,2,'Ctrl+S uses the same project archive path')
    await ui.key('s',value)
    assert.equal(ui.downloads.length,2,'editing inputs retains normal shortcut protection')
    await ui.render({fileAction:{sequence:1,kind:'save'}})
    assert.equal(ui.downloads.length,3)
    await ui.render({fileAction:{sequence:1,kind:'save'}})
    assert.equal(ui.downloads.length,3,'a repeated render never repeats the save request')
    await ui.render({fileAction:{sequence:2,kind:'open'}})
    assert.equal(ui.fileClicks,1)
    await ui.click('导出旧版 JSON')
    assert.match(ui.downloads.at(-1)!.name,/\.json$/)
    assert.equal(JSON.parse(await ui.downloads.at(-1)!.blob.text()).waveformSetup.diagrams[0].title,'输出响应')
  }finally{await ui.close()}
})

test('opening portable and legacy files hands a complete new project to App; errors preserve the edited project',async()=>{
  const ui=await editor()
  try{
    const source=editorTemplate('rc-highpass');source.title='来自其他电脑的工程'
    await ui.open(inputFile('迁移工程.fuxian',createProjectArchive(source)))
    assert.equal(ui.opened.length,1)
    assert.equal(ui.opened[0].project.title,source.title)
    assert.match(ui.opened[0].notice!,/重新运行/)
    assert.equal(ui.current.title,ui.baseline.title,'the current project is never replaced when App owns imports')
    await ui.open(inputFile('旧工程.json',new TextEncoder().encode(JSON.stringify(source))))
    assert.equal(ui.opened.length,2)
    await ui.open(inputFile('损坏.fuxian',new Uint8Array([1,2,3])))
    assert.equal(ui.opened.length,2)
    assert.equal(ui.current.title,ui.baseline.title)
    assert.match(ui.get('.exchange-notice').textContent!,/导入失败/)
    await ui.open(inputFile('旧工程.json',new TextEncoder().encode(JSON.stringify(source))))
    assert.equal(ui.opened.length,3,'a failed file does not prevent retrying the same file')
  }finally{await ui.close()}
})

test('an import pending during unmount cannot open or overwrite the next project',async()=>{
  const ui=await editor()
  let release!:(value:ArrayBuffer)=>void
  const bytes=createProjectArchive(editorTemplate('rc-highpass')),pending=new Promise<ArrayBuffer>(resolve=>{release=resolve})
  const file={name:'缓慢工程.fuxian',size:bytes.length,arrayBuffer:()=>pending,text:async()=>''}
  await ui.open(file)
  await ui.close()
  release(new Uint8Array(bytes).buffer)
  await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(ui.opened.length,0)
})

test('project sidebar offers explicit portable open and save callbacks',async()=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>'),previous=new Map<string,PropertyDescriptor|undefined>()
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})}
  const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!)
  let opened=0,saved=0
  try{
    await act(async()=>root.render(createElement(ProjectSidebar,{embedded:true,entries:[{id:'a',title:'分享工程',updatedAt:1,deviceCount:5}],activeId:'a',onSelect:()=>{},onNew:()=>{},onDuplicate:()=>{},saveState:'saved',onOpenFile:()=>opened++,onSaveFile:()=>saved++})))
    const buttons=dom.window.document.querySelectorAll<HTMLButtonElement>('[aria-label="独立工程文件"] button')
    assert.equal(buttons.length,2)
    await act(async()=>{buttons[0].click();buttons[1].click()})
    assert.equal(opened,1);assert.equal(saved,1)
    assert.match(dom.window.document.body.textContent!,/\.fuxian/)
  }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
})
