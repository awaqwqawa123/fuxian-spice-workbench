/** Read-only audit of a compiled local library. No vendor SPICE text is emitted. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { modelCategory } from '../src/core/model-taxonomy'
import type { ImportedSpiceModel } from '../src/core/spice-models'

interface Manifest {
  schema: number; generation: string; total: number; versions: number; indexHash: string
  chunks: { summaries: string; models: string }[]
}
interface Entry { key: string; id: string; category: string; source: string; chunk: number }
interface Sample { id: string; pins: number; function?: string; type?: string; symbolFamily?: string }
export interface ClassificationAudit {
  generation: string; schema: number; uniqueModels: number; versions: number
  integrity: { checkedModelKeys: number; checkedChunks: number; modelKeySetHash: string; pinsHash: string; spiceHash: string; symbolHash: string }
  storedCategories: Record<string, number>; currentCategories: Record<string, number>
  transitions: Record<string, number>; unknownBySource: Record<string, number>
  unknownFiles: { source: string; count: number; samples: Sample[] }[]
}
export interface ClassificationAuditOptions {
  cacheRoot?: string; seedRoot?: string; top?: number
}
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const count = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1 }
const ordered = (map: Record<string, number>) => Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
async function checkedJson<T>(path: string, expected: string): Promise<T> {
  const raw = await readFile(path)
  if (sha(raw) !== expected) throw new Error(`校验失败：${path}`)
  return JSON.parse(raw.toString('utf8')) as T
}

/** Only a missing cache falls back to the shipped seed; corruption is an error. */
export async function auditModelClassification(options: ClassificationAuditOptions): Promise<ClassificationAudit> {
  let root = options.cacheRoot && resolve(options.cacheRoot)
  let manifest: Manifest | undefined
  if (root) {
    try { manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Manifest }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !options.seedRoot) throw error }
  }
  if (!manifest) {
    if (!options.seedRoot) throw new Error('请指定 --cacheRoot 或 --seedRoot')
    root = resolve(options.seedRoot)
    manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Manifest
  }
  if (!Number.isSafeInteger(manifest.schema) || !/^[0-9]{13}-[a-f0-9-]{36}$/.test(manifest.generation) || !Array.isArray(manifest.chunks)) throw new Error('无效的目录清单')
  const generationRoot = join(root!, manifest.generation)
  const index = await checkedJson<{ entries: Entry[] }>(join(generationRoot, 'index.json'), manifest.indexHash)
  if (!Array.isArray(index.entries) || index.entries.length !== manifest.versions) throw new Error('索引数量与清单不一致')
  const entries = new Map(index.entries.map(entry => [entry.key, entry]))
  if (entries.size !== index.entries.length) throw new Error('索引模型键重复')
  const storedCategories: Record<string, number> = {}, currentCategories: Record<string, number> = {}, transitions: Record<string, number> = {}, unknownBySource: Record<string, number> = {}
  const unknownFiles = new Map<string, { source: string; count: number; samples: Sample[] }>()
  const digests: { key: string; pins: string; spice: string; symbol: string }[] = []
  const seen = new Set<string>()
  for (let chunk = 0; chunk < manifest.chunks.length; chunk++) {
    const expected = index.entries.filter(entry => entry.chunk === chunk)
    const models = await checkedJson<ImportedSpiceModel[]>(join(generationRoot, `${chunk}.models.json`), manifest.chunks[chunk].models)
    const summaries = await checkedJson<{ key: string; id: string }[]>(join(generationRoot, `${chunk}.summaries.json`), manifest.chunks[chunk].summaries)
    if (!Array.isArray(models) || !Array.isArray(summaries) || models.length !== expected.length || summaries.length !== expected.length) throw new Error(`分块 ${chunk} 数量不匹配`)
    const summaryKeys = new Map(summaries.map(summary => [summary.key, summary.id]))
    if (summaryKeys.size !== summaries.length) throw new Error(`分块 ${chunk} 摘要键重复`)
    for (const model of models) {
      const key = sha(JSON.stringify(model)), entry = entries.get(key)
      if (!entry || entry.id !== model.id || entry.chunk !== chunk || summaryKeys.get(key) !== model.id || seen.has(key)) throw new Error(`分块 ${chunk} 模型身份不匹配：${model.id}`)
      seen.add(key)
      const category = modelCategory(model)
      count(storedCategories, entry.category); count(currentCategories, category)
      if (category !== entry.category) count(transitions, `${entry.category} → ${category}`)
      digests.push({ key, pins: sha(JSON.stringify(model.pins)), spice: sha(model.spice), symbol: sha(JSON.stringify(model.symbol ?? null)) })
      if (category === 'subcircuit:other') {
        count(unknownBySource, entry.source)
        const source = model.source.label, group = unknownFiles.get(source) ?? { source, count: 0, samples: [] }
        group.count++
        if (group.samples.length < 3) group.samples.push({ id: model.id, pins: model.pins.length, function: model.deviceInfo?.function?.slice(0, 160), type: model.metadata.type?.slice(0, 160), symbolFamily: model.symbol?.family })
        unknownFiles.set(source, group)
      }
    }
  }
  if (seen.size !== entries.size) throw new Error('存在未验证模型')
  digests.sort((a, b) => a.key.localeCompare(b.key))
  return {
    generation: manifest.generation, schema: manifest.schema, uniqueModels: manifest.total, versions: manifest.versions,
    integrity: { checkedModelKeys: seen.size, checkedChunks: manifest.chunks.length, modelKeySetHash: sha(JSON.stringify(digests.map(item => item.key))), pinsHash: sha(JSON.stringify(digests.map(item => [item.key, item.pins]))), spiceHash: sha(JSON.stringify(digests.map(item => [item.key, item.spice]))), symbolHash: sha(JSON.stringify(digests.map(item => [item.key, item.symbol]))) },
    storedCategories: ordered(storedCategories), currentCategories: ordered(currentCategories), transitions: ordered(transitions), unknownBySource: ordered(unknownBySource),
    unknownFiles: [...unknownFiles.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)).slice(0, options.top ?? 30),
  }
}

export function compareClassificationAudits(before: ClassificationAudit, after: ClassificationAudit) {
  const fields = ['modelKeySetHash', 'pinsHash', 'spiceHash', 'symbolHash'] as const
  return { unchangedModels: before.versions === after.versions && fields.every(field => before.integrity[field] === after.integrity[field]), changedIntegrityFields: fields.filter(field => before.integrity[field] !== after.integrity[field]), beforeUnknown: before.storedCategories['subcircuit:other'] ?? 0, afterUnknown: after.storedCategories['subcircuit:other'] ?? 0 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), read = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
  const report = await auditModelClassification({ cacheRoot: read('--cacheRoot'), seedRoot: read('--seedRoot'), top: Number(read('--top') ?? 30) })
  const compareRoot = read('--compareRoot')
  const comparison = compareRoot && compareClassificationAudits(report, await auditModelClassification({ cacheRoot: compareRoot, top: 0 }))
  process.stdout.write(JSON.stringify(comparison ? { report, comparison } : report, null, 2) + '\n')
  if (comparison && !comparison.unchangedModels) process.exitCode = 2
}
