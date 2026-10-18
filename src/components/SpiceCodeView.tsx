import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Code2, SquarePen } from 'lucide-react'
import type { Project } from '../core/circuit'
import { spiceCodePreview } from '../core/spice-code'
import { projectModelParameters } from '../core/model-parameters'
import ModelParameterSummary from './ModelParameterSummary'

export default function SpiceCodeView({project,deviceId,modelId,onEditNetlist,onEditDeviceCode}:{project:Project;deviceId?:string;modelId?:string;onEditNetlist?:()=>void;onEditDeviceCode?:()=>void}) {
  const preview=useMemo(()=>{try{return{value:spiceCodePreview(project,deviceId,modelId),error:''}}catch(error){return{value:null,error:(error as Error).message}}},[project,deviceId,modelId])
  const parameters=useMemo(()=>{try{return projectModelParameters(project,deviceId,modelId)}catch{return null}},[project,deviceId,modelId])
  const [copied,setCopied]=useState(false),[copyError,setCopyError]=useState('')
  useEffect(()=>{setCopied(false);setCopyError('')},[preview])
  async function copy(){
    if(!preview.value)return
    try{await navigator.clipboard.writeText(preview.value.code);setCopied(true);setCopyError('')}
    catch{setCopyError('无法复制到剪贴板，请直接选中下方代码复制。')}
  }
  return <>{parameters&&<ModelParameterSummary summary={parameters}/>}<section className="spice-code-view" aria-label="SPICE 源码">
    <header><div><Code2 size={16}/><strong>{preview.value?.title??'SPICE 源码'}</strong></div><div className="spice-code-actions">{onEditDeviceCode&&<button type="button" onClick={onEditDeviceCode} aria-label="编辑器件 SPICE 代码"><SquarePen size={14}/><span>编辑器件 SPICE 代码</span></button>}{onEditNetlist&&!deviceId&&!modelId&&<button type="button" onClick={onEditNetlist} aria-label="编辑 SPICE 网表"><SquarePen size={14}/><span>编辑 SPICE 网表</span></button>}<button type="button" onClick={()=>void copy()} disabled={!preview.value} aria-label="复制 SPICE 源码">{copied?<Check size={14}/>:<Copy size={14}/>}<span>{copied?'已复制':'复制'}</span></button></div></header>
    {preview.value?<><pre tabIndex={0} aria-label="当前 SPICE 代码"><code>{preview.value.code}</code></pre><p className="spice-code-note">{preview.value.note}</p></>:<p className="spice-code-error" role="status">{preview.error}</p>}
    {copyError&&<p className="spice-code-error" role="status">{copyError}</p>}
  </section></>
}
