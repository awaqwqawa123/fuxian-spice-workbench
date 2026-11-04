import assert from 'node:assert/strict'
import test from 'node:test'
import { importSpiceDeck } from '../src/core/spice-deck-import'
import { generateNetlist, parseProject } from '../src/core/circuit'
import { compileDrawing } from '../src/core/drawing'
import { applySimulationProfile } from '../src/core/simulation-profiles'
import { sourceValues } from '../src/core/sources'
import { simulateAgentCircuit } from '../server/agent-simulation'

const fixture=(body:string)=>`Imported test circuit\nV_supply supply 0 DC 5 AC 2 30\n${body}\n.op\n.end`
const replay=(text:string)=>{
  const imported=importSpiceDeck(text),saved=parseProject(JSON.parse(JSON.stringify(imported.project)))
  assert.deepEqual(saved,imported.project)
  return {...imported,project:saved,netlist:generateNetlist(saved)}
}

test('bare first device is retained; named/numeric nets and source references round trip',()=>{
  const result=replay('V_input 1 0 DC 2 AC 0.25 -45\nR_load 1 out 1MEG\nC_load out 0 10u\n.ac oct 12 10 10k\n.end')
  assert.equal(result.references.v_input,'V1');assert.equal(result.references.r_load,'R1')
  assert.equal(result.project.drawing!.devices.find(d=>d.id==='R1')!.value,'1000000')
  assert.match(result.netlist,/V1 deck_net_1 0 DC 2 AC 0.25 -45/)
  assert.equal(result.project.ac.sweep,'oct');assert.equal(result.project.ac.points,12)
  assert.equal(compileDrawing(result.project.drawing!).errors.length,0)
})

test('multiword titles use electrical syntax rather than a device-like first letter',()=>{
  for(const title of ['RC low pass filter','Voltage divider simulation test','Low pass filter simulation circuit','Imported voltage divider example']){
    const result=replay(`${title}\nV1 in 0 5\nR1 in out 1k\nR2 out 0 1k\n.op\n.end`)
    assert.equal(result.project.title,title)
    assert.deepEqual(result.project.drawing!.devices.filter(device=>device.kind!=='GND').map(device=>device.id),['V1','R1','R2'])
  }
})

test('bare first records retain explicit IDs and valid digit-free device syntax',()=>{
  for(const first of ['V_input in 0 5','V1 in 0 5','Vsource in 0 DC 5','Vsource in 0 SIN(0 1 1k)']){
    const result=replay(`${first}\nR_load in out 1k\nR_ground out 0 1k\n.op\n.end`)
    assert.equal(result.project.drawing!.devices.filter(device=>device.kind==='V').length,1)
    assert.ok(result.references[first.split(' ')[0].toLowerCase()])
  }
  for(const first of ['R_load in out 1k','Rload in out 1k']){
    const result=replay(`${first}\nV1 in 0 5\nR2 out 0 1k\n.op`)
    assert.ok(result.references[first.split(' ')[0].toLowerCase()])
    assert.equal(result.project.drawing!.devices.filter(device=>device.kind==='R').length,2)
  }
  const diode=replay('Dclamp out 0 vendord\nV1 in 0 5\nR1 in out 1k\n.model vendord D(IS=1n)\n.op')
  assert.ok(diode.references.dclamp)
  const subcircuit=replay('Xstage in out divider\nV1 in 0 5\nR1 out 0 1k\n.subckt divider a b\nRinside a b 1k\n.ends divider\n.op')
  assert.ok(subcircuit.references.xstage)
  assert.throws(()=>importSpiceDeck('Z1 in 0 unknown\nV1 in 0 1\nR1 in 0 1k\n.op'),/不支持的器件 Z1/)
})

