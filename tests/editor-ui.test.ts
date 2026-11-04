import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act,createElement } from 'react'
import { blankProject } from '../src/core/editor'
import { generateNetlist, validateProject, type Project } from '../src/core/circuit'
import { simulate } from './simulate'
import { codexStatusFixture } from './codex-status-fixture'
import { readProjectFile } from '../src/core/project-file'

test('DOM workflow: place, rotate, connect, probe, solve, move, undo, edit and export', {timeout:60000},async()=>{
  // This is a DOM unit environment, not a real browser or a screenshot test.
  // Only the SVG coordinate transform and Web Worker transport are adapters;
  // event handlers, project state, persistence and ngspice calculations are real.
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost:3030/'})
  const globals={window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,localStorage:dom.window.localStorage}
  const prior=new Map<string,PropertyDescriptor|undefined>()
  function install(key:string,value:unknown){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})}
  for(const[key,value]of Object.entries(globals))install(key,value)
  install('IS_REACT_ACT_ENVIRONMENT',true)
  install('DOMPoint',class {constructor(public x:number,public y:number){}matrixTransform(){return{x:this.x,y:this.y}}})
  Object.assign(dom.window.SVGElement.prototype,{getScreenCTM:()=>({inverse:()=>({a:1,d:1})}),setPointerCapture:()=>{},releasePointerCapture:()=>{},hasPointerCapture:()=>false})
  const pending:Promise<void>[]=[]
  class SimulationTransport {
    onmessage:((message:{data:unknown})=>void)|null=null
    onerror:((error:{message:string})=>void)|null=null
    terminated=false
    postMessage(p:Project){pending.push(simulate(p).then(result=>{if(!this.terminated)this.onmessage?.({data:{type:'result',result}})},error=>{if(!this.terminated)this.onerror?.({message:String(error)})}))}
    terminate(){this.terminated=true}
  }
  install('Worker',SimulationTransport)
  install('fetch',async(path:string)=>{
    if(path==='/api/model-library/browse')return Response.json({groups:[],counts:[],libraries:[],total:0,offset:0,limit:40})
    assert.equal(path,'/api/codex/status');return Response.json(codexStatusFixture)
  })
  const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL
  let exported:Blob|null=null,filename=''
  URL.createObjectURL=(blob)=>{exported=blob as Blob;return'blob:test'}
  URL.revokeObjectURL=()=>{}
  dom.window.HTMLAnchorElement.prototype.click=function(){filename=this.download}
  const {createRoot}=await import('react-dom/client')
  const {default:EditorWorkbench}=await import('../src/EditorWorkbench')
  const root=createRoot(dom.window.document.getElementById('root')!)
  const doc=dom.window.document
  const query=(selector:string)=>{const found=doc.querySelector(selector);assert.ok(found,`Missing element ${selector}`);return found}
  const displayedResult=()=>query('[data-page-waveform]:not([hidden])')
  const assertResultState=(state:'complete'|'stale')=>{
    assert.equal(displayedResult().getAttribute('data-result-state'),state)
    assert.equal(query('.workspace-run-status').getAttribute('data-state'),state,'page and workspace report the same result validity')
    if(state==='stale'){
      assert.match(displayedResult().querySelector('[role="status"]')!.textContent!,/结果已过期/)
      assert.match(query('.workspace-run-status').getAttribute('title')!,/保留上次运行数据.*重新仿真/)
    }
  }
  const assertDcOutput=(expected:number)=>{
    const row=[...displayedResult().querySelectorAll('.page-op-results tr')].find(row=>row.querySelector('td')?.textContent==='v(vout)')
    assert.ok(row,'actual output node is present in the operating-point table')
    const reading=row.querySelectorAll('td')[1].textContent!
    assert.match(reading,/ V$/)
    assert.ok(Math.abs(Number.parseFloat(reading)-expected)<1e-5,`${reading} must match the actual circuit output ${expected} V`)
  }
  const button=(label:string)=>query(`button[aria-label="${label}"]`)
  const byText=(text:string)=>{const found=[...doc.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);assert.ok(found,`Missing button ${text}`);return found}
  const click=async(el:Element)=>{await act(async()=>{el.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,button:0}))})}
  const pointer=async(el:Element,type:string,x=0,y=0,modifiers:MouseEventInit={})=>{await act(async()=>{el.dispatchEvent(new dom.window.MouseEvent(type,{bubbles:true,clientX:x,clientY:y,button:0,...modifiers}))})}
  const saved=()=>JSON.parse(dom.window.localStorage.getItem('fuxian-free-editor-v2')!) as Project
  const field=(label:string)=>[...doc.querySelectorAll('label.field')].find(e=>e.querySelector('span')?.textContent===label)
  const editField=async(label:string,value:string)=>{
    const input=field(label)?.querySelector('input');assert.ok(input,`Missing field ${label}`)
    await act(async()=>{
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,value)
      input.dispatchEvent(new dom.window.Event('input',{bubbles:true}))
    })
  }
  const pin=(id:string,n:number)=>query(`.editor-pin[aria-label^="${id} 引脚 ${n}"]`)
  const canvas=()=>query('.editor-canvas')
  const key=async(key:string,modifiers:KeyboardEventInit={})=>{await act(async()=>{canvas().dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...modifiers}))})}
  const place=async(label:string,x:number,y:number)=>{await click(button(`放置${label}`));await pointer(canvas(),'pointerdown',x,y)}
  const wire=async(a:string,ap:number,b:string,bp:number)=>{await pointer(pin(a,ap),'pointerdown');await pointer(pin(b,bp),'pointerdown')}
  try {
    await act(async()=>{root.render(createElement(EditorWorkbench,{seed:blankProject(),onBack:()=>{}}))})
    assert.equal(saved().drawing!.devices.length,0)
    await place('直流电压源',200,320);await place('电阻',460,200);await place('电阻',820,320)
    await click(button('旋转选中器件'))
    assert.equal(saved().drawing!.devices.find(d=>d.id==='R2')!.rotation,90)
    assert.ok(field('元件数值'))
    assert.equal(field('参考电压源'),undefined)
    assert.equal(doc.querySelector('.source-properties'),null)
    assert.equal(doc.querySelector('.editor-analysis-select'),null)
    await place('接地',200,440);await place('接地',820,440)
    await wire('V1',1,'R1',1);await wire('R1',2,'R2',1);await wire('V1',2,'G1',1);await wire('R2',2,'G2',1)
    await click(button('测量探针 (P)'));await pointer(pin('R2',1),'pointerdown')
    const beforePanelSwitch=saved()
    await click(button('打开仿真设置'))
    assert.deepEqual(saved(),beforePanelSwitch)
    const simulationDialog=query('[role="dialog"][aria-label="仿真设置"]')
    assert.ok(simulationDialog.contains(field('起始频率')!))
    assert.equal(query('.editor-inspector').contains(simulationDialog),false)
    assert.ok(query('.free-app').closest('[inert]'),'modal locks the workbench, including inherited inert state')
    assert.equal(simulationDialog.closest('[inert]'),null,'settings remain interactive')
    await click(byText('瞬态分析'))
    assert.ok(simulationDialog.contains(field('仿真时长')!))
    assert.equal(simulationDialog.querySelector('.source-properties'),null)
    assert.deepEqual(saved(),beforePanelSwitch,'changing analysis is a draft until applied')
    await click(byText('取消'))
    assert.deepEqual(saved(),beforePanelSwitch)
    assert.equal(doc.querySelector('[aria-label="仿真设置"]'),null)
    await click(button('打开仿真设置'));await click(byText('瞬态分析'));await click(byText('应用设置'))
    assert.equal(saved().analysis,'tran')
    await click(button('选择 / 移动 (V)'))
    await pointer(query('.editor-device[aria-label^="V1 "]'),'pointerdown',200,320);await pointer(canvas(),'pointerup',200,320)
    const waveform=query('[aria-label="V1 瞬态波形"]')
    await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value')!.set!.call(waveform,'sine');waveform.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})
    assert.equal(field('仿真时长'),undefined)
    const sourceInput=async(label:string,value:string)=>{const input=query(`[aria-label="${label}"]`);await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})}
    await sourceInput('V1 频率 (Hz)','2kHz')
    assert.equal(saved().drawing!.devices.find(d=>d.id==='V1')!.params!.frequency,'2kHz')
    const inspector=query('.editor-inspector-scroll')
    inspector.scrollTop=250
    await click(button('打开仿真设置'))
    assert.equal(inspector.scrollTop,250,'opening a separate settings window preserves property-panel position')
    await click(byText('DC 扫描'))
    assert.ok(field('扫描起点'));assert.ok(field('扫描终点'))
    assert.equal(query('[role="dialog"][aria-label="仿真设置"]').contains(query('[aria-label="V1 频率 (Hz)"]')),false)
    await click(byText('直流工作点'))
    assert.equal(saved().analysis,'tran')
    await click(byText('应用设置'))
    assert.equal(saved().analysis,'op')
    assert.equal(query('.free-app').closest('[inert]'),null)
    assert.deepEqual(validateProject(saved()),[])
    await click(byText('运行仿真'));await act(async()=>{await Promise.all(pending)})
    assertDcOutput(2.5)
    assertResultState('complete')
    const oldResultId=displayedResult().getAttribute('data-result-id')
    const oldNetlist=generateNetlist(saved())
    await pointer(query('.editor-device[aria-label^="R1 "]'),'pointerdown',460,200)
    await pointer(canvas(),'pointermove',500,240);await pointer(canvas(),'pointerup',500,240)
    assert.ok(field('元件数值'))
    assert.equal(field('参考电压源'),undefined)
    assert.equal(doc.querySelector('.editor-analysis-select'),null)
    assert.equal(saved().drawing!.devices.find(d=>d.id==='R1')!.x,500)
    assert.equal(generateNetlist(saved()),oldNetlist)
    assertResultState('complete');assert.equal(displayedResult().getAttribute('data-result-id'),oldResultId,'moving geometry retains the valid result')
    await click(button('删除选中项'))
    assert.ok(!saved().drawing!.devices.some(d=>d.id==='R1'))
    await click(button('撤销'))
    assert.equal(generateNetlist(saved()),oldNetlist)
    assertResultState('complete');assert.equal(displayedResult().getAttribute('data-result-id'),oldResultId,'undo restores result validity without a new solve')
    await pointer(query('.editor-device[aria-label^="R2 "]'),'pointerdown',820,320);await pointer(canvas(),'pointerup',820,320)
    await editField('元件数值','2k')
    assert.equal(saved().drawing!.devices.find(d=>d.id==='R2')!.value,'2k')
    assertResultState('stale');assert.equal(displayedResult().getAttribute('data-result-id'),oldResultId,'parameter edits retain the prior data while marking it stale')
    await click(byText('运行仿真'));await act(async()=>{await Promise.all(pending)})
    assertDcOutput(10/3)
    assertResultState('complete');assert.notEqual(displayedResult().getAttribute('data-result-id'),oldResultId,'rerunning replaces the stale result')
    await pointer(query('.editor-device[aria-label^="V1 "]'),'pointerdown',200,320);await pointer(canvas(),'pointerup',200,320)
    assert.ok(doc.querySelector('.source-parameters'))
    await sourceInput('V1 直流工作点','6V')
    assert.equal(saved().drawing!.devices.find(d=>d.id==='V1')!.value,'6V')
    await click(byText('运行仿真'));await act(async()=>{await Promise.all(pending)})
    assertDcOutput(4)
    await pointer(query('.editor-device[aria-label^="R2 "]'),'pointerdown',820,320);await pointer(canvas(),'pointerup',820,320)
    await click(byText('保存工程文件'))
    assert.match(filename,/\.fuxian$/)
    assert.ok(exported)
    const archive=exported as Blob
    const {project:exportedProject}=await readProjectFile({name:filename,size:archive.size,arrayBuffer:()=>archive.arrayBuffer(),text:()=>archive.text()})
    assert.deepEqual(exportedProject,saved())
    const oldRotation=saved().drawing!.devices.find(d=>d.id==='R2')!.rotation
    await act(async()=>{canvas().dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'r',bubbles:true}))})
    assert.equal(saved().drawing!.devices.find(d=>d.id==='R2')!.rotation,(oldRotation+90)%360)
    await act(async()=>{canvas().dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Delete',bubbles:true}))})
    assert.ok(!saved().drawing!.devices.some(d=>d.id==='R2'))
    await act(async()=>{canvas().dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))})
    assert.ok(saved().drawing!.devices.some(d=>d.id==='R2'))
    // Restore the vertical shunt before the group move: after rotation its routed
    // signal and ground spans can physically overlap, which now joins them.
    await key('z',{ctrlKey:true})
    assert.equal(saved().drawing!.devices.find(d=>d.id==='R2')!.rotation,oldRotation)
    // Shift selection and a group drag preserve electrical connectivity and undo together.
    const beforeGroup=saved()
    await pointer(query('.editor-device[aria-label^="R1 "]'),'pointerdown',500,240);await pointer(canvas(),'pointerup',500,240)
    await pointer(query('.editor-device[aria-label^="R2 "]'),'pointerdown',820,320,{shiftKey:true});await pointer(canvas(),'pointerup',820,320)
    assert.equal(doc.querySelectorAll('.editor-device.selected').length,2)
    await pointer(query('.editor-device[aria-label^="R1 "]'),'pointerdown',500,240)
    await pointer(canvas(),'pointermove',540,260);await pointer(canvas(),'pointerup',540,260)
    assert.equal(saved().drawing!.devices.find(d=>d.id==='R1')!.x,540)
    assert.equal(saved().drawing!.devices.find(d=>d.id==='R2')!.x,860)
    assert.equal(generateNetlist(saved()),generateNetlist(beforeGroup))
    await key('z',{ctrlKey:true});assert.deepEqual(saved(),beforeGroup)
    // A marquee selects a whole circuit, which can be previewed, pasted and undone.
    await pointer(canvas(),'pointerdown',120,120);await pointer(canvas(),'pointermove',900,500);await pointer(canvas(),'pointerup',900,500)
    assert.equal(doc.querySelectorAll('.editor-device.selected').length,5)
    await key('c',{ctrlKey:true});await key('v',{ctrlKey:true})
    assert.ok(doc.querySelector('.paste-preview'));assert.deepEqual(saved(),beforeGroup)
    await key('Escape');assert.equal(doc.querySelector('.paste-preview'),null);assert.deepEqual(saved(),beforeGroup)
    // Transform/cancel a preview must never transform or delete the source selection.
    await pointer(query('.editor-device[aria-label^="R1 "]'),'pointerdown',500,240);await pointer(canvas(),'pointerup',500,240)
    await key('c',{ctrlKey:true});await key('v',{ctrlKey:true});await key('r');await key('e',{ctrlKey:true})
    assert.deepEqual(saved(),beforeGroup)
    await key('Delete');assert.deepEqual(saved(),beforeGroup);assert.equal(doc.querySelector('.paste-preview'),null)
    await key('a',{ctrlKey:true});await key('c',{ctrlKey:true})
    await key('v',{ctrlKey:true});await pointer(canvas(),'pointerdown',1300,340)
    assert.equal(saved().drawing!.devices.length,10);assert.equal(saved().drawing!.wires.length,8)
    assert.deepEqual(validateProject(saved()),[])
    await key('z',{ctrlKey:true});assert.deepEqual(saved(),beforeGroup)
    await key('a',{ctrlKey:true});await key('Delete')
    assert.equal(saved().drawing!.devices.length,0);assert.equal(saved().drawing!.wires.length,0)
    await key('z',{ctrlKey:true});assert.deepEqual(saved(),beforeGroup)
    // Layout is one undo transaction and cannot alter the generated circuit.
    await pointer(query('.editor-device[aria-label^="R1 "]'),'pointerdown',500,240);await pointer(canvas(),'pointerup',500,240)
    await pointer(query('.editor-device[aria-label^="R2 "]'),'pointerdown',820,320,{shiftKey:true});await pointer(canvas(),'pointerup',820,320)
    assert.equal(byText('水平等距').hasAttribute('disabled'),true)
    await click(byText('水平对齐'))
    assert.equal(saved().drawing!.devices.find(d=>d.id==='R2')!.y,240)
    assert.equal(generateNetlist(saved()),generateNetlist(beforeGroup))
    await key('z',{ctrlKey:true});assert.deepEqual(saved(),beforeGroup)
    await key('y',{ctrlKey:true});assert.equal(saved().drawing!.devices.find(d=>d.id==='R2')!.y,240)
    await key('z',{ctrlKey:true})
    // Inspecting a wire does not split it or change persisted data; Esc clears it.
    await click(button('网络高亮 (N)'))
    await pointer(query('[aria-label="导线 W2"]'),'pointerdown',700,240)
    assert.ok(doc.querySelector('.editor-wire.net-highlight'))
    assert.ok(doc.querySelector('.editor-pin.net-highlight'))
    assert.ok(doc.querySelector('[aria-label="高亮网络详情"]'))
    assert.deepEqual(saved(),beforeGroup)
    await key('Escape');assert.equal(doc.querySelector('.net-highlight'),null)
    // Refdes validates before commit and follows probe, wire and highlighted references.
    await pointer(query('.editor-device[aria-label^="R2 "]'),'pointerdown',820,320);await pointer(canvas(),'pointerup',820,320)
    await click(button('高亮 R2 引脚 1'))
    await editField('器件编号','R1')
    const submitRefdes=async()=>{await act(async()=>{query('.refdes-editor').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}))})}
    await submitRefdes();assert.ok(doc.querySelector('.refdes-error'));assert.deepEqual(saved(),beforeGroup)
    await editField('器件编号',' r20 ');await submitRefdes()
    assert.equal(doc.querySelector('.refdes-error'),null)
    assert.deepEqual(saved().drawing!.output,{device:'R20',pin:0})
    assert.ok(doc.querySelector('.editor-pin.net-highlight[aria-label^="R20 引脚 1"]'))
    assert.equal(saved().drawing!.wires.some(w=>['from','to'].some(end=>'device'in w[end as 'from'|'to']&&(w[end as 'from'|'to'] as {device:string}).device==='R2')),false)
    assert.deepEqual(validateProject(saved()),[])
    await pointer(query('.editor-device[aria-label^="V1 "]'),'pointerdown',200,320);await pointer(canvas(),'pointerup',200,320)
    await editField('器件编号','V10');await submitRefdes()
    assert.equal(saved().drawing!.sourceId,'V10');assert.ok(doc.querySelector('.source-parameters'))
    await click(byText('运行仿真'));await act(async()=>{await Promise.all(pending)})
    assertDcOutput(4)
    // Successful solves now enable DC overlays. Disable their view preferences
    // before verifying the ordinary schematic export and its unchanged circuit.
    const beforeExport=saved()
    for(const label of ['直流电压','直流电流']){
      const toggle=doc.querySelector<HTMLButtonElement>(`.bias-toolbar button[aria-label="${label}"]`)
      assert.ok(toggle,label);assert.equal(toggle.getAttribute('aria-pressed'),String(label==='直流电压'),'successful solves enable voltage and retain the current-display preference')
      if(toggle.getAttribute('aria-pressed')==='true')await click(toggle)
      assert.equal(toggle.getAttribute('aria-pressed'),'false')
    }
    assert.deepEqual(saved(),beforeExport,'overlay preferences do not edit the circuit')
    await click(button('导出原理图 SVG'))
    assert.equal(filename,'fuxian-schematic.svg')
    assert.equal((exported as unknown as Blob).type,'image/svg+xml')
    const svgText=await (exported as unknown as Blob).text()
    const svgDoc=new dom.window.DOMParser().parseFromString(svgText,'image/svg+xml')
    assert.equal(svgDoc.querySelector('parsererror'),null)
    assert.match(svgDoc.documentElement.textContent!,/V10/);assert.match(svgDoc.documentElement.textContent!,/R20/)
    assert.doesNotMatch(svgText,/selection-bounds|net-highlight|paste-preview/)
    await key('z',{ctrlKey:true});await key('z',{ctrlKey:true});assert.deepEqual(saved(),beforeGroup)
    // Unfinished wire gestures stay out of persistence and undo history.
    await click(button('空白画布'));await place('电阻',240,200);await place('电阻',720,400)
    const beforeWire=saved()
    await pointer(pin('R1',2),'pointerdown')
    await pointer(canvas(),'pointermove',400,280);await pointer(canvas(),'pointerdown',400,280)
    assert.ok(doc.querySelector('.staged-wire'));assert.deepEqual(saved(),beforeWire)
    await key('Backspace');assert.equal(doc.querySelector('.staged-wire'),null);assert.deepEqual(saved(),beforeWire)
    await pointer(canvas(),'pointerdown',400,280);await key('Escape')
    assert.equal(doc.querySelector('.staged-wire'),null);assert.deepEqual(saved(),beforeWire)
    await pointer(pin('R1',2),'pointerdown');await pointer(canvas(),'pointermove',400,280)
    await key(' ')
    assert.match(query('.pending-wire').getAttribute('d')!,/V 280 H 400/)
    await pointer(canvas(),'pointerdown',400,280);await pointer(pin('R2',1),'pointerdown')
    assert.equal(saved().drawing!.wires.length,2);assert.equal(saved().drawing!.junctions.length,1)
    assert.equal(saved().drawing!.wires[0].bend,'vh')
    await key('z',{ctrlKey:true});assert.deepEqual(saved(),beforeWire)
    await key('y',{ctrlKey:true})
    const routed=saved(),junction=routed.drawing!.junctions[0]
    await pointer(query(`[aria-label="连接点 ${junction.id}"]`),'pointerdown',junction.x,junction.y)
    await pointer(canvas(),'pointermove',junction.x+40,junction.y+20);await pointer(canvas(),'pointerup',junction.x+40,junction.y+20)
    assert.equal(saved().drawing!.junctions[0].x,junction.x+40)
    assert.deepEqual(saved().drawing!.wires,routed.drawing!.wires)
    await key('z',{ctrlKey:true});assert.deepEqual(saved(),routed)
    await click(button('导线 (W)'))
    await pointer(query('[aria-label="导线 W1"]'),'pointerdown',280,240)
    assert.ok(doc.querySelector('.staged-wire'));assert.deepEqual(saved(),routed)
    await key('Escape');assert.deepEqual(saved(),routed)
    assert.equal(doc.querySelector('.staged-wire'),null)
    // Continuous measurements use existing results and never move the reference output.
    await click(byText('示例电路'));await click(query('[data-example-id="rc-lowpass"]'));await click(byText('使用示例'))
    await click(byText('运行仿真'));await act(async()=>{await Promise.all(pending)})
    const beforeProbes=saved(),runsBeforeProbes=pending.length
    const assertSavedProbeSelection=(count:number)=>{
      const current=saved(),{probes,waveformSetup,...electrical}=current
      const {probes:_oldProbes,waveformSetup:_oldWaveforms,...beforeElectrical}=beforeProbes
      assert.deepEqual(electrical,beforeElectrical,'placing measurements must not edit the electrical circuit or reference output')
      assert.equal(probes?.length,count,'measurement targets are persisted with the project')
      assert.ok(waveformSetup,'manual probe selection saves the target plot configuration')
      const selectedSignals=waveformSetup.diagrams.flatMap(diagram=>diagram.view?.panels.flatMap(panel=>panel.ids)??[])
      for(const probe of probes!)assert.ok(selectedSignals.includes(`probe:${probe.id}`),`saved plots include explicitly selected ${probe.id}`)
      assert.equal(pending.length,runsBeforeProbes,'measurement placement reuses solver results')
    }
    await click(button('测量探针 (P)'));await pointer(pin('V1',1),'pointerdown');await pointer(pin('C1',1),'pointerdown')
    assert.equal(doc.querySelectorAll('.probe-record-option').length,2)
    assert.equal(doc.querySelectorAll('.measurement-marker[data-probe-type="voltage"]').length,2)
    assertSavedProbeSelection(2)
    assert.match(query('.wave-trace-list').textContent!,/V\(vin\)/);assert.match(query('.wave-trace-list').textContent!,/V\(vout\)/)
    const selectProbe=async(value:string)=>{await click(query(`button[data-probe-mode="${value}"]`))}
    await selectProbe('differential');await pointer(pin('V1',1),'pointerdown');await pointer(pin('V1',1),'pointerup')
    assert.ok(doc.querySelector('.probe-pending-endpoint'))
    await pointer(pin('C1',1),'pointerdown');await pointer(pin('C1',1),'pointerup')
    assert.equal(doc.querySelector('.probe-pending-endpoint'),null)
    assert.equal(doc.querySelectorAll('.measurement-marker[data-probe-type="differential"]').length,2)
    assert.equal(doc.querySelectorAll('.measurement-marker-negative').length,1)
    assert.equal(doc.querySelectorAll('.probe-record-option').length,3)
    assert.match(query('.wave-trace-list').textContent!,/V\(vin, vout\)/)
    assertSavedProbeSelection(3)
    await selectProbe('current');await pointer(query('.editor-device[aria-label^="V1 "]'),'pointerdown')
    assert.match(query('.wave-trace-list').textContent!,/I\(V1\)/)
    assert.equal(doc.querySelectorAll('.probe-record-option').length,4)
    assert.equal(doc.querySelectorAll('.measurement-marker[data-probe-type="current"]').length,1)
    await pointer(query('[aria-label="导线 W2"]'),'pointerdown',650,200)
    assert.equal(doc.querySelectorAll('.probe-record-option').length,5)
    assert.equal(doc.querySelectorAll('.probe-tip-wire').length,1)
    assert.match(query('.wave-trace-list').textContent!,/I\(W2 →\)/)
    const currentTip=query('.probe-tip-wire')
    await act(async()=>{currentTip.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'f',bubbles:true,cancelable:true}))})
    assert.match(query('.wave-trace-list').textContent!,/I\(W2 ←\)/)
    assertSavedProbeSelection(5)
    assert.equal(pending.length,runsBeforeProbes,'wire measurements reuse solver results without starting a new run')
    await key('Escape')
    await pointer(query('.editor-device[aria-label^="R1 "]'),'pointerdown',460,200);await pointer(canvas(),'pointerup',460,200)
    await editField('元件数值','2k')
    assertResultState('stale');assert.match(query('.wave-trace-list').textContent!,/I\(V1\)/)
    await click(button('清空测量'))
    // A pending differential endpoint cannot leak through an inspector voltage probe.
    await selectProbe('differential');await pointer(pin('V1',1),'pointerdown')
    await click(button('探测 R1 引脚 2'));await pointer(pin('V1',2),'pointerdown')
    assert.equal(doc.querySelectorAll('.probe-record-option').length,2)
    assert.match(query('.probe-record-select').textContent!,/V1:1/)
    // Presets place the selected electrical model, not the generic symbol's default.
    const chooseExtended=async(label:string,category='全部')=>{
      await click(query('.library-extension-toggle'))
      const dialog=query('[role="dialog"][aria-label="拓展器件"]')
      await click([...dialog.querySelectorAll('button')].find(item=>item.firstChild?.textContent?.trim()==='通用器件')!)
      const categoryButton=[...dialog.querySelectorAll('nav button')].find(item=>item.firstChild?.textContent===category)
      assert.ok(categoryButton,`Missing extension category ${category}`)
      await click(categoryButton)
      const before=saved()
      const placement=dialog.querySelector(`button[aria-label="放置${label}"]`)
      assert.ok(placement,`extension dialog offers ${label}`)
      await click(placement)
      assert.ok(!doc.querySelector('[role="dialog"][aria-label="拓展器件"]'),'choosing closes the popup before canvas placement')
      assert.deepEqual(saved(),before,'choosing a component alone does not edit the drawing')
    }
    await click(button('空白画布'));await chooseExtended('LED 发光二极管','光电')
    await pointer(canvas(),'pointerdown',300,220)
    assert.equal(saved().drawing!.devices[0].value,'D_LED_RED')
    assert.equal(saved().drawing!.devices[0].kind,'D')
    await click(button('放置直流电压源'));await pointer(canvas(),'pointerdown',500,220)
    assert.equal(saved().source.dc,'5V');assert.equal(saved().drawing!.sourceId,'V1')
    // Extension presets enter canvas placement after their modal closes.
    await chooseExtended('脉冲电压源','电源');await pointer(canvas(),'pointerdown',700,220)
    assert.equal(saved().drawing!.devices.find(d=>d.id==='V2')!.params!.waveform,'pulse')
    await chooseExtended('PWL 电流源');await pointer(canvas(),'pointerdown',700,440)
    assert.equal(saved().drawing!.devices.find(d=>d.id==='I1')!.params!.waveform,'pwl')
    assert.match(saved().drawing!.devices.find(d=>d.id==='I1')!.params!.points,/mA/)
    // Basic HTML drag/drop still carries the allowlisted preset and overrides a pending source.
    await chooseExtended('正弦电压源')
    const transfer=new Map<string,string>()
    const dataTransfer={get types(){return [...transfer.keys()]},setData:(k:string,v:string)=>transfer.set(k,v),getData:(k:string)=>transfer.get(k)??'',effectAllowed:''}
    const drag=async(el:Element,type:string)=>{const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,clientX:700,clientY:440});Object.defineProperty(event,'dataTransfer',{value:dataTransfer});await act(async()=>{el.dispatchEvent(event)})}
    await drag(button('放置直流电压源'),'dragstart')
    assert.equal(transfer.get('application/x-fuxian-library-part'),'base-V')
    assert.equal(transfer.get('application/x-fuxian-device'),'V')
    assert.equal(dataTransfer.effectAllowed,'copy')
    await drag(canvas(),'drop')
    assert.equal(saved().drawing!.devices.find(d=>d.id==='V3')!.params!.waveform,'dc','basic drag must not inherit pending sine parameters')
    // The canvas still accepts known extension ids from external palette integrations.
    transfer.clear();transfer.set('application/x-fuxian-device','I');transfer.set('application/x-fuxian-value','0mA');transfer.set('application/x-fuxian-library-part','source-I-pwl')
    await drag(canvas(),'drop')
    assert.equal(saved().drawing!.devices.find(d=>d.id==='I2')!.params!.waveform,'pwl')
    assert.match(saved().drawing!.devices.find(d=>d.id==='I2')!.params!.points,/mA/)
    await chooseExtended('正弦电压源')
    transfer.clear();transfer.set('application/x-fuxian-device','R');await drag(canvas(),'drop')
    assert.equal(saved().drawing!.devices.find(d=>d.id==='R1')!.params,undefined,'unrelated drag cannot inherit pending source parameters')
    const beforeBadDrop=structuredClone(saved())
    transfer.set('application/x-fuxian-library-part','source-V-sine');await drag(canvas(),'drop')
    assert.deepEqual(saved(),beforeBadDrop,'mismatched preset id is rejected without circuit mutation')
    transfer.set('application/x-fuxian-library-part','untrusted-preset-id');await drag(canvas(),'drop')
    assert.deepEqual(saved(),beforeBadDrop,'unknown preset id is rejected without circuit mutation')
    // Opening Codex checks local readiness without transmitting the project.
    await click(button('打开 AI 助手'))
    assert.equal(doc.querySelector<HTMLSelectElement>('[aria-label="AI 运行方式"]')?.value,'codex');assert.equal(doc.querySelector('[aria-label="AI API 密钥"]'),null)
    await click(button('关闭 AI 助手侧栏'));assert.equal(doc.querySelector('.assistant-sidebar'),null)
  } finally {
    await act(async()=>{root.unmount()})
    URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke
    dom.window.close()
    for(const[key,descriptor]of prior){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
  }
})
