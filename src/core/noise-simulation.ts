import type { Simulation } from 'eecircuit-engine'
import type { RawResult } from './results'

export interface NoiseSimulationResult extends RawResult { noiseTotals?: { input:number; output:number } }

// Voltage/current saves belong to AC/TRAN. Noise needs both spectral and integrated
// vectors; saving only spectra makes ngspice reject its integrated noise plot.
export function normalizeNoiseSaves(netlist:string):string {
  return netlist.replace(/^([ \t]*)\.save\b[^\r\n]*$/gim,'$1.save all')
}

/** Export the spectral plot explicitly: the default current plot is integrated noise. */
export async function runNoiseSimulation(simulation:Simulation,netlist:string):Promise<NoiseSimulationResult> {
  simulation.setNetList(normalizeNoiseSaves(netlist))
  // eecircuit-engine 1.8 has no public command hook. Keep its small command adapter
  // isolated here and fail clearly if the pinned engine changes its protocol.
  const adapter=simulation as unknown as {commandList?:unknown;cmd?:unknown}
  if(!Array.isArray(adapter.commandList)||typeof adapter.cmd!=='number')throw new Error('当前 ngspice 引擎不支持噪声频谱导出，请检查引擎版本。')
  adapter.commandList=[' ','source test.cir','destroy all','run','print noise2.onoise_total noise2.inoise_total','setplot noise1','write out.raw']
  const raw=await simulation.runSim()
  if(!raw.data.some(vector=>vector.name.toLowerCase()==='frequency')||!raw.data.some(vector=>vector.name.toLowerCase()==='onoise_spectrum')||!raw.data.some(vector=>vector.name.toLowerCase()==='inoise_spectrum'))throw new Error('ngspice 没有返回噪声频谱；积分总噪声不能作为频谱显示。')
  const total=(name:string)=>{
    const match=simulation.getInfo().match(new RegExp(`noise2\\.${name}\\s*=\\s*([+\\-\\d.eE]+)`,'i'))
    const value=match?Number(match[1]):NaN
    return Number.isFinite(value)&&value>=0?value:undefined
  }
  const input=total('inoise_total'),output=total('onoise_total')
  return {...raw,...(input!==undefined&&output!==undefined?{noiseTotals:{input,output}}:{})}
}
