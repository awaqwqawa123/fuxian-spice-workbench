import { useCallback, useState } from 'react'

/** View preference only: measurement targets and waveform configuration stay in Project. */
export const PROBE_MARKER_VISIBILITY_KEY = 'fuxian.probe-marker-visibility.v1'
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): StorageLike | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage } catch { return undefined }
}

export function readProbeMarkerVisibility(storage = browserStorage()): boolean {
  try { return storage?.getItem(PROBE_MARKER_VISIBILITY_KEY) !== 'hidden' } catch { return true }
}

export function saveProbeMarkerVisibility(visible: boolean, storage = browserStorage()): void {
  try { storage?.setItem(PROBE_MARKER_VISIBILITY_KEY, visible ? 'visible' : 'hidden') } catch { /* The current view remains usable when storage is unavailable. */ }
}

export function useProbeMarkerVisibility(): readonly [boolean, (visible: boolean) => void] {
  const [visible, setVisible] = useState(readProbeMarkerVisibility)
  const change = useCallback((next: boolean) => {
    setVisible(next)
    saveProbeMarkerVisibility(next)
  }, [])
  return [visible, change] as const
}
