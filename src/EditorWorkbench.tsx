import { canProbeCurrent } from './core/branch-currents'
import {MIN_CANVAS_ZOOM,MAX_CANVAS_ZOOM,stepCanvasZoom} from './core/canvas-zoom'
import { deviceCatalog, deviceKinds, modelFor, availableModels, pinsFor } from './core/devices'
import { advancedExamples, exampleProject, type ExampleId } from './core/examples'
import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createWorkspaceLayout, workspaceLayoutReducer, type SidebarId } from './core/workspace-layout'
import { readSidebarWidths, saveSidebarWidths, SIDEBAR_LIMITS, sizeWorkspace } from './core/sidebar-sizing'
import SidebarResizeHandle from './components/SidebarResizeHandle'
import { FolderOpen, Library, LoaderCircle, Maximize2, Minimize2, PanelRightClose, SlidersHorizontal, Sparkles, Network, ImageDown, ClipboardPaste, ClipboardList, Settings2, Tag, FlipHorizontal2, Search, Activity, ArrowDownToLine, BookOpen, Check, ChevronDown, CircleHelp, Code2, Copy, FilePlus2, Hand, Minus, MousePointer2, Pin, Play, Plus, Redo2, RotateCw, Save, ScanLine, Square, Trash2, Undo2, Upload, Waves, X, Zap, Boxes, BotMessageSquare, MoreHorizontal, WandSparkles } from 'lucide-react'
import { dcSweep, generateNetlist, parseProject, validateProject, type Analysis, type Project, type TemplateId } from './core/circuit'
import { compileDrawing, deviceNames, setNetLabel, sameTerminal, terminalKey, type Terminal, type Drawing, type Rotation, type XY, type NetLabelStyle } from './core/drawing'
import ConnectionWarnings from './components/ConnectionWarnings'
import { allItems, moveSelection, removeSelection, transformSelection } from './core/selection'
import { copySchematicSelection, pasteSchematicSelection, type SchematicClipboard } from './core/schematic-clipboard'
import { blankProject, editableProject, editorTemplate, redo, remember, undo, type UndoState } from './core/editor'
import { experimentHistory, type Result } from './core/results'
import EditorCanvas, { DeviceSymbol, isDeviceTool, type EditorTool } from './components/EditorCanvas'
import EmbeddedWaveformResults from './components/EmbeddedWaveformResults'
import SinglePageWorkspace, { readSinglePageLayout, type SinglePageWorkspaceMode } from './components/SinglePageWorkspace'
import FinalTestReportDialog from './components/FinalTestReportDialog'
import AppearanceSettings from './components/AppearanceSettings'
import { useAppearance, type AppearancePreferences } from './core/appearance'
import PersistenceNotice from './components/PersistenceNotice'
import InlineDeviceValue from './components/InlineDeviceValue'
import { simulationFeedback } from './core/simulation-feedback'
import type { WaveformSnapshot } from './components/WaveformWorkspace'
import { newCanvasWaveform, readCanvasWaveforms, readCanvasWaveformWarning, saveCanvasWaveforms, MAX_CANVAS_WAVEFORMS, type CanvasWaveform } from './core/canvas-waveform-store'
import type { WaveformSignal } from './core/waveform-workspace'
import type { WaveformFitRequest } from './components/WaveformWorkspace'
import { applySimulationProfile, initialSimulationProfiles, readSimulationProfiles, saveSimulationProfiles, simulationReferenceWarning, updateSimulationProfile, type SimulationProfiles } from './core/simulation-profiles'
import { parseWaveformSetup, waveformSetupIssues, type WaveformSetup } from './core/waveform-setup'
import { waveformIssueMessages } from './core/waveform-issue-display'
import { aiProjectFingerprint } from './core/ai'
import { circuitTitleFromReply } from './core/circuit-title'
import { requestCodexAgent } from './core/codex-client'
import SpiceNetlistEditor from './components/SpiceNetlistEditor'
import RefdesEditor from './components/RefdesEditor'
import { layoutSelection, type LayoutOperation } from './core/layout'
import { inspectNet, renameDevice } from './core/net-tools'
import { schematicSvg } from './core/export-svg'
import DeviceLibrary from './components/DeviceLibrary'
import SchematicSymbolsToolbar from './components/SchematicSymbolsToolbar'
import {type NetworkSymbolPreset} from './core/net-symbol-presets'
import SaveToUserLibrary, { SaveLibraryDialog } from './components/SaveToUserLibrary'
import { modelsForLibraryPlacement } from './core/user-library'
import DeviceParameters from './components/DeviceParameters'
import SourceParameters from './components/SourceParameters'
import SubcircuitParameters from './components/SubcircuitParameters'
import { isConfiguredSource, sourceDescription } from './core/sources'
import { deviceParameterDefinitions } from './core/device-parameters'
import { deviceExamples, deviceExampleProject, type DeviceExampleId } from './core/device-examples'
import type { LibraryPart } from './core/library'
import AiAssistant from './components/AiAssistant'
import { useDesktopCircuit } from './core/desktop-circuit-client'
import SpiceLibrary from './components/SpiceLibrary'
import { type ImportedSpiceModel } from './core/spice-models'
import type { ProbeMode } from './components/ProbeTray'
import ProbeToolbar from './components/ProbeToolbar'
import ConnectionCheck from './components/ConnectionCheck'
import { MAX_MEASUREMENT_PROBES, type Measurement } from './core/probes'
import { measurementProbeMarkers } from './core/probe-layout'
import { useProbeMarkerVisibility } from './core/probe-marker-visibility'
import { layoutElectricallyEquivalent } from './core/layout-electrical-equivalence'
import { useDcVoltages } from './core/use-dc-voltages'
import { DcVoltageToggle, DcVoltageNotice } from './components/DcVoltageControls'
import BiasInspectionPanel from './components/BiasInspectionPanel'
import { layoutBiasMeasurements } from './core/bias-display'
import { type BiasMeasurement } from './core/bias-inspection'
import type { WireCurrentTarget } from './core/wire-currents'
import { stableLayoutMeasurements } from './core/layout-probes'
import { parseProjectProbes, projectWithCandidateProbes, reconcileProjectProbes } from './core/project-probes'
import { importCircuit, exportLtspice } from './core/exchange'
import type { ProbeTarget, WireAnchor } from './core/probe-placement'
import { createWireCurrentTarget } from './core/wire-currents'
import { normalizeWireOverlaps, remapOverlapAnchor, remapOverlapMeasurements, remapOverlapTerminal, type WireOverlapResult } from './core/wire-overlap'
import TemplateGallery from './components/TemplateGallery'
import ModelEditorDialog from './components/ModelEditorDialog'
import ModelAcquisitionAssistant from './components/ModelAcquisitionAssistant'
import ManualModelBuilder from './components/ManualModelBuilder'
import ModelSearchDialog from './components/ModelSearchDialog'

import SpiceCodeView from './components/SpiceCodeView'
import { importSearchedModel, assignProjectModel } from './core/model-import-action'
import InspectorTabs, { type InspectorTab } from './components/InspectorTabs'
import type { ModelEditTarget } from './core/model-editor'
import SimulationSettings from './components/SimulationSettings'
import SettingsDialog from './components/SettingsDialog'
import AssistantSidebar from './components/AssistantSidebar'
import CircuitExplanationAssistant from './components/CircuitExplanationAssistant'
import type { AgentModelAcquisition } from './core/agent-models'
import CanvasContextMenu from './components/CanvasContextMenu'
import type { CanvasContextMenuItem, CanvasContextRequest } from './core/context-menu'

const STORAGE = 'fuxian-free-editor-v2'
const NO_MEASUREMENTS:Measurement[]=[]
const NO_BIAS_MEASUREMENTS:BiasMeasurement[]=[]
interface EditorSnapshot {
  project:Project
  waveformSetup:WaveformSetup
  diagramPast:CanvasWaveform[][]
  diagramFuture:CanvasWaveform[][]
  undoScope?:'circuit'|'project'
}
function persistentWaveformSetup(setup:WaveformSetup):WaveformSetup {
  return {...setup,diagrams:setup.diagrams.map(({resultId:_resultId,view,...diagram})=>({...diagram,...(view?{view}:{})}))}
}
function initialSnapshot(seed:Project,storageId:string):EditorSnapshot {
  const project=initialProject(seed),profiles=project.waveformSetup?updateSimulationProfile(project.waveformSetup.profiles,project):readSimulationProfiles(localStorage,storageId,project)
  const waveformSetup=project.waveformSetup?{...project.waveformSetup,profiles}:{version:1 as const,profiles,diagrams:readCanvasWaveforms(localStorage,storageId,project.drawing!,profiles.activeId)}
  return {project:project.waveformSetup?{...project,waveformSetup}:project,waveformSetup,diagramPast:[],diagramFuture:[]}
}
function snapshotWithWaveforms(snapshot:EditorSnapshot,waveformSetup:WaveformSetup,persist:boolean):EditorSnapshot {
  return {...snapshot,waveformSetup,project:persist?{...snapshot.project,waveformSetup:persistentWaveformSetup(waveformSetup)}:snapshot.project}
}
function navigateCircuitHistory(state:UndoState<EditorSnapshot>,direction:'undo'|'redo'):UndoState<EditorSnapshot>{
  const next=direction==='undo'?undo(state):redo(state)
  if(next===state)return state
  const scope=direction==='undo'?state.present.undoScope:next.present.undoScope
  if(scope!=='circuit')return next
  const setup={...next.present.waveformSetup,diagrams:state.present.waveformSetup.diagrams}
  const present=snapshotWithWaveforms(next.present,setup,state.present.project.waveformSetup!==undefined)
  return {...next,present:{...present,diagramPast:state.present.diagramPast,diagramFuture:state.present.diagramFuture}}
}
interface EditorCandidateUndo {before:EditorSnapshot;afterFingerprint:string}
const candidateUndoKey=(projectId:string)=>`fuxian.editor-candidate-undo.v1:${encodeURIComponent(projectId)}`
const canonicalFingerprint=(fingerprint:string)=>JSON.stringify(JSON.parse(fingerprint),(_key,value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value)
function readCandidateUndo(projectId?:string):EditorCandidateUndo[]{
  if(!projectId)return []
  try{
    const raw=localStorage.getItem(candidateUndoKey(projectId))
    if(!raw||raw.length>5_000_000)return []
    const entries:unknown=JSON.parse(raw)
    if(!Array.isArray(entries))return []
    return entries.slice(-12).flatMap((entry):EditorCandidateUndo[]=>{
      try{
        if(!entry||typeof entry!=='object'||typeof entry.afterFingerprint!=='string'||entry.afterFingerprint.length>500_000)return []
        JSON.parse(entry.afterFingerprint)
        const before=entry.before
        if(!before||typeof before!=='object')return []
        const project=parseProject(before.project,{allowDraft:true}),waveformSetup=parseWaveformSetup(before.waveformSetup,project)
        if(!waveformSetup)return []
        return [{before:{project,waveformSetup,diagramPast:[],diagramFuture:[]},afterFingerprint:entry.afterFingerprint}]
      }catch{return []}
    })
  }catch{return []}
}
function preparedProjectCommit(before:EditorSnapshot,raw:Project,replaceWaveforms=false){
  const clearWaveforms=replaceWaveforms&&raw.waveformSetup===undefined
  const explicit=replaceWaveforms||raw.waveformSetup!==undefined&&raw.waveformSetup!==before.project.waveformSetup
  const setup:WaveformSetup=clearWaveforms?{version:1,profiles:initialSimulationProfiles(raw),diagrams:[]}:explicit?structuredClone(raw.waveformSetup!):{...before.waveformSetup,profiles:updateSimulationProfile(before.waveformSetup.profiles,raw)}
  const complete=clearWaveforms?raw:{...raw,...(explicit||before.project.waveformSetup!==undefined?{waveformSetup:persistentWaveformSetup(setup)}:{})}
  const prepared=reconcileProjectProbes(before.project,complete)
  return {snapshot:{project:prepared.project,waveformSetup:setup,diagramPast:explicit?[]:before.diagramPast,diagramFuture:explicit?[]:before.diagramFuture,undoScope:explicit?'project' as const:'circuit' as const},notices:prepared.notices}
}
const analysisNames: Record<Analysis,string> = { ac:'AC 频率响应',noise:'噪声分析',tran:'瞬态分析',op:'DC 工作点',dc:'DC 扫描' }
function initialProject(seed:Project) {
  if(seed.template==='custom')return structuredClone(seed)
  try { const raw = localStorage.getItem(STORAGE); if (raw) { const p = parseProject(JSON.parse(raw),{allowDraft:true}); if(p.template === 'custom') return p } } catch { /* Keep the template available when browser storage is unavailable. */ }
  return editableProject(seed)
}
function download(name:string,text:string,type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text],{type})), a = document.createElement('a')
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000)
}
function Field({label,value,onChange,hint,type = 'text'}:{label:string;value:string | number;onChange:(value:string)=>void;hint?:string;type?:string}) {
  return <label className="field"><span>{label}</span><div className="input-wrap"><input type={type} value={value} onChange={e => onChange(e.target.value)} spellCheck={false}/></div>{hint && <small className="field-hint">{hint}</small>}</label>
}

