import { CodeXml, SlidersHorizontal } from 'lucide-react'
import type { KeyboardEvent } from 'react'

export type InspectorTab = 'device' | 'model'

export default function InspectorTabs({ value, onChange }: { value: InspectorTab; onChange: (value: InspectorTab) => void }) {
  const tabs = [
    { id: 'device' as const, label: '器件编辑', ariaLabel: '器件编辑', Icon: SlidersHorizontal },
    { id: 'model' as const, label: 'SPICE 模型', ariaLabel: '编辑 SPICE 模型', Icon: CodeXml },
  ]
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    onChange(tabs[next].id)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }
  return <div className="inspector-tabs" role="tablist" aria-label="器件与模型编辑">
    {tabs.map(({ id, label, ariaLabel, Icon }, index) => <button key={id} id={`inspector-${id}-tab`} role="tab" aria-label={ariaLabel} aria-selected={value === id} aria-controls={`inspector-${id}-panel`} tabIndex={value === id ? 0 : -1} onClick={() => onChange(id)} onKeyDown={event => navigate(event, index)}><Icon size={14}/><span>{label}</span></button>)}
  </div>
}
