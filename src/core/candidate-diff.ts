import { resolveCandidateProject, type CandidateResolution } from './candidate-resolution'
import { candidateWithWaveformSetup } from './candidate-waveform-setup'
import type { Project } from './circuit'
import { compileDrawing, parseDrawing, terminalKey } from './drawing'
import { layoutElectricalDifferences } from './layout-electrical-equivalence'

type Category = 'layout' | 'electrical' | 'metadata' | 'measurement' | 'profile'
interface PathSummary { paths: string[]; total: number; truncated: boolean }
export interface CandidateDiff {
  schemaVersion: 1
  changed: boolean
  classification: Category | 'unchanged' | 'mixed' | 'unknown'
  categories: Category[]
  electricalEquivalent: boolean | null
  equivalenceReason: 'connectivity_unreadable' | null
  changedComponents: { ids: string[]; total: number; truncated: boolean }
  changedFields: PathSummary
  electricalDifferences: PathSummary
  conflicts: PathSummary & { unavailable: boolean }
  resolutionStatus: CandidateResolution['status']
  mergeSimulationStale: boolean | null
}

const stable = (value: unknown): string | undefined => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item)
const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
const identified = (item: unknown): item is Record<string, unknown> & { id: string } => object(item) && typeof item.id === 'string'
// Only schema paths leave this service. Values and validation exception text
// may contain private model sources or user content and must never be returned.
const pathPattern = /^project(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[A-Za-z0-9_.:+-]{1,80}\])*$/
const safePath = (path: string) => path.length <= 512 && pathPattern.test(path) ? path : 'project'
const summary = (paths: string[], limit: number): PathSummary => {
  const unique = [...new Set(paths.map(safePath))].sort()
  const total = new Set(paths).size
  const visible = unique.slice(0, limit)
  return { paths: visible, total, truncated: total > visible.length }
}

function changedPaths(before: unknown, after: unknown, path = 'project'): string[] {
  if (stable(before) === stable(after)) return []
  if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .flatMap(key => changedPaths(before[key], after[key], `${path}.${key}`))
  if (Array.isArray(before) && Array.isArray(after) && [...before, ...after].every(identified)) {
    const left = new Map(before.map(item => [item.id, item])), right = new Map(after.map(item => [item.id, item]))
    const rows = [...new Set([...left.keys(), ...right.keys()])].sort().flatMap(id => changedPaths(left.get(id), right.get(id), `${path}[${id}]`))
    // Preserve the editor's ordering edits even when row values are identical.
    return rows.length ? rows : [path]
  }
  return [path]
}

function category(path: string, electricalPaths: string[], equivalenceKnown: boolean): Category {
  if (/^project\.probes\[[^\]]+\]\.(layout|positiveLayout|negativeLayout)(\.|$)/.test(path)) return 'layout'
  if (path.startsWith('project.probes') || path.startsWith('project.drawing.output')) return 'measurement'
  if (/^project\.(analysis|source|values|ac|tran|dc|temperature|sweep)(\.|$)/.test(path)
    || path.startsWith('project.waveformSetup.profiles')) return 'profile'
  if (path.startsWith('project.title') || path.startsWith('project.report') || path.startsWith('project.waveformSetup.diagrams')) return 'metadata'
  if (path.startsWith('project.models') || /^project\.(schemaVersion|template)(\.|$)/.test(path)) return 'electrical'
  if (path.startsWith('project.drawing')) {
    if (/\.(x|y|rotation|mirrored|groundStyle|pinPositions|bend|waypoints|style)(\.|$)/.test(path)) return 'layout'
    // A route/junction rewrite or label move within a proven net is layout.
    // Without readable connectivity it cannot be labelled layout-only.
    if (equivalenceKnown && !electricalPaths.some(item => item.startsWith('project.drawing') && !item.startsWith('project.drawing.output'))) return 'layout'
    return 'electrical'
  }
  return 'metadata'
}

function assertReadableConnectivity(project: Project): void {
  if (!project.drawing) return
  // Drafts can lack a source, ground or output. Their references and ordered
  // subcircuit ports still have to be structurally readable before comparison.
  const drawing = parseDrawing(project.drawing), topology = compileDrawing(drawing)
  const names = new Map<string, Set<string>>()
  for (const label of drawing.labels ?? []) {
    const net = topology.nodes.get(terminalKey(label.at))!
    if (net === '0') continue
    const group = names.get(net) ?? new Set<string>()
    group.add(label.name.toLowerCase()); names.set(net, group)
    if (group.size > 1) throw new Error('ambiguous net labels')
  }
}

/** Read-only bounded review using the same omitted-field, merge and electrical
 * invariants as the editor. An equivalent result is not engineering acceptance. */
