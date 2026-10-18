/** Browser file reader; text/PDF parsing is shared with the local model assistant. */
export * from './datasheet-pdf-text'
import { DATASHEET_LIMITS, extractDatasheetPdf, type DatasheetText } from './datasheet-pdf-text'
import { datasheetEncodingNotices, normalizeDatasheetText } from './datasheet-encoding'

export async function readDatasheetFile(file: File, progress?: (page: number, total: number) => void,options:{requirements?:string;curvePages?:number[]}={}): Promise<DatasheetText> {
  if (file.size > DATASHEET_LIMITS.fileBytes) throw new Error('规格书最大支持 12 MB，请拆分文件后重试。')
  if (/\.pdf$/i.test(file.name)) {
    const data = new Uint8Array(await file.arrayBuffer())
    if (!new TextDecoder().decode(data.subarray(0, 5)).startsWith('%PDF-')) throw new Error('文件不是有效的 PDF。请下载规格书原文件，不要使用网页或验证页面。')
    const { browserPdfLoader } = await import('./datasheet-pdf-browser')
    const document=await extractDatasheetPdf(data.slice(), file.name, browserPdfLoader, progress)
    try{
      const {renderBrowserDatasheetFigures}=await import('./datasheet-curve-images')
      const figures=await renderBrowserDatasheetFigures(data,document.pages,options)
      if(figures.length)return {...document,figures,notices:[`附加 ${figures.length} 张原始曲线页供助手读取；读图拟合仍须核对坐标、条件与适用范围。`,...document.notices.filter(notice=>!notice.includes('图表曲线'))]}
    }catch(error){document.notices.push(`曲线页绘制失败：${(error as Error).message}；文字仍保留。`)}
    return document
  }
  if (!/\.txt$/i.test(file.name)) throw new Error('请选择 PDF 或 UTF-8 TXT 规格书。')
  const text = normalizeDatasheetText(await file.text())
  if (text.length > DATASHEET_LIMITS.characters) throw new Error('规格书文本过长，请截取电气参数相关页。')
  if (text.replace(/\uFFFD/g, '').trim().length < 25) throw new Error('可识别文本太少，请包含参数值、单位和测试条件。')
  const pages = [{ number: 1, text }]
  return { fileName: file.name, pages, notices: ['TXT 按第 1 页显示；请核对原规格书页码。', ...datasheetEncodingNotices(pages)] }
}
