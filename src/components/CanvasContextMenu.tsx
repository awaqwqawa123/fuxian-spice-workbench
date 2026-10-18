import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { contextMenuPosition, type CanvasContextMenuItem, type CanvasContextRequest } from '../core/context-menu'
export type { CanvasContextMenuItem, CanvasContextRequest } from '../core/context-menu'

export interface CanvasContextMenuProps {
  request:CanvasContextRequest
  items:CanvasContextMenuItem[]
  title?:string
  onAction:(id:string)=>void
  onClose:()=>void
}

export default function CanvasContextMenu({request,items,title='原理图菜单',onAction,onClose}:CanvasContextMenuProps){
  const menu=useRef<HTMLDivElement>(null)
  const origin=useRef<Element|null>(null)
  const close=useRef(onClose);close.current=onClose
  const [at,setAt]=useState({x:request.clientX,y:request.clientY})
  function restoreFocus(){
    const target=origin.current as (Element&{focus?:(options?:FocusOptions)=>void})|null
    if(target?.isConnected)target.focus?.({preventScroll:true})
  }
  useLayoutEffect(()=>{
    const panel=menu.current;if(!panel)return
    origin.current=document.activeElement
    const rect=panel.getBoundingClientRect()
    setAt(contextMenuPosition({x:request.clientX,y:request.clientY},rect,{width:window.innerWidth,height:window.innerHeight}))
    ;(panel.querySelector<HTMLButtonElement>('button:not(:disabled)')??panel).focus({preventScroll:true})
    const outside=(event:Event)=>{if(!panel.contains(event.target as Node))close.current()}
    const resize=()=>close.current()
    document.addEventListener('pointerdown',outside,true)
    document.addEventListener('scroll',outside,true)
    window.addEventListener('resize',resize)
    return()=>{
      document.removeEventListener('pointerdown',outside,true)
      document.removeEventListener('scroll',outside,true)
      window.removeEventListener('resize',resize)
      if(panel.contains(document.activeElement)||document.activeElement===document.body)restoreFocus()
    }
  },[request])
  function keyDown(event:KeyboardEvent<HTMLDivElement>){
    // Keep the editor's global delete/rotate shortcuts out of a focused menu.
    event.stopPropagation()
    if(event.key==='Escape'||event.key==='Tab'){
      event.preventDefault();restoreFocus();onClose();return
    }
    const keys=['ArrowDown','ArrowUp','Home','End']
    if(!keys.includes(event.key))return
    event.preventDefault()
    const buttons=[...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if(!buttons.length)return
    const index=buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowUp'?(index<=0?buttons.length-1:index-1):(index+1)%buttons.length
    buttons[next].focus()
  }
  return createPortal(<div ref={menu} className="canvas-context-menu" role="menu" aria-label={title} tabIndex={-1}
    style={{left:at.x,top:at.y}} onKeyDown={keyDown} onContextMenu={event=>event.preventDefault()}>
    <div className="canvas-context-menu-title" aria-hidden="true">{title}</div>
    {items.map(item=><div key={item.id} role="none">
      {item.separatorBefore&&<div className="canvas-context-menu-separator" role="separator"/>}
      <button type="button" role="menuitem" tabIndex={-1} disabled={item.disabled} className={item.danger?'is-danger':undefined}
        onClick={()=>{restoreFocus();onClose();onAction(item.id)}}>
        <span>{item.label}</span>{item.shortcut&&<kbd>{item.shortcut}</kbd>}
      </button>
    </div>)}
  </div>,document.body)
}
