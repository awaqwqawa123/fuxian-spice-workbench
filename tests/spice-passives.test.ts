import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { normalizePassiveComponents } from '../src/core/spice-passives'
import { importedModelNetlist, parseImportedModels, parseSpiceLibrary } from '../src/core/spice-models'
import type { RawNetlistResult } from '../src/core/raw-netlist'

const source={label:'Passive compatibility regression',url:'https://example.org/original.lib',attribution:'Vendor original retained'}
function imported(text:string){
  const preview=parseSpiceLibrary(text,source)
  assert.deepEqual(preview.diagnostics.filter(d=>d.severity==='error'),[])
  assert.equal(preview.models.length,1)
  const model=preview.models[0]
  model.symbol={version:1,shape:'box',title:'Original terminals',pins:model.pins.map((label,index)=>({label,index}))}
  const restored=parseImportedModels(JSON.parse(JSON.stringify([model])))[0]
  assert.deepEqual(restored.pins,model.pins)
  assert.deepEqual(restored.symbol,model.symbol)
  assert.deepEqual(restored.source,source)
  assert.deepEqual(restored,model)
  return restored
}
function solve(netlist:string):Promise<RawNetlistResult>{
  const assets=new URL('../dist/assets/',import.meta.url),bundle=readdirSync(assets).find(name=>/^raw-netlist\.worker-.*\.js$/.test(name))!
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{bundle:new URL(bundle,assets).href}})
    let settled=false
    const timer=setTimeout(()=>finish(new Error('Passive regression timed out')),30000)
    function finish(error?:Error,result?:RawNetlistResult){if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();error?reject(error):resolve(result!)}
    worker.on('message',m=>{if(m.type==='ready')worker.postMessage({netlist});if(m.type==='result')finish(undefined,m.result);if(m.type==='error')finish(new Error(m.message))})
    worker.on('error',error=>finish(error instanceof Error?error:new Error(String(error))));worker.on('exit',code=>{if(!settled)finish(new Error(`Worker exited ${code}`))})
  })
}
function close(actual:number,expected:number){assert.ok(Math.abs(actual-expected)<=Math.max(1e-12,Math.abs(expected)*1e-7),`${actual} != ${expected}`)}

test('all vendor TC pair spellings retain both coefficients and migrate old saved records',()=>{
  for(const tail of ['TC=.001,.00001','TC=.001 .00001','TC= (.001) (.00001)','TC=.001 (+.00001)','TC1=.001, .00001','TC1=.001 .00001']){
    const original=`.subckt TEMP_R A B\nR1 A B 1k ${tail}\n.ends TEMP_R`
    const model=imported(original)
    assert.match(model.spice,/TC1=\.001 TC2=\+?\.00001/)
    const legacy={...model,spice:original}
    assert.deepEqual(parseImportedModels([legacy]),[model])
    assert.equal(importedModelNetlist(legacy),importedModelNetlist(model))
  }
  assert.deepEqual(normalizePassiveComponents(['R1 a b 1k TC=.001']),['R1 a b 1k TC1=.001'])
  assert.deepEqual(normalizePassiveComponents(['RR4 0 1 1.000000K TC1=0 0']),['RR4 0 1 1.000000K TC1=0 TC2=0'])
  for(const tail of ['TC=0 TC1=1','TC=0,0 TC2=1','TC=0 TC=1','TC=unknown','TC=1garbage,2','TC=0 0"','TC1=0 0"','TC1=0 TC2=0"','TC=0 0 0','TC2=0 0'])assert.throws(()=>normalizePassiveComponents([`R1 a b 1k ${tail}`]))
})

test('real ngspice temperature response preserves resistor and capacitor coefficients, sign and reference temperature',async()=>{
  const r=imported('.subckt TEMP_R A B\nR1 A B 1k TC1=-.001 (-.00001)\n.ends TEMP_R')
  const c=imported('.subckt TEMP_C A B\nC1 A B 1u TC=.001 .00001\n.ends TEMP_C')
  for(const temperature of [17,27,37]){
    const d=temperature-27
    const resistor=await solve(`R temperature\nV1 in 0 1\nX1 in 0 TEMP_R\n${importedModelNetlist(r)}\n.temp ${temperature}\n.save i(v1)\n.op\n.end`)
    assert.deepEqual(resistor.warnings,[])
    close(resistor.vectors.find(v=>v.name==='i(v1)')!.values[0],-1/(1000*(1-.001*d-.00001*d*d)))
    const capacitor=await solve(`C temperature\nV1 in 0 DC 0 AC 1\nX1 in 0 TEMP_C\n${importedModelNetlist(c)}\n.temp ${temperature}\n.save i(v1)\n.ac lin 1 1000 1000\n.end`)
    assert.deepEqual(capacitor.warnings,[])
    close(capacitor.vectors.find(v=>v.name==='i(v1)')!.imaginary![0],-2*Math.PI*1000*1e-6*(1+.001*d+.00001*d*d))
  }
})

test('AWBEXP malformed source TC is rejected rather than partially converted; valid zero TC1 pair runs',async()=>{
  const original='RR4 0 1 1.000000K TC=0 0"'
  const preview=parseSpiceLibrary(`.subckt AWBEXP 2 1\n${original}\n.ends AWBEXP`,source)
  assert.equal(preview.models.length,0)
  assert.ok(preview.diagnostics.some(d=>/温度系数或其后参数不完整/.test(d.message)))
  const model=imported('.subckt ZERO_TC A B\nR1 A B 1k TC1=0 0\n.ends ZERO_TC')
  const result=await solve(`Zero TC1 pair\nV1 in 0 1\nX1 in 0 ZERO_TC\n${importedModelNetlist(model)}\n.temp 127\n.save i(v1)\n.op\n.end`)
  assert.deepEqual(result.warnings,[])
  close(result.vectors.find(v=>v.name==='i(v1)')!.values[0],-.001)
})

