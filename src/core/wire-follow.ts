import { DRAWING_BOUNDS, MAX_WIRE_WAYPOINTS, simplifyWirePoints, terminalKey, terminalPosition, wirePoints, type Drawing, type Terminal, type Wire, type XY } from './drawing'
import { initialWireBend } from './wire-routing'
import { followsLead, leadCaptionObstacles, routeLeadPath, routeOverlapsWires, routeRetraces, segmentEntersBody, symbolBodyRect, terminalLeadDirection } from './wire-lead-route'

const equal = (a: XY, b: XY) => a.x === b.x && a.y === b.y
const horizontal = (a: XY, b: XY) => a.y === b.y
const orientationChanged=(before:Drawing,after:Drawing,terminal:Terminal)=>{
  if(!('device' in terminal))return false
  const old=before.devices.find(d=>d.id===terminal.device),next=after.devices.find(d=>d.id===terminal.device)
  return old?.rotation!==next?.rotation||!!old?.mirrored!==!!next?.mirrored
}

function followConstrainedLead(after:Drawing,wire:Wire,end:'from'|'to',path:XY[]):XY[] {
  const terminal=wire[end],at=terminalPosition(after,terminal),direction=terminalLeadDirection(after,terminal)
  const part='device' in terminal?after.devices.find(device=>device.id===terminal.device):undefined
  const body=part?symbolBodyRect(part):undefined
  const localObstacles=[...(body?[body]:[]),...leadCaptionObstacles(after,wire.id)]
  // Try the nearest old corner first. Only consume further corners if rotation
  // placed them inside the new body or leaves the retained span crossing it.
  for(let index=1;index<path.length;index++){
    const tail=path.slice(index),fixed=index===path.length-1,other=wire[end==='from'?'to':'from']
    if(tail.slice(1).some((point,i)=>localObstacles.some(rect=>segmentEntersBody(tail[i],point,rect))))continue
    const connector=routeLeadPath(after,at,tail[0],direction,fixed?terminalLeadDirection(after,other):undefined,wire.bend,wire.id)
    if(!connector)continue
    const combined=simplifyWirePoints([...connector,...tail.slice(1)])
    if(combined.length<2||!followsLead(at,combined[1],direction))continue
    if(routeRetraces(combined))continue
    if(routeOverlapsWires(after,combined,wire.id))continue
    if(combined.slice(1).some((point,i)=>localObstacles.some(rect=>segmentEntersBody(combined[i],point,rect))))continue
    return combined
  }
  throw new Error(`${wire.id} 变换后的引脚通道无法避开器件本体、位号/数值或已有导线，请先拉开器件间距或调整走线。`)
}

/** Stretch the lead nearest a moving terminal, independently of wire storage direction.
 * Interior routing and the fixed electrical endpoint are anchors, not translated geometry.
 */
function followWireEndpoint(before: Drawing, after: Drawing, wire: Wire, end: 'from' | 'to', original: XY[]): XY[] {
  const terminal = wire[end], current = terminalPosition(after, terminal), old = terminalPosition(before, terminal)
  const turned = (t: Terminal) => orientationChanged(before,after,t)
  if (equal(current, old) && (!turned(terminal) || original.length < 2)) return original
  const path = end === 'from' ? original : original.slice().reverse()
  if(turned(terminal)){
    const route=followConstrainedLead(after,wire,end,path)
    return end==='from'?route:route.reverse()
  }
  const fixed = path.at(-1)!
  const oldHorizontal = path.length > 1 ? horizontal(path[0], path[1]) : wire.bend === 'hv'
  const leadHorizontal = !wire.waypoints?.length
    ? initialWireBend(after, terminal, oldHorizontal ? 'hv' : 'vh') === 'hv'
    : oldHorizontal
  let route: XY[]
  if (path.length >= 3 && leadHorizontal === oldHorizontal) {
    // The first elbow slides along the next span. Later corners remain untouched.
    const elbow = leadHorizontal ? { x: path[1].x, y: current.y } : { x: current.x, y: path[1].y }
    route = [current, elbow, ...path.slice(2, -1), fixed]
  } else {
    // A previously straight wire has no body to preserve; otherwise keep the
    // remaining user-routed body in place.
    const keepBody = path.length >= 3 && !!wire.waypoints?.length
    const anchor = keepBody ? path[1] : fixed
    const corner = leadHorizontal ? { x: anchor.x, y: current.y } : { x: current.x, y: anchor.y }
    route = [current, corner, anchor, ...(keepBody ? [...path.slice(2, -1), fixed] : [])]
  }
  route=simplifyWirePoints(route)
  return simplifyWirePoints(end === 'from' ? route : route.slice().reverse())
}

/** Update both ends of a component lead against the current path. Explicitly
 * dragging a junction alone keeps its existing wire bend and routing behavior.
 */
