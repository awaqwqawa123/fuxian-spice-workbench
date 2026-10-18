import { probeBadgeWidth, probeCurrentAngle, probeLeaderPath, type ProbeMarker } from '../core/probe-layout'
import { probePoint } from '../core/probe-placement'
import { probeTypes, type ProbeType } from '../core/probes'
import type { Drawing, XY } from '../core/drawing'

export function ProbeLeader({ offset, label, type }: { offset: XY; label: string; type: ProbeType }) {
  return <path className="probe-leader" d={probeLeaderPath(offset, probeBadgeWidth(label))} stroke="currentColor" strokeWidth="1.5" strokeDasharray={type === 'differential' ? '5 3' : undefined} opacity=".7" fill="none" pointerEvents="none"/>
}

export function ProbeTipGlyph({ type, negative = false, currentAngle = 0, sharedTip = false }: { type: ProbeType; negative?: boolean; currentAngle?: number; sharedTip?: boolean }) {
  if (type === 'current') return <>
    {!sharedTip && <circle className="probe-clamp-halo" r="15" fill="white" fillOpacity=".95"/>}
    <path d={sharedTip ? 'M -9 -18 A 20 20 0 1 0 9 -18 M -9 -18 V -12 M 9 -18 V -12' : 'M -6 -11 A 13 13 0 1 0 6 -11 M -6 -11 V -5 M 6 -11 V -5'} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
    <g className="probe-current-arrow" transform={`rotate(${currentAngle})`}><path d={sharedTip ? 'M -28 0 H -15 M 15 0 H 28 M 22 -5 L 28 0 L 22 5' : 'M -20 0 H 22 M 16 -5 L 22 0 L 16 5'} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></g>
  </>
  return <><circle r={type === 'differential' ? 12 : 10} fill="white" stroke="currentColor" strokeWidth="2.5"/>{type === 'differential' ? <text y="5" textAnchor="middle" fontSize="17" fontWeight="800" fill="currentColor">{negative ? '−' : '+'}</text> : <circle r="3.5" fill="currentColor"/>}{!sharedTip && <><path d={`M 0 ${type === 'differential' ? -12 : -10} L 5 -21 L 12 -28 Q 14 -30 16 -28 L 20 -24 Q 22 -22 20 -20 L 12 -12 Z`} fill="white" stroke="currentColor" strokeWidth="2"/><path d="M 9 -21 L 16 -14" stroke="currentColor" strokeWidth="2"/></>}</>
}

export function ProbeBadgeGlyph({ type, label, selected = false, negative = false }: { type: ProbeType; label: string; selected?: boolean; negative?: boolean }) {
  const width = probeBadgeWidth(label)
  return <><rect width={width} height="36" rx="10" fill="white" stroke="currentColor" strokeWidth={selected ? 2.5 : 1.5} strokeDasharray={negative ? '4 2' : undefined}/><path className="probe-badge-accent" d="M 10 1 H 33 V 35 H 10 Q 1 35 1 26 V 10 Q 1 1 10 1" fill="currentColor" fillOpacity=".11"/><text x="18" y="23" textAnchor="middle" fill="currentColor" fontSize={type === 'differential' ? 14 : 17} fontWeight="800">{probeTypes[type].symbol}</text><path className="probe-type-divider" d="M 34 9 V 27" stroke="currentColor" opacity=".4"/><text x="45" y="23" fill="currentColor" fontSize="14" fontWeight="750">{label}</text><circle cx={width - 10} cy="9" r="2" fill="currentColor" opacity=".55"/></>
}

/** The read-only glyph has no editor controls and is safe in a standalone SVG. */
export function StaticProbeMarker({ drawing, marker }: { drawing: Drawing; marker: ProbeMarker }) {
  const point = probePoint(drawing, marker.at, marker.anchor), offset = marker.offset ?? { x: 28, y: -64 }, type = marker.type ?? 'voltage'
  return <g className={`measurement-marker measurement-marker-${type}${marker.negative ? ' measurement-marker-negative' : ''}`} data-probe-type={type} data-probe-id={marker.reference ? undefined : marker.label} data-probe-reference={marker.reference ? 'output' : undefined} aria-label={marker.reference ? '参考输出 V OUT（非测量）' : `${probeTypes[type].name}探针 ${marker.label}`} transform={`translate(${point.x} ${point.y})`} color={marker.color} pointerEvents="none">
    <ProbeLeader offset={offset} label={marker.label} type={type}/>
    <g className="probe-tip"><ProbeTipGlyph type={type} negative={marker.negative} currentAngle={probeCurrentAngle(drawing, marker)} sharedTip={marker.sharedTip}/></g>
    <g className="probe-badge" transform={`translate(${offset.x} ${offset.y})`}><ProbeBadgeGlyph type={type} label={marker.label} negative={marker.negative}/></g>
  </g>
}
