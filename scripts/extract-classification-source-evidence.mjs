/** Read-only vendor metadata audit. Output contains IDs, categories and evidence locations, never SPICE bodies. */
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sha = value => createHash('sha256').update(value).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const lower = value => String(value ?? '').toLowerCase()
const atom = node => Array.isArray(node) ? node[0] : node
const child = (node, name) => node.find(value => Array.isArray(value) && lower(value[0]) === lower(name))

/** Parse data-only PRP S-expressions, including both quoted and unquoted property names. */
export function parsePropertyRecords(text, { excludeAmbiguous = false } = {}) {
  const root = [], stack = [root]
  let offset = 0
  while (offset < text.length) {
    if (/\s/.test(text[offset])) { offset++; continue }
    const character = text[offset++]
    if (character === '(') { const value = []; stack.at(-1).push(value); stack.push(value); continue }
    if (character === ')') { if (stack.length === 1) throw new Error('Unexpected property close'); stack.pop(); continue }
    let value = ''
    if (character === '"') {
      let closed = false
      while (offset < text.length) {
        const next = text[offset++]
        if (next === '"') { closed = true; break }
        if (next === '\\' && ['"', '\\'].includes(text[offset])) value += text[offset++]
        else value += next
      }
      if (!closed) throw new Error('Unclosed property string')
    } else {
      value = character
      while (offset < text.length && !/[\s()]/.test(text[offset])) value += text[offset++]
    }
    stack.at(-1).push(value)
  }
  if (stack.length !== 1) throw new Error('Unclosed property record')
  const records = new Map(), ambiguous = new Set()
  for (const node of root) {
    if (!Array.isArray(node) || typeof node[0] !== 'string') throw new Error('Invalid property record')
    const id = lower(node[0])
    if (records.has(id) || ambiguous.has(id)) {
      if (!excludeAmbiguous) throw new Error(`Duplicate property record: ${node[0]}`)
      records.delete(id)
      ambiguous.add(id)
      continue
    }
    records.set(id, node)
  }
  return records
}

function symbolCategory(symbol) {
  if (/^opamp\d*$/i.test(symbol)) return 'analog:amplifier-unverified'
  if (/^vcomp\d*$/i.test(symbol)) return 'analog:comparator'
  if (/^nmosfet\d*$/i.test(symbol)) return 'mos:n'
  if (/^pmosfet\d*$/i.test(symbol)) return 'mos:p'
  if (/^npndlg$/i.test(symbol)) return 'bjt:darlington-npn'
  if (/^pnpdlg$/i.test(symbol)) return 'bjt:darlington-pnp'
}

/** A hierarchy is evidence only when every explicitly linked implementation resolves to the same reviewed category. */
export function propertyEvidence(records, id, trail = new Set()) {
  id = lower(id)
  if (trail.has(id)) return undefined
  const record = records.get(id)
  if (!record) return undefined
  const info = child(record, 'device_info'), symbol = info && child(info, 'SYMBOL_NAME')?.[1]
  const category = symbolCategory(symbol ?? '')
  if (category) return { category, symbols: [symbol], implementations: [], recordIds: [record[0]] }
  if (lower(child(record, 'Hierarchical')?.[1]) !== 'yes') return undefined
  const implementations = child(record, 'Implementation')?.slice(1).map(atom)
  if (!implementations?.length || implementations.some(value => typeof value !== 'string')) return undefined
  const nextTrail = new Set([...trail, id]), resolved = implementations.map(name => propertyEvidence(records, name, nextTrail))
  if (resolved.some(value => !value) || new Set(resolved.map(value => value.category)).size !== 1) return undefined
  return { category: resolved[0].category, symbols: [...new Set(resolved.flatMap(value => value.symbols))], implementations, recordIds: [record[0], ...resolved.flatMap(value => value.recordIds)] }
}

const tinaTags = {
  opamp: 'analog:opamp', comparator: 'analog:comparator', instamp: 'analog:instrumentation', fulldiffamp: 'analog:differential',
  diffamp: 'analog:difference', currshuntmon: 'analog:current-sense', buffer: 'analog:buffer', vgamp: 'analog:variable-gain', adconverters: 'interface:adc',
}
export function tinaIndexEvidence(text, id) {
  const matches = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*\.?SUBCKT\s+(\S+)\s+.+?\[([^\]]+)\]\s*$/i)
    if (match && lower(match[1]) === lower(id)) matches.push({ category: tinaTags[lower(match[2])], tag: match[2], line: index + 1 })
  }
  return matches.length === 1 && matches[0].category ? matches[0] : undefined
}

