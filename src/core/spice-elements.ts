import {subcircuitInstanceParameterTail} from './subcircuit-parameters'
import { parseQuantity, type Project } from "./circuit"
import { modelFor } from "./devices"
import { deviceParameterValues } from "./device-parameters"
import { importedModelNetlist } from "./spice-models"
import type { Device } from "./drawing"
import { opAmpParameters } from './opamp-models'
import { configuredSourceSpice, isConfiguredSource } from './sources'

export function referenceSourceSpice(p: Project): string {
  const input=p.drawing?.devices.find(part=>part.id===p.drawing?.sourceId)
  if(input&&isConfiguredSource(input))return configuredSourceSpice(input,p.analysis)
  const a = parseQuantity(p.source.amplitude, 'voltage'), f = parseQuantity(p.source.frequency, 'frequency'), o = parseQuantity(p.source.offset, 'voltage')
  const period = 1 / f
  const wave = p.source.waveform === 'sine' ? `SIN(${o} ${a} ${f})` : `PULSE(${o} ${o+a} 0 ${period/1000} ${period/1000} ${period/2} ${period})`
  const bias=parseQuantity(p.source.dc,'voltage')
  return p.analysis === 'op' || p.analysis === 'dc' ? `DC ${bias}` : p.analysis === 'ac' || p.analysis === 'noise' ? `DC ${bias} AC 1` : `DC ${o} AC 1 ${wave}`
}

/** One source statement for the solver, inspector preview and SPICE export. */
export function sourceSpice(p:Project,part:Device,sourceId=p.drawing?.sourceId??'',reference?:string):string {
  if(isConfiguredSource(part))return configuredSourceSpice(part,p.analysis)
  if(part.kind==='V')return part.id===sourceId?reference??referenceSourceSpice(p):`DC ${parseQuantity(part.value,'voltage')} AC 0`
  if(part.kind==='I')return `DC ${parseQuantity(part.value,'current')}`
  throw new Error('仅电压源和电流源支持激励语句')
}

