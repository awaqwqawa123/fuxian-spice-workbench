import {dcSource,parseSolverOptions,parseNodeVoltageSettings,validateSimulationOptions} from './simulation-options'
import { analysisSignals, circuitGraph, parseQuantity, type Project, type Quantity } from './circuit'
import { CANVAS_DIAGRAM_MAX, CANVAS_DIAGRAM_MIN } from './canvas-diagrams'
import { MAX_CANVAS_WAVEFORMS, validWaveformView, type CanvasWaveform, type WaveformViewState } from './canvas-waveform-store'
import { applySimulationProfile, parseSwitchStates, simulationReferenceWarning, type SimulationProfile, type SimulationProfiles } from './simulation-profiles'
import { compileDrawing, DRAWING_BOUNDS, terminalKey, type Pin, type Terminal } from './drawing'
import { branchCurrentSaveVectors, normalizeCurrentVector } from './branch-current-vectors'
import { canProbeCurrent } from './branch-currents'
import { parseProjectProbes } from './project-probes'
import { wireCurrentCut } from './wire-currents'
import { parseProjectSweep, parseTemperature } from './simulation-experiment'
import { validateWaveformExpression } from './waveform-expression'
import { parseWaveformAnalysisSettings } from './waveform-analysis-settings'

/** Persist only configuration; solver samples and historical run IDs remain session-local. */
export interface WaveformSetup { version: 1; profiles: SimulationProfiles; diagrams: CanvasWaveform[] }

