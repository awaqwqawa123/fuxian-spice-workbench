import { memo } from 'react'
import type { GroundStyle, NetLabelStyle, Rotation } from '../core/drawing'
import { netSymbolGeometry } from '../core/net-symbol-geometry'
export { netSymbolBounds, groundSymbolBounds } from '../core/net-symbol-geometry'

const fontFamily = "Consolas, 'Microsoft YaHei', monospace"
const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const GroundSymbolGraphic = memo(function GroundSymbolGraphic({ style = 'earth' }: { style?: GroundStyle }) {
  const path = style === 'signal' ? 'M 0 0 V 14 M -16 14 H 16 L 0 32 Z'
    : style === 'chassis' ? 'M 0 0 V 14 M -18 14 H 18 M -12 14 L -20 26 M 0 14 L -8 26 M 12 14 L 4 26'
    : 'M 0 0 V 14 M -18 14 H 18 M -12 21 H 12 M -5 28 H 5'
  return <g data-ground-style={style} {...common}><path d={path}/></g>
})

/** The origin is the electrical attachment point; rotation never rotates the net name. */
export const NetSymbolGraphic = memo(function NetSymbolGraphic({ name, style = 'text', rotation = 0, paper = '#fcfdfb' }: { name: string; style?: NetLabelStyle; rotation?: Rotation; paper?: string }) {
  const { width, text } = netSymbolGeometry(name, style, rotation), left = -12 - width, right = -12
  const outline = style === 'input' ? `M ${left} -10 H ${right - 10} L ${right} 0 L ${right - 10} 10 H ${left} Z`
    : style === 'output' ? `M ${left + 10} -10 H ${right} V 10 H ${left + 10} L ${left} 0 Z`
    : `M ${left + 10} -10 H ${right - 10} L ${right} 0 L ${right - 10} 10 H ${left + 10} L ${left} 0 Z`
  return <g data-net-symbol={style} className="net-symbol-glyph">
    {style !== 'text' && <g {...common} transform={`rotate(${rotation})`}>
      {style === 'power' ? <path d="M 0 0 V -24 M -10 -24 H 10"/> : <><path d="M 0 0 H -12"/><path className="net-port-body" d={outline} fill={paper}/></>}
    </g>}
    <text x={text.x} y={text.y} textAnchor={text.anchor} fill="currentColor" stroke={paper} strokeWidth="3" paintOrder="stroke fill" strokeLinejoin="round" fontFamily={fontFamily} fontSize="13" fontWeight="600">{name}</text>
  </g>
})
