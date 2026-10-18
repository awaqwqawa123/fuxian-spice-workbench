import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, CodeXml, Save, X } from 'lucide-react'
import type { Project } from '../core/circuit'
import { createModelEditDraft, prepareModelEdit, type ModelEditScope, type ModelEditTarget } from '../core/model-editor'
import ModelSymbolPreview from './ModelSymbolPreview'
import { modelCodeParameters } from '../core/model-parameters'
import { replaceModelParameter } from '../core/model-parameter-edit'
import { useWorkbenchDialog } from './AssistantWindow'

export interface ModelEditorProps extends ModelEditTarget {
  project: Project
  onApply: (project: Project) => void
  onClose: () => void
  embedded?: boolean
  active?: boolean
}

export default function ModelEditor({ project, deviceId, modelId, onApply, onClose, embedded = false, active = true }: ModelEditorProps) {
  const [initial] = useState(() => {
    try { return { draft: createModelEditDraft(project, { deviceId, modelId }), snapshot: JSON.stringify(project), error: '' } }
    catch (error) { return { draft: undefined, snapshot: JSON.stringify(project), error: (error as Error).message } }
  })
  const [text, setText] = useState(initial.draft?.text ?? '')
  const [scope, setScope] = useState<ModelEditScope>(deviceId ? 'device' : 'project')
  const [validated, setValidated] = useState(false), [saveError, setSaveError] = useState('')
  const [parameterDrafts,setParameterDrafts]=useState<Record<string,string>>({})
  const parameterSummary=useMemo(()=>modelCodeParameters(text),[text])
  const parameterErrors=Object.entries(parameterDrafts).flatMap(([key,value])=>{try{replaceModelParameter(text,key,value);return []}catch(error){return [(error as Error).message]}})
  const panel = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useWorkbenchDialog(panel, active && !embedded, onClose)
  const stale = initial.snapshot !== JSON.stringify(project)
  const result = useMemo(() => {
    if (!initial.draft) return { error: initial.error }
    if (stale) return { error: '工程已发生变化。草稿已保留，请复制需要的代码并关闭后重新打开，避免覆盖新的修改。' }
    try { return { value: prepareModelEdit(project, { deviceId, modelId }, text, scope), error: '' } }
    catch (error) { return { error: (error as Error).message } }
  }, [project, deviceId, modelId, text, scope, stale, initial])

  useEffect(() => {
    if (!active) return
    if (!embedded) { panel.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus(); return }
    const key = (event: KeyboardEvent) => {
      if (!panel.current?.contains(event.target as Node)) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close.current(); return }
    }
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('keydown', key, true) }
  }, [embedded, active])

  function apply() {
    if (!validated || !result.value || stale || parameterErrors.length) return
    try { onApply(result.value.project); onClose() }
    catch (error) { setSaveError((error as Error).message) }
  }
  function changeParameter(key:string,value:string){
    setParameterDrafts(previous=>({...previous,[key]:value}));setValidated(false);setSaveError('')
    try{setText(replaceModelParameter(text,key,value))}catch{/* Keep an incomplete field visible without replacing the last valid source. */}
  }
  const draft = initial.draft, visibleModel = result.value?.model ?? draft?.model
  return <div className={embedded ? 'model-editor-inline' : 'workbench-window-backdrop model-editor-overlay'} onMouseDown={event => { if (!embedded && event.target === event.currentTarget) onClose() }} onKeyDown={event => { if (!embedded) event.stopPropagation() }}>
    <section className={`model-editor-dialog${embedded ? ' model-editor-embedded' : ''}`} ref={panel} role={embedded ? 'region' : 'dialog'} aria-modal={embedded ? undefined : true} aria-label="编辑 SPICE 模型" tabIndex={embedded ? undefined : -1}>
      <header><div><span className="model-editor-kicker">SPICE MODEL EDITOR</span><h2><CodeXml size={22}/>编辑 SPICE 模型</h2><p>{deviceId ? `${deviceId} · ` : ''}{draft?.originalId ?? modelId} · 保存到当前工程</p></div><button aria-label="关闭模型编辑器" onClick={onClose}><X size={20}/></button></header>
      <div className="model-editor-body">
        {draft && <>
          <div className="model-editor-identity">{visibleModel && <ModelSymbolPreview model={visibleModel}/>}<div><strong>{visibleModel?.id}</strong><p>{visibleModel?.type}{visibleModel?.technology ? ` · ${visibleModel.technology}` : ''}</p><p>逻辑引脚顺序：{visibleModel?.pins.join(' → ')}</p><small>{draft.builtIn ? '基于内置教学模型创建工程副本' : '保留原模型的来源、许可与厂家信息，并注明用户修改'}</small></div></div>
          {deviceId && <fieldset className="model-editor-scope"><legend>应用范围</legend><label><input type="radio" name="model-scope" value="device" checked={scope === 'device'} onChange={() => { setScope('device'); setValidated(false) }}/><span><strong>仅当前器件 {deviceId}</strong><small>另存独立模型，其他器件继续使用原模型。</small></span></label><label><input type="radio" name="model-scope" value="all" checked={scope === 'all'} onChange={() => { setScope('all'); setValidated(false) }}/><span><strong>全部同型号器件 · {draft.references.length} 个</strong><small>{draft.references.join('、') || '当前没有器件引用此模型'}</small></span></label></fieldset>}
          {!deviceId && <p className="model-editor-impact">编辑工程模型；更名后自动同步 {draft.references.length} 个引用：{draft.references.join('、') || '暂无引用'}。</p>}
          <section className="model-parameter-editor" aria-label="编辑模型关键参数"><header><strong>关键参数</strong><span>与下方源码同步 · 尚未应用</span></header><div>{parameterSummary.rows.map(row=><label key={row.key} title={row.note}><span>{row.label}<code>{row.key}</code></span><div><input aria-label={`${row.label} ${row.key}`} spellCheck={false} value={parameterDrafts[row.key]??row.value} onChange={event=>changeParameter(row.key,event.target.value)}/><small>{row.unit||'无量纲'}</small></div></label>)}</div><p>{parameterSummary.note}</p></section>
          <label className="model-editor-code-label">.model 定义<textarea aria-label="编辑模型定义" spellCheck={false} value={text} onChange={event => { setText(event.target.value); setParameterDrafts({});setValidated(false); setSaveError('') }} maxLength={8192} rows={7}/></label>
          <p className="model-editor-help">编辑当前器件的 .model 定义；上方器件连接语句由原理图生成。支持 D、NPN / PNP、NMOS / PMOS、VDMOS、NJF / PJF；参数单位遵循 SPICE（m = 毫，meg = 兆）。.subckt 与外部依赖尚不支持。</p>
          <details className="model-editor-original" open><summary>当前原始模型代码</summary><pre><code>{draft.originalSpice}</code></pre></details>
        </>}
        {(result.error || saveError || parameterErrors.length>0) && <p className="model-editor-error" role="alert">{parameterErrors.join('；') || saveError || result.error}</p>}
        {validated && result.value && <section className="model-editor-validation" role="status"><strong><Check size={16}/>语法和引脚检查通过</strong><p>{result.value.created ? '新增工程模型' : '更新工程模型'} {result.value.model.id}；应用到：{result.value.affectedDeviceIds.join('、') || '工程模型库（暂无器件引用）'}。</p><pre>{result.value.model.spice}</pre><small>保存后可撤销。电气参数变更需重新运行仿真；语法通过不代表模型精度或所有工作条件均有效。</small></section>}
      </div>
      <footer><span>模型随工程保存 · 当前工程内生效</span><div><button onClick={onClose}>取消</button><button disabled={!result.value || stale || parameterErrors.length>0} onClick={() => { setValidated(true); setSaveError('') }}>验证并预览</button><button className="primary" disabled={!validated || !result.value || stale || parameterErrors.length>0} onClick={apply}><Save size={15}/>应用模型</button></div></footer>
    </section>
  </div>
}
