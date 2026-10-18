import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, BookOpen, Search, X } from 'lucide-react'
import { templates, type TemplateId } from '../core/circuit'
import { editorTemplate } from '../core/editor'
import { advancedExamples, exampleProject, type ExampleId } from '../core/examples'
import { deviceExamples, deviceExampleProject, type DeviceExampleId } from '../core/device-examples'
import { schematicSvg } from '../core/export-svg'

export type GalleryExampleId = TemplateId | ExampleId | DeviceExampleId
const categories = ['全部', '基础滤波', '二极管与晶体管', '运放与放大', '开关与继电器', '电源与磁性'] as const
type Category = typeof categories[number]
const advancedCategory: Record<ExampleId, Category> = {
  rectifier: '二极管与晶体管', 'diode-sweep': '二极管与晶体管', 'bjt-amplifier': '运放与放大',
  'mos-switch': '二极管与晶体管', 'opamp-gain': '运放与放大',
}
const deviceCategory: Record<DeviceExampleId, Category> = {
  'switch-load': '开关与继电器', 'voltage-switch': '开关与继电器', 'relay-changeover': '开关与继电器',
  'ldo-regulator': '电源与磁性', 'transformer-ratio': '电源与磁性',
}
const examples = [
  ...templates.map(t => ({ id: t.id, name: t.name, detail: t.description, category: '基础滤波' as Category, project: () => editorTemplate(t.id) })),
  ...advancedExamples.map(t => ({ ...t, category: advancedCategory[t.id], project: () => exampleProject(t.id) })),
  ...deviceExamples.map(t => ({ ...t, category: deviceCategory[t.id], project: () => deviceExampleProject(t.id) })),
]
const analysisNames = { noise: '噪声分析', ac: 'AC 频率响应', tran: '瞬态分析', op: 'DC 工作点', dc: 'DC 扫描' }
const searchableExamples = examples.map(entry => ({ ...entry, searchText: `${entry.name} ${entry.detail} ${entry.category} ${entry.id} ${analysisNames[entry.project().analysis]}`.toLowerCase() }))

export default function TemplateGallery({ onClose, onUse }: { onClose: () => void; onUse: (id: GalleryExampleId) => void }) {
  const [category, setCategory] = useState<Category>('全部')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<GalleryExampleId>('rc-lowpass')
  const panel = useRef<HTMLElement>(null), searchInput = useRef<HTMLInputElement>(null)
  const close = useRef(onClose); close.current = onClose
  const visible = searchableExamples.filter(e => (category === '全部' || e.category === category) && e.searchText.includes(search.trim().toLowerCase()))
  const entry = visible.find(e => e.id === selected) ?? visible[0]
  const project = useMemo(() => entry?.project(), [entry])
  const preview = useMemo(() => project && entry ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(schematicSvg(project.drawing!, { title: entry.name }))}` : '', [entry, project])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    searchInput.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (event.key !== 'Tab') return
      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input') ?? [])]
      const first = focusable[0], last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', key, true)
    return () => { document.body.style.overflow = overflow; window.removeEventListener('keydown', key, true); previous?.focus() }
  }, [])
  return <div className="examples-backdrop" onClick={onClose}>
    <section ref={panel} className="example-gallery" role="dialog" aria-modal="true" aria-label="示例电路" aria-describedby="example-gallery-hint" onClick={event => event.stopPropagation()}>
      <header className="example-gallery-header"><div><span className="example-eyebrow">CIRCUIT COLLECTION / {String(examples.length).padStart(2, '0')}</span><h2><BookOpen size={24} />示例电路</h2><p id="example-gallery-hint">挑选一个起点，在同一张原理图中继续设计。</p></div><button aria-label="关闭示例电路" onClick={onClose}><X size={22} /></button></header>
      <div className="example-gallery-body">
        <aside className="example-categories" aria-label="示例分类"><span>按电路用途浏览</span>{categories.map(name => <button key={name} aria-pressed={category === name} onClick={() => setCategory(name)}>{name}<small>{name === '全部' ? examples.length : examples.filter(e => e.category === name).length}</small></button>)}</aside>
        <div className="example-browser"><label className="example-search"><Search size={17} /><input ref={searchInput} aria-label="搜索示例电路" placeholder="搜索名称、器件或分析类型" value={search} onChange={e => setSearch(e.target.value)} /><kbd>ESC 关闭</kbd></label><div className="example-list-heading"><strong>{category === '全部' ? '所有示例' : category}</strong><small>{visible.length} 个电路</small></div><div className="example-list">{visible.map(e => <button className="example-card" key={e.id} data-example-id={e.id} aria-pressed={entry?.id === e.id} onClick={() => setSelected(e.id)}><span className="example-card-category">{e.category}</span><strong>{e.name}</strong><small>{e.detail}</small><span className="example-card-select">{entry?.id === e.id ? '正在预览' : '查看电路'}<ArrowRight size={13} /></span></button>)}{!visible.length && <div className="example-empty"><Search size={25} /><strong>没有找到相关示例</strong><p>试试「RC」「继电器」或「LDO」。</p><button onClick={() => { setSearch(''); setCategory('全部') }}>查看全部示例</button></div>}</div></div>
        <aside className="example-preview" aria-label="示例预览">{entry&&project?<><span className="example-eyebrow">CIRCUIT PREVIEW</span><img src={preview} alt={`${entry.name}原理图预览`} /><span className="example-preview-category">{entry.category}</span><h3>{entry.name}</h3><p>{entry.detail}</p><dl><div><dt>分析</dt><dd>{analysisNames[project.analysis]}</dd></div><div><dt>器件</dt><dd>{project.drawing!.devices.filter(d => d.kind !== 'GND').length} 个</dd></div></dl><button className="use-example" onClick={() => onUse(entry.id)}>使用示例<ArrowRight size={17} /></button><small className="example-replace-note">载入后可编辑全部器件。<br />Ctrl+Z 可恢复当前原理图。</small></>:<div className="example-preview-empty">没有可预览的电路，请调整搜索或分类。</div>}</aside>
      </div>
      <footer className="example-gallery-footer"><span>浏览与预览不会改变当前工程</span><button onClick={onClose}>返回原理图</button></footer>
    </section>
  </div>
}
