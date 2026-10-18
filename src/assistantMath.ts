/**
 * remark-math understands dollar delimiters, while Codex also writes TeX's
 * \(...\) and \[...\] delimiters. Normalize those before Markdown parses
 * backslashes as escapes. Code spans and fenced source must remain literal.
 */
export function normalizeAssistantMath(source: string): string {
  type Delimiter = { index: number; kind: '(' | '[' | ')' | ']' }
  const delimiters: Delimiter[] = []
  let fence: { marker: string; length: number } | null = null
  let codeTicks = 0
  let offset = 0

  for (const line of source.split(/(?<=\n)/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length &&
          /^\s*$/.test(line.slice(marker[0].length))) fence = null
      offset += line.length
      continue
    }
    if (!codeTicks && marker) {
      fence = { marker: marker[1][0], length: marker[1].length }
      offset += line.length
      continue
    }

    for (let index = 0; index < line.length; index++) {
      if (line[index] === '`') {
        let end = index + 1
        while (line[end] === '`') end++
        const count = end - index
        if (!codeTicks) codeTicks = count
        else if (codeTicks === count) codeTicks = 0
        index = end - 1
        continue
      }
      if (codeTicks || line[index] !== '\\' || !'()[]'.includes(line[index + 1] ?? '')) continue
      // An escaped backslash is text, not a TeX delimiter.
      let preceding = 0
      for (let back = index - 1; back >= 0 && line[back] === '\\'; back--) preceding++
      if (preceding % 2 === 0) delimiters.push({ index: offset + index, kind: line[index + 1] as Delimiter['kind'] })
      index++
    }
    offset += line.length
  }

  const replacements = new Map<number, string>()
  let opening: Delimiter | null = null
  for (const delimiter of delimiters) {
    if (!opening) {
      if (delimiter.kind === '(' || delimiter.kind === '[') opening = delimiter
    } else if ((opening.kind === '(' && delimiter.kind === ')') ||
               (opening.kind === '[' && delimiter.kind === ']')) {
      if (delimiter.index > opening.index + 2) {
        const display = opening.kind === '['
        replacements.set(opening.index, display ? '\n$$\n' : '$')
        replacements.set(delimiter.index, display ? '\n$$\n' : '$')
      }
      opening = null
    }
  }

  if (!replacements.size) return source
  let normalized = ''
  for (let index = 0; index < source.length; index++) {
    const replacement = replacements.get(index)
    if (replacement === undefined) normalized += source[index]
    else {
      normalized += replacement
      index++ // Consume the bracket or parenthesis along with its backslash.
    }
  }
  return normalized
}
