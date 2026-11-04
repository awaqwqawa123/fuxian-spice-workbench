import type { ImportedSpiceModel } from './spice-models'
import type { ModelCategoryId } from './model-taxonomy'
import { isInstalledTinaSource } from './installed-model-source'
import sourceEvidence from './model-category-source-evidence.json'
import semiconductorEvidence from './model-category-semiconductor-evidence.json'
import diodeEvidence from './model-category-diode-evidence.json'

interface ReviewedSource {
  library?: string
  file: string
  sha256: string
  evidenceFile?: string
  evidence: string
  category: string
  ids: string[]
}

// These records contain audited identifiers and provenance, never vendor model
// bodies. A library/file and exact root must both match: neither a model prefix
// nor a component inside its implementation establishes the enclosing function.
const records = new Map<string, ReviewedSource>()
for (const record of [...sourceEvidence.sources, ...semiconductorEvidence.sources, ...diodeEvidence.sources] as ReviewedSource[]) {
  for (const id of record.ids) {
    const key = `${record.library ?? 'pspice'}|${record.file.toLowerCase()}|${id.toLowerCase()}`
    const existing = records.get(key)
    if (existing && existing.category !== record.category) throw new Error(`器件分类证据冲突：${key}（${existing.category} / ${record.category}）`)
    records.set(key, record)
  }
}

export function reviewedModelSourceCategory(model: ImportedSpiceModel): { category: ModelCategoryId; reason: string } | undefined {
  const label = model.source.label.replaceAll('\\', '/')
  const pspice = label.match(/^PSpice 本地库 \/ tools\/pspice\/library\/([^/]+)$/i)
  // Use the importer's real current/legacy labels and the shared provenance
  // validator. A similar user label or an unregistered URL cannot inherit TLD
  // classification, and nested paths cannot match a reviewed file basename.
  const tina = isInstalledTinaSource(model.source) ? label.match(/^(?:TINA 本地库|本机 TINA) \/ SPICELIB\/([^/]+)$/) : undefined
  const library = pspice ? 'pspice' : tina ? 'tina' : undefined
  const file = (pspice ?? tina)?.[1]
  if (!library || !file) return undefined
  const record = records.get(`${library}|${file.toLowerCase()}|${model.id.toLowerCase()}`)
  if (!record) return undefined
  return { category: record.category as ModelCategoryId, reason: `原件 ${record.evidenceFile ?? record.file}：${record.evidence}（SHA-256 ${record.sha256}）` }
}
