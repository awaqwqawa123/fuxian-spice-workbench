import type { Device } from '../core/drawing'
import type { LtspiceSymbol as SymbolData } from '../core/ltspice-symbol'
import { displaySymbolPins as displayPins, symbolFallbackLabel as fallbackLabel, displayedSymbolTexts, symbolTextExtent as textExtent, type SymbolDisplayText as DisplayText } from '../core/model-symbol-text-layout'

type DisplayPrimitive=Omit<SymbolData['geometry'][number],'type'>&{type:SymbolData['geometry'][number]['type']|'polygon'|'polyline';lineStyle?:number;lineWidth?:number;fillStyle?:number}
// OrCAD LineStyle enum: Solid, Dash, Dot, DashDot, DashDotDot, Default.
const dashStyles:Record<number,string>={1:'6 4',2:'1 3',3:'6 3 1 3',4:'6 3 1 3 1 3'}
// Source widths are an enum, not pixels. Preserve Thin < Default < Medium < Wide.
const lineWidths:Record<number,number>={0:1,1:2,2:3,3:1.5}
function primitivePath(item:DisplayPrimitive){
  const [x1,y1,x2,y2,x3,y3,x4,y4]=item.coords
  if(item.type==='line')return <line x1={x1} y1={y1} x2={x2} y2={y2}/>
  if(item.type==='rectangle')return <rect x={Math.min(x1,x2)} y={Math.min(y1,y2)} width={Math.abs(x2-x1)} height={Math.abs(y2-y1)}/>
  if(item.type==='circle')return <ellipse cx={(x1+x2)/2} cy={(y1+y2)/2} rx={Math.abs(x2-x1)/2} ry={Math.abs(y2-y1)/2}/>
  if(item.type==='arc')return <path d={`M ${x3} ${y3} A ${Math.abs(x2-x1)/2} ${Math.abs(y2-y1)/2} 0 0 1 ${x4} ${y4}`}/>
  if(item.type==='polygon')return <polygon points={item.coords.reduce((points,value,index)=>index%2===0?`${points}${index?' ':''}${value},${item.coords[index+1]}`:points,'')}/>
  if(item.type==='polyline')return <polyline points={item.coords.reduce((points,value,index)=>index%2===0?`${points}${index?' ':''}${value},${item.coords[index+1]}`:points,'')}/>
  return null
}
/** Physical numbers are a presentation preference; never synthesize them from
 * the SPICE port index or change the source library's visibility flags. */
export function LtspiceSymbolGraphic({symbol,device,showPinLabels=true,showPhysicalPinNumbers=true}:{symbol:SymbolData;device?:Pick<Device,'rotation'|'mirrored'>&Partial<Pick<Device,'id'|'value'>>;showPinLabels?:boolean;showPhysicalPinNumbers?:boolean}){
  const rotation=device?.rotation??0,mirror=device?.mirrored?-1:1
  return <g data-custom-symbol="ltspice" transform={`rotate(${rotation}) scale(${mirror} 1)`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {symbol.geometry.map((primitive,index)=>{const item=primitive as DisplayPrimitive;return <g key={index} strokeWidth={item.lineWidth===undefined?undefined:lineWidths[item.lineWidth]} strokeDasharray={item.lineStyle===undefined?undefined:dashStyles[item.lineStyle]} fill={item.type!=='line'&&item.fillStyle===0?'currentColor':undefined} data-source-line-style={item.lineStyle} data-source-line-width={item.lineWidth} data-source-fill-style={item.fillStyle}>{primitivePath(item)}</g>})}
    {symbol.annotations?.map((annotation,index)=>{const label=annotation as DisplayText,text=label.binding==='reference'?device?.id??label.text:label.binding==='value'?device?.value??label.text:label.text;return <g key={`label-${index}`} transform={`translate(${label.x} ${label.y}) scale(${mirror} 1) rotate(${(label.rotation??0)-rotation})`}><text x="0" y="0" data-symbol-label={label.binding} textAnchor={label.anchor??'start'} dominantBaseline={label.binding?'text-before-edge':undefined} fontSize={label.size??10} fontFamily={label.fontFamily} fontWeight={label.fontWeight} fontStyle={label.italic?'italic':undefined} fill="currentColor" stroke="none">{text}</text></g>})}
    {displayPins(symbol).map(({pin,key,electrical})=>{
      // Use the lead direction rather than the pin's side of the origin.
      // This also places power/control labels correctly after rotation.
      const placement=fallbackLabel(symbol,pin,rotation,mirror)
      return <g key={key} data-symbol-pin={electrical?pin.index:undefined} data-symbol-physical-pin={electrical?undefined:key} data-source-label-rotate={pin.labelRotate}><title>{`${electrical?pin.index+1:'物理引脚'}: ${pin.label}${pin.number?` · ${pin.number}`:''}`}</title>{electrical&&<circle cx={pin.x} cy={pin.y} r={(symbol as SymbolData&{origin?:string}).origin==='standard'?1.5:0} fill="currentColor" stroke="none"/>}{showPinLabels&&pin.labelVisible!==false&&<g transform={`translate(${pin.x} ${pin.y}) scale(${mirror} 1) rotate(${-rotation})`}><text x={placement.x} y={placement.y} textAnchor={placement.anchor} fontFamily="Consolas, sans-serif" fontSize="9" fill="currentColor" stroke="var(--canvas-background, #fcfdfb)" strokeWidth="2.5" paintOrder="stroke fill">{pin.label}</text></g>}{showPinLabels&&(showPhysicalPinNumbers||pin.numberVisible===true)&&pin.number&&<g transform={`translate(${pin.x} ${pin.y}) scale(${mirror} 1) rotate(${-rotation})`}><text x={placement.x} y={placement.y+(pin.labelVisible!==false?11:0)} textAnchor={placement.anchor} fontFamily="Consolas, sans-serif" fontSize="8" fill="currentColor" stroke="none" data-pin-number={electrical?pin.index:key}>{pin.number}</text></g>}</g>
    })}
  </g>
}
export function LtspiceSymbolPreview({symbol,label,className='ltspice-symbol-preview',showPhysicalPinNumbers=true}:{symbol:SymbolData;label?:string;className?:string;showPhysicalPinNumbers?:boolean}){
  const texts=displayedSymbolTexts(symbol,undefined,showPhysicalPinNumbers)
  const textPoints=texts.flatMap(textExtent)
  const allX=[...symbol.pins.map(pin=>pin.x),...symbol.geometry.flatMap(item=>item.coords.filter((_,i)=>i%2===0)),...textPoints.map(point=>point.x)]
  const allY=[...symbol.pins.map(pin=>pin.y),...symbol.geometry.flatMap(item=>item.coords.filter((_,i)=>i%2===1)),...textPoints.map(point=>point.y)]
  const left=Math.min(...allX)-10,top=Math.min(...allY)-10,width=Math.max(...allX)-left+10,height=Math.max(...allY)-top+10
  return <svg className={className} viewBox={`${left} ${top} ${Math.max(40,width)} ${Math.max(40,height)}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={label??`${symbol.title} 原理图符号`}><title>{label??`${symbol.title} 原理图符号`}</title><LtspiceSymbolGraphic symbol={symbol} showPhysicalPinNumbers={showPhysicalPinNumbers}/></svg>
}
