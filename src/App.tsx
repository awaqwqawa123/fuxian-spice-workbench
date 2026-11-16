import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newProject, type Project } from './core/circuit'
import { blankProject } from './core/editor'
import { addProject, loadProjectCollection, saveProjectCollection, saveProjectSelection, selectProject, updateProject } from './core/project-store'
import EditorWorkbench from './EditorWorkbench'
import ProjectSidebar from './components/ProjectSidebar'
import ProjectWritebackDialog from './components/ProjectWritebackDialog'
import type { BoundProjectFile } from './core/project-writeback'
import ProjectBackupPicker from './components/ProjectBackupPicker'
import { applyWorkbenchRoute } from './core/workbench-route'
import { ensureDesktopControlThread, DesktopControlRequestError } from './core/desktop-control-client'
import { useAssistantSettings } from './core/assistant-settings'
import { repositoryRequest, type RepositorySnapshot } from './core/project-repository-client'
import { claimLaunchedProject, readLaunchToken } from './core/project-open-handoff'
import { readProjectFile } from './core/project-file'
import type { LoadedProjectCollection, ProjectEntry } from './core/project-store'
import type { SchematicClipboard } from './core/schematic-clipboard'

const projectStorage={getItem:(key:string)=>localStorage.getItem(key),setItem:(key:string,value:string)=>localStorage.setItem(key,value)}

export default function App() {
  const [initial] = useState(()=>loadProjectCollection(projectStorage,newProject()))
  return <ProjectWorkspace initial={initial}/>
}

