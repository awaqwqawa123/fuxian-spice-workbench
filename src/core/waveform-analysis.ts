import { analysisSignals } from './circuit'
import { resultXAxisUnit, type Result } from './results'
import { waveformSignals, type WaveformSignal } from './waveform-workspace'

export interface WaveformMeasurementOptions {
  start?: number; end?: number; lowLevel?: number; highLevel?: number
  threshold?: number; direction?: 'rising' | 'falling'
  initialLevel?: number; finalLevel?: number
  referenceSignal?: WaveformSignal; referenceThreshold?: number
}
export interface WaveformMeasurementRecord { id: string; name: string; value: number | null; unit: string; source: string; reason?: string }
export interface WaveformMeasurementResult {
  signalId: string; signalName: string; unit: string; start: number; end: number
  records: WaveformMeasurementRecord[]; warnings: string[]
}
export interface FftOptions { start?: number; end?: number; samples?: number; window?: 'hann' | 'rectangular'; fundamental?: number }
export interface FftResult {
  signalId: string; signalName: string; unit: string; start: number; end: number; samples: number
  window: 'hann' | 'rectangular'; sampleRate: number; resolution: number; nyquist: number
  frequencies: number[]; amplitudes: number[]; warnings: string[]
  thd: { percent: number | null; fundamental: number; fundamentalAmplitude?: number; harmonics: { order: number; frequency: number; amplitude: number }[]; reason?: string } | null
}

export function defaultAnalysisSignal(result: Result): WaveformSignal | undefined {
  const signals = waveformSignals(result).signals
  const output = `voltage:v(${analysisSignals(result.project).outputNode})`.toLowerCase()
  return signals.find(s => s.id.toLowerCase() === output) ?? signals.find(s => s.kind === 'voltage') ?? signals[0]
}
const unitOf = (signal: WaveformSignal) => (signal as WaveformSignal & { unit?: string }).unit ?? (signal.kind === 'current' ? 'A' : 'V')

function series(result: Result, signal: WaveformSignal | undefined, options: { start?: number; end?: number }) {
  if (result.analysis !== 'tran' && result.analysis !== 'dc') throw new Error('自动测量仅适用于瞬态或直流扫描的实数波形；交流与噪声结果请使用对应分析。')
  if (!signal || signal.kind === 'noise' || signal.kind === 'transfer') throw new Error('请选择已保存的实数电压、电流或表达式曲线。')
  const x = result.x, y = signal.values, direction=x.length>1&&x.at(-1)!<x[0]?-1:1
  if (x.length < 2 || y.length !== x.length || x.some((v, i) => !Number.isFinite(v) || i > 0 && (v-x[i-1])*direction<=0) || y.some(v => !Number.isFinite(v))) throw new Error('波形必须包含至少两个有限、按坐标严格单调的有效采样点。')
  const low=Math.min(x[0],x.at(-1)!),high=Math.max(x[0],x.at(-1)!)
  const start = options.start ?? low, end = options.end ?? high
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < low || end > high || start >= end) throw new Error('测量区间必须在已保存的波形内，且结束值大于开始值。')
  const sx = [start], sy = [interpolate(x, y, start)]
  // Integrate in coordinate order without changing the original scan order.
  for (let n = 0; n < x.length; n++) {const i=direction===1?n:x.length-1-n;if (x[i] > start && x[i] < end) { sx.push(x[i]); sy.push(y[i]) }}
  sx.push(end); sy.push(interpolate(x, y, end))
  return { x: sx, y: sy, start, end, signal, unit: unitOf(signal) }
}
export function interpolate(x: readonly number[], y: readonly number[], at: number): number {
  let lo = 0, hi = x.length - 1
  const direction=x.length>1&&x.at(-1)!<x[0]?-1:1
  while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if ((x[mid]-at)*direction>0) hi = mid; else lo = mid }
  const fraction = (at - x[lo]) / (x[hi] - x[lo])
  return y[lo] + fraction * (y[hi] - y[lo])
}
function crossing(x: number[], y: number[], level: number, direction: 'rising' | 'falling', after = -Infinity): number | null {
  if (!Number.isFinite(level)) return null
  for (let i = 1; i < x.length; i++) {
    const crosses = direction === 'rising' ? y[i - 1] < level && y[i] >= level || y[i - 1] === level && y[i] > level : y[i - 1] > level && y[i] <= level || y[i - 1] === level && y[i] < level
    if (crosses) { const t = x[i - 1] + (level - y[i - 1]) / (y[i] - y[i - 1]) * (x[i] - x[i - 1]); if (t >= after) return t }
  }
  return null
}