const object = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}：需要对象`)
  return value as Record<string, unknown>
}
const fields = (value: Record<string, unknown>, allowed: readonly string[], path: string) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${path}.${key}：不支持此字段；波形配置不能包含运行 ID 或求解器数据`)
}
const text = (value: unknown, path: string, max = 100, empty = false): string => {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${path}：需要${empty ? '' : '非空的'}最多 ${max} 字符文本`)
  return value
}
const finite = (value: unknown, path: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${path}：需要 ${min}～${max} 范围内的有限数字`)
  return value
}
const analysis = (value: unknown, path: string): Project['analysis'] => {
  if (!['ac', 'noise', 'tran', 'dc', 'op'].includes(String(value)) || typeof value !== 'string') throw new Error(`${path}：只支持 ac / noise / tran / dc / op`)
  return value as Project['analysis']
}
function terminal(value: unknown, path: string): Terminal | null {
  if (value === null) return null
  const raw = object(value, path)
  if ('junction' in raw) { fields(raw, ['junction'], path); return { junction: text(raw.junction, `${path}.junction`) } }
  fields(raw, ['device', 'pin'], path)
  const pin = finite(raw.pin, `${path}.pin`, 0, 31)
  if (!Number.isInteger(pin)) throw new Error(`${path}.pin：需要整数引脚编号`)
  return { device: text(raw.device, `${path}.device`), pin: pin as Pin }
}
function settings(value: unknown, path: string): SimulationProfile['settings'] {
  const raw = object(value, path); fields(raw, ['analysis', 'ac', 'tran', 'dc', 'sourceId', 'output', 'temperature', 'sweep', 'switchStates','noise','solver','initialConditions','nodeSets'], path)
  const ac = object(raw.ac, `${path}.ac`), tran = object(raw.tran, `${path}.tran`)
  fields(ac, ['start', 'stop', 'points','sweep'], `${path}.ac`); fields(tran, ['stop', 'step','start','outputStep','uic'], `${path}.tran`)
  if(ac.sweep!==undefined&&!['dec','oct','lin'].includes(String(ac.sweep)))throw new Error(`${path}.ac.sweep：需要 dec / oct / lin`)
  const minimum=ac.sweep==='lin'?2:1,points = finite(ac.points, `${path}.ac.points`, minimum, 500)
  if (!Number.isInteger(points)) throw new Error(`${path}.ac.points：需要 ${minimum}～500 的整数`)
  const clean: SimulationProfile['settings'] = {
    analysis: analysis(raw.analysis, `${path}.analysis`),
    ac: { start: text(ac.start, `${path}.ac.start`, 80, true), stop: text(ac.stop, `${path}.ac.stop`, 80, true), points },
    tran: { stop: text(tran.stop, `${path}.tran.stop`, 80, true), step: text(tran.step, `${path}.tran.step`, 80, true) },
  }
  if (raw.dc !== undefined) {
    const dc = object(raw.dc, `${path}.dc`); fields(dc, ['start', 'stop', 'step','sourceId'], `${path}.dc`)
    clean.dc = { start: text(dc.start, `${path}.dc.start`, 80, true), stop: text(dc.stop, `${path}.dc.stop`, 80, true), step: text(dc.step, `${path}.dc.step`, 80, true) }
  }
  if(ac.sweep!==undefined)clean.ac.sweep=ac.sweep as 'dec'|'oct'|'lin'
  for(const field of ['start','outputStep'] as const)if(tran[field]!==undefined)clean.tran[field]=text(tran[field],`${path}.tran.${field}`,40,true)
  if(tran.uic!==undefined){if(typeof tran.uic!=='boolean')throw new Error(`${path}.tran.uic：需要布尔值`);clean.tran.uic=tran.uic}
  if(raw.dc!==undefined&&(raw.dc as Record<string,unknown>).sourceId!==undefined)clean.dc!.sourceId=text((raw.dc as Record<string,unknown>).sourceId,`${path}.dc.sourceId`,40)
  if(raw.solver!==undefined)clean.solver=parseSolverOptions(raw.solver,{allowDraft:true})
  for(const field of ['initialConditions','nodeSets'] as const)if(raw[field]!==undefined){const rows=raw[field];if(!Array.isArray(rows))throw new Error(`${path}.${field}：需要数组`);for(const [index,row] of rows.entries())fields(object(row,`${path}.${field}[${index}]`),['at','value'],`${path}.${field}[${index}]`);clean[field]=parseNodeVoltageSettings(rows,field,undefined,{allowDraft:true})}
  if(raw.noise!==undefined){const noise=object(raw.noise,`${path}.noise`);fields(noise,['negative','summaryInterval'],`${path}.noise`);clean.noise={};if(noise.negative!==undefined)clean.noise.negative=terminal(noise.negative,`${path}.noise.negative`);if(noise.summaryInterval!==undefined){const count=finite(noise.summaryInterval,`${path}.noise.summaryInterval`,0,10000);if(!Number.isInteger(count))throw new Error(`${path}.noise.summaryInterval：需要整数`);clean.noise.summaryInterval=count}}
  if (raw.sourceId !== undefined) clean.sourceId = text(raw.sourceId, `${path}.sourceId`, 100, true)
  if (raw.output !== undefined) clean.output = terminal(raw.output, `${path}.output`)
  if (raw.temperature !== undefined) clean.temperature = parseTemperature(raw.temperature)
  if (raw.sweep !== undefined) clean.sweep = parseProjectSweep(raw.sweep)
  if (raw.switchStates !== undefined) clean.switchStates = parseSwitchStates(raw.switchStates)
  return clean
}
function view(value: unknown, path: string): WaveformViewState {
  const raw = object(value, path)
  fields(raw, ['analysis', 'layout', 'panels', 'domain', 'cursors', 'activePanel', 'splitDirection', 'splitRatio', 'autoFit'], path)
  const cursors = object(raw.cursors, `${path}.cursors`); fields(cursors, ['a', 'b'], `${path}.cursors`)
  if (!Array.isArray(raw.panels) || raw.panels.length !== 4) throw new Error(`${path}.panels：需要 4 个视图配置，layout 决定显示 1 / 2 / 4 个`)
  raw.panels.forEach((value, index) => {
    const panelPath = `${path}.panels[${index}]`, panel = object(value, panelPath)
    fields(panel, ['source', 'display', 'ids', 'primary', 'expressions', 'axisRanges', 'solo', 'overlayIds'], panelPath)
    if (panel.expressions !== undefined) {
      if (!Array.isArray(panel.expressions) || panel.expressions.length > 24) throw new Error(`${panelPath}.expressions：最多 24 条表达式`)
      const expressionIds = new Set<string>()
      for (const entry of panel.expressions) {
        const expression = object(entry, `${panelPath}.expressions`)
        fields(expression, ['id', 'name', 'expression'], `${panelPath}.expressions`)
        const id = text(expression.id, `${panelPath}.expressions.id`, 100)
        if (expressionIds.has(id)) throw new Error(`${panelPath}.expressions：编号重复`)
        expressionIds.add(id)
        text(expression.expression, `${panelPath}.expressions.expression`, 1000)
        if (expression.name !== undefined) text(expression.name, `${panelPath}.expressions.name`, 80)
      }
    }
    if (!Array.isArray(panel.ids) || panel.ids.length > 128) throw new Error(`${panelPath}.ids：需要最多 128 个信号 ID 的数组`)
    const ids = panel.ids.map((id, i) => text(id, `${panelPath}.ids[${i}]`, 199))
    if (new Set(ids).size !== ids.length) throw new Error(`${panelPath}.ids：信号 ID 不能重复`)
    if(panel.overlayIds!==undefined){
      if(!Array.isArray(panel.overlayIds)||panel.overlayIds.length>128)throw new Error(`${panelPath}.overlayIds：需要最多 128 个信号 ID 的数组`)
      const previous=panel.overlayIds.map((id,i)=>text(id,`${panelPath}.overlayIds[${i}]`,199))
      if(new Set(previous).size!==previous.length)throw new Error(`${panelPath}.overlayIds：信号 ID 不能重复`)
    }
    if (panel.primary !== undefined) {
      const primary = text(panel.primary, `${panelPath}.primary`, 199)
      if (!ids.includes(primary)) throw new Error(`${panelPath}.primary：必须是该视图 ids 中的信号`)
    }
  })
  if (!validWaveformView(raw as unknown as WaveformViewState)) throw new Error(`${path}：analysis、layout、panel source/display、domain、cursors 或 activePanel 无效`)
  return structuredClone(raw as unknown as WaveformViewState)
}

