import { createServer, type Server } from 'node:net'

// Explicitly avoid the host's ephemeral range (which may include fetch's
// forbidden ports) and keep test listeners clear of the workbench's 3032 port.
const FIRST_PORT = 20_000
const LAST_PORT = 60_000
const RANGE = LAST_PORT - FIRST_PORT + 1
let allocation = 0

function bind(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { server.off('listening', onListening); server.off('error', onError) }
    const onListening = () => { cleanup(); resolve() }
    const onError = (error: Error) => { cleanup(); reject(error) }
    server.once('listening', onListening)
    server.once('error', onError)
    try { server.listen(port, host) } catch (error) { cleanup(); reject(error) }
  })
}

/** Bind an HTTP or TCP fixture to a fetch-safe port and leave it listening. */
export async function listenOnSafeTestPort(server: Server, host = '127.0.0.1'): Promise<number> {
  if (server.listening) throw new Error('Test server is already listening')
  const start = (process.pid * 1031 + allocation++ * 2039) % RANGE
  for (let attempt = 0; attempt < 256; attempt++) {
    const candidate = FIRST_PORT + (start + attempt * 7919) % RANGE
    try { await bind(server, host, candidate); return candidate }
    catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  throw new Error(`No available test port in ${FIRST_PORT}–${LAST_PORT}`)
}

/** Reserve, verify and release a port for a fixture that binds in another process. */
export async function availableSafeTestPort(host = '127.0.0.1'): Promise<number> {
  const server = createServer()
  const port = await listenOnSafeTestPort(server, host)
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}
