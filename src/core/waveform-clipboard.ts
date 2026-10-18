import { DRAWING_BOUNDS } from './drawing'
import type { CanvasWaveform } from './canvas-waveform-store'

/** Copy a selection as one translated group, including at sheet boundaries. */
export function pasteWaveformGroup(source:readonly CanvasWaveform[],existing:readonly CanvasWaveform[]):CanvasWaveform[]{
  if(!source.length)return []
  const minX=Math.max(...source.map(item=>DRAWING_BOUNDS.min-item.x)),maxX=Math.min(...source.map(item=>DRAWING_BOUNDS.max-item.width-item.x))
  const minY=Math.max(...source.map(item=>DRAWING_BOUNDS.min-item.y)),maxY=Math.min(...source.map(item=>DRAWING_BOUNDS.max-item.height-item.y))
  const occupied=[...source,...existing]
  let delta={x:0,y:0}
  outer:for(let step=1;step<=occupied.length*source.length+2;step++){
    for(const [dx,dy]of [[40,40],[-40,-40],[40,-40],[-40,40]]){
      const x=Math.max(minX,Math.min(maxX,dx*step)),y=Math.max(minY,Math.min(maxY,dy*step))
      if(source.every(item=>!occupied.some(other=>item.x+x===other.x&&item.y+y===other.y))){delta={x,y};break outer}
    }
  }
  return source.map(item=>({...structuredClone(item),id:crypto.randomUUID(),title:`${item.title.slice(0,77)} 副本`,x:item.x+delta.x,y:item.y+delta.y}))
}
