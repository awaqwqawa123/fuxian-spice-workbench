import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatSI } from '../core/circuit'
import type { Result } from '../core/results'
import type { WaveformDomain, WaveformSignal } from '../core/waveform-workspace'
import { analyzeWaveform, fftCsv, waveformMeasurementsCsv, type FftResult, type WaveformMeasurementResult } from '../core/waveform-analysis'
import { defaultWaveformAnalysisSettings, parseWaveformAnalysisSettings, resolveWaveformAnalysisRange, type WaveformAnalysisSettings } from '../core/waveform-analysis-settings'
import type { WaveformFftReply, WaveformFftTask } from '../core/waveform-fft-task'
import { SpectrumPlot } from './WaveformAnalysisTools'

export interface PageWaveformAnalysisRequest { sequence: number; kind: 'measure' | 'fft'; range: WaveformDomain; signalId?: string }
interface Props {
  result: Result; signals: WaveformSignal[]; initialSettings?: WaveformAnalysisSettings
  onSettingsChange?: (settings: WaveformAnalysisSettings) => void
  visibleRange?: WaveformDomain; request?: PageWaveformAnalysisRequest; active?: boolean
  exportContext?: { groupName?: string; profileName?: string; stale?: boolean; status?: string }
}
type Tab = 'measure' | 'range' | 'events' | 'fft' | 'display' | 'spectrum' | 'harmonics' | 'notes'
const optional = (value: string) => value.trim() ? Number(value) : undefined
const csvCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function PageWaveformAnalysis({ result, signals, initialSettings, onSettingsChange, visibleRange, request, active = true, exportContext }: Props) {
  const choices = useMemo(() => signals.filter(signal => signal.kind !== 'noise' && signal.kind !== 'transfer'), [signals])
  const [settings, setSettings] = useState<WaveformAnalysisSettings>(() => initialSettings ?? defaultWaveformAnalysisSettings(choices.find(signal => signal.kind === 'voltage')?.id ?? choices[0]?.id))
  const saved = JSON.stringify(initialSettings), incoming = useRef(saved), onChange = useRef(onSettingsChange)
  onChange.current = onSettingsChange
  useEffect(() => {
    if (incoming.current !== saved) {
      incoming.current = saved
      if (initialSettings) setSettings(initialSettings)
    }
  }, [saved, initialSettings])
  const change = (next: WaveformAnalysisSettings) => {
    setSettings(next)
    try { const clean = parseWaveformAnalysisSettings(next); incoming.current = JSON.stringify(clean); onChange.current?.(clean) } catch { /* Incomplete edits stay local; only valid settings are persisted. */ }
  }
  const [tab, setTab] = useState<Tab>('measure'), [page, setPage] = useState(0)
  const panel = useRef<HTMLElement>(null)
  const [rowsPerPage, setRowsPerPage] = useState(4)
  const [paneHeight, setPaneHeight] = useState(500)
  useEffect(() => {
    const element = panel.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const update = () => { setPaneHeight(element.clientHeight); setRowsPerPage(Math.max(1, Math.min(4, Math.floor((element.clientHeight - 200) / 34)))) }
    update()
    const observer = new ResizeObserver(update); observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const switchTab = (value: Tab) => { setTab(value); setPage(0) }
  const processedRequest = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!request || request.sequence === processedRequest.current) return
    processedRequest.current = request.sequence
    const next: WaveformAnalysisSettings = { ...settings, rangeMode: 'fixed', fixedRange: [...request.range], ...(request.signalId ? { signalId: request.signalId } : {}) }
    incoming.current = JSON.stringify(next); setSettings(next); onChange.current?.(next)
    setTab(request.kind === 'fft' ? 'fft' : 'measure'); setPage(0)
  }, [request, settings])
  const signal = choices.find(item => item.id === settings.signalId)
  const isTran = result.analysis === 'tran', supported = isTran || result.analysis === 'dc'
  const validation = useMemo<{ range?: [number, number]; error?: string }>(() => {
    if (!active || !supported) return {}
    try {
      parseWaveformAnalysisSettings(settings)
      if (!signal) throw new Error('所选测量曲线不在当前运行中；请选择当前运行的曲线。')
      if (settings.events.referenceSignalId && !choices.some(item => item.id === settings.events.referenceSignalId)) throw new Error('所选参考曲线不在当前运行中；请重新选择参考曲线。')
      return { range: resolveWaveformAnalysisRange(settings, result.x, visibleRange) }
    } catch (error) { return { error: (error as Error).message } }
  }, [active, supported, settings, signal, choices, result.x, visibleRange])
  const measured = useMemo<{ data?: WaveformMeasurementResult; error?: string }>(() => {
    if (!active || !validation.range || !signal || !['measure', 'events', 'notes'].includes(tab)) return {}
    try { return { data: analyzeWaveform(result, signal, { ...settings.events, start: validation.range[0], end: validation.range[1], referenceSignal: choices.find(item => item.id === settings.events.referenceSignalId) }) } }
    catch (error) { return { error: (error as Error).message } }
  }, [active, validation.range, signal, tab, result, settings.events, choices])
  const [spectrum, setSpectrum] = useState<{ data?: FftResult; error?: string }>({}), [busy, setBusy] = useState(false)
  const worker = useRef<Worker | null>(null), sequence = useRef(0)
  const cancel = useCallback(() => { sequence.current++; worker.current?.terminate(); worker.current = null; setBusy(false) }, [])
  const calculationKey = JSON.stringify([result.id, settings.signalId, settings.rangeMode, validation.range, settings.fft.samples, settings.fft.window, settings.fft.fundamental])
  useEffect(() => { cancel(); setSpectrum({}); return cancel }, [calculationKey, cancel])
  useEffect(() => { if (!active) cancel() }, [active, cancel])
  const calculate = () => {
    cancel()
    if (!isTran || !signal || !validation.range || validation.error) return
    const job = ++sequence.current, resultId = result.id
    setBusy(true); setSpectrum({})
    try {
      const taskWorker = new Worker(new URL('../workers/waveform-analysis.worker.ts', import.meta.url), { type: 'module' })
      worker.current = taskWorker
      taskWorker.onmessage = (event: MessageEvent<WaveformFftReply>) => {
        if (sequence.current !== job || event.data.sequence !== job || event.data.resultId !== resultId) return
        taskWorker.terminate(); worker.current = null; setBusy(false); setSpectrum(event.data)
        if (event.data.data) switchTab('spectrum')
      }
      taskWorker.onerror = () => {
        if (sequence.current !== job) return
        taskWorker.terminate(); worker.current = null; setBusy(false); setSpectrum({ error: '频谱计算失败，请重新计算。' })
      }
      const task: WaveformFftTask = { sequence: job, resultId, analysis: result.analysis, x: result.x, signal, options: { start: validation.range[0], end: validation.range[1], samples: settings.fft.samples, window: settings.fft.window, fundamental: settings.fft.fundamental } }
      taskWorker.postMessage(task)
    } catch (error) { worker.current?.terminate(); worker.current = null; setBusy(false); setSpectrum({ error: (error as Error).message }) }
  }
  const metadata = (text: string, algorithm: string) => {
    const entries = { resultId: result.id, timestamp: new Date(result.timestamp).toISOString(), solver: result.engine, analysis: result.analysis, group: exportContext?.groupName, profile: exportContext?.profileName, status: exportContext?.status ?? 'completed', stale: exportContext?.stale ?? false, signalId: settings.signalId, signalName: signal?.name, rangeStart: validation.range?.[0], rangeEnd: validation.range?.[1], axisUnit: isTran ? 's' : 'V', algorithm }
    return Object.entries(entries).map(([key, value]) => `${csvCell(key)},${csvCell(value)}`).join('\r\n') + '\r\n\r\n' + text
  }
  const navigation = (pages: number) => <div className="page-list-navigation"><button disabled={page <= 0} onClick={() => setPage(value => value - 1)}>上一页</button><span>{Math.min(page + 1, pages)} / {pages}</span><button disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>下一页</button></div>
  const eventField = (key: 'lowLevel' | 'highLevel' | 'threshold' | 'referenceThreshold' | 'initialLevel' | 'finalLevel', label: string, placeholder?: string) => <label>{label}<input aria-label={label} type="number" step="any" placeholder={placeholder} value={settings.events[key] ?? ''} onChange={event => change({ ...settings, events: { ...settings.events, [key]: optional(event.target.value) } })} /></label>
  const notes = ['跃迁采用首次完整 10%–90% 事件；过冲使用初始和稳态电平。', ...(measured.data?.warnings ?? []), ...(spectrum.data?.warnings ?? [])], records = measured.data?.records ?? [], harmonics = spectrum.data?.thd?.harmonics ?? []
  const dataPage = Math.min(page, Math.max(0, Math.ceil(records.length / rowsPerPage) - 1)), harmonicPage = Math.min(page, Math.max(0, Math.ceil(harmonics.length / rowsPerPage) - 1))
  const compact = paneHeight < 300
  const notesPerPage = compact ? 1 : 2
  const tabValues = ['measure', 'range', 'events', 'fft', 'display', 'spectrum', 'harmonics', 'notes'] as const
  const tabNames = ['统计测量', '测量范围', '跃迁设置', '频谱设置', '频谱显示', 'FFT', '谐波', '说明']
  return <section ref={panel} className="page-analysis-tools" aria-label="自动测量与频谱分析" data-analysis-run={result.id} data-analysis-page={tab} data-analysis-range={validation.range?.join(',')}>
    {compact ? <label className="page-analysis-page-picker">分析工具<select aria-label="分析工具页面" value={tab} onChange={event=>switchTab(event.target.value as Tab)}>{tabValues.map((value,index)=><option key={value} value={value} disabled={!['measure','range','notes'].includes(value)&&!isTran}>{tabNames[index]}</option>)}</select></label> : <nav className="page-analysis-tabs" aria-label="分析工具页面">{tabValues.map((value, index) => <button key={value} disabled={!['measure', 'range', 'notes'].includes(value) && !isTran} aria-pressed={tab === value} onClick={() => switchTab(value)}>{tabNames[index]}</button>)}</nav>}
    {!supported ? <p>自动测量适用于瞬态波形和直流扫描；FFT 适用于瞬态波形。</p> : <>
      {tab === 'range' && <><div className="page-analysis-fields"><label>测量曲线<select aria-label="自动测量曲线" value={settings.signalId ?? ''} onChange={event => change({ ...settings, signalId: event.target.value })}>{!signal && <option value={settings.signalId ?? ''}>所选曲线已缺失</option>}{choices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>测量范围<select aria-label="测量范围" value={settings.rangeMode} onChange={event => change({ ...settings, rangeMode: event.target.value as WaveformAnalysisSettings['rangeMode'], ...(event.target.value === 'fixed' && !settings.fixedRange ? { fixedRange: visibleRange ? [...visibleRange] : [result.x[0], result.x.at(-1)!] } : {}) })}><option value="visible">当前可见区间</option><option value="full">完整运行</option><option value="fixed">固定区间</option></select></label></div>
      <div className="page-analysis-range" data-analysis-range={validation.range?.join(',')}>{([0, 1] as const).map(index => <label key={index}>{index ? '区间结束' : '区间开始'} ({isTran ? 's' : 'V'})<input aria-label={index ? '测量区间结束' : '测量区间开始'} type="number" step="any" disabled={settings.rangeMode !== 'fixed'} value={(settings.rangeMode === 'fixed' ? settings.fixedRange?.[index] : validation.range?.[index]) ?? ''} onChange={event => { const fixedRange: [number, number] = [...(settings.fixedRange ?? validation.range ?? [result.x[0], result.x.at(-1)!])]; fixedRange[index] = event.target.value === '' ? NaN : Number(event.target.value); change({ ...settings, fixedRange }) }} /></label>)}</div></>}
      {(validation.error || measured.error) && <p role="alert">{validation.error ?? measured.error}</p>}
      {tab === 'measure' && measured.data && <><table><thead><tr><th>测量项目</th><th>数值</th></tr></thead><tbody>{records.slice(dataPage * rowsPerPage, (dataPage + 1) * rowsPerPage).map(record => <tr key={record.id}><td>{record.name}</td><td>{record.value === null ? record.reason : formatSI(record.value, record.unit, 5)}</td></tr>)}</tbody></table><div className="page-inline-actions"><button onClick={() => change({ ...settings, rangeMode: 'full' })}>完整区间</button><button onClick={() => download('waveform-measurements.csv', metadata(waveformMeasurementsCsv(measured.data!), 'piecewise-linear original-sample integration'))}>导出测量 CSV</button></div>{navigation(Math.max(1, Math.ceil(records.length / rowsPerPage)))}</>}
      {tab === 'events' && <><div className="page-analysis-fields">{page === 0 ? <>{eventField('lowLevel', '低电平', '默认区间最小值')}{eventField('highLevel', '高电平', '默认区间最大值')}{eventField('threshold', '当前曲线阈值')}<label>过阈值方向<select value={settings.events.direction} onChange={event => change({ ...settings, events: { ...settings.events, direction: event.target.value as 'rising' | 'falling' } })}><option value="rising">上升</option><option value="falling">下降</option></select></label></> : <><label>延迟参考曲线<select value={settings.events.referenceSignalId ?? ''} onChange={event => change({ ...settings, events: { ...settings.events, referenceSignalId: event.target.value || undefined } })}><option value="">请选择</option>{choices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{eventField('referenceThreshold', '参考阈值')}{eventField('initialLevel', '过冲初始电平')}{eventField('finalLevel', '过冲稳态电平')}</>}</div>{!compact&&<p>跃迁采用首次完整 10%–90% 事件；过冲使用初始和稳态电平。</p>}{navigation(2)}</>}
      {['fft', 'display', 'spectrum', 'harmonics'].includes(tab) && <>
        {tab === 'fft' && <div className="page-analysis-fields"><label>FFT 点数<select aria-label="FFT 点数" value={settings.fft.samples} onChange={event => change({ ...settings, fft: { ...settings.fft, samples: Number(event.target.value) } })}>{[64,128,256,512,1024,2048,4096,8192,16384,32768,65536].map(value => <option key={value}>{value}</option>)}</select></label><label>窗函数<select aria-label="窗函数" value={settings.fft.window} onChange={event => change({ ...settings, fft: { ...settings.fft, window: event.target.value as 'hann' | 'rectangular' } })}><option value="hann">Hann</option><option value="rectangular">矩形</option></select></label><label>THD 基波频率 (Hz)<input aria-label="THD 基波频率" type="number" step="any" value={settings.fft.fundamental ?? ''} onChange={event => change({ ...settings, fft: { ...settings.fft, fundamental: optional(event.target.value) } })} /></label></div>}
        {tab === 'display' && <div className="page-analysis-fields">{([0, 1] as const).map(index => <label key={index}>显示频率{index ? '结束' : '开始'} (Hz)<input type="number" step="any" value={settings.fft.frequencyRange?.[index] ?? ''} onChange={event => { const frequencyRange: [number, number] = [...(settings.fft.frequencyRange ?? [0, spectrum.data?.nyquist ?? settings.fft.samples / (2 * ((validation.range?.[1] ?? 1) - (validation.range?.[0] ?? 0)))])]; frequencyRange[index] = event.target.value === '' ? NaN : Number(event.target.value); change({ ...settings, fft: { ...settings.fft, frequencyRange } }) }} /></label>)}</div>}
        {(tab === 'fft' || tab === 'display' || !compact && tab === 'spectrum') && <div className="page-inline-actions"><button disabled={busy || !active || !validation.range || !!validation.error} onClick={calculate}>计算 FFT</button>{busy && <><span role="status">正在计算频谱…</span><button onClick={cancel}>取消计算</button></>}</div>}
        {spectrum.error && <p role="alert">{spectrum.error}</p>}
        {!spectrum.data && !busy && !spectrum.error && <p>修改曲线、区间或计算参数后，请点击“计算 FFT”。</p>}
        {spectrum.data && <>{tab === 'spectrum' && <SpectrumPlot spectrum={spectrum.data} start={settings.fft.frequencyRange?.[0]} end={settings.fft.frequencyRange?.[1]} />}{tab === 'harmonics' && <><p>THD：{spectrum.data.thd?.percent == null ? spectrum.data.thd?.reason ?? '请在频谱设置中填写基波频率' : `${spectrum.data.thd.percent.toPrecision(5)} %`}</p><table><thead><tr><th>谐波</th><th>频率</th><th>幅度</th></tr></thead><tbody>{harmonics.slice(harmonicPage * rowsPerPage, (harmonicPage + 1) * rowsPerPage).map(item => <tr key={item.order}><td>{item.order}</td><td>{formatSI(item.frequency, 'Hz', 4)}</td><td>{formatSI(item.amplitude, spectrum.data!.unit, 4)}</td></tr>)}</tbody></table>{navigation(Math.max(1, Math.ceil(harmonics.length / rowsPerPage)))}</>}{tab === 'spectrum' && <><p>分辨率 {formatSI(spectrum.data.resolution, 'Hz', 4)} · Nyquist 上限 {formatSI(spectrum.data.nyquist, 'Hz', 4)}</p><button onClick={() => download('waveform-spectrum.csv', metadata(fftCsv(spectrum.data!), `FFT;${spectrum.data!.window};samples=${spectrum.data!.samples};linear resampling;single-sided peak`))}>导出完整频谱 CSV</button></>}</>}
      </>}
      {tab === 'notes' && <><p>统计使用原始采样与线性插值。FFT 重采样不能补回未保存的细节；增加点数不会改善同一区间的频率分辨率。</p>{notes.slice(page * notesPerPage, (page + 1) * notesPerPage).map((note, index) => <p key={index} role="status">{note}</p>)}{!notes.length && <p>当前计算无额外警告。</p>}{navigation(Math.max(1, Math.ceil(notes.length / notesPerPage)))}</>}
    </>}
  </section>
}
