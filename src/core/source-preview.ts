import type { Device } from './drawing'
import type { Project } from './circuit'
import { parseQuantity } from './circuit'
import { evaluateSourceExpression, type SourceExpressionNode } from './source-expression'
import { editableSource, sourceValues, type SourceValues } from './sources'

export interface SourcePreview {points:[number,number][];start:number;stop:number;min:number;max:number;unit:'V'|'A';error?:string;note?:string}
/** Exactly the independent source's mathematical definition, without a circuit solver. */
export function sourceValueAt(source:SourceValues,time:number):number {
  if(!Number.isFinite(time)||time<0)throw new Error('预览时间须为有限的非负数')
  const v=source.values
  if(source.waveform==='dc')return source.dc
  if(source.waveform==='expression'){
    if(!source.expressionAst)throw new Error('波形表达式没有已解析的语法树')
    return evaluateSourceExpression(source.expressionAst,time)
  }
  if(source.waveform==='sine')return v.offset+v.amplitude*Math.sin(2*Math.PI*v.frequency*Math.max(0,time-v.delay)+v.phase*Math.PI/180)
  if(source.waveform==='pulse'){
    if(time<v.delay)return v.low
    const phase=(time-v.delay)%v.period
    if(phase<v.rise)return v.low+(v.high-v.low)*phase/v.rise
    if(phase<v.rise+v.width)return v.high
    if(phase<v.rise+v.width+v.fall)return v.high+(v.low-v.high)*(phase-v.rise-v.width)/v.fall
    return v.low
  }
  const points=source.points!
  if(time>=points.at(-1)![0])return points.at(-1)![1]
  const next=points.findIndex(p=>p[0]>time),a=points[Math.max(0,next-1)],b=points[next]
  return a[1]+(b[1]-a[1])*(time-a[0])/(b[0]-a[0])
}

/** Characteristic periods/delays come from the AST, rather than guessing from raw code. */
function expressionTimes(node:SourceExpressionNode):number[] {
  const times:number[]=[]
  const slope=(n:SourceExpressionNode):[number,number]|null=>{
    if(n.type==='number')return[0,n.value]
    if(n.type==='time')return[1,0]
    if(n.type==='group')return slope(n.value)
    if(n.type==='unary'){const a=slope(n.value);return a&&[a[0]*(n.operator==='-'?-1:1),a[1]*(n.operator==='-'?-1:1)]}
    if(n.type==='binary'){
      const a=slope(n.left),b=slope(n.right);if(!a||!b)return null
      if(n.operator==='+')return[a[0]+b[0],a[1]+b[1]]
      if(n.operator==='-')return[a[0]-b[0],a[1]-b[1]]
      if(n.operator==='*'&&(a[0]===0||b[0]===0))return[a[0]*b[1]+b[0]*a[1],a[1]*b[1]]
      if(n.operator==='/'&&b[0]===0&&b[1]!==0)return[a[0]/b[1],a[1]/b[1]]
    }
    return null
  }
  const add=(t:number)=>{if(Number.isFinite(t)&&t>0)times.push(t)}
  const walk=(n:SourceExpressionNode)=>{
    if(n.type==='call'){
      const linear=slope(n.args[0]);
      if(linear&&linear[0]!==0){
        if(['sin','cos'].includes(n.name))add(4*Math.PI/Math.abs(linear[0]))
        if(['triangle','square','saw'].includes(n.name))add(2/Math.abs(linear[0]))
        if(n.name==='exp'&&linear[0]<0)add(4/Math.abs(linear[0]))
        if(n.name==='step')add(2*Math.max(0,-linear[1]/linear[0]))
        if(n.name==='ramp')add(Math.max(0,-linear[1]/linear[0])+1/Math.abs(linear[0]))
      }
      if(n.name==='pulse')add((linear&&linear[0]>0?Math.max(0,-linear[1]/linear[0]):0)+2*evaluateSourceExpression(n.args[2],0)/Math.abs(linear?.[0]||1))
      if(n.name==='window')add(Math.max(0,evaluateSourceExpression(n.args[2],0))*1.25)
      n.args.forEach(walk)
    }else if(n.type==='group'||n.type==='unary')walk(n.value)
    else if(n.type==='binary'){
      if(['<','>','<=','>='].includes(n.operator)){const a=slope(n.left),b=slope(n.right);if(a&&b&&a[0]!==b[0])add(2*(b[1]-a[1])/(a[0]-b[0]))}
      walk(n.left);walk(n.right)
    }
    else if(n.type==='conditional'){walk(n.condition);walk(n.yes);walk(n.no)}
  }
  walk(node);return times
}
export function suggestedSourcePreviewStop(source:SourceValues,fallback=.005):number {
  let stop=fallback
  if(source.waveform==='sine')stop=source.values.delay+2/source.values.frequency
  else if(source.waveform==='pulse')stop=source.values.delay+2*source.values.period
  else if(source.waveform==='pwl')stop=source.points!.at(-1)![0]*1.1
  else if(source.expressionAst){const times=expressionTimes(source.expressionAst);if(times.length)stop=Math.max(...times)}
  return Math.max(1e-15,Math.min(1e6,Number.isFinite(stop)&&stop>0?stop:.005))
}

