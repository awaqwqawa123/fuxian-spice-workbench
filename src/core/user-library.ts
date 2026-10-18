import { parseImportedModels, parseSpiceLibrary, type ImportedSpiceModel } from './spice-models'
import { defaultModelSymbol, type ModelSymbol } from './model-symbol'
import { resolveModelFunctionalSymbol } from './model-functional-symbol'
import { isOwnedPspiceSource } from './installed-model-source'

export const USER_LIBRARY_KEY = 'fuxian-user-library-v1'
export const USER_LIBRARY_EVENT = 'fuxian-user-library-change'
export interface UserLibraryEntry { id: string; name: string; model: ImportedSpiceModel; createdAt: string }
export interface UserLibraryDocument { schemaVersion: 1; entries: UserLibraryEntry[] }
type LibraryStorage = Pick<Storage, 'getItem' | 'setItem'>
const limit = 256

export function parseUserLibrary(raw: unknown): UserLibraryDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('自建库文件格式错误')
  const value = raw as Partial<UserLibraryDocument>
  if (value.schemaVersion !== 1 || !Array.isArray(value.entries) || value.entries.length > limit) throw new Error('自建库须为版本 1，最多保存 256 个器件')
  const seen = new Set<string>()
  const entries = value.entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw new Error('自建库器件数据格式错误')
    const model = parseImportedModels([entry.model])[0], id = `user-${model.id.toLowerCase()}`
    if (entry.id !== id) throw new Error(`自建库器件 ${model.id} 的标识不一致`)
    if (seen.has(id)) throw new Error(`自建库模型名 ${model.id} 重复`)
    seen.add(id)
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 80 || /[\x00-\x1f\x7f]/.test(entry.name)) throw new Error('自建库器件名称须为 1～80 个可显示字符')
    if (typeof entry.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(entry.createdAt) || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error('自建库创建日期格式错误')
    // Models without a custom body use their electrically appropriate native symbol.
    model.symbol ??= defaultModelSymbol(model.kind, model.id,model.kind==='X'?'box':'standard',model.pins)
    return { id, name: entry.name.trim(), model, createdAt: entry.createdAt }
  })
  return { schemaVersion: 1, entries }
}

export function loadUserLibrary(storage: LibraryStorage = window.localStorage): UserLibraryDocument {
  const text = storage.getItem(USER_LIBRARY_KEY)
  if (!text) return { schemaVersion: 1, entries: [] }
  try { return parseUserLibrary(JSON.parse(text)) }
  catch (reason) { throw new Error(`自建库读取失败，原数据已保留：${(reason as Error).message}`) }
}
export function saveUserLibrary(document: UserLibraryDocument, storage: LibraryStorage = window.localStorage): void {
  const checked = parseUserLibrary(document)
  storage.setItem(USER_LIBRARY_KEY, JSON.stringify(checked))
  if (typeof window !== 'undefined') window.dispatchEvent(new window.Event(USER_LIBRARY_EVENT))
}
export function createUserLibraryEntry(model: ImportedSpiceModel, name = model.id): UserLibraryEntry {
  const checked = parseImportedModels([model])[0]
  checked.symbol ??= resolveModelFunctionalSymbol(checked)
  checked.symbol ??= defaultModelSymbol(checked.kind, checked.id,checked.kind==='X'?'box':'standard',checked.pins)
  return parseUserLibrary({ schemaVersion: 1, entries: [{ id: `user-${checked.id.toLowerCase()}`, name, model: checked, createdAt: new Date().toISOString() }] }).entries[0]
}
/** Rename the declaration and matching .ends, retaining electrical values and provenance. */
export function renameLibraryModel(model: ImportedSpiceModel, name: string): ImportedSpiceModel {
  const checked = parseImportedModels([model])[0], id = name.trim()
  if (!id || /\s/.test(id)) throw new Error('SPICE 模型名不能为空或包含空白。')
  if (id === checked.id) return checked
  const escaped=checked.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
  const text = checked.kind==='X'
    ? checked.spice.replace(new RegExp(`(^\\.subckt\\s+)${escaped}(?=\\s)`, 'im'),(_,prefix:string)=>`${prefix}${id}`).replace(new RegExp(`(^\\.ends\\s+)${escaped}(?=\\s|$)`,'im'),(_,prefix:string)=>`${prefix}${id}`)
    : checked.spice.replace(/^(\.model\s+)\S+/i, (_, prefix: string) => `${prefix}${id}`)
  const preview = parseSpiceLibrary(text, checked.source), errors = preview.diagnostics.filter(item => item.severity === 'error')
  const renamed=preview.models.find(item=>item.id===id)
  if (errors.length || !renamed) throw new Error(errors.map(item => item.message).join('；') || '无法识别另存后的模型定义。')
  return parseImportedModels([{ ...renamed, metadata: checked.metadata, ...(checked.symbol ? { symbol: checked.symbol } : {}), ...(checked.assessment ? { assessment: checked.assessment } : {}), ...(checked.deviceInfo ? { deviceInfo: checked.deviceInfo } : {}) }])[0]
}
function sameEntry(a: UserLibraryEntry, b: UserLibraryEntry) {
  const { assessment: _a, ...first } = a.model, { assessment: _b, ...second } = b.model
  return a.name === b.name && JSON.stringify(first) === JSON.stringify(second)
}
/** Atomic import. A conflicting record cannot partially overwrite a library. */
export function mergeUserLibrary(existing: UserLibraryDocument, incoming: UserLibraryDocument): { document: UserLibraryDocument; added: number; skipped: number; updated: number } {
  const entries = [...parseUserLibrary(existing).entries], next = parseUserLibrary(incoming).entries
  let added = 0, skipped = 0, updated = 0
  for (const entry of next) {
    const old = entries.find(item => item.id === entry.id)
    if (old) {
      if (!sameEntry(old, entry)) throw new Error(`模型 ${entry.model.id} 与自建库中现有器件的代码、符号、名称或来源冲突；未覆盖。请先在模型编辑器另存为新模型名。`)
      // A legacy model can gain its report without changing electrical identity.
      // Keep an existing report when importing an older browser snapshot/backup.
      if (!old.model.assessment && entry.model.assessment) {
        entries[entries.indexOf(old)] = { ...old, model: { ...old.model, assessment: entry.model.assessment } }
        updated++
      } else skipped++
    } else { entries.push(entry); added++ }
  }
  return { document: parseUserLibrary({ schemaVersion: 1, entries }), added, skipped, updated }
}
export function addModelToUserLibrary(model: ImportedSpiceModel, name = model.id, storage: LibraryStorage = window.localStorage) {
  const result = mergeUserLibrary(loadUserLibrary(storage), { schemaVersion: 1, entries: [createUserLibraryEntry(model, name)] })
  saveUserLibrary(result.document, storage)
  return result
}
export function importUserLibrary(text: string, storage: LibraryStorage = window.localStorage) {
  if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) throw new Error('自建库备份文件最多支持 4 MB')
  const result = mergeUserLibrary(loadUserLibrary(storage), parseUserLibrary(JSON.parse(text)))
  saveUserLibrary(result.document, storage)
  return result
}
export function exportUserLibrary(document: UserLibraryDocument): string { return JSON.stringify(parseUserLibrary(document), null, 2) }