/** Strict shape parser. Missing references are retained so deleting a probe never makes a project unsaveable. */
export function parseWaveformSetup(input: unknown, _project: Project): WaveformSetup | undefined {
  if (input === undefined) return undefined
  const path = 'project.waveformSetup', raw = object(input, path); fields(raw, ['version', 'profiles', 'diagrams'], path)
  if (raw.version !== 1) throw new Error(`${path}.version：只支持版本 1`)
  const profilesPath = `${path}.profiles`, state = object(raw.profiles, profilesPath)
  fields(state, ['version', 'activeId', 'profiles'], profilesPath)
  if (state.version !== 1 || !Array.isArray(state.profiles) || !state.profiles.length || state.profiles.length > 24) throw new Error(`${profilesPath}：需要 version:1 和 1～24 个仿真配置`)
  const profileIds = new Set<string>(), profiles = state.profiles.map((value, index): SimulationProfile => {
    const itemPath = `${profilesPath}.profiles[${index}]`, item = object(value, itemPath)
    fields(item, ['id', 'name', 'settings'], itemPath)
    const id = text(item.id, `${itemPath}.id`)
    if (profileIds.has(id)) throw new Error(`${itemPath}.id：仿真配置编号 ${id} 重复`)
    profileIds.add(id)
    return { id, name: text(item.name, `${itemPath}.name`, 80), settings: settings(item.settings, `${itemPath}.settings`) }
  })
  const activeId = text(state.activeId, `${profilesPath}.activeId`)
  if (!profileIds.has(activeId)) throw new Error(`${profilesPath}.activeId：配置 ${activeId} 不存在`)
  if (!Array.isArray(raw.diagrams) || raw.diagrams.length > MAX_CANVAS_WAVEFORMS) throw new Error(`${path}.diagrams：需要最多 ${MAX_CANVAS_WAVEFORMS} 个画布波形图的数组`)
  const diagramIds = new Set<string>(), diagrams = raw.diagrams.map((value, index): CanvasWaveform => {
    const itemPath = `${path}.diagrams[${index}]`, item = object(value, itemPath)
    fields(item, ['id', 'title', 'profileId', 'x', 'y', 'width', 'height', 'view', 'analysisSettings'], itemPath)
    const id = text(item.id, `${itemPath}.id`)
    if (diagramIds.has(id)) throw new Error(`${itemPath}.id：波形图编号 ${id} 重复`)
    diagramIds.add(id)
    const width = finite(item.width, `${itemPath}.width`, CANVAS_DIAGRAM_MIN.width, CANVAS_DIAGRAM_MAX.width), height = finite(item.height, `${itemPath}.height`, CANVAS_DIAGRAM_MIN.height, CANVAS_DIAGRAM_MAX.height)
    return { id, title: text(item.title, `${itemPath}.title`, 80, true), profileId: text(item.profileId, `${itemPath}.profileId`), width, height,
      x: finite(item.x, `${itemPath}.x`, DRAWING_BOUNDS.min, DRAWING_BOUNDS.max - width), y: finite(item.y, `${itemPath}.y`, DRAWING_BOUNDS.min, DRAWING_BOUNDS.max - height),
      ...(item.view !== undefined ? { view: view(item.view, `${itemPath}.view`) } : {}),
      ...(item.analysisSettings !== undefined ? { analysisSettings: parseWaveformAnalysisSettings(item.analysisSettings, `${itemPath}.analysisSettings`) } : {}),
    }
  })
  return { version: 1, profiles: { version: 1, activeId, profiles }, diagrams }
}

