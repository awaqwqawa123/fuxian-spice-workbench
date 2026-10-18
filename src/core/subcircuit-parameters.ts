import {parseSourceExpression,evaluateSourceExpression} from './source-expression'
import type {Device} from './drawing'
import type {ImportedSpiceModel} from './spice-models'
import {parseSpiceParameterAssignments,parseSubcircuitHeader,spiceParameterTail,type SpiceParameterAssignment} from './spice-parameters'

/** Only public header parameters can be overridden; local .param is not an API. */
export function subcircuitParameterDefinitions(model:ImportedSpiceModel):SpiceParameterAssignment[]{
 if(model.kind!=='X')return []
 const header=model.spice.split(/\r?\n/).find(line=>new RegExp(`^\\s*\\.subckt\\s+${model.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=\\s|$)`,'i').test(line))
 if(!header)throw new Error(`子电路 ${model.id} 缺少根声明`)
 return parseSubcircuitHeader(header).parameters
}
export function parseSubcircuitOverrideValues(raw:Record<string,string>|undefined):SpiceParameterAssignment[]{
 if(raw===undefined)return []
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>128)throw new Error('子电路实例参数须为最多 128 个参数的对象')
 const seen=new Set<string>(),parameters:SpiceParameterAssignment[]=[]
 for(const [key,value]of Object.entries(raw)){
  if(['__proto__','prototype','constructor'].includes(key.toLowerCase())||!/^[a-z_][a-z0-9_]{0,63}$/i.test(key)||seen.has(key.toLowerCase()))throw new Error(`子电路实例参数 ${key} 不合法或大小写重复`)
  if(typeof value!=='string'||!value.trim()||value.length>512||/[\r\n]/.test(value))throw new Error(`子电路实例参数 ${key} 必须是非空的单行数值或常量表达式`)
  seen.add(key.toLowerCase())
  const parsed=parseSpiceParameterAssignments(`${key}=${value}`,new Set())
  if(parsed.length!==1||parsed[0].name.toLowerCase()!==key.toLowerCase())throw new Error(`子电路实例参数 ${key} 只能包含一个赋值`)
  const expression=parsed[0].value.replace(/^\{(.*)\}$/,'$1')
  if(/\b(?:time|temp|temper)\b/i.test(expression))throw new Error(`子电路实例参数 ${key} 只能使用有限常量，不能引用时间或温度上下文变量`)
  let number:number
  try{number=evaluateSourceExpression(parseSourceExpression(expression.toLowerCase().replace(/\be\b/g,String(Math.E)).replace(/\*\*/g,'^')),0)}catch(reason){throw new Error(`子电路实例参数 ${key} 无法计算为有限常量：${(reason as Error).message}`)}
  const constant=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i.test(parsed[0].value)
  parameters.push({...parsed[0],value:constant?parsed[0].value:String(number),references:[]})
 }
 return parameters
}
export function subcircuitInstanceParameterTail(part:Pick<Device,'id'|'kind'|'params'>,model:ImportedSpiceModel):string{
 const definitions=subcircuitParameterDefinitions(model),allowed=new Map(definitions.map(definition=>[definition.name.toLowerCase(),definition.name]))
 const parsed=parseSubcircuitOverrideValues(part.params).map(parameter=>{
  const name=allowed.get(parameter.name.toLowerCase())
  if(!name)throw new Error(`${part.id}：参数 ${parameter.name} 未在 .subckt ${model.id} 的公开 PARAMS 中声明；可覆盖：${definitions.map(definition=>definition.name).join('、')||'无'}`)
  return {...parameter,name}
 })
 return spiceParameterTail(parsed)
}
