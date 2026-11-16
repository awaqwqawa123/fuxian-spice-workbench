import assert from 'node:assert/strict'
import test from 'node:test'
import { addDevice, emptyDrawing, terminal, terminalKey, wirePoints, type Drawing, type Wire } from '../src/core/drawing'
import { wireNetTopology } from '../src/core/wire-net-topology'
import { createWireSnapIndex } from '../src/core/wire-routing'
import { applySeriesInsertion, findSeriesInsertion, remapSeriesMeasurements } from '../src/core/series-insertion'
import { blankProject } from '../src/core/editor'
import { generateNetlist, parseProject } from '../src/core/circuit'
import { moveSelection } from '../src/core/selection'
import { probePoint } from '../src/core/probe-placement'
import { resolveMeasurement, type Measurement } from '../src/core/probes'
import { simulate } from './simulate'

function fixture(){
  const base=emptyDrawing()
  base.devices=[
    {id:'V1',kind:'V',value:'5V',x:160,y:320,rotation:90},
    {id:'R1',kind:'R',value:'1k',x:600,y:320,rotation:90},
    {id:'G1',kind:'GND',value:'',x:160,y:440,rotation:0},
    {id:'G2',kind:'GND',value:'',x:600,y:440,rotation:0},
  ]
  base.wires=[
    {id:'W1',from:terminal('V1'),to:terminal('R1'),bend:'vh',waypoints:[{x:160,y:200},{x:600,y:200}]},
    {id:'W2',from:terminal('V1',1),to:terminal('G1'),bend:'vh'},
    {id:'W3',from:terminal('R1',1),to:terminal('G2'),bend:'vh'},
  ]
  base.labels=[{id:'N1',name:'VIN',at:terminal('V1')},{id:'N2',name:'VOUT',at:terminal('R1')}]
  base.sourceId='V1'
  base.output=terminal('R1')
  return base
}
function insertAt(base:Drawing,x=380,y=200){
  const added=addDevice(base,'R',{x,y},0)
  const target=findSeriesInsertion(base,createWireSnapIndex(base),added.drawing.devices.at(-1)!,{x,y},1)
  assert.equal(target?.kind,'ready')
  return applySeriesInsertion(base,added.drawing,target!.plan)
}
test('horizontal series insertion preserves both outer paths and separates the original nets; ngspice reads the divider',async()=>{
  const base=fixture(),result=insertAt(base),original=blankProject()
  original.source.dc='5V';original.analysis='op';original.drawing=base
  const probes:Measurement[]=[
    {id:'P1',kind:'voltage',positive:terminal('V1'),positiveLayout:{anchor:{wireId:'W1',fraction:.75},offset:{x:10,y:-30}}},
    {id:'P2',kind:'current',wire:{wireId:'W1',from:terminal('V1'),to:terminal('R1'),direction:-1},layout:{anchor:{wireId:'W1',fraction:.25}}},
    {id:'P3',kind:'voltage',positive:terminal('V1'),negative:terminal('V1'),positiveLayout:{anchor:{wireId:'W1',fraction:.25}},negativeLayout:{anchor:{wireId:'W1',fraction:.75}}},
  ]
  original.probes=probes
  const after=parseProject({...original,drawing:result.drawing,probes:remapSeriesMeasurements(result,probes)})
  const drawing=after.drawing!,nodes=wireNetTopology(drawing)
  assert.equal(nodes.net(terminal('V1')),nodes.net(terminal('R2')))
  assert.equal(nodes.net(terminal('R1')),nodes.net(terminal('R2',1)))
  assert.notEqual(nodes.net(terminal('R2')),nodes.net(terminal('R2',1)))
  assert.deepEqual(wirePoints(drawing,result.firstWire),[{x:160,y:280},{x:160,y:200},{x:340,y:200}])
  assert.deepEqual(wirePoints(drawing,result.secondWire),[{x:420,y:200},{x:600,y:200},{x:600,y:280}])
  assert.deepEqual(drawing.labels,base.labels)
  assert.deepEqual(drawing.output,base.output)
  const [v,i,diff]=after.probes!
  assert.equal(v.kind,'voltage');assert.equal(i.kind,'current');assert.equal(diff.kind,'voltage')
  assert.equal(terminalKey(v.positive),terminalKey(terminal('R1')))
  assert.deepEqual(probePoint(drawing,v.positive,v.positiveLayout?.anchor),probePoint(base,terminal('V1'),{wireId:'W1',fraction:.75}))
  assert.equal(i.wire?.direction,-1)
  assert.equal(diff.negativeLayout?.anchor?.wireId,result.secondWire.id)
  assert.match(generateNetlist(after),/^R2 vin vout 1000$/mi)
  const solved=await simulate(after)
  assert.match(solved.engine,/ngspice/i)
  assert.ok(Math.abs(solved.vout[0]-2.5)<1e-8)
  assert.ok(Math.abs(resolveMeasurement(solved,i)!.values[0]+.0025)<1e-8)
  assert.ok(Math.abs(resolveMeasurement(solved,diff)!.values[0]-2.5)<1e-8)
  assert.deepEqual(base.wires,fixture().wires)
})
test('dragging a loose mirrored and rotated device into a vertical span uses true pin order',()=>{
  const base=emptyDrawing()
  base.junctions=[{id:'J1',x:400,y:480},{id:'J2',x:400,y:120}]
  base.wires=[{id:'W1',from:{junction:'J1'},to:{junction:'J2'},bend:'vh'}]
  base.devices=[{id:'D1',kind:'D',value:'D_SI',x:560,y:300,rotation:90,mirrored:true}]
  const moved=moveSelection(base,['D1'],{x:-160,y:0}),part=moved.devices[0]
  const rotateHint=findSeriesInsertion(base,createWireSnapIndex(base),{...part,rotation:0},part,1)
  assert.equal(rotateHint?.kind,'blocked');assert.match(rotateHint!.reason,/按 R 旋转/)
  assert.equal(findSeriesInsertion(base,createWireSnapIndex(base),{...part,rotation:0},{x:408,y:300},1),null)
  const target=findSeriesInsertion(base,createWireSnapIndex(base),part,part,1)
  assert.equal(target?.kind,'ready')
  const result=applySeriesInsertion(base,moved,target!.plan)
  assert.deepEqual(result.firstWire.to,terminal('D1',0))
  assert.deepEqual(result.secondWire.from,terminal('D1',1))
  assert.notEqual(wireNetTopology(result.drawing).net(terminal('D1')),wireNetTopology(result.drawing).net(terminal('D1',1)))
  const connected=findSeriesInsertion(result.drawing,createWireSnapIndex(result.drawing),part,part,1)
  assert.equal(connected,null,'moving a wired component cannot cut another wire')
})
test('reject a cross, nearby branch, hidden same-name bypass and a probe in the removed span',()=>{
  const base=fixture(),part=addDevice(base,'R',{x:380,y:200},0).drawing.devices.at(-1)!
  const inspect=(drawing:Drawing)=>findSeriesInsertion(drawing,createWireSnapIndex(drawing),part,part,1)
  assert.equal(inspect({...base,junctions:[{id:'J1',x:380,y:200}]})?.kind,'blocked')
  const cross={...base,junctions:[{id:'J1',x:380,y:120},{id:'J2',x:380,y:260}],wires:[...base.wires,{id:'W4',from:{junction:'J1'},to:{junction:'J2'},bend:'vh'} as Wire]}
  assert.equal(inspect(cross)?.kind,'blocked')
  assert.throws(()=>insertAt({...base,labels:base.labels!.map(label=>({...label,name:'same'}))}),/两侧仍被/)
  const result=insertAt(base)
  assert.throws(()=>remapSeriesMeasurements(result,[{id:'P1',kind:'voltage',positive:terminal('V1'),positiveLayout:{anchor:{wireId:'W1',fraction:.5}}}]),/切口内有探针 P1/)
})


