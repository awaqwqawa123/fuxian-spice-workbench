/** Bounded syntax shared by file imports and vendor dependency collection.
 * This parses data only: expressions are never evaluated as JavaScript. */
import { normalizePspiceExpression, requiresPspiceExpressionLowering } from './pspice-behavior'
import { spiceModelName as modelName } from './spice-model-name'
export interface SpiceParameterAssignment { name:string; value:string; references:string[] }
const identifier=/^[a-z_][a-z0-9_]*$/i
export const spiceNodeName=/^(?=.{1,80}$)[+-]?[a-z0-9_][a-z0-9_.+-]*$/i
const constant=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i
const intrinsicNames=new Set(['pi','e','temp','temper'])
const functionArity:Record<string,readonly [number,number]>={
  abs:[1,1],sqrt:[1,1],exp:[1,1],ln:[1,1],log:[1,1],log10:[1,1],
  sin:[1,1],cos:[1,1],tan:[1,1],asin:[1,1],acos:[1,1],atan:[1,1],atan2:[2,2],
  sinh:[1,1],cosh:[1,1],tanh:[1,1],floor:[1,1],ceil:[1,1],int:[1,1],sgn:[1,1],
  pow:[2,2],pwr:[2,2],pwrs:[2,2],min:[2,2],max:[2,2],limit:[3,3],if:[3,3],
}
export function stripSpiceInlineComment(text:string):string {
  let quote=''
  for(let i=0;i<text.length;i++){
    const char=text[i]
    if((char==='"'||char==="'")&&(!quote||char===quote)){quote=quote?'':char;continue}
    if(!quote&&(char===';'||char==='$'))return text.slice(0,i).trim()
  }
  return text.trim()
}
/** Validate a numeric parameter expression, with an optional declared scope.
 * Circuit probes, file/string functions and arbitrary calls are excluded. */
