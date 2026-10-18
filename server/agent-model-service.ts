import { createHash } from 'node:crypto'
import type { AgentModelService } from '../src/core/agent-models'
import type { ModelDownloadPreview, ModelSearchCandidate, ModelSearchResults } from '../src/core/model-search'
import { parseSpiceLibrary } from '../src/core/spice-models'
import { readAvailableModelCatalog, readAvailableModelLookupCatalog, peekAvailableModelCatalog } from './model-library'
import { isBundledModelSource } from '../src/core/bundled-models'
import { createOnlineModelService } from './model-search'
import { parseModelSymbol } from '../src/core/model-symbol'
import { lookupMaterializedModels, readMaterializedModelPreview, readMaterializedLibraryStatus } from './local-model-store'
import { modelDeclarationMatch } from '../src/core/model-search-match'
import { enrichModelSymbols } from '../src/core/model-functional-symbol'
import { lookupTinaModels, readTinaModelPreview } from './tina-model-library'
import { lookupPspiceModels, readPspiceModelPreview } from './pspice-model-library'
import { isOwnedVendorModelSource } from '../src/core/installed-model-source'
import { preferredModelLibrary, isPreferredModelCandidate, comparePreferredModelCandidates, selectPreferredModelCandidates, isManufacturerModelCandidate } from '../src/core/model-source-policy'

