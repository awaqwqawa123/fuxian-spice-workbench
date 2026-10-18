import { wirePoints, type Drawing, type XY } from './drawing'
import { deviceCaptionRects, type LayoutRect } from './device-caption-geometry'
import { symbolBodyRect, terminalLeadDirection } from './wire-lead-route'
import { spansOverlap, wireNetTopology } from './wire-net-topology'
import { modelDeviceBounds, presentedModelSymbol } from './model-symbol-presentation'
import { hasOriginalOlbCaptions } from './model-symbol-captions'
import { displayedSymbolTexts, symbolTextExtent } from './model-symbol-text-layout'
import type { ImportedSpiceModel } from './spice-models'
import type { LtspiceSymbol } from './ltspice-symbol'

export type DrawingQualityKind = 'body-overlap' | 'caption-overlap' | 'caption-body' | 'wire-body' | 'wire-caption' | 'foreign-overlap' | 'lead-direction' | 'non-orthogonal' | 'retraced-route' | 'invalid-reference'
export interface DrawingQualityIssue { kind:DrawingQualityKind; objects:string[]; point?:XY; message:string }
export interface DrawingQualityReport {
  evidence:'estimated-geometry'; complete:boolean; visualAcceptance:false; issueCount:number;
  counts:Partial<Record<DrawingQualityKind,number>>; issues:DrawingQualityIssue[]; omitted:number; limitations:string[]
}
const overlap=(a:LayoutRect,b:LayoutRect)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top
const center=(r:LayoutRect):XY=>({x:(r.left+r.right)/2,y:(r.top+r.bottom)/2})
const segmentBox=(a:XY,b:XY):LayoutRect=>({left:Math.min(a.x,b.x),right:Math.max(a.x,b.x),top:Math.min(a.y,b.y),bottom:Math.max(a.y,b.y)})
/** Open interior test: touching a box boundary or a legal external pin is not penetration. */
function enters(a:XY,b:XY,r:LayoutRect):boolean {
  const epsilon=1e-6,low=[r.left+epsilon,r.top+epsilon],high=[r.right-epsilon,r.bottom-epsilon]
  let from=0,to=1
  for(let axis=0;axis<2;axis++){
    const start=axis?a.y:a.x,delta=(axis?b.y:b.x)-start
    if(!delta){if(start<low[axis]||start>high[axis])return false;continue}
    const t1=(low[axis]-start)/delta,t2=(high[axis]-start)/delta
    from=Math.max(from,Math.min(t1,t2));to=Math.min(to,Math.max(t1,t2))
    if(from>to)return false
  }
  return from<to
}
interface Obstacle {id:string;kind:'body'|'caption';box:LayoutRect}
/** A local index bounds inspect-time work; no per-frame canvas calculations. */
function obstacleIndex(obstacles:Obstacle[]){
  const cells=new Map<string,Obstacle[]>(),large:Obstacle[]=[],size=160
  const range=(r:LayoutRect)=>[Math.floor(r.left/size),Math.floor(r.right/size),Math.floor(r.top/size),Math.floor(r.bottom/size)]
  for(const obstacle of obstacles){const [x0,x1,y0,y1]=range(obstacle.box)
    if((x1-x0+1)*(y1-y0+1)>256){large.push(obstacle);continue}
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const key=x+','+y;cells.set(key,[...(cells.get(key)??[]),obstacle])}
  }
  return (box:LayoutRect)=>{const [x0,x1,y0,y1]=range(box)
    if((x1-x0+1)*(y1-y0+1)>4096)return obstacles
    const found=new Set(large);for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)for(const item of cells.get(x+','+y)??[])found.add(item)
    return [...found]
  }
}

/** Read-only estimate of the same displayed wire/body/caption geometry. A clean
 * report is not screenshot acceptance; original symbol and font bounds can differ. */
