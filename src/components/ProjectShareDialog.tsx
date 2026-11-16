import { useId, useRef } from 'react'
import { AlertTriangle, CircleCheck, Download, FolderOpen, PackageCheck, X } from 'lucide-react'
import type { ProjectShareReview } from '../core/project-share'
import { useWorkbenchDialog } from './AssistantWindow'

const labels = {
  ready: ['静态检查通过', '已核对模型依赖、端序和仿真配置。收件人打开后需重新运行仿真。'],
  draft: ['可下载为草稿', '工程本身可打开。请先解决下列问题，再与收件人确认仿真结果。'],
  blocked: ['暂时无法导出', '请先处理下列依赖或文件格式问题，确保导出的工程可以重新打开。'],
} as const
const modelLabels = {embedded:'随工程打包','built-in':'由伏线提供',missing:'缺少模型'} as const
interface Props {
  review: ProjectShareReview
  error?: string
  onClose: () => void
  onDownload: () => void
  onOpenLibrary: () => void
  onImportDependencies: () => void
}

export default function ProjectShareDialog({ review, error, onClose, onDownload, onOpenLibrary, onImportDependencies }: Props) {
  const panel = useRef<HTMLElement>(null), heading = useId()
  useWorkbenchDialog(panel,true,onClose)
  const [status, summary] = labels[review.status], StatusIcon = review.status === 'ready' ? CircleCheck : AlertTriangle
  const embeddedCount = review.models.filter(model => model.mode==='embedded').length
  return <div className="workbench-window-backdrop project-share-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
    <section ref={panel} className="workbench-window project-share-window" role="dialog" aria-modal="true" aria-labelledby={heading} tabIndex={-1}>
      <header className="project-share-heading">
        <span className="project-share-emblem"><PackageCheck size={22}/></span>
        <div><h2 id={heading}>分享工程文件</h2><p>{review.project.title || '未命名工程'}</p></div>
        <button type="button" aria-label="关闭分享检查" onClick={onClose}><X size={18}/></button>
      </header>
      <div className="project-share-body">
        <div className="project-share-status" data-status={review.status}>
          <StatusIcon size={19}/><div><strong>{status}</strong><p>{summary}</p></div>
        </div>
        {review.issues.length>0&&<section className="project-share-section">
          <h3>需要处理 <small>{review.issues.length}</small></h3>
          <ul className="project-share-issues">{review.issues.map((issue,index)=><li key={index}><strong>{issue.subject}</strong><span>{issue.detail}</span></li>)}</ul>
          {(review.issues.some(issue=>issue.kind==='external-library'||issue.kind==='model-definition'))&&<button className="project-share-secondary" type="button" onClick={onImportDependencies}><FolderOpen size={15}/>选择源电路与依赖文件</button>}
          {(review.issues.some(issue=>issue.kind==='missing-model'))&&<button className="project-share-secondary" type="button" onClick={onOpenLibrary}><FolderOpen size={15}/>打开 SPICE 模型库</button>}
        </section>}
        <section className="project-share-section">
          <h3>模型与符号 <small>{embeddedCount} 个随工程打包</small></h3>
          {review.models.length>0?<ul className="project-share-models">{review.models.map(model=><li key={JSON.stringify([model.id,model.devices])}>
            <div className="project-share-model-title"><strong>{model.id}</strong><span data-mode={model.mode}>{modelLabels[model.mode]}</span></div>
            <p>器件 {model.devices.join('、')} · {model.symbol}{model.ports.length>0&&<> · 端序 {model.ports.join(' → ')}</>}</p>
            {model.subcircuits.length>0&&<p>内含子电路：{model.subcircuits.join('、')}</p>}
            {model.source&&<p>来源：{model.source.label} · 许可：{model.source.license || '未注明，分享前请核对'}{model.source.attribution&&<> · 署名：{model.source.attribution}</>}</p>}
            {model.source?.url&&<p className="project-share-source">来源地址：{model.source.url}</p>}
          </li>)}</ul>:<p>此电路没有需要单独打包的 SPICE 模型。</p>}
          {review.unusedModels>0&&<p>{review.unusedModels} 个未被此电路使用的模型留在本机工程中。</p>}
        </section>
        <section className="project-share-section">
          <h3>仿真与波形 <small>{review.waveformCount} 个波形图</small></h3>
          <ul className="project-share-profiles">{review.profiles.map((profile,index)=><li key={index}><strong>{profile.name}</strong><span>{profile.analysis}{profile.active?' · 当前配置':''}</span></li>)}</ul>
          <p>工程包含原理图、探针和波形图配置；历史采样和会话不会打包。</p>
        </section>
        {error&&<p className="project-share-error" role="alert">{error}</p>}
      </div>
      <footer className="project-share-footer">
        {review.status!=='blocked'&&<span title={review.filename}>{review.filename}</span>}
        <button type="button" onClick={onClose}>{review.status==='blocked'?'返回工程':'取消'}</button>
        {review.status!=='blocked'&&<button type="button" className="project-share-download" onClick={onDownload}><Download size={16}/>{review.status==='draft'?'下载草稿':'下载 .fuxian'}</button>}
      </footer>
    </section>
  </div>
}
