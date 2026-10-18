import { useEffect, useId, useRef, useState } from 'react'
import { Check, CircuitBoard, Copy, FolderOpen, LoaderCircle, PanelLeftClose, PanelLeftOpen, Plus, TriangleAlert } from 'lucide-react'

// CSS consumes .is-compact from this same breakpoint; do not keep a second media rule.
export const PROJECT_DRAWER_MAX_WIDTH = 760

export interface ProjectSidebarEntry {
  id: string
  title: string
  updatedAt: number | string
  deviceCount: number
}

export interface ProjectSidebarProps {
  entries: ProjectSidebarEntry[]
  activeId: string
  embedded?: boolean
  collapsed?: boolean
  onToggle?: () => void
  onSelect: (id: string) => void
  onNew: () => void
  onDuplicate: () => void
  saveState: 'saved' | 'saving' | 'error'
  error?: string
  onRetry?: () => void
  onModalChange?: (open: boolean) => void
}

function editedAt(value: number | string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return { label: '尚未保存', full: '' }
  const now = new Date()
  const today = date.toDateString() === now.toDateString()
  return {
    label: `${today ? '今天 ' : ''}${new Intl.DateTimeFormat('zh-CN', today
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { month: 'numeric', day: 'numeric' }).format(date)}`,
    full: new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(date),
  }
}

