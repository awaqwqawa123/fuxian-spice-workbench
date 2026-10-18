import { createServer } from 'vite'

// Keep editor drafts intact while the development checkout is being verified.
const port = Number(process.env.FUXIAN_PORT ?? 3032)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('FUXIAN_PORT must be a valid local port')
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false } })
await server.listen()
console.log(`Fuxian Workbench is ready at http://localhost:${port}`)
if (process.send) process.send({ type: 'fuxian-service-ready' })
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
