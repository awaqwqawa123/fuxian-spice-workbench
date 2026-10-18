/** Translate complete Qucs-S SPICE blocks for local downloads only.
 * Copyright 2026 spice-workbench contributors; GPL-2.0-or-later for this adapter.
 * The adapter license does not grant rights to redistribute downloaded vendor models.
 */
import { createHash } from 'node:crypto'
import { QUCS_MODEL_CATALOG } from './qucs-model-catalog'
import { bjtInstanceModelIndex } from '../src/core/spice-models'
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
function numeric(value: string): string {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i.test(value)) throw new Error(`Polynomial coefficient must be a SPICE constant: ${value}`)
  return value
}
function translatePolynomial(line: string, adaptations: string[]): string {
  const poly = line.match(/^\s*([EFGH]\S*)\s+(\S+)\s+(\S+)\s+POLY\((\d+)\)\s+(.+)$/i)
  if (!poly) return line
  const [, name, a, b, dimensions, tail] = poly, count = Number(dimensions), letter = name[0].toUpperCase()
  if (count < 1 || count > 5) throw new Error('Unsupported polynomial dimension')
  const tokens = tail.replace(/[(),]/g, ' ').trim().split(/\s+/)
  const inputs = tokens.splice(0, count * (['E', 'G'].includes(letter) ? 2 : 1))
  const variables = Array.from({ length: count }, (_, i) => ['E', 'G'].includes(letter) ? `V(${inputs[2 * i]},${inputs[2 * i + 1]})` : `I(${inputs[i]})`)
  const coefficients = tokens.map(numeric)
  if (!coefficients.length || coefficients.length > 64) throw new Error('Unsupported polynomial coefficient count')
  const powers: number[][] = []
  function degree(remaining: number, position: number, vector: number[]) {
    if (position === count - 1) { powers.push([...vector, remaining]); return }
    for (let exponent = remaining; exponent >= 0; exponent--) degree(remaining - exponent, position + 1, [...vector, exponent])
  }
  for (let order = 0; powers.length < coefficients.length; order++) degree(order, 0, [])
  // SPICE's graded polynomial order: 1, x1, x2, x1², x1*x2, x2², ...
  const expression = coefficients.map((value, i) => {
    const factors = powers[i].flatMap((power, j) => Array.from({ length: power }, () => `(${variables[j]})`))
    return `(${value})${factors.length ? '*' + factors.join('*') : ''}`
  }).join('+')
  adaptations.push(`Translated ${name} POLY(${count}) with all ${coefficients.length} coefficients to equivalent behavioral source (WASM ngspice has no XSPICE)`)
  return ['E', 'G'].includes(letter) ? `${name} ${a} ${b} VALUE {${expression}}` : `B_${name} ${a} ${b} ${letter === 'F' ? 'I' : 'V'}={${expression}}`
}
function spiceSubcircuit(category: string, part: string, block: string, rootSubcircuit?: string): { text: string; rootId: string; adaptations: string[] } {
  const fragment = block.match(/<Spice>([\s\S]*?)<\/Spice>/)?.[1]
  if (!fragment) throw new Error('Native Qucs circuit has no self-contained SPICE block')
  if (/<SpiceAttach\s+"[^">]+"/.test(block)) throw new Error('Depends on an external SpiceAttach file')
  const declarations = [...fragment.matchAll(/^\s*\.(?:subckt|model)\s+(\S+)/gmi)].map(match => match[1])
  const rootName = declarations.find(name => name.toLowerCase() === (rootSubcircuit ?? `${category}_${part}`).toLowerCase())
  if (!rootName || !new RegExp('^\\s*\\.subckt\\s+' + rootName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s)', 'mi').test(fragment)) throw new Error('Cannot identify the registered source subcircuit')
  const modelNames = new Set([...fragment.matchAll(/^\s*\.model\s+(\S+)/gmi)].map(match => match[1].toLowerCase()))
  const rootId = `${part}_${category === 'VoltageComparators' && part === 'LM311' ? 'COMP_' : ''}QUCS`
  const namespace = `Q${sha256(category + '/' + part).slice(0, 8)}_`
  const names = new Map(declarations.map((name, i) => [name.toLowerCase(), name === rootName ? rootId : `${namespace}${i}`]))
  const adaptations: string[] = ['Namespaced wrapper, local model cards and helper subcircuits; no electrical constants changed']
  if (rootSubcircuit) adaptations.push(`Exposed complete source subcircuit ${rootSubcircuit} directly with its original terminal order; Qucs drawing wrapper is retained in the download`)
  const folded: string[] = []
  for (const line of fragment.split(/\r?\n/)) {
    if (/^\s*\+/.test(line)) {
      const last = folded.map(value => !!value.trim() && !value.trim().startsWith('*')).lastIndexOf(true)
      if (last < 0) throw new Error('Orphan continuation line')
      folded[last] += ' ' + line.replace(/^\s*\+\s*/, '')
    } else folded.push(line)
  }
  let active = ''
  const text = folded.map(line => {
    if (line.trim().startsWith('*')) return line // retain author / manufacturer comments verbatim
    const tokens = [...line.matchAll(/\S+/g)]
    const directive = tokens[0]?.[0].toLowerCase() ?? ''
    const letter = directive[0]?.toUpperCase() ?? ''
    // Rename only definition/reference positions. A model named NPN must not
    // change the NPN type keyword, a node or an electrical parameter.
    const position = ['.subckt', '.model', '.ends'].includes(directive) ? 1 : letter === 'X' ? tokens.length - 1 : letter === 'D' ? 3 : letter === 'Q' ? bjtInstanceModelIndex(line.split(/[;$]/, 1)[0].trim().split(/\s+/), modelNames) ?? -1 : ['J', 'W'].includes(letter) ? 4 : ['M', 'S'].includes(letter) ? 5 : -1
    const token = tokens[position]
    const tokenName = token?.[0].split(';')[0]
    const replacement = tokenName && names.get(tokenName.toLowerCase())
    if (replacement) line = line.slice(0, token!.index) + replacement + line.slice(token!.index! + tokenName!.length)
    const begin = line.match(/^\s*\.subckt\s+(\S+)/i)
    if (begin) active = begin[1]
    if (/^\s*\.ends\b/i.test(line)) {
      const end = line.trim().split(/\s+/)[1]
      if (end && end.toLowerCase() !== active.toLowerCase()) {
        adaptations.push(`Corrected source .ends label ${end} to matching .subckt ${active}`)
        line = `.ends ${active}`
      }
      active = ''
    }
    // SPICE accepts trailing unit text; parser wants canonical numerical constants.
    if (/^\s*[.+]/.test(line)) line = line.replace(/(\b(?:TF|TR|CJE|CJC)\s*=\s*[+-]?[\d.]+(?:e[+-]?\d+)?[npuf])(?:S|F)\b/gi, '$1')
    return translatePolynomial(line, adaptations)
  }).join('\n').trim() + '\n'
  return { text, rootId, adaptations }
}

export function adaptQucsSpiceComponent(sourceText: string, category: string, part: string, rootSubcircuit?: string) {
  if (!['SpiceOpamp', 'VoltageComparators', 'VoltageReferences', 'VoltageRegulators', 'Optocoupler', 'Thyristor'].includes(category)) throw new Error('Unsupported Qucs SPICE category')
  const components = [...sourceText.matchAll(/<Component ([^>]+)>([\s\S]*?)<\/Component>/g)]
  const component = components.find(match => match[1].toLowerCase() === part.toLowerCase())
  if (!component) throw new Error('Qucs component is absent from the pinned source')
  const converted = spiceSubcircuit(category, component[1], component[2], rootSubcircuit)
  const description = component[2].match(/<Description>([\s\S]*?)<\/Description>/)?.[1].trim() ?? ''
  return { ...converted, text: ['* Adapted complete Qucs-S component; original authors/vendor terms retained in downloaded source.', ...converted.adaptations.map(note => '* ' + note), ...description.split(/\r?\n/).map(line => '* ' + line.trim()), converted.text].join('\n') + '\n' }
}

/** Adapt only whole, reviewed components from the immutable selected file.
 * Hash the original bytes before transforming; callers provide decoded UTF-8
 * source from this registry, never arbitrary file paths or executable code.
 */
export function adaptQucsSpiceLibrary(sourceText: string, path: string, matchedNames?: string[]) {
  const file = QUCS_MODEL_CATALOG.files.find(file => file.path === path)
  if (!file || Buffer.byteLength(sourceText) !== file.size || sha256(sourceText) !== file.sha256) throw new Error('Qucs downloaded source does not match the pinned registry hash/size')
  const requested = matchedNames?.length ? new Set(matchedNames.map(name => name.toLowerCase())) : undefined
  const selected = file.models.filter(model => !requested || requested.has(model.name.toLowerCase()) || requested.has(model.adaptedId.toLowerCase()))
  if (!selected.length) throw new Error('No reviewed Qucs component matches this download')
  const category = path.split('/').at(-1)!.replace(/\.lib$/i, '')
  const converted = selected.map(model => adaptQucsSpiceComponent(sourceText, category, model.name, 'rootSubcircuit' in model && typeof model.rootSubcircuit === 'string' ? model.rootSubcircuit : undefined))
  return { text: converted.map(model => model.text).join('\n'), matchedNames: converted.map(model => model.rootId), adaptations: converted.flatMap(model => model.adaptations) }
}
