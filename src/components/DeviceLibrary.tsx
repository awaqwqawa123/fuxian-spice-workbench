import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Boxes, Search, X } from 'lucide-react'
import { DeviceSymbol } from './DeviceSymbol'
import { useWorkbenchDialog } from './AssistantWindow'
import { findLibraryParts, libraryCategories, commonLibraryParts, extendedLibraryParts, type LibraryPart } from '../core/library'
import type { ImportedSpiceModel } from '../core/spice-models'
import UserLibrary from './UserLibrary'
import DeviceModelResults, { type DeviceModelResultsProps } from './DeviceModelResults'
import LocalDeviceBrowser, { type LocalDeviceBrowserState } from './LocalDeviceBrowser'
import type { NetworkSymbolPreset } from '../core/net-symbol-presets'

const commonLabels:Record<string,string>={
  'base-R':'电阻','base-C':'电容','base-L':'电感','base-V':'电压源','base-I':'电流源',
  'base-D':'二极管','diode-schottky':'肖特基','diode-zener':'稳压管','diode-led':'LED',
  'base-Q':'NPN','transistor-pnp':'PNP','base-M':'N-MOS','mosfet-pmos':'P-MOS',
  'base-OPA':'运放','base-CMP':'比较器','base-SW':'开关','source-V-sine':'正弦源','source-V-pulse':'脉冲源',
}

function CommonPartButton({part,active,onPlace}:{part:LibraryPart;active?:string;onPlace:(part:LibraryPart)=>void}){
  return <button type="button" className={active===part.id?'common-device-button active':'common-device-button'}
    draggable aria-label={`放置${part.name}`} aria-pressed={active===part.id}
    data-library-part={part.id} title={`${part.name} · ${part.detail}\n点击或拖入画布；放置后调整参数`}
    onDragStart={event=>{event.dataTransfer.setData('application/x-fuxian-device',part.kind);event.dataTransfer.setData('application/x-fuxian-value',part.value);event.dataTransfer.setData('application/x-fuxian-library-part',part.id);event.dataTransfer.effectAllowed='copy'}}
    onClick={()=>onPlace(part)}>
    <svg viewBox={['OPA','CMP'].includes(part.kind)?'-72 -68 144 140':'-48 -46 96 92'} aria-hidden="true"><DeviceSymbol showPinLabels={false} device={{id:'preview',kind:part.kind,value:part.value,params:part.params,x:0,y:0,rotation:part.kind==='V'||part.kind==='I'?90:0}}/></svg>
    <span>{commonLabels[part.id]}</span>
  </button>
}

function PartCard({part,active,draggable=false,onPlace}:{part:LibraryPart;active?:string;draggable?:boolean;onPlace:(part:LibraryPart)=>void}) {
  return <button type="button" className={active===part.id?'active':''} draggable={draggable} title={`${part.name} · ${part.detail}`} onDragStart={draggable?e=>{e.dataTransfer.setData('application/x-fuxian-device',part.kind);e.dataTransfer.setData('application/x-fuxian-value',part.value);e.dataTransfer.setData('application/x-fuxian-library-part',part.id);e.dataTransfer.effectAllowed='copy'}:undefined} onClick={()=>onPlace(part)} aria-label={`放置${part.name}`}><svg viewBox={['RELAY','LDO','OPA','CMP'].includes(part.kind)?'-72 -68 144 140':'-48 -46 96 92'} aria-hidden="true"><DeviceSymbol device={{id:'preview',kind:part.kind,value:part.value,params:part.params,groundStyle:part.groundStyle,x:0,y:0,rotation:part.kind==='V'||part.kind==='I'?90:0}}/></svg><span>{part.name}<small>{part.detail||part.category}</small>{!!part.modelIds?.length&&<small>{part.modelIds.length} 个模型 · 放置后切换</small>}</span>{part.base&&part.kind.length<=2&&<kbd>{part.kind}</kbd>}</button>
}

