import metadata from './qucs-model-catalog.json'

/** Names/hashes only: third-party macro-model text is downloaded on demand. */
export const QUCS_MODEL_CATALOG = metadata
export function registeredQucsModelPath(repo: string, revision: string, path: string): boolean {
  return repo === metadata.repo && revision === metadata.revision && metadata.files.some(file => file.path === path)
}