export function validateSpiceParameterExpression(raw:string,scope?:ReadonlySet<string>):string[] {
  if(!raw.trim()||raw.length>4096||/[\r\n\x00-\x1f{}'";$\\]/.test(raw))throw new Error('SPICE 参数表达式为空、过长或含有不支持的字符')
  const tokens:string[]=[]
  let rest=raw.trim()
  while(rest){
    const match=rest.match(/^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?|[a-z_][a-z0-9_]*|\*\*|<=|>=|==|!=|<>|&&|\|\||[()+*/^,?:!<>=&|%-])/i)
    if(!match)throw new Error(`无法识别 SPICE 参数表达式：${rest.slice(0,60)}`)
    tokens.push(match[0]);rest=rest.slice(match[0].length).trimStart()
    if(tokens.length>512)throw new Error('SPICE 参数表达式过于复杂')
  }
  let cursor=0,depth=0
  const references=new Set<string>()
  function take(value:string):boolean {if(tokens[cursor]===value){cursor++;return true}return false}
  function require(value:string):void {if(!take(value))throw new Error(`SPICE 参数表达式缺少 ${value}`)}
  function expression():void {
    if(++depth>64)throw new Error('SPICE 参数表达式嵌套过深')
    binary(0)
    if(take('?')){expression();require(':');expression()}
    depth--
  }
  const precedence=[['|','||'],['&','&&'],['=','==','!=','<>','<','>','<=','>='],['+','-'],['*','/','%'],['^','**']]
  function binary(level:number):void {
    if(level===precedence.length){primary();return}
    binary(level+1)
    while(precedence[level].includes(tokens[cursor])){cursor++;binary(level+1)}
  }
  function primary():void {
    if(take('+')||take('-')||take('!')){if(++depth>64)throw new Error('SPICE 参数表达式嵌套过深');primary();depth--;return}
    if(take('(')){expression();require(')');return}
    const token=tokens[cursor++]
    if(!token)throw new Error('SPICE 参数表达式不完整')
    if(constant.test(token)){
      const match=token.match(/^((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf]?)$/i)!
      const scales:Record<string,number>={'':1,t:1e12,g:1e9,meg:1e6,k:1e3,m:1e-3,u:1e-6,n:1e-9,p:1e-12,f:1e-15}
      if(!Number.isFinite(Number(match[1])*scales[match[2].toLowerCase()]))throw new Error('SPICE 参数表达式超出数值范围')
      return
    }
    if(!identifier.test(token))throw new Error(`SPICE 参数表达式中出现无效项 ${token}`)
    const name=token.toLowerCase()
    if(take('(')){
      const arity=functionArity[name]
      if(!arity)throw new Error(`暂不支持 SPICE 参数函数 ${token}`)
      let count=0
      if(!take(')')){do{expression();count++}while(take(','));require(')')}
      if(count<arity[0]||count>arity[1])throw new Error(`SPICE 参数函数 ${token} 的参数数量不正确`)
    }else if(!intrinsicNames.has(name)){
      if(scope&&!scope.has(name))throw new Error(`SPICE 参数表达式引用未声明参数 ${token}`)
      references.add(name)
    }
  }
  expression()
  if(cursor!==tokens.length)throw new Error(`SPICE 参数表达式中存在多余内容 ${tokens[cursor]}`)
  return [...references]
}
/** Parameter assignments can use braces, quoted expressions or balanced bare
 * expressions. Output braces make evaluation and whitespace unambiguous. */
export function parseSpiceParameterAssignments(raw:string,scope?:ReadonlySet<string>):SpiceParameterAssignment[] {
  const result:SpiceParameterAssignment[]=[],seen=new Set<string>()
  let rest=raw.trim()
  while(rest){
    rest=rest.replace(/^[\s,]+/,'')
    if(!rest)break
    const match=rest.match(/^([a-z_][a-z0-9_]*)\s*=\s*/i)
    if(!match)throw new Error(`无法识别 SPICE 参数赋值：${rest.slice(0,70)}`)
    const name=match[1],key=name.toLowerCase()
    if(seen.has(key))throw new Error(`SPICE 参数 ${name} 重复`)
    seen.add(key);rest=rest.slice(match[0].length)
    let end=0,expression='',quote='',braces=0,parentheses=0
    for(;end<rest.length;end++){
      const char=rest[end]
      if((char==='"'||char==="'")&&(!quote||char===quote)){quote=quote?'':char;continue}
      if(quote)continue
      if(char==='{')braces++
      if(char==='}')braces--
      if(char==='(')parentheses++
      if(char===')')parentheses--
      if(braces<0||parentheses<0)throw new Error(`SPICE 参数 ${name} 括号不匹配`)
      if(!braces&&!parentheses&&(char===','||/\s/.test(char)&&/^\s+[a-z_][a-z0-9_]*\s*=/i.test(rest.slice(end))))break
    }
    if(quote||braces||parentheses)throw new Error(`SPICE 参数 ${name} 括号或引号不匹配`)
    expression=rest.slice(0,end).trim();rest=rest.slice(end)
    if(expression.startsWith('{')&&expression.endsWith('}')||expression.startsWith("'")&&expression.endsWith("'")||expression.startsWith('"')&&expression.endsWith('"'))expression=expression.slice(1,-1).trim()
    const references=validateSpiceParameterExpression(expression,scope)
    result.push({name,value:constant.test(expression)?expression.toLowerCase():`{${normalizePspiceExpression(expression)}}`,references})
    if(result.length>128)throw new Error('SPICE 参数数量超过 128 个')
  }
  return result
}
function splitParameterTail(text:string):{prefix:string;parameters:SpiceParameterAssignment[]} {
  const clean=stripSpiceInlineComment(text)
  if(/[\r\n\x00-\x1f]/.test(clean))throw new Error('SPICE 声明包含无效控制字符')
  const marker=/(?:^|\s)(?:params?|parameters)\s*:\s*/i.exec(clean)
  const assignment=/(?:^|\s)([a-z_][a-z0-9_]*)\s*=/i.exec(clean)
  if(marker&&(!assignment||marker.index<=assignment.index)){
    const parameters=parseSpiceParameterAssignments(clean.slice(marker.index+marker[0].length))
    if(!parameters.length)throw new Error('PARAMS: 缺少参数赋值')
    return {prefix:clean.slice(0,marker.index).trim(),parameters}
  }
  if(assignment)return {prefix:clean.slice(0,assignment.index).trim(),parameters:parseSpiceParameterAssignments(clean.slice(assignment.index).trim())}
  return {prefix:clean,parameters:[]}
}
export function parseSubcircuitHeader(text:string):{id:string;pins:string[];parameters:SpiceParameterAssignment[]} {
  const {prefix,parameters}=splitParameterTail(text),parts=prefix.split(/\s+/)
  if(parts[0].toLowerCase()!=='.subckt'||!modelName.test(parts[1]??''))throw new Error('无效 .subckt 名称')
  const pins=parts.slice(2)
  if(pins.length<2||pins.length>32||pins.some(pin=>pin.length>40||!spiceNodeName.test(pin)))throw new Error('子电路须有 2～32 个有效端口，端口名称最多 40 字符')
  if(new Set(pins.map(pin=>pin.toLowerCase())).size!==pins.length)throw new Error('子电路端口名称重复')
  return {id:parts[1],pins,parameters}
}
export function parseSubcircuitInstance(text:string):{id:string;pins:string[];target:string;parameters:SpiceParameterAssignment[]} {
  const {prefix,parameters}=splitParameterTail(text),parts=prefix.split(/\s+/),target=parts.at(-1)??''
  if(!/^X[a-z0-9_.+-]*$/i.test(parts[0])||!modelName.test(target)||parts.length<4||parts.length>34||parts.slice(1,-1).some(pin=>!spiceNodeName.test(pin)))throw new Error('X 实例的名称、节点或子电路名称无效')
  return {id:parts[0],pins:parts.slice(1,-1),target,parameters}
}
export function spiceParameterTail(parameters:readonly SpiceParameterAssignment[]):string {
  return parameters.length?` PARAMS: ${parameters.map(parameter=>`${parameter.name}=${parameter.value}`).join(' ')}`:''
}
/** Expressions on passive values and linear gains share parameter scoping.
 * Behavioral E/G/B sources are validated by their circuit-probe parser. */
export function normalizeSpiceElementParameters(text:string,scope:ReadonlySet<string>):string {
  if(/^[BEG]/i.test(text)&&(/^B/i.test(text)||/\b(?:VALUE|TABLE)\b/i.test(text)))return text
  let result='',cursor=0
  while(cursor<text.length){
    const opening=text.indexOf('{',cursor),stray=text.indexOf('}',cursor)
    if(stray!==-1&&(opening===-1||stray<opening))throw new Error('元件参数表达式括号不匹配')
    if(opening===-1){result+=text.slice(cursor);break}
    const closing=text.indexOf('}',opening+1)
    if(closing===-1||text.indexOf('{',opening+1)!==-1&&text.indexOf('{',opening+1)<closing)throw new Error('元件参数表达式括号不匹配')
    const expression=text.slice(opening+1,closing)
    validateSpiceParameterExpression(expression,scope)
    result+=`${text.slice(cursor,opening)}{${requiresPspiceExpressionLowering(expression)?normalizePspiceExpression(expression):expression}}`;cursor=closing+1
  }
  return result
}
