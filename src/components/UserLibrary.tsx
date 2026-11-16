import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Download, FolderOpen, Trash2, Upload } from 'lucide-react'
import type { ImportedSpiceModel } from '../core/spice-models'
import { exportUserLibrary, loadUserLibrary, parseUserLibrary, parseUserLibraryBackup, planUserLibraryBackup, USER_LIBRARY_BACKUP_MAX_BYTES, USER_LIBRARY_EVENT, USER_LIBRARY_KEY, type UserLibraryDocument, type UserLibraryEntry } from '../core/user-library'
import { refreshPersistentUserLibrary, restorePersistentUserLibraryBackup, removeModelFromPersistentUserLibrary } from '../core/user-library-sync'
import { modelSymbolOriginLabel } from '../core/model-symbol'
import ModelSymbolPreview from './ModelSymbolPreview'
import SaveToUserLibrary from './SaveToUserLibrary'
import ModelingScopePanel, { legacyModelingAssessment } from './ModelingScopePanel'
import UserLibrarySpiceImport from './UserLibrarySpiceImport'

function ModelDetails({ entry }: { entry: UserLibraryEntry }) {
  const [open, setOpen] = useState(false)
  const { model } = entry
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>代码、来源与建模范围</summary>
    {open && <><ModelingScopePanel assessment={model.assessment ?? legacyModelingAssessment(model)} legacy={!model.assessment}/><p>{model.source.label}</p>{model.source.url && <a href={model.source.url} target="_blank" rel="noreferrer">原始来源</a>}<pre>{model.spice}</pre><p>电气引脚：{model.symbol!.pins.map(pin => `${pin.index + 1}=${pin.label}`).join(' · ')}</p>{model.source.attribution && <p>{model.source.attribution}</p>}</>}
  </details>
}

