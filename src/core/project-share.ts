import { generateNetlist, parseProject, type Project } from './circuit'
import { modelFor } from './devices'
import { modelPinLabels } from './model-symbol'
import { projectFileName } from './project-file'
import { parseSpiceLibrary, type ImportedSpiceModel, type SpiceModelSource } from './spice-models'
import { initialSimulationProfiles, simulationNames } from './simulation-profiles'
import { waveformSetupIssues } from './waveform-setup'

export interface ShareIssue {
  kind: 'missing-model' | 'external-library' | 'model-definition' | 'pin-interface' | 'netlist' | 'configuration' | 'format'
  subject: string
  detail: string
}
export interface ShareModelEvidence {
  id: string
  mode: 'embedded' | 'built-in' | 'missing'
  devices: string[]
  source?: SpiceModelSource
  symbol: string
  ports: string[]
  subcircuits: string[]
}
export interface ProjectShareReview {
  status: 'ready' | 'draft' | 'blocked'
  project: Project
  filename: string
  issues: ShareIssue[]
  models: ShareModelEvidence[]
  unusedModels: number
  profiles: {name: string; analysis: string; active: boolean}[]
  waveformCount: number
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const modeledKinds = new Set(['D', 'Q', 'M', 'J', 'X'])

/** Review the exact device-scoped project to be exported. No I/O or simulation. */
export function reviewProjectShare(project: Project): ProjectShareReview {
  const drawing = project.template === 'custom' ? project.drawing : undefined
  const references = new Map<string, {kind: NonNullable<Project['drawing']>['devices'][number]['kind']; value: string; devices: string[]}>()
  const keyFor = (kind: string, id: string) => kind + ':' + id.toLowerCase()
  for (const device of drawing?.devices ?? []) {
    if (!modeledKinds.has(device.kind)) continue
    const key = keyFor(device.kind, device.value)
    const reference = references.get(key)
    if (reference) reference.devices.push(device.id)
    else references.set(key, { kind: device.kind, value: device.value, devices: [device.id] })
  }
  const embedded = (project.models ?? []).filter(model => references.has(keyFor(model.kind, model.id)))
  const attachments = new Map<string, ImportedSpiceModel>(embedded.map(model => [keyFor(model.kind, model.id), model]))
  let portable: Project = { ...project, ...(project.models ? { models: embedded } : {}) }
  const issues: ShareIssue[] = []
  const add = (kind: ShareIssue['kind'], subject: string, detail: string) => issues.push({kind, subject, detail})
  let blocked = false

  const models: ShareModelEvidence[] = [...references].map(([key, {kind, value, devices}]) => {
    const model = attachments.get(key), builtin = modelFor(kind, value)
    const id = model?.id ?? builtin?.id ?? (value || '未指定')
    if (!model && !builtin) add('missing-model', devices.join('、'), '缺少模型 ' + id + '；请导入并绑定到对应器件。')
    const subcircuits = model?.kind === 'X'
      ? [...model.spice.matchAll(/^[ \t]*\.subckt[ \t]+(\S+)/gim)].map(match => match[1])
      : []
    return {
      id, devices, mode: model ? 'embedded' : builtin ? 'built-in' : 'missing',
      ...(model ? { source: model.source } : {}),
      symbol: model?.symbol?.shape === 'ltspice' && model.symbol.origin !== 'standard' ? '内嵌原始符号'
        : model?.symbol ? '内嵌符号' : model || builtin ? '随软件生成的符号' : '待确认',
      ports: model ? modelPinLabels(model.kind, model.pins) : [],
      subcircuits,
    }
  })

  for (const model of embedded) {
    const lines = model.spice.split(/\r\n|\r|\n/)
    for (const [index, line] of lines.entries()) {
      if (!/^\s*\.(?:include|inc|lib)\b/i.test(line)) continue
      blocked = true
      add('external-library', model.id + ' · 第 ' + (index + 1) + ' 行', line.trim().slice(0, 240))
    }
  }
  for (const device of drawing?.devices ?? []) {
    if (device.kind !== 'X') continue
    const model = attachments.get(keyFor(device.kind, device.value))
    if (!model) continue
    if (!same(device.pins, model.pins)) {
      add('pin-interface', device.id, '画布端序：' + (device.pins?.join(' → ') || '未记录') + '；' + model.id + ' 的 .subckt 端序：' + model.pins.join(' → ') + '。请按模型端序重新放置。')
    }
    if (model.symbol?.shape === 'ltspice' && !same(device.pinPositions, model.symbol.pins.map(pin => ({x:pin.x,y:pin.y})))) {
      add('pin-interface', device.id, '画布引脚位置与已嵌入的 ' + model.id + ' 符号不一致，请重新放置。')
    }
  }

  if (!blocked) {
    try { portable = parseProject(portable, {allowDraft:true}) }
    catch (error) {
      blocked = true
      add('format','工程文件',errorText(error))
      // The archive validator reports the failing model. Surface the original
      // SPICE parser evidence as well, including missing named child circuits.
      for (const model of embedded) {
        if (model.kind !== 'X') continue
        try {
          for (const diagnostic of parseSpiceLibrary(model.spice,model.source).diagnostics) {
            if (diagnostic.severity === 'error') add('model-definition',model.id + ' · 第 ' + diagnostic.line + ' 行',diagnostic.message)
          }
        } catch (failure) { add('model-definition',model.id,errorText(failure)) }
      }
    }
  }
  const setup = portable.waveformSetup
  const profiles = setup?.profiles ?? initialSimulationProfiles(portable)
  if (!blocked) {
    try { generateNetlist(portable) }
    catch (error) {
      const known = new Set(issues.filter(issue => issue.kind === 'pin-interface' || issue.kind === 'missing-model').flatMap(issue => issue.subject.split('、')))
      for (const detail of errorText(error).split('\n')) {
        const device = detail.split('：')[0]
        if (known.has(device) && /请选择受支持的器件模型|画布引脚与|引脚坐标与/.test(detail)) continue
        add('netlist','当前电路',detail)
      }
    }
    const profileNames = new Map(profiles.profiles.map(profile => [profile.id,profile.name]))
    const diagramNames = new Map((setup?.diagrams ?? []).map(diagram => [diagram.id,diagram.title]))
    try {
      for (const detail of waveformSetupIssues(setup,portable)) {
        const prefix = detail.match(/^project\.waveformSetup\.(profiles|diagrams)\.([^.：]+)(.*)$/)
        const subject = prefix && (prefix[1] === 'profiles' ? profileNames : diagramNames).get(prefix[2])
        add('configuration', subject || '仿真与波形配置',prefix ? prefix[3].replace(/^[.：]+/,'') : detail)
      }
    } catch (error) { add('configuration', '仿真与波形配置', errorText(error)) }
  }
  const status = blocked ? 'blocked' : issues.length ? 'draft' : 'ready'
  const filename = projectFileName(portable)
  return {
    status, project: portable, filename: status === 'draft' ? filename.replace(/\.fuxian$/,'.draft.fuxian') : filename,
    issues, models, unusedModels: (project.models?.length ?? 0) - embedded.length,
    profiles: profiles.profiles.map(profile => ({name:profile.name,analysis:simulationNames[profile.settings.analysis],active:profile.id===profiles.activeId})),
    waveformCount: setup?.diagrams.length ?? 0,
  }
}
