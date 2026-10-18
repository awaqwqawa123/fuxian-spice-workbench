import type { ImportedModelType, ImportedSpiceModel, SpiceModelSource } from './spice-models'
import { isBundledModelSource } from './bundled-models'
import { isOwnedPspiceSource } from './installed-model-source'
import { equivalentModelParameterValues } from './model-parameter-values'

export interface ModelReferenceInfo { kind:'official-source'|'local-vendor-catalog'|'registered-vendor-library'; label:string; detail:string }
export interface ModelReferenceAdjustment { key:string; before:string; after:string; source:string; explanation:string }
export interface ModelReferenceComparison { adjustments:ModelReferenceAdjustment[]; inheritedCount:number }
export interface ModelReferenceIdentity { id:string; source:SpiceModelSource }

const manufacturerDomains=['ti.com','analog.com','onsemi.com','st.com','infineon.com','nexperia.com','vishay.com','diodes.com','rohm.com','toshiba.com','toshiba.semicon-storage.com','microchip.com','renesas.com','nxp.com','littelfuse.com','lrc.cn']
const isDerived=(model:ImportedSpiceModel)=>/APPROX|^TEMPLATE_/i.test(model.id)||/近似|APPROX|教学|拟合|用户修改|用户编辑|generic|teaching|derived/i.test(model.source.label)

// Vendor-owned repositories verified against their manufacturer/team README.
// Keep revisions immutable: the URL describes provenance, not model accuracy.
const officialGithubLibraries=[
  {repository:'WurthElektronik/LTspice-Library',revision:'4e1fb4ce5fc31d500206e100647a82abf36a0d71',root:'sub'},
  {repository:'WurthElektronik/Pspice-Library',revision:'5168590e698b5c90aa3f0bab458198f2c30168d9',root:'library'},
] as const