export function followWireEndpoints(before: Drawing, after: Drawing, wire: Wire, selected: ReadonlySet<string>): Wire {
  const changed = (terminal: Terminal) => !equal(terminalPosition(before, terminal), terminalPosition(after, terminal)) || orientationChanged(before,after,terminal)
  if (![wire.from, wire.to].some(terminal => changed(terminal) && ('device' in terminal || !selected.has(terminal.junction)))) return wire
  const original = wirePoints(before, wire)
  let route = original
  route = followWireEndpoint(before, after, wire, 'from', route)
  route = followWireEndpoint(before, after, wire, 'to', route)
  // Both ends may move together or collapse onto the same anchor. Check lead
  // clearance only after both updates, rather than routing toward an old end.
  for (const end of ['from','to'] as const) {
    const terminal=wire[end],direction=terminalLeadDirection(after,terminal)
    if(!changed(terminal)||!direction||route.length<2||original.length<2)continue
    const path=end==='from'?route:route.slice().reverse()
    const old=end==='from'?original:original.slice().reverse()
    if(followsLead(old[0],old[1],terminalLeadDirection(before,terminal))&&!followsLead(path[0],path[1],direction)){
      const repaired=followConstrainedLead(after,wire,end,path)
      route=end==='from'?repaired:repaired.reverse()
    }
  }
  const waypoints = route.slice(1, -1)
  if (waypoints.length > MAX_WIRE_WAYPOINTS) throw new Error('移动后导线拐点过多，请先简化走线。')
  if (waypoints.some(p => p.x < DRAWING_BOUNDS.min || p.x > DRAWING_BOUNDS.max || p.y < DRAWING_BOUNDS.min || p.y > DRAWING_BOUNDS.max)) throw new Error('移动后的导线会超出画布，请先把器件移向画布中央。')
  const next: Wire = { ...wire, bend: route.length > 1 && horizontal(route[0], route[1]) ? 'hv' : 'vh' }
  if (waypoints.length && (wire.waypoints?.length || route.length > 3)) next.waypoints = waypoints
  else delete next.waypoints
  return next
}

/** Clicked corners are degree-two junctions, not fixed branch anchors. Slide only
 * those lying on a moving pin's first lead, up to and including its first elbow.
 * Coordinates change; every wire, junction, label and probe reference is retained.
 */
export function followLeadJunctions(before: Drawing, after: Drawing, selected: ReadonlySet<string>): Drawing {
  if(!before.junctions.length)return after
  const incident = new Map<string, Wire[]>()
  for (const wire of before.wires) for (const end of [wire.from, wire.to]) {
    const key = terminalKey(end), list = incident.get(key) ?? []
    list.push(wire); incident.set(key, list)
  }
  const changes = new Map<string, XY | null>()
  // A degree-two junction coincident with ground is the ground's attachment.
  // Carry it in both axes; keeping its old position leaves a stub behind the
  // moved symbol. Ordinary component lead corners retain their fixed axis.
  const attached = new Map<string, XY | null>()
  for (const device of before.devices) {
    if (device.kind !== 'GND' || !selected.has(device.id)) continue
    for (const pin of incident.keys()) {
      if (!pin.startsWith(`${device.id}:`)) continue
      const start: Terminal = { device: device.id, pin: Number(pin.slice(device.id.length + 1)) }
      const old = terminalPosition(before, start), current = terminalPosition(after, start)
      if (equal(old, current)) continue
      for (const first of incident.get(pin)!) {
        let terminal: Terminal = start, wire = first
        const visited = new Set<string>()
        while (!visited.has(wire.id)) {
          visited.add(wire.id)
          const next: Terminal = terminalKey(wire.from) === terminalKey(terminal) ? wire.to : wire.from
          if (!('junction' in next) || selected.has(next.junction) || !equal(terminalPosition(before, next), old) || wirePoints(before, wire).length !== 1) break
          const touching = incident.get(terminalKey(next)) ?? []
          if (touching.length !== 2) break
          const existing = attached.get(next.junction)
          attached.set(next.junction, existing === null || existing && !equal(existing, current) ? null : current)
          terminal = next; wire = touching.find(candidate => candidate.id !== wire.id)!
        }
      }
    }
  }
  for (const device of before.devices) {
    if (!selected.has(device.id)) continue
    for (const first of before.wires) for (const end of [first.from, first.to]) {
      if (!('device' in end) || end.device !== device.id) continue
      const isHorizontal = initialWireBend(before, end) === 'hv'
      if ((initialWireBend(after, end) === 'hv') !== isHorizontal) continue
      const old = terminalPosition(before, end), current = terminalPosition(after, end)
      const offset = isHorizontal ? current.y - old.y : current.x - old.x
      if (!offset) continue
      let terminal: Terminal = end, wire = first
      const visited = new Set<string>()
      while (!visited.has(wire.id)) {
        visited.add(wire.id)
        const forward: boolean = terminalKey(wire.from) === terminalKey(terminal)
        const points = wirePoints(before, wire), path = forward ? points : points.slice().reverse()
        // Any elbow inside this wire already provides a sliding lead corner.
        if (path.length > 2 || path.length === 2 && horizontal(path[0], path[1]) !== isHorizontal) break
        const next: Terminal = forward ? wire.to : wire.from
        if (!('junction' in next) || selected.has(next.junction)) break
        const touching = incident.get(terminalKey(next)) ?? []
        if (touching.length !== 2) break
        const point = terminalPosition(before, next)
        const moved = isHorizontal ? { x: point.x, y: point.y + offset } : { x: point.x + offset, y: point.y }
        if (!attached.has(next.junction)) {
          const existing = changes.get(next.junction)
          changes.set(next.junction, existing === null || existing && !equal(existing, moved) ? null : moved)
        }
        const continuation = touching.find(candidate => candidate.id !== wire.id)
        if (!continuation) break
        terminal = next; wire = continuation
      }
    }
  }
  for (const [id, point] of attached) changes.set(id, point)
  if (!changes.size) return after
  const junctions = after.junctions.map(junction => {
    const moved = changes.get(junction.id)
    if (!moved) return junction
    if (moved.x < DRAWING_BOUNDS.min || moved.x > DRAWING_BOUNDS.max || moved.y < DRAWING_BOUNDS.min || moved.y > DRAWING_BOUNDS.max) throw new Error('移动后的导线会超出画布，请先把器件移向画布中央。')
    return { ...junction, ...moved }
  })
  return { ...after, junctions }
}
