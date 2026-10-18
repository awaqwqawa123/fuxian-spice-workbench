import assert from 'node:assert/strict'
import test from 'node:test'
import { act,createElement } from 'react'
import { JSDOM } from 'jsdom'
import { projectKey } from '../src/core/circuit'
import { connect,terminal, type Drawing } from '../src/core/drawing'
import { blankProject, editableProject } from '../src/core/editor'
import { resolveBranchCurrent } from '../src/core/branch-currents'
import { createWireCurrentTarget,hasWireCurrentTarget,resolveWireCurrent,wireCurrentCut,wireCurrentUnavailableReason } from '../src/core/wire-currents'
import { nearestWireProbeTarget,projectOnWire,wireProbeAngle, type ProbeTarget,type WireAnchor } from '../src/core/probe-placement'
import { resolveMeasurement } from '../src/core/probes'
import { simulate } from './simulate'

const close=(a:number,b:number,tolerance=1e-9)=>assert.ok(Math.abs(a-b)<tolerance,`${a} ≠ ${b}`)
function parallelRc(){
  const p=blankProject();p.source={dc:'1V',offset:'1V',amplitude:'200mV',frequency:'1kHz',waveform:'sine'};p.tran={step:'2us',stop:'40us'};p.ac={points:10,start:'100Hz',stop:'10kHz'}
  let d=p.drawing!
  d.devices=[
    {id:'V1',kind:'V',value:'1V',x:160,y:300,rotation:90},
    {id:'R1',kind:'R',value:'1k',x:560,y:300,rotation:90},
    {id:'C1',kind:'C',value:'1uF',x:880,y:300,rotation:90},
    {id:'G1',kind:'GND',value:'',x:160,y:500,rotation:0},
    {id:'G2',kind:'GND',value:'',x:560,y:500,rotation:0},
    {id:'G3',kind:'GND',value:'',x:880,y:500,rotation:0},
  ];d.junctions=[{id:'J1',x:400,y:180}];d.sourceId='V1';d.output=terminal('R1')
  d=connect(d,terminal('V1'),{junction:'J1'},'vh')
  d=connect(d,{junction:'J1'},terminal('R1'))
  d=connect(d,{junction:'J1'},terminal('C1'))
  for(const [device,ground] of [['V1','G1'],['R1','G2'],['C1','G3']])d=connect(d,terminal(device,1),terminal(ground))
  p.drawing=d;return p
}
test('real ngspice: a current clamp on either RC series wire reads its branch with an explicit reversible direction',async()=>{
  for(const analysis of ['tran','ac'] as const){
    const project=editableProject();project.analysis=analysis;project.tran={step:'2us',stop:'40us'};project.ac={points:10,start:'100Hz',stop:'10kHz'}
    const key=projectKey(project),result=await simulate(project),drawing=project.drawing!
    const resistor=resolveBranchCurrent(result,'R1')!
    for(const wireId of ['W1','W2']){
      const wire=createWireCurrentTarget(drawing,{wireId,fraction:.37})
      const trace=resolveMeasurement(result,{id:'P1',kind:'current',wire})!,reverse=resolveWireCurrent(result,{...wire,direction:-1})!
      assert.ok(trace);assert.equal(trace.name,`I(${wireId} →)`)
      for(let i=0;i<result.points;i++){close(trace.values[i],resistor.values[i]);close(reverse.values[i],-trace.values[i]);if(analysis==='ac'){const expected=resistor.complex![i];close(trace.magnitude![i],20*Math.log10(Math.hypot(expected.real,expected.img)),1e-8);close(reverse.complex![i].img,-expected.img)}}
    }
    assert.equal(projectKey(project),key)
  }
})
test('real ngspice: forked wires measure different branches, feeder uses KCL, AC sums phasors before magnitude',async()=>{
  for(const analysis of ['tran','ac'] as const){
    const project=parallelRc();project.analysis=analysis
    const result=await simulate(project),drawing=project.drawing!,key=projectKey(project)
    const targets=['W1','W2','W3'].map(wireId=>createWireCurrentTarget(drawing,{wireId,fraction:.5}))
    // Force the feeder to use the two load currents instead of the source vector.
    const withoutSource={...result,currents:{...result.currents,'i(v1)':undefined},complexCurrents:{...result.complexCurrents,'i(v1)':undefined}} as unknown as typeof result
    const [feeder,resistor,capacitor]=targets.map(target=>resolveWireCurrent(withoutSource,target)!)
    assert.ok(feeder&&resistor&&capacitor)
    for(let i=0;i<result.points;i++){
      close(feeder.values[i],resistor.values[i]+capacitor.values[i]);close(feeder.values[i],-result.currents!['i(v1)'][i],1e-8)
      if(analysis==='ac'){
        close(feeder.complex![i].real,resistor.complex![i].real+capacitor.complex![i].real)
        close(feeder.complex![i].img,resistor.complex![i].img+capacitor.complex![i].img)
        close(feeder.complex![i].img,-result.complexCurrents!['i(v1)'][i].img)
      }
    }
    assert.ok(resistor.values.some((value,i)=>Math.abs(value-capacitor.values[i])>1e-4))
    const returnCurrent=resolveWireCurrent(withoutSource,createWireCurrentTarget(drawing,{wireId:'W4',fraction:.5}))!
    assert.ok(returnCurrent,'separate ground symbols remain electrically connected for KCL')
    for(let i=0;i<result.points;i++)close(returnCurrent.values[i],-feeder.values[i])
    if(analysis==='ac'){
      const trace=resolveMeasurement(withoutSource,{id:'P1',kind:'current',wire:targets[0]})!
      const actual=10**(trace.magnitude![0]/20),wrong=Math.hypot(resistor.complex![0].real,resistor.complex![0].img)+Math.hypot(capacitor.complex![0].real,capacitor.complex![0].img)
      assert.ok(Math.abs(actual-wrong)>1e-4)
    }
    assert.equal(projectKey(project),key)
  }
})
test('ideal wire loops and label bypasses are explicitly indeterminate, and missing vectors never invent current',async()=>{
  const project=parallelRc(),d=project.drawing!,wire=createWireCurrentTarget(d,{wireId:'W1',fraction:.5})
  let loop:Drawing={...d,junctions:[...d.junctions,{id:'J2',x:160,y:100}]}
  loop=connect(loop,terminal('V1'),{junction:'J2'});loop=connect(loop,{junction:'J2'},{junction:'J1'})
  const cut=wireCurrentCut(loop,wire);assert.equal(cut.ok,false);if(!cut.ok)assert.match(cut.reason,/不唯一/)
  assert.throws(()=>createWireCurrentTarget(loop,{wireId:'W1',fraction:.5}),/不唯一/)
  const labels={...d,labels:[{id:'N1',name:'BYPASS',at:terminal('V1')},{id:'N2',name:'bypass',at:{junction:'J1'}}]}
  assert.equal(wireCurrentCut(labels,wire).ok,false)
  const unknown={...d,devices:d.devices.map(device=>device.kind==='GND'?device:{...device,kind:'M' as const})}
  const unsupported=wireCurrentCut(unknown,wire);assert.equal(unsupported.ok,false);if(!unsupported.ok)assert.match(unsupported.reason,/尚未保存引脚电流/)
  project.analysis='tran';const result=await simulate(project)
  assert.equal(resolveWireCurrent({...result,currents:{}},wire),null)
  assert.match(wireCurrentUnavailableReason({...result,currents:{}},wire)!,/缺少/)
  assert.equal(resolveWireCurrent({...result,project:{...project,drawing:loop}},wire),null)
  assert.match(wireCurrentUnavailableReason({...result,project:{...project,drawing:loop}},wire)!,/不唯一/)
})