export default function EditorWorkbench({seed,projectId,initialCodexSessionId,initialLeftPanel,examplesOpen,onExamplesOpenChange,onProjectChange,saveState,saveError,onRetrySave,shortcutsBlocked=false,projectPanel}:{seed:Project;projectId?:string;initialCodexSessionId?:string;initialLeftPanel?:'projects'|'library';onBack?:()=>void;examplesOpen?:boolean;onExamplesOpenChange?:(open:boolean)=>void;onProjectChange?:(project:Project)=>void;saveState?:'saved'|'saving'|'error';saveError?:string;onRetrySave?:()=>void;shortcutsBlocked?:boolean;projectPanel?:ReactNode}) {
  const [localExamplesOpen,setLocalExamplesOpen]=useState(false)
  const galleryOpen=examplesOpen??localExamplesOpen
  function changeExamples(open:boolean){setLocalExamplesOpen(open);onExamplesOpenChange?.(open)}
  const [timeline,setTimeline] = useState<UndoState<EditorSnapshot>>(() => ({past:[],present:initialSnapshot(seed,projectId??'standalone'),future:[]}))
  const project = timeline.present.project, drawing = project.drawing!
  const namingProject=useRef(project);namingProject.current=project
  const waveformApplications=useRef<EditorCandidateUndo[]>(readCandidateUndo(projectId))
  const desktopCircuit = useDesktopCircuit(projectId, project)
  const [layout,dispatchLayout]=useReducer(workspaceLayoutReducer,undefined,()=>({...createWorkspaceLayout(),leftPanel:initialLeftPanel??'library'}))
  const workspaceBody=useRef<HTMLDivElement>(null)
  const [sidebarWidths,setSidebarWidths]=useState(readSidebarWidths)
  const [sidebarTab,setSidebarTab]=useState<'waveform'|'properties'>('waveform')
  const [containerWidth,setContainerWidth]=useState(()=>typeof window==='undefined'?1440:window.innerWidth)
  const [compactLeftRequested,setCompactLeftRequested]=useState(false)
  const [showSimulation,setShowSimulation] = useState(false)
  const sizing=sizeWorkspace(containerWidth,sidebarWidths,{...layout,rightOpen:false,leftOpen:layout.leftOpen&&(containerWidth>=1100||compactLeftRequested)&&!(containerWidth<1500&&layout.aiOpen)})
  const leftVisible=sizing.visible.left,showAi=sizing.visible.ai
  const inspectorTab=layout.rightPanel
  function setInspectorTab(panel:InspectorTab){setSidebarTab('properties');setPageMode('split');dispatchLayout({type:'panel-right',panel})}
  const [aiMounted,setAiMounted]=useState(!!initialCodexSessionId)
  const [chatMounted,setChatMounted]=useState(!!initialCodexSessionId)
  const [explanationMounted,setExplanationMounted]=useState(false)
  const [modelAssistantMounted,setModelAssistantMounted]=useState(false)
  const [assistantTab,setAssistantTab]=useState<'chat'|'explain'>('chat')
  const [modelAcquisitions,setModelAcquisitions]=useState<AgentModelAcquisition[]>([])
  const receiveModelAcquisitions=useCallback((items:AgentModelAcquisition[])=>{if(items.length)setModelAcquisitions(previous=>{const merged=new Map(previous.map(item=>[item.id,item]));for(const item of items)merged.set(item.id,item);return [...merged.values()].slice(-9)})},[])
  function openAi(){setAiMounted(true);setChatMounted(true);setAssistantTab('chat');dispatchLayout({type:'open-ai'})}
  function selectAssistantTab(tab:'chat'|'explain'){setAssistantTab(tab);if(tab==='chat')setChatMounted(true);else setExplanationMounted(true)}
  function closeAi(){dispatchLayout({type:'close-ai'});if(assistantTab==='chat')setChatMounted(false);setAiMounted(false)}
  useEffect(()=>{if(initialCodexSessionId)dispatchLayout({type:'open-ai'})},[initialCodexSessionId])
  useEffect(()=>{
    const element=workspaceBody.current
    if(!element)return
    const update=()=>{const width=element.getBoundingClientRect().width;setContainerWidth(width>0?width:window.innerWidth)}
    update()
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(update)
    observer?.observe(element);window.addEventListener('resize',update)
    return()=>{observer?.disconnect();window.removeEventListener('resize',update)}
  },[])
  useEffect(()=>saveSidebarWidths(sidebarWidths),[sidebarWidths])
  function resizeHandle(id:SidebarId,label:string){return <SidebarResizeHandle label={label} controls={`workspace-${id}`} width={sizing.widths[id]} min={sizing.min[id]} max={sizing.max[id]} direction={id==='left'?1:-1} hidden={!sizing.visible[id] || id==='ai' && sizing.overlayAi} onResize={width=>setSidebarWidths(current=>({...current,[id]:width}))} onReset={()=>setSidebarWidths(current=>({...current,[id]:SIDEBAR_LIMITS[id].default}))}/>}
  const workspaceStyle={'--workspace-left-width':`${sizing.widths.left}px`,'--workspace-right-width':`${sizing.widths.right}px`,'--workspace-ai-width':`${sizing.widths.ai}px`} as CSSProperties
  const [showModels,setShowModels]=useState(false)
  const [modelLibraryInitialPage,setModelLibraryInitialPage]=useState<'local'|undefined>()
  function openModelLibrary(page?:'local'){setModelLibraryInitialPage(page);setShowModels(true)}
  const [netlistEditorMounted,setNetlistEditorMounted]=useState(false),[showNetlistEditor,setShowNetlistEditor]=useState(false)
  function openNetlistEditor(){setTool('select');setNetlistEditorMounted(true);setShowNetlistEditor(true)}
  const [modelSearchVisibleFor,setModelSearchVisibleFor]=useState<string>()
  const [modelAssistantDrop,setModelAssistantDrop]=useState<{projectId:string;file:File;requestId:number}>()
  const modelDropSequence=useRef(0)
  const modelSearchScope=projectId??'standalone'
  const showModelSearch=modelSearchVisibleFor===modelSearchScope
  useEffect(()=>{setModelSearchVisibleFor(undefined);setModelAssistantDrop(undefined)},[projectId])
  const probeTools=useRef<HTMLDivElement>(null)
  function openProbeTools(){probeTools.current?.querySelector<HTMLButtonElement>(`[data-probe-mode="${probeMode}"]`)?.focus()}
  const [modelTarget,setModelTarget]=useState<ModelEditTarget|null>(null)
  const [editingModel,setEditingModel]=useState<ModelEditTarget|null>(null)
  const [modelToSave,setModelToSave]=useState<ImportedSpiceModel|null>(null)
  const modelSaveCompletion=useRef<((saved:boolean)=>void)|undefined>(undefined)
  function finishModelSave(saved:boolean){modelSaveCompletion.current?.(saved);modelSaveCompletion.current=undefined}
  function requestModelSave(model:ImportedSpiceModel){
    finishModelSave(false)
    setModelToSave(structuredClone(model))
    return new Promise<boolean>(resolve=>{modelSaveCompletion.current=resolve})
  }
  function closeModelSave(){finishModelSave(false);setModelToSave(null)}
  useEffect(()=>{setModelToSave(null);return()=>finishModelSave(false)},[projectId])
  const [category,setCategory]=useState('全部'),[placement,setPlacement]=useState<LibraryPart|null>(null)
  const measurements=project.probes??NO_MEASUREMENTS,[selectedMeasurement,setSelectedMeasurement]=useState<string>()
  const [showProbeMarkers,setShowProbeMarkers]=useProbeMarkerVisibility()
  const pendingProbeNotices=useRef<string[]>([])
  const displayMeasurements=useMemo(()=>stableLayoutMeasurements(project,measurements),[project,measurements])
  const [probeMode,setProbeMode]=useState<ProbeMode>('voltage'),[probePositive,setProbePositive]=useState<Terminal|null>(null),probeSequence=useRef(0)
  probeSequence.current=Math.max(probeSequence.current,...measurements.map(measurement=>Number(measurement.id.slice(1))))
  const probePositiveAnchor=useRef<WireAnchor|undefined>(undefined)
  const [exchangeNotice,setExchangeNotice]=useState<string[]>([]),[pendingImport,setPendingImport]=useState<{project:Project;warnings:string[];format:string}|null>(null)
  const [search,setSearch]=useState(''), searchInput=useRef<HTMLInputElement>(null)
  const [highlightedNet,setHighlightedNet]=useState<Terminal|null>(null)
  const [labelTarget,setLabelTarget]=useState<Terminal|null>(null), [labelName,setLabelName]=useState('')
  const [labelStyle,setLabelStyle]=useState<NetLabelStyle>('text'),[labelRotation,setLabelRotation]=useState<Rotation>(0),[networkSymbol,setNetworkSymbol]=useState<NetworkSymbolPreset|null>(null)
  const [selection,setSelection] = useState<string[]>(()=>drawing.devices.some(p=>p.id==='C1')?['C1']:[])
  const selected=selection.length===1?selection[0]:null
  const selectionRef=useRef(selection);selectionRef.current=selection
  const [clipboard,setClipboard] = useState<SchematicClipboard|null>(null),clipboardRef=useRef<SchematicClipboard|null>(null)
  const [wireBend,setWireBend] = useState<'hv'|'vh'>('hv'), [fitSelection,setFitSelection] = useState(0)
  const [createProfile,setCreateProfile]=useState(false),[profileTarget,setProfileTarget]=useState<string|null>(null)
  const [settingsRunRequest,setSettingsRunRequest]=useState(0)
  function openSimulation(create=false,target:string|null=null){setCreateProfile(create);setProfileTarget(target);setShowSimulation(true)}
  const [showSettings,setShowSettings]=useState(false)
  const [showFinalReport,setShowFinalReport]=useState(false)
  function openSettings(){setShowSettings(true)}
  function closeSettings(){setShowSettings(false)}
  const [appearance,setAppearance,appearancePersistence]=useAppearance()
  const [previewAppearance,setPreviewAppearance]=useState<AppearancePreferences|null>(null)
  const [showAppearance,setShowAppearance]=useState(false)
  const [contextMenu,setContextMenu] = useState<CanvasContextRequest|null>(null)
  const inspectorScroll = useRef<HTMLDivElement>(null)
  const [parameterFocus,setParameterFocus]=useState(0)
  const [tool,setTool] = useState<EditorTool>('select'), [rotation,setRotation] = useState<Rotation>(0)
  useEffect(()=>{if(tool!=='label')setNetworkSymbol(null)},[tool])
  const [zoom,setZoom] = useState(1), [resetView,setResetView] = useState(0), [showNodes,setShowNodes] = useState(false)
  const [status,setStatus] = useState('选中器件可拖动；点击空心引脚开始接线。'), [storageError,setStorageError] = useState(false)
  const [localSaveIssues,setLocalSaveIssues]=useState<Record<string,string>>({})
  const updateLocalSaveIssue=useCallback((key:string,message:string)=>setLocalSaveIssues(old=>{
    if(old[key]===message||!old[key]&&!message)return old
    const next={...old};if(message)next[key]=message;else delete next[key];return next
  }),[])
  const [naming,setNaming] = useState(false), namingRequest=useRef<AbortController|null>(null)
  useEffect(()=>()=>namingRequest.current?.abort(),[])
  const [help,setHelp] = useState(false), [showIssues,setShowIssues] = useState(false), [view,setView] = useState<'canvas'|'netlist'>('canvas')
  const diagramStorageId=projectId??'standalone'
  const waveformSetup=timeline.present.waveformSetup,simulationProfiles=waveformSetup.profiles,diagrams=waveformSetup.diagrams
  const waveformWarnings=useMemo(()=>waveformSetupIssues(waveformSetup,project),[waveformSetup,project])
  const diagramHistory={past:timeline.present.diagramPast,present:diagrams,future:timeline.present.diagramFuture}
  const setDiagramHistory=useCallback((update:(history:UndoState<CanvasWaveform[]>)=>UndoState<CanvasWaveform[]>,persist=true)=>{
    setTimeline(previous=>{
      const snapshot=previous.present,setup=snapshot.waveformSetup,old={past:snapshot.diagramPast,present:setup.diagrams,future:snapshot.diagramFuture},next=update(old)
      if(next===old)return previous
      const changed=snapshotWithWaveforms(snapshot,{...setup,diagrams:next.present},persist)
      return {...previous,present:{...changed,diagramPast:next.past,diagramFuture:next.future}}
    })
  },[])
  const [expandedDiagramId,setExpandedDiagramId]=useState<string|null>(()=>{try{return localStorage.getItem(`fuxian.active-waveform-group:${projectId??'standalone'}`)}catch{return null}})
  const [pageMode,setPageMode]=useState<SinglePageWorkspaceMode>(()=>readSinglePageLayout(projectId??'standalone').mode)
  const rightVisible=!layout.maximized&&pageMode!=='schematic'&&sidebarTab==='properties'
  function showWaveformSidebar(){setSidebarTab('waveform');setPageMode(mode=>mode==='schematic'?'split':mode);if(layout.maximized)dispatchLayout({type:'toggle-maximize'});else if(layout.rightOpen)dispatchLayout({type:'close-right'})}
  function changeSidebarTab(tab:'waveform'|'properties'){if(tab==='waveform')showWaveformSidebar();else setInspectorTab(inspectorTab)}
  const [circuitFitMode,setCircuitFitMode]=useState<'auto'|'manual'>('auto')
  const [waveFitRequests,setWaveFitRequests]=useState<Record<string,WaveformFitRequest>>({})
  const [waveShowRequests,setWaveShowRequests]=useState<Record<string,number>>({})
  const fitSequence=useRef(0)
  const [activeProbeDiagramId,setActiveProbeDiagramId]=useState<string|null>(null)
  const [diagramProbeRequests,setDiagramProbeRequests]=useState<Record<string,{id:string;sequence:number;panel?:number}[]>>({})
  const pageDiagram=diagrams.find(item=>item.id===(expandedDiagramId??activeProbeDiagramId))??diagrams.find(item=>item.profileId===simulationProfiles.activeId)??diagrams[0]
  const inlineProfile=profileTarget?simulationProfiles.profiles.find(item=>item.id===diagrams.find(diagram=>diagram.id===profileTarget)?.profileId):undefined
  const inlineProject=inlineProfile?applySimulationProfile(project,inlineProfile):project
  const inlineProfiles=inlineProfile?{...simulationProfiles,activeId:inlineProfile.id}:simulationProfiles
  const [waveformStorageWarning,setWaveformStorageWarning]=useState(()=>readCanvasWaveformWarning(localStorage,diagramStorageId))
  const diagramProbeSequence=useRef(0)
  const [profileResults,setProfileResults]=useState<Record<string,Result>>({})
  const dcVoltages=useDcVoltages(project,profileResults,projectId??'standalone')
  const result=profileResults[simulationProfiles.activeId]??null
  const [profileHistory,setProfileHistory]=useState<Record<string,Result[]>>({})
  const [runningProfileId,setRunningProfileId]=useState<string|null>(null)
  const [profileFailures,setProfileFailures]=useState<Record<string,string>>({})
  const [dismissedFailures,setDismissedFailures]=useState<Record<string,string>>({})
  const [interruptedProfiles,setInterruptedProfiles]=useState<Record<string,boolean>>({})
  const activeFailure=profileFailures[simulationProfiles.activeId]??''
  const visibleFailure=activeFailure&&dismissedFailures[simulationProfiles.activeId]!==activeFailure?activeFailure:''
  const [running,setRunning] = useState(false), [progress,setProgress] = useState('')
  const pageProfile=simulationProfiles.profiles.find(item=>item.id===pageDiagram?.profileId)
  const pageProbeResult=pageDiagram?.resultId?(profileHistory[pageDiagram.profileId]??[]).find(item=>item.id===pageDiagram.resultId)??null:profileResults[pageDiagram?.profileId??'']??null
  const pageProbeStale=useMemo(()=>!!pageProbeResult&&!!pageProfile&&!layoutElectricallyEquivalent(pageProbeResult.experiment??pageProbeResult.project,applySimulationProfile(project,pageProfile)),[pageProbeResult,pageProfile,project])
  useEffect(()=>{if(pageDiagram){try{localStorage.setItem(`fuxian.active-waveform-group:${projectId??'standalone'}`,pageDiagram.id)}catch{/* Keep active selection in this session. */}}},[pageDiagram?.id,projectId])
  function fitBoth(){setCircuitFitMode('auto');setResetView(value=>value+1);if(pageDiagram)setWaveFitRequests(old=>({...old,[pageDiagram.id]:{sequence:++fitSequence.current,kind:'fit'}}))}
  function locateWaveformSignal(signal:WaveformSignal){
    if(signal.measurementId){const probe=measurements.find(item=>item.id===signal.measurementId);if(probe?.kind==='voltage')setHighlightedNet(probe.positive);else if(probe?.kind==='current'&&probe.device)setSelection([probe.device]);setStatus(`${signal.name} → 对应电路测量点`);return}
    const match=signal.id.match(/^(voltage|current):[vi]\(([^)]+)\)$/i)
    if(!match)return
    if(match[1]==='current'){const part=drawing.devices.find(item=>item.id.toLowerCase()===match[2].toLowerCase());if(part)setSelection([part.id]);return}
    const node=match[2].toLowerCase(),entry=[...compileDrawing(drawing).nodes.entries()].find(([,value])=>value.toLowerCase()===node)
    if(!entry)return
    const key=entry[0];setHighlightedNet(key.includes(':')?{device:key.split(':')[0],pin:Number(key.split(':')[1])}:{junction:key})
  }
  function setFailure(message:string){setProfileFailures(old=>({...old,[simulationProfiles.activeId]:message}))}
  const patchDiagram=useCallback((id:string,patch:Partial<CanvasWaveform>)=>{
    if('profileId' in patch)setDiagramProbeRequests(old=>({...old,[id]:[]}))
    setTimeline(previous=>{
    const snapshot=previous.present,setup=snapshot.waveformSetup,old={past:snapshot.diagramPast,present:setup.diagrams,future:snapshot.diagramFuture}
    const next=old.present.map(item=>item.id===id?{...item,...patch,id:item.id}:item)
    if(JSON.stringify(next)===JSON.stringify(old.present))return previous
    const viewOnly=Object.keys(patch).length===1&&'view' in patch,oldView=old.present.find(item=>item.id===id)?.view
    // The first result initializes a view automatically. Keep that compatibility
    // state local until the user edits it; opening a legacy project is read-only.
    const initialView=viewOnly&&(!oldView||oldView.analysis!==patch.view?.analysis||JSON.stringify({...oldView,activePanel:oldView.activePanel??0})===JSON.stringify({...patch.view,activePanel:patch.view?.activePanel??0}))
    const persist=!initialView&&!(Object.keys(patch).length===1&&'resultId' in patch)
    const history=viewOnly?{...old,present:next}:remember(old,next),changed=snapshotWithWaveforms(snapshot,{...setup,diagrams:next},persist)
    return {...previous,present:{...changed,diagramPast:history.past,diagramFuture:history.future}}
    })
  },[])
  const snapshotDiagram=useCallback((_id:string,_snapshot:WaveformSnapshot)=>{},[])
  function addDiagram(copy?:CanvasWaveform){
    if(diagrams.length>=MAX_CANVAS_WAVEFORMS){setStatus(`最多支持 ${MAX_CANVAS_WAVEFORMS} 个图组。`);return}
    const next=newCanvasWaveform(drawing,copy?.profileId??simulationProfiles.activeId,diagrams,copy)
    setDiagramHistory(old=>remember(old,[...old.present,next]));setActiveProbeDiagramId(next.id);setExpandedDiagramId(next.id)
    setStatus(`已${copy?'复制':'新建'}图组 ${next.title}；电路视图保持。`)
  }
  function removeDiagrams(ids:string[]){
    setDiagramHistory(old=>remember(old,old.present.filter(item=>!ids.includes(item.id))))
    if(expandedDiagramId&&ids.includes(expandedDiagramId))setExpandedDiagramId(null)
    if(activeProbeDiagramId&&ids.includes(activeProbeDiagramId))setActiveProbeDiagramId(null)
    setStatus(`已移除 ${ids.length} 个图组；在图组管理中撤销可恢复。`)
  }
  function removeDiagram(id:string){removeDiagrams([id])}
  function selectProbe(id:string){
    setSelectedMeasurement(id)
    setSelection([]);setLabelTarget(null)
    const target=diagrams.find(item=>item.id===(expandedDiagramId??activeProbeDiagramId))??diagrams.find(item=>item.profileId===simulationProfiles.activeId)??diagrams[0]
    if(!target){setStatus(`已选择 ${id} 探针；Delete 删除，Ctrl+Z 撤销。`);return}
    setActiveProbeDiagramId(target.id);setExpandedDiagramId(target.id)
    const request={id,sequence:++diagramProbeSequence.current,panel:target.view?.activePanel??0}
    setDiagramProbeRequests(old=>({...old,[target.id]:[...(old[target.id]??[]),request].slice(-128)}))
    setStatus(`${id} → ${target.title} · 视图 ${request.panel+1}；未运行的配置将在仿真后显示。`)
  }
  function expandDiagram(id?:string){const chosen=diagrams.find(d=>d.id===id)??pageDiagram;if(!chosen)return;setActiveProbeDiagramId(chosen.id);setExpandedDiagramId(chosen.id)}
  function returnToDiagram(){setPageMode('schematic')}
  function selectSimulationProfile(id:string){const state=updateSimulationProfile(simulationProfiles,project),profile=state.profiles.find(p=>p.id===id);if(!profile)return;commit({...applySimulationProfile(project,profile),waveformSetup:persistentWaveformSetup({...waveformSetup,profiles:{...state,activeId:id}})});setStatus(`当前仿真配置：${profile.name}`)}
  const pendingSimulationProject=useRef<Project|null>(null)
  function applyProfiles(profiles:SimulationProfiles){
    const nextProject=pendingSimulationProject.current??project;pendingSimulationProject.current=null
    const nextSetup={...waveformSetup,profiles:profileTarget?{...profiles,activeId:simulationProfiles.activeId}:profiles,diagrams:profileTarget?diagrams.map(item=>item.id===profileTarget?{...item,profileId:profiles.activeId,resultId:undefined,view:undefined}:item):diagrams}
    const active=nextSetup.profiles.profiles.find(item=>item.id===nextSetup.profiles.activeId)
    const applied={... (active?applySimulationProfile(nextProject,active):nextProject),waveformSetup:persistentWaveformSetup(nextSetup)}
    commit(applied);setStatus(`已保存 ${profiles.profiles.length} 个仿真配置；各波形图可独立选择配置。`)
    return applied
  }
  function applySettingsAndRun(next:Project,profiles:SimulationProfiles){
    pendingSimulationProject.current=profileTarget?null:next
    const applied=applyProfiles(profiles),profile=profiles.profiles.find(item=>item.id===profiles.activeId)!
    run(applySimulationProfile(applied,profile),true,profile.id,profileTarget??undefined)
  }
  function runCurrentSimulation(){if(showSimulation)setSettingsRunRequest(value=>value+1);else run()}
  const persistWorkspace=useCallback(()=>{
    let profileSaved=false,diagramsSaved=false
    try{profileSaved=saveSimulationProfiles(localStorage,diagramStorageId,simulationProfiles)}catch{/* Storage may be unavailable. */}
    try{diagramsSaved=saveCanvasWaveforms(localStorage,diagramStorageId,diagrams)}catch{/* Keep edits in memory. */}
    updateLocalSaveIssue('profiles',profileSaved?'':'仿真配置的本地副本未保存')
    updateLocalSaveIssue('diagrams',diagramsSaved?'':'波形图组的本地副本未保存')
  },[simulationProfiles,diagrams,diagramStorageId,updateLocalSaveIssue])
  useEffect(persistWorkspace,[persistWorkspace])
  useEffect(()=>setWaveformStorageWarning(readCanvasWaveformWarning(localStorage,diagramStorageId)),[diagrams,diagramStorageId])
  useEffect(()=>{if(expandedDiagramId&&!diagrams.some(d=>d.id===expandedDiagramId))setExpandedDiagramId(null)},[diagrams,expandedDiagramId])
  useEffect(()=>{
    if(activeProbeDiagramId&&!diagrams.some(d=>d.id===activeProbeDiagramId))setActiveProbeDiagramId(null)
  },[diagrams,activeProbeDiagramId])
  const worker = useRef<Worker | null>(null), deadline = useRef<ReturnType<typeof setTimeout> | null>(null), started = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null),fileMenu=useRef<HTMLDetailsElement>(null),secondaryMenu=useRef<HTMLDetailsElement>(null),editMenu=useRef<HTMLDetailsElement>(null)
  useEffect(()=>{
    const closeOutside=(event:PointerEvent)=>{for(const menu of [fileMenu.current,secondaryMenu.current,editMenu.current])if(menu?.open&&!menu.contains(event.target as Node))menu.open=false}
    document.addEventListener('pointerdown',closeOutside)
    return()=>document.removeEventListener('pointerdown',closeOutside)
  },[])
  const errors = useMemo(()=>validateProject(project),[project]), topology = useMemo(()=>compileDrawing(drawing),[drawing])
  const device = drawing.devices.find(p => p.id === selected), selectedWire = drawing.wires.find(w => w.id === selected)
  const netInfo=useMemo(()=>highlightedNet&&topology.nodes.has(terminalKey(highlightedNet))?inspectNet(drawing,highlightedNet,topology.nodes):null,[drawing,highlightedNet,topology])
  const selectedDevices=drawing.devices.filter(p=>selection.includes(p.id))
  const stale = useMemo(()=>!!result && !layoutElectricallyEquivalent(result.experiment??result.project,project),[result,project])
  const runFeedback=simulationFeedback({result,running:running&&runningProfileId===simulationProfiles.activeId,progress,failure:activeFailure,stale,interrupted:interruptedProfiles[simulationProfiles.activeId]})
  const persistenceMessages=[...(storageError?['工程草稿未保存，修改仍在内存']:[]),...(saveState==='error'?[saveError||'工程自动保存失败，修改仍在内存']:[]),...Object.values(localSaveIssues),...(!appearancePersistence.persisted?[appearancePersistence.message||'外观偏好未保存']:[])]
  function retrySave(){persistWorkspace();if(onProjectChange){try{if(onRetrySave)onRetrySave();else onProjectChange(project);setStorageError(false)}catch{setStorageError(true)}}else{try{localStorage.setItem(STORAGE,JSON.stringify(project));setStorageError(false)}catch{setStorageError(true)}}if(!appearancePersistence.persisted)setAppearance(appearance)}
  const netlist=useMemo(()=>errors.length?'':generateNetlist(project),[project,errors])
  function commit(next:Project | ((p:Project)=>Project),application=false,replaceWaveforms=false,capture=false):Project|undefined {
    let committed:Project|undefined
    const update=()=>setTimeline(previous => {
      const before=previous.present,raw=typeof next === 'function'?next(before.project):next
      const prepared=preparedProjectCommit(before,raw,replaceWaveforms)
      if(capture)committed=prepared.snapshot.project
      pendingProbeNotices.current.push(...prepared.notices)
      if(application){waveformApplications.current.push({before,afterFingerprint:aiProjectFingerprint(prepared.snapshot.project)});if(waveformApplications.current.length>40)waveformApplications.current.shift()}
      return remember(previous,prepared.snapshot)
    })
    if(capture)flushSync(update);else update()
    if(application&&projectId)try{
      localStorage.setItem(candidateUndoKey(projectId),JSON.stringify(waveformApplications.current.slice(-12).map(({before,afterFingerprint})=>({before:{project:before.project,waveformSetup:persistentWaveformSetup(before.waveformSetup)},afterFingerprint}))))
    }catch{setExchangeNotice(previous=>[...previous,'浏览器未能持久保存方案撤销快照；当前页面仍可撤销，请导出工程备份。'])}
    setFailure('')
    return committed
  }
  async function nameCircuit(){
    if(namingRequest.current||!drawing.devices.length)return
    const snapshot=structuredClone(project),fingerprint=aiProjectFingerprint(snapshot),controller=new AbortController()
    namingRequest.current=controller;setNaming(true);setStatus('正在用本机 Codex 识别电路并拟定名称…')
    try{
      const response=await requestCodexAgent({project:snapshot,prompt:'请先用 inspect_circuit 读取当前电路，只根据真实器件与连接识别电路功能。不要修改候选、不要运行仿真。最终只输出一个 6～30 字的中文电路名称，不要解释、编号或 Markdown。'},event=>{
        if(!controller.signal.aborted&&event.type==='tool'&&event.status==='running')setStatus(`AI 取名：${event.name==='inspect_circuit'?'正在读取电路':event.name}…`)
      },controller.signal)
      if(controller.signal.aborted)return
      if(aiProjectFingerprint(namingProject.current)!==fingerprint){setStatus('识别期间项目已编辑，未覆盖当前名称；可再次点击 AI 取名。');return}
      const title=circuitTitleFromReply(response.summary)
      commit(p=>({...p,title}));setStatus(`AI 已将项目命名为“${title}”，可在顶栏继续修改；Ctrl+Z 可撤销。`)
    }catch(error){if(!controller.signal.aborted)setStatus(`AI 取名未完成：${(error as Error).message}`)}
    finally{if(namingRequest.current===controller){namingRequest.current=null;setNaming(false)}}
  }
  function setMeasurements(next:Measurement[]|((previous:Measurement[])=>Measurement[])) {
    commit(p=>({...p,probes:typeof next==='function'?next(p.probes??[]):next}))
  }
  function overlapSelection(result:WireOverlapResult,ids:string[]) {
    return [...new Set(ids.flatMap(id=>{
      if(result.wireMap[id])return result.wireMap[id].map(span=>span.wireId)
      const terminal=result.terminalMap[id]
      return terminal?['junction' in terminal?terminal.junction:terminal.device]:[id]
    }))]
  }
  function remapOverlapUi(result:WireOverlapResult) {
    if(!result.changed)return
    setSelection(ids=>overlapSelection(result,ids))
    setHighlightedNet(at=>at?remapOverlapTerminal(result,at):null)
    setLabelTarget(at=>at?remapOverlapTerminal(result,at):null)
    setProbePositive(at=>at?remapOverlapTerminal(result,at):null)
    if(probePositiveAnchor.current)probePositiveAnchor.current=remapOverlapAnchor(result,probePositiveAnchor.current)??undefined
  }
  function overlapProbes(p:Project,result:WireOverlapResult):Pick<Project,'probes'> {
    if(!result.changed||p.probes===undefined)return p.probes===undefined?{}:{probes:p.probes}
    const mapped=remapOverlapMeasurements(result,p.probes),probes:Measurement[]=[]
    pendingProbeNotices.current.push(...mapped.notices)
    for(const measurement of mapped.measurements){try{probes.push(...parseProjectProbes([measurement],result.drawing)!)}catch(error){pendingProbeNotices.current.push(`已移除失效探针 ${measurement.id}：${(error as Error).message}；请重新放置，撤销可恢复。`)}}
    return {probes}
  }
  function updateDrawing(next:Drawing,preserveConnections=true) {
    // Geometry and parameter edits retain explicit connections, including after
    // restoring overlapping routes. Only deliberate new wiring merges spans.
    try {
      const mergeWireIds=preserveConnections?undefined:new Set(next.wires.filter(wire=>!drawing.wires.some(old=>old.id===wire.id)).map(wire=>wire.id))
      const normalized=normalizeWireOverlaps(next,{preserveConnections,mergeWireIds})
      commit(p=>{
        // Explicit removals are resolved against the raw edit first. Overlap
        // normalization then migrates surviving probes using its proven wire map.
        const removed=p.drawing && [
          p.drawing.wires.some(item=>!next.wires.some(other=>other.id===item.id)),
          p.drawing.devices.some(item=>!next.devices.some(other=>other.id===item.id)),
          p.drawing.junctions.some(item=>!next.junctions.some(other=>other.id===item.id)),
        ].some(Boolean)
        const pruned=removed?reconcileProjectProbes(p,{...p,drawing:next}):{project:p,notices:[]}
        pendingProbeNotices.current.push(...pruned.notices)
        const drawing=normalized.drawing
        const newSource=!p.drawing?.sourceId&&drawing.sourceId?drawing.devices.find(part=>part.id===drawing.sourceId&&part.kind==='V'):null
        return {...pruned.project,drawing,...overlapProbes(pruned.project,normalized),...(newSource?{source:{...p.source,dc:newSource.value}}:{})}
      })
      remapOverlapUi(normalized)
      return normalized
    }catch(error){setExchangeNotice(previous=>[...previous,(error as Error).message]);return null}
  }
  function mergeOverlappingWires() {
    try {
      const normalized=normalizeWireOverlaps(drawing)
      if(!normalized.changed){setStatus('没有需要合并的共线重叠段；普通交叉保持原连接。');return}
      commit(p=>({...p,drawing:normalized.drawing,...overlapProbes(p,normalized)}));remapOverlapUi(normalized)
      setStatus(`已合并 ${normalized.mergedSegments} 处重合线段，保留实际分支；Ctrl+Z 可一次撤销。`)
    }catch(error){setExchangeNotice(previous=>[...previous,(error as Error).message])}
  }
  function clearMeasurements(){setMeasurements([]);setSelectedMeasurement(undefined);setProbePositive(null)}
  function addMeasurement(candidate:Measurement) {
    setShowProbeMarkers(true)
    const key=(m:Measurement)=>m.kind==='current'?m.wire?`iw:${m.wire.wireId}`:`i:${m.device}`:`v:${topology.nodes.get(terminalKey(m.positive))}:${m.negative?topology.nodes.get(terminalKey(m.negative)):'0'}`
    const existing=measurements.find(m=>key(m)===key(candidate))
    const store=(probes:Measurement[])=>commit(p=>{
      const at=candidate.kind==='voltage'?candidate.positive:candidate.wire?topology.nodes.get(terminalKey(candidate.wire.from))==='0'?candidate.wire.to:candidate.wire.from:{device:candidate.device,pin:topology.nodes.get(`${candidate.device}:0`)==='0'?1:0} as Terminal
      return {...p,probes,...(!p.drawing!.output&&topology.nodes.get(terminalKey(at))!=='0'?{drawing:{...p.drawing!,output:at}}:{})}
    })
    if(existing){store(measurements.map(m=>m.id===existing.id?{...candidate,id:existing.id}:m));selectProbe(existing.id);setStatus(`已将 ${existing.id} 探针移到点击位置，仍读取同一网络。`);return}
    if(measurements.length>=MAX_MEASUREMENT_PROBES){setStatus(`最多同时添加 ${MAX_MEASUREMENT_PROBES} 个测量，请先移除不用的探针。`);return}
    store([...measurements,candidate]);selectProbe(candidate.id)
    setStatus(result&&!stale?'测量已添加，直接读取本次仿真结果。':'测量已添加，运行仿真查看波形。')
  }
  function nextProbeId(){if(probeSequence.current<Number.MAX_SAFE_INTEGER)return `P${++probeSequence.current}`;let id=1;while(measurements.some(measurement=>measurement.id===`P${id}`))id++;return `P${id}`}
  function inspectorProbe(at:Terminal){setProbePositive(null);setProbeMode('voltage');addMeasurement({id:nextProbeId(),kind:'voltage',positive:at})}
  function probeAt(at:Terminal,anchor?:WireAnchor) {
    if(probeMode==='current'){
      if(anchor){probeWire(anchor);return}
      const wires=drawing.wires.filter(w=>sameTerminal(w.from,at)||sameTerminal(w.to,at))
      if(wires.length===1)probeWire({wireId:wires[0].id,fraction:sameTerminal(wires[0].from,at)?0:1})
      else setStatus('请选择导线上的具体位置，以确定要测量哪一条支路的电流。')
      return
    }
    if(probeMode==='differential'&&!probePositive){setProbePositive(at);probePositiveAnchor.current=anchor;setStatus(`已选正端 ${terminalKey(at)}，点击负端完成差分测量。`);return}
    addMeasurement({id:nextProbeId(),kind:'voltage',positive:probeMode==='differential'?probePositive??at:at,positiveLayout:{anchor:probeMode==='differential'?probePositiveAnchor.current:anchor},...(probeMode==='differential'?{negative:at,negativeLayout:{anchor}}:{})});setProbePositive(null)
  }
  function probePair(positive:ProbeTarget,negative:ProbeTarget){setProbePositive(null);addMeasurement({id:nextProbeId(),kind:'voltage',positive:positive.at,negative:negative.at,positiveLayout:{anchor:positive.anchor},negativeLayout:{anchor:negative.anchor}})}
  function markerIdentity(label:string){return{id:label.replace(/[+−]$/,''),negative:label.endsWith('−')}}
  function moveProbeLabel(label:string,offset:XY){const key=markerIdentity(label);setMeasurements(ms=>ms.map(m=>{if(m.id!==key.id)return m;if(m.kind==='current')return{...m,layout:{...m.layout,offset}};const name=key.negative?'negativeLayout':'positiveLayout';return{...m,[name]:{...m[name],offset}}}))}
  function relocateProbe(label:string,target:ProbeTarget,offset?:XY){
    const key=markerIdentity(label),measurement=measurements.find(m=>m.id===key.id)
    if(measurement?.kind==='current'&&measurement.wire){
      if(!target.anchor){setStatus('请将电流钳拖到导线上的具体位置。');return}
      try{
        const wire=createWireCurrentTarget(drawing,target.anchor,measurement.wire.direction)
        setMeasurements(ms=>ms.map(m=>m.id===key.id?{id:m.id,kind:'current',wire,layout:{...(m.kind==='current'?m.layout:undefined),anchor:target.anchor,...(offset?{offset}:{})}}:m))
        setSelectedMeasurement(key.id);setStatus(`已移动 ${key.id} 电流钳；箭头为正方向。`)
      }catch(error){setStatus((error as Error).message)}
      return
    }
    if(measurement?.kind==='current'){setStatus('电流探针绑定器件支路；可拖动标牌，切换电流测量请点击另一个可测器件。');return}
    setMeasurements(ms=>ms.map(m=>{if(m.id!==key.id||m.kind!=='voltage')return m;return key.negative?{...m,negative:target.at,negativeLayout:{...m.negativeLayout,anchor:target.anchor,...(offset?{offset}:{})}}:{...m,positive:target.at,positiveLayout:{...m.positiveLayout,anchor:target.anchor,...(offset?{offset}:{})}}}))
    setSelectedMeasurement(key.id);setStatus(`已移动 ${key.id} 测量端点，电路连接保持不变。`)
  }
  const canvasProbeMarkers=useMemo(()=>measurementProbeMarkers(drawing,measurements).map(marker=>({...marker,selected:markerIdentity(marker.label).id===selectedMeasurement})),[drawing,measurements,selectedMeasurement])
  function probeWire(anchor:WireAnchor) {
    try{
      const wire=createWireCurrentTarget(drawing,anchor)
      setProbeMode('current');setProbePositive(null)
      addMeasurement({id:nextProbeId(),kind:'current',wire,layout:{anchor}})
    }catch(error){setStatus((error as Error).message)}
  }
  function reverseProbe(label:string){
    const {id}=markerIdentity(label)
    setMeasurements(ms=>ms.map(m=>m.id===id&&m.kind==='current'&&m.wire?{...m,wire:{...m.wire,direction:m.wire.direction===1?-1:1}}:m))
    setStatus(`${id} 电流正方向已反转，波形同步反号。`)
  }
  function probeDevice(id:string) {
    if(probeMode!=='current')return
    if(!drawing.devices.some(p=>p.id===id&&canProbeCurrent(p.kind))){setStatus('请点击 R/C/L/V/I/D 器件，多脚器件电流尚不支持。');return}
    addMeasurement({id:nextProbeId(),kind:'current',device:id})
  }
  function changeProbeMode(mode:ProbeMode){setProbeMode(mode);setProbePositive(null);chooseTool('probe')}
  function resetAppliedView(){setView('canvas');stop();setSelectedMeasurement(undefined);setProbePositive(null);probePositiveAnchor.current=undefined;setHighlightedNet(null);selectItem(null);setTool('select');setPlacement(null);setResetView(v=>v+1);setShowIssues(false)}
  function replaceProject(next:Project,application=false,replaceWaveforms=false) {commit(next,application,replaceWaveforms);resetAppliedView()}
  function placeImportedModel(model:ImportedSpiceModel) {
    chooseTool(model.kind);setPlacement({id:`imported-${model.id}`,kind:model.kind,name:model.id,detail:model.detail,value:model.id,category:'导入模型'});setShowModels(false);setStatus(`点击画布放置 ${model.id} · ${model.type}`)
  }
  function importAndPlaceLibraryModel(model:ImportedSpiceModel){
    const models=modelsForLibraryPlacement(project.models,model)
    if(JSON.stringify(models)!==JSON.stringify(project.models))commit(p=>({...p,models}))
    placeImportedModel(models.find(item=>item.id.toLowerCase()===model.id.toLowerCase())??model)
  }
  function placeLibraryModel(model:ImportedSpiceModel){
    try{importAndPlaceLibraryModel(model)}catch(error){setStatus((error as Error).message)}
  }
  function applyAi(next:Project,options?:{undo?:boolean;replace?:boolean}){
    try{
      if(options?.undo){
        const beforeKey=canonicalFingerprint(aiProjectFingerprint(next)),afterKey=canonicalFingerprint(aiProjectFingerprint(project))
        const saved=[...waveformApplications.current].reverse().find(record=>canonicalFingerprint(aiProjectFingerprint(record.before.project))===beforeKey&&canonicalFingerprint(record.afterFingerprint)===afterKey)
        if(saved){setTimeline(previous=>remember(previous,saved.before));resetAppliedView();setStatus('已撤销方案，原理图、探针及应用前的波形图配置已一起恢复。');return saved.before.project}
      }
      const prepared=options?.replace||options?.undo?{project:editableProject(next),notices:[]}:projectWithCandidateProbes(project,editableProject(next)),editable=prepared.project
      pendingProbeNotices.current.push(...prepared.notices)
      const applied=commit(editable,!options?.undo,!!options?.replace||!!options?.undo,true)!
      resetAppliedView()
      setStatus(options?.replace?'已恢复到方案生成时并应用方案；原理图、探针与波形图均可撤销恢复。':editable.waveformSetup?'AI 原理图、探针与波形图配置已一起应用；运行对应配置后显示真实波形，可撤销或再次应用。':layoutElectricallyEquivalent(project,editable)?'AI 布局与探针已更新，现有波形图配置已保留；可撤销或再次应用。':'AI 方案与探针已更新，现有波形图配置已保留；Ctrl+Z 可恢复，运行仿真验证结果。')
      return applied
    }catch(error){reportLayoutProbeFailure(error);throw error}
  }
  function reportLayoutProbeFailure(error:unknown){const message=(error as Error).message;setStatus(message);setExchangeNotice(previous=>[...previous,message])}
  function highlightNet(at:Terminal) {setHighlightedNet(old=>old&&terminalKey(old)===terminalKey(at)?old:at);setStatus(`已高亮网络 ${inspectNet(drawing,at,topology.nodes).name}；Esc 清除。`)}
  function renameSelected(id:string) {
    if(!device)return
    const next=renameDevice(drawing,device.id,id),newId=id.trim().toUpperCase()
    if(next===drawing)return
    const remap=(at:Terminal|null)=>at&&'device'in at&&at.device===device.id?{...at,device:newId}:at
    commit(p=>({...p,drawing:next,...(p.probes!==undefined?{probes:p.probes.map(m=>m.kind==='current'?m.wire?{...m,wire:{...m.wire,from:remap(m.wire.from)!,to:remap(m.wire.to)!}}:{...m,device:m.device===device.id?newId:m.device}:{...m,positive:remap(m.positive)!,...(m.negative?{negative:remap(m.negative)!}:{})})}:{})}));setSelection(ids=>ids.map(old=>old===device.id?newId:old));setHighlightedNet(remap);setLabelTarget(remap);setProbePositive(remap)
    setStatus(`已将 ${device.id} 改为 ${newId}；连线、标签和探针已同步，Ctrl+Z 可撤销。`)
  }
  function arrange(operation:LayoutOperation) {
    try {
      const next=layoutSelection(drawing,selection,operation)
      if(next===drawing){setStatus('选中器件已经处于目标位置。');return}
      if(!updateDrawing(next,true))return;setTool('select');setStatus('已整理器件位置并保持原连接；Ctrl+Z 可一次撤销。')
    }catch(reason){setStatus((reason as Error).message)}
  }
  function selectItems(ids:string[]) {
    setSelectedMeasurement(undefined)
    selectionRef.current=ids;setSelection(ids); setLabelTarget(null)
    const nextDevice=ids.length===1?drawing.devices.find(part=>part.id===ids[0]):undefined
    setModelTarget(current=>current?.deviceId===nextDevice?.id&&current?.deviceId?current:inspectorTab==='model'&&nextDevice&&['D','Q','M','J'].includes(nextDevice.kind)?{deviceId:nextDevice.id}:null)
  }
  function selectItem(id:string|null) { selectItems(id?[id]:[]) }
  function openDeviceProperties(id:string) {setShowSimulation(false);selectItem(id);setTool('select');setInspectorTab('device');setParameterFocus(value=>value+1)}
  useEffect(()=>{
    if(!parameterFocus)return
    const panel=inspectorScroll.current?.querySelector<HTMLElement>('#inspector-device-panel')
    const field=panel?.querySelector<HTMLInputElement|HTMLSelectElement>('.device-value-fields input,.device-value-fields select')??panel?.querySelector<HTMLInputElement>('input')
    field?.focus();if(field?.tagName==='INPUT')(field as HTMLInputElement).select()
  },[parameterFocus])
  function openModelEditor(target:ModelEditTarget) {setModelTarget(target);setEditingModel(target);setInspectorTab('model');setLabelTarget(null);setTool('select')}
  function changeInspectorTab(tab:InspectorTab) {
    setInspectorTab(tab)
    if(tab==='model'&&!modelTarget&&device&&['D','Q','M','J'].includes(device.kind))setModelTarget({deviceId:device.id})
  }
  function closeModelEditor() {setEditingModel(null)}
  function importFoundModel(model:ImportedSpiceModel) {
    commit(importSearchedModel(project,model))
    setModelTarget({modelId:model.id});setInspectorTab('model')
    setEditingModel(null)
    setStatus(`已导入 ${model.id} 到工程模型库；可查看定义、放置器件，或明确应用到同类型的选中器件。Ctrl+Z 可撤销。`)
  }
  function applyFoundModel(model:ImportedSpiceModel) {
    if(!device)return
    try{
      commit(assignProjectModel(project,device.id,model.id))
      setModelTarget({deviceId:device.id});setEditingModel(null)
      setStatus(`已将 ${model.id} 应用到 ${device.id}；Ctrl+Z 可撤销，请重新运行仿真。`)
    }catch(error){setStatus((error as Error).message)}
  }
  function toggleWireBend() { setWireBend(b=>b==='hv'?'vh':'hv') }
  function chooseTool(next:EditorTool) {setNetworkSymbol(null);if(next!=='select'&&next!=='probe')setSelectedMeasurement(undefined);if(next==='probe'){setShowProbeMarkers(true);setStatus('测量模式：选择测量类型后连续点选；Esc 退出。')} setPlacement(null);if(next!=='probe')setProbePositive(null);setTool(next); if(isDeviceTool(next))setRotation(next==='V'||next==='C'?90:0); setView('canvas') }
  function changeProbeMarkerVisibility(visible:boolean){
    setShowProbeMarkers(visible)
    if(!visible){setSelectedMeasurement(undefined);setProbePositive(null);probePositiveAnchor.current=undefined;if(tool==='probe')setTool('select')}
    setStatus(visible?'已显示全部探针图标。':'已隐藏全部探针图标、标牌与引线；测量和波形保留。')
  }
  function undoEdit() { if(!timeline.past.length)return;setSelectedMeasurement(undefined);setProbePositive(null);probePositiveAnchor.current=undefined;setHighlightedNet(null);setTimeline(state=>navigateCircuitHistory(state,'undo'));setTool('select');selectItem(null);setFailure('');setStatus('已撤销，原理图与探针已一起恢复。') }
  function redoEdit() { if(!timeline.future.length)return;setSelectedMeasurement(undefined);setProbePositive(null);probePositiveAnchor.current=undefined;setHighlightedNet(null);setTimeline(state=>navigateCircuitHistory(state,'redo'));setTool('select');selectItem(null);setFailure('');setStatus('已重做，原理图与探针已一起恢复。') }
  function transform(operation:'rotate'|'mirror') {
    try{
      if(tool==='paste'&&clipboard)setClipboard({...clipboard,drawing:transformSelection(clipboard.drawing,allItems(clipboard.drawing),operation)})
      else updateDrawing(transformSelection(drawing,selection,operation),true)
    }catch(e){setStatus((e as Error).message)}
  }
  function rotate() {
    if (isDeviceTool(tool)||tool==='label'&&networkSymbol) setRotation(r => (r+90)%360 as Rotation)
    else transform('rotate')
  }
  function removeProbe(id:string){if(!measurements.some(measurement=>measurement.id===id))return;setMeasurements(ms=>ms.filter(m=>m.id!==id));setSelectedMeasurement(undefined);setStatus(`已移除 ${id} 探针；Ctrl+Z 可恢复。`)}
  function remove() { if(selectedMeasurement){removeProbe(selectedMeasurement);return}if(!selection.length)return; if(!updateDrawing(removeSelection(drawing,selection)))return; selectItem(null); setTool('select'); setStatus('已删除选区，Ctrl+Z 可一次撤销。') }
  function copy(placing=false) {
    const copied=copySchematicSelection(project,selectionRef.current)
    if(!copied){setStatus('请先选择器件、导线或连接点。');return}
    clipboardRef.current=copied;setClipboard(copied)
    const fragment=copied.drawing
    if(placing)chooseTool('paste')
    setStatus(placing?'点击画布放置副本；Esc 取消。':`已复制 ${fragment.devices.length} 个器件及选区连线。Ctrl+V 粘贴。`)
  }
  function duplicate() {copy(true)}
  function beginPaste() {if(clipboardRef.current){chooseTool('paste');setStatus('点击画布放置副本；Esc 取消。')}else setStatus('先用 Ctrl+C 复制电路选区，再粘贴。')}
  function paste(at:XY) {
    const copied=clipboardRef.current
    if(!copied)return
    try{
      const added=pasteSchematicSelection(project,copied,at),normalized=normalizeWireOverlaps(added.project.drawing!,{preserveConnections:true})
      commit({...added.project,drawing:normalized.drawing,...overlapProbes(added.project,normalized)})
      remapOverlapUi(normalized);selectItems(overlapSelection(normalized,added.ids));setTool('select');setStatus('副本已放置；编号已重新分配，重名节点标签已加后缀。Ctrl+Z 可撤销。')
    }catch(e){setStatus((e as Error).message)}
  }
  function mirror() {transform('mirror')}
  function focusProperties() {setTimeout(()=>inspectorScroll.current?.querySelector<HTMLElement>('.inspector-tab-panel:not([hidden])')?.querySelector<HTMLElement>('input,select,textarea,button')?.focus(),0)}
  const contextDevice=drawing.devices.find(d=>d.id===contextMenu?.deviceId)
  const contextWire=drawing.wires.find(w=>w.id===contextMenu?.wireId)
  const contextTerminal=contextMenu?.terminal??contextWire?.from??(contextMenu?.junctionId?{junction:contextMenu.junctionId}:undefined)
  const contextItems:CanvasContextMenuItem[]=contextMenu?.probeLabel?[
    {id:'probe-select',label:'选择测量波形'}, {id:'probe-remove',label:'移除探针',danger:true},
    ...(measurements.some(m=>m.id===markerIdentity(contextMenu.probeLabel!).id&&m.kind==='current'&&m.wire)?[{id:'probe-reverse',label:'反转电流方向'}]:[]),
  ]:contextTerminal?[
    {id:'voltage',label:'在此放置电压探针'}, {id:'differential',label:'作为差分探针正端'},
    ...(contextWire?[{id:'wire-current',label:'在此放置电流探针'}]:[]),
    {id:'highlight',label:'高亮整个网络'}, {id:'label',label:'编辑节点标签',shortcut:'F4'},
    ...(contextMenu?.labelId?[{id:'delete',label:'删除标签',danger:true}]:[]),
    ...(contextWire?[{id:'merge-overlaps',label:'合并重合导线',separatorBefore:true},{id:'bend',label:'切换导线走向'},{id:'delete',label:'删除导线',danger:true}]:contextMenu?.junctionId?[{id:'delete',label:'删除连接点',danger:true}]:[]),
  ]:contextDevice?[
    {id:'properties',label:'编辑器件参数'},
    ...(['D','Q','M','J'].includes(contextDevice.kind)?[{id:'model',label:'编辑 SPICE 模型'}]:[]),
    ...(canProbeCurrent(contextDevice.kind)?[{id:'current',label:'放置电流探针'}]:[]),
    {id:'rotate',label:'旋转选区',shortcut:'Ctrl+R',separatorBefore:true},
    {id:'mirror',label:'镜像选区',shortcut:'Ctrl+E'},
    {id:'copy',label:'复制选区',shortcut:'Ctrl+C'}, {id:'duplicate',label:'放置副本',shortcut:'F6'},
    {id:'delete',label:'删除选区',shortcut:'Delete',danger:true,separatorBefore:true},
  ]:contextMenu?.labelId?[
    {id:'label',label:'编辑节点标签'}, {id:'delete',label:'删除标签',danger:true},
  ]:[
    {id:'paste',label:'在此粘贴',shortcut:'Ctrl+V',disabled:!clipboard},
    {id:'undo',label:'撤销',shortcut:'Ctrl+Z',disabled:!timeline.past.length},
    {id:'redo',label:'重做',shortcut:'Ctrl+Shift+Z',disabled:!timeline.future.length},
    {id:'select-all',label:'全选',shortcut:'Ctrl+A',separatorBefore:true},
    {id:'fit',label:'适应整个原理图'},
    {id:'merge-overlaps',label:'合并重合导线'},
    {id:'simulation',label:'仿真设置',separatorBefore:true},
  ]
  function contextAction(id:string) {
    const request=contextMenu;if(!request)return
    setContextMenu(null)
    if(id==='properties'){openDeviceProperties(contextDevice!.id)}
    else if(id==='model'){selectItem(contextDevice!.id);openModelEditor({deviceId:contextDevice!.id});focusProperties()}
    else if(id==='rotate')transform('rotate')
    else if(id==='mirror')mirror()
    else if(id==='copy')copy()
    else if(id==='duplicate')duplicate()
    else if(id==='delete')remove()
    else if(id==='paste')paste(request.at)
    else if(id==='undo')undoEdit()
    else if(id==='redo')redoEdit()
    else if(id==='select-all'){selectItems(allItems(drawing));chooseTool('select')}
    else if(id==='merge-overlaps')mergeOverlappingWires()
    else if(id==='fit'){setCircuitFitMode('auto');setZoom(1);setResetView(v=>v+1)}
    else if(id==='simulation')openSimulation()
    else if(id==='voltage'&&contextTerminal){setProbePositive(null);setProbeMode('voltage');addMeasurement({id:nextProbeId(),kind:'voltage',positive:contextTerminal,positiveLayout:{anchor:request.anchor}})}
    else if(id==='differential'&&contextTerminal){chooseTool('probe');setProbeMode('differential');setProbePositive(contextTerminal);probePositiveAnchor.current=request.anchor;setStatus('已选差分正端，点击负端完成测量。')}
    else if(id==='highlight'&&contextTerminal)highlightNet(contextTerminal)
    else if(id==='label'){const at=contextTerminal??drawing.labels?.find(l=>l.id===request.labelId)?.at;if(at){openLabel(at);focusProperties()}}
    else if(id==='bend'&&contextWire)updateDrawing({...drawing,wires:drawing.wires.map(w=>w.id===contextWire.id?{...w,bend:w.bend==='hv'?'vh':'hv',waypoints:undefined}:w)})
    else if(id==='current'&&contextDevice){setProbeMode('current');addMeasurement({id:nextProbeId(),kind:'current',device:contextDevice.id})}
    else if(id==='wire-current'&&contextWire)probeWire(request.anchor??{wireId:contextWire.id,fraction:.5})
    else if(id==='probe-reverse'&&request.probeLabel)reverseProbe(request.probeLabel)
    else if(request.probeLabel){const probeId=markerIdentity(request.probeLabel).id;if(id==='probe-remove'){removeProbe(probeId)}else if(id==='probe-select'){selectProbe(probeId);expandDiagram(activeProbeDiagramId??undefined)}}
  }
  function openLabel(at:Terminal) {const label=drawing.labels?.find(l=>sameTerminal(l.at,at));setInspectorTab('device');setLabelTarget(at);setLabelName(label?.name??'');setLabelStyle(label?.style??'text');setLabelRotation(label?.rotation??0);setStatus('在右侧编辑网络名称、符号和方向；同名标签会电气连接。')}
  function applyLabel(name=labelName) {if(!labelTarget)return;try{if(!updateDrawing(setNetLabel(drawing,labelTarget,name,{style:labelStyle,rotation:labelRotation})))return;setLabelName(name);setStatus(name?`已设置节点 ${name}；同名标签将自动互连。`:'已移除节点标签。')}catch(e){setStatus((e as Error).message)}}
  function chooseLibraryPart(part:LibraryPart){chooseTool(part.kind);setPlacement(part);setStatus(`点击画布放置 ${part.name} · ${part.value}`)}
  function chooseNetworkSymbol(preset:NetworkSymbolPreset){chooseTool('label');setNetworkSymbol(preset);setRotation(preset.rotation);setStatus(`点击导线、引脚或空白处放置 ${preset.netName}；R 旋转，Esc 取消。`)}
  function placeNetworkSymbol(preset:NetworkSymbolPreset,at:Terminal,base:Drawing,angle:Rotation){
    try{
      const next=setNetLabel(base,at,preset.netName,{style:preset.style,rotation:angle})
      const applied=updateDrawing(next);if(!applied)return
      const placed=applied.drawing.labels!.find(label=>label.name===preset.netName&&label.id===next.labels!.find(item=>sameTerminal(item.at,at))!.id)!
      chooseTool('select');selectItems([placed.id])
      setInspectorTab('device');setLabelTarget(placed.at);setLabelName(preset.netName);setLabelStyle(preset.style);setLabelRotation(angle)
      setStatus(`已放置 ${preset.netName} 网络符号；可在右侧修改名称。同名网络自动互连。`)
    }catch(error){setStatus((error as Error).message)}
  }
  function stop(interrupted=false) { if(interrupted&&runningProfileId)setInterruptedProfiles(old=>({...old,[runningProfileId]:true}));worker.current?.terminate(); worker.current=null; if(deadline.current)clearTimeout(deadline.current);deadline.current=null;setRunning(false);setRunningProfileId(null) }
  function run(p = project,showResults = true,profileId=simulationProfiles.activeId,preferredGroupId?:string) {
    setDismissedFailures(old=>{const next={...old};delete next[profileId];return next})
    const fail=(message:string)=>setProfileFailures(old=>({...old,[profileId]:message}))
    const profile=p.waveformSetup?.profiles.profiles.find(item=>item.id===profileId)??simulationProfiles.profiles.find(item=>item.id===profileId),warning=profile?simulationReferenceWarning(p,profile):null
    if(warning){fail(warning);setStatus('仿真未能开始，请修复配置中的器件或节点引用。');return}
    const runIssues=validateProject(p)
    if(runIssues.length){fail(runIssues.join('\n'));setStatus('仿真未能开始，请按错误提示完成连接或修改参数。');return}
    // Resolve the displayed configuration at launch, including saved-project warm-up.
    // Completion must never override a later selection or a collapsed sidebar.
    const groups=diagrams.map(item=>p.waveformSetup?.diagrams.find(saved=>saved.id===item.id)??item)
    let target=groups.find(item=>item.id===(preferredGroupId??pageDiagram?.id)&&item.profileId===profileId&&(showResults||!item.resultId))
        ??groups.find(item=>item.profileId===profileId&&!item.resultId)
        ??(showResults?groups.find(item=>item.profileId===profileId):undefined)
      if(!target){
        if(groups.length>=MAX_CANVAS_WAVEFORMS){fail('图组已满，请将一个图组绑定到此配置，或删除不用的图组后重新运行。');setStatus('此配置尚无显示图组，请先调整右侧图组。');return}
        target=newCanvasWaveform(p.drawing??drawing,profileId,groups)
        setDiagramHistory(old=>remember(old,[...old.present,target!]))
      }else if(showResults&&target.resultId)patchDiagram(target.id,{resultId:undefined})
    setActiveProbeDiagramId(target.id);setExpandedDiagramId(target.id)
    if(showResults){
      setView('canvas');setShowSimulation(false);showWaveformSidebar()
      const showSequence=++fitSequence.current
      setWaveShowRequests(old=>({...old,[target!.id]:showSequence}))
    }
    stop();fail('');setInterruptedProfiles(old=>({...old,[profileId]:false}));setProgress('正在启动 ngspice…');setRunning(true);setRunningProfileId(profileId)
    let next:Worker
    try {next=new Worker(new URL('./engine.worker.ts',import.meta.url),{type:'module'})} catch(e){setRunning(false);setRunningProfileId(null);fail((e as Error).message);return}
    worker.current=next
    next.onmessage = event => {
      if(worker.current!==next)return
      const m=event.data
      if(m.type==='progress')setProgress(m.message)
      if(m.type==='error'){fail(m.message);stop()}
      if(m.type==='result'){setProfileResults(old=>({...old,[profileId]:m.result}));setProfileHistory(old=>({...old,[profileId]:[...experimentHistory(m.result),...(old[profileId]??[])].slice(0,48)}));stop();dcVoltages.simulationCompleted(m.result,{refresh:showResults});setStatus('仿真完成，波形已更新；直流工作点自动更新。')}
    }
    next.onerror=event => {if(worker.current!==next)return;fail(event.message||'计算线程未能启动');stop()}
    const timeout = Math.min(180000, 30000 * (p.sweep?.values.length ?? 1))
    deadline.current=setTimeout(() => {stop();fail(`仿真超过 ${timeout/1000} 秒，已终止。请检查连接，或缩短仿真时长。`)},timeout)
    try{next.postMessage(structuredClone(p))}catch(error){fail((error as Error).message||'仿真任务未能发送，请重试。');stop()}
  }
  useEffect(()=>{if(probePositive&&!topology.nodes.has(terminalKey(probePositive)))setProbePositive(null)},[drawing])
  useEffect(()=>{
    if(selectedMeasurement&&!measurements.some(measurement=>measurement.id===selectedMeasurement))setSelectedMeasurement(undefined)
    const notices=[...new Set(pendingProbeNotices.current.splice(0))]
    if(notices.length){setExchangeNotice(previous=>[...previous,...notices]);setStatus(notices.join('；'))}
  },[project,selectedMeasurement,measurements])
  useEffect(()=>{if(highlightedNet&&!topology.nodes.has(terminalKey(highlightedNet)))setHighlightedNet(null)},[drawing,highlightedNet])
  useEffect(() => {if(onProjectChange){try{onProjectChange(project);setStorageError(false)}catch{setStorageError(true)}return}try{localStorage.setItem(STORAGE,JSON.stringify(project));setStorageError(false)}catch{setStorageError(true)}},[project,onProjectChange])
  useEffect(() => {if(inspectorScroll.current)inspectorScroll.current.scrollTop=0},[selected,modelTarget,labelTarget,inspectorTab])
  useEffect(() => {if(!started.current){started.current=true;if(!validateProject(project).length)run(project,false)};return () => {worker.current?.terminate();if(deadline.current)clearTimeout(deadline.current)}},[])
  useEffect(() => {
    const isCanvasTarget=(target:EventTarget|null)=>view==='canvas'&&(target===document.body||!!(target as Element|null)?.closest?.('.drawing-surface,.drawing-toolbar,.page-schematic-toolbar'))
    const key=(e:KeyboardEvent) => {
      if(e.defaultPrevented||editingModel||showAppearance||showSimulation||(e.target as Element|null)?.closest?.('[role="dialog"]')||contextMenu||showIssues||showModels||showNetlistEditor||galleryOpen||shortcutsBlocked||(e.target as Element|null)?.closest?.('.assistant-sidebar,.model-search,.sidebar-resize-handle,.page-waveform-host,.simulation-settings-embedded,.page-workspace-controls,.page-collapsed-waveform')||modelTarget&&!!(e.target as HTMLElement|null)?.closest?.('.model-editor-inline'))return
      if((e.target as Element|null)?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return
      if((e.ctrlKey||e.metaKey)&&['c','v'].includes(e.key.toLowerCase())&&window.getSelection()?.isCollapsed===false&&!(e.target as Element|null)?.closest?.('.editor-canvas,.drawing-toolbar,.page-schematic-toolbar'))return
      if(!isCanvasTarget(e.target)&&(e.ctrlKey||e.metaKey)&&['c','v','z','y'].includes(e.key.toLowerCase()))return
      if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();runCurrentSimulation();return}
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();download('fuxian-schematic.json',JSON.stringify(project,null,2),'application/json');return}
      if(e.target instanceof HTMLElement && (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)||e.target.isContentEditable))return
      const k=e.key.toLowerCase()
      if((e.ctrlKey||e.metaKey)&&k==='a'){e.preventDefault();selectItems(allItems(drawing));chooseTool('select');return}
      if((e.ctrlKey||e.metaKey)&&k==='c'){e.preventDefault();copy();return}
      if((e.ctrlKey||e.metaKey)&&k==='v'){e.preventDefault();beginPaste();return}
      if((e.ctrlKey||e.metaKey)&&k==='z'){e.preventDefault();if(tool==='paste'){setTool('select');setStatus('已取消粘贴预览。')}else e.shiftKey?redoEdit():undoEdit();return}
      if((e.ctrlKey||e.metaKey)&&k==='y'){e.preventDefault();redoEdit();return}
      if((e.ctrlKey||e.metaKey)&&k==='d'){e.preventDefault();duplicate();return}
      if((e.ctrlKey||e.metaKey)&&k==='r'){e.preventDefault();rotate();return}
      if((e.ctrlKey||e.metaKey)&&k==='e'){e.preventDefault();mirror();return}
      if(k==='f2'){e.preventDefault();setCompactLeftRequested(true);dispatchLayout({type:'panel-left',panel:'library'});setView('canvas');setCategory('全部');setSearch('');setTimeout(()=>searchInput.current?.focus(),0);return}
      if(k==='f6'){e.preventDefault();duplicate();return}
      if(k==='f9'){e.preventDefault();runCurrentSimulation();return}
      if(e.ctrlKey||e.metaKey||e.altKey)return
      if(selectedMeasurement&&['delete','backspace','f5'].includes(k)){e.preventDefault();remove();return}
      if(tool==='wire'&&k===' '){e.preventDefault();toggleWireBend();return}
      if(tool==='wire'&&['delete','backspace','f5'].includes(k)){e.preventDefault();setStatus('接线时用 Backspace 退回拐点，右键 / Esc 取消未完成连线并退出。');return}
      if(tool==='select'&&['arrowleft','arrowright','arrowup','arrowdown'].includes(k)&&selection.length){e.preventDefault();const step=e.shiftKey?100:20;try{updateDrawing(moveSelection(drawing,selection,{x:k==='arrowleft'?-step:k==='arrowright'?step:0,y:k==='arrowup'?-step:k==='arrowdown'?step:0}),true)}catch(error){setStatus((error as Error).message)}return}
      if(k==='escape'){setProbePositive(null);setHighlightedNet(null);setTool('select');setHelp(false);if(running){stop(true);setStatus('仿真已停止。')}else if(tool==='paste')setStatus('已取消粘贴预览。');else if(tool==='wire')setStatus('已退出接线；未完成的路径已取消。');else if(tool==='probe')setStatus('已退出测量模式，已放置的探针保留。');else if(tool==='net'||highlightedNet)setStatus('已清除网络高亮，返回选择模式。');return}
      if(tool==='paste'&&['delete','backspace','f5'].includes(k)){e.preventDefault();setTool('select');setStatus('已取消粘贴预览。');return}
      if(k==='delete'||k==='backspace'||k==='f5'){e.preventDefault();remove();return}
      if(k==='r'){e.preventDefault();rotate();return}
      const keys:Record<string,EditorTool>={'1':'R','2':'C','3':'L','4':'V','g':'GND','n':'net','w':'wire','p':'probe','v':'select','h':'pan','f3':'wire','f4':'label','f7':'select','f8':'select','d':'D','q':'Q','m':'M'}
      if(keys[k]){e.preventDefault();chooseTool(keys[k]);if(keys[k]==='probe')openProbeTools()}
    }
    window.addEventListener('keydown',key)
    return()=>{window.removeEventListener('keydown',key)}
  })
  async function importFile(file?:File) {
    if(!file)return
    try {
      if(file.size>2*1024*1024)throw new Error('电路文件最多支持 2 MB')
      const extension=file.name.split('.').pop()?.toLowerCase(),text=await file.text()
      if(extension==='json'){replaceProject(editableProject(parseProject(JSON.parse(text),{allowDraft:true})));setExchangeNotice([]);setStatus('工程已导入，可用 Ctrl+Z 恢复。')}
      else if(extension==='asc'||['cir','net','sp','spice'].includes(extension??'')){
        const imported=importCircuit(text,extension==='asc'?'asc':'spice');setPendingImport({...imported,format:extension==='asc'?'LTspice ASC':'SPICE 网表'});setExchangeNotice([])
      }else throw new Error('请选择 JSON、LTspice .asc 或 SPICE .cir/.net/.sp 文件。Multisim 原生工程请先在 Multisim 中导出 SPICE 网表。')
    }catch(reason){const message=`导入失败：${(reason as Error).message}`;setExchangeNotice([message]);setStatus(message)}
    if(fileInput.current)fileInput.current.value=''
  }
  function exportAsc() {
    try {const output=exportLtspice(project);download('fuxian-schematic.asc',output.text);setExchangeNotice(output.warnings);setStatus('LTspice ASC 已导出。')}
    catch(reason){const message=`无法导出 ASC：${(reason as Error).message}`;setExchangeNotice([message]);setStatus(message)}
  }
  useEffect(()=>{if(galleryOpen){setTool('select');setProbePositive(null)}},[galleryOpen])
  function loadTemplate(id:TemplateId | ExampleId | DeviceExampleId | 'blank') {setView('canvas');stop();setSelectedMeasurement(undefined);setProbePositive(null);probePositiveAnchor.current=undefined;setPlacement(null);setHighlightedNet(null);setLabelTarget(null);commit(id==='blank'?blankProject():deviceExamples.some(e=>e.id===id)?deviceExampleProject(id as DeviceExampleId):advancedExamples.some(e=>e.id===id)?exampleProject(id as ExampleId):editorTemplate(id as TemplateId));selectItem(null);setTool('select');setZoom(1);setResetView(v=>v+1);setShowIssues(false);setStatus('画布已更新，Ctrl+Z 可恢复上一张原理图。')}
  function valueChange(value:string){if(device)updateDrawing({...drawing,devices:drawing.devices.map(p=>p.id===device.id?{...p,value}:p)})}
  const primary=device?.id===drawing.sourceId
  const hasMovable=tool==='paste'&&!!clipboard||selection.some(id=>drawing.devices.some(d=>d.id===id)||drawing.junctions.some(j=>j.id===id))

  function locateBiasMeasurement(measurement:BiasMeasurement){
    setView('canvas');chooseTool('select');dcVoltages.setSelectedId(measurement.id)
    if(measurement.wire){selectItems([measurement.wire.wireId]);setFitSelection(value=>value+1)}
    else if(measurement.deviceId){selectItems([measurement.deviceId]);setFitSelection(value=>value+1)}
    else if(measurement.at){highlightNet(measurement.at)}
  }
  function addBiasWire(anchor:WireAnchor){
    const wire=drawing.wires.find(item=>item.id===anchor.wireId)
    if(!wire)return
    const target:WireCurrentTarget={wireId:wire.id,from:wire.from,to:wire.to,direction:1}
    dcVoltages.addWire(target);setStatus('已添加导线工作点电流；无唯一解或缺少边界数据时会明确提示。')
  }
  function exportBiasSvg(run:Result,measurements:BiasMeasurement[],stale:boolean){
    const source=stale?run.project:project
    if(!source.drawing)return
    const placements=layoutBiasMeasurements(source.drawing,measurements,{prefs:dcVoltages.prefs,selected:selection,models:source.models,probes:source.probes})
    download('fuxian-bias-point.svg',schematicSvg(source.drawing,{title:source.title,models:source.models,probes:source.probes,biasPlacements:placements,biasDirectionMode:dcVoltages.prefs.directionMode,biasMetadata:{resultId:run.id,timestamp:run.timestamp,engine:run.engine,temperature:run.project.temperature??27,status:stale?'stale':'current'}}),'image/svg+xml')
    setStatus('已导出带工作点电压、电流和方向的 SVG。')
  }
  function exportSvg() {
    if(dcVoltages.displayActive&&dcVoltages.usable&&dcVoltages.result){exportBiasSvg(dcVoltages.result,dcVoltages.measurements,false);return}
    const sourceDevice=drawing.devices.find(part=>part.id===drawing.sourceId)
    const excitation=sourceDevice&&isConfiguredSource(sourceDevice)?sourceDescription(sourceDevice):project.analysis==='tran'
      ? `${project.source.waveform==='sine'?'正弦':'方波'} · ${project.source.amplitude} · ${project.source.frequency} · 偏置 ${project.source.offset}`
      : project.analysis==='ac'||project.analysis==='noise'?`DC ${project.source.dc} · AC 1 V`:project.analysis==='dc'?`DC 扫描 ${dcSweep(project).start} → ${dcSweep(project).stop}`:`DC ${project.source.dc}`
    download('fuxian-schematic.svg',schematicSvg(drawing,{title:project.title,sourceSummary:excitation,models:project.models,...{probes:project.probes}}),'image/svg+xml')
    setStatus('已导出 SVG 矢量原理图，可用于文档、打印或继续编辑。')
  }

  function leftPanelKey(event:import('react').KeyboardEvent<HTMLButtonElement>){
    if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
    event.preventDefault();event.stopPropagation()
    const panel=event.key==='Home'?'projects':event.key==='End'?'library':layout.leftPanel==='projects'?'library':'projects'
    setCompactLeftRequested(true);dispatchLayout({type:'panel-left',panel});event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#workspace-${panel}-tab`)?.focus()
  }

  return <><div className={`workbench-with-assistant workspace-shell${layout.maximized?' is-canvas-maximized':''}`}>
    <nav className="workspace-navigation-rail" aria-label="项目与器件导航" inert={galleryOpen||showAppearance||showSettings||!!editingModel||undefined}>
      <a className="workspace-rail-brand" href="#editor" aria-label="返回原理图" title="伏线 · 原理图" onClick={e=>{e.preventDefault();changeExamples(false);setView('canvas')}}><Zap size={21} fill="currentColor"/></a>
      <div className="workspace-rail-tabs" role="tablist" aria-label="左侧功能" aria-orientation="vertical">
        {([{panel:'projects',label:'项目',Icon:FolderOpen},{panel:'library',label:'器件库',Icon:Library}] as const).map(({panel,label,Icon})=>{
          const selected=layout.leftPanel===panel, expanded=leftVisible&&selected
          return <button key={panel} role="tab" id={`workspace-${panel}-tab`} aria-label={`${label}侧栏`} aria-selected={selected} aria-expanded={expanded} aria-controls={`workspace-${panel}-panel`} tabIndex={selected?0:-1} title={`${expanded?'收起':'打开'}${label}${panel==='library'?' (F2)':''}`} onClick={()=>{setCompactLeftRequested(!expanded);dispatchLayout(expanded?{type:'toggle-left'}:{type:'panel-left',panel})}} onKeyDown={leftPanelKey}><Icon size={21}/><span>{label}</span></button>
        })}
      </div>
      <div className="workspace-rail-bottom"><button type="button" aria-label="打开工作台设置" title="连接、API 与工作区设置" onClick={openSettings}><Settings2 size={20}/><span>设置</span></button><button type="button" aria-label="外观与画布设置" title="外观 · 主题、密度、文字与画布" aria-haspopup="dialog" onClick={()=>setShowAppearance(true)}><SlidersHorizontal size={20}/><span>外观</span></button></div>
    </nav>
    <div className="free-app" inert={galleryOpen||showAppearance||showSettings||!!editingModel||undefined}>
    <header className="free-header workspace-topbar">
      <a className="free-brand" href="#editor" aria-label="伏线原理图" onClick={e=>{e.preventDefault();changeExamples(false);setView('canvas')}}><strong>伏线<span>.</span></strong></a>
      <div className="workspace-topbar-title"><input className="project-title-input" aria-label="项目名称" title={project.title} maxLength={80} value={project.title} onChange={e=>commit(p=>({...p,title:e.target.value}))}/><button type="button" className="project-ai-name" aria-label="AI 识别电路并取名" title="用本机 Codex 读取电路并生成项目名称" disabled={naming||!drawing.devices.length} onClick={()=>void nameCircuit()}>{naming?<LoaderCircle className="step-loading-icon" size={14}/>:<WandSparkles size={14}/>}<span>{naming?'识别中':'AI 取名'}</span></button><span className="free-version">v0.29.9</span></div>
      <nav className="workspace-navigation workspace-view-tabs" aria-label="工作区导航"><button aria-current={view==='canvas'?'page':undefined} onClick={()=>setView('canvas')}><Activity size={15}/>原理图</button><button title="查看网表" aria-label="查看网表" aria-current={view==='netlist'?'page':undefined} onClick={()=>setView('netlist')}><Code2 size={15}/>网表</button></nav>
      <div className="free-file-actions workspace-topbar-actions">
        <details ref={fileMenu} className="workspace-file-menu" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();fileMenu.current?.removeAttribute('open');fileMenu.current?.querySelector('summary')?.focus()}}}><summary>文件<ChevronDown size={13}/></summary><div onClick={event=>{const button=(event.target as Element).closest('button');if(button&&!button.disabled)fileMenu.current?.removeAttribute('open')}}>
          <p className="workspace-menu-heading">工程文件</p><button title="空白画布" aria-label="空白画布" onClick={()=>loadTemplate('blank')}><FilePlus2 size={15}/>空白画布</button><button title="导入项目" aria-label="导入项目" onClick={()=>fileInput.current?.click()}><Upload size={15}/>导入项目</button><button title="导出项目" aria-label="导出项目" onClick={()=>download('fuxian-schematic.json',JSON.stringify(project,null,2),'application/json')}><Save size={15}/>导出项目</button><p className="workspace-menu-heading">图纸与仿真文件</p><button title="导出原理图 SVG" aria-label="导出原理图 SVG" onClick={exportSvg}><ImageDown size={15}/>导出原理图 SVG</button><button onClick={exportAsc}>导出 LTspice .asc</button><button disabled={!netlist} onClick={()=>download('fuxian-schematic.cir',netlist)}>导出 SPICE .cir</button><p>导入支持基础 ASC 和 SPICE 网表。Multisim 请先导出文本 SPICE。</p>
        </div></details>
        <button title="模型助手 · 查找、导入与检查器件模型" aria-label="打开模型工作区" aria-haspopup="dialog" aria-expanded={showModelSearch} aria-controls="model-search-window" onClick={()=>{setModelAssistantMounted(true);setModelSearchVisibleFor(modelSearchScope)}}><Boxes size={15}/><span>模型助手</span></button>
        <button title="电路助手 · 解释电路与审阅修改候选" className="ai-open-button" aria-label="打开 AI 助手" aria-pressed={showAi} aria-controls="workspace-ai" onClick={()=>showAi&&assistantTab==='chat'?dispatchLayout({type:'close-ai'}):openAi()}><BotMessageSquare size={15}/><span>电路助手</span></button>
        <details ref={secondaryMenu} className="workspace-file-menu workspace-secondary-menu" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();secondaryMenu.current?.removeAttribute('open');secondaryMenu.current?.querySelector('summary')?.focus()}}}><summary title="示例、报告与操作指南"><MoreHorizontal size={16}/>更多<ChevronDown size={13}/></summary><div onClick={event=>{const button=(event.target as Element).closest('button');if(button&&!button.disabled)secondaryMenu.current?.removeAttribute('open')}}>
          <p className="workspace-menu-heading">学习与交付</p>
          <button aria-label="示例电路" aria-haspopup="dialog" onClick={()=>changeExamples(true)}><BookOpen size={15}/>示例电路</button>
          <button aria-label="打开最终测试报告" aria-haspopup="dialog" onClick={()=>setShowFinalReport(true)}><ClipboardList size={15}/>最终测试报告</button>
          <button aria-label="操作指南" className={help?'active':''} onClick={()=>setHelp(v=>!v)}><CircleHelp size={16}/>操作指南</button>
          <button aria-label="合并重合导线" onClick={mergeOverlappingWires}><Network size={15}/>合并重合导线</button>
        </div></details>
        <span className="free-save-state" data-save-state={persistenceMessages.length?'error':saveState==='saving'?'saving':'saved'} role="status" title={persistenceMessages.length?persistenceMessages.join('；'):saveState==='saving'?'正在保存到本机':'工程已保存到本机'}><span className={`state-dot ${persistenceMessages.length?'amber':''}`}/><span className="workspace-save-label">{persistenceMessages.length?'未完全保存':saveState==='saving'?'保存中':'已保存'}</span></span>
        <div className="workspace-simulation-controls" role="group" aria-label="仿真配置"><label className="workspace-simulation-profile"><span>仿真设置</span><select className="simulation-profile-select" aria-label="当前仿真配置" title="选择要运行或修改的仿真配置" value={simulationProfiles.activeId} onChange={event=>selectSimulationProfile(event.target.value)}>{simulationProfiles.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button type="button" className="simulation-profile-edit" aria-label="打开仿真设置" title="修改当前仿真配置" aria-haspopup="dialog" aria-expanded={showSimulation} onClick={()=>openSimulation()}><Settings2 size={15}/><span>修改仿真</span></button><button type="button" className="simulation-profile-add" aria-label="添加仿真配置" title="添加新的仿真配置" aria-haspopup="dialog" disabled={simulationProfiles.profiles.length>=24} onClick={()=>openSimulation(true)}><Plus size={15}/><span>添加仿真</span></button></div>
        <button title={running?`停止 ${simulationProfiles.profiles.find(item=>item.id===runningProfileId)?.name??'当前配置'} 的仿真`:'运行当前配置 · Ctrl+Enter / F9'} className={`run-button ${running?'is-running':''}`} onClick={()=>running?(stop(true),setStatus('仿真已停止，保留上次运行结果。')):runCurrentSimulation()}>{running?<Square size={14} fill="currentColor"/>:<Play size={14} fill="currentColor"/>}{running?'停止仿真':'运行仿真'}</button>
      </div><input ref={fileInput} className="hidden" type="file" accept=".json,.asc,.cir,.net,.sp,.spice" onChange={e=>importFile(e.target.files?.[0])}/>
    </header>
<div className="drawing-toolbar workspace-commandbar"><div className="drawing-tools">{([{id:'select',icon:MousePointer2,label:'选择 / 移动 (V)'},{id:'wire',icon:Activity,label:'导线 (W)'},{id:'probe',icon:Pin,label:'测量探针 (P)'},{id:'pan',icon:Hand,label:'平移画布 (H)'},{id:'label',icon:Tag,label:'节点标签 (F4)'},{id:'net',icon:Network,label:'网络高亮 (N)'}] as const).map(({id,icon:Icon,label})=>id==='probe'?<ProbeToolbar key={id} toolbarRef={probeTools} onFocusMode={openProbeTools} markersVisible={showProbeMarkers} onMarkersVisibleChange={changeProbeMarkerVisibility} onViewResults={()=>{expandDiagram();showWaveformSidebar()}} mode={probeMode} onMode={changeProbeMode} active={tool==='probe'} onActivate={()=>chooseTool('probe')} measurements={displayMeasurements} selected={selectedMeasurement} onSelect={selectProbe} onRemove={removeProbe} onClear={clearMeasurements} pending={probePositive} onCancelPending={()=>{setProbePositive(null);probePositiveAnchor.current=undefined}} result={pageProbeResult} stale={pageProbeStale}/>:<Fragment key={id}><button className={tool===id?'active':''} title={label} aria-label={label} onClick={()=>chooseTool(id)}><Icon size={17}/>{id==='select'&&<span>选择</span>}{id==='wire'&&<span>接线</span>}{id==='label'&&<span>标签</span>}{id==='net'&&<span>网络</span>}</button>{id==='wire'&&<SchematicSymbolsToolbar activePart={placement?.id??(isDeviceTool(tool)?`base-${tool}`:undefined)} activeNetworkSymbol={networkSymbol?.id} onPlacePart={chooseLibraryPart} onPlaceNetworkSymbol={chooseNetworkSymbol}/>}</Fragment>)}<i/><button title="撤销 Ctrl+Z" aria-label="撤销" disabled={!timeline.past.length} onClick={()=>undoEdit()}><Undo2 size={17}/></button><button title="重做 Ctrl+Shift+Z" aria-label="重做" disabled={!timeline.future.length} onClick={()=>redoEdit()}><Redo2 size={17}/></button><details ref={editMenu} className="drawing-edit-menu" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();editMenu.current?.removeAttribute('open');editMenu.current?.querySelector('summary')?.focus()}}} onClick={event=>{const button=(event.target as Element).closest('button');if(button&&!button.disabled)editMenu.current?.removeAttribute('open')}}><summary title="旋转、镜像、复制、粘贴与删除"><MoreHorizontal size={16}/><span>编辑</span></summary><div role="group" aria-label="选区编辑操作"><button title="旋转 R" aria-label="旋转选中器件" disabled={!hasMovable&&!isDeviceTool(tool)} onClick={rotate}><RotateCw size={17}/>旋转</button><button title="镜像 Ctrl+E" aria-label="镜像选中器件" disabled={!hasMovable} onClick={mirror}><FlipHorizontal2 size={16}/>镜像</button><button title="复制选区 Ctrl+C" aria-label="复制选区" disabled={!selection.length} onClick={()=>copy()}><Copy size={16}/>复制</button><button title="粘贴 Ctrl+V · 点击画布放置" aria-label="粘贴选区" disabled={!clipboard} onClick={beginPaste}><ClipboardPaste size={16}/>粘贴</button><button title="删除 Delete" aria-label="删除选中项" disabled={!selection.length&&!selectedMeasurement} onClick={remove}><Trash2 size={16}/>删除</button></div></details></div>{tool==='wire'&&<button className="wire-mode-button" aria-label="切换接线方向" title="Space 切换方向" onClick={toggleWireBend}>{wireBend==='hv'?'先横后竖':'先竖后横'}</button>}<div className="canvas-overlay-tools"><DcVoltageToggle state={dcVoltages}/><label><input type="checkbox" checked={showNodes} onChange={e=>setShowNodes(e.target.checked)}/>节点名</label><div className="zoom-controls"><button aria-label="缩小画布" disabled={zoom<=MIN_CANVAS_ZOOM} onClick={()=>setZoom(z=>stepCanvasZoom(z,-1))}><Minus size={14}/></button><span>{Math.round(zoom*100)}%</span><button aria-label="放大画布" disabled={zoom>=MAX_CANVAS_ZOOM} onClick={()=>setZoom(z=>stepCanvasZoom(z,1))}><Plus size={14}/></button><button aria-label="缩放到选区" title="缩放到选区" disabled={!selection.length} onClick={()=>setFitSelection(v=>v+1)}><MousePointer2 size={14}/></button><button aria-label="适应整个原理图" onClick={()=>{setZoom(1);setResetView(v=>v+1)}}><ScanLine size={15}/></button></div></div><div className="workspace-layout-actions"><button aria-label={rightVisible&&inspectorTab==='device'?'收起器件属性':'打开器件属性'} title={rightVisible&&inspectorTab==='device'?'收起器件属性':'打开器件属性'} aria-expanded={rightVisible&&inspectorTab==='device'} aria-controls="workspace-right" className={rightVisible&&inspectorTab==='device'?'active':''} onClick={()=>rightVisible&&inspectorTab==='device'?showWaveformSidebar():changeInspectorTab('device')}><SlidersHorizontal size={16}/><span>属性</span></button><button aria-label={pageMode!=='schematic'&&!layout.maximized?'收起右侧栏':'展开右侧栏'} title={pageMode!=='schematic'&&!layout.maximized?'收起右侧栏':'展开右侧栏'} aria-expanded={pageMode!=='schematic'&&!layout.maximized} aria-controls="page-waveform-host" onClick={()=>pageMode!=='schematic'&&!layout.maximized?setPageMode('schematic'):sidebarTab==='properties'?setInspectorTab(inspectorTab):showWaveformSidebar()}><PanelRightClose size={16}/></button><button aria-label={layout.maximized?'恢复侧栏布局':'最大化画布'} title={layout.maximized?'恢复侧栏布局':'最大化画布'} aria-pressed={layout.maximized} onClick={()=>{if(!layout.maximized){setView('canvas')}dispatchLayout({type:'toggle-maximize'})}}>{layout.maximized?<Minimize2 size={17}/>:<Maximize2 size={17}/>}<span>{layout.maximized?'恢复':'最大化'}</span></button></div></div>
    {(!!exchangeNotice.length||visibleFailure||pendingImport||help||!!persistenceMessages.length)&&<div className="workspace-notices">
    <PersistenceNotice messages={persistenceMessages} onRetry={saveState==='error'&&!onRetrySave&&!storageError&&!Object.keys(localSaveIssues).length&&appearancePersistence.persisted?undefined:retrySave} onBackup={()=>download('fuxian-backup.json',JSON.stringify(project,null,2),'application/json')}/>
    {visibleFailure&&<div className="error-banner simulation-failure-notice" role="alert" aria-label="仿真失败提示"><strong>仿真未完成</strong><span>{activeFailure}</span><button type="button" onClick={()=>openSimulation()}>仿真设置</button><button type="button" aria-label="关闭仿真失败提示" onClick={()=>setDismissedFailures(old=>({...old,[simulationProfiles.activeId]:activeFailure}))}><X size={15}/></button></div>}
    {!!exchangeNotice.length&&<div className="exchange-notice" role="status"><div>{exchangeNotice.map((notice,i)=><p key={i}>{notice}</p>)}</div><button aria-label="关闭格式提示" onClick={()=>setExchangeNotice([])}><X size={15}/></button></div>}
    {pendingImport&&<div className="import-preview" role="region" aria-label="电路导入预览"><div><strong>{pendingImport.format} · {pendingImport.project.title}</strong><p>{pendingImport.project.drawing?.devices.length} 个器件 · {pendingImport.project.drawing?.wires.length} 段导线 · {analysisNames[pendingImport.project.analysis]}</p>{pendingImport.warnings.map((warning,i)=><p key={i}>{warning}</p>)}</div><button onClick={()=>{replaceProject(pendingImport.project);setExchangeNotice(pendingImport.warnings);setPendingImport(null);setStatus('导入已应用，Ctrl+Z 可恢复原工程。')}}>应用导入</button><button onClick={()=>setPendingImport(null)}>取消</button></div>}
    {help&&<div className="editor-help"><div><strong>放置与编辑</strong><p>滚轮精细缩放；按住中键拖动可平移画布，轻点中键进入快速缩放模式，上下移动鼠标即可放大或缩小，再轻点中键、按右键或 Esc 退出。右键拖动也可平移画布，短按右键取消接线或打开菜单。F2 搜索器件，点击后放置。拖动移动；R / Ctrl+R 旋转，Ctrl+E 镜像，Shift 点击多选，拖空白处框选，Alt 框选包含相交对象。Ctrl+C / V 复制粘贴，F6 放置副本，Delete 删除；Ctrl+Z 撤销。</p></div><div><strong>连线与分支</strong><p>F3 / W 接线，点击引脚后默认沿引脚方向出线，点另一个引脚完成，途中点空白处加拐点；Space 换方向，Backspace 退一步，右键 / Esc 取消未完成连线并退出。V 选择模式直接拖导线线段，拖选中线的拐点调整形状；Esc 或右键取消拖动。连接点可拖动并带着分支移动。F4 添加节点标签，同名标签互连。交叉线需明确点出连接点才导通。N 高亮实际网络，Esc 清除。多选器件后在右栏对齐或等距排列；单选可修改编号。</p></div><div><strong>测量与仿真</strong><p>P 点击导线任意位置测电压；拖动圆点换测量节点，拖动标牌避让器件。差分模式从正端拖到负端，或依次点击两端。参考输出在仿真设置中选择；F9 / Ctrl+Enter 运行。工具栏“工作点”可同时显示直流电压和电流，查看结果表、方向、历史与导出；修改电路后重新计算。支持 AC、瞬态、工作点与 DC 扫描；波形面板可选节点、电源电流及 A/B 游标。Ctrl+S 导出项目。</p></div><button aria-label="关闭操作指南" onClick={()=>setHelp(false)}><X size={17}/></button></div>}
    </div>}
    <div className="free-body workspace-body" ref={workspaceBody} style={workspaceStyle} data-ai-overlay={sizing.overlayAi || undefined}>
      <aside className="workspace-left" id="workspace-left" aria-label="项目与器件库" hidden={!leftVisible}>
        <div className="workspace-left-content"><div id="workspace-projects-panel" role="tabpanel" aria-labelledby="workspace-projects-tab" hidden={layout.leftPanel!=='projects'}>{projectPanel??<p>从应用首页管理项目。</p>}</div><div id="workspace-library-panel" role="tabpanel" aria-labelledby="workspace-library-tab" hidden={layout.leftPanel!=='library'}><aside className="device-library"><div className="library-title"><span>器件库</span><small>F2</small></div><div className="library-sources" role="group" aria-label="器件来源"><button className="library-external-button" onClick={()=>openModelLibrary()}>SPICE 模型库<span>{project.models?.length??0} 已导入{modelAcquisitions.length>0?` · 助手找到 ${modelAcquisitions.length}`:''}</span></button></div><DeviceLibrary key={projectId??'standalone'} projectModels={project.models??[]} onPlaceModel={placeLibraryModel} onImportAndPlaceModel={importAndPlaceLibraryModel} onImportAndPlaceLocalModel={importAndPlaceLibraryModel} search={search} onSearch={setSearch} category={category} onCategory={setCategory} active={placement?.id??(isDeviceTool(tool)?`base-${tool}`:undefined)} searchInput={searchInput} onPlaceNetworkSymbol={chooseNetworkSymbol} activeNetworkSymbol={networkSymbol?.id} onPlace={chooseLibraryPart}/>
        <div className="library-foot"><span className="online-dot"/>ngspice 本地计算<small>绘制电路 → 自动生成网表</small></div>
      </aside></div></div>
      </aside>
      {resizeHandle('left','调整左侧栏宽度')}<main className="workspace-center"><SinglePageWorkspace layoutKey={projectId??'standalone'} mode={layout.maximized?'schematic':pageMode} onModeChange={setPageMode} sidebarTab={sidebarTab} onSidebarTabChange={changeSidebarTab} onFitBoth={fitBoth} onRestoreLayout={()=>setPageMode('split')} selectionKey={expandedDiagramId??undefined} schematic={<> <div className="page-schematic-toolbar"><strong><Network size={15} strokeWidth={1.75} aria-hidden="true"/>原理图</strong><div><small className="schematic-view-status"><span/>{circuitFitMode==='auto'?'自动适配':'手动视图'}</small><div className="schematic-view-actions" role="group" aria-label="电路视图操作"><button className="canvas-view-action" aria-label="适配电路" title="适配电路 · 显示完整原理图" onClick={()=>{setCircuitFitMode('auto');setResetView(v=>v+1)}}><ScanLine size={17} strokeWidth={1.75} aria-hidden="true"/></button><button className="canvas-view-action" disabled={!selection.length} aria-label="查看电路选区" title={selection.length?'查看选区 · 适配选中的器件':'查看选区 · 请先选择器件'} onClick={()=>setFitSelection(v=>v+1)}><MousePointer2 size={17} strokeWidth={1.75} aria-hidden="true"/></button></div></div></div>
        <section className="drawing-workspace">
          <ConnectionWarnings shorts={topology.shorts} onLocate={short=>{setView('canvas');chooseTool('select');selectItems(short.wireIds.length?short.wireIds:[short.deviceId]);setFitSelection(v=>v+1)}}/>
          <div className="drawing-surface"><div className="workspace-canvas-host" hidden={view!=='canvas'}><DcVoltageNotice state={dcVoltages}/>{dcVoltages.tableOpen&&<BiasInspectionPanel state={dcVoltages} project={project} selection={selection} onLocate={locateBiasMeasurement} onExportSvg={exportBiasSvg}/>}<EditorCanvas viewKey={projectId??'standalone'} fitMode={circuitFitMode} onFitModeChange={setCircuitFitMode} gridSize={(previewAppearance??appearance).gridSize} active={view==='canvas'&&!showAppearance&&!editingModel} onContextMenu={setContextMenu} onEditDevice={openDeviceProperties} importedModels={project.models} placementValue={placement?.value} placementParams={placement?.params} placementGroundStyle={placement?.groundStyle} networkSymbol={networkSymbol??undefined} onPlaceNetworkSymbol={placeNetworkSymbol} onProbe={probeAt} onProbeDevice={probeDevice} onProbeWire={probeWire} onReverseProbe={reverseProbe} onProbePair={probePair} onMoveProbeLabel={moveProbeLabel} onRelocateProbe={relocateProbe} onSelectProbe={label=>selectProbe(markerIdentity(label).id)} probeMode={probeMode} showProbeMarkers={showProbeMarkers} probeMarkers={canvasProbeMarkers} pendingProbe={probePositive?{at:probePositive,anchor:probePositiveAnchor.current}:null} highlightedNet={netInfo?highlightedNet:null} onInspectNet={highlightNet} drawing={drawing} selection={selection} onSelect={selectItems} clipboard={clipboard?.drawing??null} clipboardModels={clipboard?.models} onPaste={paste} wireBend={wireBend} onWireBend={toggleWireBend} onWireBendChange={setWireBend} onZoom={setZoom} fitSelection={fitSelection} tool={tool} onTool={chooseTool} rotation={rotation} onChange={updateDrawing} onStatus={setStatus} zoom={zoom} resetView={resetView} showNodes={showNodes} dcVoltages={dcVoltages.voltages} biasMeasurements={dcVoltages.usable?dcVoltages.measurements:NO_BIAS_MEASUREMENTS} biasPrefs={dcVoltages.prefs} biasSelectedId={dcVoltages.selectedId} onBiasMove={dcVoltages.moveLabel} onBiasSelect={dcVoltages.setSelectedId} onBiasPin={dcVoltages.pin} onBiasUndo={dcVoltages.undoDisplay} onBiasRedo={dcVoltages.redoDisplay} placingBiasWire={dcVoltages.placingWire} onBiasWire={addBiasWire} onCancelBiasWire={()=>dcVoltages.setPlacingWire(false)} onLabel={openLabel}/></div><div className="editor-netlist" hidden={view!=='netlist'}><div><strong>由实际引脚连接生成</strong><button onClick={openNetlistEditor}><Code2 size={14}/>编辑 SPICE 网表</button><button disabled={!netlist} onClick={()=>download('fuxian-schematic.cir',netlist)}><ArrowDownToLine size={14}/>导出 .cir</button></div><pre>{netlist||errors.join('\n')}</pre></div></div>
          <div className="drawing-status"><span>{isDeviceTool(tool)?`点击画布放置${deviceNames[tool]} · R 旋转 · Esc 取消`:tool==='paste'?'粘贴预览 · 点击放置 · Esc 取消':tool==='wire'?'接线 · Space 换方向 · Backspace 退一步 · 右键 / Esc 取消并退出':tool==='probe'?status:tool==='net'?`网络高亮 · ${netInfo?netInfo.name+' · ':''}点击引脚、导线或标签 · Esc 清除`:tool==='label'?'标签模式 · 点击引脚或导线，再输入节点名称':tool==='pan'?'拖动平移画布 · Esc 返回选择':status}</span><button className="workspace-check-status" title={errors[0]??topology.warnings[0]??'连接检查通过'} onClick={()=>setShowIssues(true)}><span className={`state-dot ${errors.length||topology.warnings.length?'amber':''}`}/>{errors.length||topology.warnings.length?`检查 · ${errors.length+topology.warnings.length}`:'连接正常'}</button><button className="workspace-run-status" data-state={runFeedback.state} title={runFeedback.detail} onClick={()=>{const diagram=diagrams.find(item=>item.profileId===simulationProfiles.activeId&&!item.resultId)??diagrams.find(item=>item.profileId===simulationProfiles.activeId);if(diagram){expandDiagram(diagram.id);showWaveformSidebar()}else openSimulation()}}><span className={`state-dot ${['failed','stale','interrupted','recovered','warning'].includes(runFeedback.state)?'amber':''}`}/>{runFeedback.label}</button><small>{drawing.devices.length} 器件 · {drawing.wires.length} 导线</small></div>
        </section>
        </>} waveform={<>{waveformStorageWarning&&<details className="page-storage-warning"><summary>图组恢复提示</summary><p role="alert">{waveformStorageWarning}</p></details>}<div className="page-group-toolbar"><label title="当前波形图组"><Boxes size={16} aria-hidden="true"/><select aria-label="当前波形图组" value={pageDiagram?.id??''} onChange={event=>expandDiagram(event.target.value)}>{diagrams.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label><button className="wave-icon-button" aria-label="撤销图组操作" title="撤销图组操作" disabled={!timeline.present.diagramPast.length} onClick={()=>setDiagramHistory(undo)}><Undo2 size={16}/></button><button className="wave-icon-button" aria-label="重做图组操作" title="重做图组操作" disabled={!timeline.present.diagramFuture.length} onClick={()=>setDiagramHistory(redo)}><Redo2 size={16}/></button><span className="page-group-target" title={`探针目标 · 视图 ${(pageDiagram?.view?.activePanel??0)+1}`} aria-label={`探针目标 · 视图 ${(pageDiagram?.view?.activePanel??0)+1}`}><Pin size={14} aria-hidden="true"/><small>{(pageDiagram?.view?.activePanel??0)+1}</small></span><button className="wave-icon-button" aria-label="新图组" title="新图组" disabled={diagrams.length>=MAX_CANVAS_WAVEFORMS} onClick={()=>addDiagram()}><Plus size={16}/></button></div>{!diagrams.length&&<div className="page-waveform-empty"><strong>添加波形图组</strong><button onClick={()=>addDiagram()}>新建图组</button></div>}
    {diagrams.map(diagram=>{
      const profile=simulationProfiles.profiles.find(p=>p.id===diagram.profileId),configured=profile?applySimulationProfile(project,profile):project
      const history=profileHistory[diagram.profileId]??[],cachedResult=diagram.resultId?history.find(r=>r.id===diagram.resultId)??null:profileResults[diagram.profileId]??null
      const diagramResult=cachedResult?.analysis===profile?.settings.analysis?cachedResult:null
      return <EmbeddedWaveformResults onSettings={()=>openSimulation(false,diagram.id)} deviceSummary={device?<><strong>{device.id} · {deviceNames[device.kind]}</strong>{['R','C','L','OP'].includes(device.kind)?<InlineDeviceValue key={device.id} device={device} onApply={valueChange}/>:<span>{device.kind==='V'||device.kind==='I'?sourceDescription(device):device.value}</span>}<button onClick={()=>openDeviceProperties(device.id)}>详细参数</button></>:undefined} onAddProfile={()=>openSimulation(true,diagram.id)} followProbes={diagram.id===(expandedDiagramId??activeProbeDiagramId)} probeRequests={diagramProbeRequests[diagram.id]??[]} key={diagram.id} diagram={diagram} visible={pageDiagram?.id===diagram.id} profiles={simulationProfiles.profiles} result={diagramResult} history={history} running={running&&runningProfileId===diagram.profileId} busy={running} progress={progress} interrupted={interruptedProfiles[diagram.profileId]} failure={profileFailures[diagram.profileId]??''} stale={!!diagramResult&&!layoutElectricallyEquivalent(diagramResult.experiment??diagramResult.project,configured)} measurements={displayMeasurements} selectedMeasurement={selectedMeasurement} onSelectMeasurement={id=>{setSelectedMeasurement(id);setLabelTarget(null)}} onClose={returnToDiagram} onPatch={patchDiagram} onSnapshot={snapshotDiagram} onRun={()=>{run(configured,true,diagram.profileId,diagram.id)}} onAdd={()=>addDiagram()} onCopy={()=>addDiagram(diagram)} onRemove={()=>removeDiagram(diagram.id)} canAdd={diagrams.length<MAX_CANVAS_WAVEFORMS} active={!layout.maximized&&sidebarTab==='waveform'&&pageMode!=='schematic'&&pageDiagram?.id===diagram.id} fitRequest={waveFitRequests[diagram.id]} showRequest={waveShowRequests[diagram.id]} onSignalSelect={locateWaveformSignal}/>
    })}</>} properties={<aside className="editor-inspector workspace-right" id="workspace-right" aria-label="器件参数" hidden={!rightVisible}>
        <div className="page-inspector-existing" ><div className="inspector-panel-controls"><strong>器件参数与模型</strong><button type="button" aria-label="返回波形" onClick={showWaveformSidebar}>返回波形</button></div>
        <InspectorTabs value={inspectorTab} onChange={changeInspectorTab}/>
        <div className="editor-inspector-heading"><strong>{inspectorTab==='model'&&modelTarget?.modelId?`工程模型 · ${modelTarget.modelId}`:selection.length>1?`${selection.length} 项已选`:device?`${device.id} · ${deviceNames[device.kind]}`:selectedWire?`导线 ${selectedWire.id}`:selected?.startsWith('J')?`连接点 ${selected}`:'器件参数'}</strong><small>{inspectorTab==='model'?'MODEL':device?`${device.rotation}°`:'PROPERTIES'}</small></div>
        <div className="editor-inspector-scroll" ref={inspectorScroll}>
          <div id="inspector-model-panel" className="inspector-tab-panel" role="tabpanel" aria-labelledby="inspector-model-tab" hidden={inspectorTab!=='model'}>
            <SpiceCodeView onEditDeviceCode={modelTarget||device&&['D','Q','M','J'].includes(device.kind)?()=>openModelEditor(modelTarget??{deviceId:device!.id}):undefined} project={project} deviceId={device?.id} modelId={modelTarget?.modelId}/>
            {modelTarget?.modelId&&project.models?.filter(model=>model.id===modelTarget.modelId).map(model=><div className="model-search-import-actions" key={model.id}><strong>{model.id} · {model.type}</strong><SaveToUserLibrary model={model}/><button onClick={()=>placeImportedModel(model)}>放置此型号</button>{device&&device.kind===model.kind&&<button onClick={()=>applyFoundModel(model)}>应用到 {device.id} · {model.type}</button>}</div>)}
              {modelTarget?<p className="inspector-draft-note">点击“编辑器件 SPICE 代码”在弹窗中修改；校验后应用，Ctrl+Z 可撤销。</p>:<div className="inspector-model-empty"><Code2 size={25}/><strong>{device?`${device.id} 使用器件参数`:selection.length>1?'请选择单个器件':'选择器件以编辑模型'}</strong><p>{device?`${deviceNames[device.kind]}目前通过「器件编辑」调整电气参数，没有独立的可编辑 .model 定义。`:'在画布中选择二极管、三极管、MOS 管或 JFET，即可查看并编辑其 SPICE 模型。'}</p><p>支持 D、NPN / PNP、NMOS / PMOS、VDMOS、NJF / PJF 模型，也可以从模型库选择已导入的工程模型。</p><button onClick={()=>openModelLibrary()}><BookOpen size={14}/>打开 SPICE 模型库</button></div>}
          </div>
          <div id="inspector-device-panel" className="inspector-tab-panel" role="tabpanel" aria-labelledby="inspector-device-tab" hidden={inspectorTab!=='device'}>
            {netInfo&&<div className="net-inspector" aria-label="高亮网络详情"><div><strong><Network size={13}/>网络 {netInfo.name==='0'?'0 · GND':netInfo.name}</strong><button aria-label="清除网络高亮" onClick={()=>setHighlightedNet(null)}><X size={13}/></button></div><p>{netInfo.wireIds.length} 段导线 · {netInfo.terminalKeys.length} 个端点 · {netInfo.labelIds.length} 个标签</p><code>{netInfo.terminalKeys.join(' · ')}</code><small>同名标签与公共地相连；普通交叉不连接。</small></div>}
            {labelTarget&&<div className="label-editor"><div className="subsection-title">节点标签 <button aria-label="关闭标签编辑" onClick={()=>setLabelTarget(null)}><X size={13}/></button></div><small>{terminalKey(labelTarget)}</small><Field label="节点名称" value={labelName} onChange={setLabelName} hint="同名标签互连，不区分大小写。电源端口用于命名网络，实际供电由电压源提供。"/><label className="field"><span>网络符号</span><select aria-label="网络符号" value={labelStyle} onChange={e=>setLabelStyle(e.target.value as NetLabelStyle)}><option value="text">普通标签</option><option value="power">电源箭头</option><option value="input">输入端口</option><option value="output">输出端口</option><option value="bidirectional">双向端口</option></select></label><label className="field"><span>符号方向</span><select aria-label="符号方向" value={labelRotation} onChange={e=>setLabelRotation(Number(e.target.value) as Rotation)}>{[0,90,180,270].map(angle=><option key={angle} value={angle}>{angle}°</option>)}</select></label><div><button onClick={()=>applyLabel()}>应用标签</button><button onClick={()=>applyLabel('')}>移除标签</button></div></div>}
            {selection.length>1?<div className="selection-summary"><strong>已选择 {selection.length} 项</strong><p>{drawing.devices.filter(p=>selection.includes(p.id)).length} 个器件 · {drawing.wires.filter(w=>selection.includes(w.id)).length} 段导线 · {drawing.junctions.filter(j=>selection.includes(j.id)).length} 个连接点</p><p>拖动选中的器件或连接点移动整组，连接随之调整。方向键微移，Shift + 方向键移动五格。</p><div className="layout-controls" role="group" aria-label="整理器件布局"><button disabled={selectedDevices.length<2} title="器件中心对齐到首选器件的水平线" onClick={()=>arrange('align-horizontal')}>水平对齐</button><button disabled={selectedDevices.length<2} title="器件中心对齐到首选器件的竖直线" onClick={()=>arrange('align-vertical')}>垂直对齐</button><button disabled={selectedDevices.length<3} title="保留左右两端，按网格均匀分布" onClick={()=>arrange('distribute-horizontal')}>水平等距</button><button disabled={selectedDevices.length<3} title="保留上下两端，按网格均匀分布" onClick={()=>arrange('distribute-vertical')}>垂直等距</button></div><p>对齐以首选器件为基准；等距需至少 3 个器件，间隔按网格取整。导线随引脚调整。</p><div><button onClick={duplicate}><Copy size={13}/>放置副本</button><button onClick={()=>setFitSelection(v=>v+1)}><ScanLine size={13}/>查看选区</button></div><p>Shift 点击增减选区；点击空白处取消选择。选中单个器件可编辑其参数。</p></div>:device?<>
              <div className="selected-device-preview"><svg viewBox="-75 -75 150 150"><DeviceSymbol device={device} symbol={project.models?.find(m=>m.kind===device.kind&&m.id.toLowerCase()===device.value.toLowerCase())?.symbol} modelType={project.models?.find(m=>m.kind===device.kind&&m.id.toLowerCase()===device.value.toLowerCase())?.type}/></svg><div><strong>{device.id}</strong><small>{deviceNames[device.kind]}{primary?' · 输入激励':''}</small></div></div>
              <RefdesEditor key={device.id} device={device} onRename={renameSelected}/>
              <div className="device-value-fields">
              {device.kind==='X'&&project.models?.filter(model=>model.kind==='X'&&model.id.toLowerCase()===device.value.toLowerCase()).map(model=><SubcircuitParameters key={`${device.id}:${model.id}`} device={device} model={model} onChange={next=>updateDrawing({...drawing,devices:drawing.devices.map(part=>part.id===device.id?next:part)})}/>)}
              {device.kind==='GND'&&<label className="field"><span>接地符号</span><select aria-label="接地符号" value={device.groundStyle??'earth'} onChange={e=>updateDrawing({...drawing,devices:drawing.devices.map(part=>part.id===device.id?{...part,groundStyle:e.target.value as 'earth'|'signal'|'chassis'}:part)})}><option value="earth">标准接地</option><option value="signal">信号地</option><option value="chassis">机壳地</option></select></label>}
              {device.kind==='V'||device.kind==='I'?<SourceParameters device={device} project={project} onChange={next=>updateDrawing({...drawing,devices:drawing.devices.map(part=>part.id===next.id?next:part)})}/>:deviceParameterDefinitions[device.kind]?<DeviceParameters device={device} onChange={next=>updateDrawing({...drawing,devices:drawing.devices.map(part=>part.id===next.id?next:part)})}/>:['D','Q','M','J'].includes(device.kind)?<><label className="field"><span>器件模型</span><select value={device.value} onChange={e=>valueChange(e.target.value)}>{availableModels(device.kind,project.models).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><p className="model-note">{modelFor(device.kind,device.value,project.models)?.detail}</p>{project.models?.filter(m=>m.kind===device.kind&&m.id.toLowerCase()===device.value.toLowerCase()).map(m=><div key={m.id} className="imported-model-note">外部模型 · {m.type}<br/>来源：{m.source.url?<a href={m.source.url} target="_blank" rel="noreferrer">{m.source.label}</a>:m.source.label}<br/>{m.source.license||'未提供许可信息'}</div>)}</>:device.kind!=='GND'&&!primary&&<Field label={device.kind==='OP'?'开环增益':'元件数值'} value={device.value} onChange={valueChange} hint={device.kind==='R'?'例如 1k、4.7k、1MΩ':device.kind==='C'?'例如 10nF、100nF、1uF':device.kind==='L'?'例如 1mH、10mH':device.kind==='OP'?'有限增益理想模型；无电源轨、饱和和带宽限制。':'例如 5V、-5V'}/>}
              {device.kind==='V'&&!primary&&<button className="set-input-button" onClick={()=>updateDrawing({...drawing,sourceId:device.id})}>设为输入激励电源</button>}
              </div>
              <div className="pin-list">{pinsFor(device).map(pin=><div key={pin}><span>{deviceCatalog[device.kind].pins[pin]}</span><code>{topology.nodes.get(`${device.id}:${pin}`)}</code><button title="高亮此引脚所在网络" aria-label={`高亮 ${device.id} 引脚 ${pin+1}`} onClick={()=>highlightNet({device:device.id,pin})}><Network size={12}/></button><button title="添加此引脚的电压测量" aria-label={`探测 ${device.id} 引脚 ${pin+1}`} onClick={()=>inspectorProbe({device:device.id,pin})}><Pin size={12}/></button><button title="编辑节点标签" aria-label={`标记 ${device.id} 引脚 ${pin+1}`} onClick={()=>openLabel({device:device.id,pin})}><Tag size={12}/></button></div>)}</div>
            </>:selectedWire?<><p className="field-hint">{terminalKey(selectedWire.from)} → {terminalKey(selectedWire.to)}</p><button className="set-input-button" onClick={()=>updateDrawing({...drawing,wires:drawing.wires.map(w=>w.id===selectedWire.id?{...w,bend:w.bend==='hv'?'vh':'hv',waypoints:undefined}:w)})}>切换直角走线方向</button><button className="set-input-button" disabled={!selectedWire.waypoints?.length} onClick={()=>updateDrawing({...drawing,wires:drawing.wires.map(w=>w.id===selectedWire.id?{...w,waypoints:undefined}:w)})}>恢复自动走线</button><p className="field-hint">V 选择模式直接拖动线段，或拖动选中导线的拐点；无分支转角及标签随线移动，器件引脚与分支保持连接。方向键微移，Esc / 右键取消拖动，Ctrl+Z 撤销。切换方向会恢复自动走线；Delete 删除整条导线。</p></>:<p className="inspector-intro">{selected?.startsWith('J')?'拖动此连接点可调整走线，保持分支连接。方向键微移，Delete 删除连接点及相连导线。':'选中器件修改数值。拖动空白处框选，Shift 点击多选；Ctrl+C / V 复制粘贴。分析参数请打开「仿真设置」。'}</p>}
          </div>
        </div>


      </div></aside>}/></main>
      {resizeHandle('ai','调整 AI 助手宽度')}{aiMounted&&<AssistantSidebar visible={showAi} onMinimize={()=>dispatchLayout({type:'close-ai'})} onClose={closeAi} activeTab={assistantTab} onTabChange={selectAssistantTab} explanation={projectId && explanationMounted ? <CircuitExplanationAssistant key={projectId} projectId={projectId} project={project} circuit={desktopCircuit}/> : projectId ? <div className="circuit-explanation-intro">切到“解释”后建立当前项目的专属子对话。</div> : undefined}>{chatMounted&&<AiAssistant desktopCircuit={desktopCircuit} onOpenSettings={openSettings} onModelAcquisitions={receiveModelAcquisitions} onOpenModels={()=>openModelLibrary('local')} embedded projectId={projectId} project={project} onApply={applyAi} onClose={closeAi}/>}</AssistantSidebar>}
    </div>

    {netlistEditorMounted&&<SpiceNetlistEditor visible={showNetlistEditor} onClose={()=>setShowNetlistEditor(false)} projectId={projectId??'standalone'} title={project.title} netlist={netlist} generationError={errors.join('\n')}/>}
    <ModelSearchDialog key={modelSearchScope} visible={showModelSearch} onClose={()=>setModelSearchVisibleFor(undefined)} onOpenLibrary={()=>{setModelSearchVisibleFor(undefined);openModelLibrary('local')}}
      onDropDatasheet={file=>setModelAssistantDrop({projectId:modelSearchScope,file,requestId:++modelDropSequence.current})}
      assistant={modelAssistantMounted&&<ModelAcquisitionAssistant projectId={projectId} project={project} visible={showModelSearch} onSaveToUserLibrary={requestModelSave} onImport={importFoundModel} droppedFile={modelAssistantDrop?.projectId===modelSearchScope?modelAssistantDrop:undefined}/>}
      manual={modelAssistantMounted&&<ManualModelBuilder projectId={projectId} models={project.models??[]} onImport={importFoundModel} onSaveToUserLibrary={requestModelSave}/>}/>
    {showModels&&<SpiceLibrary project={project} onImportAndPlaceModel={importAndPlaceLibraryModel} initialPage={modelLibraryInitialPage} acquisitions={modelAcquisitions} onImportAcquired={importFoundModel} onChange={models=>{commit(p=>({...p,models}));setStatus('模型库已更新，可用 Ctrl+Z 撤销。')}} onPlace={placeImportedModel} onEditModel={modelId=>{setShowModels(false);openModelEditor({modelId})}} onClose={()=>setShowModels(false)}/>}
  </div></div> {showSimulation&&<SimulationSettings key={`${profileTarget??'project'}:${createProfile?'new':'edit'}`} project={inlineProject} profiles={inlineProfiles} newProfile={createProfile} runRequest={settingsRunRequest} busy={running} onApplyAndRun={applySettingsAndRun} onProfilesApply={applyProfiles} onApply={next=>{pendingSimulationProject.current=profileTarget?null:next}} onClose={()=>{setShowSimulation(false);setCreateProfile(false);setProfileTarget(null)}}/>} <FinalTestReportDialog open={showFinalReport} onClose={()=>setShowFinalReport(false)} project={project} projectId={projectId??undefined} profiles={simulationProfiles.profiles} results={profileResults} onReportChange={report=>commit(current=>({...current,report}))}/> {contextMenu&&<CanvasContextMenu request={contextMenu} items={contextItems} title={contextMenu.probeLabel??(contextTerminal?'网络操作':contextDevice?.id??'原理图')} onAction={contextAction} onClose={()=>setContextMenu(null)}/>} {modelToSave&&<SaveLibraryDialog model={modelToSave} onClose={closeModelSave} onSaved={()=>finishModelSave(true)}/>} {editingModel&&<ModelEditorDialog project={project} {...editingModel} onApply={next=>{commit(next);setStatus('模型已更新到当前工程，Ctrl+Z 可撤销；请重新运行仿真。')}} onClose={closeModelEditor}/>} {showIssues&&<ConnectionCheck errors={[...errors,...topology.warnings,...waveformIssueMessages(waveformWarnings,waveformSetup)]} onClose={()=>setShowIssues(false)}/>} {showAppearance&&<AppearanceSettings value={appearance} onChange={setAppearance} onPreview={setPreviewAppearance} onClose={()=>{setShowAppearance(false);setPreviewAppearance(null)}}/>}  {showSettings&&<SettingsDialog projectId={projectId??undefined} onClose={closeSettings} onOpenAppearance={()=>{closeSettings();setShowAppearance(true)}} onOpenSimulation={()=>{closeSettings();openSimulation()}} onOpenDesktopChat={()=>{closeSettings();openAi()}}/>} {galleryOpen&&<TemplateGallery onClose={()=>changeExamples(false)} onUse={id=>{loadTemplate(id);changeExamples(false)}}/>}</>
}
