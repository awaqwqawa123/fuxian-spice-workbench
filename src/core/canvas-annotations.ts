import { pinsFor } from './devices'
import { pinPosition, terminalKey, wirePoints, type Drawing, type XY } from './drawing'

export interface NodeAnnotation { name:string; point:XY; horizontal:boolean }

/** One annotation per electrical net; explicit labels and I/O markers already name theirs. */
export function nodeAnnotations(drawing:Drawing,nodes:Map<string,string>,options:{includeNamed?:boolean}={}):NodeAnnotation[] {
  const reserved=new Set<string>()
  if(!options.includeNamed){
    reserved.add('0')
    for(const label of drawing.labels??[]){const name=nodes.get(terminalKey(label.at));if(name)reserved.add(name)}
    if(drawing.sourceId){const name=nodes.get(`${drawing.sourceId}:0`);if(name)reserved.add(name)}
    if(drawing.output){const name=nodes.get(terminalKey(drawing.output));if(name)reserved.add(name)}
  }
  const candidates=new Map<string,NodeAnnotation&{score:number}>()
  const add=(key:string,point:XY,score:number,horizontal=true)=>{
    const name=nodes.get(key)
    if(!name||reserved.has(name)||(candidates.get(name)?.score??-Infinity)>=score)return
    candidates.set(name,{name,point,horizontal,score})
  }
  // A wire's midpoint leaves pin labels and device captions free. Prefer a long
  // horizontal segment; isolated pins still get one small, useful annotation.
  for(const wire of drawing.wires){
    const points=wirePoints(drawing,wire)
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i],horizontal=a.y===b.y
      add(terminalKey(wire.from),{x:(a.x+b.x)/2,y:(a.y+b.y)/2},100+Math.hypot(b.x-a.x,b.y-a.y)+(horizontal?20:0),horizontal)
    }
  }
  for(const junction of drawing.junctions)add(junction.id,junction,10)
  for(const part of drawing.devices)for(const pin of pinsFor(part))add(`${part.id}:${pin}`,pinPosition(part,pin),0)
  return [...candidates.values()].map(({score:_score,...annotation})=>annotation)
}
