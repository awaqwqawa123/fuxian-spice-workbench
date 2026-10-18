#!/usr/bin/env node
// Desktop Codex calls the already running workbench. No model or chat runtime is started.
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const HELP = `Desktop circuit tools — run from the Codex desktop conversation.

node scripts/desktop-circuit.mjs list
node scripts/desktop-circuit.mjs inspect --project ID [--source-task ID]
node scripts/desktop-circuit.mjs start --project ID --revision N --request TEXT --request-id ID [--layout-only] [--source-task ID]
node scripts/desktop-circuit.mjs call --task ID --name TOOL --input-file JSON_PATH
node scripts/desktop-circuit.mjs edit --task ID --revision N --operation-id ID --input-file OPERATIONS_JSON_PATH
node scripts/desktop-circuit.mjs diff --task ID [--revision N]
node scripts/desktop-circuit.mjs finish --task ID --summary TEXT
node scripts/desktop-circuit.mjs cancel --task ID

Use --request-file PATH or --summary-file PATH instead of inline text.
All commands accept --connection PATH and --output PATH. Output is JSON.
Default connection: ../.desktop-circuit/connection.json, relative to this script.
inspect returns the latest project revision and tool schemas. Never guess a revision.
Changes remain candidates until the user applies them in the webpage.
This tool exchanges circuit data; it does not send or synchronize chat messages.
`

let secret = ''
function safeText(value) {
  let text = String(value)
  if (secret) {
    text = text.split(secret).join('[redacted]')
    text = text.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]')
  }
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
    if (argv.length > 1) throw new Error('Help does not accept additional arguments.')
    return { command: 'help', options: new Map() }
  }
  const [command, ...rest] = argv
  const commandOptions = {
    list: [], inspect: ['project', 'source-task'],
    start: ['project', 'revision', 'request', 'request-file', 'request-id', 'layout-only', 'source-task'],
    call: ['task', 'name', 'input-file'],
    edit: ['task', 'revision', 'operation-id', 'input-file'], diff: ['task', 'revision'],
    finish: ['task', 'summary', 'summary-file'], cancel: ['task'],
  }
  if (!Object.hasOwn(commandOptions, command)) throw new Error('Unknown command. Run with --help for usage.')
  const allowed = new Set([...commandOptions[command], 'connection', 'output'])
  const options = new Map()
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    if (!flag.startsWith('--') || flag.includes('=')) throw new Error('Use named options in the form --option VALUE.')
    const name = flag.slice(2)
    if (!allowed.has(name)) throw new Error(`Unsupported option --${name.slice(0, 60)} for ${command}.`)
    if (options.has(name)) throw new Error(`Option --${name} was provided more than once.`)
    if (name === 'layout-only') options.set(name, true)
    else {
      const value = rest[++i]
      if (value === undefined || value.startsWith('--') || !value.trim()) throw new Error(`Missing value for --${name}.`)
      options.set(name, value)
    }
  }
  return { command, options }
}

function required(options, name, maxLength = 180) {
  const value = options.get(name)
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Required option --${name} is missing.`)
  if (value.length > maxLength || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid value for --${name}.`)
  return value
}

async function readText(path) {
  const file = resolve(path)
  let info
  try { info = await stat(file) } catch { throw new Error('Cannot read the specified local file.') }
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Input must be a regular file no larger than 8 MiB.')
  try { return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '') }
  catch { throw new Error('Cannot read the specified local file.') }
}

async function readJson(path) {
  try { return JSON.parse(await readText(path)) }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('The specified file contains invalid JSON.')
    throw error
  }
}

async function textOption(options, name) {
  if (options.has(name) === options.has(`${name}-file`)) throw new Error(`Provide exactly one of --${name} and --${name}-file.`)
  const text = options.has(name) ? options.get(name) : await readText(options.get(`${name}-file`))
  if (!text.trim() || text.length > 8000 || text.includes('\0')) throw new Error(`The ${name} must contain 1–8000 characters.`)
  return text
}

