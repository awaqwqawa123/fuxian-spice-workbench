/** Bounded time-only arithmetic AST. SPICE generation and numerical previews share this parser. */
export type SourceExpressionNode =
  | {type:'number';value:number}
  | {type:'time'}
  | {type:'group';value:SourceExpressionNode}
  | {type:'unary';operator:string;value:SourceExpressionNode}
  | {type:'binary';operator:string;left:SourceExpressionNode;right:SourceExpressionNode}
  | {type:'conditional';condition:SourceExpressionNode;yes:SourceExpressionNode;no:SourceExpressionNode}
  | {type:'call';name:string;args:SourceExpressionNode[]}
const arities:Record<string,number>={sin:1,cos:1,tan:1,exp:1,ln:1,sqrt:1,abs:1,tanh:1,min:2,max:2,floor:1,ceil:1,step:1,ramp:1,triangle:1,square:1,saw:1,pulse:3,window:3}

export const sourceExpressionExamples=[
  {id:'sine',label:'正弦',expression:'sin(2*pi*1k*time)'},
  {id:'mixed',label:'双频叠加',expression:'sin(2*pi*1k*time)+0.3*cos(2*pi*3k*time)'},
  {id:'step',label:'延迟阶跃',expression:'step(time-1m)'},
  {id:'pulse',label:'脉冲列',expression:'pulse(time,250u,1m)'},
  {id:'triangle',label:'三角波',expression:'triangle(1k*time)'},
  {id:'square',label:'方波',expression:'square(1k*time)'},
  {id:'saw',label:'锯齿波',expression:'saw(1k*time)'},
  {id:'ramp',label:'限幅斜坡',expression:'min(1,ramp(time/1m))'},
  {id:'damped',label:'衰减振荡',expression:'exp(-time/2m)*sin(2*pi*1k*time)'},
  {id:'window',label:'加窗正弦',expression:'window(time,500u,2m)*sin(2*pi*2k*time)'},
  {id:'rectified',label:'全波整流',expression:'abs(sin(2*pi*1k*time))'},
] as const

