import { models as builtInModels } from './devices'
import { parseModelSymbol, type ModelSymbol } from './model-symbol'
import { normalizePolynomialSourcesForNgspice, validatePolynomialSource } from './spice-polynomial'
import { parseModelAssessment, type ModelAssessment } from './modeling-assessment'
import { isPspiceSwitchCard, normalizePspiceSwitches } from './pspice-switches'
import { normalizePspiceBehaviorLine } from './pspice-behavior'
import { normalizePassiveComponents, normalizePassiveModelForNgspice } from './spice-passives'
import { normalizeDiodeAreas } from './spice-diode-area'
import { primitiveModelCompatibility } from './spice-primitive-compatibility'
import { normalizePspiceSourceUnits } from './spice-source-units'
import { normalizeSpiceElementParameters, parseSpiceParameterAssignments, parseSubcircuitHeader, parseSubcircuitInstance, spiceParameterTail, validateSpiceParameterExpression, type SpiceParameterAssignment } from './spice-parameters'
import { spiceModelName as modelId } from './spice-model-name'
import { enrichDeviceInfoFromLibrary, parseModelDeviceInfo, type ModelDeviceInfo } from './model-device-info'

export type ImportedModelKind = 'D' | 'Q' | 'M' | 'J' | 'X'
export type ImportedModelType = 'D' | 'NPN' | 'PNP' | 'NMOS' | 'PMOS' | 'NJF' | 'PJF' | 'SUBCKT'
export interface SpiceModelSource { label:string; url?:string; license?:string; attribution?:string }
export interface ImportedSpiceModel {
  id:string
  kind:ImportedModelKind
  type:ImportedModelType
  technology?:'VDMOS'
  name:string
  detail:string
  spice:string
  source:SpiceModelSource
  metadata:Record<string,string>
  pins:string[]
  symbol?:ModelSymbol
  assessment?:ModelAssessment
  deviceInfo?:ModelDeviceInfo
}
export interface SpiceModelDiagnostic { line:number; severity:'warning'|'error'; message:string; model?:string }
export interface SpiceLibraryPreview { models:ImportedSpiceModel[]; diagnostics:SpiceModelDiagnostic[] }
export const SPICE_LIBRARY_LIMITS = { fileBytes:4*1024*1024, projectModels:128, modelCharacters:4096, subcircuitCharacters:128*1024, subcircuitPins:32, previewModels:10000 } as const

// Deliberately finite ngspice parameter subsets. Unknown electrical parameters
// are rejected, never removed to make an incompatible definition appear valid.
const parameterNames:Record<Exclude<ImportedModelType,'SUBCKT'>,Set<string>> = {
  NJF:new Set('VTO BETA LAMBDA RD RS CGS CGD PB IS B KF AF FC TNOM'.split(' ')),
  PJF:new Set('VTO BETA LAMBDA RD RS CGS CGD PB IS B KF AF FC TNOM'.split(' ')),
  D:new Set('IS RS N TT CJO CJ0 VJ M EG XTI KF AF FC BV IBV TNOM ISR NR IKF NBV TRS1 TRS2 TBV1 TCV VP'.split(' ')),
  NPN:new Set('IS BF NF VAF IKF ISE NE BR NR VAR IKR ISC NC RB IRB RBM RE RC CJE VJE MJE TF XTF VTF ITF PTF CJC VJC MJC XCJC TR CJS VJS MJS XTB EG XTI KF AF FC TNOM NK NKF TIKF1 TIKF2 PC RCO VO GAMMA QCO'.split(' ')),
  PNP:new Set('IS BF NF VAF IKF ISE NE BR NR VAR IKR ISC NC RB IRB RBM RE RC CJE VJE MJE TF XTF VTF ITF PTF CJC VJC MJC XCJC TR CJS VJS MJS XTB EG XTI KF AF FC TNOM NK NKF TIKF1 TIKF2 PC RCO VO GAMMA QCO'.split(' ')),
  NMOS:new Set('LEVEL VTO KP GAMMA PHI LAMBDA RD RS CBD CBS IS PB CGSO CGDO CGBO RSH CJ MJ CJSW MJSW JS TOX NSUB NSS NFS TPG XJ LD UO U0 UCRIT UEXP VMAX NEFF KF AF FC DELTA THETA ETA KAPPA TNOM'.split(' ')),
  PMOS:new Set('LEVEL VTO KP GAMMA PHI LAMBDA RD RS CBD CBS IS PB CGSO CGDO CGBO RSH CJ MJ CJSW MJSW JS TOX NSUB NSS NFS TPG XJ LD UO U0 UCRIT UEXP VMAX NEFF KF AF FC DELTA THETA ETA KAPPA TNOM'.split(' ')),
}
// Checked against ngspice's mos1.c / mos2.c / mos3.c model parameter tables.
// Level 3 has no LAMBDA, and e.g. THETA cannot be sent to a Level 1 model.
// https://github.com/ngspice/ngspice/tree/master/src/spicelib/devices
const mosCommon='LEVEL VTO KP GAMMA PHI RD RS CBD CBS IS PB CGSO CGDO CGBO RSH CJ MJ CJSW MJSW JS TOX NSUB NSS TPG LD UO U0 KF AF FC TNOM'.split(' ')
const mosParameters:Record<string,Set<string>>={
  '1':new Set([...mosCommon,'LAMBDA']),
  '2':new Set([...mosCommon,...'LAMBDA DELTA UEXP UCRIT VMAX XJ NEFF NFS'.split(' ')]),
  '3':new Set([...mosCommon,...'VMAX XJ NFS ETA DELTA THETA KAPPA'.split(' ')]),
}
// ngspice 45.2 implements native, three-terminal VDMOS. These are electrical
// parameters from src/spicelib/devices/vdmos/vdmos.c, not a MOS1 approximation.
// Thermal terminals/flags are deliberately excluded from this three-pin UI.
const vdmosParameters=new Set('VTO VTH0 KP PHI LAMBDA THETA RD RS RG TNOM KF AF RQ VQ MTRIODE TCVTH VTOTC MU BEX TEXP0 TEXP1 TRD1 TRD2 TRG1 TRG2 TRS1 TRS2 TRB1 TRB2 SUBSHIFT KSUBTHRES TKSUBTHRES1 TKSUBTHRES2 BV IBV NBV RDS RB N TT EG XTI IS VJ VP CJO M FC CGDMIN CGDMAX A CGS'.split(' '))
const metadataNames = new Set(['mfg','type','iave','vpk','vceo','icrating','vds','ron','qg'])
const builtInIds = new Set(builtInModels.map(model=>model.id.toLowerCase()))
const numeric = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf]?)$/i

