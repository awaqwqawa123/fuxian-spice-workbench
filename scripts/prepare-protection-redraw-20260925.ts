import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { schematicSvg } from '../src/core/export-svg'
import { compileDrawing, wirePoints, terminalKey, type Device, type Drawing, type XY } from '../src/core/drawing'
import type { DesktopCircuitSnapshot } from '../src/core/desktop-circuit'
import { generateNetlist, parseProject, projectKey, validateProject } from '../src/core/circuit'
import assert from 'node:assert/strict'
import { agentDrawingGeometry } from '../src/core/agent-drawing-guidance'
import { deviceCaptionRects, placeNetLabels, type LayoutRect } from '../src/core/schematic-layout'

const directory = new URL('../docs/artifacts/2026-09-25-protection-redraw/', import.meta.url)
const snapshot: DesktopCircuitSnapshot = JSON.parse((await readFile(new URL('baseline-snapshot.json', directory), 'utf8')).replace(/^\uFEFF/, ''))
assert.equal(snapshot.projectId, '2bfea8f7-2a8b-4770-a96f-3714965cc578')
assert.equal(snapshot.revision, 2)
const baseline = snapshot.project
const svg = schematicSvg(baseline.drawing!, { title: '重排前 · ' + baseline.title, models: baseline.models, sourceSummary: 'PULSE · 0V → 5V' })
await writeFile(new URL('before.svg', directory), svg)
await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL('before.png', directory)))

// This is a reviewed arrangement of this exact circuit, not an auto-layout rule.
// Keep every wire identity and endpoint because current probes can refer to them.
const candidate = structuredClone(baseline)
const drawing = candidate.drawing!
const positions: Record<string, Pick<Device, 'x' | 'y' | 'rotation'>> = {
  V1: { x: 200, y: 340, rotation: 90 },
  D1: { x: 360, y: 200, rotation: 0 },
  R1: { x: 1000, y: 260, rotation: 90 },
  M1: { x: 980, y: 440, rotation: 0 },
  R2: { x: 500, y: 320, rotation: 90 },
  C1: { x: 500, y: 560, rotation: 270 },
  R3: { x: 320, y: 560, rotation: 90 },
  G1: { x: 500, y: 720, rotation: 0 },
}
const junctions: Record<string, XY> = {
  J1: { x: 500, y: 200 }, J2: { x: 500, y: 440 },
  J3: { x: 500, y: 660 }, J4: { x: 1000, y: 660 },
}
const paths: Record<string, XY[]> = {
  W1: [{ x: 200, y: 200 }],
  W2: [{ x: 1000, y: 200 }],
  W3: [], W4: [], W5: [], W6: [], W7: [], W8: [], W9: [],
  W10: [{ x: 200, y: 800 }, { x: 1000, y: 800 }],
  W11: [], W12: [],
  W13: [{ x: 320, y: 440 }],
  W14: [{ x: 320, y: 660 }],
  W15: [],
}
drawing.devices = drawing.devices.map(device => ({ ...device, ...positions[device.id] }))
drawing.junctions = drawing.junctions.map(junction => ({ ...junction, ...junctions[junction.id] }))
drawing.wires = drawing.wires.map(wire => {
  const points = paths[wire.id]
  assert.ok(points, `Explicit route missing for ${wire.id}`)
  const { waypoints: _previous, ...rest } = wire
  return { ...rest, ...(points.length ? { waypoints: points } : {}) }
})
parseProject(candidate)
assert.deepEqual(validateProject(candidate), [])
assert.equal(projectKey(candidate), projectKey(baseline), 'The layout-only agent gate must accept the complete candidate')
assert.equal(generateNetlist(candidate), generateNetlist(baseline), 'Netlist is byte-for-byte unchanged')
assert.deepEqual([...compileDrawing(drawing).nodes], [...compileDrawing(baseline.drawing!).nodes])
const stripGeometry = (source: Drawing) => ({ ...source,
  devices: source.devices.map(({ x, y, rotation, ...device }) => device),
  junctions: source.junctions.map(({ x, y, ...junction }) => junction),
  wires: source.wires.map(({ waypoints, bend, ...wire }) => wire),
})
assert.deepEqual({ ...candidate, drawing: stripGeometry(drawing) }, { ...baseline, drawing: stripGeometry(baseline.drawing!) })
await writeFile(new URL('candidate-project.json', directory), JSON.stringify(candidate, null, 2))
await writeFile(new URL('baseline-project.json', directory), JSON.stringify(baseline, null, 2))
const afterSvg = schematicSvg(drawing, { title: '重排后 · ' + candidate.title, models: candidate.models, sourceSummary: 'PULSE · 0V → 5V' })
await writeFile(new URL('after.svg', directory), afterSvg)
await sharp(Buffer.from(afterSvg)).png().toFile(fileURLToPath(new URL('after.png', directory)))
const intermediate = JSON.parse((await readFile(new URL('intermediate-project.json', directory), 'utf8')).replace(/^\uFEFF/, ''))
const intermediateSvg = schematicSvg(intermediate.drawing, { title: '原对话重画结果 · ' + intermediate.title, models: intermediate.models, sourceSummary: 'PULSE · 0V → 5V' })
await writeFile(new URL('intermediate.svg', directory), intermediateSvg)
await sharp(Buffer.from(intermediateSvg)).png().toFile(fileURLToPath(new URL('intermediate.png', directory)))

