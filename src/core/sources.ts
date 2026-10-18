import { parseQuantity, type Project, type Quantity } from './circuit'
import type { Device } from './drawing'
import { parseSourceExpression, sourceExpressionSpice, type SourceExpressionNode } from './source-expression'

export const sourceWaveforms = ['dc','sine','pulse','pwl','expression'] as const
export type SourceWaveform = typeof sourceWaveforms[number]
export const sourceWaveformNames:Record<SourceWaveform,string>={dc:'直流 DC',sine:'正弦 SIN',pulse:'脉冲 / 三角 PULSE',pwl:'分段线性 PWL',expression:'代码自定义波形'}
export const sourceInstructions='每个 V/I 可使用独立 Device.params 激励；Device.value 是 DC 数值。params.waveform 为 dc/sine/pulse/pwl/expression，共用 acAmplitude、acPhase；sine 另用 offset、amplitude、frequency、delay、phase；pulse 另用 low、high、delay、rise、fall、width、period（rise/fall/width 必须大于0，三者之和不大于period）；pwl 使用 points 时间/数值字符串，例如 "0s 0V 1ms 1V"，从0开始且时间严格递增，最多100点，末点后保持。所有参数值均为字符串。expression 使用 params.expression 单行 time 数学表达式，例如 "sin(2*pi*1k*time)"；数值为 SI 基本单位，允许 time/pi、sin/cos/tan/exp/ln/sqrt/abs/tanh/min/max/floor/ceil/step/ramp/triangle/square/saw/pulse/window 和算术/比较/三元运算，禁止节点引用、指令和换行；仅瞬态使用表达式，DC/AC 保留独立参数。只有未设置 params.waveform 的旧参考电压源使用 project.source；其他未设置波形的旧源是直流。工程仍须接地V源作为 drawing.sourceId，AC时参考源幅度须大于零。'
type SourceDevice=Pick<Device,'kind'|'value'|'params'>
export const isConfiguredSource=(part:SourceDevice)=>['V','I'].includes(part.kind)&&part.params?.waveform!==undefined

export function sourceDefaults(kind:'V'|'I',waveform:SourceWaveform='dc'):Record<string,string> {
  const unit=kind==='V'?'V':'mA'
  const common={waveform,acAmplitude:kind==='V'?'1V':'0A',acPhase:'0'}
  if(waveform==='expression')return{...common,expression:kind==='V'?'sin(2*pi*1k*time)':'1m*sin(2*pi*1k*time)'}
  if(waveform==='sine')return{...common,offset:`0${unit}`,amplitude:`1${unit}`,frequency:'1kHz',delay:'0s',phase:'0'}
  if(waveform==='pulse')return{...common,low:`0${unit}`,high:`1${unit}`,delay:'0s',rise:'1us',fall:'1us',width:'499us',period:'1ms'}
  if(waveform==='pwl')return{...common,points:`0s 0${unit}\n1ms 1${unit}\n2ms 0${unit}`}
  return common
}

/** Explicit per-device sources override the legacy project-wide input source. */
export function editableSource(part:Device,project:Project):Device {
  if(isConfiguredSource(part))return part
  if(part.kind!=='V'&&part.kind!=='I')throw new Error('请选择电压源或电流源')
  if(part.kind==='V'&&part.id===project.drawing?.sourceId){
    const old=project.source, wave=old.waveform==='sine'?'sine':'pulse'
    const params=sourceDefaults('V',wave)
    if(wave==='sine')Object.assign(params,{amplitude:old.amplitude,offset:old.offset,frequency:old.frequency})
    else{
      const period=1/parseQuantity(old.frequency,'frequency'),low=parseQuantity(old.offset,'voltage')
      Object.assign(params,{low:old.offset,high:String(low+parseQuantity(old.amplitude,'voltage')),rise:String(period/1000),fall:String(period/1000),width:String(period/2),period:String(period)})
    }
    return{...part,value:old.dc,params}
  }
  return{...part,params:{...sourceDefaults(part.kind),acAmplitude:part.kind==='V'?'0V':'0A'}}
}

/** Switching waveform drops incompatible old fields while retaining common AC settings. */
export function patchSourceParameters(part:Device,project:Project,patch:Record<string,string>):Device {
  const current=editableSource(part,project),wave=patch.waveform??current.params!.waveform
  if(!sourceWaveforms.includes(wave as SourceWaveform))throw new Error('激励波形请选择 dc、sine、pulse、pwl 或 expression')
  const params=wave===current.params!.waveform?current.params!:{...sourceDefaults(part.kind as 'V'|'I',wave as SourceWaveform),acAmplitude:current.params!.acAmplitude??'0',acPhase:current.params!.acPhase??'0'}
  return{...current,params:{...params,...patch}}
}

