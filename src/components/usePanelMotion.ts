import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

type Edge = 'left' | 'right' | 'content'
type PanelRecord = { node: HTMLElement | null; visible: boolean; key: unknown; rect: DOMRect | null; animation: Animation | null; observer: ResizeObserver | null; restore: (() => void) | null }

function reducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function duration(node: HTMLElement, edge: Edge) {
  const raw = window.getComputedStyle(node).getPropertyValue(edge === 'content' ? '--motion-normal' : '--motion-panel').trim()
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value * (raw.endsWith('ms') ? 1 : 1000) : edge === 'content' ? 180 : 220
}

/**
 * Changes the real layout once, then animates only the panel's compositor layer.
 * A departing panel uses its previous bounds until the short fade completes;
 * hidden/inert are already true, so it cannot intercept input or retain focus.
 * No clone, React animation frame loop or width/height interpolation is needed.
 */
export function usePanelMotion(ref: RefObject<HTMLElement | null>, visible: boolean, edge: Edge = 'right', contentKey?: unknown, onAfterHide?: () => void) {
  const afterHide = useRef(onAfterHide); afterHide.current = onAfterHide
  const record = useRef<PanelRecord>({ node: null, visible: false, key: undefined, rect: null, animation: null, observer: null, restore: null })
  const cancel = () => {
    const state = record.current
    const animation = state.animation
    state.animation = null
    if (animation) { animation.onfinish = null; animation.oncancel = null; animation.cancel() }
    state.restore?.(); state.restore = null
  }
  useLayoutEffect(() => {
    const node = ref.current, state = record.current
    if (!node) return
    const mounted = state.node !== node
    if (mounted) {
      cancel(); state.observer?.disconnect(); state.node = node; state.rect = null
      state.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
        if (state.visible && !node.hidden && !state.animation) state.rect = node.getBoundingClientRect()
      })
      state.observer?.observe(node)
    }
    const changed = mounted || visible !== state.visible || contentKey !== state.key
    const previouslyVisible = state.visible
    state.visible = visible; state.key = contentKey
    if (!changed) return
    const oldRect = state.rect
    cancel()
    if (reducedMotion() || typeof node.animate !== 'function' || node.parentElement?.closest('[data-layout-motion]')) {
      if (visible) state.rect = node.getBoundingClientRect()
      else if (!mounted && previouslyVisible) afterHide.current?.()
      return
    }
    const offset = edge === 'left' ? -16 : edge === 'right' ? 16 : 0
    const shifted = edge === 'content' ? 'translateY(4px)' : `translateX(${offset}px)`
    if (!visible) {
      if (!previouslyVisible) return
      if (!oldRect || oldRect.width <= 0 || oldRect.height <= 0) { afterHide.current?.(); return }
      const originalAria = node.getAttribute('aria-hidden'), originalInert = node.hasAttribute('inert')
      node.setAttribute('aria-hidden', 'true'); node.setAttribute('inert', '')
      node.setAttribute('data-layout-motion', 'leaving')
      const bounds = { left: oldRect.left, top: oldRect.top, width: oldRect.width, height: oldRect.height }
      for (const [name, value] of Object.entries(bounds)) node.style.setProperty(`--motion-panel-${name}`, `${value}px`)
      state.restore = () => {
        node.removeAttribute('data-layout-motion')
        for (const name of Object.keys(bounds)) node.style.removeProperty(`--motion-panel-${name}`)
        if (originalAria === null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', originalAria)
        if (!originalInert) node.removeAttribute('inert')
      }
    } else {
      const nextRect = node.getBoundingClientRect()
      state.rect = nextRect
      if (nextRect.width <= 0 || nextRect.height <= 0) return
      node.setAttribute('data-layout-motion', 'entering')
      state.restore = () => node.removeAttribute('data-layout-motion')
    }
    const animation = node.animate(visible
      ? [{ opacity: edge === 'content' ? .55 : 0, transform: shifted }, { opacity: 1, transform: 'none' }]
      : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: shifted }],
    { duration: duration(node, edge), easing: visible ? 'cubic-bezier(.2,.8,.2,1)' : 'cubic-bezier(.4,0,1,1)' })
    state.animation = animation
    const finish = () => {
      if (state.animation !== animation) return
      state.animation = null; state.restore?.(); state.restore = null
      if (!state.visible) afterHide.current?.()
      else state.rect = node.getBoundingClientRect()
    }
    animation.onfinish = finish; animation.oncancel = finish
  })
  useEffect(() => {
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    const change = () => {
      if (!media?.matches) return
      const exiting = !record.current.visible && record.current.animation !== null
      cancel(); if (exiting) afterHide.current?.()
    }
    media?.addEventListener?.('change', change)
    return () => { media?.removeEventListener?.('change', change); cancel(); record.current.observer?.disconnect() }
  }, [])
}
