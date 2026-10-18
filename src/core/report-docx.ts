import { strToU8, zipSync } from 'fflate'

export type ReportBlock =
  | { kind: 'heading'; text: string; level: 1 | 2 | 3 }
  | { kind: 'paragraph'; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'image'; svg: string; title: string; png?: Uint8Array }

const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const relationNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const packageRelationNs = 'http://schemas.openxmlformats.org/package/2006/relationships'
const xml = (text: string): string => text
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
  .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)

function textRuns(text: string): string {
  return text.replace(/\r\n?/g, '\n').split(/([\n\t])/).map(piece => piece === '\n'
    ? '<w:r><w:br/></w:r>' : piece === '\t' ? '<w:r><w:tab/></w:r>'
      : `<w:r><w:t xml:space="preserve">${xml(piece)}</w:t></w:r>`).join('')
}

function paragraph(text: string, style = 'Normal', bookmark?:number): string {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${bookmark!==undefined?`<w:bookmarkStart w:id="${bookmark}" w:name="ReportSection${bookmark}"/>`:''}${textRuns(text)}${bookmark!==undefined?`<w:bookmarkEnd w:id="${bookmark}"/>`:''}</w:p>`
}

function table(block: Extract<ReportBlock, { kind: 'table' }>): string {
  // Retain extra cells even when a caller supplied fewer headings than data columns.
  const columns = Math.max(1, block.headers.length, ...block.rows.map(row => row.length))
  const width = Math.floor(9638 / columns)
  const cell = (value: string, heading: boolean) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${heading ? '<w:shd w:fill="EDF4EF"/>' : ''}</w:tcPr>${paragraph(value, heading ? 'TableHeader' : 'TableText')}</w:tc>`
  const row = (values: string[], heading: boolean) => `<w:tr>${heading ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: columns }, (_, i) => cell(values[i] ?? '', heading)).join('')}</w:tr>`
  return `<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(edge => `<w:${edge} w:val="single" w:sz="4" w:color="D7E1DA"/>`).join('')}</w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${block.headers.length ? row(block.headers, true) : ''}${block.rows.map(values => row(values, false)).join('')}</w:tbl>${paragraph('')}`
}

