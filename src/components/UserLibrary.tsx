import { useEffect, useRef, useState } from 'react'
import { Download, FolderOpen, Trash2, Upload } from 'lucide-react'
import type { ImportedSpiceModel } from '../core/spice-models'
import { exportUserLibrary, loadUserLibrary, parseUserLibrary, USER_LIBRARY_EVENT, USER_LIBRARY_KEY, type UserLibraryDocument } from '../core/user-library'
import { refreshPersistentUserLibrary, importPersistentUserLibrary, removeModelFromPersistentUserLibrary } from '../core/user-library-sync'
import { modelSymbolOriginLabel } from '../core/model-symbol'
import ModelSymbolPreview from './ModelSymbolPreview'
import SaveToUserLibrary from './SaveToUserLibrary'
import ModelingScopePanel, { legacyModelingAssessment } from './ModelingScopePanel'

export default function UserLibrary({ search = '', projectModels = [], onPlace }: { search?: string; projectModels?: ImportedSpiceModel[]; onPlace?: (model: ImportedSpiceModel) => void }) {
  const [library, setLibrary] = useState<UserLibraryDocument>({ schemaVersion: 1, entries: [] }), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [selected, setSelected] = useState(''), [removeId, setRemoveId] = useState<string | null>(null), input = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(true), [working, setWorking] = useState(false)
  useEffect(() => {
    let active = true
    const changed = (event: Event) => { try { setLibrary(event instanceof window.CustomEvent && event.detail ? parseUserLibrary(event.detail) : loadUserLibrary()); setError(''); setNotice('') } catch (reason) { setError((reason as Error).message) } }
    const refresh = async () => { try { const latest = await refreshPersistentUserLibrary(); if (active) { setLibrary(latest); setError('') } } catch (reason) { if (active) setError((reason as Error).message) } finally { if (active) setLoading(false) } }
    const storage = (event: StorageEvent) => { if (event.key === USER_LIBRARY_KEY) void refresh() }
    const focused = () => void refresh()
    try { setLibrary(loadUserLibrary()) } catch { /* Durable refresh supplies the actionable error. */ }
    window.addEventListener(USER_LIBRARY_EVENT, changed); window.addEventListener('storage', storage); window.addEventListener('focus', focused); void refresh()
    return () => { active = false; window.removeEventListener(USER_LIBRARY_EVENT, changed); window.removeEventListener('storage', storage); window.removeEventListener('focus', focused) }
  }, [])
  const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const matches = library.entries.filter(entry => words.every(word => `${entry.name} ${entry.model.id} ${entry.model.type} ${entry.model.source.label}`.toLowerCase().includes(word)))
  const currentModel = projectModels.find(model => model.id === selected) ?? projectModels[0]
  async function readFile(file?: File) {
    if (!file) return
    setWorking(true); setError(''); setNotice('')
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('自建库备份文件最多支持 4 MB')
      const result = await importPersistentUserLibrary(await file.text())
      setLibrary(result.document); setError(''); setNotice(`已导入 ${result.added} 个器件${result.updated ? `，补充 ${result.updated} 个器件的建模记录` : ''}，保留 ${result.skipped} 个已有条目。`)
    } catch (reason) { setError((reason as Error).message); setNotice('') }
    finally { setWorking(false); if (input.current) input.current.value = '' }
  }
  function download() {
    try {
      const url = URL.createObjectURL(new Blob([exportUserLibrary(library)], { type: 'application/json' })), anchor = document.createElement('a')
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
    <div className="library-section-heading"><span>自建库</span><span>{matches.length} / {library.entries.length} 个</span></div>
    <p className="user-library-note">自建库是所有项目共用的本机器件库。保存后关闭页面、切换项目仍会保留；点击器件即可放置。工程的「保存」用于保存当前电路。</p>
    <div className="user-library-tools"><button type="button" disabled={loading || working} onClick={() => input.current?.click()}><Upload size={13}/>导入备份</button><button type="button" disabled={loading || working} onClick={download}><Download size={13}/>导出备份</button><input ref={input} type="file" hidden accept=".json,application/json" aria-label="导入自建库备份" onChange={event => void readFile(event.target.files?.[0])}/></div>
    {currentModel && <div className="user-library-project-save"><label>从当前项目保存<select aria-label="保存到自建库的项目模型" value={currentModel.id} onChange={event => setSelected(event.target.value)}>{projectModels.map(model => <option key={model.id} value={model.id}>{model.id} · {model.type}</option>)}</select></label><SaveToUserLibrary model={currentModel}/></div>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{loading && <p role="status">正在读取本机自建库…</p>}{working && <p role="status">正在保存自建库更改…</p>}
    {!loading && !matches.length && <div className="user-library-empty"><FolderOpen size={25}/><strong>{library.entries.length ? '没有匹配的自建器件' : '保存你自己的器件'}</strong><p>将编辑、导入或建模后的模型保存到这里。模型与符号一起保存，可跨项目放置。</p></div>}
    <div className="user-library-cards">{matches.map(entry => <article key={entry.id} className="user-library-card">
      <button type="button" className="user-library-place" disabled={!onPlace} onClick={() => { try { onPlace?.(entry.model); setError('') } catch (reason) { setError((reason as Error).message) } }} aria-label={`放置自建器件 ${entry.name}`}><ModelSymbolPreview model={entry.model}/><span><strong>{entry.name}</strong><code>{entry.model.id}</code><small>{entry.model.type} · {modelSymbolOriginLabel(entry.model.symbol)}</small></span></button>
      <details><summary>代码、来源与建模范围</summary><ModelingScopePanel assessment={entry.model.assessment ?? legacyModelingAssessment(entry.model)} legacy={!entry.model.assessment}/><p>{entry.model.source.label}</p>{entry.model.source.url && <a href={entry.model.source.url} target="_blank" rel="noreferrer">原始来源</a>}<pre>{entry.model.spice}</pre><p>电气引脚：{entry.model.symbol!.pins.map(pin => `${pin.index + 1}=${pin.label}`).join(' · ')}</p>{entry.model.source.attribution && <p>{entry.model.source.attribution}</p>}</details>
      <div className="user-library-card-actions">{removeId === entry.id ? <><span>移除此库条目？</span><button type="button" disabled={working} onClick={() => void remove(entry.id)}>确认移除</button><button type="button" disabled={working} onClick={() => setRemoveId(null)}>取消</button></> : <button type="button" disabled={loading || working} aria-label={`从自建库移除 ${entry.name}`} onClick={() => { setRemoveId(entry.id); setNotice('') }}><Trash2 size={12}/>移除</button>}</div>
    </article>)}</div>
    <p className="user-library-note">模型、来源、符号与电气引脚顺序一起保存，支持已通过兼容检查的子电路。可导出 JSON 备份或迁移到另一台电脑。</p>
  </section>
}
