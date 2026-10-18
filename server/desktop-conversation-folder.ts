import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { DesktopControlError } from './desktop-control-manager'

/** Codex groups local chats by their thread/start working directory. */
export class DesktopConversationFolder {
  constructor(readonly storageDirectory: string, readonly defaultDirectory: string) {}

  private get file() { return join(this.storageDirectory, 'conversation-folder.json') }

  async read(): Promise<{ directory: string | null; defaultDirectory: string }> {
    let raw: string
    try { raw = await readFile(this.file, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { directory: null, defaultDirectory: resolve(this.defaultDirectory) }
      throw new DesktopControlError(500, '无法读取电路对话文件夹设置；已有对话保持原绑定')
    }
    try {
      if (raw.length > 8192) throw new Error('oversized')
      const saved = JSON.parse(raw)
      if (saved.version !== 1 || saved.directory !== null && (typeof saved.directory !== 'string' || !isAbsolute(saved.directory))) throw new Error('invalid')
      return { directory: saved.directory, defaultDirectory: resolve(this.defaultDirectory) }
    } catch { throw new DesktopControlError(500, '电路对话文件夹设置损坏；请检查本机设置文件，已有对话保持原绑定') }
  }

  private async validDirectory(input: string): Promise<string> {
    if (!input || input.length > 2048 || input.includes('\0') || !isAbsolute(input)) throw new DesktopControlError(400, '请输入已有文件夹的绝对路径')
    try {
      const directory = await realpath(input)
      if (!(await stat(directory)).isDirectory()) throw new DesktopControlError(400, '电路对话路径不是文件夹')
      await access(directory, constants.R_OK | constants.W_OK | constants.X_OK)
      return directory
    } catch (error) {
      if (error instanceof DesktopControlError) throw error
      throw new DesktopControlError(400, '电路对话文件夹不存在或无法访问，请选择已有且可写的文件夹')
    }
  }

  async effectiveDirectory(): Promise<string> {
    const setting = await this.read()
    if (!setting.directory) return resolve(this.defaultDirectory)
    return this.validDirectory(setting.directory)
  }

  async update(directory: unknown): Promise<{ directory: string | null; defaultDirectory: string }> {
    if (directory !== null && typeof directory !== 'string') throw new DesktopControlError(400, '电路对话文件夹设置格式不正确')
    const selected = directory === null ? null : await this.validDirectory(directory.trim())
    await mkdir(this.storageDirectory, { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, directory: selected }), { mode: 0o600 })
    await rename(temporary, this.file)
    return { directory: selected, defaultDirectory: resolve(this.defaultDirectory) }
  }
}
