import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { Activity, ArrowLeft, ChartNoAxesCombined, ChevronLeft, ChevronRight, Download, FileText, LoaderCircle, Pin, Play, Ruler, Settings2, SlidersHorizontal, X } from 'lucide-react'
import { analysisSignals, formatSI } from '../core/circuit'
import { compatibleResults, toCsv, type Result } from '../core/results'
import { simulationNames } from '../core/simulation-profiles'
import { analyzeWaveform } from '../core/waveform-analysis'
import { waveformSignals, type WaveformSignal, type WaveformDomain } from '../core/waveform-workspace'
import type CanvasWaveformResults from './CanvasWaveformResults'
import WaveformWorkspace, { type WaveformSnapshot, type WaveformFitRequest, type WaveformInspectionState, type WaveformExportApi } from './WaveformWorkspace'
import PageWaveformAnalysis from './PageWaveformAnalysis'
import { simulationFeedback } from '../core/simulation-feedback'
import type { WaveformAnalysisSettings } from '../core/waveform-analysis-settings'

type Props = ComponentProps<typeof CanvasWaveformResults> & {
  deviceSummary?: ReactNode
  onSettings: () => void
  interrupted?: boolean
  active?: boolean
  fitRequest?: WaveformFitRequest
  showRequest?: number
  onSignalSelect?: (signal: WaveformSignal) => void
}

