import { CANVAS, DRAWING_BOUNDS, type Drawing, type XY } from './drawing'
import {clampCanvasZoom} from './canvas-zoom'
import { fitView, selectionBounds, type Bounds } from './selection'

/** Diagram geometry belongs to the sheet UI, never to the electrical netlist. */
export interface CanvasDiagramGeometry { id:string; x:number; y:number; width:number; height:number }
export const CANVAS_DIAGRAM_MIN = { width:320, height:200 }
export const CANVAS_DIAGRAM_MAX = { width:2400, height:1600 }
export type CanvasDiagramEdge = 'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'nw'
const finite=(value:number,fallback:number)=>Number.isFinite(value)?value:fallback
const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value))

export function normalizeCanvasDiagram(geometry:CanvasDiagramGeometry):CanvasDiagramGeometry {
  const width=clamp(finite(geometry.width,640),CANVAS_DIAGRAM_MIN.width,CANVAS_DIAGRAM_MAX.width)
  const height=clamp(finite(geometry.height,330),CANVAS_DIAGRAM_MIN.height,CANVAS_DIAGRAM_MAX.height)
  return {id:geometry.id,width,height,
    x:clamp(finite(geometry.x,120),DRAWING_BOUNDS.min,DRAWING_BOUNDS.max-width),
    y:clamp(finite(geometry.y,560),DRAWING_BOUNDS.min,DRAWING_BOUNDS.max-height)}
}

export function defaultCanvasDiagram(drawing:Drawing,id='waveforms'):CanvasDiagramGeometry {
  const bounds=selectionBounds(drawing)
  return normalizeCanvasDiagram({id,width:640,height:330,
    x:bounds?(bounds.left+bounds.right-640)/2:120,
    y:bounds?bounds.bottom+100:560})
}

export function changeCanvasDiagram(geometry:CanvasDiagramGeometry,delta:XY,kind:'move'|'resize'):CanvasDiagramGeometry {
  return normalizeCanvasDiagram(kind==='move'?{...geometry,x:geometry.x+delta.x,y:geometry.y+delta.y}:{...geometry,width:geometry.width+delta.x,height:geometry.height+delta.y})
}

/** Scale a diagram around a normalized anchor while respecting sheet and size bounds.
 * The anchor is expressed in the frame (0 = left/top, 1 = right/bottom), so
 * a pointer at the centre keeps the frame centred as its geometry changes.
 */
export function scaleCanvasDiagram(geometry:CanvasDiagramGeometry,factor:number,anchor:{x?:number;y?:number}={}) {
  const box=normalizeCanvasDiagram(geometry)
  const amount=clamp(finite(factor,1),.55,1.8)
  const ax=clamp(finite(anchor.x??.5,.5),0,1),ay=clamp(finite(anchor.y??.5,.5),0,1)
  const width=clamp(box.width*amount,CANVAS_DIAGRAM_MIN.width,CANVAS_DIAGRAM_MAX.width)
  const height=clamp(box.height*amount,CANVAS_DIAGRAM_MIN.height,CANVAS_DIAGRAM_MAX.height)
  return normalizeCanvasDiagram({ ...box, x:box.x+(box.width-width)*ax, y:box.y+(box.height-height)*ay, width, height })
}

/** Keep the opposite edge fixed while resizing, including at sheet/minimum bounds. */
export function resizeCanvasDiagram(geometry:CanvasDiagramGeometry,delta:XY,edge:CanvasDiagramEdge='se'):CanvasDiagramGeometry {
  const box=normalizeCanvasDiagram(geometry),right=box.x+box.width,bottom=box.y+box.height
  const dx=finite(delta.x,0),dy=finite(delta.y,0)
  let {x,y,width,height}=box
  if(edge.includes('w')){width=clamp(box.width-dx,CANVAS_DIAGRAM_MIN.width,Math.min(CANVAS_DIAGRAM_MAX.width,right-DRAWING_BOUNDS.min));x=right-width}
  else if(edge.includes('e'))width=clamp(box.width+dx,CANVAS_DIAGRAM_MIN.width,Math.min(CANVAS_DIAGRAM_MAX.width,DRAWING_BOUNDS.max-box.x))
  if(edge.includes('n')){height=clamp(box.height-dy,CANVAS_DIAGRAM_MIN.height,Math.min(CANVAS_DIAGRAM_MAX.height,bottom-DRAWING_BOUNDS.min));y=bottom-height}
  else if(edge.includes('s'))height=clamp(box.height+dy,CANVAS_DIAGRAM_MIN.height,Math.min(CANVAS_DIAGRAM_MAX.height,DRAWING_BOUNDS.max-box.y))
  return {...box,x,y,width,height}
}

