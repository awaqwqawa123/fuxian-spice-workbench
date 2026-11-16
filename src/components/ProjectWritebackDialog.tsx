import { useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, Download, FileCheck, FolderOpen, X } from 'lucide-react'
import { BoundProjectFile, browserProjectPickers, cancelledProjectPicker, supportsProjectWriteback } from '../core/project-writeback'
import type { Project } from '../core/circuit'
import { useWorkbenchDialog } from './AssistantWindow'

interface Props {
  binding?: BoundProjectFile
  onClose: () => void
  onOpen: (project:Project,notice?:string,binding?:BoundProjectFile) => void
  getProject?: () => Project
  onExport?: () => void
  onChooseNormal?: () => void
  onDownloadBackup?: (name:string,bytes:Uint8Array) => void
}
export default function ProjectWritebackDialog({binding,onClose,onOpen,getProject,onExport,onChooseNormal,onDownloadBackup}:Props) {
  const panel=useRef<HTMLElement>(null), title=useId(), active=useRef(false)
  const lifetime=useRef<AbortController|null>(null)
  useEffect(()=>{const controller=new AbortController();lifetime.current=controller;return()=>controller.abort()},[])
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('')
  const pickers=browserProjectPickers(), supported=supportsProjectWriteback(pickers)
  function close(){if(!active.current)onClose()}
  useWorkbenchDialog(panel,true,close)
  async function run(action:()=>Promise<void>) {
    if(active.current)return
    active.current=true;setBusy(true);setError('');setMessage('')
    try{await action()}
    catch(reason){if(!cancelledProjectPicker(reason))setError((reason as Error).message)}
    finally{active.current=false;setBusy(false)}
  }
  function openSelected(){
    void run(async()=>{
      const {project,warnings,binding:next}=await BoundProjectFile.choose(pickers)
      if(lifetime.current?.signal.aborted)return
      onOpen(project,['已在本机创建可写副本。要更新原文件，请从「文件」菜单选择「写回原工程文件」。',...warnings].join(' '),next)
    })
  }
  function openExternal(){
    void run(async()=>{
      const {project,warnings}=await binding!.openExternalCopy()
      if(lifetime.current?.signal.aborted)return
      onOpen(project,['已将外部版本打开为独立副本；之前编辑的工程仍可从项目栏打开。',...warnings].join(' '))
    })
  }
  function verifyBackup(){void run(async()=>{const name=await binding!.verifyBackup(pickers);setMessage('已核对原文件备份：'+name)})}
  function write(){
    if(!getProject)return
    void run(async()=>{
      const project=getProject()
      const backup=binding!.backupName
      const name=await binding!.write(project,lifetime.current?.signal)
      setMessage('已写回 '+name+'。旧版备份：'+backup)
    })
  }
  return <div className="workbench-window-backdrop writeback-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)close()}}>
    <section ref={panel} className="workbench-window writeback-window" role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1}>
      <header><FileCheck size={22}/><div><h2 id={title}>{binding?'写回原工程文件':'打开可写工程'}</h2>{binding&&<p className="writeback-filename">{binding.name}</p>}</div><button type="button" aria-label="关闭写回窗口" disabled={busy} onClick={close}><X size={18}/></button></header>
      <div className="writeback-body">
        {!supported?<p>当前浏览器未开放工程写回。可以照常打开副本、编辑，再导出新的 .fuxian 文件。</p>:binding?<><p>把此工程的原理图、模型和仿真配置写到同一份文件。本机项目会继续自动保存。</p><p>请先关闭正在编辑原文件的其他程序。伏线会在提交前检查内容，但无法锁定浏览器之外的编辑器。</p></>:<p>选择一个 .fuxian 文件来建立可写的本机副本。只有通过「写回原工程文件」逐次确认，才会更新原文件。关闭网页后，关联会清除。</p>}
        {supported&&binding&&binding.canWrite&&<div className="writeback-backup">
          <div><strong>保留写回前的版本</strong><p>{binding.backupName?'已验证：'+binding.backupName:'先下载原版本，再从下载目录选择该备份文件。伏线会核对备份内容。'}</p></div>
          <div><button type="button" disabled={busy} onClick={()=>onDownloadBackup?.(binding.suggestedBackupName(),binding.backupBytes())}><Download size={15}/>下载原文件备份</button><button type="button" disabled={busy} onClick={verifyBackup}><FolderOpen size={15}/>选择下载的备份</button></div>
        </div>}
        {error&&<p className="writeback-error" role="alert"><AlertTriangle size={16}/><span>{error}</span></p>}
        {message&&<p className="writeback-message" role="status">{message}</p>}
        {busy&&<p role="status">正在检查文件…</p>}
      </div>
      <footer>
        <button type="button" disabled={busy} onClick={close}>关闭</button>
        {binding&&<button type="button" disabled={busy} onClick={openExternal}>打开外部版本为新副本</button>}
        {onExport&&<button type="button" disabled={busy} onClick={onExport}>导出当前工程</button>}
        {supported&&!binding&&<button type="button" className="writeback-primary" disabled={busy} onClick={openSelected}><FolderOpen size={16}/>选择 .fuxian 文件</button>}
        {!binding&&onChooseNormal&&<button type="button" className={supported?undefined:"writeback-primary"} disabled={busy} onClick={onChooseNormal}>打开独立副本</button>}
        {supported&&binding&&<button type="button" className="writeback-primary" disabled={busy||!binding.canWrite||!binding.backupName||!getProject} onClick={write}>确认写回原文件</button>}
      </footer>
    </section>
  </div>
}
