import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'

export const WURTH_SOURCES = [
  { repo: 'WurthElektronik/LTspice-Library', revision: '4e1fb4ce5fc31d500206e100647a82abf36a0d71', rootPath: 'sub/', label: 'Würth Elektronik 官方 LTspice 模型' },
  { repo: 'WurthElektronik/Pspice-Library', revision: '5168590e698b5c90aa3f0bab458198f2c30168d9', rootPath: 'library/', label: 'Würth Elektronik 官方 PSpice 模型' },
]
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const safeName = name => /^[a-z0-9_.+-]{1,64}$/i.test(name)
const safePath = path => path.length < 500 && !/[\x00-\x1f\\?#%]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..')

/** Keep original pin order; local .model / nested .subckt definitions are not independent parts. */
export function parseWurthDeclarations(text) {
  if (/LTspice Encrypted File|\$CDNENCSTART|\.protect\b/i.test(text)) return { declarations: [], encrypted: true, helperDeclarations: 0 }
  const lines = []
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\*/.test(line)) continue
    if (/^\s*\+/.test(line) && lines.length) lines[lines.length - 1] += ' ' + line.replace(/^\s*\+/, '')
    else lines.push(line)
  }
  const found = new Map(), referenced = new Set()
  let depth = 0
  for (const raw of lines) {
    const line = raw.split(';')[0].trim(), fields = line.split(/\s+/), directive = fields[0]?.toLowerCase()
    if (directive === '.ends') { depth = Math.max(0, depth - 1); continue }
    if (directive === '.subckt') {
      if (depth === 0 && safeName(fields[1] ?? '')) {
        const pins = []
        for (const token of fields.slice(2)) {
          if (/^params?:?$/i.test(token) || token.includes('=')) break
          if (/^[a-z0-9_.+-]{1,64}$/i.test(token)) pins.push(token)
        }
        if (pins.length && pins.length <= 128) found.set(fields[1].toLowerCase(), { name: fields[1], kind: 'subckt', pins })
      }
      depth++
      continue
    }
    if (directive === '.model' && depth === 0 && safeName(fields[1] ?? '')) found.set(fields[1].toLowerCase(), { name: fields[1], kind: 'model' })
    if (depth && /^x/i.test(fields[0] ?? '')) {
      const parameters = fields.findIndex((token, index) => index > 0 && (/^params?:?$/i.test(token) || token.includes('=')))
      const called = fields[(parameters > 0 ? parameters : fields.length) - 1]
      if (called) referenced.add(called.toLowerCase())
    }
  }
  // Numeric product declarations remain searchable even if wrappers reference them.
  const helpers = [...found.values()].filter(item => !/\d/.test(item.name) && referenced.has(item.name.toLowerCase()))
  const helperKeys = new Set(helpers.map(item => item.name.toLowerCase()))
  return { declarations: [...found.values()].filter(item => !helperKeys.has(item.name.toLowerCase())).sort((a, b) => compare(a.name, b.name)), encrypted: false, helperDeclarations: helpers.length }
}

export function buildWurthCatalog(bytes, source) {
  if (bytes.length > 128 * 1024 * 1024) throw new Error('Würth archive exceeds 128 MiB')
  if (!WURTH_SOURCES.some(item => item.repo === source.repo && item.revision === source.revision && item.rootPath === source.rootPath)) throw new Error('Unreviewed Würth source')
  const prefix = `${source.repo.split('/')[1]}-${source.revision}/`
  const stats = { sourceFiles: 0, oversizedFiles: 0, encryptedFiles: 0, emptyFiles: 0, helperDeclarations: 0 }
  let totalSize = 0
  const entries = unzipSync(bytes, { filter(file) {
    if (!file.name.startsWith(prefix + source.rootPath)) return false
    const path = file.name.slice(prefix.length)
    if (!/\.(?:lib|mod|sub|spi|spice|cir)$/i.test(path) || !safePath(path)) return false
    stats.sourceFiles++
    if (file.originalSize > 1024 * 1024) { stats.oversizedFiles++; return false }
    if ((totalSize += file.originalSize) > 64 * 1024 * 1024) throw new Error('Würth selected sources exceed 64 MiB')
    return true
  } })
  if (!stats.sourceFiles) throw new Error('Archive does not contain the reviewed source prefix')
  const files = Object.entries(entries).map(([path, content]) => {
    const { declarations, encrypted, helperDeclarations } = parseWurthDeclarations(new TextDecoder('windows-1252').decode(content))
    if (encrypted) stats.encryptedFiles++
    if (!declarations.length) stats.emptyFiles++
    stats.helperDeclarations += helperDeclarations
    return { path: path.slice(prefix.length), size: content.length, sha256: createHash('sha256').update(content).digest('hex'), names: declarations.map(item => item.name), declarations }
  }).sort((a, b) => compare(a.path, b.path))
  return { ...source, archiveSha256: createHash('sha256').update(bytes).digest('hex'), stats, files }
}

export function serializeWurthCatalogs(catalogs) { return JSON.stringify({ schema: 1, catalogs }) + '\n' }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ltArchive, psArchive, output] = process.argv.slice(2)
  if (!ltArchive || !psArchive) throw new Error('Usage: node scripts/build-wurth-model-index.mjs pinned-ltspice.zip pinned-pspice.zip [output.json]')
  const catalogs = []
  for (const [index, path] of [ltArchive, psArchive].entries()) catalogs.push(buildWurthCatalog(new Uint8Array(await readFile(path)), WURTH_SOURCES[index]))
  await writeFile(output ?? new URL('../server/wurth-model-declaration-index.json', import.meta.url), serializeWurthCatalogs(catalogs))
  for (const catalog of catalogs) process.stdout.write(`${catalog.repo}: ${catalog.files.length} bounded files, ${catalog.files.reduce((sum, file) => sum + file.names.length, 0)} top-level declarations, ${JSON.stringify(catalog.stats)}\n`)
}
