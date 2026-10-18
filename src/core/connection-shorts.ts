import {terminalKey} from './drawing-geometry'
import type {Drawing} from './drawing'

export interface ConnectionShort {deviceId:string; pins:[number,number]; node:string; wireIds:string[]; message:string}

/** Only conductive connections count. A normal path through another device
 * must never be mistaken for a wire bypass. */
export function connectionShorts(drawing:Drawing,nodes:Map<string,string>):ConnectionShort[] {
  const graph=new Map<string,{to:string;wireId?:string}[]>()
  const join=(a:string,b:string,wireId?:string)=>{
    graph.set(a,[...(graph.get(a)??[]),{to:b,wireId}])
    graph.set(b,[...(graph.get(b)??[]),{to:a,wireId}])
  }
  for(const wire of drawing.wires)join(terminalKey(wire.from),terminalKey(wire.to),wire.id)
  const labels=new Map<string,string>()
  for(const label of drawing.labels??[]){const name=label.name.toLowerCase(),key=terminalKey(label.at),first=labels.get(name);if(first)join(first,key);else labels.set(name,key)}
  const grounds=drawing.devices.filter(d=>d.kind==='GND')
  for(const ground of grounds.slice(1))join(`${grounds[0].id}:0`,`${ground.id}:0`)
  const path=(from:string,to:string)=>{
    const previous=new Map<string,{from:string;wireId?:string}>(),queue=[from],seen=new Set(queue)
    for(let i=0;i<queue.length&&!seen.has(to);i++)for(const edge of graph.get(queue[i])??[])if(!seen.has(edge.to)){seen.add(edge.to);previous.set(edge.to,{from:queue[i],wireId:edge.wireId});queue.push(edge.to)}
    const wires:string[]=[]
    for(let at=to;at!==from;){const edge=previous.get(at);if(!edge)break;if(edge.wireId)wires.push(edge.wireId);at=edge.from}
    return wires.reverse()
  }
  return drawing.devices.flatMap(device=>{
    // Collector-base / gate-drain ties can implement normal feedback; check
    // the main conduction pair, not every pair on a multi-terminal device.
    const pins:[number,number]|null=['R','C','L','D','V','I'].includes(device.kind)?[0,1]:['Q','M','J'].includes(device.kind)?[0,2]:null
    if(!pins)return []
    const a=`${device.id}:${pins[0]}`,b=`${device.id}:${pins[1]}`,node=nodes.get(a)
    if(node===undefined||node!==nodes.get(b))return []
    const wireIds=path(a,b)
    const pair=device.kind==='Q'?'集电极与发射极':device.kind==='M'||device.kind==='J'?'漏极与源极':'两端'
    return [{deviceId:device.id,pins,node,wireIds,message:`${device.id} ${pair}被短接到同一节点 ${node.toUpperCase()}；器件已被旁路${wireIds.length?`（连接路径：${wireIds.join(' → ')}）`:'（同名标签或接地连接）'}`}]
  })
}