export function readCandidateDiff(baseline: Project, proposal: Project, current: Project): CandidateDiff {
  let candidate = proposal, normalized = true
  try { candidate = candidateWithWaveformSetup(baseline, proposal) }
  catch { normalized = false }
  const paths = changedPaths(baseline, candidate)
  let electrical: string[] = [], electricalEquivalent: boolean | null = null
  try {
    if (!normalized) throw new Error('unreadable candidate attachments')
    assertReadableConnectivity(baseline); assertReadableConnectivity(candidate)
    electrical = layoutElectricalDifferences(baseline, candidate).map(item => item.path)
    electricalEquivalent = electrical.length === 0
  } catch { /* Unreadable references must not be inferred electrically equal. */ }
  const categories = [...new Set(paths.map(path => category(path, electrical, electricalEquivalent !== null)))].sort() as Category[]
  const ids = new Set<string>()
  const beforeDevices = new Map((baseline.drawing?.devices ?? []).map(device => [device.id, device]))
  const afterDevices = new Map((candidate.drawing?.devices ?? []).map(device => [device.id, device]))
  for (const id of new Set([...beforeDevices.keys(), ...afterDevices.keys()])) if (stable(beforeDevices.get(id)) !== stable(afterDevices.get(id))) ids.add(id)
  for (const path of electrical) {
    const pin = path.match(/^project\.drawing\.pins\[([^:]+):/)
    if (pin) ids.add(pin[1])
  }
  const allIds = [...ids].sort()
  const resolution = resolveCandidateProject(baseline, candidate, current)
  const rawConflicts = resolution.conflicts ?? []
  const conflictPaths = rawConflicts.filter(path => pathPattern.test(path) && path.length <= 512)
  const conflicts = summary(conflictPaths, 50)
  // Keep the complete diagnostic count while withholding non-path exceptions.
  conflicts.total = new Set(rawConflicts).size
  conflicts.truncated = conflicts.total > conflicts.paths.length
  return {
    schemaVersion: 1, changed: paths.length > 0,
    classification: paths.length === 0 ? 'unchanged' : electricalEquivalent === null ? 'unknown' : categories.length === 1 ? categories[0] : 'mixed',
    categories, electricalEquivalent, equivalenceReason: electricalEquivalent === null ? 'connectivity_unreadable' : null,
    changedComponents: { ids: allIds.slice(0, 80), total: allIds.length, truncated: allIds.length > 80 },
    changedFields: summary(paths, 100), electricalDifferences: summary(electrical, 100),
    conflicts: { ...conflicts, unavailable: rawConflicts.length !== conflictPaths.length },
    resolutionStatus: resolution.status, mergeSimulationStale: resolution.simulationStale ?? null,
  }
}

const pathSchema = (limit: number) => ({ type: 'object', additionalProperties: false, required: ['paths', 'total', 'truncated'], properties: {
  paths: { type: 'array', maxItems: limit, items: { type: 'string', maxLength: 512 } }, total: { type: 'integer', minimum: 0 }, truncated: { type: 'boolean' },
} })
const categories = ['layout', 'electrical', 'metadata', 'measurement', 'profile']
export const candidateDiffOutputSchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'changed', 'classification', 'categories', 'electricalEquivalent', 'equivalenceReason', 'changedComponents', 'changedFields', 'electricalDifferences', 'conflicts', 'resolutionStatus', 'mergeSimulationStale'],
  properties: {
    schemaVersion: { const: 1 }, changed: { type: 'boolean' }, classification: { enum: ['unchanged', ...categories, 'mixed', 'unknown'] },
    categories: { type: 'array', uniqueItems: true, maxItems: 5, items: { enum: categories } },
    electricalEquivalent: { type: ['boolean', 'null'] }, equivalenceReason: { enum: [null, 'connectivity_unreadable'] },
    changedComponents: { type: 'object', additionalProperties: false, required: ['ids', 'total', 'truncated'], properties: {
      ids: { type: 'array', maxItems: 80, items: { type: 'string', maxLength: 80 } }, total: { type: 'integer', minimum: 0 }, truncated: { type: 'boolean' },
    } },
    changedFields: pathSchema(100), electricalDifferences: pathSchema(100),
    conflicts: { ...pathSchema(50), required: ['paths', 'total', 'truncated', 'unavailable'], properties: { ...pathSchema(50).properties, unavailable: { type: 'boolean' } } },
    resolutionStatus: { enum: ['ready', 'applied', 'mergeable', 'already-present', 'conflict'] }, mergeSimulationStale: { type: ['boolean', 'null'] },
  },
} as const
