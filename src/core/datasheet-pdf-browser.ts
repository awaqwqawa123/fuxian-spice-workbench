import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { DatasheetStandardFontFactory } from './datasheet-pdf-fonts'
import type { PdfLoader } from './datasheet-text'

GlobalWorkerOptions.workerSrc = workerUrl
export const browserPdfLoader: PdfLoader = { getDocument: options => getDocument({ ...options, StandardFontDataFactory: DatasheetStandardFontFactory, useWorkerFetch: false }) }
