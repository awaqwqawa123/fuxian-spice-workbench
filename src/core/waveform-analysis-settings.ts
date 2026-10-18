export interface WaveformAnalysisSettings {
  version: 1
  signalId?: string
  rangeMode: 'visible' | 'full' | 'fixed'
  fixedRange?: [number, number]
  events: {
    direction: 'rising' | 'falling'
    lowLevel?: number; highLevel?: number; threshold?: number
    referenceSignalId?: string; referenceThreshold?: number
    initialLevel?: number; finalLevel?: number
  }
  fft: { samples: number; window: 'hann' | 'rectangular'; fundamental?: number; frequencyRange?: [number, number] }
}

export function defaultWaveformAnalysisSettings(signalId?: string): WaveformAnalysisSettings {
  return { version: 1, ...(signalId ? { signalId } : {}), rangeMode: 'visible', events: { direction: 'rising' }, fft: { samples: 4096, window: 'hann' } }
}
const object = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}：需要对象`)
  return value as Record<string, unknown>
}
const fields = (value: Record<string, unknown>, allowed: readonly string[], path: string) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${path}.${key}：不支持此字段`)
}
const finite = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path}：需要有限数字`)
  return value
}
const signal = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 199 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${path}：需要最多 199 字符的非空曲线编号`)
  return value
}
function range(value: unknown, path: string, nonnegative = false): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${path}：需要实际开始和结束数值`)
  const start = finite(value[0], `${path}[0]`), end = finite(value[1], `${path}[1]`)
  if (start >= end || nonnegative && start < 0) throw new Error(`${path}：结束值必须大于开始值${nonnegative ? '，频率不得为负' : ''}`)
  return [start, end]
}
/** Optional configuration extends version 1; unknown nested fields remain rejected. */
export function parseWaveformAnalysisSettings(input: unknown, path = 'analysisSettings'): WaveformAnalysisSettings {
  const raw = object(input, path)
  fields(raw, ['version', 'signalId', 'rangeMode', 'fixedRange', 'events', 'fft'], path)
  if (raw.version !== 1 || !['visible', 'full', 'fixed'].includes(String(raw.rangeMode))) throw new Error(`${path}：需要 version:1 和 visible / full / fixed 区间模式`)
  const event = object(raw.events, `${path}.events`), fft = object(raw.fft, `${path}.fft`)
  fields(event, ['direction', 'lowLevel', 'highLevel', 'threshold', 'referenceSignalId', 'referenceThreshold', 'initialLevel', 'finalLevel'], `${path}.events`)
  fields(fft, ['samples', 'window', 'fundamental', 'frequencyRange'], `${path}.fft`)
  if (!['rising', 'falling'].includes(String(event.direction))) throw new Error(`${path}.events.direction：只支持 rising / falling`)
  const samples = finite(fft.samples, `${path}.fft.samples`)
  if (!Number.isInteger(samples) || samples < 64 || samples > 65536 || (samples & (samples - 1))) throw new Error(`${path}.fft.samples：需要 64–65536 之间的 2 的整数次幂`)
  if (!['hann', 'rectangular'].includes(String(fft.window))) throw new Error(`${path}.fft.window：只支持 hann / rectangular`)
  const clean: WaveformAnalysisSettings = { version: 1, rangeMode: raw.rangeMode as WaveformAnalysisSettings['rangeMode'], events: { direction: event.direction as WaveformAnalysisSettings['events']['direction'] }, fft: { samples, window: fft.window as WaveformAnalysisSettings['fft']['window'] } }
  if (raw.signalId !== undefined) clean.signalId = signal(raw.signalId, `${path}.signalId`)
  if (raw.fixedRange !== undefined) clean.fixedRange = range(raw.fixedRange, `${path}.fixedRange`)
  if (clean.rangeMode === 'fixed' && !clean.fixedRange) throw new Error(`${path}.fixedRange：固定区间必须填写开始和结束`)
  for (const key of ['lowLevel', 'highLevel', 'threshold', 'referenceThreshold', 'initialLevel', 'finalLevel'] as const) if (event[key] !== undefined) clean.events[key] = finite(event[key], `${path}.events.${key}`)
  if (clean.events.lowLevel !== undefined && clean.events.highLevel !== undefined && clean.events.lowLevel >= clean.events.highLevel) throw new Error(`${path}.events.highLevel：高电平必须大于低电平`)
  if (event.referenceSignalId !== undefined) clean.events.referenceSignalId = signal(event.referenceSignalId, `${path}.events.referenceSignalId`)
  if (fft.fundamental !== undefined) {
    clean.fft.fundamental = finite(fft.fundamental, `${path}.fft.fundamental`)
    if (clean.fft.fundamental <= 0) throw new Error(`${path}.fft.fundamental：基波频率必须大于零`)
  }
  if (fft.frequencyRange !== undefined) clean.fft.frequencyRange = range(fft.frequencyRange, `${path}.fft.frequencyRange`, true)
  return clean
}
export function validWaveformAnalysisSettings(input: unknown): input is WaveformAnalysisSettings {
  try { parseWaveformAnalysisSettings(input); return true } catch { return false }
}
/** Absolute ranges are never clipped onto a different run. */
export function resolveWaveformAnalysisRange(settings: WaveformAnalysisSettings, x: readonly number[], visibleRange?: readonly [number, number]): [number, number] {
  if (x.length < 2 || !Number.isFinite(x[0]) || !Number.isFinite(x.at(-1))) throw new Error('当前运行没有可测量的有效坐标区间。')
  const low=Math.min(x[0],x.at(-1)!),high=Math.max(x[0],x.at(-1)!)
  const selected = settings.rangeMode === 'fixed' ? settings.fixedRange : settings.rangeMode === 'visible' ? visibleRange ?? [low,high] : [low,high]
  if (!selected || !selected.every(Number.isFinite) || selected[0] >= selected[1]) throw new Error('测量区间必须有有限的开始和结束，且结束大于开始。')
  if (selected[0] < low || selected[1] > high) throw new Error(`测量区间超出当前运行范围 ${low}–${high}；请修改固定区间或选择完整运行。`)
  return [selected[0], selected[1]]
}
