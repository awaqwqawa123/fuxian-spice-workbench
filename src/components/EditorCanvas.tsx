import {readCanvasViewPreference,saveCanvasViewPreference} from '../core/canvas-view-preferences'
import { canProbeCurrent } from '../core/branch-currents'
import { deviceCatalog, deviceKinds, pinsFor } from '../core/devices'
import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent } from 'react'
import {useCanvasNavigation} from './useCanvasNavigation'
import {NetSymbolGraphic} from './NetSymbolGraphic'
import {CanvasDeviceArtwork,CanvasDeviceHitArea,CanvasWire,CanvasPin,type CanvasDeviceView,type CanvasItemActions} from './CanvasCircuitItems'
import {networkSymbolPresets,type NetworkSymbolPreset} from '../core/net-symbol-presets'
import type {GroundStyle} from '../core/drawing'
import {clampCanvasZoom} from '../core/canvas-zoom'
import { addDevice, CANVAS, clampCoordinate, compileDrawing, createDrawingRenderCache, connect, joinAtWire, nextId, pinPosition, sameTerminal, snap, terminal, terminalKey, terminalPosition, wirePath, wirePoints, type Device, type DeviceKind, type Drawing, type Pin, type Rotation, type Terminal, type Wire, type XY } from '../core/drawing'
import { moveWireCorner, moveWireSegment, nearestWireSegment } from '../core/wire-edit'
import { fitView, moveSelection, positionClipboard, rectangle, selectRectangle, selectionBounds } from '../core/selection'
import { inspectNet } from '../core/net-tools'
import { nearestProbeTarget, nearestWireProbeTarget, probePoint, projectOnWire, wireProbeAngle, type ProbeTarget, type WireAnchor } from '../core/probe-placement'
import { probeTypes, type ProbeType } from '../core/probes'
import type { CanvasContextRequest } from '../core/context-menu'
import { canvasPoint, continuedWireBend, createWireSnapIndex, initialWireBend, nearestWireTarget, wireGridPoint, type WireSnapTarget } from '../core/wire-routing'
import { nodeAnnotations } from '../core/canvas-annotations'
import { biasPlacementRect, layoutBiasMeasurements, type BiasDisplayPreferences } from '../core/bias-display'
import type { BiasMeasurement } from '../core/bias-inspection'
import BiasCanvasLayer from './BiasCanvasLayer'
import { placeNetLabels } from '../core/schematic-layout'
import { junctionAppearances } from '../core/junction-appearance'
import { libraryPartById } from '../core/library'
import { fitCanvasView, moveCanvasDiagrams, selectCanvasDiagrams, type CanvasDiagramGeometry } from '../core/canvas-diagrams'
import CanvasWaveformDiagram, { type CanvasDiagram } from './CanvasWaveformDiagram'
import ComponentValueEditor, { hasQuickValue } from './ComponentValueEditor'
export type { CanvasContextRequest } from '../core/context-menu'
export type EditorTool = 'select' | 'wire' | 'probe' | 'pan' | 'label' | 'paste' | 'net' | DeviceKind
export const isDeviceTool = (tool: EditorTool): tool is DeviceKind => deviceKinds.includes(tool as DeviceKind)
const NO_IMPORTED_MODELS:ImportedSpiceModel[]=[]
const NO_CANVAS_DIAGRAMS:CanvasDiagram[]=[]

import { DeviceSymbol } from './DeviceSymbol'
import { ProbeBadgeGlyph, ProbeLeader, ProbeTipGlyph, StaticProbeMarker } from './ProbeGlyphs'
import { layoutProbeMarkers, measurementProbeMarkers, probeBadgeWidth, probeCurrentAngle, probeMarkerBounds, type ProbeMarker } from '../core/probe-layout'
import type { ImportedSpiceModel } from '../core/spice-models'
import { modelDeviceBounds, presentedModelSymbol } from '../core/model-symbol-presentation'
import { deviceCaptionLayout } from '../core/device-caption-geometry'
export { DeviceSymbol } from './DeviceSymbol'

interface Props {
  active?:boolean
  drawing:Drawing; selection:string[]; onSelect:(ids:string[])=>void
  tool:EditorTool; onTool:(tool:EditorTool)=>void; rotation:Rotation
  onChange:(drawing:Drawing,preserveConnections?:boolean)=>void; onStatus:(message:string)=>void
  onEditDevice?:(id:string)=>void
  zoom:number; onZoom:(zoom:number)=>void; resetView:number; fitSelection:number
  viewKey?:string; fitMode?:'auto'|'manual'; onFitModeChange?:(mode:'auto'|'manual')=>void
  showNodes:boolean; onLabel?:(at:Terminal)=>void
  dcVoltages?:Map<string,number>
  biasMeasurements?:BiasMeasurement[];biasPrefs?:BiasDisplayPreferences;biasSelectedId?:string
  onBiasMove?:(id:string,offset:XY)=>void;onBiasSelect?:(id:string)=>void;onBiasPin?:(id:string)=>void
  onBiasUndo?:()=>void;onBiasRedo?:()=>void
  placingBiasWire?:boolean;onBiasWire?:(anchor:WireAnchor)=>void;onCancelBiasWire?:()=>void
  networkSymbol?:NetworkSymbolPreset
  onPlaceNetworkSymbol?:(preset:NetworkSymbolPreset,at:Terminal,base:Drawing,rotation:Rotation)=>void
  wireBend:'hv'|'vh'; onWireBend:()=>void
  onWireBendChange?:(bend:'hv'|'vh')=>void
  clipboard:Drawing|null; clipboardModels?:ImportedSpiceModel[]; onPaste:(at:XY)=>void
  highlightedNet?:Terminal|null; onInspectNet?:(at:Terminal)=>void
  onProbe?:(at:Terminal,anchor?:WireAnchor)=>void; onProbeDevice?:(id:string)=>void
  onProbeWire?:(anchor:WireAnchor)=>void; onReverseProbe?:(label:string)=>void
  onProbePair?:(positive:ProbeTarget,negative:ProbeTarget)=>void
  onMoveProbeLabel?:(label:string,offset:XY)=>void
  onRelocateProbe?:(label:string,target:ProbeTarget,offset?:XY)=>void
  onSelectProbe?:(label:string)=>void
  probeMode?:ProbeType
  probeMarkers?:ProbeMarker[]
  showProbeMarkers?:boolean
  pendingProbe?:{at:Terminal;anchor?:WireAnchor}|null
  placementValue?:string
  placementParams?:Record<string,string>
  placementGroundStyle?:GroundStyle
  importedModels?:ImportedSpiceModel[]
  onContextMenu?:(request:CanvasContextRequest)=>void
  canvasDiagrams?:CanvasDiagram[]
  onDiagramChange?:(id:string,geometry:CanvasDiagramGeometry)=>void
  onDiagramExpand?:(id:string)=>void
  selectedDiagramId?:string|null
  selectedDiagramIds?:string[]
  onDiagramSelect?:(id:string|null)=>void
  onSheetSelect?:(circuitIds:string[],diagramIds:string[],activeDiagramId:string|null)=>void
  onDiagramGroupChange?:(changes:CanvasDiagramGeometry[])=>void
  gridSize?:number
}
type DragState={base:Drawing;preview:Drawing;ids:string[];start:XY;delta:XY;client:XY;label?:Terminal}
type WireDrag={base:Drawing;preview:Drawing;id:string;kind:'segment'|'corner'|'group';index:number;ids:string[];start:XY;client:XY;delta:XY;routeOrigin:XY;horizontal:boolean;previewDelta:XY;started:boolean;pointerId:number}
function wireDragDrawing(state:WireDrag):Drawing {
  if(!state.started)return state.base
  if(state.kind==='group')return moveSelection(state.base,state.ids,state.delta)
  return(state.kind==='corner'?moveWireCorner:moveWireSegment)(state.base,state.id,state.index,state.delta)
}
type Marquee={start:XY;at:XY;additive:boolean;intersect:boolean;original:string[];originalDiagrams:string[]}
type PanState=
  |{client:XY;center:XY;sx:number;sy:number;button:0|1|2;pointerId:number;started:boolean;target:Element;anchor?:XY;resumeZoom?:boolean}
