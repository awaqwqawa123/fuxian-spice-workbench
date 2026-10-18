import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// These are local installer data roots, not arbitrary directories supplied by HTTP.
export const vendorLibraryLayouts = {
  pspice: ['tools/pspice/library', 'tools/capture/library'],
  tina: ['SPICELIB', 'MACROLIB', 'BUTTONS'],
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binaryExtensions = new Set(['.exe', '.dll', '.bpl', '.obj', '.o', '.pdb', '.msi'])
const tinaAuxiliary = new Set(['compregy.tcr', 'compbar.cfg', 'clcf.cat', 'spmacros.ind', 'packages.xml', 'base.mcd', 'smpl.teq', 'slm.aen', 'slm.bkw', 'slm.btn', 'readme.txt'])
const slash = (value) => value.split(sep).join('/')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

function options(argv) {
  const result = { targetDir: resolve(repoRoot, 'model-library'), cadenceRoot: 'E:/Cadence/SPB_25.1', tinaRoot: 'E:/TINA', vendor: 'all', verify: false }
  const names = { '--target-dir': 'targetDir', '--cadence-root': 'cadenceRoot', '--tina-root': 'tinaRoot', '--vendor': 'vendor' }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--verify') { result.verify = true; continue }
    if (argv[i] === '--help') {
      process.stdout.write('Import installed vendor model/symbol libraries into this repository.\nUsage: node scripts/import-installed-vendor-libraries.mjs [--target-dir <model-library>] [--vendor all|pspice|tina] [--cadence-root <installation>] [--tina-root <installation>] [--verify]\n--verify checks stored files against the manifest without requiring the original installation.\n')
      return undefined
    }
    const name = names[argv[i]]
    if (!name || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument: ${argv[i]}`)
    result[name] = argv[++i]
  }
  if (!['all', 'pspice', 'tina'].includes(result.vendor)) throw new Error('Vendor must be all, pspice or tina')
  for (const key of ['targetDir', 'cadenceRoot', 'tinaRoot']) {
    if (/^[a-z]+:\/\//i.test(result[key])) throw new Error(`${key} must be a local filesystem directory`)
    result[key] = resolve(result[key])
  }
  return result
}

function contained(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function safeTarget(root, rel) {
  if (typeof rel !== 'string' || isAbsolute(rel) || rel.includes('\\') || rel.split('/').some((part) => part === '..' || !part)) throw new Error(`Invalid manifest path: ${rel}`)
  const path = resolve(root, rel)
  if (!contained(root, path)) throw new Error(`Path escapes library snapshot: ${rel}`)
  // Never follow symlinks/junctions inside a writable snapshot.
  let current = root
  for (const part of rel.split('/')) {
    current = resolve(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Snapshot contains a symbolic link: ${current}`)
  }
  return path
}