export function ProjectWorkspace({initial,repository}:{initial:LoadedProjectCollection;repository?:RepositorySnapshot}) {
  const { connectionMode } = useAssistantSettings()
  const [loaded] = useState(() => applyWorkbenchRoute(initial,window.location.search,!!repository))
  const [collection,setCollection] = useState(loaded.collection)
  const [saveState,setSaveState] = useState<'saved'|'saving'|'error'>(loaded.canPersist?'saving':'error')
  const [error,setError] = useState(loaded.warning??'')
  const [examplesOpen, setExamplesOpen] = useState(() => window.location.hash === '#templates')
  const [initialLeftPanel, setInitialLeftPanel] = useState<'projects'|'library'>('library')
  const [fileAction, setFileAction] = useState<{sequence:number;kind:'open'|'save'}>()
  const [openedProjectNotice, setOpenedProjectNotice] = useState<{id:string;message:string}>()
  const currentCollection = useRef(collection)
  currentCollection.current = collection
  const lastEnsuredProject = useRef('')
  const persistedEntries = useRef<typeof collection.entries | undefined>(undefined)
  const savedRepository = useRef(repository)
  const persistedLocal = useRef(repository?.collection)
  const saveQueue = useRef(Promise.resolve())
  const lastAttempt = useRef(0)
  const projectFileInput = useRef<HTMLInputElement>(null)
  // Project changes remount the editor; copied fragments belong to this workspace.
  const schematicClipboard = useRef<SchematicClipboard|null>(null)
  const [opening,setOpening] = useState(false)
  const [openError,setOpenError] = useState('')
  const externalFileBindings=useRef(new Map<string,BoundProjectFile>())
  const [openWritable,setOpenWritable]=useState(false)
  const [backupOpen,setBackupOpen] = useState(false)
  const active=collection.entries.find(entry=>entry.id===collection.activeId)
  const projectChanged=useCallback((project:Project)=>{
    setCollection(previous=>{
      if(!active||previous.activeId!==active.id)return previous
      const current=previous.entries.find(entry=>entry.id===active.id)
      if(!current||JSON.stringify(current.project)===JSON.stringify(project))return previous
      try{return updateProject(previous,current.id,project)}
      catch{
        // Editing can temporarily exceed import limits. Keep that draft in memory;
        // the persistence effect reports validation failure without losing the editor.
        return {...previous,entries:previous.entries.map(entry=>entry.id===current.id?{...entry,project:structuredClone(project),updatedAt:Date.now()}:entry)}
      }
    })
  },[active?.id])

  const persistRepository = useCallback(()=>{
    const attempt=++lastAttempt.current
    setSaveState('saving')
    saveQueue.current=saveQueue.current.then(async()=>{
      if(attempt!==lastAttempt.current)return
      const snapshot=savedRepository.current
      const entries=currentCollection.current
      if(!snapshot || !entries.entries.length){
        if(attempt===lastAttempt.current)setSaveState('saved')
        return
      }
      try {
        const last=persistedLocal.current
        if(last?.entries!==entries.entries){
          savedRepository.current=await repositoryRequest({action:'save',collection:entries,expectedRevision:snapshot.revision},AbortSignal.timeout(15_000))
        } else if(last.activeId!==entries.activeId&&snapshot.revision){
          await repositoryRequest({action:'select',activeId:entries.activeId,expectedRevision:snapshot.revision},AbortSignal.timeout(10_000))
        }
        persistedLocal.current=entries
        if(attempt===lastAttempt.current){setSaveState('saved');setError(loaded.warning??'')}
      } catch (cause) {
        if(attempt===lastAttempt.current){
          setSaveState('error')
          setError(`保存到本机失败：${(cause as Error).message} 修改仍保留在当前网页，可导出工程文件。`)
        }
      }
    })
  },[loaded])

  useEffect(()=>{
    if(!loaded.canPersist)return
    if(repository){persistRepository();return}
    try{
      if(persistedEntries.current===collection.entries)saveProjectSelection(projectStorage,collection)
      else {saveProjectCollection(projectStorage,collection);persistedEntries.current=collection.entries}
      setSaveState('saved');setError(loaded.warning??'')
    }
    catch(cause){setSaveState('error');setError(`自动保存失败：${(cause as Error).message}。修改仍在内存，请修正参数或导出备份。`)}
  },[collection,loaded,repository,persistRepository])
  useEffect(()=>{
    if(!repository)return
    const protect=(event:BeforeUnloadEvent)=>{
      if(!currentCollection.current.entries.length || persistedLocal.current===currentCollection.current)return
      event.preventDefault();event.returnValue=''
    }
    window.addEventListener('beforeunload',protect)
    return ()=>window.removeEventListener('beforeunload',protect)
  },[repository])
  useEffect(() => {
    const sync = () => setExamplesOpen(window.location.hash === '#templates')
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])
  useEffect(() => {
    if(!active||connectionMode==='mcp')return
    let mounted = true, retry: ReturnType<typeof setTimeout> | undefined, pending: ReturnType<typeof setTimeout> | undefined
    const projectId = collection.activeId, title = active.project.title
    const ensure = async () => {
      try { await ensureDesktopControlThread(projectId, title) }
      catch (reason) {
        if (!mounted) return
        // A disconnected desktop or local service can recover later. A rejected
        // creation stays pending for review so we never make a second thread.
        if (!(reason instanceof DesktopControlRequestError) || [408, 501, 502, 503].includes(reason.status)) retry = setTimeout(() => { void ensure() }, reason instanceof DesktopControlRequestError && reason.status === 501 ? 30_000 : 2500)
      }
    }
    if (lastEnsuredProject.current === projectId) pending = setTimeout(() => { void ensure() }, 350)
    else { lastEnsuredProject.current = projectId; void ensure() }
    return () => { mounted = false; if (pending) clearTimeout(pending); if (retry) clearTimeout(retry) }
  }, [collection.activeId, active?.project.title, connectionMode])
  function changeExamples(open: boolean) {
    const hash = open ? '#templates' : '#editor'
    if (window.location.hash !== hash) window.history.pushState(null, '', hash)
    setExamplesOpen(open)
  }
  function navigateProject(id:string){
    const url=new URL(window.location.href);url.searchParams.set('project',id);url.searchParams.delete('codexSession');url.hash='editor'
    window.history.replaceState(null,'',url)
  }
  function choose(id:string){if(id!==collection.activeId){setFileAction(undefined);setInitialLeftPanel('projects');changeExamples(false);navigateProject(id);setCollection(previous=>selectProject(previous,id))}}
  function create(){setFileAction(undefined);const project=blankProject();project.title=`新建电路 ${collection.entries.length+1}`;const next=addProject(collection,project);setInitialLeftPanel('projects');changeExamples(false);navigateProject(next.activeId);setCollection(next)}
  function openProjectFile(project:Project, notice?:string, binding?:BoundProjectFile) {
    // Imported projects receive a fresh local identity and their own chat binding.
    // Read the current collection so a completed file read cannot restore an old list.
    const next=addProject(currentCollection.current,project)
    if(binding)externalFileBindings.current.set(next.activeId,binding)
    currentCollection.current=next
    setInitialLeftPanel('projects');changeExamples(false);navigateProject(next.activeId)
    setOpenedProjectNotice({id:next.activeId,message:notice??'工程文件已作为独立项目打开；原工程已保留。'})
    setFileAction(undefined);setCollection(next)
  }
  const onOpen = useRef(openProjectFile)
  onOpen.current=openProjectFile
  useEffect(()=>{
    if(!repository)return
    const token=readLaunchToken(new URL(window.location.href))
    if(token===undefined)return
    let live=true
    const controller=new AbortController()
    setOpening(true)
    const timer=setTimeout(()=>controller.abort(),15_000)
    claimLaunchedProject(token,controller.signal).then(({project,warnings})=>{
      if(live)onOpen.current(project,['已从文件打开为独立工程；原文件未改动。',...warnings].join(' '))
    }).catch(reason=>{
      if(!live)return
      setOpenError((reason as Error).message)
      const url=new URL(window.location.href);url.hash=''
      window.history.replaceState(null,'',url)
    }).finally(()=>{clearTimeout(timer);if(live)setOpening(false)})
    return ()=>{live=false;clearTimeout(timer);controller.abort()}
  },[repository])
  function requestProjectFile(kind:'open'|'save') {
    if(kind==='open'&&projectFileInput.current){projectFileInput.current.click();return}
    setFileAction(previous=>({sequence:(previous?.sequence??0)+1,kind}))
  }
  function duplicate(){
    if(!active)return
    setFileAction(undefined)
    const project=structuredClone(active.project);project.title=`${project.title.slice(0,70)} 副本`
    try{const next=addProject(collection,project);setInitialLeftPanel('projects');changeExamples(false);navigateProject(next.activeId);setCollection(next)}
    catch(cause){setSaveState('error');setError(`无法另存副本：${(cause as Error).message}。当前工程仍在内存，请修正参数后重试。`)}
  }
  async function restoreBackup(snapshot:ProjectEntry){
    const operation=saveQueue.current.then(async()=>{
      const saved=savedRepository.current
      if(!saved)throw new Error('无法读取本机工程库修订。')
      const before=currentCollection.current
      const next=addProject(before,{...snapshot.project,title:`${snapshot.project.title.slice(0,70)}（恢复副本）`})
      savedRepository.current=await repositoryRequest({action:'save',collection:next,expectedRevision:saved.revision},AbortSignal.timeout(15_000))
      persistedLocal.current=next
      const latest=currentCollection.current
      const result=latest===before ? next : {...latest,activeId:next.activeId,entries:[...latest.entries,next.entries.at(-1)!]}
      currentCollection.current=result
      setInitialLeftPanel('projects');changeExamples(false);navigateProject(result.activeId)
      setOpenedProjectNotice({id:result.activeId,message:'已把上一版备份恢复为独立工程。'})
      setFileAction(undefined);setCollection(result)
    })
    saveQueue.current=operation.catch(()=>{})
    await operation
  }
  function retry(){
    if(!loaded.canPersist)return
    if(repository){persistRepository();return}
    try{saveProjectCollection(projectStorage,collection);persistedEntries.current=collection.entries;setSaveState('saved');setError('')}
    catch(cause){setSaveState('error');setError((cause as Error).message)}
  }
  const projectEntries=useMemo(()=>collection.entries.map(entry=>({id:entry.id,title:entry.project.title,updatedAt:entry.updatedAt,deviceCount:entry.project.drawing?.devices.filter(part=>part.kind!=='GND').length??0})),[collection.entries])
  const openMessage=openError&&<p role="alert">{openError} <button type="button" onClick={()=>setOpenError('')}>关闭提示</button></p>
  const backupPicker=backupOpen&&<ProjectBackupPicker canRestore={!!repository} onClose={()=>setBackupOpen(false)} onRestore={restoreBackup}/>
  if(!active)return <main className="project-startup"><section>
    <h1>{opening?'正在打开工程':'伏线 · 本机工程'}</h1>
    <p>{opening?'工作台正在读取选中的 .fuxian 文件。':'打开别人分享的 .fuxian 工程，或新建原理图。工程会自动保存到本机。'}</p>
    {loaded.warning&&<p role="status">{loaded.warning}</p>}
    {openMessage}
    <div className="project-startup-actions"><button type="button" autoFocus disabled={opening} onClick={()=>requestProjectFile('open')}>打开工程</button><button type="button" disabled={opening} onClick={create}>新建工程</button>{repository&&<button type="button" disabled={opening} onClick={()=>setBackupOpen(true)}>从备份恢复</button>}</div>
    <button type="button" disabled={opening} onClick={()=>setOpenWritable(true)}>打开可写工程</button>
    <input ref={projectFileInput} type="file" hidden accept=".fuxian,.json" aria-label="打开工程文件" onChange={async event=>{
      const file=event.currentTarget.files?.[0];event.currentTarget.value=''
      if(!file)return
      setOpening(true);setOpenError('')
      try {const {project,warnings}=await readProjectFile(file);openProjectFile(project,warnings.length?warnings.join(' '):undefined)}
      catch (reason) {setOpenError((reason as Error).message)}
      finally {setOpening(false)}
    }}/>
  </section>{backupPicker}{openWritable&&<ProjectWritebackDialog onClose={()=>setOpenWritable(false)} onOpen={(...args)=>{openProjectFile(...args);setOpenWritable(false)}} onChooseNormal={()=>{setOpenWritable(false);requestProjectFile('open')}}/>}</main>
  const projectPanel=<ProjectSidebar embedded entries={projectEntries} activeId={collection.activeId} onSelect={choose} onNew={create} onDuplicate={duplicate} onOpenFile={()=>requestProjectFile('open')} onSaveFile={()=>requestProjectFile('save')} onRestoreBackup={repository?()=>setBackupOpen(true):undefined} saveState={saveState} error={error} onRetry={loaded.canPersist?retry:undefined}/>
  return <div className="project-shell">
    <div className="project-main">
      {openMessage&&<div className="project-startup-notice">{openMessage}</div>}
      <EditorWorkbench key={active.id} initialLeftPanel={initialLeftPanel} projectId={active.id} schematicClipboard={schematicClipboard} initialCodexSessionId={active.id===loaded.collection.activeId?loaded.sessionId:undefined} seed={active.project} onProjectChange={projectChanged} onOpenProject={openProjectFile} externalFileBinding={externalFileBindings.current.get(active.id)} projectFileInputRef={projectFileInput} onRequestProjectSave={repository?retry:undefined} fileAction={fileAction} initialProjectNotice={openedProjectNotice?.id===active.id?openedProjectNotice.message:undefined} saveState={saveState} saveError={error} onRetrySave={loaded.canPersist?retry:undefined} examplesOpen={examplesOpen} onExamplesOpenChange={changeExamples} projectPanel={projectPanel}/>
    </div>
    {backupPicker}
  </div>
}
