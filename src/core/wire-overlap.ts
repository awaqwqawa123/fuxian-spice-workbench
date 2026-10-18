import { MAX_WIRE_WAYPOINTS, nextId, sameTerminal, simplifyWirePoints, terminalKey, wirePoints, type Drawing, type Terminal, type Wire, type XY } from './drawing'
import type { WireAnchor, ProbeLayout } from './probe-placement'
import type { Measurement } from './probes'
import { hasWireCurrentTarget, wireCurrentCut } from './wire-currents'

/** Fractions follow the source wire's from → to direction. A descending target
 * interval reverses that direction. An old wire may become several branches. */
export interface WireOverlapSpan {
  wireId: string
  sourceStart: number
  sourceEnd: number
  targetStart: number
  targetEnd: number
}
export interface WireOverlapResult {
  source: Drawing
  drawing: Drawing
  changed: boolean
  mergedSegments: number
  wireMap: Record<string, WireOverlapSpan[]>
  terminalMap: Record<string, Terminal>
}
export interface WireOverlapOptions {
  /** Geometry edits retain explicit endpoints and wire identities, even at overlaps. */
  preserveConnections?: boolean
  /** New conductors can merge their own overlaps without joining older overlaps elsewhere. */
  mergeWireIds?: ReadonlySet<string>
}
interface Segment { wire: Wire; a: XY; b: XY; start: number; length: number; horizontal: boolean; low: number; high: number }
interface Contributor { wireId: string; start: number; end: number; forward: boolean }
interface Edge { a: string; b: string; points: XY[]; contributors: Contributor[] }
const distance = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y)
const epsilon = 1e-9

/** Coalesce actual positive-length collinear overlap. Shared spans are real
 * conductors, with branch vertices where necessary. Perpendicular crossings
 * and coincident endpoints without a shared span do not create connections.
 * Call at an edit transaction boundary, never on every drag frame. */
