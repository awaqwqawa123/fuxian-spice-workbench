import { aiProjectFingerprint, parseAiProposal, proposalChanges, type AiProposal } from './ai'
import type { Project } from './circuit'
import type { ModelDownloadPreview, ModelSearchResults } from './model-search'
import { parseImportedModels, parseSpiceLibrary, type ImportedSpiceModel, type SpiceModelDiagnostic, type SpiceModelSource } from './spice-models'
import { stripSpiceInlineComment } from './spice-parameters'
import { isBundledModelSource } from './bundled-models'
import { additionalPublicModelIds, registeredAdditionalModelSource } from './model-download-sources'
import { parseModelSymbol } from './model-symbol'
import { parseModelLibraryPreview } from './model-library-preview'
import { isOwnedVendorModelSource } from './installed-model-source'

export interface AgentModelService {
  /** Fixed registered declarations plus installed models; never performs web search. */
  lookup?(query:string):Promise<ModelSearchResults>
  search(query:string):Promise<ModelSearchResults>
  download(id:string):Promise<ModelDownloadPreview>
}
export interface AgentModelAcquisition extends ModelDownloadPreview {
  id:string
  query:string
  name:string
  importedModelIds:string[]
  origin:'local-library'|'online'
}
export const AGENT_MODEL_LIMITS={downloads:3,fileCharacters:250_000,totalCharacters:600_000} as const
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
const localSourceUrl='https://www.analog.com/en/resources/design-tools-and-calculators/ltspice-simulator.html'
function registeredDownloadUrl(raw:unknown):boolean{
  if(typeof raw!=='string')return false
  try{
    const url=new URL(raw)
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)return false
    if(url.hostname==='www.ti.com')return /^\/lit\/zip\/[a-z0-9]{3,20}$/i.test(url.pathname)
    if(url.hostname!=='raw.githubusercontent.com')return false
    if(registeredAdditionalModelSource(raw))return true
    const path=decodeURIComponent(url.pathname.slice(1)),parts=path.split('/'),repo=parts.slice(0,2).join('/'),revision=parts[2],file=parts.slice(3).join('/')
    if(!/^[a-f0-9]{40}$/.test(revision)||file.length>=500||/[\x00-\x1f\\?#%]/.test(file)||file.split('/').some(part=>!part||part==='.'||part==='..'))return false
    if(repo==='kicad-spice-library/KiCad-Spice-Library')return file.startsWith('Models/')
    return repo==='KiCad/kicad-source-mirror'&&['demos/simulation/power_supplies/LM317_power_supply/1N4002.lib','demos/simulation/laser_driver/fzt1049a.lib','demos/simulation/power_supplies/buck_conv/IRF-Power-VDMOS.mod'].includes(file)
  }catch{return false}
}

/** Downloads are data, never executable instructions; reparse before allowing additions. */
export function parseAcquiredModelLibrary(text:string,source:SpiceModelSource,options:{preserveSavedSymbols?:boolean}={}){
  const preview=options.preserveSavedSymbols?parseSpiceLibrary(text,source):parseModelLibraryPreview(text,source),publicIds=additionalPublicModelIds(source)
  // Each public model.spice still contains its full helper dependency closure.
  // Apply the same display selection on download and saved-record restoration.
  return publicIds?{...preview,models:preview.models.filter(model=>publicIds.includes(model.id))}:preview
}

/** Recognize the old parser's exact compatibility failures from the retained
 * original, rather than accepting an arbitrary saved "error" as permission to
 * add models. Unsupported controls and unrelated diagnostics never migrate. */
function previousCompatibilityFailures(text:string):Map<string,SpiceModelDiagnostic> {
  const lines:{text:string;line:number}[]=[]
  for(const [index,raw] of text.split(/\r?\n/).entries()){
    const line=stripSpiceInlineComment(raw.trim())
    if(!line||line.startsWith('*'))continue
    if(line.startsWith('+')&&lines.length)lines.at(-1)!.text+=` ${line.slice(1).trim()}`
    else lines.push({text:line,line:index+1})
  }
  const failures=new Map<string,SpiceModelDiagnostic>(),blocks=new Map<string,{id:string;line:number;lines:typeof lines;dependencies:string[]}>()
  const oldName=/^[a-z0-9_][a-z0-9_.-]{0,39}$/i
  const switchError=(type:string)=>`模型类型 ${type} 暂不支持；支持 D、NPN、PNP、NMOS、PMOS、VDMOS、NJF、PJF`
  function cardFailure(line:string):string|undefined {
    const type=line.match(/^\.model\s+\S+\s+([a-z][a-z0-9]*)/i)?.[1].toUpperCase()
    if(type&&['VSWITCH','ISWITCH','SW','CS'].includes(type))return switchError(type)
    if(type&&['RES','R'].includes(type)&&/\bT_ABS\s*=/i.test(line))return '辅助电阻模型参数 T_ABS 不支持或重复；原参数未删减'
    if(type&&['D','NPN','PNP','NMOS','PMOS','NJF','PJF','VDMOS'].includes(type)){
      let body=line.replace(/^\.model\s+\S+\s+\S+\s*/i,'').trim()
      if(body.startsWith('(')&&body.endsWith(')'))body=body.slice(1,-1).trim()
      if(/[()]/.test(body))return '模型参数括号不匹配，或包含暂不支持的表达式'
      const expression=body.match(/\b([a-z][a-z0-9_]*)\s*=\s*(\{[^\s,]+\})/i)
      if(expression)return `电气参数 ${expression[1].toUpperCase()} 需要常数，暂不支持“${expression[2]}”`
    }
    return undefined
  }
  let pending:typeof lines=[]
  for(const entry of lines){
    if(/^\.subckt\b/i.test(entry.text)){pending=[entry];continue}
    if(pending.length){
      pending.push(entry)
      if(!/^\.ends\b/i.test(entry.text))continue
      const header=pending[0],tokens=header.text.split(/\s+/),id=tokens[1],pins=tokens.slice(2)
      const block={id,line:header.line,lines:pending,dependencies:[] as string[]};blocks.set(id.toLowerCase(),block)
      let message:string|undefined
      if(pins.length<2||pins.length>32||pins.some(pin=>!oldName.test(pin)))message='子电路须有 2～32 个有效端口；带 PARAMS 的表头暂不支持'
      if(!message)for(const line of pending.slice(1,-1))if(/^\.model\b/i.test(line.text)){message=cardFailure(line.text);if(message)break}
      if(!message)for(const line of pending.slice(1,-1)){
        if(/^\.model\b/i.test(line.text))continue
        if(/^\.param\b/i.test(line.text)){
          if(!/^\.param\s+(?:[a-z_][\w]*\s*=\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?\s*)+$/i.test(line.text)){message=`第 ${line.line} 行 .param 仅支持常数赋值`;break}
          continue
        }
        if(!/^[RCLVIDQJMEXFGHBKSW][a-z0-9_.-]*\s+\S+/i.test(line.text)){message=`第 ${line.line} 行包含不支持的元件：${line.text.slice(0,80)}`;break}
        if(/^X/i.test(line.text)){
          const target=line.text.split(/\s+/).at(-1)!
          if(!oldName.test(target)){message=`第 ${line.line} 行的 X 实例带有不支持的参数或子电路名称`;break}
          block.dependencies.push(target)
        }
      }
      if(message)failures.set(id.toLowerCase(),{line:header.line,severity:'error',message,model:id})
      pending=[];continue
    }
    if(/^\.model\b/i.test(entry.text)){
      const message=cardFailure(entry.text),id=entry.text.split(/\s+/)[1]
      if(message)failures.set(id.toLowerCase(),{line:entry.line,severity:'error',message,model:id})
    }
  }
  // Formerly parsed wrappers failed when a dependency was rejected. Replay
  // that exact diagnostic without trusting a cached declaration or model ID.
  const directlyRejected=new Set(failures.keys()),visiting=new Set<string>(),done=new Set<string>()
  function visit(key:string):void {
    if(done.has(key)||failures.has(key)||visiting.has(key))return
    visiting.add(key)
    const block=blocks.get(key)
    if(block)for(const target of block.dependencies){
      visit(target.toLowerCase())
      const failure=failures.get(target.toLowerCase())
      if(failure){failures.set(key,{line:block.line,severity:'error',model:block.id,message:directlyRejected.has(target.toLowerCase())?`子电路 ${block.id} 引用缺失的 .subckt ${target}；请提供展开依赖的模型文件`:failure.message});break}
    }
    visiting.delete(key);done.add(key)
  }
  for(const key of blocks.keys())visit(key)
  return failures
}

function acquisitionRecordsAgree(item:AgentModelAcquisition,parsed:ReturnType<typeof parseAcquiredModelLibrary>):boolean {
  if(stable(parsed.models)===stable(item.models)&&stable(parsed.diagnostics)===stable(item.diagnostics))return true
  if(!Array.isArray(item.models)||!Array.isArray(item.diagnostics))return false
  let restored:ImportedSpiceModel[]
  try{restored=parseImportedModels(item.models)}catch{return false}
  for(const model of restored)if(!parsed.models.some(current=>stable(current)===stable(model)))return false
  // Restoring a subcircuit canonicalizes its code; all other saved fields are
  // still immutable. Display symbols have already passed their own validator.
  for(const model of restored){
    const saved=item.models.find(entry=>entry.id===model.id)!
    if(stable({...saved,spice:model.spice})!==stable(model))return false
  }
  const legacy=previousCompatibilityFailures(item.text)
  const resolved=item.diagnostics.filter(diagnostic=>!parsed.diagnostics.some(current=>stable(current)===stable(diagnostic)))
  if(new Set(resolved.map(diagnostic=>stable(diagnostic))).size!==resolved.length)return false
  for(const diagnostic of resolved){
    if(!diagnostic||typeof diagnostic.model!=='string'||stable(legacy.get(diagnostic.model.toLowerCase()))!==stable(diagnostic))return false
  }
  for(const current of parsed.diagnostics)if(!item.diagnostics.some(diagnostic=>stable(current)===stable(diagnostic))&&!(current.severity==='warning'&&resolved.some(diagnostic=>diagnostic.line===current.line&&diagnostic.model===current.model)))return false
  for(const model of parsed.models)if(!restored.some(saved=>saved.id===model.id)&&!(model.kind==='X'&&resolved.some(diagnostic=>diagnostic.model===model.id)))return false
  return true
}

export function parseAgentModelAcquisitions(raw:unknown):AgentModelAcquisition[]{
  if(raw===undefined)return []
  if(!Array.isArray(raw)||raw.length>AGENT_MODEL_LIMITS.downloads)throw new Error('助手模型下载记录超过上限')
  const ids=new Set<string>();let total=0
  return raw.map(item=>{
    if(!item||typeof item!=='object'||typeof item.id!=='string'||!/^[a-f0-9]{64}$/.test(item.id)||ids.has(item.id)||typeof item.query!=='string'||item.query.length>48||typeof item.name!=='string'||item.name.length>500||typeof item.text!=='string'||item.text.length>AGENT_MODEL_LIMITS.fileCharacters)throw new Error('助手模型下载记录格式错误')
    ids.add(item.id);total+=item.text.length
    if(total>AGENT_MODEL_LIMITS.totalCharacters)throw new Error('助手模型下载源码超过上限')
    const parsed=parseAcquiredModelLibrary(item.text,item.source,{preserveSavedSymbols:true})
    if(item.origin==='local-library'){
      const localLabel=String(item.source.label)
      const installed=(/^本机 LTspice \/ standard\.(?:dio|bjt|mos|jft)$/.test(localLabel)||(/^本机 LTspice \/ sub\/Contrib\/(?:CHEMI-CON|Wurth)\/[a-z0-9_. /+-]+\.(?:lib|sub)$/i.test(localLabel)&&!localLabel.split('/').some(part=>part==='.'||part==='..'||!part)))&&item.source.url===localSourceUrl
      if(!installed&&!isOwnedVendorModelSource(item.source)&&!isBundledModelSource(item.source)&&!registeredDownloadUrl(item.source.url))throw new Error('助手模型缺少已登记的本地库来源')
    }else if(item.origin!=='online'||!registeredDownloadUrl(item.source.url))throw new Error('助手模型缺少支持的公开下载来源')
    // Symbols are bounded display attachments, not electrical model text.
    // Revalidate their shape, coordinates and every immutable port index while
    // continuing to compare all electrical definitions/source/diagnostics with
    // the freshly parsed original text. Never trust the stored JSON wholesale.
    if(Array.isArray(item.models))for(const model of parsed.models){
      const saved=item.models.find((entry:unknown)=>entry&&typeof entry==='object'&&(entry as {id?:unknown}).id===model.id)
      if(saved?.symbol!==undefined)model.symbol=parseModelSymbol(saved.symbol,model.kind,model.pins)
    }
    if(!acquisitionRecordsAgree(item,parsed))throw new Error('助手模型与下载源码或兼容性记录不一致')
    if(!Array.isArray(item.importedModelIds)||item.importedModelIds.length>128||item.importedModelIds.some((id:unknown)=>typeof id!=='string'||!parsed.models.some(model=>model.id===id))||new Set(item.importedModelIds).size!==item.importedModelIds.length)throw new Error('助手模型导入记录不一致')
    return{id:item.id,query:item.query,name:item.name,text:item.text,source:item.source,...parsed,importedModelIds:[...item.importedModelIds],origin:item.origin}
  })
}

/** Preserve every existing model; only accept parser-verified downloaded additions. */
export function parseAgentProposal(summary:string,project:unknown,original:Project,acquisitions:AgentModelAcquisition[]):AiProposal{
  const verifiedAcquisitions=parseAgentModelAcquisitions(acquisitions)
  if(!project||typeof project!=='object'||Array.isArray(project))throw new Error('助手候选项目格式错误')
  const proposed=project as Project,existing=original.models??[],incoming=proposed.models??existing
  if(!Array.isArray(incoming))throw new Error('助手候选模型库格式错误')
  for(const model of existing)if(!incoming.some(item=>stable(item)===stable(model)))throw new Error(`助手不能修改或删除已有模型 ${model.id}`)
  const additions:ImportedSpiceModel[]=[]
  for(const model of incoming){
    if(existing.some(item=>item.id.toLowerCase()===String(model.id).toLowerCase()))continue
    const verified=verifiedAcquisitions.some(item=>item.importedModelIds.includes(model.id)&&item.models.some(downloaded=>stable(downloaded)===stable(model)))
    if(!verified)throw new Error(`模型 ${model.id??'?'} 没有匹配的真实下载记录，候选未接受`)
    additions.push(model)
  }
  const baseline={...original,...(incoming.length||original.models?{models:incoming}:{})}
  const proposal=parseAiProposal(JSON.stringify({summary,project}),baseline)
  return{...proposal,base:aiProjectFingerprint(original),changes:[...proposalChanges(original,proposal.project).filter(change=>change!=='项目没有变化'),...additions.map(model=>`导入模型 ${model.id} · ${model.source.label}`)].concat(!additions.length&&aiProjectFingerprint(proposal.project)===aiProjectFingerprint(original)?['项目没有变化']:[])}
}
