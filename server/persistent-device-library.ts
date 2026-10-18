import { createHash, randomUUID } from 'node:crypto'
import { copyFile, link, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { LocalModelCatalog } from '../src/core/model-catalog'
import type { ImportedSpiceModel } from '../src/core/spice-models'
import { parseImportedModels, parseSpiceLibrary } from '../src/core/spice-models'
import { selectPreferredCatalogModels, preferredModelLibrary } from '../src/core/model-source-policy'
import { browseDeviceLibraryIndex, indexDeviceLibraryModel, summarizeDeviceLibraryModel, type DeviceLibraryBrowsePage, type DeviceLibraryBrowseRequest, type DeviceLibraryBuildStatus, type DeviceLibraryIndexEntry, type DeviceLibraryModelSummary } from '../src/core/device-library-catalog'
import { ownedModelLibraryRoot } from './owned-model-library'
import { modelCategories, modelCategory, modelCategoryGroups } from '../src/core/model-taxonomy'
import { libraryEngineReviews } from './model-library-engine-review'

// Bump schema when compilation, model classification or symbol evidence changes.
// This invalidates compiled display data without modifying original library files.
const SCHEMA=4, CHUNK_SIZE=128
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const keyPattern=/^[a-f0-9]{64}$/
const generationPattern=/^[0-9]{13}-[a-f0-9-]{36}$/
const modelKey=(model:ImportedSpiceModel)=>sha(JSON.stringify(model))
export interface PersistentDeviceLibraryOptions {cacheRoot?:string;scope?:string;stampPaths?:string[];reviewRoot?:string;seedRoot?:string}
interface IndexFile {schema:number;scope:string;entries:DeviceLibraryIndexEntry[]}
interface Manifest {schema:number;scope:string;generation:string;builtAt:string;total:number;versions:number;sourceStamp:string;indexHash:string;chunks:{summaries:string;models:string}[]}
interface ActiveLibrary {storageRoot:string;manifest:Manifest;index:IndexFile;byKey:Map<string,DeviceLibraryIndexEntry>}
export interface DeviceLibraryBuildResult {schema:number;generation:string;builtAt:string;total:number;versions:number;chunks:number}
export type PersistentDeviceBrowseResult={status:200;data:DeviceLibraryBrowsePage}|{status:202|503;data:DeviceLibraryBuildStatus}

function defaultStampPaths():string[] {
  const root=ownedModelLibraryRoot(), app=process.env.LOCALAPPDATA||join(homedir(),'AppData','Local')
  const ltRoots=[join(app,'LTspice','lib'),join(homedir(),'Documents','LTspiceXVII','lib')]
  return [join(root,'vendor','ltspice','paths_manifest.json'),join(root,'vendor','tina','paths_manifest.json'),join(root,'vendor','pspice','paths_manifest.json'),...ltRoots.flatMap(lib=>['standard.dio','standard.bjt','standard.mos','standard.jft'].map(file=>join(lib,'cmp',file)).concat([join(lib,'sub','Contrib','CHEMI-CON'),join(lib,'sub','Contrib','Wurth')]))]
}
async function sourceStamp(paths:readonly string[]):Promise<string> {
  // These registered manifest/directory stamps are O(libraries), never a recursive
  // scan. Explicit refresh handles original-file changes not reflected in a stamp.
  const records=await Promise.all(paths.map(async path=>{try{const info=await stat(path);return [path,info.size,info.mtimeMs]}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return [path,'missing']}}))
  return sha(JSON.stringify(records))
}
function boundedCache<T>(cache:Map<number,T>,key:number,value:T,limit:number):T {
  cache.delete(key);cache.set(key,value)
  while(cache.size>limit)cache.delete(cache.keys().next().value!)
  return value
}
function validateStoredModel(stored:ImportedSpiceModel,legacy:boolean):ImportedSpiceModel {
  let definition=stored
  if(legacy){
    // Parser upgrades can canonicalize old BJT aliases and subcircuit closures.
    // Keep source/catalog/symbol evidence, and require the same real terminals.
    const preview=parseSpiceLibrary(stored.spice,stored.source)
    const canonical=preview.models.find(model=>model.id===stored.id)
    if(!canonical||preview.diagnostics.some(item=>item.severity==='error'))throw new Error(`保存的模型 ${stored.id} 无法通过完整验证`)
    if(JSON.stringify(canonical.pins)!==JSON.stringify(stored.pins))throw new Error('保存的模型引脚顺序与源码不一致')
    definition={...stored,spice:canonical.spice}
  }
  const validated=parseImportedModels([definition])[0]
  if(JSON.stringify(validated.pins)!==JSON.stringify(stored.pins))throw new Error('保存的模型引脚顺序与源码不一致')
  return {...stored,...validated,name:stored.name,detail:stored.detail}
}

