import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Simulation } from 'eecircuit-engine'
import { normalizeLegacyDiodeDefaultStates } from '../src/core/spice-legacy-diode-state'

// Consumes native psp_cmd.exe runs without redistributing the owned di.lib.
// Each native pair must contain the same macro and IC except its STATE tail.
const root = resolve(process.argv[2] ?? 'verification/pspice-diode-state/normal')
const names = ['awb1n4153', 'awb1n4001', 'awb1n5819', 'awb1n4148', 'awb1n1183']
const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const nativeSource = argument('--native-source')
const nativeExe = argument('--native-exe')
let sourceLibraryHash: string | undefined
if (nativeSource || nativeExe) {
  assert.ok(nativeSource && nativeExe, 'Provide both --native-source and --native-exe')
  const bytes = await readFile(nativeSource)
  sourceLibraryHash = createHash('sha256').update(bytes).digest('hex')
  const originalLibrary = bytes.toString('latin1')
  await mkdir(root, { recursive: true })
  for (const name of names) {
    const match = new RegExp(`^\\.subckt\\s+${name}\\b[\\s\\S]*?^\\.ends[^\\r\\n]*`, 'im').exec(originalLibrary)
    assert.ok(match, `Owned source missing ${name}`)
    for (const variant of ['original', 'without-state']) {
      const macro = variant === 'original' ? match[0] : match[0].replace(/\{state\}(?=\s+IC=)/i, '')
      const circuit = `Cadence default diode state comparison\nV1 1 0 PULSE(0 1 100n 50n 50n 2u 4u)\nR1 1 2 1k\nX1 2 0 ${name}\n${macro}\n.OPTIONS NUMDGT=7 RELTOL=1e-4 ABSTOL=1e-12 VNTOL=1e-6\n.DC V1 -.2 1 .01\n.TRAN 10n 6u 0 2n\n.PRINT DC V(2) I(V1)\n.PRINT TRAN V(2) I(V1)\n.END\n`
      const path = join(root, `${name}-${variant}.cir`)
      await writeFile(path, circuit, 'latin1')
      const command = await promisify(execFile)(nativeExe, [path], { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
      await writeFile(join(root, `${name}-${variant}-command.txt`), command.stdout + '\n' + command.stderr)
    }
  }
}
type Point = [number, number, number]
function nativeCurves(output: string): { dc: Point[]; tran: Point[] } {
  const curves: { dc: Point[]; tran: Point[] } = { dc: [], tran: [] }
  let section: 'dc' | 'tran' | undefined
  for (const line of output.split(/\r?\n/)) {
    if (line.includes('DC TRANSFER CURVES')) section = 'dc'
    if (line.includes('TRANSIENT ANALYSIS')) section = 'tran'
    const match = /^\s*([+-]?\d\.\d+E[+-]\d+)\s+([+-]?\d\.\d+E[+-]\d+)\s+([+-]?\d\.\d+E[+-]\d+)\s*$/.exec(line)
    if (match && section) {
      const point = match.slice(1).map(Number) as Point
      const previous = curves[section].at(-1)
      // Native PRINT may repeat its exact terminal row after rounding.
      if (previous?.[0] === point[0]) curves[section][curves[section].length - 1] = point
      else curves[section].push(point)
    }
  }
  return curves
}
function maximumDifferences(left: Point[], right: Point[]) {
  assert.equal(left.length, right.length)
  return left.reduce((max, row, index) => row.map((value, axis) => Math.max(max[axis], Math.abs(value - right[index][axis]))) as Point, [0, 0, 0] as Point)
}
function interpolate(points: Point[], x: number, axis: 1 | 2) {
  if (x <= points[0][0]) return points[0][axis]
  const upper = points.findIndex(point => point[0] >= x)
  if (upper < 0) return points.at(-1)![axis]
  const a = points[upper - 1], b = points[upper]
  return a[axis] + (b[axis] - a[axis]) * (x - a[0]) / (b[0] - a[0])
}

const simulator = new Simulation()
await simulator.start()
const engine = simulator.getInitInfo().match(/ngspice-[\d.]+/)?.[0]
const cases = []
for (const name of names) {
  const stem = name
  const source = await readFile(join(root, `${stem}-original.cir`), 'utf8')
  const removed = await readFile(join(root, `${stem}-without-state.cir`), 'utf8')
  assert.equal(removed.replace(/\s+/g, ' '), source.replace(/\{state\}(?=\s+IC=)/i, '').replace(/\s+/g, ' '))
  const originalOutput = await readFile(join(root, `${stem}-original.out`), 'utf8')
  const omittedOutput = await readFile(join(root, `${stem}-without-state.out`), 'utf8')
  assert.ok(!/ERROR\(/.test(originalOutput + omittedOutput), 'Native CLI exit zero alone does not confirm simulation success')
  const original = nativeCurves(originalOutput)
  const omitted = nativeCurves(omittedOutput)
  assert.equal(original.dc.length, 121)
  assert.equal(original.tran.length, 601)
  const nativeDifference = {
    dc: maximumDifferences(original.dc, omitted.dc),
    tran: maximumDifferences(original.tran, omitted.tran),
  }
  assert.deepEqual(nativeDifference, { dc: [0, 0, 0], tran: [0, 0, 0] })
  const adapter = normalizeLegacyDiodeDefaultStates(source, [name])
  assert.deepEqual(adapter.convertedModels, [name])
  const comparisons: Record<string, unknown> = {}
  for (const analysis of ['dc', 'tran'] as const) {
    const circuit = adapter.netlist.split(/\r?\n/).filter(line =>
      !/^\.print\b/i.test(line) && !new RegExp(`^\\.${analysis === 'dc' ? 'tran' : 'dc'}\\b`, 'i').test(line)
    ).join('\n').replace(/^\.END$/im, '.save v(2) i(v1)\n.end')
    simulator.setNetList(circuit)
    const result = await simulator.runSim()
    assert.deepEqual(simulator.getError(), [])
    const scale = result.data[0].values as number[]
    const voltage = result.data.find(vector => vector.name.toLowerCase() === 'v(2)')!.values as number[]
    const current = result.data.find(vector => vector.name.toLowerCase() === 'i(v1)')!.values as number[]
    const points = scale.map((x, index) => [x, voltage[index], current[index]] as Point)
    assert.ok(points.every(point => point.every(Number.isFinite)))
    const resampled = original[analysis].map(row => [row[0], interpolate(points, row[0], 1), interpolate(points, row[0], 2)] as Point)
    const difference = maximumDifferences(original[analysis], resampled)
    assert.ok(difference[1] < (analysis === 'dc' ? 3e-5 : 1e-3), `${stem} ${analysis}: voltage difference outside tested bounds`)
    assert.ok(difference[2] < (analysis === 'dc' ? 3e-8 : 1e-6), `${stem} ${analysis}: current difference outside tested bounds`)
    comparisons[analysis] = { nativePoints: original[analysis].length, enginePoints: points.length, maxVoltageDifferenceV: difference[1], maxCurrentDifferenceA: difference[2] }
    console.log(`${stem} ${analysis}: dV=${difference[1]} dI=${difference[2]}`)
  }
  cases.push({ model: name, icV: 1.10250e-36, sourceHash: createHash('sha256').update(source).digest('hex'), nativeDifference, comparisons })
}
const report = { schema: 1, date: new Date().toISOString(), nativeEngine: 'Cadence PSpice 25.1.0', executionEngine: engine, sourceLibraryHash, method: 'Native original STATE=1 versus omitted positional STATE; same library macro, AREA, IC, models and analysis. ngspice output interpolated to native printed samples.', cases }
await writeFile(join(root, '..', 'family-comparison.json'), JSON.stringify(report, null, 2) + '\n')
