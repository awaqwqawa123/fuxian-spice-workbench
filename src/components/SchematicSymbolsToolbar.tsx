import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { libraryParts, type LibraryPart } from '../core/library'
import { networkSymbolPresets, type NetworkSymbolPreset } from '../core/net-symbol-presets'
import { DeviceSymbol } from './DeviceSymbol'
import { NetSymbolGraphic, netSymbolBounds } from './NetSymbolGraphic'

type SymbolOption = { id: string; name: string; part?: LibraryPart; preset?: NetworkSymbolPreset }
const groups = [
  { id: 'ground', name: '接地符号', label: '接地', options: libraryParts.filter(part => part.kind === 'GND').map(part => ({ id: part.id, name: part.name, part })) },
  { id: 'power', name: '电源符号', label: '电源', options: networkSymbolPresets.filter(preset => preset.style === 'power').map(preset => ({ id: preset.id, name: preset.name, preset })) },
  { id: 'port', name: '网络端口', label: '端口', options: networkSymbolPresets.filter(preset => preset.style !== 'power').map(preset => ({ id: preset.id, name: preset.name, preset })) },
] satisfies { id: string; name: string; label: string; options: SymbolOption[] }[]

function SymbolGlyph({ option }: { option: SymbolOption }) {
  if (option.part) return <svg viewBox="-26 -8 52 48" aria-hidden="true"><DeviceSymbol device={{ id: 'preview', kind: 'GND', value: '', groundStyle: option.part.groundStyle, x: 0, y: 0, rotation: 0 }}/></svg>
  const preset = option.preset!, bounds = netSymbolBounds(preset.netName, preset.style, preset.rotation)
  return <svg viewBox={`${bounds.left - 5} ${bounds.top - 5} ${bounds.right - bounds.left + 10} ${bounds.bottom - bounds.top + 10}`} aria-hidden="true"><NetSymbolGraphic name={preset.netName} style={preset.style} rotation={preset.rotation} paper="var(--ui-raised, #fcfdfb)"/></svg>
}

/** Carries only registered presets, using the same drop handoff as the library. */
function dragSymbol(event: DragEvent, option: SymbolOption) {
  if (option.part) {
    event.dataTransfer.setData('application/x-fuxian-device', option.part.kind)
    event.dataTransfer.setData('application/x-fuxian-value', option.part.value)
    event.dataTransfer.setData('application/x-fuxian-library-part', option.part.id)
  } else event.dataTransfer.setData('application/x-fuxian-net-symbol', option.id)
  event.dataTransfer.effectAllowed = 'copy'
}

export default function SchematicSymbolsToolbar({ activePart, activeNetworkSymbol, onPlacePart, onPlaceNetworkSymbol }: {
  activePart?: string; activeNetworkSymbol?: string; onPlacePart: (part: LibraryPart) => void; onPlaceNetworkSymbol: (preset: NetworkSymbolPreset) => void
}) {
  const [chosen, setChosen] = useState<Record<string, string>>({}), [open, setOpen] = useState<string | null>(null)
  const [position, setPosition] = useState({ left: 8, top: 0, maxHeight: 320 })
  const toolbar = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null), triggers = useRef<Record<string, HTMLButtonElement | null>>({})
  const group = groups.find(item => item.id === open)
  function close(restoreFocus = false) { if (restoreFocus && open) triggers.current[open]?.focus(); setOpen(null) }
  function place(option: SymbolOption) {
    if (open) setChosen(previous => ({ ...previous, [open]: option.id }))
    close(true)
    if (option.part) onPlacePart(option.part); else onPlaceNetworkSymbol(option.preset!)
  }
  useLayoutEffect(() => {
    if (!open) return
    const locate = () => {
      const rect = triggers.current[open]?.getBoundingClientRect(); if (!rect) return
      const width = Math.min(238, window.innerWidth - 16), height = menu.current?.scrollHeight ?? 250
      const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12
      const upward = below < Math.min(height, 160) && above > below
      const maxHeight = Math.max(80, upward ? above : below)
      setPosition({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), top: upward ? Math.max(8, rect.top - Math.min(height, maxHeight) - 4) : rect.bottom + 4, maxHeight })
    }
    locate()
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    const selected = chosen[open] ?? groups.find(item => item.id === open)!.options[0].id
    Array.from(buttons ?? []).find(button => button.dataset.symbolPreset === selected)?.focus()
    const outside = (event: PointerEvent) => { if (!toolbar.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(null) }
    const key = (event: KeyboardEvent) => {
      // The canvas also listens on window. The open menu owns shortcuts, including R.
      event.stopImmediatePropagation()
      if (event.key === 'Escape') { event.preventDefault(); close(true); return }
      if (event.key === 'Tab') { close(true); return }
      const controls = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
      const index = controls.indexOf(document.activeElement as HTMLButtonElement)
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length
        controls[next]?.focus()
      } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); controls[index]?.click() }
    }
    window.addEventListener('keydown', key, true)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', locate)
    window.addEventListener('scroll', locate, true)
    return () => {
      window.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', locate); window.removeEventListener('scroll', locate, true)
    }
  }, [open])
  return <div ref={toolbar} className="schematic-symbol-tools" role="group" aria-label="接地、电源与网络符号">
    {groups.map(item => {
      const option = item.options.find(option => option.id === chosen[item.id]) ?? item.options[0]
      const active = item.options.some(option => option.id === activePart || option.id === activeNetworkSymbol)
      return <div key={item.id} className={`schematic-symbol-group${active ? ' active' : ''}`}>
        <button type="button" className="schematic-symbol-primary" draggable aria-label={`放置${option.name}`} title={`${option.name} · 点击后在画布放置，也可拖入画布`} onClick={() => place(option)} onDragStart={event => { dragSymbol(event, option); close() }}><SymbolGlyph option={option}/><span>{item.label}</span></button>
        <button ref={element => { triggers.current[item.id] = element }} type="button" className="schematic-symbol-dropdown" aria-label={`选择${item.name}`} title={`选择${item.name}`} aria-haspopup="menu" aria-expanded={open === item.id} aria-controls={open === item.id ? 'schematic-symbol-menu' : undefined} onClick={() => setOpen(open === item.id ? null : item.id)}><ChevronDown size={11}/></button>
      </div>
    })}
    {group && createPortal(<div ref={menu} id="schematic-symbol-menu" role="menu" aria-label={`选择${group.name}`} className="schematic-symbol-menu" style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}><div className="schematic-symbol-menu-heading">{group.name}<small>点击或拖入画布</small></div>{group.options.map(option => <button key={option.id} type="button" role="menuitem" data-symbol-preset={option.id} draggable aria-label={`放置${option.name}`} className={option.id === (chosen[group.id] ?? group.options[0].id) ? 'selected' : ''} onClick={() => place(option)} onDragStart={event => { dragSymbol(event, option); setChosen(previous => ({ ...previous, [group.id]: option.id })) }} onDragEnd={() => close()}><SymbolGlyph option={option}/><span>{option.name}</span></button>)}</div>, document.body)}
  </div>
}