/** IDs whose meaning and solver support can be established before any run. No numerical data are fabricated. */
export function availableWaveformSignalIds(project: Project, profile: SimulationProfile): string[] {
  const configured = applySimulationProfile(project, profile), drawing = configured.drawing, custom = configured.template === 'custom'
  if (configured.analysis === 'noise') return ['noise:output', 'noise:input']
  const nodes = custom && drawing ? [...compileDrawing(drawing).nodes.values()] : custom ? [] : circuitGraph(configured).parts.flatMap(part => part.nodes)
  const nodeNames = new Set(nodes.map(name => name.toLowerCase())), devices = drawing?.devices ?? (custom ? [] : circuitGraph(configured).parts)
  const ids = nodes.filter(node => node !== '0' && /^[a-z_][a-z0-9_]*$/i.test(node)).map(node => `voltage:v(${node.toLowerCase()})`)
  const vectors = [...devices.filter(device => device.kind === 'V').map(device => `i(${device.id.toLowerCase()})`), ...branchCurrentSaveVectors(configured)]
  ids.push(...vectors.flatMap(vector => { const name = normalizeCurrentVector(vector); return name ? [`current:${name}`] : [] }))
  const currentSupported = (id: string) => devices.some(device => device.id === id && canProbeCurrent(device.kind) && (configured.analysis !== 'ac' || !['D', 'I'].includes(device.kind)))
  for (const probe of project.probes ?? []) {
    try {
      parseProjectProbes([probe], drawing)
      if (probe.kind === 'current') {
        if (probe.wire) { const cut = wireCurrentCut(drawing!, probe.wire); if (!cut.ok || !cut.plans.some(plan => plan.every(term => currentSupported(term.device)))) continue }
        else if (!currentSupported(probe.device)) continue
      } else {
        const topology = compileDrawing(drawing!), terminals = [probe.positive, ...(probe.negative ? [probe.negative] : [])]
        if (terminals.some(at => { const node = topology.nodes.get(terminalKey(at)); return !node || node !== '0' && !/^[a-z_][a-z0-9_]*$/i.test(node) })) continue
      }
      ids.push(`probe:${probe.id}`)
    } catch { /* Missing measurement identities remain explicit issues in their referencing panels. */ }
  }
  if (configured.analysis === 'ac') {
    const signals = analysisSignals(configured)
    if (signals.inputNode !== '0' && signals.outputNode !== '0' && nodeNames.has(signals.inputNode.toLowerCase()) && nodeNames.has(signals.outputNode.toLowerCase())) ids.push('transfer')
  }
  return [...new Set(ids)]
}

