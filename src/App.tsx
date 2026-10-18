import { useCallback, useEffect, useRef, useState } from 'react'
import { newProject, type Project } from './core/circuit'
import { blankProject } from './core/editor'
import { addProject, loadProjectCollection, saveProjectCollection, selectProject, updateProject } from './core/project-store'
import EditorWorkbench from './EditorWorkbench'
import ProjectSidebar from './components/ProjectSidebar'
import { applyWorkbenchRoute } from './core/workbench-route'
import { ensureDesktopControlThread, DesktopControlRequestError } from './core/desktop-control-client'

const projectStorage={getItem:(key:string)=>localStorage.getItem(key),setItem:(key:string,value:string)=>localStorage.setItem(key,value)}

export default function App() {
  const [loaded] = useState(() => applyWorkbenchRoute(loadProjectCollection(projectStorage,newProject()),window.location.search))
  const [collection,setCollection] = useState(loaded.collection)
  const [saveState,setSaveState] = useState<'saved'|'saving'|'error'>(loaded.canPersist?'saving':'error')
  const [error,setError] = useState(loaded.warning??'')
  const [examplesOpen, setExamplesOpen] = useState(() => window.location.hash === '#templates')
  const [initialLeftPanel, setInitialLeftPanel] = useState<'projects'|'library'>('library')
  const lastEnsuredProject = useRef('')
  const active=collection.entries.find(entry=>entry.id===collection.activeId)!
  const projectChanged=useCallback((project:Project)=>{
    setCollection(previous=>{
      if(previous.activeId!==active.id)return previous
      const current=previous.entries.find(entry=>entry.id===active.id)
      if(!current||JSON.stringify(current.project)===JSON.stringify(project))return previous
      try{return updateProject(previous,current.id,project)}
      catch{
        // Editing can temporarily exceed import limits. Keep that draft in memory;
        // the persistence effect reports validation failure without losing the editor.
        return {...previous,entries:previous.entries.map(entry=>entry.id===current.id?{...entry,project:structuredClone(project),updatedAt:Date.now()}:entry)}
      }
    })
  },[active.id])
  useEffect(()=>{
    if(!loaded.canPersist)return
    try{saveProjectCollection(projectStorage,collection);setSaveState('saved');setError(loaded.warning??'')}
    catch(cause){setSaveState('error');setError(`自动保存失败：${(cause as Error).message}。修改仍在内存，请修正参数或导出备份。`)}
  },[collection,loaded])
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
  }, [collection.activeId, active.project.title])
  function changeExamples(open: boolean) {
    const hash = open ? '#templates' : '#editor'
    if (window.location.hash !== hash) window.history.pushState(null, '', hash)
    setExamplesOpen(open)
  }
  function navigateProject(id:string){
    const url=new URL(window.location.href);url.searchParams.set('project',id);url.searchParams.delete('codexSession');url.hash='editor'
    window.history.replaceState(null,'',url)
  }
  function choose(id:string){if(id!==collection.activeId){setInitialLeftPanel('projects');changeExamples(false);navigateProject(id);setCollection(previous=>selectProject(previous,id))}}
  function create(){const project=blankProject();project.title=`新建电路 ${collection.entries.length+1}`;const next=addProject(collection,project);setInitialLeftPanel('projects');changeExamples(false);navigateProject(next.activeId);setCollection(next)}
  function duplicate(){
    const project=structuredClone(active.project);project.title=`${project.title.slice(0,70)} 副本`
    try{const next=addProject(collection,project);setInitialLeftPanel('projects');changeExamples(false);navigateProject(next.activeId);setCollection(next)}
    catch(cause){setSaveState('error');setError(`无法另存副本：${(cause as Error).message}。当前工程仍在内存，请修正参数后重试。`)}
  }
  function retry(){
    if(!loaded.canPersist)return
    try{saveProjectCollection(projectStorage,collection);setSaveState('saved');setError('')}
    catch(cause){setSaveState('error');setError((cause as Error).message)}
  }
  const projectPanel=<ProjectSidebar embedded entries={collection.entries.map(entry=>({id:entry.id,title:entry.project.title,updatedAt:entry.updatedAt,deviceCount:entry.project.drawing?.devices.filter(part=>part.kind!=='GND').length??0}))} activeId={collection.activeId} onSelect={choose} onNew={create} onDuplicate={duplicate} saveState={saveState} error={error} onRetry={loaded.canPersist?retry:undefined}/>
  return <div className="project-shell">
    <div className="project-main">
      <EditorWorkbench key={active.id} initialLeftPanel={initialLeftPanel} projectId={active.id} initialCodexSessionId={active.id===loaded.collection.activeId?loaded.sessionId:undefined} seed={active.project} onProjectChange={projectChanged} saveState={saveState} saveError={error} onRetrySave={loaded.canPersist?retry:undefined} examplesOpen={examplesOpen} onExamplesOpenChange={changeExamples} projectPanel={projectPanel}/>
    </div>
  </div>
}
