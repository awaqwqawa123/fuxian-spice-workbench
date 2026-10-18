import { parseQuantity, type Project } from './circuit'
import { circuitGraph } from './circuit'
import { compileDrawing, terminalKey, terminalPosition, type Drawing, type Terminal } from './drawing'
export interface SolverOptions {
  method?: 'trap'|'gear'
  reltol?:string; abstol?:string; vntol?:string; chgtol?:string; gmin?:string; trtol?:string; itl1?:string; itl4?:string
  maxord?:'1'|'2'
}
export interface NodeVoltageSetting { at:Terminal; value:string }
export interface ParseSimulationOptions { allowDraft?:boolean }
const optionRanges:Record<string,[number,number]>={reltol:[1e-12,.1],abstol:[1e-18,1],vntol:[1e-15,1],chgtol:[1e-24,1],gmin:[1e-18,.01],trtol:[.1,100],itl1:[1,10000],itl4:[1,10000]}
function solverNumber(key:string,value:string):number {
 const quantity=key==='abstol'?'current':key==='vntol'?'voltage':'gain'
 const numeric=key==='chgtol'?value.trim().replace(/(?:coulombs?|C)$/i,''):value
 return parseQuantity(numeric,quantity)
}
const record=(value:unknown,field:string):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${field}：需要对象`)
 return value as Record<string,unknown>
}
export function parseSolverOptions(input:unknown,options:ParseSimulationOptions={}):SolverOptions {
 const item=record(input,'project.solver'), clean:SolverOptions={}
 for(const key of Object.keys(item)) {
  const value=item[key]
  if(!['method','maxord',...Object.keys(optionRanges)].includes(key))throw new Error(`project.solver.${key}：不支持该求解器选项`)
  if(value===undefined)continue
  if(key==='method') { if(value!=='trap'&&value!=='gear')throw new Error('project.solver.method：只支持 trap 或 gear'); clean.method=value;continue }
  if(key==='maxord') { if(value!=='1'&&value!=='2')throw new Error('project.solver.maxord：只支持 1 或 2'); clean.maxord=value;continue }
  if(typeof value!=='string'||value.length>40||/[\r\n]/.test(value))throw new Error(`project.solver.${key}：需要最多 40 字符的数值字符串`)
  if(!value.trim())continue
  if(!options.allowDraft){
   let number:number
   try{number=solverNumber(key,value)}catch(error){throw new Error(`project.solver.${key}：${(error as Error).message}`)}
   const [low,high]=optionRanges[key]
   if(number<low||number>high||(['itl1','itl4'].includes(key)&&!Number.isInteger(number)))throw new Error(`project.solver.${key}：允许范围 ${low}～${high}${['itl1','itl4'].includes(key)?'，需要整数':''}`)
  }
  Object.assign(clean,{[key]:value})
 }
 return clean
}
export function parseNodeVoltageSettings(input:unknown,field:'initialConditions'|'nodeSets',drawing?:Drawing,options:ParseSimulationOptions={}):NodeVoltageSetting[]{
 if(!Array.isArray(input)||input.length>80)throw new Error(`project.${field}：需要最多 80 个节点设置的数组`)
 return input.map((value,index)=>{
  const prefix=`project.${field}[${index}]`,item=record(value,prefix),at=record(item.at,`${prefix}.at`)
  let terminal:Terminal
  if(typeof at.device==='string'&&/^[A-Za-z][A-Za-z0-9_]*$/.test(at.device)&&Number.isInteger(at.pin)&&Number(at.pin)>=0&&Number(at.pin)<32&&!('junction' in at))terminal={device:at.device,pin:at.pin as number}
  else if(typeof at.junction==='string'&&/^J[A-Za-z0-9_]*$/.test(at.junction)&&!('device' in at))terminal={junction:at.junction}
  else throw new Error(`${prefix}.at：需要器件引脚或连接点，例如 {device:"C1",pin:0}`)
  if(drawing&&!options.allowDraft)try{terminalPosition(drawing,terminal)}catch{throw new Error(`${prefix}.at：端点 ${terminalKey(terminal)} 不存在，器件或引脚可能已删除`)}
  if(typeof item.value!=='string'||item.value.length>40||/[\r\n]/.test(item.value))throw new Error(`${prefix}.value：需要最多 40 字符的电压字符串`)
  if(!options.allowDraft)try{const voltage=parseQuantity(item.value,'voltage');if(Math.abs(voltage)>1000)throw new Error('电压允许范围 -1000～1000 V')}catch(error){throw new Error(`${prefix}.value：${(error as Error).message}`)}
  return {at:terminal,value:item.value}
 })
}
function projectNodes(project:Project):Map<string,string>{
 if(project.template==='custom'&&project.drawing)return compileDrawing(project.drawing).nodes
 const nodes=new Map<string,string>()
 for(const part of circuitGraph(project).parts)part.nodes.forEach((node,pin)=>nodes.set(`${part.id}:${pin}`,node))
 return nodes
}
export function nodeVoltageDirectives(project:Project):string[]{
 const nodes=projectNodes(project), lines:string[]=[]
 for(const [field,command] of [['initialConditions','.ic'],['nodeSets','.nodeset']] as const){
  if(!project[field]?.length)continue
  const items=parseNodeVoltageSettings(project[field],field,project.drawing),assignments=new Map<string,number>()
  items.forEach((item,index)=>{
   const prefix=`project.${field}[${index}]`,node=nodes.get(terminalKey(item.at)),number=parseQuantity(item.value,'voltage')
   if(node===undefined)throw new Error(`${prefix}.at：端点 ${terminalKey(item.at)} 不在当前电路中`)
   if(node==='0'){if(number!==0)throw new Error(`${prefix}.value：接地节点不能设置非零电压`);return}
   const previous=assignments.get(node)
   if(previous!==undefined&&previous!==number)throw new Error(`${prefix}.value：同一网络 ${node} 与前一个设置冲突（${previous} V 与 ${number} V）`)
   assignments.set(node,number)
  })
  if(assignments.size)lines.push(`${command} ${[...assignments].map(([node,value])=>`V(${node})=${value}`).join(' ')}`)
 }
 return lines
}
export function solverOptionsDirective(input?:SolverOptions):string {
 const options=parseSolverOptions(input??{}), values:Record<string,string|number>={reltol:'1e-5'}
 for(const [key,value] of Object.entries(options))values[key]=['method','maxord'].includes(key)?value:solverNumber(key,value)
 return `.options ${Object.entries(values).map(([key,value])=>`${key}=${value}`).join(' ')}`
}
export function dcSource(project:Project):{id:string;kind:'voltage'|'current'}{
 const id=project.dc?.sourceId??(project.template==='custom'?project.drawing?.sourceId||'Vref':'V1')
 if(project.template!=='custom'){if(id!=='V1')throw new Error(`project.dc.sourceId：模板电路没有源 ${id}`);return {id,kind:'voltage'}}
 const source=project.drawing?.devices.find(device=>device.id===id)
 if(!source||!['V','I'].includes(source.kind))throw new Error(`project.dc.sourceId：${id} 不是现有独立电压或电流源`)
 return {id,kind:source.kind==='I'?'current':'voltage'}
}
export function noiseNegativeNode(project:Project):string {
 if(!project.noise?.negative)return '0'
 const node=projectNodes(project).get(terminalKey(project.noise.negative))
 if(node===undefined)throw new Error(`project.noise.negative：端点 ${terminalKey(project.noise.negative)} 不在当前电路中`)
 return node
}
export function validateSimulationOptions(project:Project):string[]{
 const errors:string[]=[]
 try{parseSolverOptions(project.solver??{})}catch(error){errors.push((error as Error).message)}
 try{nodeVoltageDirectives(project)}catch(error){errors.push((error as Error).message)}
 try{const negative=noiseNegativeNode(project);if(project.analysis==='noise'&&project.drawing?.output){const output=projectNodes(project).get(terminalKey(project.drawing.output));if(output===negative)throw new Error('project.noise.negative：噪声输出正负端不能是同一网络')}}catch(error){errors.push((error as Error).message)}
 const interval=project.noise?.summaryInterval
 if(interval!==undefined&&(!Number.isInteger(interval)||interval<0||interval>10000))errors.push('project.noise.summaryInterval：需要 0～10000 的整数（0 只输出总噪声）')
 return errors
}

export function simulationControlDirectives(project:Project):string[]{return [solverOptionsDirective(project.solver),...nodeVoltageDirectives(project)]}
