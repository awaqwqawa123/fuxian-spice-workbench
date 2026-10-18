import type { ImportedSpiceModel } from './spice-models'
import { modelCategoryLabel } from './model-taxonomy'

export interface LocalModelFile {
  file:string
  label:string
  available:boolean
  accepted:number
  rejected:number
  issues:{message:string;count:number}[]
  packageId?:string
  source?:string
}
export interface LocalModelCatalog { models:ImportedSpiceModel[]; files:LocalModelFile[]; materialized?:{installed:boolean;files:number;models:number;unsupported:number;unsupportedFiles:number;builtAt?:string;artifacts?:{files:number;modelFiles:number;olb:number;asy:number}} }

export const modelTypeLabels={D:'二极管',NPN:'NPN 晶体管',PNP:'PNP 晶体管',NMOS:'N 沟道 MOS',PMOS:'P 沟道 MOS',NJF:'N 沟道 JFET',PJF:'P 沟道 JFET',SUBCKT:'多引脚子电路'} as const
/** Search actual stored parameters as well as part names; never infer ratings. */
export function modelSearchText(model:ImportedSpiceModel):string {
  return `${model.id} ${model.name} ${model.type} ${model.technology??''} ${modelTypeLabels[model.type]} ${modelCategoryLabel(model)} ${Object.entries(model.metadata).map(([key,value])=>`${key}=${value} ${value}`).join(' ')} ${model.source.label} ${model.source.license??''} ${model.spice}`.toLowerCase()
}
export function searchCatalog(models:ImportedSpiceModel[],query:string,type='',manufacturer='') {
  const terms=query.toLowerCase().trim().replace(/\s*=\s*/g,'=').split(/\s+/).filter(Boolean)
  return models.filter(model=>(!type||model.type===type)&&(!manufacturer||model.metadata.mfg===manufacturer)&&terms.every(term=>modelSearchText(model).includes(term)))
}

/** A short overview of explicit electrical constants, separate from catalog ratings. */
export function catalogModelParameters(model:ImportedSpiceModel):{key:string;value:string}[] {
  if(model.kind==='X')return []
  const order=model.kind==='D'?['BV','IS','RS','CJO','TT']:model.kind==='Q'?['BF','VAF','IKF','TF']:model.kind==='M'?['VTO','KP','CGS','CGDMAX']:['VTO','BETA','CGS','CGD']
  const values=new Map([...model.spice.matchAll(/\b([a-z][a-z0-9_]*)\s*=\s*([^\s(),]+)/gi)].map(match=>[match[1].toUpperCase(),match[2]]))
  return order.filter(key=>values.has(key)).slice(0,4).map(key=>({key,value:values.get(key)!}))
}
