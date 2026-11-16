import type { WaveformDomain } from './waveform-workspace'

const prefixes: Record<number, string> = { '-12': 'p', '-9': 'n', '-6': 'µ', '-3': 'm', 0: '', 3: 'k', 6: 'M', 9: 'G', 12: 'T' }

function engineeringScale(reference: number, unit: string) {
  const exponent = unit && reference > 0 && Number.isFinite(reference)
    ? Math.max(-12, Math.min(12, Math.floor((Math.log10(reference) + 1e-12) / 3) * 3)) : 0
  return { scale: 10 ** exponent, displayUnit: `${prefixes[exponent]}${unit}` }
}

/** Zero-aligned engineering steps with enough room for readable labels. */
export function waveformLinearAxis([min, max]: WaveformDomain, width: number, unit: string) {
  const span = max - min
  const { scale, displayUnit } = engineeringScale(Math.max(Math.abs(min), Math.abs(max)), unit)
  if (!Number.isFinite(span) || span <= 0) return { major: [], minor: [], labels: [], step: 0, displayUnit }
  const precision = Math.max(0,Math.min(16,Math.ceil(-Math.log10(span/Math.max(1,width/60)/scale))))
  const labelLength = Math.max((min/scale).toFixed(precision).length, (max/scale).toFixed(precision).length)
  const intervals = Math.max(1, Math.floor(width / Math.max(60,labelLength*6+14)))
  const raw = span / intervals
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].find(value => value * power >= raw * (1 - 1e-10))! * power
  if (!Number.isFinite(step) || step <= 0) return { major: [], minor: [], labels: [], step: 0, displayUnit }
  const first = Math.ceil(min / step - 1e-10), last = Math.floor(max / step + 1e-10)
  const major = Array.from({ length: Math.max(0, Math.min(100, last - first + 1)) }, (_, i) => (first + i) * step)
  let decimals = Math.max(0, Math.min(16, -Math.floor(Math.log10(step / scale))))
  while (decimals < 16 && Math.abs(Number((step / scale).toFixed(decimals)) - step / scale) > step / scale * 1e-8) decimals++
  const labels = major.map(value => (Math.abs(value) < step * 1e-8 ? 0 : value / scale).toFixed(decimals))
  const minor: number[] = []
  const minorStep = step / 5
  if (minorStep / span * width >= 8) {
    const start = Math.ceil(min / minorStep - 1e-10), end = Math.floor(max / minorStep + 1e-10)
    for (let i = start; i <= end && minor.length < 500; i++) if (i % 5 !== 0) minor.push(Number((i * minorStep).toPrecision(14)))
  }
  return { major, minor, labels, step, displayUnit }
}

/** Keep logarithmic coordinates in decades; scale only the displayed numbers. */
export function waveformLogAxis([min, max]: WaveformDomain, width: number, unit: string) {
  const span = max - min
  // At a wide frequency span, prefer Hz (or a nearby engineering unit) so
  // low frequencies do not all read as long strings of leading zeroes.
  const { scale, displayUnit } = engineeringScale(10 ** (span > 4 ? Math.min(Math.max(0, min), max) : max), unit)
  if (!Number.isFinite(span) || span <= 0) return { major: [], minor: [], labels: [], displayUnit }
  const count = Math.max(2, Math.min(20, Math.floor(width / 90) + 1))
  const decades = Math.floor(max) - Math.ceil(min) + 1
  const decadeStep = Math.max(1, Math.ceil(span / (count - 1)))
  const firstDecade = Math.ceil(min / decadeStep) * decadeStep
  const natural = decades >= 2 ? Array.from({ length: Math.max(0, Math.floor((max - firstDecade) / decadeStep) + 1) }, (_, i) => firstDecade + i * decadeStep) : []
  const major = natural.length >= 2 ? natural : Array.from({ length: count }, (_, i) => min + span * i / (count - 1))
  const relativeSpacing = Math.expm1(span / (count - 1) * Math.LN10)
  const digits = Math.max(3, Math.min(15, Math.ceil(-Math.log10(relativeSpacing)) + 2))
  const labels = major.map(tick => {
    const value = Number((10 ** tick / scale).toPrecision(digits))
    return value < .001 || value >= 1e6 ? value.toExponential() : String(value)
  })
  return { major, minor: [], labels, displayUnit }
}
