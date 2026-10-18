import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'
import { decodeSpiceLibrary, parseSpiceLibrary, SPICE_LIBRARY_LIMITS } from '../src/core/spice-models'
import { localLibraryRoots, readLocalModelCatalog } from '../server/model-library'

// Run with: tsx scripts/audit-installed-model-sources.ts
// This reads installed files in place and emits aggregate results only.
const root = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'LTspice', 'lib')
const component = await readLocalModelCatalog()
const subRoot = join(root, 'sub')
const files: string[] = []
async function walk(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (entry.isFile() && /\.(?:sub|lib)$/i.test(entry.name)) files.push(path)
  }
}
try { await walk(subRoot) } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

const groups = new Map<string, { files: number; declarations: number; parserAccepted: number; cleanFiles: number; filesWithAccepted: number; parserErrors: number; oversized: number; kinds: Record<string, number>; errorExamples: Record<string, number> }>()
function group(name: string) {
  let result = groups.get(name)
  if (!result) {
    result = { files: 0, declarations: 0, parserAccepted: 0, cleanFiles: 0, filesWithAccepted: 0, parserErrors: 0, oversized: 0, kinds: {}, errorExamples: {} }
    groups.set(name, result)
  }
  return result
}
const supportedNames = new Map<string, string[]>()
const cleanCandidates: { file: string; declarations: number; models: string[] }[] = []
for (const path of files.sort()) {
  const rel = relative(subRoot, path).replaceAll('\\', '/')
  const bucket = group(rel.startsWith('Contrib/') ? rel.split('/').slice(0, 2).join('/') : 'LTspice/sub (root)')
  bucket.files++
  const info = await stat(path)
  if (info.size > SPICE_LIBRARY_LIMITS.fileBytes) { bucket.oversized++; continue }
  const input = decodeSpiceLibrary(await readFile(path))
  const declarations = [...input.matchAll(/^\s*\.(?:model|subckt)\s+\S+/gim)].length
  bucket.declarations += declarations
  const parsed = parseSpiceLibrary(input, { label: 'Installed LTspice audit' })
  const errors = parsed.diagnostics.filter(item => item.severity === 'error')
  bucket.parserAccepted += parsed.models.length
  bucket.parserErrors += errors.length
  if (!errors.length) {
    bucket.cleanFiles++
    if (parsed.models.length) cleanCandidates.push({ file: rel, declarations, models: parsed.models.map(model => model.id) })
  }
  if (parsed.models.length) bucket.filesWithAccepted++
  for (const model of parsed.models) {
    bucket.kinds[model.type] = (bucket.kinds[model.type] ?? 0) + 1
    const names = supportedNames.get(model.id.toLowerCase()) ?? []
    names.push(rel)
    supportedNames.set(model.id.toLowerCase(), names)
  }
  for (const issue of errors) {
    const category = issue.message.split('：')[0].replace(/^第 \d+ 行/, '第 N 行')
    bucket.errorExamples[category] = (bucket.errorExamples[category] ?? 0) + 1
  }
}
const totals = [...groups.values()].reduce((sum, item) => ({
  files: sum.files + item.files, declarations: sum.declarations + item.declarations,
  parserAccepted: sum.parserAccepted + item.parserAccepted, cleanFiles: sum.cleanFiles + item.cleanFiles,
  filesWithAccepted: sum.filesWithAccepted + item.filesWithAccepted,
  parserErrors: sum.parserErrors + item.parserErrors, oversized: sum.oversized + item.oversized,
}), { files: 0, declarations: 0, parserAccepted: 0, cleanFiles: 0, filesWithAccepted: 0, parserErrors: 0, oversized: 0 })
const duplicates = [...supportedNames].filter(([, paths]) => paths.length > 1)
console.log(JSON.stringify({
  date: new Date().toISOString(), component: component.files, componentTotals: { accepted: component.models.length, rejected: component.files.reduce((sum, file) => sum + file.rejected, 0) },
  subRoot, totals, uniqueParserAccepted: supportedNames.size, duplicateNames: duplicates.length,
  duplicateExamples: duplicates.slice(0, 20), groups: Object.fromEntries(groups), cleanCandidates,
}, null, 2))
