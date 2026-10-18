import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, X } from 'lucide-react'
import { parseQuantity, type Quantity } from '../core/circuit'
import type { Device } from '../core/drawing'
import { useWorkbenchDialog } from './AssistantWindow'

const valueFields: Partial<Record<Device['kind'], { label: string; quantity: Quantity; min: number; max: number; hint: string }>> = {
  R: { label: '电阻', quantity: 'resistance', min: .01, max: 1e9, hint: '例如 15.9kΩ、22k 或 1MΩ' },
  C: { label: '电容', quantity: 'capacitance', min: 1e-12, max: 1, hint: '例如 20nF、100n 或 4.7µF' },
  L: { label: '电感', quantity: 'inductance', min: 1e-9, max: 1e3, hint: '例如 10mH、100u 或 2.2µH' },
}

export const hasQuickValue = (device: Device) => !!valueFields[device.kind]

/** A single value transaction; text input never edits the live circuit before applying. */
export default function ComponentValueEditor({ device, onApply, onClose }: { device: Device; onApply: (value: string) => void; onClose: () => void }) {
  const [original] = useState(device), [value, setValue] = useState(device.value)
  const panel = useRef<HTMLElement>(null), input = useRef<HTMLInputElement>(null)
  useWorkbenchDialog(panel, true, onClose)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])
  const field = valueFields[original.kind]!
  const stale = device.kind !== original.kind || device.value !== original.value
  let error = ''
  try {
    const number = parseQuantity(value, field.quantity)
    if (number < field.min || number > field.max) error = `允许范围 ${field.min}～${field.max}（基本单位）`
  } catch (reason) { error = (reason as Error).message }
  if (stale) error = '器件数值已在其他位置改变，请关闭后重新编辑。'
  function apply() { if (!error) { onApply(value.trim()); onClose() } }
  return createPortal(<div className="workbench-window-backdrop component-value-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }} onKeyDown={event => event.stopPropagation()}>
    <section className="component-value-editor" role="dialog" aria-modal="true" aria-label={`编辑 ${device.id} 数值`} ref={panel} tabIndex={-1}>
      <header><div><span>{device.id}</span><h2>编辑{field.label}值</h2></div><button type="button" aria-label="关闭数值编辑" onClick={onClose}><X size={17}/></button></header>
      <form onSubmit={event => { event.preventDefault(); apply() }}>
        <label htmlFor="component-quick-value">{field.label}值</label>
        <input id="component-quick-value" ref={input} aria-label={`${device.id} ${field.label}值`} aria-invalid={!!error} aria-describedby={error ? 'component-value-error' : 'component-value-hint'} value={value} maxLength={40} spellCheck={false} autoComplete="off" onChange={event => setValue(event.target.value)}/>
        <p className="component-value-hint" id="component-value-hint">{field.hint}</p>
        {error && <p className="component-value-error" id="component-value-error" role="alert">{error}</p>}
        <footer><span>Enter 应用 · Esc 取消</span><div><button type="button" onClick={onClose}>取消</button><button className="primary" type="submit" disabled={!!error}><Check size={15}/>应用</button></div></footer>
      </form>
    </section>
  </div>, document.body)
}
