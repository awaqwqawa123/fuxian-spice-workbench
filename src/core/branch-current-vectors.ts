import type { Project } from './circuit'

/** @device currents are real-analysis vectors; some do not exist in AC at all. */
export function branchCurrentSaveVectors(project: Project): string[] {
  if(project.analysis==='noise')return []
  const devices = project.drawing?.devices ?? (project.template === 'custom' ? [] : [
    { id: 'R1', kind: 'R' }, { id: 'C1', kind: 'C' }, ...(project.template === 'rlc-lowpass' ? [{ id: 'L1', kind: 'L' }] : []),
  ])
  return devices.flatMap(part => {
    if (part.kind === 'L') return [`i(${part.id})`]
    if (project.analysis === 'ac') return []
    if (part.kind === 'R' || part.kind === 'C') return [`@${part.id.toLowerCase()}[i]`]
    if (part.kind === 'D') return [`@${part.id.toLowerCase()}[id]`]
    if(part.kind==='I'&&project.analysis==='tran'&&'params' in part&&part.params?.waveform==='expression')return [`@b__fx_${part.id.toLowerCase()}_wave[i]`]
    if (part.kind === 'I') return [`@${part.id.toLowerCase()}[current]`]
    return []
  })
}

/** ngspice write wraps saved @r1[i] in i(...); never confuse it with a node. */
export function normalizeCurrentVector(name: string): string | null {
  const unwrapped = name.match(/^i\((@[^()]+)\)$/i)?.[1] ?? name
  const behavioral=unwrapped.match(/^@b__fx_(i[1-9]\d*)_wave\[i\]$/i)
  if(behavioral)return `i(${behavioral[1].toLowerCase()})`
  const property = unwrapped.match(/^@([a-z][a-z0-9_]*)\[(i|id|current)\]$/i)
  if (property) {
    const [, device, quantity] = property
    const quantities: Record<string, string> = { r: 'i', c: 'i', d: 'id', i: 'current' }
    const expected = quantities[device[0].toLowerCase()]
    return expected === quantity.toLowerCase() ? `i(${device.toLowerCase()})` : null
  }
  const branch = name.match(/^i\(([a-z][a-z0-9_]*)\)$/i) ?? name.match(/^([a-z][a-z0-9_]*)#branch$/i)
  return branch ? `i(${branch[1].toLowerCase()})` : null
}

