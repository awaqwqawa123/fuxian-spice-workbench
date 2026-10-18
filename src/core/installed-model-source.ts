import type { SpiceModelSource } from './spice-models'

export const tinaSourceUrl = 'https://www.ti.com/tool/TINA-TI'
export const pspiceSourceUrl = 'https://www.cadence.com/en_US/home/tools/system-design-and-verification/analog-mixed-signal-simulation/pspice.html'

function boundedLibraryPath(path:string):boolean {
  return /\.(?:lib|mod|sub|cir|spice|spi|inc|txt)$/i.test(path)
    && !/[\\:\x00-\x1f]/.test(path)
    && path.split('/').every(part=>!!part&&part!=='.'&&part!=='..')
}

/** Recognize recorded local provenance, never accept a user-selected disk path. */
export function isInstalledTinaSource(source: SpiceModelSource): boolean {
  const prefix=['TINA 本地库 / SPICELIB/','本机 TINA / SPICELIB/'].find(value=>source.label.startsWith(value))
  return source.url===tinaSourceUrl&&!!prefix&&boundedLibraryPath(source.label.slice(prefix.length))
}

export function isOwnedPspiceSource(source:SpiceModelSource):boolean {
  const prefix='PSpice 本地库 /'
  if(source.url!==pspiceSourceUrl||!source.label.startsWith(prefix))return false
  const path=source.label.slice(prefix.length).replace(/^ /,'')
  return /^(?:tools\/)?pspice\/library\//i.test(path)&&boundedLibraryPath(path)
}

export function isOwnedVendorModelSource(source:SpiceModelSource):boolean {
  return isInstalledTinaSource(source)||isOwnedPspiceSource(source)
}
