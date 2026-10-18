import { useCallback, useEffect, useRef, useState } from 'react'
import { MoveHorizontal } from 'lucide-react'

export default function SidebarResizeHandle({ label, controls, width, min, max, direction, hidden, onResize, onReset }: {
  label: string; controls: string; width: number; min: number; max: number; direction: 1 | -1; hidden: boolean
  onResize: (width: number) => void; onReset: () => void
}) {
  const handle = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; width: number; horizontal: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)
  const stopDrag = useCallback(() => {
    const pointerId = drag.current?.pointerId
    drag.current = null
    setDragging(false)
    if (pointerId !== undefined && handle.current?.hasPointerCapture(pointerId)) handle.current.releasePointerCapture(pointerId)
  }, [])
  useEffect(() => { if (hidden) stopDrag() }, [hidden, stopDrag])
  useEffect(() => {
    window.addEventListener('blur', stopDrag)
    return () => { window.removeEventListener('blur', stopDrag); drag.current = null }
  }, [stopDrag])
  const resize = (value: number) => onResize(Math.round(Math.max(min, Math.min(max, value))))
  return <div ref={handle} className={`sidebar-resize-handle${dragging ? ' is-dragging' : ''}`} role="separator" aria-label={label} aria-orientation="vertical" aria-controls={controls} aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(width)} aria-valuetext={`${Math.round(width)} 像素`} hidden={hidden} tabIndex={0} title={`${label} · 左右拖动中间箭头或按方向键调整 · 双击箭头恢复默认宽度`}
    onPointerDown={event => {
      if (event.button !== 0 || event.target === event.currentTarget || drag.current) return
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus()
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width, horizontal: false }
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={event => {
      const start = drag.current
      if (!start || start.pointerId !== event.pointerId) return
      if (!(event.buttons & 1)) { stopDrag(); return }
      const dx = event.clientX - start.x, dy = event.clientY - start.y
      // Decide the gesture before changing any saved width. Vertical scroll
      // gestures and small pointer jitter must never resize a panel.
      if (!start.horizontal) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 5) return
        if (Math.abs(dy) >= Math.abs(dx)) { stopDrag(); return }
        start.horizontal = true; setDragging(true)
      }
      event.preventDefault(); event.stopPropagation(); resize(start.width + dx * direction)
    }}
    onPointerUp={event => {
      if (drag.current?.pointerId !== event.pointerId) return
      event.preventDefault(); event.stopPropagation(); stopDrag()
    }}
    onPointerCancel={stopDrag}
    onLostPointerCapture={stopDrag}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); onReset() }}
    onKeyDown={event => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); stopDrag(); return }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      resize(event.key === 'Home' ? min : event.key === 'End' ? max : width + (event.key === 'ArrowRight' ? 1 : -1) * direction * (event.shiftKey ? 40 : 12))
    }}><span className="sidebar-resize-grip" aria-hidden="true"><MoveHorizontal size={10} /></span></div>
}
