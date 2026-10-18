import { parentPort, workerData } from 'node:worker_threads'

// Exercise the exact production worker bundle in Node, without a browser UI.
globalThis.self = globalThis
globalThis.postMessage = message => parentPort.postMessage(message)
await import(workerData.bundle)
parentPort.on('message', data => globalThis.onmessage({ data }))
parentPort.postMessage({ type: 'ready' })
