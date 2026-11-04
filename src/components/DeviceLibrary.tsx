import { useEffect, useRef, useState, type RefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Boxes, LibraryBig, Search, X } from 'lucide-react'
import { DeviceSymbol } from './DeviceSymbol'
import { useWorkbenchDialog } from './AssistantWindow'
import MotionPresence from './MotionPresence'
import { findLibraryParts, libraryCategories, commonLibraryParts, extendedLibraryParts, type LibraryPart } from '../core/library'
import type { ImportedSpiceModel } from '../core/spice-models'
import UserLibrary from './UserLibrary'
import type { DeviceModelResultsProps } from './DeviceModelResults'
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

export type LibraryBrowseMode = 'local' | 'generic' | 'user' | 'models'
export interface LibraryDialogRequest { serial: number; mode: LibraryBrowseMode }

type ExtensionLibraryDialogProps = {
  search: string; onSearch: (value: string) => void; category: string; onCategory: (value: string) => void
  active?: string; onPlace: (part: LibraryPart) => void; onClose: () => void
  browseMode: LibraryBrowseMode; onBrowseMode: (mode: LibraryBrowseMode) => void
  localState: LocalDeviceBrowserState; onLocalStateChange: (state: LocalDeviceBrowserState) => void
  projectModels?: ImportedSpiceModel[]; onPlaceModel?: (model: ImportedSpiceModel) => void
  onImportAndPlaceLocalModel?: (model: ImportedSpiceModel) => void | Promise<void>
  renderModelManager?: (onClose: () => void) => ReactNode
}

