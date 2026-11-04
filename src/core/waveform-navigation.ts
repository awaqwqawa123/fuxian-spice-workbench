import { zoomWaveformDomain, type WaveformDomain } from './waveform-workspace'
import { zoomWaveformAxisRanges, type WaveformAxisRanges } from './waveform-axis-settings'

/** Opposite wheel deltas are reciprocal, including line/page input devices. */
export function waveformWheelFactor(deltaY:number,deltaMode=0,pageHeight=480):number {
  const pixels=deltaY*(deltaMode===1?16:deltaMode===2?pageHeight:1)
  return Number.isFinite(pixels)?Math.exp(-Math.max(-160,Math.min(160,pixels))*.0025):1
}

/** Apply the actual bounded X multiplier to Y too, so limits cannot distort XY zoom. */
export function zoomWaveformCoordinates(domain:WaveformDomain,ranges:WaveformAxisRanges,factor:number,x=.5,y=.5,axes:{x:boolean;y:boolean}={x:true,y:true}) {
  const nextDomain=axes.x?zoomWaveformDomain(domain,factor,x):domain
  const appliedFactor=axes.x?(domain[1]-domain[0])/(nextDomain[1]-nextDomain[0]):factor
  return {domain:nextDomain,ranges:axes.y?zoomWaveformAxisRanges(ranges,appliedFactor,y):ranges}
}