function textField(raw:unknown,label:string,max:number,required=false):string|undefined {
  if(raw===undefined&&!required)return undefined
  if(typeof raw!=='string'||raw.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw)||required&&!raw.trim())throw new Error(`${label}格式错误`)
  return raw.trim()
}
function parseSource(raw:unknown):SpiceModelSource {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('模型需要来源信息')
  const source=raw as Record<string,unknown>
  const label=textField(source.label,'模型来源',200,true)!
  const url=textField(source.url,'模型来源网址',2048)
  if(url){let parsed:URL;try{parsed=new URL(url)}catch{throw new Error('模型来源网址须为 HTTP 或 HTTPS 地址')}if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('模型来源网址须为 HTTP 或 HTTPS 地址')}
  const license=textField(source.license,'模型授权说明',500),attribution=textField(source.attribution,'模型署名',1000)
  return {label,...(url?{url}:{}),...(license?{license}:{}),...(attribution?{attribution}:{})}
}
function cleanMetadata(raw:unknown):Record<string,string> {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('模型目录信息格式错误')
  const result:Record<string,string>={}
  for(const [key,value] of Object.entries(raw)){
    if(!metadataNames.has(key))throw new Error(`不支持的模型目录信息：${key}`)
    result[key]=textField(value,'模型目录信息',200,true)!
  }
  return result
}

/** Decode browser File.arrayBuffer(), including LTspice's UTF-16 catalog files. */
export function decodeSpiceLibrary(input:ArrayBuffer|Uint8Array):string {
  const data=input instanceof Uint8Array?input:new Uint8Array(input)
  if(data.byteLength>SPICE_LIBRARY_LIMITS.fileBytes)throw new Error('SPICE 模型文件最多支持 4 MB')
  let encoding='utf-8'
  if(data[0]===0xff&&data[1]===0xfe)encoding='utf-16le'
  else if(data[0]===0xfe&&data[1]===0xff)encoding='utf-16be'
  else if(data.length>=8){
    const sample=data.slice(0,Math.min(256,data.length));let even=0,odd=0
    for(let i=0;i<sample.length;i++)if(sample[i]===0){if(i%2)odd++;else even++}
    if(odd>sample.length/4&&even<sample.length/20)encoding='utf-16le'
    else if(even>sample.length/4&&odd<sample.length/20)encoding='utf-16be'
  }
  try{return new TextDecoder(encoding,{fatal:true}).decode(data).replace(/^\uFEFF/,'')}
  catch {if(encoding!=='utf-8')throw new Error('模型文件的 UTF-16 编码不完整');return new TextDecoder('windows-1252').decode(data)}
}