function download(result: Result, title: string) {
  const url = URL.createObjectURL(new Blob(['\uFEFF' + toCsv(result)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = `${title || 'waveform'}.csv`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A mounted result view belongs to the page; changing groups keeps each saved view intact. */
export default function EmbeddedWaveformResults({ diagram, visible, profiles, result, history, running, busy, progress, failure, stale, interrupted,
  measurements, selectedMeasurement, probeRequests, inspectRequest, onSelectMeasurement, onPatch, onSnapshot, onRun,
  onCopy, onRemove, canAdd, deviceSummary, onSettings, active = visible, fitRequest, showRequest, onSignalSelect }: Props) {
  const [comparison, setComparison] = useState<Result | null>(null)
  const region=useRef<HTMLElement>(null)
  const [tightHeight,setTightHeight]=useState(false),[showParameters,setShowParameters]=useState(false)
  useEffect(()=>{
    const element=region.current;if(!element)return
    const update=()=>{if(element.clientHeight>0)setTightHeight(element.clientHeight<520)}
    update();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(update);observer?.observe(element)
    return()=>observer?.disconnect()
  },[])
  const [overlaySweep, setOverlaySweep] = useState(false)
  const [page, setPage] = useState(0)
  const [toolPage, setToolPage] = useState<'view' | 'setup' | 'log' | 'analysis'>('view')
  const [inspection, setInspection] = useState<WaveformInspectionState | null>(null)
  const [analysisRequest, setAnalysisRequest] = useState<{ sequence: number; kind: 'measure' | 'fft'; range: WaveformDomain; signalId?: string }>()
  const requestSequence = useRef(0)
  const exporter = useRef<WaveformExportApi | null>(null)
  const [exportAvailable, setExportAvailable] = useState(false)
  const [exportBusy, setExportBusy] = useState(false), [exportError, setExportError] = useState('')
  const exportReady = useCallback((api: WaveformExportApi | null) => { exporter.current = api; setExportAvailable(!!api) }, [])
  const inspect = useCallback((value: WaveformInspectionState) => setInspection(old => old && old.resultId === value.resultId && old.panelIndex === value.panelIndex && old.signal?.id === value.signal?.id && old.domain[0] === value.domain[0] && old.domain[1] === value.domain[1] && old.lensRange?.[0] === value.lensRange?.[0] && old.lensRange?.[1] === value.lensRange?.[1] ? old : value), [])
  const settingsChange = useCallback((value: WaveformAnalysisSettings) => onPatch(diagram.id, { analysisSettings: value }), [diagram.id, onPatch])
  const savedRange = useMemo<WaveformDomain | undefined>(() => {
    if (!result?.x.length) return undefined
    const min = result.x[0], max = result.x.at(-1)!, domain = diagram.view?.domain ?? [0, 1]
    if (result.analysis === 'ac' || result.analysis === 'noise') return domain.map(value => 10 ** (Math.log10(min) + (Math.log10(max) - Math.log10(min)) * value)) as unknown as WaveformDomain
    return [min + (max - min) * domain[0], min + (max - min) * domain[1]]
  }, [result, diagram.view?.domain])
  const range = inspection && inspection.resultId === result?.id ? inspection.lensRange ?? inspection.domain : savedRange
  function analyzeSelection(kind: 'measure' | 'fft') { if (range) { setAnalysisRequest({ sequence: ++requestSequence.current, kind, range, signalId: inspection?.signal?.id }); setToolPage('analysis') } }
  async function exportView(format: 'svg' | 'png' | 'csv') {
    if (exportBusy) return
    if (!exporter.current) { setExportError('请先返回波形绘图页，再导出当前视图。'); return }
    setExportBusy(true); setExportError('')
    try { const value = await exporter.current.exportCurrent(format); const url = URL.createObjectURL(value.blob), link = document.createElement('a'); link.href = url; link.download = value.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
    catch (error) { setExportError((error as Error).message) }
    finally { setExportBusy(false) }
  }
  const profile = profiles.find(item => item.id === diagram.profileId)
  const matchedComparison = result && comparison && compatibleResults(result, comparison) ? comparison : null
  const snapshot = useCallback((value: WaveformSnapshot) => onSnapshot(diagram.id, value), [diagram.id, onSnapshot])
  const view = useCallback<NonNullable<ComponentProps<typeof WaveformWorkspace>['onViewChange']>>(value => onPatch(diagram.id, { view: value }), [diagram.id, onPatch])
  const cachedSignals = useRef<WaveformSignal[]>([])
  const expressions = diagram.view?.panels[diagram.view.activePanel ?? 0]?.expressions
  const expressionsKey = JSON.stringify(expressions)
  const signals = useMemo(() => { if (active && result) cachedSignals.current = waveformSignals(result, measurements, expressions).signals; return cachedSignals.current }, [active, result, measurements, expressionsKey])
  const primary = signals.find(signal => signal.id === (inspection?.resultId === result?.id ? inspection?.signal?.id : undefined))
    ?? signals.find(signal => signal.id === diagram.view?.panels[diagram.view.activePanel ?? 0]?.primary)
    ?? signals.find(signal => signal.id.toLowerCase() === `voltage:v(${result ? analysisSignals(result.project).outputNode : ''})`.toLowerCase())
    ?? signals.find(signal => signal.kind === 'voltage')
  const summary = useMemo(() => {
    if (!active || !result || !primary || !range || !['tran', 'dc'].includes(result.analysis)) return null
    try { return analyzeWaveform(result, primary, { start: range[0], end: range[1] }) } catch { return null }
  }, [active, result, primary, range?.[0], range?.[1]])
  const records = result?.analysis === 'op' ? Object.entries(result.voltages ?? {}) : []
  const pages = Math.max(1, Math.ceil(records.length / 6))
  const logLines = result ? [...result.warnings, ...result.log.split(/\r?\n/)].filter(Boolean).flatMap(line => line.match(/.{1,60}/gu) ?? []) : []
  const logPages = Math.max(1, Math.ceil(logLines.length / 8))
  useEffect(() => setPage(0), [result?.id, toolPage])
  useEffect(() => { if (inspectRequest) setToolPage('view') }, [inspectRequest?.sequence])
  useEffect(() => { if (fitRequest) setToolPage('view') }, [fitRequest?.sequence])
  useEffect(() => { if (showRequest) setToolPage('view') }, [showRequest])
  const feedback=simulationFeedback({result,running,progress,failure,stale,interrupted})
  const source=result?`${profile?.name===simulationNames[result.analysis]?'':simulationNames[result.analysis]+' · '}${new Date(result.timestamp).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})} · ${result.engine}`:''
  return <section ref={region} className="page-waveform-results" data-page-waveform={diagram.id} data-waveform-settings={diagram.id} data-result-state={feedback.state} data-result-id={result?.id} data-compact-height={tightHeight||undefined} hidden={!visible} aria-label="页面波形与测量">
    <header className="page-result-toolbar">
      <div className="page-result-caption"><strong title={diagram.title}>{diagram.title || '波形'}</strong><span title={`${profile?.name??'配置已删除'}${source?' · '+source:''}`}>{profile?.name ?? '配置已删除'}{result&&<span className="page-result-source"> · {source}</span>}</span></div>
      <button type="button" className="wave-icon-button" title="修改当前图组的仿真配置" aria-label="设置当前波形仿真配置" aria-haspopup="dialog" onClick={onSettings}><Settings2 size={16} /></button>
      {deviceSummary&&tightHeight&&<button type="button" className="wave-icon-button" title="当前器件参数" aria-label="当前器件参数" aria-expanded={showParameters} aria-controls={`page-device-${diagram.id}`} onClick={()=>setShowParameters(value=>!value)}><SlidersHorizontal size={16}/></button>}
      <button type="button" className="wave-icon-button" title={running ? '运行中' : '运行当前图组配置'} aria-label={running ? '运行中' : '运行'} disabled={busy || !profile} onClick={onRun}>{running ? <LoaderCircle size={16} className="wave-icon-loading"/> : <Play size={16} />}</button>
      <label className="wave-icon-select" data-disabled={!result || exportBusy || undefined} title={exportAvailable?"导出当前图与所选曲线":"返回波形页可导出图片与所选曲线"}>
        {exportBusy ? <LoaderCircle size={16} className="wave-icon-loading" aria-hidden="true"/> : <Download size={16} aria-hidden="true"/>}
        <select aria-label="导出当前波形" disabled={!result || exportBusy} value="" onChange={event => { const value = event.target.value; if (value === 'raw') result && download(result, diagram.title); else if (value) void exportView(value as 'svg' | 'png' | 'csv') }}><option value="">{exportBusy ? '正在导出' : '导出'}</option><option value="svg" disabled={!exportAvailable}>当前图 SVG</option><option value="png" disabled={!exportAvailable}>当前图 PNG</option><option value="csv" disabled={!exportAvailable}>可见曲线 CSV</option><option value="raw">基础结果 CSV</option></select>
      </label>
    </header>
    {deviceSummary&&<div className="page-device-summary" id={`page-device-${diagram.id}`} hidden={tightHeight&&!showParameters}>{deviceSummary}</div>}
    <nav className="page-result-tabs" aria-label="结果工具">
      <button type="button" className="wave-icon-button" title="波形" aria-label="波形" aria-pressed={toolPage === 'view'} onClick={() => setToolPage('view')}><Activity size={16}/></button>
      <button type="button" className="wave-icon-button" title="图组与对比" aria-label="图组与对比" aria-pressed={toolPage === 'setup'} onClick={() => setToolPage('setup')}><ChartNoAxesCombined size={16}/></button>
      <button type="button" className="wave-icon-button" title="自动测量" aria-label="自动测量" aria-pressed={toolPage === 'analysis'} disabled={!result} onClick={() => setToolPage('analysis')}><Ruler size={16}/></button>
      <button type="button" className="wave-icon-button" title="运行日志" aria-label="运行日志" aria-pressed={toolPage === 'log'} onClick={() => setToolPage('log')}><FileText size={16}/></button>
      <span className={`page-result-state${['failed','stale','interrupted','recovered','warning'].includes(feedback.state)?' is-warning':''}`} title={feedback.detail} role="status">{feedback.label}{result&&` · ${result.points.toLocaleString()} 点`}</span>
    </nav>
    {toolPage !== 'view' && <div className="page-return-toolbar"><button className="wave-icon-button" aria-label="返回波形" title="返回波形" onClick={() => setToolPage('view')}><ArrowLeft size={16}/></button><span>{toolPage === 'setup' ? '图组管理与对比' : toolPage === 'analysis' ? '自动测量与频谱' : '运行日志'}</span></div>}
    {exportError && <p className="page-export-error" role="alert">{exportError}</p>}
    <div className="page-result-content" hidden={toolPage !== 'view'}>
      {result ? result.analysis === 'op' ? <div className="page-op-results"><h3>直流工作点</h3><table><thead><tr><th>对象</th><th>电压</th></tr></thead><tbody>{records.slice(Math.min(page, pages - 1) * 6, (Math.min(page, pages - 1) + 1) * 6).map(([name, values]) => <tr key={name}><td>{name}</td><td>{formatSI(values[0], 'V', 6)}</td></tr>)}</tbody></table><div className="page-list-navigation"><button disabled={page <= 0} onClick={() => setPage(value => value - 1)} aria-label="上一页工作点"><ChevronLeft size={14} /></button><span>{Math.min(page + 1, pages)} / {pages} · {records.length} 个节点</span><button disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)} aria-label="下一页工作点"><ChevronRight size={14} /></button></div></div>
        : <WaveformWorkspace embedded active={active && toolPage === 'view'} fitRequest={fitRequest} showRequest={showRequest} onInspectionChange={inspect} onSignalSelect={onSignalSelect} onExportReady={exportReady} exportContext={{ groupName: diagram.title, profileName: profile?.name, stale, status: failure ? '运行失败，保留旧结果' : stale ? '结果已过期' : '当前结果' }} result={result} comparison={matchedComparison} sweepComparisons={overlaySweep ? result.sweepResults : undefined}
          measurements={measurements} selectedMeasurement={visible ? selectedMeasurement : undefined} onSelectMeasurement={onSelectMeasurement}
          probeRequests={probeRequests} inspectRequest={inspectRequest} initialView={diagram.view} onViewChange={view} onSnapshot={snapshot} />
        : <div className="page-waveform-empty"><strong>{running ? '正在仿真' : failure ? '仿真未完成' : '波形区域已就绪'}</strong><p>{failure || (running ? progress : '运行当前配置，曲线会直接显示在这里。')}</p><button disabled={busy || !profile} onClick={onRun}>运行此配置</button></div>}
    </div>
    <div className="page-result-analysis" hidden={toolPage !== 'analysis'}>{result && <PageWaveformAnalysis exportContext={{groupName:diagram.title,profileName:profile?.name,stale,status:failure?'运行失败，保留旧结果':stale?'结果已过期':'当前结果'}} active={active && toolPage === 'analysis'} result={result} signals={signals} initialSettings={diagram.analysisSettings} onSettingsChange={settingsChange} visibleRange={range} request={analysisRequest} />}</div>
    <div className="page-result-setup" hidden={toolPage !== 'setup'}>
      <label>图组名称<input aria-label="波形图名称" maxLength={80} value={diagram.title} onChange={event => onPatch(diagram.id, { title: event.target.value })} /></label>
      <label>仿真配置<select aria-label="波形图仿真配置" value={diagram.profileId} onChange={event => onPatch(diagram.id, { profileId: event.target.value, resultId: undefined, view: undefined })}>{!profile && <option value={diagram.profileId}>原配置已删除</option>}{profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>显示结果<select aria-label="波形图显示结果" value={diagram.resultId ?? ''} onChange={event => onPatch(diagram.id, { resultId: event.target.value || undefined })}><option value="">最新运行</option>{history.map(item => <option key={item.id} value={item.id}>{new Date(item.timestamp).toLocaleTimeString('zh-CN')} · {item.sweepLabel ?? simulationNames[item.analysis]}</option>)}{diagram.resultId && !history.some(item => item.id === diagram.resultId) && <option value={diagram.resultId}>历史运行不在当前会话中</option>}</select></label>
      <div className="page-inline-actions"><button disabled={!result || result.analysis === 'op'} onClick={() => result && setComparison(result)}><Pin size={13} />固定对比</button>{comparison && <button onClick={() => setComparison(null)}><X size={13} />移除对比</button>}</div>
      {comparison && <p>{new Date(comparison.timestamp).toLocaleTimeString('zh-CN')} · {matchedComparison ? '虚线为固定对比结果' : '分析类型不兼容，保留对比引用'}</p>}
      {!!result?.sweepResults?.length && <label className="page-inline-check"><input type="checkbox" checked={overlaySweep} onChange={event => setOverlaySweep(event.target.checked)} />叠加参数扫描曲线</label>}
      <div className="page-inline-actions"><button disabled={!canAdd} onClick={onCopy}>复制图组</button><button onClick={onRemove}>删除图组</button></div>
    </div>
    <div className="page-result-log" hidden={toolPage !== 'log'}><h3>本次运行日志</h3><pre>{logLines.slice(Math.min(page, logPages - 1) * 8, (Math.min(page, logPages - 1) + 1) * 8).join('\n') || failure || '尚无运行日志。'}</pre><div className="page-list-navigation"><button disabled={page <= 0} onClick={() => setPage(value => value - 1)} aria-label="上一页运行日志"><ChevronLeft size={14} /></button><span>{Math.min(page + 1, logPages)} / {logPages} · {logLines.length} 行</span><button disabled={page + 1 >= logPages} onClick={() => setPage(value => value + 1)} aria-label="下一页运行日志"><ChevronRight size={14} /></button></div></div>
    <footer className="page-measurement-summary" hidden={toolPage !== 'view'} aria-label="关键测量读数">
      {range && <span data-measurement-range={`${range[0]},${range[1]}`}>可见区间 {formatSI(range[0], result?.analysis === 'tran' ? 's' : result?.analysis === 'dc' ? 'V' : 'Hz', 4)}–{formatSI(range[1], result?.analysis === 'tran' ? 's' : result?.analysis === 'dc' ? 'V' : 'Hz', 4)}</span>}
      {summary ? <><strong>{primary?.name}</strong>{!tightHeight&&summary.records.filter(record => ['rms', 'peakToPeak', 'mean'].includes(record.id)).map(record => <span key={record.id}>{record.name} <b>{record.value === null ? '未测得' : formatSI(record.value, record.unit, 5)}</b></span>)}</> : <span>{result?.analysis === 'ac' ? '频率范围与 A/B 游标在绘图区同步' : '运行后显示关键测量读数'}</span>}
      {result && ['tran', 'dc'].includes(result.analysis) && <button onClick={() => analyzeSelection('measure')}>测量此区间</button>}{result?.analysis === 'tran' && <button onClick={() => analyzeSelection('fft')}>区间 FFT</button>}
    </footer>
  </section>
}