/** Integrate the actual piecewise-linear samples, including interpolated window boundaries. */
export function analyzeWaveform(result: Result, signal = defaultAnalysisSignal(result), options: WaveformMeasurementOptions = {}): WaveformMeasurementResult {
  for (const value of [options.lowLevel, options.highLevel, options.threshold, options.referenceThreshold, options.initialLevel, options.finalLevel]) if (value !== undefined && !Number.isFinite(value)) throw new Error('电平和阈值必须为有限数值。')
  if (options.lowLevel !== undefined && options.highLevel !== undefined && options.highLevel <= options.lowLevel) throw new Error('高电平必须大于低电平。')
  const s = series(result, signal, options), { x, y, start, end, unit } = s
  let min = Infinity, max = -Infinity, integral = 0, squared = 0
  for (const value of y) { min = Math.min(min, value); max = Math.max(max, value) }
  for (let i = 1; i < x.length; i++) { const dt = x[i] - x[i - 1], a = y[i - 1], b = y[i]; integral += dt * (a + b) / 2; squared += dt * (a * a + a * b + b * b) / 3 }
  const source = `${s.signal.name}；${start}–${end} ${resultXAxisUnit(result)}；保存采样点的分段线性积分`
  const records: WaveformMeasurementRecord[] = [], warnings: string[] = []
  const add = (id: string, name: string, value: number | null, u = unit, reason?: string) => records.push({ id, name, value, unit: u, source, ...(value === null ? { reason: reason ?? '区间内未找到完整事件' } : {}) })
  add('min', '最小值', min); add('max', '最大值', max); add('mean', '平均值', integral / (end - start)); add('rms', 'RMS', Math.sqrt(Math.max(0, squared / (end - start)))); add('peakToPeak', '峰峰值', max - min)
  if (result.analysis === 'tran') {
    const low = options.lowLevel ?? min, high = options.highLevel ?? max, valid = Number.isFinite(low) && Number.isFinite(high) && high > low
    const l10 = low + .1 * (high - low), l90 = low + .9 * (high - low)
    const r10 = valid ? crossing(x, y, l10, 'rising') : null, r90 = r10 !== null ? crossing(x, y, l90, 'rising', r10) : null
    const f90 = valid ? crossing(x, y, l90, 'falling') : null, f10 = f90 !== null ? crossing(x, y, l10, 'falling', f90) : null
    add('riseTime', '首次上升时间（10%→90%）', r10 !== null && r90 !== null ? r90 - r10 : null, 's')
    add('fallTime', '首次下降时间（90%→10%）', f90 !== null && f10 !== null ? f10 - f90 : null, 's')
    warnings.push(`上升/下降电平：${low}–${high} ${unit}；未指定时采用区间最小/最大值。`)
    const direction = options.direction ?? 'rising'
    const t = options.threshold !== undefined ? crossing(x, y, options.threshold, direction) : null
    add('crossing', `首次${direction === 'rising' ? '上升' : '下降'}过阈值时刻`, t, 's', options.threshold === undefined ? '请指定阈值' : undefined)
    let delay: number | null = null, delayReason = '请选择参考曲线并指定两条曲线的阈值'
    if (options.referenceSignal && options.referenceThreshold !== undefined && t !== null) {
      const reference = series(result, options.referenceSignal, { start, end }), rt = crossing(reference.x, reference.y, options.referenceThreshold, direction)
      if (rt !== null) { delay = t - rt; delayReason = '' }
      else delayReason = '参考曲线未找到阈值事件'
    }
    add('delay', '首次阈值延迟（当前−参考）', delay, 's', delayReason)
    const initial = options.initialLevel, final = options.finalLevel
    let overshoot: number | null = null
    if (initial !== undefined && final !== undefined && Number.isFinite(initial) && Number.isFinite(final) && final !== initial) {
      const step = final - initial, t90 = crossing(x, y, initial + .9 * step, step > 0 ? 'rising' : 'falling')
      if (t90 !== null) {
        let peak = 0
        for (let i = 0; i < x.length; i++) if (x[i] >= t90) { const excursion = (y[i] - final) / step; peak = Math.max(peak, excursion); if (excursion < -.1 && x[i] > t90) break }
        overshoot = peak * 100
      }
    }
    add('overshoot', '首次跃迁过冲', overshoot, '%', '请指定不同的初始/稳态电平，且区间需包含完整的 90% 跃迁')
  }
  return { signalId: s.signal.id, signalName: s.signal.name, unit, start, end, records, warnings }
}

