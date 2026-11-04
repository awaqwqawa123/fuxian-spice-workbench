import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { Minus, Sparkles, X } from 'lucide-react'
import { useMotionSurface } from './MotionPresence'

const inertOwners = new WeakMap<Element, { count: number; initial: boolean }>()
function lockInert(element: Element) {
  const owner = inertOwners.get(element)
  if (owner) owner.count++
  else inertOwners.set(element, { count: 1, initial: element.hasAttribute('inert') })
  element.setAttribute('inert', '')
}
function unlockInert(element: Element) {
  const owner = inertOwners.get(element)
  if (!owner || --owner.count > 0) return
  if (!owner.initial) element.removeAttribute('inert')
  inertOwners.delete(element)
}

/** A dialog owns keyboard focus and makes every sibling surface inert until dismissed. */
export function useWorkbenchDialog(panel: RefObject<HTMLElement | null>, visible: boolean, onEscape: () => void, { motionVisible = visible, motionEnabled = true }: { motionVisible?: boolean; motionEnabled?: boolean } = {}) {
  const motion = useMotionSurface(panel, { visible: motionVisible, kind: 'dialog', enabled: motionEnabled })
  const escape = useRef(onEscape); escape.current = onEscape
  useEffect(() => {
    const element = panel.current
    if (!visible || !motion.active || !element) return
    const previous = document.activeElement as HTMLElement | null
    const locked: Element[] = []
    let branch: Element = element.closest('.workbench-window-backdrop,.examples-backdrop') ?? element
    while (branch.parentElement && branch.parentElement !== document.documentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || /^(SCRIPT|STYLE|LINK)$/.test(sibling.tagName)) continue
        locked.push(sibling); lockInert(sibling)
      }
      branch = branch.parentElement
    }
    const focusable = () => Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')).filter(item => !item.closest('[hidden],[inert]') && (!item.closest('details:not([open])') || item.tagName === 'SUMMARY'))
    focusable()[0]?.focus()
    const key = (event: KeyboardEvent) => {
      // A later dialog can make this one inert, e.g. saving a reviewed model.
      if (element.closest('[inert]')) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); escape.current(); return }
      if (event.key !== 'Tab') return
      const controls = focusable(), first = controls[0], last = controls.at(-1)
      if (!first) { event.preventDefault(); element.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      for (const item of locked) unlockInert(item)
      if (previous?.isConnected && !previous.closest('[inert],[hidden]') && (element.contains(document.activeElement) || document.activeElement === document.body)) previous.focus()
    }
  }, [panel, visible, motion.active])
  return motion
}

export default function AssistantWindow({ visible, onMinimize, onClose, children }: { visible: boolean; onMinimize: () => void; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null)
  const motion = useWorkbenchDialog(panel, visible, onMinimize)
  return <div className="workbench-window-backdrop assistant-window-backdrop" hidden={!motion.mounted} onMouseDown={event => { if (event.target === event.currentTarget) onMinimize() }}>
    <section ref={panel} className="workbench-window assistant-window" role="dialog" aria-modal="true" aria-label="AI 助手窗口" tabIndex={-1}>
      <header className="workbench-window-heading"><div><span className="workbench-window-kicker">CIRCUIT ASSISTANT</span><h2><Sparkles size={20}/>AI 助手</h2><p>最小化后继续绘图，会话保留；关闭窗口结束本次会话。</p></div><div className="workbench-window-controls"><button aria-label="最小化 AI 助手" title="最小化，保留会话 (Esc)" onClick={onMinimize}><Minus size={18}/></button><button aria-label="关闭 AI 助手窗口" title="关闭并清除会话" onClick={onClose}><X size={18}/></button></div></header>
      <div className="assistant-window-content">{children}</div>
    </section>
  </div>
}
