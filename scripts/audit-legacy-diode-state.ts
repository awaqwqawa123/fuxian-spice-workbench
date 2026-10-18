import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readCompiledAuditModels } from '../server/model-electrical-audit'
import { importedModelNetlist } from '../src/core/spice-models'
import { normalizeLegacyDiodeDefaultStates } from '../src/core/spice-legacy-diode-state'

const root = resolve(process.argv[2] ?? 'model-library')
const output = resolve(process.argv[3] ?? 'verification/pspice-diode-state/default-family-audit.json')
const snapshot = await readCompiledAuditModels(root)
const candidates = snapshot.records.filter(({ model }) => model.kind === 'X' &&
  /PSpice/i.test(model.source.label) && /[\\/]di\.lib$/i.test(model.source.label))
const rows = candidates.map(({ key, model }) => {
  const invocation = `Verified default invocation\nV1 A 0 .05\nX1 A 0 ${model.id}\n${importedModelNetlist(model)}\n.op\n.end`
  const adapted = normalizeLegacyDiodeDefaultStates(invocation, [model.id])
  return { key, id: model.id, ports: model.pins, source: model.source.label,
    safeDefaultForm: adapted.convertedModels.length === 1,
    diagnostics: adapted.diagnostics.filter(issue => issue.severity === 'error') }
})
const report = {
  schema: 1, generation: snapshot.generation, sourceVersions: candidates.length,
  safeDefaultForms: rows.filter(row => row.safeDefaultForm).length,
  protectedForms: rows.filter(row => row.diagnostics.length > 0).length,
  unaffectedForms: rows.filter(row => !row.safeDefaultForm && !row.diagnostics.length).length,
  scope: 'Structural family audit only. Full invocation STATE/IC overrides and UIC are still checked at execution. Not a curve/precision certification for all devices.',
  rows,
}
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ sourceVersions: report.sourceVersions, safeDefaultForms: report.safeDefaultForms, protectedForms: report.protectedForms }))
