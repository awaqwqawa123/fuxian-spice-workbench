import type { WaveformTrace } from './waveform-workspace'

export type CursorSearch = 'maximum' | 'minimum' | 'next-peak' | 'previous-peak' | 'next-trough' | 'previous-trough'
export interface WaveformCursorSample { index: number; x: number; y: number }

/** The saved sample closest to the plateau's midpoint in x, with earlier ties. */
function plateauSample(trace: WaveformTrace, start: number, end: number): WaveformCursorSample {
  const midpoint = trace.x[start] / 2 + trace.x[end] / 2
  let index = start
  for (let i = start + 1; i <= end; i++) {
    if (Math.abs(trace.x[i] - midpoint) < Math.abs(trace.x[index] - midpoint)) index = i
  }
  return { index, x: trace.x[index], y: trace.y[index] }
}

/**
 * Search original saved samples, never display-decimated points or interpolated extrema.
 * Local extrema need two strictly lower/higher neighbours; an endpoint is not a peak.
 * Flat extrema are one event, represented by their midpoint's nearest saved sample.
 * Directional searches are strict and stop at the visible range instead of wrapping.
 */
export function findWaveformCursorSample(
  trace: WaveformTrace, range: readonly [number, number], currentX: number | null, mode: CursorSearch,
): WaveformCursorSample | null {
  const [low, high] = range,direction=trace.x.length>1&&trace.x.at(-1)!<trace.x[0]?-1:1
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high || trace.x.length !== trace.y.length) return null
  if (currentX !== null && !Number.isFinite(currentX)) return null
  const global = mode === 'maximum' || mode === 'minimum'
  const maximum = mode === 'maximum' || mode.endsWith('peak')
  const previous = mode.startsWith('previous')
  let selected: WaveformCursorSample | null = null
  const valid = (i: number) => i >= 0 && i < trace.x.length && Number.isFinite(trace.x[i]) && Number.isFinite(trace.y[i])
  for (let start = 0; start < trace.x.length; start++) {
    if (!valid(start) || trace.x[start] < low || trace.x[start] > high) continue
    let end = start
    while (valid(end + 1) && (trace.x[end + 1]-trace.x[end])*direction > 0 && trace.x[end + 1] >= low && trace.x[end + 1] <= high && trace.y[end + 1] === trace.y[start]) end++
    const candidate = plateauSample(trace, start, end)
    if (global) {
      if (!selected || (maximum ? candidate.y > selected.y : candidate.y < selected.y) || candidate.y === selected.y && candidate.x < selected.x) selected = candidate
    } else {
      const neighbours = valid(start - 1) && valid(end + 1) && (trace.x[start]-trace.x[start - 1])*direction > 0 && (trace.x[end + 1]-trace.x[end])*direction > 0
      const extremum = neighbours && (maximum
        ? trace.y[start - 1] < candidate.y && trace.y[end + 1] < candidate.y
        : trace.y[start - 1] > candidate.y && trace.y[end + 1] > candidate.y)
      const inDirection = currentX === null || (previous ? candidate.x < currentX : candidate.x > currentX)
      if (extremum && inDirection && (!selected || (previous ? candidate.x > selected.x : candidate.x < selected.x))) selected = candidate
    }
    start = end
  }
  return selected
}
