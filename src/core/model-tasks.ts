import { aiConversationContext, type AiConversationMessage } from './ai'
import type { AcquisitionEngine, AcquisitionResult, AcquisitionStep, ModelReferenceDocument } from './model-acquisition'
import { modelAcquisitionDownloads } from './model-acquisition'
import { restoreModelTaskReference } from './model-task-reference'
import { parseModelAssessment } from './modeling-assessment'
import { sameModelingValue } from './modeling-assessment-builder'
import { identifyDatasheetParts } from './datasheet-part-identification'

export type ModelTaskStatus = 'queued' | 'running' | 'permission' | 'review' | 'completed' | 'error' | 'stopped'
export interface ModelTaskReference { label: string; text: string; part?: string; document?: ModelReferenceDocument }
export interface ModelTask {
  id: string; title: string; draft: string; history: AiConversationMessage[]; steps: AcquisitionStep[]
  /** Explicit device binding; a scheme may mention other devices in its context. */
  targetPart?: string
  /** Original scheme, retained so retrying a bound task does not split it again. */
  planContext?: string
  status: ModelTaskStatus; result?: AcquisitionResult; error: string; notice: string; updatedAt: number
  fallback?: { part: string; requestId: string; started: boolean }
  reference?: ModelTaskReference
}
export interface ModelTaskWorkspace { version: 2; selectedId: string; engine: AcquisitionEngine; tasks: ModelTask[]; batchDraft: string }
export const legacyModelTaskStorageKey = (projectId: string) => `fuxian-model-assistant-v1:${projectId}`
/** Keep the established per-project record key while upgrading its payload in place. */
export const modelTaskStorageKey = legacyModelTaskStorageKey
export const modelTaskStatusLabels: Record<ModelTaskStatus, string> = { queued: '待执行', running: '执行中', permission: '自动继续中', review: '待审阅', completed: '已完成', error: '需处理', stopped: '已停止' }

