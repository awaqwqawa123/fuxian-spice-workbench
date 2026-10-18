import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, ChevronDown, LoaderCircle, RefreshCw, Shapes } from 'lucide-react'
import type { ModelDownloadPreview, ModelSearchCandidate, ModelSearchResults } from '../core/model-search'
import type { ImportedSpiceModel } from '../core/spice-models'
import { downloadDeviceModel, lookupDeviceModels } from '../core/device-model-client'
import { modelCategoryLabel } from '../core/model-taxonomy'
import ModelSymbolPreview from './ModelSymbolPreview'
import { modelSymbolDescription, modelTerminalDescription } from '../core/model-symbol-display'
import { acquiredModelMatches } from '../core/model-download-sources'
import { groupDeviceModelCandidates, type DeviceModelGroup, type DeviceModelVariant } from '../core/model-search-groups'
import { modelDeclarationMatch } from '../core/model-search-match'
import { preferredModelLibrary } from '../core/model-source-policy'

export interface DeviceModelResultsProps {
  query: string
  projectModels?: ImportedSpiceModel[]
  onPlaceModel?: (model: ImportedSpiceModel) => void
  onImportAndPlaceModel?: (model: ImportedSpiceModel, preview: ModelDownloadPreview) => void | Promise<void>
  onOpenModels?: (query: string) => void
  remoteOnly?: boolean
}
const normalized = (value: string) => value.trim().toUpperCase()
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : '模型请求失败，请重试'
const sourceName=(candidate:ModelSearchCandidate)=>{const library=preferredModelLibrary(candidate.source);return library?{tina:'TINA',pspice:'PSpice',ltspice:'LTspice'}[library]:'未登记来源'}
interface VariantReadState {status:'ready'|'unsupported'|'error';reason?:string}

