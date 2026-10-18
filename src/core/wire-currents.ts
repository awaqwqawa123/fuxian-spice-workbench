import { canProbeCurrent, resolveBranchCurrent } from './branch-currents'
import { pinsFor } from './devices'
import { sameTerminal, terminalKey, type Drawing, type Terminal } from './drawing'
import type { WireAnchor } from './probe-placement'
import type { Complex, Result } from './results'

/** Identity includes endpoints so a deleted/reused wire id cannot read old samples. */
export interface WireCurrentTarget { wireId:string; from:Terminal; to:Terminal; direction:1|-1 }
type Term = { device:string; coefficient:number }
type Cut = { ok:true; plans:Term[][] } | { ok:false; reason:string }
export const wireCurrentName = (target:WireCurrentTarget) => `I(${target.wireId}${target.direction===1?' →':' ←'})`
export function hasWireCurrentTarget(drawing:Drawing,target:WireCurrentTarget):boolean {
  const wire=drawing.wires.find(w=>w.id===target.wireId)
  return !!wire&&sameTerminal(wire.from,target.from)&&sameTerminal(wire.to,target.to)
}

/** Remove only the measured conductor. All other wires, labels and grounds remain ideal connections. */
export function wireCurrentCut(drawing:Drawing,target:WireCurrentTarget):Cut {
  if(!hasWireCurrentTarget(drawing,target))return{ok:false,reason:'此导线已删除或接线已改变，不能读取旧导线的电流。'}
  const graph=new Map<string,Set<string>>()
  const add=(a:string,b:string)=>{if(!graph.has(a))graph.set(a,new Set());if(!graph.has(b))graph.set(b,new Set());graph.get(a)!.add(b);graph.get(b)!.add(a)}
  for(const wire of drawing.wires)if(wire.id!==target.wireId)add(terminalKey(wire.from),terminalKey(wire.to))
  const labels=new Map<string,string[]>()
  for(const label of drawing.labels??[]){const key=label.name.toLowerCase();labels.set(key,[...(labels.get(key)??[]),terminalKey(label.at)])}
  const grounds=drawing.devices.filter(d=>d.kind==='GND').map(d=>`${d.id}:0`)
  for(const group of [...labels.values(),grounds])for(const key of group.slice(1))add(group[0],key)
  const reach=(start:string)=>{const found=new Set([start]),queue=[start];for(let n=0;n<queue.length;n++)for(const next of graph.get(queue[n])??[])if(!found.has(next)){found.add(next);queue.push(next)}return found}
  const from=reach(terminalKey(target.from))
  if(from.has(terminalKey(target.to)))return{ok:false,reason:'这段导线存在另一条理想导线或同名网络路径，环路中的电流分配不唯一；请测量环路外的支路或器件电流。'}
  const to=reach(terminalKey(target.to)),plans:Term[][]=[]
  // KCL: positive wire flow is from → to. The two cuts give equivalent sums;
  // keep both so a missing/unsupported vector on one side can use the other.
  for(const [side,sign] of [[from,-1],[to,1]] as const){
    const terms:Term[]=[];let supported=true
    const includesGround=grounds.some(key=>side.has(key))
    for(const device of drawing.devices){
      if(device.kind==='GND')continue
      const pins=pinsFor(device).filter(pin=>side.has(`${device.id}:${pin}`))
      // The compiler's ideal OP is Eout out 0 in+ in- gain: its output has an
      // implicit return to global ground. This unknown current must block the
      // ground-side sum, even when none of the symbol's three pins is there.
      // SW/VSW, RELAY, LDO and XFMR use only their explicit external terminals.
      if((device.kind==='OPA'||device.kind==='CMP')&&includesGround){supported=false;break}
      if(device.kind==='OP'){
        if(includesGround||pins.includes(2)){supported=false;break}
        continue // Ideal E control inputs draw exactly zero current.
      }
      if(!pins.length)continue
      if(!canProbeCurrent(device.kind)){supported=false;break}
      const coefficient=pins.reduce<number>((sum,pin)=>sum+(pin===0?1:-1),0)*sign*target.direction
      if(coefficient)terms.push({device:device.id,coefficient})
    }
    if(supported)plans.push(terms)
  }
  return plans.length?{ok:true,plans:plans.sort((a,b)=>a.length-b.length)}:{ok:false,reason:'导线两侧都包含尚未保存引脚电流的器件，暂时无法可靠计算这段导线电流。'}
}

export function createWireCurrentTarget(drawing:Drawing,anchor:WireAnchor,direction:1|-1=1):WireCurrentTarget {
  const wire=drawing.wires.find(w=>w.id===anchor.wireId)
  if(!wire)throw new Error('请将电流探针放在一段现有导线上。')
  const target:WireCurrentTarget={wireId:wire.id,from:{...wire.from},to:{...wire.to},direction}
  const cut=wireCurrentCut(drawing,target)
  if(!cut.ok)throw new Error(cut.reason)
  return target
}

export function resolveWireCurrent(result:Result,target:WireCurrentTarget):{values:number[];complex?:Complex[]}|null {
  if(!result.project.drawing)return null
  const cut=wireCurrentCut(result.project.drawing,target)
  if(!cut.ok)return null
  for(const plan of cut.plans){
    const branches=plan.map(term=>({...term,trace:resolveBranchCurrent(result,term.device)}))
    if(branches.some(b=>!b.trace||result.analysis==='ac'&&!b.trace.complex))continue
    if(result.analysis==='ac'){
      const complex=Array.from({length:result.points},(_,index)=>branches.reduce((sum,b)=>({real:sum.real+b.trace!.complex![index].real*b.coefficient,img:sum.img+b.trace!.complex![index].img*b.coefficient}),{real:0,img:0}))
      if(complex.some(v=>!Number.isFinite(v.real)||!Number.isFinite(v.img)))continue
      return{values:complex.map(v=>v.real),complex}
    }
    const values=Array.from({length:result.points},(_,index)=>branches.reduce((sum,b)=>sum+b.trace!.values[index]*b.coefficient,0))
    if(values.every(Number.isFinite))return{values}
  }
  return null
}

export function wireCurrentUnavailableReason(result:Result,target:WireCurrentTarget):string|null {
  if(!result.project.drawing)return'此仿真结果不包含导线连接信息。'
  const cut=wireCurrentCut(result.project.drawing,target)
  if(!cut.ok)return cut.reason
  return resolveWireCurrent(result,target)?null:'本次仿真缺少计算这段导线所需的支路电流；请重新运行。部分器件的 AC 引脚电流暂不支持。'
}
