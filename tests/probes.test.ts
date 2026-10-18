import assert from 'node:assert/strict'
import test from 'node:test'
import { act,createElement,useState } from 'react'
import { JSDOM } from 'jsdom'
import { generateNetlist,projectKey } from '../src/core/circuit'
import { connect,setNetLabel,terminal,type Drawing,type Terminal } from '../src/core/drawing'
import { blankProject,editableProject } from '../src/core/editor'
import { exampleProject } from '../src/core/examples'
import { nearestSample } from '../src/core/measurements'
import { probeColors,resolveMeasurement,type Measurement } from '../src/core/probes'
import { simulate } from './simulate'
import { nearestProbeTarget, probePoint, projectOnWire, type ProbeTarget, type WireAnchor } from '../src/core/probe-placement'

function divider(){
  const p=blankProject();p.analysis='dc';p.dc={start:'0V',stop:'5V',step:'2.5V'}
  let d=p.drawing!
  d.devices=[
    {id:'V1',kind:'V',value:'5V',x:200,y:320,rotation:90},
    {id:'R1',kind:'R',value:'1k',x:460,y:200,rotation:0},
    {id:'R2',kind:'R',value:'1k',x:820,y:320,rotation:90},
    {id:'G1',kind:'GND',value:'',x:200,y:440,rotation:0},
    {id:'G2',kind:'GND',value:'',x:820,y:440,rotation:0},
  ]
  d.sourceId='V1';d.output=terminal('R2')
  d=connect(d,terminal('V1'),terminal('R1'),'vh');d=connect(d,terminal('R1',1),terminal('R2'))
  d=connect(d,terminal('V1',1),terminal('G1'));d=connect(d,terminal('R2',1),terminal('G2'))
  p.drawing=setNetLabel(d,terminal('R2'),'OUT')
  return p
}
test('real ngspice: differential and ground probes read saved samples without changing the experiment',async()=>{
  const p=divider(),key=projectKey(p),r=await simulate(p)
  const diff=resolveMeasurement(r,{id:'P2',kind:'voltage',positive:terminal('V1'),negative:terminal('R2')})!
  const output=resolveMeasurement(r,{id:'P1',kind:'voltage',positive:terminal('R2')})!
  assert.equal(diff.name,'V(vin, out)');assert.equal(diff.color,probeColors[1])
  assert.deepEqual(diff.values,[0,1.25,2.5]);assert.deepEqual(output.values,[0,1.25,2.5])
  const reverse=resolveMeasurement(r,{id:'P3',kind:'voltage',positive:terminal('G1'),negative:terminal('R2')})!
  assert.deepEqual(reverse.values,[0,-1.25,-2.5])
  assert.deepEqual(resolveMeasurement(r,{id:'P4',kind:'voltage',positive:terminal('G1')})!.values,[0,0,0])
  assert.equal(projectKey(p),key);assert.equal(r.key,key);assert.deepEqual(r.project.drawing!.output,terminal('R2'))
})
test('real ngspice: AC differential uses complex subtraction before magnitude and phase',async()=>{
  const p=editableProject(),r=await simulate(p)
  const diff=resolveMeasurement(r,{id:'P1',kind:'voltage',positive:terminal('V1'),negative:terminal('C1')})!
  const i=nearestSample(r.x,1000,true),q=2*Math.PI*r.x[i]*1600*100e-9
  const expectedMagnitude=20*Math.log10(q/Math.sqrt(1+q*q)),expectedPhase=Math.atan2(1,q)*180/Math.PI
  assert.ok(Math.abs(diff.magnitude![i]-expectedMagnitude)<1e-5)
  assert.ok(Math.abs(diff.phase![i]-expectedPhase)<1e-5)
  const output=resolveMeasurement(r,{id:'P2',kind:'voltage',positive:terminal('C1')})!
  assert.ok(Math.abs(diff.magnitude![i]-(0-output.magnitude![i]))>1)
  const current=resolveMeasurement(r,{id:'P3',kind:'current',device:'V1'})!
  assert.ok(Math.abs(current.magnitude![i]-(diff.magnitude![i]-20*Math.log10(1600)))<1e-5)
  assert.ok(r.complexVoltages!['v(vin)']);assert.ok(r.complexCurrents!['i(v1)'])
})
test('real ngspice: every voltage-source branch current is saved with ngspice polarity',async()=>{
  const p=exampleProject('mos-switch'),netlist=generateNetlist(p),r=await simulate(p)
  assert.match(netlist,/\.save .*i\(V1\).*i\(V2\)/)
  const supply=resolveMeasurement(r,{id:'P1',kind:'current',device:'V2'})!
  assert.equal(supply.name,'I(V2)')
  assert.ok(supply.values.at(-1)!<-.0049)
  for(let i=0;i<r.points;i++)assert.ok(Math.abs(supply.values[i]+(5-r.vout[i])/1000)<1e-8)
  assert.deepEqual(r.current,r.currents!['i(v1)'])
})
test('unavailable or stale probe references never fabricate a voltage/current trace',async()=>{
  const r=await simulate(divider())
  assert.equal(resolveMeasurement(r,{id:'P1',kind:'voltage',positive:terminal('R99')}),null)
  assert.equal(resolveMeasurement({...r,currents:{}},{id:'P1',kind:'current',device:'R1'}),null)
  assert.equal(resolveMeasurement({...r,voltages:{}},{id:'P1',kind:'voltage',positive:terminal('R2')}),null)
  assert.equal(resolveMeasurement({...r,currents:{}},{id:'P1',kind:'current',device:'V1'}),null)
})