export default function DeviceModelResults({ query, projectModels = [], onPlaceModel, onImportAndPlaceModel, onOpenModels, remoteOnly = false }: DeviceModelResultsProps) {
  const term = query.trim(), version = useRef(0), downloadController = useRef<AbortController | null>(null)
  const indexable = /^[a-z0-9][a-z0-9_. +\/-]{1,47}$/i.test(term)
  const [lookup, setLookup] = useState<{ query: string; result?: ModelSearchResults; error?: string; loading: boolean }>({ query: '', loading: false })
  const [retry, setRetry] = useState(0), [busyId, setBusyId] = useState(''), [actionError, setActionError] = useState('')
  const [preview, setPreview] = useState<{ groupId: string; variantId: string; candidate: ModelSearchCandidate; file: ModelDownloadPreview; models: ImportedSpiceModel[] } | null>(null)
  const [selected, setSelected] = useState(''), [placing, setPlacing] = useState(false)
  const [limit, setLimit] = useState(8), [expanded, setExpanded] = useState(''), [variantSelection, setVariantSelection] = useState<Record<string,string>>({})
  const [variantReads,setVariantReads]=useState<Record<string,VariantReadState>>({})

  useEffect(() => {
    const current = ++version.current, controller = new AbortController()
    downloadController.current?.abort(); setBusyId(''); setPreview(null); setSelected(''); setActionError(''); setPlacing(false); setLimit(8); setExpanded(''); setVariantSelection({}); setVariantReads({})
    if (!indexable) { setLookup({ query: term, loading: false }); return () => controller.abort() }
    setLookup({ query: term, loading: true })
    let timeout: ReturnType<typeof setTimeout> | undefined
    const debounce = setTimeout(() => {
      timeout = setTimeout(() => controller.abort(), 25000)
      void lookupDeviceModels(term, controller.signal).then(result => {
        if (current === version.current) setLookup({ query: term, result, loading: false })
      }).catch(reason => {
        if (current === version.current) setLookup({ query: term, error: controller.signal.aborted ? '器件索引查询超时，请重试或重新启动工作台服务' : errorMessage(reason), loading: false })
      }).finally(() => clearTimeout(timeout))
    }, 350)
    return () => { ++version.current; clearTimeout(debounce); clearTimeout(timeout); controller.abort(); downloadController.current?.abort() }
  }, [term, retry,indexable])

  if (term.length < 2) return null
  const local = remoteOnly ? [] : projectModels.filter(model => modelDeclarationMatch(model.id,term))
  if (!indexable && !local.length) return null
  const result = lookup.query === term ? lookup.result : undefined
  const candidates = (result?.candidates ?? []).filter(candidate => !remoteOnly || candidate.origin !== 'local-library' || candidate.availability !== undefined)
  const rejectedVersions=new Set(Object.entries(variantReads).filter(([,value])=>value.status==='unsupported').map(([id])=>id))
  const groups = groupDeviceModelCandidates(candidates,term,rejectedVersions)
  // A letter-only family search such as OPA remains a browse of distinct
  // devices, even if a library also declares a generic root named OPA.
  const exactGroups=/\d/.test(term)?groups.filter(group=>modelDeclarationMatch(group.name,term)==='exact'):[]
  const primaryGroups=exactGroups.length?exactGroups:groups
  const relatedGroups=exactGroups.length?groups.filter(group=>!exactGroups.includes(group)):[]
  const unavailable=(variant:DeviceModelVariant)=>variantReads[variant.id]?.status==='unsupported'||variant.candidate.availability==='unsupported'
  const available=(variant:DeviceModelVariant)=>!unavailable(variant)&&variantReads[variant.id]?.status!=='error'&&(variantReads[variant.id]?.status==='ready'||variant.candidate.availability==='ready')
  const compatible = primaryGroups.filter(group => group.variants.some(variant => !unavailable(variant)))
  // Keep the active source visible when its last candidate fails validation;
  // moving it inside a closed diagnostics section would hide the new reason.
  const visible = compatible.slice(0, limit),activeGroup=primaryGroups.find(group=>group.id===expanded)
  if(activeGroup&&!visible.some(group=>group.id===activeGroup.id))visible.push(activeGroup)
  const unsupported = primaryGroups.filter(group => group.variants.every(unavailable)&&group.id!==expanded)
  const previewIsCurrent=!!preview&&preview.groupId===expanded&&variantSelection[expanded]===preview.variantId&&!busyId
  const currentModel = previewIsCurrent?preview?.models.find(model => model.id === selected):undefined
  const loading = lookup.query !== term || lookup.loading

  async function readVariant(group: DeviceModelGroup, variant: DeviceModelVariant) {
    downloadController.current?.abort()
    const controller = new AbortController(), current = ++version.current
    downloadController.current = controller; setBusyId(variant.id); setPreview(null); setSelected(''); setActionError('')
    if(variant.candidate.availability==='unsupported'){setBusyId('');return}
    const candidate=variant.candidate, timeout = setTimeout(() => controller.abort(), 45000)
    let incompatible=false
    try {
      const file = await downloadDeviceModel(candidate.id, controller.signal)
      if (current !== version.current) return
      // Each card is one public device. Other declarations and helper roots in
      // the same source file must never be offered as this device's model.
      const models = file.models.filter(model => acquiredModelMatches(model.id,variant.matchedNames,file.source))
      models.sort((a, b) => Number(normalized(b.id) === normalized(group.name)) - Number(normalized(a.id) === normalized(group.name)))
      if (!models.length) {incompatible=true;throw new Error(file.diagnostics.filter(item=>!item.model||variant.matchedNames.some(name=>normalized(name)===normalized(item.model!))).map(item => item.message).join('；') || '此版本没有兼容的匹配模型，请选择其他来源版本')}
      setVariantReads(value=>({...value,[variant.id]:{status:'ready'}}))
      setPreview({ groupId:group.id, variantId:variant.id, candidate, file, models }); setSelected(models[0].id)
    } catch (reason) {
      if (current === version.current) {
        const message=controller.signal.aborted?candidate.origin==='local-library'?'本地模型读取超时，请重试':'模型获取超时，请重试':errorMessage(reason)
        setVariantReads(value=>({...value,[variant.id]:{status:incompatible?'unsupported':'error',reason:message}}));setActionError(message)
      }
    } finally { clearTimeout(timeout); if (current === version.current) setBusyId('') }
  }
  function openGroup(group:DeviceModelGroup){
    if(expanded===group.id){downloadController.current?.abort();++version.current;setBusyId('');setExpanded('');setPreview(null);setSelected('');setActionError('');return}
    const variant=group.variants.find(item=>item.id===variantSelection[group.id])??group.variants.find(item=>!unavailable(item))??group.variants[0]
    setExpanded(group.id);setVariantSelection(value=>({...value,[group.id]:variant.id}));void readVariant(group,variant)
  }
  async function importAndPlace() {
    if (!currentModel || !preview || !onImportAndPlaceModel) return
    const current = version.current
    setPlacing(true); setActionError('')
    try { await onImportAndPlaceModel(currentModel, preview.file); if (current === version.current){setPreview(null);setExpanded('')} }
    catch (reason) { if (current === version.current) setActionError(errorMessage(reason)) }
    finally { if (current === version.current) setPlacing(false) }
  }
  function renderGroup(group:DeviceModelGroup){
    const variant=group.variants.find(item=>item.id===variantSelection[group.id])??group.variants[0],candidate=variant.candidate
    const isOpen=expanded===group.id,ready=group.variants.filter(available).length
    const rejected=group.variants.filter(unavailable),readState=variantReads[variant.id]
    const selectedReady=preview?.groupId===group.id&&preview.variantId===variant.id&&!!currentModel&&!unavailable(variant)
    const selectedStatus=busyId===variant.id?'当前版本 · 正在读取…':unavailable(variant)?'当前版本 · 暂不兼容':readState?.status==='error'?'当前版本 · 读取失败':selectedReady?'当前版本 · 已检查，可放置':'当前版本 · 待检查'
    const collapsedStatus=ready?'推荐模型可用':rejected.length===group.variants.length?'暂不兼容 · 原件已保存':'待检查'
    const exact=group.variants.some(item=>item.matchedNames.some(name=>modelDeclarationMatch(name,term)==='exact'))
    return <article key={group.id} className="device-model-candidate device-model-group">
      <button type="button" disabled={loading||placing} aria-expanded={isOpen} onClick={()=>openGroup(group)}>
        <Shapes size={20}/><span><strong>{group.name}</strong><small>{!exact&&candidate.match==='filename'&&<>文件名匹配 · </>}{isOpen?selectedStatus:collapsedStatus}</small></span><span className="device-model-version-count">{group.variants.length===1?sourceName(candidate):`${group.variants.length} 个库`}</span><ChevronDown size={14} className={isOpen?'device-model-chevron-open':undefined}/>
      </button>
      {isOpen&&<div className="device-model-variants">
        <label>模型库<select value={variant.id} disabled={placing} onChange={event=>{const next=group.variants.find(item=>item.id===event.target.value);if(!next)return;setVariantSelection(value=>({...value,[group.id]:next.id}));void readVariant(group,next)}}>{group.variants.map(item=><option key={item.id} value={item.id}>{sourceName(item.candidate)} · 推荐版本{unavailable(item)?' · 暂不兼容':variantReads[item.id]?.status==='error'?' · 读取失败':available(item)?' · 本地可用':' · 待检查'}</option>)}</select></label>
        <details className="device-model-compatibility"><summary>原始文件与来源</summary><p>{candidate.source.label}</p><p>{candidate.path}</p></details>
        {unavailable(variant)&&<details className="device-model-compatibility"><summary>此版本暂不兼容 · 查看原因</summary><p>{readState?.reason||candidate.reason||'原始文件已完整保存，当前导入器尚不支持此版本。'}</p></details>}
        {!selectedReady&&!unavailable(variant)&&busyId!==variant.id&&<p className="device-model-status"><button type="button" disabled={placing||!!busyId} onClick={()=>{setVariantSelection(value=>({...value,[group.id]:variant.id}));void readVariant(group,variant)}}><RefreshCw size={13}/>{readState?'重新检查此版本':'检查推荐版本'}</button></p>}
        {busyId===variant.id&&<p className="device-model-status" role="status"><LoaderCircle className="device-model-spinner" size={14}/>正在读取器件符号与参数…</p>}
        {selectedReady&&currentModel&&preview&&<div className="device-model-preview">
          {preview.models.length>1&&<label>选择匹配声明<select value={currentModel.id} onChange={event=>setSelected(event.target.value)} disabled={placing}>{preview.models.map(model=><option key={model.id} value={model.id}>{model.id}</option>)}</select></label>}
          <div className="device-model-pin-preview"><ModelSymbolPreview model={currentModel}/></div>
          <strong>{group.name}</strong><small>{modelCategoryLabel(currentModel)} · {currentModel.metadata.mfg||'原文件未注明厂商'}</small><p>{modelTerminalDescription(currentModel)}</p>
          <small>{modelSymbolDescription(currentModel)}</small>
          <small>已通过导入语法检查；仿真精度尚未认证。</small>
          {preview.file.diagnostics.length>0&&<details><summary>同文件解析说明（{preview.file.diagnostics.length}）</summary>{preview.file.diagnostics.slice(0,8).map((item,index)=><p key={index}>{item.message}</p>)}</details>}
          <button type="button" className="device-model-import" disabled={!onImportAndPlaceModel||placing} onClick={()=>void importAndPlace()}>{placing?<><LoaderCircle className="device-model-spinner" size={14}/>正在放置…</>:'放置到画布'}</button>
        </div>}
        {rejected.length>0&&!unavailable(variant)&&<details className="device-model-compatibility"><summary>其他暂不兼容版本（{rejected.length}）</summary>{rejected.map(item=><details key={item.id}><summary>{item.candidate.source.label} · {item.candidate.path.split('/').at(-1)}</summary><p>{item.candidate.path}</p><p>{variantReads[item.id]?.reason||item.candidate.reason||'原件已保存，当前格式尚不支持仿真。'}</p></details>)}</details>}
      </div>}
    </article>
  }
  return <section className="device-model-results" aria-label="器件模型搜索结果" aria-busy={loading || !!busyId || placing}>
    <header><strong>器件模型</strong>{onOpenModels&&<button type="button" onClick={()=>onOpenModels(term)} title="打开完整 SPICE 模型库">模型库<ArrowUpRight size={13}/></button>}</header>
    {local.length>0&&<div className="device-model-current"><small>当前项目 · 可以直接放置</small>{local.map(model=><button type="button" key={model.id} disabled={!onPlaceModel||placing} onClick={()=>{try{onPlaceModel?.(model);setActionError('')}catch(reason){setActionError(errorMessage(reason))}}}><ModelSymbolPreview model={model}/><span><strong>{model.id}</strong><small>{model.pins.length} 引脚 · {model.type}</small></span><Check size={14}/></button>)}</div>}
    {loading&&<p className="device-model-status" role="status"><LoaderCircle className="device-model-spinner" size={15}/>正在查找本地器件模型…</p>}
    {lookup.query===term&&lookup.error&&<div className="device-model-error" role="alert"><p>{lookup.error}</p><button type="button" onClick={()=>setRetry(value=>value+1)}><RefreshCw size={13}/>重试查询</button></div>}
    {visible.map(renderGroup)}
    {relatedGroups.length>0&&<details className="device-model-unsupported-groups"><summary>其他相关型号（{relatedGroups.length}）</summary>{relatedGroups.slice(0,limit).map(renderGroup)}{relatedGroups.length>limit&&<button type="button" onClick={()=>setLimit(value=>value+8)}>显示更多相关型号</button>}</details>}
    {unsupported.length>0&&<details className="device-model-unsupported-groups"><summary>暂不兼容器件（{unsupported.length}）</summary>{unsupported.map(renderGroup)}</details>}
    {actionError&&<p className="device-model-error" role="alert">{actionError}</p>}
    {!loading&&!lookup.error&&result&&!groups.length&&!local.length&&<p className="device-model-status">已登记库中未找到“{term}”。{onOpenModels&&<button type="button" onClick={()=>onOpenModels(term)}>让模型助手查找或建立模型</button>}</p>}
    {compatible.length>limit&&<p className="device-model-status">已显示 {limit} 个器件，共 {compatible.length} 个。<button type="button" onClick={()=>setLimit(value=>value+8)}>显示更多</button></p>}
    {result?.notices?.length?<details className="device-model-notices"><summary>索引说明</summary>{result.notices.map((notice,index)=><p key={index}>{notice}</p>)}</details>:null}
  </section>
}
