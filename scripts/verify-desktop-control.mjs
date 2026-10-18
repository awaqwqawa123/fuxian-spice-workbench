// Explicit integration check against the installed Codex. Never attaches to an
// existing desktop process, changes global configuration, or touches a user thread.
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const executable = process.argv[2]
if (!executable) throw new Error('Usage: node scripts/verify-desktop-control.mjs ABSOLUTE_CODEX_EXE [BROKER_DIRECTORY] [DESKTOP_SELECTED_MODEL]')
const desktopSelectedModel = process.argv[4]
const brokerDirectory = process.argv[3] ? pathToFileURL(`${resolve(process.argv[3])}/`) : new URL('./desktop-broker/', import.meta.url)
const { runBroker } = await import(new URL('broker.mjs', brokerDirectory))
const { DesktopControlClient } = await import(new URL('client.mjs', brokerDirectory))
const { framedJson, writeJson } = await import(new URL('common.mjs', brokerDirectory))
for (const name of ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_PERMISSION_PROFILE']) delete process.env[name]
const directory = await mkdtemp(join(tmpdir(), 'fuxian-real-desktop-control-'))
const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough()
errors.resume() // The report deliberately excludes raw provider / credential logs.
const pending = new Map(), desktopEvents = [], webEvents = []
let nextId = 0, runtime, web
const check = (label, value = true) => { assert.ok(value, label); console.log(label) }
framedJson(output, message => {
  if (message.id !== undefined && !message.method) {
    const item = pending.get(message.id)
    if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(`Protocol code ${message.error.code}`)) : item.resolve(message.result) }
  } else if (message.id !== undefined) {
    // No tools or approvals are expected in this memory-only check.
    writeJson(input, { id: message.id, error: { code: -32601, message: 'Not used in this isolated verification' } })
  } else desktopEvents.push(message)
}, error => { throw error })
const desktopCall = (method, params = {}) => new Promise((accept, reject) => {
  const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)) }, 60000)
  pending.set(id, { resolve: accept, reject, timer }); writeJson(input, { id, method, params })
})
async function waitForTurn(threadId, turnId) {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    const complete = desktopEvents.find(e => e.method === 'turn/completed' && e.params?.threadId === threadId && e.params?.turn?.id === turnId)
    if (complete) {
      if (complete.params.turn.status !== 'completed') {
        const error = complete.params.turn.error ?? {}, message = String(error.message ?? '')
        console.log(JSON.stringify({ failed: true, info: error.codexErrorInfo, categories: ['403', '401', 'model', 'code_mode', 'attestation', 'timeout', 'stream', 'authentication'].filter(word => message.toLowerCase().includes(word)) }))
      }
      assert.equal(complete.params.turn.status, 'completed', 'real model turn must complete')
      assert.ok(webEvents.some(e => e.type === 'notification' && e.message.method === 'turn/completed' && e.message.params?.turn?.id === turnId), 'both clients receive completion')
      return complete
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('Real model did not finish within 180 seconds')
}
try {
  runtime = await runBroker({ executable, args: ['app-server', '--analytics-default-enabled', '-c', 'project_doc_max_bytes=0'], directory, discoveryPath: join(directory, 'discovery.json'), input, output, errors })
  await desktopCall('initialize', { clientInfo: { name: 'fuxian_shared_verify', title: 'Shared runtime verification', version: '0.25.0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
  writeJson(input, { method: 'initialized' })
  web = new DesktopControlClient({ discoveryPath: join(directory, 'discovery.json'), timeoutMs: 60000 })
  web.listen(e => webEvents.push(e)); await web.connect()
  check('Authenticated web client joined the desktop runtime', (await web.status()).ready)
  const started = await desktopCall('thread/start', { cwd: directory, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', ...(desktopSelectedModel ? { model: desktopSelectedModel } : {}), baseInstructions: 'This is an isolated conversation continuity test. Reply briefly. Do not invoke any tools.' })
  const threadId = started.thread.id, pid = runtime.child.pid
  console.log(JSON.stringify({ model: /^[a-zA-Z0-9._:/-]+$/.test(started.model ?? '') ? started.model : 'configured default' }))
  const first = await desktopCall('turn/start', { threadId, input: [{ type: 'text', text: '记住本次会话代号：青竹-9274-K6。只回复已记住，不调用工具。' }] })
  const queued = await web.handoff(threadId, 'web')
  check('Switch waits for the running desktop turn', queued.owner === 'desktop' && queued.pendingOwner === 'web')
  await waitForTurn(threadId, first.turn.id)
  check('Broker confirmed web ownership after completion', (await web.status(threadId)).owner === 'web')
  await assert.rejects(desktopCall('turn/start', { threadId, input: [{ type: 'text', text: 'This must not be delivered.' }] }))
  check('Non-owner desktop send was rejected')
  const second = await web.call('turn/start', { threadId, input: [{ type: 'text', text: '刚才的代号是什么？另请记住银杏-5831。只回复两个代号，不调用工具。' }] })
  await waitForTurn(threadId, second.turn.id)
  const webText = desktopEvents.filter(e => e.method === 'item/completed' && e.params?.turnId === second.turn.id && e.params?.item?.type === 'agentMessage').map(e => e.params.item.text).join('\n')
  check('Web turn retained desktop context', webText.includes('青竹-9274-K6') && webText.includes('银杏-5831'))
  check('Switch back to desktop confirmed', (await web.handoff(threadId, 'desktop')).owner === 'desktop')
  await assert.rejects(web.call('turn/start', { threadId, input: [{ type: 'text', text: 'This must not be delivered.' }] }))
  const third = await desktopCall('turn/start', { threadId, input: [{ type: 'text', text: '现在只回复本次会话记住的两个代号，不调用工具。' }] })
  await waitForTurn(threadId, third.turn.id)
  const desktopText = desktopEvents.filter(e => e.method === 'item/completed' && e.params?.turnId === third.turn.id && e.params?.item?.type === 'agentMessage').map(e => e.params.item.text).join('\n')
  check('Desktop turn retained web context', desktopText.includes('青竹-9274-K6') && desktopText.includes('银杏-5831'))
  check('All turns used the original process', runtime.child.pid === pid && runtime.child.exitCode === null)
  const report = { passed: true, at: new Date().toISOString(), codexPid: pid, threadId, turns: [first.turn.id, second.turn.id, third.turn.id], officialDesktopUiTested: false }
  await writeFile(join(directory, 'verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  web?.close(); for (const item of pending.values()) clearTimeout(item.timer)
  await runtime?.close(); input.destroy(); output.destroy(); errors.destroy()
  // Only this check's freshly allocated temporary directory is removed.
  await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
}
