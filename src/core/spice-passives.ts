import { spiceParameterNumber } from './model-parameter-values'
import { parseSpiceParameterAssignments, parseSubcircuitHeader } from './spice-parameters'

const scalar='[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?(?:meg|[tgkmunpf])?'
const coefficient=`(?:\\(\\s*${scalar}\\s*\\)|${scalar}|\\{[^{}]+\\})(?=\\s|,|$)`
const tcExpression=new RegExp(`\\b(TC|TC1)\\s*=\\s*(${coefficient})(?:\\s*,\\s*(${coefficient})|\\s+(${coefficient}))?`,'gi')
const unwrap=(raw:string)=>raw.startsWith('(')?raw.slice(1,-1).trim():raw

/** PSpice uses TC=a,b (or TC=a b), whereas this ngspice engine accepts
 * independent TC1/TC2 assignments. Neither coefficient is discarded. */
function temperatureCoefficients(text:string):string {
  if(!/^[RCL]/i.test(text)||! /\bTC(?:[12])?\s*=/i.test(text))return text
  let seen=false
  const rewritten=text.replace(tcExpression,(full,key:string,first:string,commaSecond?:string,spaceSecond?:string)=>{
    const second=commaSecond??spaceSecond
    // A single native TC1 assignment already has the desired meaning.
    if(key.toUpperCase()==='TC1'&&!second)return full
    if(seen||/\bTC2\s*=/i.test(text)||key.toUpperCase()==='TC'&&/\bTC1\s*=/i.test(text))throw new Error('无源元件温度系数重复或冲突；未删减原参数')
    seen=true
    return `TC1=${unwrap(first)}${second?` TC2=${unwrap(second)}`:''}`
  })
  if(/\bTC\s*=/i.test(rewritten))throw new Error('无源元件 TC 须为一或两个明确的温度系数；未猜测原参数')
  // Matching the first coefficient alone is insufficient: e.g. an original
  // `TC=0 0"` would otherwise become `TC1=0 0"`. Validate the whole remaining
  // assignment tail so unmatched quotes, extra scalars and duplicate keys
  // cannot be presented as a successfully converted vendor model.
  const first=rewritten.search(/\bTC[12]\s*=/i)
  if(first!==-1)try{parseSpiceParameterAssignments(rewritten.slice(first))}catch(error){
    throw new Error(`无源元件温度系数或其后参数不完整：${(error as Error).message}；原件未修剪或猜测`)
  }
  return rewritten
}

/** Lower LTspice's documented inductor equivalent circuit into native parts.
 * Rser is in series with L; Rpar and Cpar span the original two terminals.
 * The original L name/direction stay intact for K and I(L) references.
 * https://ltwiki.org/LTspiceHelp/LTspiceHelp/L_Inductor.htm
 */
