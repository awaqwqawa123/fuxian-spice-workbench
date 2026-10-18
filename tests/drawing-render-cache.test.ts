import assert from 'node:assert/strict'
import test from 'node:test'
import {performance} from 'node:perf_hooks'
import {createDrawingRenderCache,emptyDrawing,terminalPosition,wirePath,wirePoints,type Drawing,type Wire} from '../src/core/drawing'
import {createWireSnapIndex} from '../src/core/wire-routing'
import {placeNetLabels} from '../src/core/schematic-layout'
import {layoutProbeMarkers,probeMarkerBounds,type ProbeMarker} from '../src/core/probe-layout'

function fixture():Drawing {
  return {...emptyDrawing(),devices:[
    {id:'V1',kind:'V',value:'5',x:100,y:200,rotation:0},
    {id:'R1',kind:'R',value:'1k',x:300,y:300,rotation:0},
  ],wires:[{id:'W1',from:{device:'V1',pin:1},to:{device:'R1',pin:0},bend:'hv'}],labels:[{id:'N1',name:'OUT',at:{device:'R1',pin:0}}]}
}

test('renderer snapshot shares exact routes across artwork, labels, snapping and probe helpers without altering source',()=>{
  const source=fixture(),before=JSON.stringify(source),cache=createDrawingRenderCache(),render=cache.snapshot(source),wire=source.wires[0]
  const markers:ProbeMarker[]=[{at:wire.to,label:'P1',color:'#c00',anchor:{wireId:wire.id,fraction:.5}}]
  assert.notEqual(render,source);assert.equal(cache.snapshot(source),render)
  assert.equal(render.devices,source.devices);assert.equal(render.wires,source.wires)
  const expected={path:wirePath(source,wire),snap:createWireSnapIndex(source),labels:placeNetLabels(source),probes:layoutProbeMarkers(source,markers)}
  const actual={path:wirePath(render,wire),snap:createWireSnapIndex(render),labels:placeNetLabels(render),probes:layoutProbeMarkers(render,markers)}
  assert.deepEqual(actual,expected)
  assert.deepEqual(actual.probes.map(marker=>probeMarkerBounds(render,marker)),expected.probes.map(marker=>probeMarkerBounds(source,marker)))
  assert.equal(wirePoints(render,wire),wirePoints(render,wire),'registered renderer routes are reused by reference')
  assert.equal(cache.readStats().routeComputations,1)
  assert.ok(cache.readStats().routeHits>=5)
  assert.equal(JSON.stringify(source),before,'geometry cache never serializes into or mutates the project')
})

test('automatic route invalidates when surrounding obstacles change despite stable wire and endpoint identities',()=>{
  const source=fixture(),cache=createDrawingRenderCache(),wire=source.wires[0],first=cache.snapshot(source)
  const before=wirePoints(first,wire)
  const changed:Drawing={...source,devices:[...source.devices,{id:'R2',kind:'R',value:'1k',x:200,y:200,rotation:0}]}
  const after=wirePoints(cache.snapshot(changed),wire)
  assert.deepEqual(after,wirePoints(changed,wire))
  assert.notDeepEqual(after,before,'the new obstacle actually changes this repair route')
  assert.equal(cache.readStats().routeComputations,2)
  assert.equal(cache.readStats().explicitReuses,0)
  assert.equal(wirePoints(cache.snapshot(source),wire),before,'undo revisits its exact former snapshot')
  assert.equal(cache.readStats().routeComputations,2)
})

test('explicit route reuse requires stable wire plus both actual endpoint owners',()=>{
  const base=fixture(),wire:Wire={...base.wires[0],waypoints:[{x:200,y:200},{x:200,y:300}]},source={...base,wires:[wire]},cache=createDrawingRenderCache()
  const first=wirePoints(cache.snapshot(source),wire)
  const unrelated:Drawing={...source,devices:[...source.devices,{id:'C1',kind:'C',value:'1n',x:900,y:400,rotation:90}]}
  assert.equal(wirePoints(cache.snapshot(unrelated),wire),first)
  assert.equal(cache.readStats().explicitReuses,1)
  for(const rotation of [90,180,270] as const){
    const changed={...source,devices:source.devices.map(part=>part.id==='R1'?{...part,x:part.x+20,y:part.y-20,rotation,mirrored:true}:part)}
    assert.deepEqual(wirePoints(cache.snapshot(changed),wire),wirePoints(changed,wire))
  }
  const rewired={...wire,to:{device:'R1',pin:1}},changed={...source,wires:[rewired]}
  assert.deepEqual(wirePoints(cache.snapshot(changed),rewired),wirePoints(changed,rewired))
  assert.equal(cache.readStats().routeComputations,5)
})

