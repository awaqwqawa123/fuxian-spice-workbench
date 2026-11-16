import type { Project } from './circuit'
import { createProjectArchive, MAX_PROJECT_FILE_BYTES, readProjectFile } from './project-file'

type Permission = 'granted' | 'denied' | 'prompt'
interface WriteStream {
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}
export interface ProjectFileHandle {
  kind: 'file'
  name: string
  getFile(): Promise<File>
  isSameEntry(other: ProjectFileHandle): Promise<boolean>
  requestPermission(options: {mode:'readwrite'}): Promise<Permission>
  createWritable(options: {mode:'exclusive'; keepExistingData:false}): Promise<WriteStream>
}
interface PickerType { description: string; accept: Record<string, string[]> }
export interface ProjectFilePickers {
  showOpenFilePicker?: (options: {multiple:false;excludeAcceptAllOption:true;types:PickerType[]}) => Promise<ProjectFileHandle[]>
}
const pickerTypes = [{description:'伏线工程',accept:{'application/zip':['.fuxian']}}]
const handleOptions = {mode:'exclusive',keepExistingData:false} as const
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export class ExternalProjectConflict extends Error {}
export function browserProjectPickers(): ProjectFilePickers {
  return window as unknown as ProjectFilePickers
}
export function supportsProjectWriteback(pickers:ProjectFilePickers): boolean {
  return typeof pickers.showOpenFilePicker==='function'
}
export function cancelledProjectPicker(error:unknown): boolean {
  return typeof error==='object' && error!==null && 'name' in error && error.name==='AbortError'
}

function requireHandle(handle:ProjectFileHandle) {
  if (handle?.kind!=='file' || !/\.fuxian$/i.test(handle.name) || typeof handle.isSameEntry!=='function' || typeof handle.getFile!=='function' ||
      typeof handle.requestPermission!=='function' || typeof handle.createWritable!=='function') throw new Error('请选择浏览器可授权的 .fuxian 文件。')
}
const sameBytes = (a:Uint8Array,b:Uint8Array) => a.length===b.length && a.every((byte,index)=>byte===b[index])
async function readRevision(handle:ProjectFileHandle,expectedName:string):Promise<Uint8Array<ArrayBuffer>> {
  const file=await handle.getFile()
  if (handle.name!==expectedName || file.name!==expectedName) throw new Error('文件名已变化，请重新选取外部文件。')
  if (!Number.isInteger(file.size) || file.size<0 || file.size>MAX_PROJECT_FILE_BYTES) throw new Error('无法读取文件，或已超过工程文件大小限制。')
  const bytes=new Uint8Array(await file.arrayBuffer())
  if (bytes.length!==file.size || bytes.length===0) throw new Error('文件为空或在读取时发生变化，请重新选取。')
  return bytes
}
const parseRevision = (name:string,bytes:Uint8Array<ArrayBuffer>) => readProjectFile({
  name,size:bytes.length,arrayBuffer:async()=>bytes.buffer,text:async()=>new TextDecoder().decode(bytes)
})

/** A binding is created from the same immutable bytes used to open the editable copy.
 * It lives in memory and never accepts a new base after detecting a conflict.
 */
export class BoundProjectFile {
  private busy = false
  private backup: {handle:ProjectFileHandle;name:string} | undefined
  private invalidated = false
  private constructor(private handle:ProjectFileHandle, readonly name:string, private revision:Uint8Array<ArrayBuffer>) {}

  static async choose(pickers:ProjectFilePickers) {
    if (!supportsProjectWriteback(pickers)) throw new Error('当前浏览器不支持文件写回，请用“导出工程文件”。')
    const handles=await pickers.showOpenFilePicker!({multiple:false,excludeAcceptAllOption:true,types:pickerTypes})
    if (handles.length!==1) throw new Error('请明确选择一个外部工程。')
    const handle=handles[0]
    requireHandle(handle)
    const name=handle.name, bytes=await readRevision(handle,name)
    const opened=await parseRevision(name,bytes)
    return {...opened,binding:new BoundProjectFile(handle,name,bytes)}
  }

