#!/usr/bin/env node
// MCP stdio adapter for the already running local workbench. Never starts a GUI.
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const MAX_REQUEST = 2 * 1024 * 1024
const MAX_RESPONSE = 16 * 1024 * 1024
const secrets = new Set()
const pending = new Set()
const controllers = new Set()
const HELP = `伏安软件 MCP — connect a compatible stdio MCP client to the running workbench.

node scripts/workbench-mcp.mjs [--connection ABSOLUTE_PATH]
node scripts/workbench-mcp.mjs --print-config [--connection ABSOLUTE_PATH]
node scripts/workbench-mcp.mjs --doctor [--json] [--connection ABSOLUTE_PATH]
node scripts/workbench-mcp.mjs --help

Default connection: ../.desktop-circuit/connection.json relative to this script.
Start the workbench first. This adapter does not start a service or window.
Normal mode uses newline-delimited JSON-RPC on stdin/stdout only.
--print-config prints client configuration without the local credential.
--doctor checks the connection, MCP handshake, tools and synchronized project count.
It is read-only, has a total 10-second deadline and prints no project names or credentials.
Doctor exit codes: 0 ready; 2 missing connection; 3 invalid connection;
4 unavailable service; 5 authorization failed; 6 invalid protocol; 7 project sync required.
`

function options(argv) {
  const result = { connection: resolve(dirname(script), '../.desktop-circuit/connection.json') }
  const seen = new Set()
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (seen.has(flag)) throw new Error('Duplicate option. See --help.')
    seen.add(flag)
    if (flag === '--help') result.help = true
    else if (flag === '--print-config') result.print = true
    else if (flag === '--doctor') result.doctor = true
    else if (flag === '--json') result.json = true
    else if (flag === '--connection') {
      const path = argv[++i]
      if (!path || !isAbsolute(path)) throw new Error('--connection requires an absolute file path.')
      result.connection = resolve(path)
    } else throw new Error('Unknown option. See --help.')
  }
  if (result.help && argv.length !== 1) throw new Error('--help does not accept other options.')
  if (result.json && !result.doctor || result.doctor && result.print) throw new Error('Invalid option combination. See --help.')
  return result
}

function redact(text) {
  let safe = String(text)
  for (const secret of secrets) {
    safe = safe.split(secret).join('[redacted]')
    safe = safe.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]')
  }
  return safe.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
}

function reply(value) { process.stdout.write(`${redact(JSON.stringify(value))}\n`) }
function fault(id, code, message) { reply({ jsonrpc: '2.0', id, error: { code, message } }) }

async function connection(path) {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 65536) throw new Error()
    const config = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
    if (config?.version !== 1 || typeof config.url !== 'string' || typeof config.token !== 'string') throw new Error()
    const url = new URL(config.url)
    if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]+\/?$/.test(config.url)
      || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !/^[\x21-\x7e]{24,4096}$/.test(config.token)) throw new Error()
    secrets.add(config.token)
    return { origin: url.origin, token: config.token }
  } catch (cause) {
    const error = new Error('Cannot read a valid local connection. Start the workbench and check the connection file.')
    error.diagnosticStatus = cause.code === 'ENOENT' ? 'connection_missing' : 'connection_invalid'
    throw error
  }
}

const doctorOutcomes = {
  ready: [0, 'MCP service ready; synchronized projects available.'],
  connection_missing: [2, 'Local connection file missing. Start the workbench first.'],
  connection_invalid: [3, 'Local connection file invalid or unreadable. Check the workbench connection.'],
  service_unavailable: [4, 'Local service unavailable or diagnostic deadline exceeded.'],
  auth_failed: [5, 'Local service rejected authorization. Refresh the workbench connection.'],
  protocol_failed: [6, 'MCP response or required read-only tools invalid. Check service compatibility.'],
  project_sync_required: [7, 'MCP service ready; open a project in the workbench to synchronize it.'],
}
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value)
function diagnosticFailure(status) {
  const error = new Error()
  error.diagnosticStatus = status
  return error
}