function parseModel(line:string,source:SpiceModelSource,parameterScope?:ReadonlySet<string>):ImportedSpiceModel {
  if(line.length>SPICE_LIBRARY_LIMITS.modelCharacters)throw new Error('单个模型最多支持 4096 个字符')
  const header=line.match(/^\.model\s+(\S+)\s+([a-z][a-z0-9]*)\s*(.*)$/i)
  if(!header)throw new Error('无法识别 .model 定义')
  const id=header[1],declaredType=header[2].toUpperCase(),vdmos=declaredType==='VDMOS'
  let type=declaredType as Exclude<ImportedModelType,'SUBCKT'>
  if(!modelId.test(id))throw new Error('模型名须为字母、数字、下划线、点或短横线，可用 / 分隔厂商限定段，最多 40 个字符')
  if(/^fx_/i.test(id))throw new Error('FX_ 前缀是工作台内部生成模型的保留名称，请在原文件中改名')
  if(builtInIds.has(id.toLowerCase()))throw new Error(`模型名 ${id} 与内置模型重复，请在原文件中改名`)
  if(!vdmos&&!Object.hasOwn(parameterNames,type))throw new Error(`模型类型 ${type} 暂不支持；支持 D、NPN、PNP、NMOS、PMOS、VDMOS、NJF、PJF`)
  let body=header[3].trim()
  if(body.startsWith('(')&&body.endsWith(')'))body=body.slice(1,-1).trim()
  if(vdmos){
    const flags=[...body.matchAll(/(?:^|[\s,])(pchan|nchan)(?=[\s,]|$)/gi)].map(match=>match[1].toLowerCase())
    if(flags.length>1)throw new Error('VDMOS 通道标志重复或冲突')
    type=flags[0]==='pchan'?'PMOS':'NMOS'
    body=body.replace(/(^|[\s,])(?:pchan|nchan)(?=[\s,]|$)/gi,' ').trim()
  }
  if(/[\r\n]/.test(body)||!parameterScope&&/[()]/.test(body))throw new Error('模型参数括号不匹配，或包含暂不支持的表达式')
  const parameters:Record<string,string>={},metadata:Record<string,string>={}
  let cursor=0
  while(cursor<body.length){
    const rest=body.slice(cursor)
    const token=rest.match(parameterScope?/^[\s,]*([a-z][a-z0-9_]*)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\{[^{}\r\n]*\}|[^\s,()]+))/i:/^[\s,]*([a-z][a-z0-9_]*)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,]+))/i)
    if(!token)throw new Error(`无法识别模型参数：${rest.slice(0,70)}`)
    cursor+=token[0].length
    const key=token[1].toUpperCase(),value=token[2]??token[3]??token[4]
    if(metadataNames.has(key.toLowerCase())&&(vdmos||!['vds','ron','qg'].includes(key.toLowerCase()))){
      const metaKey=key.toLowerCase();if(Object.hasOwn(metadata,metaKey))throw new Error(`目录信息 ${key} 重复`)
      metadata[metaKey]=textField(value,`目录信息 ${key}`,200,true)!
    }else{
      if(!(vdmos?vdmosParameters:parameterNames[type]).has(key))throw new Error(`暂不支持电气参数 ${key}；模型未导入，原定义不会被删减`)
      if(Object.hasOwn(parameters,key))throw new Error(`电气参数 ${key} 重复`)
      const match=value.match(numeric)
      if(!match&&parameterScope){
        if(key==='LEVEL')throw new Error('MOS LEVEL 须为明确常数，不能使用参数表达式')
        parameters[key]=parseSpiceParameterAssignments(`${key}=${value}`,parameterScope)[0].value
        continue
      }
      if(!match||!Number.isFinite(Number(match[1])))throw new Error(`电气参数 ${key} 需要常数，暂不支持“${value}”`)
      const scales:Record<string,number>={'':1,t:1e12,g:1e9,meg:1e6,k:1e3,m:1e-3,u:1e-6,n:1e-9,p:1e-12,f:1e-15}
      const number=Number(match[1])*scales[match[2].toLowerCase()]
      if(!Number.isFinite(number))throw new Error(`电气参数 ${key} 超出数值范围`)
      parameters[key]=value.toLowerCase()
    }
    while(/[\s,]/.test(body[cursor]??'')&&cursor<body.length)cursor++
  }
  const kind:ImportedModelKind=type==='D'?'D':type==='NPN'||type==='PNP'?'Q':type==='NJF'||type==='PJF'?'J':'M'
  const aliasGroups=vdmos?[['VTO','VTH0'],['TCVTH','VTOTC'],['MU','BEX']]:type==='D'?[['CJO','CJ0'],['TBV1','TCV']]:kind==='Q'?[['NK','NKF'],['PC','VJC']]:[]
  for(const aliases of aliasGroups)if(aliases.filter(key=>parameters[key]!==undefined).length>1)throw new Error(`${aliases.join(' 与 ')} 是同一个电气参数的别名，不能重复定义`)
  if(kind==='M'&&!vdmos){
    const level=parameters.LEVEL??'1'
    if(!/^[123](?:\.0*)?$/.test(level))throw new Error(`MOS LEVEL=${level} 暂不支持；当前支持 Level 1、2、3`)
    const valid=mosParameters[String(Number(level))]
    for(const key of Object.keys(parameters))if(!valid.has(key))throw new Error(`电气参数 ${key} 不适用于 MOS Level ${Number(level)}，模型未导入`)
    if(parameters.U0!==undefined&&parameters.UO!==undefined)throw new Error('U0 与 UO 是同一个电气参数的别名，不能重复定义')
  }
  const pins=kind==='D'?['阳极 A','阴极 K']:kind==='Q'?['集电极 C','基极 B','发射极 E']:['漏极 D','栅极 G',vdmos||kind==='J'?'源极 S':'源极 S（体端接源极）']
  const detail=`导入 ${type}${vdmos?' · VDMOS 功率 MOS':''} 模型 · ${source.label}。${vdmos?'原生三端 VDMOS，保留非线性电容及体二极管参数，不使用 W/L 缩放；未启用自热。':kind==='M'?'当前符号为三端，体端内部接源极；实例 W=100 µm、L=10 µm。':''}兼容性仅代表已通过语法检查，器件精度以模型来源及适用条件为准。`
  return {id,kind,type,...(vdmos?{technology:'VDMOS' as const}:{}),name:id,detail,spice:`.model ${id} ${vdmos?'VDMOS':type}(${vdmos?(type==='PMOS'?'pchan ':'nchan '):''}${Object.entries(parameters).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join(' ')})`,source,metadata,pins}
}

function removeInlineComment(line:string):string {
  let quote=''
  for(let i=0;i<line.length;i++){
    const char=line[i]
    if((char==='"'||char==="'")&&(!quote||char===quote)){quote=quote?'':char;continue}
    if(!quote&&(char===';'||char==='$'))return line.slice(0,i).trim()
  }
  return line.trim()
}

