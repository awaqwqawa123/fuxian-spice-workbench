import { type Project } from './circuit'
import type { DesktopCircuitTask } from './desktop-circuit'
import { resolveCandidateProject, type CandidateResolution } from './candidate-resolution'

export interface DesktopCandidateApplication { before: Project; after: string; simulationStale?: boolean }
export type DesktopCandidateResolution = CandidateResolution | { status: 'unavailable'; project?: undefined; conflicts?: undefined; simulationStale?: undefined }

/** Rebase a saved candidate onto the live canvas without changing either input. */
export function resolveDesktopCandidate(task: DesktopCircuitTask, current: Project, lastApply?: DesktopCandidateApplication): DesktopCandidateResolution {
  if (task.status !== 'completed' || !task.result?.changed) return { status: 'unavailable' }
  return resolveCandidateProject(task.baseline, task.result.proposal.project, current, lastApply?.after)
}