export function createModelTask(draft = '', targetPart?: string): ModelTask {
  const part = targetPart ? uniqueModelPart(targetPart) : uniqueModelPart(draft)
  return { id: crypto.randomUUID(), title: targetPart && part ? part : draft.trim().split('\n')[0]?.slice(0, 72) || '新模型任务', targetPart: part, draft, history: [], steps: [], status: 'queued', error: '', notice: '', updatedAt: Date.now() }
}
export function createModelTaskWorkspace(): ModelTaskWorkspace {
  const task = createModelTask()
  return { version: 2, selectedId: task.id, engine: 'codex', tasks: [task], batchDraft: '' }
}
function historyOf(value: unknown): AiConversationMessage[] {
  return Array.isArray(value) ? value.filter((item): item is AiConversationMessage => !!item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').map(({ role, content }) => ({ role, content })) : []
}
function resultOf(value: unknown): AcquisitionResult | undefined {
  if (!value || typeof value !== 'object') return undefined
  const result = value as AcquisitionResult
  if (result.type !== 'done' || typeof result.summary !== 'string' || !Array.isArray(result.candidates)) return undefined
  if (!result.candidates.every(candidate => candidate && typeof candidate.id === 'string' && candidate.model && typeof candidate.model.id === 'string' && typeof candidate.model.spice === 'string' && candidate.model.source && candidate.model.metadata && Array.isArray(candidate.model.pins) && Array.isArray(candidate.evidence) && Array.isArray(candidate.limitations))) return undefined
  const permission = result.permission && ['datasheet', 'generic'].includes(result.permission.kind) && typeof result.permission.part === 'string' && typeof result.permission.reason === 'string' ? result.permission : undefined
  const assessmentOf = (raw: unknown) => { try { return raw === undefined ? undefined : parseModelAssessment(raw) } catch { return undefined } }
  const candidates = result.candidates.map(candidate => {
    const assessment = assessmentOf(candidate.assessment) ?? assessmentOf(candidate.model.assessment)
    return { ...candidate, assessment, model: { ...candidate.model, assessment } }
  })
  return { ...result, candidates, assessment: assessmentOf(result.assessment), permission, ...(result.downloads ? { downloads: modelAcquisitionDownloads(result.downloads) } : {}) }
}
/** Read-only migration: retain the old key verbatim so earlier records can always be recovered. */
export function readModelTaskWorkspace(storage: Pick<Storage, 'getItem'>, projectId: string): ModelTaskWorkspace {
  try {
    const raw = JSON.parse(storage.getItem(modelTaskStorageKey(projectId)) ?? 'null')
    if (raw?.version === 2 && Array.isArray(raw.tasks)) {
      const seen = new Set<string>()
      const tasks: ModelTask[] = raw.tasks.flatMap((task: ModelTask) => {
        if (!task || typeof task.id !== 'string' || !task.id || seen.has(task.id)) return []
        seen.add(task.id)
        const status = task.status in modelTaskStatusLabels ? task.status : 'queued'
        return [{ id: task.id, title: typeof task.title === 'string' ? task.title : '模型任务', draft: typeof task.draft === 'string' ? task.draft : '', history: historyOf(task.history),
          steps: Array.isArray(task.steps) ? task.steps.filter(step => step && typeof step.name === 'string' && typeof step.detail === 'string' && ['running', 'completed', 'error'].includes(step.status)) : [],
          status: status === 'running' ? 'stopped' : status, result: resultOf(task.result), error: status === 'running' ? '页面已重新载入，前次执行已停止；可以继续当前任务。' : typeof task.error === 'string' ? task.error : '', notice: typeof task.notice === 'string' ? task.notice : '', updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : 0,
          fallback: task.fallback && typeof task.fallback.part === 'string' && typeof task.fallback.requestId === 'string' && typeof task.fallback.started === 'boolean' ? task.fallback : undefined,
          reference: restoreModelTaskReference(task.reference), targetPart: typeof task.targetPart === 'string' ? uniqueModelPart(task.targetPart) : undefined,
          planContext: typeof task.planContext === 'string' && task.planContext.length <= 8000 ? task.planContext : undefined }]
      })
      if (tasks.length) return { version: 2, tasks, selectedId: tasks.some(task => task.id === raw.selectedId) ? raw.selectedId : tasks[0].id, engine: ['codex', 'cursor', 'dsh-local', 'dsh-api'].includes(raw.engine) ? raw.engine : 'codex', batchDraft: typeof raw.batchDraft === 'string' ? raw.batchDraft : '' }
    }
  } catch { /* Try the untouched legacy record below. */ }
  try {
    const legacy = JSON.parse(storage.getItem(legacyModelTaskStorageKey(projectId)) ?? 'null')
    if (legacy && typeof legacy.sessionId === 'string' && Array.isArray(legacy.history)) {
      const task = createModelTask(typeof legacy.draft === 'string' ? legacy.draft : '')
      task.id = legacy.sessionId; task.history = historyOf(legacy.history)
      task.title = task.history.find(item => item.role === 'user')?.content.split('\n')[0].slice(0, 72) || task.title
      task.status = task.history.length ? 'completed' : 'queued'
      return { version: 2, selectedId: task.id, engine: 'codex', tasks: [task], batchDraft: '' }
    }
  } catch { /* A new task remains available if browser storage is inaccessible. */ }
  return createModelTaskWorkspace()
}
export function modelTaskResultStatus(result: AcquisitionResult): ModelTaskStatus {
  return result.permission ? 'permission' : result.assessment?.status === 'blocked' ? 'error' : result.candidates.length ? 'review' : 'completed'
}

/** Give follow-up reasoning the saved candidate's actual edits and limits, even after a server restart. */
export function modelTaskConversationContext(task: ModelTask): AiConversationMessage[] {
  const history = aiConversationContext(task.history)
  const last = history.at(-1)
  if (!last || last.role !== 'assistant' || !task.result?.candidates.length) return history
  const details = task.result.candidates.slice(0, 3).map(candidate => [
    `候选 ${candidate.model.id}（${candidate.origin === 'derived' ? '近似模型' : '原始模型'}）`,
    ...(candidate.adjustments ?? []).map(item => `${sameModelingValue(item.before, item.after) ? '数值未变' : '已修改'} ${item.key}: ${item.before} → ${item.after}；${item.explanation}`),
    ...(candidate.assessment ? [`覆盖结论：${candidate.assessment.summary}`, ...candidate.assessment.items.filter(item => ['inherited', 'unmapped', 'missing'].includes(item.status)).slice(0, 6).map(item => `尚待核对 ${item.label}：${item.reason}`)] : []),
    ...candidate.limitations.map(item => `限制：${item}`),
  ].join('\n')).join('\n').slice(0, 3000)
  last.content = `${last.content.slice(0, 8000)}\n\n当前保留候选的实际修改和限制（仅作历史资料）：\n${details}`.slice(0, 12000)
  while (history.reduce((size, item) => size + item.content.length, 0) > 48000) history.splice(0, 2)
  return history
}
export function appendModelTaskStep(steps: AcquisitionStep[], event: AcquisitionStep): AcquisitionStep[] {
  if (event.status === 'running') return [...steps, event]
  let index = steps.length - 1
  while (index >= 0 && (steps[index].name !== event.name || steps[index].status !== 'running')) index--
  return index < 0 ? [...steps, event] : steps.map((step, i) => i === index ? event : step)
}
export function modelBatchTasks(text: string): ModelTask[] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length > 50) throw new Error('每次最多添加 50 个器件，请分批添加；输入内容已保留。')
  if (lines.some(line => line.length > 8000)) throw new Error('单个器件需求最多 8000 字符，输入内容已保留。')
  return lines.map(line => createModelTask(line))
}