export function parseSourceExpression(raw:string):SourceExpressionNode {
  if(typeof raw!=='string'||!raw.trim()||raw.length>1000||/[\r\n]/.test(raw))throw new Error('波形代码须为一行、1～1000 字符的 time 数学表达式')
  const tokens:string[]=[],pattern=/\s*(?:(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+)?(meg|[tgkmunpf])?|([a-zA-Z_][a-zA-Z_0-9]*)|(<=|>=|==|!=|[+*/^(),?:<>-]))/gy
  let pos=0
  while(pos<raw.length){
    if(!raw.slice(pos).trim())break
    pattern.lastIndex=pos;const m=pattern.exec(raw)
    if(!m)throw new Error(`波形代码第 ${pos+1} 个字符不支持；只允许数值、time、pi、数学函数与运算符`)
    if(m[1]){
      const scale:Record<string,number>={t:1e12,g:1e9,meg:1e6,k:1e3,m:1e-3,u:1e-6,n:1e-9,p:1e-12,f:1e-15}
      const value=Number(m[1]+(m[2]??''))*(m[3]?scale[m[3]]:1)
      if(!Number.isFinite(value))throw new Error('波形代码包含非有限数值')
      tokens.push(String(value))
    }else tokens.push((m[4]??m[5]).toLowerCase())
    pos=pattern.lastIndex
    if(tokens.length>300)throw new Error('波形代码过于复杂，最多 300 个符号')
  }
  let index=0,depth=0
  const expect=(value:string)=>{if(tokens[index++]!==value)throw new Error(`波形代码缺少 ${value}`)}
  const parse=(minimum=0):SourceExpressionNode=>{
    if(++depth>30)throw new Error('波形代码括号嵌套过深')
    const first=tokens[index++];let left:SourceExpressionNode
    if(first==='+'||first==='-')left={type:'unary',operator:first,value:parse(4)}
    else if(first==='('){left={type:'group',value:parse()};expect(')')}
    else if(first==='time')left={type:'time'}
    else if(first==='pi')left={type:'number',value:Math.PI}
    else if(first&&/^\d/.test(first))left={type:'number',value:Number(first)}
    else if(Object.hasOwn(arities,first??'')){
      expect('(');const args=[parse()]
      while(tokens[index]===','){index++;args.push(parse())}
      expect(')');if(args.length!==arities[first])throw new Error(`${first} 需要 ${arities[first]} 个参数`)
      left={type:'call',name:first,args}
    }else throw new Error(`不支持波形变量或函数“${first??'空'}”；可用 time、pi、sin、cos、exp、sqrt、abs、min、max 等`)
    const precedence:Record<string,number>={'==':1,'!=':1,'<':1,'>':1,'<=':1,'>=':1,'+':2,'-':2,'*':3,'/':3,'^':4}
    while(index<tokens.length){
      const operator=tokens[index],level=precedence[operator]
      if(level===undefined||level<minimum)break
      index++;left={type:'binary',operator,left,right:parse(level+(operator==='^'?0:1))}
    }
    if(minimum===0&&tokens[index]==='?'){index++;const yes=parse();expect(':');left={type:'conditional',condition:left,yes,no:parse()}}
    depth--;return left
  }
  const expression=parse()
  const validateHelpers=(node:SourceExpressionNode):void=>{
    const hasTime=(n:SourceExpressionNode):boolean=>n.type==='time'||(n.type==='group'||n.type==='unary'?hasTime(n.value):n.type==='binary'?hasTime(n.left)||hasTime(n.right):n.type==='conditional'?hasTime(n.condition)||hasTime(n.yes)||hasTime(n.no):n.type==='call'?n.args.some(hasTime):false)
    if(node.type==='call'){
      node.args.forEach(validateHelpers)
      if(node.name==='pulse'||node.name==='window'){
        if(node.args.slice(1).some(hasTime))throw new Error(`${node.name} 的时间边界必须为常数表达式`)
        const a=evaluateSourceExpression(node.args[1],0),b=evaluateSourceExpression(node.args[2],0)
        if(node.name==='pulse'&&(a<=0||b<=0||a>b))throw new Error('pulse(time,宽度,周期) 要求 0 < 宽度 ≤ 周期')
        if(node.name==='window'&&b<=a)throw new Error('window(time,开始,结束) 要求结束大于开始')
      }
    }else if(node.type==='group'||node.type==='unary')validateHelpers(node.value)
    else if(node.type==='binary'){validateHelpers(node.left);validateHelpers(node.right)}
    else if(node.type==='conditional'){validateHelpers(node.condition);validateHelpers(node.yes);validateHelpers(node.no)}
  }
  validateHelpers(expression)
  if(index!==tokens.length)throw new Error(`波形代码包含多余符号“${tokens[index]}”`)
  return expression
}

/** Helpers lower into ngspice's B-source arithmetic; no .func or host-language execution. */
export function sourceExpressionSpice(node:SourceExpressionNode):string {
  const render=():string=>{switch(node.type){
    case 'number':return String(node.value)
    case 'time':return 'time'
    case 'group':return `(${sourceExpressionSpice(node.value)})`
    case 'unary':return `(${node.operator}${sourceExpressionSpice(node.value)})`
    case 'binary':return `(${sourceExpressionSpice(node.left)}${node.operator}${sourceExpressionSpice(node.right)})`
    case 'conditional':return `(${sourceExpressionSpice(node.condition)}?${sourceExpressionSpice(node.yes)}:${sourceExpressionSpice(node.no)})`
    case 'call':{
      const a=node.args.map(sourceExpressionSpice),x=a[0],fraction=`(${x}-floor(${x}))`
      if(node.name==='step')return `(${x}>=0?1:0)`
      if(node.name==='ramp')return `max(0,${x})`
      if(node.name==='triangle')return `(1-4*abs(${fraction}-0.5))`
      if(node.name==='square')return `(${fraction}<0.5?1:-1)`
      if(node.name==='saw')return `(2*${fraction}-1)`
      if(node.name==='pulse')return `((${a[2]}>0)?((${a[1]}>0)?((${a[1]}<=${a[2]})?((${x}>=0)?((${x}-floor(${x}/${a[2]})*${a[2]})<${a[1]}?1:0):0):0):0):0)`
      if(node.name==='window')return `(${x}<${a[1]}?0:(${x}<${a[2]}?1:0))`
      return `${node.name}(${a.join(',')})`
    }
  }}
  const code=render()
  if(code.length>20000)throw new Error('波形函数展开过于复杂，最多 20000 字符')
  return code
}
export function compileSourceExpression(raw:string):string {return sourceExpressionSpice(parseSourceExpression(raw))}

