import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createDesktopCircuitMiddleware } from '../server/desktop-circuit-middleware'
import { blankProject } from '../src/core/editor'

const projectDirectory = fileURLToPath(new URL('..', import.meta.url))
const installer = join(projectDirectory, 'scripts', 'workbench-bridge-install.mjs')
type Command = { command: string; args: string[] }

function run({ command, args }: Command, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, { env, windowsHide: true, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error)
      else resolve({ code: Number(error?.code ?? 0), stdout, stderr })
    })
  })
}

async function instance(t: TestContext, directory: string, mcpBridgeDirectory: string) {
  const middleware = createDesktopCircuitMiddleware({ directory, projectDirectory, mcpBridgeDirectory })
  const server = createServer((req, res) => { void middleware(req, res, () => res.writeHead(404).end()) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let closed = false
  async function close() {
    if (closed) return
    closed = true
    try { await middleware.close() }
    finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  }
  t.after(close)
  await middleware.manager.connect(origin)
  const info = async () => {
    const response = await fetch(`${origin}/api/desktop-circuit/mcp-info`, { headers: { 'x-fuxian-desktop': '1' } })
    assert.equal(response.status, 200)
    return response.json()
  }
  const activate = (body: object = {}, headers: Record<string, string> = {}) => fetch(`${origin}/api/desktop-circuit/mcp-bridge`, {
    method: 'POST', headers: { origin, 'x-fuxian-desktop': '1', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { middleware, origin, info, activate, close, connection: join(directory, 'connection.json') }
}

test('stable local MCP config isolates two installations and needs an explicit same-workspace relink after moving', { timeout: 35_000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'fuxian-mcp-bridge-'))
  const stable = join(temp, '用户 配置')
  const env = { ...process.env, FUXIAN_MCP_BRIDGE_DIR: stable }
  const aDirectory = join(temp, '工程 甲')
  const bDirectory = join(temp, '工程 乙')
  const a = await instance(t, aDirectory, stable), b = await instance(t, bDirectory, stable)
  t.after(() => rm(temp, { recursive: true, force: true }))
  const register = (...args: string[]) => run({ command: process.execPath, args: [installer, ...args] }, env)
  const inspect = (config: Command) => run({ ...config, args: [...config.args, '--doctor', '--json'] }, env)
  const aId = a.middleware.manager.workspaceId!, bId = b.middleware.manager.workspaceId!
  assert.notEqual(aId, bId)
  await a.middleware.manager.sync({ projectId: 'project-a', project: { ...blankProject(), title: '合成项目甲' }, expectedRevision: null })
  const aConnection = JSON.parse(await readFile(a.connection, 'utf8'))
  const bConnection = JSON.parse(await readFile(b.connection, 'utf8'))
  const firstInfo = await a.info()
  assert.equal(firstInfo.bridgeStatus, 'unlinked')
  assert.deepEqual(firstInfo.config.mcpServers.fuxian.args.slice(-2), ['--workspace', aId])
  assert.equal((await a.activate({}, { origin: 'http://localhost:1234' })).status, 403)
  assert.equal((await a.activate({}, { 'x-fuxian-desktop': '' })).status, 403)
  assert.equal((await a.activate({ workspaceId: bId, connection: b.connection })).status, 400)
  assert.equal((await a.info()).bridgeStatus, 'unlinked')
  const activated = await a.activate()
  assert.equal(activated.status, 200)
  const activation = await activated.json()
  assert.equal(activation.bridgeStatus, 'linked')
  const first = await register('--link', '--connection', a.connection)
  assert.equal(first.code, 0, first.stderr)
  const second = await register('--link', '--connection', b.connection)
  assert.equal(second.code, 0, second.stderr)
  assert.ok(!first.stdout.includes(aConnection.token) && !second.stdout.includes(bConnection.token))
  assert.ok(!first.stdout.includes('工程 甲') && !second.stdout.includes('工程 乙'))
  const aConfig: Command = JSON.parse(first.stdout).mcpServers.fuxian
  assert.deepEqual(activation.config.mcpServers.fuxian, aConfig)
  const bConfig: Command = JSON.parse(second.stdout).mcpServers.fuxian
  assert.equal(aConfig.command, bConfig.command)
  assert.notDeepEqual(aConfig.args, bConfig.args)
  assert.equal((await a.info()).bridgeStatus, 'linked')
  assert.deepEqual((await a.info()).config.mcpServers.fuxian, aConfig)
  assert.equal(JSON.parse((await inspect(aConfig)).stdout).projectCount, 1)
  assert.equal(JSON.parse((await inspect(bConfig)).stdout).status, 'project_sync_required')

  const invalidHttp = await fetch(`${b.origin}/api/desktop-circuit/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bConnection.token}`, 'x-fuxian-workspace': aId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(invalidHttp.status, 409)
  const wrongLink = await register('--relink', '--workspace', aId, '--connection', b.connection)
  assert.equal(wrongLink.code, 1)
  assert.match(wrongLink.stderr, /工作区标识不一致/)
  assert.equal(JSON.parse((await inspect(aConfig)).stdout).projectCount, 1)

  await a.close()
  const moved = join(temp, '迁移后 工程甲')
  await rename(aDirectory, moved)
  const movedA = await instance(t, moved, stable)
  try {
    assert.equal(movedA.middleware.manager.workspaceId, aId)
    assert.equal((await movedA.info()).bridgeStatus, 'relink-required')
    assert.equal((await movedA.activate()).status, 409)
    const movedConnection = JSON.parse(await readFile(movedA.connection, 'utf8'))
    const stale = await inspect(aConfig)
    assert.equal(stale.code, 8)
    assert.equal(JSON.parse(stale.stdout).status, 'workspace_mismatch')
    assert.equal((await register('--link', '--connection', movedA.connection)).code, 1)
    const spoofed = join(temp, 'placeholder.json')
    await writeFile(spoofed, JSON.stringify({ ...bConnection, workspaceId: aId }))
    const rejected = await register('--relink', '--workspace', aId, '--connection', spoofed)
    assert.equal(rejected.code, 1)
    assert.match(rejected.stderr, /未确认/)
    const relinked = await register('--relink', '--workspace', aId, '--connection', movedA.connection)
    assert.equal(relinked.code, 0, relinked.stderr)
    assert.equal(relinked.stdout, first.stdout)
    assert.equal((await movedA.info()).bridgeStatus, 'linked')
    assert.notEqual(movedConnection.token, aConnection.token)
    assert.equal(JSON.parse((await inspect(aConfig)).stdout).projectCount, 1)
    assert.equal(JSON.parse((await inspect(bConfig)).stdout).status, 'project_sync_required')
  } finally { await movedA.close(); await b.close() }
})
