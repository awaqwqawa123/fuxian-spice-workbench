import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, ExternalLink, FileCheck2, FileSearch, Search } from 'lucide-react'
import type { ModelDownloadPreview, ModelSearchCandidate, ModelSearchResults, ModelSearchSourceStatus } from '../core/model-search'
import { acquiredModelMatches } from '../core/model-download-sources'
import type { DatasheetCandidate, DatasheetDownload, DatasheetSearchResults } from '../core/datasheet-search'
import DatasheetModelBuilder from './DatasheetModelBuilder'
import type { ImportedModelKind, ImportedSpiceModel } from '../core/spice-models'
import ModelReview from './ModelReview'
import type { ModelTaskReference } from '../core/model-tasks'

export interface ModelSearchProps { models: ImportedSpiceModel[]; selectedKind?: ImportedModelKind; onImport: (model: ImportedSpiceModel) => void; initialQuery?: string; droppedFile?: { file: File; requestId: number }; /** A stable requestId starts one automatic search for this explicit part while mounted. */ autoQuery?: { part: string; requestId: string }; /** Called before the automatic request so its start can be persisted across reloads. */ onAutoStart?: (requestId: string) => void; onUseAssistant?: (part: string, reference?: ModelTaskReference) => void; /** Legacy compatibility; acquisition never dispatches to chat. */ onAiSearch?: (query: string) => void }
interface LcscProductEvidence { url: string; mpn: string; brand: string; sku: string; exactPart: boolean; datasheetUrl?: string; detail: string }
function hasMatchingSubcircuit(preview: ModelDownloadPreview | undefined, query: string) { return Boolean(preview?.diagnostics.some(item => item.model?.toLowerCase() === query.trim().toLowerCase() && /subckt|子电路/i.test(item.message))) }
function filenameMatchNote(query: string, fileName: string) {
  const part = query.trim().replace(/[^a-z0-9]/gi, '').toUpperCase()
  const name = fileName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/gi, '').toUpperCase()
  return part && !name.includes(part) ? '文件名未证明与所搜订货型号完全一致，请核对 PDF 订货表与封装。' : ''
}
function exactModelCandidate(item: ModelSearchCandidate, query: string) {
  return item.match === 'exact' || item.match === undefined && item.matchedModels.some(name => name.toLowerCase() === query.toLowerCase())
}
function automaticDatasheetCandidate(candidates: DatasheetCandidate[], query: string) {
  const sought = query.replace(/[^a-z0-9]/gi, '').toUpperCase()
  if (sought.length < 2) return undefined
  const exact = candidates.filter(item => {
    try {
      const stem = decodeURIComponent(new URL(item.url).pathname.split('/').at(-1) ?? '').replace(/\.[^.]+$/, '').toUpperCase()
      return stem.split(/[^A-Z0-9]+/).includes(sought)
    } catch { return false }
  })
  return exact.length === 1 ? exact[0] : undefined
}
type StepState = 'waiting' | 'running' | 'completed' | 'failed'
interface Step { title: string; state: StepState; detail: string }
const newSteps = (): Step[] => [
  { title: '核对器件与模型来源', state: 'waiting', detail: '查询模型库、器件目录和公开网页来源' },
  { title: '下载所选源码', state: 'waiting', detail: '选择结果后获取真实模型文件' },
  { title: '检查兼容性', state: 'waiting', detail: '检查精确型号、模型类型和可导入参数' },
]
const searchSites = [
  { id: 'semiee', name: '半导小芯 Semiee', home: 'https://www.semiee.com/' },
  { id: 'lcsc', name: '立创商城 LCSC', home: 'https://www.szlcsc.com/' },
  { id: 'jlc', name: 'JLCPCB 器件目录', home: 'https://jlcpcb.com/parts' },
  { id: 'google', name: 'Google 搜索', home: 'https://www.google.com/' },
  { id: 'alldatasheet', name: 'AllDataSheet', home: 'https://www.alldatasheet.com/' },
] as const
function siteLink(site: typeof searchSites[number], status: ModelSearchSourceStatus | undefined, query: string) {
  const fallback = query.trim() ? site.id === 'lcsc' ? `https://so.szlcsc.com/global.html?k=${encodeURIComponent(query.trim())}` : site.id === 'jlc' ? `https://jlcpcb.com/parts/componentSearch?isSearch=true&searchTxt=${encodeURIComponent(query.trim())}` : site.id === 'google' ? `https://www.google.com/search?q=${encodeURIComponent(query.trim() + ' SPICE model datasheet')}` : site.id === 'alldatasheet' ? `https://www.alldatasheet.com/view.jsp?Searchword=${encodeURIComponent(query.trim())}` : `https://www.semiee.com/search?searchModel=${encodeURIComponent(query.trim())}` : site.home
  try {
    const url = new URL(status?.searchUrl ?? fallback)
    const hosts = site.id === 'semiee' ? ['semiee.com', 'www.semiee.com'] : site.id === 'lcsc' ? ['www.szlcsc.com', 'szlcsc.com', 'so.szlcsc.com'] : site.id === 'jlc' ? ['jlcpcb.com', 'www.jlcpcb.com'] : site.id === 'google' ? ['www.google.com', 'google.com'] : ['www.alldatasheet.com', 'alldatasheet.com']
    return url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password && !url.port && !url.hash ? url.href : fallback
  } catch { return fallback }
}
function safeEvidenceUrl(raw: string) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || /^(?:localhost|.*\.local|.*\.internal)$/i.test(url.hostname) || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) || url.hostname.includes(':')) return undefined
    return url.href
  } catch { return undefined }
}
const sourceStateLabel = { searched: '已检索', restricted: '自动访问受限', unavailable: '暂不可用' } as const
export default function ModelSearch({ models, selectedKind, onImport, initialQuery, droppedFile, autoQuery, onAutoStart, onUseAssistant }: ModelSearchProps) {
  const [query, setQuery] = useState(initialQuery?.trim() ?? ''), [mode, setMode] = useState<'online' | 'datasheet'>('online')
  const [results, setResults] = useState<ModelSearchResults>(), [preview, setPreview] = useState<ModelDownloadPreview>(), [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [steps, setSteps] = useState<Step[]>(newSteps)
  const [datasheets, setDatasheets] = useState<DatasheetSearchResults>(), [downloaded, setDownloaded] = useState<DatasheetDownload>(), [downloadUrl, setDownloadUrl] = useState('')
  const [lcscProductUrl, setLcscProductUrl] = useState(''), [lcscProduct, setLcscProduct] = useState<LcscProductEvidence>()
  const [fallbackDismissed, setFallbackDismissed] = useState(false)
  const [fallbackReason, setFallbackReason] = useState(''), [autoDraft, setAutoDraft] = useState(false)
  const [queryRevision, setQueryRevision] = useState(0)
  const [activeDrop, setActiveDrop] = useState<{ file: File; requestId: number; queryRevision: number }>()
  const request = useRef<AbortController | undefined>(undefined), requestVersion = useRef(0), lastAutoRequest = useRef(''), lastInitialQuery = useRef(initialQuery?.trim() ?? '')
  useEffect(() => () => { requestVersion.current++; request.current?.abort() }, [])
  useEffect(() => {
    const part = initialQuery?.trim() ?? ''
    if (part === lastInitialQuery.current) return
    lastInitialQuery.current = part
    // Returning from the assistant can supply the part that was entered here.
    // Keep that part's loaded document and review draft instead of remounting it.
    if (part.toUpperCase() === query.trim().toUpperCase()) return
    requestVersion.current++; request.current?.abort()
    setQuery(part); setMode('online'); setBusy(''); setError(''); setNotice(''); setResults(undefined); setPreview(undefined); setDatasheets(undefined); setDownloaded(undefined); setDownloadUrl(''); setLcscProduct(undefined); setFallbackReason(''); setAutoDraft(false); setSteps(newSteps()); setQueryRevision(value => value + 1)
  }, [initialQuery])
  useEffect(() => {
    const part = autoQuery?.part.trim(), requestId = autoQuery?.requestId
    if (!part || !requestId || requestId === lastAutoRequest.current) return
    lastAutoRequest.current = requestId
    setQuery(part); setMode('online'); setDownloaded(undefined); setDatasheets(undefined); setDownloadUrl(''); setLcscProduct(undefined); setQueryRevision(value => value + 1)
    if (part.length < 2 || part.length > 48 || !/^[A-Za-z0-9][A-Za-z0-9._/+()-]*$/.test(part)) {
      requestVersion.current++; request.current?.abort(); setBusy(''); setResults(undefined); setPreview(undefined)
      setError('请先确认完整器件型号，再搜索模型或规格书。')
      return
    }
    onAutoStart?.(requestId)
    void search(part)
  }, [autoQuery?.part, autoQuery?.requestId])
  useEffect(() => {
    if (!droppedFile) return
    requestVersion.current++; request.current?.abort()
    setBusy(''); setDownloaded(undefined); setAutoDraft(false); setNotice('')
    setActiveDrop({ ...droppedFile, queryRevision }); setMode('datasheet')
  }, [droppedFile?.requestId])
  const previewModels = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return [...(preview?.models ?? [])].sort((a, b) => Number(b.id.toLowerCase() === needle) - Number(a.id.toLowerCase() === needle))
  }, [preview, query])
  const current = previewModels.find(item => item.id === selected) ?? previewModels[0]
  const noExactModel = preview ? !preview.models.some(model => acquiredModelMatches(model.id,[query.trim()],preview.source)) : Boolean(results && !results.candidates.some(item => item.match === 'exact' || item.match === undefined && item.matchedModels.some(name => name.toLowerCase() === query.trim().toLowerCase())))
  const exactSubcircuit = hasMatchingSubcircuit(preview, query)
  const restrictedSources = results?.sourceStatuses?.filter(item => item.state === 'restricted').length ?? 0
  function step(index: number, state: StepState, detail: string) { setSteps(previous => previous.map((item, i) => i === index ? { ...item, state, detail } : item)) }
  async function post<T,>(path: string, body: object): Promise<T> {
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    let response: Response
    try { response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal }) }
    catch (error) { if ((error as Error).name === 'AbortError') throw error; throw new Error('无法连接本机模型服务；请确认工作台服务正在运行，然后重试') }
    let value: T & { error?: string }
    try { value = await response.json() } catch { throw new Error('模型服务未响应，请重启工作台服务后重试') }
    if (!response.ok) throw new Error(value.error ?? '模型请求失败')
    return value
  }
  async function fallbackToDatasheet(version: number, searchedQuery: string, reason: string) {
    if (version !== requestVersion.current) return
    setMode('datasheet'); setFallbackReason(reason); setDatasheets(undefined); setAutoDraft(false)
    setBusy('未找到准确可导入模型，正在查找厂商规格书…')
    try {
      const found = await post<DatasheetSearchResults>('/api/model-library/datasheet/search', { query: searchedQuery })
      if (version !== requestVersion.current) return
      setDatasheets(found)
      const candidate = automaticDatasheetCandidate(found.candidates, searchedQuery)
      if (!candidate) {
        setFallbackReason(`${reason} ${found.candidates.length ? '规格书候选不能唯一证明完整型号，请核对后手动选择；同系列 PDF 不会自动下载。' : '公开搜索未找到可自动下载的厂商规格书。可粘贴 PDF 链接或选择本地文件。'}`)
        return
      }
      setBusy(`正在下载 ${candidate.manufacturer} 的规格书…`)
      const file = await post<DatasheetDownload>('/api/model-library/datasheet/download', { id: candidate.id })
      if (version !== requestVersion.current) return
      setDownloaded({ ...file, id: `${file.id}:${version}` }); setAutoDraft(true)
      setFallbackReason(`${reason} 已下载文件名匹配的厂商规格书；请核对下方正文、器件类型与建模结果。`)
      setNotice(`已下载 ${file.fileName}（${Math.ceil(file.byteLength / 1024)} KB）；正在本机提取参数。`)
    } catch (failure) {
      if (version !== requestVersion.current || (failure as Error).name === 'AbortError') return
      setFallbackReason(`${reason} 自动查找或下载规格书失败：${(failure as Error).message}。可粘贴厂商 PDF 链接或选择本地文件。`)
    } finally { if (version === requestVersion.current) setBusy('') }
  }
  async function search(input = query) {
    const version = ++requestVersion.current
    const searchedQuery = input.trim()
    setBusy('正在搜索器件模型…'); setError(''); setNotice(''); setPreview(undefined); setResults(undefined); setFallbackDismissed(false); setFallbackReason(''); setAutoDraft(false); setSteps(newSteps())
    step(0, 'running', '正在核对指定器件站点与可下载模型源码')
    try {
      const value = await post<ModelSearchResults>('/api/model-library/search', { query: searchedQuery }); if (version !== requestVersion.current) return
      setResults(value); step(0, 'completed', `${value.candidates.length} 个模型源码候选${value.coverage === 'partial' ? '；部分来源未完成' : ''}；未下载或修改工程`)
      const exact = value.candidates.filter(item => exactModelCandidate(item, searchedQuery))
      const failures: string[] = []
      for (const item of exact) {
        if (version !== requestVersion.current) return
        setBusy(`正在核验 ${item.name} 的实际 SPICE 定义…`)
        step(1, 'running', `下载并解析 ${item.name}`)
        try {
          const file = await post<ModelDownloadPreview>('/api/model-library/download', { id: item.id })
          if (version !== requestVersion.current) return
          const matching = file.models.find(model => model.id.toLowerCase() === searchedQuery.toLowerCase())
          if (matching) {
            setPreview(file); setSelected(matching.id)
            step(1, 'completed', `已核验 ${item.name} 的实际源码`)
            step(2, 'completed', '找到同名可导入模型，请审阅后导入工程')
            return
          }
          failures.push(`${item.name} 无同名兼容定义`)
        } catch (failure) {
          if ((failure as Error).name === 'AbortError' || version !== requestVersion.current) return
          failures.push(`${item.name} 下载失败`)
        }
      }
      step(1, exact.length ? 'completed' : 'waiting', exact.length ? `已检查 ${exact.length} 份同名源码线索` : '未发现同名源码线索')
      step(2, 'failed', '未找到同名可导入定义；继续查找规格书')
      await fallbackToDatasheet(version, searchedQuery, `${exact.length ? `已核验 ${exact.length} 份同名源码线索（${failures.join('；')}），` : ''}没有找到 ${searchedQuery} 的准确可导入 SPICE 模型。`)
    } catch (error) { if (version === requestVersion.current && (error as Error).name !== 'AbortError') { setError((error as Error).message); step(0, 'failed', (error as Error).message) } }
    finally { if (version === requestVersion.current) setBusy('') }
  }
  async function download(item: ModelSearchCandidate) {
    const version = ++requestVersion.current
    setBusy(`正在获取 ${item.name}…`); setError(''); setNotice(''); setPreview(undefined); setFallbackDismissed(false)
    step(1, 'running', `${item.origin === 'local-library' ? '读取本地模型' : '下载模型'}：${item.name}`); step(2, 'waiting', '等待源码下载与解析')
    try {
      const value = await post<ModelDownloadPreview>('/api/model-library/download', { id: item.id }); if (version !== requestVersion.current) return
      setPreview(value); setSelected(value.models.find(model => model.id.toLowerCase() === query.trim().toLowerCase())?.id ?? value.models[0]?.id ?? '')
      step(1, 'completed', `${item.origin === 'local-library' ? '已读取' : '已下载'} ${item.name}，保留来源与完整源码`)
      const exact = value.models.some(model => model.id.toLowerCase() === query.trim().toLowerCase())
      const subcircuit = hasMatchingSubcircuit(value, query)
      step(2, exact ? 'completed' : 'failed', `${value.models.length} 个可导入模型；${exact ? '找到同名兼容模型，请审阅后导入' : subcircuit ? '找到同名 .subckt，但兼容检查未通过；请查看源码、端口和诊断' : '当前文件没有同名可导入模型'}`)
      if (!exact) await fallbackToDatasheet(version, query.trim(), subcircuit ? '同名 .subckt 未通过兼容检查；请查看诊断，并继续查找规格书。' : `下载的 ${item.name} 没有 ${query.trim()} 的同名可导入模型。`)
    } catch (error) { if (version === requestVersion.current && (error as Error).name !== 'AbortError') { setError((error as Error).message); step(1, 'failed', (error as Error).message); await fallbackToDatasheet(version, query.trim(), `下载 ${item.name} 失败，尚未核实可导入模型。`) } }
    finally { if (version === requestVersion.current) setBusy('') }
  }
  function switchMode(value: 'online' | 'datasheet') {
    requestVersion.current++; request.current?.abort(); setBusy(''); setMode(value); setError(''); setNotice('')
    setSteps(previous => previous.map(item => item.state === 'running' ? { ...item, state: 'waiting', detail: '请求已取消，可重新执行' } : item))
  }
  async function searchDatasheets() {
    const version = ++requestVersion.current
    setMode('datasheet'); setBusy('正在联网搜索厂商规格书…'); setError(''); setNotice(''); setDatasheets(undefined)
    try { const result = await post<DatasheetSearchResults>('/api/model-library/datasheet/search', { query: query.trim() }); if (version === requestVersion.current) setDatasheets(result) }
    catch (error) { if (version === requestVersion.current && (error as Error).name !== 'AbortError') setError((error as Error).message) }
    finally { if (version === requestVersion.current) setBusy('') }
  }
  async function downloadDatasheet(input: { id: string } | { url: string }) {
    const version = ++requestVersion.current
    setBusy('正在下载规格书原文件…'); setError(''); setNotice(''); setFallbackReason(''); setAutoDraft(false)
    try {
      const result = await post<DatasheetDownload>('/api/model-library/datasheet/download', input); if (version !== requestVersion.current) return
      setDownloaded({ ...result, id: `${result.id}:${version}` }); setAutoDraft(true); setNotice(`已下载 ${result.fileName}（${Math.ceil(result.byteLength / 1024)} KB）；下方在本机提取参数，请核对文件内容。`)
    } catch (error) { if (version === requestVersion.current && (error as Error).name !== 'AbortError') setError((error as Error).message) }
    finally { if (version === requestVersion.current) setBusy('') }
  }
  async function inspectLcscProduct() {
    const version = ++requestVersion.current
    setBusy('正在核对立创商品页…'); setError(''); setNotice(''); setLcscProduct(undefined)
    try {
      const value = await post<LcscProductEvidence>('/api/model-library/lcsc/product', { url: lcscProductUrl.trim(), part: query.trim() })
      if (version === requestVersion.current) setLcscProduct(value)
    } catch (error) { if (version === requestVersion.current && (error as Error).name !== 'AbortError') setError((error as Error).message) }
    finally { if (version === requestVersion.current) setBusy('') }
  }
  function importModel(model: ImportedSpiceModel) {
    try { onImport(model); setNotice(`${model.id} 已导入工程模型库`); setError('') } catch (error) { setError((error as Error).message) }
  }
  return <section className="model-search" aria-label="查找与创建 SPICE 模型" onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation() }}>
    <header><FileSearch size={18}/><div><strong>添加建模资料</strong><p>查找厂商参考模型，或添加器件规格书</p></div></header>
    <div className="model-search-modes" role="group" aria-label="资料获取方式"><button type="button" aria-pressed={mode === 'online'} className={mode === 'online' ? 'active' : ''} onClick={() => switchMode('online')}><Search size={15}/>搜索模型</button><button type="button" aria-pressed={mode === 'datasheet'} className={mode === 'datasheet' ? 'active' : ''} onClick={() => switchMode('datasheet')}><FileCheck2 size={15}/>导入规格书</button></div>
    <label className="model-search-query">器件型号<input aria-label="搜索器件型号" placeholder="如 OPA2376、2N3904" maxLength={48} value={query} disabled={Boolean(busy)} onChange={event => { setQuery(event.target.value); setPreview(undefined); setResults(undefined); setNotice(''); setError(''); setDatasheets(undefined); setDownloaded(undefined); setDownloadUrl(''); setLcscProduct(undefined); setFallbackReason(''); setAutoDraft(false); setQueryRevision(value => value + 1); setSteps(newSteps()); setFallbackDismissed(false) }} onKeyDown={event => { if (event.key === 'Enter' && mode === 'online' && !busy && query.trim().length >= 2) { event.preventDefault(); void search() } }}/></label>
    <div id="model-search-datasheet" aria-label="导入规格书" hidden={mode !== 'datasheet'}>
      {fallbackReason && <><p className="model-search-auto-fallback" role="status"><FileCheck2 size={16}/><span>{fallbackReason}</span></p>{onUseAssistant && <button type="button" className="model-search-assistant-handoff" onClick={() => onUseAssistant(query.trim())}>交给模型助手继续查找</button>}</>}
      {activeDrop?.queryRevision===queryRevision && filenameMatchNote(query, activeDrop.file.name) && <p className="model-search-match-warning" role="status">{filenameMatchNote(query, activeDrop.file.name)} 当前型号：{query}；文件：{activeDrop.file.name}。请核对订货表后再建模。</p>}
      <DatasheetModelBuilder key={queryRevision} models={models} selectedKind={selectedKind} name={query} onName={setQuery} onImport={onImport} onUseAssistant={onUseAssistant} downloaded={downloaded} droppedFile={activeDrop?.queryRevision===queryRevision?activeDrop:undefined} autoDraft={autoDraft} onReadStatus={status => {
        setNotice(status.stage === 'reading' ? `正在读取「${status.fileName}」…` : status.stage === 'completed' ? `已读取「${status.fileName}」，可在模型需求中继续生成。` : `「${status.fileName}」解析失败。${status.retainedFileName ? `仍保留「${status.retainedFileName}」。` : '请查看下方错误说明。'}`)
      }}/>
      <section className="datasheet-online" aria-label="联网获取规格书">
        <strong>从网址添加资料</strong><p className="model-search-help">粘贴原厂规格书地址，读取后带回模型需求。</p>
        <label>PDF / TXT 原始地址<input type="url" aria-label="联网规格书原始下载地址" value={downloadUrl} maxLength={1800} placeholder="https://厂商网站/.../datasheet.pdf" onChange={event => setDownloadUrl(event.target.value)}/></label>
        <button type="button" className="model-search-primary" disabled={Boolean(busy) || !downloadUrl.trim()} onClick={() => void downloadDatasheet({ url: downloadUrl.trim() })}><Download size={14}/>下载并提取此链接</button>
        <details className="model-search-secondary" open={Boolean(datasheets || busy.includes('规格书'))}><summary>按型号查找规格书</summary><button type="button" disabled={Boolean(busy) || query.trim().length < 2} onClick={() => void searchDatasheets()}><Search size={14}/>联网查找规格书</button>
          {query.trim().length >= 2 && <a className="model-search-browser-link" href={`https://www.google.com/search?q=${encodeURIComponent(`${query.trim()} datasheet PDF`)}`} target="_blank" rel="noreferrer noopener">在浏览器搜索规格书 PDF <ExternalLink size={12}/></a>}
          {datasheets && <><p role="status">检索完成 · {datasheets.candidates.length} 份厂商候选规格书</p>{datasheets.notices.map(message => <p className="model-search-help" key={message}>{message}</p>)}<div className="model-search-results">{datasheets.candidates.map(item => <article key={item.id}><strong>{item.title}</strong><small>{item.manufacturer}</small>{'matchNote' in item && typeof item.matchNote === 'string' && <span className="model-search-match-note">{item.matchNote}</span>}<a href={item.url} target="_blank" rel="noreferrer">核对原始来源 <ExternalLink size={12}/></a><button type="button" disabled={Boolean(busy)} onClick={() => void downloadDatasheet({ id: item.id })}><Download size={14}/>下载并提取规格书</button></article>)}</div>{datasheets.sourceStatuses?.length ? <div className="model-search-sources-grid" aria-label="网页搜索来源">{datasheets.sourceStatuses.map(status => <article key={status.source} data-source={status.source} data-status={status.state}><div><strong>{status.label}</strong><span>{sourceStateLabel[status.state]}</span></div><p>{status.detail}</p>{status.results?.slice(0, 5).map(item => { const href = safeEvidenceUrl(item.url); return href ? <a key={href} href={href} target="_blank" rel="noreferrer noopener">{item.title} <ExternalLink size={12}/></a> : null })}<a href={siteLink(searchSites.find(site => site.id === status.source) ?? searchSites[2], status, query)} target="_blank" rel="noreferrer noopener">在{status.label}继续搜索 <ExternalLink size={12}/></a></article>)}</div> : null}</>}
        </details>
        <details className="model-search-secondary"><summary>从立创商品页提取规格书</summary>
          <p className="model-search-help">粘贴 item.szlcsc.com 的商品页网址。工作台会核对型号、厂家和公开 PDF 地址。</p>
          <label>立创商品页网址<input type="url" aria-label="立创商品页网址" value={lcscProductUrl} maxLength={300} placeholder="https://item.szlcsc.com/517186.html" onChange={event => { setLcscProductUrl(event.target.value); setLcscProduct(undefined) }}/></label>
          <button type="button" disabled={Boolean(busy) || query.trim().length < 2 || !lcscProductUrl.trim()} onClick={() => void inspectLcscProduct()}><FileCheck2 size={14}/>核对商品资料</button>
          {lcscProduct && <div className="model-search-lcsc-evidence"><strong>{lcscProduct.mpn} · {lcscProduct.brand || '厂商未标注'}</strong><small>立创编号 {lcscProduct.sku || '未标注'} · {lcscProduct.detail}</small><a href={lcscProduct.url} target="_blank" rel="noreferrer noopener">查看原始商品页 <ExternalLink size={12}/></a>{lcscProduct.exactPart && lcscProduct.datasheetUrl && <button type="button" disabled={Boolean(busy)} onClick={() => void downloadDatasheet({ url: lcscProduct.datasheetUrl! })}><Download size={14}/>下载 PDF 规格书</button>}</div>}
        </details>
      </section>
      {downloaded && filenameMatchNote(query, downloaded.fileName) && <p className="model-search-match-warning" role="status">{filenameMatchNote(query, downloaded.fileName)}</p>}
    </div>
    <div id="model-search-online" aria-label="搜索模型" hidden={mode !== 'online'}>
      <p className="model-search-intro">优先获取原厂模型；没有同名模型时，查找规格书作为调整厂商相似模型的依据。</p>
      <button type="button" className="model-search-primary model-search-action" disabled={Boolean(busy) || query.trim().length < 2} onClick={() => void search()}><Search size={15}/>搜索可下载模型</button>
      <details className="model-search-sources" aria-label="指定搜索来源">
        <summary>来源状态{restrictedSources ? ` · ${restrictedSources} 站自动访问受限` : ''}</summary>
        <div className="model-search-sources-heading"><strong>指定器件来源</strong><small>商品页、规格书与可导入 SPICE 模型分别核对</small></div>
        <div className="model-search-sources-grid">{searchSites.map(site => {
          const status = results?.sourceStatuses?.find(item => item.source === site.id)
          const state = status?.state ?? (results ? 'unreported' : 'waiting')
          return <article key={site.id} data-source={site.id} data-status={state}>
            <div><strong>{site.name}</strong><span>{status ? sourceStateLabel[status.state] : results ? '状态未报告' : busy ? '检索中' : '待检索'}</span></div>
            <p>{status?.detail ?? (results ? '本次搜索没有收到该站点的状态；请使用官方入口核对型号。' : '输入型号并搜索后显示站点结果及访问状态。')}</p>
            {status?.resultCount !== undefined && <small>站点线索 {status.resultCount} 条；仍需核对是否提供 SPICE 源码</small>}
            {status?.results?.slice(0, 5).map(item => { const href = safeEvidenceUrl(item.url); return href ? <a key={href} href={href} target="_blank" rel="noreferrer noopener">{item.title} <ExternalLink size={12}/></a> : null })}
            <a href={siteLink(site, status, query)} target="_blank" rel="noreferrer noopener">在{site.name}核对型号 <ExternalLink size={12}/></a>
          </article>
        })}</div>
        {restrictedSources > 0 && <p className="model-search-source-explainer">“自动访问受限”表示网站没有向工作台后台返回可读取的搜索结果，并不代表工作台断网或该型号没有资料。可到工作台设置 → 资料来源，在专用浏览器登录并检查连接；已登记的 SPICE 模型库和厂商 PDF 索引仍独立检索。浏览器下载的 .lib / .mod / .cir 可导入模型库，PDF 可拖入规格书区域。</p>}
      </details>
      {steps.some(item => item.state !== 'waiting') && <details className="model-acquisition-steps" aria-label="模型获取进度" open={Boolean(busy || steps.some(item => item.state === 'failed'))}><summary>检索与兼容性记录</summary><ol>{steps.map((item, index) => <li key={item.title} data-status={item.state}><span aria-hidden="true">{item.state === 'completed' ? <Check size={12}/> : index + 1}</span><div><strong>{item.title}</strong><small>{item.detail}</small></div><em>{({ waiting: '待执行', running: '进行中', completed: '已完成', failed: '失败' })[item.state]}</em></li>)}</ol></details>}
      {results && <><p className="model-search-count">补充模型库：{results.indexedFiles.toLocaleString()} 个索引文件 · {results.candidates.length} 个 SPICE 源码候选{results.coverage === 'partial' ? ' · 部分来源未完成' : ''}</p>{results.notices.map(message => <p className="model-search-help" key={message}>{message}</p>)}{results.candidates.length === 0 && <p className="model-search-empty">当前没有经过核对的可下载 SPICE 源码。站点页面或规格书可用于核对器件，但不能直接导入为仿真模型。</p>}<div className="model-search-results">{results.candidates.map(item => <article key={item.id}><strong>{item.name}</strong><small>{item.source.label}</small><span>{item.match === 'exact' || item.match === undefined && item.matchedModels.some(name => name.toLowerCase() === query.trim().toLowerCase()) ? '文件内有同名声明；仍需下载核对兼容性' : item.match === 'related' ? '相关来源或相近型号，仅供核对；不能视为电气等效' : '仅文件名匹配；需下载核对实际型号'}</span>{item.matchedModels.length > 0 && <small>声明：{item.matchedModels.join(' · ')}</small>}<button disabled={Boolean(busy)} onClick={() => void download(item)}><Download size={14}/>下载并预览</button></article>)}</div>{results.coverage === 'partial' && <button type="button" disabled={Boolean(busy)} onClick={() => void search()}>重试未完成的来源</button>}</>}
      {exactSubcircuit && <p className="model-search-error" role="status">已找到 {query} 的同名 .subckt，但此文件未通过兼容检查。请查看下方具体诊断，并核对符号、引脚顺序与依赖模型。</p>}
      {preview && <section className="model-search-preview" aria-label="下载模型预览"><strong>{preview.models.length} 个兼容模型</strong><p>{preview.source.license}</p><a href={preview.source.url} target="_blank" rel="noreferrer">原始模型与作者说明 <ExternalLink size={12}/></a>{preview.models.length > 0 && <><label>选择导入型号<select aria-label="选择下载模型" value={current?.id ?? ''} onChange={event => { setSelected(event.target.value); setNotice('') }}>{previewModels.map(model => <option key={model.id} value={model.id}>{model.id} · {model.type}</option>)}</select></label>{current && <ModelReview model={current} origin="downloaded" limitations={['已通过导入语法检查，尚未进行器件曲线与工作范围验证。']}>{current.id.toLowerCase() !== query.trim().toLowerCase() && <p className="model-search-help">此模型与搜索型号不同；请确认是否为可接受的替代器件。</p>}<button className="model-search-primary" disabled={models.some(model => model.id.toLowerCase() === current.id.toLowerCase())} onClick={() => importModel(current)}><Download size={14}/>{models.some(model => model.id.toLowerCase() === current.id.toLowerCase()) ? '工程中已有此型号' : '导入到工程'}</button></ModelReview>}</>}{preview.diagnostics.length > 0 && <details open={!preview.models.length}><summary>{preview.diagnostics.filter(item => item.severity === 'error').length} 项兼容问题 / {preview.diagnostics.length} 条检查记录</summary><ul>{preview.diagnostics.slice(0, 30).map((item, index) => <li key={index}>{item.model ? `${item.model}：` : ''}{item.message}</li>)}</ul>{preview.diagnostics.length > 30 && <small>仅展开前 30 条；原始文件完整保留。</small>}</details>}<button type="button" onClick={() => { const url = URL.createObjectURL(new Blob([preview.text], { type: 'text/plain;charset=utf-8' })), a = document.createElement('a'); a.href = url; a.download = `${query.replace(/[^a-z0-9_.-]/gi, '_') || 'model'}.lib`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }}><Download size={14}/>保存源码 .lib</button><details><summary>原始文件（保留作者与条款）</summary><pre>{preview.text}</pre></details>{!preview.models.length && <button onClick={() => switchMode('datasheet')}>使用规格书建模</button>}</section>}
      {noExactModel && !fallbackDismissed && <section className="model-search-fallback" aria-label="规格书导入提示"><span>{preview ? '当前文件没有同名兼容模型' : results?.coverage === 'partial' ? '尚未确认准确模型，部分来源不可用' : '可访问的模型库中没有同名声明；指定站点状态见上方'}。相近型号不能视为电气等效。</span><div><button type="button" disabled={Boolean(busy)} onClick={() => switchMode('datasheet')}>转到导入规格书</button>{onUseAssistant && <button type="button" disabled={!query.trim()} onClick={() => onUseAssistant(query.trim())}>交给模型助手继续查找</button>}<button type="button" onClick={() => setFallbackDismissed(true)}>收起</button></div></section>}
      <p className="model-search-help">支持标准 .model 和自包含、可由 ngspice 运行的 .subckt。多引脚子电路需核对端口顺序；加密内容、外部依赖和专有元件会显示兼容诊断。</p>
    </div>
    {busy && <p role="status" className="model-search-help">{busy}</p>}{error && <p role="alert" className="model-search-error">{error}</p>}{notice && <p role="status" className="model-search-notice">{notice}</p>}
  </section>
}
