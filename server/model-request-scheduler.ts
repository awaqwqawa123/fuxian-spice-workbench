import { AsyncLocalStorage } from 'node:async_hooks'

// A request may have several HTTP consumers. Cancellation belongs to their
// shared operation, so leaving one panel never cancels another panel's lookup.
const operationContext = new AsyncLocalStorage<AbortSignal | undefined>()
export const currentModelRequestSignal = () => operationContext.getStore()
// Existing byte/text caches are shared across distinct operations. Their own
// finite network deadlines apply; one operation must not abort another user's
// already shared cache fill.
export const withoutModelRequestCancellation = <T>(work: () => T): T => operationContext.run(undefined, work)

export class ModelRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

interface Consumer {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  cleanup: () => void
}
interface Operation {
  key: string
  work: () => Promise<unknown>
  controller: AbortController
  consumers: Set<Consumer>
  running: boolean
  failure?: ModelRequestError
  timer?: ReturnType<typeof setTimeout>
}

/** Bounded shared work. A timeout cannot free a slot while uncancellable work
 * is still running: doing that would turn repeated UI retries into unbounded
 * background downloads. Queued work with no consumers is removed immediately.
 */
export function createModelRequestScheduler(concurrency: number, queueLimit: number, executionMs: number, queueMs = 8_000) {
  const operations = new Map<string, Operation>(), queue: Operation[] = []
  let running = 0

  function deliver(operation: Operation, value?: unknown, reason?: unknown) {
    for (const consumer of operation.consumers) {
      consumer.cleanup()
      if (reason !== undefined) consumer.reject(reason)
      else consumer.resolve(value)
    }
    operation.consumers.clear()
  }
  function removeQueued(operation: Operation) {
    const index = queue.indexOf(operation)
    if (index >= 0) queue.splice(index, 1)
    operations.delete(operation.key)
    clearTimeout(operation.timer)
  }
  function cancel(operation: Operation, failure: ModelRequestError) {
    if (operation.failure) return
    operation.failure = failure
    clearTimeout(operation.timer)
    operation.controller.abort(failure)
    deliver(operation, undefined, failure)
    if (!operation.running) removeQueued(operation)
  }
  function pump() {
    while (running < concurrency && queue.length) {
      const operation = queue.shift()!
      if (!operation.consumers.size) { removeQueued(operation); continue }
      operation.running = true; running++
      clearTimeout(operation.timer)
      operation.timer = setTimeout(() => cancel(operation, new ModelRequestError('模型处理超时，已停止等待；正在结束本次任务，请稍后重新操作', 504)), executionMs)
      void Promise.resolve().then(() => {
        operation.controller.signal.throwIfAborted()
        return operationContext.run(operation.controller.signal, operation.work)
      }).then(value => {
        operations.delete(operation.key)
        deliver(operation, value)
      }, reason => {
        operations.delete(operation.key)
        deliver(operation, undefined, reason)
      }).finally(() => {
        clearTimeout(operation.timer)
        if (operations.get(operation.key) === operation) operations.delete(operation.key)
        running--
        pump()
      })
    }
  }
  return {
    schedule<T>(key: string, work: () => Promise<T>, signal: AbortSignal): Promise<T> {
      if (signal.aborted) return Promise.reject(signal.reason)
      let operation = operations.get(key)
      if (operation?.failure) return Promise.reject(new ModelRequestError('上一次同型号任务正在结束，请稍后重试；本地器件检索仍可使用', 503))
      if (!operation) {
        if (queue.length >= queueLimit) return Promise.reject(new ModelRequestError('模型任务队列已满，请等待当前任务完成后重试', 503))
        operation = { key, work, controller: new AbortController(), consumers: new Set(), running: false }
        operations.set(key, operation); queue.push(operation)
        operation.timer = setTimeout(() => cancel(operation!, new ModelRequestError('模型任务等待时间过长，请稍后重试', 503)), queueMs)
      }
      const shared = operation
      if (shared.consumers.size >= 128) return Promise.reject(new ModelRequestError('同型号请求过多，请稍后重试', 503))
      return new Promise<T>((resolve, reject) => {
        const abort = () => {
          shared.consumers.delete(consumer)
          consumer.cleanup()
          reject(signal.reason)
          if (!shared.consumers.size) cancel(shared, new ModelRequestError('模型请求已取消', 499))
        }
        const consumer: Consumer = { resolve: value => resolve(value as T), reject, cleanup: () => signal.removeEventListener('abort', abort) }
        shared.consumers.add(consumer)
        signal.addEventListener('abort', abort, { once: true })
        pump()
      })
    },
  }
}
