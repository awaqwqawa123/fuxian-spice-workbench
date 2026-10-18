import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { changeCanvasDiagram, normalizeCanvasDiagram, resizeCanvasDiagram, type CanvasDiagramEdge, type CanvasDiagramGeometry } from '../core/canvas-diagrams'
import type { XY } from '../core/drawing'

export interface CanvasDiagram extends CanvasDiagramGeometry { title?:string; content:ReactNode; onCopy?:()=>void; copyDisabled?:boolean; onWheelResize?:(factor:number,anchor?:{x:number;y:number})=>void }
interface Props {
  diagram:CanvasDiagram; active:boolean; selected?:boolean; toWorld:(x:number,y:number)=>XY; screenScale?:number
  onChange?:(id:string,geometry:CanvasDiagramGeometry,kind?:'move'|'resize')=>void
  onPreview?:(id:string,geometry:CanvasDiagramGeometry|null)=>void
  constrainMove?:(geometry:CanvasDiagramGeometry)=>CanvasDiagramGeometry
  onExpand?:(id:string)=>void; onWheelResize?:(factor:number,anchor?:{x:number;y:number})=>void; onActivate?:(additive?:boolean)=>void
}
type Gesture={base:CanvasDiagramGeometry;kind:'move'|'resize';edge:CanvasDiagramEdge;start:XY;client:XY;pointerId:number;target:Element;started:boolean}
const sameGeometry=(a:CanvasDiagramGeometry,b:CanvasDiagramGeometry)=>a.id===b.id&&a.x===b.x&&a.y===b.y&&a.width===b.width&&a.height===b.height
const textControl=(target:EventTarget)=>!!(target as Element).closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
const embeddedControl=(target:EventTarget)=>textControl(target)||!!(target as Element).closest('button,summary,[data-waveform-control]')

