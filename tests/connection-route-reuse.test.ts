import assert from 'node:assert/strict'
import test from 'node:test'
import { compileDrawing, createDrawingRenderCache, drawingNodeNames, emptyDrawing, rawWirePoints, wirePoints, type Drawing } from '../src/core/drawing'

function measuredDrawing(junctionCount: number, wireCount = 1) {
  const drawing = emptyDrawing()
  let rotationReads = 0
  for (let i = 0; i < wireCount; i++) {
    const y = i * 500
    drawing.devices.push(
      { id: `V${i + 1}`, kind: 'V', value: '5', x: 100, y: 200 + y, get rotation() { rotationReads++; return 0 as const } },
      { id: `R${i + 1}`, kind: 'R', value: '1k', x: 300, y: 300 + y, get rotation() { rotationReads++; return 0 as const } },
    )
    drawing.wires.push({ id: `W${i + 1}`, from: { device: `V${i + 1}`, pin: 1 }, to: { device: `R${i + 1}`, pin: 0 }, bend: 'hv' })
  }
  for (let i = 0; i < junctionCount; i++) drawing.junctions.push({ id: `J${i + 1}`, x: 1800, y: 100 + i * 20 })
  return { drawing, reads: () => rotationReads }
}

test('connection checking repairs each automatic wire once even with many junctions', t => {
  const single = measuredDrawing(1, 4), many = measuredDrawing(24, 4)
  const { drawing } = many
  const wire = drawing.wires[0]
  assert.notDeepEqual(wirePoints(drawing, wire), rawWirePoints(drawing, wire), 'the fixture must enter automatic route repair')
  const before = many.reads()
  const sample = measuredDrawing(24, 4)
  for (const candidate of sample.drawing.wires) wirePoints(sample.drawing, candidate)
  compileDrawing(single.drawing)
  compileDrawing(drawing)
  t.diagnostic(`pin rotation reads: one junction ${single.reads()}, 24 junctions ${many.reads() - before}, each route computed directly ${sample.reads()}`)
  assert.equal(many.reads() - before, sample.reads())
  assert.equal(single.reads(), sample.reads())
})

test('crossing wires remain separate and moved foreign junctions are checked against exact routes', () => {
  const drawing: Drawing = {
    ...emptyDrawing(),
    junctions: [
      { id: 'J1', x: 100, y: 200 }, { id: 'J2', x: 300, y: 200 },
      { id: 'J3', x: 200, y: 100 }, { id: 'J4', x: 200, y: 300 },
      { id: 'J5', x: 260, y: 200 }, { id: 'J6', x: 240, y: 200 }, { id: 'J7', x: 220, y: 200 },
    ],
    wires: [
      { id: 'W1', from: { junction: 'J1' }, to: { junction: 'J2' }, bend: 'hv' },
      { id: 'W2', from: { junction: 'J3' }, to: { junction: 'J4' }, bend: 'vh' },
    ],
    labels: [
      { id: 'N1', name: 'OUT', at: { junction: 'J1' } }, { id: 'N2', name: 'out', at: { junction: 'J7' } },
    ],
  }
  const checked = compileDrawing(drawing)
  assert.notEqual(checked.nodes.get('J1'), checked.nodes.get('J3'))
  assert.equal(checked.nodes.get('J1'), checked.nodes.get('J7'))
  const overlapIds = (errors: string[]) => errors.filter(error => error.includes('未连接导线重叠')).map(error => error.split(' ')[0])
  assert.deepEqual(overlapIds(checked.errors), ['J5', 'J6'])
  drawing.junctions[0].y += 40
  drawing.junctions[1].y += 40
  assert.deepEqual(overlapIds(compileDrawing(drawing).errors), [])
})

test('repeated compilation on one immutable snapshot does not rerun its checks', () => {
  const { drawing } = measuredDrawing(24)
  const cache = createDrawingRenderCache(), first = cache.snapshot(drawing)
  const compiled = compileDrawing(first)
  assert.equal(cache.readStats().routeComputations, 1)
  cache.resetStats()
  assert.deepEqual(compileDrawing(first), compiled)
  assert.equal(cache.readStats().routeHits, 0)
})

test('node names match full compilation without routing and callers cannot alter the cached map', () => {
  const { drawing, reads } = measuredDrawing(24, 4)
  const snapshot = createDrawingRenderCache().snapshot(drawing)
  const rawNames = drawingNodeNames(drawing), snapshotNames = drawingNodeNames(snapshot)
  assert.equal(reads(), 0)
  assert.deepEqual(snapshotNames, rawNames)
  snapshotNames.set('V1:1', 'changed-by-caller')
  const compiled = compileDrawing(snapshot)
  assert.deepEqual(compiled.nodes, rawNames)
  compiled.nodes.clear()
  compiled.errors.length = 0
  assert.deepEqual(compileDrawing(snapshot), compileDrawing(drawing))
})

test('replacing a routing obstacle rechecks overlap on the new immutable snapshot', () => {
  const { drawing } = measuredDrawing(0)
  drawing.junctions.push({ id: 'J1', x: 240, y: 260 })
  const cache = createDrawingRenderCache(), original = cache.snapshot(drawing)
  const changed: Drawing = { ...drawing, devices: [...drawing.devices, { id: 'R2', kind: 'R', value: '1k', x: 200, y: 200, rotation: 0 }] }
  const overlaps = (d: Drawing) => compileDrawing(d).errors.filter(error => error.includes('未连接导线重叠'))
  assert.equal(overlaps(original).length, 1)
  assert.deepEqual(overlaps(cache.snapshot(changed)), [])
  assert.equal(overlaps(cache.snapshot(drawing)).length, 1)
  assert.equal(cache.readStats().routeComputations, 2)
})
