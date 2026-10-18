import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const groups = ['cmp', 'sub', 'sym']
const manifestName = 'paths_manifest.json'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const slash = path => path.split(sep).join('/')
const contained = (root, path) => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}

function noLinks(path) {
  let current = resolve(path)
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Symbolic link/junction requires review: ' + current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

function safePath(root, path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\') || path.includes(':') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid manifest path: ' + path)
  const actual = resolve(root, path)
  if (!contained(root, actual)) throw new Error('Path escapes library snapshot: ' + path)
  noLinks(actual)
  return actual
}

function collect(root, prefix = '') {
  noLinks(root)
  const result = []
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Symbolic link/junction requires review: ' + path)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) result.push({ sourcePath: path, path: prefix + slash(relative(root, path)) })
      else throw new Error('Unsupported filesystem entry: ' + path)
    }
  }
  walk(root)
  return result
}

function sourceRecords(sourceRoot) {
  return groups.flatMap(group => collect(join(sourceRoot, group), 'lib/' + group + '/')).map(file => {
    const bytes = readFileSync(file.sourcePath)
    return { ...file, size: bytes.length, sha256: sha256(bytes) }
  })
}

function summary(files) {
  return {
    totalFiles: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
    groups: Object.fromEntries(groups.map(group => [group, files.filter(file => file.path.startsWith('lib/' + group + '/')).length])),
    asy: files.filter(file => /\.asy$/i.test(file.path)).length,
  }
}

/** Preserve every original, including binaries, encrypted models and unsupported
 * symbols. No ngspice compatibility claim or ASY conversion is made here. */
export function importLtspiceLibrary({ sourceRoot, targetDir }) {
  sourceRoot = resolve(sourceRoot)
  const destination = resolve(targetDir, 'vendor', 'ltspice')
  noLinks(sourceRoot)
  noLinks(destination)
  const source = realpathSync(sourceRoot)
  if (contained(source, destination) || contained(destination, source)) throw new Error('Source and destination must not overlap')
  const files = sourceRecords(sourceRoot)
  // Preflight collisions before copying. Existing user edits are never replaced.
  for (const file of files) {
    const target = safePath(destination, file.path)
    if (existsSync(target) && (!lstatSync(target).isFile() || sha256(readFileSync(target)) !== file.sha256)) throw new Error('Existing original differs; preserved without overwrite: ' + target)
  }
  const manifestPath = safePath(destination, manifestName)
  if (existsSync(manifestPath)) {
    const previous = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (previous.vendor !== 'ltspice' || previous.schema !== 1 || !Array.isArray(previous.files) || previous.files.length !== files.length || previous.files.some((file, index) => file.path !== files[index].path || file.sha256 !== files[index].sha256)) throw new Error('Existing manifest differs; preserved without overwrite')
  }
  for (const group of groups) mkdirSync(safePath(destination, 'lib/' + group), { recursive: true })
  for (const file of files) {
    const target = safePath(destination, file.path)
    if (existsSync(target)) continue
    const bytes = readFileSync(file.sourcePath)
    if (sha256(bytes) !== file.sha256) throw new Error('Installed original changed during import: ' + file.sourcePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes, { flag: 'wx' })
  }
  const manifest = {
    schema: 1, vendor: 'ltspice', importedAt: new Date().toISOString(),
    sourceRoot, sourceLayout: groups, destinationLayout: 'vendor/ltspice/lib',
    preservation: 'All original bytes retained; no decryption, conversion or compatibility filtering.',
    ...summary(files), files,
  }
  // Publish only after originals exist. Interrupted imports can be resumed.
  if (!existsSync(manifestPath)) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  return verifyLtspiceLibrary({ targetDir, sourceRoot })
}

/** Offline verification uses only the portable snapshot. sourceRoot additionally
 * compares the entire installed file set and every byte hash. */
export function verifyLtspiceLibrary({ targetDir, sourceRoot }) {
  const destination = resolve(targetDir, 'vendor', 'ltspice')
  const manifest = JSON.parse(readFileSync(safePath(destination, manifestName), 'utf8'))
  if (manifest.schema !== 1 || manifest.vendor !== 'ltspice' || !Array.isArray(manifest.files)) throw new Error('Unsupported LTspice manifest')
  const names = new Set()
  for (const file of manifest.files) {
    if (!groups.some(group => typeof file.path === 'string' && file.path.startsWith('lib/' + group + '/')) || names.has(file.path)) throw new Error('Invalid or duplicate manifest path: ' + file.path)
    const target = safePath(destination, file.path)
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.sourcePath !== 'string' || !isAbsolute(file.sourcePath)) throw new Error('Invalid original record: ' + file.path)
    names.add(file.path)
    const bytes = readFileSync(target)
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error('Original checksum/size mismatch: ' + file.path)
  }
  const actualFiles = groups.flatMap(group => collect(join(destination, 'lib', group), 'lib/' + group + '/'))
  if (actualFiles.length !== names.size || actualFiles.some(file => !names.has(file.path))) throw new Error('Snapshot file set differs from manifest')
  const totals = summary(manifest.files)
  if (JSON.stringify(totals.groups) !== JSON.stringify(manifest.groups) || totals.totalFiles !== manifest.totalFiles || totals.bytes !== manifest.bytes || totals.asy !== manifest.asy) throw new Error('Manifest totals mismatch')
  if (sourceRoot) {
    const sources = sourceRecords(resolve(sourceRoot))
    const recorded = new Map(manifest.files.map(file => [file.path, file]))
    if (sources.length !== recorded.size || sources.some(file => { const original = recorded.get(file.path); return !original || original.sha256 !== file.sha256 || original.size !== file.size })) throw new Error('Installed originals differ from portable snapshot')
  }
  return { vendor: 'ltspice', destination, manifestPath: join(destination, manifestName), ...totals, verified: true, sourceCompared: Boolean(sourceRoot) }
}

function options(argv) {
  const result = { targetDir: join(workspaceRoot, 'model-library'), sourceRoot: join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'LTspice', 'lib'), verify: false, compareSource: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--verify') result.verify = true
    else if (arg === '--compare-source') result.compareSource = true
    else if (arg === '--help') {
      console.log('Import every local LTspice cmp/sub/sym original, without conversion.\nUsage: node scripts/import-ltspice-library.mjs [--source-root <LTspice/lib>] [--target-dir <model-library>] [--verify] [--compare-source]\n--verify validates the portable snapshot offline; --compare-source also compares installed originals.\nThe default destination is model-library alongside this script workspace, independent of the current working directory.')
      return
    } else if ((arg === '--source-root' || arg === '--target-dir') && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      const value = argv[++index]
      if (/^[a-z]+:\/\//i.test(value)) throw new Error('Only local filesystem directories are supported')
      result[arg === '--source-root' ? 'sourceRoot' : 'targetDir'] = resolve(value)
    } else throw new Error('Unknown or incomplete argument: ' + arg)
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = options(process.argv.slice(2))
    if (args) console.log(JSON.stringify(args.verify ? verifyLtspiceLibrary({ targetDir: args.targetDir, ...(args.compareSource ? { sourceRoot: args.sourceRoot } : {}) }) : importLtspiceLibrary(args), null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
