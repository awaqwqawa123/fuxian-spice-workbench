import { dcSweep, newProject, type Project } from './circuit'
import { pinsFor } from './devices'
import type { Terminal } from './drawing'
import { parseTemperature, parseProjectSweep } from './simulation-experiment'
import { parseNodeVoltageSettings, parseSolverOptions } from './simulation-options'

export interface SimulationProfile {
  id:string; name:string
  settings:Pick<Project,'analysis'|'ac'|'tran'|'dc'|'temperature'|'sweep'|'noise'|'solver'|'initialConditions'|'nodeSets'> & {sourceId?:string; output?:Terminal|null; switchStates?:Record<string,'ON'|'OFF'>}
}
export interface SimulationProfiles { version:1; activeId:string; profiles:SimulationProfile[] }
const prefix='fuxian-simulation-profiles-v1:'
const optionalSettings=['temperature','sweep','noise','solver','initialConditions','nodeSets'] as const
export const simulationNames={ac:'AC 频率响应',noise:'噪声分析',tran:'瞬态分析',dc:'DC 扫描',op:'直流工作点'} as const

export function simulationSettings(project:Project):SimulationProfile['settings'] {
  const switches=project.drawing?.devices.filter(device=>device.kind==='SW')??[]
  const optional=Object.fromEntries(optionalSettings.filter(key=>project[key]!==undefined).map(key=>[key,project[key]]))
  return structuredClone({analysis:project.analysis,ac:project.ac,tran:project.tran,dc:dcSweep(project),...optional,...(switches.length?{switchStates:Object.fromEntries(switches.map(device=>[device.id,device.value as 'ON'|'OFF']))}:{}),sourceId:project.drawing?.sourceId,output:project.drawing?.output??null})
}
export function initialSimulationProfiles(project:Project):SimulationProfiles {
  return {version:1,activeId:'default',profiles:[{id:'default',name:simulationNames[project.analysis],settings:simulationSettings(project)}]}
}
export function applySimulationProfile(project:Project,profile:SimulationProfile):Project {
  const {sourceId,output,switchStates,...analysis}=structuredClone(profile.settings),drawing=project.drawing
  // Profiles store references, never old devices/wires. Deleted references are
  // kept invalid so the user can repair them, rather than silently changing nodes.
  const result={...project,...analysis,...(drawing?{drawing:{...drawing,...(switchStates?{devices:drawing.devices.map(device=>device.kind==='SW'&&Object.hasOwn(switchStates,device.id)?{...device,value:switchStates[device.id]}:device)}:{}),...(sourceId!==undefined?{sourceId}:{}),...(output!==undefined?{output}:{})}}:{})}
  // Absence means default for this profile, never inheritance from the previous one.
  for(const key of optionalSettings)if(analysis[key]===undefined)delete result[key]
  return result
}
export function createSimulationProfile(state:SimulationProfiles,project:Project,copy=false):{profiles:SimulationProfiles;project:Project} {
  if(state.profiles.length>=24)return {profiles:state,project}
  const updated=updateSimulationProfile(state,project),selected=updated.profiles.find(p=>p.id===updated.activeId)!
  const defaults=newProject(),settings=simulationSettings(copy?project:{...project,analysis:'ac',ac:defaults.ac,tran:defaults.tran,dc:undefined,temperature:undefined,sweep:undefined,noise:undefined,solver:undefined,initialConditions:undefined,nodeSets:undefined})
  const profile:SimulationProfile={id:crypto.randomUUID(),name:copy?`${selected.name.slice(0,72)} 副本`:`配置 ${updated.profiles.length+1}`,settings}
  return {profiles:{...updated,activeId:profile.id,profiles:[...updated.profiles,profile]},project:applySimulationProfile(project,profile)}
}
export function updateSimulationProfile(state:SimulationProfiles,project:Project):SimulationProfiles {
  const settings=simulationSettings(project),profile=state.profiles.find(p=>p.id===state.activeId)
  if(!profile)return state
  const generatedName=profile.name===simulationNames[profile.settings.analysis]||profile.id==='default'&&Object.values<string>(simulationNames).includes(profile.name)
  const name=generatedName?simulationNames[settings.analysis]:profile.name
  // Freeze legacy profiles at the current shared contact state before the first
  // edit/switch. They did not previously record any independent state.
  const migrate=settings.switchStates&&state.profiles.some(p=>p.settings.switchStates===undefined)
  if(!migrate&&profile.name===name&&JSON.stringify(profile.settings)===JSON.stringify(settings))return state
  return {...state,profiles:state.profiles.map(p=>p.id===state.activeId?{...p,name,settings}:migrate&&p.settings.switchStates===undefined?{...p,settings:{...p.settings,switchStates:structuredClone(settings.switchStates)}}:p)}
}

