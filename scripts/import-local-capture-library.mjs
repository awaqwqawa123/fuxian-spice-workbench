import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const slash = value => value.split(sep).join('/')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const within = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`) }

function targetPath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error(`Unsafe destination: ${name}`)
  const path = resolve(root, name)
  if (!within(root, path)) throw new Error(`Destination leaves library: ${name}`)
  let cursor = path
  while (within(root, cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`Destination crosses a symbolic link: ${cursor}`)
    if (cursor === root) break
    cursor = dirname(cursor)
  }
  return path
}
function store(path, bytes) {
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || hash(readFileSync(path)) !== hash(bytes)) throw new Error(`Existing file differs; preserved without overwrite: ${path}`)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.capture-import-${process.pid}.tmp`
  writeFileSync(temporary, bytes, { flag: 'wx' })
  renameSync(temporary, path)
}
function sourceBytes(source, destinationRoot) {
  if (!source || typeof source.path !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256 ?? '')) throw new Error('Each selected file requires its original local path and SHA-256')
  if (/^[a-z]+:\/\//i.test(source.path)) throw new Error('Only local selected files are accepted')
  const path = realpathSync(resolve(source.path))
  if (!lstatSync(path).isFile() || within(destinationRoot, path)) throw new Error(`Source must be an independent regular file: ${source.path}`)
  const bytes = readFileSync(path)
  if (hash(bytes) !== source.sha256) throw new Error(`Selected source SHA-256 changed: ${source.path}`)
  return { bytes, origin: { localPath: slash(path), sha256: source.sha256 } }
}
function pythonEnvironment(packages) {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(packages ? { PYTHONPATH: [resolve(packages), process.env.PYTHONPATH].filter(Boolean).join(delimiter) } : {}) }
}
function confirmCaptureFiles(paths, python, environment) {
  const program = 'import json,sys,olefile\nfor path in json.load(sys.stdin):\n with olefile.OleFileIO(path) as ole:\n  entries=ole.listdir()\n  if not ole.exists("Library") or not any(len(entry)==2 and entry[0]=="Packages" for entry in entries): raise ValueError("Not a Capture library: "+path)\nprint("Capture structures confirmed")'
  execFileSync(python, ['-c', program], { input: JSON.stringify(paths), env: environment, encoding: 'utf8', windowsHide: true })
}
function totals(files) {
  const kinds = {}, extensions = {}
  for (const file of files) { kinds[file.kind] = (kinds[file.kind] ?? 0) + 1; const extension = file.path.slice(file.path.lastIndexOf('.')).toLowerCase(); extensions[extension] = (extensions[extension] ?? 0) + 1 }
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), kinds, extensions }
}
export function verifyLocalCaptureLibrary(libraryRoot) {
  const root = resolve(libraryRoot, 'vendor/pspice'), manifest = JSON.parse(readFileSync(resolve(root, 'paths_manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.vendor !== 'pspice' || manifest.source?.selectionKind !== 'user-selected-local-capture-files') throw new Error('Not a selected local Capture manifest')
  const failures = [], names = new Set()
  for (const record of manifest.files) {
    const path = targetPath(root, record.path), key = record.path.toLowerCase()
    if (names.has(key)) throw new Error(`Duplicate manifest path: ${record.path}`)
    names.add(key)
    if (!existsSync(path)) { failures.push({ path: record.path, reason: 'missing' }); continue }
    const bytes = readFileSync(path)
    if (bytes.length !== record.bytes || hash(bytes) !== record.sha256) failures.push({ path: record.path, reason: 'checksum-or-size-mismatch' })
  }
  if (JSON.stringify(totals(manifest.files)) !== JSON.stringify(manifest.totals)) failures.push({ path: 'paths_manifest.json', reason: 'summary-mismatch' })
  const convertedRoot = resolve(libraryRoot, 'converted-symbols/pspice')
  for (const file of manifest.conversion.files) {
    const path = targetPath(convertedRoot, file.path)
    if (!existsSync(path)) { failures.push({ path: file.path, reason: 'conversion-missing' }); continue }
    const bytes = readFileSync(path), record = JSON.parse(bytes)
    if (hash(bytes) !== file.sha256 || record.originalSha256 !== file.originalSha256 || record.version !== 1) failures.push({ path: file.path, reason: 'conversion-checksum-or-source-mismatch' })
  }
  return { ...manifest.totals, captureOlbFiles: manifest.files.filter(file => file.kind === 'original-capture-symbol').length, convertedParts: manifest.conversion.parts, verified: failures.length === 0, failures }
}

/** Explicit selection only. This never discovers installations or scans personal folders. */
export function importLocalCaptureLibrary({ selection, libraryRoot = resolve(repoRoot, 'model-library'), python = 'python', pythonPackages }) {
  if (selection?.schemaVersion !== 1 || selection.selectionKind !== 'user-selected-local-capture-files' || !Array.isArray(selection.olbs) || !selection.olbs.length) throw new Error('An explicit local Capture selection is required')
  libraryRoot = resolve(libraryRoot)
  const root = resolve(libraryRoot, 'vendor/pspice'), convertedRoot = resolve(libraryRoot, 'converted-symbols/pspice'), environment = pythonEnvironment(pythonPackages)
  const pending = [], names = new Set(), originals = []
  function add(path, bytes, kind, origin, extra = {}) {
    targetPath(root, path)
    if (names.has(path.toLowerCase())) throw new Error(`Duplicate selected destination: ${path}`)
    names.add(path.toLowerCase())
    pending.push({ path, bytes, record: { path, bytes: bytes.length, sha256: hash(bytes), kind, origin, ...extra } })
  }
  for (const file of selection.olbs) {
    if (!/^tools\/capture\/library\/.+\.olb$/i.test(file.targetPath)) throw new Error(`Capture OLB must be stored under tools/capture/library: ${file.targetPath}`)
    const original = sourceBytes(file, root)
    originals.push(file.path)
    add(file.targetPath, original.bytes, 'original-capture-symbol', original.origin)
  }
  confirmCaptureFiles(originals, python, environment)
  if (selection.vca821) {
    const input = selection.vca821, archive = sourceBytes(input.zip, root), sub = sourceBytes(input.sub, root), asy = sourceBytes(input.asy, root)
    const files = unzipSync(archive.bytes), model = files['vca821.lib']
    if (!model) throw new Error('Selected TI ZIP does not contain original vca821.lib')
    const text = Buffer.from(model).toString('latin1')
    if (!/^\.SUBCKT VCA821 \+Vcc VG \+Vin \+Rg -Rg -Vin -Vcc Vref Out Gnd FB\s*$/im.test(text) || /^\s*\.(?:protect|unprotect)\b|BEGIN\s+ENCRYPTED|\$CD[KN]/im.test(text)) throw new Error('VCA821 ZIP model does not have the expected clear original 11-port interface')
    const selectedOlb = selection.olbs.find(file => basename(file.path).toLowerCase() === 'vca821.olb')
    if (!selectedOlb || !files['library/vca821.olb'] || hash(files['library/vca821.olb']) !== selectedOlb.sha256) throw new Error('Selected VCA821 OLB differs from original TI ZIP')
    if (hash(model) !== hash(sub.bytes)) throw new Error('Saved VCA821 SUB differs from original TI ZIP LIB; select and review the versions explicitly')
    add('originals/ti-vca821/' + basename(input.zip.path), archive.bytes, 'original-vendor-archive', archive.origin)
    add('originals/ti-vca821/vca821.sub', sub.bytes, 'original-clear-pspice-model', sub.origin, { note: 'Original user-saved SUB is byte-identical to the TI ZIP LIB; preserved without renaming.' })
    add('originals/ti-vca821/VCA821.asy', asy.bytes, 'original-user-ltspice-symbol', asy.origin, { note: 'Original ModelFile path preserved, including its stale absolute reference.' })
    add('tools/pspice/library/ti-vca821/vca821.lib', Buffer.from(model), 'electrical-model', { archive: archive.origin.localPath, archiveSha256: archive.origin.sha256, entry: 'vca821.lib' }, { note: 'Exact original download filename and bytes restored from selected TI ZIP; not generated model code.' })
    const originalAsy = asy.bytes.toString('latin1')
    if (!/^SYMATTR ModelFile .+$/m.test(originalAsy)) throw new Error('Original ASY ModelFile is absent; no replacement path invented')
    const derived = Buffer.from(originalAsy.replace(/^SYMATTR ModelFile .+$/m, 'SYMATTR ModelFile ../../tools/pspice/library/ti-vca821/vca821.lib'), 'latin1')
    add('derived/ti-vca821/VCA821.asy', derived, 'derived-ltspice-symbol', { originalPath: 'originals/ti-vca821/VCA821.asy', originalSha256: asy.origin.sha256 }, { note: 'Only ModelFile is corrected; geometry, names and explicit SpiceOrder are unchanged. Canvas association uses original OLB.' })
    if (input.tinaMacro) {
      const macro = sourceBytes(input.tinaMacro, root)
      if (macro.bytes.subarray(0, 4).toString('ascii') !== 'OBSS') throw new Error('Selected TINA macro does not have the expected OBSS header')
      add('originals/ti-vca821/sbom367.sub', macro.bytes, 'original-tina-binary-macro', macro.origin, { note: 'OBSS TINA macro container; never classified as clear SPICE text or made an electrical model.' })
    }
  }
  // Preflight every destination before saving anything; differing prior originals are never overwritten.
  for (const file of pending) {
    const path = targetPath(root, file.path)
    if (existsSync(path) && (!lstatSync(path).isFile() || hash(readFileSync(path)) !== file.record.sha256)) throw new Error(`Existing file differs; preserved without overwrite: ${path}`)
  }
  for (const file of pending) store(targetPath(root, file.path), file.bytes)
  execFileSync(python, [resolve(repoRoot, 'scripts/convert-orcad-symbols.py'), root, convertedRoot], { env: environment, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  const conversion = { files: [], parts: 0, templateMappedParts: 0, unverifiedParts: 0, rejectedStreams: 0, reasons: {} }
  for (const file of pending.filter(file => file.record.kind === 'original-capture-symbol')) {
    const cachePath = `${file.path}.json`, bytes = readFileSync(targetPath(convertedRoot, cachePath)), record = JSON.parse(bytes)
    if (record.version !== 1 || record.originalSha256 !== file.record.sha256) throw new Error(`Conversion source mismatch: ${file.path}`)
    const partResults = record.parts.map(part => {
      const mapped = part.pins.filter(pin => Number.isInteger(pin?.spiceOrder)), orders = mapped.map(pin => pin.spiceOrder).sort((a, b) => a - b)
      const verified = !part.unsupportedElectricalMapping && !!part.pspiceTemplate && orders.length > 0 && orders.every((order, index) => order === index + 1) && !part.issues?.length
      const reason = verified ? 'Explicit original PSpiceTemplate and device pin map; actual model declaration is still required for runtime linkage.' : (part.issues ?? []).join('; ') || 'No complete unique original PSpiceTemplate mapping; original geometry retained without inventing port order.'
      conversion.parts += 1
      conversion[verified ? 'templateMappedParts' : 'unverifiedParts'] += 1
      if (!verified) conversion.reasons[reason] = (conversion.reasons[reason] ?? 0) + 1
      return { id: part.id, modelId: part.modelId, physicalPins: part.pins.length, mappedPorts: verified ? mapped.length : 0, status: verified ? 'template-order-proven' : 'original-symbol-only', reason }
    })
    conversion.rejectedStreams += record.issues.length
    conversion.files.push({ path: cachePath, sha256: hash(bytes), originalSha256: file.record.sha256, parts: partResults, issues: record.issues })
  }
  const files = pending.map(file => file.record), manifest = { schemaVersion: 1, vendor: 'pspice', source: { selectionKind: selection.selectionKind, product: 'User-selected local Capture symbols and original TI VCA821 download', version: 'mixed-user-selected', versionEvidence: 'source-file-or-model-header-only;not-an-installed-Cadence-release', selectedFiles: selection.olbs.map(file => slash(file.path)), snapshotPolicy: 'explicit-selected-originals-plus-byte-exact-TI-ZIP-model-and-recorded-derived-ASY;not-complete-installation' }, files, totals: totals(files), conversion }
  mkdirSync(root, { recursive: true })
  // Manifest is generated data; original file conflicts were checked above.
  writeFileSync(resolve(root, 'paths_manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return verifyLocalCaptureLibrary(libraryRoot)
}

function options(argv) {
  const result = { libraryRoot: resolve(repoRoot, 'model-library') }
  const names = { '--selection': 'selectionPath', '--library-root': 'libraryRoot', '--python': 'python', '--python-packages': 'pythonPackages' }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--verify') { result.verify = true; continue }
    if (argv[index] === '--help') return undefined
    const name = names[argv[index]]
    if (!name || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${argv[index]}`)
    result[name] = argv[++index]
  }
  if (!result.verify && !result.selectionPath) throw new Error('--selection is required for an explicit file selection')
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = options(process.argv.slice(2))
    if (!result) console.log('Usage: node scripts/import-local-capture-library.mjs --selection <JSON> [--library-root <model-library>] [--python <python>] [--python-packages <local-site-packages>] | --verify [--library-root <model-library>]')
    else console.log(JSON.stringify(result.verify ? verifyLocalCaptureLibrary(result.libraryRoot) : importLocalCaptureLibrary({ ...result, selection: JSON.parse(readFileSync(resolve(result.selectionPath), 'utf8')) })))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}


