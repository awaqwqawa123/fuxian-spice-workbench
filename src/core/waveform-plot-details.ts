import type { WaveformDomain, WaveformTrace } from './waveform-workspace'

/** Stable signal identities keep their color as other probes/expressions appear. */
export function waveformSignalColor(id:string):string {
  let hash=2166136261
  for(const char of id){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619)}
  return `hsl(${(hash>>>0)%360} 65% 42%)`
}

export function waveformSampleWindow(trace:Pick<WaveformTrace,'x'|'y'>,range:WaveformDomain) {
  const length=Math.min(trace.x.length,trace.y.length)
  const direction=length>1&&trace.x[length-1]<trace.x[0]?-1:1
  const lower=(value:number,inclusive:boolean)=>{let start=0,end=length;while(start<end){const middle=(start+end)>>>1,at=trace.x[middle]*direction,target=value*direction;if(at<target||!inclusive&&at===target)start=middle+1;else end=middle}return start}
  const first=lower(direction===1?range[0]:range[1],true),end=lower(direction===1?range[1]:range[0],false)
  let maximumStep=0
  for(let i=Math.max(1,first);i<Math.min(length,end+1);i++)maximumStep=Math.max(maximumStep,Math.abs(trace.x[i]-trace.x[i-1]))
  return {first,end,count:Math.max(0,end-first),maximumStep}
}
