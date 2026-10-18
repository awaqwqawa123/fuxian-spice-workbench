import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { biasMeasurementText, type BiasPlacement } from '../core/bias-display'
import type { XY } from '../core/drawing'

interface Props {
  placements:BiasPlacement[];directionMode:'reference'|'actual';selectedId?:string;pinned:string[]
  onMove:(id:string,offset:XY)=>void;onSelect:(id:string)=>void;onPin:(id:string)=>void
  onUndo?:()=>void;onRedo?:()=>void
}
function position(event:PointerEvent<SVGGElement>):XY {
  const svg=event.currentTarget.ownerSVGElement,ctm=svg?.getScreenCTM()
  if(!ctm)return{x:event.clientX,y:event.clientY}
  const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(ctm.inverse())
  return{x:p.x,y:p.y}
}

/** Draggable artwork does not edit the circuit or relocate its electrical target. */
export default function BiasCanvasLayer({placements,directionMode,selectedId,pinned,onMove,onSelect,onPin,onUndo,onRedo}:Props) {
  const drag=useRef<{id:string;start:XY;offset:XY;pointerId:number;element:SVGGElement}|null>(null)
  const [preview,setPreview]=useState<{id:string;offset:XY}|null>(null)
  function cancel(){
    const active=drag.current
    drag.current=null;setPreview(null)
    if(active?.element.hasPointerCapture?.(active.pointerId))active.element.releasePointerCapture(active.pointerId)
  }
  useEffect(()=>{
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&drag.current){event.preventDefault();event.stopImmediatePropagation();cancel()}}
    window.addEventListener('keydown',escape,true)
    return()=>{window.removeEventListener('keydown',escape,true);const active=drag.current;if(active?.element.hasPointerCapture?.(active.pointerId))active.element.releasePointerCapture(active.pointerId)}
  },[])
  useEffect(()=>{if(drag.current&&!placements.some(item=>item.measurement.id===drag.current!.id))cancel()},[placements])
  return <g data-layer="bias-annotations">{placements.map(placement=>{
    const {measurement:m,point,width,height,arrow}=placement,offset=preview?.id===m.id?preview.offset:placement.offset
    const text=biasMeasurementText(m,directionMode),left=point.x+offset.x,top=point.y+offset.y
    const vx=arrow?arrow.to.x-arrow.from.x:0,vy=arrow?arrow.to.y-arrow.from.y:0,length=Math.hypot(vx,vy),ux=length?vx/length:0,uy=length?vy/length:0
    const arrowhead=arrow?`M ${arrow.to.x-ux*6-uy*4} ${arrow.to.y-uy*6+ux*4} L ${arrow.to.x} ${arrow.to.y} L ${arrow.to.x-ux*6+uy*4} ${arrow.to.y-uy*6-ux*4}`:''
    return <g key={m.id} className={`bias-canvas-label ${m.kind==='voltage'?'canvas-dc-voltage':'canvas-dc-current'} ${selectedId===m.id?'selected':''} ${m.value===null?'unavailable':''}`} data-bias-id={m.id} data-dc-node={m.node} data-dc-voltage={m.kind==='voltage'?m.value:undefined} data-dc-current={m.kind!=='voltage'?m.value:undefined} data-bias-device={m.deviceId} role="group" aria-label={text}>
      <title>{`${text}\n${m.direction}\n${m.reason??m.source}\n拖动标牌可避让；双击固定测点。`}</title>
      <g pointerEvents="none"><path className="bias-leader" d={`M ${point.x} ${point.y} L ${left+width/2} ${top+height/2}`}/><circle cx={point.x} cy={point.y} r="2.5"/>{arrow&&<path className="bias-arrow" data-bias-arrow={m.id} d={`M ${arrow.from.x} ${arrow.from.y} L ${arrow.to.x} ${arrow.to.y} ${arrowhead}`}/>}</g>
      <g className="bias-badge" transform={`translate(${left} ${top})`} role="button" tabIndex={0} aria-label={`工作点标牌 ${text}`} onPointerDown={event=>{
        if(event.button!==0)return
        event.stopPropagation();event.preventDefault();event.currentTarget.focus();onSelect(m.id)
        drag.current={id:m.id,start:position(event),offset:{...offset},pointerId:event.pointerId,element:event.currentTarget}
        event.currentTarget.setPointerCapture(event.pointerId)
      }} onPointerMove={event=>{
        const active=drag.current
        if(!active||active.id!==m.id||active.pointerId!==event.pointerId)return
        event.stopPropagation();const at=position(event)
        setPreview({id:m.id,offset:{x:active.offset.x+at.x-active.start.x,y:active.offset.y+at.y-active.start.y}})
      }} onPointerUp={event=>{
        const active=drag.current
        if(!active||active.id!==m.id||active.pointerId!==event.pointerId)return
        event.stopPropagation();const at=position(event)
        if(Math.hypot(at.x-active.start.x,at.y-active.start.y)>2)onMove(m.id,{x:active.offset.x+at.x-active.start.x,y:active.offset.y+at.y-active.start.y})
        cancel()
      }} onPointerCancel={event=>{event.stopPropagation();cancel()}} onLostPointerCapture={()=>{if(drag.current?.id===m.id)cancel()}} onDoubleClick={event=>{event.stopPropagation();onPin(m.id)}} onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.stopPropagation();if(event.shiftKey)onRedo?.();else onUndo?.()}if(event.key==='Enter'){event.stopPropagation();onSelect(m.id)}if(event.key===' '){event.preventDefault();event.stopPropagation();onPin(m.id)}}}>
        <rect width={width} height={height} rx="4"/><text x="8" y={height/2+4} pointerEvents="none">{text}</text>{pinned.includes(m.id)&&<circle className="bias-pinned-dot" cx={width-5} cy="5" r="2"/>}
      </g>
    </g>
  })}</g>
}