async function domScope(run:(doc:Document,window:Window,root:import('react-dom/client').Root)=>Promise<void>){
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost:3030/'})
  const prior=new Map<string,PropertyDescriptor|undefined>()
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,IS_REACT_ACT_ENVIRONMENT:true,DOMPoint:class{constructor(public x:number,public y:number){}matrixTransform(m:{a?:number;d?:number;e?:number;f?:number}){return{x:this.x*(m.a??1)+(m.e??0),y:this.y*(m.d??1)+(m.f??0)}}}})){
    prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  Object.assign(dom.window.SVGElement.prototype,{getScreenCTM:()=>({inverse:()=>({a:1,d:1})}),setPointerCapture:()=>{},releasePointerCapture:()=>{},hasPointerCapture:()=>false,getBoundingClientRect:()=>({left:0,top:0,width:1000,height:255})})
  const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')!)
  try{await run(dom.window.document,dom.window as unknown as Window,root)}finally{await act(async()=>root.unmount());for(const[key,value]of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}dom.window.close()}
}
test('DOM: continuous probe clicks on pins, wires and labels leave drawing and tool unchanged',async()=>{
  await domScope(async(doc,win,root)=>{
    const {default:EditorCanvas}=await import('../src/components/EditorCanvas')
    const probes:Terminal[]=[],currents:string[]=[],changes:unknown[]=[],tools:string[]=[],selections:unknown[]=[]
    const props={drawing:divider().drawing!,selection:[],onSelect:(ids:string[])=>selections.push(ids),tool:'probe' as const,onTool:(tool:string)=>tools.push(tool),rotation:0 as const,onChange:(d:unknown)=>changes.push(d),onStatus:()=>{},zoom:1,onZoom:()=>{},resetView:0,fitSelection:0,showNodes:false,wireBend:'hv' as const,onWireBend:()=>{},clipboard:null,onPaste:()=>{},onProbe:(at:Terminal)=>probes.push(at),onProbeDevice:(id:string)=>currents.push(id),probeMarkers:[{at:terminal('R2'),label:'P1',color:probeColors[0]}]}
    const trigger=async(selector:string,type='pointerdown')=>{const el=doc.querySelector(selector);assert.ok(el,selector);await act(async()=>el.dispatchEvent(new (win as unknown as typeof globalThis).MouseEvent(type,{bubbles:true,button:0})))}
    await act(async()=>root.render(createElement(EditorCanvas,props)))
    await trigger('.editor-pin[aria-label^="R2 引脚 1"]');await trigger('[aria-label="导线 W1"]');await trigger('[aria-label="节点标签 OUT"]')
    assert.equal(probes.length,3);assert.deepEqual(changes,[]);assert.deepEqual(tools,[]);assert.deepEqual(selections,[])
    assert.equal(doc.querySelectorAll('.measurement-marker').length,1)
    await act(async()=>root.render(createElement(EditorCanvas,{...props,probeMode:'current'})))
    await trigger('.editor-device[aria-label^="V1 "]');await trigger('.editor-device[aria-label^="R1 "]')
    assert.deepEqual(currents,['V1','R1']);assert.equal(probes.length,3);assert.deepEqual(changes,[]);assert.deepEqual(tools,[])
  })
})
test('DOM: multiple probe traces, current units and selectable cursor measurement',async()=>{
  const result=await simulate(divider())
  const measurements:Measurement[]=[{id:'P1',kind:'voltage',positive:terminal('V1')},{id:'P2',kind:'voltage',positive:terminal('R2')},{id:'P3',kind:'current',device:'V1'}]
  await domScope(async(doc,win,root)=>{
    const {default:Waveform}=await import('../src/components/Waveform')
    const render=async(selectedMeasurement?:string)=>act(async()=>root.render(createElement(Waveform,{result,comparison:null,phase:false,measurements,selectedMeasurement})))
    const click=async(el:Element,x=0)=>act(async()=>el.dispatchEvent(new (win as unknown as typeof globalThis).MouseEvent('click',{bubbles:true,clientX:x,button:0})))
    await render('P2');assert.equal(doc.querySelectorAll('.plot-legend .probe-trace-button').length,2)
    const byText=(text:string)=>{const el=[...doc.querySelectorAll('button')].find(e=>e.textContent===text);assert.ok(el,text);return el}
    await click(byText('游标 A'));await click(doc.querySelector('svg')!,65);await click(doc.querySelector('svg')!,978)
    assert.equal(doc.querySelector('.measurement-readout strong')!.textContent,'V(out)')
    assert.match(doc.querySelector('.measurement-readout')!.textContent!,/ΔY: 2\.5 V/)
    await render('P3');assert.equal(doc.querySelectorAll('.plot-legend .probe-trace-button').length,1)
    assert.match(doc.querySelector('.plot-legend')!.textContent!,/I\(V1\)/);assert.match(doc.querySelector('.trace-controls')!.textContent!,/正方向/)
    await act(async()=>root.render(createElement(Waveform,{result,comparison:null,phase:false,measurements:[{id:'P4',kind:'voltage',positive:terminal('R99')}]})))
    assert.match(doc.body.textContent!,/没有这些探针的数据/);assert.equal(doc.querySelector('svg'),null)
  })
})
test('DOM: palette presets keep their model through click/drop and do not leak into a plain drag',async()=>{
  await domScope(async(doc,win,root)=>{
    const {default:EditorCanvas}=await import('../src/components/EditorCanvas')
    const changed:Drawing[]=[]
    const props={drawing:divider().drawing!,selection:[],onSelect:()=>{},tool:'D' as const,onTool:()=>{},rotation:90 as const,onChange:(d:Drawing)=>changed.push(d),onStatus:()=>{},zoom:1,onZoom:()=>{},resetView:0,fitSelection:0,showNodes:false,wireBend:'hv' as const,onWireBend:()=>{},clipboard:null,onPaste:()=>{},placementValue:'D_SCHOTTKY'}
    await act(async()=>root.render(createElement(EditorCanvas,props)))
    const canvas=doc.querySelector('svg')!
    await act(async()=>canvas.dispatchEvent(new (win as unknown as typeof globalThis).MouseEvent('pointerdown',{bubbles:true,button:0,clientX:600,clientY:400})))
    assert.equal(changed.at(-1)!.devices.at(-1)!.value,'D_SCHOTTKY');assert.equal(changed.at(-1)!.devices.at(-1)!.rotation,90)
    const drop=async(kind:string,value?:string)=>{
      const data:Record<string,string>={'application/x-fuxian-device':kind,...(value!==undefined?{'application/x-fuxian-value':value}:{})}
      const event=new (win as unknown as typeof globalThis).MouseEvent('drop',{bubbles:true,clientX:600,clientY:400})
      Object.defineProperty(event,'dataTransfer',{value:{types:Object.keys(data),getData:(name:string)=>data[name]??''}})
      await act(async()=>canvas.dispatchEvent(event))
    }
    await drop('Q','Q_PNP');assert.equal(changed.at(-1)!.devices.at(-1)!.value,'Q_PNP')
    await drop('R');assert.equal(changed.at(-1)!.devices.at(-1)!.value,'1k')
  })
})

