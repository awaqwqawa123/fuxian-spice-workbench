import { terminalKey } from './drawing-geometry'
import type { Drawing, NetLabel } from './drawing'

/** Keep one annotation per name and physical conductor. Remote aliases must
 * remain visible, and saved label identities remain available for editing. */
export function visibleNetLabels(drawing:Drawing):NetLabel[] {
  if(!drawing.labels?.length)return []
  const parents=new Map<string,string>()
  const root=(key:string):string=>{
    const parent=parents.get(key)
    if(!parent){parents.set(key,key);return key}
    if(parent===key)return key
    const result=root(parent);parents.set(key,result);return result
  }
  for(const wire of drawing.wires){
    const a=root(terminalKey(wire.from)),b=root(terminalKey(wire.to))
    if(a!==b)parents.set(b,a)
  }
  const seen=new Map<string,Set<string>>()
  return (drawing.labels??[]).filter(label=>{
    if((label.style??'text')!=='text')return true
    const name=label.name.toLowerCase(),conductor=root(terminalKey(label.at))
    const conductors=seen.get(name)??new Set<string>()
    if(conductors.has(conductor))return false
    conductors.add(conductor);seen.set(name,conductors);return true
  })
}
