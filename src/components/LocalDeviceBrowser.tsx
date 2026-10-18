import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, LoaderCircle, Plus, RefreshCw, Search, X } from 'lucide-react'
import type { DeviceLibraryBrowsePage, DeviceLibraryModelSummary } from '../core/device-library-catalog'
import type { ImportedSpiceModel } from '../core/spice-models'
import { preferredModelLibraries, preferredModelLibrary, type PreferredModelLibrary } from '../core/model-source-policy'
import { modelCategories, modelCategoryGroups } from '../core/model-taxonomy'
import { ModelSymbolGraphic } from './ModelSymbolPreview'
import { DeviceProfileDetails } from './DeviceProfileDetails'
import { LocalServiceUnavailableError, readLocalService } from '../core/local-service-request'

const PAGE_SIZE = 40
const reconnectDelays = [1000, 2500, 5000, 10_000, 15_000, 30_000, 30_000]
const sourceLabels = { tina: 'TINA', pspice: 'PSpice', ltspice: 'LTspice' }
export interface LocalDeviceBrowserState { query: string; category: string; source: '' | PreferredModelLibrary; offset: number }
const requestKey = (state: LocalDeviceBrowserState) => JSON.stringify([state.query, state.category, state.source, state.offset])
type CachedPage = { page: DeviceLibraryBrowsePage; storedAt: number }
type CategoryBrowsePage = DeviceLibraryBrowsePage & { subcategories?: { id: string; group: string; label: string; count: number }[] }
const pageCache = new Map<string, CachedPage>()
let cacheGeneration: string | undefined
function cachedPage(key: string) {
  const result = pageCache.get(key)
  if (result && Date.now() - result.storedAt < 120_000) return result.page
  pageCache.delete(key)
  return null
}
function rememberPage(key: string, page: DeviceLibraryBrowsePage) {
  if (page.generation && cacheGeneration && page.generation !== cacheGeneration) pageCache.clear()
  if (page.generation) cacheGeneration = page.generation
  pageCache.delete(key)
  pageCache.set(key, { page, storedAt: Date.now() })
  while (pageCache.size > 24) pageCache.delete(pageCache.keys().next().value!)
}

