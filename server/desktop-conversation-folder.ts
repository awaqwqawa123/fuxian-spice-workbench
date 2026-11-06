import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DesktopControlError } from './desktop-control-manager'
import { validWorkbenchProjectId } from '../src/core/codex-workbench-link'

/** Codex groups local chats by their thread/start working directory. */
export class DesktopConversationFolder {
  private static allocations = new Map<string, Promise<string>>()
  readonly defaultDirectory: string
  constructor(readonly storageDirectory: string) {
    // The location follows this installation's persistent data, never the
    // developer's account or the source checkout used to build the package.
    this.defaultDirectory = resolve(storageDirectory, 'workspaces')
  }

  static projectFolderName(projectId: unknown): string {
    if (!validWorkbenchProjectId(projectId) || projectId === '.' || projectId === '..') throw new DesktopControlError(400, '项目编号格式不正确')
    // Titles, casing and reserved Windows names must not become path segments.
    return `project-${createHash('sha256').update(projectId).digest('hex')}`
  }

  private get file() { return join(this.storageDirectory, 'conversation-folder.json') }
  private get projectFile() { return join(this.storageDirectory, 'project-workspaces.json') }

  private async projectRoots(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(this.projectFile, 'utf8')
      if (raw.length > 4 * 1024 * 1024) throw new Error('oversized')
      const saved = JSON.parse(raw), roots = saved.roots
      if (saved.version !== 1 || !roots || typeof roots !== 'object' || Array.isArray(roots) || Object.keys(roots).length > 4096 || Object.entries(roots).some(([key, root]) => !/^project-[a-f0-9]{64}$/.test(key) || typeof root !== 'string' || root.length > 2048 || !isAbsolute(root))) throw new Error('invalid')
      return roots
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new DesktopControlError(500, '工程对话文件夹关联无法读取，原目录已保留，未重新分配')
    }
  }

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

  async effectiveDirectory(projectId: string): Promise<string> {
    const name = DesktopConversationFolder.projectFolderName(projectId)
    // Main and explanation managers can allocate at the same time. Serialize
    // only the short local journal write, not any Codex operation.
    const key = resolve(this.storageDirectory), previous = DesktopConversationFolder.allocations.get(key)
    const operation = (previous ?? Promise.resolve()).catch(() => {}).then(() => this.allocate(name))
    DesktopConversationFolder.allocations.set(key, operation)
    try { return await operation }
    finally { if (DesktopConversationFolder.allocations.get(key) === operation) DesktopConversationFolder.allocations.delete(key) }
  }

  private async allocate(name: string): Promise<string> {
    const roots = await this.projectRoots(), assigned = roots[name]
    const setting = assigned ? null : await this.read()
    try {
      if (!assigned && !setting?.directory) await mkdir(this.defaultDirectory, { recursive: true })
      const root = await this.validDirectory(assigned ?? setting?.directory ?? this.defaultDirectory)
      const proposed = join(root, name)
      try { await mkdir(proposed) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      const directory = await this.validDirectory(proposed), child = relative(root, directory)
      if (!child || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(child)) throw new DesktopControlError(400, '工程对话文件夹指向专用目录以外，请检查该目录的链接设置')
      if (!assigned) {
        if (Object.keys(roots).length >= 4096) throw new DesktopControlError(507, '工程对话目录关联已达本机上限，请保留现有记录')
        roots[name] = root
        await mkdir(this.storageDirectory, { recursive: true })
        const temporary = `${this.projectFile}.${randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify({ version: 1, roots }), { mode: 0o600 })
        await rename(temporary, this.projectFile)
      }
      return directory
    } catch (error) {
      if (error instanceof DesktopControlError) throw error
      throw new DesktopControlError(400, '无法创建工程专用对话文件夹，请在设置中选择已有且可写的对话根目录')
    }
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