/** A persistent compiled library, not a cache of an installation scan. Opening
 * the browser reads one compact index plus only the visible summary chunks.
 * Original files, dependencies and symbols are parsed once during explicit build. */
export class PersistentDeviceLibraryStore {
  private referenceCatalog:{generation:string;promise:Promise<LocalModelCatalog>}|undefined
  private readonly root:string
  private readonly scope:string
  private readonly stamps:string[]
  private readonly reviewRoot:string
  private readonly seedRoot:string|undefined
  private seed:ActiveLibrary|undefined
  private requiresRebuild=false
  private active:ActiveLibrary|undefined
  private initializing:Promise<void>|undefined
  private initialized=false
  private building:Promise<DeviceLibraryBuildResult>|undefined
  private failure=''
  private attempted=false
  private progress:{processed:number;total:number}|undefined
  private stale=false
  private checkedAt=0
  private readonly summaries=new Map<number,DeviceLibraryModelSummary[]>()
  private readonly fullModels=new Map<number,ImportedSpiceModel[]>()

  constructor(options:PersistentDeviceLibraryOptions={}) {
    this.root=resolve(options.cacheRoot??join(ownedModelLibraryRoot(),'.cache','device-library-v1'))
    this.scope=sha(options.scope??ownedModelLibraryRoot())
    this.stamps=options.stampPaths??defaultStampPaths()
    this.reviewRoot=resolve(options.reviewRoot??ownedModelLibraryRoot())
    // Paths are server deployment options; HTTP callers supply only content keys.
    this.seedRoot=options.seedRoot?resolve(options.seedRoot):(options.cacheRoot||options.scope?undefined:join(ownedModelLibraryRoot(),'catalog'))
    if(this.seedRoot){
      const cacheRelative=relative(this.seedRoot,this.root)
      if(cacheRelative===''||(cacheRelative!=='..'&&!cacheRelative.startsWith('..'+sep)&&!isAbsolute(cacheRelative)))throw new Error('运行缓存不能写入随附器件目录')
    }
  }
  private path(generation:string,file:string):string {return join(this.root,generation,file)}
  private activePath(active:ActiveLibrary,file:string):string {return join(active.storageRoot,active.manifest.generation,file)}
  /** Upgrade the previously compiled library, preserving immutable electrical
   * definitions and symbol keys. Never rescan original vendor installations. */
  private async upgradeCategories(active:ActiveLibrary):Promise<ActiveLibrary> {
    const {manifest,index}=active
    const generation=`${Date.now()}-${randomUUID()}`,temporary=this.path(generation+'.pending','')
    await mkdir(temporary,{recursive:true})
    const categories=new Map<string,string>()
    for(let chunk=0;chunk<manifest.chunks.length;chunk++){
      const expected=index.entries.filter(entry=>entry.chunk===chunk)
      const raw=await readFile(this.activePath(active,`${chunk}.summaries.json`))
      if(sha(raw)!==manifest.chunks[chunk].summaries)throw new Error('原器件摘要校验失败，旧目录已保留')
      const summaries=JSON.parse(raw.toString('utf8')) as DeviceLibraryModelSummary[]
      if(!Array.isArray(summaries)||summaries.length!==expected.length||summaries.length>CHUNK_SIZE)throw new Error('原器件摘要不完整，旧目录已保留')
      const byKey=new Map(summaries.map(summary=>[summary.key,summary]))
      if(byKey.size!==expected.length)throw new Error('原器件摘要键重复，旧目录已保留')
      let models:ImportedSpiceModel[]|undefined
      for(const entry of expected){
        const summary=byKey.get(entry.key)
        if(!summary||summary.id!==entry.id||preferredModelLibrary(summary.source)!==entry.source)throw new Error('原器件摘要与索引不一致，旧目录已保留')
        const matching=modelCategories.filter(leaf=>leaf.label===summary.categoryLabel&&leaf.group===entry.category)
        let category:string
        if(matching.length===1)category=matching[0].id
        else{
          // Old display labels may become ambiguous in a later vocabulary. In
          // that case use only the already compiled, checksum-verified model.
          if(!models){
            const modelRaw=await readFile(this.activePath(active,`${chunk}.models.json`))
            if(sha(modelRaw)!==manifest.chunks[chunk].models)throw new Error('原模型校验失败，旧目录已保留')
            models=JSON.parse(modelRaw.toString('utf8')) as ImportedSpiceModel[]
            if(!Array.isArray(models)||models.length!==expected.length)throw new Error('原模型分块不完整，旧目录已保留')
          }
          const model=models.find(item=>modelKey(item)===entry.key)
          if(!model||model.id!==entry.id||preferredModelLibrary(model.source)!==entry.source)throw new Error('原模型与索引不一致，旧目录已保留')
          category=modelCategory(model)
          if(category.split(':')[0]!==entry.category)throw new Error('原器件分类不一致，旧目录已保留')
        }
        categories.set(entry.key,category)
      }
      // Hard links preserve verified immutable chunks without duplicating a
      // large local library. Copying is the fallback on filesystems without them.
      for(const suffix of ['summaries','models']){
        const from=this.activePath(active,`${chunk}.${suffix}.json`),to=join(temporary,`${chunk}.${suffix}.json`)
        try{await link(from,to)}catch{await copyFile(from,to)}
      }
    }
    const upgradedIndex:IndexFile={...index,schema:SCHEMA,entries:index.entries.map(entry=>({...entry,category:categories.get(entry.key)!}))}
    const indexJson=JSON.stringify(upgradedIndex)
    await writeFile(join(temporary,'index.json'),indexJson,'utf8')
    const upgradedManifest:Manifest={...manifest,schema:SCHEMA,generation,indexHash:sha(indexJson)}
    await rename(temporary,this.path(generation,''))
    const pendingManifest=join(this.root,`manifest-${randomUUID()}.pending`)
    await writeFile(pendingManifest,JSON.stringify(upgradedManifest),'utf8')
    await rename(pendingManifest,join(this.root,'manifest.json'))
    return {storageRoot:this.root,manifest:upgradedManifest,index:upgradedIndex,byKey:new Map(upgradedIndex.entries.map(entry=>[entry.key,entry]))}
  }
  private async readActiveLibrary(storageRoot:string):Promise<ActiveLibrary> {
    const seed=storageRoot===this.seedRoot
    const manifest=JSON.parse(await readFile(join(storageRoot,'manifest.json'),'utf8')) as Manifest
    // A shipped index is signed by its original scope, independently of this
    // clone's path. Runtime generations must still match the current scope.
    if(!(seed?[3,SCHEMA]:[1,2,3,SCHEMA]).includes(manifest.schema)||!keyPattern.test(manifest.scope)||(!seed&&manifest.scope!==this.scope)||!generationPattern.test(manifest.generation)||!Array.isArray(manifest.chunks)||!keyPattern.test(manifest.indexHash))throw new Error('本地器件索引版本或来源已变化，需要重新整理')
    const raw=await readFile(join(storageRoot,manifest.generation,'index.json'))
    if(sha(raw)!==manifest.indexHash)throw new Error('本地器件索引校验失败，需要重新整理')
    const index=JSON.parse(raw.toString('utf8')) as IndexFile
    if(index.schema!==manifest.schema||index.scope!==manifest.scope||!Array.isArray(index.entries)||index.entries.length!==manifest.versions)throw new Error('本地器件索引不完整')
    const byKey=new Map<string,DeviceLibraryIndexEntry>()
    for(const entry of index.entries){
      if(!keyPattern.test(entry.key)||typeof entry.id!=='string'||typeof entry.text!=='string'||!(manifest.schema===1?modelCategoryGroups.some(group=>group.id===entry.category):modelCategories.some(leaf=>leaf.id===entry.category))||!['tina','pspice','ltspice'].includes(entry.source)||!Number.isSafeInteger(entry.chunk)||entry.chunk<0||entry.chunk>=manifest.chunks.length||byKey.has(entry.key))throw new Error('本地器件索引条目无效')
      byKey.set(entry.key,entry)
    }
    for(const chunk of manifest.chunks)if(!keyPattern.test(chunk.models)||!keyPattern.test(chunk.summaries))throw new Error('本地器件分块校验信息无效')
    return {storageRoot,manifest,index,byKey}
  }
  private async initialize():Promise<void> {
    if(this.initialized)return
    if(this.initializing)return this.initializing
    this.initializing=(async()=>{
      try{
        for(const storageRoot of [this.root,...(this.seedRoot?[this.seedRoot]:[])]){
          try{
            const active=await this.readActiveLibrary(storageRoot),seed=storageRoot===this.seedRoot
            if(seed)this.seed=active
            if(this.active)continue // Keep seed lookup separate from the current runtime index.
            this.active=active
            this.requiresRebuild=!seed&&active.manifest.schema!==SCHEMA
            this.stale=this.requiresRebuild||(!seed&&await sourceStamp(this.stamps)!==active.manifest.sourceStamp)
            this.failure=''
            if(active.manifest.schema===1){
              try{this.active=await this.upgradeCategories(active)}
              catch(error){this.failure=(error as Error).message;this.stale=true}
            }
            this.checkedAt=Date.now()
          }catch(error){
            // Invalid data is never authoritative. A valid shipped snapshot can
            // replace an absent/incompatible runtime without any source scan.
            if(!this.active&&(error as NodeJS.ErrnoException).code!=='ENOENT')this.failure=(error as Error).message
          }
        }
      }finally{this.initialized=true;this.initializing=undefined}
    })()
    return this.initializing
  }
  private checkStamp():void {
    if(!this.active||this.active.storageRoot===this.seedRoot||Date.now()-this.checkedAt<60_000)return
    this.checkedAt=Date.now()
    const generation=this.active.manifest.generation
    void sourceStamp(this.stamps).then(stamp=>{if(this.active?.manifest.generation===generation)this.stale=this.requiresRebuild||stamp!==this.active.manifest.sourceStamp}).catch(()=>{if(this.active?.manifest.generation===generation)this.stale=true})
  }
  private async compiledModels(active:ActiveLibrary):Promise<ImportedSpiceModel[]> {
    const result:ImportedSpiceModel[]=[]
    for(let chunk=0;chunk<active.manifest.chunks.length;chunk++){
      const raw=await readFile(this.activePath(active,`${chunk}.models.json`))
      if(sha(raw)!==active.manifest.chunks[chunk].models)throw new Error('原模型校验失败，旧目录已保留')
      const models=JSON.parse(raw.toString('utf8')) as ImportedSpiceModel[]
      const expected=active.index.entries.filter(entry=>entry.chunk===chunk)
      if(!Array.isArray(models)||models.length!==expected.length||models.length>CHUNK_SIZE)throw new Error('原模型分块不完整，旧目录已保留')
      const seen=new Set<string>()
      for(const model of models){
        const key=modelKey(model),entry=active.byKey.get(key)
        if(!entry||entry.chunk!==chunk||entry.id!==model.id||entry.source!==preferredModelLibrary(model.source)||seen.has(key))throw new Error('原模型与索引不一致，旧目录已保留')
        seen.add(key);result.push(active.manifest.schema===3?validateStoredModel(model,true):model)
      }
    }
    return result
  }
  private async mergeCompiledModels(fresh:readonly ImportedSpiceModel[]):Promise<ImportedSpiceModel[]> {
    if(!this.active)return selectPreferredCatalogModels(fresh)
    // Never infer sameness from category, public part number or library alone.
    // An exact model ID and registered original source identify an update.
    const identity=(model:ImportedSpiceModel)=>JSON.stringify([model.id.toLowerCase(),preferredModelLibrary(model.source),model.source.label,model.source.url??''])
    const grouped=(models:readonly ImportedSpiceModel[])=>{
      const groups=new Map<string,Map<string,ImportedSpiceModel>>()
      for(const model of models){
        if(!preferredModelLibrary(model.source))continue
        const id=identity(model),group=groups.get(id)??new Map<string,ImportedSpiceModel>()
        group.set(modelKey(model),model);groups.set(id,group)
      }
      return groups
    }
    const retained=grouped(this.seed?await this.compiledModels(this.seed):[])
    if(this.active!==this.seed){
      for(const [id,group] of grouped(await this.compiledModels(this.active)))retained.set(id,group)
    }
    const incoming=grouped(fresh),selected=new Set(selectPreferredCatalogModels(fresh).map(identity))
    for(const [id,group] of incoming){
      // Apply explicit updates to every known source version, even when the
      // default selector prefers another file for the same public part.
      if(!retained.has(id)&&!selected.has(id))continue
      const model=group.values().next().value!
      if(group.size!==1)throw new Error(`模型 ${model.id} 的来源 ${model.source.label} 含有多个不同定义，旧目录已保留；请明确来源后重新整理`)
      const previous=retained.get(id)
      if(previous&&previous.size>1&&!previous.has(modelKey(model)))throw new Error(`模型 ${model.id} 的现有来源 ${model.source.label} 不唯一，旧目录已保留；请明确版本后重新整理`)
      retained.set(id,group)
    }
    return [...retained.values()].flatMap(group=>[...group.values()])
  }
  async rebuild(loadCatalog:()=>Promise<LocalModelCatalog>):Promise<DeviceLibraryBuildResult> {
    await this.initialize()
    if(this.building)return this.building
    this.attempted=true;this.failure='';this.progress={processed:0,total:0}
    this.building=(async()=>{
      // Let the first /browse response display real progress before scanning starts.
      await new Promise<void>(done=>setImmediate(done))
      const stampBefore=await sourceStamp(this.stamps)
      const catalog=await loadCatalog()
      const models=await this.mergeCompiledModels(catalog.models)
      this.progress={processed:0,total:models.length}
      const generation=`${Date.now()}-${randomUUID()}`, temporary=this.path(generation+'.pending',''), final=this.path(generation,'')
      await mkdir(temporary,{recursive:true})
      const entries:DeviceLibraryIndexEntry[]=[],chunks:Manifest['chunks']=[]
      for(let offset=0;offset<models.length;offset+=CHUNK_SIZE){
        const slice=models.slice(offset,offset+CHUNK_SIZE),chunk=chunks.length
        const summaries=slice.map(model=>{
          const key=modelKey(model);entries.push(indexDeviceLibraryModel(model,key,chunk))
          return summarizeDeviceLibraryModel(model,key)
        })
        const summaryJson=JSON.stringify(summaries),modelJson=JSON.stringify(slice)
        await writeFile(join(temporary,`${chunk}.summaries.json`),summaryJson,'utf8')
        await writeFile(join(temporary,`${chunk}.models.json`),modelJson,'utf8')
        chunks.push({summaries:sha(summaryJson),models:sha(modelJson)})
        this.progress={processed:Math.min(offset+CHUNK_SIZE,models.length),total:models.length}
      }
      const stampAfter=await sourceStamp(this.stamps)
      if(stampBefore!==stampAfter)throw new Error('整理期间原始库发生变化，旧目录已保留，请重新整理')
      const index:IndexFile={schema:SCHEMA,scope:this.scope,entries},indexJson=JSON.stringify(index)
      await writeFile(join(temporary,'index.json'),indexJson,'utf8')
      const manifest:Manifest={schema:SCHEMA,scope:this.scope,generation,builtAt:new Date().toISOString(),total:new Set(entries.map(entry=>(entry.publicId??entry.id).toLowerCase())).size,versions:entries.length,sourceStamp:stampAfter,indexHash:sha(indexJson),chunks}
      // A completed generation is immutable. Activation is a single atomic rename;
      // any failed build leaves the previous good generation and manifest intact.
      await rename(temporary,final)
      const pendingManifest=join(this.root,`manifest-${randomUUID()}.pending`)
      await writeFile(pendingManifest,JSON.stringify(manifest),'utf8')
      await rename(pendingManifest,join(this.root,'manifest.json'))
      this.active={storageRoot:this.root,manifest,index,byKey:new Map(entries.map(entry=>[entry.key,entry]))}
      this.summaries.clear();this.fullModels.clear();this.stale=false;this.requiresRebuild=false;this.checkedAt=Date.now()
      return {schema:SCHEMA,generation,builtAt:manifest.builtAt,total:manifest.total,versions:manifest.versions,chunks:chunks.length}
    })().catch(error=>{this.failure=error instanceof Error?error.message:String(error);if(this.active)this.stale=true;throw error}).finally(()=>{this.building=undefined;this.progress=undefined})
    return this.building
  }
  async browse(request:DeviceLibraryBrowseRequest,loadCatalog:()=>Promise<LocalModelCatalog>,refresh=false):Promise<PersistentDeviceBrowseResult> {
    await this.initialize();this.checkStamp()
    if(refresh||!this.active&&!this.attempted)void this.rebuild(loadCatalog).catch(()=>{/* returned by status, old generation remains available */})
    if(!this.active){
      if(this.attempted&&!this.building&&this.failure)return {status:503,data:{state:'failed',message:'本地器件目录整理失败，原件仍保留，可重新整理',error:this.failure}}
      return {status:202,data:{state:'building',message:this.progress?.total?'正在整理本地器件目录与符号':'首次整理本地器件索引，完成后将直接读取现成目录',...(this.progress?{progress:this.progress}:{})}}
    }
    const active=this.active,{page,groups}=browseDeviceLibraryIndex(active.index.entries,request)
    // Keep the captured generation across awaited IO, even if a build activates a
    // newer generation in parallel. Model selections carry immutable content keys.
    const needed=[...new Set(groups.flatMap(group=>group.entries.map(entry=>entry.chunk)))]
    const loaded=await Promise.all(needed.map(async chunk=>{
      const cached=this.active===active?this.summaries.get(chunk):undefined
      if(cached)return boundedCache(this.summaries,chunk,cached,8)
      const raw=await readFile(this.activePath(active,`${chunk}.summaries.json`))
      if(sha(raw)!==active.manifest.chunks[chunk].summaries)throw new Error('本地器件摘要校验失败，请重新整理目录')
      const summaries=JSON.parse(raw.toString('utf8')) as DeviceLibraryModelSummary[]
      if(!Array.isArray(summaries)||summaries.length>CHUNK_SIZE)throw new Error('本地器件摘要格式无效')
      if(this.active===active)boundedCache(this.summaries,chunk,summaries,8)
      return summaries
    }))
    const byKey=new Map(loaded.flat().map(summary=>[summary.key,summary]))
    const reviews=await libraryEngineReviews(this.reviewRoot,active.manifest.generation)
    for(const [key,summary] of byKey){const review=reviews.get(key);if(review&&summary.profile)byKey.set(key,{...summary,profile:{...summary.profile,electrical:{...summary.profile.electrical,engineReview:review}}})}
    return {status:200,data:{...page,state:'ready',generation:active.manifest.generation,builtAt:active.manifest.builtAt,updating:!!this.building,stale:this.stale,groups:groups.map(group=>({id:group.id,models:group.entries.map(entry=>{const summary=byKey.get(entry.key);if(!summary)throw new Error('本地器件摘要缺失，请重新整理目录');return summary}).sort((a,b)=>Number(a.profile?.electrical.engineReview?.status==='compatibility-error')-Number(b.profile?.electrical.engineReview?.status==='compatibility-error'))}))}}
  }
  async readModel(key:string):Promise<ImportedSpiceModel> {
    if(typeof key!=='string'||!keyPattern.test(key))throw new Error('器件键无效，请重新选择器件')
    await this.initialize()
    // Previously saved sourceKeys may name an older immutable seed definition.
    // This lookup must not replace or relabel the current runtime selection.
    const active=this.active?.byKey.has(key)?this.active:this.seed,entry=active?.byKey.get(key)
    if(!active||!entry)throw new Error('器件不在当前本地目录中，请重新读取目录并选择')
    const review=(await libraryEngineReviews(this.reviewRoot,active.manifest.generation)).get(key)
    if(review?.status==='compatibility-error')throw new Error(`模型 ${entry.id} 的实际引擎兼容检查未通过，暂不放置：${review.reason}。原件保留，可选择其他来源版本。`)
    let models=this.active===active?this.fullModels.get(entry.chunk):undefined
    if(models)boundedCache(this.fullModels,entry.chunk,models,2)
    if(!models){
      const raw=await readFile(this.activePath(active,`${entry.chunk}.models.json`))
      if(sha(raw)!==active.manifest.chunks[entry.chunk].models)throw new Error('本地模型校验失败，请重新整理目录')
      models=JSON.parse(raw.toString('utf8')) as ImportedSpiceModel[]
      if(!Array.isArray(models)||models.length>CHUNK_SIZE)throw new Error('本地模型分块格式无效')
      if(this.active===active)boundedCache(this.fullModels,entry.chunk,models,2)
    }
    const stored=models.find(model=>modelKey(model)===key)
    if(!stored||stored.id!==entry.id||preferredModelLibrary(stored.source)!==entry.source)throw new Error('本地模型与目录条目不一致，请重新整理目录')
    return validateStoredModel(stored,active.manifest.schema===3)
  }
  async referenceModels():Promise<LocalModelCatalog|undefined>{
    await this.initialize()
    const active=this.active
    if(!active)return undefined
    if(this.referenceCatalog?.generation===active.manifest.generation)return this.referenceCatalog.promise
    const promise=this.compiledModels(active).then(async models=>{
      const freeze=(value:unknown):void=>{if(!value||typeof value!=='object'||Object.isFrozen(value))return;for(const child of Object.values(value))freeze(child);Object.freeze(value)}
      for(let index=0;index<models.length;index++){freeze(models[index]);if(index%128===0)await new Promise<void>(done=>setImmediate(done))}
      const catalog={models,files:[]};freeze(catalog);return catalog
    })
    this.referenceCatalog={generation:active.manifest.generation,promise}
    void promise.catch(()=>{if(this.referenceCatalog?.promise===promise)this.referenceCatalog=undefined})
    return promise
  }
}