export default function ProjectSidebar({ entries, activeId, embedded = false, collapsed = false, onToggle = () => {}, onSelect, onNew, onDuplicate, saveState, error, onRetry, onModalChange }: ProjectSidebarProps) {
  const panelId = useId()
  const headingId = useId()
  const [compact, setCompact] = useState(() => !embedded && typeof window !== 'undefined' && window.innerWidth <= PROJECT_DRAWER_MAX_WIDTH)
  const panelRef = useRef<HTMLDivElement>(null)
  const railToggleRef = useRef<HTMLButtonElement>(null)
  const panelToggleRef = useRef<HTMLButtonElement>(null)
  const callbackRef = useRef({ onToggle, onModalChange })
  callbackRef.current = { onToggle, onModalChange }
  const modal = !embedded && compact && !collapsed
  const wasCollapsed = useRef(collapsed)

  useEffect(() => {
    if (embedded) { setCompact(false); return }
    if (typeof window.matchMedia === 'function') {
      const query = window.matchMedia(`(max-width: ${PROJECT_DRAWER_MAX_WIDTH}px)`)
      const update = () => setCompact(query.matches)
      update()
      query.addEventListener('change', update)
      return () => query.removeEventListener('change', update)
    }
    const update = () => setCompact(window.innerWidth <= PROJECT_DRAWER_MAX_WIDTH)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [embedded])

  useEffect(() => {
    if (embedded) return
    callbackRef.current.onModalChange?.(modal)
    if (!modal) return
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelToggleRef.current?.focus()
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        callbackRef.current.onToggle()
      } else if (event.key === 'Tab') {
        const buttons = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const first = buttons[0], last = buttons.at(-1)
        if (!first || !last) return
        if (!panelRef.current?.contains(document.activeElement)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
        event.stopPropagation()
      }
    }
    document.addEventListener('keydown', keyboard, true)
    return () => {
      document.removeEventListener('keydown', keyboard, true)
      callbackRef.current.onModalChange?.(false)
      if (priorFocus?.isConnected && !panelRef.current?.contains(priorFocus)) priorFocus.focus()
      else railToggleRef.current?.focus()
    }
  }, [modal, embedded])

  useEffect(() => {
    if (!embedded && wasCollapsed.current !== collapsed && !compact) {
      (collapsed ? railToggleRef.current : panelToggleRef.current)?.focus()
    }
    wasCollapsed.current = collapsed
  }, [collapsed, compact, embedded])

  function select(id: string) {
    onSelect(id)
    if (compact && !embedded) onToggle()
  }
  function create(duplicate = false) {
    if (duplicate) onDuplicate()
    else onNew()
    if (compact && !embedded) onToggle()
  }
  const saveLabel = saveState === 'saved' ? '已自动保存到本机' : saveState === 'saving' ? '正在保存…' : '保存失败'
  const SaveIcon = saveState === 'saved' ? Check : saveState === 'saving' ? LoaderCircle : TriangleAlert
  return <aside className={`project-sidebar${embedded ? ' is-embedded' : ''}${!embedded && collapsed ? ' is-collapsed' : ''}${!embedded && compact ? ' is-compact' : ''}`} aria-label="项目侧边栏">
    {!embedded && <div className="project-sidebar-rail" hidden={!collapsed && !compact}>
      <button ref={railToggleRef} type="button" className="project-sidebar-icon" onClick={onToggle} aria-label={collapsed ? '展开项目栏' : '收起项目栏'} title={collapsed ? '展开项目栏' : '收起项目栏'} aria-expanded={!collapsed} aria-controls={panelId}>
        <PanelLeftOpen size={19} />
      </button>
      <span className="project-sidebar-rail-line" />
      <button type="button" className="project-sidebar-icon" onClick={onNew} aria-label="新建项目" title="新建项目"><Plus size={19} /></button>
      <span className="project-sidebar-rail-count" title={`${entries.length} 个本机项目`}>{entries.length}</span>
      <span className={`project-sidebar-rail-state is-${saveState}`} title={saveLabel}><SaveIcon size={15} /><span className="project-sidebar-sr-only">{saveLabel}</span></span>
    </div>}
    {modal && <div className="project-sidebar-backdrop" aria-hidden="true" onClick={onToggle} />}
    <div ref={panelRef} id={panelId} className="project-sidebar-panel" hidden={!embedded && collapsed} role={modal ? 'dialog' : undefined} aria-modal={modal ? true : undefined} aria-labelledby={headingId}>
      <header className="project-sidebar-heading">
        <div><span className="project-sidebar-eyebrow">WORKSPACE</span><h2 id={headingId}><FolderOpen size={17} />我的项目</h2></div>
        {!embedded && <button ref={panelToggleRef} type="button" className="project-sidebar-icon" onClick={onToggle} aria-label="收起项目栏" title="收起项目栏" aria-expanded={!collapsed} aria-controls={panelId}><PanelLeftClose size={18} /></button>}
      </header>
      <div className="project-sidebar-actions">
        <button type="button" className="project-sidebar-new" onClick={() => create()}><Plus size={16} />新建项目</button>
        <button type="button" className="project-sidebar-copy" onClick={() => create(true)} disabled={!entries.some(entry => entry.id === activeId)} title="将当前项目另存为独立副本"><Copy size={14} />另存副本</button>
      </div>
      <div className="project-sidebar-section"><span>本机项目</span><span>{entries.length.toString().padStart(2, '0')}</span></div>
      <nav className="project-sidebar-list" aria-label="本机项目">
        {entries.length ? entries.map(entry => {
          const active = entry.id === activeId
          const date = editedAt(entry.updatedAt)
          return <button type="button" className={`project-sidebar-entry${active ? ' is-active' : ''}`} key={entry.id} onClick={() => select(entry.id)} aria-current={active ? 'page' : undefined} title={entry.title}>
            <span className="project-sidebar-entry-top"><CircuitBoard size={17} /><strong>{entry.title || '未命名项目'}</strong>{active && <span className="project-sidebar-current">当前</span>}</span>
            <span className="project-sidebar-entry-meta"><span>{entry.deviceCount} 个器件</span><time title={date.full}>{date.label}</time></span>
          </button>
        }) : <p className="project-sidebar-empty">从新建项目开始，<br />在这里管理你的原理图。</p>}
      </nav>
      <footer className="project-sidebar-footer">
        <div className={`project-sidebar-save is-${saveState}`} role="status"><SaveIcon size={14} /><span>{saveLabel}</span></div>
        {saveState === 'error' && <div className="project-sidebar-error"><p>{error || '本机存储暂时不可用，请导出项目备份。'}</p>{onRetry && <button type="button" onClick={onRetry}>重试保存</button>}</div>}
        {saveState === 'saved' && error && <p role="status" className="project-sidebar-warning">{error}</p>}
        <p>修改项目名称可在工作区顶部进行。<br />重要项目可随时导出备份。</p>
      </footer>
    </div>
  </aside>
}
