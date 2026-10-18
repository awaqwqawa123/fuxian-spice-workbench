import { useCallback, useEffect, useState } from 'react'

export type WorkbenchTheme = 'light' | 'dark' | 'warm' | 'classic' | 'graphite' | 'minimal' | 'ocean' | 'forest' | 'violet' | 'rose' | 'blueprint' | 'amber'
export type GridSize = 10 | 20 | 40 | 80
export interface AppearancePreferences {
  theme: WorkbenchTheme
  density: 'comfortable' | 'compact'
  typography: 'standard' | 'larger'
  gridSize: GridSize
  canvasColor: string | null
  wireColor: string | null
  deviceColor: string | null
}
export const APPEARANCE_STORAGE_KEY = 'fuxian-appearance-v1'
export const THEME_COLLECTION_STORAGE_KEY = 'fuxian-appearance-collection-v1'
export const GRID_SIZES: readonly GridSize[] = [10, 20, 40, 80]
export const WORKBENCH_THEMES: readonly WorkbenchTheme[] = ['light', 'dark', 'warm', 'classic', 'graphite', 'minimal', 'ocean', 'forest', 'violet', 'rose', 'blueprint', 'amber']
export const THEME_PRESETS: Record<WorkbenchTheme, {
  label: string; description: string; canvas: string; wire: string; device: string; panel: string; ink: string
  rail: string; accent: string; scheme: 'light' | 'dark'
}> = {
  light: { label: '清晨 · 工程白', description: '明亮画布，沉稳蓝色与清晰层级', canvas: '#fcfdff', wire: '#277c76', device: '#334b69', panel: '#f0f3f8', ink: '#243247', rail: '#172338', accent: '#3264d8', scheme: 'light' },
  dark: { label: '深空 · 石墨黑', description: '深蓝工作台，适合专注与长时间绘图', canvas: '#151e2d', wire: '#75c9b4', device: '#b5c9e9', panel: '#182235', ink: '#e1e8f4', rail: '#0e1727', accent: '#80aaff', scheme: 'dark' },
  warm: { label: '手稿 · 暖纸色', description: '温和纸面与墨色，适合长时间阅读', canvas: '#faf6ec', wire: '#60733a', device: '#70583d', panel: '#f0eadf', ink: '#493f33', rail: '#302a24', accent: '#79603d', scheme: 'light' },
  classic: { label: '经典 · 工程绿', description: '熟悉的绿色强调，沉稳的仪器风格', canvas: '#f8fafb', wire: '#237761', device: '#244c65', panel: '#eef2f5', ink: '#243746', rail: '#193632', accent: '#1c715e', scheme: 'light' },
  graphite: { label: '石墨 · 专注灰', description: '中性深灰底色，减少长时间工作的眩光', canvas: '#191c21', wire: '#8bc8b5', device: '#c5cdd9', panel: '#23272e', ink: '#e5e9ef', rail: '#13161b', accent: '#a3c0e4', scheme: 'dark' },
  minimal: { label: '极简 · 银雾白', description: '浅色导航与银灰层次，轻盈简洁', canvas: '#ffffff', wire: '#527f86', device: '#465469', panel: '#f3f4f6', ink: '#293344', rail: '#f3f4f6', accent: '#52657a', scheme: 'light' },
  ocean: { label: '海盐 · 青瓷白', description: '清透的青白画布，搭配海蓝色导航', canvas: '#f6fcfd', wire: '#0f7b84', device: '#285b70', panel: '#e9f5f7', ink: '#244755', rail: '#124655', accent: '#08798b', scheme: 'light' },
  forest: { label: '森林 · 墨绿黑', description: '深绿色工作台，柔和的薄荷色强调', canvas: '#122921', wire: '#70ccb0', device: '#c0dbc8', panel: '#1c352b', ink: '#dfede4', rail: '#0b1914', accent: '#7dd7a5', scheme: 'dark' },
  violet: { label: '暮紫 · 夜幕紫', description: '深紫底色与淡紫线条，安静而鲜明', canvas: '#211b32', wire: '#b5a1ee', device: '#dfd1f6', panel: '#2b243f', ink: '#eee7fa', rail: '#151024', accent: '#b8a1f2', scheme: 'dark' },
  rose: { label: '玫瑰 · 柔雾粉', description: '柔和粉白纸面，克制的玫瑰色强调', canvas: '#fffafb', wire: '#8e677a', device: '#63465c', panel: '#f9eef2', ink: '#493242', rail: '#47303e', accent: '#ae456e', scheme: 'light' },
  blueprint: { label: '蓝图 · 制图蓝', description: '经典蓝图底色，清晰的冰蓝器件线条', canvas: '#132f50', wire: '#bce6f4', device: '#e5f2ff', panel: '#173a5c', ink: '#e1f0fb', rail: '#071b31', accent: '#75c6f4', scheme: 'dark' },
  amber: { label: '琥珀 · 仪表黑', description: '深棕黑底与琥珀金色，仪表台的质感', canvas: '#1b1711', wire: '#efbd60', device: '#e1d2b7', panel: '#2b241a', ink: '#f3e8d4', rail: '#15100a', accent: '#f4bb52', scheme: 'dark' },
}
export const DEFAULT_APPEARANCE: AppearancePreferences = { theme: 'light', density: 'comfortable', typography: 'standard', gridSize: 20, canvasColor: null, wireColor: null, deviceColor: null }
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function validColor(value: unknown): string | null {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : null
}

