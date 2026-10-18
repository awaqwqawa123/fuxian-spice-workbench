import { MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM } from './canvas-zoom'
import { DRAWING_BOUNDS, type XY } from './drawing'

export interface CanvasViewPreference { version:1; center:XY; zoom:number; mode:'auto'|'manual' }
const key=(project:string)=>`fuxian.schematic-view:${project}`
export function readCanvasViewPreference(project?:string):CanvasViewPreference|null {
  if(!project)return null
  try{
    const value=JSON.parse(localStorage.getItem(key(project))??'null')
    if(value?.version!==1||!['auto','manual'].includes(value.mode)||!Number.isFinite(value.zoom)||value.zoom<MIN_CANVAS_ZOOM||value.zoom>MAX_CANVAS_ZOOM)return null
    if(![value.center?.x,value.center?.y].every(n=>Number.isFinite(n)&&n>=DRAWING_BOUNDS.min&&n<=DRAWING_BOUNDS.max))return null
    return {version:1,center:{x:value.center.x,y:value.center.y},zoom:value.zoom,mode:value.mode}
  }catch{return null}
}
export function saveCanvasViewPreference(project:string|undefined,value:CanvasViewPreference){
  if(!project)return
  try{localStorage.setItem(key(project),JSON.stringify(value))}catch{/* Viewing remains available when storage is full. */}
}