function ExtensionLibraryDialog({search,onSearch,category,onCategory,active,onPlace,onClose,browseMode,onBrowseMode,localState,onLocalStateChange,projectModels,onImportAndPlaceLocalModel}:{search:string;onSearch:(value:string)=>void;category:string;onCategory:(value:string)=>void;active?:string;onPlace:(part:LibraryPart)=>void;onClose:()=>void;browseMode:'local'|'generic';onBrowseMode:(mode:'local'|'generic')=>void;localState:LocalDeviceBrowserState;onLocalStateChange:(state:LocalDeviceBrowserState)=>void;projectModels?:ImportedSpiceModel[];onImportAndPlaceLocalModel?:(model:ImportedSpiceModel)=>void|Promise<void>}) {
  const panel=useRef<HTMLElement>(null),input=useRef<HTMLInputElement>(null)
  const categories=libraryCategories.filter(name=>name==='全部'||extendedLibraryParts.some(part=>part.category===name))
  const effectiveCategory=categories.includes(category)?category:'全部'
  const matches=findLibraryParts(search,effectiveCategory).filter(part=>!part.base)
  const allMatches=findLibraryParts(search).filter(part=>!part.base)
  useWorkbenchDialog(panel,true,onClose)
  useEffect(()=>{if(browseMode==='generic')input.current?.focus();else panel.current?.querySelector<HTMLInputElement>('input[aria-label="搜索本地器件"]')?.focus()},[browseMode])
  return createPortal(<div className="workbench-window-backdrop extension-library-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
    <section ref={panel} id="extended-device-library" className="workbench-window extension-library-window" role="dialog" aria-modal="true" aria-label="拓展器件" aria-describedby="extension-library-hint" tabIndex={-1} onKeyDown={event=>event.stopPropagation()}>
      <header className="workbench-window-heading"><div><span className="workbench-window-kicker">LOCAL COMPONENT LIBRARIES</span><h2><Boxes size={23}/>拓展器件</h2><p id="extension-library-hint">默认优先 PSpice，缺少型号时由 LTspice、TINA 补充。选择型号和符号后，点击画布放置。</p></div><button type="button" aria-label="关闭拓展器件" title="关闭 (Esc)" onClick={onClose}><X size={20}/></button></header>
      <div className="extension-library-modes" role="group" aria-label="器件浏览范围"><button type="button" aria-pressed={browseMode==='local'} onClick={()=>onBrowseMode('local')}>本地器件 <small>PSpice 优先 · LTspice · TINA</small></button><button type="button" aria-pressed={browseMode==='generic'} onClick={()=>onBrowseMode('generic')}>通用器件 <small>{extendedLibraryParts.length} 种基础功能</small></button></div>
      {browseMode==='local'?<LocalDeviceBrowser state={localState} onStateChange={onLocalStateChange} projectModels={projectModels} onImportAndPlace={onImportAndPlaceLocalModel} onClose={onClose}/>:<div className="extension-library-body">
        <nav className="extension-library-categories" aria-label="拓展器件分类"><span>按功能浏览</span>{categories.map(name=><button type="button" key={name} aria-pressed={effectiveCategory===name} onClick={()=>onCategory(name)}>{name}<small>{name==='全部'?allMatches.length:allMatches.filter(part=>part.category===name).length}</small></button>)}</nav>
        <div className="extension-library-browser"><label className="extension-library-search"><Search size={17}/><input ref={input} aria-label="搜索拓展器件" placeholder="搜索信号源、继电器、MOSFET…" value={search} onChange={e=>onSearch(e.target.value)}/>{search&&<button type="button" aria-label="清除拓展器件搜索" onClick={()=>{onSearch('');input.current?.focus()}}><X size={15}/></button>}</label><div className="extension-library-result-heading"><strong>{effectiveCategory==='全部'?'全部拓展器件':effectiveCategory}</strong><span role="status">{matches.length} 项</span></div><div className="device-palette extension-library-cards">{matches.map(part=><PartCard key={part.id} part={part} active={active} onPlace={onPlace}/>)}</div>{!matches.length&&<div className="extension-library-empty"><Search size={25}/><strong>没有匹配的拓展器件</strong><p>试试“脉冲”“继电器”或其他分类。</p><button type="button" onClick={()=>{onSearch('');onCategory('全部');input.current?.focus()}}>查看全部拓展器件</button></div>}</div>
      </div>}
      <footer className="workbench-window-footer"><span>点击器件进入放置 · Esc 返回画布</span><button type="button" onClick={onClose}>返回画布</button></footer>
    </section>
  </div>,document.body)
}