function officialGithubReference(source:SpiceModelSource,url:URL):ModelReferenceInfo|undefined {
  // Reject normalization tricks, encoded separators and non-source URL suffixes.
  if(url.href!==source.url||/[?#]/.test(source.url??'')||url.hostname!=='raw.githubusercontent.com'||url.port||url.search||url.hash)return undefined
  for(const library of officialGithubLibraries){
    const prefix=`/${library.repository}/${library.revision}/${library.root}/`
    if(!url.pathname.startsWith(prefix))continue
    const file=url.pathname.slice(prefix.length)
    if(!/\.lib$/i.test(file)||!file.split('/').every(part=>/^[a-z0-9_][a-z0-9_.-]*$/i.test(part)))continue
    if(/(?:^|[\/_.-])examples?(?:[\/_.-]|$)/i.test(file))continue
    return {kind:'official-source',label:'厂商官方 GitHub 来源 · Würth Elektronik',detail:`来源为已核对厂商归属的 ${library.repository} 固定版本模型文件；保留原条款。来源不证明改参后的目标器件精度，仍需核对拓扑和仿真验证。`}
  }
  return undefined
}

/** Provenance eligibility, not a claim of vendor authentication or measurement accuracy. */
export function manufacturerReferenceInfo(model:ImportedSpiceModel):ModelReferenceInfo|undefined {
  if(isDerived(model))return undefined
  let url:URL
  try{url=new URL(model.source.url??'')}catch{return undefined}
  if(url.protocol!=='https:'||url.username||url.password)return undefined
  const host=url.hostname.toLowerCase()
  const manufacturer=model.metadata.mfg?.trim()
  const namedManufacturer=manufacturer&&!/generic|teaching|unknown|教学|近似|^none$|^n\/?a$/i.test(manufacturer)
  const officialGithub=officialGithubReference(model.source,url)
  if(officialGithub)return officialGithub
  if(isOwnedPspiceSource(model.source))return {kind:'local-vendor-catalog',label:`PSpice 本地原始模型目录${namedManufacturer?` · ${manufacturer}`:' · 原文件未注厂家'}`,detail:'来源可追溯到软件保存的 PSpice 原始库，保留原件、版权与兼容性检查；目录归属不等于单个模型的厂家认证。只能作为同类型、同极性且有参数依据的参考，修改后需验证。'}
  if(isBundledModelSource(model.source)&&namedManufacturer)return {kind:'registered-vendor-library',label:`已登记厂商参考库 · ${manufacturer}`,detail:'参考来源为已登记、固定版本的第三方模型库，保留厂家字段及条款；并非厂商官网原件或独立实测验证。'}
  if(/^本机 LTspice\s*\//.test(model.source.label)){
    const file=model.source.label.match(/^本机 LTspice\s*\/\s*(standard\.(?:dio|bjt|mos|jft))$/i)?.[1]?.toLowerCase()
    const expected={D:'standard.dio',Q:'standard.bjt',M:'standard.mos',J:'standard.jft',X:''}[model.kind]
    if(!file||file!==expected||!namedManufacturer||!(host==='analog.com'||host.endsWith('.analog.com'))||!url.pathname.includes('ltspice'))return undefined
    return {kind:'local-vendor-catalog',label:`本机 LTspice 厂商目录 · ${manufacturer}`,detail:'来源可追溯到本机 LTspice 目录及其厂家字段；目录信息不等于厂商签名认证或目标器件验证。'}
  }
  if(!manufacturerDomains.some(domain=>host===domain||host.endsWith(`.${domain}`)))return undefined
  // A product/datasheet page is not evidence of an existing SPICE definition.
  if(/\.pdf$/i.test(url.pathname))return undefined
  return {kind:'official-source',label:`厂商站点来源 · ${host}`,detail:'保留原模型来源与条款；原始来源不证明改参后的目标器件精度，仍需验证。'}
}

export function isManufacturerReference(model:ImportedSpiceModel):boolean { return Boolean(manufacturerReferenceInfo(model)) }
export function isCompatibleManufacturerTemplate(model:ImportedSpiceModel,type:ImportedModelType):boolean {
  return type!=='SUBCKT'&&model.type===type&&model.kind!=='X'&&isManufacturerReference(model)
}

function explicitParameters(model:ImportedSpiceModel):Map<string,string> {
  const result=new Map<string,string>()
  if(model.kind==='X')return result
  const code=model.spice.replace(/\n\s*\+/g,' ').split(/\r?\n/).find(line=>/^\s*\.model\s/i.test(line))??''
  for(const item of code.matchAll(/\b([a-z][a-z0-9_]*)\s*=\s*([^\s(),]+)/gi)){
    const key=item[1].toUpperCase(),canonical=key==='VTH0'?'VTO':key==='CJ0'?'CJO':key
    if(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i.test(item[2]))result.set(canonical,item[2])
  }
  return result
}

/** Compare explicit source values without inventing simulator defaults. */
export function modelParameterAdjustments(reference:ImportedSpiceModel,derived:ImportedSpiceModel,notes:{key:string;source:string;explanation?:string}[]=[]):ModelReferenceComparison {
  const before=explicitParameters(reference),after=explicitParameters(derived),adjustments:ModelReferenceAdjustment[]=[]
  let inheritedCount=0
  for(const [key,value] of after){
    const old=before.get(key),note=notes.find(item=>item.key.toUpperCase()===key)
    if(old!==undefined&&equivalentModelParameterValues(old,value)){inheritedCount++;continue}
    adjustments.push({key,before:old??'未显式定义',after:value,source:note?.source??'参数修改依据待核对',explanation:note?.explanation??'仅修改这一显式参数，其适用条件及对整体模型的影响仍需验证。'})
  }
  for(const [key,value] of before)if(!after.has(key))adjustments.push({key,before:value,after:'已移除',source:'模型差异',explanation:'原模板参数已移除，需核对是否改变仿真行为。'})
  return {adjustments,inheritedCount}
}