interface LibraryLine { text:string; line:number }
interface SubcircuitBlock { id:string; pins:string[]; lines:LibraryLine[]; dependencies:string[]; parameterNames:Set<string>; instances:ReturnType<typeof parseSubcircuitInstance>[]; start:number }
interface ResistorModel {id:string;spice:string;instanceParameters?:Record<string,string>}
const resistorModelHeader=/^\.model\s+(\S+)\s+(?:RES|R)(?=\s|\(|$)\s*(.*)$/i
// RES is the vendor alias for the ngspice R model, not an ordinary resistor
// value. Keep its temperature coefficients in a model card and retain the
// instance's resistance. Auxiliary cards belong to their enclosing subcircuit.
function parseResistorModel(line:string):ResistorModel {
  const match=line.match(resistorModelHeader)
  if(!match||line.length>SPICE_LIBRARY_LIMITS.modelCharacters)throw new Error('无法识别辅助电阻模型')
  const id=match[1];if(!modelId.test(id)||/^fx_/i.test(id))throw new Error('辅助电阻模型名称无效')
  let body=match[2].trim()
  if(body.startsWith('(')&&body.endsWith(')'))body=body.slice(1,-1).trim()
  const allowed=new Set(['TC1','TC2','TNOM','RSH','DEFW','NARROW','SHORT','TEMP','DTEMP'])
  const parameters=new Map<string,string>()
  while(body){
    const token=body.match(/^[\s,]*([a-z][a-z0-9_]*)\s*=\s*([^\s,()]+)/i)
    if(!token)throw new Error(`辅助电阻模型参数须为常数：${body.slice(0,70)}`)
    const declaredKey=token[1].toUpperCase(),value=token[2]
    const key=({T_ABS:'TEMP',T_REL_GLOBAL:'DTEMP',T_MEASURED:'TNOM'} as Record<string,string>)[declaredKey]??declaredKey
    if(!allowed.has(key)||parameters.has(key))throw new Error(`辅助电阻模型参数 ${key} 不支持或重复；原参数未删减`)
    const number=value.match(numeric)
    const scales:Record<string,number>={'':1,t:1e12,g:1e9,meg:1e6,k:1e3,m:1e-3,u:1e-6,n:1e-9,p:1e-12,f:1e-15}
    if(!number||!Number.isFinite(Number(number[1])*scales[number[2].toLowerCase()]))throw new Error(`辅助电阻模型 ${key} 须为有限常数`)
    parameters.set(key,value.toLowerCase());body=body.slice(token[0].length).replace(/^[\s,]+/,'')
  }
  // ngspice TEMP/DTEMP are instance parameters. Leaving them on an R model
  // is silently ignored by the solver and reintroduces noise into T_ABS=0 K
  // vendor resistors. Carry the vendor defaults to every referencing instance.
  const instanceParameters=Object.fromEntries([...parameters].filter(([key])=>key==='TEMP'||key==='DTEMP'))
  return{id,spice:`.model ${id} R(${[...parameters].filter(([key])=>key!=='TEMP'&&key!=='DTEMP').sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join(' ')})`,...(Object.keys(instanceParameters).length?{instanceParameters}:{})}
}
function validBjtInstanceTail(parts:readonly string[],parameterScope?:ReadonlySet<string>):boolean {
  let rest=parts.join(' ').trim()
  const seen=new Set<string>()
  const constant=/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:meg|[tgkmunpf])?(?=\s|,|$)/i
  function takeConstant():boolean {
    const match=rest.match(constant)
    if(!match||!Number.isFinite(Number(match[1])))return false
    rest=rest.slice(match[0].length).trim()
    return true
  }
  function takeValue():boolean {
    if(!rest.startsWith('{'))return takeConstant()
    if(!parameterScope)return false
    const end=rest.indexOf('}')
    if(end<0||end+1<rest.length&&!/[\s,]/.test(rest[end+1]))return false
    try{validateSpiceParameterExpression(rest.slice(1,end),parameterScope)}catch{return false}
    rest=rest.slice(end+1).trim()
    return true
  }
  // Only the first positional scalar can be AREA. Arbitrary node/model
  // names cannot stand in for an area or another instance parameter.
  if(rest.match(constant)||rest.startsWith('{')){
    if(!takeValue())return false
    seen.add('AREA')
  }
  while(rest){
    const off=rest.match(/^OFF(?=\s|$)/i)
    if(off){
      if(seen.has('OFF'))return false
      seen.add('OFF');rest=rest.slice(off[0].length).trim();continue
    }
    const parameter=rest.match(/^(AREA|AREAB|AREAC|M|IC|TEMP|DTEMP)\s*=\s*/i)
    if(!parameter||seen.has(parameter[1].toUpperCase()))return false
    const key=parameter[1].toUpperCase()
    seen.add(key);rest=rest.slice(parameter[0].length).trim()
    if(!takeValue())return false
    if(key==='IC'&&rest.startsWith(',')){
      rest=rest.slice(1).trim()
      if(!takeValue())return false
    }
  }
  return true
}
/** Q c b e [substrate] model [area/parameters]. Resolve the optional node from
 * local model declarations, rather than treating the substrate as a model or
 * guessing from numeric node names. Each candidate must also have a legal
 * parameter tail in a declared scope. Callers supply case-folded IDs. */
export function bjtInstanceModelIndex(parts:readonly string[],declaredModelIds:ReadonlySet<string>,parameterScope?:ReadonlySet<string>):number|undefined {
  if(parts[0]?.[0]?.toUpperCase()!=='Q')return undefined
  const candidates=[4,5].filter(index=>parts[index]&&declaredModelIds.has(parts[index].toLowerCase())&&validBjtInstanceTail(parts.slice(index+1),parameterScope))
  if(candidates.length>1)throw new Error(`Q 实例的模型位置不明确：${parts[4]} / ${parts[5]} 均有本地定义且尾部参数合法；请明确衬底节点与模型名称`)
  return candidates[0]
}
/** Only self-contained ngspice statements are eligible. In particular LTspice A
 * devices, encrypted content, file directives and command blocks are excluded. */
