import assert from 'node:assert/strict'
import test from 'node:test'
import { editorTemplate } from '../src/core/editor'
import { createProjectArchive, readProjectFile } from '../src/core/project-file'
import { BoundProjectFile, ExternalProjectConflict, type ProjectFilePickers } from '../src/core/project-writeback'

const start=editorTemplate('rc-lowpass')
start.title='原电路'
const edited={...start,title:'新的仿真工程'}
const changed={...start,title:'外部已更新'}
const bytes=()=>new Uint8Array(createProjectArchive(start))
class FileFixture {
  readonly kind='file' as const
  name:string
  bytes:Uint8Array<ArrayBuffer>
  requests=0
  writers=0
  closes=0
  aborts=0
  permission:'granted'|'denied'|'prompt'='granted'
  readError?:Error
  writeError?:Error
  beforeWrite?:()=>void
  afterClose?:()=>void
  constructor(name:string, data:Uint8Array){
    this.name=name;this.bytes=new Uint8Array(data)
  }
  async getFile(){
    if(this.readError)throw this.readError
    return new File([this.bytes],this.name,{lastModified:1})
  }
  async isSameEntry(other:unknown){return this===other}
  async requestPermission(options:{mode:string}){
    assert.equal(options.mode,'readwrite')
    this.requests++;return this.permission
  }
  async createWritable(options:{mode:string;keepExistingData:boolean}){
    assert.deepEqual(options,{mode:'exclusive',keepExistingData:false})
    this.writers++
    if(this.writeError)throw this.writeError
    let staged:Uint8Array<ArrayBuffer>|undefined
    return {
      write:async(data:Uint8Array)=>{staged=new Uint8Array(data);this.beforeWrite?.()},
      close:async()=>{assert.ok(staged);this.bytes=staged;this.closes++;this.afterClose?.()},
      abort:async()=>{staged=undefined;this.aborts++},
    }
  }
}
const picker=(...handles:FileFixture[]):ProjectFilePickers=>({showOpenFilePicker:async options=>{
  assert.equal(options.multiple,false)
  assert.deepEqual(options.types[0].accept,{'application/zip':['.fuxian']})
  return handles
}})
async function linked() {
  const source=new FileFixture('带 空格的电路.fuxian',bytes())
  const {binding,project}=await BoundProjectFile.choose(picker(source))
  const backup=new FileFixture('写回前备份.fuxian',binding.backupBytes())
  return {source,backup,binding,project}
}

test('writeback is based on the selected archive, verifies an independent backup and preserves the preceding successful revision',async()=>{
  const {source,backup,binding,project}=await linked()
  assert.equal(project.title,start.title)
  assert.equal(source.requests,0)
  assert.equal(source.writers,0)
  await assert.rejects(binding.write(edited),/备份/)
  await assert.rejects(binding.verifyBackup(picker(source)),/独立备份/)
  assert.equal(source.requests,0,'initial selection and backup must never request write access')
  const original=source.bytes.slice()
  assert.equal(await binding.verifyBackup(picker(backup)),backup.name)
  assert.equal(await binding.write(edited),source.name)
  assert.deepEqual(backup.bytes,original)
  assert.equal((await readProjectFile(await source.getFile())).project.title,edited.title)
  assert.equal(source.closes,1)
  assert.equal(binding.backupName,undefined)
  await assert.rejects(binding.verifyBackup(picker(backup)),/内容.*不同/)
  await assert.rejects(binding.write(start),/备份/)
  const newerBackup=new FileFixture('最新备份.fuxian',binding.backupBytes())
  await binding.verifyBackup(picker(newerBackup))
  await binding.write(start)
  assert.equal((await readProjectFile(await newerBackup.getFile())).project.title,edited.title)
})

test('unsupported, ambiguous, empty or corrupt selections cannot establish a baseline or obtain a write permission',async()=>{
  const source=new FileFixture('外部工程.fuxian',bytes()), empty=new FileFixture('空.fuxian',new Uint8Array())
  const corrupt=new FileFixture('损坏.fuxian',new Uint8Array([1,2,3]))
  await assert.rejects(BoundProjectFile.choose({}),/导出/)
  await assert.rejects(BoundProjectFile.choose(picker(source,corrupt)),/一个/)
  await assert.rejects(BoundProjectFile.choose(picker(empty)),/为空/)
  await assert.rejects(BoundProjectFile.choose(picker(corrupt)),/ZIP/)
  const failure=new FileFixture('无法读取.fuxian',bytes())
  failure.readError=new DOMException('locked','NotReadableError')
  await assert.rejects(BoundProjectFile.choose(picker(failure)),/locked/)
  for(const file of [source,empty,corrupt,failure]){
    assert.equal(file.requests,0);assert.equal(file.writers,0)
  }
})

