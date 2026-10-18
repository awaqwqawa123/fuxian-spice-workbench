import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChartNoAxesCombined, CircuitBoard, Columns2, Maximize, PanelLeftOpen, PanelRightClose, PanelRightOpen, SlidersHorizontal } from 'lucide-react'
import SidebarResizeHandle from './SidebarResizeHandle'

export type SinglePageWorkspaceMode = 'split' | 'schematic' | 'waveform'
export type WorkspaceSidebarTab = 'waveform' | 'properties'
export interface SinglePageWorkspaceProps {
  schematic: ReactNode
  waveform: ReactNode
  properties?: ReactNode
  sidebarTab?: WorkspaceSidebarTab
  onSidebarTabChange?: (tab: WorkspaceSidebarTab) => void
  selectionKey?: string
  /** Local UI preferences are scoped to the project, separately from analysis data. */
  layoutKey?: string
  mode?: SinglePageWorkspaceMode
  onModeChange?: (mode: SinglePageWorkspaceMode) => void
  onFitBoth?: () => void
  onRestoreLayout?: () => void
}
const defaultRatio = .45
const storageKey = (key?: string) => `fuxian.single-page-layout:${key ?? 'default'}`
export function readSinglePageLayout(key?: string): { ratio: number; mode: SinglePageWorkspaceMode } {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(key)) ?? 'null')
    const legacy = Number(localStorage.getItem('fuxian.single-page-split'))
    const ratio = saved?.ratio ?? legacy
    return {
      ratio: Number.isFinite(ratio) && ratio >= .3 && ratio <= .65 ? ratio : defaultRatio,
      mode: ['split', 'schematic', 'waveform'].includes(saved?.mode) ? saved.mode : 'split',
    }
  } catch { return { ratio: defaultRatio, mode: 'split' } }
}