test('wire probe anchors preserve the clicked point and follow a moved conductor without changing connectivity',()=>{
  const d=divider().drawing!,before=structuredClone(d)
  const target=projectOnWire(d,'W2',{x:640,y:202})!
  assert.deepEqual(target.point,{x:640,y:200});assert.ok(target.anchor!.fraction>0&&target.anchor!.fraction<1)
  assert.deepEqual(probePoint(d,target.at,target.anchor),target.point)
  const moved={...d,devices:d.devices.map(p=>({...p,x:p.x+20,y:p.y+20}))}
  assert.deepEqual(probePoint(moved,target.at,target.anchor),{x:660,y:220})
  assert.equal(nearestProbeTarget(d,{x:640,y:500},10),null)
  assert.deepEqual(d,before)
})

test('DOM: place a probe at a wire click, move its label, relocate its tip, and drag a differential measurement',async()=>{
  await domScope(async(doc,win,root)=>{
    const {default:EditorCanvas}=await import('../src/components/EditorCanvas')
    const probes:{at:Terminal;anchor?:WireAnchor}[]=[],pairs:[ProbeTarget,ProbeTarget][]=[],relocated:ProbeTarget[]=[],offsets:{x:number;y:number}[]=[],changes:unknown[]=[]
    const drawing=divider().drawing!,before=structuredClone(drawing)
    const props={drawing,selection:[],onSelect:()=>{},tool:'probe' as const,onTool:()=>{},rotation:0 as const,onChange:(d:unknown)=>changes.push(d),onStatus:()=>{},zoom:1,onZoom:()=>{},resetView:0,fitSelection:0,showNodes:false,wireBend:'hv' as const,onWireBend:()=>{},clipboard:null,onPaste:()=>{},onProbe:(at:Terminal,anchor?:WireAnchor)=>probes.push({at,anchor}),onProbePair:(a:ProbeTarget,b:ProbeTarget)=>pairs.push([a,b]),onRelocateProbe:(_label:string,target:ProbeTarget)=>relocated.push(target),onMoveProbeLabel:(_label:string,offset:{x:number;y:number})=>offsets.push(offset),probeMarkers:[{at:terminal('R1',1),anchor:projectOnWire(drawing,'W2',{x:640,y:200})!.anchor,label:'P1',color:probeColors[0]}]}
    const event=async(selector:string,type:string,x:number,y:number)=>{const el=doc.querySelector(selector);assert.ok(el,selector);await act(async()=>el.dispatchEvent(new (win as unknown as typeof globalThis).MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y})))}
    await act(async()=>root.render(createElement(EditorCanvas,props)))
    await event('[aria-label="导线 W2"]','pointerdown',640,202)
    assert.equal(probes.length,1);assert.deepEqual(probePoint(drawing,probes[0].at,probes[0].anchor),{x:640,y:200})
    assert.match(doc.querySelector('.measurement-marker')!.getAttribute('transform')!,/translate\(640 200\)/)
    assert.equal(doc.querySelector('.probe-badge rect')!.getAttribute('height'),'36')
    const badgeOffset=doc.querySelector('.probe-badge')!.getAttribute('transform')!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!
    await event('.probe-badge','pointerdown',660,154);await event('svg.editor-canvas','pointermove',720,184);await event('svg.editor-canvas','pointerup',720,184)
    assert.deepEqual(offsets.at(-1),{x:Number(badgeOffset[1])+60,y:Number(badgeOffset[2])+30});assert.equal(relocated.length,0)
    await event('.probe-tip','pointerdown',640,200);await event('svg.editor-canvas','pointermove',200,320);await event('svg.editor-canvas','pointerup',200,280)
    assert.equal(relocated.length,1);assert.deepEqual(relocated[0].at,terminal('V1'))
    await act(async()=>root.render(createElement(EditorCanvas,{...props,probeMode:'differential'})))
    await event('[aria-label="导线 W1"]','pointerdown',300,200);await event('svg.editor-canvas','pointermove',640,200);await event('svg.editor-canvas','pointerup',640,200)
    assert.equal(pairs.length,1);assert.deepEqual(pairs[0][0].at,terminal('V1'));assert.deepEqual(pairs[0][1].at,terminal('R1',1))
    assert.deepEqual(changes,[]);assert.deepEqual(drawing,before)
  })
})

