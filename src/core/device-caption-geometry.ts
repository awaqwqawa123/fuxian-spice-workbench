import type { Device } from './drawing'
import { modelDeviceBounds } from './model-device-bounds'
import { pinsFor } from './devices'
import { GRID, pinPosition } from './drawing-geometry'
import { captionTextWidth } from './caption-text-geometry'

export interface LayoutRect { left:number; top:number; right:number; bottom:number }
const rect = (left:number, top:number, right:number, bottom:number):LayoutRect => ({ left, top, right, bottom })
const grow = (value:LayoutRect, amount:number):LayoutRect => rect(value.left-amount,value.top-amount,value.right+amount,value.bottom+amount)

// These values mirror the text styles and positions used by EditorCanvas. The
// canvas draws captions in the device group's local (unrotated) coordinates,
// so a caption remains an obstacle even when the symbol itself is rotated.
const displayValue = (device:Device) => {
  if (device.kind === 'RELAY') return 'SPDT'
  if (device.kind === 'VSW') return 'SW'
  if ((device.kind === 'V' || device.kind === 'I') && device.params?.waveform) {
    const waveform=device.params.waveform
    if (waveform === 'expression') return 'f(time) · 代码波形'
    if (waveform === 'sine') return `SIN · ${device.params.amplitude ?? '1'} · ${device.params.frequency ?? '1kHz'}`
    if (waveform === 'pulse') return `PULSE · ${device.params.low ?? '0'} → ${device.params.high ?? '1'}`
    if (waveform === 'pwl') return 'PWL · 分段线性'
  }
  const value = device.value || device.kind
  return device.kind === 'R' && !/(?:Ω|ohms?|欧姆)$/i.test(value) ? `${value}Ω` : value
}

export interface CaptionAnchor { x:number; y:number; size:number; anchor:'start'|'middle' }

/** Shared local coordinates for canvas text, routing obstacles and SVG export.
 * Multi-pin captions sit outside the rotated terminal envelope so a supply
 * lead can leave its pin without immediately passing through device text. */
export function deviceCaptionLayout(device:Device, modelBounds?:LayoutRect):{ref:CaptionAnchor;value:CaptionAnchor} {
  if(device.kind==='X'){
    const bounds=modelBounds??modelDeviceBounds(device)
    return {ref:{x:0,y:bounds.top-25,size:13,anchor:'middle'},value:{x:0,y:bounds.top-10,size:11,anchor:'middle'}}
  }
  const extended=pinsFor(device).length>3||['LDO','XFMR'].includes(device.kind)
  if(extended){
    const pins=pinsFor(device).map(pin=>pinPosition({...device,x:0,y:0},pin))
    const x=Math.max(...pins.map(pin=>pin.x))+GRID
    const y=Math.min(-58,Math.min(...pins.map(pin=>pin.y))-18)
    return {ref:{x,y:y-18,size:16,anchor:'start'},value:{x,y,size:13,anchor:'start'}}
  }
  const vertical=device.rotation===90||device.rotation===270||pinsFor(device).length===3
  return {ref:{x:vertical?42:0,y:vertical?-5:-37,size:16,anchor:vertical?'start':'middle'},value:{x:vertical?42:0,y:vertical?19:42,size:13,anchor:vertical?'start':'middle'}}
}

export interface DeviceCaptionGeometryOptions {
  /** The same local, rotated original-symbol bounds passed by the renderer. */
  modelBounds?:LayoutRect
  /** Actual painted text when the source summary replaces the stored value. */
  valueText?:string
}

function localDeviceCaptionRects(device:Device, padding = 3, options:DeviceCaptionGeometryOptions = {}):LayoutRect[] {
  if(device.kind==='GND')return []
  const layout=deviceCaptionLayout(device,options.modelBounds)
  const captions=[{...layout.ref,text:device.id},{...layout.value,text:options.valueText??displayValue(device)}]
  return captions.map(c => {
    const textWidth = captionTextWidth(c.text,c.size)
    const left = c.anchor === 'middle' ? c.x - textWidth / 2 : c.x
    return grow(rect(left,c.y-c.size+1,left+textWidth,c.y+4),padding)
  })
}

/** Return the two actual caption bounds painted next to a device. */
export function deviceCaptionRects(device:Device, padding = 3, options:DeviceCaptionGeometryOptions = {}):LayoutRect[] {
  return localDeviceCaptionRects(device,padding,options).map(item => rect(item.left+device.x,item.top+device.y,item.right+device.x,item.bottom+device.y))
}
