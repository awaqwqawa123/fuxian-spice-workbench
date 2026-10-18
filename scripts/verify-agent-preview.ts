// Run after building and starting Vite preview:
// node --import tsx scripts/verify-agent-preview.ts http://localhost:3031
// Only the local fixture is contacted as a model; no account credentials are used.
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { editorTemplate } from '../src/core/editor'
import { parseProject } from '../src/core/circuit'
import { listenOnSafeLoopbackPort } from '../server/safe-loopback-port'

const fixtureKey = 'preview-smoke-local-fixture-only'
const target = new URL(process.argv[2] ?? 'http://localhost:3031')
if (!['http:', 'https:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  || target.username || target.password || target.search || target.hash || target.pathname !== '/') {
  throw new Error('Pass the origin of an already running local Vite preview, such as http://localhost:3031')
}

function sendModelStream(res: ServerResponse, tool?: { name: string; arguments: string }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
  const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
    id: 'preview-smoke-completion', object: 'chat.completion.chunk', created: 1, model: 'preview-smoke-model',
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`
  res.write(frame(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${tool.name}`, type: 'function', function: tool }] }
    : { role: 'assistant', content: '候选 R1 已改为 2k，已读取真实 ngspice 仿真结果。' }, null))
  res.end(frame({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n')
}

async function main() {
  let modelRequests = 0, toolNames: string[] = [], fixtureFailure: Error | undefined
  let returnedMeasurement: { engine: string; points: number } | undefined
  const fixture = createServer((req, res) => {
    void (async () => {
      let body = ''; for await (const chunk of req) body += chunk
      assert.equal(req.url, '/v1/chat/completions', 'Preview must use the local model fixture route')
      assert.equal(req.headers.authorization, `Bearer ${fixtureKey}`, 'Preview must forward the test-only fixture credential')
      const payload = JSON.parse(body)
      assert.equal(payload.stream, true, 'DSH must request actual streamed model responses')
      const step = ++modelRequests
      if (step === 1) {
        toolNames = payload.tools.map((tool: { function: { name: string } }) => tool.function.name).sort()
        assert.deepEqual(toolNames, ['inspect_circuit', 'replace_candidate', 'set_component_value', 'simulate_circuit', 'validate_circuit'])
        sendModelStream(res, { name: 'inspect_circuit', arguments: '{}' })
      } else if (step === 2) sendModelStream(res, { name: 'set_component_value', arguments: '{"deviceId":"R1","value":"2k"}' })
      else if (step === 3) sendModelStream(res, { name: 'simulate_circuit', arguments: '{}' })
      else {
        assert.equal(step, 4, 'A bounded read/edit/simulate/final tool loop should use four model requests')
        const measurement = payload.messages.filter((message: { role: string }) => message.role === 'tool')
          .map((message: { content: string }) => JSON.parse(message.content))
          .find((result: { engine?: unknown }) => typeof result.engine === 'string' && /ngspice/i.test(result.engine))
        assert.ok(measurement && measurement.points > 5, 'The model must receive real ngspice measurements before finalizing')
        returnedMeasurement = { engine: measurement.engine, points: measurement.points }
        sendModelStream(res)
      }
    })().catch(error => {
      fixtureFailure = error instanceof Error ? error : new Error(String(error))
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Local fixture assertion failed' } }))
    })
  })
  const port = await listenOnSafeLoopbackPort(fixture)
  const project = parseProject(editorTemplate('rc-lowpass'), { allowDraft: true })
  const original = JSON.stringify(project)
  try {
    // Intentionally omit mode to exercise the same default as the Agent UI.
    const response = await fetch(new URL('/api/agent/run', target), {
      method: 'POST', signal: AbortSignal.timeout(125000),
      headers: { Origin: target.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: `http://127.0.0.1:${port}/v1`, model: 'preview-smoke-model',
        apiKey: fixtureKey, protocol: 'chat-completions', prompt: '将 R1 改成 2k 并仿真，给出实际结果。', project }),
    })
    assert.equal(response.status, 200, `Expected the real preview Agent route to accept the request, got ${response.status}`)
    assert.match(response.headers.get('content-type') ?? '', /application\/x-ndjson/)
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    if (fixtureFailure) throw fixtureFailure
    const failure = events.find(event => event.type === 'error')
    if (failure) throw new Error(`Preview Agent failed: ${String(failure.error)}`)
    assert.deepEqual(events[0], { type: 'started', engine: 'DeepSeek Harness', version: '0.1.5-rc.2' })
    assert.ok(events.slice(1, -1).every(event => event.type === 'tool'), 'Only tool progress may occur between started and done')
    const done = events.at(-1)
    assert.equal(done?.type, 'done'); assert.equal(done.changed, true)
    assert.equal(done.base, original)
    assert.equal(done.project?.drawing?.devices.find((device: { id: string }) => device.id === 'R1')?.value, '2k')
    assert.equal(JSON.stringify(project), original, 'Running an Agent must not mutate the original project')
    assert.equal(done.simulation?.stale, false)
    assert.match(done.simulation?.engine ?? '', /ngspice/i)
    assert.ok(done.simulation.points > 5)
    assert.deepEqual(returnedMeasurement, { engine: done.simulation.engine, points: done.simulation.points })
    assert.deepEqual(events.filter(event => event.type === 'tool' && event.status === 'completed').map(event => event.name),
      ['inspect_circuit', 'set_component_value', 'simulate_circuit'])
    assert.equal(modelRequests, 4)
    console.log(JSON.stringify({ target: target.origin, status: 'passed', runtime: 'DeepSeek Harness 0.1.5-rc.2',
      modelRequests, tools: toolNames.length, engine: done.simulation.engine, points: done.simulation.points,
      candidateR1: '2k', originalUnchanged: true }))
  } finally {
    fixture.closeAllConnections()
    await new Promise<void>(resolve => fixture.close(() => resolve()))
  }
}

main().catch(error => {
  console.error(`Agent preview smoke failed: ${(error instanceof Error ? error.message : String(error)).split(fixtureKey).join('[fixture credential]')}`)
  process.exitCode = 1
})
