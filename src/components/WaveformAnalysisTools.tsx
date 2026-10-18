import { useMemo, useState } from 'react'
import { formatSI } from '../core/circuit'
import { resultXAxisUnit, type Result } from '../core/results'
import { waveformSignals, type WaveformSignal } from '../core/waveform-workspace'
import { analyzeWaveform, defaultAnalysisSignal, fftCsv, fftWaveform, waveformMeasurementsCsv, type FftResult, type WaveformMeasurementResult } from '../core/waveform-analysis'

interface Props { result: Result; signals?: WaveformSignal[] }
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' })), link = document.createElement('a')
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
const optional = (value: string) => value.trim() ? Number(value) : undefined
function valueText(value: number, unit: string) { return unit === '%' ? `${value.toPrecision(5)} %` : formatSI(value, unit, 5) }

export default function WaveformAnalysisTools({ result, signals: provided }: Props) {
  // A new saved run gets its own range; prior tool calculations never replace solver data.
  return <Tools key={result.id} result={result} signals={provided}/>
}
function Tools({ result, signals: provided }: Props) {
  const signals = useMemo(() => (provided ?? waveformSignals(result).signals).filter(s => s.kind !== 'noise' && s.kind !== 'transfer'), [provided, result])
  const [selected, setSelected] = useState(defaultAnalysisSignal(result)?.id ?? signals[0]?.id ?? '')
  const signal = signals.find(s => s.id === selected) ?? signals[0]
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [low, setLow] = useState(''), [high, setHigh] = useState('')
  const [threshold, setThreshold] = useState(''), [direction, setDirection] = useState<'rising' | 'falling'>('rising')
  const [reference, setReference] = useState(''), [referenceThreshold, setReferenceThreshold] = useState('')
  const [initial, setInitial] = useState(''), [final, setFinal] = useState('')
  const [samples, setSamples] = useState(4096), [window, setWindow] = useState<'hann' | 'rectangular'>('hann'), [fundamental, setFundamental] = useState('')
  const [frequencyStart, setFrequencyStart] = useState(''), [frequencyEnd, setFrequencyEnd] = useState('')
  const [fftEnabled, setFftEnabled] = useState(false)
  const measured = useMemo<{ data?: WaveformMeasurementResult; error?: string }>(() => {
    try { return { data: analyzeWaveform(result, signal, { start: optional(start), end: optional(end), lowLevel: optional(low), highLevel: optional(high), threshold: optional(threshold), direction, initialLevel: optional(initial), finalLevel: optional(final), referenceSignal: signals.find(s => s.id === reference), referenceThreshold: optional(referenceThreshold) }) } }
    catch (error) { return { error: (error as Error).message } }
  }, [result, signal, start, end, low, high, threshold, direction, initial, final, signals, reference, referenceThreshold])
  const spectrum = useMemo<{ data?: FftResult; error?: string }>(() => {
    if (!fftEnabled || result.analysis !== 'tran') return {}
    try { return { data: fftWaveform(result, signal, { start: optional(start), end: optional(end), samples, window, fundamental: optional(fundamental) }) } }
    catch (error) { return { error: (error as Error).message } }
  }, [fftEnabled, result, signal, start, end, samples, window, fundamental])
  const isTran = result.analysis === 'tran', axisUnit = resultXAxisUnit(result)
  return <details className="wave-analysis-tools" aria-label="自动测量与频谱分析">
    <summary>自动测量与频谱分析 <small>平均值 · RMS · 跃迁时间 · FFT / THD</small></summary>
    {!isTran && result.analysis !== 'dc' ? <p>自动测量与 FFT 需要瞬态实数波形；直流扫描可计算区间统计值。当前为交流或噪声分析。</p> : <div className="wave-analysis-content">
      <div className="wave-analysis-fields">
        <label>测量曲线<select aria-label="自动测量曲线" value={signal?.id ?? ''} onChange={event => setSelected(event.target.value)}>{signals.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>区间开始 ({axisUnit})<input aria-label="测量区间开始" type="number" step="any" placeholder={String(Math.min(result.x[0],result.x.at(-1)!))} value={start} onChange={event => setStart(event.target.value)}/></label>
        <label>区间结束 ({axisUnit})<input aria-label="测量区间结束" type="number" step="any" placeholder={String(Math.max(result.x[0],result.x.at(-1)!))} value={end} onChange={event => setEnd(event.target.value)}/></label>
        <button type="button" onClick={() => { setStart(''); setEnd('') }}>恢复完整区间</button>
      </div>
      <p>数值输入支持科学计数法，例如 1e-3。平均值和 RMS 按区间长度加权，使用实际保存采样之间的线性插值。</p>
      {isTran && <details className="wave-analysis-event-settings"><summary>跃迁、阈值与延迟设置</summary><div className="wave-analysis-fields">
        <label>低电平<input aria-label="上升下降低电平" type="number" step="any" placeholder="默认区间最小值" value={low} onChange={e => setLow(e.target.value)}/></label>
        <label>高电平<input aria-label="上升下降高电平" type="number" step="any" placeholder="默认区间最大值" value={high} onChange={e => setHigh(e.target.value)}/></label>
        <label>当前曲线阈值<input aria-label="测量阈值" type="number" step="any" value={threshold} onChange={e => setThreshold(e.target.value)}/></label>
        <label>过阈值方向<select aria-label="阈值方向" value={direction} onChange={e => setDirection(e.target.value as 'rising' | 'falling')}><option value="rising">上升</option><option value="falling">下降</option></select></label>
        <label>延迟参考曲线<select aria-label="延迟参考曲线" value={reference} onChange={e => setReference(e.target.value)}><option value="">请选择</option>{signals.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>参考阈值<input aria-label="延迟参考阈值" type="number" step="any" value={referenceThreshold} onChange={e => setReferenceThreshold(e.target.value)}/></label>
        <label>过冲初始电平<input aria-label="过冲初始电平" type="number" step="any" value={initial} onChange={e => setInitial(e.target.value)}/></label>
        <label>过冲稳态电平<input aria-label="过冲稳态电平" type="number" step="any" value={final} onChange={e => setFinal(e.target.value)}/></label>
      </div><p>上升/下降时间采用首次完整 10%–90% 事件。延迟为当前曲线首次过阈值时刻减去参考曲线首次同方向过阈值时刻。过冲按指定初始/稳态电平计算首次跃迁，不自动猜测稳态。</p></details>}
      {measured.error && <p role="alert">{measured.error}</p>}
      {measured.data && <><div className="wave-analysis-table"><table><thead><tr><th>测量项目</th><th>数值</th></tr></thead><tbody>{measured.data.records.map(record => <tr key={record.id} data-measurement={record.id}><td>{record.name}</td><td>{record.value === null ? <span title={record.reason}>未能测量 · {record.reason}</span> : valueText(record.value, record.unit)}</td></tr>)}</tbody></table></div><button type="button" onClick={() => download('waveform-measurements.csv', waveformMeasurementsCsv(measured.data!))}>导出测量 CSV</button>{measured.data.warnings.map(warning => <p key={warning}>{warning}</p>)}</>}
      {isTran && <details className="wave-analysis-fft" onToggle={event => setFftEnabled(event.currentTarget.open)}><summary>FFT 频谱与谐波失真</summary>
        <div className="wave-analysis-fields">
          <label>FFT 点数<select aria-label="FFT 点数" value={samples} onChange={e => setSamples(Number(e.target.value))}>{[256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
          <label>窗函数<select aria-label="FFT 窗函数" value={window} onChange={e => setWindow(e.target.value as 'hann' | 'rectangular')}><option value="hann">Hann（适合一般波形）</option><option value="rectangular">矩形（适合完整周期）</option></select></label>
          <label>THD 基波频率 (Hz)<input aria-label="THD 基波频率" type="number" step="any" placeholder="留空仅计算频谱" value={fundamental} onChange={e => setFundamental(e.target.value)}/></label>
          <label>显示频率开始 (Hz)<input aria-label="FFT 显示频率开始" type="number" step="any" placeholder="0" value={frequencyStart} onChange={e => setFrequencyStart(e.target.value)}/></label>
          <label>显示频率结束 (Hz)<input aria-label="FFT 显示频率结束" type="number" step="any" placeholder={String(spectrum.data?.nyquist ?? '')} value={frequencyEnd} onChange={e => setFrequencyEnd(e.target.value)}/></label>
        </div>
        {spectrum.error && <p role="alert">{spectrum.error}</p>}
        {spectrum.data && <><p>频率分辨率 {formatSI(spectrum.data.resolution, 'Hz', 4)}；重采样 Nyquist 上限 {formatSI(spectrum.data.nyquist, 'Hz', 4)}；单边峰值幅度 {spectrum.data.unit}。</p><SpectrumPlot spectrum={spectrum.data} start={optional(frequencyStart)} end={optional(frequencyEnd)}/>
          {spectrum.data.thd && <div className="wave-analysis-thd"><strong>THD：{spectrum.data.thd.percent === null ? `未能测量 · ${spectrum.data.thd.reason}` : valueText(spectrum.data.thd.percent, '%')}</strong>{spectrum.data.thd.harmonics.length > 0 && <table><thead><tr><th>谐波次数</th><th>频率</th><th>峰值幅度</th></tr></thead><tbody><tr><td>1（基波）</td><td>{formatSI(spectrum.data.thd.fundamental, 'Hz', 4)}</td><td>{valueText(spectrum.data.thd.fundamentalAmplitude!, spectrum.data.unit)}</td></tr>{spectrum.data.thd.harmonics.map(h => <tr key={h.order}><td>{h.order}</td><td>{formatSI(h.frequency, 'Hz', 4)}</td><td>{valueText(h.amplitude, spectrum.data!.unit)}</td></tr>)}</tbody></table>}</div>}
          <button type="button" onClick={() => download('waveform-spectrum.csv', fftCsv(spectrum.data!))}>导出完整频谱 CSV</button>{spectrum.data.warnings.map(warning => <p key={warning}>{warning}</p>)}
        </>}
      </details>}
    </div>}
  </details>
}

export function SpectrumPlot({ spectrum, start = 0, end = spectrum.nyquist }: { spectrum: FftResult; start?: number; end?: number }) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > spectrum.nyquist || start >= end) return <p role="alert">显示频率须在 0 至 Nyquist 上限内，结束值应大于开始值。</p>
  const bins = spectrum.frequencies.flatMap((f, i) => f >= start && f <= end ? [{ f, a: spectrum.amplitudes[i] }] : [])
  if (!bins.length) return <p>此显示区间没有频谱采样点；请扩大区间。</p>
  const max = bins.reduce((peak, b) => Math.max(peak, b.a), 0) || 1, width = 620, height = 200
  // Preserve the peak in each screen pixel, including narrow harmonics.
  const groups = new Map<number, { f: number; a: number }>()
  for (const bin of bins) { const pixel = Math.floor((bin.f - start) / (end - start) * width); if (!groups.has(pixel) || groups.get(pixel)!.a < bin.a) groups.set(pixel, bin) }
  const path = [...groups.values()].map((bin, i) => `${i === 0 ? 'M' : 'L'}${60 + (bin.f - start) / (end - start) * width},${220 - bin.a / max * height}`).join(' ')
  return <svg className="wave-analysis-spectrum" viewBox="0 0 720 265" role="img" aria-label={`${spectrum.signalName} FFT 单边幅度频谱`}>
    <path d="M60,20V220H680" fill="none" stroke="currentColor" opacity=".5"/>
    {[0, .25, .5, .75, 1].map(f => <g key={f}><line x1={60 + width * f} x2={60 + width * f} y1="220" y2="225" stroke="currentColor"/><text x={60 + width * f} y="242" textAnchor="middle">{formatSI(start + (end - start) * f, 'Hz', 3)}</text></g>)}
    <text x="55" y="26" textAnchor="end">{formatSI(max, spectrum.unit, 3)}</text><text x="55" y="222" textAnchor="end">0</text>
    <path d={path} fill="none" stroke="#47b8e0" strokeWidth="1.5"/><text x="380" y="260" textAnchor="middle">频率 (Hz) · 幅度 ({spectrum.unit})</text>
  </svg>
}
