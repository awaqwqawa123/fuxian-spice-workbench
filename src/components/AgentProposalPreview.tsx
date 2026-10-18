import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Expand, Minus, Plus, Scan, X } from 'lucide-react'
import { dcSweep, type Project } from '../core/circuit'
import { editableSource, sourceDescription } from '../core/sources'
import { editableProject } from '../core/editor'
import { schematicSvg } from '../core/export-svg'
import { useWorkbenchDialog } from './AssistantWindow'
import WaveformSetupPreview, { type WaveformPreviewProject } from './WaveformSetupPreview'

export interface AgentProposalPreviewProps { project: WaveformPreviewProject; baseline?: WaveformPreviewProject; proposalLabel?: string; baselineLabel?: string }

/** The SVG is produced exclusively by our escaped React exporter and displayed as an isolated image. */
function previewImage(project: Project) {
  const drawing = project.drawing ?? editableProject(project).drawing
  if (!drawing) return null
  const part = drawing.devices.find(device => device.id === drawing.sourceId && device.kind === 'V')
  const source = part ? editableSource(part, { ...project, drawing }) : null
  const sourceSummary = !source ? undefined : project.analysis === 'op' ? `DC ${source.value}` : project.analysis === 'dc' ? `DC 扫描 ${dcSweep(project).start} → ${dcSweep(project).stop}` : project.analysis === 'ac' || project.analysis === 'noise' ? `DC ${source.value} · AC ${source.params?.acAmplitude ?? '0'} · ${source.params?.acPhase ?? '0'}°` : sourceDescription(source)
  const svg = schematicSvg(drawing, { title: project.title, sourceSummary, models: project.models, probes: project.probes })
  const width = Number(svg.match(/<svg[^>]*\swidth="([\d.]+)"/)?.[1]) || 800
  const height = Number(svg.match(/<svg[^>]*\sheight="([\d.]+)"/)?.[1]) || 480
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width, height, devices: drawing.devices.filter(device => device.kind !== 'GND').length, wires: drawing.wires.length }
}

export default function AgentProposalPreview({ project, baseline, proposalLabel = '候选原理图', baselineLabel = '任务开始时的原理图' }: AgentProposalPreviewProps) {
  const [expanded, setExpanded] = useState(false), [comparison, setComparison] = useState(false), [zoom, setZoom] = useState<number | null>(null)
  const panel = useRef<HTMLElement>(null)
  useWorkbenchDialog(panel, expanded, () => setExpanded(false))
  const proposal = useMemo(() => { try { return { image: previewImage(project), error: '' } } catch (error) { return { image: null, error: (error as Error).message } } }, [project])
  const original = useMemo(() => { try { return baseline ? previewImage(baseline) : null } catch { return null } }, [baseline])
  const image = comparison && original ? original : proposal.image
  const selectedProject = comparison && original && baseline ? baseline : project
  const label = comparison && original ? baselineLabel : proposalLabel
  if (!proposal.image) return <><p className="agent-proposal-image-error" role="status">原理图预览暂不可用{proposal.error ? `：${proposal.error}` : ''}。候选参数仍可在下方审阅。</p><WaveformSetupPreview project={project}/></>
  function magnify(direction: 1 | -1) {
    const area = panel.current?.querySelector('.agent-proposal-viewport')
    const fit = area && image ? Math.min((area.clientWidth - 36) / image.width, (area.clientHeight - 36) / image.height) : 1
    setZoom(Math.max(.2, Math.min(4, (zoom ?? fit) + direction * .25)))
  }
  const aspect = `${proposal.image.width} / ${proposal.image.height}`
  const thumbnailStyle = { '--proposal-aspect': aspect } as CSSProperties
  return <section className="agent-proposal-preview" aria-label="候选原理图预览">
    <header><div className="agent-proposal-heading"><strong>{proposalLabel}</strong><span className="agent-proposal-readonly">只读</span></div><span className="agent-proposal-stats"><b>{proposal.image.devices}</b> 个器件 <i aria-hidden="true">·</i> <b>{proposal.image.wires}</b> 段导线</span></header>
    <button className="agent-proposal-thumbnail" style={thumbnailStyle} type="button" aria-label="放大预览候选原理图" onClick={() => setExpanded(true)}><img src={proposal.image.src} alt={`${project.title}的${proposalLabel}`}/><span><Expand size={13}/>放大预览</span></button>
    <small>只读预览 · 应用前可检查器件与接线</small>
    <WaveformSetupPreview project={project}/>
    {expanded && createPortal(<div className="workbench-window-backdrop agent-proposal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setExpanded(false) }}>
      <section ref={panel} className="workbench-window agent-proposal-window" role="dialog" aria-modal="true" aria-label="候选原理图放大预览" tabIndex={-1}>
        <header className="agent-proposal-window-heading"><div><span>SCHEMATIC REVIEW</span><h2>{label}</h2><p>{comparison && baseline ? baseline.title : project.title}</p></div><button type="button" aria-label="关闭原理图预览" onClick={() => setExpanded(false)}><X size={20}/></button></header>
        <div className="agent-proposal-preview-tools"><div className="agent-proposal-compare" aria-label="预览版本"><button type="button" aria-pressed={!comparison} onClick={() => { setComparison(false); setZoom(null) }}>{proposalLabel === '候选原理图' ? '候选方案' : proposalLabel}</button>{original && <button type="button" aria-pressed={comparison} onClick={() => { setComparison(true); setZoom(null) }}>{baselineLabel === '任务开始时的原理图' ? '任务开始时' : baselineLabel}</button>}</div><div className="agent-proposal-zoom"><button type="button" aria-label="缩小原理图预览" disabled={zoom !== null && zoom <= .2} onClick={() => magnify(-1)}><Minus size={15}/></button><output aria-label="预览缩放">{zoom === null ? '适应窗口' : `${Math.round(zoom * 100)}%`}</output><button type="button" aria-label="放大原理图预览" disabled={zoom !== null && zoom >= 4} onClick={() => magnify(1)}><Plus size={15}/></button><button type="button" aria-label="原理图预览适应窗口" onClick={() => setZoom(null)}><Scan size={15}/></button></div></div>
        <div className="agent-proposal-review-body"><div className="agent-proposal-viewport" tabIndex={0} aria-label={`${label}，只读，可滚动查看`}><img className={zoom === null ? 'is-fit' : ''} src={image!.src} alt={label} style={zoom === null ? { aspectRatio: `${image!.width} / ${image!.height}` } : { width: image!.width * zoom, height: image!.height * zoom }}/></div><aside className="agent-proposal-review-setup" aria-label="当前预览版本的仿真设置"><WaveformSetupPreview project={selectedProject} emptyMessage/></aside></div>
        <footer><span>只读预览 · 关闭后保留候选方案</span><button type="button" onClick={() => setExpanded(false)}>返回方案</button></footer>
      </section>
    </div>, document.body)}
  </section>
}