function collectTree(root, subdir) {
  const records = []
  const tree = resolve(root, subdir)
  if (!existsSync(tree)) throw new Error(`Installed library directory is missing: ${tree}`)
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = resolve(path, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Installed library link requires explicit review: ${child}`)
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) {
        if (binaryExtensions.has(extname(entry.name).toLowerCase())) throw new Error(`Executable unexpectedly found inside model library: ${child}`)
        records.push({ source: child, path: slash(relative(root, child)) })
      }
    }
  }
  walk(tree)
  return records
}

function sourceFiles(vendor, root) {
  const files = vendorLibraryLayouts[vendor].flatMap((subdir) => collectTree(root, subdir))
  if (vendor === 'tina') {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (extname(entry.name).toLowerCase() === '.ddb' || tinaAuxiliary.has(entry.name.toLowerCase())) files.push({ source: resolve(root, entry.name), path: entry.name })
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

function inSelectedScope(vendor, path) {
  if (vendorLibraryLayouts[vendor].some((subdir) => path.startsWith(`${subdir}/`))) return true
  return vendor === 'tina' && !path.includes('/') && (extname(path).toLowerCase() === '.ddb' || tinaAuxiliary.has(path.toLowerCase()))
}

function kind(path) {
  const extension = extname(path).toLowerCase()
  if (['.lib', '.cir', '.mod', '.model', '.sp', '.spice', '.spicemodel', '.inc', '.sub'].includes(extension)) return 'electrical-model'
  if (['.olb', '.slb', '.plb', '.ddb', '.tsm', '.asy', '.mcd'].includes(extension)) return 'original-symbol-or-macro'
  if (['.ind', '.tld', '.prp', '.tag', '.cat', '.tcr'].includes(extension)) return 'vendor-index-or-metadata'
  return 'related-library-asset'
}

function version(vendor, root) {
  if (vendor === 'pspice') {
    const match = root.match(/(?:SPB_|OrCAD[_ -]?)(\d+(?:\.\d+)*)/i)
    return { product: 'Cadence OrCAD / PSpice', version: match?.[1] ?? 'unknown', versionEvidence: 'installation-directory-name' }
  }
  const readme = existsSync(resolve(root, 'readme.txt')) ? readFileSync(resolve(root, 'readme.txt'), 'latin1') : ''
  const match = readme.match(/New features in Tina-TI\s+([\d.]+)/i)
  return { product: 'DesignSoft TINA-TI', version: match?.[1] ?? 'unknown', versionEvidence: match ? 'installed-readme.txt' : 'not-available' }
}

function dependencyReferences(files, dataByPath) {
  const byPath = new Map(files.map((file) => [file.path.toLowerCase(), file.path]))
  const byName = new Map()
  for (const file of files) {
    const name = file.path.split('/').at(-1).toLowerCase()
    const list = byName.get(name) ?? []
    list.push(file.path); byName.set(name, list)
  }
  const references = []
  for (const file of files.filter((record) => kind(record.path) === 'electrical-model')) {
    const lines = dataByPath.get(file.path).toString('latin1').split(/\r?\n/)
    for (let line = 0; line < lines.length; line += 1) {
      const match = lines[line].match(/^\s*\.(include|inc|lib)\s+(?:"([^"]+)"|'([^']+)'|([^\s;]+))/i)
      if (!match) continue
      const reference = match[2] ?? match[3] ?? match[4]
      // .LIB section identifiers are not paths.
      if (match[1].toLowerCase() === 'lib' && !/\.(?:lib|inc|mod|cir|sp|spice|sub)$/i.test(reference)) continue
      const normalized = reference.replaceAll('\\', '/')
      const localPath = slash(relative('.', resolve(dirname(file.path), normalized)))
      let target = byPath.get(localPath.toLowerCase())
      let resolution = 'relative-to-source-file'
      const candidates = byName.get(normalized.split('/').at(-1).toLowerCase()) ?? []
      if (!target && candidates.length === 1) { target = candidates[0]; resolution = 'unique-file-in-library-search-path' }
      references.push({ from: file.path, line: line + 1, directive: match[1].toLowerCase(), reference, ...(target ? { target, resolution, status: 'available' } : { status: 'unresolved', candidates }) })
    }
  }
  return references
}

function totals(files) {
  const kinds = {}; const extensions = {}
  for (const file of files) {
    kinds[file.kind] = (kinds[file.kind] ?? 0) + 1
    const extension = extname(file.path).toLowerCase() || '(no-extension)'
    extensions[extension] = (extensions[extension] ?? 0) + 1
  }
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), kinds, extensions }
}

function writeAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.import-${process.pid}.tmp`
  try { writeFileSync(temp, bytes); renameSync(temp, path) } finally { if (existsSync(temp)) unlinkSync(temp) }
}

export function verifyVendorSnapshot(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'paths_manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error(`Unsupported manifest: ${root}`)
  if (!['pspice', 'tina'].includes(manifest.vendor)) throw new Error(`Unknown manifest vendor: ${root}`)
  const failures = []; const paths = new Set()
  for (const record of manifest.files) {
    if (!inSelectedScope(manifest.vendor, record.path)) throw new Error(`Manifest file is outside selected library scope: ${record.path}`)
    if (paths.has(record.path.toLowerCase())) throw new Error(`Duplicate manifest path: ${record.path}`)
    paths.add(record.path.toLowerCase())
    const path = safeTarget(root, record.path)
    if (!existsSync(path)) { failures.push({ path: record.path, reason: 'missing' }); continue }
    const bytes = readFileSync(path)
    if (bytes.length !== record.bytes || hash(bytes) !== record.sha256) failures.push({ path: record.path, reason: 'checksum-or-size-mismatch' })
  }
  if (JSON.stringify(totals(manifest.files)) !== JSON.stringify(manifest.totals)) failures.push({ path: 'paths_manifest.json', reason: 'summary-mismatch' })
  return { vendor: manifest.vendor, root, ...manifest.totals, verified: failures.length === 0, failures }
}

export function importVendorSnapshot(vendor, sourceRoot, targetRoot) {
  if (contained(sourceRoot, targetRoot) || contained(targetRoot, sourceRoot)) throw new Error('Source installation and target snapshot must be separate directories')
  const sources = sourceFiles(vendor, sourceRoot)
  const dataByPath = new Map(sources.map((file) => [file.path, readFileSync(file.source)]))
  const records = sources.map((file) => ({ path: file.path, sourceRelativePath: file.path, sha256: hash(dataByPath.get(file.path)), bytes: dataByPath.get(file.path).length, kind: kind(file.path) }))
  mkdirSync(targetRoot, { recursive: true })
  const oldManifestPath = resolve(targetRoot, 'paths_manifest.json')
  const previous = existsSync(oldManifestPath) ? JSON.parse(readFileSync(oldManifestPath, 'utf8')) : undefined
  if (previous && (previous.schemaVersion !== 1 || previous.vendor !== vendor || !Array.isArray(previous.files))) throw new Error('Existing snapshot manifest must be reviewed before replacement')
  const currentPaths = new Set(records.map((record) => record.path.toLowerCase()))
  const removedRecords = (previous?.files ?? []).filter((record) => !currentPaths.has(record.path.toLowerCase()))
  // Only prior manifest-owned library files are eligible; unrelated user files are preserved.
  const removedPaths = removedRecords.map((record) => {
    if (!inSelectedScope(vendor, record.path)) throw new Error(`Previous manifest path is outside selected library scope: ${record.path}`)
    return safeTarget(targetRoot, record.path)
  })
  let copied = 0; let unchanged = 0
  for (const record of records) {
    const path = safeTarget(targetRoot, record.path)
    if (existsSync(path) && hash(readFileSync(path)) === record.sha256) { unchanged += 1; continue }
    writeAtomic(path, dataByPath.get(record.path)); copied += 1
  }
  const references = dependencyReferences(sources, dataByPath)
  const manifest = {
    schemaVersion: 1, vendor, source: { installationRoot: slash(sourceRoot), ...version(vendor, sourceRoot), roots: vendorLibraryLayouts[vendor], snapshotPolicy: 'all-original-files-in-selected-library-roots-plus-explicit-TINA-device-and-symbol-metadata;no-compatibility-filter;no-executables' },
    files: records, totals: totals(records), collections: [...vendorLibraryLayouts[vendor], ...(vendor === 'tina' ? ['root-device-and-symbol-metadata'] : [])].map((collection) => ({ collection, ...totals(records.filter((record) => collection === 'root-device-and-symbol-metadata' ? !record.path.includes('/') : record.path.startsWith(`${collection}/`))) })), dependencies: { references, available: references.filter((entry) => entry.status === 'available').length, unresolved: references.filter((entry) => entry.status === 'unresolved').length },
    notice: 'Local snapshot of this user\'s installed vendor libraries. Originals remain unchanged; presence does not imply ngspice compatibility or permission to redistribute. Hashes refer to exact original file bytes.',
  }
  for (const path of removedPaths) if (existsSync(path)) unlinkSync(path)
  // No timestamps: a repeated import of unchanged sources produces the same manifest.
  writeAtomic(resolve(targetRoot, 'paths_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const verification = verifyVendorSnapshot(targetRoot)
  if (!verification.verified) throw new Error(`Snapshot verification failed: ${JSON.stringify(verification.failures)}`)
  return { ...verification, copied, unchanged, removed: removedPaths.length, sourceVersion: manifest.source.version, availableDependencies: manifest.dependencies.available, unresolvedDependencies: manifest.dependencies.unresolved }
}

const canonical = (path) => process.platform === 'win32' ? realpathSync(path).toLowerCase() : realpathSync(path)
if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) {
  try {
    const args = options(process.argv.slice(2))
    if (args) {
      const vendors = args.vendor === 'all' ? ['pspice', 'tina'] : [args.vendor]
      const reports = vendors.map((vendor) => {
        const target = resolve(args.targetDir, 'vendor', vendor)
        return args.verify ? verifyVendorSnapshot(target) : importVendorSnapshot(vendor, vendor === 'pspice' ? args.cadenceRoot : args.tinaRoot, target)
      })
      process.stdout.write(`${JSON.stringify({ targetDir: slash(args.targetDir), reports }, null, 2)}\n`)
      if (reports.some((report) => !report.verified)) process.exitCode = 1
    }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