test('DOM: V, I and differential are separate accessible tools with explicit pending cancellation and unavailable data',async()=>{
  const result=await simulate(divider())
  await domScope(async(doc,win,root)=>{
    const {default:ProbeTray}=await import('../src/components/ProbeTray')
    const modes:string[]=[],selected:string[]=[],removed:string[]=[]
    let canceled=0
    const measurements:Measurement[]=[{id:'P1',kind:'voltage',positive:terminal('R2')},{id:'P2',kind:'current',device:'R1'},{id:'P3',kind:'voltage',positive:terminal('V1'),negative:terminal('R2')},{id:'P4',kind:'current',device:'R99'}]
    const props={mode:'voltage' as const,onMode:(mode:string)=>modes.push(mode),active:false,onActivate:()=>{},measurements,selected:'P1',onSelect:(id:string)=>selected.push(id),onRemove:(id:string)=>removed.push(id),onClear:()=>{},pending:null,onCancelPending:()=>canceled++,result,stale:false,onViewResults:()=>{}}
    const click=async(selector:string)=>{const el=doc.querySelector(selector);assert.ok(el,selector);await act(async()=>el.dispatchEvent(new (win as unknown as typeof globalThis).MouseEvent('click',{bubbles:true})))}
    await act(async()=>root.render(createElement(ProbeTray,props)))
    assert.equal(doc.querySelector('select[aria-label="探针类型"]'),null)
    assert.equal(doc.querySelectorAll('.probe-mode-button').length,3)
    for(const mode of ['voltage','current','differential'])await click(`button[data-probe-mode="${mode}"]`)
    assert.deepEqual(modes,['voltage','current','differential'])
    assert.deepEqual([...doc.querySelectorAll('.probe-chip-type')].map(el=>el.textContent),['V','I','ΔV','I'])
    assert.match(doc.querySelector('.probe-chip.unavailable')!.textContent!,/P4.*无可用数据/)
    await click('[aria-label="查看电流测量 P2"]');await click('[aria-label="移除测量 P2"]')
    assert.deepEqual(selected,['P2']);assert.deepEqual(removed,['P2'])
    await act(async()=>root.render(createElement(ProbeTray,{...props,mode:'differential',active:true,pending:terminal('V1')})))
    assert.equal(doc.querySelector('[data-probe-mode="differential"]')!.getAttribute('aria-pressed'),'true')
    assert.match(doc.querySelector('.probe-instruction.has-pending')!.textContent!,/正端已选：V1:0.*点击负端/)
    await click('.probe-instruction.has-pending button');assert.equal(canceled,1)
    await act(async()=>root.render(createElement(ProbeTray,{...props,mode:'current',active:true})))
    assert.match(doc.querySelector('.probe-instruction')!.textContent!,/1 → 2.*二极管及电流源暂不支持 AC 电流/)
  })
})

