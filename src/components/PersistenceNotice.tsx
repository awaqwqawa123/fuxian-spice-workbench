import { AlertTriangle, Download, RotateCcw } from 'lucide-react'

export default function PersistenceNotice({ messages, onRetry, onBackup }: {
  messages: string[]; onRetry?: () => void; onBackup: () => void
}) {
  if (!messages.length) return null
  return <div className="workspace-persistence-notice" role="alert" aria-label="保存失败提示">
    <AlertTriangle size={17} aria-hidden="true" />
    <div><strong>部分修改尚未保存</strong><p>{messages.join('；')}</p></div>
    <div className="persistence-actions">
      {onRetry && <button type="button" onClick={onRetry}><RotateCcw size={14} />重试保存</button>}
      <button type="button" onClick={onBackup}><Download size={14} />导出工程备份</button>
    </div>
  </div>
}
