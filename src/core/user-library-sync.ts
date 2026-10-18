import type { ImportedSpiceModel } from './spice-models'
import { createUserLibraryEntry, loadUserLibrary, parseUserLibrary, USER_LIBRARY_EVENT, USER_LIBRARY_KEY, type UserLibraryDocument } from './user-library'

export const USER_LIBRARY_API = '/api/user-library'
export const USER_LIBRARY_MIGRATION_KEY = 'fuxian-user-library-disk-migrated-v1'
type MergeResult = { document: UserLibraryDocument; added: number; skipped: number; updated: number }
type RemoveResult = { document: UserLibraryDocument; removed: boolean }
export interface PersistentUserLibraryOptions { storage?: Pick<Storage, 'getItem' | 'setItem'>; fetcher?: typeof fetch }
let pending: Promise<unknown> = Promise.resolve()
const fallbackValues = new Map<string, string>()
const fallbackStorage = { getItem: (key: string) => fallbackValues.get(key) ?? null, setItem: (key: string, value: string) => { fallbackValues.set(key, value) } }
const migratedStorage = new WeakSet<object>()

function serialize<T>(action: () => Promise<T>): Promise<T> {
  const operation = pending.catch(() => {}).then(action)
  pending = operation
  return operation
}
async function request(action: '' | 'merge' | 'remove', value: unknown, options: PersistentUserLibraryOptions): Promise<MergeResult & RemoveResult> {
  const response = await (options.fetcher ?? fetch)(`${USER_LIBRARY_API}${action ? `/${action}` : ''}`, {
    method: action ? 'POST' : 'GET', headers: { 'X-Fuxian-User-Library': '1', ...(action ? { 'Content-Type': 'application/json' } : {}) },
    ...(action ? { body: JSON.stringify(value) } : {}), signal: AbortSignal.timeout(20000),
  }).catch(() => { throw new Error('无法连接本机自建库服务，尚未确认保存。请保持伏线服务运行后重试；原模型仍保留。') })
  let raw: Record<string, unknown>
  try { raw = await response.json() as Record<string, unknown> }
  catch { throw new Error('本机自建库服务尚未就绪，尚未确认保存。请重启伏线服务后重试；原模型仍保留。') }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('本机自建库服务返回无效数据，尚未确认保存；原模型仍保留。')
  if (!response.ok) throw new Error(typeof raw.error === 'string' ? raw.error : '本机自建库操作失败，原数据已保留。')
  return { document: parseUserLibrary(raw.document), added: Number(raw.added ?? 0), skipped: Number(raw.skipped ?? 0), updated: Number(raw.updated ?? 0), removed: raw.removed === true }
}
function storageFor(options: PersistentUserLibraryOptions) {
  if (options.storage) return options.storage
  try { return window.localStorage } catch { return fallbackStorage }
}
function cache(document: UserLibraryDocument, options: PersistentUserLibraryOptions): void {
  // Disk is authoritative. A full/disabled browser cache cannot turn a confirmed
  // durable save into an apparent failure or hide the successfully saved model.
  try { storageFor(options).setItem(USER_LIBRARY_KEY, JSON.stringify(document)) } catch { /* Disk result is returned to the caller. */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new window.CustomEvent(USER_LIBRARY_EVENT, { detail: document }))
}
async function migrate(options: PersistentUserLibraryOptions): Promise<UserLibraryDocument> {
  const storage = storageFor(options)
  if (!migratedStorage.has(storage) && storage.getItem(USER_LIBRARY_MIGRATION_KEY) !== '1') {
    const legacy = loadUserLibrary(storage)
    const result = legacy.entries.length ? await request('merge', { document: legacy }, options) : await request('', undefined, options)
    // Write the marker before updating the cache. Keep the original local entries
    // unchanged if migration is rejected by a conflicting or damaged disk file.
    try { storage.setItem(USER_LIBRARY_MIGRATION_KEY, '1') } catch { /* Preserve readable legacy storage. */ }
    migratedStorage.add(storage)
    return result.document
  }
  return (await request('', undefined, options)).document
}
/** Restores a shared library independently of browser origin or current project. */
export function refreshPersistentUserLibrary(options: PersistentUserLibraryOptions = {}): Promise<UserLibraryDocument> {
  return serialize(async () => { const document = await migrate(options); cache(document, options); return document })
}
export function addModelToPersistentUserLibrary(model: ImportedSpiceModel, name = model.id, options: PersistentUserLibraryOptions = {}): Promise<MergeResult> {
  return serialize(async () => {
    await migrate(options)
    const result = await request('merge', { document: { schemaVersion: 1, entries: [createUserLibraryEntry(model, name)] } }, options)
    cache(result.document, options); return result
  })
}
export function importPersistentUserLibrary(text: string, options: PersistentUserLibraryOptions = {}): Promise<MergeResult> {
  return serialize(async () => {
    if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) throw new Error('自建库备份文件最多支持 4 MB')
    const document = parseUserLibrary(JSON.parse(text))
    await migrate(options)
    const result = await request('merge', { document }, options)
    cache(result.document, options); return result
  })
}
export function removeModelFromPersistentUserLibrary(id: string, options: PersistentUserLibraryOptions = {}): Promise<RemoveResult> {
  return serialize(async () => {
    await migrate(options)
    const result = await request('remove', { id }, options)
    cache(result.document, options); return result
  })
}
