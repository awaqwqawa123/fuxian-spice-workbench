/** POLY source compatibility for the bundled ngspice without XSPICE.
 * Kept at the export boundary: saved original electrical definitions and
 * branch names remain unchanged. No fitted or truncated coefficients. */
export interface PolynomialSource {
  name:string;kind:'E'|'G'|'F'|'H';positive:string;negative:string
  dimensions:number;controls:string[][];coefficients:string[];expression:string
}
const coefficient=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i
const identifier=/^[a-z0-9_.$:+\/-]+$/i
const MAX_DIMENSIONS=16,MAX_COEFFICIENTS=512,MAX_EXPRESSION=128*1024
const suffixScale:Readonly<Record<string,number>>={t:1e12,g:1e9,meg:1e6,k:1e3,m:1e-3,u:1e-6,n:1e-9,p:1e-12,f:1e-15}
function validateCoefficient(value:string){
  if(!coefficient.test(value))throw new Error(`POLY 系数必须是完整 SPICE 常数：${value}`)
  const match=value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)!
  const magnitude=Number(match[1]),scale=match[2]?suffixScale[match[2].toLowerCase()]:1
  if(!Number.isFinite(magnitude)||!Number.isFinite(magnitude*scale))throw new Error(`POLY 系数经 SPICE 后缀缩放后不是有限数：${value}`)
  // This numeric conversion is validation only. The export retains the exact
  // source coefficient string rather than formatting a rounded JS number.
}

/** SPICE's graded order: 1, x1, x2, x1*x1, x1*x2, x2*x2, ...
 * Descending first-variable powers enumerate every homogeneous degree. */
function polynomialExpression(coefficients:readonly string[],variables:readonly string[]){
  const powers:number[][]=[]
  function degree(remaining:number,position:number,prefix:number[]){
    if(powers.length>=coefficients.length)return
    if(position===variables.length-1){powers.push([...prefix,remaining]);return}
    for(let power=remaining;power>=0&&powers.length<coefficients.length;power--)degree(remaining-power,position+1,[...prefix,power])
  }
  for(let order=0;powers.length<coefficients.length;order++)degree(order,0,[])
  let length=0
  return coefficients.map((value,index)=>{
    const factors=powers[index].flatMap((power,variable)=>Array.from({length:power},()=>`(${variables[variable]})`))
    const term=`(${value})${factors.length?'*'+factors.join('*'):''}`
    length+=term.length+1;if(length>MAX_EXPRESSION)throw new Error('POLY 完整等价表达式超过 128 KB；未截断或近似系数')
    return term
  }).join('+')
}
/** Accept complete literal controls/coefficient lists, otherwise reject rather
 * than silently exporting a source that still requires XSPICE. */
