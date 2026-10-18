import { useEffect, useRef, useState } from 'react'
import { BookOpen, Check, ExternalLink, FileUp, LibraryBig, Plus, Search, SquarePen, Trash2, X } from 'lucide-react'
import type { Project } from '../core/circuit'
import { decodeSpiceLibrary, mergeImportedModels, parseSpiceLibrary, SPICE_LIBRARY_LIMITS, type ImportedSpiceModel } from '../core/spice-models'
import ModelSymbolPreview from './ModelSymbolPreview'
import { catalogModelParameters, modelTypeLabels, searchCatalog } from '../core/model-catalog'
import LocalModelCatalog from './LocalModelCatalog'
import type { AgentModelAcquisition } from '../core/agent-models'
import type { ModelDownloadPreview } from '../core/model-search'
import { parseModelLibraryPreview } from '../core/model-library-preview'

type Preview = ReturnType<typeof parseSpiceLibrary>
type Page = 'local' | 'project' | 'import'

export default function SpiceLibrary({ project, onChange, onPlace, onEditModel, onClose, acquisitions = [], onImportAcquired, onImportAndPlaceModel, initialPage }: {
  project: Project
  onChange: (models: ImportedSpiceModel[]) => void
  onPlace: (model: ImportedSpiceModel) => void
  onEditModel?: (id: string) => void
  onClose: () => void
  acquisitions?: AgentModelAcquisition[]
  onImportAcquired?: (model: ImportedSpiceModel) => void
  onImportAndPlaceModel?: (model: ImportedSpiceModel, preview: ModelDownloadPreview) => void | Promise<void>
  initialPage?: Page
}) {
  const [page, setPage] = useState<Page>(initialPage ?? (project.models?.length ? 'project' : 'local'))
  const [text, setText] = useState(''), [label, setLabel] = useState('用户导入')
  const [url, setUrl] = useState(''), [license, setLicense] = useState('')
  const [attribution, setAttribution] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState(''), [projectQuery, setProjectQuery] = useState(''), [projectType, setProjectType] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingEdit, setPendingEdit] = useState<string | null>(null)
  const panel = useRef<HTMLElement>(null), input = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const room = Math.max(0, SPICE_LIBRARY_LIMITS.projectModels - (project.models?.length ?? 0))
  const candidates = searchCatalog(preview?.models??[],filter)
  const projectMatches=searchCatalog(project.models??[],projectQuery,projectType)
  useEffect(() => {
    if (pendingEdit && project.models?.some(model => model.id.toLowerCase() === pendingEdit.toLowerCase())) {
      setPendingEdit(null)
      onEditModel?.(pendingEdit)
    }
  }, [pendingEdit, project.models, onEditModel])
  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      if (event.key !== 'Tab') return
      const elements = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary') ?? []).filter(el => el.getClientRects().length > 0)
      const first = elements[0], last = elements.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', key, true)
    return () => { mounted.current = false; window.removeEventListener('keydown', key, true); previous?.focus() }
  }, [onClose])

  function resetPreview() { setPreview(null); setSelected(new Set()); setError(''); setNotice('') }
  function inspect(content = text, source = { label, ...(url.trim() ? { url: url.trim() } : {}), ...(license.trim() ? { license: license.trim() } : {}), ...(attribution.trim() ? { attribution: attribution.trim() } : {}) }) {
    try {
      setError(''); setNotice('')
      const result = parseModelLibraryPreview(content, source)
      setPreview(result)
      const existing = new Set(project.models?.map(model => model.id.toLowerCase()))
      setFilter('')
      setSelected(new Set(result.models.filter(model => !existing.has(model.id.toLowerCase())).slice(0, room).map(model => model.id)))
    } catch (cause) { setPreview(null); setError((cause as Error).message) }
  }
  async function readFile(file?: File) {
    if (!file) return
    resetPreview(); setBusy(true)
    try {
      if (file.size > SPICE_LIBRARY_LIMITS.fileBytes) throw new Error('模型文件最多支持 4 MB，请先拆分大型库。')
      const content = decodeSpiceLibrary(await file.arrayBuffer())
      if (!mounted.current) return
      setText(content); setLabel(file.name); setUrl(''); setLicense(''); setAttribution('')
      inspect(content, { label: file.name })
    } catch (cause) { if (mounted.current) setError((cause as Error).message) }
    finally { if (mounted.current) setBusy(false); if (input.current) input.current.value = '' }
  }
  function apply() {
    if (!preview) return
    try {
      const chosen = preview.models.filter(model => selected.has(model.id))
      if (!chosen.length) throw new Error('请先选择要导入的模型。')
      const next = mergeImportedModels(project.models ?? [], chosen)
      onChange(next); setPage('project'); setNotice(`已导入 ${chosen.length} 个模型。点击“放置”将对应器件放入画布；工程导出会保留模型。`); setError(''); setPreview(null)
    } catch (cause) { setError((cause as Error).message) }
  }
  function editLocalModel(model: ImportedSpiceModel) {
    if (!onEditModel || model.kind === 'X') return
    try {
      const existing = project.models?.find(item => item.id.toLowerCase() === model.id.toLowerCase())
      if (existing) {
        if (existing.spice !== model.spice) throw new Error(`工程内已有同名但定义不同的 ${model.id}；请先为其中一个模型另存为新名称。`)
        onEditModel(existing.id); return
      }
      onChange(mergeImportedModels(project.models ?? [], [model]))
      setPendingEdit(model.id)
      setError('')
    } catch (cause) { setError((cause as Error).message) }
  }
  return <div className="spice-library-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <aside ref={panel} className="spice-library-dialog" role="dialog" aria-modal="true" aria-label="SPICE 模型库">
      <header><div><span className="spice-library-kicker">MODEL LIBRARY</span><h2><LibraryBig size={23} />SPICE 模型库</h2><p>把器件的电气模型带进你的原理图。</p></div><button onClick={onClose} aria-label="关闭 SPICE 模型库"><X size={20}/></button></header>
      <nav aria-label="模型库页面">{([{id:'local',name:'本地库'},{ id: 'project', name: `工程模型 · ${project.models?.length ?? 0}` }, { id: 'import', name: '导入模型' }] as const).map(tab => <button key={tab.id} aria-pressed={page === tab.id} onClick={() => { setPage(tab.id); setError('') }}>{tab.name}</button>)}</nav>
      <div className="spice-library-content">
        {error && <p className="spice-library-error" role="alert">{error}</p>}
        {notice && <p className="spice-library-notice" role="status"><Check size={16}/>{notice}</p>}
        {page==='local'&&<LocalModelCatalog models={project.models??[]} onImportAndPlaceModel={onImportAndPlaceModel} acquisitions={acquisitions} onImportAcquired={model=>{if(onImportAcquired)onImportAcquired(model);else onChange(mergeImportedModels(project.models,[model]))}} onImport={incoming=>{const next=mergeImportedModels(project.models,incoming);onChange(next);setNotice(`已导入 ${incoming.length} 个真实型号，可在此继续放置或打开“工程模型”查看。`)}} onPlace={onPlace} onManual={()=>setPage('import')} onEditModel={onEditModel?editLocalModel:undefined}/>}
        {page === 'project' && <>
          {!!project.models?.length&&<div className="catalog-filters project-model-filters"><label><Search size={16}/><input aria-label="搜索工程模型" placeholder="搜索型号、厂家、类型或参数，如 BF=200…" value={projectQuery} onChange={event=>setProjectQuery(event.target.value)}/></label><select aria-label="工程模型器件类型" value={projectType} onChange={event=>setProjectType(event.target.value)}><option value="">全部类型</option>{Object.entries(modelTypeLabels).map(([type,name])=><option key={type} value={type}>{name}</option>)}</select><span role="status">{projectMatches.length} / {project.models.length} 个模型</span></div>}
          {!project.models?.length ? <div className="spice-library-empty"><BookOpen size={32}/><h3>这个工程还没有外部模型</h3><p>从本地库选择随附示例，或导入 .lib / .mod 文件。</p><button className="primary" onClick={() => setPage('import')}><Plus size={15}/>导入第一个模型</button></div> : <div className="project-model-list">{projectMatches.map(model => {
            const used = project.drawing?.devices.filter(device => device.kind === model.kind && device.value.toLowerCase() === model.id.toLowerCase()) ?? []
            return <article key={model.id}><div className="project-model-heading"><ModelSymbolPreview model={model}/><div><h3>{model.id}</h3><span>{model.type} · 逻辑端子 {model.pins.join(' / ')}</span></div><button className="primary" onClick={() => onPlace(model)} aria-label={`放置模型 ${model.id}`}><Plus size={14}/>放置</button></div><p>{model.detail}</p><dl className="catalog-model-parameters" aria-label={`${model.id} 模型关键参数`}>{catalogModelParameters(model).map(parameter=><div key={parameter.key}><dt>{parameter.key}</dt><dd>{parameter.value}</dd></div>)}</dl><div className="model-provenance">来源：{model.source.url ? <a href={model.source.url} target="_blank" rel="noreferrer">{model.source.label}<ExternalLink size={12}/></a> : model.source.label}<small>{model.source.attribution && `${model.source.attribution} · `}{model.source.license || '未提供许可信息'}{used.length ? ` · 使用中：${used.map(device => device.id).join('、')}` : ''}</small></div><details><summary>模型定义与参数</summary><pre>{model.spice}</pre>{Object.keys(model.metadata).length > 0 && <p>原库附加信息：{Object.entries(model.metadata).map(([key, value]) => `${key}=${value}`).join(' · ')}</p>}</details>{onEditModel && <button className="project-model-edit" onClick={() => onEditModel(model.id)} aria-label={`编辑模型 ${model.id}`}><SquarePen size={13}/>编辑模型</button>}<button className="model-remove" disabled={used.length > 0} title={used.length ? '请先删除或切换使用此模型的器件' : '移除模型，可在关闭后撤销'} onClick={() => onChange((project.models ?? []).filter(item => item.id !== model.id))}><Trash2 size={13}/>移除{used.length ? '（正在使用）' : ''}</button></article>
          })}</div>}
          {!!project.models?.length&&!projectMatches.length&&<p className="catalog-loading">工程模型中没有匹配结果。清除筛选，或打开离线模型目录搜索更多型号。</p>}
        </>}
        {page === 'import' && <>
          <div className="model-import-intro"><FileUp size={22}/><div><strong>导入本机或下载的模型文件</strong><p>支持二极管、NPN / PNP、Level 1–3 MOS 与功率 VDMOS 的 .model；可识别 UTF-8 / UTF-16 和续行。</p></div><button disabled={busy} onClick={() => input.current?.click()}>选择文件</button><input ref={input} type="file" className="hidden" accept=".lib,.mod,.model,.txt,.dio,.bjt,.mos,.sp,.cir,.sub" onChange={event => void readFile(event.target.files?.[0])}/></div>
          <div className="model-source-fields"><label>来源名称<input value={label} disabled={busy} onChange={event => { setLabel(event.target.value); resetPreview() }} maxLength={200}/></label><label>来源网址（可选）<input type="url" value={url} disabled={busy} onChange={event => { setUrl(event.target.value); resetPreview() }} placeholder="https://…" maxLength={1000}/></label><label>许可说明（可选）<input value={license} disabled={busy} onChange={event => { setLicense(event.target.value); resetPreview() }} placeholder="原文件或下载页中的许可" maxLength={300}/></label><label>作者 / 署名（可选）<input value={attribution} disabled={busy} onChange={event=>{setAttribution(event.target.value);resetPreview()}} maxLength={1000}/></label></div>
          <label className="model-text-label">模型文本<textarea aria-label="SPICE 模型文本" rows={7} value={text} disabled={busy} onChange={event => { setText(event.target.value); resetPreview() }} spellCheck={false} placeholder="粘贴包含 .model 声明的 SPICE 模型文本…" maxLength={SPICE_LIBRARY_LIMITS.fileBytes}/></label>
          <div className="model-import-actions"><button className="primary" disabled={busy || !text.trim()} onClick={() => inspect()}>{busy ? '读取中…' : '解析并预览'}</button><small>支持自包含的 .subckt；加密模型、LTspice 专有元件及外部依赖会被拒绝。导入前核对引脚顺序，解析后仍需运行仿真。</small></div>
          {preview && <section className="model-preview" aria-label="模型导入预览"><div className="model-preview-title"><strong>{preview.models.length} 个可导入模型</strong><span>已选择 {selected.size} 个</span></div>
            {preview.diagnostics.length > 0 && <details open><summary>{preview.diagnostics.length} 条兼容提示</summary><ul>{preview.diagnostics.map((diagnostic, index) => <li key={index} className={diagnostic.severity}>第 {diagnostic.line} 行{diagnostic.model ? ` · ${diagnostic.model}` : ''}：{diagnostic.message}</li>)}</ul></details>}
            <div className="model-preview-selection"><input aria-label="筛选导入模型" placeholder="搜索型号 / 厂家 / 类型 / 参数…" value={filter} onChange={event=>setFilter(event.target.value)}/><button onClick={()=>setSelected(new Set(candidates.filter(model=>!project.models?.some(item=>item.id.toLowerCase()===model.id.toLowerCase())).slice(0,room).map(model=>model.id)))}>选择筛选结果</button><button onClick={()=>setSelected(new Set())}>清空选择</button><small>每个工程最多 128 个模型；还可导入 {room} 个。</small></div>
            <div className="model-candidates">{candidates.map(model => { const exists = project.models?.some(item => item.id.toLowerCase() === model.id.toLowerCase()); return <label key={model.id}><input type="checkbox" aria-label={`选择导入模型 ${model.id}`} checked={selected.has(model.id)} disabled={exists || !selected.has(model.id) && selected.size >= room} onChange={event => setSelected(old => { const next = new Set(old); event.target.checked ? next.add(model.id) : next.delete(model.id); return next })}/><ModelSymbolPreview model={model}/><span><strong>{model.id}</strong><small>{model.type} · 逻辑端子 {model.pins.join(' / ')}{exists ? ' · 工程已存在' : ''}</small></span></label> })}</div>
            <button className="primary" disabled={!selected.size} onClick={apply}>导入所选模型（{selected.size}）</button>
          </section>}
        </>}
      </div>
      <footer><span>模型随工程 JSON 保存 · 仿真在本机 ngspice 中执行</span><button onClick={onClose}>返回原理图</button></footer>
    </aside>
  </div>
}