/** Resolve a library placement before changing the current project. */
function sameImportedLayout(a:ModelSymbol|undefined,b:ModelSymbol|undefined):boolean {
  if(a?.shape!=='ltspice'||b?.shape!=='ltspice'||a.origin!=='imported'||b.origin!=='imported')return false
  if(!b.pins.every(pin=>typeof (pin as {labelVisible?:boolean}).labelVisible==='boolean'))return false
  const pins=(symbol:ModelSymbol)=>symbol.pins.map(({index,label,x,y})=>({index,label,x,y}))
  const geometry=(items:readonly {type:string;coords:number[]}[]|undefined)=>items?.flatMap(item=>{
    if(item.type!=='polygon'&&item.type!=='polyline')return[{type:item.type,coords:item.coords}]
    const lines:{type:string;coords:number[]}[]=[]
    for(let i=0;i<item.coords.length-2;i+=2)lines.push({type:'line',coords:item.coords.slice(i,i+4)})
    if(item.type==='polygon')lines.push({type:'line',coords:[...item.coords.slice(-2),...item.coords.slice(0,2)]})
    return lines
  })
  const annotations=(symbol:ModelSymbol)=>symbol.annotations?.filter(label=>!(label as {binding?:string}).binding&&!/（未建模）$/.test(label.text)).map(({text,x,y})=>({text,x,y}))??[]
  return JSON.stringify(pins(a))===JSON.stringify(pins(b))&&JSON.stringify(geometry(a.geometry))===JSON.stringify(geometry(b.geometry))&&JSON.stringify(annotations(a))===JSON.stringify(annotations(b))
}
export function modelsForLibraryPlacement(existing: ImportedSpiceModel[] | undefined, incoming: ImportedSpiceModel): ImportedSpiceModel[] {
  const models = parseImportedModels(existing ?? []), model = parseImportedModels([incoming])[0]
  const old = models.find(item => item.id.toLowerCase() === model.id.toLowerCase())
  if (!old) return parseImportedModels([...models, model])
  const visualSymbol = (item: ImportedSpiceModel) => item.symbol?.shape === 'box'||item.symbol?.shape==='ltspice' ? item.symbol : undefined
  const sameVisual=JSON.stringify(visualSymbol(old))===JSON.stringify(visualSymbol(model))
  const recoveredOriginal=!old.symbol&&model.kind==='X'&&model.symbol?.shape==='ltspice'&&model.symbol.origin==='imported'&&!!model.symbol.geometry?.length&&model.symbol.pins.every(pin=>typeof pin.labelVisible==='boolean'&&typeof pin.numberVisible==='boolean')
  const restoredDisplay=!sameVisual&&isOwnedPspiceSource(model.source)&&(sameImportedLayout(old.symbol,model.symbol)||recoveredOriginal)
  if (old.spice !== model.spice || !sameVisual&&!restoredDisplay) throw new Error(`当前项目中的 ${model.id} 代码或符号与自建库不同，未覆盖。请将其中一个模型另存为新模型名再放置。`)
  if (JSON.stringify(old.source) !== JSON.stringify(model.source) || JSON.stringify(old.metadata) !== JSON.stringify(model.metadata)) throw new Error(`当前项目中的 ${model.id} 与自建库的来源信息不同。为保留两份来源，请将其中一个模型另存为新模型名再放置。`)
  // Restore original OLB display metadata or recover a previously missing
  // symbol. Existing device anchors stay saved; presentation keeps their old
  // layout when the recovered original differs, while new placements use it.
  const restoreAssessment = !old.assessment && !!model.assessment
  return restoredDisplay || restoreAssessment
    ? models.map(item => item === old ? {
      ...item,
      ...(restoredDisplay ? { symbol: model.symbol } : {}),
      ...(restoreAssessment ? { assessment: model.assessment } : {}),
    } : item)
    : models
}
