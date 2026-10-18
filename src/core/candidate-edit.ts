import { parseProject, type Project } from './circuit'
import { deviceCatalog } from './devices'
import type { Device, NetLabel, Rotation, Terminal, Wire } from './drawing'
import { MAX_MEASUREMENT_PROBES, type Measurement } from './probes'
import { patchSourceParameters } from './sources'

/** Explicit IDs and complete references: this API never guesses aliases or deletes attachments. */
export type CandidateEditOperation =
  | { op:'set_value'; deviceId:string; value?:string; params?:Record<string,string> }
  | { op:'add_component'; device:Device }
  | { op:'remove_component'; deviceId:string }
  | { op:'connect'; wireId:string; from:Terminal; to:Terminal; bend?:Wire['bend'] }
  | { op:'disconnect'; wireId:string }
  | { op:'move_component'; deviceId:string; x:number; y:number; rotation?:Rotation; mirrored?:boolean }
  | { op:'set_probes'; probes:Measurement[] }
  | { op:'set_net_label'; label:NetLabel }
  | { op:'remove_net_label'; labelId:string }
  | { op:'set_reference_source'; deviceId:string }
  | { op:'set_output'; terminal:Terminal }

type Schema = {type?:string;properties?:Record<string,Schema>;required?:string[];additionalProperties?:boolean|Schema;items?:Schema;anyOf?:Schema[];enum?:unknown[];const?:unknown;minimum?:number;maximum?:number;multipleOf?:number;minItems?:number;maxItems?:number;maxLength?:number;pattern?:string}
const string=(maxLength=80):Schema=>({type:'string',maxLength})
const id=(prefix:string):Schema=>({...string(40),pattern:`^${prefix}[1-9]\\d{0,4}$`})
const deviceId=id(`(?:${[...new Set(Object.values(deviceCatalog).map(item=>item.prefix))].join('|')})`)
const coordinate:Schema={type:'number',minimum:-20000,maximum:20000,multipleOf:20}
const rotation:Schema={type:'integer',enum:[0,90,180,270]}
const object=(properties:Record<string,Schema>,required=Object.keys(properties)):Schema=>({type:'object',properties,required,additionalProperties:false})
const terminal:Schema={anyOf:[object({device:deviceId,pin:{type:'integer',minimum:0,maximum:31}}),object({junction:id('J')})]}
const point=object({x:{type:'integer',minimum:-2560,maximum:2560},y:{type:'integer',minimum:-2560,maximum:2560}})
const params:Schema={type:'object',additionalProperties:string(4000)}
const device=object({id:deviceId,kind:{type:'string',enum:Object.keys(deviceCatalog)},value:string(40),x:coordinate,y:coordinate,rotation,mirrored:{type:'boolean'},groundStyle:{type:'string',enum:['earth','signal','chassis']},params,pins:{type:'array',minItems:2,maxItems:32,items:string(40)},pinPositions:{type:'array',minItems:2,maxItems:32,items:point}},['id','kind','value','x','y','rotation'])
const probeLayout=object({offset:object({x:{type:'number',minimum:-20000,maximum:20000},y:{type:'number',minimum:-20000,maximum:20000}}),anchor:object({wireId:id('W'),fraction:{type:'number',minimum:0,maximum:1}})},[])
const probe=object({id:id('P'),kind:{type:'string',enum:['voltage','current']},positive:terminal,negative:terminal,device:deviceId,wire:object({wireId:id('W'),from:terminal,to:terminal,direction:{type:'integer',enum:[1,-1]}}),positiveLayout:probeLayout,negativeLayout:probeLayout,layout:probeLayout},['id','kind'])
const label=object({id:id('N'),name:string(40),at:terminal,style:{type:'string',enum:['text','power','input','output','bidirectional']},rotation},['id','name','at'])
const operation=(op:CandidateEditOperation['op'],properties:Record<string,Schema>,required=Object.keys(properties))=>object({op:{const:op},...properties},['op',...required])
export const candidateEditOperationsSchema:Schema={type:'array',minItems:1,maxItems:32,items:{anyOf:[
  operation('set_value',{deviceId,value:string(40),params},['deviceId']),
  operation('add_component',{device}),operation('remove_component',{deviceId}),
  operation('connect',{wireId:id('W'),from:terminal,to:terminal,bend:{type:'string',enum:['hv','vh']}},['wireId','from','to']),
  operation('disconnect',{wireId:id('W')}),
  operation('move_component',{deviceId,x:coordinate,y:coordinate,rotation,mirrored:{type:'boolean'}},['deviceId','x','y']),
  operation('set_probes',{probes:{type:'array',maxItems:MAX_MEASUREMENT_PROBES,items:probe}}),
  operation('set_net_label',{label}),operation('remove_net_label',{labelId:id('N')}),
  operation('set_reference_source',{deviceId}),operation('set_output',{terminal}),
]}}

