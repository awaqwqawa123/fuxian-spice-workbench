import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ChartNoAxesCombined, PanelTop, Maximize2 } from 'lucide-react'
import { useWorkbenchDialog } from './AssistantWindow'

interface Props { visible: boolean; docked?: boolean; onDockChange?: (docked: boolean) => void; onClose: () => void; children: ReactNode }

/** Keep the waveform workspace mounted so reopening never resets its view or cursors. */
export default function WaveformDialog({ visible, docked = false, onDockChange, onClose, children }: Props) {
  const panel = useRef<HTMLElement>(null)
  const [dragging, setDragging] = useState(false)
  useWorkbenchDialog(panel, visible && !docked, onClose)
  return createPortal(
    <div className={`workbench-window-backdrop waveform-dialog-backdrop${docked ? ' is-docked' : ''}${dragging ? ' is-dragging' : ''}`} hidden={!visible}
      onMouseDown={event => { if (!docked && event.target === event.currentTarget) onClose() }}>
      <section ref={panel} className="workbench-window waveform-dialog" role={visible ? docked ? 'region' : 'dialog' : undefined}
        aria-modal={visible && !docked ? 'true' : undefined} aria-label={docked ? '顶栏停靠波形' : '放大波形'} tabIndex={-1}
        onKeyDown={event => event.stopPropagation()}>
        <header className="waveform-dialog-heading" draggable={!!onDockChange && !docked}
          onDragStart={event => { setDragging(true); event.dataTransfer.setData('text/plain', 'waveform-dock'); event.dataTransfer.effectAllowed = 'move' }}
          onDragEnd={event => { setDragging(false); if (event.clientY >= 0 && event.clientY <= 64) onDockChange?.(true) }}>
          <div><h2><ChartNoAxesCombined size={18} />波形</h2><p>{docked ? '已停靠顶栏 · 下方画布仍可操作' : '拖动标题到顶栏停靠 · 曲线与游标同步到图框'}</p></div>
          <div className="waveform-dialog-actions">{onDockChange && <button type="button" aria-label={docked ? '取消波形停靠' : '停靠波形到顶栏'} onClick={() => onDockChange(!docked)}>{docked ? <Maximize2 size={15}/> : <PanelTop size={15} />}{docked ? '放大窗口' : '停靠顶栏'}</button>}
          <button type="button" aria-label="关闭放大波形" title="返回原理图 (Esc)" onClick={onClose}><ArrowLeft size={15} />返回原理图</button></div>
        </header>
        <div className="waveform-dialog-content">{children}</div>
      </section>
    </div>, document.body,
  )
}