export default function DeviceLibrary({search,onSearch,category,onCategory,onPlace,active,searchInput,projectModels,onPlaceModel,onImportAndPlaceModel,onImportAndPlaceLocalModel,onOpenModels}:{search:string;onSearch:(value:string)=>void;category:string;onCategory:(value:string)=>void;onPlace:(part:LibraryPart)=>void;active?:string;searchInput:RefObject<HTMLInputElement|null>;projectModels?:ImportedSpiceModel[];onPlaceModel?:(model:ImportedSpiceModel)=>void;onImportAndPlaceModel?:DeviceModelResultsProps['onImportAndPlaceModel'];onImportAndPlaceLocalModel?:(model:ImportedSpiceModel)=>void|Promise<void>;onOpenModels?:DeviceModelResultsProps['onOpenModels'];onPlaceNetworkSymbol?:(preset:NetworkSymbolPreset)=>void;activeNetworkSymbol?:string}) {
  const [extended,setExtended]=useState(false)
  const [section,setSection]=useState<'system'|'user'>('system')
  const [browseMode,setBrowseMode]=useState<'local'|'generic'>('local')
  const [localState,setLocalState]=useState<LocalDeviceBrowserState>({query:'',category:'',source:'',offset:0})
  const [genericSearch,setGenericSearch]=useState(''),[genericCategory,setGenericCategory]=useState(category)
  const lastSidebarQuery=useRef<string|undefined>(undefined)
  function openExtendedLibrary(){
    if(lastSidebarQuery.current!==search){
      setBrowseMode('local')
      setLocalState(state=>({...state,query:search,category:'',offset:0}))
      setGenericSearch(search);setGenericCategory('全部')
      lastSidebarQuery.current=search
    }
    setExtended(true)
  }
  const matches=findLibraryParts(search),searching=!!search.trim(),common=commonLibraryParts.filter(part=>matches.includes(part))
  return <div className="common-device-library">
    <label className="device-search"><Search size={14}/><input ref={searchInput} aria-label="搜索器件" placeholder="器件 / 型号，例如 TL431" value={search} onChange={e=>{onSearch(e.target.value);onCategory('全部')}}/><kbd>F2</kbd></label>
    <div className="user-library-switch" role="group" aria-label="器件库分类"><button type="button" aria-pressed={section==='system'} onClick={()=>setSection('system')}>常用器件</button><button type="button" aria-pressed={section==='user'} onClick={()=>setSection('user')}>自建库</button></div>
    {section==='user'?<UserLibrary search={search} projectModels={projectModels} onPlace={onPlaceModel}/>:<>
    <div className="library-section-heading"><span>{searching?'匹配常用器件':'点击或拖入画布'}</span><span>{common.length} 项</span></div>
    <div className="device-palette common-device-grid" role="group" aria-label="常用器件">{common.map(part=><CommonPartButton key={part.id} part={part} active={active} onPlace={onPlace}/>)}</div>
    {searching&&!common.length&&<p className="library-empty">常用器件中没有匹配项，可查找完整本地库。</p>}
    <button type="button" className="library-extension-toggle" aria-haspopup="dialog" aria-expanded={extended} aria-controls={extended?'extended-device-library':undefined} onClick={openExtendedLibrary}><Boxes size={16}/><span>拓展器件</span><small>完整本地库</small><ArrowUpRight size={14}/></button>
    {searching&&<p className="library-search-scope">打开拓展器件，搜索完整本地型号与通用器件。</p>}
    {searching&&<DeviceModelResults query={search} projectModels={projectModels} onPlaceModel={onPlaceModel} onImportAndPlaceModel={onImportAndPlaceModel} onOpenModels={onOpenModels}/>}
    </>}
    {extended&&<ExtensionLibraryDialog search={genericSearch} onSearch={setGenericSearch} category={genericCategory} onCategory={setGenericCategory} active={active} browseMode={browseMode} onBrowseMode={setBrowseMode} localState={localState} onLocalStateChange={setLocalState} projectModels={projectModels} onImportAndPlaceLocalModel={onImportAndPlaceLocalModel} onClose={()=>setExtended(false)} onPlace={part=>{setExtended(false);onPlace(part)}}/>}
  </div>
}
