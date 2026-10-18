import {memo,type KeyboardEvent,type PointerEvent,type RefObject} from 'react'
import {canProbeCurrent} from '../core/branch-currents'
import {deviceNames,pinPosition,type Device,type Pin,type Wire,type XY} from '../core/drawing'
import {deviceCaptionLayout} from '../core/device-caption-geometry'
import type {ImportedSpiceModel} from '../core/spice-models'
import type {ModelSymbol} from '../core/model-symbol'
import {hasOriginalOlbCaptions} from '../core/model-symbol-captions'
import {sourceDescription} from '../core/sources'
import {DeviceSymbol} from './DeviceSymbol'
import {hasQuickValue} from './ComponentValueEditor'

export interface CanvasDeviceView {
  part:Device;model:ImportedSpiceModel|undefined;symbol:ModelSymbol|undefined
  caption:ReturnType<typeof deviceCaptionLayout>
  hitBox:{x:number;y:number;width:number;height:number}
}

// Event dispatch is kept separate from artwork props. Memoized items always
// invoke the current canvas actions, including the current tool and drawing.
export interface CanvasItemActions {
  hoverDevice:(id:string|null)=>void
  deviceDown:(event:PointerEvent<SVGGElement>,id:string)=>void
  deviceDoubleClick:(event:React.MouseEvent<SVGGElement>,id:string)=>void
  deviceKeyDown:(event:KeyboardEvent<SVGGElement>,part:Device)=>void
  valueDown:(event:PointerEvent<SVGTextElement>,part:Device)=>void
  valueDoubleClick:(event:React.MouseEvent<SVGTextElement>,part:Device)=>void
  valueKeyDown:(event:KeyboardEvent<SVGTextElement>,part:Device)=>void
  wireDown:(event:PointerEvent<SVGPathElement>,wire:Wire)=>void
  wireKeyDown:(event:KeyboardEvent<SVGPathElement>,wire:Wire)=>void
  cornerDown:(event:PointerEvent<SVGGElement>,id:string,index:number)=>void
  pinDown:(event:PointerEvent<SVGGElement>,part:Device,pin:Pin)=>void
  pinKeyDown:(event:KeyboardEvent<SVGGElement>,part:Device,pin:Pin)=>void
}
type Actions=RefObject<CanvasItemActions>

export const CanvasDeviceHitArea=memo(function CanvasDeviceHitArea({view,actions}:{view:CanvasDeviceView;actions:Actions}) {
  const {part,hitBox}=view
  return <g data-device-hit-area={part.id} className="device-hit-area" transform={`translate(${part.x} ${part.y})`} onPointerEnter={()=>actions.current.hoverDevice(part.id)} onPointerLeave={()=>actions.current.hoverDevice(null)} onPointerDown={e=>actions.current.deviceDown(e,part.id)} onDoubleClick={e=>actions.current.deviceDoubleClick(e,part.id)}><rect {...hitBox} rx="5" fill="transparent" stroke="none"/></g>
})

export const CanvasDeviceArtwork=memo(function CanvasDeviceArtwork({view,selected,hovered,inputSource,shortMessage,actions}:{view:CanvasDeviceView;selected:boolean;hovered:boolean;inputSource:boolean;shortMessage?:string;actions:Actions}) {
  const {part,model,symbol,caption,hitBox}=view
  return <g transform={`translate(${part.x} ${part.y})`} className={`editor-device ${selected?'selected':''} ${hovered?'device-hovered':''} ${canProbeCurrent(part.kind)?'current-probe-target':''}`} pointerEvents="visiblePainted" role="button" tabIndex={0} aria-label={`${part.id} ${deviceNames[part.kind]} ${part.value}`} data-context-device={part.id} onPointerEnter={()=>actions.current.hoverDevice(part.id)} onPointerLeave={()=>actions.current.hoverDevice(null)} onDoubleClick={e=>actions.current.deviceDoubleClick(e,part.id)} onPointerDown={e=>actions.current.deviceDown(e,part.id)} onKeyDown={e=>actions.current.deviceKeyDown(e,part)}>
    <rect className="device-hit" {...hitBox} rx="5" pointerEvents="none"/>
    <DeviceSymbol device={part} modelType={model?.type} symbol={symbol}/>
    {shortMessage&&<g className="device-short-indicator" aria-label={shortMessage} pointerEvents="none"><title>{shortMessage}</title><rect {...hitBox} rx="5"/><g transform={`translate(${hitBox.x} ${hitBox.y-12})`}><circle r="10"/><text textAnchor="middle" y="5">!</text><text className="device-short-label" x="16" y="4">{part.id} 已被短接</text></g></g>}
    {part.kind!=='GND'&&!hasOriginalOlbCaptions(symbol)&&<text className="device-ref" x={caption.ref.x} y={caption.ref.y} textAnchor={caption.ref.anchor} style={{fontSize:caption.ref.size}}>{part.id}</text>}
    {part.kind!=='GND'&&!hasOriginalOlbCaptions(symbol)&&<text className="device-value" x={caption.value.x} y={caption.value.y} textAnchor={caption.value.anchor} style={{fontSize:caption.value.size}} role="button" tabIndex={0} aria-label={`编辑 ${part.id} ${hasQuickValue(part)?'数值':'参数'}`} onPointerDown={e=>actions.current.valueDown(e,part)} onDoubleClick={e=>actions.current.valueDoubleClick(e,part)} onKeyDown={e=>actions.current.valueKeyDown(e,part)}><title>{hasQuickValue(part)?'双击直接修改数值':'双击编辑器件参数'}</title>{(part.kind==='V'||part.kind==='I')&&part.params?.waveform?sourceDescription(part):part.kind==='V'&&inputSource?'输入激励':`${part.kind==='RELAY'?'SPDT':part.kind==='VSW'?'SW':part.value}${part.kind==='R'&&!/(?:Ω|ohms?|欧姆)$/i.test(part.value)?'Ω':''}`}</text>}
  </g>
})

