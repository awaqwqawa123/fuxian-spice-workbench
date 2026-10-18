/** This ngspice runtime requires a named diode AREA assignment. PSpice's
 * positional area has exactly the same meaning; keep its value/expression
 * and every following instance option. In particular, do not guess the
 * meaning of an additional vendor STATE argument. */
export function normalizeDiodeAreas(spice:string):string {
  return spice.split('\n').map(line=>{
    const match=line.match(/^(D\S*\s+\S+\s+\S+\s+\S+)\s+(\{[^{}]+\}|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?)(?=\s|$)(.*)$/i)
    return match?`${match[1]} AREA=${match[2]}${match[3]}`:line
  }).join('\n')
}
