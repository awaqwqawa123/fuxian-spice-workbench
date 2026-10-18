import type { ImportedSpiceModel } from './spice-models'
import type { ModelDeviceInfo } from './model-device-info'
import { modelCategory, modelCategoryLabel } from './model-taxonomy'
import { presentedModelSymbol } from './model-symbol-presentation'
import { classifyModelFunctionalSymbol } from './model-functional-symbol'

export interface DeviceLibraryProfile {
  device: ModelDeviceInfo & {category:string;categoryLabel:string}
  symbol: {status:'original'|'standard'|'connection-only';source?:string;sha256?:string}
  pinMapping: {status:'verified'|'electrical-order-only';ports:{index:number;node:string;label:string;number?:string}[]}
  electrical: {status:'static-accepted';source:string;declarations:number;dependencies:string[];simulation:'not-verified';engineReview?:DeviceEngineReview}
}
export interface DeviceEngineReview {
  status:'load-passed'|'compatibility-error'|'compatibility-warning'|'needs-device-test'
  test:string
  reason:string
  recordedAt:string
}

/** Readiness describes distinct evidence layers. A drawable symbol and accepted
 * dependency closure do not certify the electrical accuracy of a simulation. */
export function deviceLibraryProfile(model:ImportedSpiceModel):DeviceLibraryProfile {
  const symbol=presentedModelSymbol(model),classification=model.kind==='X'?classifyModelFunctionalSymbol(model):undefined
  const graphical=symbol?.shape==='ltspice',mapped=model.kind!=='X'||graphical||classification?.mapping==='verified'
  const declarations=[...model.spice.matchAll(/^\s*\.(?:model|subckt)\s+(\S+)/gim)].map(match=>match[1])
  const device=model.deviceInfo??{version:1 as const,...(model.metadata.mfg?{manufacturer:model.metadata.mfg}:{}),...(model.metadata.type?{function:model.metadata.type}:{}),evidence:[]}
  return {
    device:{...device,category:modelCategory(model),categoryLabel:modelCategoryLabel(model)},
    symbol:{status:graphical?(symbol.origin==='standard'?'standard':'original'):model.kind!=='X'?'standard':'connection-only',...(symbol?.source?{source:symbol.source.label,sha256:symbol.source.sha256}:{})},
    pinMapping:{status:mapped?'verified':'electrical-order-only',ports:model.pins.map((node,index)=>({index,node,label:symbol?.pins[index]?.label??node,...(symbol?.pins[index]?.number?{number:symbol.pins[index].number}:{})}))},
    electrical:{status:'static-accepted',source:model.source.label,declarations:declarations.length,dependencies:declarations.filter(id=>id.toLowerCase()!==model.id.toLowerCase()),simulation:'not-verified'},
  }
}
