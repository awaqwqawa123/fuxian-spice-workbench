import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Check, Grid2X2, Palette, RotateCcw, Star, X } from 'lucide-react'
import { appearanceColors, applyAppearance, DEFAULT_APPEARANCE, GRID_SIZES, isDarkCanvas, loadThemeCollection, normalizeAppearance, saveThemeCollection, THEME_PRESETS, type AppearancePreferences, type ThemeCollection, type WorkbenchTheme } from '../core/appearance'
import { useWorkbenchDialog } from './AssistantWindow'

interface Props { value: AppearancePreferences; onChange: (value: AppearancePreferences) => boolean | void; onClose: () => void; onPreview?: (value: AppearancePreferences | null) => void }
type ThemeFilter = 'all' | 'light' | 'dark' | 'favorites' | 'recent'
const THEME_FILTERS: readonly { value: ThemeFilter; label: string }[] = [{ value: 'all', label: '全部' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'favorites', label: '收藏' }, { value: 'recent', label: '最近使用' }]

export default function AppearanceSettings({ value, onChange, onClose, onPreview }: Props) {
  const [draft, setDraft] = useState(() => normalizeAppearance(value))
  const [saveFailed, setSaveFailed] = useState(false)
  const committed = useRef(normalizeAppearance(value))
  const preview = useRef(onPreview); preview.current = onPreview
  const [externalChange, setExternalChange] = useState(false)
  const [themeFilter, setThemeFilter] = useState<ThemeFilter>('all')
  const [collection, setCollection] = useState(loadThemeCollection)
  const [collectionFailed, setCollectionFailed] = useState(false)
  const panel = useRef<HTMLElement>(null)
  function close() { applyAppearance(committed.current); preview.current?.(null); onClose() }
  useWorkbenchDialog(panel, true, close)
  useEffect(() => {
    const next = normalizeAppearance(value)
    if (JSON.stringify(next) !== JSON.stringify(committed.current)) setExternalChange(true)
    committed.current = next
    applyAppearance(draft)
  }, [value, draft])
  useEffect(() => { applyAppearance(draft); preview.current?.(draft) }, [draft])
  useEffect(() => () => { applyAppearance(committed.current); preview.current?.(null) }, [])
  const colors = appearanceColors(draft), preset = THEME_PRESETS[draft.theme]
  const themes = Object.keys(THEME_PRESETS) as WorkbenchTheme[]
  const matchingThemes = (filter: ThemeFilter) => filter === 'recent' ? collection.recent : filter === 'favorites' ? themes.filter(theme => collection.favorites.includes(theme)) : themes.filter(theme => filter === 'all' || THEME_PRESETS[theme].scheme === filter)
  const filteredThemes = matchingThemes(themeFilter)
  const darkCanvas = isDarkCanvas(colors.canvas)
  function chooseTheme(theme: WorkbenchTheme) { setDraft(old => ({ ...old, theme, canvasColor: null, wireColor: null, deviceColor: null })) }
  const changed = JSON.stringify(draft) !== JSON.stringify(committed.current)
  function apply() {
    const saved = onChange(draft)
    committed.current = { ...draft }
    if (saved === false) { setSaveFailed(true); return }
    // Only applied styles enter history; browsing a preview must not clutter it.
    saveThemeCollection({ ...collection, recent: [draft.theme, ...collection.recent.filter(theme => theme !== draft.theme)].slice(0, 6) })
    setSaveFailed(false); close()
  }
  function updateCollection(next: ThemeCollection) {
    setCollection(next)
    setCollectionFailed(!saveThemeCollection(next))
  }
  function favorite(theme: WorkbenchTheme) { updateCollection({ ...collection, favorites: collection.favorites.includes(theme) ? collection.favorites.filter(item => item !== theme) : [...collection.favorites, theme] }) }
  function restoreApplied() { setDraft({ ...committed.current }); setExternalChange(false) }
  return <div className="workbench-window-backdrop appearance-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <section ref={panel} className="workbench-window appearance-settings" role="dialog" aria-modal="true" aria-label="外观与画布" tabIndex={-1}>
      <header className="workbench-window-heading"><div><span className="workbench-window-kicker">WORKSPACE APPEARANCE</span><h2><Palette size={21} />外观与画布</h2><p>选择即预览整个工作台，点击“应用外观”保存到本机。</p></div><button type="button" aria-label="关闭外观设置" onClick={close}><X size={18} /></button></header>
      <div className="appearance-settings-body">
        <div className="appearance-preview-state" role="status"><span>{saveFailed ? '当前窗口已应用 · 尚未保存' : changed ? '预览中 · 尚未应用' : '当前已应用的外观'}</span><span>已应用：{THEME_PRESETS[committed.current.theme].label}</span>{changed && <button type="button" onClick={restoreApplied}>查看已应用外观</button>}</div>
        {externalChange && <p className="appearance-external-note" role="status">其他窗口更新了外观。当前预览保留；取消将恢复最新已应用设置。<button type="button" onClick={restoreApplied}>载入最新设置</button></p>}
        {saveFailed && <p className="appearance-save-error" role="alert">外观已在当前窗口生效，但未能保存到本机。请点击“重试保存”；关闭后可继续使用，刷新可能恢复上次保存的外观。</p>}
        <section className="appearance-reading-options" aria-label="界面布局与文字"><h3>布局与文字</h3><div><fieldset><legend>信息密度</legend>{([['comfortable', '舒适', '更宽松的间距，适合日常使用'], ['compact', '紧凑', '集中显示更多操作和参数']] as const).map(([density, label, description]) => <button type="button" key={density} aria-pressed={draft.density === density} onClick={() => setDraft(old => ({ ...old, density }))}><strong>{label}</strong><small>{description}</small></button>)}</fieldset><fieldset><legend>文字大小</legend>{([['standard', '标准', '适合常用窗口尺寸'], ['larger', '较大', '提高参数与操作文字的可读性']] as const).map(([typography, label, description]) => <button type="button" key={typography} aria-pressed={draft.typography === typography} onClick={() => setDraft(old => ({ ...old, typography }))}><strong>{label}</strong><small>{description}</small></button>)}</fieldset></div></section>
        <fieldset className="appearance-themes"><legend>界面风格</legend><div className="appearance-theme-overview"><div className="appearance-theme-filters" role="group" aria-label="筛选界面风格">{THEME_FILTERS.map(filter => <button type="button" key={filter.value} aria-pressed={themeFilter === filter.value} onClick={() => setThemeFilter(filter.value)}>{filter.label}<span>{matchingThemes(filter.value).length}</span></button>)}</div><span>当前预览 <strong>{preset.label}</strong></span></div>{collectionFailed && <p className="appearance-external-note" role="status">收藏尚未保存到本机。<button type="button" onClick={() => updateCollection(collection)}>重试保存收藏</button></p>}<div className="appearance-theme-options">{filteredThemes.map(theme => {
          const option = THEME_PRESETS[theme]
          return <div key={theme} className="appearance-theme-entry"><button type="button" data-theme={theme} aria-pressed={draft.theme === theme} onClick={() => chooseTheme(theme)} className="appearance-theme-card" style={{ '--sample-panel': option.panel, '--sample-canvas': option.canvas, '--sample-ink': option.ink, '--sample-wire': option.wire, '--sample-device': option.device, '--sample-rail': option.rail, '--sample-accent': option.accent, '--sample-grid': option.scheme === 'dark' ? '#ffffff18' : '#10203815' } as CSSProperties}>
            <span className="appearance-theme-sample" aria-hidden="true"><i className="appearance-sample-rail"><b /><b /><b /></i><i className="appearance-sample-top"><b /><em /></i><i className="appearance-sample-side"><b /><b /><b /></i><svg viewBox="0 0 140 80"><path className="sample-wire" d="M 17 30 H 43 M 90 30 H 125 V 62 H 17 V 30" /><path className="sample-device" d="M 43 30 L 48 23 L 55 37 L 62 23 L 69 37 L 76 23 L 83 37 L 90 30 M 70 62 V 70 M 60 70 H 80 M 64 74 H 76" /><circle className="sample-node" cx="125" cy="30" r="2.5" /></svg></span>
            <span className="appearance-theme-name">{option.label}{draft.theme === theme && <Check size={14} />}</span><small>{option.description}</small>
          </button><button type="button" className="appearance-theme-favorite" aria-label={`${collection.favorites.includes(theme) ? '取消收藏' : '收藏'}${option.label}`} aria-pressed={collection.favorites.includes(theme)} onClick={() => favorite(theme)}><Star size={14} fill={collection.favorites.includes(theme) ? 'currentColor' : 'none'} /></button></div>
        })}</div>{filteredThemes.length === 0 && <p className="appearance-collection-empty">{themeFilter === 'favorites' ? '还没有收藏的风格。点击风格卡片右上角的星标即可收藏。' : '还没有最近使用的风格。应用外观后会显示在这里。'}</p>}<p>选择风格后可继续调整画布配色，点击“应用外观”保存。</p></fieldset>
        <div className="appearance-detail-grid"><section className="appearance-canvas-options"><h3><Grid2X2 size={15} />画布显示</h3><label className="appearance-grid-field"><span>显示网格间距</span><select aria-label="显示网格间距" value={draft.gridSize} onChange={event => setDraft(old => ({ ...old, gridSize: Number(event.target.value) as AppearancePreferences['gridSize'] }))}>{GRID_SIZES.map(size => <option key={size} value={size}>{size} · {size === 10 ? '细' : size === 20 ? '标准' : size === 40 ? '疏' : '大'}</option>)}</select></label><p className="appearance-note">调整网格显示密度。器件与导线仍按原有连接网格吸附，已有电路位置不会变化。</p>
          {([['canvasColor', '画布背景', 'canvas'], ['wireColor', '导线颜色', 'wire'], ['deviceColor', '器件颜色', 'device']] as const).map(([key, label, colorKey]) => <label className="appearance-color-field" key={key}><span>{label}</span><code>{colors[colorKey].toUpperCase()}</code><input aria-label={label} type="color" value={colors[colorKey]} onChange={event => setDraft(old => ({ ...old, [key]: event.target.value }))} /><button type="button" aria-label={`恢复${label}`} title={`恢复${label}`} disabled={draft[key] === null} onClick={() => setDraft(old => ({ ...old, [key]: null }))}><RotateCcw size={13} /></button></label>)}
        </section><section className="appearance-preview" aria-label="画布配色预览" style={{ backgroundColor: colors.canvas, '--preview-grid-color': darkCanvas ? '#52606b' : '#b7c3c9', backgroundSize: `${draft.gridSize}px ${draft.gridSize}px` } as CSSProperties}><svg viewBox="0 0 260 180" aria-hidden="true"><g stroke={colors.wire} strokeWidth="2" fill="none"><path d="M 33 89 H 84 M 160 89 H 223 V 147 H 33 V 89" /><circle cx="223" cy="89" r="2.2" fill={colors.wire} /></g><g stroke={colors.device} strokeWidth="2" fill="none"><path d="M 84 89 H 93 V 79 H 151 V 99 H 93 V 89 M 151 89 H 160 M 115 147 V 163 M 100 163 H 130 M 105 169 H 125 M 110 175 H 120" /></g><g fill={darkCanvas ? '#d6e0e7' : '#405361'} fontFamily="var(--mono)" fontSize="12"><text x="115" y="60">R1</text><text x="110" y="119">10kΩ</text></g></svg><span style={{ color: darkCanvas ? '#a2b3bf' : '#687a87' }}>画布预览</span></section></div>
      </div>
      <footer className="workbench-window-footer"><button type="button" onClick={() => setDraft({ ...DEFAULT_APPEARANCE })}><RotateCcw size={14} />恢复默认</button><div><button type="button" onClick={close}>{saveFailed ? '关闭，保留本次应用' : '取消'}</button><button type="button" className="primary" onClick={apply}><Check size={15} />{saveFailed ? '重试保存' : '应用外观'}</button></div></footer>
    </section>
  </div>
}
