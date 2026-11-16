import { pinsFor } from './devices'
import { GRID, MAX_WIRE_WAYPOINTS, nextId, pinPosition, wirePoints, type Device, type Drawing, type Terminal, type Wire, type XY } from './drawing'
import { followsLead, terminalLeadDirection } from './wire-lead-route'
import { pointOnSpan, wireNetTopology } from './wire-net-topology'
import { type WireSnapIndex } from './wire-routing'
import type { Measurement } from './probes'
import type { WireAnchor } from './probe-placement'

const samePoint=(a:XY,b:XY)=>a.x===b.x&&a.y===b.y
const distance=(a:XY,b:XY)=>Math.hypot(a.x-b.x,a.y-b.y)
const between=(value:number,a:number,b:number)=>value>=Math.min(a,b)&&value<=Math.max(a,b)
const EPSILON=1e-10
type Segment=WireSnapIndex['segments'][number]
export interface SeriesInsertion {
  wireId:string; deviceId:string; span:Segment
  first:{terminal:Terminal;point:XY}; second:{terminal:Terminal;point:XY}
}
type SeriesTarget={kind:'ready';plan:SeriesInsertion}|{kind:'blocked';reason:string}|null
const blocked=(reason:string):SeriesTarget=>({kind:'blocked',reason})
const belongs=(t:Terminal,deviceId:string)=>'device' in t&&t.device===deviceId

function intersects(a:XY,b:XY,segment:Segment):boolean {
  const {from:c,to:d}=segment
  if(a.y===b.y){
    if(c.y===d.y)return a.y===c.y&&Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))<=Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))
    return between(c.x,a.x,b.x)&&between(a.y,c.y,d.y)
  }
  if(c.x===d.x)return a.x===c.x&&Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y))<=Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y))
  return between(c.y,a.y,b.y)&&between(a.x,c.x,d.x)
}

/** Use the same cached spans as the drawing. Preview does not re-route wires or change connectivity. */
export function findSeriesInsertion(base:Drawing,index:WireSnapIndex,part:Device,aim:XY,screenScale:number):SeriesTarget {
  const pins=pinsFor(part)
  if(pins.length!==2||base.wires.some(w=>belongs(w.from,part.id)||belongs(w.to,part.id))||
    base.labels?.some(label=>belongs(label.at,part.id))||base.output&&belongs(base.output,part.id))return null
  const [a,b]=pins.map(pin=>({terminal:{device:part.id,pin},point:pinPosition(part,pin)}))
  const horizontal=a.point.y===b.point.y
  if(samePoint(a.point,b.point)||!horizontal&&a.point.x!==b.point.x)return null
  const axis=horizontal?'x':'y',cross=horizontal?'y':'x'
  const scale=Number.isFinite(screenScale)&&screenScale>0?screenScale:1
  const radius=Math.min(GRID/2,10/scale)
  const nearby=index.segments.filter(s=>s.from[cross]===s.to[cross]&&s.from[axis]!==s.to[axis]&&s.from[cross]===a.point[cross]&&Math.abs(aim[cross]-s.from[cross])<=radius&&between((a.point[axis]+b.point[axis])/2,s.from[axis],s.to[axis]))
  if(!nearby.length){
    // Require a direct hit for a rotation hint so nearby intentional free
    // placements still behave normally, even when they snap to the same grid.
    const opposite=index.segments.some(s=>s.from[axis]===s.to[axis]&&s.from[cross]!==s.to[cross]&&
      Math.abs(aim[axis]-s.from[axis])<=Math.min(radius,4/scale)&&between(aim[cross],s.from[cross],s.to[cross]))
    return opposite?blocked('器件与导线方向不一致，请按 R 旋转后再放置。'):null
  }
  const fits=nearby.filter(s=>pointOnSpan(a.point,s.from,s.to)&&pointOnSpan(b.point,s.from,s.to)&&
    ![a.point,b.point].some(p=>samePoint(p,s.from)||samePoint(p,s.to)))
  if(!fits.length)return blocked('直线段太短，请移到离引脚或拐角更远的位置。')
  if(fits.length!==1)return blocked('这里有重叠导线，请移到单独的一段直线上。')
  const span=fits[0]
  const [first,second]=distance(span.from,a.point)<distance(span.from,b.point)?[a,b]:[b,a]
  const symbols={...base,devices:[part]}
  if([first,second].some(pin=>{const lead=terminalLeadDirection(symbols,pin.terminal);return !lead||!lead.x&&!lead.y})||
    !followsLead(first.point,span.from,terminalLeadDirection(symbols,first.terminal))||
    !followsLead(second.point,span.to,terminalLeadDirection(symbols,second.terminal)))return blocked('这两个引脚的出口与导线方向不一致。')
  if(index.segments.some(other=>other!==span&&intersects(first.point,second.point,other))||
    index.terminals.some(t=>t.terminal&&!belongs(t.terminal,part.id)&&pointOnSpan(t.point,first.point,second.point)))return blocked('这里有交叉、分支或引脚，请移到一段独立的直线上。')
  return {kind:'ready',plan:{wireId:span.wireId,deviceId:part.id,span,first,second}}
}