test('real ngspice: ideal opamp implicit ground return never makes a ground-wire clamp falsely read zero',async()=>{
  const project=blankProject();project.source={dc:'1V',offset:'1V',amplitude:'200mV',frequency:'1kHz',waveform:'sine'};project.tran={step:'2us',stop:'40us'};project.ac={points:10,start:'100Hz',stop:'10kHz'}
  let d=project.drawing!
  d.devices=[{id:'V1',kind:'V',value:'1V',x:160,y:300,rotation:90},{id:'E1',kind:'OP',value:'100k',x:420,y:220,rotation:0},{id:'R1',kind:'R',value:'1k',x:720,y:300,rotation:90},{id:'G1',kind:'GND',value:'',x:440,y:540,rotation:0}]
  d.junctions=[{id:'J1',x:440,y:440}];d.sourceId='V1';d.output=terminal('E1',2)
  d=connect(d,terminal('V1'),terminal('E1'));d=connect(d,terminal('E1',1),terminal('E1',2));d=connect(d,terminal('E1',2),terminal('R1'))
  d=connect(d,terminal('R1',1),{junction:'J1'});d=connect(d,terminal('V1',1),{junction:'J1'});d=connect(d,{junction:'J1'},terminal('G1'))
  project.drawing=d
  const target=createWireCurrentTarget(d,{wireId:'W6',fraction:.5}),cut=wireCurrentCut(d,target)
  assert.ok(cut.ok);assert.ok(cut.plans.every(plan=>plan.length>0),'implicit OP ground must not create a zero-current empty plan')
  for(const analysis of ['tran','ac'] as const){
    project.analysis=analysis;const result=await simulate(project),current=resolveWireCurrent(result,target)!,resistor=resolveBranchCurrent(result,'R1')!
    assert.ok(current)
    for(let index=0;index<result.points;index++){close(current.values[index],resistor.values[index]);if(analysis==='ac')close(current.complex![index].img,resistor.complex![index].img)}
    assert.ok(current.values.some(value=>Math.abs(value)>.0009))
    const absent={...result,currents:{},complexCurrents:{},complexVoltages:{}}
    assert.equal(resolveWireCurrent(absent,target),null,'unknown implicit return cannot fall back to a fabricated zero')
  }
})
test('deleted/reused wire identities do not read older results; moving a clamp follows the chosen wire tangent',async()=>{
  const project=parallelRc(),drawing=project.drawing!,wire=createWireCurrentTarget(drawing,{wireId:'W1',fraction:.5}),result=await simulate(project)
  const removed={...drawing,wires:drawing.wires.filter(w=>w.id!=='W1')}
  assert.equal(hasWireCurrentTarget(removed,wire),false)
  assert.equal(resolveMeasurement({...result,project:{...project,drawing:removed}},{id:'P1',kind:'current',wire}),null)
  const reused={...drawing,wires:drawing.wires.map(w=>w.id==='W1'?{...w,from:terminal('R1'),to:terminal('C1')}:w)}
  assert.equal(hasWireCurrentTarget(reused,wire),false)
  const newTarget={...wire,from:terminal('R1'),to:terminal('C1')}
  assert.equal(resolveMeasurement(result,{id:'P1',kind:'current',wire:newTarget}),null)
  assert.equal(wireProbeAngle(drawing,{wireId:'W1',fraction:0}),-90)
  assert.equal(wireProbeAngle(drawing,{wireId:'W1',fraction:1}),0)
  assert.equal(wireProbeAngle(drawing,{wireId:'W1',fraction:1},-1),180)
  assert.equal(nearestWireProbeTarget(drawing,{x:400,y:180},14),null,'fork must select one particular segment')
  const target=nearestWireProbeTarget(drawing,{x:240,y:183},14)!
  assert.equal(target.anchor!.wireId,'W1');assert.equal(target.point.y,180)
})

