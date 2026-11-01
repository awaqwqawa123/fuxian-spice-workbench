import { createServer, preview } from 'vite'
import { fileURLToPath } from 'node:url'
import { runtimeOptions } from './runtime-options.mjs'

// Both modes load the same config and backend plugins. Normal use serves the
// built frontend, without a source watcher or on-demand module transforms.
const root = fileURLToPath(new URL('../', import.meta.url))
const { port, mode } = runtimeOptions(process.argv.slice(2), process.env, root)
process.env.FUXIAN_MODE = mode
const listener = { host: '127.0.0.1', port, strictPort: true, open: false }
const server = mode === 'development'
  ? await createServer({ root, server: { ...listener, hmr: false } })
  : await preview({ root, mode: 'production', preview: listener })
if (mode === 'development') await server.listen()
console.log(`Fuxian Workbench is ready at http://localhost:${port} (${mode})`)
if (process.send) process.send({ type: 'fuxian-service-ready', mode })
let closing = false
async function close() {
  if (closing) return
  closing = true
  await server.close()
  process.exit(0)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, close)
if (process.send) {
  process.on('message', (message) => {
    if (message?.type === 'fuxian-service-shutdown') void close()
  })
  process.once('disconnect', close)
}