export default function SinglePageWorkspace({ schematic, waveform, properties, sidebarTab = 'waveform', onSidebarTabChange, selectionKey, layoutKey, mode: controlledMode, onModeChange, onFitBoth, onRestoreLayout }: SinglePageWorkspaceProps) {
  const host = useRef<HTMLDivElement>(null)
  const schematicHost = useRef<HTMLDivElement>(null)
  const waveformHost = useRef<HTMLElement>(null)
  const focusAfterChange = useRef<'schematic' | 'waveform' | null>(null)
  const [width, setWidth] = useState(1000)
  const [tab, setTab] = useState<'schematic' | 'waveform'>('waveform')
  const [savedLayout, setSavedLayout] = useState(() => ({ key: layoutKey, ...readSinglePageLayout(layoutKey) }))
  // Resolve project switches before effects so a former project's preference
  // cannot be written to the new project's storage by a stale effect.
  const layout = savedLayout.key === layoutKey ? savedLayout : { key: layoutKey, ...readSinglePageLayout(layoutKey) }
  const mode = controlledMode ?? layout.mode
  const ratio = layout.ratio
  useEffect(() => { if (savedLayout.key !== layoutKey) setSavedLayout({ key: layoutKey, ...readSinglePageLayout(layoutKey) }) }, [layoutKey, savedLayout.key])
  useEffect(() => {
    const element = host.current
    if (!element) return
    const update = () => { const next = element.getBoundingClientRect().width; if (next > 0) setWidth(next) }
    update(); const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(element); window.addEventListener('resize', update)
    return () => { observer?.disconnect(); window.removeEventListener('resize', update) }
  }, [])
  useEffect(() => {
    try { localStorage.setItem(storageKey(layoutKey), JSON.stringify({ ratio, mode })) } catch { /* Interaction remains available when storage is full. */ }
  }, [layoutKey, ratio, mode])
  useEffect(() => { if (mode === 'split') setTab('waveform') }, [selectionKey, sidebarTab, mode])
  useEffect(() => {
    const region = focusAfterChange.current === 'schematic' ? schematicHost.current : focusAfterChange.current === 'waveform' ? waveformHost.current : null
    if (!region || region.hidden) return
    const target = region.querySelector<HTMLElement>('svg.editor-canvas,button:not(:disabled),select,input,[tabindex="0"]')
    ;(target ?? region).focus()
    focusAfterChange.current = null
  }, [mode, tab])
  const changeMode = (next: SinglePageWorkspaceMode) => {
    focusAfterChange.current = next === 'schematic' ? 'schematic' : 'waveform'
    setTab(next === 'schematic' ? 'schematic' : 'waveform')
    setSavedLayout({ ...layout, mode: next })
    onModeChange?.(next)
  }
  const restore = () => {
    setSavedLayout({ key: layoutKey, ratio: defaultRatio, mode: 'split' })
    focusAfterChange.current = 'waveform'; setTab('waveform'); onModeChange?.('split'); onRestoreLayout?.()
  }
  const sharedSidebar = properties !== undefined
  const narrow = width < (sharedSidebar ? 560 : 768)
  const min = Math.max(sharedSidebar ? 240 : 320, width * .3), max = Math.min(width - (sharedSidebar ? 320 : 448), width * .65)
  const left = Math.max(min, Math.min(max, width * ratio))
  const schematicHidden = mode === 'waveform' || mode === 'split' && narrow && tab !== 'schematic'
  const waveformHidden = mode === 'schematic' || mode === 'split' && narrow && tab !== 'waveform'
  const sidebarLabel = sidebarTab === 'properties' ? '专注属性' : '专注波形'
  const expandLabel = sidebarTab === 'properties' ? '展开侧边栏' : '展开波形'
  const collapseLabel = sidebarTab === 'properties' ? '收起侧边栏' : '收起波形'
  const SidebarIcon = sidebarTab === 'properties' ? SlidersHorizontal : ChartNoAxesCombined
  const ModeIcon = mode === 'schematic' ? CircuitBoard : mode === 'waveform' ? SidebarIcon : Columns2
  const iconProps = { size: 16, strokeWidth: 1.75, 'aria-hidden': true as const }
  return <div ref={host} className={`single-page-workspace v2-workspace${sharedSidebar ? ' has-shared-sidebar' : ''}${narrow ? ' is-compact' : ''} is-${mode}`} data-page-tab={tab} data-sidebar-tab={sidebarTab} data-workspace-mode={mode} style={{ '--page-schematic-width': `${left}px` } as CSSProperties}>
    <nav className="page-workspace-controls page-layout-toolbar" aria-label="工作区视图">
      <strong className="page-view-caption"><ModeIcon {...iconProps} /><span>{mode === 'schematic' ? '专注电路' : mode === 'waveform' ? sidebarLabel : sidebarTab === 'properties' ? '电路与属性' : '电路与波形'}</span></strong>
      {onFitBoth && <button className="page-view-action" aria-label="双区适配" onClick={onFitBoth} title="双区适配 · 分别适配完整电路和波形，保留固定坐标"><Maximize {...iconProps} /><span className="page-view-sr-only">双区适配</span></button>}
      <div className="page-view-modes" role="group" aria-label="显示模式">
        <button className="page-view-action" aria-label="恢复左右布局" aria-pressed={mode === 'split'} onClick={restore} title="恢复左右布局 · 恢复默认比例，保留曲线与坐标"><Columns2 {...iconProps} /><span className="page-view-sr-only">恢复左右布局</span></button>
        <button className="page-view-action" aria-label="专注电路" aria-pressed={mode === 'schematic'} onClick={() => changeMode('schematic')} title="专注电路"><CircuitBoard {...iconProps} /><span className="page-view-sr-only">专注电路</span></button>
        <button className="page-view-action" aria-label={sidebarLabel} aria-pressed={mode === 'waveform'} onClick={() => changeMode('waveform')} title={sidebarLabel}><SidebarIcon {...iconProps} /><span className="page-view-sr-only">{sidebarLabel}</span></button>
      </div>
      {mode !== 'schematic' && <button className="page-view-action page-collapse-waveform" aria-label={collapseLabel} onClick={() => changeMode('schematic')} title={collapseLabel}><PanelRightClose {...iconProps} /><span className="page-view-sr-only">{collapseLabel}</span></button>}
      {mode === 'schematic' && <button className="page-view-action page-expand-waveform" aria-label={expandLabel} onClick={() => changeMode('split')} title={expandLabel}><PanelRightOpen {...iconProps} /><span className="page-view-sr-only">{expandLabel}</span></button>}
    </nav>
    {narrow && mode === 'split' && <nav className="page-compact-tabs" aria-label="窄窗口工作区"><button className="page-view-action" aria-label="电路与参数" title="电路与参数" aria-pressed={tab === 'schematic'} onClick={() => setTab('schematic')}><CircuitBoard {...iconProps} /><span className="page-view-sr-only">电路与参数</span></button><button className="page-view-action" aria-label="波形与测量" title="波形与测量" aria-pressed={tab === 'waveform'} onClick={() => setTab('waveform')}><SidebarIcon {...iconProps} /><span className="page-view-sr-only">波形与测量</span></button><small>加宽窗口可同时查看</small></nav>}
    <div className="page-workspace-body">
      <div ref={schematicHost} className="page-schematic-host" tabIndex={-1} hidden={schematicHidden}>{schematic}</div>
      <SidebarResizeHandle label="调整电路与波形比例" controls="page-waveform-host" width={left} min={min} max={Math.max(min, max)} direction={1} hidden={narrow || mode !== 'split'} onResize={value => setSavedLayout({ ...layout, ratio: value / width })} onReset={() => setSavedLayout({ ...layout, ratio: defaultRatio })} />
      <aside ref={waveformHost} className="page-waveform-host" id="page-waveform-host" aria-label={sharedSidebar ? '波形与器件属性侧边栏' : '页面波形工作区'} tabIndex={-1} hidden={waveformHidden}>
        {sharedSidebar && <nav className="page-sidebar-tabs" role="tablist" aria-label="右侧栏内容" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'waveform' : event.key === 'End' ? 'properties' : sidebarTab === 'waveform' ? 'properties' : 'waveform'
          onSidebarTabChange?.(next)
          waveformHost.current?.querySelector<HTMLButtonElement>(`#page-sidebar-${next}-tab`)?.focus()
        }}>
          <button id="page-sidebar-waveform-tab" role="tab" title="波形" aria-selected={sidebarTab === 'waveform'} aria-controls="page-sidebar-waveform-panel" tabIndex={sidebarTab === 'waveform' ? 0 : -1} onClick={() => onSidebarTabChange?.('waveform')}><ChartNoAxesCombined {...iconProps} /><span>波形</span></button>
          <button id="page-sidebar-properties-tab" role="tab" title="器件属性" aria-selected={sidebarTab === 'properties'} aria-controls="page-sidebar-properties-panel" tabIndex={sidebarTab === 'properties' ? 0 : -1} onClick={() => onSidebarTabChange?.('properties')}><SlidersHorizontal {...iconProps} /><span>器件属性</span></button>
        </nav>}
        {sharedSidebar ? <><section id="page-sidebar-waveform-panel" className="page-sidebar-panel" role="tabpanel" aria-labelledby="page-sidebar-waveform-tab" hidden={sidebarTab !== 'waveform'}>{waveform}</section><section id="page-sidebar-properties-panel" className="page-sidebar-panel" role="tabpanel" aria-labelledby="page-sidebar-properties-tab" hidden={sidebarTab !== 'properties'}>{properties}</section></> : waveform}
      </aside>
      {mode === 'schematic' && <aside className="page-collapsed-waveform page-waveform-rail" aria-label="已收起的波形区" title="图组和测量已保留"><button className="page-view-action" aria-label="展开波形" onClick={() => changeMode('split')} title="展开波形 · 恢复原图组和观察范围"><PanelRightOpen {...iconProps} /><span className="page-view-sr-only">展开波形</span></button><SidebarIcon {...iconProps} /></aside>}
      {mode === 'waveform' && <aside className="page-collapsed-schematic" aria-label="已收起的电路区"><button className="page-view-action" aria-label="恢复左右布局" title="恢复左右布局" onClick={() => changeMode('split')}><PanelLeftOpen {...iconProps} /><span className="page-view-sr-only">恢复左右布局</span></button><CircuitBoard {...iconProps} /></aside>}
    </div>
  </div>
}