const vendorFile=process.env.SPICE_OWNED_MODEL_LIBRARY_DIR?join(process.env.SPICE_OWNED_MODEL_LIBRARY_DIR,'vendor','pspice','tools','pspice','library','function.lib'):undefined
test('actual AWBEXP original retains its orphan quote and is excluded with an explicit diagnostic',{skip:!vendorFile||!existsSync(vendorFile)},()=>{
  const text=readFileSync(vendorFile!,'utf8'),block=text.match(/^\.SUBCKT AWBEXP\b[\s\S]*?^\.ENDS AWBEXP\s*$/im)?.[0]
  assert.ok(block)
  assert.match(block,/RR4 0 1 1\.000000K TC=0 0"/)
  const preview=parseSpiceLibrary(block,{...source,label:'Original function.lib / AWBEXP'})
  assert.equal(preview.models.length,0)
  assert.ok(preview.diagnostics.some(d=>d.model==='AWBEXP'&&/温度系数或其后参数不完整/.test(d.message)))
  assert.throws(()=>importedModelNetlist({id:'AWBEXP',kind:'X',type:'SUBCKT',name:'AWBEXP',detail:'',spice:block,source,metadata:{},pins:['2','1']}),/温度系数或其后参数不完整/)
})

test('inductor parasitics preserve exact equivalent-circuit impedance, multiplier and original L references',async()=>{
  const original='.subckt COIL A B\nL1 A B 1m Rser=2 Rpar=100 Cpar=1u M=2\n.ends COIL'
  const model=imported(original)
  assert.match(model.spice,/L1 A __fx_pass_node_\d+ 1m M=2/)
  assert.equal(parseImportedModels([{...model,spice:original}])[0].spice,model.spice)
  const ac=await solve(`Coil impedance\nV1 in 0 DC 0 AC 1\nX1 in 0 COIL\n${importedModelNetlist(model)}\n.save i(v1)\n.ac lin 1 1000 1000\n.end`)
  assert.deepEqual(ac.warnings,[])
  const w=2*Math.PI*1000,l=w*.001,denom=4+l*l
  close(ac.vectors.find(v=>v.name==='i(v1)')!.values[0],-2*(2/denom+1/100))
  close(ac.vectors.find(v=>v.name==='i(v1)')!.imaginary![0],-2*(-l/denom+w*1e-6))
  const coupled=imported('.subckt COUP A B C D\nL1 A B 1m Rser=2\nL2 C D 4m Rser=3\nK1 L1 L2 .9\n.ends COUP')
  assert.match(coupled.spice,/K1 L1 L2 \.9/)
  const response=await solve(`Coupled coil\nV1 in 0 DC 0 AC 1\nX1 in 0 out 0 COUP\nRload out 0 1000\n${importedModelNetlist(coupled)}\n.save v(out)\n.ac lin 1 1000 1000\n.end`)
  assert.deepEqual(response.warnings,[])
  // Independently calculate Z21*RL / (Z11*(RL+Z22)-Z12*Z21).
  const z11r=2,z11i=w*.001,z22r=1003,z22i=w*.004,mutual=w*.9*.002
  const dr=z11r*z22r-z11i*z22i+mutual*mutual,di=z11r*z22i+z11i*z22r
  close(response.vectors.find(v=>v.name==='v(out)')!.values[0],mutual*1000*di/(dr*dr+di*di))
  close(response.vectors.find(v=>v.name==='v(out)')!.imaginary![0],mutual*1000*dr/(dr*dr+di*di))
})

test('fixed zero parasitics are disabled; uncertain zero conditions and unsupported physics are rejected',()=>{
  const model=imported('.subckt ZERO A B\nL1 A B 1m Rser=0 Rpar={RP} Cpar={CP}\n.param RP=0 CP=0\n.ends ZERO')
  assert.match(model.spice,/L1 A B 1m\n/)
  assert.doesNotMatch(model.spice,/__fx_pass_/)
  const positive=imported('.subckt POSITIVE A B\nL1 A B 1m Rpar={RP}\n.param RP=100\n.ends POSITIVE')
  assert.match(positive.spice,/R__fx_pass_par_\d+ A B \{RP\}/i)
  for(const body of ['L1 A B 1m Rser=-1','L1 A B 1m Rpar=-1','L1 A B 1m Cpar=-1','L1 A B 1m Rser=1 Flux=2']){
    const preview=parseSpiceLibrary(`.subckt BAD A B\n${body}\n.ends BAD`,source)
    assert.equal(preview.models.length,0)
    assert.ok(preview.diagnostics.some(d=>d.severity==='error'))
  }
  for(const parasitic of ['Rpar','Rser']){
    const preview=parseSpiceLibrary(`.subckt BAD A B PARAMS: RP=100\nL1 A B 1m ${parasitic}={RP}\n.ends BAD`,source)
    assert.equal(preview.models.length,0)
    assert.ok(preview.diagnostics.some(d=>/关闭条件/.test(d.message)))
  }
  const collision=normalizePassiveComponents(['.subckt C A B','R__fx_pass_ser_2 A __fx_pass_node_1 1','L1 A B 1m Rser=1','.ends C'])
  assert.equal(new Set(collision.filter(line=>/^[RLC]/i.test(line)).map(line=>line.split(/\s+/)[0].toLowerCase())).size,3)
})
