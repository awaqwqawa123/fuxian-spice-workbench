#!/usr/bin/env node
import { copyFile, mkdtemp, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  bridgeBinding, bridgeBindingPath, bridgeHasAssets, bridgePaths, ensureBridgeDirectories,
  publishBridgeFile, readLocalWorkbenchConnection, verifyWorkspaceEndpoint, workbenchBridgeDirectory, workspaceIdIsValid,
} from './workbench-bridge-store.mjs'

const source = dirname(fileURLToPath(import.meta.url))
const help = `伏线 MCP 固定入口

node scripts/workbench-bridge-install.mjs --link --connection ABSOLUTE_FILE
node scripts/workbench-bridge-install.mjs --relink --workspace ID --connection ABSOLUTE_FILE

运行目标工作台后执行。移动后请保留原工作区数据，从新地址显式重新关联。
输出可复制到客户端的通用 MCP JSON；不会修改客户端配置。`

async function installAssets(root, sourceDirectory) {
  const { bin, command, script, helper } = bridgePaths(root)
  if (await bridgeHasAssets(root)) return
  const stage = await mkdtemp(join(root, '.bridge-'))
  const [stageCommand, stageScript, stageHelper] = [command, script, helper].map(path => join(stage, basename(path)))
  try {
    const copied = await Promise.allSettled([
      copyFile(process.execPath, stageCommand),
      copyFile(join(sourceDirectory, 'workbench-mcp.mjs'), stageScript),
      copyFile(join(sourceDirectory, 'workbench-bridge-store.mjs'), stageHelper),
    ])
    const error = copied.find(result => result.status === 'rejected')
    if (error) throw error.reason
    try { await rename(stage, bin) }
    catch (error) { if (!await bridgeHasAssets(root)) throw error }
  } finally {
    await Promise.allSettled([stageCommand, stageScript, stageHelper].map(path => unlink(path)))
    await rmdir(stage).catch(() => {})
  }
}

export class WorkbenchBridgeInstallError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const fail = (status, message) => new WorkbenchBridgeInstallError(status, message)

export async function installWorkbenchBridge({ connection: inputPath, expectedWorkspace, relink = false, root = workbenchBridgeDirectory(), sourceDirectory = source }) {
  let connection, config
  try {
    connection = await realpath(inputPath)
    config = await readLocalWorkbenchConnection(connection)
  } catch { throw fail(503, '无法读取本机工作台连接文件。请检查路径并启动目标工作台。') }
  const workspaceId = config.workspaceId
  if (!workspaceIdIsValid(workspaceId) || (expectedWorkspace !== undefined && workspaceId !== expectedWorkspace) || (relink && !expectedWorkspace)) {
    throw fail(409, '工作区标识不一致；请保留原工作区数据并选择对应的连接文件。')
  }
  try { await verifyWorkspaceEndpoint(config, workspaceId, AbortSignal.timeout(5000)) }
  catch { throw fail(503, '运行中的工作台未确认该工作区。请启动目标工作台再重试。') }

  const path = bridgeBindingPath(root, workspaceId)
  let existing
  try { existing = await bridgeBinding(root, workspaceId) }
  catch (error) { if (error.code !== 'ENOENT') throw fail(409, '已有关联记录无法读取；未覆盖原记录。') }
  if (relink && !existing) throw fail(409, '没有找到原关联记录；请使用首次关联。')
  if (!relink && existing && existing.connection !== connection) {
    throw fail(409, '该工作区已关联到其他位置；移动后请使用终端重新关联。')
  }
  try {
    await ensureBridgeDirectories(root)
    await installAssets(root, sourceDirectory)
    if (existing?.connection !== connection) {
      try { await publishBridgeFile(path, { version: 1, workspaceId, connection }, !existing) }
      catch (error) {
        if (error.code !== 'EEXIST' || (await bridgeBinding(root, workspaceId)).connection !== connection) throw error
      }
    }
  } catch {
    throw fail(503, '未能保存本机 MCP 关联；请检查用户数据目录后重试。')
  }
  const { command, script } = bridgePaths(root)
  return { mcpServers: { fuxian: { command, args: [script, '--workspace', workspaceId] } } }
}

async function main() {
  const [mode, flag, value, secondFlag, secondValue, ...extra] = process.argv.slice(2)
  if (mode === '--help' && !flag) { process.stdout.write(`${help}\n`); return }
  try {
    const first = mode === '--link' && flag === '--connection' && !secondFlag
    const relink = mode === '--relink' && flag === '--workspace' && workspaceIdIsValid(value) && secondFlag === '--connection'
    const path = first ? value : secondValue
    if ((!first && !relink) || extra.length || typeof path !== 'string' || !isAbsolute(path)) throw new Error(help)
    const config = await installWorkbenchBridge({ connection: resolve(path), expectedWorkspace: relink ? value : undefined, relink })
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`)
  } catch (error) {
    // Filesystem errors can contain user-specific paths. Only print curated diagnostics.
    process.stderr.write(`${error.code ? '无法安装或关联本机 MCP 入口，请检查用户数据目录是否可写。' : error.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main()
