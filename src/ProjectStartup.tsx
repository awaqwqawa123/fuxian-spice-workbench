import { useEffect, useState } from 'react'
import { newProject } from './core/circuit'
import { readBrowserProjectsForMigration, type LoadedProjectCollection } from './core/project-store'
import { repositoryRequest, type RepositorySnapshot } from './core/project-repository-client'
import { readLaunchToken } from './core/project-open-handoff'
import { ProjectWorkspace } from './App'
import ProjectBackupPicker from './components/ProjectBackupPicker'
import './project-startup.css'

export const browserProjectStorage = {getItem:(key:string)=>localStorage.getItem(key),setItem:(key:string,value:string)=>localStorage.setItem(key,value)}
type Startup = { snapshot:RepositorySnapshot; browser?:LoadedProjectCollection } | { error:string } | null

export default function ProjectStartup() {
  const [startup,setStartup] = useState<Startup>(null)
  const [attempt,setAttempt] = useState(0)
  const [migrating,setMigrating] = useState(false)
  const [warning,setWarning] = useState('')
  const [backupOpen,setBackupOpen] = useState(false)
  useEffect(()=>{
    const controller = new AbortController()
    let live = true
    const timer = setTimeout(()=>controller.abort(new Error('本机工程库响应超时。')),10_000)
    repositoryRequest({action:'bootstrap'},controller.signal).then(async snapshot=>{
      if (controller.signal.aborted) return
      const url = new URL(window.location.href)
      const openingFile = readLaunchToken(url) !== undefined
      const hasExplicitProject = snapshot.collection.entries.some(entry=>entry.id===url.searchParams.get('project'))
      const browser = openingFile || hasExplicitProject ? undefined : await readBrowserProjectsForMigration(browserProjectStorage,newProject())
      if (!live) return
      setStartup({snapshot,browser})
    }).catch(error=>{ if(live)setStartup({error:error instanceof Error ? error.message : '本机工程库暂不可用。'}) }).finally(()=>clearTimeout(timer))
    return ()=>{ live=false; clearTimeout(timer); controller.abort() }
  },[attempt])

  if (startup && 'snapshot' in startup) {
    const existing = new Set(startup.snapshot.collection.entries.map(entry=>entry.id))
    const missing = startup.browser?.collection.entries.filter(entry=>!existing.has(entry.id)) ?? []
    if (startup.browser?.canPersist && missing.length) {
      const legacy = startup.browser
      return <main className="project-startup"><section>
        <h1>恢复上一版的工程</h1>
        <p>这个浏览器里有 {missing.length} 个工程尚未迁移。导入后可以换浏览器继续编辑。本机已有的工程会保留。</p>
        <ul>{missing.slice(0,8).map(entry=><li key={entry.id}>{entry.project.title}{entry.id===legacy.collection.activeId?'（上次打开）':''}</li>)}</ul>
        {missing.length>8&&<p>以及另外 {missing.length-8} 个工程。</p>}
        {legacy.warning&&<p role="status">{legacy.warning}</p>}
        {warning&&<p role="alert">{warning}</p>}
        <div className="project-startup-actions"><button autoFocus type="button" disabled={migrating} onClick={async()=>{
          setMigrating(true);setWarning('')
          try {
            const snapshot = await repositoryRequest({action:'migrate',collection:legacy.collection},AbortSignal.timeout(20_000))
            setStartup({snapshot})
          } catch (error) {setWarning(error instanceof Error ? error.message : '导入失败，原浏览器数据仍可使用。')}
          finally {setMigrating(false)}
        }}>{migrating?'正在迁移…':'迁移并继续'}</button>
        <button type="button" disabled={migrating} onClick={()=>setStartup({snapshot:startup.snapshot})}>暂不迁移</button></div>
        <p>以后仍可从原浏览器打开工作台主页进行迁移。</p>
      </section></main>
    }
    return <ProjectWorkspace initial={{collection:startup.snapshot.collection, canPersist:true, warning:startup.browser?.warning}} repository={startup.snapshot}/>
  }
  return <main className="project-startup"><section>{startup&&'error' in startup
    ? <><h1>暂时无法读取本机工程</h1><p role="alert">{startup.error} 原工程仍保留。</p><div className="project-startup-actions"><button type="button" onClick={()=>{setStartup(null);setAttempt(n=>n+1)}}>重试读取</button><button type="button" onClick={()=>setBackupOpen(true)}>查看可导出的备份</button></div><details><summary>找回上一版工程</summary><p>请回到原浏览器和原来的工作台地址导出 .fuxian 文件，再在工作台恢复后打开。</p></details></>
    : <><h1>正在恢复工程</h1><p role="status">正在读取本机工程库…</p></>}</section>{backupOpen&&<ProjectBackupPicker canRestore={false} onClose={()=>setBackupOpen(false)} onRestore={()=>{}}/>}</main>
}
