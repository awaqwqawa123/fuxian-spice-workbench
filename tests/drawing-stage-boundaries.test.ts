import assert from 'node:assert/strict'
import test from 'node:test'
import { compileDrawing, connect, emptyDrawing, terminal, type Device, type Drawing, type Terminal } from '../src/core/drawing'
import { arrangeSignalStructure } from '../src/core/redraw-structure'
import { redrawDrawingLayout } from '../src/core/redraw-layout'

/** Two separate local gain loops, with an explicit source and final output.
 * The fixture starts scrambled; coordinates are deliberately not role evidence. */
function stages():Drawing {
  let drawing:Drawing={...emptyDrawing(),sourceId:'V1',output:terminal('U2',2),devices:[
    {id:'V1',kind:'V',value:'1',rotation:90,x:880,y:600},
    {id:'U1',kind:'OPA',value:'100k',rotation:0,x:200,y:400,params:{gbw:'2MHz'}},
    {id:'U2',kind:'OPA',value:'100k',rotation:0,x:600,y:100},
    {id:'R1',kind:'R',value:'10k',rotation:90,x:140,y:100},
    {id:'R2',kind:'R',value:'90k',rotation:0,x:600,y:600},
    {id:'R3',kind:'R',value:'10k',rotation:90,x:500,y:500},
    {id:'R4',kind:'R',value:'40k',rotation:0,x:100,y:400},
    {id:'V2',kind:'V',value:'15',rotation:90,x:940,y:300},
    {id:'V3',kind:'V',value:'-15',rotation:90,x:300,y:700},
    {id:'G1',kind:'GND',value:'',rotation:0,x:940,y:900},
  ]}
  const pairs:[Terminal,Terminal][]=[
    [terminal('V1'),terminal('U1')],[terminal('V1',1),terminal('G1')],
    [terminal('U1',1),terminal('R1')],[terminal('R1',1),terminal('G1')],
    [terminal('U1',1),terminal('R2')],[terminal('R2',1),terminal('U1',2)],
    [terminal('U1',2),terminal('U2')],
    [terminal('U2',1),terminal('R3')],[terminal('R3',1),terminal('G1')],
    [terminal('U2',1),terminal('R4')],[terminal('R4',1),terminal('U2',2)],
    [terminal('V2'),terminal('U1',3)],[terminal('V2'),terminal('U2',3)],
    [terminal('V3'),terminal('U1',4)],[terminal('V3'),terminal('U2',4)],
    [terminal('V2',1),terminal('G1')],[terminal('V3',1),terminal('G1')],
  ]
  for(const [from,to]of pairs)drawing=connect(drawing,from,to)
  return drawing
}

function specialize(drawing:Drawing) {
  const net=compileDrawing(drawing).nodes
  const groundNets=new Set(drawing.devices.filter(device=>device.kind==='GND').map(device=>net.get(`${device.id}:0`)!))
  return arrangeSignalStructure(drawing,{net,groundNets},drawing.devices.filter(device=>device.kind!=='GND').map(device=>device.id),300,240,200)
}

function extraResistor(drawing:Drawing,id:string,from:Terminal,to:Terminal) {
  drawing={...drawing,devices:[...drawing.devices,{id,kind:'R',value:'100k',rotation:0,x:500,y:300}]}
  return connect(connect(drawing,terminal(id),from),terminal(id,1),to)
}

function unchangedElectrical(before:Drawing,next:Drawing) {
  const terminals=(drawing:Drawing)=>[...compileDrawing(drawing).nodes.entries()].sort(([a],[b])=>a.localeCompare(b))
  assert.deepEqual(terminals(next),terminals(before),'all actual terminal networks stay unchanged')
  const data=(drawing:Drawing)=>({...drawing,devices:drawing.devices.map(({x,y,...data})=>data),junctions:drawing.junctions.map(({x,y,...data})=>data),wires:drawing.wires.map(({bend,waypoints,...data})=>data)})
  assert.deepEqual(data(next),data(before),'fallback is only a layout operation')
}

