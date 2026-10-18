import {isOwnedPspiceSource} from './installed-model-source'
import type {ImportedSpiceModel,SpiceModelSource} from './spice-models'

export function isLegacyDiodeLibrarySource(source:SpiceModelSource):boolean {
  return isOwnedPspiceSource(source)&&/\/di\.lib$/i.test(source.label)
}

export function legacyDiodeRootsForModels(models:readonly ImportedSpiceModel[]):string[] {
  return models.filter(model=>model.kind==='X'&&isLegacyDiodeLibrarySource(model.source)).map(model=>model.id)
}

/** Raw/exported decks retain the importer's source header. This identifies the
 * applicable adapter family; the adapter still checks every electrical line,
 * complete invocation scope and defaults before allowing any transformation.
 * Neither a part name nor an unrelated source comment is sufficient evidence.
 */
export function legacyDiodeRootsFromRetainedSources(netlist:string):string[] {
  const roots=new Set<string>()
  let current:{id:string;label?:string;url?:string}|undefined
  for(const line of netlist.split(/\r?\n/)){
    const imported=line.match(/^\s*\* Imported model:\s*([^;\s]+);/)
    if(imported){current={id:imported[1]};continue}
    if(!/^\s*\*/.test(line)){current=undefined;continue}
    if(!current)continue
    const source=line.match(/^\s*\* Source:\s*(.*)$/),url=line.match(/^\s*\* URL:\s*(.*)$/)
    if(source)current.label=source[1].trim()
    if(url)current.url=url[1].trim()
    if(current.label&&current.url&&isLegacyDiodeLibrarySource({label:current.label,url:current.url}))roots.add(current.id)
  }
  return [...roots]
}