function parseSubcircuitBlock(lines:LibraryLine[],externalResistors:ReadonlyMap<string,ResistorModel>=new Map(),externalSwitches:readonly string[]=[],externalModels:ReadonlyMap<string,ImportedSpiceModel>=new Map()):SubcircuitBlock {
  const original=lines
  lines=normalizePspiceSwitches(lines.map(line=>line.text),externalSwitches).map(text=>({text:normalizePspiceBehaviorLine(text),line:original.find(line=>line.text===text||text.startsWith(`B__PS_${line.text.split(/\s+/)[0]} `))?.line??original[0].line}))
  const beforePassives=lines
  lines=normalizePassiveComponents(normalizeDiodeAreas(lines.map(line=>line.text).join('\n')).split('\n')).map(text=>({text,line:beforePassives.find(line=>line.text===text||line.text.split(/\s+/)[0]===text.split(/\s+/)[0])?.line??original[0].line}))
  const header=lines[0],parsedHeader=parseSubcircuitHeader(header.text),{id,pins}=parsedHeader
  if(!id||!modelId.test(id)||/^fx_/i.test(id)||builtInIds.has(id.toLowerCase()))throw new Error('子电路名称无效或与内置模型冲突')
  const end=lines.at(-1)
  if(!end||!/^\.ends(?:\s+\S+)?$/i.test(end.text))throw new Error('.subckt 缺少对应的 .ends')
  const endName=end.text.split(/\s+/)[1]
  if(endName&&endName.toLowerCase()!==id.toLowerCase())throw new Error(`.ends ${endName} 与 .subckt ${id} 不一致`)
  const dependencies:string[]=[],modelReferences:string[]=[],defined=new Set<string>();let elements=0
  const assignments:SpiceParameterAssignment[]=[...parsedHeader.parameters],parameterScope=new Set(assignments.map(parameter=>parameter.name.toLowerCase()))
  const parameterNames=new Set(parameterScope),instances:ReturnType<typeof parseSubcircuitInstance>[]=[]
  // Collect the full local scope before validation: vendor defaults and .param
  // definitions can refer to a later declaration, but not to an absent scope.
  for(const entry of lines.slice(1,-1))if(/^\.param\b/i.test(entry.text)){
    const parsed=parseSpiceParameterAssignments(entry.text.replace(/^\.param\s*/i,''))
    if(!parsed.length)throw new Error(`第 ${entry.line} 行 .param 缺少参数赋值`)
    for(const parameter of parsed){
      const key=parameter.name.toLowerCase()
      if(parameterScope.has(key))throw new Error(`子电路参数 ${parameter.name} 重复`)
      parameterScope.add(key);assignments.push(parameter)
    }
    entry.text=`.param ${parsed.map(parameter=>`${parameter.name}=${parameter.value}`).join(' ')}`
  }
  for(const parameter of assignments)validateSpiceParameterExpression(parameter.value.startsWith('{')?parameter.value.slice(1,-1):parameter.value,parameterScope)
  const byName=new Map(assignments.map(parameter=>[parameter.name.toLowerCase(),parameter])),visitedParameters=new Set<string>(),pendingParameters=new Set<string>()
  function visitParameter(name:string):void {
    if(pendingParameters.has(name))throw new Error(`子电路参数 ${name} 循环引用`)
    if(visitedParameters.has(name))return
    pendingParameters.add(name)
    for(const dependency of byName.get(name)?.references??[])visitParameter(dependency)
    pendingParameters.delete(name);visitedParameters.add(name)
  }
  for(const name of byName.keys())visitParameter(name)
  if(parsedHeader.parameters.length)header.text=`.subckt ${id} ${pins.join(' ')}${spiceParameterTail(parsedHeader.parameters)}`
  const resistors=new Map<string,ResistorModel>(),usedExternalResistors=new Map<string,ResistorModel>()
  // SPICE model cards can follow their instances. Collect and validate all
  // local declarations first so a four-terminal BJT has the same meaning at
  // import, preview and saved-project replay.
  for(const entry of lines.slice(1,-1)){
    if(!/^\.model\b/i.test(entry.text))continue
    const isResistor=resistorModelHeader.test(entry.text)
    const model=isResistor?parseResistorModel(entry.text):isPspiceSwitchCard(entry.text)?{id:entry.text.split(/\s+/)[1],spice:entry.text}:parseModel(entry.text,{label:'子电路内部模型'},parameterScope)
    if(defined.has(model.id.toLowerCase()))throw new Error(`内部模型 ${model.id} 重复`)
    defined.add(model.id.toLowerCase())
    if(isResistor)resistors.set(model.id.toLowerCase(),model)
    entry.text=model.spice
  }
  const declaredModelIds=new Set([...defined,...externalModels.keys()])
  for(const entry of lines.slice(1,-1)){
    const line=entry.text,letter=line[0]?.toUpperCase()
    if(/^\.model\b/i.test(line))continue
    if(/^\.param\b/i.test(line)){
      continue
    }
    if(line.startsWith('.'))throw new Error(`第 ${entry.line} 行包含不支持的子电路指令：${line.slice(0,80)}`)
    if(!/^[RCLVIDQJMEXFGHBKSW][a-z0-9_.+-]*\s+\S+/i.test(line))throw new Error(`第 ${entry.line} 行包含不支持的元件：${line.slice(0,80)}`)
    validatePolynomialSource(line)
    elements++
    entry.text=normalizeSpiceElementParameters(line,parameterScope)
    if(letter==='R'){
      const parts=line.split(/\s+/),valueFirst=numeric.test(parts[3]??'')
      const reference=valueFirst?parts[4]:parts[3]
      if(reference&&modelId.test(reference)&&!numeric.test(reference)&&(valueFirst||defined.has(reference.toLowerCase())||externalResistors.has(reference.toLowerCase())||numeric.test(parts[4]??''))){
        const key=reference.toLowerCase(),local=resistors.get(key)
        const external=defined.has(key)?undefined:externalResistors.get(key),model=local??external
        if(!model)throw new Error(`第 ${entry.line} 行电阻依赖缺失或非电阻的 .model ${reference}`)
        const value=valueFirst?parts[3]:parts[4]
        if(!value||!numeric.test(value))throw new Error(`第 ${entry.line} 行模型电阻须保留明确的常数阻值`)
        if(parts.slice(5).some(part=>! /^(?:L|W|M|TEMP|DTEMP)=[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i.test(part)&&!/^NOISY=[01]$/i.test(part)))throw new Error(`第 ${entry.line} 行模型电阻包含不支持的实例参数；未删减原参数`)
        for(const [key,value] of Object.entries(model.instanceParameters??{}))if(!parts.slice(5).some(part=>part.split('=')[0].toUpperCase()===key))entry.text+=` ${key}=${value}`
        // At absolute zero this finite resistor subset has no noise. Explicit
        // NOISY=0 also avoids the pinned WASM engine's nonzero thermal residual
        // at TEMP=-273.15; retain TEMP for temperature-coefficient evaluation.
        const temperature=entry.text.match(/(?:^|\s)TEMP=([^\s]+)/i)?.[1]
        if(temperature!==undefined&&Number(temperature)===-273.15&&!/\bNOISY=/i.test(entry.text))entry.text+=' NOISY=0'
        if(external)usedExternalResistors.set(key,external)
      }
    }
    if(['D','Q','J','M'].includes(letter)){
      const parts=line.split(/\s+/),position=letter==='Q'?bjtInstanceModelIndex(parts,declaredModelIds,parameterScope):letter==='D'?3:letter==='M'?5:4
      if(letter==='Q'&&position===undefined)throw new Error(`第 ${entry.line} 行的 Q 实例缺少本地 .model 定义，或实例尾部参数不受支持；模型位置候选：${parts.slice(4,6).join(' / ')||'缺失'}。请提供自包含定义及常数 AREA、OFF、IC、TEMP 等参数`)
      const reference=position===undefined?undefined:parts[position]
      if(!reference||!modelId.test(reference))throw new Error(`第 ${entry.line} 行缺少有效的 .model 名称`)
      modelReferences.push(reference)
    }
    if(letter==='X'){
      const instance=parseSubcircuitInstance(line)
      for(const parameter of instance.parameters)validateSpiceParameterExpression(parameter.value.startsWith('{')?parameter.value.slice(1,-1):parameter.value,parameterScope)
      dependencies.push(instance.target);instances.push(instance)
      if(instance.parameters.length)entry.text=`${instance.id} ${instance.pins.join(' ')} ${instance.target}${spiceParameterTail(instance.parameters)}`
    }
  }
  const usedExternalModels=new Map<string,ImportedSpiceModel>()
  for(const reference of modelReferences){
    const key=reference.toLowerCase()
    if(defined.has(key))continue
    const model=externalModels.get(key)
    if(!model)throw new Error(`子电路依赖外部 .model ${reference}；请提供自包含定义`)
    usedExternalModels.set(key,model)
  }
  if(!elements)throw new Error('子电路没有可仿真的元件语句')
  if(usedExternalResistors.size)lines.splice(lines.length-1,0,...[...usedExternalResistors.values()].map(model=>({text:model.spice,line:header.line})))
  if(usedExternalModels.size)lines.splice(lines.length-1,0,...[...usedExternalModels.values()].map(model=>({text:model.spice,line:header.line})))
  const length=lines.reduce((sum,line)=>sum+line.text.length+1,0)
  if(length>SPICE_LIBRARY_LIMITS.subcircuitCharacters)throw new Error('单个子电路源码最多支持 128 KB')
  return {id,pins,lines,dependencies,parameterNames,instances,start:header.line}
}
function importedSubcircuit(block:SubcircuitBlock,blocks:Map<string,SubcircuitBlock>,source:SpiceModelSource):ImportedSpiceModel {
  const ordered:SubcircuitBlock[]=[],visited=new Set<string>(),stack=new Set<string>()
  function visit(current:SubcircuitBlock){
    const key=current.id.toLowerCase()
    if(stack.has(key))throw new Error(`子电路 ${current.id} 循环引用`)
    if(visited.has(key))return
    stack.add(key)
    for(const instance of current.instances){
      const dependency=blocks.get(instance.target.toLowerCase())
      if(!dependency)continue // The dependency traversal reports the missing definition.
      if(instance.pins.length!==dependency.pins.length)throw new Error(`X 实例 ${instance.id} 的端口数量与 ${dependency.id} 不一致`)
      for(const parameter of instance.parameters)if(!dependency.parameterNames.has(parameter.name.toLowerCase()))throw new Error(`X 实例 ${instance.id} 设置了 ${dependency.id} 未声明的参数 ${parameter.name}`)
    }
    for(const name of current.dependencies){
      const dependency=blocks.get(name.toLowerCase())
      if(!dependency)throw new Error(`子电路 ${current.id} 引用缺失的 .subckt ${name}；请提供展开依赖的模型文件`)
      visit(dependency)
    }
    stack.delete(key);visited.add(key);ordered.push(current)
  }
  visit(block)
  const spice=ordered.flatMap(item=>item.lines.map(line=>line.text)).join('\n')
  if(spice.length>SPICE_LIBRARY_LIMITS.subcircuitCharacters)throw new Error('子电路及依赖源码最多支持 128 KB')
  return {id:block.id,kind:'X',type:'SUBCKT',name:block.id,detail:`导入子电路 · ${source.label}。${block.pins.length} 个端口，按 .subckt 原始顺序接线；兼容性仅代表静态检查通过，仍需实际 ngspice 仿真验证。`,spice,source,metadata:{},pins:block.pins}
}

/** Preview only: each rejected record remains visible in diagnostics. No directives execute. */
export function parseSpiceLibrary(text:string,sourceInput:SpiceModelSource):SpiceLibraryPreview {
  const source=parseSource(sourceInput)
  if(typeof text!=='string'||new TextEncoder().encode(text).length>SPICE_LIBRARY_LIMITS.fileBytes)throw new Error('SPICE 模型文件最多支持 4 MB')
  const diagnostics:SpiceModelDiagnostic[]=[],models:ImportedSpiceModel[]=[]
  if(/<binary file>|\x00|\.protect\b|\.unprotect\b|\$cd[nk]|BEGIN\s+ENCRYPTED/i.test(text))return {models,diagnostics:[{line:1,severity:'error',message:'文件包含二进制、加密或受保护模型，不能导入 ngspice'}]}
  const lines:{text:string;line:number}[]=[]
  for(const [index,raw] of text.replace(/^\uFEFF/,'').split(/\r?\n/).entries()){
    const line=removeInlineComment(raw.trim())
    if(!line||line.startsWith('*'))continue
    if(line.startsWith('+')){
      if(!lines.length){diagnostics.push({line:index+1,severity:'error',message:'续行前缺少模型定义'});continue}
      lines[lines.length-1].text+=` ${line.slice(1).trim()}`
    }else lines.push({text:line,line:index+1})
  }
  // Extracting a definition from a disabled condition, a library section or
  // a control program changes its meaning. Refuse the whole contextual file
  // instead of offering seemingly valid records from an unknown scope.
  const scoped=lines.filter(entry=>/^\.(?:if|elseif|else|endif|control|endc|lib|endl|include|inc)\b/i.test(entry.text))
  if(scoped.length)return {models,diagnostics:[...diagnostics,...scoped.map(entry=>({line:entry.line,severity:'error' as const,message:`文件包含条件、控制区块、库区段或外部依赖：${entry.text.slice(0,100)}。为保留原语义，整个文件未导入；请提供独立且展开依赖的 .model 定义`}))]}
  const seen=new Set<string>(),duplicate=new Set<string>(),blocks=new Map<string,SubcircuitBlock>()
  const externalResistors=new Map<string,ResistorModel>(),externalModels=new Map<string,ImportedSpiceModel>(),externalSwitches:string[]=[];let scopeDepth=0
  for(const entry of lines){
    if(/^\.subckt\b/i.test(entry.text)){scopeDepth++;continue}
    if(/^\.ends\b/i.test(entry.text)){scopeDepth=Math.max(0,scopeDepth-1);continue}
    if(scopeDepth)continue
    if(isPspiceSwitchCard(entry.text)){externalSwitches.push(entry.text);continue}
    if(/^\.model\b/i.test(entry.text)&&!resistorModelHeader.test(entry.text)){
      try{const model=parseModel(entry.text,source),key=model.id.toLowerCase();if(externalModels.has(key))duplicate.add(key);else externalModels.set(key,model)}catch{}
      continue
    }
    if(!resistorModelHeader.test(entry.text))continue
    try{const model=parseResistorModel(entry.text),key=model.id.toLowerCase();if(externalResistors.has(key))duplicate.add(key);else externalResistors.set(key,model)}catch{/* The main pass retains the exact failing card's diagnostic. */}
  }
  for(const key of duplicate)externalResistors.delete(key)
  for(const key of duplicate)externalModels.delete(key)
  let pending:LibraryLine[]=[]
  for(const entry of lines){
    if(/^\.subckt\b/i.test(entry.text)){
      if(pending.length){diagnostics.push({line:entry.line,severity:'error',message:'嵌套 .subckt 暂不支持；请展开为独立定义'});pending=[]}
      pending=[entry];continue
    }
    if(pending.length){
      pending.push(entry)
      if(/^\.ends\b/i.test(entry.text)){
        try{
          const block=parseSubcircuitBlock(pending,externalResistors,externalSwitches,externalModels),key=block.id.toLowerCase()
          if(blocks.has(key)||seen.has(key)){duplicate.add(key);throw new Error(`模型名 ${block.id} 重复，所有同名定义均未导入`)}
          blocks.set(key,block)
        }catch(error){diagnostics.push({line:pending[0].line,severity:'error',message:(error as Error).message,model:pending[0].text.split(/\s+/)[1]})}
        pending=[]
      }
      continue
    }
    if(/^\.ends\b/i.test(entry.text)){diagnostics.push({line:entry.line,severity:'error',message:'.ends 没有对应的 .subckt'});continue}
    if(!/^\.model\b/i.test(entry.text)){diagnostics.push({line:entry.line,severity:'error',message:`未导入内容：${entry.text.slice(0,100)}。仅接受独立 .model，不能执行控制语句或引用外部文件`});continue}
    try{
      if(models.length>=SPICE_LIBRARY_LIMITS.previewModels)throw new Error('模型数量超过预览上限')
      const declaredId=entry.text.match(/^\.model\s+(\S+)/i)?.[1],key=declaredId?.toLowerCase()
      if(key&&(seen.has(key)||blocks.has(key))){duplicate.add(key);throw new Error(`模型名 ${declaredId} 重复，所有同名定义均未导入`)}
      if(key)seen.add(key)
      if(isPspiceSwitchCard(entry.text)){
        normalizePspiceSwitches([], [entry.text])
        diagnostics.push({line:entry.line,severity:'warning',model:declaredId,message:'辅助开关模型按原阈值与电阻嵌入引用它的子电路；平滑开关保留对数电阻插值，原件保留'})
        continue
      }
      if(resistorModelHeader.test(entry.text)){
        const auxiliary=parseResistorModel(entry.text)
        diagnostics.push({line:entry.line,severity:'warning',model:auxiliary.id,message:'辅助电阻模型按原参数嵌入引用它的子电路；不作为独立器件放置'})
        continue
      }
      const model=parseModel(entry.text,source);models.push(model)
      if(Object.keys(model.metadata).length)diagnostics.push({line:entry.line,severity:'warning',model:model.id,message:'已保留 LTspice 目录信息（厂家、额定值等），这些非电气字段不发送给 ngspice'})
    }catch(error){diagnostics.push({line:entry.line,severity:'error',message:(error as Error).message,model:entry.text.match(/^\.model\s+(\S+)/i)?.[1]})}
  }
  if(pending.length)diagnostics.push({line:pending[0].line,severity:'error',message:'.subckt 缺少 .ends',model:pending[0].text.split(/\s+/)[1]})
  for(const block of blocks.values()){
    if(duplicate.has(block.id.toLowerCase()))continue
    try{if(models.length>=SPICE_LIBRARY_LIMITS.previewModels)throw new Error('模型数量超过预览上限');models.push(importedSubcircuit(block,blocks,source))}
    catch(error){diagnostics.push({line:block.start,severity:'error',message:(error as Error).message,model:block.id})}
  }
  const accepted=models.filter(model=>!duplicate.has(model.id.toLowerCase()))
  enrichDeviceInfoFromLibrary(accepted,text,source)
  return {models:accepted,diagnostics}
}

/** Revalidate saved projects before they can reach the simulation worker. */
export function parseImportedModels(raw:unknown):ImportedSpiceModel[] {
  if(!Array.isArray(raw)||raw.length>SPICE_LIBRARY_LIMITS.projectModels)throw new Error('每个工程最多支持 128 个导入模型')
  const seen=new Set<string>()
  return raw.map(item=>{
    if(!item||typeof item!=='object'||typeof item.spice!=='string')throw new Error('导入模型数据格式错误')
    const source=parseSource(item.source)
    const model:ImportedSpiceModel=item.kind==='X'?(()=>{
      const preview=parseSpiceLibrary(item.spice,source)
      const found=preview.models.find(model=>model.kind==='X'&&model.id===item.id)
      if(!found||preview.diagnostics.some(d=>d.severity==='error'))throw new Error(`保存的子电路 ${item.id} 无法通过完整验证`)
      return found
    })():parseModel(item.spice,source)
    // Old saved subcircuits may predate PSpice lowering. Reparse and migrate
    // their complete validated closure, while keeping identity and port order.
    // Primitive cards retain their original strict canonical-data boundary.
    if(model.kind!=='X'&&item.spice!==model.spice||item.id!==model.id||item.kind!==model.kind||item.type!==model.type||item.technology!==model.technology)throw new Error('保存的模型定义不一致，请重新从原模型文件导入')
    if(model.kind==='X'&&JSON.stringify(item.pins)!==JSON.stringify(model.pins))throw new Error('保存的子电路引脚顺序与源码不一致')
    const key=model.id.toLowerCase();if(seen.has(key))throw new Error(`模型名 ${model.id} 重复`);seen.add(key)
    model.metadata=cleanMetadata(item.metadata)
    if(item.symbol!==undefined)model.symbol=parseModelSymbol(item.symbol,model.kind,model.pins)
    if(item.assessment!==undefined)model.assessment=parseModelAssessment(item.assessment)
    if(item.deviceInfo!==undefined){
      model.deviceInfo=parseModelDeviceInfo(item.deviceInfo)
      if(model.deviceInfo.portMapping&&JSON.stringify(model.deviceInfo.portMapping.ports)!==JSON.stringify(model.pins))throw new Error('保存的端口证据与模型电气顺序不一致')
    }
    return model
  })
}

/** The caller chooses records first; existing definitions are never overwritten. */
export function mergeImportedModels(existing:ImportedSpiceModel[]|undefined,incoming:ImportedSpiceModel[]):ImportedSpiceModel[] {
  return parseImportedModels([...(existing??[]),...incoming])
}

/** Preserve attribution when a project is exported as a standalone netlist. */
export function importedModelNetlist(model:ImportedSpiceModel):string {
  const comment=(label:string,value:string)=>`* ${label}: ${value.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g,' ').trim()}`
  const source=model.source
  return normalizePspiceSourceUnits([
    comment('Imported model',`${model.id}; definition formatting normalized, electrical values retained`),
    comment('Source',source.label),
    ...(source.url?[comment('URL',source.url)]:[]),
    ...(source.license?[comment('License',source.license)]:[]),
    ...(source.attribution?[comment('Attribution',source.attribution)]:[]),
    ...(model.assessment?[
      comment('Modeling scope',`${model.assessment.status}: ${model.assessment.summary}`),
      comment('Validation',`syntax ${model.assessment.validation.syntax}; electrical simulation not performed by modeling workflow`),
      ...model.assessment.items.filter(item=>item.status==='missing'||item.status==='unmapped').map(item=>comment('Unresolved modeling',`${item.label}: ${item.reason}`)),
    ]:[]),
    ...Object.entries(model.metadata).map(([key,value])=>comment(`Catalog ${key}`,value)),
    primitiveModelCompatibility(normalizePassiveModelForNgspice(normalizeDiodeAreas(normalizePolynomialSourcesForNgspice(model.spice)))).spice.replace(/^([ \t]*Q\S+(?:[ \t]+[^ \t\r\n{}=]+){4,5}[ \t]+)(\{[^{}\r\n]+\})([ \t]*)$/gim,'$1AREA=$2$3'),
  ].join('\n'))
}
