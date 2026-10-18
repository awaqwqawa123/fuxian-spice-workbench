import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Code2, FileUp, Library, Sparkles, X } from 'lucide-react'
import { useWorkbenchDialog } from './AssistantWindow'

interface ModelSearchDialogProps {
  visible: boolean
  onClose: () => void
  onOpenLibrary?: () => void
  onDropDatasheet: (file: File) => void
  assistant?: ReactNode
  manual?: ReactNode
}

/** The assistant owns discovery; documents are optional attachments to its task. */
export default function ModelSearchDialog({ visible, onClose, onOpenLibrary, onDropDatasheet, assistant, manual }: ModelSearchDialogProps) {
  const panel = useRef<HTMLElement>(null)
  const [dragging, setDragging] = useState(false)
  const [dropError, setDropError] = useState('')
  useWorkbenchDialog(panel, visible, onClose)
  useEffect(() => { if (!visible) setDragging(false) }, [visible])

  return <div className="workbench-window-backdrop model-search-backdrop" hidden={!visible} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={panel} id="model-search-window" className="workbench-window model-search-window" role={visible ? 'dialog' : undefined} aria-modal={visible ? 'true' : undefined} aria-label="模型助手" tabIndex={-1}
      onDragOver={event => {
        if (!Array.from(event.dataTransfer.types).includes('Files') && !event.dataTransfer.files.length) return
        event.preventDefault(); setDragging(true)
      }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }}
      onDropCapture={() => setDragging(false)}
      onDrop={event => {
        const files = event.dataTransfer.files
        if (!files.length) return
        event.preventDefault(); setDragging(false)
        if (files.length !== 1 || !/\.(pdf|txt)$/i.test(files[0].name)) {
          setDropError('每次请拖入一份 PDF 或 TXT 规格书。'); return
        }
        setDropError(''); onDropDatasheet(files[0])
      }}>
      <header className="workbench-window-heading">
        <div><h2><Sparkles size={21}/>器件模型助手</h2><p>告诉助手你需要的器件型号和用途，自动查找资料并建立模型。</p></div>
        <div className="model-workspace-heading-actions">
          {onOpenLibrary && <button type="button" onClick={onOpenLibrary}><Library size={15}/>本地模型库</button>}
          <button type="button" aria-label="关闭模型助手" title="关闭窗口，保留任务和草稿" onClick={onClose}><X size={18}/></button>
        </div>
      </header>
      {dragging && <div className="model-search-window-drop-hint"><FileUp size={26}/>松开以添加规格书</div>}
      {dropError && <p className="model-search-error" role="alert">{dropError}</p>}
      <div className="model-search-window-body">
        <div id="model-workspace-assistant-panel">{assistant}</div>
        {manual && <details className="model-workspace-manual-tools"><summary><Code2 size={15}/>高级：手动编辑模型</summary><div id="model-workspace-manual-panel">{manual}</div></details>}
      </div>
    </section>
  </div>
}
