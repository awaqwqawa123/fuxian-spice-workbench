import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseQuantity } from '../src/core/circuit'

// Run after the real browser conversation and service restart. This inspects only
// the explicitly selected lab session; it never starts a model turn.
const [baseUrl, sessionId, expectedThread, expectedMarker] = process.argv.slice(2)
assert.ok(baseUrl && sessionId && expectedThread && expectedMarker,
  'Usage: tsx scripts/verify-codex-session-loop.ts <local-origin> <session-id> <thread-id> <memory-marker>')
const origin = new URL(baseUrl)
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
const response = await fetch(new URL(`/api/codex-session/state?id=${encodeURIComponent(sessionId)}`, origin), {
  headers: { Origin: origin.origin, 'X-Fuxian-Session': '1' }, signal: AbortSignal.timeout(10000),
})
assert.equal(response.status, 200)
const state = await response.json() as any
assert.equal(state.id, sessionId)
assert.equal(state.threadId, expectedThread, 'The original official thread must survive the service restart')
assert.equal(state.status, 'completed')
assert.equal(state.reasoningEffort, 'medium')
const userMessages = state.messages.filter((item: any) => item.role === 'user')
const replies = state.messages.filter((item: any) => item.role === 'assistant')
assert.ok(userMessages.length >= 3 && replies.length >= 3, 'Expected three completed real conversation turns')
assert.ok(userMessages[0].content.includes(expectedMarker))
assert.ok(userMessages.slice(1).every((item: any) => !item.content.includes(expectedMarker)), 'Later prompts must not repeat the memory marker')
assert.ok(replies[1].content.includes(expectedMarker), 'Second turn must recall the first-turn marker')
assert.ok(replies.at(-1).content.includes(expectedMarker), 'Post-restart turn must still recall the marker')
const simulation = state.result?.simulation
assert.ok(simulation && /ngspice/i.test(simulation.engine))
assert.equal(simulation.analysis, 'ac')
assert.ok(simulation.points >= 100 && simulation.samples.length >= 8)
assert.equal(simulation.stale, false)
const project = state.result.project
const r = parseQuantity(project.drawing.devices.find((item: any) => item.id === 'R1').value, 'resistance')
const c = parseQuantity(project.drawing.devices.find((item: any) => item.id === 'C1').value, 'capacitance')
assert.equal(r, 1600, 'This verification requests no component changes')
assert.ok(Math.abs(c - 1e-7) < 1e-16)
const sampleChecks = simulation.samples.map((sample: any) => {
  const omegaRc = 2 * Math.PI * sample.x * r * c
  const expectedGainDb = -10 * Math.log10(1 + omegaRc ** 2)
  const expectedPhaseDeg = -Math.atan(omegaRc) * 180 / Math.PI
  assert.ok(Math.abs(sample.gainDb - expectedGainDb) < 0.05, `Gain mismatch at ${sample.x} Hz`)
  assert.ok(Math.abs(sample.phaseDeg - expectedPhaseDeg) < 0.05, `Phase mismatch at ${sample.x} Hz`)
  return { frequencyHz: sample.x, gainDb: sample.gainDb, expectedGainDb, phaseDeg: sample.phaseDeg, expectedPhaseDeg }
})
assert.ok(state.events.some((event: any) => event.name === 'simulate_circuit' && event.status === 'completed'))
const evidence = {
  verifiedAt: new Date().toISOString(), sessionId, threadId: state.threadId,
  model: state.model, reasoningEffort: state.reasoningEffort,
  userTurns: userMessages.length, assistantTurns: replies.length,
  memoryBeforeRestart: replies[1].content, memoryAndExplanationAfterRestart: replies.at(-1).content,
  simulation: { engine: simulation.engine, analysis: simulation.analysis, points: simulation.points,
    elapsedMs: simulation.elapsedMs, theoreticalCutoffHz: 1 / (2 * Math.PI * r * c), sampleChecks },
  scope: 'Persistent workbench Codex session; this does not establish attachment to the original desktop conversation.',
}
await mkdir(resolve('verification'), { recursive: true })
const output = resolve('verification/v0.19.2-real-session-loop.json')
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ verified: true, threadId: state.threadId, turns: replies.length,
  engine: simulation.engine, points: simulation.points, checkedSamples: sampleChecks.length, output }))
