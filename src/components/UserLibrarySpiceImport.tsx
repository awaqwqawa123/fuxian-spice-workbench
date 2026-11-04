import { useEffect, useRef, useState, type DragEvent } from 'react'
import { FileUp, X } from 'lucide-react'
import type { SpiceLibraryPreview } from '../core/spice-models'
import type { UserLibraryDocument } from '../core/user-library'
import { importModelsToPersistentUserLibrary } from '../core/user-library-sync'
import { previewUserLibrarySpiceFile, USER_LIBRARY_CAPACITY, USER_SPICE_FILE_ACCEPT } from '../core/user-library-spice-import'
import ModelSymbolPreview from './ModelSymbolPreview'

export default function UserLibrarySpiceImport({ library, disabled, onImported, onBusyChange, onStart }: {
  library: UserLibraryDocument; disabled: boolean
  onImported: (document: UserLibraryDocument, message: string) => void
  onBusyChange: (busy: boolean) => void
  onStart: () => void
}) {
  const input = useRef<HTMLInputElement>(null), mounted = useRef(true)
  const [open, setOpen] = useState(false), [dragging, setDragging] = useState(false), [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<SpiceLibraryPreview | null>(null), [filename, setFilename] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set()), [query, setQuery] = useState(''), [error, setError] = useState('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const existing = new Set(library.entries.map(entry => entry.model.id.toLowerCase()))
  const room = Math.max(0, USER_LIBRARY_CAPACITY - library.entries.length)
  const models = preview?.models ?? [], matches = models.filter(model => `${model.id} ${model.type}`.toLowerCase().includes(query.trim().toLowerCase()))
  const chosen = models.filter(model => selected.has(model.id)), newCount = chosen.filter(model => !existing.has(model.id.toLowerCase())).length
  function working(value: boolean) { setBusy(value); onBusyChange(value) }
  async function readFile(file?: File) {
    if (!file || busy || disabled) return
    onStart()
    setOpen(true); setError(''); setPreview(null); setSelected(new Set()); setQuery(''); setFilename(file.name); working(true)
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('SPICE 模型文件最多支持 4 MB，请先拆分大型库。')
      const result = previewUserLibrarySpiceFile(file.name, await file.arrayBuffer())
      if (!mounted.current) return
      setPreview(result)
      let available = room
      setSelected(new Set(result.models.filter(model => existing.has(model.id.toLowerCase()) || available-- > 0).map(model => model.id)))
      if (!result.models.length && !result.diagnostics.length) setError('文件中没有可识别的 .model 或自包含 .subckt 模型。')
    } catch (reason) { if (mounted.current) setError((reason as Error).message) }
    finally { if (mounted.current) { working(false); if (input.current) input.current.value = '' } }
  }
  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault(); event.stopPropagation(); setDragging(false)
    if (busy || disabled) return
    if (event.dataTransfer.files.length !== 1) { onStart(); setOpen(true); setPreview(null); setSelected(new Set()); setFilename(''); setError('每次请拖入一个模型文件；一个文件内可以包含多个模型。'); return }
    void readFile(event.dataTransfer.files[0])
  }
  async function apply() {
    if (!chosen.length || newCount > room || busy) return
    setError(''); working(true)
    try {
      const result = await importModelsToPersistentUserLibrary(chosen)
      if (!mounted.current) return
      onImported(result.document, `已保存 ${result.added} 个模型到自建库${result.skipped ? `，保留 ${result.skipped} 个相同条目` : ''}。可跨项目放置，模型代码、符号与引脚顺序一起保留。`)
      setPreview(null); setSelected(new Set()); setOpen(false)
    } catch (reason) { if (mounted.current) setError((reason as Error).message) }
    finally { if (mounted.current) working(false) }
  }
  return <section className={`user-spice-import${dragging ? ' is-dragging' : ''}`} aria-label="导入 SPICE 模型到自建库"
    onDragOver={event => { if (!busy && !disabled && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setDragging(true) } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }} onDrop={drop}>
    <div className="user-spice-import-heading"><button type="button" className="user-spice-file-button" disabled={disabled || busy} onClick={() => input.current?.click()}><FileUp size={15}/>导入 SPICE 模型</button><span>或将模型文件拖到这里 · .lib / .mod / .cir / .sub 等 · 最多 4 MB</span>{open && <button type="button" aria-label="收起 SPICE 导入" disabled={busy} onClick={() => { setOpen(false); setError('') }}><X size={15}/></button>}</div>
    <input ref={input} type="file" hidden accept={USER_SPICE_FILE_ACCEPT} aria-label="选择自建库 SPICE 模型文件" onChange={event => void readFile(event.target.files?.[0])}/>
    {open && <div className="user-spice-import-body">
      <p className="user-spice-import-help">直接存入所有项目共用的自建库。支持 .model 和自包含 .subckt；原理图保持不变。{filename && <strong>当前文件：{filename}</strong>}</p>
      {error && <p role="alert">{error}</p>}
      {preview && <>
        <div className="user-spice-preview-heading"><strong>{models.length} 个可导入模型 · 已选 {chosen.length} 个</strong><span>自建库 {library.entries.length} / {USER_LIBRARY_CAPACITY} · 剩余 {room} 个新模型位置</span></div>
        {!!preview.diagnostics.length && <details className="user-spice-diagnostics" open={!models.length}><summary>{preview.diagnostics.length} 条兼容检查提示{!models.length ? ' · 没有可导入模型' : ''}</summary><ul>{preview.diagnostics.map((item, index) => <li key={index} className={item.severity}>第 {item.line} 行{item.model ? ` · ${item.model}` : ''}：{item.message}</li>)}</ul></details>}
        {!!models.length && <>
          <div className="user-spice-selection"><input aria-label="筛选自建库待导入模型" placeholder="搜索型号或类型…" value={query} onChange={event => setQuery(event.target.value)} disabled={busy}/><button type="button" disabled={busy} onClick={() => { let available = room; setSelected(new Set(matches.filter(model => existing.has(model.id.toLowerCase()) || available-- > 0).map(model => model.id))) }}>选择筛选结果</button><button type="button" disabled={busy} onClick={() => setSelected(new Set())}>清空选择</button></div>
          <div className="user-spice-candidates">{matches.slice(0, 100).map(model => <article key={model.id}><label><input type="checkbox" aria-label={`选择自建库导入模型 ${model.id}`} checked={selected.has(model.id)} disabled={busy || !selected.has(model.id) && !existing.has(model.id.toLowerCase()) && newCount >= room} onChange={event => setSelected(current => { const next = new Set(current); event.target.checked ? next.add(model.id) : next.delete(model.id); return next })}/><ModelSymbolPreview model={model}/><span><strong>{model.id}</strong><small>{model.type} · 引脚 {model.pins.map((pin, index) => `${index + 1}=${pin}`).join(' / ')}{existing.has(model.id.toLowerCase()) ? ' · 已有同名模型，保存时检查冲突' : ''}</small></span></label><details><summary>{model.id} · 查看 SPICE 代码</summary><pre>{model.spice}</pre></details></article>)}</div>
          {matches.length > 100 && <p>当前显示前 100 项，请搜索缩小范围；已选模型仍全部保留。</p>}
          <div className="user-spice-import-actions"><span>同名且内容一致时跳过；冲突时整批不保存。解析通过后仍需仿真验证。</span><button type="button" disabled={busy || disabled || !chosen.length || newCount > room} onClick={() => void apply()}>保存所选到自建库（{chosen.length}）</button></div>
        </>}
      </>}
    </div>}
  </section>
}
