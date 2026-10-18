// Started by Windows WMI, outside the editor's process Job. No credentials are stored here.
import { spawn } from 'node:child_process'
import { openSync, closeSync, appendFileSync, statSync, renameSync } from 'node:fs'
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const configPath = process.argv[2]
if (!configPath) throw new Error('A service run configuration is required')
const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''))
const { directory, projectDirectory, port, serviceId } = config
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[0-9a-f-]{36}$/.test(serviceId)) throw new Error('Invalid local service configuration')
const statePath = join(directory, 'state.json')
const stopPath = join(directory, `${serviceId}.stop`)
const stdoutPath = join(directory, 'stdout.log'), stderrPath = join(directory, 'stderr.log')
for (const logPath of [stdoutPath, stderrPath]) {
  try { if (statSync(logPath).size > 8 * 1024 * 1024) renameSync(logPath, `${logPath}.previous`) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  closeSync(openSync(logPath, 'a'))
}
const startedAt = new Date().toISOString()
appendFileSync(stderrPath, `Local service host started ${startedAt}; runtime ${process.execPath}\n`)
let child, status = 'starting', stopping = false, writeQueue = Promise.resolve(), timer, restartTimer
let hasBeenReady = false
let lastExitCode
const restarts = []
const state = () => ({ serviceId, projectDirectory, port, hostPid: process.pid, childPid: child?.pid, configPath, status, stdoutPath, stderrPath,
  nodeExecutable: process.execPath, startedAt, updatedAt: new Date().toISOString(), lastExitCode })
function publish() {
  writeQueue = writeQueue.then(async () => {
    const temporary = `${statePath}.${serviceId}.tmp`
    await writeFile(temporary, JSON.stringify(state(), null, 2))
    await rename(temporary, statePath)
  }).catch((error) => {
    try { appendFileSync(stderrPath, `Local service state update failed: ${error.message}\n`) } catch { /* The log directory may also be unavailable. */ }
    // The managed server closes on IPC disconnect, so a failed host cannot orphan it.
    process.exit(1)
  })
  return writeQueue
}
async function finish(finalStatus, code) {
  clearInterval(timer); clearTimeout(restartTimer)
  status = finalStatus
  await publish()
  await unlink(stopPath).catch(() => {})
  process.exitCode = code
}
const shutdown = () => {
  if (stopping) return
  stopping = true; status = 'stopping'; void publish()
  clearTimeout(restartTimer)
  if (child?.connected) child.send({ type: 'fuxian-service-shutdown' }, () => {})
  else if (!child) void finish('stopped', 0)
}
function startChild() {
  const stdout = openSync(stdoutPath, 'a'), stderr = openSync(stderrPath, 'a')
  const running = spawn(process.execPath, [join(projectDirectory, 'scripts', 'serve-local.mjs')], {
    cwd: projectDirectory, windowsHide: true,
    env: { ...process.env, FUXIAN_PORT: String(port) }, stdio: ['ignore', stdout, stderr, 'ipc'],
  })
  closeSync(stdout); closeSync(stderr)
  child = running; status = 'starting'; void publish()
  running.on('message', (message) => {
    if (message?.type === 'fuxian-service-ready' && !stopping) {
      hasBeenReady = true; status = 'ready'; void publish()
    }
  })
  running.on('error', error => appendFileSync(stderrPath, `Local service launch failed: ${error.message}\n`))
  running.once('close', async (code) => {
    child = undefined
    lastExitCode = code
    appendFileSync(stderrPath, `Local service child exited (${code}) at ${new Date().toISOString()}; requested shutdown: ${stopping}.\n`)
    if (stopping) { await finish('stopped', 0); return }
    const now = Date.now()
    while (restarts.length && restarts[0] < now - 60_000) restarts.shift()
    // Startup failures need attention; a previously healthy service may recover
    // from a request crash, but a crash loop must stop and retain its diagnostics.
    if (!hasBeenReady || restarts.length >= 3) { await finish('failed', code || 1); return }
    const delay = [500, 1500, 3000][restarts.length]
    restarts.push(now); status = 'restarting'
    appendFileSync(stderrPath, `Local service exited (${code}); restarting in ${delay} ms (${restarts.length}/3 within 60 seconds).\n`)
    await publish()
    if (stopping) { await finish('stopped', 0); return }
    restartTimer = setTimeout(startChild, delay)
  })
}
timer = setInterval(async () => {
  const requested = await readFile(stopPath, 'utf8').catch(() => '')
  if (requested.trim() === serviceId) shutdown()
}, 250)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown)
startChild()
