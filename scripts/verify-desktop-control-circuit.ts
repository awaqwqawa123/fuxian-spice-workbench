// Opt-in real Codex + ngspice check; never selects or mutates a user's thread.
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DesktopCircuitManager } from '../server/desktop-circuit-manager'
import { DesktopControlManager } from '../server/desktop-control-manager'
import { createDesktopControlMiddleware } from '../server/desktop-control-middleware'
import { createDesktopCircuitMiddleware } from '../server/desktop-circuit-middleware'
import { privateLocalFilesPlugin, PRIVATE_LOCAL_DENY } from '../server/private-local-files'
import { createServer } from 'vite'
import { circuitAgentTools, circuitAgentInstructions } from '../src/core/agent-circuit'
import { editorTemplate } from '../src/core/editor'
import { desktopCircuitFingerprint } from '../src/core/desktop-circuit'
import { DesktopControlClient } from './desktop-broker/client.mjs'
// @ts-expect-error The broker is also runnable by the installed plain Node launcher.
import { runBroker } from './desktop-broker/broker.mjs'
// @ts-expect-error Plain Node transport helpers.
import { framedJson, writeJson } from './desktop-broker/common.mjs'

const executable = process.argv[2], selectedModel = process.argv[3]
if (!executable || !selectedModel) throw new Error('Pass official Codex executable and desktop-selected model')
for (const name of ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_PERMISSION_PROFILE']) delete process.env[name]
const directory = await mkdtemp(join(tmpdir(), 'fuxian-shared-circuit-'))
const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough(); errors.resume()
const calls = new Map<number, { accept: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
let sequence = 0, runtime: any, gateway: DesktopControlManager | undefined, browserServer: Awaited<ReturnType<typeof createServer>> | undefined
const circuits = new DesktopCircuitManager({ directory: join(directory, 'circuits'), projectDirectory: resolve('.') })
framedJson(output, (message: any) => {
  if (message.id !== undefined && !message.method) {
    const call = calls.get(message.id)
    if (call) { calls.delete(message.id); clearTimeout(call.timer); message.error ? call.reject(new Error(`Protocol error ${message.error.code}`)) : call.accept(message.result) }
  } else if (message.id !== undefined) writeJson(input, { id: message.id, error: { code: -32601, message: 'No desktop host operation expected in isolated circuit verification' } })
}, (error: Error) => { throw error })
const desktopCall = (method: string, params: unknown) => new Promise<any>((accept, reject) => {
  const id = ++sequence, timer = setTimeout(() => { calls.delete(id); reject(new Error(`Timeout: ${method}`)) }, 60000)
  calls.set(id, { accept, reject, timer }); writeJson(input, { id, method, params })
})
try {
  runtime = await runBroker({ executable, args: ['app-server', '--analytics-default-enabled', '-c', 'project_doc_max_bytes=0'], directory, discoveryPath: join(directory, 'discovery.json'), input, output, errors })
  await desktopCall('initialize', { clientInfo: { name: 'fuxian_circuit_verify', version: '0.25.0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
  writeJson(input, { method: 'initialized' })
  const projectId = 'shared-runtime-circuit-verification', baseline = editorTemplate('rc-lowpass')
  await circuits.sync({ projectId, project: baseline, expectedRevision: null })
  const client = new DesktopControlClient({ discoveryPath: join(directory, 'discovery.json'), timeoutMs: 60000 })
  gateway = new DesktopControlManager({ directory: join(directory, 'gateway'), projectDirectory: resolve('.'), legacyDirectory: join(directory, 'legacy-empty'), circuitManager: circuits, brokerFactory: () => client })
  const started = await desktopCall('thread/start', { cwd: directory, ephemeral: false, sandbox: 'read-only', approvalPolicy: 'never', model: selectedModel, baseInstructions: `This is an isolated circuit integration check. Use only the supplied circuit dynamic tools. Do not invoke shell or change files. ${circuitAgentInstructions}`, dynamicTools: circuitAgentTools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.parameters })) })
  const threadId = started.thread.id
  await desktopCall('thread/name/set', { threadId, name: '伏线共享服务隔离仿真验证' })
  if (process.argv[4] === '--browser-lab') {
    const apiOptions = { directory: join(directory, 'circuits'), projectDirectory: resolve('.') }
    const circuitApi = createDesktopCircuitMiddleware({ ...apiOptions, manager: circuits })
    const controlApi = createDesktopControlMiddleware({ ...apiOptions, manager: gateway })
    browserServer = await createServer({ configFile: false, root: resolve('.'), plugins: [privateLocalFilesPlugin(), { name: 'isolated-desktop-control-lab', configureServer(server) { server.middlewares.use(circuitApi); server.middlewares.use(controlApi) } }], server: { host: '127.0.0.1', port: 3035, strictPort: true, hmr: false, fs: { deny: ['.env', '.env.*', '**/.git/**', ...PRIVATE_LOCAL_DENY] } }, worker: { format: 'es' } })
    await browserServer.listen(); await circuits.connect('http://127.0.0.1:3035')
    console.log(JSON.stringify({ browserLab: 'http://localhost:3035/?v=0.25.0#editor', threadId, isolatedDesktop: true }))
    await new Promise<void>(accept => { process.once('SIGINT', accept); process.once('SIGTERM', accept) })
  } else {
  await gateway.bind(projectId, { threadId })
  assert.equal((await gateway.handoff(projectId, 'web')).owner, 'web')
  await gateway.send(projectId, '请用 inspect_circuit 读取当前 RC 低通电路，将 R1 改为 2.2k，使用 validate_circuit 和 simulate_circuit 完成真实 AC 仿真，再简短说明结果。使用这里提供的动态电路工具，不用 CLI。仅生成候选，不应用。', 'verify-circuit-turn')
  console.log('Real Codex circuit task delivered to the shared runtime')
  const deadline = Date.now() + 240000
  let lastEvents = -1, completed = false
  while (Date.now() < deadline) {
    const state = await circuits.state(projectId), task = state.tasks.at(-1)
    if ((task?.events.length ?? 0) !== lastEvents) { lastEvents = task?.events.length ?? 0; console.log(JSON.stringify({ status: task?.status ?? 'waiting', tools: task?.events.map(e => `${e.name}:${e.status}`) ?? [] })) }
    if (task?.status === 'completed') {
      assert.equal(task.result!.proposal.project.drawing!.devices.find(d => d.id === 'R1')!.value, '2.2k')
      assert.match(task.result!.simulation!.engine, /ngspice/i)
      assert.ok(task.result!.simulation!.points > 0)
      assert.equal(desktopCircuitFingerprint(state.snapshot!.project), desktopCircuitFingerprint(baseline), 'candidate must not change the live circuit')
      assert.equal((await gateway.handoff(projectId, 'desktop')).owner, 'desktop')
      console.log(JSON.stringify({ passed: true, threadId, processId: runtime.child.pid, simulation: task.result!.simulation!.engine, points: task.result!.simulation!.points, candidateValue: '2.2k', liveCircuitUnchanged: true }))
      completed = true
      break
    }
    const control = await gateway.state(projectId)
    if (control.error) throw new Error(control.error)
    if (Date.now() > deadline - 1000) throw new Error(`Circuit task did not complete: ${task?.error ?? 'no candidate'}`)
    await new Promise(accept => setTimeout(accept, 500))
  }
  assert.ok(completed, 'Real circuit verification must finish before its deadline')
  }
} finally {
  await browserServer?.close()
  await gateway?.close(); await circuits.close(); await runtime?.close()
  for (const call of calls.values()) clearTimeout(call.timer)
  input.destroy(); output.destroy(); errors.destroy()
  await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
}
