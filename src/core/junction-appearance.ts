import type { Drawing } from './drawing'

export interface JunctionAppearance {
  kind: 'open' | 'through' | 'branch'
  connections: number
}

/** Visual markers depend on explicit wire ends, never on geometric crossings.
 * A two-way junction remains in the drawing for editing and current probes;
 * hiding its resting marker must not merge wires or change electrical topology.
 */
export function junctionAppearances(drawing: Drawing): Map<string, JunctionAppearance> {
  const result = new Map<string, JunctionAppearance>(drawing.junctions.map(junction => [junction.id, { kind: 'open', connections: 0 }]))
  for (const wire of drawing.wires) {
    for (const endpoint of [wire.from, wire.to]) {
      if (!('junction' in endpoint)) continue
      const appearance = result.get(endpoint.junction)
      if (appearance) appearance.connections++
    }
  }
  for (const appearance of result.values()) appearance.kind = appearance.connections > 2 ? 'branch' : appearance.connections === 2 ? 'through' : 'open'
  return result
}