export function normalizeWireOverlaps(source: Drawing, options: WireOverlapOptions = {}): WireOverlapResult {
  const result: WireOverlapResult = { source, drawing: source, changed: false, mergedSegments: 0, wireMap: {}, terminalMap: {} }
  const identity = (wire: Wire): WireOverlapSpan[] => [{ wireId: wire.id, sourceStart: 0, sourceEnd: 1, targetStart: 0, targetEnd: 1 }]
  if (options.preserveConnections) {
    for (const wire of source.wires) result.wireMap[wire.id] = identity(wire)
    return result
  }
  const groups = new Map<string, Segment[]>(), totals = new Map<string, number>()
  const positions = new Map<string, XY>(), terminals = new Map<string, Terminal>(), parent = new Map<string, string>()
  const node = (key: string, point: XY, terminal?: Terminal) => {
    if (!parent.has(key)) { parent.set(key, key); positions.set(key, point); if (terminal) terminals.set(key, terminal) }
    return key
  }
  const root = (key: string): string => { const p = parent.get(key)!; if (p === key) return key; const r = root(p); parent.set(key, r); return r }
  const union = (a: string, b: string) => { parent.set(root(b), root(a)) }
  for (const wire of source.wires) {
    result.wireMap[wire.id] = identity(wire)
    const points = wirePoints(source, wire)
    let along = 0
    node(`t:${terminalKey(wire.from)}`, points[0], wire.from)
    node(`t:${terminalKey(wire.to)}`, points.at(-1)!, wire.to)
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index], length = distance(a, b), horizontal = a.y === b.y
      if (!length) continue
      const start = horizontal ? a.x : a.y, stop = horizontal ? b.x : b.y
      const key = `${horizontal ? 'h' : 'v'}:${horizontal ? a.y : a.x}`
      const segment = { wire, a, b, start: along, length, horizontal, low: Math.min(start, stop), high: Math.max(start, stop) }
      const group = groups.get(key) ?? []; group.push(segment); groups.set(key, group)
      along += length
    }
    totals.set(wire.id, along)
  }
  const edges: Edge[] = [], affected = new Set<string>()
  const pointNode = (segment: Segment, value: number) => {
    const point = segment.horizontal ? { x: value, y: segment.a.y } : { x: segment.a.x, y: value }
    const along = segment.start + distance(segment.a, point), total = totals.get(segment.wire.id)!
    const terminal = along === 0 ? segment.wire.from : along === total ? segment.wire.to : undefined
    return { point, along, key: node(terminal ? `t:${terminalKey(terminal)}` : `p:${segment.wire.id}:${along}`, point, terminal) }
  }
  for (const segments of groups.values()) {
    // Split at all collinear segment bounds. Extra degree-two split vertices
    // disappear when paths are rebuilt, so unrelated manual routes stay intact.
    const bounds = [...new Set(segments.flatMap(segment => [segment.low, segment.high]))].sort((a, b) => a - b)
    const atoms = new Map<string, Edge[]>()
    for (const segment of segments) {
      const cuts = bounds.filter(value => value >= segment.low && value <= segment.high)
      for (let index = 1; index < cuts.length; index++) {
        const low = pointNode(segment, cuts[index - 1]), high = pointNode(segment, cuts[index])
        const forward = low.along < high.along
        const edge: Edge = { a: low.key, b: high.key, points: [low.point, high.point], contributors: [{ wireId: segment.wire.id, start: Math.min(low.along, high.along), end: Math.max(low.along, high.along), forward }] }
        const key = `${cuts[index - 1]}:${cuts[index]}`, list = atoms.get(key) ?? []; list.push(edge); atoms.set(key, list)
      }
    }
    for (const copies of atoms.values()) {
      if (options.mergeWireIds && !copies.some(copy => copy.contributors.some(contributor => options.mergeWireIds!.has(contributor.wireId)))) {
        // An unrelated new conductor must not reconnect older geometry-only
        // overlaps. Keep each edge's vertices and contributors independent.
        edges.push(...copies)
        continue
      }
      const edge = copies[0]
      if (copies.length > 1) {
        result.mergedSegments += copies.length - 1
        for (const copy of copies) { union(edge.a, copy.a); union(edge.b, copy.b); for (const contributor of copy.contributors) affected.add(contributor.wireId) }
        edge.contributors = copies.flatMap(copy => copy.contributors)
      }
      edges.push(edge)
    }
  }
  if (!affected.size) return result

  const terminalGroups = new Map<string, Terminal[]>()
  for (const [key, terminal] of terminals) { const id = root(key), group = terminalGroups.get(id) ?? []; group.push(terminal); terminalGroups.set(id, group) }
  const canonical = new Map<string, Terminal>(), removedJunctions = new Set<string>(), junctions = [...source.junctions]
  const extraPinLinks: { from: Terminal; to: Terminal }[] = []
  for (const [key, members] of terminalGroups) {
    // Device pins can never be aliased away: each remains a real SPICE pin.
    // A second coincident pin gets an explicit zero-length ideal connection.
    const chosen = members.find(t => 'device' in t) ?? members[0]
    canonical.set(key, chosen)
    for (const terminal of members) {
      if (sameTerminal(terminal, chosen)) continue
      if ('junction' in terminal) { result.terminalMap[terminalKey(terminal)] = chosen; removedJunctions.add(terminal.junction) }
      else extraPinLinks.push({ from: chosen, to: terminal })
    }
  }
  const mappedTerminal = (terminal: Terminal) => result.terminalMap[terminalKey(terminal)] ?? terminal
  const untouched = source.wires.filter(wire => !affected.has(wire.id)).flatMap(wire => {
    const from = mappedTerminal(wire.from), to = mappedTerminal(wire.to)
    // joinAtWire can leave a zero-length link between duplicate junction IDs.
    // Once those exact endpoints coalesce, the link no longer has an edge.
    if (!sameTerminal(wire.from, wire.to) && sameTerminal(from, to) && totals.get(wire.id) === 0) { result.wireMap[wire.id] = []; return [] }
    return [sameTerminal(from, wire.from) && sameTerminal(to, wire.to) ? wire : { ...wire, from, to }]
  })
  const selectedEdges = edges.filter(edge => edge.contributors.some(c => affected.has(c.wireId)))
  const adjacency = new Map<string, number[]>()
  selectedEdges.forEach((edge, index) => {
    edge.a = root(edge.a); edge.b = root(edge.b)
    for (const key of [edge.a, edge.b]) { const list = adjacency.get(key) ?? []; list.push(index); adjacency.set(key, list) }
  })
  const endpoint = (key: string) => {
    const existing = canonical.get(key)
    if (existing) return existing
    const id = nextId('J', junctions), terminal = { junction: id }, point = positions.get(key)!
    junctions.push({ id, ...point }); canonical.set(key, terminal); return terminal
  }
  const stopAt = (key: string) => canonical.has(key) || adjacency.get(key)?.length !== 2
  const reservedIds = source.wires.map(wire => ({ id: wire.id })), usedIds = new Set(untouched.map(wire => wire.id)), visited = new Set<number>()
  const rebuilt: Wire[] = []
  for (const id of affected) result.wireMap[id] = []
  const walk = (start: string, first: number) => {
    let current = start, index = first
    const path: XY[] = [positions.get(current)!]
    const contributions: { contributor: Contributor; targetStart: number; targetEnd: number }[] = []
    let length = 0
    while (!visited.has(index)) {
      visited.add(index)
      const edge = selectedEdges[index], forward = edge.a === current, next = forward ? edge.b : edge.a, points = forward ? edge.points : [...edge.points].reverse(), size = distance(points[0], points[1])
      path.push(points[1])
      for (const contributor of edge.contributors) {
        const sameDirection = contributor.forward === forward
        contributions.push({ contributor, targetStart: length + (sameDirection ? 0 : size), targetEnd: length + (sameDirection ? size : 0) })
      }
      length += size; current = next
      if (stopAt(current)) break
      const nextIndex = adjacency.get(current)!.find(candidate => !visited.has(candidate))
      if (nextIndex === undefined) break
      index = nextIndex
    }
    const from = endpoint(start), to = endpoint(current), route = simplifyWirePoints(path)
    const candidate = contributions.map(c => c.contributor.wireId).find(id => !usedIds.has(id))
    const id = candidate ?? nextId('W', reservedIds)
    usedIds.add(id); if (!candidate) reservedIds.push({ id })
    const wire: Wire = { id, from, to, bend: route[0].y === route[1]?.y ? 'hv' : 'vh', ...(route.length > 2 ? { waypoints: route.slice(1, -1) } : {}) }
    if ((wire.waypoints?.length ?? 0) > MAX_WIRE_WAYPOINTS) throw new Error('合并重叠导线后拐点过多，请先简化走线。')
    rebuilt.push(wire)
    for (const { contributor, targetStart, targetEnd } of contributions) result.wireMap[contributor.wireId].push({ wireId: id, sourceStart: contributor.start / totals.get(contributor.wireId)!, sourceEnd: contributor.end / totals.get(contributor.wireId)!, targetStart: targetStart / length, targetEnd: targetEnd / length })
  }
  for (const [key, indexes] of adjacency) if (stopAt(key)) for (const index of indexes) if (!visited.has(index)) walk(key, index)
  // Closed routed loops can have no branch vertices. Preserve them as explicit
  // closed conductors; the current solver correctly reports their ambiguity.
  selectedEdges.forEach((edge, index) => { if (!visited.has(index)) { endpoint(edge.a); walk(edge.a, index) } })
  for (const link of extraPinLinks) { const id = nextId('W', reservedIds); reservedIds.push({ id }); rebuilt.push({ id, ...link, bend: 'hv' }) }
  const drawing: Drawing = { ...source, junctions: junctions.filter(j => !removedJunctions.has(j.id)), wires: [...untouched, ...rebuilt], ...(source.labels ? { labels: source.labels.map(label => ({ ...label, at: mappedTerminal(label.at) })) } : {}), output: source.output ? mappedTerminal(source.output) : null }
  if (drawing.wires.length > 200 || drawing.junctions.length > 100) throw new Error('合并重叠导线会超过 200 段导线或 100 个连接点，请先简化走线。')
  for (const spans of Object.values(result.wireMap)) spans.sort((a, b) => a.sourceStart - b.sourceStart)
  result.changed = true; result.drawing = drawing
  return result
}