export function canvasDiagramBounds(diagrams:readonly CanvasDiagramGeometry[]):Bounds|null {
  if(!diagrams.length)return null
  const safe=diagrams.map(normalizeCanvasDiagram)
  return {left:Math.min(...safe.map(d=>d.x)),top:Math.min(...safe.map(d=>d.y)),right:Math.max(...safe.map(d=>d.x+d.width)),bottom:Math.max(...safe.map(d=>d.y+d.height))}
}

/** Frames use the same enclosure / Alt-intersection convention as circuit items. */
export function selectCanvasDiagrams(diagrams:readonly CanvasDiagramGeometry[],area:Bounds,intersect=false):string[] {
  return diagrams.filter(diagram=>{
    const box=normalizeCanvasDiagram(diagram),right=box.x+box.width,bottom=box.y+box.height
    return intersect?box.x<=area.right&&right>=area.left&&box.y<=area.bottom&&bottom>=area.top
      :box.x>=area.left&&right<=area.right&&box.y>=area.top&&bottom<=area.bottom
  }).map(diagram=>diagram.id)
}

/** Clamp one displacement for every selected frame so spacing survives sheet edges. */
export function moveCanvasDiagrams(diagrams:readonly CanvasDiagramGeometry[],ids:readonly string[],delta:XY):CanvasDiagramGeometry[] {
  const selected=diagrams.filter(diagram=>ids.includes(diagram.id)).map(normalizeCanvasDiagram)
  if(!selected.length)return []
  const dx=clamp(finite(delta.x,0),Math.max(...selected.map(d=>DRAWING_BOUNDS.min-d.x)),Math.min(...selected.map(d=>DRAWING_BOUNDS.max-d.x-d.width)))
  const dy=clamp(finite(delta.y,0),Math.max(...selected.map(d=>DRAWING_BOUNDS.min-d.y)),Math.min(...selected.map(d=>DRAWING_BOUNDS.max-d.y-d.height)))
  return selected.map(d=>({...d,x:d.x+dx,y:d.y+dy}))
}

/** Fit every visible sheet object without adding plot frames to circuit topology. */
export function fitCanvasView(drawing:Drawing,diagrams:readonly CanvasDiagramGeometry[]=[],viewport=CANVAS,maxZoom=1.5,annotations:readonly Bounds[]=[]) {
  const objects=[canvasDiagramBounds(diagrams),...annotations].filter((item):item is Bounds=>!!item)
  const diagramBounds=objects.length?{left:Math.min(...objects.map(item=>item.left)),top:Math.min(...objects.map(item=>item.top)),right:Math.max(...objects.map(item=>item.right)),bottom:Math.max(...objects.map(item=>item.bottom))}:null
  if(!diagramBounds)return fitView(drawing,undefined,viewport,maxZoom)
  const circuit=selectionBounds(drawing)
  const bounds=circuit?{left:Math.min(circuit.left,diagramBounds.left),top:Math.min(circuit.top,diagramBounds.top),right:Math.max(circuit.right,diagramBounds.right),bottom:Math.max(circuit.bottom,diagramBounds.bottom)}:diagramBounds
  return {center:{x:(bounds.left+bounds.right)/2,y:(bounds.top+bounds.bottom)/2},zoom:clampCanvasZoom(Math.min(maxZoom,Math.max(80,viewport.width-128)/(bounds.right-bounds.left+60),Math.max(80,viewport.height-112)/(bounds.bottom-bounds.top+60)))}
}
