import { randomInt } from 'node:crypto'
import type { Server } from 'node:net'

// Windows can allocate ephemeral ports from 1024–15000, including ports that
// Fetch refuses to contact. Bind explicitly above the Fetch restricted range.
const FIRST_PORT = 30_000
const LAST_PORT_EXCLUSIVE = 60_000
const MAX_ATTEMPTS = 64

/** Start a local HTTP bridge on a port that Node/Fetch clients can address. */
export async function listenOnSafeLoopbackPort(server: Server, host = '127.0.0.1'): Promise<number> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const port = randomInt(FIRST_PORT, LAST_PORT_EXCLUSIVE)
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.off('listening', started); reject(error) }
        const started = () => { server.off('error', failed); resolve() }
        server.once('error', failed)
        server.once('listening', started)
        try { server.listen(port, host) }
        catch (error) { server.off('error', failed); server.off('listening', started); reject(error) }
      })
      return port
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
    }
  }
  throw new Error('Could not reserve a safe local HTTP port')
}
