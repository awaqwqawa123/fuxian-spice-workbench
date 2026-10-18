import type { CanvasDiagramGeometry } from './canvas-diagrams'

const prefix='fuxian-canvas-diagram-v1:'
export function readCanvasDiagram(storage:Pick<Storage,'getItem'>,projectId:string):CanvasDiagramGeometry|null {
  try {
    const value=JSON.parse(storage.getItem(prefix+projectId)??'null') as CanvasDiagramGeometry|null
    if(!value||value.id!=='waveform'||![value.x,value.y,value.width,value.height].every(Number.isFinite))return null
    if(Math.abs(value.x)>20000||Math.abs(value.y)>20000||value.width<320||value.width>2400||value.height<200||value.height>1600)return null
    return {id:value.id,x:value.x,y:value.y,width:value.width,height:value.height}
  } catch {return null}
}
export function saveCanvasDiagram(storage:Pick<Storage,'setItem'>,projectId:string,geometry:CanvasDiagramGeometry):boolean {
  try {storage.setItem(prefix+projectId,JSON.stringify(geometry));return true} catch{return false}
}
