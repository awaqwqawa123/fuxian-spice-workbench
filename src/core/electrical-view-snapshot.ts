import type { Project } from './circuit'

// UI snapshots are immutable. Presentation-only edits may replace the project
// shell hundreds of times while the electrical children retain their identities.
// Keep this cache scoped to a mounted editor, never to general mutable imports.
const presentation = new Set(['waveformSetup', 'report', 'title'])
export function createElectricalViewSnapshot() {
  let previous: Project | undefined
  return (project: Project): Project => {
    if (previous) {
      const keys = Object.keys(project).filter(key => !presentation.has(key)) as (keyof Project)[]
      const before = Object.keys(previous).filter(key => !presentation.has(key))
      if (keys.length === before.length && keys.every(key => Object.hasOwn(previous!, key) && Object.is(previous![key], project[key]))) return previous
    }
    previous = project
    return project
  }
}
