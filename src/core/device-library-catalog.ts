import type { ImportedSpiceModel } from './spice-models'
import { modelTypeLabels, catalogModelParameters } from './model-catalog'
import { modelCategories, modelCategory, modelCategoryGroups, modelCategoryLabel } from './model-taxonomy'
import { modelSymbolDescription, modelTerminalDescription } from './model-symbol-display'
import { presentedModelSymbol } from './model-symbol-presentation'
import { preferredModelLibraries, preferredModelLibrary, selectPreferredCatalogModels, type PreferredModelLibrary } from './model-source-policy'
import { publicModelId } from './model-public-identity'
import { deviceLibraryProfile, type DeviceLibraryProfile } from './device-library-profile'

export interface DeviceLibraryBrowseRequest {
  query?: string
  category?: string
  source?: '' | PreferredModelLibrary
  offset?: number
  limit?: number
}
/** Browsing never transfers model code. Full validated definitions are read only
 * when placing the selected registered key. Display symbols may improve without
 * changing the original model's electrical anchors. */
export interface DeviceLibraryModelSummary extends Pick<ImportedSpiceModel, 'id'|'name'|'kind'|'type'|'technology'|'pins'|'metadata'|'source'|'symbol'> {
  key: string
  categoryLabel: string
  terminalDescription: string
  symbolDescription: string
  profile?: DeviceLibraryProfile
}
export interface DeviceLibraryIndexEntry {
  key: string; id: string; publicId?:string; source: PreferredModelLibrary; category: string; text: string; chunk: number
}
export interface DeviceLibraryBrowseGroup { id: string; models: DeviceLibraryModelSummary[] }
export interface DeviceLibraryBrowsePage {
  state?: 'ready'
  generation?: string
  builtAt?: string
  updating?: boolean
  stale?: boolean
  groups: DeviceLibraryBrowseGroup[]
  total: number
  offset: number
  limit: number
  counts: { id: string; label: string; count: number }[]
  subcategories?: { id: string; group: string; label: string; count: number }[]
  libraries: { id: PreferredModelLibrary; count: number }[]
}
export interface DeviceLibraryBuildStatus {
  state: 'building'|'failed'
  message: string
  error?: string
  progress?: {processed: number; total: number}
  generation?: string
}

/** Reject ambiguous values instead of coercing strings, booleans or paths. */
export function parseDeviceLibraryBrowseRequest(value: unknown): Required<DeviceLibraryBrowseRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('器件库浏览参数必须是对象')
  const data = value as Record<string, unknown>
  if (Object.keys(data).some(key => !['query', 'category', 'source', 'offset', 'limit'].includes(key))) throw new Error('器件库浏览包含未知参数')
  const query = data.query === undefined ? '' : data.query, category = data.category === undefined ? '' : data.category, source = data.source === undefined ? '' : data.source, offset = data.offset === undefined ? 0 : data.offset, limit = data.limit === undefined ? 36 : data.limit
  if (typeof query !== 'string' || query.length > 100) throw new Error('器件搜索文字最多 100 个字符')
  if (typeof category !== 'string' || category !== '' && !modelCategoryGroups.some(group => group.id === category) && !modelCategories.some(leaf => leaf.id === category)) throw new Error('器件分类无效')
  if (typeof source !== 'string' || source !== '' && !preferredModelLibraries.includes(source as PreferredModelLibrary)) throw new Error('器件来源仅支持 TINA、PSpice、LTspice')
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('器件库分页位置无效')
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 60) throw new Error('每页器件数必须为 1 到 60')
  return { query, category, source: source as '' | PreferredModelLibrary, offset, limit }
}