export function normalizePassiveComponents(input:readonly string[]):string[] {
  const header=input.find(line=>/^\.subckt\b/i.test(line))
  const overridable=new Set(header?parseSubcircuitHeader(header).parameters.map(p=>p.name.toLowerCase()):[])
  const fixed=new Map<string,string>()
  for(const line of input)if(/^\.param\b/i.test(line))for(const parameter of parseSpiceParameterAssignments(line.replace(/^\.param\s*/i,''))){
    if(!overridable.has(parameter.name.toLowerCase())&&spiceParameterNumber(parameter.value)!==undefined)fixed.set(parameter.name.toLowerCase(),parameter.value)
  }
  function number(value:string):number|undefined {
    const direct=spiceParameterNumber(value)
    if(direct!==undefined)return direct
    const name=value.match(/^\{\s*([a-z_][a-z0-9_]*)\s*\}$/i)?.[1].toLowerCase()
    return name?spiceParameterNumber(fixed.get(name)??''):undefined
  }
  const reserved=new Set(input.flatMap(line=>line.match(/[a-z_][a-z0-9_.+-]*/gi)??[]).map(name=>name.toLowerCase()))
  let counter=0
  function fresh(prefix:string):string {let id:string;do{id=`${prefix}${++counter}`}while(reserved.has(id.toLowerCase()));reserved.add(id.toLowerCase());return id}
  return input.flatMap(original=>{
    const text=temperatureCoefficients(original)
    if(!/^L/i.test(text)||!/\b(?:Rser|Rpar|Cpar)\s*=/i.test(text))return [text]
    const match=text.match(/^(L\S*)\s+(\S+)\s+(\S+)\s+(\{[^{}]+\}|[^\s]+)\s+(.*)$/i)
    if(!match)throw new Error('含寄生参数的电感须有明确的两端节点和电感值')
    const [,id,a,b,inductance,tail]=match
    const parameters=parseSpiceParameterAssignments(tail)
    const parasitics=new Map(parameters.filter(p=>/^(?:rser|rpar|cpar)$/i.test(p.name)).map(p=>[p.name.toLowerCase(),p.value]))
    const native=parameters.filter(p=>!/^(?:rser|rpar|cpar)$/i.test(p.name))
    if(native.some(p=>! /^(?:IC|M|TEMP|DTEMP|TC1|TC2)$/i.test(p.name)))throw new Error('电感寄生展开含不支持的实例参数；原语义未删减')
    const multiplicity=native.find(p=>/^m$/i.test(p.name))?.value
    const temperature=native.filter(p=>/^(?:TEMP|DTEMP)$/i.test(p.name)).map(p=>` ${p.name}=${p.value}`).join('')
    const expression=(value:string)=>value.startsWith('{')?value.slice(1,-1):value
    const scaled=(value:string,divide:boolean)=>multiplicity?`{(${expression(value)})${divide?'/':'*'}(${expression(multiplicity)})}`:value
    const series=parasitics.get('rser'),parallel=parasitics.get('rpar'),capacitance=parasitics.get('cpar')
    for(const [key,value] of parasitics){
      const n=number(value)
      if(n!==undefined&&n<0)throw new Error(`电感 ${key} 为负值，不能视作无源寄生参数；未修改原数值`)
      if((key==='rpar'||key==='rser')&&n===undefined)throw new Error(`参数化 ${key} 的零值会关闭寄生支路；无法确认可覆盖参数的关闭条件，未擅自改为短路或大电阻`)
    }
    const internal=series!==undefined&&number(series)!==0?fresh('__fx_pass_node_'):b
    const lines=[`${id} ${a} ${internal} ${inductance}${native.length?` ${native.map(p=>`${p.name}=${p.value}`).join(' ')}`:''}`]
    // Explicit zero parasitics disable these branches in LTspice. Internal
    // .param scalar defaults can be proven fixed; header defaults can change.
    if(series!==undefined&&number(series)!==0)lines.push(`${fresh('R__fx_pass_ser_')} ${internal} ${b} ${scaled(series,true)}${temperature}`)
    if(parallel!==undefined&&number(parallel)!==0)lines.push(`${fresh('R__fx_pass_par_')} ${a} ${b} ${scaled(parallel,true)}${temperature}`)
    if(capacitance!==undefined&&number(capacitance)!==0)lines.push(`${fresh('C__fx_pass_par_')} ${a} ${b} ${scaled(capacitance,false)}${temperature}`)
    return lines
  })
}

/** The export path also receives legacy saved definitions. Scope generated
 * nodes and fixed .param declarations to each original subcircuit. */
export function normalizePassiveModelForNgspice(spice:string):string {
  const result:string[]=[];let block:string[]=[]
  for(const line of spice.split('\n')){
    if(/^\.subckt\b/i.test(line)){if(block.length)throw new Error('无源元件兼容转换不接受嵌套子电路');block=[line];continue}
    if(block.length){block.push(line);if(/^\.ends\b/i.test(line)){result.push(...normalizePassiveComponents(block));block=[]}}
    else result.push(line)
  }
  if(block.length)throw new Error('无源元件兼容转换遇到缺少 .ends 的子电路')
  return result.join('\n')
}
