import { DATASHEET_LIMITS, type DatasheetText } from './datasheet-pdf-text'
import type { ModelTaskReference } from './model-tasks'
import { normalizeDatasheetText } from './datasheet-encoding'
import {parseDatasheetFigures} from './datasheet-curve-evidence'

/** Preserve the parsed pages for the modelling tools; the compact text is only a UI summary. */
export function modelTaskReference(document: DatasheetText, part?: string, url?: string): ModelTaskReference {
  const pages = document.pages.map(({ number, text }) => ({ number, text: normalizeDatasheetText(text) }))
  return {
    label: document.fileName,
    text: pages.slice(0, 6).map(page => `第 ${page.number} 页：\n${page.text.slice(0, 850)}`).join('\n\n').slice(0, 5500),
    ...(part ? { part } : {}),
    document: { fileName: document.fileName, pages, ...(url ? { url } : {}),...(document.figures?.length?{figures:parseDatasheetFigures(document.figures,pages.map(page=>page.number))}:{}) },
  }
}

export function restoreModelTaskReference(value: unknown): ModelTaskReference | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as ModelTaskReference
  if (typeof item.label !== 'string' || typeof item.text !== 'string') return undefined
  const reference: ModelTaskReference = { label: item.label.slice(0, 180), text: item.text.slice(0, 5500), ...(typeof item.part === 'string' ? { part: item.part.slice(0, 48) } : {}) }
  const document = item.document
  if (document && typeof document.fileName === 'string' && document.fileName.length <= 180 && Array.isArray(document.pages) && document.pages.length > 0 && document.pages.length <= DATASHEET_LIMITS.pages
    && document.pages.every((page, index) => page && Number.isInteger(page.number) && page.number > 0 && (!index || page.number > document.pages[index - 1].number) && typeof page.text === 'string')
    && document.pages.reduce((total, page) => total + page.text.length, 0) <= DATASHEET_LIMITS.characters) {
    reference.document = { fileName: document.fileName, pages: document.pages.map(({ number, text }) => ({ number, text: normalizeDatasheetText(text) })), ...(typeof document.url === 'string' && document.url.length <= 1800 ? { url: document.url } : {}) }
    let figureNotice=''
    try{const figures=parseDatasheetFigures(document.figures,document.pages.map(page=>page.number));if(figures.length)reference.document.figures=figures}catch{figureNotice='\n曲线图片缓存无效，请重新添加规格书；文字仍保留。'}
    reference.text = reference.document.pages.slice(0, 6).map(page => `第 ${page.number} 页：\n${page.text.slice(0, 850)}`).join('\n\n').slice(0, 5500)+figureNotice
  }
  return reference
}
