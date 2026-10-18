import { pinsFor } from './devices'
import { pinPosition, wirePoints, type Drawing, type Terminal, type XY } from './drawing'
import { probePoint, wireProbeAngle, type WireAnchor } from './probe-placement'
import { measurementType, probeColors, type Measurement, type ProbeType } from './probes'
import { deviceLayoutObstacles, placeNetLabels } from './schematic-layout'
import { hasWireCurrentTarget } from './wire-currents'
import { netSymbolBounds } from './net-symbol-geometry'

export interface ProbeMarker {
  at: Terminal; label: string; color: string; anchor?: WireAnchor; offset?: XY
  selected?: boolean; type?: ProbeType; negative?: boolean; direction?: 1 | -1
  sharedTip?: boolean
  /** A legacy reference output is not a saved measurement. */
  reference?: boolean
}
export interface ProbeRect { left: number; top: number; right: number; bottom: number }
export interface ProbePlacementOptions { preserveOffsets?: boolean }
export const probeBadgeHeight = 36
export const probeBadgeWidth = (label: string) => Math.max(96, 61 + [...label].reduce((size, char) => size + (char.codePointAt(0)! > 255 ? 14 : 8.6), 0))
export const probeBadgeRect = (point: XY, offset: XY, label: string): ProbeRect => ({ left: point.x + offset.x, top: point.y + offset.y, right: point.x + offset.x + probeBadgeWidth(label), bottom: point.y + offset.y + probeBadgeHeight })
const overlaps = (a: ProbeRect, b: ProbeRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const grow = (r: ProbeRect, by: number): ProbeRect => ({ left: r.left - by, top: r.top - by, right: r.right + by, bottom: r.bottom + by })
const validOffset = (offset?: XY): offset is XY => !!offset && Number.isFinite(offset.x) && Number.isFinite(offset.y)
const validTerminal = (drawing: Drawing, at: Terminal) => 'device' in at ? drawing.devices.some(device => device.id === at.device && pinsFor(device).includes(at.pin)) : drawing.junctions.some(junction => junction.id === at.junction)

/** Converts actual measurements only; undefined uses a clearly identified legacy output reference. */
export function measurementProbeMarkers(drawing: Drawing, measurements?: readonly Measurement[]): ProbeMarker[] {
  if (measurements === undefined) return drawing.output && validTerminal(drawing, drawing.output) ? [{ at: drawing.output, label: 'OUT', type: 'voltage', color: '#b86b14', reference: true }] : []
  return measurements.flatMap((measurement, index): ProbeMarker[] => {
    const number = Number(measurement.id.slice(1)), color = probeColors[Number.isInteger(number) && number > 0 ? (number - 1) % probeColors.length : index % probeColors.length]
    const marker = (at: Terminal, label: string, layout?: { anchor?: WireAnchor; offset?: XY }): ProbeMarker => ({ at, label, color, type: measurementType(measurement), negative: label.endsWith('−'), anchor: layout?.anchor, offset: layout?.offset })
    if (measurement.kind === 'voltage') return [marker(measurement.positive, measurement.id + (measurement.negative ? '+' : ''), measurement.positiveLayout), ...(measurement.negative ? [marker(measurement.negative, measurement.id + '−', measurement.negativeLayout)] : [])].filter(item => validTerminal(drawing, item.at))
    if (measurement.wire) {
      if (!hasWireCurrentTarget(drawing, measurement.wire)) return []
      const anchor = measurement.layout?.anchor?.wireId === measurement.wire.wireId ? measurement.layout.anchor : { wireId: measurement.wire.wireId, fraction: .5 }
      return [{ ...marker(measurement.wire.from, measurement.id, { ...measurement.layout, anchor }), direction: measurement.wire.direction }]
    }
    return validTerminal(drawing, { device: measurement.device, pin: 0 }) ? [marker({ device: measurement.device, pin: 0 }, measurement.id, measurement.layout)] : []
  })
}

export function probeCurrentAngle(drawing: Drawing, marker: ProbeMarker): number {
  if (marker.anchor) return wireProbeAngle(drawing, marker.anchor, marker.direction ?? 1)
  const device = 'device' in marker.at ? drawing.devices.find(device => device.id === (marker.at as { device: string }).device) : undefined
  if (!device || pinsFor(device).length < 2) return 0
  const from = pinPosition(device, 0), to = pinPosition(device, 1)
  return Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI
}

/** Leader ends at the nearest badge edge; the tip itself always stays on the measured conductor. */
export function probeLeaderPoints(offset: XY, width: number): XY[] {
  const center = { x: offset.x + width / 2, y: offset.y + probeBadgeHeight / 2 }
  if (offset.x > 12 || offset.x + width < -12) {
    const end = { x: offset.x > 0 ? offset.x : offset.x + width, y: center.y }
    return [{ x: Math.sign(end.x) * 14, y: 0 }, { x: end.x - Math.sign(end.x) * 12, y: 0 }, { x: end.x - Math.sign(end.x) * 12, y: end.y }, end]
  }
  const end = { x: center.x, y: offset.y > 0 ? offset.y : offset.y + probeBadgeHeight }
  return [{ x: 0, y: Math.sign(end.y) * 14 }, { x: 0, y: end.y - Math.sign(end.y) * 12 }, { x: end.x, y: end.y - Math.sign(end.y) * 12 }, end]
}
export const probeLeaderPath = (offset: XY, width: number) => probeLeaderPoints(offset, width).filter((point, index, points) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y).map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')
const segmentRects = (points: XY[], padding = 2): ProbeRect[] => points.slice(1).map((b, i) => ({ left: Math.min(points[i].x, b.x) - padding, top: Math.min(points[i].y, b.y) - padding, right: Math.max(points[i].x, b.x) + padding, bottom: Math.max(points[i].y, b.y) + padding }))

/** Shared deterministic placement for the editable canvas, previews and standalone exports. */
export function layoutProbeMarkers(drawing: Drawing, markers: readonly ProbeMarker[], { preserveOffsets = true }: ProbePlacementOptions = {}): ProbeMarker[] {
  const valid = markers.filter(marker => validTerminal(drawing, marker.at) && (!marker.anchor || drawing.wires.some(wire => wire.id === marker.anchor!.wireId)))
  if(!valid.length)return []
  const points=valid.map(marker=>probePoint(drawing,marker.at,marker.anchor))
  const sharedTips=valid.map((marker,index)=>valid.some((other,otherIndex)=>other!==marker&&(other.type==='current'||marker.type==='current')&&Math.hypot(points[otherIndex].x-points[index].x,points[otherIndex].y-points[index].y)<.01))
  // Manual badges only need their exact anchors and shared-tip state. Scanning
  // the entire circuit for placement obstacles cannot change their offsets.
  if(preserveOffsets&&valid.every(marker=>validOffset(marker.offset)))return valid.map((marker,index)=>({...marker,sharedTip:sharedTips[index]}))
  const body = drawing.devices.flatMap(device => deviceLayoutObstacles(device, 5))
  const labels = placeNetLabels(drawing).map(({ label, point, x, y, width }) => {
    if (label.style && label.style !== 'text') {
      const bounds = netSymbolBounds(label.name, label.style, label.rotation)
      return grow({ left: point.x + bounds.left, top: point.y + bounds.top, right: point.x + bounds.right, bottom: point.y + bounds.bottom }, 4)
    }
    return { left: point.x + x - 4, top: point.y + y - 26, right: point.x + x + width + 4, bottom: point.y + y + 4 }
  })
  const wires = drawing.wires.flatMap(wire => segmentRects(wirePoints(drawing, wire), 5))
  const tips = points.map(p => ({ left: p.x - 24, top: p.y - 32, right: p.x + 25, bottom: p.y + 24 }))
  // Reserve every manual badge first, even when it is later in the list.
  const occupied = preserveOffsets ? valid.filter(marker => validOffset(marker.offset)).map(marker => grow(probeBadgeRect(probePoint(drawing, marker.at, marker.anchor), marker.offset!, marker.label), 8)) : []
  return valid.map((marker,index) => {
    const sharedTip = sharedTips[index]
    if (preserveOffsets && validOffset(marker.offset)) return { ...marker, sharedTip }
    const point = points[index], width = probeBadgeWidth(marker.label)
    const candidates: XY[] = []
    for (const distance of [28, 48, 80, 120, 180, 260, 360, 500]) {
      candidates.push({ x: distance, y: -probeBadgeHeight - distance }, { x: -width - distance, y: -probeBadgeHeight - distance }, { x: distance, y: distance }, { x: -width - distance, y: distance }, { x: -width / 2, y: -probeBadgeHeight - distance }, { x: -width / 2, y: distance }, { x: distance, y: -probeBadgeHeight / 2 }, { x: -width - distance, y: -probeBadgeHeight / 2 })
    }
    const score = (offset: XY) => {
      const rect = probeBadgeRect(point, offset, marker.label), leader = segmentRects(probeLeaderPoints(offset, width).map(p => ({ x: p.x + point.x, y: p.y + point.y })), 1)
      const collision = [...body, ...labels, ...occupied, ...tips, ...wires].filter(obstacle => overlaps(rect, obstacle)).length
      // Attachments may begin inside pin lead bounds; penalize only the farther leader segments.
      const leaderCrossings = leader.slice(1).reduce((sum, segment) => sum + [...body, ...labels, ...occupied].filter(obstacle => overlaps(segment, obstacle)).length, 0)
      return collision * 100000 + leaderCrossings * 200 + Math.hypot(offset.x + width / 2, offset.y + probeBadgeHeight / 2)
    }
    let offset = candidates[0], best = Infinity
    for (const candidate of candidates) { const value = score(candidate); if (value < best) { offset = candidate; best = value } }
    occupied.push(grow(probeBadgeRect(point, offset, marker.label), 8))
    return { ...marker, offset, sharedTip }
  })
}

/** Saves only visual offsets; node/branch identity and exact tip anchors never change. */
export function autoPlaceMeasurementProbes(drawing: Drawing, measurements: readonly Measurement[], options: ProbePlacementOptions = {}): Measurement[] {
  const markers = new Map(layoutProbeMarkers(drawing, measurementProbeMarkers(drawing, measurements), options).map(marker => [marker.label, marker]))
  return measurements.map(measurement => {
    if (measurement.kind === 'current') { const marker = markers.get(measurement.id); return marker ? { ...measurement, layout: { ...measurement.layout, ...(marker.anchor ? { anchor: marker.anchor } : {}), offset: marker.offset } } : measurement }
    const positive = markers.get(measurement.id + (measurement.negative ? '+' : '')), negative = measurement.negative ? markers.get(measurement.id + '−') : undefined
    return { ...measurement, ...(positive ? { positiveLayout: { ...measurement.positiveLayout, offset: positive.offset } } : {}), ...(negative ? { negativeLayout: { ...measurement.negativeLayout, offset: negative.offset } } : {}) }
  })
}

/** Bounds include tip artwork, full labels and leaders, so exported probes are never cropped. */
export function probeMarkerBounds(drawing: Drawing, marker: ProbeMarker): ProbeRect {
  const point = probePoint(drawing, marker.at, marker.anchor), badge = probeBadgeRect(point, marker.offset ?? { x: 28, y: -64 }, marker.label)
  return { left: Math.min(point.x - 32, badge.left - 3), top: Math.min(point.y - 34, badge.top - 3), right: Math.max(point.x + 32, badge.right + 3), bottom: Math.max(point.y + 32, badge.bottom + 3) }
}
