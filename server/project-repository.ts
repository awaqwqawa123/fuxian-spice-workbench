import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { parseProject } from '../src/core/circuit'
import { editableProject } from '../src/core/editor'
import type { ProjectBackupPage } from '../src/core/project-backups'
import type { ProjectCollection, ProjectEntry } from '../src/core/project-store'

export const PROJECT_REPOSITORY_LIMIT = 96 * 1024 * 1024
const PROJECT_LIMIT = 32 * 1024 * 1024
const ENTRY_LIMIT = 2000
const BACKUP_PAGE_SIZE = 100
const SCHEMA_VERSION = 1
const FILE_NAME = 'projects.sqlite3'

export interface ProjectRepositorySnapshot { collection: ProjectCollection; revision: string | null }
export interface ProjectRepositorySelection { activeId: string; revision: string }
export class ProjectRepositoryError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
type RevisionRecord = { revision: string | null; active_id: string; migration: string | null }
type StoredProject = { id: string; updated_at: number; document: string; position: number }
type EncodedProject = { entry: ProjectEntry; document: string }
const unavailable = () => new ProjectRepositoryError(503, '本机工程库暂时无法读取或写入；已有文件已保留。请检查数据目录、磁盘空间或稍后重试。')
const conflict = () => new ProjectRepositoryError(409, '工程库已由另一个窗口更新。当前草稿仍在，请导出草稿或重新加载已保存的工程。')
const invalid = (message: string) => new ProjectRepositoryError(400, message)
export const projectRepositoryId = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= 128 && !value.includes('\0')
export const projectRepositoryRevision = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const empty = (): ProjectCollection => ({ version: 1, activeId: '', entries: [] })
const normalizedProject = (document: unknown) => editableProject(parseProject(document, { allowDraft: true }))

export function projectRepositoryDirectory(env = process.env, platform = process.platform): string {
  if (env.FUXIAN_DATA_DIR) {
    if (!isAbsolute(env.FUXIAN_DATA_DIR)) throw new ProjectRepositoryError(503, 'FUXIAN_DATA_DIR 需要设置为本机绝对路径。')
    return resolve(env.FUXIAN_DATA_DIR)
  }
  const standard = platform === 'win32'
    ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  if (!isAbsolute(standard)) throw new ProjectRepositoryError(503, '系统数据位置无效；请设置本机数据目录。')
  return join(standard, 'Fuxian')
}

