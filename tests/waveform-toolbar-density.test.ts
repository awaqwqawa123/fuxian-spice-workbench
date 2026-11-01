import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import WaveformWorkspace, { type WaveformExportApi } from '../src/components/WaveformWorkspace'
import { editableProject } from '../src/core/editor'
import { processResult } from '../src/core/results'
import { defaultWaveformPanels, waveformSignals } from '../src/core/waveform-workspace'
import type { WaveformViewState } from '../src/core/canvas-waveform-store'

test('compact header keeps secondary tools accessible and preserves multi-view, trace, cursor and export flows', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' }), doc = dom.window.document
  const prior = new Map<string, PropertyDescriptor | undefined>(), resize = new Map<Element, (width:number,height:number)=>void>()
  class ResizeObserverStub {
    constructor(private callback:(entries:{contentRect:{width:number;height:number}}[])=>void) {}
    observe(target:Element) { resize.set(target,(width,height)=>this.callback([{contentRect:{width,height}}])) }
    disconnect() {}
  }
  for (const [key,value] of Object.entries({window:dom.window,document:doc,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,ResizeObserver:ResizeObserverStub,IS_REACT_ACT_ENVIRONMENT:true})) {
    prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  const project=editableProject();project.analysis='tran'
  const result=processResult({dataType:'real',numPoints:3,data:[{name:'time',values:[0,.001,.002]},{name:'v(vin)',values:[0,1,1]},{name:'v(vout)',values:[0,.4,.7]},{name:'i(V1)',values:[0,-.001,-.0003]}]},project,'* density fixture',0,'UI fixture','',[])
  const signals=waveformSignals(result).signals,panels=defaultWaveformPanels(result,signals)
  panels[0]={...panels[0],ids:[signals.find(signal=>signal.name==='v(vout)')!.id],primary:signals.find(signal=>signal.name==='v(vout)')!.id}
  let saved:WaveformViewState={analysis:'tran',layout:1,panels,domain:[0,1],cursors:{a:null,b:null}},api:WaveformExportApi|null=null
  const {createRoot}=await import('react-dom/client'),root=createRoot(doc.getElementById('root')!)
  const get=(label:string)=>{const element=doc.querySelector<HTMLElement>(`[aria-label="${label}"]`);assert.ok(element,label);return element}
  const click=async(label:string)=>act(async()=>get(label).click())
  const change=async(label:string,value:string)=>act(async()=>{const element=get(label) as HTMLSelectElement;element.value=value;element.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})
  try {
    await act(async()=>root.render(createElement(WaveformWorkspace,{embedded:true,result,comparison:null,initialView:saved,onViewChange:next=>{saved=next},onExportReady:next=>{api=next}})))
    const region=doc.querySelector<HTMLElement>('.wave-workspace-embedded')!,header=doc.querySelector('.wave-embedded-header')!,tools=header.querySelector<HTMLDetailsElement>('.wave-toolbar-tools')!
    assert.equal(region.querySelector(':scope > .wave-embedded-toolbar'),null,'the old separate toolbar row is absent')
    assert.equal(header.querySelectorAll(':scope > [role=tablist] > [role=tab]').length,3)
    assert.equal((get('当前波形视图') as HTMLSelectElement).hidden,true,'single plots do not spend header width on a redundant picker')
    for (const width of [980,520,360,260,220,200]) {
      await act(async()=>resize.get(region)!(width,260))
      assert.equal(region.dataset.embeddedSize,`${width}x260`)
      assert.equal(header.querySelector('.wave-embedded-quick-zoom')!==null,width>=500)
      assert.equal(tools.contains(get('局部放大')),width<320)
      assert.equal(tools.contains(get('自动适配视图')),width<260)
      assert.ok(tools.contains(get('数学'))&&tools.contains(get('坐标'))&&tools.contains(get('信息')))
      assert.equal(doc.querySelectorAll('.wave-embedded-header').length,1)
    }
    await act(async()=>{tools.open=true})
    await click('坐标')
    assert.equal(tools.open,false,'choosing a detailed page dismisses the menu')
    assert.equal(get('坐标').getAttribute('aria-selected'),'true')
    assert.equal(tools.dataset.active,'true','the compact trigger identifies a selected secondary page')
    await click('绘图')
    await act(async()=>{tools.open=true;tools.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})
    assert.equal(tools.open,false)
    assert.equal(doc.activeElement,get('波形工具'),'Escape returns keyboard focus to the disclosure')
    await act(async()=>{tools.open=true;doc.body.dispatchEvent(new dom.window.MouseEvent('pointerdown',{bubbles:true}))})
    assert.equal(tools.open,false,'clicking outside dismisses the menu')
    await act(async()=>resize.get(region)!(980,700))
    await change('波形视图布局','4')
    assert.equal(saved.layout,4)
    assert.equal(doc.querySelectorAll('.wave-embedded-view').length,4)
    assert.equal((get('当前波形视图') as HTMLSelectElement).hidden,false)
    await click('视图 1 添加曲线')
    await change('视图 1 可添加曲线',signals.find(signal=>signal.name==='v(vin)')!.id)
    await click('视图 1 添加所选曲线')
    assert.equal(saved.panels[0].ids.length,2)
    await click('游标')
    assert.ok(doc.querySelector('.wave-embedded-cursors'),'the cursor entry still opens its controls')
    await click('绘图')
    assert.ok(api)
    const artifact=await (api as WaveformExportApi).exportCurrent('csv')
    assert.match(await artifact.blob.text(),/original_saved_samples/)
    assert.match(artifact.filename,/view1.csv$/)
    await act(async()=>root.render(createElement(WaveformWorkspace,{result,comparison:null})))
    const detailed=doc.querySelector('.wave-toolbar')!
    assert.equal(detailed.querySelectorAll('[aria-label="自动适配视图"]').length,1,'the detailed toolbar has one automatic-fit control')
    assert.ok(detailed.querySelector('.wave-toolbar-tools .wave-layout-buttons'),'detailed layout tools stay inside the disclosure')
  } finally {
    await act(async()=>root.unmount());dom.window.close()
    for(const [key,value] of prior)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)
  }
})
