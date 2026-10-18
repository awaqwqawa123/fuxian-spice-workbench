import type { Project } from './circuit'
import { projectWithCandidateProbes } from './project-probes'
import { updateSimulationProfile } from './simulation-profiles'

/** Match the editor's omitted-field semantics using the immutable baseline,
 * never the live project. Omitted probes and waveform frames are preserved,
 * while explicit empty arrays still clear them. */
export function candidateWithWaveformSetup(baseline: Project, candidate: Project): Project {
  const withProbes = projectWithCandidateProbes(baseline, candidate).project
  if (withProbes.waveformSetup !== undefined || baseline.waveformSetup === undefined) return withProbes
  return { ...withProbes, waveformSetup: {
    ...structuredClone(baseline.waveformSetup),
    profiles: updateSimulationProfile(baseline.waveformSetup.profiles, withProbes),
  } }
}