const stores=new Map<string,PersistentDeviceLibraryStore>()
function storeFor(options:PersistentDeviceLibraryOptions={}):PersistentDeviceLibraryStore {
  const key=JSON.stringify([resolve(options.cacheRoot??join(ownedModelLibraryRoot(),'.cache','device-library-v1')),options.scope??ownedModelLibraryRoot(),options.stampPaths??defaultStampPaths(),options.reviewRoot??ownedModelLibraryRoot(),options.seedRoot])
  let store=stores.get(key);if(!store){store=new PersistentDeviceLibraryStore(options);stores.set(key,store)}return store
}
export function rebuildPersistentDeviceLibrary(loadCatalog:()=>Promise<LocalModelCatalog>,options:PersistentDeviceLibraryOptions={}):Promise<DeviceLibraryBuildResult> {return storeFor(options).rebuild(loadCatalog)}
export function browsePersistentDeviceLibrary(request:DeviceLibraryBrowseRequest,loadCatalog:()=>Promise<LocalModelCatalog>,options:PersistentDeviceLibraryOptions={},refresh=false):Promise<PersistentDeviceBrowseResult> {return storeFor(options).browse(request,loadCatalog,refresh)}
export function readPersistentDeviceLibraryModel(key:string,options:PersistentDeviceLibraryOptions={}):Promise<ImportedSpiceModel> {return storeFor(options).readModel(key)}
export function readPersistentDeviceLibraryCatalog(options:PersistentDeviceLibraryOptions={}):Promise<LocalModelCatalog|undefined>{return storeFor(options).referenceModels()}
