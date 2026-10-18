import { analysisSignals } from './circuit'
import { resolveBranchCurrent } from './branch-currents'
import type { Complex, Result } from './results'

export interface WaveformExpression { id:string; name?:string; expression:string }
export interface ExpressionReference { kind:'voltage'|'current'; nodes?:string[]; device?:string }
type Dimension = readonly [number,number]
type Ast = {kind:'number';value:number;dimension:Dimension}|{kind:'reference';reference:ExpressionReference}|{kind:'unary';op:string;arg:Ast}|{kind:'binary';op:string;left:Ast;right:Ast}|{kind:'call';name:string;args:Ast[]}
export interface ParsedWaveformExpression { ast:Ast; references:ExpressionReference[]; dimension:Dimension; unit:string }
export interface ExpressionValues { values:number[]; complex?:Complex[]; unit:string; dimensionless:boolean; powerPhasor:boolean }
const functions=new Set(['abs','sqrt','min','max','real','imag','conj','exp','ln','log10','sin','cos'])
const same=(a:Dimension,b:Dimension)=>a[0]===b[0]&&a[1]===b[1]
const scalar:Dimension=[0,0]

function unit(d:Dimension):string {
  if(same(d,scalar))return '1'
  if(same(d,[1,0]))return 'V'
  if(same(d,[0,1]))return 'A'
  if(same(d,[1,1]))return 'W'
  if(same(d,[1,-1]))return 'Ω'
  const power=(name:string,value:number)=>value===0?'':value===1?name:`${name}^${value}`
  return [power('V',d[0]),power('A',d[1])].filter(Boolean).join('·')
}

/** A bounded expression grammar; no JavaScript interpretation or property access. */
export function parseWaveformExpression(text:string):ParsedWaveformExpression {
  if(typeof text!=='string'||!text.trim()||text.length>1000||/[\r\n\u0000-\u001f]/.test(text))throw new Error('表达式需要最多 1000 字符的单行文本')
  const tokens:string[]=[]
  let offset=0
  while(offset<text.length){
    if(/\s/.test(text[offset])){offset++;continue}
    const token=text.slice(offset).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[TGMkKmunpµμ])?(?:V|A)?/i)?.[0]
      ??text.slice(offset).match(/^[a-z_][a-z0-9_:$]*/i)?.[0]
      ??( '+-*/^(),'.includes(text[offset])?text[offset]:undefined)
    if(!token)throw new Error(`表达式在第 ${offset+1} 字符处包含不支持的符号`)
    tokens.push(token);offset+=token.length
    if(tokens.length>256)throw new Error('表达式过于复杂，最多 256 个符号')
  }
  let at=0,count=0
  const references:ExpressionReference[]=[]
  const take=(wanted:string)=>{if(tokens[at]!==wanted)throw new Error(`表达式需要 ${wanted}`);at++}
  const node=(value:Ast):Ast=>{if(++count>128)throw new Error('表达式过于复杂，最多 128 个运算节点');return value}
  function primary(depth:number):Ast {
    if(depth>24)throw new Error('表达式嵌套最多 24 层')
    const token=tokens[at++]
    if(token===undefined)throw new Error('表达式不完整')
    if(token==='('){const value=expression(0,depth+1);take(')');return value}
    if(/^\d|^\./.test(token)){
      const match=token.match(/^((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[TGMkKmunpµμ])?(V|A)?$/i)
      if(!match)throw new Error('表达式数值格式错误')
      const scales:Record<string,number>={t:1e12,g:1e9,meg:1e6,k:1e3,m:1e-3,u:1e-6,'µ':1e-6,'μ':1e-6,n:1e-9,p:1e-12}
      const factor=match[2]==='M'?1e6:scales[match[2]?.toLowerCase()]??1,value=Number(match[1])*factor
      if(!Number.isFinite(value))throw new Error('表达式数值必须有限')
      return node({kind:'number',value,dimension:match[3]?.toUpperCase()==='V'?[1,0]:match[3]?.toUpperCase()==='A'?[0,1]:scalar})
    }
    const name=token.toLowerCase()
    if(name==='pi')return node({kind:'number',value:Math.PI,dimension:scalar})
    if(name==='v'||name==='i'){
      take('(')
      const names:string[]=[]
      do {
        const value=tokens[at++]
        if(!value||!(/^[a-z_][a-z0-9_:$]*$/i.test(value)||/^\d+$/.test(value)))throw new Error('V / I 需要实际节点或器件名称')
        names.push(value.toLowerCase())
        if(tokens[at]!==',')break
        at++
      } while(names.length<3)
      take(')')
      if(name==='i'&&names.length!==1||name==='v'&&(names.length<1||names.length>2))throw new Error('使用 V(node)、V(a,b) 或 I(device)')
      const reference:ExpressionReference=name==='v'?{kind:'voltage',nodes:names}:{kind:'current',device:names[0]}
      references.push(reference);return node({kind:'reference',reference})
    }
    if(!functions.has(name))throw new Error(`不支持函数或名称 ${token}`)
    take('(');const args:Ast[]=[]
    do {args.push(expression(0,depth+1));if(tokens[at]!==',')break;at++} while(args.length<17)
    take(')')
    if((name==='min'||name==='max')?args.length<2||args.length>16:args.length!==1)throw new Error(`${name} 参数数量无效`)
    return node({kind:'call',name,args})
  }
  function unary(depth:number):Ast {
    if(depth>24)throw new Error('表达式嵌套最多 24 层')
    if(tokens[at]==='+'||tokens[at]==='-')return node({kind:'unary',op:tokens[at++],arg:unary(depth+1)})
    return power(depth)
  }
  function power(depth:number):Ast {
    const left=primary(depth)
    return tokens[at]==='^'?(at++,node({kind:'binary',op:'^',left,right:unary(depth+1)})):left
  }
  function expression(min:number,depth:number):Ast {
    let left=unary(depth)
    while(true){
      const op=tokens[at],precedence=op==='+'||op==='-'?1:op==='*'||op==='/'?2:0
      if(precedence<=min)break
      at++;left=node({kind:'binary',op,left,right:expression(precedence,depth+1)})
    }
    return left
  }
  const ast=expression(0,0)
  if(at!==tokens.length)throw new Error(`表达式包含多余符号 ${tokens[at]}`)
  const dimension=infer(ast)
  return {ast,references,dimension,unit:unit(dimension)}
}