test('DOM: typed markers distinguish differential polarity and current direction, and current tips cannot become voltage endpoints',async()=>{
  await domScope(async(doc,win,root)=>{
    const {default:EditorCanvas}=await import('../src/components/EditorCanvas')
    const drawing=divider().drawing!,offsets:{x:number;y:number}[]=[],relocated:ProbeTarget[]=[],selected:string[]=[],statuses:string[]=[]
    const props={drawing,selection:[],onSelect:()=>{},tool:'probe' as const,onTool:()=>{},rotation:0 as const,onChange:()=>{},onStatus:(text:string)=>statuses.push(text),zoom:1,onZoom:()=>{},resetView:0,fitSelection:0,showNodes:false,wireBend:'hv' as const,onWireBend:()=>{},clipboard:null,onPaste:()=>{},probeMode:'differential' as const,pendingProbe:{at:terminal('R1',1),anchor:projectOnWire(drawing,'W2',{x:640,y:200})!.anchor},onRelocateProbe:(_label:string,target:ProbeTarget)=>relocated.push(target),onMoveProbeLabel:(_label:string,offset:{x:number;y:number})=>offsets.push(offset),onSelectProbe:(id:string)=>selected.push(id),probeMarkers:[{at:terminal('R1'),label:'P1',color:probeColors[0],type:'voltage' as const},{at:terminal('R2'),label:'P2',color:probeColors[1],type:'current' as const,selected:true},{at:terminal('V1'),label:'P3+',color:probeColors[2],type:'differential' as const},{at:terminal('R2'),label:'P3−',color:probeColors[2],type:'differential' as const,negative:true}]}
    await act(async()=>root.render(createElement(EditorCanvas,props)))
    assert.deepEqual([...doc.querySelectorAll('.measurement-marker')].map(el=>el.getAttribute('data-probe-type')),['voltage','current','differential','differential'])
    assert.equal(doc.querySelector('.measurement-marker-negative .probe-tip text')!.textContent,'−')
    assert.equal(doc.querySelector('.probe-current-arrow')!.getAttribute('transform'),'rotate(90)')
    assert.match(doc.querySelector('.probe-pending-endpoint')!.getAttribute('transform')!,/translate\(640 200\)/)
    for(const badge of doc.querySelectorAll('.probe-badge rect')){assert.equal(badge.getAttribute('width'),'96');assert.equal(badge.getAttribute('height'),'36')}
    const event=async(selector:string,type:string,x:number,y:number)=>{const el=doc.querySelector(selector);assert.ok(el,selector);await act(async()=>el.dispatchEvent(new (win as unknown as typeof globalThis).MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y})))}
    await event('.probe-tip-current','pointerdown',820,280);await event('svg.editor-canvas','pointermove',200,280);await event('svg.editor-canvas','pointerup',200,280)
    assert.deepEqual(relocated,[]);assert.deepEqual(selected,['P2']);assert.match(statuses.at(-1)!,/绑定器件支路/)
    const badge=doc.querySelector('.measurement-marker-current .probe-badge')!,badgeOffset=badge.getAttribute('transform')!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!
    await act(async()=>badge.dispatchEvent(new (win as unknown as typeof globalThis).KeyboardEvent('keydown',{bubbles:true,key:'ArrowRight'})))
    assert.deepEqual(offsets.at(-1),{x:Number(badgeOffset[1])+10,y:Number(badgeOffset[2])})
    const device=drawing.devices.find(d=>d.id==='R2')!
    await act(async()=>root.render(createElement(EditorCanvas,{...props,drawing:{...drawing,devices:drawing.devices.map(d=>d.id===device.id?{...d,rotation:270 as const}:d)},pendingProbe:null})))
    assert.equal(doc.querySelector('.probe-current-arrow')!.getAttribute('transform'),'rotate(-90)')
    assert.equal(doc.querySelector('.probe-pending-endpoint'),null)
    // Persistent artwork and badge text share the same sheet scale as symbols.
    // Only transparent targets retain a minimum reachable screen size.
    for(const scale of [.2,.5,1,2,4]){
      Object.assign((win as unknown as typeof globalThis).SVGElement.prototype,{getScreenCTM:()=>({a:scale,inverse:()=>({a:1/scale,d:1/scale})})})
      await act(async()=>root.render(createElement(EditorCanvas,{...props,zoom:scale})))
      const visualScale=scale,worldScale=1
      for(const marker of doc.querySelectorAll('.measurement-marker')){
        assert.ok(marker.getAttribute('transform')!.endsWith(`scale(${worldScale})`))
        assert.equal(Number(marker.querySelector('.probe-badge rect')!.getAttribute('width'))*visualScale,96*visualScale)
        assert.equal(Number(marker.querySelector('.probe-badge rect')!.getAttribute('height'))*visualScale,36*visualScale)
        assert.equal(marker.querySelector('.probe-tip-hit')!.getAttribute('fill'),'transparent')
        assert.ok(Number(marker.querySelector('.probe-tip-hit')!.getAttribute('r'))*visualScale>=9)
        assert.ok(Number(marker.querySelector('.probe-badge-hit')!.getAttribute('stroke-width'))*visualScale>=18)
      }
      assert.ok(doc.querySelector('.probe-pending-endpoint')!.getAttribute('transform')!.endsWith(`scale(${worldScale})`))
      assert.equal(doc.querySelector('.output-marker'),null,'actual measurements replace the legacy output triangle')
    }
  })
})