export function remapOverlapTerminal(result: WireOverlapResult, terminal: Terminal): Terminal {
  return result.terminalMap[terminalKey(terminal)] ?? terminal
}
function anchorCandidates(result: WireOverlapResult, anchor: WireAnchor) {
  if (!Number.isFinite(anchor.fraction)) return []
  const fraction = Math.max(0, Math.min(1, anchor.fraction)), candidates: { anchor: WireAnchor; direction: 1 | -1 }[] = []
  for (const span of result.wireMap[anchor.wireId] ?? []) {
    if (fraction < span.sourceStart - epsilon || fraction > span.sourceEnd + epsilon) continue
    const t = Math.max(0, Math.min(1, (fraction - span.sourceStart) / (span.sourceEnd - span.sourceStart)))
    const mapped = { wireId: span.wireId, fraction: span.targetStart + (span.targetEnd - span.targetStart) * t }, direction = span.targetEnd >= span.targetStart ? 1 : -1
    if (!candidates.some(candidate => candidate.anchor.wireId === mapped.wireId && Math.abs(candidate.anchor.fraction - mapped.fraction) < epsilon && candidate.direction === direction)) candidates.push({ anchor: mapped, direction })
  }
  return candidates
}
export function remapOverlapAnchor(result: WireOverlapResult, anchor: WireAnchor, requireUnique = false): WireAnchor | null {
  const candidates = anchorCandidates(result, anchor)
  return !candidates.length || requireUnique && candidates.length !== 1 ? null : candidates[0].anchor
}
/** Keep clamp location and physical arrow direction, never guess which side of
 * a new branch it measured. Voltage probes may share any equivalent branch. */
