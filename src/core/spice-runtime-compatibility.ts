import {primitiveModelCompatibility} from './spice-primitive-compatibility'
import {normalizeNgspiceSubcircuitIdentifiers} from './spice-runtime-identifiers'
import {normalizePspiceSourceUnits} from './spice-source-units'
import {normalizeLegacyDiodeDefaultStates} from './spice-legacy-diode-state'
import {legacyDiodeRootsFromRetainedSources} from './legacy-diode-provenance'

export function reviewRuntimeNetlist(netlist:string,verifiedLegacyRoots?:readonly string[]) {
  const legacy=normalizeLegacyDiodeDefaultStates(normalizePspiceSourceUnits(netlist),verifiedLegacyRoots??legacyDiodeRootsFromRetainedSources(netlist))
  return {...legacy,netlist:normalizeNgspiceSubcircuitIdentifiers(primitiveModelCompatibility(legacy.netlist).spice)}
}

/** One execution boundary for canvas, raw decks, exports and library audits.
 * The caller retains the original source and saved model identity separately.
 * These conversions preserve equations; unsupported domain limits stay visible.
 */
export function prepareRuntimeNetlist(netlist:string,verifiedLegacyRoots?:readonly string[]):string {
  const review=reviewRuntimeNetlist(netlist,verifiedLegacyRoots)
  const errors=review.diagnostics.filter(item=>item.severity==='error')
  if(errors.length)throw new Error(errors.map(item=>`${item.model}：${item.message}`).join('\n'))
  return review.netlist
}
