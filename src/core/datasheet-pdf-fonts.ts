/** Bundled fallback fonts keep original PDF labels visible without remote requests. */
const fontUrls = import.meta.glob<string>('../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', {
  eager: true, query: '?url', import: 'default',
})
export class DatasheetStandardFontFactory {
  async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
    const url = Object.entries(fontUrls).find(([path]) => path.endsWith('/' + filename))?.[1]
    if (!url) throw new Error('规格书字体不在本地资源中：' + filename)
    const response = await fetch(url)
    if (!response.ok) throw new Error('规格书本地字体读取失败：' + filename)
    return new Uint8Array(await response.arrayBuffer())
  }
}