function parseCollection(input: unknown): { collection: ProjectCollection; encoded: EncodedProject[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('工程列表格式错误')
  const { version, activeId, entries } = input as Partial<ProjectCollection>
  if (version !== 1 || !Array.isArray(entries) || !entries.length || entries.length > ENTRY_LIMIT || !projectRepositoryId(activeId)) throw invalid('工程列表格式错误，或工程数量超过上限')
  let size = 0
  const seen = new Set<string>()
  let encoded: EncodedProject[]
  try {
    encoded = entries.map(value => {
      if (!value || typeof value !== 'object' || !projectRepositoryId(value.id) || seen.has(value.id) || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) throw invalid('工程标识重复、无效，或更新时间错误')
      seen.add(value.id)
      const project = normalizedProject(value.project), document = JSON.stringify(project), bytes = Buffer.byteLength(document)
      if (bytes > PROJECT_LIMIT) throw invalid('单个工程超过 32 MiB，请先精简或导出工程')
      size += bytes
      if (size > PROJECT_REPOSITORY_LIMIT) throw invalid('工程库超过保存上限，请先导出工程')
      return { entry: { id: value.id, updatedAt: value.updatedAt, project }, document }
    })
  } catch (error) {
    if (error instanceof ProjectRepositoryError) throw error
    throw invalid(`工程内容不能保存：${(error as Error).message}`)
  }
  if (!seen.has(activeId)) throw invalid('当前工程不存在')
  return { collection: { version: 1, activeId, entries: encoded.map(({ entry }) => entry) }, encoded }
}

const sqlite = () => import('node:sqlite').catch(() => {
  throw new ProjectRepositoryError(503, '当前 Node 运行环境无法使用本机工程库。请使用伏线 Windows 包自带的运行时，或升级到 Node 24。')
})

/**
 * Project data, revision and the selected project commit together. BEGIN IMMEDIATE
 * gives all processes using this data directory one writer, including instances
 * running on different ports. The on-disk SQLite journal rolls back failed commits.
 */
export class ProjectRepository {
  readonly path: string
  constructor(readonly directory: string) { this.path = join(resolve(directory), FILE_NAME) }

  private async database<T>(write: boolean, operation: (db: DatabaseSync) => T, create = write): Promise<T | undefined> {
    let db: DatabaseSync | undefined
    try {
      const { DatabaseSync } = await sqlite()
      try {
        const info = await lstat(this.path)
        if (!info.isFile() || info.isSymbolicLink()) throw unavailable()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (!create) return undefined
      }
      if (write) await mkdir(this.directory, { recursive: true, mode: 0o700 })
      // A live writer may have left a rollback journal; use a regular connection
      // so SQLite can carry out recovery on the next open if needed.
      db = new DatabaseSync(this.path, { timeout: 1500, allowExtension: false })
      db.exec('PRAGMA busy_timeout = 1500; PRAGMA synchronous = FULL;')
      db.exec(write ? 'BEGIN IMMEDIATE;' : 'BEGIN;')
      try {
        const version = db.prepare('PRAGMA user_version').get()?.user_version
        if (version === 0) {
          // A connection creating the new file could be interrupted before its
          // first transaction. An empty SQLite DB is safe to initialize; an
          // unrelated version-0 database is not.
          const objects = db.prepare("SELECT count(*) AS total FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()?.total
          if (objects !== 0) throw unavailable()
          if (!write) { db.exec('COMMIT;'); return undefined }
          db.exec(`
            CREATE TABLE repository (
              singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
              revision TEXT NULL, active_id TEXT NOT NULL, migration TEXT NULL
            ) STRICT;
            INSERT INTO repository VALUES (1, NULL, '', NULL);
            CREATE TABLE projects (
              id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL,
              document TEXT NOT NULL, position INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE previous_projects (
              id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, document TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = ${SCHEMA_VERSION};
          `)
        } else if (version !== SCHEMA_VERSION) {
          throw new ProjectRepositoryError(503, '本机工程库版本不受此版本支持；原数据已保留。请使用建立该工程库或更新的伏线版本。')
        }
        const result = operation(db)
        db.exec('COMMIT;')
        return result
      } catch (error) {
        try { db.exec('ROLLBACK;') } catch { /* The storage subsystem may already have rolled back. */ }
        throw error
      }
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error
      throw unavailable()
    } finally {
      db?.close()
    }
  }

  private metadata(db: DatabaseSync): RevisionRecord {
    const row = db.prepare('SELECT revision, active_id, migration FROM repository WHERE singleton = 1').get() as RevisionRecord | undefined
    if (!row || (row.revision === null ? row.active_id !== '' : !projectRepositoryRevision(row.revision) || !projectRepositoryId(row.active_id))) throw unavailable()
    return row
  }

  private read(db: DatabaseSync, metadata = this.metadata(db)): ProjectRepositorySnapshot {
    const state = db.prepare('SELECT count(*) AS count, coalesce(sum(length(CAST(document AS BLOB))), 0) AS bytes FROM projects').get()
    if (!state || Number(state.count) > ENTRY_LIMIT || Number(state.bytes) > PROJECT_REPOSITORY_LIMIT) throw unavailable()
    const records = db.prepare('SELECT id, updated_at, document, position FROM projects ORDER BY position, id').all() as StoredProject[]
    if (!records.length && metadata.revision === null) return { collection: empty(), revision: null }
    if (metadata.revision === null || !records.some(row => row.id === metadata.active_id)) throw unavailable()
    try {
      return {
        revision: metadata.revision,
        collection: {
          version: 1, activeId: metadata.active_id,
          entries: records.map(row => {
            if (!projectRepositoryId(row.id) || !Number.isSafeInteger(row.updated_at) || row.updated_at < 0 || Buffer.byteLength(row.document) > PROJECT_LIMIT) throw unavailable()
            return { id: row.id, updatedAt: row.updated_at, project: normalizedProject(JSON.parse(row.document)) }
          }),
        }
      }
    } catch { throw unavailable() }
  }

  async bootstrap(): Promise<ProjectRepositorySnapshot> {
    return await this.database(false, db => this.read(db)) ?? { collection: empty(), revision: null }
  }

  async listBackups(offset: unknown): Promise<ProjectBackupPage> {
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw invalid('备份页码无效')
    // These reads do not depend on the active collection or its metadata.
    return await this.database(false, db => {
      const entries = db.prepare(`
        SELECT id, updated_at, CASE
          WHEN length(CAST(document AS BLOB)) <= ? AND json_valid(document)
          THEN substr(json_extract(document, '$.title'), 1, 200)
        END AS title
        FROM (SELECT id, updated_at, document FROM previous_projects
              ORDER BY updated_at DESC, id LIMIT ? OFFSET ?)
        ORDER BY updated_at DESC, id
      `).all(PROJECT_LIMIT, BACKUP_PAGE_SIZE + 1, offset)
      return {
        backups: entries.slice(0, BACKUP_PAGE_SIZE).map(row => ({
          id: String(row.id), updatedAt: Number(row.updated_at),
          title: typeof row.title === 'string' && row.title.trim() ? row.title : '未能识别标题的备份',
        })),
        more: entries.length > BACKUP_PAGE_SIZE,
      }
    }) ?? { backups: [], more: false }
  }

  async readBackup(id: unknown, updatedAt: unknown): Promise<ProjectEntry> {
    if (!projectRepositoryId(id) || typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0) throw invalid('备份标识或时间无效')
    const backup = await this.database(false, db => {
      const row = db.prepare(`
        SELECT updated_at, CASE WHEN length(CAST(document AS BLOB)) <= ? THEN document END AS document
        FROM previous_projects WHERE id = ?
      `).get(PROJECT_LIMIT, id)
      if (!row) return undefined
      if (row.updated_at !== updatedAt) throw new ProjectRepositoryError(409, '这份备份已更新。请刷新列表后重新选择。')
      try {
        if (typeof row.document !== 'string') throw new Error()
        return { id, updatedAt, project: normalizedProject(JSON.parse(row.document)) }
      } catch {
        throw new ProjectRepositoryError(422, '这份备份无法读取；备份文件仍保留。请选择其他备份。')
      }
    })
    if (!backup) throw new ProjectRepositoryError(404, '没有找到这份备份。请刷新列表后重新选择。')
    return backup
  }

  private write(db: DatabaseSync, data: ReturnType<typeof parseCollection>, migration: string | null): ProjectRepositorySnapshot {
    const byId = new Set(data.collection.entries.map(entry => entry.id))
    const backup = db.prepare(`
      INSERT INTO previous_projects (id, updated_at, document)
      SELECT id, updated_at, document FROM projects WHERE id = ?
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, document = excluded.document
    `)
    const read = db.prepare('SELECT updated_at, document, position FROM projects WHERE id = ?')
    const deleteEntry = db.prepare('DELETE FROM projects WHERE id = ?')
    const put = db.prepare(`
      INSERT INTO projects (id, updated_at, document, position) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, document = excluded.document, position = excluded.position
    `)
    const order = db.prepare('UPDATE projects SET position = ? WHERE id = ?')
    for (const row of db.prepare('SELECT id FROM projects').iterate()) {
      const id = String(row.id)
      if (!byId.has(id)) { backup.run(id); deleteEntry.run(id) }
    }
    for (const [position, { entry, document }] of data.encoded.entries()) {
      const stored = read.get(entry.id)
      if (stored?.updated_at === entry.updatedAt && stored.document === document) {
        if (stored.position !== position) order.run(position, entry.id)
        continue
      }
      if (stored) backup.run(entry.id)
      put.run(entry.id, entry.updatedAt, document, position)
    }
    const revision = randomUUID()
    db.prepare('UPDATE repository SET revision = ?, active_id = ?, migration = ? WHERE singleton = 1').run(revision, data.collection.activeId, migration)
    return { collection: data.collection, revision }
  }

  async save(input: unknown, expectedRevision: string | null): Promise<ProjectRepositorySnapshot> {
    if (expectedRevision !== null && !projectRepositoryRevision(expectedRevision)) throw invalid('工程修订标识无效')
    const parsed = parseCollection(input)
    const saved = await this.database(true, db => {
      const metadata = this.metadata(db)
      if (expectedRevision !== metadata.revision) throw conflict()
      // Confirm the prior version can be recovered before writing a new one.
      // A malformed store must never become an apparently empty library.
      this.read(db, metadata)
      return this.write(db, parsed, metadata.migration)
    }, expectedRevision === null)
    if (!saved) throw conflict()
    return saved
  }

  async migrate(input: unknown): Promise<ProjectRepositorySnapshot> {
    const parsed = parseCollection(input)
    const fingerprint = createHash('sha256').update(JSON.stringify(parsed.collection)).digest('hex')
    return (await this.database(true, db => {
      const metadata = this.metadata(db)
      const existing = this.read(db, metadata)
      if (metadata.revision === null) return this.write(db, parsed, fingerprint)
      const ids = new Set(existing.collection.entries.map(entry => entry.id))
      const additions = parsed.collection.entries.filter(entry => !ids.has(entry.id))
      if (!additions.length) return existing
      // Old browser data can be imported after a file has already been opened.
      // Existing IDs always retain the version last saved to the local library.
      const merged = parseCollection({ ...existing.collection,
        activeId: parsed.collection.activeId,
        entries: [...existing.collection.entries, ...additions],
      })
      return this.write(db, merged, fingerprint)
    }))!
  }

  async select(activeId: string, expectedRevision: string): Promise<ProjectRepositorySelection> {
    if (!projectRepositoryId(activeId) || !projectRepositoryRevision(expectedRevision)) throw invalid('工程标识或修订无效')
    const selection = await this.database(true, db => {
      const metadata = this.metadata(db)
      if (expectedRevision !== metadata.revision) throw conflict()
      if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(activeId)) throw invalid('要打开的工程不存在')
      if (metadata.active_id !== activeId) db.prepare('UPDATE repository SET active_id = ? WHERE singleton = 1').run(activeId)
      return { activeId, revision: expectedRevision }
    }, false)
    if (!selection) throw conflict()
    return selection
  }
}
