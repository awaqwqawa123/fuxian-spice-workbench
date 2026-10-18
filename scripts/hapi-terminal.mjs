import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const id = process.argv[2]
if (!id || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error('Usage: node scripts/hapi-terminal.mjs <HAPI session ID>')
const c = JSON.parse(await readFile(new URL('../.hapi-local/connection.json', import.meta.url), 'utf8'))
const env = { ...process.env, HAPI_HOME: c.dataDirectory, HAPI_API_URL: c.url, CLI_API_TOKEN: c.token }
if (!env.TERM || env.TERM === 'dumb') env.TERM = 'xterm-256color'
for (const key of ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_PERMISSION_PROFILE', 'CODEX_CI', 'CODEX_SHELL', 'CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE', 'NODE_OPTIONS']) delete env[key]
const child = spawn(c.executable, ['resume', id], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
