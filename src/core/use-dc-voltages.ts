import { useEffect, useMemo, useRef, useState } from 'react'
import { validateProject, type Project } from './circuit'
import { dcNodeVoltages, dcVoltageProject, dcVoltageResultMatches } from './dc-voltage'
import { layoutElectricallyEquivalent } from './layout-electrical-equivalence'
import { biasMeasurements } from './bias-inspection'
import { readBiasDisplayPreferences, saveBiasDisplayPreferences, type BiasDisplayPreferences } from './bias-display'
import { readBiasHistory, saveBiasHistory } from './bias-history'
import type { Result } from './results'
import type { XY } from './drawing'
import type { WireCurrentTarget } from './wire-currents'

export function useDcVoltages(project:Project,profileResults:Record<string,Result>,projectId='standalone') {
  const [prefs,setPrefs]=useState(()=>readBiasDisplayPreferences(projectId))
  const [displayPast,setDisplayPast]=useState<BiasDisplayPreferences[]>([]),[displayFuture,setDisplayFuture]=useState<BiasDisplayPreferences[]>([])
  const [saved,setSaved]=useState(()=>({projectId,history:readBiasHistory(projectId)}))
  const [running,setRunning]=useState(false),[progress,setProgress]=useState(''),[failure,setFailure]=useState('')
  const [storageWarning,setStorageWarning]=useState(''),[tableOpen,setTableOpen]=useState(false),[placingWire,setPlacingWire]=useState(false)
  const [selectedId,setSelectedId]=useState<string>(),[viewedRunId,setViewedRunId]=useState<string>()
  const worker=useRef<Worker|null>(null),deadline=useRef<ReturnType<typeof setTimeout>|null>(null)
  const workerSnapshot=useRef<{scope:string,project:Project}|null>(null)
  const currentProject=useRef(project);currentProject.current=project
  const currentScope=useRef(projectId);currentScope.current=projectId
  const preferences=useRef(prefs);preferences.current=prefs
  const savedRuns=useRef(saved);savedRuns.current=saved
  const completedProfiles=useRef(profileResults);completedProfiles.current=profileResults
  const history=saved.projectId===projectId?saved.history:[]
  const latest=history[0]??null
  const result=useMemo<Result|null>(()=>[...Object.values(profileResults),...history]
    .filter(item=>dcVoltageResultMatches(item,project)&&(!prefs.current||!!item.terminalCurrents))
    .sort((a,b)=>b.timestamp-a.timestamp)[0]??null,[project,profileResults,history,prefs.current])
  const displayActive=prefs.voltage||prefs.current
  const usable=!!result&&!running&&!failure
  const measurements=useMemo(()=>biasMeasurements(usable?result:null,project,prefs.wireTargets??[]),[usable,result,project,prefs.wireTargets])
  const voltages=useMemo(()=>prefs.voltage&&usable?dcNodeVoltages(result!,project):undefined,[prefs.voltage,usable,result,project])
  const stale=!!latest&&!dcVoltageResultMatches(latest,project)&&!result
  function stopWorker(){
    worker.current?.terminate();worker.current=null
    workerSnapshot.current=null
    if(deadline.current)clearTimeout(deadline.current)
    deadline.current=null;setRunning(false)
  }
  function stop(){stopWorker();setFailure('计算已停止。此前结果保留在历史中，请重新计算后显示。')}
  useEffect(()=>()=>{
    worker.current?.terminate()
    if(deadline.current)clearTimeout(deadline.current)
  },[])
  useEffect(()=>{
    stopWorker();setFailure('');setStorageWarning('');setTableOpen(false);setPlacingWire(false);setViewedRunId(undefined);setSelectedId(undefined)
    setPrefs(readBiasDisplayPreferences(projectId));setSaved({projectId,history:readBiasHistory(projectId)});setDisplayPast([]);setDisplayFuture([])
  },[projectId])
  useEffect(()=>{
    if(saved.projectId===projectId&&!saveBiasDisplayPreferences(projectId,prefs))setStorageWarning('显示设置未能保存，请检查浏览器存储空间。')
  },[prefs,projectId,saved.projectId])
  useEffect(()=>{
    if(saved.projectId===projectId&&saved.history.length&&!saveBiasHistory(projectId,saved.history))setStorageWarning('工作点历史未能保存，当前结果仍可查看与导出。')
  },[saved,projectId])
  // Notice visibility is UI state: background restoration must respect its saved value.
  function setNoticeHidden(hidden:boolean){
    const previous=preferences.current
    if(!!previous.noticeHidden===hidden)return
    const next={...previous,noticeHidden:hidden}
    preferences.current=next;setPrefs(next)
  }
  function calculate(){startCalculation(true)}
  function startCalculation(revealNotice:boolean){
    if(revealNotice)setNoticeHidden(false)
    stopWorker();setFailure('');setViewedRunId(undefined)
    const scope=currentScope.current,snapshot=dcVoltageProject(currentProject.current),issues=validateProject(snapshot)
    if(issues.length){setFailure(issues.join('\n'));return}
    let next:Worker
    try{next=new Worker(new URL('../bias.worker.ts',import.meta.url),{type:'module'})}
    catch(error){setFailure((error as Error).message);return}
    worker.current=next;workerSnapshot.current={scope,project:snapshot};setRunning(true);setProgress('正在计算直流工作点…')
    const fail=(message:string)=>{if(worker.current!==next)return;setFailure(message);stopWorker()}
    next.onmessage=event=>{
      if(worker.current!==next||currentScope.current!==scope)return
      const message=event.data
      if(message.type==='progress')setProgress(message.message)
      if(message.type==='error')fail(message.message)
      if(message.type==='result'){
        const completed=message.result as Result
        stopWorker()
        if(!dcVoltageResultMatches(completed,currentProject.current)){
          setFailure('计算期间电路已修改，请重新计算直流工作点。');return
        }
        rememberResult(completed,scope)
      }
    }
    next.onerror=event=>fail(event.message||'工作点计算线程未能启动。')
    deadline.current=setTimeout(()=>fail('工作点计算超过 30 秒，已停止。请检查电路连接和模型。'),30000)
    try{next.postMessage(structuredClone(snapshot))}catch(error){fail((error as Error).message)}
  }
  function rememberResult(completed:Result,scope:string){
    const previous=savedRuns.current
    const next={projectId:scope,history:[completed,...(previous.projectId===scope?previous.history:[]).filter(item=>item.id!==completed.id)].slice(0,6)}
    savedRuns.current=next;setSaved(next)
  }
  /** A successful waveform analysis requests a separate bias point, never one of its samples. */
  function simulationCompleted(completed:Result,{refresh=false}:{refresh?:boolean}={}){
    const scope=currentScope.current,active=currentProject.current
    // A callback retained by a previous project cannot turn on this project's annotations.
    if(scope!==projectId||!layoutElectricallyEquivalent(dcVoltageProject(completed.experiment??completed.project),dcVoltageProject(active)))return
    const next={...preferences.current,voltage:true}
    preferences.current=next;setPrefs(next);setViewedRunId(undefined)
    // A deliberate run must obtain a new bias point. Only its own single-point OP
    // can satisfy that request directly; restored results may still use history.
    const candidates=refresh?[completed]:[completed,...Object.values(completedProfiles.current),...(savedRuns.current.projectId===scope?savedRuns.current.history:[])]
    const cached=candidates.filter(item=>dcVoltageResultMatches(item,active)&&(!next.current||!!item.terminalCurrents)).sort((a,b)=>b.timestamp-a.timestamp)[0]
    if(cached){
      if(worker.current)stopWorker()
      setFailure('');rememberResult(cached,scope);return
    }
    const pending=workerSnapshot.current
    if(worker.current&&pending?.scope===scope&&layoutElectricallyEquivalent(pending.project,dcVoltageProject(active)))return
    startCalculation(false)
  }
  function toggleKind(kind:'voltage'|'current',show:boolean){
    const next={...preferences.current,[kind]:show,...(show?{noticeHidden:false}:{})}
    preferences.current=next
    setPrefs(next)
    if(show){
      const currentResult=result&&(!next.current||!!result.terminalCurrents)?result:null
      if(currentResult){setFailure('');if(!history.some(item=>item.id===currentResult.id))setSaved(previous=>({...previous,history:[currentResult,...previous.history].slice(0,6)}))}
      else if(!worker.current)calculate()
    }else if(!next.voltage&&!next.current){stopWorker();setFailure('');setPlacingWire(false)}
  }
  const mountedScope=useRef<string|undefined>(undefined)
  useEffect(()=>{
    if(saved.projectId!==projectId||mountedScope.current===projectId)return
    mountedScope.current=projectId
    if((prefs.voltage||prefs.current)&&!result)startCalculation(false)
  },[saved.projectId,projectId,prefs.voltage,prefs.current,result])
  function updateDisplay(next:BiasDisplayPreferences){
    if(JSON.stringify(next)===JSON.stringify(preferences.current))return
    const before=preferences.current
    preferences.current=next
    setDisplayPast(previous=>[...previous,before].slice(-32));setDisplayFuture([]);setPrefs(next)
  }
  function patchPrefs(patch:Partial<BiasDisplayPreferences>){updateDisplay({...preferences.current,...patch})}
  function moveLabel(id:string,offset:XY){updateDisplay({...preferences.current,offsets:{...preferences.current.offsets,[id]:offset}})}
  function pin(id:string){const previous=preferences.current;updateDisplay({...previous,pinned:previous.pinned.includes(id)?previous.pinned.filter(item=>item!==id):[...previous.pinned,id]})}
  function hide(id:string){const previous=preferences.current;updateDisplay({...previous,hidden:previous.hidden.includes(id)?previous.hidden.filter(item=>item!==id):[...previous.hidden,id]})}
  function undoDisplay(){const last=displayPast.at(-1);if(!last)return;setDisplayPast(displayPast.slice(0,-1));setDisplayFuture(previous=>[preferences.current,...previous]);setPrefs({...last,noticeHidden:preferences.current.noticeHidden})}
  function redoDisplay(){const first=displayFuture[0];if(!first)return;setDisplayFuture(displayFuture.slice(1));setDisplayPast(previous=>[...previous,preferences.current]);setPrefs({...first,noticeHidden:preferences.current.noticeHidden})}
  function addWire(target:WireCurrentTarget){
    const previous=preferences.current
    updateDisplay({...previous,current:true,wireTargets:[...(previous.wireTargets??[]).filter(item=>item.wireId!==target.wireId),target]})
    setPlacingWire(false)
    if(!result?.terminalCurrents&&!worker.current)calculate()
  }
  const viewedResult=history.find(item=>item.id===viewedRunId)??result??latest
  return {enabled:prefs.voltage,toggle:(show:boolean)=>toggleKind('voltage',show),currentsEnabled:prefs.current,toggleCurrents:(show:boolean)=>toggleKind('current',show),
    calculate,simulationCompleted,stop,noticeHidden:!!prefs.noticeHidden,setNoticeHidden,running,progress,failure,stale,result,voltages,usable,displayActive,measurements,prefs,patchPrefs,moveLabel,pin,hide,history,
    storageWarning,tableOpen,setTableOpen,placingWire,setPlacingWire,addWire,selectedId,setSelectedId,viewedRunId,setViewedRunId,viewedResult,
    undoDisplay,redoDisplay,canUndoDisplay:displayPast.length>0,canRedoDisplay:displayFuture.length>0}
}
