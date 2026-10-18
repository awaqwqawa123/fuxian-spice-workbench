import type { Device, Pin } from '../core/drawing'
import { localPin } from '../core/devices'
import type { ModelSymbol } from '../core/model-symbol'

/** Keeps the existing electrical anchors even when the visible body is custom. */
export default function ModelBoxSymbol({ device, symbol, showPinLabels=true }: { device: Device; symbol: ModelSymbol; showPinLabels?:boolean }) {
  const angle = device.rotation * Math.PI / 180, mirror = device.mirrored ? -1 : 1
  const anchors = symbol.pins.map(pin => ({ ...pin, ...localPin(device.kind, pin.index as Pin,device) }))
  const halfHeight=device.kind==='X'?Math.max(28,...anchors.map(pin=>Math.abs(pin.y)+14)):25
  const halfWidth=device.kind==='X'?40:25
  const transformLabel = (x: number, y: number) => ({ x: Math.round(x * mirror * Math.cos(angle) - y * Math.sin(angle)), y: Math.round(x * mirror * Math.sin(angle) + y * Math.cos(angle)) })
  const familyLabel=symbol.family==='voltage-regulator'?'REG':symbol.family==='operational-amplifier'?'AMP':symbol.family==='comparator'?'CMP':symbol.family==='adjustable-shunt-reference'?'REF':symbol.family?.includes('reference')?'REF':symbol.family?.includes('optocoupler')?'OPTO':'IC'
  return <g data-symbol={device.kind} data-custom-symbol="box" data-symbol-family={symbol.family}>
    <title>{`${symbol.title}: ${symbol.pins.map(pin=>`${pin.index+1}: ${pin.label}`).join(' / ')}`}</title>
    <g transform={`rotate(${device.rotation}) scale(${mirror} 1)`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x={-halfWidth} y={-halfHeight} width={halfWidth*2} height={halfHeight*2} rx="1" fill="var(--canvas-background, #fcfdfb)"/>
      {anchors.map(pin => <path key={pin.index} data-symbol-pin={pin.index} d={`M ${pin.x} ${pin.y} L ${Math.max(-halfWidth, Math.min(halfWidth, pin.x))} ${Math.max(-halfHeight, Math.min(halfHeight, pin.y))}`}/>)}
    </g>
    {showPinLabels&&anchors.map(pin => {
      const label=pin.label.length>7?`${pin.label.slice(0,6)}…`:pin.label
      const point=transformLabel(device.kind==='X'?(pin.x<0?-34:34):pin.x === -40 ? -17 : pin.x === 40 ? 17 : 12,device.kind==='X'?pin.y+3:pin.y === 0 ? -7 : pin.y < 0 ? -14 : 20)
      return <text key={pin.index} {...point} fill="currentColor" stroke="none" fontFamily="Consolas, sans-serif" fontSize="7.5" textAnchor={device.kind==='X'&&device.rotation%180===0?(point.x<0?'start':'end'):'middle'}><title>{pin.label}</title>{label}</text>
    })}
    {!anchors.some(pin=>Math.abs(pin.y)<12)&&<text x="0" y="4" fill="currentColor" opacity=".7" stroke="none" fontSize="7" fontWeight="600" textAnchor="middle">{device.kind==='X'?familyLabel:symbol.title.slice(0,8)}</text>}
  </g>
}
