import { cpus, totalmem, platform, release, arch } from 'node:os'
import { performance } from 'node:perf_hooks'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { newProject } from '../src/core/circuit'
import { analyzeWaveform, type WaveformMeasurementOptions } from '../src/core/waveform-analysis'
import type { Result } from '../src/core/results'
import type { WaveformSignal } from '../src/core/waveform-workspace'

// Algorithm-only baseline. Includes input validation, clipping, integration,
// and default event extraction. Excludes rendering, solver and signal creation.
const points = 100000, duration = .1, iterations = 120, warmups = 30
const x = Array.from({ length: points }, (_, index) => duration * index / (points - 1))
const y = x.map(time => 1.2 + 2 * Math.sin(2 * Math.PI * 100 * time) + .2 * Math.sin(2 * Math.PI * 200 * time))
const project = newProject(); project.analysis = 'tran'
const result: Result = {
  id: '100k-summary-baseline', project, key: '', analysis: 'tran', netlist: '', timestamp: 0, elapsed: 0,
  engine: 'analytic benchmark input', log: '', warnings: [], x, vin: y, vout: y, current: y.map(() => 0),
  magnitude: [], phase: [], cutoff: null, peakDb: null, peakFrequency: null, points,
}
const signal: WaveformSignal = { id: 'voltage:v(vout)', name: 'V(vout)', kind: 'voltage', color: '#ff6600', values: y }
const reference = { ...signal, id: 'reference', values: x.map(time => 1.2 + 2 * Math.sin(2 * Math.PI * 100 * (time + .001))) }
const scenarios: { name: string; options: WaveformMeasurementOptions }[] = [
  { name: 'full-run-default-summary', options: {} },
  { name: 'visible-middle-half', options: { start: .025, end: .075 } },
  { name: 'visible-detail-one-percent', options: { start: .045, end: .046 } },
  { name: 'full-run-reference-delay', options: { threshold: 1.2, referenceSignal: reference, referenceThreshold: 1.2 } },
]
const round = (value: number) => Number(value.toFixed(4))
const measurements = scenarios.map(({ name, options }) => {
  for (let index = 0; index < warmups; index++) analyzeWaveform(result, signal, options)
  const samples: number[] = []
  let checksum = 0
  for (let index = 0; index < iterations; index++) {
    const start = performance.now(), summary = analyzeWaveform(result, signal, options)
    samples.push(performance.now() - start)
    checksum += summary.records.find(record => record.id === 'mean')!.value!
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = (fraction: number) => sorted[Math.ceil(fraction * sorted.length) - 1]
  return {
    name, rangeSeconds: [options.start ?? 0, options.end ?? duration], iterations, warmups,
    milliseconds: { minimum: round(sorted[0]), median: round(percentile(.5)), p95: round(percentile(.95)), maximum: round(sorted.at(-1)!), mean: round(samples.reduce((a, b) => a + b, 0) / samples.length) },
    summaryTargetMilliseconds: 150, meetsAlgorithmTarget: percentile(.95) < 150,
    checksum: round(checksum), samplesMilliseconds: samples.map(round),
  }
})
const hardware = cpus()
const report = {
  measuredAt: new Date().toISOString(), scope: 'analyzeWaveform algorithm only; no browser DOM, painting, solver or signal construction',
  caveat: 'Synthetic calibrated waveform at the existing 100000-point result limit; host contention and runtime warm-up affect measurements. These timings do not establish browser interaction latency.',
  input: { points, durationSeconds: duration, sampleCoordinates: 'strictly increasing uniform samples', signal: '1.2 + 2*sin(2*pi*100*t) + 0.2*sin(2*pi*200*t)' },
  host: { cpu: hardware[0]?.model, logicalProcessors: hardware.length, totalMemoryGiB: round(totalmem() / 1024 ** 3), platform: platform(), release: release(), architecture: arch(), node: process.version },
  measurements,
}
const output = JSON.stringify(report, null, 2)
if (process.argv[2]) { const destination = resolve(process.argv[2]); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, `${output}\n`, 'utf8') }
process.stdout.write(`${output}\n`)