export interface SeriesResult {
  drawing:Drawing; original:Wire; firstWire:Wire; secondWire:Wire; firstFraction:number; secondFraction:number
}
const pathLength=(points:XY[])=>points.reduce((sum,p,i)=>i?sum+distance(points[i-1],p):sum,0)

/** Preserve the wire's from → to direction on both remaining pieces. */
export function applySeriesInsertion(base:Drawing,placed:Drawing,plan:SeriesInsertion):SeriesResult {
  const original=base.wires.find(w=>w.id===plan.wireId)
  if(!original||(placed.wires.length!==base.wires.length||placed.wires.some((w,i)=>w!==base.wires[i]))||base.wires.length>=200)throw new Error('无法串入：导线已改变或数量已达上限。')
  const points=wirePoints(base,original),{span,first,second}=plan
  const segment=points.findIndex((p,i)=>i>0&&samePoint(points[i-1],span.from)&&samePoint(p,span.to))
  if(segment<1)throw new Error('无法串入：导线路径已改变。')
  const firstPath=[...points.slice(0,segment),first.point],secondPath=[second.point,...points.slice(segment)]
  const half=(id:string,from:Terminal,to:Terminal,path:XY[]):Wire=>{
    const waypoints=path.slice(1,-1)
    if(waypoints.length>MAX_WIRE_WAYPOINTS||waypoints.some(p=>p.x%GRID!==0||p.y%GRID!==0))throw new Error('无法串入：原导线拐点超出可保存范围。')
    return {id,from,to,bend:path[0].y===path[1].y?'hv':'vh',...(waypoints.length?{waypoints}:{})}
  }
  const firstWire=half(original.id,original.from,first.terminal,firstPath)
  const secondWire=half(nextId('W',base.wires),second.terminal,original.to,secondPath)
  const drawing={...placed,wires:base.wires.flatMap(w=>w.id===original.id?[firstWire,secondWire]:[w])}
  const nets=wireNetTopology(drawing)
  if(nets.net(first.terminal)===nets.net(second.terminal))throw new Error('无法串入：两侧仍被其他导线、地或同名网标连通。')
  for(const [wire,path] of [[firstWire,firstPath],[secondWire,secondPath]] as const){
    const rendered=wirePoints(drawing,wire)
    if(rendered.length!==path.length||rendered.some((point,i)=>!samePoint(point,path[i])))throw new Error('无法串入：两侧不能保留为原来的走线。')
  }
  const fullLength=pathLength(points)
  return {drawing,original,firstWire,secondWire,firstFraction:pathLength(firstPath)/fullLength,secondFraction:1-pathLength(secondPath)/fullLength}
}

/** Geometric attachment determines the side; each probe keeps its offset and current direction. */
export function remapSeriesMeasurements(result:SeriesResult,measurements:readonly Measurement[]):Measurement[] {
  const {original,firstWire,secondWire,firstFraction,secondFraction,drawing}=result
  const nets=wireNetTopology(drawing)
  return measurements.map(measurement=>{
    const remap=(anchor:WireAnchor)=>{
      const amount=anchor.fraction
      const side=amount<=firstFraction+EPSILON?firstWire:amount>=secondFraction-EPSILON?secondWire:null
      if(!side)throw new Error(`无法串入：切口内有探针 ${measurement.id}，请先把它移到器件的其中一侧。`)
      const fraction=side===firstWire?amount/firstFraction:(amount-secondFraction)/(1-secondFraction)
      return {side,anchor:{wireId:side.id,fraction:Math.min(1,Math.max(0,fraction))}}
    }
    if(measurement.kind==='voltage'){
      const mapTip=(at:Terminal,layout:typeof measurement.positiveLayout)=>{
        if(layout?.anchor?.wireId!==original.id)return {at,layout}
        const {side,anchor}=remap(layout.anchor),outer=side===firstWire?side.from:side.to
        return {at:nets.net(at)===nets.net(outer)?at:outer,layout:{...layout,anchor}}
      }
      const pos=mapTip(measurement.positive,measurement.positiveLayout)
      const neg=measurement.negative?mapTip(measurement.negative,measurement.negativeLayout):undefined
      return {...measurement,positive:pos.at,positiveLayout:pos.layout,...(neg?{negative:neg.at,negativeLayout:neg.layout}:{})}
    }
    if(measurement.wire?.wireId===original.id){
      const {side,anchor}=remap(measurement.layout?.anchor??{wireId:original.id,fraction:.5})
      return {id:measurement.id,kind:'current',wire:{wireId:side.id,from:side.from,to:side.to,direction:measurement.wire.direction},layout:{...measurement.layout,anchor}}
    }
    if(measurement.device&&measurement.layout?.anchor?.wireId===original.id){
      const {side,anchor}=remap(measurement.layout.anchor)
      if(nets.net({device:measurement.device,pin:0})!==nets.net(side.from))throw new Error(`无法串入：探针 ${measurement.id} 的图标与测量端分处切口两侧，请先移动探针。`)
      return {...measurement,layout:{...measurement.layout,anchor}}
    }
    return measurement
  })
}
