import type { AgentToolScope } from './agent-tool-scope'
import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import { circuitAgentTools, createCircuitAgentTools } from '../src/core/agent-circuit'
import { listenOnSafeLoopbackPort } from './safe-loopback-port'

async function body(req: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = []
  for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; if (size > 384 * 1024) throw new Error('工具请求过大'); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Task-local Streamable HTTP MCP: only the registered candidate/model tools exist. */
export async function openCursorMcp(tools: Pick<ReturnType<typeof createCircuitAgentTools>, 'execute'>, signal: AbortSignal, definitions: AgentToolScope['definitions'] = circuitAgentTools) {
  const token = randomBytes(32).toString('hex'), serverName = 'fuxian_circuit'
  let queue = Promise.resolve(), toolCalls = 0
  const server = createServer((req, res) => {
    const json = (status: number, value: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) } }
    void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.authorization !== `Bearer ${token}` || req.headers.origin || req.url !== '/mcp') { json(403, { error: 'Denied' }); return }
      if (signal.aborted) { json(410, { error: 'Task stopped' }); return }
      if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(req.method === 'DELETE' ? 200 : 405); res.end(); return }
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) { json(405, { error: 'JSON POST required' }); return }
      const message = await body(req)
      if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { json(400, { error: 'Invalid JSON-RPC' }); return }
      if (message.id === undefined) { res.writeHead(202); res.end(); return }
      const send = (result: unknown) => json(200, { jsonrpc: '2.0', id: message.id, result })
      if (message.method === 'initialize') { send({ protocolVersion: ['2025-03-26', '2025-06-18', '2025-11-25'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: serverName, version: '0.18.0' } }); return }
      if (message.method === 'ping') { send({}); return }
      if (message.method === 'tools/list') { send({ tools: definitions.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) }); return }
      if (message.method !== 'tools/call' || !definitions.some(tool => tool.name === message.params?.name)) { json(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Only circuit tools are available' } }); return }
      if (++toolCalls > 18) { send({ isError: true, content: [{ type: 'text', text: '已达到本次任务工具调用上限' }] }); return }
      const operation = queue.then(() => tools.execute(message.params.name, message.params.arguments ?? {}))
      queue = operation.then(() => {}, () => {})
      try {
        const value = await operation as { figure?: { mimeType: string; dataBase64: string } }
        const figure = message.params.name === 'view_datasheet_curve' ? value?.figure : undefined
        if (figure && (!['image/png', 'image/jpeg'].includes(figure.mimeType) || typeof figure.dataBase64 !== 'string' || !figure.dataBase64)) throw new Error('规格书曲线图片格式不正确，未发送到模型')
        send({ content: [
          { type: 'text', text: JSON.stringify(figure ? { ...value, figure: { ...figure, dataBase64: undefined } } : value) },
          ...(figure ? [{ type: 'image', mimeType: figure.mimeType, data: figure.dataBase64 }] : []),
        ] })
      }
      catch (error) { send({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message.slice(0, 4000) : '电路工具执行失败' }] }) }
    })().catch(() => json(400, { error: 'Invalid MCP request' }))
  })
  server.requestTimeout = 10000; server.headersTimeout = 10000
  const abort = () => server.closeAllConnections()
  signal.addEventListener('abort', abort, { once: true })
  const port = await listenOnSafeLoopbackPort(server)
  const url = `http://127.0.0.1:${port}/mcp`
  return { token, serverName, url, get calls() { return toolCalls }, configuration: { type: 'http' as const, name: serverName, url, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] },
    async close() { signal.removeEventListener('abort', abort); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await queue },
  }
}