/** Evaluates only the allowlisted AST. Domain/nonfinite errors are explicit, never plotted as zero. */
export function evaluateSourceExpression(node:SourceExpressionNode,time:number):number {
  if(!Number.isFinite(time)||time<0)throw new Error('预览时间须为有限的非负数')
  const run=(n:SourceExpressionNode):number=>{
    let value:number
    switch(n.type){
      case 'number':value=n.value;break
      case 'time':value=time;break
      case 'group':value=run(n.value);break
      case 'unary':value=n.operator==='-'?-run(n.value):run(n.value);break
      case 'conditional':value=run(n.condition)!==0?run(n.yes):run(n.no);break
      case 'binary':{
        const a=run(n.left),b=run(n.right)
        switch(n.operator){
          case '+':value=a+b;break;case '-':value=a-b;break;case '*':value=a*b;break
          case '/':if(b===0)throw new Error('波形代码出现除以零');value=a/b;break
          case '^':value=Math.pow(a,b);break
          case '<':value=Number(a<b);break;case '>':value=Number(a>b);break
          case '<=':value=Number(a<=b);break;case '>=':value=Number(a>=b);break
          case '==':value=Number(a===b);break;case '!=':value=Number(a!==b);break
          default:throw new Error('未知波形运算符')
        }break
      }
      case 'call':{
        const a=n.args.map(run),x=a[0],fraction=x-Math.floor(x)
        switch(n.name){
          case 'sin':value=Math.sin(x);break;case 'cos':value=Math.cos(x);break;case 'tan':value=Math.tan(x);break
          case 'exp':value=Math.exp(x);break;case 'ln':if(x<=0)throw new Error('ln 参数必须大于 0');value=Math.log(x);break
          case 'sqrt':if(x<0)throw new Error('sqrt 参数必须非负');value=Math.sqrt(x);break
          case 'abs':value=Math.abs(x);break;case 'tanh':value=Math.tanh(x);break
          case 'min':value=Math.min(x,a[1]);break;case 'max':value=Math.max(x,a[1]);break
          case 'floor':value=Math.floor(x);break;case 'ceil':value=Math.ceil(x);break
          case 'step':value=Number(x>=0);break;case 'ramp':value=Math.max(0,x);break
          case 'triangle':value=1-4*Math.abs(fraction-.5);break
          case 'square':value=fraction<.5?1:-1;break;case 'saw':value=2*fraction-1;break
          case 'pulse':if(a[2]<=0||a[1]<=0||a[1]>a[2])throw new Error('pulse(time,宽度,周期) 要求 0 < 宽度 ≤ 周期');value=x>=0&&x-Math.floor(x/a[2])*a[2]<a[1]?1:0;break
          case 'window':if(a[2]<=a[1])throw new Error('window(time,开始,结束) 要求结束大于开始');value=x>=a[1]&&x<a[2]?1:0;break
          default:throw new Error('未知波形函数')
        }break
      }
    }
    if(!Number.isFinite(value))throw new Error('波形代码在当前时间窗超出有限数值范围')
    return value
  }
  return run(node)
}
