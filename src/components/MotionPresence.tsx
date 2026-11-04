import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'

interface PresenceOwner { active: boolean; completeExit?: () => void }
const PresenceContext = createContext<PresenceOwner>({ active: true })
export type MotionPhase = 'enter' | 'exit' | 'closed'

/** A fixed fallback is only used when a real browser can animate. Tests and
 * older hosts without animation support dismiss synchronously. */
export function motionExitDuration(): number {
  if (typeof window === 'undefined' || typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') return 0
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 0
  const token = getComputedStyle(document.documentElement).getPropertyValue('--motion-normal').trim()
  const parsed = Number.parseFloat(token)
  return Number.isFinite(parsed) ? Math.min(500, Math.max(0, parsed * (token.endsWith('ms') ? 1 : 1000))) : 180
}

function useRetainedPresence(active: boolean) {
  const [retained, setRetained] = useState(active)
  const latest = useRef({ active, epoch: 0 })
  if (latest.current.active !== active) latest.current = { active, epoch: latest.current.epoch + 1 }
  const epoch = latest.current.epoch
  const completeExit = useCallback(() => {
    if (!latest.current.active && latest.current.epoch === epoch) setRetained(false)
  }, [epoch])
  // Closed surfaces are common. Do not force a computed-style read for each
  // closed modal whenever the editor updates its selection or simulation status.
  const duration = !active && retained ? motionExitDuration() : 0
  const mounted = active || retained && duration > 0
  useLayoutEffect(() => {
    if (active) { setRetained(true); return }
    if (!duration) { setRetained(false); return }
    // CSS can start on a later frame after React has committed. Surface completion
    // is authoritative; this timer only recovers from removed styles/lost events.
    const timer = window.setTimeout(completeExit, duration * 2 + 120)
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const changed = () => { if (preference?.matches) completeExit() }
    preference?.addEventListener?.('change', changed)
    return () => { window.clearTimeout(timer); preference?.removeEventListener?.('change', changed) }
  }, [active, duration, completeExit])
  return { active, mounted, phase: (active ? 'enter' : mounted ? 'exit' : 'closed') as MotionPhase, completeExit }
}

/** Retain a conditionally rendered surface through its exit. No DOM wrapper,
 * cloned tree, screenshot, or duplicate component instance is introduced. */
export default function MotionPresence({ present, children }: { present: boolean; children: ReactNode }) {
  const parent = useContext(PresenceContext)
  const active = present && parent.active
  const motion = useRetainedPresence(active)
  const owner = useMemo(() => ({ active, completeExit: motion.completeExit }), [active, motion.completeExit])
  const previous = useRef<ReactNode>(null)
  if (active) previous.current = children
  if (!motion.mounted) { previous.current = null; return null }
  return <PresenceContext.Provider value={owner}>{active ? children : previous.current}</PresenceContext.Provider>
}

/** Register the real DOM surface, including portal content. Always-mounted
 * surfaces use mounted for their hidden attribute and active for listeners. */
export function useMotionSurface(ref: RefObject<HTMLElement | null>, { visible = true, kind = 'menu', enabled = true }: { visible?: boolean; kind?: 'dialog' | 'menu'; enabled?: boolean } = {}) {
  const parent = useContext(PresenceContext)
  const motion = useRetainedPresence(!enabled || visible && parent.active)
  useLayoutEffect(() => {
    const panel = ref.current
    if (!panel || !enabled) return
    const surface = kind === 'dialog' ? panel.closest<HTMLElement>('.workbench-window-backdrop,.examples-backdrop') ?? panel : panel
    surface.dataset.motionSurface = kind
    surface.dataset.motionState = motion.phase
    if (motion.active) return
    const wasInert = panel.hasAttribute('inert'), wasHidden = surface.getAttribute('aria-hidden')
    panel.setAttribute('inert', '')
    surface.setAttribute('aria-hidden', 'true')
    const block = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
    const finished = (event: Event) => {
      if (motion.phase !== 'exit' || event.target !== surface) return
      if (event.type === 'animationend' && !/(exit|out|close)/i.test((event as AnimationEvent).animationName)) return
      if (event.type === 'transitionend' && (event as TransitionEvent).propertyName !== 'opacity') return
      // Ignore an old enter/end event if a rapid toggle has already begun a new
      // fade. This read happens only at completion, never on animation frames.
      const opacity = Number.parseFloat(getComputedStyle(surface).opacity)
      if (Number.isFinite(opacity) && opacity > .001) return
      motion.completeExit()
      parent.completeExit?.()
    }
    // The backdrop still catches a second click while its contents are inert.
    // This prevents dismissing a dialog from accidentally activating the canvas.
    surface.addEventListener('pointerdown', block, true)
    surface.addEventListener('click', block, true)
    surface.addEventListener('animationend', finished)
    surface.addEventListener('transitionend', finished)
    return () => {
      if (!wasInert) panel.removeAttribute('inert')
      if (wasHidden === null) surface.removeAttribute('aria-hidden'); else surface.setAttribute('aria-hidden', wasHidden)
      surface.removeEventListener('pointerdown', block, true)
      surface.removeEventListener('click', block, true)
      surface.removeEventListener('animationend', finished)
      surface.removeEventListener('transitionend', finished)
    }
  }, [ref, kind, enabled, motion.active, motion.phase, motion.completeExit, parent.completeExit])
  return motion
}
