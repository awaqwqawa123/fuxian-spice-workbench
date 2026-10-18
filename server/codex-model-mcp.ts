import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import { circuitAgentTools, type createCircuitAgentTools } from '../src/core/agent-circuit'
import { listenOnSafeLoopbackPort } from './safe-loopback-port'

const supplementalTools = ['search_spice_models', 'download_spice_model', 'import_spice_model', 'set_measurement_probes', 'configure_waveforms']
const readOnlyTools = new Set(['search_spice_models', 'download_spice_model'])
const serverName = 'fuxian_models'
async function readBody(req: IncomingMessage) {
  let size = 0
  const chunks: Buffer[] = []
  for await (const part of req) {
    const chunk = Buffer.from(part); size += chunk.length
    if (size > 192 * 1024) throw new Error('模型工具请求过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Per-turn official MCP bridge upgrades old durable threads without changing their history or global configuration. */
export async function openCodexModelMcp(tools: Pick<ReturnType<typeof createCircuitAgentTools>, 'execute'>, signal: AbortSignal, options: {
  /** Server/test-only schema override, never supplied by HTTP input. */
  definitions?: readonly { name: string; description: string; parameters: unknown }[]
} = {}) {
  const token = randomBytes(32).toString('hex')
  // An explicit scope replaces the default; never add mutations to a read-only scope.
  const definitions = options.definitions ?? circuitAgentTools.filter(tool => supplementalTools.includes(tool.name))
  let queue = Promise.resolve(), pending = 0
  const server = createServer((req, res) => {
    const json = (status: number, value: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) } }
    void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.authorization !== `Bearer ${token}` || req.headers.origin || req.url !== '/mcp') { json(403, { error: 'Denied' }); return }
      if (signal.aborted) { json(410, { error: 'Task stopped' }); return }
      if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(req.method === 'DELETE' ? 200 : 405); res.end(); return }
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) { json(405, { error: 'JSON POST required' }); return }
      const message = await readBody(req)
      if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { json(400, { error: 'Invalid JSON-RPC' }); return }
      if (message.id === undefined) { res.writeHead(202); res.end(); return }
      const send = (result: unknown) => json(200, { jsonrpc: '2.0', id: message.id, result })
      if (message.method === 'initialize') { send({ protocolVersion: ['2025-03-26', '2025-06-18', '2025-11-25'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: serverName, version: '0.19.5' } }); return }
      if (message.method === 'ping') { send({}); return }
      if (message.method === 'tools/list') { send({ tools: definitions.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters,
        annotations: { readOnlyHint: readOnlyTools.has(tool.name), destructiveHint: false, idempotentHint: true, openWorldHint: readOnlyTools.has(tool.name) },
      })) }); return }
      const name = message.params?.name
      if (message.method !== 'tools/call' || !definitions.some(tool => tool.name === name)) { json(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Only listed circuit compatibility tools are available' } }); return }
      pending++
      const operation = queue.then(() => tools.execute(name, message.params.arguments ?? {})).finally(() => { pending-- })
      queue = operation.then(() => {}, () => {})
      try {const value=await operation as {figure?:{mimeType:string;dataBase64:string}};const figure=name==='view_datasheet_curve'?value.figure:undefined;send({ content: [{ type: 'text', text: JSON.stringify(figure?{...value,figure:{...figure,dataBase64:undefined}}:value) },...(figure?[{type:'image',mimeType:figure.mimeType,data:figure.dataBase64}]:[])] }) }
      catch (error) { send({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message.slice(0, 2000) : '模型工具执行失败' }] }) }
    })().catch(() => json(400, { error: 'Invalid MCP request' }))
  })
  server.requestTimeout = 10000; server.headersTimeout = 10000
  const abort = () => server.closeAllConnections()
  signal.addEventListener('abort', abort, { once: true })
  const port = await listenOnSafeLoopbackPort(server)
  let closing: Promise<void> | undefined
  return { serverName, toolNames: definitions.map(tool => tool.name), get pending() { return pending },
    configuration: { url: `http://127.0.0.1:${port}/mcp`, http_headers: { Authorization: `Bearer ${token}` }, enabled: true },
    close() {
      if (!closing) closing = (async () => { signal.removeEventListener('abort', abort); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await queue })()
      return closing
    },
  }
}
