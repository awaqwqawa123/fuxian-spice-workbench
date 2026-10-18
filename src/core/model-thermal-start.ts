import type {ImportedSpiceModel} from './spice-models'
export interface ThermalModelStart {
 family:'ntc'|'ptc';temperature:number;resistance:number
 /** Relative to the externally assigned subcircuit instance, e.g. x113.aout. */
 nodes:{path:string;value:number}[];evidence:string[]
}
/** Numerical starting hints for recognized source thermal equations, never
 * model substitutions or package-pin guesses. Caller owns existing IC/NODESET
 * precedence. Returning undefined is safer than creating an unknown hint. */
export function thermalModelStart(model:ImportedSpiceModel,temperature=27):ThermalModelStart|undefined {
 if(model.kind!=='X'||model.pins.length!==2||model.pins.map(pin=>pin.toUpperCase()).sort().join(',')!=='RN,RP'||!Number.isFinite(temperature)||temperature<=-273.15)return
 const blocks=[...model.spice.matchAll(/^\s*\.subckt\s+(\S+)[^\n]*\n([\s\S]*?)^\s*\.ends[^\n]*/gmi)]
 const root=blocks.find(block=>block[1].toUpperCase()===model.id.toUpperCase())
 if(!root)return
 const instance=root[2].match(/^\s*(X\S+)\s+RN\s+RP\s+(NTC_BASE|TFPT_BASE)\s+PARAMS:\s*(.+)$/mi)
 const baseName=instance?.[2]??root[1],base=blocks.find(block=>block[1].toUpperCase()===baseName.toUpperCase())
 if(!/^(NTC|TFPT)_BASE$/i.test(baseName)||!base||!/v\(RP,RN\)\/v\(AOUT\)/i.test(base[2]))return
 const ptc=/^TFPT_BASE$/i.test(baseName),parameters=instance?.[3]??root[0].split('\n')[0],values=new Map<string,number>()
 for(const match of parameters.matchAll(/\b(R25|A|B|C|D|T0|W|X|Y|Z)\s*=\s*([-+\d.eE]+)(?=\s|$)/gi))values.set(match[1].toUpperCase(),Number(match[2]))
 // T0 is a documented NTC kernel default when the wrapper does not override
 // it. An explicitly symbolic override stays unknown instead of falling back.
 if(!ptc&&!/\bT0\s*=/i.test(parameters)){
  const defaultT0=base[0].split('\n')[0].match(/\bT0\s*=\s*([-+\d.eE]+)(?=\s|$)/i)
  if(defaultT0)values.set('T0',Number(defaultT0[1]))
 }
 const coefficients=ptc?['A','B','C','D']:temperature>25?['A','B','C','D']:['W','X','Y','Z']
 if(!['R25',...(ptc?[]:['T0']),...coefficients].every(name=>Number.isFinite(values.get(name))))return
 const [a,b,c,d]=coefficients.map(name=>values.get(name)!),t=ptc?temperature:values.get('T0')!+temperature
 const resistance=values.get('R25')!*(ptc?a+t*(b+t*(c+t*d)):Math.exp(a+b/t+c/t**2+d/t**3))
 if(!Number.isFinite(resistance)||resistance<=0)return
 const prefix=instance?`${instance[1].toLowerCase()}.`:''
 const nodes=[{path:`${prefix}aout`,value:resistance},{path:`${prefix}h`,value:0},...(ptc?[{path:`${prefix}t`,value:1},{path:`${prefix}ftemp`,value:temperature},{path:`${prefix}tottol`,value:0}]:[])]
 return {family:ptc?'ptc':'ntc',temperature,resistance,nodes,evidence:[`Explicit root ordered ports: ${model.pins.join(', ')}`,`Recognized ${baseName} source equation v(RP,RN)/v(AOUT)`,`Source coefficients: ${parameters}`,`Source-derived ${temperature} °C nominal resistance ${resistance} ohm; no coefficient or source changes`]}
}
