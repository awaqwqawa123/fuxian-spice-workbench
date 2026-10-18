/** Live read-only audit. Vendor sources stay in memory, never in the repository. */
import assert from 'node:assert/strict'
import { Simulation } from 'eecircuit-engine'
import { createOnlineModelService, fetchModelText } from '../server/model-search'
import { parseImportedModels } from '../src/core/spice-models'

// Exercise fixed indexes while independently testing the actual immutable
// download path. External product-search failures cannot hide this audit.
const service=createOnlineModelService(async(url,limit)=>{
  if(url.endsWith('/git/trees/master?recursive=1'))throw new Error('Live tree deliberately disabled: verify pinned offline search')
  return fetchModelText(url,limit)
})
const found=await service.search('150060RS73220')
const candidate=found.candidates.find(item=>item.source.url?.includes('/WurthElektronik/LTspice-Library/')&&item.path==='sub/WL-SMCC.lib')
assert.ok(candidate,'actual part must be found inside the official generic filename')
const preview=await service.download(candidate.id)
assert.equal(preview.diagnostics.filter(item=>item.severity==='error').length,0)
const model=preview.models.find(item=>item.id==='0603_150060RS73220')
assert.ok(model);assert.deepEqual(model.pins,['1','2'])
assert.deepEqual(parseImportedModels([model]),[model])
const simulator=new Simulation();await simulator.start()
simulator.setNetList(`Official LED model audit\nV1 IN 0 5\nR1 IN LED 1k\nX1 LED 0 ${model.id}\n${model.spice}\n.op\n.save V(LED)\n.end`)
const result=await simulator.runSim()
assert.deepEqual(simulator.getError(),[])
const voltage=result.data.find(vector=>vector.name.toLowerCase()==='v(led)')
assert.ok(voltage&&voltage.values.every(Number.isFinite))
assert.equal(typeof voltage.values[0],'number')
if(typeof voltage.values[0]!=='number')throw new Error('Expected real DC output')
assert.ok(voltage.values[0]>1&&voltage.values[0]<3.5,'a red LED must conduct at this chosen DC test point')
const controllerResults=await service.search('CD4047B')
const controller=controllerResults.candidates.find(item=>item.path.endsWith('/cd4047b.spi'))
assert.ok(controller,'previously omitted .spi declaration is searchable')
const rejected=await service.download(controller.id)
assert.ok(rejected.diagnostics.some(item=>item.severity==='error'),'LTspice-specific logic must remain visibly unsupported')
assert.equal(rejected.models.length,0)
console.log(JSON.stringify({
  official:{part:'150060RS73220',candidate:candidate.source.url,modelsInFile:preview.models.length,selected:model.id,pins:model.pins,dcVolts:voltage.values[0],errors:simulator.getError()},
  unsupported:{part:'CD4047B',candidate:controller.source.url,imported:rejected.models.length,errors:rejected.diagnostics.filter(item=>item.severity==='error').slice(0,3).map(item=>item.message)},
},null,2))
