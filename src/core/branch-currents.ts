import { circuitGraph, parseQuantity, type Project } from './circuit'
import { compileDrawing } from './drawing'
import type { Complex, Result } from './results'
export { branchCurrentSaveVectors, normalizeCurrentVector } from './branch-current-vectors'

/** Positive current flows from the first netlisted terminal to the second. */
export const currentProbeKinds: readonly string[] = ['V', 'R', 'C', 'L', 'I', 'D']
export const canProbeCurrent = (kind: string): boolean => currentProbeKinds.includes(kind)

function parts(project: Project) {
  return project.drawing?.devices ?? (project.template !== 'custom' ? circuitGraph(project).parts : [])
}
export const hasCurrentProbeDevice = (project: Project, id: string): boolean => parts(project).some(part => part.id === id && canProbeCurrent(part.kind))

const completeReal = (values: number[] | undefined, count: number): values is number[] => !!values && values.length === count && values.every(Number.isFinite)
const completeComplex = (values: Complex[] | undefined, count: number): values is Complex[] => !!values && values.length === count && values.every(v => Number.isFinite(v.real) && Number.isFinite(v.img))

export function resolveBranchCurrent(result: Result, id: string): { values: number[]; complex?: Complex[] } | null {
  const device = parts(result.project).find(part => part.id === id)
  if (!device || !canProbeCurrent(device.kind)) return null
  const key = `i(${id.toLowerCase()})`
  if (result.analysis !== 'ac') {
    const values = result.currents?.[key]
    return completeReal(values, result.points) ? { values } : null
  }
  // Diode @id and independent current-source @current describe the bias point,
  // not a verified complex small-signal branch. Do not present them as AC data.
  if (device.kind === 'D' || device.kind === 'I') return null
  if (device.kind === 'R' || device.kind === 'C') {
    try {
      const nodes = result.project.drawing
        ? compileDrawing(result.project.drawing).elements.find(element => element.device.id === id)?.nodes
        : circuitGraph(result.project).parts.find(part => part.id === id)?.nodes
      if (!nodes || nodes.length !== 2 || result.x.length !== result.points || result.x.some(f => !Number.isFinite(f) || f <= 0)) return null
      const node = (name: string) => name === '0' ? Array.from({ length: result.points }, () => ({ real: 0, img: 0 })) : result.complexVoltages?.[`v(${name.toLowerCase()})`]
      const positive = node(nodes[0]), negative = node(nodes[1])
      if (!completeComplex(positive, result.points) || !completeComplex(negative, result.points)) return null
      const value = parseQuantity(device.value, device.kind === 'R' ? 'resistance' : 'capacitance')
      if (!Number.isFinite(value) || value <= 0) return null
      const complex = positive.map((a, index) => {
        const b = negative[index], real = a.real - b.real, img = a.img - b.img
        if (device.kind === 'R') return { real: real / value, img: img / value }
        const admittance = 2 * Math.PI * result.x[index] * value
        return { real: -img * admittance, img: real * admittance }
      })
      return completeComplex(complex, result.points) ? { values: complex.map(v => v.real), complex } : null
    } catch { return null }
  }
  const complex = result.complexCurrents?.[key]
  return completeComplex(complex, result.points) ? { values: complex.map(v => v.real), complex } : null
}