export async function extractClassificationSourceEvidence({ cacheRoot, libraryRoot }) {
  const manifest = await json(join(cacheRoot, 'manifest.json')), directory = join(cacheRoot, manifest.generation)
  const indexBytes = await readFile(join(directory, 'index.json'))
  if (sha(indexBytes) !== manifest.indexHash) throw new Error('Cache index checksum mismatch')
  const entries = JSON.parse(indexBytes.toString('utf8')).entries
  const pending = new Map(entries.filter(entry => entry.category === 'subcircuit:other').map(entry => [entry.key, entry]))
  const metadata = new Map(), groups = new Map(), skipped = {}, storedUnknown = pending.size
  const skip = reason => { skipped[reason] = (skipped[reason] ?? 0) + 1 }
  for (const [chunk, hashes] of manifest.chunks.entries()) {
    if (!entries.some(entry => pending.has(entry.key) && entry.chunk === chunk)) continue
    const bytes = await readFile(join(directory, `${chunk}.models.json`))
    if (sha(bytes) !== hashes.models) throw new Error(`Cache chunk checksum mismatch: ${chunk}`)
    for (const model of JSON.parse(bytes.toString('utf8'))) {
      const entry = pending.get(sha(JSON.stringify(model)))
      if (!entry) continue
      const source = model.source.label.replaceAll('\\', '/')
      const matched = source.match(/^(PSpice|TINA) 本地库 \/ (.+)$/)
      if (!matched || model.kind !== 'X') { skip('outside-PRP-TLD-subcircuit-scope'); continue }
      const library = matched[1] === 'TINA' ? 'tina' : 'pspice', relative = matched[2]
      if (relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('Unsafe source evidence path')
      if (library === 'pspice' && /^infineon/i.test(basename(relative))) { skip('semiconductor-audit-owned-separately'); continue }
      const sourcePath = join(libraryRoot, 'vendor', library, relative), extension = library === 'tina' ? '.tld' : '.prp'
      const metaKey = `${library}/${relative}`
      if (!metadata.has(metaKey)) {
        const adjacent = (await readdir(dirname(sourcePath))).find(name => lower(name) === lower(basename(sourcePath).replace(/\.[^.]+$/, extension)))
        if (!adjacent) metadata.set(metaKey, null)
        else {
          const raw = await readFile(join(dirname(sourcePath), adjacent)), text = raw.toString('latin1')
          metadata.set(metaKey, { text, sha256: sha(raw), file: adjacent, records: library === 'pspice' ? parsePropertyRecords(text, { excludeAmbiguous: true }) : undefined })
        }
      }
      const meta = metadata.get(metaKey)
      if (!meta) { skip('no-paired-metadata'); continue }
      const evidence = library === 'tina' ? tinaIndexEvidence(meta.text, model.id) : propertyEvidence(meta.records, model.id)
      if (!evidence) { skip('metadata-not-specific-or-unresolved'); continue }
      const explanation = library === 'tina' ? `Paired TLD exact root [${evidence.tag}] index` : `PRP exact root${evidence.implementations.length ? ' and every explicitly linked Hierarchical Implementation' : ''}: SYMBOL_NAME=${evidence.symbols.join(',')}; symbol labels establish this category only, never pin order`
      const key = `${library}/${relative}/${evidence.category}`
      const group = groups.get(key) ?? { library, file: basename(relative), sha256: meta.sha256, evidenceFile: meta.file, evidence: explanation, category: evidence.category, ids: [], lines: [], implementationExamples: [] }
      group.ids.push(model.id)
      if (evidence.line) group.lines.push(evidence.line)
      if (evidence.implementations?.length && group.implementationExamples.length < 2) group.implementationExamples.push({ id: model.id, implementations: evidence.implementations })
      groups.set(key, group)
    }
  }
  const sources = [...groups.values()].map(group => ({ ...group, ids: [...new Set(group.ids)].sort((a, b) => a.localeCompare(b, 'en')), lines: [...new Set(group.lines)].sort((a, b) => a - b) })).sort((a, b) => a.library.localeCompare(b.library) || a.file.localeCompare(b.file) || a.category.localeCompare(b.category))
  return { version: 1, generation: manifest.generation, taxonomyRevision: manifest.taxonomyRevision, scope: 'Exact paired TLD tags and complete PRP implementation-symbol evidence for stored unclassified subcircuits; no electrical model, pin or symbol change.', storedUnknown, classifiedVersions: sources.reduce((sum, source) => sum + source.ids.length, 0), skipped, sources }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
  if (!value('--cache-root') || !value('--library-root') || !value('--output')) throw new Error('Usage: node scripts/extract-classification-source-evidence.mjs --cache-root CACHE --library-root LIBRARY --output NEW_JSON')
  const report = await extractClassificationSourceEvidence({ cacheRoot: resolve(value('--cache-root')), libraryRoot: resolve(value('--library-root')) })
  await writeFile(resolve(value('--output')), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ generation: report.generation, storedUnknown: report.storedUnknown, classifiedVersions: report.classifiedVersions, groups: report.sources.length, skipped: report.skipped }))
}
