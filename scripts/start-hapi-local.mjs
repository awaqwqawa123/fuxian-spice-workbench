import { spawn, execFile } from 'node:child_process'
import { access, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = '0.30.7'
const executable = process.env.FUXIAN_HAPI_EXECUTABLE || join(homedir(), '.codex', 'tools', 'hapi', version, 'npm', 'node_modules', '@twsxtd', 'hapi-win32-x64', 'bin', 'hapi.exe')
const data = process.env.FUXIAN_HAPI_HOME || join(homedir(), '.codex', 'tools', 'hapi', 'workbench-data')
const url = 'http://127.0.0.1:3006'
const local = join(root, '.hapi-local')
await access(executable)
await mkdir(data, { recursive: true })
await mkdir(local, { recursive: true })
let token
try { token = (await readFile(join(data, 'workbench-access-token'), 'utf8')).trim() } catch { /* First launch. */ }
if (!token) { token = randomBytes(32).toString('hex'); await writeFile(join(data, 'workbench-access-token'), token, { mode: 0o600 }) }
const env = { ...process.env, HAPI_HOME: data, HAPI_API_URL: url, CLI_API_TOKEN: token, HAPI_LISTEN_HOST: '127.0.0.1', HAPI_LISTEN_PORT: '3006', HAPI_PUBLIC_URL: url }
for (const key of ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_PERMISSION_PROFILE', 'CODEX_CI', 'CODEX_SHELL', 'CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE', 'NODE_OPTIONS']) delete env[key]
const health = async () => { try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })).ok } catch { return false } }
if (!await health()) {
  const log = await open(join(data, 'hub.log'), 'a')
  const child = spawn(executable, ['hub'], { cwd: root, env, windowsHide: true, detached: true, stdio: ['ignore', log.fd, log.fd] })
  await new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail) })
  child.unref(); await log.close()
  await writeFile(join(data, 'hub-process.json'), JSON.stringify({ pid: child.pid, executable, startedAt: new Date().toISOString() }), { mode: 0o600 })
  const deadline = Date.now() + 20000
  while (!await health()) { if (Date.now() > deadline) throw new Error('HAPI Hub did not start. Inspect the local hub log.'); await new Promise(r => setTimeout(r, 250)) }
}
const auth = await fetch(`${url}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: token }), signal: AbortSignal.timeout(5000) })
if (!auth.ok) throw new Error('Port 3006 is occupied by a different HAPI service; it has not been stopped.')
const { token: jwt } = await auth.json()
const machinesResponse = await fetch(`${url}/api/machines`, { headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(5000) })
if (!machinesResponse.ok) throw new Error('Cannot inspect HAPI Runner state; no process has been restarted.')
const { machines = [] } = await machinesResponse.json()
const online = machines.filter(machine => machine.active)
const matching = online.find(machine => machine.runnerState?.capabilities?.codexSharedRuntime === true && (machine.metadata?.workspaceRoots ?? []).some(directory => resolve(directory).toLowerCase() === root.toLowerCase()))
await writeFile(join(local, 'connection.json'), JSON.stringify({ url, token, version, executable, dataDirectory: data }, null, 2), { mode: 0o600 })
// The isolated HAPI_HOME limits runner lifecycle operations to this integration.
const run = promisify(execFile)
if (matching) {
  console.log(JSON.stringify({ version, url, runner: 'reused', workspaceRoot: root }))
} else {
  if (online.length && !process.argv.includes('--restart-runner')) throw new Error('The existing dedicated HAPI Runner uses another workspace. Use --restart-runner after its tasks finish.')
  if (online.length) {
    const sessionsResponse = await fetch(`${url}/api/sessions?limit=500`, { headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(5000) })
    if (!sessionsResponse.ok) throw new Error('Cannot inspect active tasks; Runner was not restarted.')
    const { sessions = [] } = await sessionsResponse.json()
    if (sessions.some(session => session.active && (session.thinking || Object.keys(session.agentState?.requests ?? {}).length))) throw new Error('A HAPI task is running or awaiting approval; Runner was not restarted.')
    await run(executable, ['runner', 'stop'], { cwd: root, env, windowsHide: true, timeout: 30000, maxBuffer: 100000 })
  }
  const runner = await run(executable, ['runner', 'start', '--workspace-root', root], { cwd: root, env, windowsHide: true, timeout: 45000, maxBuffer: 100000 })
  await writeFile(join(data, 'runner-start.log'), runner.stdout + runner.stderr)
  console.log(JSON.stringify({ version, url, connectionFile: join(local, 'connection.json'), runner: 'started', workspaceRoot: root }))
}