export function parsePolynomialSource(line:string):PolynomialSource|undefined{
  const content=line.split(/[;$]/,1)[0].trim()
  if(!/^[EFGH]\S*\s/i.test(content)||!/(?:^|\s)POLY\b/i.test(content))return undefined
  const match=content.match(/^([EFGH]\S*)\s+(\S+)\s+(\S+)\s+POLY\s*\(\s*(\d+)\s*\)\s*,?\s*(.+)$/i)
  if(!match)throw new Error('POLY 语句不完整：需要输出节点、维数、全部控制端口与常数系数')
  const [,name,positive,negative,dimension,tail]=match,kind=name[0].toUpperCase() as PolynomialSource['kind'],dimensions=Number(dimension)
  if(dimensions<1||dimensions>MAX_DIMENSIONS)throw new Error(`POLY 维数须为 1～${MAX_DIMENSIONS}；未近似原始模型`)
  if(![name,positive,negative].every(token=>identifier.test(token)))throw new Error('POLY 名称或输出节点包含不支持的字符')
  // Parse each complete control group before coefficients. Flattening every
  // parenthesis would silently accept malformed/nested controls as other inputs.
  if(/[{}]/.test(tail))throw new Error('POLY 仅支持原始常数系数；参数表达式尚未验证')
  const tokens=tail.match(/[(),]|[^\s(),]+/g)??[],width=kind==='E'||kind==='G'?2:1,input:string[]=[];let position=0
  for(let control=0;control<dimensions;control++){
    if(control&&tokens[position]===',')position++
    const grouped=tokens[position]==='(';if(grouped)position++
    for(let port=0;port<width;port++){
      if(port&&tokens[position]===',')position++
      const node=tokens[position++];if(!node||!identifier.test(node))throw new Error('POLY 控制端口不完整或括号格式不支持')
      input.push(node)
    }
    if(grouped&&tokens[position++]!==')')throw new Error('POLY 控制端口括号必须完整包围一组控制输入')
  }
  if(tokens[position]===',')position++
  const coefficients:string[]=[]
  while(position<tokens.length){
    const value=tokens[position++];validateCoefficient(value)
    coefficients.push(value)
    if(tokens[position]===','){position++;if(position===tokens.length)throw new Error('POLY 系数列表末尾缺少常数')}
  }
  if(!coefficients.length)throw new Error('POLY 缺少完整控制端口或系数')
  if(!input.every(token=>identifier.test(token)))throw new Error('POLY 控制端口不是有效的原始节点或电压源名称')
  if(width===1&&!input.every(token=>/^V\S+$/i.test(token)))throw new Error('F/H POLY 必须由原始电压源的支路电流控制')
  if(coefficients.length>MAX_COEFFICIENTS)throw new Error(`POLY 常数系数超过 ${MAX_COEFFICIENTS} 项；没有删除高阶项`)
  const controls=Array.from({length:dimensions},(_,index)=>input.slice(index*width,(index+1)*width))
  const variables=controls.map(control=>width===2?`V(${control[0]},${control[1]})`:`I(${control[0]})`)
  return{name,kind,positive,negative,dimensions,controls,coefficients,expression:polynomialExpression(coefficients,variables)}
}
/** Static import validation invokes exactly the syntax/export checks. */
export function validatePolynomialSource(line:string):void {parsePolynomialSource(line)}

/** E/G VALUE retains the original source name and its branch references.
 * F/H retain their original controlled-source names. A local current source
 * drives a zero-volt sensing source, so its exact polynomial current controls
 * the original F/H at gain 1. This preserves I(Hname) and cross-source links. */
export function normalizePolynomialSourcesForNgspice(text:string):string{
  const original=text.split(/\r?\n/),reserved=new Set((text.match(/[a-z0-9_.$:+\/-]+/gi)??[]).map(token=>token.toLowerCase()))
  const folded:string[]=[]
  for(const line of original){
    if(/^\s*\+/.test(line)){
      let prior=folded.length-1;while(prior>=0&&(!folded[prior].trim()||/^\s*\*/.test(folded[prior])))prior--
      if(prior<0)throw new Error('POLY 导出遇到没有原始定义的续行')
      folded[prior]+=' '+line.replace(/^\s*\+\s*/,'')
    }else folded.push(line)
  }
  let serial=0
  function helper(prefix:string){let value:string;do{value=`${prefix}__swpoly_${++serial}`}while(reserved.has(value.toLowerCase()));reserved.add(value.toLowerCase());return value}
  return folded.flatMap(line=>{
    if(/^\s*\*/.test(line))return[line]
    const parsed=parsePolynomialSource(line);if(!parsed)return[line]
    const {name,positive,negative,expression,kind}=parsed
    const comment=line.match(/[;$].*$/)?.[0]
    if(kind==='E'||kind==='G')return[`${name} ${positive} ${negative} VALUE={${expression}}${comment?' '+comment:''}`]
    const node=helper('n'),sense=helper('V'),behavior=helper('B')
    return[`${behavior} 0 ${node} I={${expression}}`,`${sense} ${node} 0 0`,`${name} ${positive} ${negative} ${sense} 1${comment?' '+comment:''}`]
  }).join('\n')
}
