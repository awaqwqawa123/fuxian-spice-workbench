import {useEffect,useLayoutEffect,useRef,useState,type RefObject} from 'react'
import type {XY} from '../core/drawing'
import {clampCanvasZoom} from '../core/canvas-zoom'

type View={center:XY;zoom:number}
type Size={width:number;height:number}
const same=(a:View,b:View)=>a.zoom===b.zoom&&a.center.x===b.center.x&&a.center.y===b.center.y

// Navigation changes only the SVG camera. Keep the circuit and embedded plots
// out of React's high-frequency input path, then publish one settled snapshot.
export function useCanvasNavigation(svg:RefObject<SVGSVGElement|null>,zoom:number,onZoom:(zoom:number)=>void,size:RefObject<Size>,grid:number){
  const [view,setView]=useState<View>({center:{x:600,y:320},zoom})
  const current=useRef(view),pending=useRef(false),frame=useRef<number|null>(null),idle=useRef<ReturnType<typeof setTimeout>|null>(null)
  const wheelBounds=useRef<DOMRect|null>(null),publishedZoom=useRef(zoom),previousZoom=useRef(zoom)
  const layers=useRef<{canvas:SVGSVGElement;rects:Element[];pattern:Element|null}|null>(null)
  const options=useRef({onZoom,grid});options.current={onZoom,grid}
  function clearScheduled(){
    if(frame.current!==null)window.cancelAnimationFrame?.(frame.current)
    if(idle.current!==null)clearTimeout(idle.current)
    frame.current=null;idle.current=null
  }
  function paint(){
    const canvas=svg.current;if(!canvas)return
    if(layers.current?.canvas!==canvas)layers.current={canvas,rects:[...canvas.querySelectorAll('.canvas-viewport-background,.canvas-viewport-grid')],pattern:canvas.querySelector('#editor-dot-grid')}
    const {center,zoom:scale}=current.current,{width,height}=size.current
    const w=width/scale,h=height/scale,x=center.x-w/2,y=center.y-h/2
    canvas.setAttribute('viewBox',`${x} ${y} ${w} ${h}`)
    for(const rect of layers.current.rects){
      rect.setAttribute('x',String(x));rect.setAttribute('y',String(y));rect.setAttribute('width',String(w));rect.setAttribute('height',String(h))
    }
    const base=options.current.grid,step=base*Math.pow(2,Math.max(0,Math.ceil(Math.log2(6/(base*scale)))))
    const pattern=layers.current.pattern
    pattern?.setAttribute('width',String(step));pattern?.setAttribute('height',String(step));pattern?.firstElementChild?.setAttribute('r',String(.7/scale))
  }
  function commit(){
    clearScheduled();wheelBounds.current=null
    if(!pending.current)return
    pending.current=false;paint()
    const next=current.current
    setView(previous=>same(previous,next)?previous:next)
    if(publishedZoom.current!==next.zoom){publishedZoom.current=next.zoom;options.current.onZoom(next.zoom)}
  }
  function navigate(center:XY,nextZoom=current.current.zoom,settle=true){
    const next={center,zoom:nextZoom};if(same(current.current,next))return
    current.current=next;pending.current=true
    if(frame.current===null){
      if(typeof window.requestAnimationFrame==='function')frame.current=window.requestAnimationFrame(()=>{frame.current=null;paint()})
      else paint()
    }
    if(idle.current!==null)clearTimeout(idle.current)
    idle.current=settle?setTimeout(commit,140):null
  }
  function jump(center:XY,nextZoom:number){navigate(center,nextZoom,false);commit()}
  function wheel(clientX:number,clientY:number,delta:number){
    const canvas=svg.current;if(!canvas)return
    const bounds=wheelBounds.current??canvas.getBoundingClientRect()
    wheelBounds.current=bounds
    const state=current.current,next=clampCanvasZoom(state.zoom*Math.exp(-Math.max(-160,Math.min(160,delta))*.0025))
    if(next===state.zoom)return
    // Calculate against the newest requested camera, including events that
    // arrived before the next animation frame. No layout read per wheel tick.
    const anchor=bounds.width>0&&bounds.height>0?{
      x:state.center.x+(clientX-bounds.left-bounds.width/2)/state.zoom,
      y:state.center.y+(clientY-bounds.top-bounds.height/2)/state.zoom,
    }:new DOMPoint(clientX,clientY).matrixTransform(canvas.getScreenCTM()!.inverse())
    const ratio=state.zoom/next
    navigate({x:anchor.x+(state.center.x-anchor.x)*ratio,y:anchor.y+(state.center.y-anchor.y)*ratio},next)
  }
  useLayoutEffect(()=>{
    if(previousZoom.current===zoom)return
    previousZoom.current=zoom
    // A delayed acknowledgment of our own snapshot must not replace newer input.
    if(publishedZoom.current===zoom)return
    publishedZoom.current=zoom
    if(current.current.zoom===zoom)return
    clearScheduled();pending.current=false;wheelBounds.current=null
    current.current={center:current.current.center,zoom};setView(current.current);paint()
  },[zoom])
  useLayoutEffect(()=>{wheelBounds.current=null},[size.current.width,size.current.height])
  // An unrelated selection/hover render or host resize must preserve the live camera.
  useLayoutEffect(paint)
  useEffect(()=>()=>{clearScheduled();pending.current=false},[])
  return{view,current,pending,navigate,jump,commit,wheel}
}
