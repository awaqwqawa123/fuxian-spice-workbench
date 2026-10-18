import type { LtspiceAsy } from './ltspice-symbol'
import type { SpiceModelSource } from './spice-models'

export interface OfflineSymbolSource {
  key: string
  repo: string
  revision: string
  archiveSha256: string
}
export interface OfflineSymbolAsset {
  id: string
  sourceKey: string
  relativePath: string
  name: string
  format: 'asy' | 'olb'
  sha256: string
  bytes: number
  originalStored: boolean
  symbolsAvailable: boolean
  status: 'parsed' | 'converted' | 'needs-conversion' | 'unsupported' | 'unreadable'
  reason: string
  pinCount?: number
  modelStatus?: 'linked' | 'symbol-only' | 'unsupported'
  convertedParts?: number
}
export interface OfflineSymbolCatalog {
  total: number
  items: OfflineSymbolAsset[]
  sources: OfflineSymbolSource[]
  counts: { originals: number; parsedAsy: number; linkedAsy: number; olb: number; convertedOlb: number; needsConversion: number; unsupported: number }
  notices: string[]
}
export interface OfflineSymbolDetail {
  item: OfflineSymbolAsset
  source: SpiceModelSource
  asy?: LtspiceAsy
  parts?: { id: string; name: string; pinCount: number; status: 'linked' | 'symbol-only' | 'unsupported'; reason: string }[]
}
