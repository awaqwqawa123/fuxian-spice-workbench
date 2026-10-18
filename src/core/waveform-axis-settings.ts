import { parseQuantity } from './circuit'
import type { WaveformDomain } from './waveform-workspace'

export type WaveformAxisRanges = Record<string, WaveformDomain>
export function validWaveformAxisRanges(value: unknown): value is WaveformAxisRanges {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length <= 8
    && Object.entries(value).every(([unit, range]) => unit.length > 0 && unit.length <= 40
      && Array.isArray(range) && range.length === 2 && range.every(Number.isFinite) && range[0] < range[1] && Number.isFinite(range[1] - range[0]))
}

/** Inputs accept displayed units and engineering suffixes, e.g. 1.5ms / 20mA. */
export function parseWaveformAxisValue(text: string, unit: string): number {
  const value = text.trim()
  const withoutUnit = value.endsWith(unit) ? value.slice(0, -unit.length).trim() : value
  return parseQuantity(withoutUnit, 'gain')
}

export function parseWaveformAxisRange(start: string, end: string, unit: string): WaveformDomain {
  const range: WaveformDomain = [parseWaveformAxisValue(start, unit), parseWaveformAxisValue(end, unit)]
  if (range[0] >= range[1]) throw new Error('下限必须小于上限。')
  if (!Number.isFinite(range[1] - range[0])) throw new Error('量程范围过大，请缩小范围。')
  return range
}

/** Shared X domain is saved normalized; frequency bounds are stored logarithmically. */
export function waveformRangeDomain(range: WaveformDomain, bounds: WaveformDomain, logarithmic: boolean): WaveformDomain {
  if (!range.every(Number.isFinite) || range[0] >= range[1] || logarithmic && range[0] <= 0) throw new Error('横轴范围无效；频率必须大于 0。')
  const start = logarithmic ? Math.log10(range[0]) : range[0], end = logarithmic ? Math.log10(range[1]) : range[1]
  const span = bounds[1] - bounds[0]
  if (!(span > 0) || start < bounds[0] - span * 1e-10 || end > bounds[1] + span * 1e-10) throw new Error('横轴范围必须位于已有仿真结果内。')
  const domain: WaveformDomain = [Math.max(0, (start - bounds[0]) / span), Math.min(1, (end - bounds[0]) / span)]
  if (domain[1] - domain[0] < 1e-6 * (1 - 1e-6)) throw new Error('横轴范围过小，请扩大范围。')
  return domain
}

/** Zoom physical Y units around a pointer fraction measured bottom → top. */
export function zoomWaveformAxisRanges(ranges: WaveformAxisRanges, factor: number, anchor = .5): WaveformAxisRanges {
  if (!Number.isFinite(factor) || factor <= 0) return ranges
  const fraction = Math.max(0, Math.min(1, anchor))
  const result: WaveformAxisRanges = {}
  for (const [unit, [min, max]] of Object.entries(ranges)) {
    const center = min + (max - min) * fraction, span = (max - min) / factor
    const next: WaveformDomain = [center - span * fraction, center + span * (1 - fraction)]
    result[unit] = next.every(Number.isFinite) && next[0] < next[1] && Number.isFinite(next[1] - next[0]) ? next : [min, max]
  }
  return result
}
