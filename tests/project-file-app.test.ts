import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { blankProject } from '../src/core/editor'
import { PROJECTS_STORAGE, type ProjectCollection } from '../src/core/project-store'
import { createProjectArchive, readProjectFile } from '../src/core/project-file'
import { parseSpiceLibrary } from '../src/core/spice-models'
import { codexStatusFixture } from './codex-status-fixture'

test('App opens portable files as separate projects and sidebar save uses the latest editor without exporting chat state', {timeout:30000}, async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:3032/#editor'}),doc=dom.window.document
  Object.defineProperty(dom.window,'innerWidth',{value:1440,configurable:true})
  const original=new Map<string,PropertyDescriptor|undefined>()
  const install=(key:string,value:unknown)=>{original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true})}
  for(const [key,value] of Object.entries({window:dom.window,document:doc,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,IS_REACT_ACT_ENVIRONMENT:true}))install(key,value)
  install('Worker',class{onmessage=null;onerror=null;postMessage(){}terminate(){}})
  const ensured:string[]=[]
  install('fetch',async(url:string,init?:RequestInit)=>{
    if(url==='/api/desktop-control/ensure'){const {projectId}=JSON.parse(String(init?.body));ensured.push(projectId);return Response.json({projectId,threadId:'fixture-thread',connected:true,approvals:[],messages:[]})}
    if(url.startsWith('/api/desktop-control/state?'))return Response.json({connected:false,ready:false,desktopConnected:false,owner:'web',busy:false,approvals:[],messages:[]})
    if(url==='/api/codex/status')return Response.json(codexStatusFixture)
    return Response.json({document:{version:1,devices:[]},models:[],candidates:[],notices:[]})
  })
  const seed=blankProject();seed.title='原有未完成工程'
  dom.window.localStorage.setItem('fuxian-free-editor-v2',JSON.stringify(seed))
  dom.window.localStorage.setItem('fuxian-assistant-settings-v1',JSON.stringify({connectionMode:'native'}))
  dom.window.localStorage.setItem('fuxian-codex-settings',JSON.stringify({apiKey:'PRIVATE-KEY-MUST-STAY-LOCAL',threadId:'PRIVATE-CHAT'}))
  const {createRoot}=await import('react-dom/client'),{default:App}=await import('../src/App')
  const root=createRoot(doc.getElementById('root')!)
  const click=async(node:HTMLElement)=>{await act(async()=>node.click())}
  const collection=()=>JSON.parse(dom.window.localStorage.getItem(PROJECTS_STORAGE)!) as ProjectCollection
  const changeTitle=async(value:string)=>{
    const field=doc.querySelector<HTMLInputElement>('[aria-label="项目名称"]')!;assert.ok(field)
    await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})
  }
  const selectFile=async(file:File|{name:string;size:number;arrayBuffer():Promise<ArrayBuffer>;text():Promise<string>})=>{
    const input=doc.querySelector<HTMLInputElement>('input[type="file"][accept*=".fuxian"]');assert.ok(input)
    Object.defineProperty(input,'files',{configurable:true,value:[file]})
    await act(async()=>{input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  }
  const downloadUrls:{blob:Blob;name?:string}[]=[]
  const priorCreate=URL.createObjectURL,priorRevoke=URL.revokeObjectURL,anchorClick=dom.window.HTMLAnchorElement.prototype.click
  URL.createObjectURL=(blob)=>{downloadUrls.push({blob:blob as Blob});return `blob:fixture-${downloadUrls.length}`}
  URL.revokeObjectURL=()=>{}
  dom.window.HTMLAnchorElement.prototype.click=function(){downloadUrls.at(-1)!.name=this.download}
  try{
    await act(async()=>root.render(createElement(App)))
    const originalId=collection().activeId,originalProject=structuredClone(collection().entries[0].project)
    const shared=blankProject();shared.title='分享给同事的二极管工程'
    shared.models=parseSpiceLibrary('.model SHARE_D D(IS=2n N=1.4)',{label:'Portable public fixture'}).models
    shared.drawing!.devices=[{id:'D1',kind:'D',value:'SHARE_D',x:320,y:240,rotation:90}]
    const bytes=createProjectArchive(shared),file=new File([bytes as Uint8Array<ArrayBuffer>],'同事的电路.fuxian')
    await selectFile(file)
    let saved=collection()
    assert.equal(saved.entries.length,2)
    assert.notEqual(saved.activeId,originalId)
    assert.deepEqual(saved.entries.find(entry=>entry.id===originalId)!.project,originalProject)
    assert.equal(saved.entries.find(entry=>entry.id===saved.activeId)!.project.title,shared.title)
    assert.deepEqual(saved.entries.find(entry=>entry.id===saved.activeId)!.project.models,shared.models)
    assert.equal(new URL(dom.window.location.href).searchParams.get('project'),saved.activeId)
    assert.ok(ensured.includes(saved.activeId),'new project gets its own local chat binding')
    assert.ok(doc.querySelector('[aria-label="项目侧栏"][aria-selected="true"]'),'opening stays in the projects panel')
    await changeTitle('刚修改还未另存的工程')
    const sidebarSave=doc.querySelector<HTMLButtonElement>('.project-sidebar [aria-label="保存工程文件"]')
      ?? [...doc.querySelectorAll<HTMLButtonElement>('.project-sidebar button')].find(node=>node.textContent?.trim()==='保存工程文件')
    assert.ok(sidebarSave,'project sidebar provides portable save')
    await click(sidebarSave)
    assert.equal(downloadUrls.length,1)
    assert.match(downloadUrls[0].name!,/\.fuxian$/)
    const exported=await readProjectFile(new File([await downloadUrls[0].blob.arrayBuffer()],downloadUrls[0].name!))
    assert.equal(exported.project.title,'刚修改还未另存的工程')
    assert.ok(!JSON.stringify(exported).includes('PRIVATE-KEY-MUST-STAY-LOCAL'))
    assert.ok(!JSON.stringify(exported).includes('PRIVATE-CHAT'))
    const beforeInvalid=structuredClone(collection())
    await selectFile(new File(['broken'],'bad.fuxian'))
    assert.deepEqual(collection(),beforeInvalid,'failed file loading leaves every existing project intact')
    await selectFile(file)
    saved=collection()
    assert.equal(saved.entries.length,3,'the same file may be opened repeatedly as independent projects')
    assert.equal(new Set(saved.entries.map(entry=>entry.id)).size,3)
    assert.equal(saved.entries.find(entry=>entry.id===originalId)!.project.title,originalProject.title)
  }finally{
    await act(async()=>root.unmount());dom.window.close()
    URL.createObjectURL=priorCreate;URL.revokeObjectURL=priorRevoke;dom.window.HTMLAnchorElement.prototype.click=anchorClick
    for(const [key,descriptor] of original){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
  }
})