// Separate read-only flow: never emit server-controlled text into diagnostic output.
async function doctor(path) {
  let phase = 'connection'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  const fail = status => { throw diagnosticFailure(status) }
  try {
    await connection(path)
    async function call(request) {
      let config = await connection(path)
      let response
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch(`${config.origin}/api/desktop-circuit/mcp`, {
            method: 'POST', redirect: 'error',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
            body: JSON.stringify(request), signal: controller.signal,
          })
        } catch { fail('service_unavailable') }
        if (response.status !== 403 || attempt !== 0) break
        await response.body?.cancel()
        const refreshed = await connection(path)
        if (refreshed.origin === config.origin && refreshed.token === config.token) fail('auth_failed')
        config = refreshed
      }
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); fail('auth_failed') }
      if (!response.ok) { await response.body?.cancel(); fail(response.status >= 500 ? 'service_unavailable' : 'protocol_failed') }
      if (!Object.hasOwn(request, 'id')) {
        await response.body?.cancel()
        if (response.status !== 202 && response.status !== 204) fail('protocol_failed')
        return
      }
      let result
      try { result = JSON.parse(await responseText(response)) }
      catch { fail(controller.signal.aborted ? 'service_unavailable' : 'protocol_failed') }
      if (!isObject(result) || result.jsonrpc !== '2.0' || result.id !== request.id
        || !Object.hasOwn(result, 'result') || Object.hasOwn(result, 'error')) fail('protocol_failed')
      return result.result
    }
    phase = 'initialize'
    const initialized = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fuxian-mcp-doctor', version: '1.0.0' },
    } })
    if (!isObject(initialized) || !['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(initialized.protocolVersion)
      || !isObject(initialized.capabilities) || !isObject(initialized.capabilities.tools)
      || !isObject(initialized.serverInfo) || typeof initialized.serverInfo.name !== 'string' || !initialized.serverInfo.name
      || typeof initialized.serverInfo.version !== 'string' || !initialized.serverInfo.version) fail('protocol_failed')
    await call({ jsonrpc: '2.0', method: 'notifications/initialized' })
    phase = 'tools'
    const tools = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    if (!isObject(tools) || !Array.isArray(tools.tools) || tools.nextCursor !== undefined
      || tools.tools.some(tool => !isObject(tool) || typeof tool.name !== 'string' || !tool.name
        || !isObject(tool.inputSchema) || tool.inputSchema.type !== 'object')
      || new Set(tools.tools.map(tool => tool.name)).size !== tools.tools.length
      || !tools.tools.some(tool => tool.name === 'list_projects')) fail('protocol_failed')
    phase = 'projects'
    const listed = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } })
    if (!isObject(listed) || listed.isError === true || listed.isError !== undefined && listed.isError !== false
      || !Array.isArray(listed.content) || listed.content.some(item => !isObject(item) || item.type !== 'text' || typeof item.text !== 'string')) fail('protocol_failed')
    let projects = listed.structuredContent
    if (projects === undefined) {
      if (listed.content.length !== 1) fail('protocol_failed')
      try { projects = JSON.parse(listed.content[0].text) } catch { fail('protocol_failed') }
    }
    if (!isObject(projects) || !Array.isArray(projects.projects)
      || projects.projects.some(project => !isObject(project) || typeof project.projectId !== 'string' || !project.projectId
        || typeof project.title !== 'string' || !Number.isSafeInteger(project.revision) || project.revision < 1)) fail('protocol_failed')
    return { status: projects.projects.length ? 'ready' : 'project_sync_required', ready: true,
      phase: 'complete', toolCount: tools.tools.length, projectCount: projects.projects.length }
  } catch (error) {
    return { status: Object.hasOwn(doctorOutcomes, error.diagnosticStatus) ? error.diagnosticStatus : 'protocol_failed', ready: false, phase }
  } finally { clearTimeout(timer) }
}

