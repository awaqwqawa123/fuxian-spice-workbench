import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parseModelSymbol, type ModelSymbol } from '../src/core/model-symbol'
import { validateLtspicePinOrder, type LtspiceAsy } from '../src/core/ltspice-symbol'

export const SYMBOL_MODEL_EXTENSIONS = /\.(?:lib|mod|sub|cir|spice|spi|inc|txt|fam)$/i
export const modelPathIdentity = (path: string) => resolve(path).toLowerCase()
export function symbolPathWithin(root: string, path: string) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
export function asyModelFile(asy: LtspiceAsy): string {
  const file = asy.modelFile || (SYMBOL_MODEL_EXTENSIONS.test(asy.spiceModel) ? asy.spiceModel : '')
  return file && !isAbsolute(file) && !/[:\x00-\x1f{}$]/.test(file) ? file.replaceAll('\\', '/') : ''
}
/** ModelFile is a file, SpiceModel/Value2/Value are explicit model identifiers.
 * A display title or a matching pin count alone never associates a model.
 */
export function asyModelNames(asy: LtspiceAsy): string[] {
  const spiceModel = SYMBOL_MODEL_EXTENSIONS.test(asy.spiceModel) ? '' : asy.spiceModel
  const names = spiceModel ? [spiceModel] : [asy.value2, asy.value]
  return [...new Set(names.map(name => name.trim().toLowerCase()).filter(name => !!name && !/[\s{}=:@]/.test(name) && !SYMBOL_MODEL_EXTENSIONS.test(name)))]
}
export function parseSymbolModelHeaders(text: string): Map<string, string[]> {
  const headers = new Map<string, string[]>(), ambiguous = new Set<string>()
  for (const match of text.replace(/\r?\n\s*\+/g, ' ').matchAll(/^\s*\.subckt\s+(\S+)\s+([^\r\n]*)/gim)) {
    const id = match[1].toLowerCase(), tokens = match[2].trim().split(/\s+/).filter(Boolean)
    const boundary = tokens.findIndex(port => /^params?:?$/i.test(port) || port.includes('=') || /^[;$]/.test(port))
    const ports = boundary < 0 ? tokens : tokens.slice(0, boundary)
    if (headers.has(id)) ambiguous.add(id)
    headers.set(id, ports)
  }
  // Multiple definitions of the same ID in one file may be selected by .lib
  // sections; this resolver does not silently choose the last definition.
  for (const id of ambiguous) headers.delete(id)
  return headers
}
export const sameSymbolModelPorts = (actual: readonly string[] | undefined, expected: readonly string[]) => !!actual && actual.length === expected.length && actual.every((port, index) => port.toLowerCase() === expected[index].toLowerCase())

export function createSymbolModelFileIndex(paths: readonly string[]) {
  const byPath = new Map(paths.map(path => [modelPathIdentity(path), path])), byName = new Map<string, string[]>()
  for (const path of paths) { const name = basename(path).toLowerCase(); byName.set(name, [...(byName.get(name) ?? []), path]) }
  return {
    resolve(file: string, symbolPath: string, root: string): string[] {
      if (!file || isAbsolute(file) || /[:\x00-\x1f{}$]/.test(file)) return []
      const fragment = file.replaceAll('\\', '/')
      for (const target of [resolve(dirname(symbolPath), fragment), resolve(root, fragment), resolve(dirname(root), fragment)]) {
        if (!symbolPathWithin(root, target)) continue
        const found = byPath.get(modelPathIdentity(target))
        if (found) return [found]
      }
      // LTspice's bare ModelFile searches the same installed model tree. A
      // duplicate basename is preserved as ambiguous, never chosen by order.
      return !fragment.includes('/') ? byName.get(fragment.toLowerCase()) ?? [] : []
    },
  }
}

export function originalSymbolForDeclaration(asy: LtspiceAsy, id: string, pins: readonly string[], headers: Map<string, string[]>, allowFamily = true): { symbol: ModelSymbol; exact: boolean } | undefined {
  if (asy.prefix.toUpperCase() !== 'X' || !sameSymbolModelPorts(headers.get(id.toLowerCase()), pins)) return undefined
  const names = asyModelNames(asy), exact = names.includes(id.toLowerCase())
  if (!exact && (!allowFamily || !names.some(name => sameSymbolModelPorts(headers.get(name), pins)))) return undefined
  validateLtspicePinOrder(asy.symbol, pins)
  return { symbol: parseModelSymbol({ ...asy.symbol, origin: 'imported', title: id.slice(0, 32) }, 'X', [...pins]), exact }
}
