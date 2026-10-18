import { access, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
export interface CursorLaunch { executable: string; argsPrefix: string[] }
const exists = (file: string) => access(file).then(() => true, () => false)
/** Resolve only the official package structure; never execute cmd/ps1 text or a shell. */
export async function resolveCursorLaunch(executable: string, argsPrefix: string[] = []): Promise<CursorLaunch> {
  if (!/\.(?:cmd|ps1)$/i.test(executable)) return { executable, argsPrefix }
  if (!/^(?:cursor-agent|agent)\.(?:cmd|ps1)$/i.test(basename(executable))) throw new Error('Cursor 启动脚本名称不受支持')
  const parent = dirname(executable), dirs = [parent]
  const versions = await readdir(join(parent, 'versions'), { withFileTypes: true }).catch(() => [])
  dirs.push(...versions.filter(item => item.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(item.name)).map(item => join(parent, 'versions', item.name)).sort().reverse())
  for (const directory of dirs) if (await exists(join(directory, 'node.exe')) && await exists(join(directory, 'index.js'))) return { executable: join(directory, 'node.exe'), argsPrefix: [join(directory, 'index.js'), ...argsPrefix] }
  throw new Error('Cursor Windows CLI 包缺少 node.exe 或 index.js，请重新安装官方 CLI')
}
export async function findManagedCursorExecutable(directory = process.cwd()): Promise<string | null> {
  const root = resolve(directory, 'runtime', 'cursor-agent')
  try {
    const info = JSON.parse(await readFile(join(root, 'active.json'), 'utf8'))
    if (typeof info.version !== 'string' || !/^\d{4}\.\d{2}\.\d{2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]{5,40}$/.test(info.version)) return null
    const executable = join(root, info.version, 'cursor-agent.cmd')
    return await exists(executable) ? executable : null
  } catch { return null }
}
