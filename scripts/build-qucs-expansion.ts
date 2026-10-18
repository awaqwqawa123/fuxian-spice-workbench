/** Offline conversion of pinned Qucs-S reference data. GPL-2.0-or-later.
 * Never remove unsupported electrical fields or publish fragments of a rejected chip.
 * Run after build-qucs-models.py with: node --import tsx scripts/build-qucs-expansion.ts
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { parseSpiceLibrary } from '../src/core/spice-models'

const root = new URL('../public/models/qucs/', import.meta.url)
const revision = 'e0c0e154edb4f8403d53c5c5601c2ee133c9e970'
const categories = [
  ['DiodesSchottky', 'schottky', '肖特基二极管'], ['Z-Diodes', 'zener', '稳压二极管'],
] as const
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))
const previousIds = new Set<string>(manifest.converted.flatMap((file: any) => file.models.map((model: any) => model.id.toLowerCase())))
const cpp = await readFile(new URL('upstream/diode.cpp', root), 'utf8')
const diodeDefaults = Object.fromEntries([...cpp.matchAll(/Props.append\(new Property\("([^"\n]+)",\s*"([^"\n]+)"/g)].map(match => [match[1], match[2]]))
const diodeOrder = Object.keys(diodeDefaults)
const ignored: Record<string, string[]> = { Temp: ['26.85'], Area: ['1', '1.0'], UseGlobTemp: ['yes'], LibName: ['Generic'], CompName: ['Generic'], Ffe: ['1', '1.0'], Cp: ['0', '0.0', '0.0 fF'], Ttt1: ['0', '0.0'], Ttt2: ['0', '0.0'], Tm1: ['0', '0.0'], Tm2: ['0', '0.0'], Symbol: ['normal'] }
const rename: Record<string, string> = { Cj0: 'CJO', Tbv: 'TBV1', Trs: 'TRS1' }
function numeric(value: string): string {
  // Units are annotations, not multiplication factors. Retain the SPICE suffix.
  // Lowercase f is the femto scale, NOT the uppercase F unit annotation.
  const normalized = value.trim().replace(/\s+(?:Ohm|A|V|F|s)$/, '').replace(/(?<=[0-9fpnum])(?:Ohm|A|V|F|s)$/, '').replace(/\s+/g, '')
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i.test(normalized)) throw new Error(`Nonconstant value: ${value}`)
  return normalized
}
function diodeParameters(overrides: Record<string, string>): string {
  const assigned = { ...diodeDefaults, ...overrides }
  const result: string[] = []
  for (const [key, value] of Object.entries(assigned)) {
    if (ignored[key]) { if (!ignored[key].includes(value)) throw new Error(`Unsupported physics ${key}=${value}`); continue }
    if (key === 'Ikf' && Number(value) === 0) continue // upstream 0 means disabled high injection
    result.push(`${rename[key] ?? key.toUpperCase()}=${numeric(value)}`)
  }
  return result.join(' ')
}
function nativeDiode(category: string, part: string, block: string): string {
  if (category === 'DiodesSchottky') {
    const nodes = [...block.matchAll(/<Diode\s[^>]*>/g)]
    if (nodes.length !== 1) throw new Error('Not one diode primitive')
    const values = [...nodes[0][0].matchAll(/"([^"\n]*)"\s+[01]/g)].map(match => match[1])
    if (values.length !== 28) throw new Error('Unexpected Schottky property count')
    if (values[2] === '29.2') throw new Error('Upstream Cj0=29.2 implies 29.2 F for SD103ASDM/ATW; quarantined rather than guessing a missing pico suffix')
    return `.model ${part}_QUCS D(${diodeParameters(Object.fromEntries(values.map((value, i) => [diodeOrder[i], value])))} mfg="Qucs community / unspecified manufacturer" type="Schottky single die")`
  }
  const model = block.match(/<Model>([\s\S]*?)<\/Model>/)?.[1]
  if (!model) throw new Error('No native model')
  const lines = model.trim().split(/\r?\n/).map(line => line.trim())
  const header = lines.shift()!.match(/^\.Def:\S+\s+(.+)$/)
  if (!header || lines.pop() !== '.Def:End') throw new Error('Unsupported native subcircuit structure')
  const sourcePins = header[1].split(/\s+/)
  if (sourcePins.length !== 2) throw new Error('Native Zener must have exactly two ports')
  const pin = (node: string) => node === sourcePins[0] ? 'K' : node === sourcePins[1] ? 'A' : node
  const output = [`.subckt ${part}_QUCS K A`]
  for (const line of lines) {
    const record = line.match(/^(Diode|Vdc):(\w+)\s+(\S+)\s+(\S+)\s+(.+)$/)
    if (!record) throw new Error(`Unsupported native element: ${line}`)
    const [, kind, name, a, b, tail] = record
    const props = Object.fromEntries([...tail.matchAll(/(\w+)="([^"\n]+)"/g)].map(match => [match[1], match[2]]))
    if (kind === 'Diode') {
      const modelId = `Z${sha256(part + name).slice(0, 10)}_QUCS`
      // Native Qucs diode port order is K,A; diode.cpp exports pin_seq 1,0.
      output.push(`${name} ${pin(b)} ${pin(a)} ${modelId}`, `.model ${modelId} D(${diodeParameters(props)})`)
    } else {
      if (Object.keys(props).join() !== 'U') throw new Error('Unsupported Vdc field')
      output.push(`${name} ${pin(a)} ${pin(b)} DC ${numeric(props.U)}`)
    }
  }
  output.push(`.ends ${part}_QUCS`)
  return output.join('\n')
}

const files: any[] = [], skipped: any[] = [], packages: any[] = [], registered: any[] = []
const sourcePins = JSON.parse(await readFile(new URL('upstream/expansion-sources.json', root), 'utf8'))
if (sourcePins.revision !== revision) throw new Error('Expansion source revision mismatch')
for (const file of sourcePins.files) {
  const bytes = await readFile(new URL(`upstream/${file.file}`, root))
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  if (blob !== file.gitBlobSha1) throw new Error(`Pinned upstream blob mismatch: ${file.file}`)
  files.push({ file: `upstream/${file.file}`, url: `https://raw.githubusercontent.com/ra3xdh/qucs_s/${revision}/${file.path}`, bytes: bytes.length, sha256: sha256(bytes), gitBlobSha1: blob })
}
await mkdir(new URL('expanded/', root), { recursive: true })
for (const [category, slug, title] of categories) {
  const input = new URL(`upstream/${category}.lib`, root), bytes = await readFile(input)
  const sourceFile = `upstream/${category}.lib`, sourceUrl = `https://raw.githubusercontent.com/ra3xdh/qucs_s/${revision}/library/${category}.lib`
  const accepted: any[] = []
  for (const component of bytes.toString('utf8').matchAll(/<Component ([^>]+)>([\s\S]*?)<\/Component>/g)) {
    const [, part, block] = component
    try {
      if (previousIds.has(`${part}_QUCS`.toLowerCase()) && category === 'DiodesSchottky') throw new Error('Part already shipped from Diodes.lib; retain existing attributed source')
      const generated = { text: nativeDiode(category, part, block), rootId: `${part}_QUCS`, adaptations: ['Converted Qucs native diode/voltage network using pinned diode.cpp property order, constructor defaults and K,A to A,K diode port mapping; Vdc port order preserved per volt_dc.cpp'] }
      const source = { label: `离线开源库 / Qucs-S 社区参考 / ${category} / ${part}`, url: sourceUrl, license: 'GPL-2.0-or-later', attribution: 'Qucs-S project and contributors；不是厂商官网原件。保留整个电气网络及内部依赖，原作者及厂商说明见随附上游文件；单通道模型不表示整颗多通道封装。型号添加 _QUCS，内部名称隔离。源文件、GPL 许可和转换记录随库提供。' }
      const preview = parseSpiceLibrary(generated.text, source)
      const errors = preview.diagnostics.filter(issue => issue.severity === 'error')
      if (errors.length) throw new Error([...new Set(errors.map(issue => issue.message))].join('; '))
      const model = preview.models.find(model => model.id === generated.rootId)
      if (!model) throw new Error('Complete public model missing after parse')
      const file = `expanded/${slug}-${part.toLowerCase()}.lib`
      const text = [`* Pinned Qucs-S community reference; GPL-2.0-or-later; NOT a manufacturer original.`, `* ${category}/${part}; ${revision}`, ...generated.adaptations.map(note => '* ' + note), ...block.match(/<Description>([\s\S]*?)<\/Description>/)![1].trim().split(/\r?\n/).map(line => '* ' + line.trim()), generated.text].join('\n') + '\n'
      await writeFile(new URL(file, root), text)
      accepted.push({ id: model.id, part, type: model.type, pins: model.pins, adaptations: generated.adaptations, declarations: preview.models.length })
      registered.push({ packageId: `qucs-${slug}`, file: `qucs/${file}`, source, excludedIds: preview.models.filter(item => item.id !== model.id).map(item => item.id) })
      files.push({ file, upstream: `${category}.lib`, bytes: Buffer.byteLength(text), sha256: sha256(text), models: accepted.slice(-1), skipped: [] })
      previousIds.add(model.id.toLowerCase())
    } catch (error) { skipped.push({ upstream: `${category}.lib`, part, reason: (error as Error).message }) }
  }
  if (accepted.length) packages.push({ id: `qucs-${slug}`, name: `Qucs · ${title}`, license: 'GPL-2.0-or-later', detail: `${accepted.length} 个社区参考；保留完整电气网络与依赖。`, notice: '来源为 Qucs-S 社区参考库；未经过厂商认证，实际精度及适用条件须核对。多通道 IC 仅表示来源中的单通道。', documentation: '/models/qucs/README.md' })
  console.log(category, accepted.length, 'accepted')
}
const report = { revision, license: 'GPL-2.0-or-later', files, packages, registered, skipped, publicModels: registered.length }
// Remove only obsolete outputs named in this converter's previous manifest.
try {
  const prior = JSON.parse(await readFile(new URL('expansion-manifest.json', root), 'utf8'))
  for (const row of prior.files) if (/^expanded\/[a-z0-9_.-]+\.lib$/.test(row.file) && !files.some(file => file.file === row.file)) await unlink(new URL(row.file, root))
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
await writeFile(new URL('expansion-manifest.json', root), JSON.stringify(report, null, 2) + '\n')
await writeFile(new URL('../src/core/qucs-model-expansion.ts', import.meta.url), '// Generated offline by scripts/build-qucs-expansion.ts; GPL-2.0-or-later.\nexport const qucsExpandedPackages = ' + JSON.stringify(packages, null, 2) + ' as const\nexport const qucsExpandedFiles = ' + JSON.stringify(registered, null, 2) + '\n')
console.log(registered.length, 'public models;', skipped.length, 'whole definitions skipped')
