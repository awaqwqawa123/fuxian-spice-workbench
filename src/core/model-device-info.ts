import type { ImportedSpiceModel, SpiceModelSource } from './spice-models'

/** Descriptive source evidence never changes model code, package numbering or ports. */
export interface ModelDeviceInfo {
  version: 1
  manufacturer?: string
  function?: string
  description?: string
  portMapping?: {ports:string[]; labels:string[]; source:string; sha256:string; text:string}
  evidence: {kind:'source-header'|'catalog-metadata'; source:string; sha256?:string; text:string}[]
}

export function parseModelDeviceInfo(raw:unknown):ModelDeviceInfo {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('器件资料格式错误')
  const info=raw as Record<string,unknown>
  if(info.version!==1||Object.keys(info).some(key=>!['version','manufacturer','function','description','portMapping','evidence'].includes(key)))throw new Error('器件资料版本或字段错误')
  const text=(value:unknown,max:number)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw new Error('器件资料文字格式错误');return value.trim()}
  if(!Array.isArray(info.evidence)||info.evidence.length>8)throw new Error('器件资料证据列表错误')
  const evidence=info.evidence.map(raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('器件资料证据格式错误')
    const item=raw as Record<string,unknown>
    if(!['source-header','catalog-metadata'].includes(item.kind as string)||Object.keys(item).some(key=>!['kind','source','sha256','text'].includes(key)))throw new Error('器件资料证据字段错误')
    if(item.sha256!==undefined&&(typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256)))throw new Error('器件资料校验值错误')
    return {kind:item.kind as ModelDeviceInfo['evidence'][number]['kind'],source:text(item.source,300),text:text(item.text,1200),...(item.sha256?{sha256:item.sha256 as string}:{})}
  })
  let portMapping:ModelDeviceInfo['portMapping']
  if(info.portMapping!==undefined){
    const p=info.portMapping as Record<string,unknown>
    if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(key=>!['ports','labels','source','sha256','text'].includes(key))||!Array.isArray(p.ports)||!Array.isArray(p.labels)||!p.ports.length||p.ports.length>64||p.ports.length!==p.labels.length||typeof p.sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.sha256))throw new Error('器件端口证据格式错误')
    portMapping={ports:p.ports.map(value=>text(value,64)),labels:p.labels.map(value=>text(value,64)),source:text(p.source,300),sha256:p.sha256,text:text(p.text,1200)}
  }
  return {version:1,...(info.manufacturer!==undefined?{manufacturer:text(info.manufacturer,160)}:{}),...(info.function!==undefined?{function:text(info.function,300)}:{}),...(info.description!==undefined?{description:text(info.description,1200)}:{}),...(portMapping?{portMapping}:{}),evidence}
}

const manufacturers:[RegExp,string][]=[
  [/\bMicrosemi\b/i,'Microsemi'],[/\bTexas Instruments\b/i,'Texas Instruments'],
  [/\bAnalog Devices\b/i,'Analog Devices'],[/\bLinear Technology\b/i,'Linear Technology'],
  [/\bNational Semiconductor\b/i,'National Semiconductor'],[/\bON Semiconductor\b/i,'ON Semiconductor'],
  [/\bFairchild\b/i,'Fairchild'],[/\bVishay\b/i,'Vishay'],[/\bInfineon\b/i,'Infineon'],
  [/\bSTMicroelectronics\b/i,'STMicroelectronics'],[/\bNXP\b/i,'NXP'],[/\bNexperia\b/i,'Nexperia'],
  [/\bInternational Rectifier\b/i,'International Rectifier'],[/\bRenesas\b/i,'Renesas'],
]
// Only an explicit description of the root's purpose is classification evidence.
const purpose=/\b(?:bidirectional\s+(?:suppressor|supressor)|transient\s+(?:voltage\s+)?suppressor|TVS|Schottky|Zener|varactor|photodiode|operational amplifier|op[- ]amp|instrumentation amplifier|comparator|voltage reference|shunt reference|low[- ]dropout|LDO|voltage regulator|gate driver|MOSFET driver|IGBT driver|switching regulator|buck converter|boost converter|PWM controller|analog[- ]to[- ]digital|digital[- ]to[- ]analog|optocoupler|rectifier|fast recovery)\b/i
const clean=(line:string)=>line.replace(/^\s*\*+/,'').replace(/\*+\s*$/,'').trim().replace(/\s+/g,' ').slice(0,1200)

/** Only captions reviewed as describing the whole source file may follow a
 * root selected out of a multi-device library. All other comments stay scoped. */
export function sharedDeviceInfoHeaderLines(lines:readonly string[],source:SpiceModelSource):string[] {
  if(!/(?:^|\/)msemi_supressor\.lib$/i.test(source.label.replaceAll('\\','/')))return []
  return lines.filter(line=>/^Microsemi Bidirectional suppressor$/i.test(clean(line)))
}

/** Global comments stop at the first declaration. Scoped comments never leak
 * from internal dependency cards or the previous device into the next root. */
export function enrichDeviceInfoFromLibrary(models:ImportedSpiceModel[],text:string,source:SpiceModelSource,sha256?:string):void {
  const global:string[]=[],scoped=new Map<string,string[]>();let pending:string[]=[],depth=0,started=false
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim()
    if(depth){if(/^\.subckt\b/i.test(line))depth++;if(/^\.ends\b/i.test(line))depth--;continue}
    if(!line||line.startsWith('*')){if(line.startsWith('*'))pending.push(clean(line));continue}
    const declaration=line.match(/^\.(?:model|subckt)\s+(\S+)/i)
    if(declaration){
      if(!started){
        // Only the checked whole-file caption may describe every root. Other
        // first-device comments must never leak into subsequent device records.
        global.push(...sharedDeviceInfoHeaderLines(pending,source))
        started=true
      }
      scoped.set(declaration[1].toLowerCase(),pending)
      if(/^\.subckt\b/i.test(line))depth=1
    }
    pending=[]
  }
  for(const model of models){
    const local=scoped.get(model.id.toLowerCase())??[],lines=[...local,...global].filter(Boolean)
    const manufacturer=model.metadata.mfg??manufacturers.find(([pattern])=>lines.some(line=>pattern.test(line)))?.[1]
    const functionText=local.find(line=>purpose.test(line))??global.find(line=>purpose.test(line))??model.metadata.type
    const selected=[...new Set(lines.filter(line=>purpose.test(line)||manufacturer&&manufacturers.some(([pattern,name])=>name===manufacturer&&pattern.test(line))))].slice(0,3)
    const evidence:ModelDeviceInfo['evidence']=selected.map(line=>({kind:'source-header',source:source.label,...(sha256?{sha256}:{}),text:line}))
    if(model.metadata.mfg||model.metadata.type)evidence.push({kind:'catalog-metadata',source:source.label,text:Object.entries(model.metadata).filter(([key])=>key==='mfg'||key==='type').map(([key,value])=>`${key}=${value}`).join('; ')})
    if(manufacturer||functionText)model.deviceInfo=parseModelDeviceInfo({version:1,...(manufacturer?{manufacturer}:{}),...(functionText?{function:functionText}:{}),...(selected.length?{description:selected.join(' · ')}:{}),evidence})
  }
}
