import net from 'node:net'
import { readFile } from 'node:fs/promises'
import { discoveryFile, framedJson, writeJson } from './common.mjs'

const failure = (code, message) => Object.assign(new Error(message), { code })

export class DesktopControlClient {
  constructor({ discoveryPath, timeoutMs = 15000 } = {}) {
    this.discoveryPath = discoveryPath ?? discoveryFile(); this.timeoutMs = timeoutMs
    this.pending = new Map(); this.listeners = new Set(); this.nextId = 1; this.connected = false
  }
  async connect() {
    if (this.connected) return this
    if (this.connecting) return this.connecting
    this.connecting = this.open().finally(() => { this.connecting = null })
    return this.connecting
  }
  async open() {
    let discovery
    try { discovery = JSON.parse(await readFile(this.discoveryPath, 'utf8')) }
    catch (error) { throw failure(error.code === 'ENOENT' ? 'DESKTOP_DISCOVERY_MISSING' : 'DESKTOP_DISCOVERY_INVALID', '桌面共享配置尚未就绪，请使用连接按钮自动修复') }
    if (!discovery || typeof discovery.pipe !== 'string' || typeof discovery.token !== 'string' || discovery.token.length < 32) throw failure('DESKTOP_DISCOVERY_INVALID', '桌面中转发现文件无效')
    if (process.platform === 'win32' && !discovery.pipe.startsWith('\\\\.\\pipe\\codex-desktop-control-')) throw failure('DESKTOP_DISCOVERY_INVALID', '桌面中转只支持本机命名管道')
    const socket = net.createConnection(discovery.pipe); this.socket = socket
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(failure('DESKTOP_CONNECT_TIMEOUT', 'Codex 桌面中转连接超时')); socket.destroy() }, Math.min(this.timeoutMs, 5000))
      let authenticated = false
      const fail = () => { clearTimeout(timer); if (this.socket === socket) this.disconnect(); reject(failure('DESKTOP_TRANSPORT_CLOSED', 'Codex 桌面中转已断开，请重新连接')) }
      socket.on('error', fail); socket.on('close', fail)
      socket.on('connect', () => writeJson(socket, { type: 'hello', token: discovery.token }))
      framedJson(socket, message => {
        if (!authenticated) {
          if (message.type !== 'hello' || message.ok !== true) { fail(); socket.destroy(); return }
          authenticated = true; this.connected = true; clearTimeout(timer); resolve(this); return
        }
        if (message.type === 'response') {
          const pending = this.pending.get(message.requestId)
          if (!pending) return
          this.pending.delete(message.requestId); clearTimeout(pending.timer)
          if (message.error) { const error = new Error(message.error.message ?? 'Codex 请求失败'); error.code = message.error.code; pending.reject(error) }
          else pending.resolve(message.result)
        } else for (const listener of this.listeners) { try { listener(message) } catch { /* isolate listeners */ } }
      }, () => { fail(); socket.destroy() })
    })
  }
  request(payload) {
    if (!this.connected) return Promise.reject(failure('DESKTOP_TRANSPORT_CLOSED', 'Codex 桌面中转未连接'))
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Codex 请求等待超时；连接将重新建立，请先核对状态，不要重复发送任务'))
        // A live pipe with an unresponsive broker otherwise stays cached forever.
        // The caller keeps ambiguous thread/start and turn/start results in its
        // journal; reconnecting the transport must not retry either operation.
        this.close()
      }, this.timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer }); writeJson(this.socket, { ...payload, requestId })
    })
  }
  call(method, params = {}) { return this.request({ type: 'request', method, params }) }
  status(threadId) { return this.request({ type: 'status', threadId }) }
  handoff(threadId, owner) { return this.request({ type: 'handoff', threadId, owner }) }
  registerTools(threadId, names) { return this.request({ type: 'register-tools', threadId, names }) }
  respond(id, response) { return this.request({ type: 'server-response', id, ...response }) }
  listen(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  disconnect() {
    const wasConnected = this.connected; this.connected = false
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure('DESKTOP_TRANSPORT_CLOSED', 'Codex 桌面中转连接已关闭')) }
    this.pending.clear()
    if (wasConnected) for (const listener of this.listeners) { try { listener({ type: 'disconnected' }) } catch {} }
  }
  close() { this.disconnect(); this.socket?.destroy() }
}