function bodyRect(device: Device): LayoutRect {
  const bounds: Record<string, [number, number, number, number]> = {
    R: [-24,-10,24,10], C: [-7,-22,7,22], D: [-18,-22,18,22],
    M: [-18,-24,20,24], V: [-25,-25,25,25], GND: [-18,14,18,28],
  }
  const [left,top,right,bottom] = bounds[device.kind]
  const angle = device.rotation*Math.PI/180
  const corners = [[left,top],[right,top],[right,bottom],[left,bottom]].map(([x,y]) => {
    const mx=x*(device.mirrored?-1:1)
    return { x:device.x+Math.round(mx*Math.cos(angle)-y*Math.sin(angle)), y:device.y+Math.round(mx*Math.sin(angle)+y*Math.cos(angle)) }
  })
  return { left:Math.min(...corners.map(p=>p.x)), right:Math.max(...corners.map(p=>p.x)), top:Math.min(...corners.map(p=>p.y)), bottom:Math.max(...corners.map(p=>p.y)) }
}
function hits(a:XY,b:XY,r:LayoutRect) {
  return a.x===b.x ? a.x>r.left&&a.x<r.right&&Math.max(Math.min(a.y,b.y),r.top)<Math.min(Math.max(a.y,b.y),r.bottom)
    : a.y===b.y ? a.y>r.top&&a.y<r.bottom&&Math.max(Math.min(a.x,b.x),r.left)<Math.min(Math.max(a.x,b.x),r.right) : true
}
function audit(source: Drawing) {
  const geom=agentDrawingGeometry(source), nets=compileDrawing(source).nodes
  const bodies=source.devices.map(device=>({id:device.id,rect:bodyRect(device)}))
  const captions=source.devices.flatMap(device=>deviceCaptionRects(device).map(rect=>({id:device.id,rect})))
  const labels=placeNetLabels(source).map(item=>({id:item.label.id,rect:{left:item.point.x+item.x,right:item.point.x+item.x+item.width,top:item.point.y+item.y-22,bottom:item.point.y+item.y}}))
  const segments=source.wires.flatMap(wire=>wirePoints(source,wire).slice(1).map((to,i)=>({wire:wire.id,net:nets.get(terminalKey(wire.from)),from:wirePoints(source,wire)[i],to})))
  const bodyHits=segments.flatMap(segment=>bodies.filter(body=>hits(segment.from,segment.to,body.rect)).map(body=>({wire:segment.wire,body:body.id})))
  const textHits=segments.flatMap(segment=>[...captions,...labels].filter(text=>hits(segment.from,segment.to,text.rect)).map(text=>({wire:segment.wire,text:text.id})))
  const exits=source.wires.flatMap(wire=>{
    const points=wirePoints(source,wire)
    return [[wire.from,points[0],points[1]],[wire.to,points.at(-1)!,points.at(-2)!]].flatMap(([terminal,p,q])=>{
      const at=terminal as typeof wire.from, from=p as XY, to=q as XY
      if(!('device' in at))return []
      const pin=geom.devices.find(device=>device.id===at.device)!.pins.find(pin=>pin.pin===at.pin)!
      const dx=to.x-from.x,dy=to.y-from.y,normal=pin.outward
      return dx*normal.x+dy*normal.y>0 && dx*normal.y-dy*normal.x===0 ? [] : [{wire:wire.id,terminal:terminalKey(at)}]
    })
  })
  const overlaps=[]
  for(let a=0;a<segments.length;a++)for(let b=a+1;b<segments.length;b++) {
    const x=segments[a],y=segments[b]
    const horizontal=x.from.y===x.to.y&&y.from.y===y.to.y&&x.from.y===y.from.y
    const vertical=x.from.x===x.to.x&&y.from.x===y.to.x&&x.from.x===y.from.x
    const span=horizontal?Math.min(Math.max(x.from.x,x.to.x),Math.max(y.from.x,y.to.x))-Math.max(Math.min(x.from.x,x.to.x),Math.min(y.from.x,y.to.x))
      :vertical?Math.min(Math.max(x.from.y,x.to.y),Math.max(y.from.y,y.to.y))-Math.max(Math.min(x.from.y,x.to.y),Math.min(y.from.y,y.to.y)):0
    if(span>0)overlaps.push({wires:[x.wire,y.wire],differentNet:x.net!==y.net,length:span})
  }
  return {
    devices:source.devices.length,wires:source.wires.length,junctions:source.junctions.length,
    bends:source.wires.reduce((sum,wire)=>sum+Math.max(0,wirePoints(source,wire).length-2),0),
    wireLength:segments.reduce((sum,{from,to})=>sum+Math.abs(from.x-to.x)+Math.abs(from.y-to.y),0),
    diagonalSegments:segments.filter(({from,to})=>from.x!==to.x&&from.y!==to.y).length,
    bodyHits,textHits,exits,overlaps,
  }
}
const report={baselineRevision:snapshot.revision,nonGeometricFieldsUnchanged:true,netlistByteIdentical:true,pinNetworksUnchanged:true,
  evidence:'Pure-function geometry checks and standalone SVG/PNG review; no browser interaction or waveform placement validation.',
  metricLimits:'Text checks use shared estimated device captions and net-label rectangles. They do not cover output-probe text or label leaders. VOUT symbol avoidance is covered separately by export-svg regression tests and actual PNG review.',
  baseline:audit(baseline.drawing!),intermediate:audit(intermediate.drawing),candidate:audit(drawing)}
assert.deepEqual(report.candidate.bodyHits, [])
assert.deepEqual(report.candidate.textHits, [])
assert.deepEqual(report.candidate.exits, [])
assert.deepEqual(report.candidate.overlaps, [])
assert.equal(report.candidate.diagonalSegments,0)
await writeFile(new URL('acceptance.json',directory),JSON.stringify(report,null,2))
console.log(JSON.stringify(report,null,2))
