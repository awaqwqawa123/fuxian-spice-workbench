import { useEffect, useRef, type ReactNode } from 'react'
import { MessageSquare, Minus, Sparkles, BookOpenText, X } from 'lucide-react'

/** A companion surface: drawing remains available while a task runs. */
export default function AssistantSidebar({ visible, onMinimize, onClose, children, explanation, activeTab = 'chat', onTabChange }: {
  visible: boolean
  onMinimize: () => void
  onClose: () => void
  children: ReactNode
  explanation?: ReactNode
  activeTab?: 'chat' | 'explain'
  onTabChange?: (tab: 'chat' | 'explain') => void
}) {
  const panel = useRef<HTMLElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!visible) return
    const active = document.activeElement
    if (active instanceof HTMLElement && !panel.current?.contains(active)) returnFocus.current = active
  }, [visible])

  function dismiss(action: () => void) {
    if (panel.current?.contains(document.activeElement) && returnFocus.current?.isConnected) returnFocus.current.focus()
    action()
  }

  return <aside ref={panel} id="workspace-ai" className="assistant-sidebar" aria-label="AI 助手侧栏" hidden={!visible} onKeyDown={event => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    dismiss(onMinimize)
  }}>
    <header className="assistant-sidebar-heading">
      <div><span className="assistant-sidebar-kicker">CIRCUIT ASSISTANT</span><h2><Sparkles size={18} />{activeTab==='explain'?'电路解释':'电路绘制'}</h2></div>
      <div className="assistant-sidebar-controls">
        <button type="button" aria-label="收起 AI 助手" title="收起侧栏，保留会话与任务 (Esc)" onClick={() => dismiss(onMinimize)}><Minus size={17} /></button>
        <button type="button" aria-label="关闭 AI 助手侧栏" title="关闭助手面板" onClick={() => dismiss(onClose)}><X size={17} /></button>
      </div>
    </header>
    <p className="assistant-sidebar-hint">{activeTab==='explain'?'项目子对话 · 只解释当前电路':'项目主对话 · 绘制和修改电路'}</p>
    {explanation !== undefined && <div className="assistant-workspace-tabs" role="tablist" aria-label="电路对话" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const tabs: ('chat' | 'explain')[] = ['chat','explain']
      const next = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'explain' : tabs[(tabs.indexOf(activeTab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
      onTabChange?.(next)
      panel.current?.querySelector<HTMLButtonElement>(`#assistant-${next}-tab`)?.focus()
    }}><button type="button" id="assistant-chat-tab" role="tab" aria-selected={activeTab === 'chat'} aria-controls="assistant-chat-panel" tabIndex={activeTab === 'chat' ? 0 : -1} onClick={() => onTabChange?.('chat')}><MessageSquare size={14}/><span className="assistant-tab-label">绘制</span></button><button type="button" id="assistant-explain-tab" role="tab" aria-selected={activeTab === 'explain'} aria-controls="assistant-explain-panel" tabIndex={activeTab === 'explain' ? 0 : -1} onClick={() => onTabChange?.('explain')}><BookOpenText size={14}/><span className="assistant-tab-label">解释</span></button></div>}
    <div className="assistant-sidebar-content">{explanation === undefined ? children : <><div id="assistant-chat-panel" className="assistant-tab-panel assistant-chat-panel" role="tabpanel" aria-labelledby="assistant-chat-tab" hidden={activeTab !== 'chat'}>{children}</div><div id="assistant-explain-panel" className="assistant-tab-panel assistant-explain-panel" role="tabpanel" aria-labelledby="assistant-explain-tab" hidden={activeTab !== 'explain'}>{explanation}</div></>}</div>
  </aside>
}