async function responseText(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) {
    await response.body?.cancel()
    throw new Error('Workbench response exceeds 16 MiB.')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.length
    if (size > MAX_RESPONSE) throw new Error('Workbench response exceeds 16 MiB.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function forward(request, path) {
  const hasId = Object.hasOwn(request, 'id')
  const controller = new AbortController()
  controllers.add(controller)
  const timer = setTimeout(() => controller.abort(), 120000)
  try {
    let config = await connection(path)
    let response
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch(`${config.origin}/api/desktop-circuit/mcp`, {
          method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
          body: JSON.stringify(request), signal: controller.signal,
        })
      } catch {
        throw new Error('Local workbench request interrupted or unavailable. Check task status before retrying; the request was not resent.')
      }
      // Only a definite authorization rejection is safe to retry after rotation.
      if (response.status !== 403 || attempt !== 0) break
      await response.body?.cancel()
      const refreshed = await connection(path)
      if (refreshed.origin === config.origin && refreshed.token === config.token) {
        if (hasId) fault(request.id, -32000, 'Workbench rejected the request (HTTP 403).')
        return
      }
      config = refreshed
    }
    if (!hasId) { await response.body?.cancel(); return }
    const raw = await responseText(response)
    let result
    try { result = JSON.parse(raw) } catch { throw new Error(`Workbench returned invalid JSON (HTTP ${response.status}).`) }
    if (result?.jsonrpc === '2.0' && result.id === request.id
      && (Object.hasOwn(result, 'result') !== Object.hasOwn(result, 'error'))
      && (!Object.hasOwn(result, 'error') || (Number.isInteger(result.error?.code) && typeof result.error?.message === 'string'))) {
      reply(result)
    } else if (!response.ok) {
      fault(request.id, -32000, `Workbench rejected the request (HTTP ${response.status}).`)
    } else throw new Error('Workbench returned an invalid JSON-RPC response.')
  } catch (error) {
    if (hasId) fault(request.id, -32000, redact(error.message))
    else process.stderr.write('Workbench notification could not be delivered.\n')
  } finally {
    clearTimeout(timer)
    controllers.delete(controller)
  }
}

function dispatch(line, path) {
  if (!line.length || !line.toString('utf8').trim()) return
  let request
  try { request = JSON.parse(line.toString('utf8')) }
  catch { fault(null, -32700, 'Invalid JSON. Send one JSON-RPC message per line.'); return }
  const validId = typeof request?.id === 'string' || (typeof request?.id === 'number' && Number.isFinite(request.id)) || request?.id === null
  if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
    || !request.method.length || (Object.hasOwn(request, 'id') && !validId)
    || (Object.hasOwn(request, 'params') && (!request.params || typeof request.params !== 'object'))) {
    fault(validId ? request.id : null, -32600, 'Invalid JSON-RPC request.'); return
  }
  if (pending.size >= 128) {
    if (Object.hasOwn(request, 'id')) fault(request.id, -32000, 'Too many concurrent requests. Wait for pending requests to finish.')
    return
  }
  const work = forward(request, path)
  pending.add(work)
  void work.finally(() => pending.delete(work))
}

async function serve(path) {
  const stop = () => {
    for (const controller of controllers) controller.abort()
    process.stdin.destroy()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // Buffer bytes until newline, bounded even when a client never sends a newline.
  let parts = []
  let size = 0
  let oversized = false
  try { for await (const chunk of process.stdin) {
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(start, end)
      size += part.length
      if (!oversized && size > MAX_REQUEST) {
        parts = []
        oversized = true
        fault(null, -32700, 'JSON-RPC message exceeds 2 MiB.')
      }
      if (!oversized) parts.push(part)
      if (newline >= 0) {
        if (!oversized) dispatch(Buffer.concat(parts, size), path)
        parts = []; size = 0; oversized = false
      }
      start = end + 1
    }
  } } catch (error) {
    if (!process.stdin.destroyed) throw error
  }
  if (size && !oversized) dispatch(Buffer.concat(parts, size), path)
  // Each request has its own bounded timeout; EOF drains outstanding work.
  await Promise.allSettled([...pending])
}

try {
  const args = options(process.argv.slice(2))
  if (args.help) process.stdout.write(HELP)
  else if (args.doctor) {
    const result = await doctor(args.connection)
    const [code, message] = doctorOutcomes[result.status]
    process.stdout.write(args.json ? `${JSON.stringify({ ...result, message })}\n` : `${result.status}: ${message}${result.ready ? ` Tools: ${result.toolCount}. Projects: ${result.projectCount}.` : ''}\n`)
    process.exitCode = code
  }
  else if (args.print) process.stdout.write(`${JSON.stringify({ mcpServers: { fuxian: {
    command: process.execPath, args: [script, '--connection', args.connection],
  } } }, null, 2)}\n`)
  else await serve(args.connection)
} catch {
  process.stderr.write('MCP adapter could not start. Check arguments with --help.\n')
  process.exitCode = 1
}
