import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import { editorTemplate } from '../src/core/editor'
import { libraryPartById, type LibraryPart } from '../src/core/library'
import { generateNetlist } from '../src/core/circuit'
import DeviceLibrary from '../src/components/DeviceLibrary'
import SourceParameters from '../src/components/SourceParameters'

test('library keeps basics in sidebar and extensions in a focus-trapped popup; source selection retains real netlist behavior',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:3034/'})
  const saved=new Map<string,PropertyDescriptor|undefined>()
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,fetch:async()=>Response.json({groups:[],total:0,offset:0,limit:48,counts:[],libraries:[],candidates:[]})})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!)
  let placed:LibraryPart|undefined,latest=editorTemplate('rc-lowpass');latest.analysis='tran'
  function Harness(){
    const [search,onSearch]=useState(''),[category,onCategory]=useState('全部'),[project,setProject]=useState(latest),searchInput=useRef<HTMLInputElement>(null)
    latest=project
    return createElement('div',{},createElement(DeviceLibrary,{search,onSearch,category,onCategory,searchInput,onPlace:part=>{placed=part;setProject(p=>({...p,drawing:{...p.drawing!,devices:p.drawing!.devices.map(d=>d.id==='V1'?{...d,value:part.value,params:structuredClone(part.params)}:d)}}))}}),createElement(SourceParameters,{device:project.drawing!.devices[0],project,onChange:next=>setProject(p=>({...p,drawing:{...p.drawing!,devices:p.drawing!.devices.map(d=>d.id===next.id?next:d)}}))}))
  }
  const doc=dom.window.document,byLabel=(label:string)=>{const el=doc.querySelector<HTMLElement>(`[aria-label="${label}"]`);assert.ok(el,label);return el}
  const click=async(el:Element)=>act(async()=>{el.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}))})
  const key=async(el:Element,value:string,shiftKey=false)=>act(async()=>{el.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:value,shiftKey,bubbles:true,cancelable:true}))})
  const set=async(el:Element,value:string)=>act(async()=>{const prototype=el.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(el,value);el.dispatchEvent(new dom.window.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}))})
  const dialog=()=>doc.querySelector<HTMLElement>('[role="dialog"][aria-label="拓展器件"]')
  const openGeneric=async(toggle:Element)=>{
    await click(toggle)
    await click([...dialog()!.querySelectorAll('button')].find(button=>button.firstChild?.textContent?.trim()==='通用器件')!)
  }
  try{
    await act(async()=>root.render(createElement(Harness)))
    const toggle=doc.querySelector<HTMLButtonElement>('.library-extension-toggle')!
    assert.equal(dialog(),null)
    assert.equal(toggle.getAttribute('aria-haspopup'),'dialog')
    assert.equal(doc.querySelector('.common-device-grid')!.querySelectorAll('button').length,18)
    assert.equal(doc.querySelector('.network-symbol-palette'),null,'ground and network tools now belong to the top toolbar')
    const payload=new Map<string,string>(),drag=new dom.window.Event('dragstart',{bubbles:true})
    Object.defineProperty(drag,'dataTransfer',{value:{setData:(type:string,value:string)=>payload.set(type,value)}})
    await act(async()=>{byLabel('放置直流电压源').dispatchEvent(drag)})
    const dragged=libraryPartById(payload.get('application/x-fuxian-library-part')!)
    assert.equal(dragged?.kind,'V');assert.equal(dragged?.params?.waveform,'dc')
    for(const [id,label,value]of [
      ['transistor-pnp','PNP 三极管','Q_PNP'],['base-M','N 沟道 MOSFET','M_NMOS'],
      ['mosfet-pmos','P 沟道 MOSFET','M_PMOS'],['diode-schottky','肖特基二极管','D_SCHOTTKY'],
      ['diode-zener','稳压二极管','D_ZENER'],['diode-led','LED 发光二极管','D_LED_RED'],
    ]){
      const button=byLabel(`放置${label}`)
      assert.equal(button.getAttribute('data-library-part'),id)
      await click(button)
      assert.strictEqual(placed,libraryPartById(id),'click preserves the registered preset and its model choices')
      const transfer=new Map<string,string>(),event=new dom.window.Event('dragstart',{bubbles:true})
      Object.defineProperty(event,'dataTransfer',{value:{setData:(type:string,text:string)=>transfer.set(type,text)}})
      await act(async()=>button.dispatchEvent(event))
      assert.equal(transfer.get('application/x-fuxian-value'),value)
      assert.strictEqual(libraryPartById(transfer.get('application/x-fuxian-library-part')!),placed,'drag and click resolve the same allowlisted preset')
    }
    assert.notEqual(byLabel('放置NPN 三极管').querySelector('svg')!.innerHTML,byLabel('放置PNP 三极管').querySelector('svg')!.innerHTML,'opposite transistor polarities retain distinct graphics')
    assert.notEqual(byLabel('放置N 沟道 MOSFET').querySelector('svg')!.innerHTML,byLabel('放置P 沟道 MOSFET').querySelector('svg')!.innerHTML)
    await click(byLabel('放置脉冲电压源'));assert.equal(placed?.params?.waveform,'pulse')
    await click(byLabel('放置正弦电压源'));assert.equal(placed?.params?.waveform,'sine')

    toggle.focus();await openGeneric(toggle)
    assert.ok(dialog());assert.ok(dialog()!.parentElement!.parentElement===doc.body,'popup is outside the clipped sidebar')
    assert.equal(doc.getElementById('root')!.hasAttribute('inert'),true)
    assert.ok(byLabel('搜索拓展器件'))
    const controls=dialog()!.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input'),first=controls[0],last=controls[controls.length-1]
    first.focus();await key(first,'Tab',true);assert.ok(doc.activeElement===last,'shift-tab wraps to last dialog control')
    await key(last,'Tab');assert.ok(doc.activeElement===first,'tab wraps to first dialog control')
    let leakedKeys=0;const receive=()=>{leakedKeys++};dom.window.addEventListener('keydown',receive)
    await key(dialog()!.querySelector('[aria-label="放置正弦电压源"]')!,'Delete');assert.equal(leakedKeys,0,'dialog does not trigger editor delete/placement shortcuts')
    await key(byLabel('搜索拓展器件'),'Escape');assert.equal(leakedKeys,0)
    dom.window.removeEventListener('keydown',receive)
    assert.equal(dialog(),null);assert.equal(doc.getElementById('root')!.hasAttribute('inert'),false);assert.ok(doc.activeElement===toggle,'close returns focus to library toggle')

    await openGeneric(toggle)
    await click(dialog()!.querySelector('[aria-label="放置正弦电压源"]')!);assert.equal(placed?.params?.waveform,'sine');assert.equal(dialog(),null,'choosing a part returns to canvas placement')
    assert.ok(doc.activeElement===toggle,'placement returns focus to library toggle')
    await set(byLabel('V1 频率 (Hz)'),'2kHz');assert.match(generateNetlist(latest),/SIN\(0 1 2000 0 0 0\)/)
    await set(byLabel('V1 瞬态波形'),'pwl')
    await set(byLabel('V1 PWL 时间与数值'),'0s 0V\n1ms 3V\n2ms 1V')
    assert.match(generateNetlist(latest),/PWL\(0 0 0.001 3 0.002 1\)/)

    assert.equal(doc.querySelector('[aria-label="搜索器件"]'),null,'model search is consolidated inside the extension dialog')
    const basicAfterSidebarSearch=doc.querySelector('.device-palette')!.querySelectorAll('button').length
    assert.equal(doc.querySelector('[aria-label="放置SPDT 继电器"]'),null)
    assert.match(toggle.textContent??'',/搜索.*型号库/)
    await openGeneric(toggle);await set(byLabel('搜索拓展器件'),'继电器');assert.ok(byLabel('放置SPDT 继电器'))
    await set(byLabel('搜索拓展器件'),'脉冲');assert.equal(dialog()!.querySelectorAll('.device-palette button').length,2)
    assert.equal(byLabel('放置脉冲电流源').getAttribute('draggable'),'false','modal tells users to select then place instead of dragging across a blocking backdrop')
    await click(byLabel('放置脉冲电流源'));assert.equal(placed?.kind,'I');assert.equal(placed?.params?.waveform,'pulse');assert.equal(dialog(),null)
    await openGeneric(toggle);assert.equal((byLabel('搜索拓展器件') as HTMLInputElement).value,'脉冲','reopening keeps search')
    await set(byLabel('搜索拓展器件'),'not-a-device');assert.match(dialog()!.textContent??'',/没有匹配的拓展器件/)
    await click(Array.from(dialog()!.querySelectorAll('button')).find(button=>button.textContent==='查看全部拓展器件')!)
    assert.equal((byLabel('搜索拓展器件') as HTMLInputElement).value,'')
    await click(Array.from(dialog()!.querySelectorAll('nav button')).find(button=>button.textContent?.startsWith('光电'))!)
    assert.ok(byLabel('放置LED 发光二极管'));assert.equal(dialog()!.querySelectorAll('.device-palette button').length,1)
    await click(byLabel('关闭拓展器件'));await openGeneric(toggle)
    assert.ok(byLabel('放置LED 发光二极管'),'reopening also keeps category')
    assert.equal(doc.querySelector('.device-palette')!.querySelectorAll('button').length,basicAfterSidebarSearch,'extension category and search never change the sidebar search')
    await act(async()=>{dialog()!.parentElement!.dispatchEvent(new dom.window.MouseEvent('mousedown',{bubbles:true}))})
    assert.equal(dialog(),null,'backdrop closes the library')
  }finally{
    await act(async()=>root.unmount());dom.window.close()
    for(const [key,value]of saved)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)
  }
})
