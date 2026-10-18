import { Download, ExternalLink, FileCode2 } from 'lucide-react'
import { useState } from 'react'
import type { AgentModelAcquisition } from '../core/agent-models'
import { SPICE_LIBRARY_LIMITS, type ImportedSpiceModel } from '../core/spice-models'

function saveSource(item:AgentModelAcquisition) {
  const url=URL.createObjectURL(new Blob([item.text],{type:'text/plain;charset=utf-8'})),link=document.createElement('a')
  link.href=url;link.download=`${item.query.replace(/[^a-z0-9_.-]/gi,'_')||'spice-model'}.lib`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}

export default function AgentModelDownloads({items,models,onImport}:{items:AgentModelAcquisition[];models:ImportedSpiceModel[];onImport:(model:ImportedSpiceModel)=>void}) {
  const [error,setError]=useState('')
  function importModel(model:ImportedSpiceModel){try{onImport(model);setError('')}catch(reason){setError((reason as Error).message)}}
  if(!items.length)return null
  const saved=new Set(models.map(model=>model.id.toLowerCase()))
  const room=SPICE_LIBRARY_LIMITS.projectModels-models.length
  return <section className="assistant-model-downloads library-acquisitions" aria-label="助手找到的模型">
    <header><FileCode2 size={17}/><strong>助手找到的模型</strong><span>{items.length} 份源码</span></header>
    <p>这里展示助手下载的候选源码。只有点击“导入工程”后，兼容的模型定义才会随工程保存。</p>
    {error&&<p role="alert" className="spice-library-error">{error}</p>}
    <div className="library-acquisition-list">{items.map(item=>{
      const imported=item.models.filter(model=>saved.has(model.id.toLowerCase())).length
      const status=!item.models.length?'暂不兼容':imported===item.models.length?'工程已保存':`${item.models.length-imported} 个待导入`
      return <details key={item.id} className="assistant-model-download library-acquisition">
        <summary><span><strong>{item.query}</strong><small>{item.origin==='local-library'?'本机模型库':'联网下载'} · {item.source.label}</small></span><em>{status}</em></summary>
        <div className="library-acquisition-body">
          <div className="library-acquisition-source"><span>原始来源：{item.source.url?<a href={item.source.url} target="_blank" rel="noreferrer noopener">{item.source.label}<ExternalLink size={12}/></a>:item.source.label}</span>{item.source.license&&<small>许可：{item.source.license}</small>}{item.source.attribution&&<small>署名：{item.source.attribution}</small>}</div>
          {item.diagnostics.length>0&&<details className="library-acquisition-diagnostics"><summary>兼容性提示 · {item.diagnostics.length}</summary><ul>{item.diagnostics.map((entry,index)=><li key={index}>{entry.model?`${entry.model}：`:''}{entry.message}</li>)}</ul></details>}
          {item.models.length?<div className="library-acquisition-models">{item.models.map(model=>{
            const exists=saved.has(model.id.toLowerCase())
            return <article key={model.id} className="assistant-model-definition"><div><strong>{model.id} · {model.type}</strong><span>{exists?'工程已保存':'未导入工程'}</span></div><p>{model.detail}</p><div className="library-acquisition-actions"><button type="button" disabled={exists||room<=0} onClick={()=>importModel(model)}>{exists?'工程中已有此模型':room<=0?'工程模型数量已满':'导入工程（可撤销）'}</button>{item.importedModelIds.includes(model.id)&&!exists&&<small>该模型也包含在对话候选方案中。</small>}</div><details><summary>查看模型定义 · {model.id}</summary><pre><code>{model.spice}</code></pre></details></article>
          })}</div>:<p className="library-acquisition-unsupported">这份源码没有当前可直接导入的定义；请查看兼容性提示和原文。</p>}
          <details className="assistant-model-source"><summary>查看完整 SPICE 源码 · {item.name}</summary><pre><code>{item.text}</code></pre></details>
          <button type="button" onClick={()=>saveSource(item)}><Download size={13}/>保存源码 .lib</button>
        </div>
      </details>
    })}</div>
  </section>
}