test('DOM: current clamps attach to clicked wires, drag only to wires, expose reverse action and retain device probes',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:3031'}),prior=new Map<string,PropertyDescriptor|undefined>()
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,IS_REACT_ACT_ENVIRONMENT:true,DOMPoint:class{constructor(public x:number,public y:number){}matrixTransform(){return{x:this.x,y:this.y}}}})){
    prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  Object.assign(dom.window.SVGElement.prototype,{getScreenCTM:()=>({inverse:()=>({a:1,d:1})}),setPointerCapture:()=>{},releasePointerCapture:()=>{},hasPointerCapture:()=>false})
  const {createRoot}=await import('react-dom/client'),{default:EditorCanvas}=await import('../src/components/EditorCanvas'),root=createRoot(dom.window.document.getElementById('root')!)
  try{
    const doc=dom.window.document,drawing=parallelRc().drawing!,anchors:WireAnchor[]=[],devices:string[]=[],relocated:ProbeTarget[]=[],reversed:string[]=[],changes:Drawing[]=[]
    const anchor=projectOnWire(drawing,'W2',{x:500,y:180})!.anchor!
    const props={drawing,selection:[],onSelect:()=>{},tool:'probe' as const,onTool:()=>{},rotation:0 as const,onChange:(d:Drawing)=>changes.push(d),onStatus:()=>{},zoom:1,onZoom:()=>{},resetView:0,fitSelection:0,showNodes:false,wireBend:'hv' as const,onWireBend:()=>{},clipboard:null,onPaste:()=>{},probeMode:'current' as const,onProbeWire:(a:WireAnchor)=>anchors.push(a),onProbeDevice:(id:string)=>devices.push(id),onReverseProbe:(id:string)=>reversed.push(id),onRelocateProbe:(_label:string,target:ProbeTarget)=>relocated.push(target),probeMarkers:[{at:{junction:'J1'},anchor,label:'P1',color:'#a76512',type:'current' as const,direction:1 as const}]}
    const event=async(selector:string,type:string,x=0,y=0)=>{const target=doc.querySelector(selector);assert.ok(target,selector);await act(async()=>target.dispatchEvent(new dom.window.MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y})))}
    await act(async()=>root.render(createElement(EditorCanvas,props)))
    await event('[aria-label="导线 W2"]','pointerdown',500,182)
    assert.equal(anchors.length,1);assert.equal(anchors[0].wireId,'W2')
    assert.equal(doc.querySelector('.probe-current-arrow')!.getAttribute('transform'),'rotate(0)')
    await event('.probe-tip-wire','pointerdown',500,180);await event('.editor-canvas','pointermove',700,180);await event('.editor-canvas','pointerup',700,180)
    assert.equal(relocated.length,1);assert.equal(relocated[0].anchor!.wireId,'W3')
    await event('.probe-tip-wire','pointerdown',500,180);await event('.editor-canvas','pointerup',900,580)
    assert.equal(relocated.length,1,'invalid blank drop retains original clamp')
    await event('.probe-tip-wire','dblclick',500,180);assert.deepEqual(reversed,['P1'])
    await event('[data-context-device="R1"]','pointerdown',560,300);assert.deepEqual(devices,['R1'])
    await act(async()=>root.render(createElement(EditorCanvas,{...props,probeMarkers:[{...props.probeMarkers[0],direction:-1 as const}]})))
    assert.equal(doc.querySelector('.probe-current-arrow')!.getAttribute('transform'),'rotate(180)')
    assert.deepEqual(changes,[])
  }finally{await act(async()=>root.unmount());for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}dom.window.close()}
})
