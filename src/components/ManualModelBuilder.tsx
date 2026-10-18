import { useEffect, useId, useRef, useState } from 'react'
import { BookPlus, Check, ClipboardCopy, CodeXml, Download, FilePlus2, LoaderCircle, RotateCcw } from 'lucide-react'
import type { ImportedSpiceModel } from '../core/spice-models'
import { checkManualModel, copyManualModel, emptyManualModelDraft, MANUAL_MODEL_LIMITS, manualModelStorageKey, readManualModelDraft, saveManualModelDraft, type ManualModelDraft, type ManualModelPreview } from '../core/manual-model'
import { modelParameterAdjustments } from '../core/model-reference'
import ModelReview from './ModelReview'

export interface ManualModelBuilderProps {
  projectId?:string
  models:ImportedSpiceModel[]
  onImport:(model:ImportedSpiceModel)=>void|Promise<void>
  onSaveToUserLibrary?:(model:ImportedSpiceModel)=>void|boolean|Promise<void|boolean>
}

function ManualModelDraftEditor({projectId,models,onImport,onSaveToUserLibrary}:ManualModelBuilderProps) {
  const [restored]=useState(()=>{try{return readManualModelDraft(localStorage,projectId)}catch{return {draft:emptyManualModelDraft(),error:'无法访问本机草稿存储，请保留源码副本。'}}})
  const [draft,setDraft]=useState(restored.draft),[previous,setPrevious]=useState<ManualModelDraft>()
  const [selection,setSelection]=useState(''),[preview,setPreview]=useState<ManualModelPreview>()
  const [error,setError]=useState(''),[storageError,setStorageError]=useState(restored.error??''),[notice,setNotice]=useState('')
  const [busy,setBusy]=useState<'project'|'library'|undefined>(),[imported,setImported]=useState(''),[saved,setSaved]=useState('')
  const alive=useRef(true),editor=useRef<HTMLTextAreaElement>(null),sourceId=useId()
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  function change(next:ManualModelDraft,remember=false){
    if(remember)setPrevious(draft)
    const value={...next,updatedAt:Date.now()}
    setDraft(value);setPreview(undefined);setError('');setNotice('');setImported('');setSaved('')
    try{saveManualModelDraft(localStorage,projectId,value);setStorageError('')}
    catch(reason){setStorageError(`草稿尚未保存到本机：${(reason as Error).message}。请复制源码留存。`)}
  }
  function check(){
    setError('');setNotice('');setPreview(undefined)
    try{setPreview(checkManualModel(draft.text,draft.reference))}
    catch(reason){setError((reason as Error).message)}
  }
  function copy(){
    const selected=models.find(model=>model.id===selection)
    if(!selected)return
    try{change(copyManualModel(selected,models),true);editor.current?.focus()}
    catch(reason){setError((reason as Error).message)}
  }
  async function accept(destination:'project'|'library'){
    if(!preview||busy)return
    const model=preview.model
    if(destination==='project'&&models.some(item=>item.id.toLowerCase()===model.id.toLowerCase())){setError(`工程中已存在 ${model.id}。请在源码中改名后重新检查；现有模型不会被覆盖。`);return}
    setBusy(destination);setError('');setNotice('')
    try{
      if(destination==='project')await onImport(model)
      else if(onSaveToUserLibrary&&(await onSaveToUserLibrary(model))===false)return
      if(!alive.current)return
      if(destination==='project')setImported(model.spice);else setSaved(model.spice)
      setNotice(destination==='project'?`${model.id} 已导入工程模型库；可在模型库中选择放置。`:`${model.id} 已保存到自建库。`)
    }catch(reason){if(alive.current)setError(`未能${destination==='project'?'导入工程':'保存到自建库'}：${(reason as Error).message}。源码与预览已保留。`)}
    finally{if(alive.current)setBusy(undefined)}
  }
  const duplicate=Boolean(preview&&models.some(model=>model.id.toLowerCase()===preview.model.id.toLowerCase()))
  const comparison=preview&&draft.reference?modelParameterAdjustments(draft.reference,preview.model):undefined
  return <section className="manual-model-builder" aria-label="手动从零建模">
    <header className="manual-model-heading"><div><h3><CodeXml size={19}/>手动建模</h3><p>编写一个 .model 或自包含 .subckt，检查引脚与参数后再导入。</p></div><span>用户源码 · 电气行为未验证</span></header>
    <div className="manual-model-source-tools"><button type="button" disabled={Boolean(busy)} onClick={()=>{change(emptyManualModelDraft(),true);editor.current?.focus()}}><FilePlus2 size={15}/>新建空白</button><label>复制工程模型<select aria-label="选择要复制的工程模型" value={selection} disabled={!models.length||Boolean(busy)} onChange={event=>setSelection(event.target.value)}><option value="">{models.length?'选择参考模型':'工程中暂无模型'}</option>{models.map(model=><option key={model.id} value={model.id}>{model.id} · {model.type}</option>)}</select></label><button type="button" disabled={!models.some(model=>model.id===selection)||Boolean(busy)} onClick={copy}><ClipboardCopy size={15}/>复制到编辑区</button>{previous&&<button type="button" disabled={Boolean(busy)} onClick={()=>{const old=previous;setPrevious(draft);change(old)}}><RotateCcw size={14}/>恢复上一份草稿</button>}</div>
    {draft.reference&&<p className="manual-model-reference">参考：<strong>{draft.reference.id}</strong> · {draft.reference.source.label}。原来源与条款随副本保留。</p>}
    <label className="manual-model-source-label" htmlFor={sourceId}>SPICE 模型源码</label>
    <textarea ref={editor} id={sourceId} aria-label="手动模型源码" spellCheck={false} value={draft.text} disabled={Boolean(busy)} maxLength={MANUAL_MODEL_LIMITS.characters} onChange={event=>change({...draft,text:event.target.value})} placeholder={'从空白开始编写 .model 或 .subckt 定义\n子电路须含完整 .ends，支持 2～32 个逻辑端口。'}/>
    <div className="manual-model-check-row"><small>{draft.text.length.toLocaleString()} 字符 · 最多 128 KB · {storageError?'本机保存待处理':'草稿自动保存在本机'}</small><button type="button" className="manual-model-check" disabled={!draft.text.trim()||Boolean(busy)} onClick={check}><Check size={16}/>检查并预览</button></div>
    <p className="manual-model-help">支持 D、NPN / PNP、MOS / VDMOS、JFET 和兼容子电路。需要一个独立模型；外部文件、控制命令和不兼容参数会被拒绝。</p>
    {storageError&&<p className="manual-model-warning" role="alert">{storageError}</p>}
    {error&&<p className="manual-model-error" role="alert">{error}</p>}
    {notice&&<p className="manual-model-success" role="status">{notice}</p>}
    {preview&&<div className="manual-model-preview"><p className="manual-model-check-result"><Check size={16}/>语法与引脚结构检查通过 · 仍需运行仿真验证</p>{duplicate&&<p className="manual-model-warning">工程中已有同名模型 {preview.model.id}；请在源码中改名后重新检查。</p>}{preview.diagnostics.length>0&&<details className="manual-model-diagnostics"><summary>检查说明 · {preview.diagnostics.length} 项</summary><ul>{preview.diagnostics.map((item,index)=><li key={index}>第 {item.line} 行：{item.message}</li>)}</ul></details>}
      <ModelReview model={preview.model} referenceModel={draft.reference} {...comparison} limitations={['此模型由用户手动编写或修改，仅通过可导入语法与引脚结构检查，未验证电气行为、准确度或全部工作条件。',...(draft.reference&&preview.model.kind==='X'?['子电路内部结构和表达式需与参考源码逐项核对，参数卡不代表完整电路差异。']:[])]}>
        <button type="button" disabled={Boolean(busy)||duplicate||imported===preview.model.spice} onClick={()=>void accept('project')}>{busy==='project'?<LoaderCircle className="manual-model-spinner" size={15}/>:<Download size={15}/>}导入工程模型库</button>
        {onSaveToUserLibrary&&<button type="button" disabled={Boolean(busy)||saved===preview.model.spice} onClick={()=>void accept('library')}>{busy==='library'?<LoaderCircle className="manual-model-spinner" size={15}/>:<BookPlus size={15}/>}保存到自建库</button>}
      </ModelReview>
      {draft.reference&&preview.model.kind==='X'&&<details className="manual-model-original"><summary>对照原始子电路源码 · {draft.reference.id}</summary><pre>{draft.reference.spice}</pre></details>}
    </div>}
  </section>
}

export default function ManualModelBuilder(props:ManualModelBuilderProps) {
  // Remount only this editor when switching projects, so an earlier project's
  // draft or in-flight callback cannot populate the new project's editor.
  return <ManualModelDraftEditor key={manualModelStorageKey(props.projectId)} {...props}/>
}
