import type { ModelDownloadPreview, ModelSearchResults } from './model-search'

function waitForRetry(milliseconds:number,signal:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new DOMException('查询已取消','AbortError'));return}
    const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(new DOMException('查询已取消','AbortError'))}
    const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve()},milliseconds)
    signal.addEventListener('abort',cancel,{once:true})
  })
}

async function post<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  for(let attempt=0;;attempt++){
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
    const value = await response.json().catch(() => null)
    if(!response.ok&&(response.status===429||response.status===503)&&attempt<2){
      const seconds=Number(response.headers.get('Retry-After'))
      await waitForRetry(Number.isFinite(seconds)&&seconds>0?Math.min(4000,seconds*1000):600*(attempt+1),signal)
      continue
    }
    if (!response.ok) throw new Error(value?.error || `器件模型服务请求失败（${response.status}），请确认工作台服务已启动`)
    if (!value) throw new Error('器件模型服务返回了无效结果，请重试')
    return value as T
  }
}

interface SharedLookup {controller:AbortController;promise:Promise<ModelSearchResults>;subscribers:number;settled:boolean}
const lookups=new Map<string,SharedLookup>()

/** Index lookup is deliberately separate from web discovery and assistant requests. */
export async function lookupDeviceModels(query: string, signal: AbortSignal): Promise<ModelSearchResults> {
  if(signal.aborted)throw new DOMException('查询已取消','AbortError')
  const key=query.trim().toUpperCase()
  let task=lookups.get(key)
  if(!task){
    const controller=new AbortController()
    const promise=post<ModelSearchResults>('/api/model-library/lookup',{query:query.trim()},controller.signal).then(value=>{
      if(!Array.isArray(value.candidates))throw new Error('器件索引结果格式不正确，请重新启动工作台服务')
      return value
    })
    task={controller,promise,subscribers:0,settled:false};lookups.set(key,task)
    const settle=()=>{task!.settled=true;if(lookups.get(key)===task)lookups.delete(key)}
    void promise.then(settle,settle)
  }
  const current=task;current.subscribers++
  return new Promise((resolve,reject)=>{
    let finished=false
    const cleanup=()=>{
      if(finished)return false
      finished=true;signal.removeEventListener('abort',cancel);current.subscribers--
      if(!current.subscribers&&!current.settled){current.controller.abort();if(lookups.get(key)===current)lookups.delete(key)}
      return true
    }
    const cancel=()=>{if(cleanup())reject(new DOMException('查询已取消','AbortError'))}
    signal.addEventListener('abort',cancel,{once:true})
    void current.promise.then(value=>{if(cleanup())resolve(value)},error=>{if(cleanup())reject(error)})
    if(signal.aborted)cancel()
  })
}

export async function downloadDeviceModel(id: string, signal: AbortSignal): Promise<ModelDownloadPreview> {
  const value = await post<ModelDownloadPreview>('/api/model-library/download', { id }, signal)
  if (!Array.isArray(value.models) || !Array.isArray(value.diagnostics)) throw new Error('模型下载结果格式不正确，请重试')
  return value
}
