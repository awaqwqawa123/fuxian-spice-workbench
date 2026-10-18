import type { AcquisitionResult } from './model-acquisition'
import type { DatasheetText } from './datasheet-text'
import { createModelTask, mentionedModelParts, modelTaskBoundPart, uniqueModelPart, type ModelTask } from './model-tasks'
import { modelTaskQuickPrompt } from './model-task-guidance'
import { restoreModelTaskReference } from './model-task-reference'
import { identifyDatasheetParts } from './datasheet-part-identification'

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const partPattern = (part: string) => new RegExp(`(?<![A-Z0-9._-])${escapePattern(part)}(?![A-Z0-9._-])`, 'gi')

/** Filename prefixes are metadata only when the document independently names the remaining part. */
export function datasheetFilenamePart(document: Pick<DatasheetText, 'fileName' | 'pages'>): string | undefined {
  const stem = document.fileName.replace(/\.[^.]+$/, '').toUpperCase()
  const filePart = uniqueModelPart(stem)
  if (!filePart) return undefined
  const text = document.pages.map(page => page.text).join('\n')
  if (partPattern(filePart).test(text)) return filePart
  const withoutMaker = filePart.replace(/^(?:LRC|TI|ONSEMI|ON|NEXPERIA|NXP|ST|ADI|INFINEON)[_-]/, '')
  if (withoutMaker !== filePart && uniqueModelPart(withoutMaker) === withoutMaker && partPattern(withoutMaker).test(text)) return withoutMaker
  return undefined
}

export function modelPartChoices(result?: AcquisitionResult): NonNullable<AcquisitionResult['partChoices']> {
  if (!Array.isArray(result?.partChoices)) return []
  const seen = new Set<string>()
  return result.partChoices.filter(choice => {
    if (!choice || typeof choice.part !== 'string' || uniqueModelPart(choice.part) !== choice.part.toUpperCase() || /XX/i.test(choice.part)
      || (choice.referenceVoltage !== undefined && (typeof choice.referenceVoltage !== 'number' || !Number.isFinite(choice.referenceVoltage) || choice.referenceVoltage <= 0))
      || typeof choice.evidence !== 'string' || !choice.evidence.trim() || choice.evidence.length > 4000) return false
    const key = choice.part.toUpperCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 24)
}

/** Choosing a documented variant always starts a clean backend session with the same evidence. */
export function modelTaskForPartChoice(source: ModelTask, part: string): ModelTask {
  const choice = modelPartChoices(source.result).find(item => item.part.toUpperCase() === part.toUpperCase())
  if (!choice) throw new Error('该型号未在当前规格书选择中，请重新核对资料。')
  let request = source.draft.trim() || [...source.history].reverse().find(message => message.role === 'user')?.content.trim() || ''
  for (const oldPart of mentionedModelParts(request)) if (oldPart !== choice.part.toUpperCase()) request = request.replace(partPattern(oldPart), choice.part)
  if (!request) request = modelTaskQuickPrompt(choice.part, 'datasheet')
  else if (!mentionedModelParts(request).includes(choice.part.toUpperCase())) request = `请为 ${choice.part} 建立模型。\n${request}`
  const task = createModelTask(request)
  const remote = source.result?.partChoiceDocument
  task.reference = source.reference?.document ? { ...source.reference, part: choice.part }
    : remote ? restoreModelTaskReference({ label: remote.fileName, text: '', document: remote, part: choice.part })
    : source.reference ? { ...source.reference, part: choice.part } : undefined
  return task
}

/** Resolve identity from original pages, never the compact excerpt or an opaque filename. */
export function modelTaskDocumentIdentity(task: ModelTask) {
  return task.reference?.document ? identifyDatasheetParts(task.reference.document) : undefined
}

export function modelTaskHasBackendState(task: ModelTask): boolean {
  return Boolean(task.history.length || task.steps.length || task.result || task.fallback || task.status !== 'queued')
}

/** Keep historical backend identities immutable; an unbound used task must fork before binding. */
export function bindModelTaskDocument(source: ModelTask, selectedPart?: string): { task: ModelTask; error?: string } {
  if (!source.reference?.document) return { task: source }
  const identity = modelTaskDocumentIdentity(source)!
  const explicit = source.planContext && source.targetPart ? source.targetPart : uniqueModelPart(source.draft) ?? source.targetPart
  const documented = identity.candidates.map(item => item.part.toUpperCase())
  const selection = selectedPart?.toUpperCase()
  if (selection && !documented.includes(selection)) return { task: source, error: '所选型号不在当前规格书识别结果中，请核对当前资料。' }
  if (!selection && explicit && documented.length && !identifyDatasheetParts(source.reference.document,explicit).candidates.some(candidate=>candidate.part.toUpperCase()===explicit)) return { task: source, error: `需求型号 ${explicit} 与规格书中的 ${documented.join('、')} 不一致。请添加对应规格书，或选择这份规格书里的目标型号。` }
  const previousPart = modelTaskBoundPart(source)
  const part = selection ?? explicit ?? (source.targetPart && documented.includes(source.targetPart.toUpperCase()) ? source.targetPart.toUpperCase() : undefined) ?? (source.reference.part && documented.includes(source.reference.part.toUpperCase()) ? source.reference.part.toUpperCase() : undefined) ?? identity.part
  if (!part) return { task: source, error: documented.length ? '这份规格书包含多个型号，请在下方选择目标型号后生成；需求原文已保留。' : '规格书中尚未识别出完整型号，请核对可读的标题页或补充完整型号；已有资料与需求保留。' }
  let draft = source.draft
  if (selection && explicit && explicit !== part) draft = draft.replace(partPattern(explicit), part)
  const fork = modelTaskHasBackendState(source) && previousPart !== part || Boolean(previousPart && previousPart !== part)
  const task = fork ? { ...createModelTask(draft, part), ...(source.planContext ? { planContext: source.planContext } : {}), reference: source.reference } : source
  return { task: { ...task, draft, title: part, targetPart: part, reference: { ...source.reference, part }, error: '', updatedAt: Date.now() } }
}