export function summarizeDeviceLibraryModel(model: ImportedSpiceModel, key: string): DeviceLibraryModelSummary {
  const { id, name, kind, type, technology, pins, metadata, source } = model
  const symbol = presentedModelSymbol(model)
  return {key,id,name,kind,type,...(technology?{technology}:{}),pins,metadata,source,...(symbol?{symbol}:{}),categoryLabel:modelCategoryLabel(model),terminalDescription:modelTerminalDescription(model),symbolDescription:modelSymbolDescription(model),profile:deviceLibraryProfile(model)}
}
export function indexDeviceLibraryModel(model: ImportedSpiceModel, key: string, chunk: number): DeviceLibraryIndexEntry {
  const text = `${model.id} ${model.name} ${model.type} ${model.technology??''} ${modelTypeLabels[model.type]} ${modelCategoryLabel(model)} ${model.deviceInfo?.manufacturer??''} ${model.deviceInfo?.function??''} ${model.deviceInfo?.description??''} ${Object.entries(model.metadata).map(([k,v])=>`${k}=${v} ${v}`).join(' ')} ${catalogModelParameters(model).map(({key,value})=>`${key}=${value}`).join(' ')} ${model.source.label}`.toLowerCase()
  return {key,id:model.id,publicId:publicModelId(model.id,model.source),source:preferredModelLibrary(model.source)!,category:modelCategory(model),text,chunk}
}
function uniqueCount(models: DeviceLibraryIndexEntry[]): number { return new Set(models.map(item => (item.publicId??publicModelId(item.id,item.source)).toLowerCase())).size }

/** Filter the compact persisted entries first. Only visible groups identify
 * summary chunks to read; full model definitions are never part of browsing. */
export function browseDeviceLibraryIndex(index: readonly DeviceLibraryIndexEntry[], request: DeviceLibraryBrowseRequest = {}): {page: Omit<DeviceLibraryBrowsePage,'groups'>; groups:{id:string;entries:DeviceLibraryIndexEntry[]}[]} {
  const { query, category, source, offset, limit } = parseDeviceLibraryBrowseRequest(request)
  const terms = query.toLowerCase().trim().replace(/\s*=\s*/g, '=').split(/\s+/).filter(Boolean)
  const searched = index.filter(item => terms.every(term => item.text.includes(term)))
  const libraries = preferredModelLibraries.map(id => ({ id, count: uniqueCount(searched.filter(item => item.source === id)) }))
  const sourced = source ? searched.filter(item => item.source === source) : searched
  const categoryMatches = (entry: DeviceLibraryIndexEntry, id: string) => id.includes(':') ? entry.category === id : entry.category.split(':')[0] === id
  const counts = [{ id: '', label: '全部', count: uniqueCount(sourced) }, ...modelCategoryGroups.map(group => ({ ...group, count: uniqueCount(sourced.filter(item => categoryMatches(item, group.id))) }))]
  const subcategories = modelCategories.map(leaf => ({ ...leaf, count: uniqueCount(sourced.filter(item => item.category === leaf.id)) }))
  const filtered = category ? sourced.filter(item => categoryMatches(item, category)) : sourced
  const groups = new Map<string, {id:string;entries:DeviceLibraryIndexEntry[]}>()
  for (const entry of filtered) {
    const publicId=entry.publicId??publicModelId(entry.id,entry.source),key = publicId.toLowerCase(), group = groups.get(key)
    if (group) group.entries.push(entry)
    else groups.set(key, { id: publicId, entries: [entry] })
  }
  const needle=query.trim().toLowerCase()
  const relevance=(group:{id:string;entries:DeviceLibraryIndexEntry[]})=>!needle?0:group.id.toLowerCase()===needle||group.entries.some(entry=>entry.id.toLowerCase()===needle)?0:group.id.toLowerCase().startsWith(needle)?1:2
  const sorted = [...groups.values()].sort((a, b) => relevance(a)-relevance(b)||a.id.localeCompare(b.id, 'en', { numeric: true }))
  const pageGroups = sorted.slice(offset, offset + limit)
  for (const group of pageGroups) group.entries.sort((a, b) => preferredModelLibraries.indexOf(a.source) - preferredModelLibraries.indexOf(b.source))
  return {groups:pageGroups,page:{total:sorted.length,offset,limit,counts,subcategories,libraries}}
}

/** Pure helper for small fixtures. Production uses the persisted index and reads
 * summary chunks for this page, without reparsing catalog model definitions. */
export function browseDeviceLibrary(models: readonly ImportedSpiceModel[], request: DeviceLibraryBrowseRequest = {}): DeviceLibraryBrowsePage {
  const selected=selectPreferredCatalogModels(models)
  const index=selected.map((model,i)=>indexDeviceLibraryModel(model,String(i),0))
  const {page,groups}=browseDeviceLibraryIndex(index,request)
  return {...page,groups:groups.map(group=>({id:group.id,models:group.entries.map(entry=>summarizeDeviceLibraryModel(selected[Number(entry.key)],entry.key))}))}
}