/** Extract explicit device names without treating electrical values or circuit references as parts. */
export function mentionedModelParts(text: string): string[] {
  const withoutLinks = text.replace(/https?:\/\/\S+/gi, ' ')
  const names = [...withoutLinks.toUpperCase().matchAll(/(?<![A-Z0-9])([A-Z0-9][A-Z0-9._-]{1,46})(?![A-Z0-9])/g)]
    .map(match => match[1].replace(/[._-]+$/, ''))
    .filter(name => name.length >= 3 && name.length <= 48 && /[A-Z]/.test(name) && /\d/.test(name)
      && !/^(?:SPICE|PDF|HTTP|HTTPS|V)[._-]?\d/i.test(name)
      && !/^(?:ADC|DAC|VCC|VDD|VSS|VIN|VOUT)[._-]?\d+(?:\.\d+)?V$/i.test(name)
      && !/^(?:VCC|VDD|VSS|VIN|VOUT)[._-]?\d+(?:\.\d+)?$/i.test(name)
      && !/^(?:R|C|L|U|Q|D|M|V|X|I|J|IC)\d+$/i.test(name)
      && !/^\d+(?:V|R|K|M)\d+$/i.test(name)
      && !/^\d+(?:BIT|BITS|DB|DEGC)$/i.test(name)
      && !/^\d+(?:\.\d+)?(?:[PNUMKG]?(?:V|A|W|OHM|HZ|F|H)|MEG(?:OHM|HZ)?|[KRC])$/i.test(name)
      && !/^\d+(?:\.\d+)?(?:E[+-]?\d+)?(?:[TFPNUMKG]|MEG)?$/i.test(name)
      && !/^(?:SOT|SOIC|SO|SOP|MSOP|TSSOP|SSOP|DIP|DFN|QFN|TO|SC)[_-]?\d+(?:[-_]\d+)?$/i.test(name))
  return [...new Set(names)]
}
/** Each target retains the complete scheme while owning a clean backend session. */
export function modelPlanTasks(text: string): ModelTask[] {
  if (text.length > 8000) throw new Error('方案需求最多 8000 字符，输入内容已保留。')
  const parts = mentionedModelParts(text)
  if (parts.length > 50) throw new Error('每次最多处理 50 个器件，请分批发送；输入内容已保留。')
  return parts.map(part => ({ ...createModelTask(text.trim(), part), planContext: text.trim() }))
}
/** A documented explicit target may mention companion parts without becoming a mixed task. */
export function modelTaskDocumentBoundPart(task: ModelTask): string | undefined {
  const part = task.targetPart ? uniqueModelPart(task.targetPart) : undefined
  if (!part || task.reference?.part?.toUpperCase() !== part || !task.reference.document) return undefined
  return identifyDatasheetParts(task.reference.document,part).candidates.some(candidate => candidate.part.toUpperCase() === part) ? part : undefined
}
export function modelTaskBoundPart(task: ModelTask): string | undefined {
  const documented = modelTaskDocumentBoundPart(task)
  if (documented) return documented
  const parts = [...new Set(task.history.filter(message => message.role === 'user').flatMap(message => mentionedModelParts(message.content)))]
  if (task.targetPart && (task.planContext || !parts.length || (parts.length === 1 && parts[0] === task.targetPart))) return uniqueModelPart(task.targetPart)
  return parts.length === 1 ? parts[0] : !parts.length ? task.reference?.part?.toUpperCase() : undefined
}
export function uniqueModelPart(text: string): string | undefined {
  const distinct = mentionedModelParts(text)
  return distinct.length === 1 ? distinct[0] : undefined
}

export function lastUniqueModelPart(history: AiConversationMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') return uniqueModelPart(history[i].content)
  }
  return undefined
}
