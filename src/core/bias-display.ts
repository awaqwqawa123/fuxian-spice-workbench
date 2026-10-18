import { formatSI } from './circuit'
import type { BiasMeasurement } from './bias-inspection'
import { terminalPosition, wirePoints, type Drawing, type XY } from './drawing'
import { deviceLayoutObstacles, placeNetLabels, type LayoutRect } from './schematic-layout'
import { layoutProbeMarkers, measurementProbeMarkers, probeMarkerBounds } from './probe-layout'
import type { Measurement } from './probes'
import { netSymbolBounds } from './net-symbol-geometry'
import { modelDeviceBounds, presentedModelSymbol } from './model-symbol-presentation'
import type { ImportedSpiceModel } from './spice-models'
import type { WireCurrentTarget } from './wire-currents'

export interface BiasDisplayPreferences {
  version:1; voltage:boolean; current:boolean; scope:'all'|'selected'|'pinned'
  noticeHidden?:boolean; pinned:string[]; hidden:string[]; offsets:Record<string,XY>; directionMode:'reference'|'actual'; wireTargets?:WireCurrentTarget[]
}
export type BiasRect = LayoutRect
export interface BiasPlacement {measurement:BiasMeasurement;point:XY;offset:XY;width:number;height:number;arrow?:{from:XY;to:XY}}
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>
export const defaultBiasDisplayPreferences = ():BiasDisplayPreferences => ({version:1,voltage:false,current:false,noticeHidden:false,scope:'all',pinned:[],hidden:[],offsets:{},directionMode:'reference',wireTargets:[]})
const object = (value:unknown):value is Record<string,unknown> => !!value&&typeof value==='object'&&!Array.isArray(value)
const validId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=2048&&!['__proto__','prototype','constructor'].includes(value)
const validXY=(value:unknown):value is XY=>object(value)&&typeof value.x==='number'&&typeof value.y==='number'&&Number.isFinite(value.x)&&Number.isFinite(value.y)&&Math.abs(value.x)<=40000&&Math.abs(value.y)<=40000
const ids=(value:unknown)=>Array.isArray(value)?[...new Set(value.filter(validId))].slice(0,2000):[]
const validTerminal=(value:unknown)=>object(value)&&('device'in value
  ?!('junction'in value)&&typeof value.device==='string'&&/^[A-Z]+[1-9]\d{0,4}$/.test(value.device)&&Number.isInteger(value.pin)&&Number(value.pin)>=0&&Number(value.pin)<32
  :typeof value.junction==='string'&&/^J[1-9]\d{0,4}$/.test(value.junction))
