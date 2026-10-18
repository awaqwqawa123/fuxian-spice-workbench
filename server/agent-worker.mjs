import { parentPort, workerData } from 'node:worker_threads'
// Run the same bundled ngspice worker used by the schematic UI.
globalThis.self = globalThis
globalThis.postMessage = message => parentPort.postMessage(message)
await import(workerData.bundle)
parentPort.on('message', data => globalThis.onmessage({ data }))
parentPort.postMessage({ type: 'ready' })
