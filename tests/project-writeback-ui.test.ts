import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { editorTemplate } from '../src/core/editor'
import { createProjectArchive, readProjectFile } from '../src/core/project-file'
import { PROJECTS_STORAGE, type ProjectCollection } from '../src/core/project-store'
import type { ProjectFileHandle } from '../src/core/project-writeback'

test('explicitly opening a writable project binds only its own local copy and requires an independent verified backup', {timeout:30000}, async()=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost:3032/#editor'}),doc=dom.window.document
  const original=new Map<string,PropertyDescriptor|undefined>()
  for(const [key,value] of Object.entries({window:dom.window,document:doc,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,IS_REACT_ACT_ENVIRONMENT:true,Worker:class{onmessage=null;onerror=null;postMessage(){}terminate(){}},fetch:async()=>Response.json({installed:false,available:false,authenticated:false})})){
    original.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
    Object.defineProperty(globalThis,key,{value,writable:true,configurable:true})
  }
  const seed=editorTemplate('rc-lowpass');seed.title='原有本机工程'
  dom.window.localStorage.setItem('fuxian-free-editor-v2',JSON.stringify(seed))
  const {createRoot}=await import('react-dom/client'),{default:App}=await import('../src/App')
  const root=createRoot(doc.getElementById('root')!)
  const archive={...seed,title:'同事的电路'}
  const originalBytes=new Uint8Array(createProjectArchive(archive))
  const fileHandle=(name:string,initial:Uint8Array<ArrayBuffer>)=>{
    let bytes=initial, writes=0, permissions=0
    const handle:ProjectFileHandle={
      kind:'file',name,
      getFile:async()=>new File([bytes],name),
      isSameEntry:async other=>other===handle,
      requestPermission:async()=>{permissions++;return 'granted'},
      createWritable:async()=>{
        let pending:Uint8Array<ArrayBuffer>|undefined
        return {write:async value=>{pending=value},close:async()=>{assert.ok(pending);bytes=pending;writes++},abort:async()=>{pending=undefined}}
      },
    }
    return {handle,get bytes(){return bytes},get writes(){return writes},get permissions(){return permissions}}
  }
  const source=fileHandle('同事的电路.fuxian',originalBytes)
  let selected:ProjectFileHandle[]=[]
  Object.defineProperty(dom.window,'showOpenFilePicker',{value:async()=>selected})
  const collection=()=>JSON.parse(dom.window.localStorage.getItem(PROJECTS_STORAGE)!) as ProjectCollection
  const click=(node:HTMLElement)=>act(async()=>node.click())
  const button=(label:string,selector='button')=>{
    const found=[...doc.querySelectorAll<HTMLButtonElement>(selector)].find(node=>node.textContent?.trim()===label||node.getAttribute('aria-label')===label)
    assert.ok(found,label);return found
  }
  const inDialog=(label:string)=>button(label,'.writeback-window button')
  const fileMenu=()=>doc.querySelector<HTMLDetailsElement>('.workspace-file-menu')!
  const openMenu=async()=>{if(!fileMenu().open)await click(fileMenu().querySelector('summary')!)}
  const downloaded:{name?:string;blob?:Blob}={}
  const priorCreate=URL.createObjectURL,priorRevoke=URL.revokeObjectURL,nativeClick=dom.window.HTMLAnchorElement.prototype.click
  URL.createObjectURL=blob=>{downloaded.blob=blob as Blob;return 'blob:writeback-test'}
  URL.revokeObjectURL=()=>{}
  dom.window.HTMLAnchorElement.prototype.click=function(){downloaded.name=this.download}
  try{
    await act(async()=>root.render(createElement(App)))
    const oldId=collection().activeId
    assert.equal(fileMenu().querySelector('[aria-label="写回原工程文件"]'),null)
    await openMenu();await click(button('打开可写工程'))
    selected=[source.handle,fileHandle('重复选择.fuxian',new Uint8Array()).handle]
    await click(inDialog('选择 .fuxian 文件'))
    assert.match(doc.querySelector('.writeback-error')!.textContent!,/明确选择一个/)
    assert.equal(collection().activeId,oldId)
    assert.equal(source.permissions,0)
    selected=[source.handle]
    await click(inDialog('选择 .fuxian 文件'))
    assert.notEqual(collection().activeId,oldId)
    assert.equal(collection().entries.length,2)
    assert.equal(source.writes,0)
    assert.equal(source.permissions,0)
    const nameField=doc.querySelector<HTMLInputElement>('[aria-label="项目名称"]')!
    await act(async()=>{
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(nameField,'修改后的电路')
      nameField.dispatchEvent(new dom.window.Event('input',{bubbles:true}))
    })
    await openMenu();await click(button('写回原工程文件'))
    assert.equal(inDialog('确认写回原文件').disabled,true)
    await click(inDialog('下载原文件备份'))
    assert.match(downloaded.name!,/写回前/)
    assert.deepEqual(new Uint8Array(await downloaded.blob!.arrayBuffer()),originalBytes)
    selected=[source.handle]
    await click(inDialog('选择下载的备份'))
    assert.match(doc.querySelector('.writeback-error')!.textContent!,/独立备份/)
    assert.equal(inDialog('确认写回原文件').disabled,true)
    const backup=fileHandle(downloaded.name!,new Uint8Array(await downloaded.blob!.arrayBuffer()))
    selected=[backup.handle]
    await click(inDialog('选择下载的备份'))
    assert.equal(inDialog('确认写回原文件').disabled,false)
    await click(inDialog('确认写回原文件'))
    assert.equal(source.permissions,1)
    assert.equal(source.writes,1)
    assert.equal((await readProjectFile(await source.handle.getFile())).project.title,'修改后的电路')
    assert.deepEqual(backup.bytes,originalBytes)
    assert.equal(inDialog('确认写回原文件').disabled,true)
    await click(inDialog('关闭'))
    const oldProject=[...doc.querySelectorAll<HTMLButtonElement>('.project-sidebar-entry')].find(node=>node.textContent?.includes(seed.title))!
    await click(oldProject)
    assert.equal(new URL(dom.window.location.href).searchParams.get('project'),oldId)
    assert.equal(fileMenu().querySelector('[aria-label="写回原工程文件"]'),null,'switching cannot carry the file handle to another project')
  }finally {
    await act(async()=>root.unmount());dom.window.close()
    URL.createObjectURL=priorCreate;URL.revokeObjectURL=priorRevoke;dom.window.HTMLAnchorElement.prototype.click=nativeClick
    for(const [key,descriptor] of original){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
  }
})
