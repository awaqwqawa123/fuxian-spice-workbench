import { aiProjectFingerprint } from './ai'
import { mergeCandidateProject, type CandidateConflictPolicy } from './candidate-merge'
import { candidateWithWaveformSetup } from './candidate-waveform-setup'
import { validateProject, type Project } from './circuit'
import { layoutElectricallyEquivalent } from './layout-electrical-equivalence'

export type CandidateResolution = {
  status: 'ready' | 'applied' | 'mergeable' | 'already-present' | 'conflict'
  project?: Project
  conflicts?: string[]
  simulationStale?: boolean
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item)
const fingerprint = (project: Project) => stable(JSON.parse(aiProjectFingerprint(project)))

/** Resolve any saved proposal against the current project, regardless of its
 * circuit template or the assistant that produced it. Neither input changes. */
export function resolveCandidateProject(baseline: Project, proposal: Project, current: Project, lastAppliedFingerprint?: string, conflictPolicy: CandidateConflictPolicy = 'reject'): CandidateResolution {
  try {
    const candidate = candidateWithWaveformSetup(baseline, proposal)
    const currentKey = fingerprint(current)
    if (lastAppliedFingerprint && stable(JSON.parse(lastAppliedFingerprint)) === currentKey || currentKey === fingerprint(candidate)) return { status: 'applied' }
    if (currentKey === fingerprint(baseline)) return { status: 'ready', project: candidate }

    const merged = mergeCandidateProject(baseline, candidate, current, conflictPolicy)
    if (!merged.project) return { status: 'conflict', conflicts: merged.conflicts }

    // The editor permits unfinished circuits. Block only validation errors
    // introduced by combining the two branches, not errors already present in
    // either draft independently.
    const existing = new Set([...validateProject(current), ...validateProject(candidate)])
    const introduced = validateProject(merged.project).filter(issue => !existing.has(issue))
    if (introduced.length) return { status: 'conflict', conflicts: introduced }
    if (fingerprint(merged.project) === currentKey) return { status: 'already-present', conflicts: merged.conflicts }
    return { status: 'mergeable', project: merged.project, conflicts: merged.conflicts, simulationStale: !layoutElectricallyEquivalent(candidate, merged.project) }
  } catch (error) {
    return { status: 'conflict', conflicts: [(error as Error).message] }
  }
}