function imageSize(svg: string): { cx: number; cy: number } {
  const svgTag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? ''
  const viewBox = svgTag.match(/\bviewBox\s*=\s*["']\s*([-+\d.e]+)[ ,]+([-+\d.e]+)[ ,]+([-+\d.e]+)[ ,]+([-+\d.e]+)\s*["']/i)
  const attr = (name: string) => Number(svgTag.match(new RegExp(`\\b${name}\\s*=\\s*["']([\\d.]+)(?:px)?["']`, 'i'))?.[1])
  const width = viewBox ? Number(viewBox[3]) : attr('width')
  const height = viewBox ? Number(viewBox[4]) : attr('height')
  const ratio = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? height / width : .6
  const cx = Math.round(Math.min(5943600, 6400800 / ratio))
  return { cx, cy: Math.round(cx * ratio) }
}

const styles = `${declaration}<w:styles xmlns:w="${wordNs}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/><w:widowControl/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="300"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val="285A40"/><w:sz w:val="40"/></w:rPr></w:style>${[1, 2, 3].map(level => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${level === 1 ? 300 : 200}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="285A40"/><w:sz w:val="${[30, 25, 22][level - 1]}"/></w:rPr></w:style>`).join('')}<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Header"/><w:basedOn w:val="TableText"/><w:rPr><w:b/><w:color w:val="285A40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="61746A"/><w:sz w:val="18"/></w:rPr></w:style></w:styles>`

/** A genuine OOXML package. Text and tables remain editable; PNGs provide broad image compatibility. */
export function reportDocx(input: { title: string; blocks: ReportBlock[]; toc?:boolean }): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  const put = (path: string, contents: string) => { files[path] = strToU8(contents) }
  const relations = [
    `<Relationship Id="rIdStyles" Type="${relationNs}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdFooter" Type="${relationNs}/footer" Target="footer1.xml"/>`,
    `<Relationship Id="rIdSettings" Type="${relationNs}/settings" Target="settings.xml"/>`,
  ]
  const sectionHeadings=input.blocks.flatMap((block,index)=>block.kind==='heading'&&block.level===2?[{text:block.text,id:index}]:[])
  let tocAdded=false
  const toc=()=>paragraph('目录','Title')+paragraph('目录页码由 Word / WPS 更新域后填入；正文页码自动生成。')+'<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-1" \\h \\z </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>'+sectionHeadings.map(item=>`<w:p><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9638"/></w:tabs></w:pPr><w:hyperlink w:anchor="ReportSection${item.id}">${textRuns(item.text)}</w:hyperlink><w:r><w:tab/></w:r><w:fldSimple w:instr="PAGEREF ReportSection${item.id} \\h"><w:r><w:t>更新目录</w:t></w:r></w:fldSimple></w:p>`).join('')+'<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p>'
  let imageIndex = 0
  let needsSvgReader = false
  const body = input.blocks.map((block,index) => {
    if (block.kind === 'heading') {
      const insert=input.toc&&block.level===2&&!tocAdded?'<w:p><w:r><w:br w:type="page"/></w:r></w:p>'+toc():''
      if(insert)tocAdded=true
      // Report level 1 is its cover title, while level 2 starts an actual chapter.
      const style=input.toc?(block.level===1?'Title':`Heading${block.level-1}`):`Heading${block.level}`
      return insert+paragraph(block.text,style,index)
    }
    if (block.kind === 'paragraph') return paragraph(block.text,/^表 \d+ ·/.test(block.text)?'Caption':'Normal')
    if (block.kind === 'table') return table(block)
    const id = ++imageIndex
    if (!/<svg\b/i.test(block.svg)) throw new Error(`报告图片“${block.title}”缺少 SVG 内容`)
    put(`word/media/image${id}.svg`, block.svg)
    const svgId = `rIdImage${id}Svg`
    relations.push(`<Relationship Id="${svgId}" Type="${relationNs}/image" Target="media/image${id}.svg"/>`)
    let primaryId = svgId
    let extension = ''
    if (block.png?.length) {
      const signature = [137, 80, 78, 71, 13, 10, 26, 10]
      if (!signature.every((byte, i) => block.png![i] === byte)) throw new Error(`报告图片“${block.title}”的 PNG 数据无效`)
      files[`word/media/image${id}.png`] = block.png
      primaryId = `rIdImage${id}Png`
      relations.push(`<Relationship Id="${primaryId}" Type="${relationNs}/image" Target="media/image${id}.png"/>`)
      extension = `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${svgId}"/></a:ext></a:extLst>`
    } else needsSvgReader = true
    const { cx, cy } = imageSize(block.svg)
    const title = xml(block.title)
    return `<w:p><w:pPr><w:jc w:val="center"/><w:keepNext/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Figure ${id}" descr="${title}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${title}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${primaryId}">${extension}</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>${paragraph(block.title, 'Caption')}`
  }).join('')
  const readerNote = needsSvgReader ? paragraph('图片以 SVG 矢量格式嵌入；请使用支持 SVG 的新版 Word 阅读，或从软件导出 HTML / PDF 查看完整图片。') : ''
  put('word/document.xml', `${declaration}<w:document xmlns:w="${wordNs}" xmlns:r="${relationNs}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${input.toc?'':paragraph(input.title, 'Title')}${readerNote}${body}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`)
  put('word/styles.xml', styles)
  put('word/footer1.xml', `${declaration}<w:ftr xmlns:w="${wordNs}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${textRuns('第 ')}<w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple>${textRuns(' 页 / 共 ')}<w:fldSimple w:instr="NUMPAGES"><w:r><w:t>1</w:t></w:r></w:fldSimple>${textRuns(' 页')}</w:p></w:ftr>`)
  put('word/settings.xml', `${declaration}<w:settings xmlns:w="${wordNs}"><w:updateFields w:val="true"/></w:settings>`)
  put('word/_rels/document.xml.rels', `${declaration}<Relationships xmlns="${packageRelationNs}">${relations.join('')}</Relationships>`)
  put('_rels/.rels', `${declaration}<Relationships xmlns="${packageRelationNs}"><Relationship Id="rIdDocument" Type="${relationNs}/officeDocument" Target="word/document.xml"/><Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rIdApp" Type="${relationNs}/extended-properties" Target="docProps/app.xml"/></Relationships>`)
  put('docProps/core.xml', `${declaration}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(input.title)}</dc:title><dc:creator>伏线 · SPICE Workbench</dc:creator><dc:description>基于实际仿真结果生成的电路设计与测试报告</dc:description></cp:coreProperties>`)
  put('docProps/app.xml', `${declaration}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>伏线 · SPICE Workbench</Application></Properties>`)
  put('[Content_Types].xml', `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="png" ContentType="image/png"/>${[['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'], ['/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'], ['/word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'], ['/word/footer1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml'], ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'], ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml']].map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('')}</Types>`)
  return zipSync(files, { level: 6 })
}