export default function LocalDeviceBrowser({ state, onStateChange, projectModels = [], onImportAndPlace, onClose }: {
  state: LocalDeviceBrowserState
  onStateChange: (state: LocalDeviceBrowserState) => void
  projectModels?: ImportedSpiceModel[]
  onImportAndPlace?: (model: ImportedSpiceModel) => void | Promise<void>
  onClose: () => void
}) {
  const key = requestKey(state)
  const [result, setResult] = useState(() => ({ key, page: cachedPage(key) }))
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [placementError, setPlacementError] = useState('')
  const [indexing, setIndexing] = useState<{ message: string; progress?: { processed: number; total: number } } | null>(null)
  const [reconnecting, setReconnecting] = useState<{ attempt: number; delay: number } | null>(null)
  const [revision, setRevision] = useState(0), [placing, setPlacing] = useState('')
  const [versions, setVersions] = useState<Record<string, string>>({})
  const [collapsedGroup, setCollapsedGroup] = useState('')
  const input = useRef<HTMLInputElement>(null), mounting = useRef(true), refreshRequested = useRef(false), refreshOnRetry = useRef(false)
  const placementController = useRef<AbortController | null>(null)
  const page = result.key === key ? result.page : null
  const lastNavigationPage = useRef<CategoryBrowsePage | null>(result.page)
  if (page) lastNavigationPage.current = page
  useEffect(() => { mounting.current = true; return () => { mounting.current = false; placementController.current?.abort() } }, [])
  useEffect(() => {
    let active = true, poll: number | undefined, pollCount = 0, transportFailures = 0, transportUnavailable = false, reading = false, lastWake = 0
    const controller = new AbortController(), previous = cachedPage(key)
    let refresh = refreshRequested.current
    refreshRequested.current = false
    setResult(old => ({ key, page: previous ?? (old.key === key ? old.page : null) })); setLoading(true); setError(''); setIndexing(null); setReconnecting(null)
    refreshOnRetry.current = false
    async function read() {
      if (!active || reading) return
      reading = true
      const requestRefresh = refresh
      refresh = false
      try {
        const { response, value: data } = await readLocalService('/api/model-library/browse', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(requestRefresh ? { 'x-model-catalog-refresh': '1' } : {}) }, signal: controller.signal,
          body: JSON.stringify({ ...state, limit: PAGE_SIZE }),
        }, 15_000)
        if (!active) return
        transportFailures = 0; transportUnavailable = false; setReconnecting(null); setError('')
        if (response.status === 202 && data?.state === 'building') {
          setIndexing({ message: data.message || '正在整理本地索引', progress: data.progress }); setLoading(true)
          poll = window.setTimeout(() => void read(), [1000, 2000, 5000][Math.min(pollCount++, 2)])
          return
        }
        if (!response.ok) { refreshOnRetry.current = data?.state === 'failed'; throw new Error(data?.error || data?.message || `本地器件目录读取失败（${response.status}）`) }
        if (!data || !Array.isArray(data.groups) || !Array.isArray(data.counts) || !Array.isArray(data.libraries) || !Number.isFinite(data.total) || !Number.isFinite(data.offset) || !Number.isFinite(data.limit) || data.limit < 1) throw new Error('本地器件目录格式不正确，请重试')
        const next = data as DeviceLibraryBrowsePage
        rememberPage(key, next); setResult({ key, page: next }); setLoading(false); setIndexing(null)
        if (next.updating) {
          setIndexing({ message: '正在更新本地索引，现有器件仍可使用' })
          poll = window.setTimeout(() => void read(), 5000)
        }
      } catch (cause) {
        if (!active) return
        setIndexing(null)
        if (cause instanceof LocalServiceUnavailableError) {
          transportUnavailable = true
          // A lost connection does not invalidate an already compiled library.
          refreshOnRetry.current = false
          if (transportFailures < reconnectDelays.length) {
            const delay = reconnectDelays[transportFailures++]
            setReconnecting({ attempt: transportFailures, delay }); setLoading(true)
            poll = window.setTimeout(() => void read(), delay)
          } else {
            setReconnecting(null); setLoading(false)
            setError(cause.timedOut ? '本地后台响应超时，自动重连暂未成功。返回窗口时会再次检查，也可以立即重试。' : `本地后台暂未连接，已尝试自动重连 ${reconnectDelays.length} 次。返回窗口时会再次检查，也可以立即重试。`)
          }
        } else {
          transportUnavailable = false; setReconnecting(null); setLoading(false)
          setError(cause instanceof Error ? cause.message : '本地器件目录读取失败，请重试')
        }
      } finally { reading = false }
    }
    function wake() {
      if (!active || !transportUnavailable || reading || Date.now() - lastWake < 1000 || document.visibilityState === 'hidden') return
      lastWake = Date.now(); transportFailures = 0
      window.clearTimeout(poll); setLoading(true); setError(''); setReconnecting({ attempt: 1, delay: 0 })
      void read()
    }
    window.addEventListener('online', wake); window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake)
    const debounce = window.setTimeout(() => void read(), state.query ? 180 : 0)
    return () => { active = false; controller.abort(); window.clearTimeout(debounce); window.clearTimeout(poll); window.removeEventListener('online', wake); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake) }
  }, [key, revision])

  function refresh() {
    pageCache.clear(); refreshRequested.current = true; setRevision(value => value + 1)
  }
  function retry() {
    if (refreshOnRetry.current) { pageCache.clear(); refreshRequested.current = true }
    setRevision(value => value + 1)
  }
  async function place(model: DeviceLibraryModelSummary | ImportedSpiceModel) {
    if (!onImportAndPlace || placing || placementController.current) return
    const selectedKey = 'key' in model ? model.key : `saved:${model.id}`
    setPlacing(selectedKey); setPlacementError('')
    const controller = new AbortController(); placementController.current = controller
    let handedOff = false
    try {
      let complete: ImportedSpiceModel
      if ('key' in model) {
        const { response, value: data } = await readLocalService('/api/model-library/device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ key: model.key }) }, 30_000)
        if (!response.ok) throw new Error(data?.error || '器件模型读取失败')
        complete = data?.model
        if (!complete || complete.id !== model.id || complete.kind !== model.kind || typeof complete.spice !== 'string' || !complete.spice.trim() || complete.source?.label !== model.source.label || complete.source?.url !== model.source.url) throw new Error('器件模型与所选版本不一致，请重新读取目录')
      } else complete = model
      if (!mounting.current || controller.signal.aborted) return
      handedOff = true
      await onImportAndPlace(complete)
      if (mounting.current) onClose()
    } catch (cause) {
      if (mounting.current) setPlacementError(cause instanceof LocalServiceUnavailableError && !handedOff ? `${cause.timedOut ? '本地后台响应超时' : '本地后台暂未连接'}，器件尚未放置。连接恢复后请再次点击“放置”。` : cause instanceof Error ? cause.message : String(cause))
    } finally { if (mounting.current) setPlacing(''); placementController.current = null }
  }
  const setFilter = (values: Partial<LocalDeviceBrowserState>) => onStateChange({ ...state, ...values, offset: 0 })
  const resetFilters = () => onStateChange({ query: '', category: '', source: '', offset: 0 })
  const total = page?.total ?? 0
  const currentPage = page ? Math.floor(page.offset / page.limit) + 1 : 1
  const totalPages = page ? Math.max(1, Math.ceil(total / page.limit)) : 1
  // Keep navigation available while the next lightweight page is being read.
  const navigationPage = (page ?? lastNavigationPage.current) as CategoryBrowsePage | null
  const activeGroup = state.category.split(':')[0]
  function toggleCategory(group: string) {
    if (group && group === activeGroup) {
      setCollapsedGroup(value => value === group ? '' : group)
      return
    }
    setCollapsedGroup('')
    setFilter({ category: group })
  }
  const selectedGroup = navigationPage?.counts.find(item => item.id === activeGroup) ?? modelCategoryGroups.find(item => item.id === activeGroup)
  const selectedLeaf = navigationPage?.subcategories?.find(item => item.id === state.category) ?? modelCategories.find(item => item.id === state.category)
  const reconnectMessage = reconnecting ? `正在连接本地后台 · ${reconnecting.attempt}/${reconnectDelays.length}${reconnecting.delay ? `（${reconnecting.delay / 1000} 秒后重试）` : ''}` : ''
  return <div className="extension-library-body local-device-body">
    <nav className="extension-library-categories local-device-categories" aria-label="本地器件分类" aria-busy={loading}>
      <span>按器件功能浏览</span>
      {navigationPage?.counts.map(category => {
        const children = navigationPage.subcategories?.filter(item => item.group === category.id) ?? []
        const expanded = !!category.id && activeGroup === category.id && collapsedGroup !== category.id && children.length > 0
        return <div className="local-device-category-group" key={category.id}>
          <button type="button" className="local-device-category-parent" aria-label={category.id ? category.label : '全部型号'} title={children.length ? `${expanded ? '收起' : '展开'}${category.label}子分类` : undefined} aria-pressed={state.category === category.id} aria-expanded={children.length ? expanded : undefined} aria-controls={children.length ? `local-device-category-${category.id}` : undefined} data-active={!!category.id && activeGroup === category.id} onClick={() => children.length ? toggleCategory(category.id) : setFilter({ category: category.id })}>
            <span>{children.length ? expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/> : null}{category.id ? category.label : '全部型号'}</span><small>{category.count.toLocaleString()}</small>
          </button>
          {expanded && <div id={`local-device-category-${category.id}`} className="local-device-subcategories" role="group" aria-label={`${category.label}子分类`}>
            <button type="button" aria-label={`全部${category.label}`} aria-pressed={state.category === category.id} onClick={() => setFilter({ category: category.id })}><span>全部{category.label}</span><small>{category.count.toLocaleString()}</small></button>
            {children.map(child => <button type="button" key={child.id} aria-label={child.label} aria-pressed={state.category === child.id} data-empty={child.count === 0} onClick={() => setFilter({ category: child.id })}><span>{child.label}</span><small>{child.count.toLocaleString()}</small></button>)}
          </div>}
        </div>
      })}
      {!navigationPage && <span>{indexing ? '正在整理分类' : loading ? '读取分类中…' : '目录暂不可用'}</span>}
    </nav>
    <div className="extension-library-browser local-device-browser" aria-busy={loading}>
      <div className="local-device-filters">
        <label className="extension-library-search"><Search size={17}/><input ref={input} aria-label="搜索本地器件" placeholder="搜索型号、厂商或器件类型，如 TL431、运算放大器…" value={state.query} onChange={event => setFilter({ query: event.target.value })}/>{state.query && <button type="button" aria-label="清除本地器件搜索" onClick={() => { setFilter({ query: '' }); input.current?.focus() }}><X size={15}/></button>}</label>
        <select aria-label="器件来源" value={state.source} onChange={event => setFilter({ source: event.target.value as LocalDeviceBrowserState['source'] })}><option value="">PSpice 优先（全部库）</option>{preferredModelLibraries.map(source => <option key={source} value={source}>{sourceLabels[source]}{page ? ` · ${(page.libraries.find(item => item.id === source)?.count ?? 0).toLocaleString()}` : ''}</option>)}</select>
      </div>
      <div className="extension-library-result-heading"><strong className="local-device-category-heading">{selectedLeaf ? <><span>{selectedGroup?.label}</span><ChevronRight size={13}/>{selectedLeaf.label}</> : selectedGroup?.label || '本地器件'}</strong><span className="local-device-read-status" role="status">{(loading || indexing) && <LoaderCircle size={13} className="local-device-spinner"/>}{reconnecting ? `自动重连 ${reconnecting.attempt}/${reconnectDelays.length}` : indexing ? '正在整理本地索引' : loading ? page ? '更新当前页…' : '读取当前页…' : error ? '读取失败' : `${total.toLocaleString()} 个型号`}{page && <button type="button" aria-label="刷新本地器件目录" disabled={!!indexing || !!placing} onClick={refresh}><RefreshCw size={13}/></button>}</span></div>
      {placementError && <p className="local-device-error" role="alert">{placementError}</p>}
      {page && reconnecting && <p className="local-device-index-note" role="status"><LoaderCircle size={13} className="local-device-spinner"/>{reconnectMessage}。已读取的器件和分类保留。</p>}
      {page && error && <p className="local-device-error" role="alert">{error}<button type="button" onClick={retry}>重试</button></p>}
      {page && indexing && <p className="local-device-index-note" role="status"><LoaderCircle size={13} className="local-device-spinner"/>{indexing.message}</p>}
      {page?.stale && !indexing && <p className="local-device-index-note">本地库有更新，点击刷新目录更新索引。已有器件仍可使用。</p>}
      {!page && loading ? <div className="extension-library-empty local-device-loading" role="status"><LoaderCircle size={28} className="local-device-spinner"/><strong>{reconnecting ? '正在重新连接本地后台' : indexing ? '正在整理本地索引' : '正在读取当前页器件'}</strong><p>{reconnectMessage || indexing?.message || '每页 40 个型号，仅放置时读取完整模型'}</p>{indexing?.progress && indexing.progress.total > 0 && <p>{indexing.progress.processed.toLocaleString()} / {indexing.progress.total.toLocaleString()}</p>}{indexing && <p>整理在后台进行，可以切换到通用器件或返回画布。</p>}</div> : !page && error ? <div className="extension-library-empty"><strong>本地器件库暂时无法读取</strong><p className="local-device-error" role="alert">{error}</p><button type="button" onClick={retry}><RefreshCw size={15}/>重新读取</button></div> : <>
        <div className="local-device-card-grid">{page?.groups.map(group => {
          const selected = group.models.find(model => model.key === versions[group.id]) ?? group.models[0]
          if (!selected) return null
          const saved = projectModels.find(model => model.id.toLowerCase() === selected.id.toLowerCase())
          const source = preferredModelLibrary(selected.source)
          const incompatible=selected.profile?.electrical.engineReview?.status==='compatibility-error'
          return <article className="local-device-card" key={group.id} aria-label={`本地器件 ${selected.id}`}>
            <div className="local-device-card-top"><ModelSymbolGraphic model={selected} symbol={selected.symbol}/><div><strong>{group.id}</strong><span>{selected.categoryLabel}</span><small>{selected.profile?.device.manufacturer || selected.metadata.mfg || '原库未注明厂商'}{selected.id!==group.id&&` · ${selected.id}`}</small></div></div>
            <p className="local-device-symbol-note">{selected.symbolDescription}{incompatible&&<strong> · 仿真兼容需处理</strong>}</p>
            <p className="local-device-terminals" title={selected.terminalDescription}>{selected.terminalDescription}</p>
            <p className="local-device-source" title={selected.source.label}>模型来源：{selected.source.label}</p>
            <DeviceProfileDetails profile={selected.profile}/>
            <div className="local-device-card-bottom">{group.models.length > 1 ? <select disabled={!!placing} aria-label={`${selected.id} 模型库`} value={selected.key} onChange={event => setVersions(old => ({ ...old, [group.id]: event.target.value }))}>{group.models.map(model => <option key={model.key} value={model.key}>{sourceLabels[preferredModelLibrary(model.source)!] ?? '本地模型'} · {model.source.label}{model.key === group.models[0].key ? ' · 优先版本' : ''}</option>)}</select> : <small>{source ? sourceLabels[source] : '本地模型'}</small>}<button type="button" disabled={!onImportAndPlace || !!placing || incompatible} onClick={() => void place(selected)} aria-label={`放置本地器件 ${selected.id}`}>{placing === selected.key ? <LoaderCircle size={14} className="local-device-spinner"/> : <Plus size={14}/>}放置</button></div>
            {saved && <div className="local-device-saved"><small>工程已保存模型</small><button type="button" disabled={!onImportAndPlace || !!placing} onClick={() => void place(saved)} aria-label={`放置工程模型 ${saved.id}`}>沿用工程模型</button></div>}
          </article>
        })}</div>
        {!page?.groups.length && <div className="extension-library-empty"><Search size={25}/><strong>没有匹配的本地器件</strong><p>{selectedLeaf ? '当前搜索和来源下没有已确认属于此子分类的模型；可选择全部大类或清除筛选。' : '换一个型号、分类或来源试试。'}</p><button type="button" onClick={resetFilters}>查看全部本地器件</button></div>}
        <div className="local-device-pagination"><span>{total ? `${page!.offset + 1}–${Math.min(page!.offset + page!.groups.length, total)} / ${total.toLocaleString()} 个型号` : '0 个型号'}</span><div><button type="button" aria-label="上一页" disabled={!page || page.offset === 0 || !!placing} onClick={() => onStateChange({ ...state, offset: Math.max(0, page!.offset - page!.limit) })}><ArrowLeft size={15}/></button><span>{currentPage} / {totalPages}</span><button type="button" aria-label="下一页" disabled={!page || page.offset + page.limit >= total || !!placing} onClick={() => onStateChange({ ...state, offset: page!.offset + page!.limit })}><ArrowRight size={15}/></button></div></div>
      </>}
    </div>
  </div>
}
