import { useEffect, useMemo, useState } from 'react'
import { Check, ExternalLink, FolderSearch, Plus, RefreshCw, Search, SquarePen } from 'lucide-react'
import { catalogModelParameters, modelTypeLabels, searchCatalog, type LocalModelCatalog as Catalog } from '../core/model-catalog'
import { categoryCounts, filterCatalogByCategory, modelCategories, modelCategoryCoverage, modelCategoryGroups, modelCategoryLabel } from '../core/model-taxonomy'
import { SPICE_LIBRARY_LIMITS, type ImportedSpiceModel } from '../core/spice-models'
import ModelSymbolPreview from './ModelSymbolPreview'
import { modelSymbolDescription, modelTerminalDescription } from '../core/model-symbol-display'
import { preferredModelLibrary, selectPreferredCatalogModels } from '../core/model-source-policy'
import { publicModelId } from '../core/model-public-identity'
import type { AgentModelAcquisition } from '../core/agent-models'
import AgentModelDownloads from './AgentModelDownloads'
import LocalLtspiceSymbols from './LocalLtspiceSymbols'
import MaterializedModelCatalog from './MaterializedModelCatalog'
import type { ModelDownloadPreview } from '../core/model-search'

const PAGE_SIZE=40
// The catalog already selects one version per exact part and library. Keep
// DOM/selection identities small instead of copying full macro source code.
const catalogVersionKey=(model:ImportedSpiceModel)=>JSON.stringify([model.id,model.source.label,model.source.url])
const libraryName=(model:ImportedSpiceModel)=>{const source=preferredModelLibrary(model.source);return source?{ltspice:'LTspice',tina:'TINA',pspice:'PSpice'}[source]:'工程模型'}
const publicKey=(model:ImportedSpiceModel)=>publicModelId(model.id,model.source).toUpperCase()
const publicCatalogModels=(models:readonly ImportedSpiceModel[])=>[...new Map(models.map(model=>[publicKey(model),model])).values()]
function selectCatalogVersion(selection:Set<string>,model:ImportedSpiceModel,models:readonly ImportedSpiceModel[]){
  for(const item of models)if(publicKey(item)===publicKey(model))selection.delete(catalogVersionKey(item))
  selection.add(catalogVersionKey(model))
}
export default function LocalModelCatalog({models,onImport,onPlace,onManual,onEditModel,acquisitions=[],onImportAcquired,onImportAndPlaceModel}:{
  models:ImportedSpiceModel[]
  onImport:(models:ImportedSpiceModel[])=>void
  onPlace:(model:ImportedSpiceModel)=>void
  onManual:()=>void
  onEditModel?:(model:ImportedSpiceModel)=>void
  acquisitions?:AgentModelAcquisition[]
  onImportAcquired?:(model:ImportedSpiceModel)=>void
  onImportAndPlaceModel?:(model:ImportedSpiceModel,preview:ModelDownloadPreview)=>void|Promise<void>
}){
  const[catalog,setCatalog]=useState<Catalog|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const[query,setQuery]=useState(''),[savedQuery,setSavedQuery]=useState(''),[type,setType]=useState(''),[page,setPage]=useState(0),[revision,setRevision]=useState(0)
  const[packageId,setPackageId]=useState(''),[manufacturer,setManufacturer]=useState(''),[category,setCategory]=useState('')
  const[selected,setSelected]=useState<Set<string>>(new Set())
  const[versions,setVersions]=useState<Record<string,string>>({})
  const existing=useMemo(()=>new Map(models.map(model=>[model.id.toLowerCase(),model])),[models])
  const savedModels=useMemo(()=>searchCatalog(models,savedQuery),[models,savedQuery])
  const room=SPICE_LIBRARY_LIMITS.projectModels-models.length
  useEffect(()=>{
    const controller=new AbortController();setBusy(true);setError('')
    void fetch('/api/model-library/catalog',{method:'POST',headers:revision?{'X-Model-Catalog-Refresh':'1'}:undefined,signal:controller.signal}).then(async response=>{
      if(!response.ok){const body=await response.json().catch(()=>null);throw new Error(body?.error||'本机模型目录不可用，请使用本地工作台服务，或手动选择库文件。')}
      const result=await response.json() as Catalog
      if(!Array.isArray(result.models)||!Array.isArray(result.files))throw new Error('模型目录响应格式不正确')
      if(!controller.signal.aborted){setCatalog({...result,models:selectPreferredCatalogModels(result.models),files:result.files.filter(file=>['ltspice','tina','pspice'].includes(file.packageId??''))});setSelected(new Set());setPage(0)}
    }).catch(cause=>{if(!controller.signal.aborted)setError((cause as Error).message)}).finally(()=>{if(!controller.signal.aborted)setBusy(false)})
    return()=>controller.abort()
  },[revision])
  const baseResults=useMemo(()=>searchCatalog(catalog?.models??[],query,type,manufacturer).filter(model=>!packageId||preferredModelLibrary(model.source)===packageId),[catalog,query,type,packageId,manufacturer])
  const counts=useMemo(()=>categoryCounts(publicCatalogModels(baseResults)),[baseResults])
  const allCounts=useMemo(()=>categoryCounts(publicCatalogModels(catalog?.models??[])),[catalog])
  const modelVersions=useMemo(()=>{
    const groups=new Map<string,ImportedSpiceModel[]>()
    for(const model of filterCatalogByCategory(baseResults,category)){
      const key=publicKey(model),group=groups.get(key)??[];group.push(model);groups.set(key,group)
    }
    return groups
  },[baseResults,category])
  const results=useMemo(()=>[...modelVersions.entries()].map(([key,items])=>items.find(model=>catalogVersionKey(model)===versions[key])??items[0]),[modelVersions,versions])
  const activeGroup=category.split(':')[0]
  const manufacturers=useMemo(()=>[...new Set(catalog?.models.map(model=>model.metadata.mfg).filter(Boolean)??[])].sort((a,b)=>a.localeCompare(b)),[catalog])
  const pageCount=Math.max(1,Math.ceil(results.length/PAGE_SIZE)),currentPage=Math.min(page,pageCount-1)
  const visible=results.slice(currentPage*PAGE_SIZE,(currentPage+1)*PAGE_SIZE)
  const chosen=catalog?.models.filter(model=>selected.has(catalogVersionKey(model))&&!existing.has(model.id.toLowerCase()))??[]
  const unsupported=catalog?.files.reduce((total,file)=>total+file.rejected,0)??0
  function apply(){try{onImport(chosen);setSelected(new Set());setError('')}catch(cause){setError((cause as Error).message)}}
  function place(model:ImportedSpiceModel){try{const already=existing.get(model.id.toLowerCase());if(!already)onImport([model]);onPlace(already??model)}catch(cause){setError((cause as Error).message)}}
  return <section className="local-model-catalog" aria-label="离线与本机模型目录">
    <div className="catalog-intro"><FolderSearch size={25}/><div><h3>本地模型库</h3><p>默认 PSpice，缺少型号时由 LTspice、TINA 补充。选择型号、核对引脚，直接放置。</p></div><button disabled={busy} onClick={()=>setRevision(value=>value+1)}><RefreshCw size={14}/>{busy?'读取中…':'刷新目录'}</button><button type="button" onClick={onManual}>导入模型文件</button></div>
    {error&&<p className="spice-library-error" role="alert">{error}</p>}
    {busy&&!catalog&&<p className="catalog-loading" role="status">正在读取本地模型与符号…</p>}
    <AgentModelDownloads items={acquisitions} models={models} onImport={model=>onImportAcquired ? onImportAcquired(model) : onImport([model])} />
    <LocalLtspiceSymbols models={models} onImport={onImport} onPlace={onPlace}/>
    <details className="catalog-saved" open={models.length>0}>
      <summary>本工程已保存模型 · {models.length}</summary>
      {models.length ? <>
        <p>从搜索结果或文件导入的模型随工程保存。这里保留型号、来源、参数和原始定义；只有完成导入的模型会出现在此处。</p>
        <label className="catalog-saved-search"><Search size={15}/><input aria-label="搜索已保存模型" value={savedQuery} placeholder="搜索已保存型号、厂家或参数" onChange={event=>setSavedQuery(event.target.value)}/></label>
        <div className="catalog-saved-grid">{savedModels.map(model=><article key={model.id} className="catalog-saved-model"><div className="catalog-saved-heading"><ModelSymbolPreview model={model}/><div><strong>{model.id}</strong><small>{modelCategoryLabel(model)}{model.metadata.mfg?` · ${model.metadata.mfg}`:''} · {model.pins.join(' / ')}</small></div><button onClick={()=>onPlace(model)} aria-label={`放置已保存模型 ${model.id}`}><Plus size={13}/>放置</button></div>{onEditModel&&model.kind!=='X'&&<button className="catalog-edit-model" onClick={()=>onEditModel(model)} aria-label={`基于此模型修改参数 ${model.id}`}><SquarePen size={13}/>基于此模型修改参数</button>}<p>{model.detail}</p><dl className="catalog-model-parameters" aria-label={`${model.id} 已保存模型关键参数`}>{catalogModelParameters(model).map(parameter=><div key={parameter.key}><dt>{parameter.key}</dt><dd>{parameter.value}</dd></div>)}</dl><div className="catalog-saved-source"><span>来源：{model.source.url?<a href={model.source.url} target="_blank" rel="noreferrer noopener">{model.source.label}<ExternalLink size={12}/></a>:model.source.label}</span><small>{model.source.attribution&&`${model.source.attribution} · `}{model.source.license||'未提供许可说明'}</small></div><details><summary>查看 SPICE 定义</summary><pre><code>{model.spice}</code></pre></details></article>)}</div>
        {!savedModels.length&&<p className="catalog-loading">已保存模型中没有匹配结果。</p>}
      </>:<p>从下方选择本地模型，或到搜索页下载并导入；未导入的候选不会保存到工程。</p>}
    </details>
    {catalog&&<>
      <div className="catalog-summary"><strong>{publicCatalogModels(catalog.models).length.toLocaleString()}<span>可选型号</span></strong><div><span>本机 LTspice<b>{catalog.models.filter(model=>preferredModelLibrary(model.source)==='ltspice').length}</b></span><span>TINA 本地库<b>{catalog.files.filter(file=>file.packageId==='tina').reduce((total,file)=>total+file.accepted,0)}</b></span><span>PSpice 本地库<b>{catalog.files.filter(file=>file.packageId==='pspice').reduce((total,file)=>total+file.accepted,0)}</b></span><span>未兼容记录<b>{unsupported}</b></span></div></div>
      <>
        <div className="catalog-filters"><label><Search size={16}/><input aria-label="搜索本机模型" value={query} placeholder="搜索型号 / 厂家 / 分类 / 参数，如肖特基、IRF、BF=200…" onChange={event=>{setQuery(event.target.value);setPage(0)}}/></label><select aria-label="模型来源包" value={packageId} onChange={event=>{setPackageId(event.target.value);setPage(0)}}><option value="">PSpice 优先（全部库）</option><option value="pspice">PSpice 本地库</option><option value="ltspice">本机 LTspice</option><option value="tina">TINA 本地库</option></select><select aria-label="本机模型器件类型" value={type} onChange={event=>{setType(event.target.value);setCategory('');setPage(0)}}><option value="">全部器件类型</option>{Object.entries(modelTypeLabels).map(([value,label])=><option key={value} value={value}>{label} · {publicCatalogModels(catalog.models.filter(model=>model.type===value)).length}</option>)}</select><select aria-label="筛选模型厂家" value={manufacturer} onChange={event=>{setManufacturer(event.target.value);setPage(0)}}><option value="">全部厂家</option>{manufacturers.map(name=><option key={name} value={name}>{name}</option>)}</select></div>
        <nav className="catalog-category-browser" aria-label="模型细分类"><div className="catalog-category-groups"><button type="button" aria-pressed={!category} onClick={()=>{setCategory('');setPage(0)}}>全部模型 <small>{counts.get('')??0}</small></button>{modelCategoryGroups.map(group=><button type="button" key={group.id} aria-pressed={activeGroup===group.id} onClick={()=>{setCategory(group.id);setPage(0)}}>{group.label} <small>{counts.get(group.id)??0}</small></button>)}</div>{activeGroup&&<div className="catalog-category-leaves" aria-label="细分型号"><button type="button" aria-pressed={category===activeGroup} onClick={()=>{setCategory(activeGroup);setPage(0)}}>全部{modelCategoryGroups.find(group=>group.id===activeGroup)?.label} <small>{counts.get(activeGroup)??0}</small></button>{modelCategories.filter(item=>item.group===activeGroup).map(item=><button type="button" key={item.id} aria-pressed={category===item.id} onClick={()=>{setCategory(item.id);setPage(0)}}>{item.label} <small>{counts.get(item.id)??0}</small></button>)}</div>}</nav>
        <details className="catalog-category-coverage"><summary>查看完整器件分类与本目录支持范围</summary><p>上方分类数量随搜索与来源筛选变化。下表统计完整目录；基础 R/L/C 可从器件库直接放置，电容、电感等外部宏模型另行计数。缺少来源证据的子电路归入“未分类子电路”。</p><div>{modelCategoryCoverage.map(family=><section key={family.group}><strong>{family.group}</strong><div className="catalog-category-coverage-items">{family.items.map(item=><span key={item.label}>{item.label}<b>{'builtIn' in item?'内置':('category' in item?allCounts.get(item.category)??0:0).toLocaleString()}</b></span>)}</div></section>)}</div></details>
        <div className="catalog-actions"><span>找到 {results.length} 个 · 已选 {chosen.length} / 还可导入 {Math.max(0,room)}</span><button disabled={!visible.some(model=>!existing.has(model.id.toLowerCase()))||room<=0} onClick={()=>setSelected(old=>{const next=new Set(old);for(const model of visible){if(!existing.has(model.id.toLowerCase())&&next.size<room)selectCatalogVersion(next,model,catalog?.models??[])}return next})}>选择本页</button><button disabled={!chosen.length} onClick={()=>setSelected(new Set())}>清空</button><button className="primary" disabled={!chosen.length||chosen.length>room} onClick={apply}><Plus size={14}/>导入所选（{chosen.length}）</button></div>
        <p className="model-symbol-note">默认选择 PSpice 兼容版本；缺失时由 LTspice、TINA 补充，同一型号保留各库版本可切换。厂商信息以原文件记载为准。符号标注逻辑引脚，封装管脚请核对规格书。</p>
        <div className="catalog-model-grid">{visible.map(model=>{
          const versionKey=catalogVersionKey(model),exists=existing.has(model.id.toLowerCase()),checked=selected.has(versionKey)
          const sourceVersions=modelVersions.get(publicKey(model))??[model]
          return <article key={model.id} className={checked&&!exists?'is-selected':undefined}>
            <label className="catalog-model-select">
              <input type="checkbox" aria-label={`选择本机模型 ${model.id}`} checked={checked&&!exists} disabled={exists||!checked&&chosen.length>=room} onChange={event=>setSelected(old=>{const next=new Set(old);event.target.checked?selectCatalogVersion(next,model,catalog?.models??[]):next.delete(versionKey);return next})}/>
              <ModelSymbolPreview model={model}/>
              <span className="catalog-model-name"><strong>{publicModelId(model.id,model.source)}</strong><small>{modelCategoryLabel(model)}{model.metadata.type?` · 原库：${model.metadata.type}`:''}</small><small>{modelSymbolDescription(model)}</small><small className="catalog-model-terminals">{modelTerminalDescription(model)}</small></span>
            </label>
            {sourceVersions.length>1?<label>模型库<select aria-label={`${model.id} 模型库`} value={versionKey} onChange={event=>{setVersions(old=>({...old,[publicKey(model)]:event.target.value}));setSelected(old=>{const next=new Set(old);for(const item of catalog?.models??[])if(publicKey(item)===publicKey(model))next.delete(catalogVersionKey(item));return next})}}>{sourceVersions.map(item=><option key={catalogVersionKey(item)} value={catalogVersionKey(item)}>{libraryName(item)} · {item.id}</option>)}</select></label>:<small>{libraryName(model)}</small>}
            <p>{model.metadata.mfg||'原库未注明厂家'}<span>{exists?<><Check size={11}/>工程已导入</>:'参数已识别'}</span></p>
            <dl className="catalog-model-parameters" aria-label={`${model.id} 模型关键参数`}>{catalogModelParameters(model).map(parameter=><div key={parameter.key}><dt>{parameter.key}</dt><dd>{parameter.value}</dd></div>)}</dl>
            <div className="catalog-model-bottom"><small>{model.metadata.vds?`${model.metadata.vds} V · `:''}{model.metadata.vpk?`${model.metadata.vpk} V · `:''}{model.metadata.vceo?`${model.metadata.vceo} V · `:''}{model.pins.length} 个逻辑端子</small><button disabled={!exists&&room<=0} onClick={()=>place(model)} aria-label={`${exists?'放置工程模型':'导入并放置'} ${model.id}`}><Plus size={13}/>{exists?'放置':'导入并放置'}</button></div>
            {onEditModel&&model.kind!=='X'&&<button className="catalog-edit-model" disabled={!exists&&room<=0} onClick={()=>onEditModel(model)} aria-label={`基于此模型修改参数 ${model.id}`}><SquarePen size={13}/>基于此模型修改参数</button>}
            <details className="catalog-model-code"><summary>查看 SPICE 代码 · {model.id}</summary><pre><code>{model.spice}</code></pre><p>{model.source.label} · {model.source.license}</p><p>{model.source.attribution}</p></details>
          </article>
        })}</div>
        {!results.length&&<p className="catalog-loading">本机已下载模型中没有匹配型号，登记目录的结果显示在下方。</p>}
        <MaterializedModelCatalog revision={revision} query={query} projectModels={models} onPlaceModel={onPlace} onImportAndPlaceModel={onImportAndPlaceModel??((model)=>{if(!existing.has(model.id.toLowerCase()))onImport([model]);onPlace(model)})}/>
        <div className="catalog-pagination"><button disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>上一页</button><span>第 {currentPage+1} / {pageCount} 页 · 每页 {PAGE_SIZE} 个</span><button disabled={currentPage>=pageCount-1} onClick={()=>setPage(currentPage+1)}>下一页</button></div>
      </>
      <details className="catalog-compatibility"><summary>兼容检查与来源 · {unsupported} 条定义暂不可导入</summary><p>“参数已识别”表示通过当前导入器检查，不代表所有型号均完成仿真或获得厂商精度认证。VDMOS 使用 ngspice 原生三端模型，未启用自热。未知参数、加密文件以及未通过静态检查或缺少依赖的子电路会保留明确拒绝原因。</p>{catalog.files.map(file=><div key={file.file}><strong>{file.file}</strong><span> · {file.available?`${file.accepted} 可选 / ${file.rejected} 未导入`:'未找到本机文件'}</span>{file.issues.length>0&&<ul>{file.issues.map((issue,index)=><li key={index}>{issue.count} 条：{issue.message}</li>)}</ul>}</div>)}<p>原始模型与符号保留来源及原条款。导出工程会包含所选模型定义与来源信息；软件库来源不代表厂商精度认证。</p></details>
    </>}
  </section>
}