async function requestBody(command, options) {
  if (command === 'list') return {}
  if (command === 'inspect') return { projectId: required(options, 'project'), ...(options.has('source-task') ? { sourceTaskId: required(options, 'source-task') } : {}) }
  if (command === 'start') {
    const revision = required(options, 'revision')
    if (!/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new Error('--revision must be a non-negative safe integer returned by inspect.')
    return {
      projectId: required(options, 'project'), expectedRevision: Number(revision),
      requestId: required(options, 'request-id'), request: await textOption(options, 'request'),
      layoutOnly: options.get('layout-only') === true,
      ...(options.has('source-task') ? { sourceTaskId: required(options, 'source-task') } : {}),
    }
  }
  const taskId = required(options, 'task')
  if (command === 'cancel') return { taskId }
  if (command === 'finish') return { taskId, summary: await textOption(options, 'summary') }
  if (command === 'edit' || command === 'diff') {
    let expectedCandidateRevision
    if (command === 'edit' || options.has('revision')) {
      const revision = required(options, 'revision')
      if (!/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new Error('--revision must be the positive candidate revision returned by task inspection.')
      expectedCandidateRevision = Number(revision)
    }
    if (command === 'diff') return { taskId, ...(expectedCandidateRevision === undefined ? {} : { expectedCandidateRevision }) }
    const operationId = required(options, 'operation-id', 128)
    const operations = await readJson(required(options, 'input-file', 4096))
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 32) throw new Error('Edit input must be an array containing 1 to 32 operations.')
    return { taskId, expectedCandidateRevision, operationId, operations }
  }
  const name = required(options, 'name')
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(name)) throw new Error('Invalid tool name.')
  const input = await readJson(required(options, 'input-file', 4096))
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Tool input must be a JSON object.')
  return { taskId, name, input }
}

async function loadConnection(path) {
  const config = await readJson(path)
  if (!config || config.version !== 1 || typeof config.url !== 'string' || typeof config.token !== 'string') throw new Error('Invalid desktop circuit connection file; start the workbench service first.')
  // Only explicit numeric loopback HTTP origins. No DNS lookup or forwarded credentials.
  let url
  try { url = new URL(config.url) } catch { throw new Error('Invalid local workbench URL.') }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Connection URL must be an explicit http://127.0.0.1:PORT or http://[::1]:PORT origin.')
  }
  if (!/^[\x21-\x7e]{24,4096}$/.test(config.token)) throw new Error('Invalid local workbench credential.')
  secret = config.token
  return { origin: url.origin, token: config.token }
}

async function responseText(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('Workbench response exceeded 16 MiB.')
  const chunks = []
  let total = 0
  for await (const chunk of response.body ?? []) {
    total += chunk.length
    if (total > MAX_RESPONSE_BYTES) throw new Error('Workbench response exceeded 16 MiB.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (command === 'help') { process.stdout.write(HELP); return }
  const body = await requestBody(command, options)
  const connection = await loadConnection(options.get('connection') ?? resolve(scriptDir, '../.desktop-circuit/connection.json'))
  let response
  try {
    response = await fetch(`${connection.origin}/api/desktop-circuit/agent/${command}`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(command === 'call' && body.name === 'simulate_circuit' ? 120000 : 30000),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error('Workbench request timed out; inspect the task state in the webpage before retrying.')
    throw new Error('Cannot contact the local workbench, or it attempted a redirect. Check that its service is running.')
  }
  const raw = await responseText(response)
  let result
  try { result = JSON.parse(raw) } catch { throw new Error(`Workbench returned invalid JSON (HTTP ${response.status}).`) }
  if (!response.ok) {
    const detail = typeof result?.error === 'string' ? safeText(result.error).slice(0, 1600) : 'Request rejected.'
    throw new Error(`Workbench HTTP ${response.status}: ${detail}`)
  }
  const json = `${safeText(JSON.stringify(result, null, 2))}\n`
  if (options.has('output')) {
    const outputPath = resolve(options.get('output'))
    const connectionPath = resolve(options.get('connection') ?? resolve(scriptDir, '../.desktop-circuit/connection.json'))
    if (outputPath.toLowerCase() === connectionPath.toLowerCase()) throw new Error('Output cannot overwrite the connection file.')
    await writeFile(outputPath, json, 'utf8')
    process.stdout.write(`${JSON.stringify({ outputPath })}\n`)
  } else process.stdout.write(json)
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ error: safeText(error instanceof Error ? error.message : 'Desktop circuit command failed.').slice(0, 2000) })}\n`)
  process.exitCode = 1
})
