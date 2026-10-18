import { renderToStaticMarkup } from 'react-dom/server'
import { DeviceSymbol } from '../components/DeviceSymbol'
import { NetSymbolGraphic } from '../components/NetSymbolGraphic'
import { netSymbolBounds } from './net-symbol-geometry'
import type { ImportedSpiceModel } from './spice-models'
import { terminalPosition, wirePath, wirePoints, type Device, type Drawing, type XY } from './drawing'
import { junctionAppearances } from './junction-appearance'
import { placeNetLabels } from './schematic-layout'

import type { Measurement } from './probes'
import { layoutProbeMarkers, measurementProbeMarkers, probeMarkerBounds } from './probe-layout'
import { StaticProbeMarker } from '../components/ProbeGlyphs'
import { sourceDescription } from './sources'
import { modelDeviceBounds, presentedModelSymbol } from './model-symbol-presentation'
import { deviceCaptionLayout } from './device-caption-geometry'
import { hasOriginalOlbCaptions } from './model-symbol-captions'
import { biasMeasurementText, biasPlacementRect, type BiasPlacement } from './bias-display'
const deviceSymbol = (device:Device, options:SchematicSvgOptions) => {
  const model=options.models?.find(model=>model.kind===device.kind&&model.id.toLowerCase()===device.value.toLowerCase())
  return model?presentedModelSymbol(model,device):undefined
}

export interface SchematicSvgOptions {
  title?: string; sourceSummary?: string; models?:ImportedSpiceModel[]; probes?:Measurement[]
  biasPlacements?:readonly BiasPlacement[]
  biasDirectionMode?:'reference'|'actual'
  biasMetadata?:{resultId:string;timestamp:number;engine:string;temperature:number;status:'current'|'stale'}
}

const colors = { ink: '#263c34', muted: '#56685f', wire: '#356b51', paper: '#ffffff' }
const fontFamily = 'Consolas, "Microsoft YaHei", monospace'
// React escapes markup; remove control characters that XML 1.0 cannot represent.
const xmlText = (value: string) => value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
const columns = (value: string) => [...value].reduce((n, char) => n + (char.codePointAt(0)! > 255 ? 2 : 1), 0)
function lines(value: string, limit: number): string[] {
  const result: string[] = []
  for (const paragraph of xmlText(value).split(/\r?\n/)) {
    let line = '', width = 0
    for (const char of paragraph.replace(/\t/g, '    ')) {
      const size = columns(char)
      if (line && width + size > limit) { result.push(line); line = ''; width = 0 }
      line += char; width += size
    }
    result.push(line)
  }
  return result.length ? result : ['']
}

interface Caption { x: number; y: number; anchor: 'start' | 'middle'; lines: string[]; size: number; strong?: boolean }
interface LayoutRect { left: number; top: number; right: number; bottom: number }
function captions(device: Device, drawing: Drawing, options: SchematicSvgOptions): Caption[] {
  if (device.kind === 'GND') return []
  if (hasOriginalOlbCaptions(deviceSymbol(device,options))) return []
  const layout=deviceCaptionLayout(device,device.kind==='X'?modelDeviceBounds(device,deviceSymbol(device,options)):undefined)
  const at=(caption:typeof layout.ref)=>({...caption,x:device.x+caption.x,y:device.y+caption.y})
  const result: Caption[] = [{...at(layout.ref),lines:[xmlText(device.id)],strong:true}]
  const value = device.kind === 'V' && device.id === drawing.sourceId && options.sourceSummary !== undefined
    ? options.sourceSummary
    : (device.kind === 'V' || device.kind === 'I') && device.params?.waveform ? sourceDescription(device)
    : device.kind === 'SW' ? (device.value === 'ON' ? '闭合' : '断开')
    : device.kind === 'RELAY' ? 'SPDT 继电器'
    : device.kind === 'VSW' ? '压控开关'
    : device.kind === 'XFMR' ? `Ns/Np = ${device.value}`
    : `${device.value}${device.kind === 'R' && !/(?:Ω|ohms?|欧姆)$/i.test(device.value) ? 'Ω' : ''}`
  result.push({...at(layout.value),lines:lines(value,36)})
  return result
}

