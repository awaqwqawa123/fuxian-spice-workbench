import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const WORKSPACE_HEADER = 'x-fuxian-workspace'
export const workspaceIdIsValid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value)

export function workbenchBridgeDirectory(env = process.env, platform = process.platform) {
  const base = env.FUXIAN_MCP_BRIDGE_DIR || (platform === 'win32'
    ? join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Fuxian', 'mcp-bridge')
    : join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'Fuxian', 'mcp-bridge'))
  if (!isAbsolute(base)) throw new Error('The local MCP bridge needs an absolute user data directory.')
  return resolve(base)
}

export function bridgePaths(root, platform = process.platform) {
  const bin = join(root, 'bin-v1')
  return { bin, command: join(bin, platform === 'win32' ? 'node.exe' : 'node'),
    script: join(bin, 'workbench-mcp.mjs'), helper: join(bin, 'workbench-bridge-store.mjs') }
}

export async function readSmallFile(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.size > 65536) throw new Error('Expected a small local file.')
  const raw = await readFile(path, 'utf8')
  if (raw.length > 65536) throw new Error('Local file exceeds its size limit.')
  return JSON.parse(raw.replace(/^\uFEFF/, ''))
}

export async function publishBridgeFile(path, value, create) {
  const temporary = join(dirname(path), `fuxian-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
    if (create) await link(temporary, path)
    else await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}

export async function workspaceIdentity(directory) {
  const path = join(directory, 'workspace-identity.json')
  async function read() {
    const value = await readSmallFile(path)
    if (value?.version !== 1 || !workspaceIdIsValid(value.workspaceId)) throw new Error('Local workspace identity is invalid.')
    return value.workspaceId
  }
  try { return await read() }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  try { await publishBridgeFile(path, { version: 1, workspaceId: randomUUID() }, true) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  return await read()
}

export function bridgeBindingPath(root, workspaceId) {
  if (!workspaceIdIsValid(workspaceId)) throw new Error('The workspace identity is invalid.')
  return join(root, 'workspaces', `${workspaceId}.json`)
}

export async function bridgeBinding(root, workspaceId) {
  const value = await readSmallFile(bridgeBindingPath(root, workspaceId))
  if (!isObject(value) || Object.keys(value).length !== 3 || value.version !== 1 || value.workspaceId !== workspaceId ||
    typeof value.connection !== 'string' || !isAbsolute(value.connection)) throw new Error('The workspace link is invalid.')
  return { connection: resolve(value.connection) }
}

export async function readLocalWorkbenchConnection(path) {
  const config = await readSmallFile(path)
  if (config?.version !== 1 || typeof config.url !== 'string' || typeof config.token !== 'string' ||
    config.workspaceId !== undefined && !workspaceIdIsValid(config.workspaceId)) throw new Error('The workbench connection is invalid.')
  const url = new URL(config.url)
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]+\/?$/.test(config.url) ||
    !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !/^[\x21-\x7e]{24,4096}$/.test(config.token)) throw new Error('The workbench connection is invalid.')
  return { origin: url.origin, token: config.token, workspaceId: config.workspaceId }
}

export function workbenchRequestHeaders(config, expectedWorkspace) {
  return {
    'Content-Type': 'application/json', Authorization: `Bearer ${config.token}`,
    ...(expectedWorkspace ? { [WORKSPACE_HEADER]: expectedWorkspace } : {}),
  }
}

export async function verifyWorkspaceEndpoint(config, expectedWorkspace, signal) {
  if (!workspaceIdIsValid(expectedWorkspace) || config.workspaceId !== expectedWorkspace) {
    throw new Error('Workspace identity does not match. Re-link the same workspace explicitly.')
  }
  const response = await fetch(`${config.origin}/api/desktop-circuit/mcp-identity`, {
    method: 'GET', redirect: 'error', headers: workbenchRequestHeaders(config, expectedWorkspace), signal,
  })
  await response.body?.cancel()
  if (response.status !== 204 || response.headers.get(WORKSPACE_HEADER) !== expectedWorkspace) {
    throw new Error('The running workbench could not confirm its workspace identity.')
  }
}

export async function bridgeHasAssets(root) {
  const { command, script, helper } = bridgePaths(root)
  try { return (await Promise.all([command, script, helper].map(path => lstat(path)))).every(info => info.isFile()) }
  catch { return false }
}

export async function ensureBridgeDirectories(root) {
  await mkdir(join(root, 'workspaces'), { mode: 0o700, recursive: true })
}
