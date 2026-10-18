import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Pin, X } from 'lucide-react'

/** A nonmodal toolbar panel: outside pointer presses continue to the circuit. */
export default function ProbePopover({visible,anchor,onClose,onEscape,children}:{visible:boolean;anchor:RefObject<HTMLButtonElement|null>;onClose:()=>void;onEscape:()=>void;children:ReactNode}){
  const panel=useRef<HTMLElement>(null),close=useRef(onClose),escape=useRef(onEscape)
  close.current=onClose;escape.current=onEscape
  const [position,setPosition]=useState({left:8,top:88,maxHeight:500})
  useEffect(()=>{
    if(!visible)return
    const update=()=>{
      const box=anchor.current?.getBoundingClientRect(),width=Math.min(420,window.innerWidth-16),top=Math.max(8,Math.min((box?.bottom??80)+7,window.innerHeight-140))
      setPosition({left:Math.max(8,Math.min(box?.left??8,window.innerWidth-width-8)),top,maxHeight:Math.max(120,window.innerHeight-top-8)})
    }
    update()
    const initialFocus=panel.current?.querySelector<HTMLButtonElement>('[data-probe-mode][aria-pressed=true]')??panel.current?.querySelector<HTMLButtonElement>('[data-probe-mode]')
    initialFocus?.focus()
    const outside=(event:Event)=>{
      const target=event.target as Node|null
      if(target&&!panel.current?.contains(target)&&!anchor.current?.contains(target))close.current()
    }
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){
        event.preventDefault();event.stopImmediatePropagation();escape.current();anchor.current?.focus();return
      }
      const button=(event.target as HTMLElement|null)?.closest('[data-probe-mode]')
      if(!button||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
      event.preventDefault();event.stopPropagation()
      const buttons=[...panel.current!.querySelectorAll<HTMLButtonElement>('[data-probe-mode]')],index=buttons.indexOf(button as HTMLButtonElement)
      const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length
      buttons[next].focus();buttons[next].click()
    }
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(update)
    if(anchor.current)observer?.observe(anchor.current)
    window.addEventListener('resize',update);window.addEventListener('scroll',update,true)
    document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',outside)
    window.addEventListener('keydown',key,true)
    return()=>{observer?.disconnect();window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',outside);window.removeEventListener('keydown',key,true)}
  },[visible,anchor])
  return createPortal(<section ref={panel} id="probe-tools-popover" className="probe-tool-popover" role={visible?'dialog':undefined} aria-modal={visible?'false':undefined} aria-label="探针工具" hidden={!visible} style={position} onKeyDown={event=>event.stopPropagation()}>
    <header><strong><Pin size={15}/>探针与测量</strong><button type="button" aria-label="收起探针工具" onClick={()=>{close.current();anchor.current?.focus()}}><X size={16}/></button></header>
    {children}
  </section>,document.body)
}