/** Uses only the existing registered standard library files; no user-supplied paths. */
export function createAgentModelService(online:AgentModelService=createOnlineModelService(),readCatalog=readAvailableModelCatalog):AgentModelService & Required<Pick<AgentModelService,'lookup'>>{
  const local=new Map<string,ModelDownloadPreview>()
  let injectedCatalog:Awaited<ReturnType<typeof readAvailableModelCatalog>>|undefined,injectedPending:ReturnType<typeof readAvailableModelCatalog>|undefined,injectedCompletedAt=0
  function installedCatalog(){
    if(readCatalog===readAvailableModelCatalog)return peekAvailableModelCatalog()??readAvailableModelLookupCatalog()
    if(injectedPending)return injectedPending
    if(injectedCatalog&&Date.now()-injectedCompletedAt<5*60_000)return Promise.resolve(injectedCatalog)
    const pending=readCatalog().then(value=>{injectedCatalog=value;injectedCompletedAt=Date.now();return value}).finally(()=>{if(injectedPending===pending)injectedPending=undefined})
    injectedPending=pending;return pending
  }
  async function localLookup(query:string){
      if(typeof query!=='string'||!/^[a-z0-9][a-z0-9_. +\/-]{1,47}$/i.test(query.trim()))throw new Error('请输入器件型号，不接受模型路径或网址')
      const needle=query.trim().toLowerCase(),notices:string[]=[]
      let localAvailable=true,localFiles=0
      let matches:ModelSearchCandidate[]=[]
      // The downloaded catalogue is a light metadata index. Search it before
      // any installed-model/ASY scan, so common parts never wait on a full tree.
      try{
        matches=await lookupMaterializedModels(query)
        localFiles=(await readMaterializedLibraryStatus()).files
      }catch(error){localAvailable=false;notices.push(`批量本地模型目录暂不可用：${(error as Error).message}`)}
      try{matches.push(...await lookupTinaModels(query))}
      catch(error){notices.push(`TINA 本机目录暂不可用：${(error as Error).message}`)}
      try{matches.push(...await lookupPspiceModels(query))}
      catch(error){notices.push(`PSpice 本地目录暂不可用：${(error as Error).message}`)}
      try{
        // Even an unknown model must not start a cold macro/symbol tree scan.
        // The complete installed catalogue only supplements results when warm.
        const found=await installedCatalog()
        localFiles+=found.files.length
        const selected=found.models.filter(model=>preferredModelLibrary(model.source)&&!isOwnedVendorModelSource(model.source)&&modelDeclarationMatch(model.id,query)).sort((a,b)=>Number(b.id.toLowerCase()===needle)-Number(a.id.toLowerCase()===needle)).slice(0,20)
        for(const model of selected){
          try{
          const id=createHash('sha256').update(JSON.stringify([model.source,model.spice])).digest('hex')
          // The local catalogue already canonicalizes the electrical definition.
          // Preserve its non-electrical manufacturer/rating fields as metadata too.
          const metadata=Object.entries(model.metadata).map(([key,value])=>{
            const quote=value.includes('"')?"'":'"'
            return value.includes(quote)?`${key}=${value}`:`${key}=${quote}${value}${quote}`
          }).filter(Boolean).join(' ')
          const text=`* 离线目录兼容性解析副本；电气参数保留，定义格式已规范化。\n* ${model.source.attribution??model.source.label}\n${metadata&&model.kind!=='X'?model.spice.replace(/\)$/,` ${metadata})`):model.spice}`
          const preview={...parseSpiceLibrary(text,model.source),source:model.source,text}
          const root=preview.models.find(item=>item.id===model.id)
          if(!root||root.spice!==model.spice||JSON.stringify(root.metadata)!==JSON.stringify(model.metadata))throw new Error(`本机模型 ${model.id} 的参数或目录信息不能完整往返，请从原文件手动导入`)
          // The display attachment came from the installed catalogue's exact
          // ASY binding. Revalidate it without replacing the electrical replay.
          if(model.symbol)root.symbol=parseModelSymbol(model.symbol,root.kind,root.pins)
          if(local.size>=240&&!local.has(id))local.delete(local.keys().next().value!)
          local.set(id,preview)
          matches.push({id,name:model.id,path:model.source.label,source:model.source,matchedModels:[model.id],origin:'local-library',availability:'ready',match:model.id.toLowerCase()===needle?'exact':'related'})
          }catch(error){localAvailable=false;notices.push((error as Error).message)}
        }
        if(matches.some(item=>item.name.toLowerCase()===needle))notices.push('离线模型目录有同名型号；继续检查公开来源与其他版本。')
        if(matches.some(item=>isBundledModelSource(item.source)&&item.name.toLowerCase()===`${needle}_ivfit`))notices.push('随附实测正向 DC 拟合仅用于正向直流，不包含击穿、结电容、恢复时间或温度特性；继续查找完整模型。')
      }catch(error){localAvailable=false;notices.push(`本地模型目录暂不可用：${(error as Error).message}`)}
    return {matches:matches.filter(isPreferredModelCandidate).sort(comparePreferredModelCandidates),notices,localFiles,localAvailable}
  }
  async function combine(query:string,remoteLookup:(query:string)=>Promise<ModelSearchResults>):Promise<ModelSearchResults>{
    const {matches,notices,localFiles,localAvailable}=await localLookup(query)
    try{
      const remote=await remoteLookup(query)
      const localIds=new Set(matches.map(item=>item.id))
      return{...remote,candidates:[...matches,...remote.candidates.filter(item=>!localIds.has(item.id)).map(item=>({...item,origin:'online' as const}))],notices:[...notices,...remote.notices],indexedFiles:remote.indexedFiles+localFiles,coverage:!localAvailable||remote.coverage==='partial'?'partial':'complete'}
    }catch(error){
      if(!matches.length)throw error
      return{candidates:matches,notices:[...notices,`登记模型源暂不可用，仍可预览本机模型：${(error as Error).message}`],indexedFiles:localFiles,coverage:'partial'}
    }
  }
  return{
    async lookup(query){
      // Never fall back to online.search: the sidebar must not wait for web IO.
      const result=await combine(query,async value=>{
        if(!online.lookup)throw new Error('登记模型检索服务未启用，请重新启动工作台')
        return online.lookup(value)
      })
      return {...result,candidates:selectPreferredModelCandidates(result.candidates)}
    },
    async search(query){const result=await combine(query,async value=>{
      const result=await online.search(value)
      return {...result,candidates:result.candidates.filter(isManufacturerModelCandidate)}
    });return {...result,candidates:[...selectPreferredModelCandidates(result.candidates),...result.candidates.filter(item=>!isPreferredModelCandidate(item)&&isManufacturerModelCandidate(item))]}},
    async download(id){
      const preview=structuredClone(local.get(id)??await readMaterializedModelPreview(id)??await readTinaModelPreview(id)??await readPspiceModelPreview(id)??await online.download(id))
      return enrichModelSymbols(preview,preview.text)
    },
  }
}
