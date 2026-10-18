import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export class CodexRuntimeError extends Error {}
/** A native cross-process writer lease, not a model or authentication failure. */
export class CodexThreadInUseError extends CodexRuntimeError {
  constructor() { super('此会话仍由 Codex 桌面或其他客户端持有写入权限，问题尚未送达、任务尚未开始。可点击“检查网页续聊”确认是否已释放；仍占用时需保存工作并完全退出持有它的 Codex 桌面进程，再从外部浏览器继续。切换聊天或等待回复完成不能可靠释放。'); this.name = 'CodexThreadInUseError' }
}
/** An internal deadline, distinct from a user stop or an upstream/protocol failure. */
export class CodexTimeoutError extends CodexRuntimeError {
  constructor(message = 'Codex 任务超时，已停止') { super(message); this.name = 'CodexTimeoutError' }
}
type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: unknown }

/** Bounded JSON-lines transport. Stderr is deliberately never forwarded to the browser. */
export class CodexRpc {
  readonly child: ChildProcessWithoutNullStreams
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private listeners = new Set<(message: Message) => void>()
  private nextId = 0
  private failure: Error | undefined
  private buffer = ''
  private bytes = 0
  private stderrBytes = 0
  private closed = false
  private closing?: Promise<void>
  private deadline: ReturnType<typeof setTimeout>
  private abort: () => void
  private signal: AbortSignal
  onRequest?: (message: Message) => Promise<unknown>

  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number }) {
    this.signal = options.signal
    this.child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.abort = () => this.fail(options.signal.reason instanceof CodexTimeoutError ? options.signal.reason : new CodexRuntimeError('任务已停止'))
    this.deadline = setTimeout(() => this.fail(new CodexTimeoutError()), options.timeoutMs)
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.bytes += Buffer.byteLength(chunk)
      this.buffer += chunk
      if (this.bytes > 8 * 1024 * 1024 || this.buffer.length > 2 * 1024 * 1024) return this.fail(new CodexRuntimeError('Codex 响应超过任务限制'))
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1)
        if (!line) continue
        try { this.receive(JSON.parse(line)) }
        catch { this.fail(new CodexRuntimeError('Codex App Server 返回了无效协议数据')); return }
      }
    })
    this.child.stderr.on('data', (chunk: Buffer) => { if ((this.stderrBytes += chunk.length) > 2 * 1024 * 1024) this.fail(new CodexRuntimeError('Codex 启动日志超过限制')) })
    this.child.stdin.on('error', () => this.fail(new CodexRuntimeError('Codex 连接已关闭')))
    this.child.on('error', () => this.fail(new CodexRuntimeError('无法启动本机 Codex，请检查安装及 CODEX_EXECUTABLE 设置')))
    this.child.on('exit', () => { if (!this.closed) this.fail(new CodexRuntimeError('Codex App Server 意外退出，请检查本机 Codex 配置')) })
    options.signal.addEventListener('abort', this.abort, { once: true })
    if (options.signal.aborted) this.abort()
  }
  private receive(message: Message) {
    if (this.closed) return
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid message')
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id as number)
      if (!pending) return
      this.pending.delete(message.id as number)
      // Raw upstream errors may contain provider headers or account data.
      if (message.error) {
        const error = message.error as { code?: unknown; message?: unknown }
        // Match only this known, credential-free protocol error; all other raw errors stay private.
        pending.reject(error.code === -32600 && typeof error.message === 'string' && /^thread [a-f0-9-]{36} already has an active writer$/i.test(error.message)
          ? new CodexThreadInUseError() : new CodexRuntimeError('Codex App Server 拒绝请求，请检查本机配置及版本兼容性'))
      }
      else pending.resolve(message.result)
    } else if (message.id !== undefined && message.method) {
      void (this.onRequest?.(message) ?? Promise.reject(new Error('denied'))).then(
        result => this.write({ id: message.id, result }),
        () => this.write({ id: message.id, error: { code: -32601, message: 'This circuit session does not support that operation' } }),
      )
    } else for (const listener of this.listeners) listener(message)
  }
  private write(message: unknown) {
    if (!this.closed && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n')
  }
  call(method: string, params: unknown): Promise<any> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closed) return Promise.reject(new CodexRuntimeError('Codex 连接已关闭'))
    return new Promise((resolve, reject) => { const id = ++this.nextId; this.pending.set(id, { resolve, reject }); this.write({ id, method, params }) })
  }
  notify(method: string, params?: unknown) { this.write({ method, ...(params === undefined ? {} : { params }) }) }
  listen(listener: (message: Message) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  waitFor(predicate: (message: Message) => boolean): Promise<Message> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const remove = this.listen(message => { if (predicate(message)) { remove(); this.pending.delete(id); resolve(message) } })
      this.pending.set(id, { resolve, reject: error => { remove(); reject(error) } })
    })
  }
  fail(error: Error) {
    if (this.failure || this.closed) return
    this.failure = error
    for (const item of this.pending.values()) item.reject(error)
    this.pending.clear()
    void this.close()
  }
  close(gracePeriodMs = 0): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true; clearTimeout(this.deadline); this.signal.removeEventListener('abort', this.abort)
    for (const item of this.pending.values()) item.reject(this.failure ?? new CodexRuntimeError('Codex 连接已关闭'))
    this.pending.clear(); this.listeners.clear()
    this.closing = this.closeChild(gracePeriodMs)
    return this.closing
  }
  private async closeChild(gracePeriodMs: number) {
    this.child.stdin.end()
    if (gracePeriodMs && this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, gracePeriodMs); this.child.once('exit', () => { clearTimeout(timer); resolve() }) })
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill()
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 1500); this.child.once('exit', () => { clearTimeout(timer); resolve() }) })
    }
    this.child.stdout.destroy(); this.child.stderr.destroy()
  }
}
