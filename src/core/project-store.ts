import { parseProject, type Project } from './circuit'
import { editableProject } from './editor'

export const PROJECTS_STORAGE = 'fuxian-project-library-v1'
const LEGACY_DRAFT = 'fuxian-free-editor-v2'
const LEGACY_TEMPLATES = 'fuxian-projects-v1'

export interface ProjectEntry { id: string; project: Project; updatedAt: number }
export interface ProjectCollection { version: 1; activeId: string; entries: ProjectEntry[] }
export interface LoadedProjectCollection { collection: ProjectCollection; warning?: string; canPersist: boolean }
type StorageReader = Pick<Storage, 'getItem'>
type StorageWriter = Pick<Storage, 'setItem'>

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
    try { return { collection: parseCollection(JSON.parse(raw)), canPersist: true } }
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
  try { storage.setItem(PROJECTS_STORAGE, JSON.stringify(clean)) }
  catch { throw new Error('项目保存失败：浏览器存储不可用或空间不足。当前修改仍在内存，请导出工程备份。') }
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
