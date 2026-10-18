import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export class CursorRuntimeError extends Error {}
type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: unknown }

/** Bounded JSON-lines transport. Stderr is deliberately never forwarded to the browser. */
export class CursorRpc {
  readonly child: ChildProcessWithoutNullStreams
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private listeners = new Set<(message: Message) => void>()
  private nextId = 0
  private failure: Error | undefined
  private buffer = ''
  private bytes = 0
  private stderrBytes = 0
  private closed = false
  private closePromise: Promise<void> | undefined
  private deadline: ReturnType<typeof setTimeout>
  private abort: () => void
  private signal: AbortSignal
  onRequest?: (message: Message) => Promise<unknown>

  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number }) {
    this.signal = options.signal
    this.child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.abort = () => this.fail(new CursorRuntimeError('任务已停止'))
    this.deadline = setTimeout(() => this.fail(new CursorRuntimeError('Cursor 任务超时，请缩小任务后重试')), options.timeoutMs)
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.bytes += Buffer.byteLength(chunk)
      this.buffer += chunk
      if (this.bytes > 8 * 1024 * 1024 || this.buffer.length > 2 * 1024 * 1024) return this.fail(new CursorRuntimeError('Cursor 响应超过任务限制'))
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1)
        if (!line) continue
        try { this.receive(JSON.parse(line)) }
        catch { this.fail(new CursorRuntimeError('Cursor ACP 返回了无效协议数据')); return }
      }
    })
    this.child.stderr.on('data', (chunk: Buffer) => { if ((this.stderrBytes += chunk.length) > 2 * 1024 * 1024) this.fail(new CursorRuntimeError('Cursor 启动日志超过限制')) })
    this.child.stdin.on('error', () => this.fail(new CursorRuntimeError('Cursor 连接已关闭')))
    this.child.on('error', () => this.fail(new CursorRuntimeError('无法启动本机 Cursor，请检查安装及 CURSOR_AGENT_EXECUTABLE 设置')))
    this.child.on('exit', () => { if (!this.closed) this.fail(new CursorRuntimeError('Cursor ACP 意外退出，请检查本机 Cursor 配置')) })
    options.signal.addEventListener('abort', this.abort, { once: true })
    if (options.signal.aborted) this.abort()
  }
  private receive(message: Message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid message')
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id as number)
      if (!pending) return
      this.pending.delete(message.id as number)
      // Raw upstream errors may contain provider headers or account data.
      if (message.error) pending.reject(new CursorRuntimeError('Cursor ACP 拒绝请求，请检查本机配置及版本兼容性'))
      else pending.resolve(message.result)
    } else if (message.id !== undefined && message.method) {
      void (this.onRequest?.(message) ?? Promise.reject(new Error('denied'))).then(
        result => this.write({ id: message.id, result }),
        () => this.write({ id: message.id, error: { code: -32601, message: 'This circuit session does not support that operation' } }),
      )
    } else for (const listener of this.listeners) listener(message)
  }
  private write(message: unknown) {
    if (!this.closed && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(message as object) }) + '\n')
  }
  call(method: string, params: unknown): Promise<any> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closed) return Promise.reject(new CursorRuntimeError('Cursor 连接已关闭'))
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
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeChild()
    return this.closePromise
  }
  private async closeChild() {
    this.closed = true; clearTimeout(this.deadline); this.signal.removeEventListener('abort', this.abort)
    for (const item of this.pending.values()) item.reject(this.failure ?? new CursorRuntimeError('Cursor 连接已关闭'))
    this.pending.clear(); this.listeners.clear()
    this.child.stdin.end()
    if (this.child.exitCode === null && this.child.signalCode === null) {
      if (process.platform === 'win32' && this.child.pid) {
        await new Promise<void>(resolve => execFile('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => resolve()))
      } else this.child.kill()
      if (this.child.exitCode === null && this.child.signalCode === null) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 1500); this.child.once('exit', () => { clearTimeout(timer); resolve() }) })
    }
    this.child.stdout.destroy(); this.child.stderr.destroy()
  }
}

