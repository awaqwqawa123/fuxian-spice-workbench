/** Text extraction shared by browser uploads and the local model-search service. */
import { DATASHEET_LIMITS } from './datasheet-limits'
import { datasheetEncodingNotices, normalizeDatasheetText } from './datasheet-encoding'
import type { DatasheetFigure } from './datasheet-curve-evidence'
export { DATASHEET_LIMITS } from './datasheet-limits'
export interface DatasheetPage { number: number; text: string }
export interface DatasheetText { fileName: string; pages: DatasheetPage[]; notices: string[];figures?:DatasheetFigure[] }
export interface PdfTextItem { str: string; transform: number[]; width: number; hasEOL?: boolean }
interface PdfPage { getTextContent(): Promise<{ items: unknown[] }>; cleanup(): void }
interface PdfDocument { numPages: number; getPage(page: number): Promise<PdfPage> }
export interface PdfLoader { getDocument(options: { data: Uint8Array; isEvalSupported: false; useSystemFonts: false; stopAtErrors: true }): { promise: Promise<PdfDocument>; destroy(): Promise<void> } }

/** PDF text streams need not be in visual order. Keep the visible rows and column gaps. */
export function pdfItemsToText(items: unknown[]): string {
  const runs = items.filter((item): item is PdfTextItem => Boolean(item && typeof item === 'object' && 'str' in item && 'transform' in item))
    .filter(item => item.str.trim()).map(item => ({ ...item, x: item.transform[4], y: item.transform[5] }))
    .sort((a, b) => Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x)
  const lines: { y: number; items: typeof runs }[] = []
  for (const item of runs) {
    const last = lines.at(-1)
    if (last && Math.abs(last.y - item.y) <= 2) last.items.push(item)
    else lines.push({ y: item.y, items: [item] })
  }
  return lines.map(line => line.items.sort((a, b) => a.x - b.x).map((item, index, row) => {
    if (!index) return item.str
    const previous = row[index - 1]
    return (item.x - previous.x - previous.width > 12 ? '\t' : ' ') + item.str
  }).join('')).join('\n')
}

export async function extractDatasheetPdf(data: Uint8Array, fileName: string, loader: PdfLoader, progress?: (page: number, total: number) => void): Promise<DatasheetText> {
  if (data.byteLength > DATASHEET_LIMITS.fileBytes) throw new Error('规格书最大支持 12 MB，请拆分文件后重试。')
  if (!new TextDecoder().decode(data.subarray(0, 5)).startsWith('%PDF-')) throw new Error('文件不是有效的 PDF。请下载规格书原文件，不要使用网页或验证页面。')
  const task = loader.getDocument({ data, isEvalSupported: false, useSystemFonts: false, stopAtErrors: true })
  let timeout: ReturnType<typeof setTimeout> | undefined
  const parse = async () => {
    const document = await task.promise
    if (document.numPages > DATASHEET_LIMITS.pages) throw new Error('规格书最多支持 60 页，请先截取电气参数相关页。')
    const pages: DatasheetPage[] = []
    let characters = 0
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number)
      try {
        const text = normalizeDatasheetText(pdfItemsToText((await page.getTextContent()).items))
        characters += text.length
        if (characters > DATASHEET_LIMITS.characters) throw new Error('规格书文本过长，请先截取电气参数相关页。')
        pages.push({ number, text }); progress?.(number, document.numPages)
      } finally { page.cleanup() }
    }
    if (pages.map(page => page.text).join('').replace(/\uFFFD/g, '').trim().length < 25) throw new Error('PDF 中没有足够的可复制文本，可能是扫描件。请先进行 OCR，或将参数与测试条件保存为 TXT 后导入。')
    return { fileName, pages, notices: ['仅在本机提取文字；图表曲线与扫描图片未做拟合。', ...datasheetEncodingNotices(pages)] }
  }
  try {
    return await Promise.race([parse(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('PDF 解析超过 45 秒，请截取参数页后重试。')), DATASHEET_LIMITS.milliseconds) })])
  } catch (error) {
    if ((error as Error).name === 'PasswordException') throw new Error('规格书 PDF 已加密，请先解密后导入。')
    throw error
  } finally { clearTimeout(timeout); await task.destroy() }
}