test('junction movement and missing or replaced endpoints do not inherit stale render geometry',()=>{
  const base=fixture(),wire:Wire={...base.wires[0],to:{junction:'J1'},waypoints:[{x:220,y:200}]},source={...base,wires:[wire],junctions:[{id:'J1',x:260,y:260}]},cache=createDrawingRenderCache()
  wirePoints(cache.snapshot(source),wire)
  const moved={...source,junctions:[{id:'J1',x:320,y:340}]}
  assert.deepEqual(wirePoints(cache.snapshot(moved),wire),wirePoints(moved,wire))
  assert.deepEqual(terminalPosition(cache.snapshot(moved),{junction:'J1'}),moved.junctions[0])
  assert.throws(()=>wirePoints(cache.snapshot({...source,junctions:[]}),wire),/连接点不存在/)
})

test('ordinary mutable Drawing inputs remain uncached, even when a related render view exists',()=>{
  const source=fixture(),cache=createDrawingRenderCache(),wire=source.wires[0]
  wirePoints(cache.snapshot(source),wire)
  const first=wirePoints(source,wire)
  source.devices[1].x+=80
  const second=wirePoints(source,wire)
  assert.notDeepEqual(second,first)
  source.devices[1].mirrored=true
  assert.deepEqual(wirePoints(source,wire).at(-1),terminalPosition(source,wire.to))
  const third=wirePoints(source,wire)
  third[0].x+=1000
  assert.notDeepEqual(wirePoints(source,wire),third,'normal calls retain independent mutable result arrays')
})

test('cache scope is per renderer and resetStats does not invalidate exact route storage',()=>{
  const source=fixture(),first=createDrawingRenderCache(),second=createDrawingRenderCache()
  assert.notEqual(first.snapshot(source),second.snapshot(source))
  const points=wirePoints(first.snapshot(source),source.wires[0])
  first.resetStats();assert.deepEqual(first.readStats(),{snapshots:0,routeComputations:0,routeHits:0,explicitReuses:0})
  assert.equal(wirePoints(first.snapshot(source),source.wires[0]),points)
  assert.deepEqual(first.readStats(),{snapshots:0,routeComputations:0,routeHits:1,explicitReuses:0})
  assert.equal(second.readStats().routeComputations,0)
})

test('unchanged render passes retain every automatic route point while avoiding repeated repairs',t=>{
  const source:Drawing={...emptyDrawing(),devices:[],wires:[],labels:[]}
  for(let index=0;index<20;index++){
    const x=(index%5)*700,y=Math.floor(index/5)*500
    source.devices.push({id:`V${index}`,kind:'V',value:'5',x:x+100,y:y+200,rotation:0},{id:`R${index}`,kind:'R',value:'1k',x:x+300,y:y+300,rotation:0})
    source.wires.push({id:`W${index}`,from:{device:`V${index}`,pin:1},to:{device:`R${index}`,pin:0},bend:'hv'})
    source.labels!.push({id:`N${index}`,name:`OUTPUT_${index}`,at:{device:`R${index}`,pin:0}})
  }
  const pass=(drawing:Drawing)=>({paths:drawing.wires.map(wire=>wirePath(drawing,wire)),labels:placeNetLabels(drawing),snap:createWireSnapIndex(drawing)})
  const cache=createDrawingRenderCache(),render=cache.snapshot(source),start=performance.now(),baseline=pass(source),baselineMs=performance.now()-start
  const coldStart=performance.now();assert.deepEqual(pass(render),baseline);const coldMs=performance.now()-coldStart
  const warmStart=performance.now();for(let index=0;index<8;index++)assert.deepEqual(pass(render),baseline);const warmMs=(performance.now()-warmStart)/8
  assert.equal(cache.readStats().routeComputations,source.wires.length)
  assert.equal(cache.readStats().routeHits,source.wires.length*(3*9-1))
  t.diagnostic(JSON.stringify({measurement:'exact-render-route-cache',devices:source.devices.length,wires:source.wires.length,baselineMs,coldMs,warmMs,...cache.readStats()}))
})