/** Agent/import callers reject these issues; the editor can display them while retaining the user's view. */
export function waveformSetupIssues(setup: WaveformSetup | undefined, project: Project): string[] {
  if (!setup) return []
  const issues: string[] = [], profiles = new Map(setup.profiles.profiles.map(profile => [profile.id, profile])), signals = new Map<string, Set<string>>()
  for (const profile of setup.profiles.profiles) {
    const path = `project.waveformSetup.profiles.${profile.id}`, config = profile.settings
    const number = (raw: string, key: string, kind: Quantity, min: number, max: number) => {
      try { const value = parseQuantity(raw, kind); if (value < min || value > max) throw new Error(`允许范围 ${min}～${max}`); return value }
      catch (error) { issues.push(`${path}.${key}：${(error as Error).message}`); return NaN }
    }
    const start = number(config.ac.start, 'ac.start', 'frequency', 1e-6, 1e12), stop = number(config.ac.stop, 'ac.stop', 'frequency', 1e-6, 1e12)
    if (start >= stop) issues.push(`${path}.ac.stop：终止频率必须大于起始频率`)
    const duration = number(config.tran.stop, 'tran.stop', 'time', 1e-9, 100), step = number(config.tran.step, 'tran.step', 'time', 1e-12, 1)
    if (step > duration / 10 || duration / step > 30000) issues.push(`${path}.tran.step：最大步长须不大于时长的 1/10，且时长 / 步长不得超过 30,000`)
    const configured = applySimulationProfile(project, profile), drawing = configured.drawing
    if (config.dc&&config.analysis==='dc') {
      let kind:Quantity='voltage'
      try{kind=dcSource(configured).kind}catch(error){issues.push(`${path}.dc.sourceId：${(error as Error).message}`)}
      const low = number(config.dc.start, 'dc.start', kind, -1000, 1000), high = number(config.dc.stop, 'dc.stop', kind, -1000, 1000), increment = number(config.dc.step, 'dc.step', kind, -1000, 1000)
      if (high===low||increment===0||Math.sign(high-low)!==Math.sign(increment)||Math.abs(increment)>Math.abs(high-low)||Math.abs((high-low)/increment)>10000) issues.push(`${path}.dc：步进符号须与扫向一致且不得超过范围，最多支持 10,001 点`)
    }
    if(config.tran.start!==undefined){const at=number(config.tran.start,'tran.start','time',0,100);if(at>=duration)issues.push(`${path}.tran.start：记录起点须小于终点`)}
    if(config.tran.outputStep!==undefined)number(config.tran.outputStep,'tran.outputStep','time',1e-12,100)
    for(const issue of validateSimulationOptions(configured))issues.push(`${path}：${issue}`)
    try { if (config.temperature !== undefined) parseTemperature(config.temperature); if (config.sweep) parseProjectSweep(config.sweep, configured) }
    catch (error) { issues.push(`${path}：${(error as Error).message}`) }
    const warning = simulationReferenceWarning(project, drawing ? { ...profile, settings: { ...config, sourceId: drawing.sourceId, output: drawing.output } } : profile)
    if (warning) issues.push(`${path}：${warning}`)
    if (project.template === 'custom' && (!drawing?.sourceId || !drawing.output)) issues.push(`${path}：需要指定实际参考源和输出端点`)
    if (project.template !== 'custom' && (config.sourceId !== undefined && config.sourceId !== 'V1' || config.output !== undefined && config.output !== null)) issues.push(`${path}：模板工程使用固定 V1 / vout；自定义参考端点需要自由原理图`)
    try { signals.set(profile.id, new Set(availableWaveformSignalIds(project, profile))) } catch (error) { issues.push(`${path}：无法确认可用信号：${(error as Error).message}`); signals.set(profile.id, new Set()) }
  }
  for (const diagram of setup.diagrams) {
    const path = `project.waveformSetup.diagrams.${diagram.id}`, profile = profiles.get(diagram.profileId)
    if (!profile) { issues.push(`${path}.profileId：配置 ${diagram.profileId} 已不存在，请重新选择仿真配置`); continue }
    if(diagram.analysisSettings){
      const available=new Set(signals.get(profile.id)!)
      const panel=diagram.view?.panels[diagram.view.activePanel??0]
      for(const expression of panel?.expressions??[])available.add(`expression:${expression.id}`)
      for(const [field,id] of [['signalId',diagram.analysisSettings.signalId],['events.referenceSignalId',diagram.analysisSettings.events.referenceSignalId]] as const){
        if(id&&!available.has(id))issues.push(`${path}.analysisSettings.${field}：测量曲线 ${id} 已不存在或不支持该分析；原定义已保留，请重新选择`)
      }
    }
    if (!diagram.view) continue
    if (diagram.view.analysis !== profile.settings.analysis) issues.push(`${path}.view.analysis：${diagram.view.analysis} 与配置 ${diagram.profileId} 的 ${profile.settings.analysis} 不一致`)
    diagram.view.panels.forEach((panel, index) => {
      const panelPath = `${path}.view.panels[${index}]`, available = new Set(signals.get(profile.id)!)
      for (const expression of panel.expressions ?? []) {
        available.add(`expression:${expression.id}`)
        try {
          if (profile.settings.analysis === 'noise') throw new Error('噪声分析不支持波形表达式')
          validateWaveformExpression(expression.expression, {
            voltage: [...available].filter(id => id.startsWith('voltage:')).map(id => id.slice(8)),
            current: [...available].filter(id => id.startsWith('current:')).map(id => id.slice(8)).concat(
              profile.settings.analysis === 'ac'
                ? (project.template === 'custom' ? project.drawing?.devices ?? [] : circuitGraph(project).parts).filter(device => ['R','C','L','V'].includes(device.kind)).map(device => `i(${device.id.toLowerCase()})`)
                : []),
          })
        } catch (error) { issues.push(`${panelPath}.expressions.${expression.id}：${(error as Error).message}`) }
      }
      if (panel.source === 'transfer' && !available.has('transfer')) issues.push(`${panelPath}.source：当前配置没有可用 AC 传递函数`)
      if (panel.display === 'phase' && profile.settings.analysis !== 'ac') issues.push(`${panelPath}.display：相位仅用于 AC 分析`)
      for (const id of panel.ids) if (!available.has(id)) issues.push(`${panelPath}.ids：信号 ${id} 已不存在或不支持该分析；配置已保留，请重新选择`)
      if (panel.source === 'signals' && panel.ids.includes('transfer')) issues.push(`${panelPath}.source：transfer 曲线需要 source:"transfer"`)
    })
  }
  return issues
}