export function parseSwitchStates(value:unknown):Record<string,'ON'|'OFF'> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>80)throw new Error('switchStates：需要最多 80 个触点状态的对象')
  const entries=Object.entries(value)
  for(const [id,state] of entries)if(!/^SW[1-9]\d*$/.test(id)||!['ON','OFF'].includes(String(state))||typeof state!=='string')throw new Error(`switchStates.${id}：需要手动开关编号和 ON / OFF 状态`)
  return Object.fromEntries(entries) as Record<string,'ON'|'OFF'>
}
export function simulationReferenceWarning(project:Project,profile:SimulationProfile):string|null {
  const drawing=project.drawing,settings=profile.settings
  if(!drawing)return null
  for(const id of Object.keys(settings.switchStates??{}))if(!drawing.devices.some(d=>d.id===id&&d.kind==='SW'))return `配置的触点 ${id} 已不存在或不是手动开关，请修改仿真设置。`
  if(settings.sourceId&&!drawing.devices.some(d=>d.id===settings.sourceId&&d.kind==='V'))return `配置的参考源 ${settings.sourceId} 已不存在，请修改仿真设置。`
  if(settings.dc?.sourceId&&!drawing.devices.some(d=>d.id===settings.dc!.sourceId&&['V','I'].includes(d.kind)))return `配置的扫描源 ${settings.dc.sourceId} 已不存在或不是独立电压 / 电流源，请修改仿真设置。`
  const exists=(at:Terminal)=>'device' in at?drawing.devices.some(d=>d.id===at.device&&pinsFor(d).includes(at.pin)):drawing.junctions.some(j=>j.id===at.junction)
  if(settings.noise?.negative&&!exists(settings.noise.negative))return '配置的噪声输出负端已不存在，请修改仿真设置。'
  for(const [field,label] of [['initialConditions','初始条件'],['nodeSets','节点初猜']] as const)for(const [index,item] of (settings[field]??[]).entries())if(!exists(item.at))return `配置的${label}第 ${index+1} 项端点已不存在，请修改仿真设置。`
  const output=settings.output
  if(output&&('device' in output?!drawing.devices.some(d=>d.id===output.device&&pinsFor(d).includes(output.pin)):!drawing.junctions.some(j=>j.id===output.junction)))return '配置的参考输出已不存在，请修改仿真设置。'
  return null
}
function validSettings(s:SimulationProfile['settings']):boolean {
  const text=(x:unknown)=>typeof x==='string'&&x.length<=80
  if(!s||!Object.hasOwn(simulationNames,s.analysis)||!s.ac||!s.tran||!text(s.ac.start)||!text(s.ac.stop)||!Number.isInteger(s.ac.points)||s.ac.points<1||s.ac.points>500||!text(s.tran.stop)||!text(s.tran.step))return false
  if(s.ac.sweep!==undefined&&!['dec','oct','lin'].includes(s.ac.sweep))return false
  for(const value of [s.tran.start,s.tran.outputStep])if(value!==undefined&&!text(value))return false
  if(s.tran.uic!==undefined&&typeof s.tran.uic!=='boolean')return false
  const terminal=(o:unknown):boolean=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&('device' in o?text(o.device)&&'pin' in o&&Number.isInteger(o.pin)&&Number(o.pin)>=0&&Number(o.pin)<32&&!('junction' in o):'junction' in o&&text(o.junction))
  if(s.noise!==undefined&&(!s.noise||typeof s.noise!=='object'||Array.isArray(s.noise)||s.noise.negative!==undefined&&s.noise.negative!==null&&!terminal(s.noise.negative)||s.noise.summaryInterval!==undefined&&(!Number.isInteger(s.noise.summaryInterval)||s.noise.summaryInterval<0||s.noise.summaryInterval>10000)))return false
  try{if(s.solver!==undefined)parseSolverOptions(s.solver,{allowDraft:true});if(s.initialConditions!==undefined)parseNodeVoltageSettings(s.initialConditions,'initialConditions',undefined,{allowDraft:true});if(s.nodeSets!==undefined)parseNodeVoltageSettings(s.nodeSets,'nodeSets',undefined,{allowDraft:true});if(s.temperature!==undefined)parseTemperature(s.temperature);if(s.sweep!==undefined)parseProjectSweep(s.sweep);if(s.switchStates!==undefined)parseSwitchStates(s.switchStates)}catch{return false}
  if(s.dc&&(!text(s.dc.start)||!text(s.dc.stop)||!text(s.dc.step)||s.dc.sourceId!==undefined&&!text(s.dc.sourceId)))return false
  if(s.sourceId!==undefined&&!text(s.sourceId))return false
  const o=s.output
  return o===undefined||o===null||terminal(o)
}
export function readSimulationProfiles(storage:Pick<Storage,'getItem'>,projectId:string,project:Project):SimulationProfiles {
  try {
    const value=JSON.parse(storage.getItem(prefix+projectId)??'null') as SimulationProfiles|null
    if(value?.version!==1||!Array.isArray(value.profiles)||!value.profiles.length||value.profiles.length>24)throw new Error('invalid profiles')
    const ids=new Set<string>()
    for(const p of value.profiles){if(!p||typeof p.id!=='string'||p.id.length>100||!p.id||ids.has(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>80||!validSettings(p.settings))throw new Error('invalid profile');ids.add(p.id)}
    if(!ids.has(value.activeId))throw new Error('invalid active profile')
    // The current circuit is authoritative for the selected profile, including
    // edits/undo saved immediately before a reload or an imported project.
    return updateSimulationProfile(value,project)
  } catch {return initialSimulationProfiles(project)}
}
export function saveSimulationProfiles(storage:Pick<Storage,'setItem'>,projectId:string,value:SimulationProfiles):boolean {
  try {storage.setItem(prefix+projectId,JSON.stringify(value));return true} catch{return false}
}
