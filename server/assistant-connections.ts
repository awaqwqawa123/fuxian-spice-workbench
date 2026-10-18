import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getCodexStatus, findCodexExecutable } from './codex-runtime'
import { getCursorStatus, findCursorExecutable } from './cursor-runtime'
import { resolveCursorLaunch } from './cursor-launch'
import { installManagedCursor } from './cursor-install'
import { getDshLocalStatus, getDshLocalConnectionStatus } from './dsh-local-runtime'
import type { AssistantConnectionAction, AssistantConnectionResult, LocalAssistantEngine } from '../src/core/assistant-connection-client'
const require = createRequire(import.meta.url)
const allowedEngines = ['codex', 'cursor', 'dsh']
const allowedActions = ['connect', 'login', 'configure']
async function stopOwned(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) await new Promise<void>(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => resolve()))
  else child.kill('SIGTERM')
}
/** Explicit login only; no prompt/model request, no account/credential output. */
async function login(executable: string, args: string[], signal: AbortSignal) {
  const env = { ...process.env }; delete env.NODE_OPTIONS
  const child = spawn(executable, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const abort = () => { void stopOwned(child) }; signal.addEventListener('abort', abort, { once: true })
  let bytes = 0
  const bound = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256000) void stopOwned(child) }
  child.stdout.on('data', bound); child.stderr.on('data', bound)
  try { await new Promise<void>((resolve, reject) => { child.on('error', () => reject(new Error('无法启动官方登录程序，请检查本机安装'))); child.on('exit', code => { if (signal.aborted) reject(new Error('连接已取消')); else if (code !== 0 || bytes > 256000) reject(new Error('官方登录未完成，请重试或通过官方终端登录')); else resolve() }); if (signal.aborted) abort() }) }
  finally { signal.removeEventListener('abort', abort); await stopOwned(child) }
}
let dshWeb: { child: ChildProcessWithoutNullStreams; url: string } | null = null
let dshStarting: Promise<string> | null = null
async function openDshSettings(signal: AbortSignal): Promise<string> {
  if (dshWeb && dshWeb.child.exitCode === null && dshWeb.child.signalCode === null) return dshWeb.url
  if (dshStarting) return dshStarting
  dshStarting = (async () => {
    const packagePath = require.resolve('@deepseek-ai/dsh/lib/bin.js')
    const env = { ...process.env }; delete env.NODE_OPTIONS
    const child = spawn(process.execPath, [packagePath, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let ready = false, output = '', bytes = 0
    const abort = () => { if (!ready) void stopOwned(child) }; signal.addEventListener('abort', abort, { once: true })
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => { void stopOwned(child); reject(new Error('DSH 配置界面启动超时，请检查官方 DSH 配置')) }, 30000)
        const finish = (error?: Error, url?: string) => { clearTimeout(timeout); error ? reject(error) : resolve(url!) }
        const consume = (chunk: Buffer) => {
          bytes += chunk.length; if (bytes > 256000) { void stopOwned(child); finish(new Error('DSH 配置界面启动日志超过上限')); return }
          output = (output + chunk.toString('utf8')).slice(-12000)
          const url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d{1,5}\/[^\s\x1b]{0,2048})/)?.[1]
          if (url) finish(undefined, url)
        }
        child.stdout.on('data', consume); child.stderr.on('data', consume)
        child.once('error', () => finish(new Error('无法启动官方 DSH 设置')))
        child.once('exit', () => finish(new Error(signal.aborted ? '连接已取消' : '官方 DSH 配置界面启动失败；请检查 DSH 设置与插件')))
        if (signal.aborted) abort()
      })
      signal.throwIfAborted(); ready = true; dshWeb = { child, url }
      child.once('exit', () => { if (dshWeb?.child === child) dshWeb = null })
      return url
    } finally { signal.removeEventListener('abort', abort); if (!ready) await stopOwned(child) }
  })().finally(() => { dshStarting = null })
  return dshStarting
}
export async function closeAssistantConnectionSettings() { if (dshWeb) { const child = dshWeb.child; dshWeb = null; await stopOwned(child) } }
export async function connectAssistant(engine: LocalAssistantEngine, action: AssistantConnectionAction, signal: AbortSignal): Promise<AssistantConnectionResult> {
  if (engine === 'dsh') {
    const url = action === 'configure' ? await openDshSettings(signal) : undefined
    const status = await (action === 'connect' ? getDshLocalConnectionStatus : getDshLocalStatus)({ signal })
    return { engine, state: status.available ? 'ready' : status.message.includes('运行时初始化失败') ? 'unavailable' : 'configuration-required', dsh: status, ...(url ? { url } : {}), message: status.message }
  }
  if (engine === 'cursor') {
    let executable = await findCursorExecutable()
    if (!executable && action === 'connect') executable = await installManagedCursor({ signal })
    if (action === 'login') {
      if (!executable) throw new Error('请先点一键连接安装 Cursor 官方 CLI，再启动登录')
      const launch = await resolveCursorLaunch(executable)
      await login(launch.executable, [...launch.argsPrefix, 'login'], signal)
    }
    const status = await getCursorStatus({ signal, ...(executable ? { executable } : {}) })
    return { engine, native: status, state: status.available ? 'ready' : status.authenticated === false ? 'login-required' : 'unavailable', message: status.message }
  }
  if (action === 'login') {
    const executable = await findCodexExecutable()
    if (!executable) throw new Error('未找到 Codex 官方程序，请先安装官方 Codex')
    await login(executable, ['login'], signal)
  }
  const status = await getCodexStatus({ signal })
  return { engine, native: status, state: status.available && status.authenticated !== false ? 'ready' : status.authenticated === false ? 'login-required' : 'unavailable', message: status.message }
}
export function createAssistantConnectionsMiddleware(options: { connect?: typeof connectAssistant; timeoutMs?: number } = {}) {
  const active = new Set<string>()
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url?.split('?')[0] !== '/api/assistant-connections') { next(); return }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    const reply = (code: number, value: unknown) => { if (!res.destroyed && !res.writableEnded) { if (!req.complete) res.setHeader('Connection', 'close'); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) } }
    const host = req.headers.host, remote = req.socket.remoteAddress
    if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') || req.headers.origin !== 'http://' + host || req.headers['sec-fetch-site'] === 'cross-site' || req.headers['x-fuxian-assistant-connection'] !== '1') { reply(403, { error: '助手连接仅接受本机工作台同源请求' }); return }
    if (req.method !== 'POST') { reply(405, { error: '助手连接仅接受 POST' }); return }
    if (!req.headers['content-type']?.startsWith('application/json')) { reply(415, { error: '连接请求必须使用 JSON' }); return }
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 240000)
    const abort = () => { if (!res.writableEnded) controller.abort() }; res.once('close', abort)
    let engine: string | undefined
    try {
      const body = await new Promise<string>((resolve, reject) => { let body = ''; const aborted = () => { req.pause(); reject(new Error('连接已取消')) }; controller.signal.addEventListener('abort', aborted, { once: true }); req.on('data', chunk => { body += chunk.toString(); if (Buffer.byteLength(body) > 1024) { req.pause(); reject(new Error('连接请求超过上限')) } }); req.once('end', () => { controller.signal.removeEventListener('abort', aborted); resolve(body) }); req.once('error', reject); if (controller.signal.aborted) aborted() })
      const data = JSON.parse(body)
      if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(key => !['engine', 'action'].includes(key)) || !allowedEngines.includes(data.engine) || !allowedActions.includes(data.action) || data.action === 'configure' && data.engine !== 'dsh') { reply(400, { error: '助手连接操作无效' }); return }
      engine = data.engine
      if (active.has(engine!)) { engine = undefined; reply(409, { error: '该助手正在连接，请等待或取消' }); return }
      active.add(engine!)
      reply(200, await (options.connect ?? connectAssistant)(data.engine, data.action, controller.signal))
    } catch (cause) { reply(controller.signal.aborted ? 408 : 400, { error: controller.signal.aborted ? '连接已取消或超时，请重试' : cause instanceof Error ? cause.message.slice(0, 1200) : '助手连接失败' }) }
    finally { if (engine) active.delete(engine); clearTimeout(timeout); res.off('close', abort); controller.abort() }
  }
}
