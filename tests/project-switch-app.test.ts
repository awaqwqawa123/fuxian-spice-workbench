import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { blankProject, editorTemplate } from '../src/core/editor'
import { initialSimulationProfiles } from '../src/core/simulation-profiles'
import { createEntry, loadProjectCollection, PROJECTS_STORAGE, type ProjectCollection } from '../src/core/project-store'
import { codexStatusFixture } from './codex-status-fixture'
import { updateAssistantSettings } from '../src/core/assistant-settings'

test('real App switches projects without rewriting the library and preserves edits, reload selection and chat identity', {timeout:30000}, async()=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost:3032/#editor'}),doc=dom.window.document
  Object.defineProperty(dom.window,'innerWidth',{value:1440,configurable:true})
  const original=new Map<string,PropertyDescriptor|undefined>()
  const install=(key:string,value:unknown)=>{original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true})}
  for(const [key,value] of Object.entries({window:dom.window,document:doc,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,IS_REACT_ACT_ENVIRONMENT:true}))install(key,value)
  install('Worker',class{onmessage=null;onerror=null;postMessage(){}terminate(){}})
  const ensured:string[]=[]
  install('fetch',async(url:string,init?:RequestInit)=>{
    if(url==='/api/desktop-control/ensure'){const {projectId}=JSON.parse(String(init?.body));ensured.push(projectId);return Response.json({projectId,threadId:`thread-${projectId}`,connected:true,approvals:[],messages:[]})}
    if(url.startsWith('/api/desktop-control/state?'))return Response.json({connected:false,ready:false,desktopConnected:false,owner:'web',busy:false,approvals:[],messages:[]})
    if(url==='/api/codex/status')return Response.json(codexStatusFixture)
    return Response.json({document:{version:1,devices:[]},models:[],candidates:[],notices:[]})
  })
  const entries=['第一工程','第二工程','第三工程'].map((title,index)=>{
    const project=index===2?editorTemplate('rc-lowpass'):blankProject();project.title=title
    project.waveformSetup={version:1,profiles:initialSimulationProfiles(project),diagrams:[]}
    return createEntry(project)
  })
  const seed:ProjectCollection={version:1,activeId:entries[0].id,entries}
  dom.window.localStorage.setItem(PROJECTS_STORAGE,JSON.stringify(seed))
  const writes:{key:string;bytes:number}[]=[],storagePrototype=dom.window.Storage.prototype,priorSet=storagePrototype.setItem
  storagePrototype.setItem=function(key:string,value:string){writes.push({key,bytes:value.length});return priorSet.call(this,key,value)}
  const loaded=()=>loadProjectCollection(dom.window.localStorage,blankProject()).collection
  const {createRoot}=await import('react-dom/client'),{default:App}=await import('../src/App')
  const root=createRoot(doc.getElementById('root')!)
  const title=()=>doc.querySelector<HTMLInputElement>('[aria-label="项目名称"]')!
  const select=async(index:number)=>{
    const button=doc.querySelectorAll<HTMLButtonElement>('.project-sidebar-entry')[index];assert.ok(button)
    await act(async()=>button.click())
    assert.equal(title().value,loaded().entries[index].project.title)
    assert.equal(loaded().activeId,entries[index].id)
    assert.equal(new URL(dom.window.location.href).searchParams.get('project'),entries[index].id)
    assert.ok(doc.querySelector('[aria-label="项目侧栏"][aria-selected="true"]'),'project tab remains selected')
  }
  try{
    await act(async()=>root.render(createElement(App)))
    await act(async()=>doc.querySelector<HTMLButtonElement>('[aria-label="项目侧栏"]')!.click())
    // First automatic simulation can persist the initial default waveform group.
    // Once initialized, returning to any project must only save selection.
    for(const index of [1,2,0])await select(index)
    const initialWrites=writes.filter(write=>write.key===PROJECTS_STORAGE).length
    for(const index of [1,2,0,2,1])await select(index)
    assert.equal(writes.filter(write=>write.key===PROJECTS_STORAGE).length,initialWrites,'selection must not revalidate/serialize every project')
    assert.ok(writes.filter(write=>write.key!==PROJECTS_STORAGE&&write.key.includes('selection')).every(write=>write.bytes<512))
    assert.equal(ensured.length,0,'MCP mode must not create or attach native desktop chats')
    await act(async()=>{
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(title(),'第二工程已修改')
      title().dispatchEvent(new dom.window.Event('input',{bubbles:true}))
    })
    assert.equal(loaded().entries[1].project.title,'第二工程已修改')
    const editWrites=writes.filter(write=>write.key===PROJECTS_STORAGE).length
    assert.ok(editWrites>initialWrites,'actual edits still save the full validated project library')
    await select(0);await select(1)
    assert.equal(title().value,'第二工程已修改')
    assert.equal(writes.filter(write=>write.key===PROJECTS_STORAGE).length,editWrites)
    await act(async()=>updateAssistantSettings({connectionMode:'native'}))
    for(const index of [0,2,1])await select(index)
    assert.deepEqual(new Set(ensured),new Set(entries.map(entry=>entry.id)),'optional native mode keeps project chat bindings isolated')
    const nativeRequests=ensured.length
    await act(async()=>updateAssistantSettings({connectionMode:'mcp'}))
    await select(0);await select(1)
    assert.equal(ensured.length,nativeRequests,'switching back to MCP stops native chat attachment')
    await act(async()=>root.unmount())
    const restored=createRoot(doc.getElementById('root')!)
    try{
      await act(async()=>restored.render(createElement(App)))
      assert.equal(title().value,'第二工程已修改','reload restores both last selection and edited data')
    }finally{await act(async()=>restored.unmount())}
  }finally{
    await act(async()=>root.unmount());storagePrototype.setItem=priorSet;dom.window.close()
    for(const [key,descriptor] of original){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
  }
})
