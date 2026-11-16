import { useEffect, useId, useRef, useState } from 'react'
import { ArchiveRestore, Download, RefreshCw, X } from 'lucide-react'
import { listProjectBackups, readProjectBackup, type ProjectBackupPage } from '../core/project-backups'
import { createProjectArchive, projectFileName } from '../core/project-file'
import type { ProjectEntry } from '../core/project-store'
import { useWorkbenchDialog } from './AssistantWindow'

interface Props {
  canRestore: boolean
  onClose: () => void
  onRestore: (snapshot: ProjectEntry) => void | Promise<void>
}

const formatDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const backupDate = (value: number) => value >= 0 && value <= 8.64e15 ? formatDate.format(value) : '时间未知'
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'

function exportBackup({ project }: ProjectEntry) {
  const archive = createProjectArchive(project)
  const url = URL.createObjectURL(new Blob([new Uint8Array(archive)], { type: 'application/zip' }))
  const link = document.createElement('a')
  link.href = url
  link.download = projectFileName({ title: `${project.title}（备份）` })
  try { link.click() } finally { setTimeout(() => URL.revokeObjectURL(url), 1000) }
}

export default function ProjectBackupPicker({ canRestore, onClose, onRestore }: Props) {
  const panel = useRef<HTMLElement>(null)
  const heading = useId(), help = useId()
  const request = useRef<AbortController | null>(null)
  const [page, setPage] = useState<ProjectBackupPage>()
  const [offset, setOffset] = useState(0)
  const [history, setHistory] = useState<number[]>([])
  const [reload, setReload] = useState(0)
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState<'restore' | 'export' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const selected = page?.backups.find(row => row.id === selectedId) ?? page?.backups[0]
  const close = () => { if (!request.current) onClose() }
  useWorkbenchDialog(panel, true, close)

  useEffect(() => {
    const controller = new AbortController()
    void listProjectBackups(offset, controller.signal).then(value => {
      if (!controller.signal.aborted) setPage(value)
    }, cause => {
      if (!controller.signal.aborted) setError(errorMessage(cause))
    })
    return () => controller.abort()
  }, [offset, reload])
  useEffect(() => () => request.current?.abort(), [])

  function changePage(nextOffset: number, nextHistory: number[]) {
    setPage(undefined); setError(''); setNotice(''); setSelectedId('')
    setOffset(nextOffset); setHistory(nextHistory)
  }

  async function apply(action: 'restore' | 'export') {
    if (!selected || request.current || (action === 'restore' && !canRestore)) return
    const controller = new AbortController()
    request.current = controller
    setBusy(action); setError(''); setNotice('')
    let restored = false
    try {
      const snapshot = await readProjectBackup(selected, controller.signal)
      if (controller.signal.aborted) return
      if (action === 'restore') {
        await onRestore(snapshot)
        restored = true
      } else {
        exportBackup(snapshot)
        setNotice('已发起工程文件下载。')
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause))
    } finally {
      request.current = null
      if (!controller.signal.aborted) setBusy(null)
    }
    if (restored && !controller.signal.aborted) onClose()
  }

  return <div className="workbench-window-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <section ref={panel} className="workbench-window project-backup-window" role="dialog" aria-modal="true" aria-labelledby={heading} aria-describedby={help} tabIndex={-1}>
      <header className="project-backup-heading">
        <ArchiveRestore size={22} aria-hidden="true"/>
        <div><h2 id={heading}>从备份恢复</h2><p id={help}>这里保留每个工程上一次被替换或删除前的版本。</p></div>
        <button type="button" aria-label="关闭备份恢复" disabled={!!busy} onClick={close}><X size={17}/></button>
      </header>
      <div className="project-backup-content" aria-busy={!page && !error}>
        <div className="project-backup-tools">
          <strong>本机工程备份</strong>
          <button type="button" onClick={() => { changePage(0, []); setReload(value => value + 1) }} disabled={!!busy || (!page && !error)}><RefreshCw size={14}/>刷新</button>
        </div>
        {!page && !error && <p role="status">正在读取备份…</p>}
        {page && !page.backups.length && <p>{offset ? '这一页没有备份，请返回上一页或刷新列表。' : '暂无备份。工程修改或删除后，可在这里查看上一份保存版本。'}</p>}
        {page && selected && <label className="project-backup-select">选择要恢复或导出的版本
          <select value={selected.id} disabled={!!busy} onChange={event => { setSelectedId(event.target.value); setError(''); setNotice('') }}>
            {page.backups.map(row => <option key={row.id} value={row.id}>{row.title} · {backupDate(row.updatedAt)}</option>)}
          </select>
        </label>}
        {(history.length > 0 || page?.more) && <nav className="project-backup-tools" aria-label="备份分页">
          <button type="button" disabled={!!busy || !history.length} onClick={() => changePage(history.at(-1) ?? 0, history.slice(0, -1))}>上一页</button>
          <span>第 {history.length + 1} 页</span>
          <button type="button" disabled={!!busy || !page?.more} onClick={() => { if (page) changePage(offset + page.backups.length, [...history, offset]) }}>下一页</button>
        </nav>}
        {error && <p className="project-backup-error" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </div>
      <footer className="project-backup-footer">
        <p>{canRestore ? '恢复会创建新工程，保留原工程与它的对话。' : '工程库暂不能写入；可先导出备份文件，修复后再打开。'}</p>
        <button type="button" disabled={!selected || !!busy} onClick={() => void apply('export')}><Download size={15}/>{busy === 'export' ? '正在导出…' : '导出工程文件'}</button>
        {canRestore && <button type="button" className="project-backup-primary" disabled={!selected || !!busy} onClick={() => void apply('restore')}>{busy === 'restore' ? '正在恢复…' : '恢复为副本'}</button>}
      </footer>
    </section>
  </div>
}