test('editor interactions preview, place, undo, redo, and drag a disconnected resistor in one history step',async()=>{
  const {JSDOM}=await import('jsdom')
  const {act,createElement}=await import('react')
  const {codexStatusFixture}=await import('./codex-status-fixture')
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost:3030/'})
  const win=dom.window,doc=win.document,prior=new Map<string,PropertyDescriptor|undefined>()
  const globals={window:win,document:doc,HTMLElement:win.HTMLElement,SVGElement:win.SVGElement,localStorage:win.localStorage,IS_REACT_ACT_ENVIRONMENT:true,
    DOMPoint:class{constructor(public x:number, public y:number){} matrixTransform(){return{x:this.x,y:this.y}}},
    fetch:async()=>Response.json(codexStatusFixture)}
  for(const [key,value] of Object.entries(globals)){
    prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  Object.assign(win.SVGElement.prototype,{getScreenCTM:()=>({inverse:()=>({a:1,d:1})}),setPointerCapture:()=>{},releasePointerCapture:()=>{},hasPointerCapture:()=>false})
  const {createRoot}=await import('react-dom/client'),{default:EditorWorkbench}=await import('../src/EditorWorkbench')
  const root=createRoot(doc.getElementById('root')!)
  const seed=blankProject();seed.drawing=fixture()
  seed.probes=[{id:'P1',kind:'voltage',positive:terminal('V1'),positiveLayout:{anchor:{wireId:'W1',fraction:.75}}}]
  const saved=()=>parseProject(JSON.parse(win.localStorage.getItem('fuxian-free-editor-v2')!),{allowDraft:true})
  const query=(selector:string)=>{const found=doc.querySelector(selector);assert.ok(found,selector);return found}
  const dispatch=async(selector:string,type:string,init:MouseEventInit={})=>act(async()=>{query(selector).dispatchEvent(new win.MouseEvent(type,{bubbles:true,button:0,...init}))})
  const mouse=(type:string,x:number,y:number)=>dispatch('.editor-canvas',type,{clientX:x,clientY:y})
  const resistor='button[aria-label="放置电阻"]'
  try{
    await act(async()=>root.render(createElement(EditorWorkbench,{seed})))
    await dispatch(resistor,'click')
    await mouse('pointermove',380,200)
    assert.ok(doc.querySelector('.series-insert-preview'))
    await mouse('pointerdown',380,200)
    let placed=saved()
    assert.equal(placed.drawing!.wires.length,4)
    assert.equal(placed.probes?.[0].kind,'voltage')
    assert.equal(terminalKey(placed.probes[0].positive),terminalKey(terminal('R1')))
    await dispatch('button[aria-label="撤销"]','click')
    assert.deepEqual(saved().drawing,seed.drawing)
    assert.deepEqual(saved().probes,seed.probes)
    await dispatch('button[aria-label="重做"]','click')
    assert.deepEqual(saved().drawing,placed.drawing)
    assert.deepEqual(saved().probes,placed.probes)
    await dispatch('button[aria-label="撤销"]','click')
    await dispatch(resistor,'click')
    await mouse('pointerdown',380,100)
    const loose=saved()
    assert.equal(loose.drawing!.wires.length,3)
    await dispatch('[data-device-hit-area="R2"]','pointerdown',{clientX:380,clientY:100})
    await mouse('pointermove',380,200)
    await mouse('pointerup',380,200)
    placed=saved()
    assert.equal(placed.drawing!.wires.length,4)
    assert.equal(placed.drawing!.devices.find(part=>part.id==='R2')?.y,200)
    await dispatch('button[aria-label="撤销"]','click')
    assert.deepEqual(saved().drawing,loose.drawing)
    assert.deepEqual(saved().probes,loose.probes)
  }finally{
    await act(async()=>root.unmount());win.close()
    for(const [key,descriptor] of prior){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as Record<string,unknown>)[key]}
  }
})
