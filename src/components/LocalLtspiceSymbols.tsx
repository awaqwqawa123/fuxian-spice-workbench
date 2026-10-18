import { useEffect, useRef, useState } from 'react'
import { Check, LoaderCircle, Search } from 'lucide-react'
import { parseSpiceLibrary, type ImportedSpiceModel } from '../core/spice-models'
import { validateLtspicePinOrder } from '../core/ltspice-symbol'
import { resolveModelFunctionalSymbol } from '../core/model-functional-symbol'
import type { LocalSymbolCatalog, LocalSymbolDetail, LocalSymbolEntry } from '../../server/ltspice-symbol-library'
import { LtspiceSymbolPreview } from './LtspiceSymbol'

async function request<T>(endpoint:'search'|'detail',body:object,signal?:AbortSignal):Promise<T>{
  const response=await fetch(`/api/ltspice-symbols/${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal})
  const result=await response.json();if(!response.ok)throw new Error(result.error||'读取本机原始符号失败');return result as T
}
function matchingModel(detail:LocalSymbolDetail):{model?:ImportedSpiceModel;error?:string}{
  if(detail.modelError)return{error:detail.modelError}
  if(!detail.modelText)return{error:detail.item.reason}
  const parsed=parseSpiceLibrary(detail.modelText,{...detail.source,label:`${detail.source.label} / ${detail.sourceFile}`})
  const candidates=[detail.asy.value2,detail.asy.spiceModel,detail.asy.value,detail.item.id.split('/').at(-1)].filter(Boolean).map(value=>value!.toLowerCase())
  const model=parsed.models.find(item=>String(item.kind)==='X'&&candidates.includes(item.id.toLowerCase()))
  if(!model)return{error:parsed.diagnostics.find(item=>item.severity==='error')?.message||`关联文件中找不到与 ${detail.item.name} 对应且受支持的 .subckt；不会自动选取其他型号`}
  try{validateLtspicePinOrder(detail.asy.symbol,model.pins)}catch(error){return{error:(error as Error).message}}
  const linked:ImportedSpiceModel={...model,symbol:detail.asy.symbol as unknown as ImportedSpiceModel['symbol'],source:{...model.source,...(detail.symbolSource?{attribution:`${model.source.attribution??model.source.label}。图形来源：${detail.symbolSource.label}；${detail.symbolSource.url??''}；${detail.item.format?.toUpperCase()||'ASY'}。`.slice(0,1000)}:{})}}
  linked.symbol=resolveModelFunctionalSymbol(linked,detail.modelText)??linked.symbol
  return{model:linked}
}
export default function LocalLtspiceSymbols({models,onImport,onPlace}:{models:ImportedSpiceModel[];onImport:(models:ImportedSpiceModel[])=>void;onPlace:(model:ImportedSpiceModel)=>void}){
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[offset,setOffset]=useState(0),[catalog,setCatalog]=useState<LocalSymbolCatalog>(),[selected,setSelected]=useState<LocalSymbolEntry>(),[detail,setDetail]=useState<LocalSymbolDetail>(),[busy,setBusy]=useState(false),[detailBusy,setDetailBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false),[refresh,setRefresh]=useState(0)
  const lastRefresh=useRef(0)
  useEffect(()=>{if(!open)return;const controller=new AbortController(),force=refresh!==lastRefresh.current;setBusy(true);setError('');const timer=setTimeout(()=>{lastRefresh.current=refresh;void request<LocalSymbolCatalog>('search',{query,offset,refresh:force},controller.signal).then(setCatalog).catch(cause=>{if(!controller.signal.aborted)setError((cause as Error).message)}).finally(()=>{if(!controller.signal.aborted)setBusy(false)})},query?250:0);return()=>{clearTimeout(timer);controller.abort()}},[open,query,offset,refresh])
  useEffect(()=>{if(!selected){setDetailBusy(false);return}const controller=new AbortController();setError('');setDetail(undefined);setConfirmed(false);setDetailBusy(true);void request<LocalSymbolDetail>('detail',{id:selected.id},controller.signal).then(value=>{if(!controller.signal.aborted)setDetail(value)}).catch(cause=>{if(!controller.signal.aborted)setError((cause as Error).message)}).finally(()=>{if(!controller.signal.aborted)setDetailBusy(false)});return()=>controller.abort()},[selected])
  const resolved=detail?matchingModel(detail):undefined,model=resolved?.model,named=model&&models.find(item=>item.id.toLowerCase()===model.id.toLowerCase()),already=named&&model&&named.spice===model.spice?named:undefined,conflict=!!named&&!already
  function importSelected(place:boolean){if(!model||!confirmed||conflict)return;try{if(!already)onImport([model]);if(place)onPlace(already??model);setError('')}catch(cause){setError((cause as Error).message)}}
  return <section className="ltspice-symbol-library" aria-label="本机原始器件符号库">
    <button type="button" className="ltspice-symbol-toggle" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>原始器件符号 · ASY / OLB {open?'收起':'浏览'}</button>
    {open&&<div className="ltspice-symbol-content"><p>查看本机与离线厂商库的真实图形和引脚。ASY 直接解析；OLB 显示实际转换出的符号。关联模型通过兼容检查及电气端口核对后，可带原始图形放入画布。</p>
      <div className="ltspice-symbol-controls"><label><Search size={16}/><input aria-label="搜索原始器件符号" placeholder="例如 TLV431、opamp、4N25" value={query} onChange={event=>{setQuery(event.target.value);setOffset(0);setSelected(undefined);setDetail(undefined);setConfirmed(false)}}/></label><button type="button" onClick={()=>{setSelected(undefined);setDetail(undefined);setRefresh(value=>value+1)}}>重新扫描</button></div>
      {error&&<p role="alert" className="spice-library-error">{error}</p>}{(busy||detailBusy)&&<p role="status"><LoaderCircle size={14} className="symbol-library-spinner"/>{detailBusy?'正在读取原始图形及关联模型…':'正在检索原始符号…'}</p>}
      {catalog&&<div className="ltspice-symbol-layout"><div className="ltspice-symbol-results"><strong>找到 {catalog.total} 个符号</strong>{catalog.items.map(item=><button type="button" key={item.id} className={selected?.id===item.id?'selected':''} onClick={()=>setSelected(item)}><span>{item.name}</span><small>{item.id} · {item.pinCount} 引脚 · {item.status==='linked'?'有关联模型':'仅供查看'}</small></button>)}{catalog.total>40&&<div className="ltspice-symbol-pages"><button disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-40))}>上一页</button><span>{offset+1}–{Math.min(offset+40,catalog.total)} / {catalog.total}</span><button disabled={offset+40>=catalog.total} onClick={()=>setOffset(offset+40)}>下一页</button></div>}</div>
        <div className="ltspice-symbol-detail">{detail?<><div className="ltspice-symbol-heading"><LtspiceSymbolPreview symbol={detail.asy.symbol} label={`${detail.item.name} ${detail.item.format==='olb'?'OLB 实际转换':'ASY 原始'}图形`}/><div><h4>{detail.item.name}</h4><p>{detail.item.description||'原符号未提供说明'}</p><small>{detail.item.format==='olb'?'OLB · 真实转换':'ASY · 原始图形'} · {detail.asy.symbol.pins.length} 引脚</small></div></div><p>{detail.item.reason}</p>
          {resolved?.error&&<p role="status" className="ltspice-symbol-warning">暂不可仿真导入：{resolved.error}</p>}
          {conflict&&<p role="alert" className="ltspice-symbol-warning">工程中已存在同名但电气定义不同的模型，无法自动覆盖。请先在工程模型中处理该同名变体。</p>}
          {model&&<><p className="ltspice-symbol-ready"><Check size={15}/>关联 .subckt {model.id} 已通过当前导入器检查；导入保留上方真实图形。仿真精度仍取决于模型适用范围。</p><table><caption>电气端口顺序核对</caption><thead><tr><th>电气顺序</th>{detail.physicalPinNumbers&&<th>物理引脚号</th>}<th>原始符号引脚</th><th>.subckt 端口</th></tr></thead><tbody>{detail.asy.symbol.pins.map((pin,index)=><tr key={pin.index}><td>{index+1}</td>{detail.physicalPinNumbers&&<td>{detail.physicalPinNumbers[index]}</td>}<td>{pin.label}</td><td>{model.pins[index]}</td></tr>)}</tbody></table><label className="ltspice-symbol-confirm"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>我已核对端口顺序和原厂规格书</label><div className="ltspice-symbol-actions"><button disabled={!confirmed||!!already||conflict} onClick={()=>importSelected(false)}>{already?'工程已导入':'导入工程'}</button><button disabled={!confirmed||conflict} onClick={()=>importSelected(true)}>{already?'放置到画布':'导入并放置'}</button></div></>}
          <small className="ltspice-symbol-source">{detail.source.label} · {detail.source.license}</small>{detail.symbolSource&&<small className="ltspice-symbol-source">图形来源：{detail.symbolSource.label}</small>}</>:<p>选择左侧符号，查看真实图形、引脚与关联 SPICE 模型。</p>}</div></div>}
    </div>}
  </section>
}