const captionBounds = (caption: Caption): LayoutRect => {
  const width = Math.max(...caption.lines.map(line => columns(line) * caption.size * 0.66))
  const left = caption.x - (caption.anchor === 'middle' ? width / 2 : 0)
  return { left, top: caption.y - caption.size, right: left + width, bottom: caption.y + (caption.lines.length - 1) * 18 + 5 }
}
/** A standalone SVG, independent of editor selection, CSS, zoom and browser DOM. */
export function schematicSvg(drawing: Drawing, options: SchematicSvgOptions = {}): string {
  const junctionStates = junctionAppearances(drawing)
  const points: XY[] = []
  const include = (left: number, top: number, right: number, bottom: number) => points.push({ x: left, y: top }, { x: right, y: bottom })
  const textWidth = (text: string, size: number) => columns(text) * size * 0.66
  const deviceCaptions = drawing.devices.map(device => ({ device, captions: captions(device, drawing, options) }))
  for (const { device, captions: labels } of deviceCaptions) {
    if(device.kind==='X'){
      const bounds=modelDeviceBounds(device,deviceSymbol(device,options))
      include(device.x+bounds.left,device.y+bounds.top,device.x+bounds.right,device.y+bounds.bottom)
    }else{
      // Standard symbols fit in this square, including pin leads.
      const extent = device.kind === 'RELAY' || device.kind === 'LDO' ? 66 : 44
      include(device.x - extent, device.y - extent, device.x + extent, device.y + extent)
    }
    for (const caption of labels) {
      const width = Math.max(...caption.lines.map(line => textWidth(line, caption.size)))
      const left = caption.x - (caption.anchor === 'middle' ? width / 2 : 0)
      include(left, caption.y - caption.size, left + width, caption.y + (caption.lines.length - 1) * 18 + 5)
    }
  }
  for (const wire of drawing.wires) points.push(...wirePoints(drawing, wire))
  for (const point of drawing.junctions) include(point.x - 4, point.y - 4, point.x + 4, point.y + 4)
  const labels = placeNetLabels(drawing).map(placement => {
    const { label, point } = placement, name = xmlText(label.name)
    if (label.style && label.style !== 'text') {
      const anchor = terminalPosition(drawing, label.at), bounds = netSymbolBounds(name, label.style, label.rotation)
      include(anchor.x + bounds.left, anchor.y + bounds.top, anchor.x + bounds.right, anchor.y + bounds.bottom)
      return { ...label, name, point: anchor, x: 0, y: 0, width: bounds.right - bounds.left }
    }
    const width = textWidth(name, 13) + 16
    include(point.x + placement.x, point.y + placement.y - 22, point.x + placement.x + width, point.y + placement.y)
    return { ...label, name, point, x: placement.x, y: placement.y, width }
  })
  const markers = layoutProbeMarkers(drawing, measurementProbeMarkers(drawing, options.probes).map(marker => ({ ...marker, label: xmlText(marker.label) })))
  for (const marker of markers) { const bounds = probeMarkerBounds(drawing, marker); include(bounds.left, bounds.top, bounds.right, bounds.bottom) }
  for (const placement of options.biasPlacements??[]) {
    const bounds=biasPlacementRect(placement)
    include(bounds.left-4,bounds.top-4,bounds.right+4,bounds.bottom+4)
    points.push(placement.point)
    if(placement.arrow)points.push(placement.arrow.from,placement.arrow.to)
  }
  const empty = !points.length
  const bounds = empty ? { left: 0, top: 0, right: 360, bottom: 160 } : {
    left: Math.min(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)),
    right: Math.max(...points.map(p => p.x)), bottom: Math.max(...points.map(p => p.y)),
  }
  const title = xmlText(options.title ?? '电路原理图'), titleLines = lines(title, 64)
  const margin = 32, headerHeight = titleLines.length * 25 + 24
  const width = Math.ceil(Math.max(480, bounds.right - bounds.left + margin * 2, ...titleLines.map(line => textWidth(line, 18) + margin * 2)))
  const height = Math.ceil(Math.max(280, bounds.bottom - bounds.top + margin * 2 + headerHeight))
  const dx = margin - bounds.left, dy = margin + headerHeight - bounds.top
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + renderToStaticMarkup(
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="schematic-title" fontFamily={fontFamily} color={colors.ink}>
      <title id="schematic-title">{title}</title>
      <desc>电路原理图。包含器件、参数、导线、节点标签和测量探针。</desc>
      {options.biasMetadata&&<metadata id="dc-bias-metadata">{xmlText(JSON.stringify({...options.biasMetadata,analysis:'op',directionMode:options.biasDirectionMode??'reference'}))}</metadata>}
      <rect width={width} height={height} fill={colors.paper}/>
      <text x={margin} y={margin + 18} fill={colors.ink} fontSize="18" fontWeight="700">
        {titleLines.map((line, i) => <tspan key={i} x={margin} dy={i ? 25 : 0}>{line}</tspan>)}
      </text>
      <path d={`M ${margin} ${margin + headerHeight - 10} H ${width - margin}`} fill="none" stroke="#dce5de"/>
      <g id="schematic-content" transform={`translate(${dx} ${dy})`}>
        {empty && <text x="0" y="70" fill={colors.muted} fontSize="15">空白原理图</text>}
        {deviceCaptions.map(({ device, captions: labels }) => <g key={device.id} data-device={xmlText(device.id)}>
          <g transform={`translate(${device.x} ${device.y})`}><DeviceSymbol device={device} modelType={options.models?.find(m=>m.kind===device.kind&&m.id.toLowerCase()===device.value.toLowerCase())?.type} symbol={deviceSymbol(device,options)}/></g>
          {labels.map((caption, i) => { const bounds = captionBounds(caption); return <rect key={`caption-bg-${i}`} data-caption-background="true" x={bounds.left - 5} y={bounds.top - 3} width={bounds.right - bounds.left + 10} height={bounds.bottom - bounds.top + 6} rx="3" fill={colors.paper} fillOpacity=".94" aria-hidden="true"/> })}
          {labels.map((caption, i) => <text key={i} x={caption.x} y={caption.y} textAnchor={caption.anchor} fontSize={caption.size} fontWeight={caption.strong ? 700 : 400} fill={caption.strong ? colors.ink : colors.muted} paintOrder="stroke fill" stroke={colors.paper} strokeWidth={caption.strong ? 5 : 4} strokeLinejoin="round">
            {caption.lines.map((line, index) => <tspan key={index} x={caption.x} dy={index ? 18 : 0}>{line}</tspan>)}
          </text>)}
        </g>)}
        <g data-layer="wires" fill="none" stroke={colors.wire} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {drawing.wires.map(wire => <g key={wire.id}><path d={wirePath(drawing,wire)} stroke={colors.paper} strokeWidth="6"/><path data-wire={xmlText(wire.id)} d={wirePath(drawing, wire)}/></g>)}
        </g>
        {drawing.junctions.map(junction => {
          const kind = junctionStates.get(junction.id)?.kind
          return kind === 'through' ? null : <circle key={junction.id} data-junction={xmlText(junction.id)} data-junction-kind={kind} cx={junction.x} cy={junction.y} r={kind === 'branch' ? 2.5 : 3.25} fill={kind === 'open' ? colors.paper : colors.wire} stroke={colors.wire} strokeWidth={kind === 'branch' ? .5 : 1.2}/>
        })}
        {labels.map(label => <g key={label.id} data-label={xmlText(label.id)} transform={`translate(${label.point.x} ${label.point.y})`}>
          {label.style && label.style !== 'text' ? <g color={colors.wire}><NetSymbolGraphic name={label.name} style={label.style} rotation={label.rotation} paper={colors.paper}/></g> : <>
            <path d={`M 0 0 V ${label.y-11} H ${label.x}`} fill="none" stroke={colors.wire} strokeWidth="1.5"/>
            <rect x={label.x} y={label.y-22} width={label.width} height="21" rx="3" fill={colors.paper} stroke={colors.wire}/>
            <text x={label.x+7} y={label.y-7} fontSize="13" fill={colors.wire} paintOrder="stroke fill" stroke={colors.paper} strokeWidth="2" strokeLinejoin="round">{label.name}</text>
          </>}
        </g>)}
        {markers.map(marker => <StaticProbeMarker key={marker.label} drawing={drawing} marker={marker}/>)}
        {!!options.biasPlacements?.length&&<g data-layer="dc-bias" data-status={options.biasMetadata?.status??'unverified'} opacity={options.biasMetadata?.status==='stale'?.6:1}>
          {options.biasPlacements.map(placement=>{
            const {measurement,point,offset,width,height,arrow}=placement,rectangle=biasPlacementRect(placement),color=measurement.kind==='voltage'?'#1e5796':'#a35b16'
            const dx=arrow?arrow.to.x-arrow.from.x:0,dy=arrow?arrow.to.y-arrow.from.y:0,length=Math.hypot(dx,dy),ux=length?dx/length:0,uy=length?dy/length:0
            const end={x:Math.max(rectangle.left,Math.min(rectangle.right,point.x)),y:Math.max(rectangle.top,Math.min(rectangle.bottom,point.y))}
            return <g key={measurement.id} data-bias-id={xmlText(measurement.id)}>
              <title>{xmlText(`${measurement.label}; ${measurement.direction}; ${measurement.source}${measurement.reason?`; ${measurement.reason}`:''}`)}</title>
              <path d={`M ${point.x} ${point.y} L ${end.x} ${end.y}`} fill="none" stroke={color} strokeWidth="1" strokeDasharray={measurement.value===null?'3 3':undefined}/>
              {arrow&&<g fill={color} stroke={color}><path d={`M ${arrow.from.x} ${arrow.from.y} L ${arrow.to.x} ${arrow.to.y}`} strokeWidth="2"/><path d={`M ${arrow.to.x} ${arrow.to.y} L ${arrow.to.x-ux*7-uy*4} ${arrow.to.y-uy*7+ux*4} L ${arrow.to.x-ux*7+uy*4} ${arrow.to.y-uy*7-ux*4} Z`} stroke="none"/></g>}
              <rect x={point.x+offset.x} y={point.y+offset.y} width={width} height={height} rx="4" fill="#fff" stroke={color}/>
              <text x={point.x+offset.x+8} y={point.y+offset.y+18} fontSize="12" fill={color}>{xmlText(biasMeasurementText(measurement,options.biasDirectionMode))}</text>
            </g>
          })}
        </g>}
      </g>
    </svg>,
  )
}