function constant(ast:Ast):number|undefined {
  if(ast.kind==='number'&&same(ast.dimension,scalar))return ast.value
  if(ast.kind==='unary'){const value=constant(ast.arg);return value===undefined?undefined:ast.op==='-'?-value:value}
  return undefined
}
function infer(ast:Ast):Dimension {
  if(ast.kind==='number')return ast.dimension
  if(ast.kind==='reference')return ast.reference.kind==='voltage'?[1,0]:[0,1]
  if(ast.kind==='unary')return infer(ast.arg)
  if(ast.kind==='binary'){
    const a=infer(ast.left),b=infer(ast.right)
    if(ast.op==='+'||ast.op==='-'){if(!same(a,b))throw new Error('加减两侧的单位必须相同');return a}
    if(ast.op==='*')return [a[0]+b[0],a[1]+b[1]]
    if(ast.op==='/')return [a[0]-b[0],a[1]-b[1]]
    const exponent=constant(ast.right)
    if(exponent===undefined||Math.abs(exponent)>16)throw new Error('指数需要绝对值不超过 16 的无量纲常数')
    return [a[0]*exponent,a[1]*exponent]
  }
  const dimensions=ast.args.map(infer),d=dimensions[0]
  if(ast.name==='min'||ast.name==='max'){if(dimensions.some(other=>!same(d,other)))throw new Error('min / max 参数单位必须相同');return d}
  if(ast.name==='sqrt')return [d[0]/2,d[1]/2]
  if(['abs','real','imag','conj'].includes(ast.name))return d
  if(!same(d,scalar))throw new Error(`${ast.name} 需要无量纲参数`)
  return scalar
}

/** Static references can be checked against a project's actually supported vectors. */
export function validateWaveformExpression(text:string,available?:{voltage:readonly string[];current:readonly string[]}):ParsedWaveformExpression {
  const parsed=parseWaveformExpression(text)
  if(available){
    const voltage=new Set(available.voltage.map(name=>name.toLowerCase())),current=new Set(available.current.map(name=>name.toLowerCase()))
    for(const reference of parsed.references){
      const names=reference.kind==='voltage'?reference.nodes!.filter(name=>name!=='0').map(name=>`v(${name})`):[`i(${reference.device})`]
      for(const name of names)if(!(reference.kind==='voltage'?voltage:current).has(name))throw new Error(`表达式引用 ${name} 没有可用数据`)
    }
  }
  return parsed
}

const complex=(real:number,img=0):Complex=>({real,img})
const add=(a:Complex,b:Complex):Complex=>complex(a.real+b.real,a.img+b.img)
const sub=(a:Complex,b:Complex):Complex=>complex(a.real-b.real,a.img-b.img)
const mul=(a:Complex,b:Complex):Complex=>complex(a.real*b.real-a.img*b.img,a.real*b.img+a.img*b.real)
function div(a:Complex,b:Complex):Complex {
  if(b.real===0&&b.img===0)throw new Error('表达式除数为零')
  const scale=Math.max(Math.abs(b.real),Math.abs(b.img)),re=b.real/scale,im=b.img/scale,d=re*re+im*im
  return complex((a.real/scale*re+a.img/scale*im)/d,(a.img/scale*re-a.real/scale*im)/d)
}
function pow(a:Complex,value:number):Complex {
  if(a.real===0&&a.img===0){if(value<=0)throw new Error('零的指数必须大于零');return complex(0)}
  const magnitude=Math.hypot(a.real,a.img)**value,angle=Math.atan2(a.img,a.real)*value
  return complex(magnitude*Math.cos(angle),magnitude*Math.sin(angle))
}

