import { useMemo, useRef } from 'react'
import { AlertTriangle, ArrowRight, CircuitBoard, FileInput, FileText, FolderOpen, X } from 'lucide-react'
import type { Project } from '../core/circuit'
import { schematicSvg } from '../core/export-svg'
import { simulationNames } from '../core/simulation-profiles'
import { useWorkbenchDialog } from './AssistantWindow'

export interface SimulationImportPreview { project: Project; warnings: string[]; format: string }
interface Props {
  entries: { path: string; format: 'asc' | 'spice' }[]
  selectedPath: string
  fileNames: string[]
  preview: SimulationImportPreview | null
  error: string
  createsProject: boolean
  onSelect: (path: string) => void
  onChooseFiles: () => void
  onApply: () => void
  onCancel: () => void
}

export default function SimulationImportDialog({ entries, selectedPath, fileNames, preview, error, createsProject, onSelect, onChooseFiles, onApply, onCancel }: Props) {
  const panel = useRef<HTMLElement>(null)
  useWorkbenchDialog(panel, true, onCancel)
  const project = preview?.project
  const image = useMemo(() => {
    if (!project?.drawing) return ''
    try { return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(schematicSvg(project.drawing, { title: project.title, models: project.models, probes: project.probes }))}` }
    catch { return '' }
  }, [project])
  const profiles = project?.waveformSetup?.profiles.profiles
  return <div className="workbench-window-backdrop simulation-import-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }}>
    <section ref={panel} role="dialog" aria-modal="true" aria-labelledby="simulation-import-title" className="workbench-window simulation-import-window" tabIndex={-1}>
      <header className="simulation-import-heading"><div className="simulation-import-emblem"><FileInput size={22}/></div><div><h2 id="simulation-import-title">导入 LTspice / PSpice</h2><p>读取电路、模型与仿真设置，预览后打开。</p></div><button type="button" className="simulation-import-close" aria-label="取消仿真文件导入" onClick={onCancel}><X size={18}/></button></header>
      <div className="simulation-import-content">
        <div className="simulation-import-source"><label>入口文件<select aria-label="选择仿真入口文件" value={selectedPath} onChange={event => onSelect(event.target.value)}>{entries.map(entry => <option key={entry.path} value={entry.path}>{entry.path} · {entry.format === 'asc' ? 'LTspice 原理图' : 'SPICE 网表'}</option>)}</select></label><button type="button" onClick={onChooseFiles}><FolderOpen size={15}/>重新选择文件</button></div>
        <div className="simulation-import-layout">
          <div className="simulation-import-graphic" aria-label="导入原理图预览">{image ? <img src={image} alt={`${project!.title} 导入原理图预览`}/> : <div><CircuitBoard size={36}/><strong>{error ? '需要处理导入问题' : '等待可预览的电路'}</strong><p>补齐依赖或选择其他入口文件后可重新预览。</p></div>}</div>
          <div className="simulation-import-summary">
            {project && <><span className="simulation-import-format">{preview!.format}</span><h3>{project.title}</h3><dl><div><dt>器件</dt><dd>{project.drawing?.devices.filter(device=>device.kind!=='GND').length ?? 0}</dd></div><div><dt>导线</dt><dd>{project.drawing?.wires.length ?? 0}</dd></div><div><dt>嵌入模型</dt><dd>{project.models?.length ?? 0}</dd></div><div><dt>仿真配置</dt><dd>{profiles?.length ?? 1}</dd></div></dl><div className="simulation-import-analyses"><strong>仿真设置</strong>{profiles?.length ? profiles.map(profile => <span key={profile.id}>{profile.name} · {simulationNames[profile.settings.analysis]}</span>) : <span>{simulationNames[project.analysis]}</span>}</div></>}
            <details className="simulation-import-files"><summary><FileText size={14}/>所选文件 · {fileNames.length}</summary><ul>{fileNames.map((name,index)=><li key={`${index}:${name}`}>{name}</li>)}</ul></details>
            <p className="simulation-import-hint">依赖模型和符号请与电路一起选择，或放入同一个 ZIP。只读取本次选择的文件。</p>
          </div>
        </div>
        {error && <div className="simulation-import-error" role="alert"><AlertTriangle size={17}/><div><strong>导入未完成</strong><p>{error}</p></div></div>}
        {!!preview?.warnings.length && <details className="simulation-import-warnings" open><summary><AlertTriangle size={15}/>兼容提示 · {preview.warnings.length}</summary><ul>{preview.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></details>}
      </div>
      <footer className="simulation-import-footer"><p>{createsProject ? '打开为独立项目，保留当前工程。' : '应用后可用 Ctrl+Z 恢复当前工程。'}导入后运行仿真检查结果。</p><button type="button" onClick={onCancel}>取消</button><button type="button" className="simulation-import-apply" disabled={!preview || !!error} onClick={onApply}>{createsProject ? '打开为新项目' : '应用导入'}<ArrowRight size={15}/></button></footer>
    </section>
  </div>
}