test('two proven gain stages may share supply rails while retaining separate feedback loops',()=>{
  const drawing=stages(),snapshot=structuredClone(drawing),placed=specialize(drawing)
  assert.ok(placed,'a serial pair is recognized from actual source/output and pins')
  assert.ok(placed.get('U1')!.x<placed.get('U2')!.x)
  for(const [ampId,resistorId]of [['U1','R2'],['U2','R4']]){
    const amp:Device=placed.get(ampId)!,feedback:Device=placed.get(resistorId)!
    assert.ok(Math.abs(amp.x-feedback.x)<200,`${resistorId} belongs to its own stage`)
    assert.ok(feedback.y>amp.y,`${resistorId} follows its actual lower inverting pin`)
  }
  for(const id of ['V2','V3'])assert.ok(placed.get(id)!.y<Math.min(placed.get('U1')!.y,placed.get('U2')!.y),'shared supplies stay outside the signal lane')
  assert.deepEqual(drawing,snapshot,'recognition never mutates the source snapshot')
  unchangedElectrical(drawing,redrawDrawingLayout(drawing))
})

test('an additional cross-stage loop is not silently classified as local feedback',()=>{
  const drawing=extraResistor(stages(),'R9',terminal('U2',2),terminal('U1',1))
  assert.equal(specialize(drawing),undefined)
  unchangedElectrical(drawing,redrawDrawingLayout(drawing))
})

test('parallel amplifier branches are not guessed to be a single cascade',()=>{
  let drawing=stages()
  drawing.wires=drawing.wires.filter(wire=>!('device'in wire.from&&wire.from.device==='U1'&&wire.from.pin===2&&'device'in wire.to&&wire.to.device==='U2'&&wire.to.pin===0))
  drawing=connect(drawing,terminal('V1'),terminal('U2'))
  assert.equal(specialize(drawing),undefined,'the off-path amplifier must not be discarded')
  unchangedElectrical(drawing,redrawDrawingLayout(drawing))
})

test('one resistor that closes two amplifiers is not assigned to an arbitrary stage',()=>{
  let drawing=stages()
  drawing=connect(drawing,terminal('U1',1),terminal('U2',2))
  drawing=connect(drawing,terminal('U2',1),terminal('U1',2))
  assert.equal(specialize(drawing),undefined,'feedback ownership must be unique')
})

test('a rail connected to a real signal terminal is not accepted as a pure shared supply',()=>{
  const drawing=connect(stages(),terminal('V2'),terminal('U1',2))
  assert.equal(specialize(drawing),undefined,'power membership cannot conceal an output on that net')
  unchangedElectrical(drawing,redrawDrawingLayout(drawing))
})

test('a rail attached to the non-path feedback input is still a mixed signal net',()=>{
  const drawing=connect(stages(),terminal('V2'),terminal('U1',1))
  assert.equal(specialize(drawing),undefined,'every amplifier input matters, including the input not used by the source/output path')
  unchangedElectrical(drawing,redrawDrawingLayout(drawing))
})

test('a shared rail that mixes positive and negative supply pins retains the fallback',()=>{
  const drawing=connect(stages(),terminal('U1',3),terminal('U2',4))
  assert.equal(specialize(drawing),undefined,'conservative specialization does not normalize mixed rail roles')
})

test('opposite stage orientations are preserved rather than forced into one reading axis',()=>{
  const drawing=stages()
  drawing.devices=drawing.devices.map(device=>device.id==='U2'?{...device,rotation:180}:device)
  assert.equal(specialize(drawing),undefined)
  unchangedElectrical(drawing,redrawDrawingLayout(drawing))
})

test('an absent source or explicit output is not invented for a closed or ambiguous network',()=>{
  const noSource=stages();noSource.sourceId=''
  const noOutput=stages();noOutput.output=null
  assert.equal(specialize(noSource),undefined)
  assert.equal(specialize(noOutput),undefined)
})
