import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { createCircuitAgentTools } from '../src/core/agent-circuit'
import { type DesktopCircuitSnapshot } from '../src/core/desktop-circuit'
import { generateNetlist, parseProject, validateProject } from '../src/core/circuit'
import { schematicSvg } from '../src/core/export-svg'
import { simulateAgentCircuit } from '../server/agent-simulation'
import type { Measurement } from '../src/core/probes'

const directory=new URL('../docs/artifacts/2026-09-25-measurement-probes/',import.meta.url)
const snapshot:DesktopCircuitSnapshot=JSON.parse(await readFile(new URL('baseline-snapshot.json',directory),'utf8'))
assert.equal(snapshot.projectId,'2bfea8f7-2a8b-4770-a96f-3714965cc578')
const baseline=snapshot.project
const source=JSON.parse(await readFile(new URL('source-candidate.json',directory),'utf8')) as typeof baseline
const withoutOutput=(project:typeof source)=>({...project,drawing:{...project.drawing!,output:null}})
assert.deepEqual(withoutOutput(source),withoutOutput(baseline),'Preserve the latest gate-output intention, with no other circuit changes')
const probes:Measurement[]=[
  {id:'P1',kind:'voltage',positive:{device:'M1',pin:1}},
  {id:'P2',kind:'voltage',positive:{device:'M1',pin:0}},
  {id:'P3',kind:'current',device:'R1'},
]
const tools=createCircuitAgentTools(baseline,{initialCandidate:source,signal:new AbortController().signal,simulate:simulateAgentCircuit})
await tools.execute('set_measurement_probes',{probes})
const candidate=tools.candidate
assert.deepEqual(validateProject(candidate),[])
assert.equal(generateNetlist(candidate),generateNetlist(source),'Placing probes cannot alter the netlist')
assert.deepEqual(parseProject(JSON.parse(JSON.stringify(candidate))).probes,candidate.probes)
await tools.execute('simulate_circuit',{})
assert.equal(tools.simulation!.probes?.length,3)
assert.deepEqual(tools.simulation!.unavailableProbes,[])
const svg=schematicSvg(candidate.drawing!,{title:candidate.title,models:candidate.models,probes:candidate.probes})
assert.ok(!svg.includes('正弦'))
await writeFile(new URL('candidate.svg',directory),svg)
await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL('candidate.png',directory)))
await writeFile(new URL('baseline-snapshot.json',directory),JSON.stringify(snapshot,null,2))
await writeFile(new URL('candidate-project.json',directory),JSON.stringify(candidate,null,2))
await writeFile(new URL('replace-input.json',directory),JSON.stringify({project:candidate},null,2))
await writeFile(new URL('probe-input.json',directory),JSON.stringify({probes:candidate.probes},null,2))
await writeFile(new URL('simulation.json',directory),JSON.stringify(tools.simulation,null,2))
console.log(JSON.stringify({revision:snapshot.revision,probes:candidate.probes,simulation:tools.simulation!.probes?.map(({id,name,unit,last})=>({id,name,unit,last})),engine:tools.simulation!.engine,points:tools.simulation!.points},null,2))
