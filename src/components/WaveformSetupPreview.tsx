import { Settings2 } from 'lucide-react'
import { formatSI, parseQuantity, type Project } from '../core/circuit'
import { simulationNames, simulationSettings, type SimulationProfile, type SimulationProfiles } from '../core/simulation-profiles'
import type { CanvasWaveform } from '../core/canvas-waveform-store'
export interface WaveformSetupPreviewData { version:1; profiles:SimulationProfiles; diagrams:CanvasWaveform[] }
export type WaveformPreviewProject = Project & { waveformSetup?:WaveformSetupPreviewData }

function analysisSummary(profile:SimulationProfile) {
  const {analysis,tran,ac,dc}=profile.settings
  if(analysis==='tran')return `${tran.start??'0'} → ${tran.stop} · 最大步长 ${tran.step}${tran.outputStep?` · 输出 ${tran.outputStep}`:''}${tran.uic?' · UIC':''}`
  if(analysis==='ac'||analysis==='noise')return `${ac.start} → ${ac.stop} · ${ac.points} ${ac.sweep==='lin'?'总点数':ac.sweep==='oct'?'点/倍频程':'点/十倍频'}`
  if(analysis==='dc')return dc?`${dc.sourceId?dc.sourceId+' · ':''}${dc.start} → ${dc.stop} · 步进 ${dc.step}`:'扫描范围未配置'
  return '单点直流工作点'
}

/** Translate the normalized display window, leaving the simulation duration untouched. */
export function waveformPreviewWindow(profile:SimulationProfile,diagram:CanvasWaveform):string {
  const {analysis,tran,ac,dc}=profile.settings,domain=diagram.view?.domain??[0,1]
  if(analysis==='op')return '单点直流工作点'
  const fallback=`全范围的 ${formatSI(domain[0]*100,'%',4)} → ${formatSI(domain[1]*100,'%',4)}`
  try {
    let start:number,stop:number,unit:string
    if(analysis==='tran'){start=tran.start?parseQuantity(tran.start,'time'):0;stop=parseQuantity(tran.stop,'time');unit='s'}
    else if(analysis==='dc'){if(!dc)return fallback;unit=/^I/i.test(dc.sourceId??profile.settings.sourceId??'V1')?'A':'V';start=parseQuantity(dc.start,unit==='A'?'current':'voltage');stop=parseQuantity(dc.stop,unit==='A'?'current':'voltage')}
    else {start=parseQuantity(ac.start,'frequency');stop=parseQuantity(ac.stop,'frequency');unit='Hz';if(start<=0||stop<=0)return fallback}
    if(start>stop)[start,stop]=[stop,start]
    const frequency=analysis==='ac'||analysis==='noise'
    const at=(fraction:number)=>frequency?10**(Math.log10(start)+(Math.log10(stop)-Math.log10(start))*fraction):start+(stop-start)*fraction
    return `${formatSI(at(domain[0]),unit,4)} → ${formatSI(at(domain[1]),unit,4)}${frequency?' · 对数频率':''}`
  }catch{return fallback}
}

/** Conversation previews show experiment settings only. Plot configuration lives in each canvas frame. */
export default function WaveformSetupPreview({project}:{project:WaveformPreviewProject;emptyMessage?:boolean}) {
  const profiles=project.waveformSetup?.profiles.profiles??[{id:'current',name:'',settings:simulationSettings(project)}]
  return <section className="waveform-setup-preview" aria-label="仿真设置预览">
    <header><strong><Settings2 size={13}/>仿真设置</strong></header>
    <ul>{profiles.map(profile=><li key={profile.id} data-simulation-review={profile.id}>
      <strong>{simulationNames[profile.settings.analysis]}{profiles.length>1&&profile.name&&<small>{profile.name}</small>}</strong>
      <span>{analysisSummary(profile)}</span>
      <span>{profile.settings.temperature??27} °C{profile.settings.sweep?` · ${profile.settings.sweep.target==='temperature'?'温度':profile.settings.sweep.target.slice(7)}扫描 ${profile.settings.sweep.values.length} 次`:''}</span>
    </li>)}</ul>
  </section>
}