test('DOM: probe label dragging follows the pointer at small and large zoom without changing its measurement',async()=>{
  await domScope(async(doc,win,root)=>{
    const {default:EditorCanvas}=await import('../src/components/EditorCanvas')
    const drawing=divider().drawing!,before=structuredClone(drawing),offsets:{x:number;y:number}[]=[],relocated:ProbeTarget[]=[],changes:Drawing[]=[]
    const offset={x:80,y:-65}
    const props={drawing,selection:[],onSelect:()=>{},tool:'select' as const,onTool:()=>{},rotation:0 as const,onChange:(d:Drawing)=>changes.push(d),onStatus:()=>{},zoom:1,onZoom:()=>{},resetView:0,fitSelection:0,showNodes:false,wireBend:'hv' as const,onWireBend:()=>{},clipboard:null,onPaste:()=>{},onMoveProbeLabel:(_label:string,value:{x:number;y:number})=>offsets.push(value),onRelocateProbe:(_label:string,value:ProbeTarget)=>relocated.push(value),probeMarkers:[{at:terminal('R1',1),anchor:projectOnWire(drawing,'W2',{x:640,y:200})!.anchor,label:'P1',color:probeColors[0],offset}]}
    const event=async(selector:string,type:string,x:number,y:number)=>{const el=doc.querySelector(selector)!;await act(async()=>el.dispatchEvent(new (win as unknown as typeof globalThis).MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y})))}
    let resetOffset=()=>{}
    function Harness({scale}:{scale:number}){
      const [currentOffset,setCurrentOffset]=useState(offset)
      resetOffset=()=>setCurrentOffset(offset)
      return createElement(EditorCanvas,{...props,zoom:scale,probeMarkers:[{...props.probeMarkers[0],offset:currentOffset}],onMoveProbeLabel:(_label:string,value:{x:number;y:number})=>{offsets.push(value);setCurrentOffset(value)}})
    }
    for(const scale of [.25,.5,1,2,4]){
      const translation={x:37,y:-29}
      Object.assign((win as unknown as typeof globalThis).SVGElement.prototype,{getScreenCTM:()=>({a:scale,d:scale,e:translation.x,f:translation.y,inverse:()=>({a:1/scale,d:1/scale,e:-translation.x/scale,f:-translation.y/scale})})})
      await act(async()=>{resetOffset();root.render(createElement(Harness,{scale}))})
      assert.equal(doc.querySelector('.probe-badge')!.getAttribute('transform'),'translate(80 -65)','saved offsets remain intact')
      // Derive displayed coordinates from the actual rendered SVG transform
      // chain, not from the implementation's zoom clamp or offset conversion.
      const badgeScreenOrigin=()=>{
        const marker=doc.querySelector('.measurement-marker')!.getAttribute('transform')!.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/)!
        const badge=doc.querySelector('.probe-badge')!.getAttribute('transform')!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!
        const matrix=(doc.querySelector('svg.editor-canvas')! as unknown as SVGGraphicsElement).getScreenCTM()!
        return{x:(Number(marker[1])+Number(badge[1])*Number(marker[3]))*matrix.a+matrix.e,y:(Number(marker[2])+Number(badge[2])*Number(marker[3]))*matrix.d+matrix.f}
      }
      const initial=badgeScreenOrigin(),start={x:initial.x+10*scale,y:initial.y+18*scale}
      const near=(actual:number,expected:number,message:string)=>assert.ok(Math.abs(actual-expected)<1e-8,`${message}: ${actual} ≈ ${expected}`)
      await event('.probe-badge-hit','pointerdown',start.x,start.y)
      await event('svg.editor-canvas','pointermove',start.x+40,start.y-12)
      let displayed=badgeScreenOrigin()
      near(displayed.x-initial.x,40,'rendered badge follows horizontal screen pointer motion')
      near(displayed.y-initial.y,-12,'rendered badge follows vertical screen pointer motion')
      // Pointerup may contain a newer coordinate than the last pointermove.
      await event('svg.editor-canvas','pointerup',start.x+48,start.y-16)
      displayed=badgeScreenOrigin()
      near(displayed.x-initial.x,48,'release commits the final horizontal screen coordinate')
      near(displayed.y-initial.y,-16,'release commits the final vertical screen coordinate')
      near(offsets.at(-1)!.x-offset.x,48/scale,'stored offset is in sheet units')
      near(offsets.at(-1)!.y-offset.y,-16/scale,'stored offset is in sheet units')
      assert.equal(relocated.length,0,'moving a label never moves the measurement endpoint')
      await event('.probe-tip-hit','pointerdown',640*scale+translation.x,200*scale+translation.y)
      await event('svg.editor-canvas','pointerup',200*scale+translation.x,280*scale+translation.y)
      assert.deepEqual(relocated.at(-1)!.at,terminal('V1'),'the scaled tip still relocates to the actual electrical pin')
      relocated.length=0
    }
    assert.deepEqual(changes,[])
    assert.deepEqual(drawing,before)
    assert.deepEqual(offset,{x:80,y:-65})
  })
})
