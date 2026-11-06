import { parseProject, type Project } from './circuit'
import { editableProject } from './editor'

export const PROJECTS_STORAGE = 'fuxian-project-library-v1'
export const PROJECT_SELECTION_STORAGE = 'fuxian-project-selection-v1'
const LEGACY_DRAFT = 'fuxian-free-editor-v2'
const LEGACY_TEMPLATES = 'fuxian-projects-v1'

export interface ProjectEntry { id: string; project: Project; updatedAt: number }
export interface ProjectCollection { version: 1; activeId: string; entries: ProjectEntry[] }
export interface LoadedProjectCollection { collection: ProjectCollection; warning?: string; canPersist: boolean }
type StorageReader = Pick<Storage, 'getItem'>
type StorageWriter = Pick<Storage, 'setItem'>

// A selection may only refer to the exact library whose full write succeeded.
// Keep the revision outside React state and bind it to the storage adapter, so a
// failed save or another library cannot make a stale selection authoritative.
const savedCollections = new WeakMap<StorageWriter, { entries: ProjectEntry[]; ids: Set<string>; revision: string }>()

function restoreSelection(storage: StorageReader, input: unknown, collection: ProjectCollection): void {
  const revision = (input as { selectionRevision?: unknown }).selectionRevision
  if (typeof revision !== 'string') return
  try {
    const raw = storage.getItem(PROJECT_SELECTION_STORAGE)
    if (raw === null) return
    const selected: unknown = JSON.parse(raw)
    if (!selected || typeof selected !== 'object') return
    const record = selected as { version?: unknown; revision?: unknown; activeId?: unknown }
    if (record.version === 1 && record.revision === revision && typeof record.activeId === 'string' && collection.entries.some(entry => entry.id === record.activeId)) collection.activeId = record.activeId
  } catch { /* A missing/damaged selection must not prevent recovering the library. */ }
}

function cleanProject(project: unknown): Project {
  return editableProject(parseProject(project, { allowDraft: true }))
}

export function createEntry(project: Project): ProjectEntry {
  return { id: crypto.randomUUID(), project: cleanProject(project), updatedAt: Date.now() }
}

function initialCollection(project: Project): ProjectCollection {
  const entry = createEntry(project)
  return { version: 1, activeId: entry.id, entries: [entry] }
}

function parseCollection(input: unknown): ProjectCollection {
  if (!input || typeof input !== 'object') throw new Error('项目列表格式错误')
  const raw = input as Partial<ProjectCollection>
  if (raw.version !== 1 || !Array.isArray(raw.entries) || !raw.entries.length || typeof raw.activeId !== 'string') throw new Error('项目列表格式错误')
  const seen = new Set<string>()
  const entries = raw.entries.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 128 || seen.has(entry.id)) throw new Error('项目标识无效或重复')
    if (!Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0) throw new Error('项目更新时间无效')
    seen.add(entry.id)
    return { id: entry.id, project: cleanProject(entry.project), updatedAt: entry.updatedAt }
  })
  if (!seen.has(raw.activeId)) throw new Error('当前项目不存在')
  return { version: 1, activeId: raw.activeId, entries }
}

/** Never overwrite a damaged collection automatically; the caller keeps canPersist until recovery. */
export function loadProjectCollection(storage: StorageReader, fallback: Project): LoadedProjectCollection {
  let raw: string | null
  try { raw = storage.getItem(PROJECTS_STORAGE) }
  catch { return { collection: initialCollection(fallback), canPersist: false, warning: '无法读取浏览器项目存储；本次修改仅保留在内存，请导出工程备份。' } }
  if (raw !== null) {
    try {
      const input: unknown = JSON.parse(raw), collection = parseCollection(input)
      restoreSelection(storage, input, collection)
      return { collection, canPersist: true }
    }
    catch { return { collection: initialCollection(fallback), canPersist: false, warning: '已保存的项目列表无法恢复，原数据已保留；自动保存已暂停，请导出本次工程备份。' } }
  }

  let draft: string | null, templates: string | null
  try { draft = storage.getItem(LEGACY_DRAFT); templates = storage.getItem(LEGACY_TEMPLATES) }
  catch { return { collection: initialCollection(fallback), canPersist: false, warning: '无法读取历史工程，原数据已保留；本次修改仅保留在内存，请导出工程备份。' } }
  const entries: ProjectEntry[] = [], warnings: string[] = []
  if (draft !== null) {
    try { entries.push(createEntry(JSON.parse(draft))) }
    catch { warnings.push('历史编辑草稿无法恢复，原数据已保留。') }
  }
  if (templates !== null) {
    try {
      const saved: unknown = JSON.parse(templates)
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('历史项目列表格式错误')
      let skipped = 0
      for (const project of Object.values(saved)) {
        try { entries.push(createEntry(project as Project)) }
        catch { skipped++ }
      }
      if (skipped) warnings.push(`${skipped} 个历史工程无法恢复，原数据已保留。`)
    } catch { warnings.push('历史模板工程无法恢复，原数据已保留。') }
  }
  if (!entries.length) entries.push(createEntry(fallback))
  return { collection: { version: 1, activeId: entries[0].id, entries }, canPersist: true, ...(warnings.length ? { warning: warnings.join(' ') } : {}) }
}

export function saveProjectCollection(storage: StorageWriter, collection: ProjectCollection): void {
  const clean = parseCollection(collection)
  const revision = crypto.randomUUID()
  try { storage.setItem(PROJECTS_STORAGE, JSON.stringify({ ...clean, selectionRevision: revision })) }
  catch { throw new Error('项目保存失败：浏览器存储不可用或空间不足。当前修改仍在内存，请导出工程备份。') }
  savedCollections.set(storage, { entries: collection.entries, ids: new Set(clean.entries.map(entry => entry.id)), revision })
}

/** Persist selection only; callers must fully save edits before using this path. */
export function saveProjectSelection(storage: StorageWriter, collection: ProjectCollection): void {
  const saved = savedCollections.get(storage)
  if (!saved || collection.version !== 1 || saved.entries !== collection.entries) throw new Error('请先保存项目内容，再保存当前项目选择')
  if (!saved.ids.has(collection.activeId)) throw new Error('当前项目不存在')
  try { storage.setItem(PROJECT_SELECTION_STORAGE, JSON.stringify({ version: 1, revision: saved.revision, activeId: collection.activeId })) }
  catch { throw new Error('当前项目选择保存失败：浏览器存储不可用或空间不足。工程内容仍已保存，请稍后重试。') }
}

export function updateProject(collection: ProjectCollection, id: string, project: Project): ProjectCollection {
  if (!collection.entries.some(entry => entry.id === id)) throw new Error('要更新的项目不存在')
  const clean = cleanProject(project)
  return { ...collection, entries: collection.entries.map(entry => entry.id === id ? { ...entry, project: clean, updatedAt: Date.now() } : entry) }
}

export function addProject(collection: ProjectCollection, project: Project): ProjectCollection {
  let entry = createEntry(project)
  while (collection.entries.some(existing => existing.id === entry.id)) entry = createEntry(project)
  return { ...collection, activeId: entry.id, entries: [...collection.entries, entry] }
}

export function selectProject(collection: ProjectCollection, id: string): ProjectCollection {
  if (!collection.entries.some(entry => entry.id === id)) throw new Error('要打开的项目不存在')
  return collection.activeId === id ? collection : { ...collection, activeId: id }
}
