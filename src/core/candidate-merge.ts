import { parseProject, type Project } from './circuit'
import { initialSimulationProfiles } from './simulation-profiles'

type JsonValue = unknown
// Object property order is not an edit. Snapshots can be serialized by the
// browser, the desktop service, or imported from a file in different orders.
const canonical = (value: JsonValue): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item)
const same = (left: JsonValue, right: JsonValue) => canonical(left) === canonical(right)
const object = (value: JsonValue): value is Record<string, JsonValue> => value !== null && typeof value === 'object' && !Array.isArray(value)
const identified = (value: JsonValue): value is { id: string } => object(value) && typeof value.id === 'string'
const atomic = new Set(['from', 'to', 'output', 'positive', 'negative', 'waypoints', 'domain', 'cursors'])
export type CandidateConflictPolicy = 'reject' | 'prefer-candidate'

/** Apply only the candidate's changes since its baseline. Any concurrent edit
 * to the same field is reported instead of overwriting the live schematic. */
export function mergeCandidateProject(baseline: Project, candidate: Project, current: Project, conflictPolicy: CandidateConflictPolicy = 'reject'): { project: Project | null; conflicts: string[] } {
  const conflicts: string[] = []
  function merge(before: JsonValue, proposed: JsonValue, live: JsonValue, path: string): JsonValue {
    if (same(proposed, before)) return live
    if (same(live, before) || same(live, proposed)) return proposed
    if (proposed === undefined || live === undefined || atomic.has(path.split('.').at(-1) ?? '')) {
      conflicts.push(path); return conflictPolicy === 'prefer-candidate' ? proposed : live
    }
    // Both sides may have created an optional section after the task began.
    // Merge its members (and identified rows) before treating the whole section
    // as a collision, so independent waveform and probe edits are retained.
    if ((before === undefined || Array.isArray(before)) && Array.isArray(proposed) && Array.isArray(live)
      && [...(Array.isArray(before) ? before : []), ...proposed, ...live].every(identified)) {
      const original = Array.isArray(before) ? before : []
      const old = new Map(original.map(item => [item.id, item]))
      const next = new Map(proposed.map(item => [item.id, item]))
      const now = new Map(live.map(item => [item.id, item]))
      if (old.size !== original.length || next.size !== proposed.length || now.size !== live.length) { conflicts.push(path); return conflictPolicy === 'prefer-candidate' ? proposed : live }
      const order = [...new Set([...live.map(item => item.id), ...proposed.map(item => item.id), ...original.map(item => item.id)])]
      return order.flatMap(id => {
        // The default simulation profile is a shared logical row created when
        // waveform setup first appears. Its independent fields can be merged.
        // A newly reused component/probe/chart ID cannot be assumed identical.
        if (path !== 'project.waveformSetup.profiles.profiles' && !old.has(id) && next.has(id) && now.has(id) && !same(next.get(id), now.get(id))) {
          conflicts.push(`${path}[${id}]`)
          return [conflictPolicy === 'prefer-candidate' ? next.get(id)! : now.get(id)!]
        }
        const value = merge(old.get(id), next.get(id), now.get(id), `${path}[${id}]`)
        return value === undefined ? [] : [value]
      })
    }
    if ((before === undefined || object(before)) && object(proposed) && object(live)) {
      const original = object(before) ? before : {}
      const result: Record<string, JsonValue> = {}
      for (const key of new Set([...Object.keys(original), ...Object.keys(proposed), ...Object.keys(live)])) {
        const value = merge(original[key], proposed[key], live[key], `${path}.${key}`)
        if (value !== undefined) result[key] = value
      }
      return result
    }
    conflicts.push(path); return conflictPolicy === 'prefer-candidate' ? proposed : live
  }
  // The editor seeds a default profile when someone first adds a waveform
  // frame. Use that deterministic seed as the common ancestor when both
  // branches added waveform setup after the task started.
  const ancestor = !baseline.waveformSetup && candidate.waveformSetup && current.waveformSetup
    ? { ...baseline, waveformSetup: { version: 1 as const, profiles: initialSimulationProfiles(baseline), diagrams: [] } }
    : baseline
  const merged = merge(ancestor, candidate, current, 'project')
  if (conflicts.length && conflictPolicy === 'reject') return { project: null, conflicts: [...new Set(conflicts)] }
  return { project: parseProject(merged, { allowDraft: true }), conflicts: [...new Set(conflicts)] }
}
