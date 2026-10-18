/** A transport failure is different from a reachable service without a Codex desktop connection. */
export class LocalServiceUnavailableError extends Error {
  constructor(readonly timedOut = false) {
    super(timedOut
      ? '本地工作台后台响应超时，正在自动检查连接。草稿和聊天保留。'
      : '无法连接本地工作台后台，正在自动重连。服务恢复后会继续同步，草稿和聊天保留。')
    this.name = 'LocalServiceUnavailableError'
  }
}

/** Bound headers and body reads, but never retry a write whose delivery may be uncertain. */
export async function readLocalService(url: string, options: RequestInit, timeoutMs = 10_000): Promise<{ response: Response; value: any }> {
  const controller = new AbortController(), signal = options.signal
  let timedOut = false
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  let rejectAborted = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(controller.signal.reason ?? new DOMException('Aborted', 'AbortError'))
    if (controller.signal.aborted) rejectAborted()
    else controller.signal.addEventListener('abort', rejectAborted, { once: true })
  })
  try {
    return await Promise.race([aborted, (async () => {
      const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' })
      const value = await response.json().catch(reason => {
        if (reason instanceof SyntaxError) return null
        throw reason
      })
      return { response, value }
    })()])
  } catch (reason) {
    if (signal?.aborted) throw reason
    throw new LocalServiceUnavailableError(timedOut)
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', rejectAborted)
  }
}