export function parseBiasDisplayPreferences(raw:unknown):BiasDisplayPreferences {
  const defaults=defaultBiasDisplayPreferences()
  if(!object(raw)||raw.version!==1)return defaults
  const offsets:Record<string,XY>={}
  if(object(raw.offsets))for(const [key,value] of Object.entries(raw.offsets).slice(0,2000))if(validId(key)&&validXY(value))Object.defineProperty(offsets,key,{value:{x:value.x,y:value.y},writable:true,enumerable:true,configurable:true})
  const wireTargets:WireCurrentTarget[]=Array.isArray(raw.wireTargets)?raw.wireTargets.slice(0,200).filter(item=>object(item)&&typeof item.wireId==='string'&&/^W[1-9]\d{0,4}$/.test(item.wireId)&&validTerminal(item.from)&&validTerminal(item.to)&&(item.direction===1||item.direction===-1)).map(item=>({wireId:item.wireId,from:'device'in item.from?{device:item.from.device,pin:item.from.pin}:{junction:item.from.junction},to:'device'in item.to?{device:item.to.device,pin:item.to.pin}:{junction:item.to.junction},direction:item.direction})):[]
  return{...defaults,noticeHidden:typeof raw.noticeHidden==='boolean'?raw.noticeHidden:false,voltage:typeof raw.voltage==='boolean'?raw.voltage:defaults.voltage,current:typeof raw.current==='boolean'?raw.current:defaults.current,scope:['all','selected','pinned'].includes(String(raw.scope))?raw.scope as BiasDisplayPreferences['scope']:defaults.scope,directionMode:raw.directionMode==='actual'?'actual':'reference',pinned:ids(raw.pinned),hidden:ids(raw.hidden),offsets,wireTargets}
}
const storageKey=(projectId:string)=>`fuxian:bias-display:v1:${projectId}`
export function readBiasDisplayPreferences(projectId:string,storage?:PreferenceStorage):BiasDisplayPreferences {
  try{return parseBiasDisplayPreferences(JSON.parse((storage??globalThis.localStorage).getItem(storageKey(projectId))??'null'))}catch{return defaultBiasDisplayPreferences()}
}
export function saveBiasDisplayPreferences(projectId:string,prefs:BiasDisplayPreferences,storage?:PreferenceStorage):boolean {
  try{(storage??globalThis.localStorage).setItem(storageKey(projectId),JSON.stringify(parseBiasDisplayPreferences(prefs)));return true}catch{return false}
}
export function biasMeasurementText(measurement:BiasMeasurement,directionMode:'reference'|'actual'='reference'):string {
  const signed=measurement.kind!=='voltage'&&directionMode==='reference'&&measurement.value!==null&&measurement.value>0
  const value=measurement.value===null?'不可用':`${signed?'+':''}${formatSI(directionMode==='actual'&&measurement.kind!=='voltage'?Math.abs(measurement.value):measurement.value,measurement.unit,4)}`
  return`${measurement.label} = ${value}`
}
const overlap=(a:BiasRect,b:BiasRect)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top
export const biasPlacementRect=(placement:BiasPlacement):BiasRect=>({left:placement.point.x+placement.offset.x,top:placement.point.y+placement.offset.y,right:placement.point.x+placement.offset.x+placement.width,bottom:placement.point.y+placement.offset.y+placement.height})

function anchorAndDirection(drawing:Drawing,m:BiasMeasurement):{point:XY;vector?:XY}|null {
  if(m.wire){
    const wire=drawing.wires.find(w=>w.id===m.wire!.wireId)
    if(!wire)return null
    const path=wirePoints(drawing,wire),lengths=path.slice(1).map((p,i)=>Math.hypot(p.x-path[i].x,p.y-path[i].y)),half=lengths.reduce((sum,n)=>sum+n,0)/2
    let traversed=0
    for(let i=0;i<lengths.length;i++)if(lengths[i]>0&&traversed+lengths[i]>=half){const a=path[i],b=path[i+1],fraction=(half-traversed)/lengths[i];return{point:{x:a.x+(b.x-a.x)*fraction,y:a.y+(b.y-a.y)*fraction},vector:{x:(b.x-a.x)/lengths[i]*m.wire.direction,y:(b.y-a.y)/lengths[i]*m.wire.direction}}}else traversed+=lengths[i]
    return{point:path[0]}
  }
  if(m.kind==='voltage'&&m.point)return{point:m.point}
  if(!m.at)return null
  try{
    const at=m.at,point=terminalPosition(drawing,at),device='device'in at?drawing.devices.find(d=>d.id===at.device):undefined
    if(!device||m.kind==='voltage')return{point}
    const length=Math.hypot(device.x-point.x,device.y-point.y)
    return{point,...(length?{vector:{x:(device.x-point.x)/length,y:(device.y-point.y)/length}}:{})}
  }catch{return null}
}

