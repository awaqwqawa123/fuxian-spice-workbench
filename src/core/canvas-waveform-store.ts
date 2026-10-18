import { defaultCanvasDiagram, normalizeCanvasDiagram, type CanvasDiagramGeometry } from './canvas-diagrams'
import { readCanvasDiagram } from './canvas-diagram-store'
import type { Drawing } from './drawing'
import type { WaveformDomain, WaveformPanel } from './waveform-workspace'
import { validWaveformAxisRanges } from './waveform-axis-settings'
import { parseWaveformAnalysisSettings, type WaveformAnalysisSettings } from './waveform-analysis-settings'

export interface WaveformViewState {
  analysis:string; layout:1|2|4; panels:WaveformPanel[]; domain:WaveformDomain
  cursors:{a:number|null;b:number|null}
  activePanel?:number
  splitDirection?:'rows'|'columns'; splitRatio?:number
  autoFit?:boolean
}
export interface CanvasWaveform extends CanvasDiagramGeometry {
  title:string; profileId:string; resultId?:string; view?:WaveformViewState; analysisSettings?:WaveformAnalysisSettings
}
const prefix='fuxian-canvas-waveforms-v2:'
type ReadStorage = Pick<Storage,'getItem'> & Partial<Pick<Storage,'setItem'>>
type WriteStorage = Pick<Storage,'setItem'> & Partial<Pick<Storage,'getItem'>>
const readWarnings = new WeakMap<object,Map<string,string>>()
const blockedWrites = new WeakMap<object,Set<string>>()
const compatibilityBackups = new WeakMap<object,Set<string>>()
const warningKey = (projectId:string) => `${prefix}warning:${projectId}`
function warn(storage:Partial<Pick<Storage,'getItem'|'setItem'>>,projectId:string,message:string) {
  let map=readWarnings.get(storage);if(!map){map=new Map();readWarnings.set(storage,map)}
  map.set(projectId,message)
  try{storage.setItem?.(warningKey(projectId),message)}catch{/* The in-memory warning remains visible. */}
}
export function readCanvasWaveformWarning(storage:Pick<Storage,'getItem'>,projectId:string):string|undefined {
  const current=readWarnings.get(storage)?.get(projectId)
  if(current)return current
  try{return storage.getItem(warningKey(projectId))??undefined}catch{return '无法读取波形图组存储；请检查浏览器存储权限。'}
}
/** Each distinct original is retained verbatim once; hash collisions get separate keys. */
function backupUnparsed(storage:ReadStorage,projectId:string,raw:string):string|undefined {
  let hash=2166136261
  for(let i=0;i<raw.length;i++){hash^=raw.charCodeAt(i);hash=Math.imul(hash,16777619)}
  const base=`${prefix}recovery:${projectId}:${(hash>>>0).toString(16)}`
  try{
    for(let i=0;i<100;i++){
      const key=i?`${base}:${i}`:base, existing=storage.getItem(key)
      if(existing===raw)return key
      if(existing===null&&storage.setItem){storage.setItem(key,raw);return key}
    }
  }catch{/* Never replace the source when preserving it failed. */}
  let blocked=blockedWrites.get(storage);if(!blocked){blocked=new Set();blockedWrites.set(storage,blocked)}
  blocked.add(projectId)
  return undefined
}
export const MAX_CANVAS_WAVEFORMS=12
export function newCanvasWaveform(drawing:Drawing,profileId:string,existing:CanvasWaveform[]=[],copy?:CanvasWaveform):CanvasWaveform {
  const id=crypto.randomUUID(),base=copy??defaultCanvasDiagram(drawing,id)
  const last=existing.at(-1)
  let geometry=normalizeCanvasDiagram({...base,id,...(copy?{x:copy.x+40,y:copy.y+40}:last?{x:last.x+last.width+40,y:last.y}:{})})
  if(copy){
    // Repeated copies and frames at sheet edges must remain separately visible.
    // Normalization can clamp a positive offset back onto the source frame.
    const occupied=[...existing,copy]
    for(let step=1;step<=occupied.length+1;step++){
      const candidates=[[40,40],[-40,-40],[40,-40],[-40,40]].map(([dx,dy])=>normalizeCanvasDiagram({...base,id,x:copy.x+dx*step,y:copy.y+dy*step}))
      const available=candidates.find(candidate=>!occupied.some(item=>candidate.x===item.x&&candidate.y===item.y))
      if(available){geometry=available;break}
    }
  }
  return {...(copy?structuredClone(copy):{}),...geometry,title:copy?`${copy.title.slice(0,77)} 副本`:`波形图 ${existing.length+1}`,profileId}
}
export function validWaveformView(v:WaveformViewState|undefined):v is WaveformViewState {
  if(!v||!['ac','noise','tran','dc','op'].includes(v.analysis)||![1,2,4].includes(v.layout)||!Array.isArray(v.panels)||v.panels.length!==4||!Array.isArray(v.domain)||v.domain.length!==2||!v.domain.every(Number.isFinite)||v.domain[0]<0||v.domain[1]>1||v.domain[0]>=v.domain[1])return false
  if(!v.cursors||![v.cursors.a,v.cursors.b].every(n=>n===null||typeof n==='number'&&Number.isFinite(n)))return false
  if(v.activePanel!==undefined&&(!Number.isInteger(v.activePanel)||v.activePanel<0||v.activePanel>=v.layout))return false
  if(v.splitDirection!==undefined&&!['rows','columns'].includes(v.splitDirection))return false
  if(v.splitRatio!==undefined&&(!Number.isInteger(v.splitRatio)||v.splitRatio<25||v.splitRatio>75))return false
  if(v.autoFit!==undefined&&typeof v.autoFit!=='boolean')return false
  return v.panels.every(p=>p&&['signals','transfer'].includes(p.source)&&['magnitude','phase'].includes(p.display)&&Array.isArray(p.ids)&&p.ids.length<=128&&p.ids.every(id=>typeof id==='string'&&id.length<200)&&(p.primary===undefined||typeof p.primary==='string')&&(p.solo===undefined||typeof p.solo==='boolean')&&(p.overlayIds===undefined||Array.isArray(p.overlayIds)&&p.overlayIds.length<=128&&p.overlayIds.every(id=>typeof id==='string'&&id.length<200))&&(p.axisRanges===undefined||validWaveformAxisRanges(p.axisRanges))&&(p.expressions===undefined||Array.isArray(p.expressions)&&p.expressions.length<=24&&new Set(p.expressions.map(e=>e?.id)).size===p.expressions.length&&p.expressions.every(e=>e&&typeof e.id==='string'&&e.id.length>0&&e.id.length<=100&&typeof e.expression==='string'&&e.expression.length>0&&e.expression.length<=1000&&(e.name===undefined||typeof e.name==='string'&&e.name.length<=80))))
}
export function readCanvasWaveforms(storage:ReadStorage,projectId:string,drawing:Drawing,profileId:string):CanvasWaveform[] {
  let raw:string|null=null
  try {
    raw=storage.getItem(prefix+projectId)
    if(raw!==null){
      const data=JSON.parse(raw) as {version:number;diagrams:CanvasWaveform[]}
      if(data.version!==2||!Array.isArray(data.diagrams)||data.diagrams.length>MAX_CANVAS_WAVEFORMS)throw new Error('invalid diagrams')
      const ids=new Set<string>()
      const diagrams:CanvasWaveform[]=[],issues:string[]=[]
      data.diagrams.forEach((item,index)=>{
        try{
          if(!item||typeof item.id!=='string'||!item.id||item.id.length>100||ids.has(item.id)||typeof item.title!=='string'||item.title.length>80||typeof item.profileId!=='string'||item.profileId.length>100||![item.x,item.y,item.width,item.height].every(Number.isFinite))throw new Error(`图组 ${index+1} 的基本信息无效`)
          ids.add(item.id)
          const diagram:CanvasWaveform={...normalizeCanvasDiagram(item),title:item.title,profileId:item.profileId}
          if(item.view!==undefined){if(validWaveformView(item.view))diagram.view=item.view;else issues.push(`图组“${item.title}”的坐标或曲线设置无法恢复`)}
          if(item.analysisSettings!==undefined){try{diagram.analysisSettings=parseWaveformAnalysisSettings(item.analysisSettings)}catch(error){issues.push(`图组“${item.title}”的测量设置无法恢复：${(error as Error).message}`)}}
          diagrams.push(diagram)
        }catch(error){issues.push((error as Error).message)}
      })
      if(issues.length){
        const backup=backupUnparsed(storage,projectId,raw)
        warn(storage,projectId,`${issues.join('；')}。${backup?`原始配置已完整备份到 ${backup}，保留了 ${diagrams.length} 个可恢复图组。`:'原始配置备份失败；已停止自动覆盖存储，请先导出原始配置。'}`)
      }
      if(diagrams.length||!data.diagrams.length)return diagrams
    }
  } catch(error){
    const backup=raw!==null?backupUnparsed(storage,projectId,raw):undefined
    if(raw===null){let blocked=blockedWrites.get(storage);if(!blocked){blocked=new Set();blockedWrites.set(storage,blocked)}blocked.add(projectId)}
    warn(storage,projectId,`波形图组配置读取失败：${(error as Error).message}。${backup?`原始内容已完整备份到 ${backup}。`:'原始配置未能备份；已停止自动覆盖存储。'}暂时显示兼容图组。`)
  }
  const legacy=readCanvasDiagram(storage,projectId)??defaultCanvasDiagram(drawing,'waveform')
  return [{...legacy,title:'波形图 1',profileId}]
}
export function saveCanvasWaveforms(storage:WriteStorage,projectId:string,diagrams:CanvasWaveform[]):boolean {
  // Solver arrays and run IDs belong to this browser session; selected signals,
  // layout, geometry and simulation associations are small and persistent.
  if(blockedWrites.get(storage)?.has(projectId))return false
  try {
    const serializable=diagrams.map(({resultId:_resultId,...diagram})=>diagram)
    if(diagrams.some(diagram=>diagram.analysisSettings!==undefined)){
      const key=`${prefix}pre-analysis:${projectId}`
      if(!compatibilityBackups.get(storage)?.has(projectId)&&(!storage.getItem||storage.getItem(key)===null)){
        const previous=storage.getItem?.(prefix+projectId)
        // A complete old configuration is kept for applications that reject the optional extension.
        const compatible=JSON.stringify({version:2,diagrams:serializable.map(({analysisSettings:_settings,...diagram})=>diagram)})
        let priorCompatible=false
        if(previous){try{const prior=JSON.parse(previous) as {version?:number;diagrams?:CanvasWaveform[]};priorCompatible=prior.version===2&&Array.isArray(prior.diagrams)&&!prior.diagrams.some(diagram=>diagram.analysisSettings!==undefined)}catch{/* Recovery has retained malformed source content separately. */}}
        storage.setItem(key,previous&&priorCompatible?previous:compatible)
      }
      let saved=compatibilityBackups.get(storage);if(!saved){saved=new Set();compatibilityBackups.set(storage,saved)}saved.add(projectId)
    }
    storage.setItem(prefix+projectId,JSON.stringify({version:2,diagrams:serializable}));return true
  } catch(error){warn(storage,projectId,`波形图组或兼容备份保存失败：${(error as Error).message}。原始存储未被替代配置覆盖。`);return false}
}
