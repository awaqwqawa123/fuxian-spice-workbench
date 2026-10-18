import type { Terminal, XY } from './drawing'
import type { WireAnchor } from './probe-placement'

/** A canvas hit, with both screen coordinates and a snapped drawing position. */
export interface CanvasContextRequest {
  clientX:number
  clientY:number
  at:XY
  deviceId?:string
  wireId?:string
  junctionId?:string
  labelId?:string
  terminal?:Terminal
  anchor?:WireAnchor
  probeLabel?:string
}

export interface CanvasContextMenuItem {
  id:string
  label:string
  shortcut?:string
  disabled?:boolean
  danger?:boolean
  separatorBefore?:boolean
}

export function contextMenuPosition(point:XY, size:{width:number;height:number}, viewport:{width:number;height:number}):XY {
  const margin=8
  return {
    x:Math.max(margin,Math.min(point.x,viewport.width-size.width-margin)),
    y:Math.max(margin,Math.min(point.y,viewport.height-size.height-margin)),
  }
}
