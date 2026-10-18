import { useId, useState } from 'react'
import { Check, X } from 'lucide-react'
import { parseQuantity, type Quantity } from '../core/circuit'
import type { Device } from '../core/drawing'

const fields: Partial<Record<Device['kind'], { unit: string; quantity: Quantity; min: number; max: number }>> = {
  R: { unit: 'Ω', quantity: 'resistance', min: .01, max: 1e9 },
  C: { unit: 'F', quantity: 'capacitance', min: 1e-12, max: 1 },
  L: { unit: 'H', quantity: 'inductance', min: 1e-9, max: 1e3 },
  OP: { unit: 'V/V', quantity: 'gain', min: 1, max: 1e9 },
}

/** Keep a visible draft separate from the engineering transaction and its undo. */
export default function InlineDeviceValue({ device, onApply }: { device: Device; onApply: (value: string) => void }) {
  const [draft, setDraft] = useState<{ value: string; baseline: string } | null>(null)
  const id = useId(), field = fields[device.kind]!
  const value = draft?.value ?? device.value, dirty = value !== device.value
  let error = ''
  try { const parsed = parseQuantity(value, field.quantity); if (parsed < field.min || parsed > field.max) error = `允许范围 ${field.min}～${field.max} ${field.unit}` }
  catch (reason) { error = (reason as Error).message }
  if (draft && draft.baseline !== device.value && dirty) error = '器件已在其他位置修改，请取消草稿后重新编辑'
  function apply() { if (!error && dirty) { onApply(value.trim()); setDraft(null) } }
  return <div className="inline-device-value">
    <label>数值<input aria-label="当前器件数值" aria-invalid={!!error} aria-describedby={error ? id : undefined} value={value} maxLength={40} spellCheck={false}
      onChange={event => setDraft(old => ({ baseline: old?.baseline ?? device.value, value: event.target.value }))}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); apply() } if (event.key === 'Escape') { event.stopPropagation(); setDraft(null) } }} /><span className="inline-value-unit">{field.unit}</span></label>
    {dirty && <><span className="inline-value-draft">未应用</span><button type="button" aria-label="应用器件数值" title="应用器件数值 · Enter" disabled={!!error} onClick={apply}><Check size={14}/>应用</button><button type="button" aria-label="取消器件数值修改" title="取消草稿 · Esc" onClick={() => setDraft(null)}><X size={14}/></button></>}
    {error && <span id={id} className="inline-value-error" role="alert">{error}</span>}
  </div>
}