function fft(real: Float64Array, imag: Float64Array) {
  const n = real.length
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; while (j & bit) { j ^= bit; bit >>= 1 } j ^= bit; if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]] } }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len, wr = Math.cos(angle), wi = Math.sin(angle)
    for (let start = 0; start < n; start += len) { let cr = 1, ci = 0
      for (let j = 0; j < len / 2; j++) { const a = start + j, b = a + len / 2, tr = cr * real[b] - ci * imag[b], ti = cr * imag[b] + ci * real[b]; real[b] = real[a] - tr; imag[b] = imag[a] - ti; real[a] += tr; imag[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr }
    }
  }
}

/** Simultaneous sine/cosine fit avoids mistaking non-coherent-bin leakage for harmonics. */
function harmonicFit(samples: Float64Array, fundamental: number, sampleRate: number, orders: number): number[] | null {
  const count = orders * 2 + 1, matrix = Array.from({ length: count }, () => new Float64Array(count + 1)), basis = new Float64Array(count)
  for (let i = 0; i < samples.length; i++) {
    basis[0] = 1
    for (let order = 1; order <= orders; order++) { const phase = 2 * Math.PI * fundamental * order * i / sampleRate; basis[2 * order - 1] = Math.cos(phase); basis[2 * order] = Math.sin(phase) }
    for (let row = 0; row < count; row++) { for (let col = row; col < count; col++) matrix[row][col] += basis[row] * basis[col]; matrix[row][count] += basis[row] * samples[i] }
  }
  for (let row = 0; row < count; row++) for (let col = 0; col < row; col++) matrix[row][col] = matrix[col][row]
  for (let col = 0; col < count; col++) {
    let pivot = col; for (let row = col + 1; row < count; row++) if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row
    if (Math.abs(matrix[pivot][col]) < 1e-9) return null
    ;[matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]]
    const divisor = matrix[col][col]; for (let j = col; j <= count; j++) matrix[col][j] /= divisor
    for (let row = 0; row < count; row++) if (row !== col) { const factor = matrix[row][col]; for (let j = col; j <= count; j++) matrix[row][j] -= factor * matrix[col][j] }
  }
  return Array.from({ length: orders }, (_, i) => Math.hypot(matrix[2 * i + 1][count], matrix[2 * i + 2][count]))
}