export default function UserLibrary({ search = '', projectModels = [], onPlace }: { search?: string; projectModels?: ImportedSpiceModel[]; onPlace?: (model: ImportedSpiceModel) => void }) {
  const [library, setLibrary] = useState<UserLibraryDocument>(() => {
    try { return loadUserLibrary() } catch { return { schemaVersion: 1, entries: [] } }
  }), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [selected, setSelected] = useState(''), [removeId, setRemoveId] = useState<string | null>(null), input = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(true), [working, setWorking] = useState(false)
  const [loadError, setLoadError] = useState(''), [readAttempt, setReadAttempt] = useState(0)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [backup, setBackup] = useState<{ name: string; document: UserLibraryDocument } | null>(null)
  const preview = useMemo(() => {
    if (!backup) return null
    try { return { plan: planUserLibraryBackup(library, backup.document), error: '' } }
    catch (reason) { return { plan: null, error: (reason as Error).message } }
  }, [backup, library])
  useEffect(() => {
    let active = true, refreshing = false
    const changed = (event: Event) => {
      try {
        const durable = event instanceof window.CustomEvent && event.detail
        setLibrary(durable ? parseUserLibrary(event.detail) : loadUserLibrary())
        if (durable) setLoadError('')
      } catch (reason) { setLoadError((reason as Error).message) }
    }
    const refresh = async () => {
      if (refreshing) return
      refreshing = true
      try { const latest = await refreshPersistentUserLibrary(); if (active) { setLibrary(latest); setLoadError('') } }
      catch (reason) { if (active) setLoadError((reason as Error).message) }
      finally { refreshing = false; if (active) setLoading(false) }
    }
    const storage = (event: StorageEvent) => { if (event.key === USER_LIBRARY_KEY) void refresh() }
    const focused = () => void refresh()
    window.addEventListener(USER_LIBRARY_EVENT, changed); window.addEventListener('storage', storage); window.addEventListener('focus', focused); void refresh()
    return () => { active = false; window.removeEventListener(USER_LIBRARY_EVENT, changed); window.removeEventListener('storage', storage); window.removeEventListener('focus', focused) }
  }, [readAttempt])
  const matches = useMemo(() => {
    const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean)
    return library.entries.filter(entry => words.every(word => `${entry.name} ${entry.model.id} ${entry.model.type} ${entry.model.source.label}`.toLowerCase().includes(word)))
      .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))
  }, [library, search])
  const currentModel = projectModels.find(model => model.id === selected) ?? projectModels[0]
  const managementDisabled = loading || working || Boolean(loadError)
  const showCount = library.entries.length > 0 || (!loading && !loadError)
  async function readFile(file?: File) {
    if (!file) return
    setWorking(true); setBackup(null); setError(''); setNotice('')
    try {
      if (file.size > USER_LIBRARY_BACKUP_MAX_BYTES) throw new Error('自建库备份文件最多支持 64 MB')
      setBackup({ name: file.name, document: parseUserLibraryBackup(await file.text()) })
    } catch (reason) { setError((reason as Error).message); setNotice('') }
    finally { setWorking(false); if (input.current) input.current.value = '' }
  }
  async function restore() {
    if (!backup || !preview?.plan || working) return
    setWorking(true); setError(''); setNotice('')
    try {
      const result = await restorePersistentUserLibraryBackup(backup.document, preview.plan.actions)
      setLibrary(result.document); setBackup(null)
      setNotice(`已新增 ${result.added} 个器件（同名另存 ${result.keptBoth} 个），已存在 ${result.skipped} 个，补充建模记录 ${result.updated} 个。`)
    } catch (reason) {
      const message = (reason as Error).message
      if (message.includes('在预览后已有变化')) {
        try { setLibrary(await refreshPersistentUserLibrary()) } catch { /* Retain the chosen file for retry. */ }
      }
      setError(message)
    } finally { setWorking(false) }
  }
  function download() {
    try {
      const blob = new Blob([exportUserLibrary(library)], { type: 'application/json' })
      if (blob.size > USER_LIBRARY_BACKUP_MAX_BYTES) throw new Error('当前自建库备份超过 64 MB，无法生成可直接恢复的文件。')
      const url = URL.createObjectURL(blob), anchor = document.createElement('a')
      anchor.href = url; anchor.download = 'fuxian-user-library.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (reason) { setError((reason as Error).message) }
  }
  async function remove(id: string) {
    setWorking(true); setError(''); setNotice('')
    try { const result = await removeModelFromPersistentUserLibrary(id); setLibrary(result.document); setRemoveId(null); setNotice('已从自建库移除，项目中已经放置的器件仍保留。') }
    catch (reason) { setError((reason as Error).message) }
    finally { setWorking(false) }
  }
  return <section className="user-library" aria-label="自建器件库">
    <div className="user-library-heading">
      <div><h3>已保存的器件</h3>{showCount && <span>{search.trim() ? `${matches.length} / ${library.entries.length} 个` : `${library.entries.length} 个`}</span>}</div>
      <button type="button" className="user-library-manage-toggle" aria-expanded={toolsOpen} aria-controls="user-library-manage-panel" onClick={() => setToolsOpen(current => !current)}>导入与管理<ChevronDown size={14} aria-hidden="true"/></button>
    </div>
    {loadError && <div className="user-library-load-error"><p role="alert">{loadError}{library.entries.length > 0 && ' 当前显示上次读取的器件。'}</p><button type="button" disabled={loading} onClick={() => { setLoading(true); setLoadError(''); setReadAttempt(current => current + 1) }}>重新读取</button></div>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{loading && !library.entries.length && <p role="status">正在读取本机自建库…</p>}{working && <p role="status">正在处理自建库操作…</p>}
    <div className="user-library-manage-panel" id="user-library-manage-panel" hidden={!toolsOpen}>
    <UserLibrarySpiceImport library={library} disabled={managementDisabled} onStart={() => { setError(''); setNotice('') }} onBusyChange={setWorking} onImported={(document, message) => { setLibrary(document); setError(''); setNotice(message) }}/>
    <div className="user-library-tools"><button type="button" disabled={managementDisabled} onClick={() => input.current?.click()}><Upload size={13}/>导入备份</button><button type="button" disabled={managementDisabled} onClick={download}><Download size={13}/>导出备份</button><input ref={input} type="file" hidden accept=".json,application/json" aria-label="导入自建库备份" onChange={event => void readFile(event.target.files?.[0])}/></div>
    {backup && <section className="user-library-backup-preview" aria-label="自建库备份预览">
      <header><strong>{backup.name}</strong><span>{backup.document.entries.length} 个模型 · {backup.document.entries.filter(entry => !!entry.model.symbol).length} 个符号</span></header>
      {preview?.error && <p role="alert">{preview.error}</p>}
      {preview?.plan && <><p>新增 {preview.plan.added} 个（含同名另存 {preview.plan.keptBoth} 个），已存在 {preview.plan.skipped} 个，补充建模记录 {preview.plan.updated} 个。</p>
        {!!preview.plan.actions.length && <details open={preview.plan.keptBoth > 0}><summary>查看器件与保留方式</summary><ul>{preview.plan.actions.map(action => <li key={action.source}><code>{action.source}</code><span>{action.kind === 'keep-both' ? '保留两份 · 另存为' : action.kind === 'skip' ? '已存在' : action.kind === 'update' ? '补充建模记录' : '新增'}{action.target !== action.source && <> · <code>{action.target}</code></>}</span></li>)}</ul></details>}
      </>}
      <div className="user-library-tools"><button type="button" disabled={working} onClick={() => { setBackup(null); setError('') }}>取消导入备份</button><button type="button" className="user-library-backup-confirm" disabled={managementDisabled || !preview?.plan?.actions.length} onClick={() => void restore()}>确认合并备份</button></div>
    </section>}
    {currentModel && <div className="user-library-project-save"><label>从当前项目保存<select aria-label="保存到自建库的项目模型" value={currentModel.id} onChange={event => setSelected(event.target.value)}>{projectModels.map(model => <option key={model.id} value={model.id}>{model.id} · {model.type}</option>)}</select></label><SaveToUserLibrary model={currentModel}/></div>}
    <p className="user-library-note">备份包含模型、来源、符号和电气引脚顺序。更换安装目录时，可导入原先导出的备份，或选择旧安装中的 <code>.desktop-circuit/user-library.json</code>。</p>
    </div>
    {!loading && !loadError && !matches.length && <div className="user-library-empty"><FolderOpen size={25}/><strong>{library.entries.length ? '没有匹配的自建器件' : '这个安装还没有保存的器件'}</strong><p>{library.entries.length ? '试试搜索型号、名称或来源。' : '建模后可保存到自建库。在「导入与管理」可导入 SPICE 文件，或用「导入备份」恢复旧安装的器件。'}</p></div>}
    <div className="user-library-cards" role="group" aria-label="已保存的自建器件">{matches.map(entry => <article key={entry.id} className="user-library-card">
      <button type="button" className="user-library-place" disabled={!onPlace} onClick={() => { try { onPlace?.(entry.model); setError('') } catch (reason) { setError((reason as Error).message) } }} aria-label={`放置自建器件 ${entry.name}`}><ModelSymbolPreview model={entry.model}/><span><strong>{entry.name}</strong><code>{entry.model.id}</code><small>{entry.model.type} · {modelSymbolOriginLabel(entry.model.symbol)}</small></span></button>
      <ModelDetails entry={entry}/>
      <div className="user-library-card-actions">{removeId === entry.id ? <><span>移除此库条目？</span><button type="button" disabled={managementDisabled} onClick={() => void remove(entry.id)}>确认移除</button><button type="button" disabled={working} onClick={() => setRemoveId(null)}>取消</button></> : <button type="button" disabled={managementDisabled} aria-label={`从自建库移除 ${entry.name}`} onClick={() => { setRemoveId(entry.id); setNotice('') }}><Trash2 size={12}/>移除</button>}</div>
    </article>)}</div>
  </section>
}
