import type { SidebarId, WorkspaceLayoutState } from './workspace-layout'

export const SIDEBAR_WIDTHS_STORAGE = 'fuxian-workspace-widths-v1'
export const SIDEBAR_HANDLE = 12
export const SIDEBAR_LIMITS = {
  left: { min: 192, max: 620, default: 232 },
  right: { min: 260, max: 760, default: 320 },
  // Chat may occupy all space left by the canvas and other open panels.
  // sizeWorkspace supplies the finite, viewport-specific splitter maximum;
  // keeping the preference uncapped lets a wide desktop restore it later.
  ai: { min: 300, max: Number.POSITIVE_INFINITY, default: 360 },
} as const
const COMPACT_MINIMUMS = { left: 160, right: 220, ai: 260 } as const
export type SidebarWidths = Record<SidebarId, number>
const panels: SidebarId[] = ['left', 'right', 'ai']
export const defaultSidebarWidths = (): SidebarWidths => ({ left: 232, right: 320, ai: 360 })

/** Only layout preferences live here. A denied or malformed storage entry is harmless. */
export function readSidebarWidths(): SidebarWidths {
  const widths = defaultSidebarWidths()
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SIDEBAR_WIDTHS_STORAGE) ?? 'null')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return widths
    for (const id of panels) {
      const value = (stored as Record<string, unknown>)[id], { max } = SIDEBAR_LIMITS[id]
      if (typeof value === 'number' && Number.isFinite(value)) widths[id] = Math.max(COMPACT_MINIMUMS[id], Math.min(max, Math.round(value)))
    }
  } catch { /* Private browsing and disabled storage retain in-memory resizing. */ }
  return widths
}
export function saveSidebarWidths(widths: SidebarWidths) {
  try { localStorage.setItem(SIDEBAR_WIDTHS_STORAGE, JSON.stringify(widths)) } catch { /* Keep the live layout usable. */ }
}

/** Temporary compact-mode sizing never overwrites the user's preferred widths or open panels. */
export function sizeWorkspace(containerWidth: number, preferred: SidebarWidths, layout: WorkspaceLayoutState) {
  const width = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 1440
  // Browser zoom and narrow windows need more room to draw. Ease this reserve
  // away on wide screens so large user-selected panels remain adjustable.
  const centerMin = Math.min(width, Math.max(320, Math.min(width * .535, 320 + Math.max(0, 1600 - width) * .62)))
  // A docked assistant narrower than 260px cannot fit its tabs, actions or
  // composer. On very narrow windows it floats over the canvas instead of
  // silently squeezing both surfaces below their usable widths.
  const overlayAi = layout.aiOpen && layout.priority === 'ai' && width < centerMin + COMPACT_MINIMUMS.ai + SIDEBAR_HANDLE
  if (overlayAi) return {
    visible: { left: false, right: false, ai: true },
    widths: { left: 0, right: 0, ai: 0 },
    min: { left: 0, right: 0, ai: 0 },
    max: { left: 0, right: 0, ai: 0 },
    centerMin,
    center: width,
    overlayAi,
  }
  const compactRatio = Math.max(0, Math.min(1, (1200 - width) / 200))
  const minimums = Object.fromEntries(panels.map(id => [id, Math.round(SIDEBAR_LIMITS[id].min + (COMPACT_MINIMUMS[id] - SIDEBAR_LIMITS[id].min) * compactRatio)])) as SidebarWidths
  const order: SidebarId[] = [layout.priority, ...(['right', 'ai', 'left'] as SidebarId[]).filter(id => id !== layout.priority)]
  const open = { left: layout.leftOpen, right: layout.rightOpen, ai: layout.aiOpen }
  const visible = { left: false, right: false, ai: false }, widths = { left: 0, right: 0, ai: 0 }
  let remaining = Math.max(0, width - centerMin)
  const included: SidebarId[] = []
  for (const id of order) {
    if (!open[id]) continue
    const minimum = Math.min(minimums[id], Math.max(0, width - centerMin - SIDEBAR_HANDLE))
    if (remaining < minimum + SIDEBAR_HANDLE || minimum <= 0 || width < centerMin + minimums[id] + SIDEBAR_HANDLE) continue
    visible[id] = true; widths[id] = minimum; remaining -= minimum + SIDEBAR_HANDLE; included.push(id)
  }
  for (const id of included) {
    const target = Math.max(minimums[id], Math.min(SIDEBAR_LIMITS[id].max, preferred[id]))
    const extra = Math.min(remaining, Math.max(0, target - widths[id]))
    widths[id] += extra; remaining -= extra
  }
  const max = { left: 0, right: 0, ai: 0 }, min = { left: 0, right: 0, ai: 0 }
  for (const id of included) {
    const occupied = included.reduce((sum, other) => sum + SIDEBAR_HANDLE + (other === id ? 0 : widths[other]), 0)
    max[id] = Math.max(0, Math.min(SIDEBAR_LIMITS[id].max, width - centerMin - occupied))
    min[id] = Math.min(minimums[id], max[id])
  }
  return { visible, widths, min, max, centerMin, center: width - included.reduce((sum, id) => sum + widths[id] + SIDEBAR_HANDLE, 0), overlayAi: false }
}