/** Real samples stay real; AC arithmetic operates on the saved complex phasors. */
export function evaluateWaveformExpression(result:Result,definition:WaveformExpression):ExpressionValues {
  if(result.analysis==='noise')throw new Error('噪声分析暂不支持波形数学表达式')
  const parsed=parseWaveformExpression(definition.expression),count=result.x.length,ac=result.analysis==='ac'
  if(!count||count>100000)throw new Error('表达式需要有效的求解器采样数据')
  const saved=new Map<string,Complex[]>()
  const require=(name:string,values:Complex[]|undefined):Complex[]=>{
    if(!values||values.length!==count||values.some(value=>!Number.isFinite(value.real)||!Number.isFinite(value.img)))throw new Error(`表达式引用 ${name} 没有有效数据`)
    return values
  }
  const signals=analysisSignals(result.project)
  const realVoltages=result.voltages??{[`v(${signals.inputNode})`]:result.vin,[`v(${signals.outputNode})`]:result.vout}
  function voltage(node:string):Complex[] {
    if(node==='0')return Array.from({length:count},()=>complex(0))
    const name=`v(${node})`
    if(!saved.has(name))saved.set(name,require(name,ac?result.complexVoltages?.[name]:realVoltages[name]?.map(value=>complex(value))))
    return saved.get(name)!
  }
  for(const reference of parsed.references){
    const key=reference.kind==='voltage'?`v(${reference.nodes!.join(',')})`:`i(${reference.device})`
    if(saved.has(key))continue
    if(reference.kind==='voltage'){
      const a=voltage(reference.nodes![0]),b=reference.nodes![1]?voltage(reference.nodes![1]):null
      saved.set(key,b?a.map((value,index)=>sub(value,b[index])):a)
    }else{
      const device=result.project.drawing?.devices.find(part=>part.id.toLowerCase()===reference.device)?.id??reference.device!.toUpperCase()
      const resolved=resolveBranchCurrent(result,device)
      const values=ac?result.complexCurrents?.[key]??resolved?.complex:(result.currents?.[key]??resolved?.values)?.map(value=>complex(value))
      saved.set(key,require(key,values))
    }
  }
  function evaluate(ast:Ast,index:number):Complex {
    if(ast.kind==='number')return complex(ast.value)
    if(ast.kind==='reference')return saved.get(ast.reference.kind==='voltage'?`v(${ast.reference.nodes!.join(',')})`:`i(${ast.reference.device})`)![index]
    if(ast.kind==='unary'){const value=evaluate(ast.arg,index);return ast.op==='-'?complex(-value.real,-value.img):value}
    if(ast.kind==='binary'){
      const a=evaluate(ast.left,index),b=evaluate(ast.right,index)
      if(ast.op==='+')return add(a,b)
      if(ast.op==='-')return sub(a,b)
      if(ast.op==='*')return mul(a,b)
      if(ast.op==='/')return div(a,b)
      if(!ac&&a.real<0&&!Number.isInteger(b.real))throw new Error('实数负底数不支持分数指数')
      return ac?pow(a,b.real):complex(a.real**b.real)
    }
    const args=ast.args.map(arg=>evaluate(arg,index)),a=args[0]
    switch(ast.name){
      case 'abs':return complex(Math.hypot(a.real,a.img))
      case 'real':return complex(a.real)
      case 'imag':return complex(a.img)
      case 'conj':return complex(a.real,-a.img)
      case 'sqrt':if(!ac&&a.real<0)throw new Error('实数 sqrt 参数不能为负数');return ac?pow(a,.5):complex(Math.sqrt(a.real))
      case 'min':case 'max':if(args.some(value=>value.img!==0))throw new Error('min / max 不支持复数排序，请先使用 abs / real');return complex(Math[ast.name](...args.map(value=>value.real)))
      case 'exp':return complex(Math.exp(a.real)*Math.cos(a.img),Math.exp(a.real)*Math.sin(a.img))
      case 'ln':case 'log10':if(a.real===0&&a.img===0||!ac&&a.real<0)throw new Error('对数参数必须大于零或为非零复数');return complex(Math.log(Math.hypot(a.real,a.img))/(ast.name==='ln'?1:Math.LN10),Math.atan2(a.img,a.real)/(ast.name==='ln'?1:Math.LN10))
      case 'sin':return complex(Math.sin(a.real)*Math.cosh(a.img),Math.cos(a.real)*Math.sinh(a.img))
      case 'cos':return complex(Math.cos(a.real)*Math.cosh(a.img),-Math.sin(a.real)*Math.sinh(a.img))
      default:throw new Error('不支持的表达式函数')
    }
  }
  const values:Complex[]=Array.from({length:count},(_,index)=>{
    try {const value=evaluate(parsed.ast,index);if(!Number.isFinite(value.real)||!Number.isFinite(value.img))throw new Error('运算结果不是有限数值');return value}
    catch(error){throw new Error(`${definition.name??definition.expression}：第 ${index+1} 点 ${(error as Error).message}`)}
  })
  return {values:values.map(value=>value.real),...(ac?{complex:values}:{}),unit:parsed.unit,dimensionless:same(parsed.dimension,scalar),powerPhasor:ac&&same(parsed.dimension,[1,1])}
}
