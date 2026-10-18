import { parseModelAssessment, type ModelAssessment } from './modeling-assessment'
import type { ImportedSpiceModel } from './spice-models'

/** Renaming keeps coverage; editing electrical code makes old mappings historical. */
export function assessmentAfterModelEdit(reference: ImportedSpiceModel | undefined, next: ImportedSpiceModel): ModelAssessment | undefined {
  if (!reference?.assessment) return undefined
  const normalize = (model: ImportedSpiceModel) => {
    const escaped = model.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return model.spice.replace(new RegExp(`(^\\s*\\.(?:model|subckt|ends)\\s+)${escaped}(?=\\s|$)`, 'gim'), '$1MODEL_ID')
  }
  const assessment = parseModelAssessment(reference.assessment)
  if (normalize(reference) === normalize(next)) return assessment
  return {
    ...assessment, status: 'partial', family:next.kind==='X'?assessment.family:next.type, summary: '模型代码已修改，原建模依据保留供核对；需重新检查参数与测试条件。',
    items: assessment.items.map(item => ({ ...item, status: 'unmapped', reason: `代码已修改，此项原映射需要重新核对。原说明：${item.reason}`.slice(0, 1000) })),
    validation: { syntax: 'passed', simulation: 'not-run' },
  }
}
