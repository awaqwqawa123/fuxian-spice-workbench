import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { mergeUserLibrary, parseUserLibrary, type UserLibraryDocument } from '../src/core/user-library'

const empty = (): UserLibraryDocument => ({ schemaVersion: 1, entries: [] })
const queues = new Map<string, Promise<unknown>>()

/** Mutations always merge with the latest disk state, never a browser snapshot. */
export class UserLibraryStore {
  readonly path: string
  constructor(readonly directory: string) { this.path = join(resolve(directory), 'user-library.json') }

  private async read(): Promise<UserLibraryDocument> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error }
    try { return parseUserLibrary(JSON.parse(raw)) }
    catch (error) { throw new Error(`本机自建库读取失败，原文件已保留：${(error as Error).message}`) }
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const operation = (queues.get(this.path) ?? Promise.resolve()).catch(() => {}).then(action)
    queues.set(this.path, operation)
    void operation.finally(() => { if (queues.get(this.path) === operation) queues.delete(this.path) }).catch(() => {})
    return operation
  }
  private async atomicWrite(path: string, document: UserLibraryDocument): Promise<void> {
    const pending = `${path}.${randomUUID()}.pending`
    const file = await open(pending, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(document), 'utf8'); await file.sync() }
    catch (error) { await file.close(); await unlink(pending).catch(() => {}); throw error }
    await file.close()
    try { await rename(pending, path) }
    catch (error) { await unlink(pending).catch(() => {}); throw error }
  }
  private async write(document: UserLibraryDocument, previous: UserLibraryDocument): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    // Keep the prior valid document recoverable before replacing the active one.
    await this.atomicWrite(join(this.directory, 'user-library.previous.json'), previous)
    await this.atomicWrite(this.path, parseUserLibrary(document))
  }
  load(): Promise<UserLibraryDocument> { return this.serial(() => this.read()) }
  merge(incoming: unknown): Promise<{ document: UserLibraryDocument; added: number; skipped: number; updated: number }> {
    return this.serial(async () => {
      const previous = await this.read(), result = mergeUserLibrary(previous, parseUserLibrary(incoming))
      if (result.added || result.updated) await this.write(result.document, previous)
      return result
    })
  }
  remove(id: string): Promise<{ document: UserLibraryDocument; removed: boolean }> {
    return this.serial(async () => {
      if (typeof id !== 'string' || !/^user-[a-z0-9_.$+-]+$/i.test(id) || id.length > 80) throw new Error('自建库器件标识不正确')
      const previous = await this.read(), entries = previous.entries.filter(entry => entry.id !== id)
      const removed = entries.length !== previous.entries.length, document = parseUserLibrary({ schemaVersion: 1, entries })
      if (removed) await this.write(document, previous)
      return { document, removed }
    })
  }
}
