import type { WaveformDomain } from './waveform-workspace'

/** Zero-aligned engineering steps with enough room for readable labels. */
export function waveformLinearAxis([min, max]: WaveformDomain, width: number, unit: string) {
  const span = max - min
  const previewScale = 10 ** (Math.max(-12,Math.min(12,Math.floor(Math.log10(Math.max(Math.abs(min),Math.abs(max),span))/3)*3)))
  const precision = Math.max(0,Math.min(12,Math.ceil(-Math.log10(span/Math.max(1,width/60)/previewScale))))
  const labelLength = (Math.max(Math.abs(min),Math.abs(max))/previewScale).toFixed(precision).length + unit.length + 2
  const intervals = Math.max(1, Math.floor(width / Math.max(60,labelLength*6+14)))
  const raw = span / intervals
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].find(value => value * power >= raw * (1 - 1e-10))! * power
  if (!Number.isFinite(step) || step <= 0) return { major: [], minor: [], labels: [], step: 0 }
  const first = Math.ceil(min / step - 1e-10), last = Math.floor(max / step + 1e-10)
  const major = Array.from({ length: Math.max(0, Math.min(100, last - first + 1)) }, (_, i) => Number(((first + i) * step).toPrecision(14)))
  // Keep one prefix across the axis, including ranges that cross 1 ms / 1 s.
  const reference = Math.max(Math.abs(min), Math.abs(max), step)
  const exponent = Math.max(-12, Math.min(12, Math.floor(Math.log10(reference) / 3) * 3))
  const scale = 10 ** exponent
  const prefix: Record<number, string> = { '-12': 'p', '-9': 'n', '-6': 'µ', '-3': 'm', 0: '', 3: 'k', 6: 'M', 9: 'G', 12: 'T' }
  let decimals = Math.max(0, -Math.floor(Math.log10(step / scale)))
  while (decimals < 12 && Math.abs(Number((step / scale).toFixed(decimals)) - step / scale) > step / scale * 1e-8) decimals++
  const labels = major.map(value => `${(Math.abs(value) < step * 1e-8 ? 0 : value / scale).toFixed(decimals)} ${prefix[exponent]}${unit}`)
  const minor: number[] = []
  const minorStep = step / 5
  if (minorStep / span * width >= 8) {
    const start = Math.ceil(min / minorStep - 1e-10), end = Math.floor(max / minorStep + 1e-10)
    for (let i = start; i <= end && minor.length < 500; i++) if (i % 5 !== 0) minor.push(Number((i * minorStep).toPrecision(14)))
  }
  return { major, minor, labels, step }
}
