import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const dataDirectory = () => process.env.CODEX_DESKTOP_CONTROL_DIRECTORY || join(homedir(), '.codex', 'desktop-control')
export const discoveryFile = () => process.env.CODEX_DESKTOP_CONTROL_DISCOVERY || join(dataDirectory(), 'discovery.json')
export function pipeName(directory) {
  const suffix = createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0, 24)
  return process.platform === 'win32' ? `\\\\.\\pipe\\codex-desktop-control-${suffix}` : join(directory, 'broker.sock')
}
export function framedJson(stream, receive, fail, limit = 16 * 1024 * 1024) {
  let buffer = '', first = true
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    if (first) { chunk = chunk.replace(/^\uFEFF/, ''); first = false }
    buffer += chunk
    if (Buffer.byteLength(buffer) > limit) { fail(new Error('Broker message exceeds limit')); return }
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1)
      if (!line) continue
      try { receive(JSON.parse(line)) } catch (error) { fail(error); return }
    }
  })
}
export function writeJson(stream, value) { if (stream?.writable && !stream.destroyed) stream.write(`${JSON.stringify(value)}\n`) }
