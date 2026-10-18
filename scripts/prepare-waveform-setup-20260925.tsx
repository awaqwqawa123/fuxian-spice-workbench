/** Run after npm run build. Produces review artifacts only; never writes a live project. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import sharp from 'sharp'
import { createCircuitAgentTools } from '../src/core/agent-circuit'
import { generateNetlist, projectKey, type Project } from '../src/core/circuit'
import { simulationSettings } from '../src/core/simulation-profiles'
import { waveformSetupIssues, type WaveformSetup } from '../src/core/waveform-setup'
import { waveformSignals, waveformTraces, waveformXBounds } from '../src/core/waveform-workspace'
import { CanvasWaveformPreview, type WaveformSnapshot } from '../src/components/WaveformWorkspace'
import { resolveMeasurement } from '../src/core/probes'
import { layoutProbeMarkers, measurementProbeMarkers, probeMarkerBounds } from '../src/core/probe-layout'
import { deviceLayoutObstacles, placeNetLabels, type LayoutRect } from '../src/core/schematic-layout'
import { wirePoints } from '../src/core/drawing'
import { schematicSvg } from '../src/core/export-svg'
import type { Result } from '../src/core/results'
import { simulateAgentCircuit } from '../server/agent-simulation'

const directory = new URL('../docs/artifacts/2026-09-25-waveform-setup/', import.meta.url)
await mkdir(directory, { recursive: true })
const save = (name: string, text: string) => writeFile(new URL(name, directory), text, 'utf8')
const json = (name: string, value: unknown) => save(name, `${JSON.stringify(value, null, 2)}\n`)
const baseline = JSON.parse(await readFile(new URL('baseline-snapshot.json', directory), 'utf8')) as { revision: number; projectId: string; project: Project }
assert.equal(baseline.projectId, '2bfea8f7-2a8b-4770-a96f-3714965cc578')
assert.ok(Number.isInteger(baseline.revision) && baseline.revision >= 11)
const original = structuredClone(baseline.project)
const preserved = JSON.stringify(original)
const profileId = 'tran-startup-600ms'
const panels = () => [
  { source: 'signals' as const, display: 'magnitude' as const, ids: ['probe:P1', 'probe:P2'], primary: 'probe:P1' },
  { source: 'signals' as const, display: 'magnitude' as const, ids: ['probe:P3'], primary: 'probe:P3' },
  { source: 'signals' as const, display: 'magnitude' as const, ids: [] },
  { source: 'signals' as const, display: 'magnitude' as const, ids: [] },
]
const setup: WaveformSetup = {
  version: 1,
  profiles: { version: 1, activeId: profileId, profiles: [{ id: profileId, name: '缓启动 · 600 ms / 100 µs', settings: { ...simulationSettings(original), analysis: 'tran', tran: { stop: '600ms', step: '100us' } } }] },
  diagrams: [
    { id: 'startup-overview', title: '全程 · Gate / Drain / 负载电流', profileId, x: 1280, y: 160, width: 900, height: 430, view: { analysis: 'tran', layout: 2, panels: panels(), domain: [0, 1], cursors: { a: null, b: null }, activePanel: 0 } },
    { id: 'startup-detail', title: '启动细节 · 0–150 ms', profileId, x: 1280, y: 650, width: 900, height: 430, view: { analysis: 'tran', layout: 2, panels: panels(), domain: [0, .25], cursors: { a: null, b: null }, activePanel: 0 } },
  ],
}
const events: unknown[] = []
let result: Result | undefined
const tools = createCircuitAgentTools(original, {
  signal: new AbortController().signal,
  simulate: async (project, signal) => result = await simulateAgentCircuit(project, signal),
  onEvent: event => events.push(event),
})
await tools.execute('configure_waveforms', { setup })
await tools.execute('simulate_circuit', {})
assert.ok(result, 'ngspice must produce real samples')
const solved: Result = result
const traces = (original.probes ?? []).map(probe => {
  const trace = resolveMeasurement(solved, probe)
  assert.ok(trace, `Actual solver vector missing for ${probe.id}`)
  return trace
})
const current = traces.find(trace => trace.id === 'P3')!
const finalCurrent = current.values.at(-1)!
assert.ok(finalCurrent > 0)
function firstCrossing(fraction: number) {
  const threshold = finalCurrent * fraction
  const index = current.values.findIndex(value => value >= threshold)
  assert.ok(index > 0, `No rising crossing at ${fraction}`)
  assert.ok(current.values[index - 1] < threshold)
  return { fraction, thresholdAmperes: threshold, sampleIndex: index, timeSeconds: solved.x[index], currentAmperes: current.values[index], previousTimeSeconds: solved.x[index - 1], previousCurrentAmperes: current.values[index - 1], sampleBracketSeconds: solved.x[index] - solved.x[index - 1] }
}
const a = firstCrossing(.1), b = firstCrossing(.9)
for (const diagram of setup.diagrams) diagram.view!.cursors = { a: a.timeSeconds, b: b.timeSeconds }
await tools.execute('configure_waveforms', { setup })
const candidate = tools.candidate
assert.deepEqual(candidate.drawing, original.drawing, 'Do not move or rewire this user circuit')
assert.deepEqual(candidate.probes, original.probes, 'Keep manual P2 anchor and every probe offset')
assert.deepEqual(candidate.models, original.models, 'Keep manufacturer model and source metadata')
assert.equal(JSON.stringify(original), preserved, 'Do not mutate baseline')
assert.equal(generateNetlist(candidate), generateNetlist(original), 'Solver inputs must remain byte-identical')
assert.equal(projectKey(candidate), projectKey(original))
assert.equal(tools.simulation?.stale, false, 'View-only cursor configuration must not invalidate solver result')
assert.deepEqual(waveformSetupIssues(candidate.waveformSetup, candidate), [])
assert.equal(candidate.waveformSetup!.diagrams.length, 2)
assert.ok(candidate.waveformSetup!.diagrams.every(diagram => diagram.view!.panels.length === 4))
assert.ok(!Object.hasOwn(candidate, 'x') && !JSON.stringify(candidate.waveformSetup).includes('resultId'))

const bounds = waveformXBounds(solved, null)
const { signals, unavailable } = waveformSignals(solved, candidate.probes)
assert.deepEqual(unavailable, [])
const esc = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
const plotStyle = `:root{--mono:Consolas,"Microsoft YaHei",monospace} .wave-grid{stroke:#e8ede7;stroke-width:1} .wave-axis{fill:#7c8c7a;font:10px Consolas,monospace} .wave-axis-unit{font-weight:600;fill:#526c51} .wave-cursor line{stroke-dasharray:5 3} .wave-cursor{font:11px Consolas,monospace} .wave-cursor-a{fill:#b87c25;stroke:#b87c25} .wave-cursor-b{fill:#9160b1;stroke:#9160b1} .wave-cursor text{stroke:none}`
const svgRoot = (width: number, height: number, contents: string, viewBox = `0 0 ${width} ${height}`) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}" font-family="Consolas,Microsoft YaHei,monospace"><style>${plotStyle}</style>${contents}</svg>`
const frames: string[] = []
const renderedPanels: unknown[] = []
for (const [diagramIndex, diagram] of candidate.waveformSetup!.diagrams.entries()) {
  const view = diagram.view!
  const snapshot: WaveformSnapshot = { resultId: solved.id, layout: view.layout, domain: view.domain, bounds,
    panels: view.panels.slice(0, view.layout).map(panel => ({ traces: waveformTraces(solved, null, signals, [], panel), primaryId: panel.primary })), cursors: view.cursors }
  const markup = renderToStaticMarkup(<CanvasWaveformPreview result={solved} snapshot={snapshot} showProbeTarget={false} />)
  const dom = new JSDOM(markup)
  const plots = [...dom.window.document.querySelectorAll<SVGElement>('svg.wave-plot')]
  assert.equal(plots.length, 2, 'Use both real component plots')
  // This wrapper supplies static headings only. All grids, axes, curves and cursor lines below
  // come from CanvasWaveformPreview / SignalPlot without generating substitute paths.
  let content = `<rect width="900" height="430" rx="12" fill="#fff" stroke="#cad8cf"/><text x="22" y="28" font-size="17" font-weight="700" fill="#263c34">${esc(diagram.title)}</text>`
  for (const [index, plot] of plots.entries()) {
    const y = 54 + index * 181
    const panelTraces = snapshot.panels[index].traces
    assert.equal(plot.querySelectorAll('[data-wave-trace]').length, panelTraces.length)
    const expectedStart = bounds[0] + (bounds[1] - bounds[0]) * view.domain[0]
    const expectedEnd = bounds[0] + (bounds[1] - bounds[0]) * view.domain[1]
    assert.ok(Math.abs(Number(plot.dataset.xStart) - expectedStart) < 1e-10)
    assert.ok(Math.abs(Number(plot.dataset.xEnd) - expectedEnd) < 1e-10)
    plot.setAttribute('x', '12'); plot.setAttribute('y', String(y)); plot.setAttribute('width', '876'); plot.setAttribute('height', '166')
    plot.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    plot.querySelectorAll('[id]').forEach(element => {
      const old = element.id, replacement = `${diagram.id}-${index}-${old}`
      element.id = replacement
      plot.querySelectorAll('[clip-path]').forEach(node => { if (node.getAttribute('clip-path') === `url(#${old})`) node.setAttribute('clip-path', `url(#${replacement})`) })
    })
    let legendX = 24
    for (const trace of panelTraces) {
      content += `<line x1="${legendX}" y1="${y - 9}" x2="${legendX + 22}" y2="${y - 9}" stroke="${trace.color}" stroke-width="3"/><text x="${legendX + 30}" y="${y - 5}" font-size="12" fill="#34483e">${esc(trace.name)} (${trace.unit})</text>`
      legendX += 270
    }
    content += plot.outerHTML
    renderedPanels.push({ diagramId: diagram.id, plot: index + 1, component: 'CanvasWaveformPreview / SignalPlot', traceIds: panelTraces.map(trace => trace.id), xStartSeconds: Number(plot.dataset.xStart), xEndSeconds: Number(plot.dataset.xEnd), cursorMarkers: plot.querySelectorAll('[data-wave-cursor]').length })
  }
  content += `<text x="22" y="421" font-size="11" fill="#6b7d71">A ${(a.timeSeconds * 1000).toFixed(3)} ms · B ${(b.timeSeconds * 1000).toFixed(3)} ms · Δt ${((b.timeSeconds - a.timeSeconds) * 1000).toFixed(3)} ms · 10%→90% 首跨采样估计</text>`
  const name = diagramIndex === 0 ? 'waveform-overview' : 'waveform-detail'
  const svg = svgRoot(900, 430, content)
  await save(`${name}.svg`, svg)
  await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL(`${name}.png`, directory)))
  frames.push(`<g data-waveform="${diagram.id}" transform="translate(${diagram.x} ${diagram.y})">${content}</g>`)
  dom.window.close()
}

const drawing = candidate.drawing!
const schematic = schematicSvg(drawing, { title: candidate.title, models: candidate.models, probes: candidate.probes })
const schematicDom = new JSDOM(schematic, { contentType: 'image/svg+xml' })
const schematicContent = schematicDom.window.document.querySelector('#schematic-content')!
schematicContent.removeAttribute('transform')
const objects: { id: string; rect: LayoutRect }[] = []
for (const device of drawing.devices) deviceLayoutObstacles(device).forEach((rect, index) => objects.push({ id: `${device.id}:${index}`, rect }))
for (const wire of drawing.wires) {
  const points = wirePoints(drawing, wire)
  objects.push({ id: wire.id, rect: { left: Math.min(...points.map(p => p.x)) - 3, right: Math.max(...points.map(p => p.x)) + 3, top: Math.min(...points.map(p => p.y)) - 3, bottom: Math.max(...points.map(p => p.y)) + 3 } })
}
for (const label of placeNetLabels(drawing)) objects.push({ id: label.label.id, rect: { left: label.point.x + label.x, right: label.point.x + label.x + label.width, top: label.point.y + label.y - 24, bottom: label.point.y + label.y + 3 } })
for (const marker of layoutProbeMarkers(drawing, measurementProbeMarkers(drawing, candidate.probes))) objects.push({ id: marker.label, rect: probeMarkerBounds(drawing, marker) })
const overlaps = (a: LayoutRect, b: LayoutRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const frameRects = candidate.waveformSetup!.diagrams.map(diagram => ({ id: diagram.id, rect: { left: diagram.x, top: diagram.y, right: diagram.x + diagram.width, bottom: diagram.y + diagram.height } }))
const collisions = frameRects.flatMap(frame => objects.filter(object => overlaps(frame.rect, object.rect)).map(object => ({ frame: frame.id, object: object.id })))
assert.deepEqual(collisions, [], 'Waveform frames must not overlap any existing circuit geometry or manual probes')
assert.equal(overlaps(frameRects[0].rect, frameRects[1].rect), false)
const circuitRight = Math.max(...objects.map(object => object.rect.right))
const canvas = svgRoot(2260, 1160, `<rect width="2260" height="1160" fill="#f4f7f3"/><text x="100" y="70" fill="#263c34" font-size="25" font-weight="700">原理图 + 实际 ngspice 波形</text><text x="100" y="103" font-size="15" fill="#62766b">revision ${baseline.revision} · 原电路 / P1–P3 位置完整保留 · 全程与启动细节 · 每图两 plot</text>${schematicContent.outerHTML}${frames.join('')}`)
await save('canvas-with-waveforms.svg', canvas)
await sharp(Buffer.from(canvas)).png().toFile(fileURLToPath(new URL('canvas-with-waveforms.png', directory)))
schematicDom.window.close()
const netlist = generateNetlist(candidate)
await save('unchanged-netlist.cir', netlist)
await json('configure-input.json', { setup: candidate.waveformSetup })
await json('candidate-project.json', candidate)
const summary = {
  engine: solved.engine, analysis: solved.analysis, points: solved.points, warnings: solved.warnings,
  stopSeconds: solved.x.at(-1), maximumRequestedStepSeconds: .0001, sharedResultForBothDiagrams: true,
  probeFinalValues: traces.map(trace => ({ id: trace.id, name: trace.name, kind: trace.kind, value: trace.values.at(-1) })),
  currentRiseEstimate: { source: 'P3 / I(R1)', method: 'First solver sample >= 10% / 90% of final sample current; no interpolation', finalCurrentAmperes: finalCurrent, a, b, deltaSeconds: b.timeSeconds - a.timeSeconds },
  agentSummary: tools.simulation,
}
await json('simulation-summary.json', summary)
await json('acceptance.json', {
  baselineRevision: baseline.revision, projectId: baseline.projectId, electricalNetlistIdentical: true,
  drawingIdentical: true, modelDefinitionsIdentical: true, probesIncludingOffsetsAndAnchorsIdentical: true,
  netlistSha256: createHash('sha256').update(netlist).digest('hex'), solverSamplesInProject: false,
  configurationAppliedThrough: 'configure_waveforms', solver: solved.engine, events, renderedPanels,
  geometry: { frameRects, circuitRight, horizontalClearance: 1280 - circuitRight, frameGap: 60, collisions, objects },
  detailCursorVisibility: { a: a.timeSeconds <= .15, b: b.timeSeconds <= .15 },
  validation: 'Actual ngspice + actual CanvasWaveformPreview SSR SVG/PNG. Static wrapper adds headings only. Browser automation rejected because administrator policy could not be verified; no browser or live-project verification claimed.',
})
const milli = (n: number) => (n * 1000).toFixed(3)
await save('summary.md', `# 缓启动波形配置候选\n\n基于工程 ${baseline.projectId} 的 revision ${baseline.revision}。保留原电路、2N7002 模型和 P1/P2/P3 的全部测量目标、锚点及偏移；P2 仍在 W7。候选尚未写入用户工程。\n\n- 瞬态配置：600 ms，最大步长 100 µs。两个图框位于 (1280,160)、(1280,650)，均为 900×430。\n- 全程窗口 0–600 ms；细节窗口 0–150 ms（归一化 domain 为 [0,0.25]，没有缩短求解时长）。\n- 每图两个 plot：上图 P1 Gate 与 P2 Drain 电压，下图 P3 的 R1 支路电流。每个 view 存储四条 panel 配置，layout=2。\n- ${solved.engine} 实际返回 ${solved.points} 个采样点；P3 最终电流 ${milli(finalCurrent)} mA。\n- A = ${milli(a.timeSeconds)} ms 为最终电流 10% 的首跨采样；B = ${milli(b.timeSeconds)} ms 为 90% 首跨采样；Δt = ${milli(b.timeSeconds - a.timeSeconds)} ms。这是最终负载电流的 10%→90% 上升时间，不等于 RC 时间常数。游标存物理秒值，属于采样估计；相邻样本区间分别 ${milli(a.sampleBracketSeconds)} / ${milli(b.sampleBracketSeconds)} ms，未宣称连续时间精确交点。\n\n图面采用 drawing-patterns.md §16：图框在原电路右侧，距保守电路/标牌边界 ${Math.round(1280 - circuitRight)} 个画布单位，两图间隔60，不移动电气节点腾空。网表逐字相同，Project 仅保存配置，没有求解器样本数组或运行 ID。\n\n[整页预览](canvas-with-waveforms.png) · [全程](waveform-overview.png) · [启动细节](waveform-detail.png) · [候选工程](candidate-project.json) · [仿真与游标采样](simulation-summary.json) · [验收证据](acceptance.json)\n\n图片来自实际 CanvasWaveformPreview / SignalPlot 的服务端 SVG 渲染，曲线、坐标、游标均为组件输出；导出外框仅补充标题和图例。浏览器自动化被管理员策略校验拒绝，因此这些是静态渲染与真实求解证据，不代表网页交互验收。\n\n重跑：先 npm run build，再 npx tsx scripts/prepare-waveform-setup-20260925.tsx。\n`)
console.log(JSON.stringify({ engine: solved.engine, points: solved.points, finalCurrentAmperes: finalCurrent, a, b, horizontalClearance: 1280 - circuitRight, artifacts: directory.pathname }, null, 2))
