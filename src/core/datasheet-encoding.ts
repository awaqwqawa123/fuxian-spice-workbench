/** Preserve an unreadable glyph instead of deleting it and silently changing a number. */
export function normalizeDatasheetText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x0b\x0c]/g, '\n').replace(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/g, '\uFFFD')
}

export function hasUnreadableDatasheetText(text: string): boolean {
  return /[\x00-\x08\x0e-\x1f\x7f-\x9f\uFFFD]/.test(text)
}

export function datasheetEncodingNotices(pages: { number: number; text: string }[]): string[] {
  const affected = pages.filter(page => hasUnreadableDatasheetText(page.text)).map(page => page.number)
  return affected.length ? [`第 ${affected.join('、')} 页含无法识别的字符（�）；请核对原 PDF，这些位置不能作为模型参数依据。`] : []
}

/** A short quote cannot omit a damaged digit elsewhere on the same table row. */
export function quoteHasUnreadableDatasheetText(text: string, quote: string): boolean {
  if (hasUnreadableDatasheetText(quote)) return true
  const compact = (value: string) => value.replace(/\s+/g, ' ').trim()
  const normalized = normalizeDatasheetText(text)
  const quoted = compact(quote)
  const rows = normalized.split('\n').map(compact).filter(Boolean)
  const joined = rows.join(' ')
  const start = joined.indexOf(quoted)
  if (start < 0) return false // The caller validates literal evidence independently.
  const end = start + quoted.length
  let offset = 0
  return rows.some(row => {
    const length = compact(row).length
    const overlaps = offset < end && offset + length > start
    offset += length + 1
    return overlaps && hasUnreadableDatasheetText(row)
  })
}