  get backupName(): string | undefined { return this.backup?.name }
  get canWrite(): boolean { return !this.invalidated }
  backupBytes() { return this.revision.slice() }
  suggestedBackupName() { return this.name.replace(/\.fuxian$/i,'').slice(0,64)+'-写回前-'+new Date().toISOString().slice(0,19).replace(/:/g,'-')+'.fuxian' }

  private async operation<T>(action:()=>Promise<T>):Promise<T> {
    if (this.busy) throw new Error('另一项文件操作正在进行。')
    this.busy=true
    try { return await action() }
    finally { this.busy=false }
  }
  private async assertCurrent() {
    if (this.invalidated) throw new ExternalProjectConflict('文件状态已发生变化；请打开外部版本为独立副本，或导出当前工程。')
    let bytes:Uint8Array
    try { bytes=await readRevision(this.handle,this.name) }
    catch (error) {
      this.invalidated=true
      throw new ExternalProjectConflict('无法再次读取原文件：'+errorText(error))
    }
    if (!sameBytes(bytes,this.revision)) {
      this.invalidated=true
      throw new ExternalProjectConflict('原文件的内容与打开时不同。请打开外部版本为独立副本，或导出当前工程。')
    }
  }
  private async assertBackup() {
    const backup=this.backup
    try {
      if (backup && !await this.handle.isSameEntry(backup.handle) && sameBytes(await readRevision(backup.handle,backup.name),this.revision)) return
    } catch { /* Moved, unavailable or changed backup must be saved again. */ }
    this.backup=undefined
    throw new Error('请先将原文件另存到不同的备份文件，并保留该备份。')
  }

  async verifyBackup(pickers:ProjectFilePickers) {
    if (!pickers.showOpenFilePicker) throw new Error('浏览器不支持选择备份，请导出当前工程。')
    return this.operation(async()=>{
      const handles=await pickers.showOpenFilePicker!({multiple:false,excludeAcceptAllOption:true,types:pickerTypes})
      if (handles.length!==1) throw new Error('请选择一个独立的原文件备份。')
      const handle=handles[0]
      requireHandle(handle)
      const name=handle.name
      if (await this.handle.isSameEntry(handle)) throw new Error('这是原工程文件，请选择已下载的独立备份。')
      if (!sameBytes(await readRevision(handle,name),this.revision)) throw new Error('所选备份内容与打开工程时的文件不同。')
      this.backup={handle,name}
      return name
    })
  }

  async write(project: Project, signal?:AbortSignal) {
    return this.operation(async()=>{
      signal?.throwIfAborted()
      if (!this.canWrite) throw new ExternalProjectConflict('请打开外部版本为独立副本，或导出当前工程。')
      if (!this.backup) throw new Error('请先保存并校验原文件备份。')
      // Permission prompts require a user gesture before any disk work.
      if (await this.handle.requestPermission({mode:'readwrite'})!=='granted') throw new Error('未获得写入权限，可以导出当前工程。')
      await this.assertCurrent()
      await this.assertBackup()
      const bytes=new Uint8Array(createProjectArchive(project))
      signal?.throwIfAborted()
      const writer=await this.handle.createWritable(handleOptions)
      try {
        await writer.write(bytes)
        await this.assertBackup()
        await this.assertCurrent()
        signal?.throwIfAborted()
        // Browsers stage writes until close. This is a last content check,
        // not an OS-wide compare-and-swap with editors outside this page.
        await writer.close()
      } catch (error) { await writer.abort().catch(()=>{}); throw error }
      try {
        if (!sameBytes(await readRevision(this.handle,this.name),bytes)) throw new Error('文件内容与本次保存不同，另一程序可能正在写入。')
      } catch (error) {
        this.invalidated=true
        throw new ExternalProjectConflict('写入后无法确认结果，原版本备份仍可用：'+errorText(error))
      }
      this.revision=bytes
      this.backup=undefined
      return this.name
    })
  }
  async openExternalCopy() {
    return parseRevision(this.name,await readRevision(this.handle,this.name))
  }
}
