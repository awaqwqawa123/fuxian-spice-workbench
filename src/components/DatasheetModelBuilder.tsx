import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, FileText, FileUp, LoaderCircle } from 'lucide-react'
import { readDatasheetFile, type DatasheetText } from '../core/datasheet-text'
import { modelTaskReference } from '../core/model-task-reference'
import { uniqueModelPart, type ModelTaskReference } from '../core/model-tasks'
import { identifyDatasheetParts } from '../core/datasheet-part-identification'
import type { ImportedModelKind, ImportedSpiceModel } from '../core/spice-models'
import type { DatasheetDownload } from '../core/datasheet-search'

export interface DatasheetReadStatus { stage: 'reading' | 'completed' | 'failed'; fileName: string; retainedFileName?: string; unsupportedReason?: string }
interface Props { models: ImportedSpiceModel[]; selectedKind?: ImportedModelKind; name: string; onName: (value: string) => void; onImport: (model: ImportedSpiceModel) => void; downloaded?: DatasheetDownload; droppedFile?: { file: File; requestId: number }; autoDraft?: boolean; onReadStatus?: (status: DatasheetReadStatus) => void; onUseAssistant?: (part: string, reference?: ModelTaskReference) => void }

/** Documents feed the single model-generation task. Reading a file never builds or imports a model. */
export default function DatasheetModelBuilder({ name, onName, downloaded, droppedFile, onReadStatus, onUseAssistant }: Props) {
  const [document, setDocument] = useState<DatasheetText>(), [url, setUrl] = useState('')
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null), readVersion = useRef(0)
  useEffect(() => () => { readVersion.current++ }, [])
  useEffect(() => {
    if (!downloaded) return
    const bytes = Uint8Array.from(atob(downloaded.bytesBase64), character => character.charCodeAt(0))
    void read(new File([bytes], downloaded.fileName, { type: /\.pdf$/i.test(downloaded.fileName) ? 'application/pdf' : 'text/plain' }), downloaded.url)
  }, [downloaded?.id])
  useEffect(() => { if (droppedFile) void read(droppedFile.file) }, [droppedFile?.requestId])

  function attach(result: DatasheetText, sourceUrl: string, part = uniqueModelPart(name) ?? identifyDatasheetParts(result).part) {
    onUseAssistant?.(part || '待定器件', modelTaskReference(result, part, sourceUrl))
  }
  async function read(file: File, sourceUrl = '') {
    const version = ++readVersion.current
    setError(''); setBusy('正在读取规格书…')
    onReadStatus?.({ stage: 'reading', fileName: file.name })
    try {
      const result = await readDatasheetFile(file, (page, total) => { if (version === readVersion.current) setBusy(`正在读取第 ${page} / ${total} 页…`) })
      if (version !== readVersion.current) return
      setDocument(result); setUrl(sourceUrl)
      // Model identity comes from original page evidence, never from the filename.
      const part = uniqueModelPart(name) ?? identifyDatasheetParts(result).part
      if (!name.trim() && part) onName(part)
      onReadStatus?.({ stage: 'completed', fileName: result.fileName })
      attach(result, sourceUrl, part)
    } catch (failure) {
      if (version === readVersion.current) {
        setError(`「${file.name}」解析失败：${(failure as Error).message} ${document ? `仍显示「${document.fileName}」，未采用新文件。` : '请选择包含可复制文字的 PDF 或 TXT。'}`)
        onReadStatus?.({ stage: 'failed', fileName: file.name, retainedFileName: document?.fileName })
      }
    } finally { if (version === readVersion.current) setBusy('') }
  }

  return <section className="datasheet-builder" aria-label="添加建模规格书">
    <div className={`datasheet-dropzone${dragging ? ' dragging' : ''}`} onDragOver={event => { event.preventDefault(); event.stopPropagation(); setDragging(true) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }} onDrop={event => {
      event.preventDefault(); event.stopPropagation(); setDragging(false)
      if (event.dataTransfer.files.length !== 1) { setError('每次请选择一份规格书。'); return }
      void read(event.dataTransfer.files[0])
    }}>
      <FileUp size={25}/><strong>拖入规格书，作为建模依据</strong>
      <p>PDF / TXT · 最大 12 MB、60 页</p>
      <input ref={fileInput} type="file" accept=".pdf,.txt,application/pdf,text/plain" aria-label="选择规格书文件" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void read(file) }}/>
      <button type="button" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>{document ? '替换规格书' : '选择规格书'}</button>
    </div>
    {busy && <p role="status"><LoaderCircle size={15} className="step-loading-icon"/>{busy}</p>}
    {document && <>
      <div className="datasheet-file"><FileText size={16}/><strong>{document.fileName}</strong><span>{document.pages.length} 页</span></div>
      <p className="model-search-help">资料已读取。助手会结合方案工作区选择厂商参考模型；缺少典型值时可读取曲线页拟合，生成后自动保存到自建库。</p>
      {!!document.figures?.length&&<details className="datasheet-source"><summary>原始曲线页 · {document.figures.length} 张</summary>{document.figures.map(figure=><figure key={figure.page}><img alt={`规格书第 ${figure.page} 页原始曲线`} src={`data:${figure.mimeType};base64,${figure.dataBase64}`} style={{maxWidth:'100%',height:'auto'}}/><figcaption>第 {figure.page} 页 · 原图像素 {figure.width} × {figure.height}</figcaption></figure>)}</details>}
      {onUseAssistant && <button type="button" className="datasheet-assistant-continue" disabled={Boolean(busy)} onClick={() => attach(document, url)}><ArrowUpRight size={15}/>用于生成模型</button>}
      <details className="datasheet-source"><summary>查看规格书文字 · {document.pages.length} 页</summary>{document.notices.map((notice, index) => <p key={index}>{notice}</p>)}{document.pages.map(page => <section key={page.number}><strong>第 {page.number} 页</strong><pre>{page.text}</pre></section>)}</details>
    </>}
    {error && <p role="alert" className="model-search-error">{error}</p>}
  </section>
}