function assertShape(value:unknown,schema:Schema,path:string):void {
  if(schema.anyOf){
    // Discriminated operations retain the precise failing field rather than a generic union error.
    const op=value&&typeof value==='object'?(value as Record<string,unknown>).op:undefined
    const selected=op===undefined?undefined:schema.anyOf.find(item=>item.properties?.op?.const===op)
    if(selected)return assertShape(value,selected,path)
    for(const choice of schema.anyOf)try{assertShape(value,choice,path);return}catch{/* Try remaining endpoint shape. */}
    throw new Error(`${path}: unsupported operation or invalid terminal shape`)
  }
  if(schema.const!==undefined&&value!==schema.const)throw new Error(`${path}: must equal ${String(schema.const)}`)
  if(schema.enum&&!schema.enum.includes(value))throw new Error(`${path}: unsupported value`)
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${path}: expected object`)
    const item=value as Record<string,unknown>
    for(const field of schema.required??[])if(!Object.hasOwn(item,field))throw new Error(`${path}.${field}: required`)
    for(const [field,child]of Object.entries(item)){
      const rule=Object.hasOwn(schema.properties??{},field)?schema.properties![field]:typeof schema.additionalProperties==='object'?schema.additionalProperties:undefined
      if(!rule&&schema.additionalProperties===false)throw new Error(`${path}.${field}: unknown property`)
      if(rule)assertShape(child,rule,`${path}.${field}`)
    }
  }else if(schema.type==='array'){
    if(!Array.isArray(value))throw new Error(`${path}: expected array`)
    if(value.length<(schema.minItems??0)||value.length>(schema.maxItems??Infinity))throw new Error(`${path}: expected ${schema.minItems??0}..${schema.maxItems??'unbounded'} items`)
    value.forEach((child,index)=>{if(schema.items)assertShape(child,schema.items,`${path}[${index}]`)})
  }else if(schema.type==='string'){
    if(typeof value!=='string'||value.length>(schema.maxLength??Infinity)||schema.pattern&&!new RegExp(schema.pattern).test(value))throw new Error(`${path}: invalid string or exact ID`)
  }else if(schema.type==='number'||schema.type==='integer'){
    if(typeof value!=='number'||!Number.isFinite(value)||schema.type==='integer'&&!Number.isInteger(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity)||schema.multipleOf&&value%schema.multipleOf!==0)throw new Error(`${path}: invalid coordinate or number`)
  }else if(schema.type==='boolean'&&typeof value!=='boolean')throw new Error(`${path}: expected boolean`)
}

export function parseCandidateEditOperations(raw:unknown):CandidateEditOperation[] {
  assertShape(raw,candidateEditOperationsSchema,'operations')
  const operations=structuredClone(raw) as CandidateEditOperation[]
  operations.forEach((item,index)=>{if(item.op==='set_value'&&item.value===undefined&&item.params===undefined)throw new Error(`operations[${index}]: set_value needs value or params`)})
  return operations
}

/** Only the final representation is parsed; intermediate disconnected states never escape. */
export function applyCandidateEdit(project:Project,raw:unknown):Project {
  const operations=parseCandidateEditOperations(raw),next=structuredClone(project),drawing=next.drawing
  if(!drawing)throw new Error('Atomic edits require an editable drawing')
  const findDevice=(deviceId:string)=>{const found=drawing.devices.find(part=>part.id===deviceId);if(!found)throw new Error(`Unknown device ${deviceId}`);return found}
  const usedId=(id:string)=>[...drawing.devices,...drawing.junctions,...drawing.wires,...drawing.labels??[]].some(item=>item.id===id)
  for(const item of operations)switch(item.op){
    case 'set_value':{
      const part=findDevice(item.deviceId)
      if(item.params){if(part.kind==='V'||part.kind==='I')Object.assign(part,patchSourceParameters(part,next,item.params));else part.params={...part.params,...item.params}}
      if(item.value!==undefined){part.value=item.value;if(part.kind==='V'&&drawing.sourceId===part.id)next.source.dc=part.value}
      break
    }
    case 'add_component':if(usedId(item.device.id))throw new Error(`Duplicate ID ${item.device.id}`);drawing.devices.push(item.device);break
    case 'remove_component':findDevice(item.deviceId);drawing.devices=drawing.devices.filter(part=>part.id!==item.deviceId);break
    case 'connect':if(usedId(item.wireId))throw new Error(`Duplicate ID ${item.wireId}`);drawing.wires.push({id:item.wireId,from:item.from,to:item.to,bend:item.bend??'hv'});break
    case 'disconnect':if(!drawing.wires.some(wire=>wire.id===item.wireId))throw new Error(`Unknown wire ${item.wireId}`);drawing.wires=drawing.wires.filter(wire=>wire.id!==item.wireId);break
    case 'move_component':{const part=findDevice(item.deviceId);Object.assign(part,{x:item.x,y:item.y},item.rotation===undefined?{}:{rotation:item.rotation},item.mirrored===undefined?{}:{mirrored:item.mirrored});break}
    case 'set_probes':next.probes=item.probes;break
    case 'set_net_label':{drawing.labels??=[];const index=drawing.labels.findIndex(existing=>existing.id===item.label.id);if(index<0){if(usedId(item.label.id))throw new Error(`Duplicate ID ${item.label.id}`);drawing.labels.push(item.label)}else drawing.labels[index]=item.label;break}
    case 'remove_net_label':if(!drawing.labels?.some(existing=>existing.id===item.labelId))throw new Error(`Unknown label ${item.labelId}`);drawing.labels=drawing.labels.filter(existing=>existing.id!==item.labelId);break
    case 'set_reference_source':{const part=findDevice(item.deviceId);if(part.kind!=='V')throw new Error('Reference source must be a voltage source');drawing.sourceId=part.id;next.source.dc=part.value;break}
    case 'set_output':drawing.output=item.terminal;break
  }
  return parseProject(next)
}
