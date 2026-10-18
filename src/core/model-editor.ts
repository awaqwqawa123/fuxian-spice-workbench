import { parseProject, type Project } from './circuit'
import { modelFor, models as builtInModels } from './devices'
import { parseSpiceLibrary, type ImportedSpiceModel, type ImportedModelKind, type SpiceModelSource } from './spice-models'
import { assessmentAfterModelEdit } from './model-assessment-persistence'

export interface ModelEditTarget { deviceId?: string; modelId?: string }
export type ModelEditScope = 'device' | 'all' | 'project'
export interface ModelEditDraft {
  originalId: string
  originalSpice: string
  model: ImportedSpiceModel
  text: string
  builtIn: boolean
  references: string[]
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function resolveTarget(project: Project, target: ModelEditTarget) {
  if (Boolean(target.deviceId) === Boolean(target.modelId)) throw new Error('请选择一个器件或工程模型。')
  const device = target.deviceId ? project.drawing?.devices.find(part => part.id === target.deviceId) : undefined
  if (target.deviceId && !device) throw new Error('这个器件已不在当前工程中，请重新选择。')
  if (device && !['D', 'Q', 'M', 'J'].includes(device.kind)) throw new Error('当前支持二极管、三极管、MOS 和 JFET 的 .model 编辑；其他器件请调整器件参数。')
  const imported = project.models?.find(model => sameId(model.id, device?.value ?? target.modelId!))
  const original = imported ?? (device ? modelFor(device.kind, device.value) : undefined)
  if (!original || device && original.kind !== device.kind) throw new Error('找不到这个器件的可编辑模型。')
  const references = project.drawing?.devices.filter(part => part.kind === original.kind && sameId(part.value, original.id)).map(part => part.id) ?? []
  return { original, imported, references, device }
}

export function suggestedModelName(project: Project, originalId: string): string {
  const existing = new Set([...builtInModels, ...(project.models ?? [])].map(model => model.id.toLowerCase()))
  const base = originalId.replace(/^fx_/i, 'USER_').slice(0, 30)
  let candidate = `${base}_edit`, index = 2
  while (existing.has(candidate.toLowerCase())) candidate = `${base}_edit${index++}`
  return candidate
}

function editedSource(source: SpiceModelSource): SpiceModelSource {
  const suffix = ' · 用户修改'
  return {
    ...source,
    label: source.label.endsWith(suffix) ? source.label : source.label.slice(0, 200 - suffix.length) + suffix,
    ...(source.license ? { license: source.license.replace(/模型原文未修改/g, '模型已由用户修改') } : {}),
  }
}

/** Prepare a local draft. Built-in definitions are copied, never mutated. */
export function createModelEditDraft(project: Project, target: ModelEditTarget): ModelEditDraft {
  const { original, imported, references } = resolveTarget(project, target)
  const source = imported?.source ?? { label: '伏线内置通用教学模型', attribution: '伏线 SPICE Workbench · 非厂商认证模型' }
  const text = target.deviceId ? original.spice.replace(/^(\.model\s+)\S+/i, `$1${suggestedModelName(project, original.id)}`) : original.spice
  const model = parseSpiceLibrary(text, source).models[0]
  if (!model) throw new Error('无法为这个模型建立编辑副本。')
  model.metadata = { ...(imported?.metadata ?? {}) }
  if(imported?.symbol)model.symbol=structuredClone(imported.symbol)
  const assessment=assessmentAfterModelEdit(imported,model)
  if(assessment)model.assessment=assessment
  return { originalId: original.id, originalSpice: original.spice, model, text, builtIn: !imported, references }
}

/** Validate and produce one immutable project change suitable for undo/redo. */
export function prepareModelEdit(project: Project, target: ModelEditTarget, text: string, scope: ModelEditScope) {
  const { original, imported, references, device } = resolveTarget(project, target)
  if (target.modelId && scope !== 'project' || target.deviceId && scope === 'project') throw new Error('模型应用范围与当前编辑入口不一致。')
  const source = editedSource(imported?.source ?? { label: '伏线内置通用教学模型', attribution: '伏线 SPICE Workbench · 非厂商认证模型' })
  const preview = parseSpiceLibrary(text, source)
  const errors = preview.diagnostics.filter(item => item.severity === 'error')
  if (errors.length) throw new Error(errors.map(item => `第 ${item.line} 行：${item.message}`).join('\n'))
  if (preview.models.length !== 1) throw new Error('每次编辑需要且只能包含一个独立模型定义。')
  const model = preview.models[0]
  const expectedPins: Record<ImportedModelKind, number> = { D: 2, Q: 3, M: 3, J: 3, X:'pins'in original?original.pins.length:0 }
  if (model.kind !== original.kind || model.pins.length !== expectedPins[original.kind as ImportedModelKind]) throw new Error(`模型类型必须与原器件 ${original.kind} 的逻辑引脚匹配，不能通过模型编辑更换器件种类。`)
  if(model.kind==='X'&&JSON.stringify(model.pins)!==JSON.stringify('pins'in original?original.pins:[]))throw new Error('子电路端口顺序已改变；请作为新型号导入并重新接线。')
  model.metadata = { ...(imported?.metadata ?? {}), ...model.metadata }
  if(imported?.symbol)model.symbol=structuredClone(imported.symbol)
  const assessment=assessmentAfterModelEdit(imported,model)
  if(assessment)model.assessment=assessment
  const replacing = scope !== 'device' && Boolean(imported)
  const conflict = project.models?.find(item => sameId(item.id, model.id) && !(replacing && item.id === imported!.id))
  if (conflict) throw new Error(`模型名 ${model.id} 已存在。请为独立副本选择新名称，不能覆盖其他模型。`)
  const models = replacing ? project.models!.map(item => item.id === imported!.id ? model : item) : [...(project.models ?? []), model]
  const affectedDeviceIds = scope === 'device' ? [device!.id] : references
  const affected = new Set(affectedDeviceIds)
  const next = parseProject({
    ...project,
    models,
    ...(project.drawing ? { drawing: { ...project.drawing, devices: project.drawing.devices.map(part => affected.has(part.id) ? { ...part, value: model.id } : part) } } : {}),
  }, { allowDraft: true })
  return { project: next, model: next.models!.find(item => item.id === model.id)!, affectedDeviceIds, created: !replacing, previousModelId: original.id }
}
