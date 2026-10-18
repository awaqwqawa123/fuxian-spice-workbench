/** Expand the four immutable, downloaded source archives into a private local
 * library. Original electrical and symbol files are retained without changes.
 * The workbench does not redistribute these vendor/community originals.
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join, sep } from 'node:path'
import { unzipSync } from 'fflate'

const root = resolve(process.env.SPICE_MODEL_LIBRARY_DIR || 'E:/spice-workbench-library')
const entries = [
  { key: 'community', repo: 'kicad-spice-library/KiCad-Spice-Library', revision: 'a8688952bcaab19f567bc4db237b60bde03ef310', archiveSha256: 'f97845105c5f27c5aaaa15cefa7a7621b7475a0ce6bc5c5f0650228da8c4a2c5' },
  { key: 'wurth-ltspice', repo: 'WurthElektronik/LTspice-Library', revision: '4e1fb4ce5fc31d500206e100647a82abf36a0d71' },
  { key: 'wurth-pspice', repo: 'WurthElektronik/Pspice-Library', revision: '5168590e698b5c90aa3f0bab458198f2c30168d9' },
  { key: 'qucs', repo: 'ra3xdh/qucs_s', revision: 'e0c0e154edb4f8403d53c5c5601c2ee133c9e970' },
]
await mkdir(join(root, 'sources'), { recursive: true })
const manifest = { version: 1, sources: [] }
for (const source of entries) {
  const archive = join(root, 'archives', source.key + '.zip')
  if ((await stat(archive)).size > 600 * 1024 * 1024) throw new Error('Source archive exceeds the bounded import size')
  const bytes = await readFile(archive)
  const archiveSha256 = createHash('sha256').update(bytes).digest('hex')
  if (source.archiveSha256 && source.archiveSha256 !== archiveSha256) throw new Error('Community archive does not match the previously verified download')
  const directory = resolve(root, 'sources', source.key)
  const treePrefix = source.repo.split('/')[1] + '-' + source.revision + '/'
  let total = 0, count = 0
  const files = unzipSync(bytes, { filter(file) {
    if (!file.name.startsWith(treePrefix)) throw new Error('Archive root does not match the immutable source')
    const relative = file.name.slice(treePrefix.length)
    if (!relative || relative.endsWith('/')) return false
    if (/[\x00-\x1f\\]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid archived source path')
    if (++count > 100_000 || file.originalSize > 256 * 1024 * 1024 || (total += file.originalSize) > 1500 * 1024 * 1024) throw new Error('Expanded source exceeds the bounded import size')
    return true
  } })
  const extensions = {}
  for (const [path, content] of Object.entries(files)) {
    const relative = path.slice(treePrefix.length)
    const target = resolve(directory, relative)
    if (!target.startsWith(directory + sep)) throw new Error('Source path escaped its library directory')
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, content)
    const extension = relative.split('/').at(-1).split('.').slice(1).at(-1)?.toLowerCase() || '(none)'
    extensions[extension] = (extensions[extension] || 0) + 1
  }
  manifest.sources.push({ ...source, archive, archiveSha256, directory, fileCount: count, bytes: total, extensions })
  await writeFile(join(root, 'sources', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ source: source.key, files: count, bytes: total, modelAndSymbolFiles: Object.fromEntries(Object.entries(extensions).filter(([key]) => ['lib', 'olb', 'asy', 'mod', 'sub', 'spi', 'cir', 'spice', 'dio', 'bjt', 'mos', 'jft'].includes(key))) }))
}
