import { readFile, writeFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'

// Download the archive for a reviewed KiCad-Spice-Library commit, then run:
// node scripts/build-model-declaration-index.mjs archive.zip COMMIT_SHA
// Search uses this compact declaration index; downloads still use the pinned
// upstream file and pass the normal compatibility parser before import.
const [archivePath, revision, outputPath] = process.argv.slice(2)
if (!archivePath || !/^[a-f0-9]{40}$/.test(revision ?? '')) {
  throw new Error('Usage: node scripts/build-model-declaration-index.mjs archive.zip 40-character-commit')
}
const zipped = await readFile(archivePath)
const extensions = JSON.parse(await readFile(new URL('../server/model-file-extensions.json', import.meta.url), 'utf8'))
const modelFile = new RegExp(`\\.(?:${extensions.join('|')})$`, 'i')
if (zipped.length > 25 * 1024 * 1024) throw new Error('Source archive exceeds the reviewed 25 MiB limit')
const archive = unzipSync(new Uint8Array(zipped), { filter: file => file.name.startsWith(`KiCad-Spice-Library-${revision}/Models/`) && file.originalSize <= 1024 * 1024 })
const files = []
for (const [archivePath, bytes] of Object.entries(archive)) {
  const marker = '/Models/'
  const offset = archivePath.indexOf(marker)
  if (offset < 0 || bytes.length > 1024 * 1024) continue
  const path = archivePath.slice(offset + 1)
  if (!modelFile.test(path) || /[\x00-\x1f\\?#%]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) continue
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  let text
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch { if (encoding !== 'utf-8') throw new Error(`Incomplete UTF-16 model file: ${path}`); text = new TextDecoder('windows-1252').decode(bytes) }
  const names = [...new Set([...text.matchAll(/^\s*\.(?:model|subckt)\s+(\S+)/gim)]
    .map(match => match[1]).filter(name => name.length <= 64))].sort((a, b) => a.localeCompare(b))
  if (names.length) files.push([path, names])
}
files.sort((a, b) => a[0].localeCompare(b[0]))
const output = outputPath ?? new URL('../server/model-declaration-index.json', import.meta.url)
await writeFile(output, JSON.stringify({ revision, files }) + '\n')
process.stdout.write(`${files.length} files, ${files.reduce((sum, [, names]) => sum + names.length, 0)} declarations\n`)