/** Shared by the solver netlist and the read-only model code view. */
export function deviceSpice(p:Project,part:Device,nodes:string[],sourceId:string,source:string) {
  const usedModels=new Set<string>()
  const kinds = { R: "resistance", C: "capacitance", L: "inductance" } as const
  const code=(()=>{
    const params=deviceParameterValues(part)
    const internal=(suffix:string)=>`_fx:${part.id}:${suffix}`
    if(part.kind==='SW')return `R__fx_${part.id} ${nodes[0]} ${nodes[1]} ${part.value==='ON'?params.ron:params.roff}`
    if(part.kind==='VSW'){
      const model=`FX_${part.id}`
      usedModels.add(`.model ${model} SW(Ron=${params.ron} Roff=${params.roff} Vt=${params.vt} Vh=${params.vh})`)
      return `${part.id} ${nodes.join(' ')} ${model} OFF`
    }
    if(part.kind==='RELAY'){
      const threshold=(params.pickup+params.release)/2,hysteresis=(params.pickup-params.release)/2
      usedModels.add(`.model FX_${part.id}_NO SW(Ron=${params.ron} Roff=${params.roff} Vt=${threshold} Vh=${hysteresis})`)
      usedModels.add(`.model FX_${part.id}_NC SW(Ron=${params.ron} Roff=${params.roff} Vt=${-threshold} Vh=${hysteresis})`)
      return [
        `R__fx_${part.id}_coil ${nodes[0]} ${internal('coil')} ${params.coilR}`,
        `L__fx_${part.id}_coil ${internal('coil')} ${nodes[1]} ${params.coilL}`,
        `S__fx_${part.id}_NO ${nodes[2]} ${nodes[3]} ${nodes[0]} ${nodes[1]} FX_${part.id}_NO OFF`,
        `S__fx_${part.id}_NC ${nodes[2]} ${nodes[4]} ${nodes[1]} ${nodes[0]} FX_${part.id}_NC ON`,
      ].join('\n')
    }
    if(part.kind==='LDO'){
      const vset=parseQuantity(part.value,'voltage'),input=`v(${nodes[0]},${nodes[1]})`,output=`v(${nodes[2]},${nodes[1]})`
      // A controlled pass current flows IN -> OUT, preserving input load current and dissipation.
      // Smooth the zero-current knee to avoid a singular no-load Newton iteration.
      // Scale smoothing with Rout; the default 3.3 V model stays within 5 uV at no load.
      const demand=`((min(${vset},max(0,${input}-${params.dropout}))-${output})/${params.outputR})`
      const smoothingSquared=5e-14/params.outputR
      const pass=`((${demand}+sqrt(${demand}*${demand}+${smoothingSquared}))/2)`
      return [
        `B__fx_${part.id}_pass ${nodes[0]} ${nodes[2]} I=min(1,max(0,(${input}-${params.dropout})/0.001))*min(${params.currentLimit},${pass})`,
        `B__fx_${part.id}_iq ${nodes[0]} ${nodes[1]} I=${params.quiescent}*min(1,max(0,${input}/0.1))`,
        `R__fx_${part.id}_bleed ${nodes[2]} ${nodes[1]} 1e9`,
      ].join('\n')
    }
    if(part.kind==='XFMR'){
      const ratio=parseQuantity(part.value,'gain')
      return [
        `R__fx_${part.id}_p ${nodes[0]} ${internal('p')} ${params.primaryR}`,
        `L__fx_${part.id}_p ${internal('p')} ${nodes[1]} ${params.primaryL}`,
        `R__fx_${part.id}_s ${nodes[2]} ${internal('s')} ${params.secondaryR}`,
        `L__fx_${part.id}_s ${internal('s')} ${nodes[3]} ${params.primaryL*ratio*ratio}`,
        `K__fx_${part.id} L__fx_${part.id}_p L__fx_${part.id}_s ${params.coupling}`,
      ].join('\n')
    }
    if((part.kind==='V'||part.kind==='I')&&part.params?.waveform==='expression'&&p.analysis==='tran'){
      const expression=sourceSpice(p,part,sourceId,source)
      // A zero-volt series sense source preserves V1 branch-current identity.
      if(part.kind==='V')return `${part.id} ${nodes[0]} ${internal('wave')} DC 0\nB__fx_${part.id}_wave ${internal('wave')} ${nodes[1]} ${expression}`
      return `B__fx_${part.id}_wave ${nodes[0]} ${nodes[1]} ${expression}`
    }
    if(part.kind==='V'||part.kind==='I')return `${part.id} ${nodes.join(' ')} ${sourceSpice(p,part,sourceId,source)}`
    if(part.kind==='OPA'||part.kind==='CMP'){
      const preset=opAmpParameters(part.kind,part.value)
      const gain=preset?.gain??parseQuantity(part.value,'gain'),pole=part.kind==='OPA'?params.gbw/gain:params.bandwidth
      const low=`(v(${nodes[4]})+${params.headroom})`,high=`max(${low},v(${nodes[3]})-${params.headroom})`
      return [
        `R__fx_${part.id}_in ${nodes[0]} ${nodes[1]} ${params.inputR}`,
        `E__fx_${part.id}_gain ${internal('gain')} 0 ${nodes[0]} ${nodes[1]} ${gain}`,
        `R__fx_${part.id}_pole ${internal('gain')} ${internal('pole')} 1k`,
        `C__fx_${part.id}_pole ${internal('pole')} 0 ${1/(2*Math.PI*1000*pole)}`,
        `B__fx_${part.id}_limit ${internal('limited')} 0 V=min(${high},max(${low},v(${internal('pole')})))`,
        `R__fx_${part.id}_out ${internal('limited')} ${nodes[2]} ${params.outputR}`,
        // Supply terminals need finite DC paths even when the ideal rails draw no supply current.
        `R__fx_${part.id}_rail ${nodes[3]} ${nodes[4]} 1e12`,
      ].join('\n')
    }
    if(part.kind==='OP')return `${part.id} ${nodes[2]} 0 ${nodes[0]} ${nodes[1]} ${parseQuantity(part.value,'gain')}`
    const model=modelFor(part.kind,part.value,p.models)
    if(part.kind==='X'){
      if(!model||!('source' in model)||model.kind!=='X'||nodes.length!==model.pins.length)throw new Error(`${part.id}：子电路模型或引脚数量不匹配`)
      usedModels.add(importedModelNetlist(model))
      return `${part.id} ${nodes.join(' ')} ${model.id}${subcircuitInstanceParameterTail(part,model)}`
    }
    if(model){usedModels.add('source' in model?importedModelNetlist(model):model.spice);return part.kind==='M'&& !('technology' in model&&model.technology==='VDMOS')?`${part.id} ${nodes.join(' ')} ${nodes[2]} ${model.id} W=100u L=10u`:`${part.id} ${nodes.join(' ')} ${model.id}`}
    return `${part.id} ${nodes.join(' ')} ${parseQuantity(part.value,kinds[part.kind as 'R'|'C'|'L'])}`
  })()
  return {code,models:[...usedModels]}
}