function ExtensionLibraryDialog({search,onSearch,category,onCategory,active,onPlace,onClose,browseMode,onBrowseMode,localState,onLocalStateChange,projectModels,onPlaceModel,onImportAndPlaceLocalModel,renderModelManager}: ExtensionLibraryDialogProps) {
  const panel=useRef<HTMLElement>(null),input=useRef<HTMLInputElement>(null)
  const [userSearch,setUserSearch]=useState('')
  const modelManagerOpened=useRef(false)
  if(browseMode==='models')modelManagerOpened.current=true
  const categories=libraryCategories.filter(name=>name==='全部'||extendedLibraryParts.some(part=>part.category===name))
  const effectiveCategory=categories.includes(category)?category:'全部'
  const matches=findLibraryParts(search,effectiveCategory).filter(part=>!part.base)
  const allMatches=findLibraryParts(search).filter(part=>!part.base)
  useWorkbenchDialog(panel,true,onClose)
  useEffect(()=>{
    if(browseMode==='generic'||browseMode==='user')input.current?.focus()
    else if(browseMode==='local')panel.current?.querySelector<HTMLInputElement>('input[aria-label="搜索本地器件"]')?.focus()
  },[browseMode])
  return createPortal(<div className="workbench-window-backdrop extension-library-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
    <section ref={panel} id="extended-device-library" className="workbench-window extension-library-window extension-library-unified" role="dialog" aria-modal="true" aria-label="拓展器件" aria-describedby="extension-library-hint" tabIndex={-1} onKeyDown={event=>event.stopPropagation()}>
      <header className="workbench-window-heading"><div><span className="workbench-window-kicker">COMPONENT LIBRARY</span><h2><Boxes size={23}/>拓展器件</h2><p id="extension-library-hint">搜索本地型号、选用通用器件，或管理自建库与工程模型。选好器件后，点击画布放置。</p></div><button type="button" aria-label="关闭拓展器件" title="关闭 (Esc)" onClick={onClose}><X size={20}/></button></header>
      <div className="extension-library-modes" role="group" aria-label="器件浏览范围">
        <button type="button" aria-pressed={browseMode==='local'} onClick={()=>onBrowseMode('local')}>本地器件 <small>PSpice · LTspice · TINA</small></button>
        <button type="button" aria-pressed={browseMode==='generic'} onClick={()=>onBrowseMode('generic')}>通用器件 <small>{extendedLibraryParts.length} 种功能</small></button>
        <button type="button" aria-pressed={browseMode==='user'} onClick={()=>onBrowseMode('user')}>自建库</button>
        {renderModelManager&&<button type="button" aria-label="工程模型与导入页面" aria-pressed={browseMode==='models'} onClick={()=>onBrowseMode('models')}>工程模型与导入 <small>{projectModels?.length??0} 已导入</small></button>}
      </div>
      {browseMode==='local'?<LocalDeviceBrowser state={localState} onStateChange={onLocalStateChange} projectModels={projectModels} onImportAndPlace={onImportAndPlaceLocalModel} onClose={onClose}/>:browseMode==='user'?<div className="extension-library-user">
        <label className="extension-library-search"><Search size={17}/><input ref={input} aria-label="搜索自建器件" placeholder="搜索自建器件型号、名称或来源…" value={userSearch} onChange={event=>setUserSearch(event.target.value)}/></label>
        <UserLibrary search={userSearch} projectModels={projectModels} onPlace={onPlaceModel?model=>{onPlaceModel(model);onClose()}:undefined}/>
      </div>:browseMode==='models'?null:<div className="extension-library-body">
        <nav className="extension-library-categories" aria-label="拓展器件分类"><span>按功能浏览</span>{categories.map(name=><button type="button" key={name} aria-pressed={effectiveCategory===name} onClick={()=>onCategory(name)}>{name}<small>{name==='全部'?allMatches.length:allMatches.filter(part=>part.category===name).length}</small></button>)}</nav>
        <div className="extension-library-browser"><label className="extension-library-search"><Search size={17}/><input ref={input} aria-label="搜索拓展器件" placeholder="搜索信号源、继电器、MOSFET…" value={search} onChange={e=>onSearch(e.target.value)}/>{search&&<button type="button" aria-label="清除拓展器件搜索" onClick={()=>{onSearch('');input.current?.focus()}}><X size={15}/></button>}</label><div className="extension-library-result-heading"><strong>{effectiveCategory==='全部'?'全部拓展器件':effectiveCategory}</strong><span role="status">{matches.length} 项</span></div><div className="device-palette extension-library-cards">{matches.map(part=><PartCard key={part.id} part={part} active={active} onPlace={onPlace}/>)}</div>{!matches.length&&<div className="extension-library-empty"><Search size={25}/><strong>没有匹配的拓展器件</strong><p>试试“脉冲”“继电器”或其他分类。</p><button type="button" onClick={()=>{onSearch('');onCategory('全部');input.current?.focus()}}>查看全部拓展器件</button></div>}</div>
      </div>}
      {modelManagerOpened.current&&<div className="extension-library-model-manager" hidden={browseMode!=='models'}>{renderModelManager?.(onClose)}</div>}
      <footer className="workbench-window-footer"><span>点击器件进入放置 · Esc 返回画布</span><button type="button" onClick={onClose}>返回画布</button></footer>
    </section>
  </div>,document.body)
}

type DeviceLibraryProps = {
  search: string; onSearch: (value: string) => void; category: string; onCategory: (value: string) => void
  onPlace: (part: LibraryPart) => void; active?: string; searchInput: RefObject<HTMLInputElement|null>
  projectModels?: ImportedSpiceModel[]; onPlaceModel?: (model: ImportedSpiceModel) => void
  onImportAndPlaceModel?: DeviceModelResultsProps['onImportAndPlaceModel']
  onImportAndPlaceLocalModel?: (model: ImportedSpiceModel) => void | Promise<void>
  onOpenModels?: DeviceModelResultsProps['onOpenModels']
  onPlaceNetworkSymbol?: (preset: NetworkSymbolPreset) => void; activeNetworkSymbol?: string
  dialogRequest?: LibraryDialogRequest; onDialogChange?: (open: boolean) => void
  renderModelManager?: (onClose: () => void) => ReactNode
}

