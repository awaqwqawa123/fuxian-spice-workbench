import { deviceCatalog } from './devices'
import type { Drawing, Terminal } from './drawing'
import type { Measurement } from './probes'

export interface AgentIdRename { path:string; from:string; to:string }

/** Probe references are validated in the submitted namespace before rewriting. */
export function normalizeAgentProbeIds(input:Measurement[], original:Drawing, renamedIds:AgentIdRename[]):Measurement[] {
  const probes=structuredClone(input),names=new Map(renamedIds.map(item=>[item.from,item.to]))
  const rename=(id:string,ids:string[],path:string)=>{
    if(!ids.includes(id))throw new Error(`${path} = ${JSON.stringify(id)} 引用了不存在的原始编号；不能猜测重编号后的测量目标。`)
    return names.get(id)??id
  }
  const devices=original.devices.map(item=>item.id),junctions=original.junctions.map(item=>item.id),wires=original.wires.map(item=>item.id)
  const terminal=(value:Terminal,path:string):Terminal=>'device'in value?{...value,device:rename(value.device,devices,`${path}.device`)}:{junction:rename(value.junction,junctions,`${path}.junction`)}
  probes.forEach((probe,index)=>{
    const path=`project.probes[${index}]`
    if(probe.kind==='voltage'){
      if(probe.positive)probe.positive=terminal(probe.positive,`${path}.positive`)
      if(probe.negative)probe.negative=terminal(probe.negative,`${path}.negative`)
    }else if(probe.wire){
      probe.wire.wireId=rename(probe.wire.wireId,wires,`${path}.wire.wireId`)
      if(probe.wire.from)probe.wire.from=terminal(probe.wire.from,`${path}.wire.from`)
      if(probe.wire.to)probe.wire.to=terminal(probe.wire.to,`${path}.wire.to`)
    }else probe.device=rename(probe.device,devices,`${path}.device`)
    for(const [key,layout] of Object.entries(probe).filter(([key])=>['layout','positiveLayout','negativeLayout'].includes(key))){
      const anchor=(layout as {anchor?:{wireId:string}})?.anchor
      if(anchor)anchor.wireId=rename(anchor.wireId,wires,`${path}.${key}.anchor.wireId`)
    }
  })
  return probes
}

/**
 * Agent-only compatibility for recognizable identifiers such as OP1/GND1/w0.
 * Called after structural validation. References are checked in the ORIGINAL
 * namespace before any allocation, so a dangling reference cannot accidentally
 * attach to a newly allocated ID. This never infers or changes connectivity.
 */
export function normalizeAgentDrawingIds(input:Drawing):{drawing:Drawing;renamedIds:AgentIdRename[]} {
  const drawing=structuredClone(input),renamedIds:AgentIdRename[]=[]
  const entries=[
    ...drawing.devices.map((item,index)=>({item,prefix:deviceCatalog[item.kind].prefix,path:`project.drawing.devices[${index}].id`})),
    ...drawing.junctions.map((item,index)=>({item,prefix:'J',path:`project.drawing.junctions[${index}].id`})),
    ...drawing.wires.map((item,index)=>({item,prefix:'W',path:`project.drawing.wires[${index}].id`})),
    ...(drawing.labels??[]).map((item,index)=>({item,prefix:'N',path:`project.drawing.labels[${index}].id`})),
  ]
  const seen=new Map<string,string>(),reserved=new Set<string>()
  for(const{item,prefix,path}of entries){
    if(item.id!==item.id.trim())throw new Error(`${path} = ${JSON.stringify(item.id.slice(0,80))} 不合法；编号不能包含空白，使用 ${prefix}1 等编号。`)
    const previous=seen.get(item.id)
    if(previous)throw new Error(`${path} = ${JSON.stringify(item.id)} 与 ${previous} 重复。所有器件、连接点、导线和标签的 ID 必须全局唯一；请分别编号并同步引用，不能自动猜测重复编号的连接。`)
    seen.set(item.id,path)
    if(new RegExp(`^${prefix}[1-9]\\d{0,4}$`).test(item.id))reserved.add(item.id)
    else if(!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(item.id)&&!(prefix==='G'&&item.id==='0'))throw new Error(`${path} = ${JSON.stringify(item.id.slice(0,80))} 不合法；使用 ${prefix} 加 1～99999 的整数，例如 ${prefix}1。仅可规范化最多 40 字符、字母开头的字母/数字/下划线别名。`)
  }
  const originalDevices=new Map(drawing.devices.map(item=>[item.id,item])),originalJunctions=new Set(drawing.junctions.map(item=>item.id))
  const checkTerminal=(terminal:Terminal,path:string)=>{
    if('device'in terminal){if(!originalDevices.has(terminal.device))throw new Error(`${path}.device = ${JSON.stringify(terminal.device)} 引用了不存在的器件；请使用 devices 中的原始 ID，不能猜测重编号后的引用。`)}
    else if(!originalJunctions.has(terminal.junction))throw new Error(`${path}.junction = ${JSON.stringify(terminal.junction)} 引用了不存在的连接点；请使用 junctions 中的原始 ID。`)
  }
  drawing.wires.forEach((wire,index)=>{checkTerminal(wire.from,`project.drawing.wires[${index}].from`);checkTerminal(wire.to,`project.drawing.wires[${index}].to`)})
  drawing.labels?.forEach((label,index)=>checkTerminal(label.at,`project.drawing.labels[${index}].at`))
  if(drawing.output)checkTerminal(drawing.output,'project.drawing.output')
  if(drawing.sourceId!==''&&originalDevices.get(drawing.sourceId)?.kind!=='V')throw new Error(`project.drawing.sourceId = ${JSON.stringify(drawing.sourceId)} 必须引用存在的 V 类型器件，例如 V1；未完成草图可用空字符串。`)

  const replacements=new Map<string,string>()
  for(const{item,prefix,path}of entries){
    if(new RegExp(`^${prefix}[1-9]\\d{0,4}$`).test(item.id))continue
    let number=1
    while(reserved.has(`${prefix}${number}`))number++
    const from=item.id,to=`${prefix}${number}`
    reserved.add(to);replacements.set(from,to);renamedIds.push({path,from,to});item.id=to
  }
  const rewrite=(terminal:Terminal):Terminal=>'device'in terminal?{...terminal,device:replacements.get(terminal.device)??terminal.device}:{junction:replacements.get(terminal.junction)??terminal.junction}
  drawing.wires=drawing.wires.map(wire=>({...wire,from:rewrite(wire.from),to:rewrite(wire.to)}))
  drawing.labels=drawing.labels?.map(label=>({...label,at:rewrite(label.at)}))
  drawing.sourceId=replacements.get(drawing.sourceId)??drawing.sourceId
  if(drawing.output)drawing.output=rewrite(drawing.output)
  return {drawing,renamedIds}
}
