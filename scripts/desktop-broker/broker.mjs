// Desktop stdio multiplexing adapted from DusuWorks/codex-webui (MIT).
// A single official app-server is created only by the official Desktop launcher.
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { access, mkdir, readFile, readdir, stat, writeFile, unlink } from 'node:fs/promises'
import net from 'node:net'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopRouter } from './router.mjs'
import { dataDirectory, discoveryFile, pipeName, framedJson, writeJson } from './common.mjs'

export function isPrimaryAppServerInvocation(args) {
  const index = args.indexOf('app-server')
  if (index < 0 || args.some(arg => ['--help', '-h', '--version'].includes(arg))) return false
  if (args[index + 1] && !args[index + 1].startsWith('-')) return false
  const listen = args.indexOf('--listen')
  return listen < 0 || args[listen + 1] === 'stdio://'
}
async function realCodex() {
  if (process.env.CODEX_DESKTOP_CONTROL_REAL_CODEX) return process.env.CODEX_DESKTOP_CONTROL_REAL_CODEX
  const installedConfig = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'runtime.json'), 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error })
  if (installedConfig?.realCodex) {
    // Installed sibling helpers must match the same official bundle. Prepare
    // discovers an update; a running launcher must not silently mix versions.
    await access(installedConfig.realCodex).catch(() => { throw new Error('Prepared official Codex runtime is missing; run Prepare again before activation') })
    return installedConfig.realCodex
  }
  // Prefer the newest official installed binary after desktop upgrades. Never use
  // PATH/codex, which may itself resolve to this launcher.
  const root = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin')
  const candidates = await Promise.all((await readdir(root, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory()).map(async d => {
    const filename = join(root, d.name, 'codex.exe')
    return { filename, mtime: await stat(filename).then(s => s.mtimeMs, () => 0) }
  }))
  const found = candidates.filter(x => x.mtime).sort((a, b) => b.mtime - a.mtime)[0]?.filename
  if (found) return found
  throw new Error('Cannot locate official Codex binary')
}
function childEnvironment() {
  const env = { ...process.env }; delete env.CODEX_CLI_PATH
  // Keep official Desktop tool pipe and originator: this child IS its runtime.
  delete env.CODEX_DESKTOP_CONTROL_REAL_CODEX; delete env.CODEX_DESKTOP_CONTROL_REAL_ARGS
  return env
}
export async function runBroker({ executable, args, prefixArgs = [], directory = dataDirectory(), discoveryPath = discoveryFile(), input = process.stdin, output = process.stdout, errors = process.stderr } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const pipe = pipeName(directory), token = randomBytes(32).toString('hex'), instance = randomBytes(12).toString('hex')
  const clients = new Set(), sockets = new Set()
  let child, router, closing = false, intentionalStop = false
  const sendWeb = (socket, message) => writeJson(socket, message)
  const broadcast = message => { for (const socket of clients) sendWeb(socket, message) }
  const server = net.createServer(socket => {
    sockets.add(socket); socket.setNoDelay(true)
    let authenticated = false
    const deadline = setTimeout(() => socket.destroy(), 5000)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => { clearTimeout(deadline); clients.delete(socket); sockets.delete(socket); router?.detach(socket) })
    framedJson(socket, message => {
      if (!authenticated) {
        const value = Buffer.from(typeof message.token === 'string' ? message.token : '')
        const expected = Buffer.from(token)
        if (message.type !== 'hello' || value.length !== expected.length || !timingSafeEqual(value, expected)) { sendWeb(socket, { type: 'hello', ok: false }); socket.end(); return }
        clearTimeout(deadline); authenticated = true; clients.add(socket)
        sendWeb(socket, { type: 'hello', ok: true, version: 1 })
        for (const event of router.pendingForWeb()) sendWeb(socket, event)
        return
      }
      const reply = result => sendWeb(socket, { type: 'response', requestId: message.requestId, result })
      try {
        if (message.type === 'status') reply(router.state(message.threadId ?? null))
        else if (message.type === 'handoff') reply(router.handoff(message.threadId, message.owner))
        else if (message.type === 'register-tools') { router.registerTools(socket, message.threadId, message.names); reply({}) }
        else if (message.type === 'request') router.fromClient('web', { id: message.requestId, method: message.method, params: message.params }, socket)
        else if (message.type === 'server-response') { if (router.respond('web', message.id, message, socket)) reply({}) }
        else throw new Error('未知中转请求')
      } catch (error) { sendWeb(socket, { type: 'response', requestId: message.requestId, error: { code: -32042, message: error.message } }) }
    }, () => socket.destroy())
  })
  // Binding first prevents a second launcher from creating a second writer.
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(pipe, accept) })
  try {
    child = spawn(executable, [...prefixArgs, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment() })
    router = new DesktopRouter({ child: message => writeJson(child.stdin, message), desktop: message => writeJson(output, message), broadcast, sendWeb })
    await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', reject) })
    await writeFile(discoveryPath, JSON.stringify({ version: 1, pipe, token, instance, pid: process.pid, childPid: child.pid }), { mode: 0o600 })
  } catch (error) { child?.kill(); server.close(); throw error }
  const close = async (reason = 'intentional') => {
    if (closing) return; closing = true; intentionalStop = reason === 'intentional'; router.desktopConnected = false; router.ready = false
    broadcast({ type: 'disconnected' }); for (const socket of sockets) socket.destroy()
    server.close(); input.pause(); child.stdin.end(); child.kill()
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    router.pending.clear(); router.requests.clear()
    const current = await readFile(discoveryPath, 'utf8').then(JSON.parse, () => null)
    if (current?.instance === instance) await unlink(discoveryPath).catch(() => {})
  }
  child.on('error', () => close('child')); child.on('exit', () => close('child'))
  child.stdin.on('error', () => close('child'))
  child.stderr.pipe(errors, { end: false })
  framedJson(child.stdout, message => router.fromChild(message), error => { errors.write(`[desktop-control] ${error.message}\n`); void close('protocol') })
  framedJson(input, message => router.fromClient('desktop', message), error => { errors.write(`[desktop-control] ${error.message}\n`); void close('protocol') })
  input.once('end', close); input.once('error', close)
  if (child.exitCode !== null || child.signalCode !== null) await close('child')
  return { close, child, router, pipe, discoveryPath, get intentionalStop() { return intentionalStop } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const executable = await realCodex(), args = process.argv.slice(2)
    const prefixArgs = JSON.parse(process.env.CODEX_DESKTOP_CONTROL_REAL_ARGS || '[]')
    if (!Array.isArray(prefixArgs) || prefixArgs.some(x => typeof x !== 'string')) throw new Error('Invalid runtime arguments')
    if (isPrimaryAppServerInvocation(args)) {
      const runtime = await runBroker({ executable, args, prefixArgs })
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void runtime.close() })
      runtime.child.on('exit', code => { process.exitCode = runtime.intentionalStop ? 0 : code ?? 1; process.stdin.destroy() })
    } else {
      const child = spawn(executable, [...prefixArgs, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnvironment() })
      process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
      child.stdin.on('error', () => process.stdin.unpipe(child.stdin))
      child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
      child.on('exit', code => { process.exitCode = code ?? 1; process.stdin.destroy() })
    }
  } catch (error) { process.stderr.write(`[desktop-control] ${error.message}\n`); process.exitCode = 1 }
}