export default function DeviceLibrary({search,category,onPlace,active,projectModels,onPlaceModel,onImportAndPlaceLocalModel,dialogRequest,onDialogChange,renderModelManager}: DeviceLibraryProps) {
  const [extended,setExtended]=useState(false)
  const [browseMode,setBrowseMode]=useState<LibraryBrowseMode>('local')
  const [localState,setLocalState]=useState<LocalDeviceBrowserState>({query:'',category:'',source:'',offset:0})
  const [genericSearch,setGenericSearch]=useState(''),[genericCategory,setGenericCategory]=useState(category)
  const lastSidebarQuery=useRef<string|undefined>(undefined),dialogChanged=useRef(onDialogChange)
  const handledRequest=useRef(dialogRequest?.serial??0)
  dialogChanged.current=onDialogChange
  useEffect(()=>()=>dialogChanged.current?.(false),[])
  function closeExtendedLibrary(){setExtended(false);dialogChanged.current?.(false)}
  function openExtendedLibrary(mode?: LibraryBrowseMode){
    if(lastSidebarQuery.current!==search){
      if(!mode)setBrowseMode('local')
      setLocalState(state=>({...state,query:search,category:'',offset:0}))
      setGenericSearch(search);setGenericCategory('全部')
      lastSidebarQuery.current=search
    }
    if(mode)setBrowseMode(mode)
    setExtended(true);dialogChanged.current?.(true)
  }
  useEffect(()=>{
    if(!dialogRequest?.serial||handledRequest.current===dialogRequest.serial)return
    handledRequest.current=dialogRequest.serial
    setBrowseMode(dialogRequest.mode);setExtended(true);dialogChanged.current?.(true)
  },[dialogRequest?.serial,dialogRequest?.mode])
  return <div className="common-device-library">
    <div className="library-primary-actions" role="group" aria-label="器件库入口">
      <button type="button" className="library-primary-action library-user-toggle" aria-label="打开自建库" title="自建库 · 导入 SPICE 模型、管理与放置自己的器件" aria-haspopup="dialog" aria-expanded={extended&&browseMode==='user'} aria-controls={extended?'extended-device-library':undefined} onClick={()=>openExtendedLibrary('user')}><LibraryBig size={17}/><span className="library-action-copy"><strong>自建库</strong><small>我的器件 · 导入</small></span></button>
      <button type="button" className="library-primary-action library-extension-toggle library-catalog-toggle" aria-label="拓展器件 搜索 · 自建 · 导入 F2" title="拓展器件 · 搜索本地型号、自建库与导入模型 (F2)" aria-haspopup="dialog" aria-expanded={extended} aria-controls={extended?'extended-device-library':undefined} onClick={()=>openExtendedLibrary()}><Boxes size={17}/><span className="library-action-copy"><strong>拓展器件</strong><small>搜索 · 型号库</small></span></button>
    </div>
    <div className="library-section-heading"><span>常用器件</span><span>{commonLibraryParts.length} 项</span></div>
    <p className="library-placement-hint">点击放置 · 也可拖入画布</p>
    <div className="device-palette common-device-grid" role="group" aria-label="常用器件">{commonLibraryParts.map(part=><CommonPartButton key={part.id} part={part} active={active} onPlace={onPlace}/>)}</div>
    <MotionPresence present={extended}>{extended&&<ExtensionLibraryDialog search={genericSearch} onSearch={setGenericSearch} category={genericCategory} onCategory={setGenericCategory} active={active} browseMode={browseMode} onBrowseMode={setBrowseMode} localState={localState} onLocalStateChange={setLocalState} projectModels={projectModels} onPlaceModel={onPlaceModel} onImportAndPlaceLocalModel={onImportAndPlaceLocalModel} renderModelManager={renderModelManager} onClose={closeExtendedLibrary} onPlace={part=>{closeExtendedLibrary();onPlace(part)}}/>}</MotionPresence>
  </div>
}