export function remapOverlapMeasurements(result: WireOverlapResult, measurements: Measurement[]): { measurements: Measurement[]; notices: string[] } {
  if (!result.changed) return { measurements, notices: [] }
  const notices: string[] = [], mapped: Measurement[] = []
  const layout = (value: ProbeLayout | undefined): ProbeLayout | undefined => {
    if (!value?.anchor) return value
    const anchor = remapOverlapAnchor(result, value.anchor)
    return anchor ? { ...value, anchor } : value.offset ? { offset: value.offset } : undefined
  }
  for (const measurement of measurements) {
    if (measurement.kind === 'voltage') { mapped.push({ ...measurement, positive: remapOverlapTerminal(result, measurement.positive), ...(measurement.negative ? { negative: remapOverlapTerminal(result, measurement.negative) } : {}), ...(measurement.positiveLayout ? { positiveLayout: layout(measurement.positiveLayout) } : {}), ...(measurement.negativeLayout ? { negativeLayout: layout(measurement.negativeLayout) } : {}) }); continue }
    if (!measurement.wire) { mapped.push(measurement); continue }
    if (!hasWireCurrentTarget(result.source, measurement.wire)) { notices.push(`${measurement.id} 的旧导线已改变，请重新放置电流探针。`); continue }
    const spans = result.wireMap[measurement.wire.wireId] ?? []
    const anchor = measurement.layout?.anchor
    const unambiguousUnanchored = new Set(spans.map(span => `${span.wireId}:${span.targetEnd >= span.targetStart ? 1 : -1}`)).size === 1
    const candidates = anchor?.wireId === measurement.wire.wireId ? anchorCandidates(result, anchor) : unambiguousUnanchored ? anchorCandidates(result, { wireId: measurement.wire.wireId, fraction: .5 }) : []
    if (candidates.length !== 1) { notices.push(`${measurement.id} 位于合并后的分支点，无法确定原电流方向；请在所需线段重新放置。`); continue }
    const candidate = candidates[0], wire = result.drawing.wires.find(wire => wire.id === candidate.anchor.wireId)!
    const target = { wireId: wire.id, from: wire.from, to: wire.to, direction: measurement.wire.direction * candidate.direction as 1 | -1 }, cut = wireCurrentCut(result.drawing, target)
    if (!cut.ok) { notices.push(`${measurement.id}：${cut.reason}`); continue }
    mapped.push({ ...measurement, wire: target, layout: { ...measurement.layout, anchor: candidate.anchor } })
  }
  return { measurements: mapped, notices }
}
