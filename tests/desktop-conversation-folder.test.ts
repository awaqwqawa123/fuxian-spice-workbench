import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopConversationFolder } from '../server/desktop-conversation-folder'

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'fuxian-conversation-folder-')),storage=join(root,'.desktop-control')
  return {root,storage,folder:new DesktopConversationFolder(storage),async close(){await rm(root,{recursive:true,force:true,maxRetries:3})}}
}

test('each installation automatically creates private, stable, writable project workspaces',async()=>{
  const f=await fixture()
  try {
    assert.deepEqual(await f.folder.read(),{directory:null,defaultDirectory:join(f.storage,'workspaces')})
    const paths=await Promise.all(['project-a','project-b','Project-A','CON'].map(id=>f.folder.effectiveDirectory(id)))
    assert.equal(new Set(paths).size,4)
    for(const path of paths){assert.equal((await stat(path)).isDirectory(),true);await writeFile(join(path,'writable.txt'),'ok')}
    assert.ok(paths.every(path=>path.startsWith(join(f.storage,'workspaces','project-'))))
    const restored=new DesktopConversationFolder(f.storage)
    assert.equal(await restored.effectiveDirectory('project-a'),paths[0])
    assert.equal(await restored.effectiveDirectory('project-b'),paths[1],'parallel allocation does not lose project associations')
    for(const id of ['../x','..','/outside','C:\\outside','a/b','a\\b','x\0y',''])await assert.rejects(f.folder.effectiveDirectory(id),/项目编号格式不正确/)
  }finally{await f.close()}
})

test('changing the root applies to new projects and keeps main/explanation project allocations stable',async()=>{
  const f=await fixture()
  try {
    const first=await f.folder.effectiveDirectory('project-a'),custom=join(f.root,'custom')
    await mkdir(custom);await f.folder.update(custom)
    const explanation=new DesktopConversationFolder(f.storage)
    assert.equal(await explanation.effectiveDirectory('project-a'),first)
    const second=await explanation.effectiveDirectory('project-b')
    assert.equal(second,join(await realpath(custom),DesktopConversationFolder.projectFolderName('project-b')))
    await f.folder.update(null)
    assert.equal(await f.folder.effectiveDirectory('project-b'),second)
    assert.equal(await f.folder.effectiveDirectory('project-c'),join(await realpath(join(f.storage,'workspaces')),DesktopConversationFolder.projectFolderName('project-c')))
  }finally{await f.close()}
})

test('preexisting workspace links cannot escape the configured root',async()=>{
  const f=await fixture()
  try {
    const outside=join(f.root,'outside'),root=join(f.storage,'workspaces')
    await mkdir(root,{recursive:true});await mkdir(outside)
    await symlink(outside,join(root,DesktopConversationFolder.projectFolderName('project-a')),process.platform==='win32'?'junction':'dir')
    await assert.rejects(f.folder.effectiveDirectory('project-a'),/专用目录以外/)
  }finally{await f.close()}
})

test('corrupt project allocation records fail visibly without silently regrouping conversations',async()=>{
  const f=await fixture()
  try {
    await mkdir(f.storage,{recursive:true});await writeFile(join(f.storage,'project-workspaces.json'),'{broken')
    await assert.rejects(f.folder.effectiveDirectory('project-a'),/关联无法读取/)
  }finally{await f.close()}
})