export default function CanvasWaveformDiagram({diagram,active,selected=false,toWorld,screenScale=1,onChange,onPreview,constrainMove,onExpand,onWheelResize,onActivate}:Props) {
  const group=useRef<SVGGElement>(null),gesture=useRef<Gesture|null>(null)
  const pointerFocus=useRef(false),suppressClick=useRef(false)
  const titleClip=useId()
  const [preview,setPreview]=useState<CanvasDiagramGeometry|null>(null)
  const normalized=normalizeCanvasDiagram(diagram),box=preview??normalized
  const typeScale=Math.min(box.width/640,box.height/330)
  const titleHeight=34*typeScale
  // Lay out every embedded state in the same logical coordinates, then scale
  // the whole content once. Per-selector font scaling missed empty/error/OP
  // states and stopped shrinking at .75 while the frame kept getting smaller.
  const contentWidth=box.width/typeScale-16,contentHeight=box.height/typeScale-58
  const handleScale=1/Math.max(.1,screenScale),handleWidth=12*handleScale,cornerSize=20*handleScale
  const edgeLabels:Record<CanvasDiagramEdge,string>={n:'上边',ne:'右上角',e:'右边',se:'右下角',s:'下边',sw:'左下角',w:'左边',nw:'左上角'}
  function cancel(){
    const state=gesture.current;gesture.current=null;setPreview(null);if(state)onPreview?.(diagram.id,null)
    if(state?.target.hasPointerCapture?.(state.pointerId))state.target.releasePointerCapture(state.pointerId)
  }
  useEffect(()=>{if(!active)cancel()},[active])
  useEffect(()=>{if(gesture.current&&!sameGeometry(gesture.current.base,normalized))cancel()},[diagram.id,diagram.x,diagram.y,diagram.width,diagram.height])
  useEffect(()=>()=>{const state=gesture.current;gesture.current=null;if(state?.target.hasPointerCapture?.(state.pointerId))state.target.releasePointerCapture(state.pointerId)},[])
  useEffect(()=>{
    const frame=group.current,resize=onWheelResize??diagram.onWheelResize
    if(!active||!frame||!resize)return
    const wheel=(event:WheelEvent)=>{
      if(event.defaultPrevented||!event.deltaY)return
      if((event.target as Element|null)?.closest?.('dialog,[role="dialog"],[aria-modal="true"],.canvas-waveform-legend-details'))return
      // The React prop is normally authoritative; the data attribute keeps
      // the capture guard correct when a foreignObject retargets the event
      // while a parent render is still committing selection state.
      if(!selected&&frame.getAttribute('data-diagram-selected')!=='true')return
      const bounds=frame.getBoundingClientRect()
      if(bounds.width<=0||bounds.height<=0||event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)return
      // The embedded preview owns plot wheel events and resizes this frame.
      // Leave them to its capture listener so one wheel tick resizes once.
      const plot=[...frame.querySelectorAll('.wave-plot')].some(candidate=>{
        const plotBounds=candidate.getBoundingClientRect()
        return plotBounds.width>0&&plotBounds.height>0&&event.clientX>=plotBounds.left&&event.clientX<=plotBounds.right&&event.clientY>=plotBounds.top&&event.clientY<=plotBounds.bottom
      })
      if(plot)return
      event.preventDefault();event.stopPropagation()
      const anchor={x:Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height))}
      const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?bounds.height:1)
      resize(Math.exp(-Math.max(-160,Math.min(160,delta))*.0025),anchor)
    }
    // Capture at window level because Chromium can retarget foreignObject
    // wheel events to the surrounding SVG before the frame group sees them.
    window.addEventListener('wheel',wheel,{capture:true,passive:false})
    return()=>window.removeEventListener('wheel',wheel,true)
  },[active,diagram.onWheelResize,onWheelResize,selected])
  function begin(event:PointerEvent<SVGGElement>,kind:'move'|'resize',edge:CanvasDiagramEdge='se'){
    event.stopPropagation()
    if(!active||event.button!==0||!onChange)return
    event.preventDefault();cancel();suppressClick.current=false;onActivate?.(event.shiftKey||event.ctrlKey||event.metaKey)
    pointerFocus.current=true;event.currentTarget.focus({preventScroll:true});pointerFocus.current=false
    if(event.shiftKey||event.ctrlKey||event.metaKey)return
    // Capture the actual hit element. A plain click must still reach its pane's
    // click handler; capturing the frame group would retarget that click.
    const target=event.target as Element
    gesture.current={base:normalized,kind,edge,start:toWorld(event.clientX,event.clientY),client:{x:event.clientX,y:event.clientY},pointerId:event.pointerId,target,started:false}
    target.setPointerCapture?.(event.pointerId)
  }
  function next(event:PointerEvent<SVGGElement>,state:Gesture){
    state.started=state.started||Math.hypot(event.clientX-state.client.x,event.clientY-state.client.y)>=3
    const point=toWorld(event.clientX,event.clientY)
    const delta={x:point.x-state.start.x,y:point.y-state.start.y}
    const changed=state.started?state.kind==='resize'?resizeCanvasDiagram(state.base,delta,state.edge):changeCanvasDiagram(state.base,delta,'move'):state.base
    return state.kind==='move'&&constrainMove?constrainMove(changed):changed
  }
  function move(event:PointerEvent<SVGGElement>){
    event.stopPropagation()
    const state=gesture.current
    if(!state||event.pointerId!==state.pointerId||!active)return
    const changed=next(event,state);setPreview(changed);if(state.kind==='move')onPreview?.(diagram.id,changed)
  }
  function finish(event:PointerEvent<SVGGElement>){
    event.stopPropagation()
    const state=gesture.current
    if(!state||event.pointerId!==state.pointerId||event.button!==0)return
    const changed=next(event,state);suppressClick.current=state.started;cancel()
    if(active&&!sameGeometry(changed,state.base))onChange?.(diagram.id,changed,state.kind)
  }
  function expand(){if(active){cancel();onExpand?.(diagram.id)}}
  function copy(){if(active&&!diagram.copyDisabled&&diagram.onCopy){cancel();onActivate?.();diagram.onCopy()}}
  function key(event:KeyboardEvent<SVGGElement>){
    // Clipboard and history records belong to the workbench. Do not swallow
    // their keyboard events, and leave embedded text controls entirely native.
    if(embeddedControl(event.target))return
    if((event.ctrlKey||event.metaKey)&&['c','v','z','y'].includes(event.key.toLowerCase())||['Delete','Backspace','F5'].includes(event.key))return
    event.stopPropagation()
    if(event.key==='Tab')return
    if(!active)return
    if(event.key==='Escape'){event.preventDefault();cancel();return}
    if(event.key==='Enter'||event.key===' '){event.preventDefault();expand();return}
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){
      event.preventDefault();cancel();onActivate?.()
      const handle=(event.target as Element).closest('[data-diagram-resize]'),step=event.shiftKey?20:10,kind=handle?'resize':'move'
      const delta={x:event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,y:event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0}
      const changed=handle?resizeCanvasDiagram(normalized,delta,handle.getAttribute('data-diagram-edge') as CanvasDiagramEdge??'se'):changeCanvasDiagram(normalized,delta,'move')
      onChange?.(diagram.id,kind==='move'&&constrainMove?constrainMove(changed):changed,kind)
    }
  }
  return <g ref={group} className={`canvas-waveform-diagram${preview?' is-manipulating':''}${selected?' is-selected':''}`} data-canvas-diagram={diagram.id} data-diagram-selected={selected?'true':undefined} transform={`translate(${box.x} ${box.y})`} role="group" aria-label={diagram.title??'画布波形图'} tabIndex={0}
    onFocus={event=>{if(active&&!pointerFocus.current&&!selected&&!embeddedControl(event.target))onActivate?.()}}
    onPointerDown={event=>{event.stopPropagation();suppressClick.current=false;if(!embeddedControl(event.target))begin(event,'move')}}
    onPointerMove={move} onPointerUp={finish} onPointerCancel={event=>{event.stopPropagation();cancel()}} onLostPointerCapture={event=>{event.stopPropagation();cancel()}}
    onClickCapture={event=>{if(suppressClick.current){event.preventDefault();event.stopPropagation();suppressClick.current=false}}}
    onDoubleClick={event=>{if(embeddedControl(event.target)||suppressClick.current)return;event.preventDefault();event.stopPropagation();expand()}} onKeyDown={key}
    onDragOver={event=>{event.preventDefault();event.stopPropagation()}} onDrop={event=>{event.preventDefault();event.stopPropagation()}}>
    <title>直接拖动标题或波形区域移动；拖动边缘或四角调整大小；选中后滚轮缩放整个波形图框占地，未选中时滚轮缩放画布；双击放大查看。Ctrl+C / V 复制粘贴。</title>
    <defs><clipPath id={titleClip}><rect x={42*typeScale} y="0" width={Math.max(1,box.width-(diagram.onCopy?220:155)*typeScale)} height={titleHeight}/></clipPath></defs>
    <rect className="canvas-diagram-frame" width={box.width} height={box.height} rx="5"/>
    <g className="canvas-diagram-title" tabIndex={0} role="button" aria-label="移动画布波形图" onPointerDown={event=>begin(event,'move')}>
      <rect width={box.width} height={titleHeight} rx="5"/>
      <path className="canvas-diagram-glyph" transform={`scale(${typeScale})`} d="M 12 23 H 31 M 14 24 V 10 M 15 19 L 19 16 L 23 21 L 28 12 L 31 15"/>
      <text x={42*typeScale} y={22*typeScale} style={{fontSize:13*typeScale}} clipPath={`url(#${titleClip})`}>{diagram.title??'仿真波形'}</text>
    </g>
    {diagram.onCopy&&<g className="canvas-diagram-action canvas-diagram-copy" transform={`translate(${box.width-169*typeScale} ${5*typeScale}) scale(${typeScale})`} role="button" tabIndex={0} aria-label="复制画布波形图" aria-disabled={!active||!!diagram.copyDisabled}
      onPointerDown={event=>{event.stopPropagation();event.currentTarget.focus({preventScroll:true})}} onClick={event=>{event.stopPropagation();copy()}} onDoubleClick={event=>event.stopPropagation()}
      onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();copy()}}}>
      <title>{diagram.copyDisabled?'已达到当前画布的波形图数量上限':'复制此波形图，保留配置、曲线与视图设置'}</title>
      <rect width="64" height="24" rx="4"/>
      <path d="M 13 8 V 5 H 23 V 16 H 20 M 10 8 H 20 V 19 H 10 Z"/>
      <text x="29" y="16">复制</text>
    </g>}
    <g className="canvas-diagram-action canvas-diagram-expand" transform={`translate(${box.width-99*typeScale} ${5*typeScale}) scale(${typeScale})`} role="button" tabIndex={0} aria-label="放大画布波形图" onPointerDown={event=>{event.stopPropagation();event.currentTarget.focus({preventScroll:true})}} onClick={event=>{event.stopPropagation();expand()}} onDoubleClick={event=>event.stopPropagation()}>
      <rect width="90" height="24" rx="4"/>
      <path d="M 10 10 V 6 H 14 M 10 6 L 16 12 M 22 14 V 18 H 18 M 22 18 L 16 12"/>
      <text x="32" y="16">放大查看</text>
    </g>
    <foreignObject className="canvas-diagram-foreign" x="8" y="40" width={contentWidth} height={Math.max(1,contentHeight)} transform={`scale(${typeScale})`}>
      <div className="canvas-diagram-content">{diagram.content}</div>
    </foreignObject>
    <path className="canvas-diagram-footer-line" d={`M 1 ${box.height-15*typeScale} H ${box.width-1}`}/>
    {(['n','e','s','w'] as const).map(edge=><g key={edge} className={`canvas-diagram-edge-resize edge-${edge}`} data-diagram-resize="true" data-diagram-edge={edge} tabIndex={0} role="button" aria-label={`调整画布波形图${edgeLabels[edge]}`} onPointerDown={event=>begin(event,'resize',edge)}>
      <title>拖动{edgeLabels[edge]}调整图框大小</title>
      <rect x={edge==='w'?-handleWidth/2:edge==='e'?box.width-handleWidth/2:cornerSize/2} y={edge==='n'?-handleWidth/2:edge==='s'?box.height-handleWidth/2:cornerSize/2} width={edge==='e'||edge==='w'?handleWidth:box.width-cornerSize} height={edge==='n'||edge==='s'?handleWidth:box.height-cornerSize} fill="transparent"/>
    </g>)}
    {(['nw','ne','sw'] as const).map(edge=><g key={edge} className={`canvas-diagram-corner-resize edge-${edge}`} data-diagram-resize="true" data-diagram-edge={edge} transform={`translate(${edge.includes('e')?box.width:0} ${edge.includes('s')?box.height:0}) scale(${handleScale})`} tabIndex={0} role="button" aria-label={`调整画布波形图${edgeLabels[edge]}`} onPointerDown={event=>begin(event,'resize',edge)}>
      <title>拖动{edgeLabels[edge]}调整图框大小</title><rect x="-10" y="-10" width="20" height="20" fill="transparent"/><rect className="canvas-diagram-corner-dot" x="-3" y="-3" width="6" height="6" rx="1"/>
    </g>)}
    <g className="canvas-diagram-resize" data-diagram-resize="true" data-diagram-edge="se" transform={`translate(${box.width-20*handleScale} ${box.height-20*handleScale}) scale(${handleScale})`} tabIndex={0} role="button" aria-label="调整画布波形图大小" onPointerDown={event=>begin(event,'resize')}>
      <title>拖动或用方向键调整图框大小</title>
      <rect x="-5" y="-5" width="28" height="28" fill="transparent"/>
      <path d="M 5 16 L 16 5 M 11 16 L 16 11"/>
    </g>
  </g>
}
