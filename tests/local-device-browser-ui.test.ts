import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import { parseSpiceLibrary, type ImportedSpiceModel } from '../src/core/spice-models'
import { defaultModelSymbol } from '../src/core/model-symbol'
import { ltspiceSourceUrl } from '../src/core/model-source-policy'
import { pspiceSourceUrl } from '../src/core/installed-model-source'
import DeviceLibrary from '../src/components/DeviceLibrary'

test('extension picker browses the whole local library and hands the exact selected source and symbol to canvas placement',async()=>{
  const fixture=(label:string,url:string,current:string):ImportedSpiceModel=>{
    const model=parseSpiceLibrary(`.model VENDOR_D D(IS=${current} mfg=FixtureVendor)`,{label,url}).models[0]
    model.symbol=defaultModelSymbol('D','VENDOR_D')
    return model
  }
  const ltspice=fixture('本机 LTspice / standard.dio',ltspiceSourceUrl,'1n')
  const pspice=fixture('PSpice 本地库 / tools/pspice/library/diode.lib',pspiceSourceUrl,'2n')
  const savedModel=fixture('我的工程版本','https://example.com/project-model','3n')
  const originalSaved=structuredClone(savedModel),requests:Record<string,unknown>[]=[],detailRequests:Record<string,unknown>[]=[],received:ImportedSpiceModel[]=[]
  const ltKey='a'.repeat(64),pspiceKey='b'.repeat(64)
  const summary=(model:ImportedSpiceModel,key:string)=>({key,id:model.id,name:model.name,kind:model.kind,type:model.type,pins:model.pins,metadata:model.metadata,source:model.source,symbol:model.symbol,categoryLabel:'二极管',terminalDescription:'A / K',symbolDescription:'二极管标准符号'})
  const ltSummary=summary(ltspice,ltKey),pspiceSummary=summary(pspice,pspiceKey)
  let rejectPlacement=true
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:3032/'})
  const previous=new Map<string,PropertyDescriptor|undefined>()
  const fetch=async(url:unknown,options?:RequestInit)=>{
    if(String(url)==='/api/model-library/device'){
      assert.equal(options?.method,'POST')
      const body=JSON.parse(String(options?.body)) as Record<string,unknown>;detailRequests.push(body)
      assert.deepEqual(Object.keys(body),['key'])
      assert.ok(body.key===ltKey||body.key===pspiceKey)
      return Response.json({model:body.key===ltKey?ltspice:pspice})
    }
    if(String(url)!=='/api/model-library/browse')return Response.json({candidates:[]})
    assert.equal(options?.method,'POST')
    const body=JSON.parse(String(options?.body)) as Record<string,unknown>;requests.push(body)
    const models=body.source==='pspice'?[pspiceSummary]:[ltSummary,pspiceSummary]
    return Response.json({groups:[{id:'VENDOR_D',models}],total:16000,offset:body.offset,limit:body.limit,counts:[{id:'diodes',label:'二极管',count:6000}],libraries:[{id:'ltspice',count:5000},{id:'pspice',count:11000}]})
  }
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,fetch})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!)
  function Harness(){
    const [search,onSearch]=useState(''),[category,onCategory]=useState('全部'),searchInput=useRef<HTMLInputElement>(null)
    return createElement(DeviceLibrary,{search,onSearch,category,onCategory,searchInput,onPlace:()=>assert.fail('a local model must not become a generic preset'),projectModels:[savedModel],onImportAndPlaceLocalModel:async model=>{
      received.push(model)
      if(rejectPlacement)throw new Error('已有同名工程模型，请保留原模型后重试')
    }})
  }
  const doc=dom.window.document,dialog=()=>doc.querySelector<HTMLElement>('[role="dialog"][aria-label="拓展器件"]')
  const byLabel=(label:string)=>{const node=doc.querySelector<HTMLElement>(`[aria-label="${label}"]`);assert.ok(node,label);return node}
  const button=(label:string)=>{const node=[...doc.querySelectorAll('button')].find(node=>node.firstChild?.textContent?.trim()===label||node.textContent?.trim()===label||node.getAttribute('aria-label')===label);assert.ok(node,label);return node}
  const click=async(node:Element)=>act(async()=>{node.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}))})
  const settle=async()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,330))})
  const set=async(node:Element,value:string)=>{
    await act(async()=>{
      const prototype=node.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(node,value)
      node.dispatchEvent(new dom.window.Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}))
    })
    await settle()
  }
  try{
    await act(async()=>root.render(createElement(Harness)))
    await click(doc.querySelector('.library-extension-toggle')!);await settle()
    assert.ok(dialog())
    assert.equal(button('本地器件').getAttribute('aria-pressed'),'true','the screenshot entry opens the imported library by default')
    assert.ok(doc.activeElement===byLabel('搜索本地器件'),'opening the picker focuses local model search')
    assert.equal(requests[0].query,'');assert.equal(requests[0].offset,0)
    assert.equal(detailRequests.length,0,'opening and browsing never loads full electrical models')
    assert.equal('spice' in ltSummary,false,'the catalog carries display metadata, not complete SPICE code')
    assert.match(dialog()!.textContent??'',/16[ ,]?000/,'the whole catalog count replaces the 35 generic presets')
    const card=byLabel('本地器件 VENDOR_D')
    assert.ok(card.querySelector('svg[role="img"]'),'local devices show their electrical symbols')
    assert.equal(doc.querySelectorAll('[aria-label="本地器件 VENDOR_D"]').length,1,'versions belong to one exact-device card')
    const versions=byLabel('VENDOR_D 模型库') as HTMLSelectElement
    assert.equal(versions.options.length,2)
    assert.match(versions.options[0].textContent!, /standard\.dio.*优先版本/)
    assert.equal([...versions.options].filter(option=>option.textContent?.includes('优先版本')).length,1,'source alternatives must not all claim priority')
    assert.equal(card.querySelector('.local-device-source')?.textContent,`模型来源：${ltspice.source.label}`)
    const pspiceOption=[...versions.options].find(option=>option.textContent?.includes('PSpice'))!
    assert.ok(pspiceOption)
    await set(versions,pspiceOption.value)
    assert.match(pspiceOption.textContent!, /tools\/pspice\/library\/diode\.lib/)
    assert.equal(card.querySelector('.local-device-source')?.textContent,`模型来源：${pspice.source.label}`,'visible provenance follows the source selected for placement')
    assert.equal(detailRequests.length,0,'choosing a source version still browses its lightweight summary')
    await click(byLabel('放置本地器件 VENDOR_D'))
    assert.deepEqual(detailRequests[0],{key:pspiceKey},'only the selected source version is read on placement')
    assert.deepEqual(received[0],pspice,'selected source, SPICE parameters and symbol survive the picker handoff')
    assert.ok(dialog(),'failed placement does not discard the picker')
    assert.match(dialog()!.textContent??'',/已有同名工程模型/)
    assert.deepEqual(savedModel,originalSaved,'merely browsing or failed placement never replaces an existing project model')
    await set(byLabel('搜索本地器件'),'VENDOR_D')
    assert.equal(requests.at(-1)!.query,'VENDOR_D');assert.equal(requests.at(-1)!.offset,0)
    const category=[...doc.querySelectorAll('[aria-label="本地器件分类"] button')].find(node=>node.textContent?.startsWith('二极管'))!
    assert.ok(category);await click(category);await settle()
    assert.equal(requests.at(-1)!.category,'diodes');assert.equal(requests.at(-1)!.offset,0)
    await click(button('下一页'));await settle()
    assert.equal(requests.at(-1)!.offset,requests.at(-1)!.limit,'paging requests the next local page instead of slicing a fixed palette')
    await set(byLabel('器件来源'),'pspice')
    assert.equal(requests.at(-1)!.source,'pspice');assert.equal(requests.at(-1)!.offset,0,'changing source starts a fresh page')
    rejectPlacement=false
    await click(byLabel('放置本地器件 VENDOR_D'))
    assert.deepEqual(received.at(-1),pspice)
    assert.equal(dialog(),null,'successful import-and-placement returns to canvas')
    assert.deepEqual(savedModel,originalSaved)
  }finally{
    await act(async()=>root.unmount());dom.window.close()
    for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
  }
})
