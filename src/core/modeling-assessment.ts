export type ModelAssessmentStatus = 'adjusted' | 'unchanged' | 'unmapped' | 'missing' | 'inherited'
export interface ModelAssessmentItem {
  label: string; key?: string; status: ModelAssessmentStatus
  targetValue?: string; before?: string; after?: string; evidence?: string; reason: string
}
export interface ModelAssessment {
  version: 1; status: 'partial' | 'original' | 'blocked'; family: string; summary: string
  items: ModelAssessmentItem[]
  validation: { syntax: 'passed' | 'failed' | 'unchecked'; simulation: 'not-run' }
}
function object(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) throw new Error('建模评估字段格式不正确')
  return raw as Record<string, unknown>
}
function text(raw: unknown, name: string, limit: number): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) throw new Error(`建模评估${name}格式不正确`)
  return raw.trim()
}
/** Saved assessment describes coverage only; it cannot claim unperformed simulation. */
export function parseModelAssessment(raw: unknown): ModelAssessment {
  const value = object(raw, ['version', 'status', 'family', 'summary', 'items', 'validation'])
  if (value.version !== 1 || !['partial', 'original', 'blocked'].includes(String(value.status)) || !Array.isArray(value.items) || value.items.length > 80) throw new Error('建模评估版本或状态格式不正确')
  const validation = object(value.validation, ['syntax', 'simulation'])
  if (!['passed', 'failed', 'unchecked'].includes(String(validation.syntax)) || validation.simulation !== 'not-run') throw new Error('建模评估不能宣称尚未完成的仿真验证')
  const items = value.items.map(rawItem => {
    const item = object(rawItem, ['label', 'key', 'status', 'targetValue', 'before', 'after', 'evidence', 'reason'])
    if (!['adjusted', 'unchanged', 'unmapped', 'missing', 'inherited'].includes(String(item.status))) throw new Error('建模参数覆盖状态不正确')
    const result: ModelAssessmentItem = { label: text(item.label, '项目名称', 120), status: item.status as ModelAssessmentStatus, reason: text(item.reason, '项目说明', 1000) }
    for (const [key, limit] of [['key', 80], ['targetValue', 160], ['before', 160], ['after', 160], ['evidence', 2000]] as const) if (item[key] !== undefined) result[key] = text(item[key], key, limit)
    return result
  })
  return { version: 1, status: value.status as ModelAssessment['status'], family: text(value.family, '器件类别', 80), summary: text(value.summary, '摘要', 1000), items, validation: { syntax: validation.syntax as ModelAssessment['validation']['syntax'], simulation: 'not-run' } }
}
