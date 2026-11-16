import assert from 'node:assert/strict'
import test from 'node:test'
import { generateNetlist, type Project } from '../src/core/circuit'
import { editorTemplate } from '../src/core/editor'
import { createProjectArchive, readProjectFile } from '../src/core/project-file'
import { reviewProjectShare } from '../src/core/project-share'
import { initialSimulationProfiles } from '../src/core/simulation-profiles'
import { parseSpiceLibrary } from '../src/core/spice-models'
import { simulate } from './simulate'

const source = {label:'合成模型测试库', license:'MIT', attribution:'测试作者'}
const rootModel = `.subckt TEST_CELL IN OUT
Xhelper IN OUT TEST_RES
.ends TEST_CELL`
const closure = `.subckt TEST_RES P N
Rinside P N 1.6k
.ends TEST_RES
` + rootModel

function example(): Project {
  const project = editorTemplate('rc-lowpass')
  project.title = '含原符号的 RC 工程'
  const model = parseSpiceLibrary(closure,source).models.find(model=>model.id==='TEST_CELL')!
  assert.ok(model)
  model.symbol = { version:1, origin:'imported', shape:'ltspice', title:'测试原符号',
    pins:[{index:0,label:'VIN',number:'3',x:-40,y:0},{index:1,label:'VOUT',number:'1',x:40,y:0}],
    geometry:[{type:'rectangle',coords:[-30,-15,30,15]}] }
  const unused = parseSpiceLibrary('.model ONLY_IN_EDITOR D (IS=1e-12)',{label:'不需要随工程携带'}).models[0]
  assert.ok(unused)
  project.models = [model,unused]
  const drawing = project.drawing!
  drawing.devices = drawing.devices.map(device=>device.id==='R1'
    ? {...device,id:'X1',kind:'X',value:model.id,pins:[...model.pins],pinPositions:model.symbol!.pins.map(({x,y})=>({x:x!,y:y!}))}
    : device)
  drawing.wires = drawing.wires.map(wire=>{
    const rename=(at:typeof wire.from)=>'device' in at && at.device==='R1'?{...at,device:'X1'}:at
    return {...wire,from:rename(wire.from),to:rename(wire.to)}
  })
  const profiles = initialSimulationProfiles(project)
  profiles.profiles.push({id:'time',name:'瞬态',settings:{...structuredClone(profiles.profiles[0].settings),analysis:'tran'}})
  project.waveformSetup = {version:1,profiles,diagrams:[{id:'shared',title:'输出响应',profileId:'default',x:180,y:520,width:480,height:300}]}
  return project
}

async function reopen(project: Project, name: string) {
  const bytes=createProjectArchive(project)
  return (await readProjectFile({name,size:bytes.length,arrayBuffer:async()=>new Uint8Array(bytes).buffer,text:async()=>''})).project
}

test('review keeps a used subcircuit with transitive definitions, symbol, and provenance; the reopened v1 archive reproduces the AC result',async()=>{
  const project=example(), original=structuredClone(project)
  const report=reviewProjectShare(project)
  assert.equal(report.status,'ready',JSON.stringify(report.issues))
  assert.deepEqual(report.models,[{
    id:'TEST_CELL',mode:'embedded',devices:['X1'],source,symbol:'内嵌原始符号',ports:['IN','OUT'],subcircuits:['TEST_RES','TEST_CELL'],
  }])
  assert.equal(report.unusedModels,1)
  assert.equal(report.profiles.length,2)
  assert.equal(report.waveformCount,1)
  const received=await reopen(report.project,report.filename)
  assert.deepEqual(received.models!.map(model=>model.id),['TEST_CELL'])
  assert.deepEqual(received.models![0].symbol,original.models![0].symbol)
  assert.deepEqual(received.waveformSetup,original.waveformSetup)
  assert.equal(generateNetlist(received),generateNetlist(project))
  const result=await simulate(received)
  assert.ok(result.x.length>100)
  assert.ok(Math.abs(result.magnitude![0])<.001,'RC response at 10Hz matches the near-unity pass band')
  assert.ok(result.magnitude!.at(-1)! < -35,'RC response at 100kHz matches the stop band')
  assert.deepEqual(project,original)
})

test('missing models or mismatched electrical port order are explicit draft issues and reopen as editable projects',async()=>{
  const project=example(), drawing=project.drawing!
  const chip=drawing.devices.find(device=>device.id==='X1')!
  chip.pins=['OUT','IN']
  let report=reviewProjectShare(project)
  assert.equal(report.status,'draft')
  assert.match(report.issues.find(issue=>issue.kind==='pin-interface')!.detail,/OUT → IN.*IN → OUT/)
  assert.match(report.filename,/\.draft\.fuxian$/)
  assert.deepEqual((await reopen(report.project,report.filename)).drawing!.devices.find(device=>device.id==='X1')!.pins,['OUT','IN'])
  chip.value='UNAVAILABLE_PART'
  report=reviewProjectShare(project)
  assert.equal(report.status,'draft')
  assert.deepEqual(report.models.map(model=>[model.id,model.mode]),[['UNAVAILABLE_PART','missing']])
  assert.match(report.issues.find(issue=>issue.kind==='missing-model')!.detail,/UNAVAILABLE_PART/)
  assert.equal((await reopen(report.project,report.filename)).drawing!.devices.find(device=>device.id==='X1')!.value,'UNAVAILABLE_PART')
})

test('the preflight names external libraries and missing helper subcircuits without loading them',()=>{
  const project=example(), model=project.models![0]
  model.spice='.include "D:/厂商模型/辅助.lib"\n'+model.spice
  let report=reviewProjectShare(project)
  assert.equal(report.status,'blocked')
  assert.deepEqual(report.issues.find(issue=>issue.kind==='external-library'),{
    kind:'external-library',subject:'TEST_CELL · 第 1 行',detail:'.include "D:/厂商模型/辅助.lib"',
  })
  model.spice=rootModel
  report=reviewProjectShare(project)
  assert.equal(report.status,'blocked')
  assert.match(report.issues.find(issue=>issue.kind==='model-definition')!.detail,/缺失的 .subckt TEST_RES/)
})

test('an unusable saved waveform association is flagged even when the circuit netlist is valid',async()=>{
  const project=example()
  project.waveformSetup!.diagrams[0].profileId='removed-profile'
  assert.ok(generateNetlist(project))
  const report=reviewProjectShare(project)
  assert.equal(report.status,'draft')
  assert.match(report.issues.find(issue=>issue.kind==='configuration'&&issue.subject==='输出响应')!.detail,/removed-profile/)
  assert.equal((await reopen(report.project,report.filename)).waveformSetup!.diagrams[0].profileId,'removed-profile')
})