export const CanvasWire=memo(function CanvasWire({wire,path,selected,dragging,highlighted,staged,shortMessage,netName,corners,screenScale,actions}:{wire:Wire;path:string|undefined;selected:boolean;dragging:boolean;highlighted:boolean;staged:boolean;shortMessage?:string;netName:string|undefined;corners:XY[]|undefined;screenScale:number;actions:Actions}) {
  return <g className={`editor-wire ${selected?'selected':''} ${dragging?'wire-dragging':''} ${highlighted?'net-highlight':''} ${staged?'staged-wire':''}`} data-net-name={netName}>
    <path d={path} className="wire-casing"/>
    <path d={path} className="wire-line"/>
    {shortMessage&&<path d={path} className="wire-short-indicator" data-short-wire={wire.id} pointerEvents="none" vectorEffect="non-scaling-stroke"><title>{shortMessage}</title></path>}
    <path d={path} className="wire-hit" data-probe-wire={wire.id} data-context-wire={wire.id} tabIndex={0} role="button" aria-label={`导线 ${wire.id}`} onKeyDown={e=>actions.current.wireKeyDown(e,wire)} onPointerDown={e=>actions.current.wireDown(e,wire)}/>
    {corners?.map((point,index,points)=>index>0&&index<points.length-1&&<g key={index} className="wire-corner-handle" data-context-wire={wire.id} data-wire-corner={index} transform={`translate(${point.x} ${point.y}) scale(${1/screenScale})`} role="button" aria-label={`导线 ${wire.id} 拐点 ${index}`} onPointerDown={e=>actions.current.cornerDown(e,wire.id,index)}><title>拖动调整拐点，器件引脚保持连接</title><circle r="8" className="wire-corner-hit"/><rect x="-3" y="-3" width="6" height="6" rx="1.5" className="wire-corner-dot"/></g>)}
  </g>
})

export const CanvasPin=memo(function CanvasPin({part,pin,connected,highlighted,pending,netName,screenScale,actions,enlarged=true}:{part:Device;pin:Pin;connected:boolean;highlighted:boolean;pending:boolean;netName:string|undefined;screenScale:number;actions:Actions;enlarged?:boolean}) {
  // A terminal's large screen target is useful for wiring, but must not cover
  // the device body when a fitted narrow pane is used to select or drag it.
  const point=pinPosition(part,pin),hitRadius=Math.max(6,enlarged?14/screenScale:Math.min(16,14/screenScale))
  return <g data-context-pin={part.id} data-pin-index={pin} className={`editor-pin ${connected?'connected':'open'} ${highlighted?'net-highlight':''} ${pending?'pending':''}`} data-net-name={netName} tabIndex={0} role="button" aria-label={`${part.id} 引脚 ${pin+1}${connected?' 已连接':' 未连接'}`} onPointerDown={e=>actions.current.pinDown(e,part,pin)} onKeyDown={e=>actions.current.pinKeyDown(e,part,pin)}>
    {/* Ground's enlarged pin target stays outside its draggable artwork. */}
    {part.kind==='GND'?<path className="pin-hit" transform={`translate(${point.x} ${point.y}) rotate(${part.rotation})`} d={`M ${-hitRadius} 0 A ${hitRadius} ${hitRadius} 0 0 1 ${hitRadius} 0 Z`}/>:<circle cx={point.x} cy={point.y} r={hitRadius} className="pin-hit"/>}<circle cx={point.x} cy={point.y} r={connected?2.25:3.25} className="pin-dot"/>
  </g>
})
