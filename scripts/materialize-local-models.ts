import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import declarationIndex from '../server/model-declaration-index.json'
import extensions from '../server/model-file-extensions.json'
import { WURTH_MODEL_CATALOGS } from '../server/wurth-model-catalog'
import { QUCS_MODEL_CATALOG } from '../server/qucs-model-catalog'
import { adaptQucsSpiceLibrary } from '../server/qucs-model-adapter'
import { fetchGithubModelBundle } from '../server/model-search'
import { parseAcquiredModelLibrary } from '../src/core/agent-models'
import { materializedLibraryRoot, immutableModelUrl, materializedFileId, readMaterializedSourceText, type MaterializedManifest, type MaterializedFileRecord, type MaterializedLibraryIndex } from '../server/local-model-store'

const hash=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex')
const community='kicad-spice-library/KiCad-Spice-Library'
const pattern=new RegExp(`\\.(?:${extensions.join('|')})$`,'i')
/** Materialize all registered files once. Original archives and every artifact
 * remain untouched. A failure is an indexed record with its reason, not a
 * fabricated substitute. No project import limit applies to this global store. */
export async function materializeLocalModels(onProgress:(message:string)=>void=()=>{}){
  const root=materializedLibraryRoot(),manifestBytes=await readFile(join(root,'sources','manifest.json'))
  const manifest=JSON.parse(manifestBytes.toString('utf8')) as MaterializedManifest
  if(manifest.version!==1||!Array.isArray(manifest.sources))throw new Error('本地模型来源清单格式错误')
  await mkdir(join(root,'parsed'),{recursive:true})
  const files:MaterializedFileRecord[]=[],artifacts={files:0,modelFiles:0,olb:0,asy:0}
  const originalNames=new Map(declarationIndex.files as [string,string[]][])
  for(const snapshot of manifest.sources){
    const wurth=WURTH_MODEL_CATALOGS.find(item=>item.repo===snapshot.repo&&item.revision===snapshot.revision)
    const isQucs=snapshot.repo===QUCS_MODEL_CATALOG.repo&&snapshot.revision===QUCS_MODEL_CATALOG.revision
    const isCommunity=snapshot.repo===community&&snapshot.revision===declarationIndex.revision
    if(!wurth&&!isQucs&&!isCommunity)throw new Error(`未登记的本地来源：${snapshot.repo}@${snapshot.revision}`)
    const directory=resolve(root,'sources',snapshot.directory),paths:string[]=[]
    async function walk(dir:string){
      for(const entry of await readdir(dir,{withFileTypes:true})){
        const full=join(dir,entry.name)
        if(entry.isDirectory())await walk(full)
        else if(entry.isFile()){
          artifacts.files++
          if(/\.olb$/i.test(entry.name))artifacts.olb++
          if(/\.asy$/i.test(entry.name))artifacts.asy++
          if(pattern.test(entry.name)){
            artifacts.modelFiles++
            const path=relative(directory,full).replace(/\\/g,'/')
            if(isCommunity&&path.startsWith('Models/')||wurth&&path.startsWith(wurth.rootPath)||isQucs&&path.startsWith('library/'))paths.push(path)
          }
        }
      }
    }
    await walk(directory)
    for(const path of paths.sort()){
      const descriptor=wurth?.files.find(file=>file.path===path),qucs=QUCS_MODEL_CATALOG.files.find(file=>isQucs&&file.path===path)
      const url=immutableModelUrl(snapshot.repo,snapshot.revision,path),id=materializedFileId(url)
      const source=wurth?{label:wurth.label,url,license:wurth.license,attribution:wurth.attribution}:isQucs?{label:QUCS_MODEL_CATALOG.label,url,license:QUCS_MODEL_CATALOG.license,attribution:QUCS_MODEL_CATALOG.attribution}:{label:'KiCad-Spice-Library 社区收集库（非 KiCad 官方）',url,license:'模型各自适用原作者/厂商条款；本地原件保留完整版权与免责声明',attribution:'社区收集库贡献者；原作者/厂商署名见本地保存的原始模型文件'}
      const record:MaterializedFileRecord={id,repo:snapshot.repo,revision:snapshot.revision,path,source,names:descriptor?.names??qucs?.names??originalNames.get(path)??[],models:[],rejected:0}
      try{
        const originalPath=join(directory,...path.split('/')),info=await stat(originalPath)
        if(info.size>4*1024*1024)throw new Error('原件超过 4 MB 当前导入上限，已完整保存原件，未裁剪参数')
        const original=await readFile(originalPath)
        record.originalSha256=hash(original)
        const expected=descriptor?.sha256??qucs?.sha256
        if(expected&&record.originalSha256!==expected)throw new Error('本地原件哈希与固定来源目录不符')
        let text:string,dependencies:string[]
        if(isQucs){
          if(!qucs)throw new Error('Qucs 原生器件库原件已保存；该文件尚未登记完整 SPICE 网络适配，不能把 Qucs 方程或原生模型伪装为 ngspice 模型')
          const adapted=adaptQucsSpiceLibrary((await readMaterializedSourceText(url))!,path)
          text=adapted.text;dependencies=[path]
          record.source={...source,attribution:`${source.attribution}。本地适配：${adapted.adaptations.join('；')}；保留完整网络及原参数。`.slice(0,1000)}
        }else{
          const bundle=await fetchGithubModelBundle(url,async(target,limit)=>{
            const local=await readMaterializedSourceText(target,limit)
            if(local===undefined)throw new Error('同版本模型依赖尚未保存到本地；不会转为在线读取')
            return local
          })
          text=bundle.text;dependencies=bundle.paths
        }
        const preview=parseAcquiredModelLibrary(text,record.source)
        record.models=preview.models.map(model=>({name:model.id,kind:model.kind,type:model.type,pins:model.pins??[]}))
        const errors=preview.diagnostics.filter(item=>item.severity==='error')
        record.rejected=errors.length
        if(errors.length)record.reason=[...new Set(errors.map(item=>item.message))].slice(0,8).join('；')
        if(!record.models.length&&!record.reason)record.reason='原件已保存；文件没有独立可放置的兼容模型定义'
        // Write one electrical bundle per file, rather than duplicating every
        // shared helper definition into a gigantic catalogue JSON response.
        record.textSha256=hash(text);record.dependencies=dependencies
        await writeFile(join(root,'parsed',`${id}.lib`),text,'utf8')
      }catch(error){record.reason=(error as Error).message;record.rejected=Math.max(1,record.names.length)}
      files.push(record)
      if(files.length%100===0)onProgress(`已整理 ${files.length} 个模型文件；兼容 ${files.reduce((n,file)=>n+file.models.length,0)} 个定义`)
    }
  }
  const index:MaterializedLibraryIndex={version:1,manifestSha256:hash(manifestBytes),builtAt:new Date().toISOString(),files,artifacts}
  const pending=join(root,'catalog.next.json')
  await writeFile(pending,JSON.stringify(index),'utf8');await rename(pending,join(root,'catalog.json'))
  return {files:files.length,models:files.reduce((n,file)=>n+file.models.length,0),unsupported:files.reduce((n,file)=>n+file.rejected,0),unsupportedFiles:files.filter(file=>!file.models.length).length,artifacts}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  materializeLocalModels(message=>process.stdout.write(`${message}\n`)).then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{process.stderr.write(`${(error as Error).stack}\n`);process.exitCode=1})
}