export function fftWaveform(result: Result, signal = defaultAnalysisSignal(result), options: FftOptions = {}): FftResult {
  if (result.analysis !== 'tran') throw new Error('FFT 仅适用于瞬态实数波形，交流、直流和噪声分析不能作为时域信号。')
  const s = series(result, signal, options), n = options.samples ?? 4096, window = options.window ?? 'hann'
  if (!Number.isInteger(n) || n < 64 || n > 65536 || (n & (n - 1)) !== 0) throw new Error('FFT 点数必须为 64–65536 之间的 2 的整数次幂。')
  if (window !== 'hann' && window !== 'rectangular') throw new Error('请选择 Hann 或矩形窗。')
  if (options.fundamental !== undefined && (!Number.isFinite(options.fundamental) || options.fundamental <= 0)) throw new Error('基波频率必须大于 0 Hz。')
  const duration = s.end - s.start, sampleRate = n / duration, resolution = 1 / duration, nyquist = sampleRate / 2
  const raw = new Float64Array(n), real = new Float64Array(n), imag = new Float64Array(n)
  let cursor = 1, gain = 0, maxGap = 0
  for (let i = 1; i < s.x.length; i++) maxGap = Math.max(maxGap, s.x[i] - s.x[i - 1])
  for (let i = 0; i < n; i++) {
    const time = s.start + i / sampleRate
    while (cursor < s.x.length - 1 && s.x[cursor] < time) cursor++
    const a = cursor - 1, f = (time - s.x[a]) / (s.x[cursor] - s.x[a]), value = s.y[a] + f * (s.y[cursor] - s.y[a]), weight = window === 'hann' ? .5 - .5 * Math.cos(2 * Math.PI * i / n) : 1
    raw[i] = value; real[i] = value * weight; gain += weight
  }
  fft(real, imag)
  const frequencies = Array.from({ length: n / 2 + 1 }, (_, i) => i * resolution)
  const amplitudes = frequencies.map((_, i) => Math.hypot(real[i], imag[i]) / gain * (i === 0 || i === n / 2 ? 1 : 2))
  const warnings = ['频谱来自保存的自适应采样，经线性插值等间隔重采样；增加 FFT 点数不会增加原始信息，也不能消除原始混叠。', '幅度为单边峰值幅度（DC / Nyquist 不加倍）；Hann 窗已校正相干增益，非整周期信号仍存在谱泄漏。']
  const sourceLimit = 1 / (2 * maxGap)
  if (sourceLimit < nyquist) warnings.push(`原始最大采样间隔 ${maxGap} s；保守可用频率上限约 ${sourceLimit} Hz，超过此频率的细节不可靠。`)
  let thd: FftResult['thd'] = null
  if (options.fundamental !== undefined) {
    const fundamental = options.fundamental, orders = Math.min(9, Math.ceil(Math.min(nyquist, sourceLimit) / fundamental) - 1)
    thd = { percent: null, fundamental, harmonics: [] }
    if (fundamental * duration < 3) thd.reason = 'THD 至少需要 3 个基波周期；建议使用 10 个以上周期。'
    else if (orders < 2 || maxGap * fundamental > .1) thd.reason = '原始采样或重采样带宽不足以可靠区分基波与谐波；请减小仿真最大步长。'
    else {
      const fitted = harmonicFit(raw, fundamental, sampleRate, orders)
      if (!fitted || fitted[0] <= Math.max(...amplitudes) * 1e-8 || fitted[0] === 0) thd.reason = '指定基波未检测到有效幅度。'
      else { thd.fundamentalAmplitude = fitted[0]; thd.harmonics = fitted.slice(1).map((amplitude, i) => ({ order: i + 2, frequency: fundamental * (i + 2), amplitude })); thd.percent = Math.hypot(...fitted.slice(1)) / fitted[0] * 100 }
      warnings.push(`THD 采用指定基波的同步正弦拟合，统计 2–${orders} 次谐波，排除 DC；不计入带宽外谐波与随机噪声，结果依赖保存采样精度。`)
    }
  }
  return { signalId: s.signal.id, signalName: s.signal.name, unit: s.unit, start: s.start, end: s.end, samples: n, window, sampleRate, resolution, nyquist, frequencies, amplitudes, warnings, thd }
}
const csvCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
export function waveformMeasurementsCsv(measurement: WaveformMeasurementResult): string {
  return 'signal,start,end,measurement,value,unit,source,unavailable_reason\n' + measurement.records.map(record => [measurement.signalName, measurement.start, measurement.end, record.name, record.value, record.unit, record.source, record.reason].map(csvCell).join(',')).join('\n')
}
export function fftCsv(spectrum: FftResult): string {
  const metadata = [['signal', spectrum.signalName], ['interval_s', `${spectrum.start}–${spectrum.end}`], ['fft_samples', spectrum.samples], ['window', spectrum.window], ['sample_rate_Hz', spectrum.sampleRate], ['resolution_Hz', spectrum.resolution], ['amplitude_unit', spectrum.unit], ['amplitude_convention', 'single-sided peak; coherent gain corrected'], ['THD_percent', spectrum.thd?.percent ?? spectrum.thd?.reason ?? 'not requested'], ['fundamental_Hz', spectrum.thd?.fundamental ?? ''], ...spectrum.warnings.map(w => ['warning', w])]
  return metadata.map(row => row.map(csvCell).join(',')).join('\n') + `\nfrequency_Hz,amplitude_${spectrum.unit}\n` + spectrum.frequencies.map((f, i) => `${f},${spectrum.amplitudes[i]}`).join('\n')
}