export function inspectDrawingQuality(drawing:Drawing|undefined,options:{models?:readonly ImportedSpiceModel[]}={}):DrawingQualityReport {
  const report:DrawingQualityReport={evidence:'estimated-geometry',complete:true,visualAcceptance:false,issueCount:0,counts:{},issues:[],omitted:0,limitations:['符号本体与文字为共享几何估计，不含浏览器字体实测、探针标牌或波形图框。','功能分区、闭环可读性与原始厂商符号仍需图面审阅；普通交叉不算电气连接。']}
  if(!drawing)return report
  const seen=new Set<string>(),maxIssues=120,maxChecks=200000
  let checks=0
  const budget=()=>{if(++checks<=maxChecks)return true;report.complete=false;return false}
  const add=(issue:DrawingQualityIssue)=>{const key=issue.kind+':'+[...issue.objects].sort().join('|');if(seen.has(key))return;seen.add(key)
    report.issueCount++;report.counts[issue.kind]=(report.counts[issue.kind]??0)+1
    if(report.issues.length<maxIssues)report.issues.push(issue);else report.omitted++
  }
  try{
    const models=new Map((options.models??[]).map(model=>[model.kind+':'+model.id.toLowerCase(),model]))
    const obstacles:Obstacle[]=drawing.devices.flatMap(device=>{
      const model=models.get(device.kind+':'+device.value.toLowerCase()),symbol=model?presentedModelSymbol(model,device):undefined
      const external=hasOriginalOlbCaptions(symbol)?[]:deviceCaptionRects(device,0,device.kind==='X'?{modelBounds:modelDeviceBounds(device,symbol)}:undefined).map((box,index)=>({id:device.id+':'+(index?'value':'ref'),kind:'caption' as const,box}))
      const native=symbol?.shape==='ltspice'?displayedSymbolTexts(symbol as LtspiceSymbol,device).map((text,index)=>{
        const points=symbolTextExtent(text)
        return {id:device.id+':symbol-text-'+index,kind:'caption' as const,box:{left:device.x+Math.min(...points.map(p=>p.x)),right:device.x+Math.max(...points.map(p=>p.x)),top:device.y+Math.min(...points.map(p=>p.y)),bottom:device.y+Math.max(...points.map(p=>p.y))}}
      }):[]
      return [{id:device.id,kind:'body' as const,box:symbolBodyRect(device,0)},...external,...native]
    })
    const nearby=obstacleIndex(obstacles)
    obstaclePairs: for(const a of obstacles)for(const b of nearby(a.box)){
      if(a.id>=b.id)continue
      if(!budget())break obstaclePairs
      if(!overlap(a.box,b.box))continue
      if(a.kind==='body'&&b.id.startsWith(a.id+':symbol-text-')||b.kind==='body'&&a.id.startsWith(b.id+':symbol-text-'))continue
      const kind=a.kind==='body'&&b.kind==='body'?'body-overlap':a.kind==='caption'&&b.kind==='caption'?'caption-overlap':'caption-body'
      add({kind,objects:[a.id,b.id],point:center(a.box),message:a.id+' 与 '+b.id+' 的估计图形范围相交'})
    }
    const topology=wireNetTopology(drawing),lanes=new Map<string,{id:string;net:string;a:XY;b:XY;start:number;end:number}[]>()
    wireChecks: for(const wire of drawing.wires){
      const points=wirePoints(drawing,wire),net=topology.net(wire.from)
      for(const [terminal,at,next]of [[wire.from,points[0],points[1]],[wire.to,points.at(-1),points.at(-2)]] as const){
        if(!at||!next)continue
        const direction=terminalLeadDirection(drawing,terminal)
        if(direction&&((next.x-at.x)*direction.x+(next.y-at.y)*direction.y<=0||(next.x-at.x)*direction.y-(next.y-at.y)*direction.x!==0))
          add({kind:'lead-direction',objects:[wire.id,'device'in terminal?terminal.device+':pin'+terminal.pin:terminal.junction],point:at,message:wire.id+' 未沿真实引脚出口方向引出'})
      }
      for(let i=1;i<points.length;i++){
        const a=points[i-1],b=points[i];if(a.x===b.x&&a.y===b.y)continue
        const horizontal=a.y===b.y,vertical=a.x===b.x
        if(!horizontal&&!vertical)add({kind:'non-orthogonal',objects:[wire.id],point:a,message:wire.id+' 含斜线；导入原线保持，需独立审阅正交化'})
        if(i>1){const p=points[i-2];if((a.x-p.x)*(b.x-a.x)+(a.y-p.y)*(b.y-a.y)<0&&((a.x-p.x)*(b.y-a.y)-(a.y-p.y)*(b.x-a.x)===0))add({kind:'retraced-route',objects:[wire.id],point:a,message:wire.id+' 有共线反向折返'})}
        for(const obstacle of nearby(segmentBox(a,b))){
          if(!budget())break wireChecks
          if(enters(a,b,obstacle.box))add({kind:obstacle.kind==='body'?'wire-body':'wire-caption',objects:[wire.id,obstacle.id],point:a,message:wire.id+' 穿过 '+obstacle.id+' 的估计范围'})
        }
        if(horizontal||vertical){const key=(horizontal?'h:':'v:')+(horizontal?a.y:a.x),start=Math.min(horizontal?a.x:a.y,horizontal?b.x:b.y),end=Math.max(horizontal?a.x:a.y,horizontal?b.x:b.y)
          lanes.set(key,[...(lanes.get(key)??[]),{id:wire.id,net,a,b,start,end}])}
      }
    }
    laneChecks: for(const spans of lanes.values()){
      spans.sort((a,b)=>a.start-b.start||a.end-b.end)
      for(let i=0;i<spans.length;i++)for(let j=i+1;j<spans.length&&spans[j].start<spans[i].end;j++){
        if(!budget())break laneChecks
        const a=spans[i],b=spans[j];if(!spansOverlap(a.a,a.b,b.a,b.b))continue
        if(a.id===b.id){add({kind:'retraced-route',objects:[a.id],point:a.a,message:a.id+' 的同一路线重复经过公共线段'});continue}
        if(a.net===b.net)continue
        add({kind:'foreign-overlap',objects:[a.id,b.id],point:a.a,message:a.id+' 与 '+b.id+' 属于不同网络却共线重合'})
      }
    }
  }catch(error){report.complete=false;add({kind:'invalid-reference',objects:['drawing'],message:error instanceof Error?error.message:'无效图形引用，未完成检查'})}
  if(!report.complete)report.limitations.push('检查未完成：达到计算预算或引用无效，不能以未列出的冲突数为零。')
  return report
}
