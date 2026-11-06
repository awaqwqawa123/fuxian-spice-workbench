import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

export class CodexInstallationError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** Validate an executable path, never a shell command or a browser-upload path. */
export async function validateCodexExecutable(input: string): Promise<string> {
  let selected = input.trim()
  if (selected.startsWith('"') && selected.endsWith('"')) selected = selected.slice(1, -1)
  if (!selected || selected.length > 2048 || /[\u0000-\u001f\u007f"]/.test(selected) || !isAbsolute(selected)) throw new CodexInstallationError(400, '请输入 Codex 程序的完整绝对路径，例如 C:\\程序目录\\codex.exe')
  if (process.platform === 'win32' ? !/\.exe$/i.test(selected) : basename(selected) !== 'codex') throw new CodexInstallationError(400, '请选择 Codex 可执行程序；Windows 使用 .exe，不支持命令参数、脚本或快捷方式')
  try {
    const executable = await realpath(selected)
    if (!(await stat(executable)).isFile()) throw new CodexInstallationError(400, 'Codex 安装路径必须是程序文件，不能是文件夹')
    await access(executable, constants.R_OK | (process.platform === 'win32' ? 0 : constants.X_OK))
    return executable
  } catch (cause) {
    if (cause instanceof CodexInstallationError) throw cause
    throw new CodexInstallationError(400, '该 Codex 程序不存在或无法访问，请核对完整安装路径')
  }
}

export class CodexInstallationStore {
  constructor(readonly directory: string) {}
  private get file() { return join(this.directory, 'codex-installation.json') }

  async read(): Promise<string | null> {
    let raw: string
    try { raw = await readFile(this.file, 'utf8') }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new CodexInstallationError(500, '无法读取 Codex 安装路径设置，请检查本机目录权限')
    }
    try {
      if (raw.length > 8192) throw new Error('oversized')
      const value = JSON.parse(raw)
      if (!value || value.version !== 1 || value.executable !== null && (typeof value.executable !== 'string' || value.executable.length > 2048 || !isAbsolute(value.executable) || /[\u0000-\u001f\u007f]/.test(value.executable))) throw new Error('invalid')
      return value.executable
    } catch { throw new CodexInstallationError(500, 'Codex 安装路径设置已损坏；可恢复自动检测，原登录与对话不受影响') }
  }

  async selectedExecutable(): Promise<string | null> {
    const selected = await this.read()
    return selected === null ? null : validateCodexExecutable(selected)
  }

  async update(input: unknown): Promise<string | null> {
    if (input !== null && typeof input !== 'string') throw new CodexInstallationError(400, 'Codex 安装路径格式不正确')
    const selected = input === null ? null : await validateCodexExecutable(input)
    await mkdir(this.directory, { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, executable: selected }), { mode: 0o600 })
      await rename(temporary, this.file)
    } catch { throw new CodexInstallationError(500, '无法保存 Codex 安装路径；原设置已保留，请检查目录权限') }
    finally { await rm(temporary, { force: true }).catch(() => {}) }
    return selected
  }
}

// The application root is fixed by Vite's resolved config, not request cwd or a
// browser payload. All local Codex gateways use the same per-installation store.
let activeStore: CodexInstallationStore | undefined
export function configureCodexInstallation(root: string): CodexInstallationStore {
  activeStore = new CodexInstallationStore(join(root, '.desktop-circuit'))
  return activeStore
}
export function configuredCodexExecutable(): Promise<string | null> {
  return activeStore?.selectedExecutable() ?? Promise.resolve(null)
}
