import type { Device } from './drawing'
import { localPin } from './devices'
import type { ModelSymbol } from './model-symbol'
import type { LtspiceSymbol } from './ltspice-symbol'
import { displayedSymbolTexts, symbolTextExtent, displaySymbolPins } from './model-symbol-text-layout'

/** Use actual rotated pins for complex-device captions and selection bounds. */
export function modelDeviceBounds(device:Device,symbol?:ModelSymbol){
  const angle=device.rotation*Math.PI/180,mirror=device.mirrored?-1:1
  const points=(device.pins??[]).map((_,index)=>localPin('X',index,device))
  if(symbol?.shape!=='ltspice'){
    const halfHeight=Math.max(28,...points.map(point=>Math.abs(point.y)+14))
    points.push({x:-40,y:-halfHeight},{x:40,y:halfHeight})
  }
  if(symbol?.shape==='ltspice'){
    for(const item of symbol.geometry??[])for(let index=0;index<item.coords.length;index+=2)points.push({x:item.coords[index],y:item.coords[index+1]})
    for(const {pin} of displaySymbolPins(symbol as LtspiceSymbol))points.push({x:pin.x,y:pin.y})
  }
  const rotated=points.map(point=>({x:point.x*mirror*Math.cos(angle)-point.y*Math.sin(angle),y:point.x*mirror*Math.sin(angle)+point.y*Math.cos(angle)}))
  if(symbol?.shape==='ltspice')rotated.push(...displayedSymbolTexts(symbol as LtspiceSymbol,device).flatMap(symbolTextExtent))
  return {left:Math.min(-44,...rotated.map(point=>point.x))-8,right:Math.max(44,...rotated.map(point=>point.x))+8,top:Math.min(-34,...rotated.map(point=>point.y))-8,bottom:Math.max(34,...rotated.map(point=>point.y))+8}
}
