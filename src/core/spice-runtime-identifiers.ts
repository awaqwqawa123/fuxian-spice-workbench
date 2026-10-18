/** ngspice's parameter expander treats punctuation in subcircuit names as
 * expression syntax. Keep source and saved identities intact; rename only
 * declared electrical identifiers and their X-instance references in the
 * complete executable/exported netlist. Values, nodes and parameters stay exact.
 */
export function normalizeNgspiceSubcircuitIdentifiers(netlist: string): string {
  const declarations = new Map<string, string>(), reserved = new Set<string>()
  for (const line of netlist.split(/\r?\n/)) {
    const name = line.match(/^\s*\.subckt\s+(\S+)/i)?.[1]
    if (name) { declarations.set(name.toLowerCase(), name); reserved.add(name.toLowerCase()) }
  }
  const aliases = new Map<string, string>()
  for (const [key] of declarations) {
    if (/^[a-z_][a-z0-9_]*$/i.test(key)) continue
    // A reversible encoding prevents A/B and A-B from collapsing to one model.
    const base = `FXSUB_${[...key].map(char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`
    let alias = base, suffix = 0
    while (reserved.has(alias.toLowerCase())) alias = `${base}_${++suffix}`
    reserved.add(alias.toLowerCase()); aliases.set(key, alias)
  }
  if (!aliases.size) return netlist
  return netlist.split(/(\r?\n)/).map(line => {
    const declaration = line.match(/^(\s*\.(?:subckt|ends)\s+)(\S+)/i)
    if (declaration) {
      const alias = aliases.get(declaration[2].toLowerCase())
      return alias ? line.slice(0, declaration[1].length) + alias + line.slice(declaration[0].length) : line
    }
    if (!/^\s*X[^\s]*\s/i.test(line)) return line
    // Continuations contain parameter tails in imported library definitions;
    // the electrical target precedes PARAMS: or the first assignment.
    const comment = line.search(/\s[;$]/), prefix = comment < 0 ? line : line.slice(0, comment)
    const parameter = prefix.search(/\s+(?:(?:params?|parameters)\s*:|[a-z_][a-z0-9_]*\s*=)/i)
    const electrical = parameter < 0 ? prefix : prefix.slice(0, parameter)
    const target = /\S+(?=\s*$)/.exec(electrical)
    if (!target) return line
    const alias = aliases.get(target[0].toLowerCase())
    return alias ? line.slice(0, target.index) + alias + line.slice(target.index + target[0].length) : line
  }).join('')
}
