import type { GroundStyle, NetLabelStyle, Rotation, XY } from './drawing'

export interface SymbolBounds { left: number; top: number; right: number; bottom: number }
const textWidth = (name: string) => [...name].reduce((width, char) => width + (char.codePointAt(0)! > 255 ? 15.6 : 7.8), 0)
const rotate = (point: XY, rotation: Rotation): XY => {
  switch (rotation) {
    case 90: return { x: -point.y, y: point.x }
    case 180: return { x: -point.x, y: -point.y }
    case 270: return { x: point.y, y: -point.x }
    default: return point
  }
}
const rotatedBounds = (bounds: SymbolBounds, rotation: Rotation): SymbolBounds => {
  const corners = [{ x: bounds.left, y: bounds.top }, { x: bounds.right, y: bounds.top }, { x: bounds.left, y: bounds.bottom }, { x: bounds.right, y: bounds.bottom }].map(point => rotate(point, rotation))
  return { left: Math.min(...corners.map(point => point.x)), top: Math.min(...corners.map(point => point.y)), right: Math.max(...corners.map(point => point.x)), bottom: Math.max(...corners.map(point => point.y)) }
}
export const groundSymbolBounds = (style: GroundStyle = 'earth'): SymbolBounds => ({ left: style === 'chassis' ? -22 : -20, top: -2, right: 20, bottom: style === 'signal' ? 34 : 30 })

export function netSymbolGeometry(name: string, style: NetLabelStyle, rotation: Rotation) {
  const width = Math.max(56, textWidth(name) + 24)
  const geometry: SymbolBounds = style === 'power' ? { left: -12, top: -26, right: 12, bottom: 2 }
    : style === 'text' ? { left: -2, top: -2, right: 2, bottom: 2 }
    : { left: -12 - width - 2, top: -12, right: 2, bottom: 12 }
  const center = rotate(style === 'power' ? { x: 0, y: -38 } : style === 'text' ? { x: 8, y: -8 } : { x: -12 - width / 2, y: 0 }, rotation)
  const vertical = rotation === 90 || rotation === 270
  const text = style === 'power'
    ? { x: center.x + (vertical ? rotation === 270 ? -8 : 8 : 0), y: center.y + (vertical ? 4 : rotation === 180 ? 13 : 0), anchor: (vertical ? rotation === 270 ? 'end' : 'start' : 'middle') as 'start' | 'middle' | 'end' }
    : style === 'text' ? { x: center.x, y: center.y, anchor: 'start' as const }
    : { x: center.x + (vertical ? 17 : 0), y: center.y + 4, anchor: (vertical ? 'start' : 'middle') as 'start' | 'middle' }
  return { width, geometry: rotatedBounds(geometry, rotation), text }
}

/** Local bounds include upright text and stroke padding, matching the rendered glyph. */
export function netSymbolBounds(name: string, style: NetLabelStyle = 'text', rotation: Rotation = 0): SymbolBounds {
  const { geometry, text } = netSymbolGeometry(name, style, rotation), width = textWidth(name)
  const left = text.x - (text.anchor === 'middle' ? width / 2 : text.anchor === 'end' ? width : 0)
  return { left: Math.min(geometry.left, left - 3), top: Math.min(geometry.top, text.y - 15), right: Math.max(geometry.right, left + width + 3), bottom: Math.max(geometry.bottom, text.y + 5) }
}