/** Accept only bounded display preferences; never inject arbitrary saved CSS. */
export function normalizeAppearance(value: unknown): AppearancePreferences {
  const saved = value && typeof value === 'object' ? value as Partial<AppearancePreferences> : {}
  return {
    theme: WORKBENCH_THEMES.includes(saved.theme as WorkbenchTheme) ? saved.theme! : 'light',
    density: saved.density === 'compact' ? 'compact' : 'comfortable',
    typography: saved.typography === 'larger' ? 'larger' : 'standard',
    gridSize: GRID_SIZES.includes(saved.gridSize as GridSize) ? saved.gridSize as GridSize : 20,
    canvasColor: validColor(saved.canvasColor), wireColor: validColor(saved.wireColor), deviceColor: validColor(saved.deviceColor),
  }
}

function browserStorage(): StorageLike | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage } catch { return undefined }
}
export function loadAppearance(storage = browserStorage()): AppearancePreferences {
  try { return normalizeAppearance(JSON.parse(storage?.getItem(APPEARANCE_STORAGE_KEY) ?? 'null')) } catch { return { ...DEFAULT_APPEARANCE } }
}
export function saveAppearance(value: AppearancePreferences, storage = browserStorage()): boolean {
  try { if (!storage) return false; storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(normalizeAppearance(value))); return true } catch { return false }
}
export function appearanceColors(value: AppearancePreferences) {
  const clean = normalizeAppearance(value), preset = THEME_PRESETS[clean.theme]
  return { canvas: clean.canvasColor ?? preset.canvas, wire: clean.wireColor ?? preset.wire, device: clean.deviceColor ?? preset.device }
}

/** Derive annotation ink from custom canvas luminance so labels remain readable. */
export function isDarkCanvas(color: string): boolean {
  const rgb = [1, 3, 5].map(i => Number.parseInt(color.slice(i, i + 2), 16) / 255)
  return rgb.reduce((sum, value, i) => sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i], 0) < .24
}
export function applyAppearance(value: AppearancePreferences, root = typeof document === 'undefined' ? undefined : document.documentElement) {
  if (!root) return
  const clean = normalizeAppearance(value), colors = appearanceColors(clean), darkCanvas = isDarkCanvas(colors.canvas)
  root.dataset.workbenchTheme = clean.theme
  root.dataset.workbenchDensity = clean.density
  root.dataset.workbenchTypography = clean.typography
  root.style.setProperty('--ui-control-height', clean.density === 'compact' ? '32px' : '36px')
  root.style.setProperty('--ui-space-unit', clean.density === 'compact' ? '6px' : '8px')
  root.style.setProperty('--ui-font-scale', clean.typography === 'larger' ? '1.12' : '1')
  root.dataset.workbenchTone = THEME_PRESETS[clean.theme].scheme
  root.dataset.canvasTone = darkCanvas ? 'dark' : 'light'
  root.style.setProperty('--canvas-background', colors.canvas)
  root.style.setProperty('--canvas-wire', colors.wire)
  root.style.setProperty('--canvas-device', colors.device)
  root.style.setProperty('--canvas-ink', darkCanvas ? '#d6e0e7' : '#405361')
  root.style.setProperty('--canvas-muted', darkCanvas ? '#a2b3bf' : '#687a87')
  root.style.setProperty('--canvas-grid', darkCanvas ? '#394b63' : '#d3dce8')
  root.style.setProperty('--canvas-label-background', darkCanvas ? '#24323b' : '#f0f4f6')
}

/** Preferences are local UI settings, not part of a circuit or its undo stack. */
export function useAppearance() {
  const [appearance, updateAppearance] = useState<AppearancePreferences>(() => loadAppearance())
  const [status, setStatus] = useState<{ persisted: boolean; message: string | null }>({ persisted: true, message: null })
  // Applying on mount and receiving another tab's preferences must never write them back.
  useEffect(() => { applyAppearance(loadAppearance()) }, [])
  const setAppearance = useCallback((value: AppearancePreferences): boolean => {
    const clean = normalizeAppearance(value)
    applyAppearance(clean)
    updateAppearance(clean)
    const persisted = saveAppearance(clean)
    setStatus({ persisted, message: persisted ? null : '外观已在当前窗口生效，但未能保存到本机。请重试；刷新后可能恢复上次保存的外观。' })
    return persisted
  }, [])
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_STORAGE_KEY && event.key !== null) return
      // Ignore sessionStorage and unrelated stores that happen to use the same key.
      if (event.storageArea && event.storageArea !== browserStorage()) return
      const next = loadAppearance()
      applyAppearance(next)
      updateAppearance(next)
      setStatus({ persisted: true, message: null })
    }
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [])
  return [appearance, setAppearance, status] as const
}
export interface ThemeCollection { favorites: WorkbenchTheme[]; recent: WorkbenchTheme[] }
export function normalizeThemeCollection(value: unknown): ThemeCollection {
  const saved = value && typeof value === 'object' ? value as Partial<ThemeCollection> : {}
  const themes = (input: unknown, limit: number) => Array.isArray(input) ? [...new Set(input.filter((item): item is WorkbenchTheme => WORKBENCH_THEMES.includes(item)))].slice(0, limit) : []
  return { favorites: themes(saved.favorites, 12), recent: themes(saved.recent, 6) }
}
export function loadThemeCollection(storage = browserStorage()): ThemeCollection {
  try { return normalizeThemeCollection(JSON.parse(storage?.getItem(THEME_COLLECTION_STORAGE_KEY) ?? 'null')) } catch { return { favorites: [], recent: [] } }
}
export function saveThemeCollection(value: ThemeCollection, storage = browserStorage()): boolean {
  try { if (!storage) return false; storage.setItem(THEME_COLLECTION_STORAGE_KEY, JSON.stringify(normalizeThemeCollection(value))); return true } catch { return false }
}
