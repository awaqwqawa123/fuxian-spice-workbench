import type { Drawing, Terminal, Wire, XY } from './drawing'
import { pinsFor } from './devices'
import { terminalKey, terminalPosition } from './drawing-geometry'

/** Routing identity comes from terminals, labels and ground, never from pixels.
 * This deliberately has no dependency on rendered wires or compileDrawing. */
export function wireNetTopology(drawing:Drawing, extra?:Wire) {
  const parent=new Map<string,string>(),terminals:Terminal[]=[]
  for(const device of drawing.devices)for(const pin of pinsFor(device))terminals.push({device:device.id,pin})
  for(const junction of drawing.junctions)terminals.push({junction:junction.id})
  for(const terminal of terminals)parent.set(terminalKey(terminal),terminalKey(terminal))
  const root=(id:string):string=>{
    const p=parent.get(id)
    if(p===undefined)throw new Error('电路引用了无效引脚')
    if(p===id)return id
    const r=root(p);parent.set(id,r);return r
  }
  const union=(a:Terminal,b:Terminal)=>parent.set(root(terminalKey(b)),root(terminalKey(a)))
  for(const wire of drawing.wires)union(wire.from,wire.to)
  if(extra)union(extra.from,extra.to)
  const labels=new Map<string,Terminal>()
  for(const label of drawing.labels??[]){const name=label.name.toLowerCase(),previous=labels.get(name);if(previous)union(previous,label.at);else labels.set(name,label.at)}
  const grounds=drawing.devices.filter(device=>device.kind==='GND')
  for(const device of grounds.slice(1))union({device:grounds[0].id,pin:0},{device:device.id,pin:0})
  return {
    net:(terminal:Terminal)=>root(terminalKey(terminal)),
    foreignTerminals:(wire:Wire):XY[]=>{
      const net=root(terminalKey(wire.from))
      return terminals.filter(terminal=>root(terminalKey(terminal))!==net).map(terminal=>terminalPosition(drawing,terminal))
    },
  }
}

export function spansOverlap(a:XY,b:XY,c:XY,d:XY):boolean {
  return a.x===b.x&&c.x===d.x&&a.x===c.x&&Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y))<Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y))
    ||a.y===b.y&&c.y===d.y&&a.y===c.y&&Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))<Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))
}

export function pointOnSpan(point:XY,a:XY,b:XY):boolean {
  return a.x===b.x&&point.x===a.x&&point.y>=Math.min(a.y,b.y)&&point.y<=Math.max(a.y,b.y)
    ||a.y===b.y&&point.y===a.y&&point.x>=Math.min(a.x,b.x)&&point.x<=Math.max(a.x,b.x)
}
