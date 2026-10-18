/** Case-insensitive SPICE scalar suffixes; a bare M is milli, not mega. */
export function spiceParameterNumber(raw: string): number | undefined {
  const match = raw.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf]?)$/i)
  if (!match) return undefined
  const scales: Record<string, number> = { '': 1, t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 }
  const value = Number(match[1]) * scales[match[2].toLowerCase()]
  return Number.isFinite(value) ? value : undefined
}

export function equivalentModelParameterValues(before: string, after: string): boolean {
  if (before.trim() === after.trim()) return true
  const a = spiceParameterNumber(before), b = spiceParameterNumber(after)
  if (a === undefined || b === undefined) return false
  // Only absorb floating point rounding in suffix expansion, not measurement differences.
  return a === b || Math.abs(a - b) <= Number.EPSILON * 4 * Math.max(Math.abs(a), Math.abs(b))
}
