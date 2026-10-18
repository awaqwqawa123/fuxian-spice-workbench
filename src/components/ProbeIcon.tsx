import type { ProbeType } from '../core/probes'

/** Small instrument symbols shared by the palette and drawing badges. */
export default function ProbeIcon({type,size=32}:{type:ProbeType;size?:number}) {
  return <svg className={`probe-instrument-icon probe-instrument-${type}`} width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    {type==='current'?<><path d="M 11 6 A 10 10 0 1 0 21 6"/><path d="M 11 6 V 12 M 21 6 V 12 M 5 17 H 26 M 22 13 L 26 17 L 22 21"/><path className="probe-icon-accent" d="M 13 27 H 19"/></>:type==='differential'?<><path d="M 9 4 V 19 L 5 27 M 23 4 V 19 L 27 27 M 9 10 H 23"/><circle cx="9" cy="10" r="5" className="probe-icon-surface"/><circle cx="23" cy="10" r="5" className="probe-icon-surface"/><path d="M 6.5 10 H 11.5 M 9 7.5 V 12.5 M 20.5 10 H 25.5"/><path className="probe-icon-accent" d="M 13 23 L 16 18 L 19 23 Z"/></>:<><path d="M 10 23 L 6 28 M 22 5 L 26 1"/><path className="probe-icon-surface" d="M 11 24 L 8 21 L 18 5 Q 19 3 21 5 L 25 9 Q 27 11 25 12 Z"/><path d="M 13 14 L 19 20 M 17 8 L 23 14"/><path className="probe-icon-accent" d="M 10 23 L 6 28"/></>}
  </svg>
}
