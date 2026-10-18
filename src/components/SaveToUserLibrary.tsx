import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderPlus, X } from 'lucide-react'
import type { ImportedSpiceModel } from '../core/spice-models'
import { defaultModelSymbol, modelPinLabels, modelSymbolOriginLabel, type ModelSymbol } from '../core/model-symbol'
import { resolveModelFunctionalSymbol } from '../core/model-functional-symbol'
import { renameLibraryModel } from '../core/user-library'
import { addModelToPersistentUserLibrary } from '../core/user-library-sync'
import { useWorkbenchDialog } from './AssistantWindow'
import ModelSymbolPreview from './ModelSymbolPreview'

export function SaveLibraryDialog({ model, onClose, onSaved }: { model: ImportedSpiceModel; onClose: () => void; onSaved?: () => void }) {
  const panel = useRef<HTMLElement>(null)
  const standardSymbol = useMemo(() => resolveModelFunctionalSymbol({ ...model, symbol: undefined }), [model])
  const originalSymbol = model.symbol?.shape === 'ltspice' && model.symbol.origin !== 'standard' ? model.symbol : undefined
  const [name, setName] = useState(model.id), [symbol, setSymbol] = useState<ModelSymbol>(model.symbol ?? standardSymbol ?? defaultModelSymbol(model.kind, model.id,model.kind==='X'?'box':'standard',model.pins))
  const [modelName, setModelName] = useState(model.id)
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false)
  const close = () => { if (!saving) onClose() }
  useWorkbenchDialog(panel, true, close)
  const renamed = useMemo(() => {
    try { return { model: renameLibraryModel(model, modelName), error: '' } }
    catch (reason) { return { model: undefined, error: (reason as Error).message } }
  }, [model, modelName])
  const preview = { ...(renamed.model ?? model), symbol }
  async function save() {
    if (!renamed.model || saving) return
    setSaving(true); setError(''); setNotice('')
    try {
      const result = await addModelToPersistentUserLibrary(preview, name)
      setError(''); setNotice(result.added ? `已保存 ${name} 到本机自建库。关闭页面或切换项目后仍可在「自建库」找到并放置。` : result.updated ? '已为自建库中的器件保存建模依据与缺项记录。' : '自建库已包含此器件，已保留现有建模记录，无需重复保存。')
      onSaved?.()
    } catch (reason) { setNotice(''); setError((reason as Error).message) }
    finally { setSaving(false) }
  }
  const change = (next: ModelSymbol) => { setSymbol(next); setNotice(''); setError('') }
  return createPortal(<div className="workbench-window-backdrop user-library-save-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <section ref={panel} className="workbench-window user-library-save-window" role="dialog" aria-modal="true" aria-label="保存器件到自建库" tabIndex={-1} onKeyDown={event => event.stopPropagation()}>
      <header className="workbench-window-heading"><div><span className="workbench-window-kicker">MY COMPONENTS</span><h2>保存器件到自建库</h2><p>保存模型代码、来源、符号和电气引脚映射，供所有项目复用。</p></div><button type="button" aria-label="关闭自建库保存窗口" disabled={saving} onClick={close}><X size={20}/></button></header>
      <div className="user-library-save-content">
        <ModelSymbolPreview model={preview}/>
        <fieldset className="user-library-save-fields" disabled={saving}><label>器件名称<input aria-label="自建库器件名称" maxLength={80} value={name} onChange={event => { setName(event.target.value); setNotice(''); setError('') }}/></label>
          <label>SPICE 模型名（另存副本）<input aria-label="自建库 SPICE 模型名" maxLength={40} value={modelName} spellCheck={false} onChange={event => { const value = event.target.value; setModelName(value); if(name === modelName)setName(value); setNotice(''); setError('') }}/><small>更名同步修改 .model / .subckt 声明。保存不同符号时，可另存为新型号，保留工程原模型。</small></label>
          <label>原理图符号<select aria-label="自建库符号形状" value={symbol.shape === 'box' ? 'box' : symbol.origin === 'standard' || symbol.shape === 'standard' ? 'standard' : 'ltspice'} onChange={event => { const next = event.target.value; if (next === 'standard' && standardSymbol) change(standardSymbol); else if (next === 'ltspice' && originalSymbol) change(originalSymbol); else change(defaultModelSymbol(model.kind, model.id, 'box', model.pins)) }}>{standardSymbol && <option value="standard">匹配标准器件符号</option>}<option value="box">生成引脚方框符号</option>{originalSymbol && <option value="ltspice">已导入原始符号</option>}</select><small>{modelSymbolOriginLabel(symbol)}；符号选择不改变模型端口顺序。</small></label>
          {symbol.shape === 'box' && <label>符号内名称<input aria-label="自建库符号名称" maxLength={32} value={symbol.title} onChange={event => change({ ...symbol, title: event.target.value })}/></label>}
        </fieldset>
        <fieldset disabled={saving} className="user-library-pin-map"><strong>电气引脚顺序</strong>{symbol.pins.map((pin, index) => <label key={pin.index}><span>{index + 1} · {modelPinLabels(model.kind,model.pins)[index]}</span><input aria-label={`自建库引脚 ${index + 1} 标签`} maxLength={model.kind==='X'?40:12} disabled={symbol.shape === 'standard'||symbol.shape==='ltspice'} value={pin.label} onChange={event => change({ ...symbol, pins: symbol.pins.map(item => item.index === pin.index ? { ...item, label: event.target.value } : item) })}/></label>)}<p>标签可自定义；接线位置与 SPICE 端子顺序固定。这里不是封装管脚编号。</p></fieldset>
        <div className="user-library-provenance"><strong>{preview.id} · {preview.type}</strong><span>{model.source.label}</span>{model.source.url && <a href={model.source.url} target="_blank" rel="noreferrer">查看原始来源</a>}<pre>{preview.spice}</pre></div>
        {(renamed.error || error) && <p role="alert">{renamed.error || error}</p>}{notice && <p className="user-library-success" role="status">{notice}</p>}
      </div><footer className="workbench-window-footer"><span>保存到本机公共器件库，供所有项目长期复用；可导出备份。</span><button type="button" disabled={saving} onClick={close}>关闭</button><button type="button" className="primary" disabled={!renamed.model || saving || Boolean(notice)} onClick={() => void save()}>{saving ? '正在保存…' : notice ? '已保存到自建库' : '保存到自建库'}</button></footer>
    </section>
  </div>, document.body)
}

export default function SaveToUserLibrary({ model, label = '保存到自建库', onSaved }: { model: ImportedSpiceModel; label?: string; onSaved?: () => void }) {
  const [snapshot, setSnapshot] = useState<ImportedSpiceModel | null>(null)
  return <><button type="button" className="save-to-user-library" onClick={() => setSnapshot(structuredClone(model))}><FolderPlus size={14}/>{label}</button>{snapshot && <SaveLibraryDialog model={snapshot} onClose={() => setSnapshot(null)} onSaved={onSaved}/>}</>
}
