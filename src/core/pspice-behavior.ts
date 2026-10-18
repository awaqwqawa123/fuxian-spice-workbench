/** Lower the documented PSpice analog expression subset to native ngspice.
 * Keep E/G names: ngspice lowers VALUE itself, preserving I(E...) and F/H refs.
 * No compatibility-mode setting, generated device name, or node is required.
 */
const numberToken=/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[a-z]*/i
const identifierToken=/^[a-z_][a-z0-9_.]*/i
const nativeFunctions:Record<string,number>={abs:1,sgn:1,sqrt:1,exp:1,log:1,ln:1,log10:1,sin:1,cos:1,tan:1,asin:1,acos:1,atan:1,atan2:2,sinh:1,cosh:1,tanh:1,asinh:1,acosh:1,atanh:1,ceil:1,floor:1,int:1,nint:1,u:1,uramp:1,min:2,max:2,pow:2}
const pspiceFunctions:Record<string,number>={if:3,limit:3,pwr:2,pwrs:2}
interface Token {value:string;start:number;end:number}
const invalid=(message:string):never=>{throw new Error(`PSpice 表达式：${message}`)}
export function requiresPspiceExpressionLowering(expression:string):boolean {
  return /\b(?:IF|PWR|PWRS)\s*\(|\bTEMP\b|(?<!\|)\|(?!\|)|(?<!&)&(?!&)/i.test(expression)
}

/** Returns a canonical, idempotent expression, including parameter expressions. */
export function normalizePspiceExpression(input:string):string {
  let source=input.trim()
  if(source.startsWith('{')&&source.endsWith('}'))source=source.slice(1,-1).trim()
  if(!source||source.length>8192)invalid('为空或超过 8 KB')
  const tokens:Token[]=[]
  for(let i=0;i<source.length;){
    if(/\s/.test(source[i])){i++;continue}
    const remainder=source.slice(i),match=remainder.match(numberToken)??remainder.match(identifierToken)
    const value=match?.[0]??remainder.match(/^(?:\*\*|<=|>=|==|!=|<>|&&|\|\||[+\-*/^<>=!&|?:(),#\[\]])/)?.[0]
    if(!value)invalid(`不支持的字符 ${source[i]}`)
    tokens.push({value:value!,start:i,end:i+value!.length});i+=value!.length
    if(tokens.length>4096)invalid('表达式过于复杂')
  }
  let position=0,depth=0
  const peek=()=>tokens[position]?.value
  const take=()=>tokens[position++]?.value
  const expect=(value:string)=>{if(take()!==value)invalid(`缺少 ${value}`)}
  const precedence:Record<string,number>={'|':1,'||':1,'&':2,'&&':2,'=':3,'==':3,'!=':3,'<>':3,'<':4,'>':4,'<=':4,'>=':4,'+':5,'-':5,'*':6,'/':6,'^':7,'**':7}
  const expression=(minimum=0):string=>{
    if(++depth>64)invalid('表达式嵌套超过 64 层')
    let result=primary()
    while(peek()!==undefined&&(precedence[peek()!]??-1)>=minimum){
      const operator=take()!,rank=precedence[operator],right=expression(rank+(rank===7?0:1))
      const canonical=({'|':'||','&':'&&','=':'==','<>':'!='} as Record<string,string>)[operator]??operator
      result=rank===7?`pow(${result},${right})`:`(${result}${canonical}${right})`
    }
    if(minimum===0&&peek()==='?'){
      take();const yes=expression();expect(':');const no=expression();result=`(${result}?${yes}:${no})`
    }
    depth--;return result
  }
  const primary=():string=>{
    const token=take()
    if(!token)invalid('缺少操作数')
    if(['+','-','!'].includes(token!))return `(${token}${expression(7)})`
    if(token==='('){const value=expression();expect(')');return value}
    if(numberToken.test(token!))return token!
    if(!identifierToken.test(token!))invalid(`无效操作数 ${token}`)
    const name=token!.toLowerCase()
    if(peek()!=='(')return name==='temp'?'temper':token!
    take()
    // Node identifiers such as IN+, VCC-B and 5.1 are names, not arithmetic.
    if(name==='v'||name==='i'){
      const start=tokens[position]?.start??source.length
      while(peek()!==undefined&&peek()!==')')position++
      const end=tokens[position]?.start??source.length
      const nodes=source.slice(start,end).split(',').map(part=>part.trim())
      if(!nodes.length||nodes.length>(name==='v'?2:1)||nodes.some(node=>!/^[-+a-z0-9_.:#\[\]]+$/i.test(node)))invalid(`${token} 探针节点无效`)
      expect(')');return `${name}(${nodes.join(',')})`
    }
    const arity=nativeFunctions[name]??pspiceFunctions[name]
    if(arity===undefined)invalid(`不支持函数 ${token}`)
    const args:string[]=[]
    if(peek()!==')')while(true){args.push(expression());if(peek()!==',')break;take()}
    expect(')');if(args.length!==arity)invalid(`${token} 需要 ${arity} 个参数`)
    switch(name){
      case 'if':return `(${args[0]}?${args[1]}:${args[2]})`
      case 'limit':return `min(max(${args[0]},${args[1]}),${args[2]})`
      // PSpice PWR uses the absolute base; PWRS restores its sign.
      case 'pwr':return `pow(abs(${args[0]}),${args[1]})`
      case 'pwrs':return `(sgn(${args[0]})*pow(abs(${args[0]}),${args[1]}))`
      case 'ln':return `log(${args[0]})`
      default:return `${name}(${args.join(',')})`
    }
  }
  const result=expression()
  if(position!==tokens.length)invalid(`多余内容 ${peek()}`)
  if(result.length>65536)invalid('归一后的表达式超过 64 KB')
  return result
}

function tableNumber(raw:string):number {
  const match=raw.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/i)
  if(!match)invalid('TABLE 坐标仅支持有限常数')
  const suffix=match![2].toLowerCase(),scales:Record<string,number>={t:1e12,g:1e9,meg:1e6,mil:25.4e-6,k:1e3,m:1e-3,u:1e-6,n:1e-9,p:1e-12,f:1e-15}
  const prefix=suffix.startsWith('meg')?'meg':suffix.startsWith('mil')?'mil':suffix[0]
  const value=Number(match![1])*(scales[prefix]??1)
  if(!Number.isFinite(value))invalid('TABLE 坐标必须为有限常数')
  return value
}

/** PSpice TABLE is piecewise linear, clamped to both endpoint ordinates. */
function normalizeTable(raw:string):string {
  const match=raw.match(/^\s*\{([^{}]+)\}\s*=?\s*(.+)$/)
  if(!match)invalid('TABLE 格式应为 TABLE {表达式} = (x,y) ...')
  const argument=normalizePspiceExpression(match![1]),pairs:Array<[number,number]>=[]
  let rest=match![2].trim()
  // TINA vendor libraries enclose the entire point list in one extra pair.
  // Strip only that wrapper; each coordinate still uses the same strict parser.
  if(/^\(\s*\(/.test(rest)&&rest.endsWith(')'))rest=rest.slice(1,-1).trim()
  while(rest){
    const pair=rest.match(/^\(\s*([^,()]+)\s*,\s*([^,()]+)\s*\)\s*,?\s*/)
    if(!pair)invalid('TABLE 坐标格式应为 (x,y)')
    pairs.push([tableNumber(pair![1]),tableNumber(pair![2])]);rest=rest.slice(pair![0].length)
    if(pairs.length>64)invalid('TABLE 超过 64 个坐标')
  }
  if(pairs.length<2)invalid('TABLE 至少需要 2 个坐标')
  for(let i=1;i<pairs.length;i++)if(pairs[i][0]<=pairs[i-1][0])invalid('TABLE 的横坐标必须严格递增')
  let value=String(pairs.at(-1)![1])
  for(let i=pairs.length-2;i>=0;i--){
    const [x0,y0]=pairs[i],[x1,y1]=pairs[i+1]
    const segment=`(${y0}+(${y1}-${y0})*((${argument})-${x0})/(${x1}-${x0}))`
    value=`((${argument})<${x1}?${segment}:${value})`
  }
  value=`((${argument})<=${pairs[0][0]}?${pairs[0][1]}:${value})`
  return normalizePspiceExpression(value)
}

/** Normalize one already joined/stripped library line; preserve other syntax. */
export function normalizePspiceBehaviorLine(line:string):string {
  const match=line.match(/^([eg]\S*)\s+(\S+)\s+(\S+)\s+(value|table)\b\s*=?\s*(.*)$/i)
  if(match){
    const [,id,positive,negative,kind,raw]=match
    const value=kind.toLowerCase()==='table'?normalizeTable(raw):normalizePspiceExpression(raw)
    return `${id} ${positive} ${negative} VALUE={${value}}`
  }
  const behavioral=line.match(/^([b]\S*)\s+(\S+)\s+(\S+)\s+([vi])\s*=\s*(.*)$/i)
  if(behavioral){
    const [,id,positive,negative,kind,raw]=behavioral
    return `${id} ${positive} ${negative} ${kind.toUpperCase()}={${normalizePspiceExpression(raw)}}`
  }
  return line
}