/** Labels are deterministic and keep manually dragged offsets. Arrows stay anchored at terminals. */
export function layoutBiasMeasurements(drawing:Drawing,measurements:readonly BiasMeasurement[],options:{prefs?:BiasDisplayPreferences;selected?:readonly string[];obstacles?:readonly BiasRect[];probes?:readonly Measurement[];models?:readonly ImportedSpiceModel[]}={}):BiasPlacement[] {
  const prefs=options.prefs??{...defaultBiasDisplayPreferences(),voltage:true,current:true},selected=new Set(options.selected??[]),pinned=new Set(prefs.pinned),hidden=new Set(prefs.hidden)
  const obstacles:BiasRect[]=[...(options.obstacles??[]),...drawing.devices.flatMap(device=>{
    const basic=deviceLayoutObstacles(device,4)
    if(device.kind!=='X')return basic
    const model=options.models?.find(model=>model.kind==='X'&&model.id.toLowerCase()===device.value.toLowerCase()),bounds=modelDeviceBounds(device,model?presentedModelSymbol(model,device):undefined)
    return[...basic,{left:device.x+bounds.left,top:device.y+bounds.top,right:device.x+bounds.right,bottom:device.y+bounds.bottom}]
  }),...placeNetLabels(drawing).map(({label,point,x,y,width})=>{
    if(label.style&&label.style!=='text'){const b=netSymbolBounds(label.name,label.style,label.rotation);return{left:point.x+b.left,top:point.y+b.top,right:point.x+b.right,bottom:point.y+b.bottom}}
    return{left:point.x+x-3,top:point.y+y-25,right:point.x+x+width+3,bottom:point.y+y+3}
  }),...layoutProbeMarkers(drawing,measurementProbeMarkers(drawing,options.probes)).map(marker=>probeMarkerBounds(drawing,marker))]
  const output:BiasPlacement[]=[]
  for(const measurement of [...measurements].sort((a,b)=>a.id.localeCompare(b.id))){
    if(hidden.has(measurement.id)||!(measurement.kind==='voltage'?prefs.voltage:prefs.current))continue
    if(prefs.scope==='pinned'&&!pinned.has(measurement.id))continue
    if(prefs.scope==='selected'&&!pinned.has(measurement.id)&&!selected.has(measurement.id)&&!selected.has(measurement.deviceId??'')&&!selected.has(measurement.wire?.wireId??'')&&!(measurement.kind==='voltage'&&drawing.devices.some(d=>selected.has(d.id)&&measurement.id.split(/[|:]/).includes(d.id))))continue
    const anchor=anchorAndDirection(drawing,measurement)
    if(!anchor)continue
    const point=anchor.point,text=biasMeasurementText(measurement,prefs.directionMode),width=Math.max(90,[...text].reduce((sum,c)=>sum+(c.codePointAt(0)!>255?13:7.5),0)+16),height=26
    let offset=prefs.offsets[measurement.id]
    if(!validXY(offset)){
      const candidates:XY[]=[]
      for(let radius=0;radius<12;radius++){const gap=16+radius*34;candidates.push({x:gap,y:-height-gap},{x:gap,y:gap},{x:-width-gap,y:-height-gap},{x:-width-gap,y:gap},{x:-width/2,y:-height-gap},{x:-width/2,y:gap})}
      let best=Infinity
      for(const candidate of candidates){const rectangle={left:point.x+candidate.x,top:point.y+candidate.y,right:point.x+candidate.x+width,bottom:point.y+candidate.y+height},score=obstacles.filter(o=>overlap(rectangle,o)).length*1e6+Math.hypot(candidate.x+width/2,candidate.y+height/2);if(score<best){best=score;offset=candidate}if(score<1e6)break}
    }
    const placement:BiasPlacement={measurement,point,offset:{...offset!},width,height}
    if(measurement.kind!=='voltage'&&measurement.value!==null&&anchor.vector&&!(prefs.directionMode==='actual'&&measurement.value===0)){
      const sign=prefs.directionMode==='actual'&&measurement.value<0?-1:1,vector=anchor.vector
      placement.arrow={from:{x:point.x-vector.x*12*sign,y:point.y-vector.y*12*sign},to:{x:point.x+vector.x*12*sign,y:point.y+vector.y*12*sign}}
    }
    output.push(placement);obstacles.push(biasPlacementRect(placement))
  }
  return output
}
