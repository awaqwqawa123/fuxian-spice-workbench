import type { Device } from './drawing'
import { localPin } from './devices'
import type { ImportedSpiceModel } from './spice-models'
import type { ModelSymbol } from './model-symbol'
import { resolveModelFunctionalSymbol } from './model-functional-symbol'
const resolvedSymbols=new WeakMap<ImportedSpiceModel,{spice:string;stored:ModelSymbol|undefined;result:ModelSymbol|undefined}>()

/** Upgrade display evidence while keeping every saved electrical anchor. */
export function presentedModelSymbol(model:ImportedSpiceModel,device?:Device):ModelSymbol|undefined {
  if(model.kind!=='X'&&model.symbol?.shape==='box')return model.symbol
  let cache=resolvedSymbols.get(model)
  if(!cache||cache.spice!==model.spice||cache.stored!==model.symbol){cache={spice:model.spice,stored:model.symbol,result:resolveModelFunctionalSymbol(model)};resolvedSymbols.set(model,cache)}
  const resolved=cache.result
  if(!resolved)return model.symbol
  if(device?.kind==='X'&&resolved.shape==='ltspice'){
    const sameAnchors=resolved.pins.every(pin=>{const anchor=localPin('X',pin.index,device);return pin.x===anchor.x&&pin.y===anchor.y})
    if(!sameAnchors)return {version:1,shape:'box',origin:'standard',family:resolved.family,title:resolved.title,pins:resolved.pins.map(pin=>({index:pin.index,label:pin.label}))}
  }
  return resolved
}

export { modelDeviceBounds } from './model-device-bounds'
