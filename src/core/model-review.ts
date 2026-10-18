import { modelCategory, modelCategoryLabel } from './model-taxonomy'
import { modelCodeParameters, type ModelParameterRow } from './model-parameters'
import type { ImportedSpiceModel } from './spice-models'

export interface ModelReviewPinMapping { index:number; packagePin:string; evidence:string }
export interface ModelReviewFact { label:string; value:string; unit?:string; evidence?:string; note?:string }
export interface ModelReviewParameter extends ModelParameterRow { group:string; displayValue:string; displayUnit:string }
export interface ModelReviewImplementation { id:string; label:string; value:string; unit:string; note:string }

const numberPattern = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf]?)$/i
const scales:Record<string,number> = {'':1,t:1e12,g:1e9,meg:1e6,k:1e3,m:1e-3,u:1e-6,n:1e-9,p:1e-12,f:1e-15}

/** Interpret SPICE suffixes; never turn an expression or unknown unit into a physical measurement. */
export function reviewDisplayValue(raw:string, unit:string):{displayValue:string;displayUnit:string} {
  const parsed=raw.match(numberPattern)
  if(!parsed)return {displayValue:raw,displayUnit:unit}
  const value=Number(parsed[1])*scales[parsed[2].toLowerCase()]
  if(!Number.isFinite(value))return {displayValue:raw,displayUnit:unit}
  if(!unit||unit==='°C'||unit==='1/V')return {displayValue:Number(value.toPrecision(6)).toString(),displayUnit:unit}
  const prefixes:[number,string][]=[[1e12,'T'],[1e9,'G'],[1e6,'M'],[1e3,'k'],[1,''],[1e-3,'m'],[1e-6,'µ'],[1e-9,'n'],[1e-12,'p'],[1e-15,'f']]
  const scale=value===0?prefixes[4]:prefixes.find(([factor])=>Math.abs(value)>=factor)
  if(!scale)return {displayValue:value.toExponential(3),displayUnit:unit}
  return {displayValue:Number((value/scale[0]).toPrecision(6)).toString(),displayUnit:`${scale[1]}${unit}`}
}

function groupFor(key:string):string {
  if(/^(?:C|T[TRF]$)/.test(key))return '电容与动态响应'
  if(/^(?:R[A-Z]*|VAF|VAR|LAMBDA)$/.test(key))return '电阻与输出特性'
  if(/^(?:TNOM|LEVEL|TOX|EG|XTI|KF|AF)$/.test(key))return '模型设置与温度'
  return '直流与导通特性'
}

export function reviewModelParameters(model:ImportedSpiceModel):ModelReviewParameter[] {
  // A .model inside a SUBCKT belongs to an internal element, not to the whole IC.
  if(model.kind==='X')return []
  const summary=modelCodeParameters(model.spice,model.source.label)
  const known=new Map(summary.rows.map(row=>[row.key,row]))
  const line=model.spice.replace(/\n\s*\+/g,' ').split(/\r?\n/).find(value=>/^\s*\.model\b/i.test(value))??''
  const rows:ModelParameterRow[]=[]
  for(const match of line.replace(/[;$].*$/,'').matchAll(/\b([a-z][a-z0-9_]*)\s*=\s*([^\s(),]+)/gi)){
    const key=match[1].toUpperCase(),value=match[2]
    if(!numberPattern.test(value))continue
    rows.push(known.get(key)??{key,label:'方程参数',value,unit:'',note:'此参数的含义与单位尚未在审阅面板中定义，请查对应 SPICE 模型文档。',source:model.source.label})
  }
  return rows.map(row=>({...row,group:known.has(row.key)?groupFor(row.key):'其他显式参数',...reviewDisplayValue(row.value,row.unit)}))
}

export function reviewDeviceLabel(model:ImportedSpiceModel):string {
  if(model.kind==='X'&&modelCategory(model)!=='subcircuit:other')return modelCategoryLabel(model)
  if(model.technology==='VDMOS')return `${model.type==='PMOS'?'P':'N'} 沟道功率 MOS · VDMOS`
  return {D:'二极管',NPN:'NPN 三极管',PNP:'PNP 三极管',NMOS:'N 沟道 MOS',PMOS:'P 沟道 MOS',NJF:'N 沟道 JFET',PJF:'P 沟道 JFET',SUBCKT:'多端口子电路'}[model.type]
}

/** The assistant highlights a few explicit, understood coefficients. Ratings
 * from catalogue metadata and constants inside a SUBCKT never enter this list. */
export function reviewPrimaryParameters(model:ImportedSpiceModel,changedKeys:Iterable<string>=[],limit=4):ModelReviewParameter[] {
  const keys=new Set([...changedKeys].map(key=>key.toUpperCase()))
  const priority=model.kind==='D'?['BV','CJO','CJ0','RS','IS','TT','N']
    :model.kind==='Q'?['BF','VAF','CJE','CJC','TF','IS']
      :model.kind==='M'?['VTO','VTH0','KP','RD','CGS','CGDMAX','CGSO']
        :['VTO','BETA','LAMBDA','CGS','CGD','RD']
  const rank=(key:string)=>keys.has(key)?-1:priority.includes(key)?priority.indexOf(key):priority.length
  return reviewModelParameters(model).filter(row=>row.group!=='其他显式参数').sort((a,b)=>rank(a.key)-rank(b.key)).slice(0,Math.max(0,Math.min(8,limit)))
}

/** Expose internal implementation separately. No reverse engineering of behavioral constants as ratings. */
export function reviewSubcircuitImplementation(model:ImportedSpiceModel):ModelReviewImplementation[] {
  if(model.kind!=='X')return []
  const rows:ModelReviewImplementation[]=[]
  for(const line of model.spice.replace(/\n\s*\+/g,' ').split(/\r?\n/).map(value=>value.replace(/[;$].*$/,'').trim())){
    if(!line||line.startsWith('*'))continue
    if(/^\.param\b/i.test(line)){
      for(const match of line.matchAll(/\b([a-z_][\w]*)\s*=\s*([^\s]+)/gi)){
        rows.push({id:match[1],label:'内部常数',value:match[2],unit:'',note:'来自 .param 定义；含义、单位及适用条件需结合内部电路确认。'})
      }
      continue
    }
    const parts=line.split(/\s+/),kind=parts[0]?.[0]?.toUpperCase()
    if(['R','C','L','V','I'].includes(kind)&&parts.length>=4){
      const labels:Record<string,[string,string]>={R:['内部电阻','Ω'],C:['内部电容','F'],L:['内部电感','H'],V:['内部电压源','V'],I:['内部电流源','A']}
      const raw=/^DC$/i.test(parts[3])?parts[4]:parts[3]
      if(raw&&numberPattern.test(raw))rows.push({id:parts[0],label:labels[kind][0],value:raw,unit:labels[kind][1],note:`连接 ${parts[1]} → ${parts[2]}；内部元件值，不代表整体器件的额定参数。`})
    }
    if(kind==='B')rows.push({id:parts[0],label:'行为源表达式',value:parts.slice(3).join(' '),unit:'',note:`连接 ${parts[1]} → ${parts[2]}；表达式定义仿真行为，系数不自动视为规格书实测指标。`})
  }
  return rows
}

export function reviewedPinMapping(model:ImportedSpiceModel,mapping:ModelReviewPinMapping[]=[]):ModelReviewPinMapping[] {
  return mapping.filter(item=>Number.isInteger(item.index)&&item.index>=0&&item.index<model.pins.length&&item.packagePin.trim()&&item.evidence.trim()&&mapping.filter(other=>other.index===item.index).length===1)
}
