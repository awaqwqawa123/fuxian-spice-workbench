import type { Device } from './drawing'
import type { LtspiceSymbol } from './ltspice-symbol'
import { captionTextWidth } from './caption-text-geometry'

export type SymbolDisplayPin=LtspiceSymbol['pins'][number]
export type SymbolDisplayText=NonNullable<LtspiceSymbol['annotations']>[number]
export type SymbolDisplayDevice=Pick<Device,'rotation'|'mirrored'>&Partial<Pick<Device,'id'|'value'>>

export function displaySymbolPins(symbol:LtspiceSymbol){return [...symbol.pins.map(pin=>({pin,key:`electrical-${pin.index}`,electrical:true})),...(symbol.physicalPins??[]).map((pin,index)=>({pin:{...pin,index:-1},key:`physical-${index}`,electrical:false}))]}

/** Legacy labels go outside the terminal instead of over the source body. */
export function symbolFallbackLabel(symbol:LtspiceSymbol,pin:SymbolDisplayPin,rotation=0,mirror=1){
  const lead=symbol.geometry.find(item=>item.type==='line'&&((item.coords[0]===pin.x&&item.coords[1]===pin.y)||(item.coords[2]===pin.x&&item.coords[3]===pin.y)))
  const other=Number.isFinite(pin.bodyX)&&Number.isFinite(pin.bodyY)?{x:pin.bodyX!,y:pin.bodyY!}:lead?(lead.coords[0]===pin.x&&lead.coords[1]===pin.y?{x:lead.coords[2],y:lead.coords[3]}:{x:lead.coords[0],y:lead.coords[1]}):{x:0,y:0}
  const angle=rotation*Math.PI/180,dx=(other.x-pin.x)*mirror*Math.cos(angle)-(other.y-pin.y)*Math.sin(angle),dy=(other.x-pin.x)*mirror*Math.sin(angle)+(other.y-pin.y)*Math.cos(angle)
  const vertical=Math.abs(dy)>Math.abs(dx),left=dx>=0,standard=(symbol as LtspiceSymbol&{origin?:string}).origin==='standard'
  const worldX=pin.x*mirror*Math.cos(angle)-pin.y*Math.sin(angle),alignStart=vertical?worldX>=0:left
  return standard?{x:vertical?(alignStart?5:-5):left?7:-7,y:vertical?(dy>=0?12:-7):-5,anchor:alignStart?'start' as const:'end' as const}:{x:vertical?0:left?-6:6,y:vertical?(dy>=0?-8:15):3,anchor:vertical?'middle' as const:left?'end' as const:'start' as const}
}

/** Bound the same text frame used by SVG. Native property windows have a top
 * origin; treating them as alphabetic baselines raises text over the body. */
export function symbolTextExtent(label:SymbolDisplayText){
  const size=label.size,width=captionTextWidth(label.text,size,.68),left=label.anchor==='end'?-width:label.anchor==='middle'?-width/2:0,angle=(label.rotation??0)*Math.PI/180,top=label.binding?0:-size,bottom=label.binding?size*1.25:size*.25
  return [[left,top],[left+width,top],[left,bottom],[left+width,bottom]].map(([x,y])=>({x:label.x+x*Math.cos(angle)-y*Math.sin(angle),y:label.y+x*Math.sin(angle)+y*Math.cos(angle)}))
}

/** Renderer cancels device rotation/mirroring for text. Only its origin follows
 * the symbol; explicit source text rotation remains in world coordinates. */
export function displayedSymbolTexts(symbol:LtspiceSymbol,device?:SymbolDisplayDevice,showPhysicalPinNumbers=true):SymbolDisplayText[]{
  const rotation=device?.rotation??0,mirror=device?.mirrored?-1:1,angle=rotation*Math.PI/180
  const transform=(x:number,y:number)=>({x:x*mirror*Math.cos(angle)-y*Math.sin(angle),y:x*mirror*Math.sin(angle)+y*Math.cos(angle)})
  const texts:SymbolDisplayText[]=(symbol.annotations??[]).map(label=>({...label,...transform(label.x,label.y),text:label.binding==='reference'?device?.id??label.text:label.binding==='value'?device?.value??label.text:label.text}))
  for(const {pin} of displaySymbolPins(symbol)){
    const placement=symbolFallbackLabel(symbol,pin,rotation,mirror),origin=transform(pin.x,pin.y)
    if(pin.labelVisible!==false)texts.push({text:pin.label,x:origin.x+placement.x,y:origin.y+placement.y,size:9,anchor:placement.anchor})
    if((showPhysicalPinNumbers||pin.numberVisible===true)&&pin.number)texts.push({text:pin.number,x:origin.x+placement.x,y:origin.y+placement.y+(pin.labelVisible!==false?11:0),size:8,anchor:placement.anchor})
  }
  return texts
}