export function buildSourcePreview(device:Device,project:Project,window?:{start:number;stop:number}):SourcePreview {
  const unit=device.kind==='I'?'A':'V'
  const empty:SourcePreview={unit,points:[],start:0,stop:.005,min:-1,max:1}
  try{
    const source=sourceValues(editableSource(device,project))
    let fallback=.005;try{fallback=parseQuantity(project.tran.stop,'time')}catch{/* separate draft may be incomplete */}
    const start=window?.start??0,stop=window?.stop??suggestedSourcePreviewStop(source,fallback)
    if(!Number.isFinite(start)||!Number.isFinite(stop)||start<0||stop<=start||stop>1e6)throw new Error('预览时间窗要求 0 ≤ 开始 < 结束 ≤ 1e6 s')
    const time=new Set<number>()
    for(let index=0;index<=512;index++)time.add(start+(stop-start)*index/512)
    const add=(t:number)=>{if(t>=start&&t<=stop)time.add(t)}
    let note:string|undefined
    if(source.waveform==='pwl')source.points!.forEach(([t])=>add(t))
    if(source.waveform==='pulse'){
      const v=source.values,first=Math.max(0,Math.floor((start-v.delay)/v.period)),last=Math.max(0,Math.ceil((stop-v.delay)/v.period))
      if(last-first>120)note='时间窗包含较多周期，预览采样可能遗漏窄脉冲；请缩小时间窗。'
      else for(let cycle=first;cycle<=last;cycle++){
        const t=v.delay+cycle*v.period
        for(const offset of [0,v.rise,v.rise+v.width,v.rise+v.width+v.fall])add(t+offset)
      }
    }
    if(source.waveform==='sine'&&(stop-start)*source.values.frequency>64)note='时间窗包含较多周期，预览可能出现采样混叠；请缩小时间窗。'
    if(source.waveform==='expression')note='按有限采样预览；理想跳变没有上升／下降时间，超出时间窗的细节请缩小时间窗核对。'
    const points:[number,number][]=[...time].sort((a,b)=>a-b).map(t=>{
      const value=sourceValueAt(source,t)
      if(!Number.isFinite(value)||Math.abs(value)>1e12)throw new Error(`t=${formatPreviewQuantity(t,'s')} 时波形超出预览数值范围`)
      return[t,value]
    })
    const values=points.map(p=>p[1]),lo=Math.min(...values),hi=Math.max(...values)
    const margin=hi>lo?(hi-lo)*.12:Math.max(Math.abs(lo)*.12,unit==='A'?.0001:.1)
    return{unit,points,start,stop,min:lo-margin,max:hi+margin,note}
  }catch(cause){return{...empty,error:(cause as Error).message}}
}
export function formatPreviewQuantity(value:number,unit:string):string {
  const magnitude=Math.abs(value),steps:[number,string][]=[[1e9,'G'],[1e6,'M'],[1e3,'k'],[1,''],[1e-3,'m'],[1e-6,'µ'],[1e-9,'n'],[1e-12,'p']]
  const [scale,prefix]=steps.find(([scale])=>magnitude>=scale)??(magnitude===0?[1,'']:[1e-12,'p'])
  return `${Number((value/scale).toPrecision(3))} ${prefix}${unit}`
}