test('ambiguous alphabetic model records require an explicit title and never disappear',()=>{
  assert.throws(()=>importSpiceDeck('Dclamp out 0 unavailable\nV1 in 0 5\nR1 in out 1k\n.op'),/首行.*Dclamp.*\.title.*未忽略/)
  assert.throws(()=>importSpiceDeck('.title Explicit circuit title\nDclamp out 0 unavailable\nV1 in 0 5\nR1 in out 1k\n.op'),/缺失.*model|模型/)
  const result=replay('.title Diode bridge rectifier circuit\nDclamp out 0 vendord\nV1 in 0 5\nR1 in out 1k\n.model vendord D(IS=1n)\n.op')
  assert.equal(result.project.title,'Diode bridge rectifier circuit');assert.ok(result.references.dclamp)
})

test('independent sources retain asymmetric pulse timing, PWL, DC and multiple AC amplitudes',()=>{
  const result=replay(`V1 in 0 DC 3 AC 2 90 PULSE(0 5 10u 2u 3u 40u 100u)
V2 gate 0 PWL(0 0 30u 2 100u 1)
I1 gate out DC 1m AC 0.1m -30
R1 in out 1k
R2 out 0 1k
.tran 1u 300u 5u 500n uic
.end`)
  const v1=result.project.drawing!.devices.find(d=>d.id==='V1')!,v2=result.project.drawing!.devices.find(d=>d.id==='V2')!
  assert.equal(sourceValues(v1).dc,3);assert.ok(Math.abs(sourceValues(v1).values.width-40e-6)<1e-15)
  assert.ok(Math.abs(sourceValues(v1).values.delay-10e-6)<1e-15);assert.equal(sourceValues(v1).acPhase,90)
  assert.equal(sourceValues(v2).points!.length,3)
  assert.ok(Math.abs(Number(result.project.tran.step)-5e-7)<1e-18);assert.ok(Math.abs(Number(result.project.tran.start)-5e-6)<1e-18)
  assert.match(result.netlist,/PULSE\(0 5 /)
})

test('diode, BJT and JFET simple models remain native, missing models never substitute',()=>{
  const result=replay(fixture(`R1 supply out 1k
Dfoo out 0 vendor_d
Qfoo supply out 0 vendor_q
Jfoo supply out 0 vendor_j
.model vendor_d D(IS=1n N=1.6)
.model vendor_q NPN(IS=1e-14 BF=120)
.model vendor_j NJF(VTO=-2 BETA=1m)`))
  assert.equal(result.project.models!.length,3)
  for(const kind of ['D','Q','J'])assert.ok(result.project.drawing!.devices.some(d=>d.kind===kind))
  assert.throws(()=>importSpiceDeck(fixture('D1 supply 0 missing_model')),/缺失.*model|模型/)
})

test('MOS bulk, W/L and diode instance parameters are exact adapters, including repeated terminals',()=>{
  const result=replay(fixture(`Vgate gate 0 2
R1 supply drain 1k
Morig drain gate 0 bulk vendor_m W=20u L=2u
Rbulk bulk 0 100
Dorig drain 0 vendor_d 2
.model vendor_m NMOS(LEVEL=1 VTO=1 KP=1m)
.model vendor_d D(IS=1n)`))
  const id=result.references.morig,part=result.project.drawing!.devices.find(d=>d.id===id)!
  assert.equal(part.kind,'X');assert.deepEqual(part.pins,['p1','p2','p3','p4'])
  assert.match(result.netlist,/Morig p1 p2 p3 p4 vendor_m W=20u L=2u/i)
  assert.match(result.netlist,new RegExp(`${id} drain gate 0 bulk DECK_DEVICE_`))
  assert.match(result.netlist,/Dorig p1 p2 vendor_d AREA=2/i)
})

test('parameterized nested PSpice subcircuits and global arithmetic preserve overrides',()=>{
  const result=replay(fixture(`.param base=1k gain={base/2}
R1 supply out {base*2}
Xorig out 0 DIV PARAMS: RES={gain}
.subckt DIV in ref PARAMS: RES=1k
Xinner in ref UNIT PARAMS: VALUE={RES}
.ends DIV
.subckt UNIT a b PARAMS: VALUE=1k
Rin a b {VALUE}
.ends UNIT`))
  assert.equal(result.project.drawing!.devices.find(d=>d.id==='R1')!.value,'2000')
  const part=result.project.drawing!.devices.find(d=>d.id===result.references.xorig)!
  assert.equal(part.params!.RES,'500')
  assert.match(result.netlist,/PARAMS: RES=500/)
  assert.throws(()=>importSpiceDeck(fixture('.param a={b} b={a}\nR1 supply 0 {a}')),/循环/)
  assert.throws(()=>importSpiceDeck(fixture('.param a={time+1}\nR1 supply 0 {a}')),/上下文/)
})

test('large valid libraries retain only referenced models and preserve recursive X dependency closures',()=>{
  const library=Array.from({length:140},(_,i)=>`.model VENDOR_D_${i} D(IS=1n N=1.6)`).join('\n')
  const diode=replay(fixture(`R1 supply out 1k\nD1 out 0 VENDOR_D_139\n${library}`))
  assert.deepEqual(diode.project.models!.map(model=>model.id),['VENDOR_D_139'])
  assert.match(diode.netlist,/\.model VENDOR_D_139 D\(/)
  assert.doesNotMatch(diode.netlist,/\.model VENDOR_D_0 D\(/)
  assert.ok(diode.warnings.some(warning=>warning.includes('139 个未引用模型')))

  const nested=replay(fixture(`R1 supply out 1k
X1 out 0 OUTER PARAMS: AREA=2
.subckt OUTER a b PARAMS: AREA=1
Xinner a b INNER PARAMS: SCALE={AREA}
.ends OUTER
.subckt INNER a b PARAMS: SCALE=1
Dinner a b VENDOR_D_139 {SCALE}
.ends INNER
${library}`))
  assert.deepEqual(nested.project.models!.map(model=>model.id),['OUTER'])
  assert.match(nested.netlist,/\.subckt OUTER a b PARAMS: AREA=1/i)
  assert.match(nested.netlist,/\.subckt INNER a b PARAMS: SCALE=1/i)
  assert.match(nested.netlist,/\.model VENDOR_D_139 D\(/)
  assert.doesNotMatch(nested.netlist,/\.model VENDOR_D_0 D\(/)
  assert.ok(nested.warnings.some(warning=>warning.includes('139 个未引用模型')))

  // Selection does not hide an invalid unused record from strict validation.
  assert.throws(()=>importSpiceDeck(fixture(`D1 supply 0 VENDOR_D_139\n${library}\n.model UNUSED_BAD D(UNKNOWN=2)`)),/UNUSED_BAD.*UNKNOWN/)
})

test('all supported analysis instructions persist as validated profiles',()=>{
  const result=replay(`V1 in 0 DC 1 AC 1
R1 in out 1k
C1 out 0 100n
.options reltol=1e-4 method=gear
.temp 40
.ic v(out)=0.1
.nodeset v(in)=1
.op
.ac dec 20 10 100k
.tran 1u 1m
.dc V1 -1 1 0.1
.noise v(out) V1 dec 10 10 100k 5
.probe V(out)
.backanno
.end`)
  const profiles=result.project.waveformSetup!.profiles.profiles
  assert.deepEqual(profiles.map(p=>p.settings.analysis),['op','ac','tran','dc','noise'])
  for(const profile of profiles){const p=parseProject(applySimulationProfile(result.project,profile));assert.equal(p.temperature,40);assert.equal(p.solver!.method,'gear');assert.ok(generateNetlist(p))}
  assert.equal(profiles[4].settings.noise!.summaryInterval,5)
  assert.ok(result.warnings.some(w=>w.includes('.probe')))
})

test('linear E/G and behavioral voltage-node dependencies keep all ordered external nets',()=>{
  const result=replay(fixture(`Ecopy out 0 supply 0 0.5
Gcopy out 0 supply 0 1m
Bcopy signal 0 V={v(supply,out)*2}
R1 out 0 1k
R2 signal 0 1k`))
  assert.match(result.netlist,/Ecopy p1 p2 p3 p4 0.5/)
  assert.match(result.netlist,/Gcopy p1 p2 p3 p4 0.001/)
  assert.match(result.netlist,/Bcopy p1 p2 V=\{\(v\(p3,p4\)\*2\)\}/i)
  assert.throws(()=>importSpiceDeck(fixture('F1 supply 0 V_supply 2')),/外部控制/)
  const shadow=replay(fixture('.param out=9\nB1 signal 0 V={v(out)*out}\nR1 supply out 1k\nR2 out 0 1k\nR3 signal 0 1k'))
  assert.match(shadow.netlist,/v\(p3\)\*9/)
  assert.match(shadow.netlist,/X1 signal 0 out DECK_DEVICE_/)
})

test('semantically unsupported files fail with exact diagnostics without defaults',()=>{
  for(const [body,reason]of [
    ['.include "missing.lib"\nR1 supply 0 1k',/include.*外部|外部模型/],
    ['.step param r list 1k 2k\nR1 supply 0 1k',/\.step/],
    ['R1 supply 0 1k\nR1 supply 0 2k',/编号 R1 重复/],
    ['V1 node 0 PULSE(0 1)\nR1 node 0 1k',/PULSE.*七项/],
    ['X1 supply 0 missing_subckt',/缺失.*subckt/],
    ['.model vendor_d D(IS=1n UNKNOWN=2)\nD1 supply 0 vendor_d',/UNKNOWN/],
  ] as const)assert.throws(()=>importSpiceDeck(fixture(body)),reason)
  assert.throws(()=>importSpiceDeck('I1 in 0 1m\nR1 in 0 1k\n.op'),/负端.*电压源/)
  assert.throws(()=>importSpiceDeck('Z1 in 0 unknown\nV1 in 0 1\nR1 in 0 1k\n.op'),/不支持的器件 Z1/)
})

test('passive adapters retain small resistance, initial conditions and LTspice inductor parasitics',()=>{
  const result=replay(fixture('R1 supply out 1M\nC1 out 0 1u IC=0.25\nL1 supply out 1m Rser=0.1 Rpar=1k Cpar=1p'))
  assert.equal(result.project.drawing!.devices.find(d=>d.id===result.references.r1)!.kind,'X')
  assert.match(result.netlist,/R1 p1 p2 1M/i);assert.match(result.netlist,/C1 p1 p2 1u IC=0.25/i)
  assert.match(result.netlist,/R__fx_pass_ser_/)
})

test('sine delay, phase and implicit operating point are retained',()=>{
  const result=replay('V1 in 0 SIN(1 2 1k 10u 0 30)\nR1 in 0 1k\n.tran 1u 1m\n.end')
  assert.ok(Math.abs(sourceValues(result.project.drawing!.devices[0]).dc-2)<1e-12)
  assert.match(result.netlist,/SIN\(1 2 1000 0.000009999999999999999 0 30\)/)
})

test('imported diode, BJT, MOS and nested subcircuit solve with real ngspice after saved replay',{timeout:120000},async()=>{
  for(const body of [
    'R1 supply out 1k\nD1 out 0 vendor_d\n.model vendor_d D(IS=1n N=1.6)',
    'Rb supply base 100k\nRc supply out 1k\nQ1 out base 0 vendor_q\n.model vendor_q NPN(IS=1e-14 BF=100)',
    'Vgate gate 0 2\nR1 supply out 1k\nM1 out gate 0 0 vendor_m W=20u L=2u\n.model vendor_m NMOS(LEVEL=1 VTO=1 KP=1m)',
    'X1 supply out 0 DIV PARAMS: RR=1k\n.subckt DIV a out g PARAMS: RR=2k\nRtop a out {RR}\nXbot out g UNIT\n.ends DIV\n.subckt UNIT a g\nRbot a g 1k\n.ends UNIT',
  ]){
    const imported=replay(fixture(body)),result=await simulateAgentCircuit(imported.project,AbortSignal.timeout(25000))
    assert.match(result.engine,/ngspice/);assert.equal(result.points,1);assert.ok(Number.isFinite(result.vout[0]))
    assert.ok(result.vout[0]>=0&&result.vout[0]<=5)
  }
})
