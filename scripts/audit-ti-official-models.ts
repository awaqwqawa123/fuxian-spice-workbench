import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { decodeSpiceLibrary, parseSpiceLibrary, SPICE_LIBRARY_LIMITS } from '../src/core/spice-models'

// Download official product-page links to a temporary directory, then pass the
// zip paths as arguments. Only hashes, names and parser statistics are printed.
for (const path of process.argv.slice(2)) {
  const bytes = await readFile(path)
  if (bytes.length > 2 * 1024 * 1024) throw new Error('TI audit ZIP exceeds 2 MB review limit')
  let expanded = 0
  const archive = unzipSync(bytes, { filter: file => {
    expanded += file.originalSize
    if (expanded > 16 * 1024 * 1024) throw new Error('TI audit ZIP exceeds 16 MB expanded limit')
    return file.originalSize <= SPICE_LIBRARY_LIMITS.fileBytes
  } })
  const files = []
  for (const [name, input] of Object.entries(archive)) {
    if (!input.length || name.endsWith('/')) continue
    const item: Record<string, unknown> = { name, bytes: input.length }
    if (/\.(?:lib|mod|cir|sub|txt)$/i.test(name) && input.length <= SPICE_LIBRARY_LIMITS.fileBytes) {
      const text = decodeSpiceLibrary(input)
      const parsed = parseSpiceLibrary(text, { label: `TI official ${name}` })
      item.declarations = [...text.matchAll(/^\s*\.(?:model|subckt)\s+\S+/gim)].length
      item.parserAcceptedCount = parsed.models.length
      item.parserAcceptedExamples = parsed.models.slice(0, 40).map(model => ({ id: model.id, type: model.type }))
      const issues = new Map<string, number>()
      for (const issue of parsed.diagnostics.filter(item => item.severity === 'error')) {
        const category = issue.message.split('：')[0].replace(/^第 \d+ 行/, '第 N 行')
        issues.set(category, (issues.get(category) ?? 0) + 1)
      }
      item.parserErrors = Object.fromEntries(issues)
    }
    files.push(item)
  }
  console.log(JSON.stringify({ archive: path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), files }, null, 2))
}