export function parsePwlPoints(raw:string,quantity:'voltage'|'current'):[number,number][] {
  if(typeof raw!=='string'||raw.length>4000)throw new Error('PWL 最多 4000 字符、100 个时间 / 数值点')
  const tokens=raw.trim().split(/[\s,;]+/).filter(Boolean)
  if(tokens.length<4||tokens.length>200||tokens.length%2)throw new Error('PWL 至少需要两个时间 / 数值点，例如 0s 0V、1ms 1V')
  const points:[number,number][]=[]
  for(let i=0;i<tokens.length;i+=2){
    const time=parseQuantity(tokens[i],'time'),value=parseQuantity(tokens[i+1],quantity)
    if(time<0||time>100)throw new Error('PWL 时间须在 0～100 s')
    if(Math.abs(value)>1000)throw new Error('PWL 数值须在 −1000～1000（基本单位）')
    if(points.length&&time<=points.at(-1)![0])throw new Error('PWL 时间必须严格递增；阶跃请用两个相邻的时间点')
    points.push([time,value])
  }
  if(points[0][0]!==0)throw new Error('PWL 第一个时间点须为 0s，以明确初始值')
  return points
}

export interface SourceValues { waveform:SourceWaveform; dc:number; acAmplitude:number; acPhase:number; values:Record<string,number>; points?:[number,number][]; expression?:string; expressionAst?:SourceExpressionNode }
export function sourceValues(part:SourceDevice):SourceValues {
  if(part.kind!=='V'&&part.kind!=='I')throw new Error('仅电压源和电流源支持激励参数')
  if(!part.params||typeof part.params!=='object'||Array.isArray(part.params))throw new Error('激励参数必须是键值对象')
  const wave=part.params.waveform as SourceWaveform
  if(!sourceWaveforms.includes(wave))throw new Error('激励波形请选择 DC、SIN、PULSE、PWL 或代码表达式')
  const defaults=sourceDefaults(part.kind,wave),quantity=part.kind==='V'?'voltage':'current'
  for(const [key,value]of Object.entries(part.params)){
    if(!Object.hasOwn(defaults,key))throw new Error(`不支持的激励参数：${key}`)
    if(typeof value!=='string'||value.length>(key==='points'?4000:key==='expression'?1000:40))throw new Error(`激励参数 ${key} 格式错误`)
  }
  const number=(label:string,raw:string,kind:Quantity,min:number,max:number)=>{
    const n=parseQuantity(raw,kind)
    if(n<min||n>max)throw new Error(`${label}允许范围 ${min}～${max}（基本单位）`)
    return n
  }
  const get=(key:string,kind:Quantity,min:number,max:number)=>number(key,part.params![key]??defaults[key],kind,min,max)
  const result:SourceValues={waveform:wave,dc:number('直流值',part.value,quantity,-1000,1000),acAmplitude:get('acAmplitude',quantity,0,1000),acPhase:get('acPhase','gain',-360,360),values:{}}
  const v=result.values
  if(wave==='sine'){
    v.offset=get('offset',quantity,-1000,1000);v.amplitude=get('amplitude',quantity,0,1000)
    v.frequency=get('frequency','frequency',.01,1e9);v.delay=get('delay','time',0,100);v.phase=get('phase','gain',-360,360)
  }
  if(wave==='pulse'){
    v.low=get('low',quantity,-1000,1000);v.high=get('high',quantity,-1000,1000)
    v.delay=get('delay','time',0,100);v.rise=get('rise','time',1e-12,100);v.fall=get('fall','time',1e-12,100)
    v.width=get('width','time',1e-12,100);v.period=get('period','time',1e-12,100)
    if(v.rise+v.fall+v.width>v.period*(1+1e-12))throw new Error('PULSE 周期须不小于上升时间＋高电平宽度＋下降时间')
  }
  if(wave==='expression'){result.expressionAst=parseSourceExpression(part.params.expression??defaults.expression);result.expression=sourceExpressionSpice(result.expressionAst)}
  if(wave==='pwl')result.points=parsePwlPoints(part.params.points??defaults.points,quantity)
  return result
}

export function configuredSourceSpice(part:SourceDevice,analysis:Project['analysis']):string {
  const s=sourceValues(part),v=s.values
  const dc=`DC ${s.dc}`
  if(analysis==='op'||analysis==='dc')return dc
  const head=`${dc} AC ${s.acAmplitude} ${s.acPhase}`
  if(analysis==='ac'||analysis==='noise'||s.waveform==='dc')return head
  if(s.waveform==='expression')return `${part.kind}={${s.expression}}`
  if(s.waveform==='sine')return `${head} SIN(${v.offset} ${v.amplitude} ${v.frequency} ${v.delay} 0 ${v.phase})`
  if(s.waveform==='pulse')return `${head} PULSE(${v.low} ${v.high} ${v.delay} ${v.rise} ${v.fall} ${v.width} ${v.period})`
  return `${head} PWL(${s.points!.flat().join(' ')})`
}

export function sourceDescription(part:SourceDevice):string {
  if(!isConfiguredSource(part))return `DC ${part.value}`
  const wave=part.params!.waveform
  if(wave==='expression')return 'f(time) · 代码波形'
  if(wave==='sine')return `SIN · ${part.params!.amplitude??'1'} · ${part.params!.frequency??'1kHz'}`
  if(wave==='pulse')return `PULSE · ${part.params!.low??'0'} → ${part.params!.high??'1'}`
  return wave==='pwl'?'PWL · 分段线性':`DC ${part.value}`
}