type MiddleZoomState={client:XY;center:XY;zoom:number;anchor:XY}
type WireStep={draft:Drawing;pending:Terminal;bend:'hv'|'vh';manualBend?:boolean}
type WireSession=WireStep&{base:Drawing;steps:WireStep[]}
type ProbeDrag=({kind:'label';label:string;start:XY;offset:XY;previewOffset:XY;scale:number}|{kind:'tip';label:string;wireOnly?:boolean;start:XY;origin:XY;point:XY;offset:XY;target:ProbeTarget|null}|{kind:'difference';start:ProbeTarget;client:XY})&{pointerId:number;base:Drawing}
// Parent status/chat/progress updates recreate handlers but do not change the
// circuit. Keep their dispatch current while memoizing the expensive scene.
// Callback presence still participates in React's normal shallow comparison.
export default function EditorCanvas(props:Props) {
  const current=useRef(props),handlers=useRef(new Map<string, (...args:unknown[])=>unknown>())
  current.current=props
  const stable={...props} as Props&Record<string,unknown>
  for(const [key,value] of Object.entries(props))if(key.startsWith('on')&&typeof value==='function'){
    let handler=handlers.current.get(key)
    if(!handler){handler=(...args:unknown[])=>(current.current[key as keyof Props] as ((...args:unknown[])=>unknown)|undefined)?.(...args);handlers.current.set(key,handler)}
    stable[key]=handler
  }
  return <MemoCanvasScene {...stable}/>
}
const MemoCanvasScene=memo(EditorCanvasScene)
function EditorCanvasScene({active=true,drawing,selection,onSelect,tool,onTool,rotation,onChange,onStatus,zoom,onZoom,resetView,fitSelection,fitMode='manual',onFitModeChange,viewKey,showNodes,dcVoltages,biasMeasurements,biasPrefs,biasSelectedId,onBiasMove,onBiasSelect,onBiasPin,onBiasUndo,onBiasRedo,placingBiasWire,onBiasWire,onCancelBiasWire,onLabel,wireBend,onWireBendChange,clipboard,clipboardModels=NO_IMPORTED_MODELS,onPaste,highlightedNet,onInspectNet,onProbe,onProbeDevice,onProbeWire,onReverseProbe,onProbePair,onMoveProbeLabel,onRelocateProbe,onSelectProbe,probeMode='voltage',probeMarkers:givenProbeMarkers,showProbeMarkers=true,pendingProbe,placementValue,placementParams,placementGroundStyle,networkSymbol,onPlaceNetworkSymbol,importedModels=NO_IMPORTED_MODELS,onContextMenu,onEditDevice,canvasDiagrams=NO_CANVAS_DIAGRAMS,onDiagramChange,onDiagramExpand,selectedDiagramId,selectedDiagramIds,onDiagramSelect,onSheetSelect,onDiagramGroupChange,gridSize=20}:Props) {
  const svg=useRef<SVGSVGElement>(null)
  const itemActions=useRef<CanvasItemActions>(null!)
  const deviceViewCache=useRef(new WeakMap<Device,CanvasDeviceView>())
  const geometryCache=useRef<ReturnType<typeof createDrawingRenderCache>|null>(null)
  if(!geometryCache.current)geometryCache.current=createDrawingRenderCache()
  const diagramSelection=selectedDiagramIds??(selectedDiagramId?[selectedDiagramId]:[])
  const [diagramPreview,setDiagramPreview]=useState<{id:string;changes:CanvasDiagramGeometry[]}|null>(null)
  const [editingValue,setEditingValue]=useState<string|null>(null)
  const [hoveredDevice,setHoveredDevice]=useState<string|null>(null)
  const valueDevice=drawing.devices.find(part=>part.id===editingValue)
  const deviceCapture=useRef<{element:SVGGElement;pointerId:number}|null>(null)
  const [wireSession,setWireSession]=useState<WireSession|null>(null)
  const [hover,setHover]=useState<XY|null>(null)
  const hoverFrame=useRef<number|null>(null),hoverPreview=useRef<(()=>void)|null>(null)
  const interactionFrame=useRef<number|null>(null),interactionPreview=useRef<(()=>void)|null>(null)
  const [drag,setDrag]=useState<DragState|null>(null),dragRef=useRef<DragState|null>(null)
  const [wireDrag,setWireDrag]=useState<WireDrag|null>(null),wireDragRef=useRef<WireDrag|null>(null)
  const [marquee,setMarquee]=useState<Marquee|null>(null),marqueeRef=useRef<Marquee|null>(null)
  const pan=useRef<PanState|null>(null)
  const middleZoom=useRef<MiddleZoomState|null>(null)
  const [middleZooming,setMiddleZooming]=useState(false)
  const [middlePanning,setMiddlePanning]=useState(false)
  const suppressContextMenu=useRef(false),lastBendProp=useRef(wireBend)
  const [viewport,setViewport]=useState(CANVAS)
  const viewportSize=useRef(CANVAS),initialFitDone=useRef(false),lastReset=useRef(resetView)
  const restoredView=useMemo(()=>readCanvasViewPreference(viewKey),[viewKey])
  const cameraPublished=useRef(false)
  const biasFitBounds=useRef<ReturnType<typeof biasPlacementRect>[]>([])
  const fitOptions=useRef({drawing,canvasDiagrams,fitMode,onFitModeChange})
  fitOptions.current={drawing,canvasDiagrams,fitMode,onFitModeChange}
  const acknowledgedZoom=useRef(zoom),priorZoom=useRef(zoom),priorFitMode=useRef(fitMode)
  function manualNavigation(){if(fitOptions.current.fitMode!=='manual'){fitOptions.current.fitMode='manual';fitOptions.current.onFitModeChange?.('manual')}}
  const baseGrid=[10,20,40,80].includes(gridSize)?gridSize:20
  const navigation=useCanvasNavigation(svg,zoom,value=>{acknowledgedZoom.current=value;onZoom(value)},viewportSize,baseGrid)
  const {center,zoom:viewZoom}=navigation.view
  const viewWidth=viewport.width/viewZoom,viewHeight=viewport.height/viewZoom
  const viewX=center.x-viewWidth/2,viewY=center.y-viewHeight/2
  const [screenScale,setScreenScale]=useState(1),[probeHover,setProbeHover]=useState<ProbeTarget|null>(null)
  // Persistent artwork uses sheet units, just like symbols and device text.
  // Only invisible interaction targets and temporary snap hints use screen units.
  const probeScale=1,probeScreenScale=screenScale
  const probeDrag=useRef<ProbeDrag|null>(null),[probeDragView,setProbeDragView]=useState<ProbeDrag|null>(null)
  const pending=wireSession?.pending??null
  const routingBend=wireSession?.bend??wireBend
  const working=wireSession?.base===drawing?wireSession.draft:drawing
  const visibleSource=wireDrag?.base===drawing?wireDrag.preview:drag?.base===drawing?drag.preview:working
  // Only these read-only render views share exact route geometry. All edits use
  // the original document, preserving mutable helper and transaction semantics.
  const workingGeometry=geometryCache.current.snapshot(working)
  const visible=geometryCache.current.snapshot(visibleSource)
  const probeMarkers=useMemo(()=>showProbeMarkers?layoutProbeMarkers(visible,givenProbeMarkers??measurementProbeMarkers(visible)):[],[visible,givenProbeMarkers,showProbeMarkers])
  const marqueeIds=marquee?selectRectangle(drawing,rectangle(marquee.start,marquee.at),marquee.intersect):[]
  const selected=useMemo(()=>new Set(marquee?marquee.additive?[...marquee.original,...marqueeIds]:marqueeIds:selection),[marquee,selection])
  const marqueeDiagrams=marquee?selectCanvasDiagrams(canvasDiagrams,rectangle(marquee.start,marquee.at),marquee.intersect):[]
  const selectedFrames=new Set(marquee?marquee.additive?[...marquee.originalDiagrams,...marqueeDiagrams]:marqueeDiagrams:diagramSelection)
  // Moving artwork does not change the electrical graph. Recompile only when
  // an edit is committed or an unfinished connection changes the working graph.
  const topology=useMemo(()=>compileDrawing(working),[working])
  const shortMessages=useMemo(()=>new Map(topology.shorts.map(short=>[short.deviceId,short.message])),[topology])
  const shortWireMessages=useMemo(()=>new Map(topology.shorts.flatMap(short=>short.wireIds.map(id=>[id,short.message] as const))),[topology])
  const annotations=useMemo(()=>showNodes?nodeAnnotations(visible,topology.nodes):[],[visible,topology,showNodes])
  const biasPlacements=useMemo(()=>biasMeasurements?.length&&biasPrefs&&working===drawing?layoutBiasMeasurements(visible,biasMeasurements,{prefs:biasPrefs,selected:selection,models:importedModels,probes:[],obstacles:[...canvasDiagrams.map(frame=>({left:frame.x,top:frame.y,right:frame.x+frame.width,bottom:frame.y+frame.height})),...probeMarkers.map(marker=>probeMarkerBounds(visible,marker))]}):[],[visible,biasMeasurements,biasPrefs,working,drawing,selection,importedModels,canvasDiagrams,probeMarkers])
  biasFitBounds.current=biasPlacements.map(biasPlacementRect)
  const netLabelPlacements=useMemo(()=>new Map(placeNetLabels(visible).map(item=>[item.label.id,item])),[visible])
  const labeledNets=useMemo(()=>new Set((visible.labels??[]).map(label=>topology.nodes.get(terminalKey(label.at)))),[visible.labels,topology])
  const net=useMemo(()=>highlightedNet&&topology.nodes.has(terminalKey(highlightedNet))?inspectNet(working,highlightedNet,topology.nodes):null,[working,highlightedNet,topology])
  const highlightedTerminals=useMemo(()=>new Set(net?.terminalKeys),[net]),highlightedWires=useMemo(()=>new Set(net?.wireIds),[net]),highlightedLabels=useMemo(()=>new Set(net?.labelIds),[net])
  const linked=useMemo(()=>new Set(working.wires.flatMap(w=>[terminalKey(w.from),terminalKey(w.to)])),[working])
  const labelConnected=useMemo(()=>{
    const counts=new Map<string,number>()
    for(const label of visible.labels??[]){const name=label.name.toLowerCase();counts.set(name,(counts.get(name)??0)+1)}
    return new Set((visible.labels??[]).filter(label=>(counts.get(label.name.toLowerCase())??0)>1).map(label=>terminalKey(label.at)))
  },[visible.labels])
  const junctionMarkers=useMemo(()=>junctionAppearances(workingGeometry),[workingGeometry])
  const wirePaths=useMemo(()=>new Map(visible.wires.map(w=>[w.id,wirePath(visible,w)])),[visible])
  const selectedWireId=tool==='select'&&selected.size===1?[...selected][0]:null
  const wireCorners=useMemo(()=>{const wire=visible.wires.find(w=>w.id===selectedWireId);return wire?wirePoints(visible,wire):undefined},[visible,selectedWireId])
  const modelLookup=useMemo(()=>{const models=new Map<string,ImportedSpiceModel>();for(const model of importedModels){const key=`${model.kind}:${model.id.toLowerCase()}`;if(!models.has(key))models.set(key,model)}return models},[importedModels])
  const pasteModelLookup=useMemo(()=>new Map([...importedModels,...clipboardModels].map(model=>[`${model.kind}:${model.id.toLowerCase()}`,model])),[importedModels,clipboardModels])
  const deviceViews=useMemo(()=>visible.devices.map(part=>{
    const model=modelLookup.get(`${part.kind}:${part.value.toLowerCase()}`),cached=deviceViewCache.current.get(part)
    if(cached&&cached.model===model)return cached
    const symbol=model?presentedModelSymbol(model,part):undefined
    const bounds=part.kind==='X'?modelDeviceBounds(part,symbol):undefined
    const extended=pinsFor(part).length>3||['LDO','XFMR'].includes(part.kind)
    const vertical=!extended&&(part.rotation===90||part.rotation===270||pinsFor(part).length===3)
    const hitBox={x:bounds?.left??(extended?-54:vertical?-32:-34),y:bounds?.top??(extended?-48:vertical?-34:-30),width:bounds?bounds.right-bounds.left:extended?108:vertical?64:68,height:bounds?bounds.bottom-bounds.top:extended?96:vertical?68:part.kind==='GND'?67:60}
    const view={part,model,symbol,caption:deviceCaptionLayout(part,bounds),hitBox}
    deviceViewCache.current.set(part,view)
    return view
  }),[visible.devices,modelLookup])
  const wireIndex=useMemo(()=>createWireSnapIndex(workingGeometry),[workingGeometry])
  const wireTarget=tool==='wire'&&hover?nearestWireTarget(wireIndex,hover,screenScale):null
  function hoverDevice(id:string|null){if(!pan.current&&!middleZoom.current&&!navigation.pending.current&&!dragRef.current&&!wireDragRef.current)setHoveredDevice(id)}
  function cancelInteractionFrame(){if(interactionFrame.current!==null)window.cancelAnimationFrame?.(interactionFrame.current);interactionFrame.current=null;interactionPreview.current=null}
  function queueInteractionPreview(update:()=>void){
    interactionPreview.current=update
    if(typeof window.requestAnimationFrame!=='function'){update();return}
    if(interactionFrame.current!==null)return
    interactionFrame.current=window.requestAnimationFrame(()=>{interactionFrame.current=null;const update=interactionPreview.current;interactionPreview.current=null;if(update)safe(update)})
  }
  function cancelHoverFrame(){if(hoverFrame.current!==null)window.cancelAnimationFrame?.(hoverFrame.current);hoverFrame.current=null;hoverPreview.current=null}
  function queueHoverPreview(update:()=>void){
    hoverPreview.current=update
    if(typeof window.requestAnimationFrame!=='function'){hoverPreview.current=null;update();return}
    if(hoverFrame.current!==null)return
    hoverFrame.current=window.requestAnimationFrame(()=>{hoverFrame.current=null;const update=hoverPreview.current;hoverPreview.current=null;if(update)safe(update)})
  }
  function setHoverPoint(point:XY){setHover(previous=>previous?.x===point.x&&previous.y===point.y?previous:point)}
  function updateWireHover(point:XY){
    queueHoverPreview(()=>setHoverPoint(canvasPoint(point)))
  }
  function cancelGesture(){
    navigation.commit()
    cancelInteractionFrame()
    cancelHoverFrame()
    const captured=wireDragRef.current?.pointerId??pan.current?.pointerId??probeDrag.current?.pointerId
    const devicePointer=deviceCapture.current;deviceCapture.current=null
    if(pan.current?.button===2)suppressContextMenu.current=true
    wireDragRef.current=null;setWireDrag(null);setDrag(null);dragRef.current=null;setMarquee(null);marqueeRef.current=null;pan.current=null;middleZoom.current=null;setMiddleZooming(false);setMiddlePanning(false);if(probeDrag.current)setProbeHover(null);probeDrag.current=null;setProbeDragView(null)
    if(captured!==undefined&&svg.current?.hasPointerCapture?.(captured))svg.current.releasePointerCapture(captured)
    if(devicePointer?.element.hasPointerCapture?.(devicePointer.pointerId))devicePointer.element.releasePointerCapture(devicePointer.pointerId)
  }
  function syncWireBend(bend:'hv'|'vh'){
    if(onWireBendChange){lastBendProp.current=bend;onWireBendChange(bend)}
  }
  useEffect(()=>{
    if(lastBendProp.current===wireBend)return
    lastBendProp.current=wireBend
    setWireSession(session=>session?{...session,bend:onWireBendChange?wireBend:session.bend==='hv'?'vh':'hv',manualBend:true}:session)
  },[wireBend,onWireBendChange])
  useEffect(()=>{
    const update=()=>{
      const bounds=svg.current?.getBoundingClientRect()
      // A mounted canvas may be hidden behind the netlist or waveform view.
      // Keep its last valid geometry until the host becomes visible again.
      if(!bounds||bounds.width<=0||bounds.height<=0)return
      const {width,height}=bounds
      const resized=Math.abs(viewportSize.current.width-width)>=.01||Math.abs(viewportSize.current.height-height)>=.01
      viewportSize.current={width,height}
      setViewport(previous=>Math.abs(previous.width-width)<.01&&Math.abs(previous.height-height)<.01?previous:{width,height})
      // Automatic mode follows the actual host dimensions. Manual mode keeps
      // the camera's center and screen scale while revealing more/less world.
      // Read current document data rather than the mount-time observer closure.
      if(!initialFitDone.current||resized&&fitOptions.current.fitMode==='auto'&&!pan.current&&!middleZoom.current&&!dragRef.current&&!wireDragRef.current&&!probeDrag.current&&!marqueeRef.current){
        const options=fitOptions.current
        const restore=!initialFitDone.current&&restoredView?.mode==='manual'?restoredView:null
        const view=restore??fitCanvasView(options.drawing,options.canvasDiagrams,{width,height},initialFitDone.current?undefined:1.2,biasFitBounds.current)
        if(restore){options.fitMode='manual';options.onFitModeChange?.('manual')}
        initialFitDone.current=true;navigation.jump(view.center,view.zoom)
      }
      const matrix=svg.current?.getScreenCTM?.();if(matrix?.a&&Number.isFinite(matrix.a))setScreenScale(Math.abs(matrix.a))
    }
    initialFitDone.current=false;cameraPublished.current=false
    update();const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(update):null
    if(svg.current)observer?.observe(svg.current)
    return()=>observer?.disconnect()
  },[viewKey])
  const latestCamera=useRef({project:viewKey,value:{version:1 as const,center,zoom:viewZoom,mode:fitMode}})
  latestCamera.current={project:viewKey,value:{version:1,center,zoom:viewZoom,mode:fitMode}}
  useEffect(()=>{
    if(!viewKey||!initialFitDone.current)return
    if(!cameraPublished.current){cameraPublished.current=true;return}
    const timer=setTimeout(()=>saveCanvasViewPreference(viewKey,{version:1,center,zoom:viewZoom,mode:fitMode}),150)
    return()=>clearTimeout(timer)
  },[viewKey,center.x,center.y,viewZoom,fitMode])
  useEffect(()=>()=>{if(cameraPublished.current)saveCanvasViewPreference(latestCamera.current.project,latestCamera.current.value)},[])
  useEffect(()=>{if(priorZoom.current===zoom)return;priorZoom.current=zoom;if(acknowledgedZoom.current!==zoom)manualNavigation()},[zoom])
  useEffect(()=>{
    if(priorFitMode.current===fitMode)return
    priorFitMode.current=fitMode
    if(fitMode==='auto'&&initialFitDone.current){const view=fitCanvasView(drawing,canvasDiagrams,viewportSize.current,1.5,biasFitBounds.current);navigation.jump(view.center,view.zoom)}
  },[fitMode])
  useEffect(()=>{const m=svg.current?.getScreenCTM?.();if(m?.a&&Number.isFinite(m.a))setScreenScale(Math.abs(m.a))},[viewZoom,viewport])
  useEffect(()=>{if(lastReset.current===resetView)return;lastReset.current=resetView;const bounds=svg.current?.getBoundingClientRect();const size=bounds&&bounds.width>0&&bounds.height>0?bounds:viewportSize.current;const view=fitCanvasView(drawing,canvasDiagrams,size,1.5,biasFitBounds.current);navigation.jump(view.center,view.zoom)},[resetView])
  useEffect(()=>{if(fitSelection){manualNavigation();const view=fitView(drawing,selection,viewportSize.current);navigation.jump(view.center,view.zoom)}},[fitSelection])
  const biasWasVisible=useRef(false)
  useEffect(()=>{
    const visible=biasPlacements.length>0
    if(visible&&!biasWasVisible.current&&fitOptions.current.fitMode==='auto'){const view=fitCanvasView(drawing,canvasDiagrams,viewportSize.current,1.5,biasPlacements.map(biasPlacementRect));navigation.jump(view.center,view.zoom)}
    biasWasVisible.current=visible
  },[biasPlacements])
  useEffect(()=>{if(tool!=='wire')setWireSession(null);cancelGesture();return()=>{cancelHoverFrame();cancelInteractionFrame()}},[tool,probeMode])
  useEffect(()=>{if(!active){cancelGesture();cancelHoverFrame();setEditingValue(null)}},[active])
  useEffect(()=>{if(editingValue&&!valueDevice)setEditingValue(null)},[editingValue,valueDevice])
  useEffect(()=>{
    cancelHoverFrame()
    if(wireSession&&wireSession.base!==drawing)setWireSession(null)
    if(dragRef.current&&dragRef.current.base!==drawing||wireDragRef.current&&wireDragRef.current.base!==drawing||probeDrag.current&&probeDrag.current.base!==drawing)cancelGesture()
  },[drawing])
  useEffect(()=>{
    const cancel=(e:KeyboardEvent)=>{
      if(!active)return
      const target=e.target as HTMLElement
      if(e.defaultPrevented||target?.closest?.('.assistant-sidebar,[role="dialog"],.model-editor-inline,.model-search,[data-canvas-diagram]'))return
      if(['INPUT','TEXTAREA','SELECT'].includes(target?.tagName)||target?.isContentEditable)return
      if(e.key==='Escape'){
        if(placingBiasWire){onCancelBiasWire?.();e.preventDefault();return}
        if(middleZoom.current){e.preventDefault();e.stopImmediatePropagation();cancelGesture();onStatus('已退出中键快速缩放模式。');return}
        cancelHoverFrame();setHover(null);setWireSession(null);cancelGesture()
      }
      if(tool==='wire'&&(e.key==='Backspace'||wireSession&&(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!e.shiftKey)){
        e.preventDefault()
        const last=wireSession?.steps.at(-1)
        if(last){setWireSession({...wireSession!,...last,steps:wireSession!.steps.slice(0,-1)});syncWireBend(last.bend)}else setWireSession(null)
        onStatus('已退回上一接线点；右键或 Esc 取消整条未完成的导线并退出接线。')
      }
    }
    window.addEventListener('keydown',cancel,true);return()=>window.removeEventListener('keydown',cancel,true)
  },[active,tool,onStatus,wireSession,placingBiasWire,onCancelBiasWire])
  useEffect(()=>{
    const canvas=svg.current
    const wheel=(e:WheelEvent)=>{
      if(!active||!e.deltaY||e.defaultPrevented)return
      e.preventDefault()
      manualNavigation()
      const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?viewportSize.current.height:1)
      navigation.wheel(e.clientX,e.clientY,delta)
    }
    canvas?.addEventListener('wheel',wheel,{passive:false});return()=>canvas?.removeEventListener('wheel',wheel)
  },[active])
  function rawPosition(clientX:number,clientY:number):XY {
    const matrix=svg.current?.getScreenCTM();if(!matrix)throw new Error('画布尚未就绪')
    const p=new DOMPoint(clientX,clientY).matrixTransform(matrix.inverse())
    return{x:p.x,y:p.y}
  }
  function position(clientX:number,clientY:number):XY {return wireGridPoint(rawPosition(clientX,clientY))}
  function pointedProbeTarget(point:XY,element:Element,wireOnly=false):ProbeTarget|null {
    const terminalHit=element.closest('[data-context-pin], [data-context-junction], [data-context-label]')
    const pinDevice=terminalHit?.getAttribute('data-context-pin'),junctionId=terminalHit?.getAttribute('data-context-junction'),labelId=terminalHit?.getAttribute('data-context-label')
    const at:Terminal|null=pinDevice?terminal(pinDevice,Number(terminalHit!.getAttribute('data-pin-index')) as Pin):junctionId?{junction:junctionId}:visible.labels?.find(label=>label.id===labelId)?.at??null
    // Match the painted target instead of a geometrically overlapping, unrelated net.
    if(at&&!wireOnly)return{at,point:terminalPosition(visible,at),distance:0}
    const wireId=element.closest('[data-probe-wire]')?.getAttribute('data-probe-wire')
    return wireId?projectOnWire(visible,wireId,point):(wireOnly?nearestWireProbeTarget:nearestProbeTarget)(visible,point,14/screenScale)
  }
  function pointerElement(e:PointerEvent<SVGSVGElement>):Element {
    // Pointer capture retargets events at the SVG; probe hover/release still need the actual hit.
    const hit=svg.current?.ownerDocument.elementFromPoint?.(e.clientX,e.clientY)
    return hit&&svg.current?.contains(hit)?hit:e.target as Element
  }
  function safe(action:()=>void){try{action()}catch(error){onStatus((error as Error).message)}}
  function selectOne(id:string,additive=false){onSelect(additive?selection.includes(id)?selection.filter(p=>p!==id):[...selection,id]:[id])}
  function showContextMenu(target:Element,clientX:number,clientY:number,keyboard=false){
    if(tool!=='select'){
      cancelHoverFrame();setHover(null);setProbeHover(null);setWireSession(null);cancelGesture();onTool('select')
      onStatus(tool==='wire'?'已取消未完成的连线并退出接线模式；已完成的导线保持不变。':'已取消当前工具，返回选择模式；再次右键打开菜单。')
      return
    }
    if(target.closest('[data-canvas-diagram]'))return
    safe(()=>{
      cancelGesture();setWireSession(null);onTool('select')
      const hit=target.closest('[data-context-device], [data-device-hit-area], [data-context-wire], [data-context-pin], [data-context-junction], [data-context-label], [data-context-probe]')
      const focus=(target.closest('[tabindex]')??svg.current) as (Element&{focus?:(options?:FocusOptions)=>void})|null
      focus?.focus?.({preventScroll:true})
      let raw=rawPosition(clientX,clientY)
      const request:CanvasContextRequest={clientX,clientY,at:position(clientX,clientY)}
      const deviceId=hit?.getAttribute('data-context-device')??hit?.getAttribute('data-device-hit-area')
      const wireId=hit?.getAttribute('data-context-wire')
      const pinDevice=hit?.getAttribute('data-context-pin')
      const junctionId=hit?.getAttribute('data-context-junction')
      const labelId=hit?.getAttribute('data-context-label')
      const probeLabel=hit?.getAttribute('data-context-probe')
      if(deviceId){request.deviceId=deviceId;const part=drawing.devices.find(d=>d.id===deviceId);if(keyboard&&part)raw=part}
      if(wireId){
        request.wireId=wireId
        const wire=drawing.wires.find(w=>w.id===wireId)
        if(wire){
          if(keyboard)raw=probePoint(drawing,wire.from,{wireId,fraction:.5})
          const projected=projectOnWire(drawing,wireId,raw)
          request.terminal=wire.from;request.anchor=projected?.anchor
        }
      }
      if(pinDevice){request.deviceId=pinDevice;request.terminal=terminal(pinDevice,Number(hit!.getAttribute('data-pin-index')) as Pin);if(keyboard)raw=terminalPosition(drawing,request.terminal)}
      if(junctionId){request.junctionId=junctionId;request.terminal={junction:junctionId};if(keyboard)raw=terminalPosition(drawing,request.terminal)}
      if(labelId){const label=drawing.labels?.find(l=>l.id===labelId);request.labelId=labelId;request.terminal=label?.at;if(keyboard&&label)raw=terminalPosition(drawing,label.at)}
      if(probeLabel){const marker=probeMarkers.find(m=>m.label===probeLabel);request.probeLabel=probeLabel;request.terminal=marker?.at;request.anchor=marker?.anchor;onSelectProbe?.(probeLabel);if(keyboard&&marker)raw=probePoint(drawing,marker.at,marker.anchor)}
      request.at=wireGridPoint(raw)
      const id=deviceId??pinDevice??wireId??junctionId??labelId
      if(id&&!selection.includes(id))onSelect([id])
      else if(!id&&!probeLabel)onSelect([])
      if(onContextMenu)onContextMenu(request)
      else if(deviceId)onStatus('在右侧属性栏编辑器件数值或模型。')
    })
  }
  function place(kind:DeviceKind,point:XY,angle?:Rotation,value=placementValue,params:Record<string,string>|null=placementParams??null,groundStyle=placementGroundStyle){
    const added=addDevice(drawing,kind,point,angle)
    const subcircuit=kind==='X'?importedModels.find(model=>model.kind==='X'&&model.id.toLowerCase()===value?.toLowerCase()):undefined
    if(kind==='X'&&!subcircuit)throw new Error('请先从模型库选择可导入的子电路，再放置到画布')
    if(value!==undefined||params||subcircuit||kind==='GND'&&groundStyle)added.drawing={...added.drawing,devices:added.drawing.devices.map(d=>d.id===added.id?{...d,...(value!==undefined?{value}:{}),...(params?{params:{...params}}:{}),...(kind==='GND'&&groundStyle?{groundStyle}:{}),...(subcircuit?{pins:[...subcircuit.pins],...(subcircuit.symbol?.shape==='ltspice'?{pinPositions:subcircuit.symbol.pins.map(pin=>({x:pin.x!,y:pin.y!}))}:{})}:{})}:d)}
    onChange(added.drawing);onSelect([added.id]);onTool('select')
    onStatus(`已放置 ${added.id}。Shift 点击多选；拖空白处框选；点击引脚开始接线。`)
  }
  function placeNetworkAt(preset:NetworkSymbolPreset,point:XY,element?:Element,angle:Rotation=preset.rotation){
    if(!onPlaceNetworkSymbol)return
    const hit=element?.closest('[data-context-pin],[data-context-junction],[data-context-wire],[data-context-label]')
    const pin=hit?.getAttribute('data-context-pin'),junction=hit?.getAttribute('data-context-junction'),wire=hit?.getAttribute('data-context-wire'),label=hit?.getAttribute('data-context-label')
    const direct:Terminal|undefined=pin?terminal(pin,Number(hit!.getAttribute('data-pin-index'))):junction?{junction}:drawing.labels?.find(item=>item.id===label)?.at
    if(direct){onPlaceNetworkSymbol(preset,direct,drawing,angle);return}
    const target=nearestWireTarget(createWireSnapIndex(drawing),point,screenScale,wire??undefined)
    if(wire||target?.wireId){const joined=joinAtWire(drawing,wire??target!.wireId!,target?.point??point);onPlaceNetworkSymbol(preset,joined.terminal,joined.drawing,angle);return}
    if(target?.terminal){onPlaceNetworkSymbol(preset,target.terminal,drawing,angle);return}
    if(drawing.junctions.length>=100)throw new Error('连接点数量已达上限')
    const at={junction:nextId('J',drawing.junctions)},next={...drawing,junctions:[...drawing.junctions,{id:at.junction,...wireGridPoint(point)}]}
    onPlaceNetworkSymbol(preset,at,next,angle)
  }
  function inspectSelectedTarget(target:Element){
    const hit=target.closest('[data-context-label],[data-context-junction]')
    const label=visible.labels?.find(label=>label.id===hit?.getAttribute('data-context-label'))
    const junction=hit?.getAttribute('data-context-junction')
    if(label||junction)onInspectNet?.(label?.at??{junction:junction!})
  }
  function captureDown(e:PointerEvent<SVGSVGElement>){
    if(!active)return
    navigation.commit()
    if(middleZoom.current&&e.button!==1){
      e.preventDefault();e.stopPropagation()
      if(e.button===2){cancelGesture();suppressContextMenu.current=true;onStatus('已退出中键快速缩放模式。')}
      return
    }
    suppressContextMenu.current=false
    if(e.button===0&&tool==='select')inspectSelectedTarget(e.target as Element)
    if(!onSheetSelect&&e.button===0&&!(e.target as Element).closest('[data-canvas-diagram]'))onDiagramSelect?.(null)
    if(e.button===2||e.button===1||tool==='pan'&&e.button===0){
      e.preventDefault();e.stopPropagation();svg.current?.focus()
      const m=svg.current?.getScreenCTM()?.inverse();if(!m)return
      const resumeZoom=!!middleZoom.current
      cancelGesture();suppressContextMenu.current=false;cancelHoverFrame()
      const client={x:e.clientX,y:e.clientY},target=e.target as Element
      if(e.button===1){
        const point=new DOMPoint(e.clientX,e.clientY).matrixTransform(m)
        pan.current={client,center:navigation.current.current.center,sx:m.a,sy:m.d,button:1,pointerId:e.pointerId,started:false,target,anchor:{x:point.x,y:point.y},resumeZoom}
        setMiddlePanning(true)
        e.currentTarget.setPointerCapture(e.pointerId)
      }else{
        pan.current={client,center:navigation.current.current.center,sx:m.a,sy:m.d,button:e.button===2?2:0,pointerId:e.pointerId,started:e.button===0,target}
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      return
    }
    if((e.target as Element).closest('.measurement-marker,[data-canvas-diagram]'))return
    if(e.button===0&&tool==='label'&&networkSymbol&&onPlaceNetworkSymbol){e.preventDefault();e.stopPropagation();safe(()=>placeNetworkAt(networkSymbol,rawPosition(e.clientX,e.clientY),e.target as Element,rotation));return}
    if(e.button===0&&tool==='wire'){
      e.preventDefault();e.stopPropagation();svg.current?.focus();cancelHoverFrame()
      safe(()=>{
        // Resolve from this click, never the last rendered/queued pointer preview.
        const raw=rawPosition(e.clientX,e.clientY),hit=(e.target as Element).closest('[data-context-pin], [data-context-junction], [data-context-wire], [data-context-label]')
        const pinDevice=hit?.getAttribute('data-context-pin'),junctionId=hit?.getAttribute('data-context-junction'),wireId=hit?.getAttribute('data-context-wire'),labelId=hit?.getAttribute('data-context-label')
        const direct=pinDevice?terminal(pinDevice,Number(hit!.getAttribute('data-pin-index')) as Pin):junctionId?{junction:junctionId}:working.labels?.find(label=>label.id===labelId)?.at??null
        const target:WireSnapTarget|null=direct?{terminal:direct,point:terminalPosition(working,direct)}:nearestWireTarget(wireIndex,raw,screenScale,wireId??undefined)
        setHover(target?.point??canvasPoint(raw))
        if(target?.terminal){if('junction'in target.terminal)chooseJunction(target.terminal.junction);else chooseEndpoint(target.terminal)}
        else if(target?.wireId){const split=joinAtWire(working,target.wireId,target.point);chooseEndpoint(split.terminal,split.drawing)}
        else blankDown(e)
      })
      return
    }
    if(e.button===0&&tool==='probe'&&!(e.target as Element).closest('.measurement-marker')){
      const wireId=(e.target as Element).closest('[data-probe-wire]')?.getAttribute('data-probe-wire')
      // A component click keeps its existing device-current meaning. A conductor
      // hit selects exactly that branch, even where two unrelated nets cross.
      if(probeMode==='current'&&!wireId&&(e.target as Element).closest('[data-context-device], [data-device-hit-area], [data-context-pin], [data-context-junction], [data-context-label]'))return
      const point=rawPosition(e.clientX,e.clientY),target=pointedProbeTarget(point,e.target as Element,probeMode==='current')
      if(target){
        e.preventDefault();e.stopPropagation();svg.current?.focus();setProbeHover(target)
        if(probeMode==='differential'&&onProbePair){const state:ProbeDrag={kind:'difference',start:target,client:{x:e.clientX,y:e.clientY},pointerId:e.pointerId,base:drawing};probeDrag.current=state;setProbeDragView(state);e.currentTarget.setPointerCapture(e.pointerId)}
        else chooseEndpoint(target.at,working,target.anchor)
        return
      }
    }
    if(e.button===0&&(tool==='paste'||isDeviceTool(tool))){
      e.preventDefault();e.stopPropagation();svg.current?.focus()
      safe(()=>{const p=position(e.clientX,e.clientY);if(tool==='paste')onPaste(p);else if(isDeviceTool(tool))place(tool,p,rotation)})
    }
  }
  function connectDraft(base:Drawing,from:Terminal,to:Terminal) {
    const next=connect(base,from,to,routingBend)
    if(!wireSession?.manualBend||next===base)return next
    const a=terminalPosition(base,from),b=terminalPosition(base,to),wire=next.wires.at(-1)!
    // An explicit direction override is a manual route, retained on reload.
    const corner=routingBend==='hv'?{x:b.x,y:a.y}:{x:a.x,y:b.y}
    return {...next,wires:next.wires.map(item=>item===wire?{...wire,bend:routingBend,waypoints:[corner]}:item)}
  }
  function chooseEndpoint(t:Terminal,base=working,anchor?:WireAnchor){
    svg.current?.focus()
    safe(()=>{
      if(tool==='net'){const inspected=inspectNet(base,t,base===working?topology.nodes:undefined);onInspectNet?.(t);onStatus(`网络 ${inspected.name}：${inspected.terminalKeys.length} 个连接端、${inspected.wireIds.length} 段导线、${inspected.labelIds.length} 个标签。`);return}
      if(tool==='select')onInspectNet?.(t)
      if(tool==='label'){onLabel?.(t);onTool('select');return}
      if(tool==='probe'){
        if(probeMode==='current'){if(onProbe)onProbe(t,anchor);else if(anchor)onProbeWire?.(anchor);else onStatus('请点击要测量的那一段导线，或点击 R/C/L/V/I/D 器件本体；分叉点请选定一条支路。');return}
        if(onProbe){onProbe(t,anchor);return}
        onChange({...base,output:t});onTool('select');onStatus('输出探针已更新，重新运行可查看该节点波形。');return
      }
      if(pending&&tool==='wire'){
        if(sameTerminal(pending,t))return
        const next=connectDraft(base,pending,t);onChange(next,false);setWireSession(null)
        onStatus('整条导线已连接，Ctrl+Z 可一次撤销。可继续接线，右键或 Esc 返回选择。')
      }else{
        const bend=initialWireBend(base,t,wireBend)
        setHover(terminalPosition(base,t));onSelect([]);setWireSession({base:drawing,draft:base,pending:t,bend,steps:[]});syncWireBend(bend);onTool('wire')
        onStatus('点击目标引脚完成；空白处加拐点；Space 换方向；Backspace 退一步；右键或 Esc 取消并退出接线。')
      }
    })
  }
  function blankDown(e:PointerEvent<SVGSVGElement>){
    if(e.button!==0)return
    e.currentTarget.focus()
    safe(()=>{
      const point=position(e.clientX,e.clientY)
      if(tool==='select'){
        const state={start:point,at:point,additive:e.shiftKey||e.ctrlKey||e.metaKey,intersect:e.altKey,original:selection,originalDiagrams:diagramSelection}
        marqueeRef.current=state;setMarquee(state);e.currentTarget.setPointerCapture(e.pointerId);return
      }
      if(tool==='wire'&&wireSession){
        const start=terminalPosition(working,wireSession.pending);if(start.x===point.x&&start.y===point.y)return
        if(working.junctions.length>=100)throw new Error('连接点数量已达上限')
        const id=nextId('J',working.junctions),endpoint:Terminal={junction:id},next={...working,junctions:[...working.junctions,{id,...point}]}
        const bend=continuedWireBend(start,point,routingBend)
        setWireSession({...wireSession,draft:connectDraft(next,wireSession.pending,endpoint),pending:endpoint,bend,manualBend:false,steps:[...wireSession.steps,{draft:working,pending:wireSession.pending,bend:routingBend,manualBend:wireSession.manualBend}]});syncWireBend(bend)
      }else if(tool==='wire')onStatus('请先点击一个器件引脚、连接点或导线。')
      else if(tool==='probe')onStatus('将探针放到导线、引脚或节点标签上；拖动标牌可调整显示位置。')
    })
  }
  function chooseJunction(id:string){
    const endpoint:Terminal={junction:id},attached=working.wires.find(w=>sameTerminal(w.from,endpoint)||sameTerminal(w.to,endpoint))
    if(tool==='wire'&&attached)safe(()=>{const joined=joinAtWire(working,attached.id,terminalPosition(working,endpoint));chooseEndpoint(joined.terminal,joined.drawing)})
    else chooseEndpoint(endpoint)
  }
  function startDrag(e:PointerEvent<SVGGElement>,id:string,label?:Terminal){
    e.stopPropagation();if(e.button!==0)return
    svg.current?.focus()
    if(tool==='select'&&label)onInspectNet?.(label)
    if(tool==='probe'){
      if(probeMode==='current'){
        if(drawing.devices.some(d=>d.id===id&&canProbeCurrent(d.kind)))onProbeDevice?.(id)
        else onStatus('请点击 R/C/L/V/I/D 器件；多脚器件电流尚不支持。')
      }else if(drawing.devices.find(d=>d.id===id)?.kind==='GND')chooseEndpoint(terminal(id))
      else onStatus(probeMode==='differential'?'依次点击正端、负端的导线或引脚。':'点击导线、引脚或地查看节点电压。')
      return
    }
    if(e.shiftKey||e.ctrlKey||e.metaKey){selectOne(id,true);return}
    const ids=selection.includes(id)?selection:[id];onSelect(ids)
    if(tool!=='select')return
    e.preventDefault()
    safe(()=>{
      const state={base:drawing,preview:drawing,ids,start:position(e.clientX,e.clientY),delta:{x:0,y:0},client:{x:e.clientX,y:e.clientY},label};dragRef.current=state;setDrag(state)
      // Keep native click/dblclick targeted at the device. Capturing on the SVG
      // retargets the release and double click to the canvas, losing activation.
      deviceCapture.current={element:e.currentTarget,pointerId:e.pointerId};e.currentTarget.setPointerCapture(e.pointerId)
    })
  }
  function editValue(part:Device){
    if(!active||tool!=='select')return
    cancelGesture();cancelHoverFrame();selectOne(part.id)
    if(hasQuickValue(part))setEditingValue(part.id)
    else onEditDevice?.(part.id)
  }
  function applyValue(value:string){
    if(!valueDevice||value===valueDevice.value)return
    onChange({...drawing,devices:drawing.devices.map(part=>part.id===valueDevice.id?{...part,value}:part)})
    onStatus(`${valueDevice.id} 已更新为 ${value}；Ctrl+Z 可撤销。`)
  }
  function startWireDrag(e:PointerEvent<SVGElement>,id:string,corner?:number){
    e.stopPropagation();if(e.button!==0||!active)return
    svg.current?.focus()
    if(tool==='select'){const wire=drawing.wires.find(w=>w.id===id);if(wire)onInspectNet?.(wire.from)}
    if(e.shiftKey||e.ctrlKey||e.metaKey){selectOne(id,true);return}
    const ids=selection.includes(id)?selection:[id];onSelect(ids)
    if(tool!=='select'){onTool('select');return}
    e.preventDefault()
    safe(()=>{
      const start=rawPosition(e.clientX,e.clientY),segment=nearestWireSegment(drawing,id,start)
      if(!segment)return
      const routeOrigin=corner===undefined?segment.from:wirePoints(drawing,drawing.wires.find(w=>w.id===id)!)[corner]
      const state:WireDrag={base:drawing,preview:drawing,id,kind:ids.length>1?'group':corner===undefined?'segment':'corner',index:corner??segment.index,ids,start,client:{x:e.clientX,y:e.clientY},delta:{x:0,y:0},routeOrigin,horizontal:segment.from.y===segment.to.y,previewDelta:{x:0,y:0},started:false,pointerId:e.pointerId}
      wireDragRef.current=state;setWireDrag(state);svg.current?.setPointerCapture(e.pointerId)
    })
  }
  function movedWireDrag(state:WireDrag,clientX:number,clientY:number):WireDrag{
    const point=rawPosition(clientX,clientY)
    const next={...state,started:state.started||Math.hypot(clientX-state.client.x,clientY-state.client.y)>=4,delta:{x:point.x-state.start.x,y:point.y-state.start.y}}
    const previewDelta=state.kind==='group'?{x:snap(next.delta.x),y:snap(next.delta.y)}:{
      x:state.kind==='segment'&&state.horizontal?0:clampCoordinate(snap(state.routeOrigin.x+next.delta.x))-state.routeOrigin.x,
      y:state.kind==='segment'&&!state.horizontal?0:clampCoordinate(snap(state.routeOrigin.y+next.delta.y))-state.routeOrigin.y,
    }
    if(next.started===state.started&&previewDelta.x===state.previewDelta.x&&previewDelta.y===state.previewDelta.y)return state
    return{...next,previewDelta,preview:wireDragDrawing(next)}
  }
  function zoomFromMiddleMove(state:MiddleZoomState,clientY:number){
    manualNavigation()
    // Keep the point under the activating click fixed. Mouse movement continues
    // to control zoom after the middle button has been released.
    const next=clampCanvasZoom(state.zoom*Math.exp((state.client.y-clientY)*.012))
    const ratio=state.zoom/next
    navigation.navigate({x:state.anchor.x+(state.center.x-state.anchor.x)*ratio,y:state.anchor.y+(state.center.y-state.anchor.y)*ratio},next)
  }
  function move(e:PointerEvent<SVGSVGElement>){
    safe(()=>{
      if(wireDragRef.current){
        const state=wireDragRef.current
        if(e.pointerId!==state.pointerId)return
        if(!active||state.base!==drawing){cancelGesture();return}
        const {clientX,clientY}=e
        queueInteractionPreview(()=>{if(wireDragRef.current!==state)return;const next=movedWireDrag(state,clientX,clientY);if(next===state)return;wireDragRef.current=next;setWireDrag(next)});return
      }
      if(pan.current){
        const p=pan.current
        if(e.pointerId!==p.pointerId)return
        if(!p.started&&Math.hypot(e.clientX-p.client.x,e.clientY-p.client.y)>=4)p.started=true
        if(p.started){manualNavigation();navigation.navigate({x:p.center.x-(e.clientX-p.client.x)*p.sx,y:p.center.y-(e.clientY-p.client.y)*p.sy},undefined,false)}
        return
      }
      const raw=rawPosition(e.clientX,e.clientY),at=wireGridPoint(raw)
      const probeState=probeDrag.current
      if(probeState){
        if(e.pointerId!==probeState.pointerId)return
        if(!active||probeState.base!==drawing){cancelGesture();return}
        if(probeState.kind==='label'){
          queueInteractionPreview(()=>{if(probeDrag.current!==probeState)return;const previewOffset={x:probeState.offset.x+(raw.x-probeState.start.x)/probeState.scale,y:probeState.offset.y+(raw.y-probeState.start.y)/probeState.scale};if(previewOffset.x===probeState.previewOffset.x&&previewOffset.y===probeState.previewOffset.y)return;const next={...probeState,previewOffset};probeDrag.current=next;setProbeDragView(next)});return
        }
        if(probeState.kind==='tip'){
          const point={x:probeState.origin.x+raw.x-probeState.start.x,y:probeState.origin.y+raw.y-probeState.start.y}
          const element=pointerElement(e)
          queueInteractionPreview(()=>{if(probeDrag.current!==probeState)return;const target=pointedProbeTarget(point,element,probeState.wireOnly),next={...probeState,point,target};probeDrag.current=next;setProbeDragView(next);setProbeHover(target)});return
        }
      }
      if(tool==='wire')updateWireHover(raw)
      else if(tool==='paste'||isDeviceTool(tool)||tool==='probe'||tool==='label'&&networkSymbol||probeDrag.current){
        const element=tool==='probe'||probeDrag.current?pointerElement(e):null
        queueHoverPreview(()=>{setHoverPoint(at);if(element)setProbeHover(pointedProbeTarget(raw,element,tool==='probe'&&probeMode==='current'))})
      }
      if(probeDrag.current)return
      if(dragRef.current){const base=dragRef.current,delta={x:at.x-base.start.x,y:at.y-base.start.y};queueInteractionPreview(()=>{if(dragRef.current!==base||delta.x===base.delta.x&&delta.y===base.delta.y)return;const state={...base,delta,preview:moveSelection(drawing,base.ids,delta)};dragRef.current=state;setDrag(state)})}
      if(marqueeRef.current){const base=marqueeRef.current;queueInteractionPreview(()=>{if(marqueeRef.current!==base||base.at.x===at.x&&base.at.y===at.y)return;const state={...base,at};marqueeRef.current=state;setMarquee(state)})}
    })
  }
  function finish(e:PointerEvent<SVGSVGElement>){
    if(pan.current){
      const p=pan.current
      if(e.pointerId!==p.pointerId||e.button!==p.button)return
      const moved=p.started||Math.hypot(e.clientX-p.client.x,e.clientY-p.client.y)>=4
      const nextCenter={x:p.center.x-(e.clientX-p.client.x)*p.sx,y:p.center.y-(e.clientY-p.client.y)*p.sy}
      if(moved){manualNavigation();navigation.navigate(nextCenter,undefined,false)}
      navigation.commit()
      pan.current=null
      if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)
      if(p.button===2){suppressContextMenu.current=true;if(!moved)showContextMenu(p.target,e.clientX,e.clientY)}
      if(p.button===1){
        setMiddlePanning(false)
        if(moved){
          if(p.resumeZoom){middleZoom.current={client:{x:e.clientX,y:e.clientY},center:nextCenter,zoom:navigation.current.current.zoom,anchor:p.anchor!};setMiddleZooming(true)}
          onStatus('已用中键平移画布。轻点中键可切换快速缩放模式。')
        }else if(!p.resumeZoom){
          middleZoom.current={client:{x:e.clientX,y:e.clientY},center:p.center,zoom:navigation.current.current.zoom,anchor:p.anchor!}
          setMiddleZooming(true)
          onStatus('快速缩放已开启：上下移动鼠标缩放；轻点中键、按右键或 Esc 退出。')
        }else onStatus('已退出中键快速缩放模式。')
      }
      return
    }
    if(wireDragRef.current){
      const state=wireDragRef.current
      if(e.pointerId!==state.pointerId)return
      try{safe(()=>{
        if(!active||state.base!==drawing||e.button!==0)return
        const next=movedWireDrag(state,e.clientX,e.clientY).preview
        if(next!==drawing){onChange(next,true);onStatus(state.kind==='group'?'已移动选区，连接保持不变；Ctrl+Z 可撤销。':'已调整导线路径，端点保持连接；Ctrl+Z 可撤销。')}
      })}finally{cancelGesture()}
      return
    }
    const probeState=probeDrag.current
    if(probeState){
      if(e.pointerId!==probeState.pointerId)return
      if(!active||probeState.base!==drawing||e.button!==0){cancelGesture();return}
      const finalPoint=rawPosition(e.clientX,e.clientY)
      // The final pointer position can arrive without a preceding pointermove.
      // Commit that position in the badge's sheet coordinates before release.
      if(probeState.kind==='label'){
        const offset={x:probeState.offset.x+(finalPoint.x-probeState.start.x)/probeState.scale,y:probeState.offset.y+(finalPoint.y-probeState.start.y)/probeState.scale}
        if(offset.x!==probeState.offset.x||offset.y!==probeState.offset.y)onMoveProbeLabel?.(probeState.label,offset)
      }
      const point=probeState.kind==='tip'?{x:probeState.origin.x+finalPoint.x-probeState.start.x,y:probeState.origin.y+finalPoint.y-probeState.start.y}:finalPoint
      const target=probeState.kind==='label'?null:pointedProbeTarget(point,pointerElement(e),probeState.kind==='tip'&&!!probeState.wireOnly)
      if(probeState.kind==='tip'){if(target)onRelocateProbe?.(probeState.label,target,probeState.offset);else onStatus('此处没有可测量的导线或引脚，探针保留原位置。')}
      if(probeState.kind==='difference'){
        if(Math.hypot(e.clientX-probeState.client.x,e.clientY-probeState.client.y)<5)chooseEndpoint(probeState.start.at,working,probeState.start.anchor)
        else if(target)onProbePair?.(probeState.start,target)
        else onStatus('差分负端需要落在导线或引脚上，本次拖动已取消。')
      }
      cancelGesture();if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);return
    }
    const state=dragRef.current,box=marqueeRef.current
    if(state&&state.base===drawing)safe(()=>{const end=position(e.clientX,e.clientY),next=moveSelection(drawing,state.ids,{x:end.x-state.start.x,y:end.y-state.start.y});if(next!==drawing){onChange(next,true);onStatus(`已移动选区，连接保持不变；Ctrl+Z 可撤销。`)}else if(state.label&&Math.hypot(e.clientX-state.client.x,e.clientY-state.client.y)<5)onLabel?.(state.label)})
    if(box){
      const end=position(e.clientX,e.clientY),isClick=box.start.x===end.x&&box.start.y===end.y,area=rectangle(box.start,end)
      const ids=isClick?[]:selectRectangle(drawing,area,box.intersect),frames=isClick?[]:selectCanvasDiagrams(canvasDiagrams,area,box.intersect)
      const next=[...new Set([...(box.additive?box.original:[]),...ids])],nextFrames=[...new Set([...(box.additive?box.originalDiagrams:[]),...frames])]
      if(onSheetSelect)onSheetSelect(next,nextFrames,nextFrames.at(-1)??null)
      else{onSelect(next);onDiagramSelect?.(nextFrames.at(-1)??null)}
      onStatus(next.length||nextFrames.length?`已选择 ${next.length} 个电路对象、${nextFrames.length} 个波形图。Ctrl+C / V 复制粘贴；拖动波形标题移动选中图框。`:'拖动空白处框选；Shift 点击增减选区；Alt 框选包括相交对象。')
    }
    cancelGesture();if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)
  }
  function drop(e:DragEvent<SVGSVGElement>){e.preventDefault();const preset=networkSymbolPresets.find(item=>item.id===e.dataTransfer.getData('application/x-fuxian-net-symbol'));if(preset){safe(()=>placeNetworkAt(preset,rawPosition(e.clientX,e.clientY),e.target as Element));return}const kind=e.dataTransfer.getData('application/x-fuxian-device') as DeviceKind;if(isDeviceTool(kind))safe(()=>{const id=e.dataTransfer.getData('application/x-fuxian-library-part'),part=libraryPartById(id);if(id&&(!part||part.kind!==kind))throw new Error('器件预设无效，请从器件库重新拖入');const value=e.dataTransfer.types.includes('application/x-fuxian-value')?e.dataTransfer.getData('application/x-fuxian-value'):undefined;place(kind,position(e.clientX,e.clientY),undefined,part?.value??value??deviceCatalog[kind].value,part?.params??null,part?.kind==='GND'?part.groundStyle??'earth':undefined)})}
  const probe=visible.output?terminalPosition(visible,visible.output):null
  const source=visible.devices.find(p=>p.id===visible.sourceId),input=source?pinPosition(source,0):null
  const ghost=hover&&isDeviceTool(tool)?{id:'preview',kind:tool,value:placementValue??deviceCatalog[tool].value,params:placementParams,groundStyle:placementGroundStyle,...hover,rotation} as Device:null
  const pasted=clipboard&&tool==='paste'?positionClipboard(clipboard,hover??center):null
  const groupBounds=useMemo(()=>selected.size>1?selectionBounds(visible,[...selected]):null,[visible,selected])
  const route=(from:XY,to:XY)=>{
    // A snapped destination contributes its lead axis before the user clicks.
    // Use the same automatic route as the committed conductor.
    if(pending&&!wireSession?.manualBend&&wireTarget?.terminal&&!sameTerminal(pending,wireTarget.terminal)){
      const wire:Wire={id:'__pending_wire',from:pending,to:wireTarget.terminal,bend:routingBend}
      const points=wirePoints({...visible,wires:[...visible.wires,wire]},wire)
      return points.map((point,index)=>!index?`M ${point.x} ${point.y}`:points[index-1].y===point.y?`H ${point.x}`:`V ${point.y}`).join(' ')
    }
    return routingBend==='hv'?`M ${from.x} ${from.y} H ${to.x} V ${to.y}`:`M ${from.x} ${from.y} V ${to.y} H ${to.x}`
  }
  const pendingPoint=showProbeMarkers&&pendingProbe&&tool==='probe'&&probeMode==='differential'&&topology.nodes.has(terminalKey(pendingProbe.at))?probePoint(visible,pendingProbe.at,pendingProbe.anchor):null
  const previewType=probeDragView?.kind==='tip'?probeMarkers.find(marker=>marker.label===probeDragView.label)?.type??probeMode:probeMode
  const gridStep=baseGrid*Math.pow(2,Math.max(0,Math.ceil(Math.log2(6/(baseGrid*screenScale)))))
  function activateDiagram(id:string,additive=false){
    cancelGesture();cancelHoverFrame();setHover(null);setWireSession(null)
    const ids=additive?diagramSelection.includes(id)?diagramSelection.filter(value=>value!==id):[...diagramSelection,id]:diagramSelection.includes(id)?diagramSelection:[id]
    if(onSheetSelect)onSheetSelect(additive||diagramSelection.includes(id)?selection:[],ids,ids.includes(id)?id:ids.at(-1)??null)
    else{onSelect([]);onDiagramSelect?.(ids.at(-1)??null)}
  }
  function changedDiagram(id:string,geometry:CanvasDiagramGeometry,kind?:'move'|'resize'){
    const original=canvasDiagrams.find(diagram=>diagram.id===id)
    if(kind==='move'&&original&&diagramSelection.includes(id)&&diagramSelection.length>1&&onDiagramGroupChange)onDiagramGroupChange(moveCanvasDiagrams(canvasDiagrams,diagramSelection,{x:geometry.x-original.x,y:geometry.y-original.y}))
    else onDiagramChange?.(id,geometry)
  }
  itemActions.current={
    hoverDevice,deviceDown:startDrag,cornerDown:startWireDrag,
    deviceDoubleClick:(e,id)=>{if(tool==='select'){e.preventDefault();e.stopPropagation();selectOne(id);onEditDevice?.(id)}},
    deviceKeyDown:(e,part)=>{if(e.key==='Enter'){e.stopPropagation();if(tool==='probe'&&probeMode==='current'){if(canProbeCurrent(part.kind))onProbeDevice?.(part.id);else onStatus('电流探针请点击 R/C/L/V/I/D 器件。');return}e.preventDefault();selectOne(part.id,e.shiftKey);if(tool==='select'&&!e.shiftKey)onEditDevice?.(part.id);onTool('select')}},
    valueDown:(e,part)=>{if(tool==='select'&&e.button===0){e.stopPropagation();svg.current?.focus();selectOne(part.id,e.shiftKey||e.ctrlKey||e.metaKey)}},
    valueDoubleClick:(e,part)=>{if(tool==='select'){e.preventDefault();e.stopPropagation();editValue(part)}},
    valueKeyDown:(e,part)=>{if(tool==='select'&&e.key==='Enter'){e.preventDefault();e.stopPropagation();editValue(part)}},
    wireKeyDown:(e,w)=>{if(e.key==='Enter'){e.stopPropagation();if(placingBiasWire){onBiasWire?.({wireId:w.id,fraction:.5});return}if(tool==='net'||tool==='probe')chooseEndpoint(w.from,working,{wireId:w.id,fraction:.5});else {if(tool==='select')onInspectNet?.(w.from);selectOne(w.id,e.shiftKey)}}},
    wireDown:(e,w)=>{e.stopPropagation();if(e.button!==0)return;svg.current?.focus();safe(()=>{
      if(placingBiasWire){onBiasWire?.({wireId:w.id,fraction:.5});return}
      if(tool==='probe'){const target=projectOnWire(visible,w.id,rawPosition(e.clientX,e.clientY));chooseEndpoint(w.from,working,target?.anchor)}
      else if(tool==='label'||tool==='net')chooseEndpoint(w.from)
      else if(tool==='wire'){const split=joinAtWire(working,w.id,position(e.clientX,e.clientY));chooseEndpoint(split.terminal,split.drawing)}
      else startWireDrag(e,w.id)
    })},
    pinDown:(e,part,pin)=>{e.stopPropagation();if(e.button===0)chooseEndpoint(terminal(part.id,pin))},
    pinKeyDown:(e,part,pin)=>{if(e.key==='Enter'){e.stopPropagation();chooseEndpoint(terminal(part.id,pin))}},
  }
  return <><svg ref={svg} className={`editor-canvas tool-${tool} ${middleZooming?'is-middle-zooming':''} ${middlePanning?'is-middle-panning':''} ${tool==='probe'?`tool-probe-${probeMode}`:''}`} role="group" tabIndex={0} aria-label="可编辑原理图画布" viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`}
    onPointerDownCapture={captureDown} onPointerDown={blankDown}
    onPointerMoveCapture={e=>{if(pan.current?.button===1){e.preventDefault();e.stopPropagation();move(e);return}if(!middleZoom.current)return;e.preventDefault();e.stopPropagation();zoomFromMiddleMove(middleZoom.current,e.clientY)}} onPointerMove={move}
    onPointerUpCapture={e=>{if(pan.current?.button===1){e.preventDefault();e.stopPropagation();finish(e);return}if(middleZoom.current){e.preventDefault();e.stopPropagation()}}} onPointerUp={finish} onPointerCancel={cancelGesture} onLostPointerCapture={()=>{if(pan.current||wireDragRef.current||dragRef.current||marqueeRef.current||probeDrag.current)cancelGesture()}}
    onAuxClick={e=>{if(e.button===1)e.preventDefault()}}
    onContextMenuCapture={e=>{e.preventDefault();e.stopPropagation();if(middleZoom.current||pan.current?.button===2)return;if(suppressContextMenu.current){suppressContextMenu.current=false;return}if(active)showContextMenu(e.target as Element,e.clientX,e.clientY)}}
    onKeyDownCapture={e=>{if((e.target as Element).closest('[data-canvas-diagram]'))return;if(active&&tool==='select'&&e.key==='Enter')inspectSelectedTarget(e.target as Element);if(e.key==='ContextMenu'||e.key==='F10'&&e.shiftKey){e.preventDefault();e.stopPropagation();const target=e.target as Element,box=target.getBoundingClientRect();showContextMenu(target,box.left+box.width/2,box.top+box.height/2,true)}}}
    onPointerLeave={()=>{if(middleZoom.current)cancelGesture();cancelHoverFrame();setHover(null);if(!probeDrag.current)setProbeHover(null)}} onDragOver={e=>e.preventDefault()} onDrop={drop}>
    <defs><pattern id="editor-dot-grid" width={gridStep} height={gridStep} patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r={.7/screenScale} fill="var(--canvas-grid, #c9d8ce)"/></pattern></defs>
    <rect className="canvas-viewport-background" x={viewX} y={viewY} width={viewWidth} height={viewHeight} fill="#fcfdfb"/>
    <rect className="canvas-viewport-grid" x={viewX} y={viewY} width={viewWidth} height={viewHeight} fill="url(#editor-dot-grid)"/>
    {!drawing.devices.length&&<g className="canvas-empty" pointerEvents="none"><text x="600" y="260" textAnchor="middle">从左侧放入第一个器件</text><text x="600" y="295" textAnchor="middle" className="canvas-empty-note">选择器件后点击画布，或直接拖入</text><text x="600" y="337" textAnchor="middle" className="canvas-empty-note">Shift 多选 · 拖空白处框选 · Ctrl+C / V 复制粘贴</text></g>}
    {groupBounds&&!marquee&&<rect className="selection-bounds" x={groupBounds.left-12} y={groupBounds.top-12} width={groupBounds.right-groupBounds.left+24} height={groupBounds.bottom-groupBounds.top+24} pointerEvents="none"/>}
    {/* Conductors paint above symbol bodies; terminal targets remain topmost. */}
    {deviceViews.map(view=><CanvasDeviceHitArea key={view.part.id} view={view} actions={itemActions}/>)}
    {deviceViews.map(view=><CanvasDeviceArtwork key={view.part.id} view={view} shortMessage={shortMessages.get(view.part.id)} selected={selected.has(view.part.id)} hovered={hoveredDevice===view.part.id} inputSource={view.part.id===visible.sourceId} actions={itemActions}/>)}
    {visible.wires.map(w=><CanvasWire key={w.id} wire={w} shortMessage={shortWireMessages.get(w.id)} path={wirePaths.get(w.id)} selected={selected.has(w.id)} dragging={wireDrag?.id===w.id&&wireDrag.started||false} highlighted={highlightedWires.has(w.id)} staged={!!wireSession&&drawing.wires.find(original=>original.id===w.id)!==w} netName={highlightedWires.has(w.id)?net?.name:undefined} corners={selectedWireId===w.id?wireCorners:undefined} screenScale={screenScale} actions={itemActions}/>)}
    {visible.devices.flatMap(part=>pinsFor(part).map(pin=>{
      const t=terminal(part.id,pin),key=terminalKey(t)
      return <CanvasPin key={key} part={part} pin={pin} enlarged={tool==='wire'||tool==='label'||tool==='net'||tool==='probe'&&probeMode!=='current'} connected={linked.has(key)||labelConnected.has(key)} highlighted={highlightedTerminals.has(key)} pending={!!pending&&sameTerminal(pending,t)} netName={highlightedTerminals.has(key)?net?.name:undefined} screenScale={screenScale} actions={itemActions}/>
    }))}
    {visible.junctions.map(j=>{
      const appearance=junctionMarkers.get(j.id)!
      return <g key={j.id} data-context-junction={j.id} data-junction-kind={appearance.kind} className={`editor-junction ${selected.has(j.id)?'selected':''} ${pending&&sameTerminal(pending,{junction:j.id})?'pending':''} ${highlightedTerminals.has(j.id)?'net-highlight':''}`} data-net-name={highlightedTerminals.has(j.id)?net?.name:undefined} tabIndex={0} role="button" aria-label={`连接点 ${j.id}`} onPointerDown={e=>{if(tool==='wire'||tool==='probe'||tool==='label'||tool==='net'){e.stopPropagation();if(e.button===0)chooseJunction(j.id)}else startDrag(e,j.id)}} onKeyDown={e=>{if(e.key==='Enter'){e.stopPropagation();if(tool==='select')selectOne(j.id,e.shiftKey);else chooseJunction(j.id)}}}>
        <circle cx={j.x} cy={j.y} r={Math.max(6,14/screenScale)} className="pin-hit"/><circle cx={j.x} cy={j.y} r={appearance.kind==='branch'?2.5:3.25} className="junction-dot"/>
      </g>
    })}
    {[...netLabelPlacements.values()].map(placement=>{const {label,point}=placement;return <g key={label.id} data-context-label={label.id} className={`net-label ${label.style&&label.style!=='text'?'net-symbol':''} ${selected.has(label.id)?'selected':''} ${highlightedLabels.has(label.id)?'net-highlight':''}`} data-net-name={highlightedLabels.has(label.id)?net?.name:undefined} role="button" tabIndex={0} aria-label={`节点标签 ${label.name}`} transform={`translate(${point.x} ${point.y})`} onPointerDown={e=>{e.stopPropagation();if(e.button===0){if(tool==='net'||tool==='probe'||tool==='wire'){chooseEndpoint(label.at);return}if(tool==='select'&&(label.style??'text')!=='text'){startDrag(e,label.id,label.at);return}selectOne(label.id,e.shiftKey);if(!e.shiftKey)onLabel?.(label.at);onTool('select')}}} onKeyDown={e=>{if(e.key==='Enter'){e.stopPropagation();if(tool==='net'||tool==='probe'||tool==='wire'){chooseEndpoint(label.at);return}selectOne(label.id);onLabel?.(label.at)}}}>{label.style&&label.style!=='text'?<NetSymbolGraphic name={label.name} style={label.style} rotation={label.rotation}/>:<><path d={`M 0 0 V ${placement.y-11} H ${placement.x}`}/><rect x={placement.x} y={placement.y-22} width={placement.width} height="21" rx="4"/><text x={placement.x+7} y={placement.y-7}>{label.name}</text></>}</g>})}
    {showNodes&&annotations.filter(label=>!dcVoltages?.has(label.name)).map(label=><g key={label.name} className="canvas-node-annotation" data-node-name={label.name} pointerEvents="none" transform={`translate(${label.point.x} ${label.point.y})`}><rect x="5" y="-24" width={label.name.length*6.7+12} height="18" rx="4"/><text x="11" y="-11" className="editor-node-label">{label.name}</text></g>)}
    {biasPrefs&&<BiasCanvasLayer placements={biasPlacements} directionMode={biasPrefs.directionMode} selectedId={biasSelectedId} pinned={biasPrefs.pinned} onMove={(id,offset)=>onBiasMove?.(id,offset)} onSelect={id=>onBiasSelect?.(id)} onPin={id=>onBiasPin?.(id)} onUndo={onBiasUndo} onRedo={onBiasRedo}/>}
    {input&&!labeledNets.has(topology.inputNode)&&(!probe||topology.inputNode!==topology.outputNode)&&topology.inputNode!=='0'&&<g transform={`translate(${input.x} ${input.y})`} className="input-marker" pointerEvents="none"><text x="-12" y="-12" textAnchor="end">{topology.inputNode.toUpperCase()}</text></g>}
    {showProbeMarkers&&probeHover&&(tool==='probe'||probeDragView?.kind==='tip')&&<g className={`probe-target-preview ${previewType==='current'?'probe-target-current':''}`} pointerEvents="none">
      {probeHover.anchor&&visible.wires.find(w=>w.id===probeHover.anchor!.wireId)&&<path d={wirePath(visible,visible.wires.find(w=>w.id===probeHover.anchor!.wireId)!)} stroke="#db8b16" strokeWidth={5*probeScale} opacity=".45" fill="none"/>}
      <g transform={`translate(${probeHover.point.x} ${probeHover.point.y}) scale(${probeScale})`}><circle r="12" fill="#fff5d6" stroke="#b77609" strokeWidth="2"/>{previewType==='current'&&probeHover.anchor?<g transform={`rotate(${wireProbeAngle(visible,probeHover.anchor)})`}><path d="M -19 0 H 21 M 15 -5 L 21 0 L 15 5" fill="none" stroke="#9b610a" strokeWidth="2.5" strokeLinecap="round"/></g>:<path d="M 0 1 L 6 -15 L 15 -24 L 22 -17 L 13 -8 Z" fill="#f1a834" stroke="#764506" strokeWidth="1.5"/>}<text x="28" y="-14" fontSize="12" fontWeight="700" fill="#764506">{previewType==='differential'?pendingPoint||probeDragView?.kind==='difference'?'ΔV −':'ΔV +':previewType==='current'?'I':'V'} · {previewType==='current'?probeHover.anchor?.wireId:topology.nodes.get(terminalKey(probeHover.at))}</text></g>
    </g>}
    {showProbeMarkers&&probeDragView?.kind==='difference'&&probeHover&&<path d={`M ${probeDragView.start.point.x} ${probeDragView.start.point.y} L ${probeHover.point.x} ${probeHover.point.y}`} stroke="#c44045" strokeWidth={2*probeScale} strokeDasharray={`${6*probeScale} ${4*probeScale}`} fill="none" pointerEvents="none"/>}
    {pendingPoint&&<g className="probe-pending-endpoint" transform={`translate(${pendingPoint.x} ${pendingPoint.y}) scale(${probeScale})`} pointerEvents="none" aria-label="差分正端已选，等待负端"><circle r="14" fill="#fff2d6" stroke="#ad6515" strokeWidth="2" strokeDasharray="4 3"/><text y="5" textAnchor="middle" fontSize="19" fontWeight="800" fill="#8b4b10">+</text><rect x="18" y="-42" width="122" height="29" rx="5" fill="#fff2d6" stroke="#ad6515"/><text x="26" y="-23" fontSize="12" fontWeight="700" fill="#8b4b10">ΔV + · 请选择负端</text></g>}
    {probeMarkers.map(marker=>{
      if(marker.reference)return <StaticProbeMarker key="reference-output" drawing={visible} marker={marker}/>
      if(!topology.nodes.has(terminalKey(marker.at))||marker.type==='current'&&marker.anchor&&!visible.wires.some(w=>w.id===marker.anchor!.wireId))return null
      const dragging=probeDragView?.kind!=='difference'&&probeDragView?.label===marker.label?probeDragView:null
      const point=dragging?.kind==='tip'?dragging.point:probePoint(visible,marker.at,marker.anchor),offset=dragging?.kind==='label'?dragging.previewOffset:dragging?.kind==='tip'?dragging.offset:marker.offset??{x:28,y:-64}
      const type=marker.type??(/[+−]$/.test(marker.label)?'differential':'voltage'),negative=marker.negative??marker.label.endsWith('−')
      const wireCurrent=type==='current'&&!!marker.anchor,currentAngle=probeCurrentAngle(visible,dragging?.kind==='tip'&&dragging.target?.anchor?{...marker,at:dragging.target.at,anchor:dragging.target.anchor}:marker)
      const begin=(e:PointerEvent<SVGGElement>,kind:'label'|'tip')=>{e.stopPropagation();if(e.button!==0||!active)return;e.preventDefault();svg.current?.focus();if(kind==='tip'&&tool==='probe'&&type!==probeMode&&(onProbe||onProbePair)&&!e.altKey){
        const target:ProbeTarget={at:marker.at,point,anchor:marker.anchor,distance:0};setProbeHover(target)
        if(probeMode==='differential'&&onProbePair){const state:ProbeDrag={kind:'difference',start:target,client:{x:e.clientX,y:e.clientY},pointerId:e.pointerId,base:drawing};probeDrag.current=state;setProbeDragView(state);svg.current?.setPointerCapture(e.pointerId)}
        else chooseEndpoint(marker.at,working,marker.anchor)
        return
      }onSelectProbe?.(marker.label);if(kind==='tip'&&type==='current'&&!wireCurrent){onStatus('电流探针绑定器件支路，箭头沿引脚 1 → 2；拖动标牌调整位置，点击其他器件测量其电流。');return}const start=rawPosition(e.clientX,e.clientY),shared={label:marker.label,start,offset,pointerId:e.pointerId,base:drawing};const state:ProbeDrag=kind==='label'?{...shared,kind,previewOffset:offset,scale:probeScale}:{...shared,kind,wireOnly:wireCurrent,origin:point,point,target:null};probeDrag.current=state;setProbeDragView(state);svg.current?.setPointerCapture(e.pointerId)}
      return <g key={marker.label} data-context-probe={marker.label} className={`measurement-marker measurement-marker-${type} ${negative?'measurement-marker-negative':''} ${marker.selected?'active':''}`} data-probe-type={type} transform={`translate(${point.x} ${point.y}) scale(${probeScale})`} aria-label={`${probeTypes[type].name}探针 ${marker.label}`} style={{color:marker.color,pointerEvents:dragging?'none':undefined}}>
        <ProbeLeader offset={offset} label={marker.label} type={type}/>
        <g className={`probe-tip ${type==='current'?'probe-tip-current':''} ${wireCurrent?'probe-tip-wire':''}`} role="button" tabIndex={0} aria-label={`${type==='current'?'选择电流探针':'移动探针'} ${marker.label} 测量端点`} onPointerDown={e=>begin(e,'tip')} onDoubleClick={e=>{if(wireCurrent){e.stopPropagation();onReverseProbe?.(marker.label)}}} onKeyDown={e=>{if(e.key==='Enter'){e.stopPropagation();onSelectProbe?.(marker.label)}if(wireCurrent&&e.key.toLowerCase()==='f'){e.preventDefault();e.stopPropagation();onReverseProbe?.(marker.label)}}}><title>{wireCurrent?'拖动电流钳到另一段导线；箭头表示正方向。双击或按 F 反转方向。':type==='current'?'箭头表示电流正向：引脚 1 → 2。标牌可拖动；测量支路由器件决定。':`拖到其他导线或引脚，改变${type==='differential'?negative?'差分负端':'差分正端':'测量节点'}`}</title><circle className="probe-tip-hit" r={Math.max(20,9/probeScreenScale)} fill="transparent"/><ProbeTipGlyph type={type} negative={negative} currentAngle={currentAngle} sharedTip={marker.sharedTip}/></g>
        <g className="probe-badge" role="button" tabIndex={0} aria-label={`移动探针 ${marker.label} 标牌`} transform={`translate(${offset.x} ${offset.y})`} onPointerDown={e=>begin(e,'label')} onKeyDown={e=>{if(e.key==='Enter'){e.stopPropagation();onSelectProbe?.(marker.label)}else if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();e.stopPropagation();onMoveProbeLabel?.(marker.label,{x:offset.x+(e.key==='ArrowLeft'?-10:e.key==='ArrowRight'?10:0),y:offset.y+(e.key==='ArrowUp'?-10:e.key==='ArrowDown'?10:0)})}}}><title>拖动调整标牌位置，不改变电气连接</title><ProbeBadgeGlyph type={type} label={marker.label} selected={marker.selected} negative={negative}/><path className="probe-badge-hit" d={`M 0 18 H ${probeBadgeWidth(marker.label)}`} fill="none" stroke="transparent" strokeWidth={Math.max(36,18/probeScreenScale)}/></g>
      </g>
    })}
    {pending&&hover&&tool==='wire'&&<g className="wire-follow-preview" pointerEvents="none">
      <path className="pending-wire" d={route(terminalPosition(visible,pending),wireTarget?.point??hover)} vectorEffect="non-scaling-stroke"/>
      {!wireTarget&&<g className="wire-grid-landing" transform={`translate(${wireGridPoint(hover).x} ${wireGridPoint(hover).y}) scale(${1/screenScale})`} aria-label="下一拐点网格落点"><path d="M -5 0 H 5 M 0 -5 V 5"/><circle r="8"/></g>}
    </g>}
    {wireTarget&&tool==='wire'&&<g className="wire-snap-preview" pointerEvents="none" aria-label={wireTarget.terminal?'连接到引脚或连接点':'连接到导线并建立分支'}>
      {wireTarget.wireId&&<path className="wire-snap-conductor" d={wirePaths.get(wireTarget.wireId)} vectorEffect="non-scaling-stroke"/>}
      <g transform={`translate(${wireTarget.point.x} ${wireTarget.point.y}) scale(${1/screenScale})`}><circle className="wire-snap-ring" r="5.5"/><circle className="wire-snap-dot" r="1.8"/><text x="11" y="-10">{wireTarget.terminal?'device'in wireTarget.terminal?`${wireTarget.terminal.device} · ${wireTarget.terminal.pin+1}`:wireTarget.terminal.junction:'分支'}</text></g>
    </g>}
    {tool==='label'&&networkSymbol&&hover&&<g className="ghost-device network-symbol-preview" pointerEvents="none" transform={(() => {const at=nearestWireTarget(wireIndex,hover,screenScale)?.point??wireGridPoint(hover);return `translate(${at.x} ${at.y})`})()}><NetSymbolGraphic name={networkSymbol.netName} style={networkSymbol.style} rotation={rotation}/></g>}
    {ghost&&<g className="ghost-device" transform={`translate(${ghost.x} ${ghost.y})`} pointerEvents="none"><DeviceSymbol device={ghost} modelType={importedModels.find(m=>m.kind===ghost.kind&&m.id.toLowerCase()===ghost.value.toLowerCase())?.type} symbol={(()=>{const model=importedModels.find(m=>m.kind===ghost.kind&&m.id.toLowerCase()===ghost.value.toLowerCase());return model?presentedModelSymbol(model,ghost):undefined})()}/></g>}
    {pasted&&<g className="paste-preview" pointerEvents="none">{pasted.wires.map(w=><path key={w.id} d={wirePath(pasted,w)}/>)}{pasted.devices.map(p=><g key={p.id} transform={`translate(${p.x} ${p.y})`}><DeviceSymbol device={p} modelType={pasteModelLookup.get(`${p.kind}:${p.value.toLowerCase()}`)?.type} symbol={(()=>{const model=pasteModelLookup.get(`${p.kind}:${p.value.toLowerCase()}`);return model?presentedModelSymbol(model,p):undefined})()}/></g>)}{pasted.junctions.map(j=><circle key={j.id} cx={j.x} cy={j.y} r="4"/>)}{placeNetLabels(pasted).map(({label,point,x,y,width})=><g key={label.id} transform={`translate(${point.x} ${point.y})`}>{label.style&&label.style!=='text'?<NetSymbolGraphic name={label.name} style={label.style} rotation={label.rotation}/>:<><path d={`M 0 0 V ${y-11} H ${x}`}/><rect x={x} y={y-22} width={width} height="21" rx="4"/><text x={x+7} y={y-7}>{label.name}</text></>}</g>)}</g>}
    {marquee&&<rect className={`selection-marquee ${marquee.intersect?'intersect':''}`} x={Math.min(marquee.start.x,marquee.at.x)} y={Math.min(marquee.start.y,marquee.at.y)} width={Math.abs(marquee.start.x-marquee.at.x)} height={Math.abs(marquee.start.y-marquee.at.y)} pointerEvents="none"/>}
    {canvasDiagrams.map(diagram=>{
      const group=diagramSelection.includes(diagram.id)&&diagramSelection.length>1&&!!onDiagramGroupChange
      const follower=diagramPreview?.id!==diagram.id?diagramPreview?.changes.find(change=>change.id===diagram.id):undefined
      return <CanvasWaveformDiagram key={diagram.id} diagram={follower?{...diagram,...follower}:diagram} active={active} selected={selectedFrames.has(diagram.id)} toWorld={rawPosition} screenScale={screenScale} onChange={changedDiagram} onExpand={onDiagramExpand} onWheelResize={diagram.onWheelResize} onActivate={additive=>activateDiagram(diagram.id,additive)}
        constrainMove={group?geometry=>moveCanvasDiagrams(canvasDiagrams,diagramSelection,{x:geometry.x-diagram.x,y:geometry.y-diagram.y}).find(change=>change.id===diagram.id)??geometry:undefined}
        onPreview={(id,geometry)=>setDiagramPreview(geometry&&group?{id,changes:moveCanvasDiagrams(canvasDiagrams,diagramSelection,{x:geometry.x-diagram.x,y:geometry.y-diagram.y})}:null)}/>
    })}
  </svg>{middleZooming&&<div className="canvas-middle-zoom-hint" role="status"><strong>快速缩放</strong><span>↑ 放大　↓ 缩小</span><small>轻点中键退出 · 按住中键拖动平移</small></div>}{active&&valueDevice&&hasQuickValue(valueDevice)&&<ComponentValueEditor key={valueDevice.id} device={valueDevice} onApply={applyValue} onClose={()=>setEditingValue(null)}/>}</>
}
