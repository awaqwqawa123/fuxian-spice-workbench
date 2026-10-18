import { parseSpiceLibrary, type SpiceModelSource } from './spice-models'
import { enrichModelSymbols } from './model-functional-symbol'

/** New-library import boundary. Saved-project validation deliberately uses the
 * electrical parser directly so upgrades cannot move existing wire anchors. */
export function parseModelLibraryPreview(text: string, source: SpiceModelSource) {
  const preview = parseSpiceLibrary(text, source)
  return enrichModelSymbols(preview, text)
}
