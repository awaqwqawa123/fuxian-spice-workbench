import { parseSpiceLibrary, type ImportedSpiceModel, type ImportedModelKind, type ImportedModelType, type SpiceLibraryPreview, type SpiceModelSource } from './spice-models'
import { isCompatibleManufacturerTemplate, isManufacturerReference, modelParameterAdjustments } from './model-reference'
import { assessModeling } from './modeling-assessment-builder'

export interface ModelSearchCandidate { id:string; name:string; path:string; source:SpiceModelSource; matchedModels:string[]; origin?:'local-library'|'online'; match?:'exact'|'related'|'filename'; availability?:'ready'|'unsupported'; reason?:string }
export interface ModelSearchSourceStatus { source:'semiee'|'lcsc'|'google'|'alldatasheet'|'jlc'; label:string; state:'searched'|'restricted'|'unavailable'; searchUrl:string; detail:string; resultCount?:number; results?:{url:string;title:string}[] }
export interface ModelSearchResults { candidates:ModelSearchCandidate[]; notices:string[]; indexedFiles:number; coverage?:'complete'|'partial'; sourceStatuses?:ModelSearchSourceStatus[] }
export interface ModelDownloadPreview extends SpiceLibraryPreview { source:SpiceModelSource; text:string }
export interface ApproximateParameter { key:string; value:string; evidence:string }
export interface ApproximateModelRequest { template:ImportedSpiceModel; name:string; datasheetUrl?:string; datasheetFile?:string; parameterSource?:'datasheet'|'user'; parameters:ApproximateParameter[] }
const explicitFields = (keys: string, units: Record<string,string> = {}) => keys.split(' ').map(key => ({key,label:`${key}${units[key] ? ` · ${units[key]}` : ''}`,help:'仅使用明确的 SPICE 方程参数或有条件、可审定的映射依据；额定值与其他整体指标不能直接代入。'}))
export const approximateFields:Record<Exclude<ImportedModelType,'SUBCKT'>,{key:string;label:string;help:string}[]> = {
  D:[{key:'BV',label:'击穿电压 BV · V',help:'使用规定反向电流下的击穿电压；不要用最大反向额定电压替代。'},{key:'IBV',label:'击穿测试电流 IBV · A',help:'与 BV 对应的测试电流。'},{key:'CJO',label:'零偏结电容 CJO · F',help:'仅使用零偏压结电容；非零反偏电容不能直接代入。'}],
  NPN:[{key:'BF',label:'低电流直流增益 BF',help:'hFE 只能作为低电流增益的近似，填写测试电流与电压。'},{key:'CJE',label:'零偏 B–E 结电容 CJE · F',help:'仅使用零偏压值。'},{key:'CJC',label:'零偏 B–C 结电容 CJC · F',help:'仅使用零偏压值。'}],
  PNP:[{key:'BF',label:'低电流直流增益 BF',help:'hFE 只能作为低电流增益的近似，填写测试电流与电压。'},{key:'CJE',label:'零偏 B–E 结电容 CJE · F',help:'仅使用零偏压值。'},{key:'CJC',label:'零偏 B–C 结电容 CJC · F',help:'仅使用零偏压值。'}],
  NMOS:[{key:'VTO',label:'阈值近似 VTO · V',help:'用 VGS(th) 典型值作初始近似，并记录 ID 测试条件；不等于完整曲线拟合。'}],
  PMOS:[{key:'VTO',label:'阈值近似 VTO · V',help:'P 沟道填写负阈值，记录 VGS(th) 对应的 ID 测试条件。'}],
  NJF:[{key:'VTO',label:'夹断电压 VTO · V',help:'N 沟道通常为负值；记录 VGS(off) 的电流测试条件，仅作为初始近似。'},{key:'BETA',label:'跨导系数 BETA · A/V²',help:'依据输出曲线拟合，不能将数据手册 gfs 直接填入。'}],
  PJF:[{key:'VTO',label:'模型夹断参数 VTO · V',help:'ngspice PJF 使用负 VTO；手册中正的外部 VGS(off) 须转换符号并记录测试条件。'},{key:'BETA',label:'跨导系数 BETA · A/V²',help:'依据输出曲线拟合，不能将数据手册 gfs 直接填入。'}],
}
for (const type of ['D','NPN','PNP','NMOS','PMOS','NJF','PJF'] as const) {
  const keys = type==='D'?'IS RS N TT VJ M TNOM':type==='NPN'||type==='PNP'?'IS NF VAF TF':type==='NMOS'||type==='PMOS'?'KP LAMBDA CGSO CGDO CGS CGDMIN CGDMAX':'IS CGS CGD'
  approximateFields[type].push(...explicitFields(keys,{IS:'A',RS:'Ω',TT:'s',TF:'s',VJ:'V',VAF:'V',CGS:'F',CGD:'F',CGDMIN:'F',CGDMAX:'F',CGSO:'F/m',CGDO:'F/m',KP:'A/V²'}))
  if(['NMOS','PMOS','NJF','PJF'].includes(type))approximateFields[type].push(...explicitFields('TNOM',{TNOM:'°C'}))
}
export function approximationTemplates(imported:ImportedSpiceModel[],kind?:ImportedModelKind):ImportedSpiceModel[] {
  return imported.filter(model=>model.kind!=='X'&&(!kind||model.kind===kind)&&isManufacturerReference(model))
}
export function createApproximateModel(input:ApproximateModelRequest):ImportedSpiceModel {
  const name=input.name.trim()
  if(!/^[a-z0-9_][a-z0-9_.-]{0,31}$/i.test(name))throw new Error('器件型号应为 1–32 位字母、数字、点、下划线或短横线')
  let url:URL|undefined
  if(input.datasheetUrl?.trim()){
    try{url=new URL(input.datasheetUrl)}catch{throw new Error('请填写数据手册的完整 HTTP / HTTPS 来源网址')}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('数据手册来源须为 HTTP / HTTPS 网址')
  }else if(input.parameterSource!=='user'&&(!input.datasheetFile||input.datasheetFile.length>180||/[\x00-\x1f]/.test(input.datasheetFile)))throw new Error('请填写数据手册的完整 HTTP / HTTPS 来源网址')
  if(!input.template||!isManufacturerReference(input.template))throw new Error('需要可追溯厂商来源的现有模型作为模板；请先让模型助手查找同类、同极性的厂商模板。通用教学模型或仅填写厂家名称不能用于建模。')
  const parsedTemplate=parseSpiceLibrary(input.template.spice,input.template.source)
  const canonical=parsedTemplate.models.length===1&&!parsedTemplate.diagnostics.some(item=>item.severity==='error')?parsedTemplate.models[0]:undefined
  if(!canonical)throw new Error('模板模型不兼容，请重新选择')
  if(canonical.type!==input.template.type||canonical.kind!==input.template.kind||canonical.technology!==input.template.technology)throw new Error('模板的器件类型或技术与源码不一致，请重新导入原始厂商模型')
  if(canonical.type==='SUBCKT')throw new Error('子电路不能套用单管 .model 参数模板；请让模型助手查找可修改的同类厂商子电路模板与参数映射')
  if(!isCompatibleManufacturerTemplate(input.template,canonical.type))throw new Error('需要同类、同极性的厂商模型模板')
  const fields=approximateFields[canonical.type],seen=new Set<string>()
  if(!input.parameters.length)throw new Error('至少填写一项有手册依据的参数')
  let spice=canonical.spice.replace(/^\.model\s+\S+/,`.model ${name}_APPROX`)
  const evidence:string[]=[]
  for(const parameter of input.parameters){
    const key=parameter.key.toUpperCase(),value=parameter.value.trim(),note=parameter.evidence.trim()
    if(!fields.some(field=>field.key===key)||seen.has(key))throw new Error(`不支持或重复的辅助参数 ${key}`)
    seen.add(key)
    const match=value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf]?)$/i)
    if(!match||!Number.isFinite(Number(match[1])))throw new Error(`${key} 需要 SPICE 数值，例如 100、2.5、4p`)
    const number=Number(match[1])
    if(key==='TNOM'?number<=-273.15:key==='VTO'?(['PMOS','NJF','PJF'].includes(canonical.type)?number>=0:number<=0):number<=0)throw new Error(`${key} 数值或极性不正确`)
    if(note.length<4||note.length>2048||/[\r\n\x00-\x1f]/.test(note))throw new Error(`${key} 请填写 4–2048 字的手册页码、测试条件或依据`)
    // VTH0 and CJ0 are aliases; replace rather than introduce two definitions.
    const aliases=key==='VTO'?['VTO','VTH0']:key==='CJO'?['CJO','CJ0']:[key]
    for(const alias of aliases)spice=spice.replace(new RegExp(`\\b${alias}=[^\\s)]+\\s*`,'i'),'')
    spice=spice.replace(/\)$/,` ${key}=${value})`)
    evidence.push(`${key}=${value}: ${note}`)
  }
  const source:SpiceModelSource={label:`厂商模板改参近似 · ${name} · 未经实测验证`,...(url?{url:url.href}:{}),license:`基于 ${canonical.id}；沿用原模板条款：${canonical.source.license??'原来源未注明许可，使用前核查'}`.slice(0,500),attribution:`${input.parameterSource==='user'?'参数由用户明确提供，未独立验证。':''}${input.datasheetFile?`本地规格书 ${input.datasheetFile}。`:''}模板 ${canonical.id}，来源 ${canonical.source.url??canonical.source.label}。参数依据：${evidence.join('；')}。其余参数沿用模板，未对完整曲线拟合。`.slice(0,1000)}
  const result=parseSpiceLibrary(spice,source)
  if(result.models.length!==1||result.diagnostics.some(item=>item.severity==='error'))throw new Error(result.diagnostics.map(item=>item.message).join('；')||'模型验证失败')
  const model={...result.models[0],metadata:{...input.template.metadata},...(input.template.symbol?{symbol:{...input.template.symbol,title:name}}:{})}
  const comparison=modelParameterAdjustments(canonical,model,input.parameters.map(item=>({key:item.key,source:item.evidence})))
  model.source.attribution=`参考模板 ${canonical.id} → 调整 ${comparison.adjustments.length} 项参数 → 待验证；沿用 ${comparison.inheritedCount} 项显式参数。${model.source.attribution}`.slice(0,1000)
  return {...model,assessment:assessModeling({model,reference:input.template,origin:'derived',part:name,adjustments:comparison.adjustments,reason:'此入口记录明确参数修改；完整目标规格书、曲线和实际电路条件仍需核对。'})}
}