test('an outside write with unchanged metadata cannot replace the revision base and can be opened as a separate version',async()=>{
  const {source,binding,backup}=await linked()
  await binding.verifyBackup(picker(backup))
  const external=new Uint8Array(createProjectArchive(changed))
  source.bytes=external.slice()
  await assert.rejects(binding.write(edited),ExternalProjectConflict)
  assert.deepEqual(source.bytes,external);assert.equal(source.writers,0)
  assert.equal(binding.canWrite,false)
  assert.equal((await binding.openExternalCopy()).project.title,changed.title)
  await assert.rejects(binding.write(edited),ExternalProjectConflict)
})

test('a file mutation between bytes read and use of the bound project is caught before opening a writer',async()=>{
  const source=new FileFixture('打开后即修改.fuxian',bytes())
  const oldget=source.getFile.bind(source)
  let once=true
  source.getFile=async()=>{
    const file=await oldget()
    if(once){once=false;source.bytes=new Uint8Array(createProjectArchive(changed))}
    return file
  }
  const {binding,project}=await BoundProjectFile.choose(picker(source))
  assert.equal(project.title,start.title)
  await binding.verifyBackup(picker(new FileFixture('读到的版本.fuxian',binding.backupBytes())))
  await assert.rejects(binding.write(edited),ExternalProjectConflict)
  assert.equal(source.writers,0)
  assert.equal((await readProjectFile(await source.getFile())).project.title,changed.title)
})

test('denied permission, a locked original, a moved original and a changed backup preserve the file',async()=>{
  const {source,binding,backup}=await linked()
  const original=binding.backupBytes()
  await binding.verifyBackup(picker(backup))
  source.permission='denied'
  await assert.rejects(binding.write(edited),/权限/)
  assert.equal(source.writers,0)
  source.permission='granted'
  source.writeError=new DOMException('locked','NoModificationAllowedError')
  await assert.rejects(binding.write(edited),/locked/)
  assert.equal(source.closes,0)
  source.writeError=undefined
  backup.bytes=new Uint8Array(createProjectArchive(changed))
  await assert.rejects(binding.write(edited),/保留该备份/)
  assert.equal(source.writers,1)
  assert.equal(binding.backupName,undefined)
  backup.bytes=original.slice()
  await binding.verifyBackup(picker(backup))
  source.name='被移动后的工程.fuxian'
  await assert.rejects(binding.write(edited),/文件名已变化/)
  assert.equal(source.writers,1)
  assert.deepEqual(source.bytes,original)
})

test('checks after staging detect a colliding writer before close, and abort if the editor closes',async()=>{
  const {source,binding,backup}=await linked()
  await binding.verifyBackup(picker(backup))
  source.beforeWrite=()=>{source.bytes=new Uint8Array(createProjectArchive(changed))}
  await assert.rejects(binding.write(edited),ExternalProjectConflict)
  assert.equal(source.aborts,1);assert.equal(source.closes,0)
  assert.equal((await readProjectFile(await source.getFile())).project.title,changed.title)
  const other=await linked(), controller=new AbortController()
  await other.binding.verifyBackup(picker(other.backup))
  other.source.beforeWrite=()=>controller.abort()
  await assert.rejects(other.binding.write(edited,controller.signal),{name:'AbortError'})
  assert.equal(other.source.aborts,1);assert.equal(other.source.closes,0)
  assert.deepEqual(other.source.bytes,other.backup.bytes)
})

test('if another writer wins after commit, report uncertain contents and retain the validated backup',async()=>{
  const {source,binding,backup}=await linked()
  await binding.verifyBackup(picker(backup))
  const old=backup.bytes.slice()
  source.afterClose=()=>{source.bytes=new Uint8Array(createProjectArchive(changed))}
  await assert.rejects(binding.write(edited),/写入后无法确认结果/)
  assert.equal(binding.canWrite,false)
  assert.equal(binding.backupName,backup.name)
  assert.deepEqual(backup.bytes,old)
})
