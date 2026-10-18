import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeSpiceLibrary, parseImportedModels, type ImportedSpiceModel } from '../src/core/spice-models'
import { preferredModelLibrary, ltspiceSourceUrl } from '../src/core/model-source-policy'
import { isOwnedPspiceSource } from '../src/core/installed-model-source'
import { classifyModelFunctionalSymbol } from '../src/core/model-functional-symbol'
import { presentedModelSymbol } from '../src/core/model-symbol-presentation'
import { parseModelSymbol, type ModelSymbol } from '../src/core/model-symbol'
import { readOwnedPspiceSymbolForModel } from './owned-pspice-symbols'
import { createInstalledModelSymbolResolver } from './installed-model-symbol'
import { localSubcircuitRoots } from './model-library'
import { symbolPathWithin } from './original-symbol-link'

export type SymbolAuditStatus = 'original-verified'|'standard-verified'|'connection-only'|'original-unverified'|'error'
export interface SymbolAuditRow { key:string; id:string; library:string; source:string; kind:string; family:string; ports:string; symbol:string; status:SymbolAuditStatus; reason:string }
export type OriginalSymbolResolver = (model:ImportedSpiceModel)=>Promise<ModelSymbol|undefined>
const geometryIdentity=(symbol:ModelSymbol)=>JSON.stringify({shape:symbol.shape,pins:symbol.pins,physicalPins:symbol.physicalPins,geometry:symbol.geometry,annotations:symbol.annotations})

/** Resolve only recorded installed provenance inside server-selected roots.
 * Reuse the same explicit file/model/SpiceOrder association used by import. */
export function createInstalledAuditResolver(roots=localSubcircuitRoots()):OriginalSymbolResolver {
  const resolvers=new Map<string,ReturnType<typeof createInstalledModelSymbolResolver>>()
  const texts=new Map<string,Promise<string>>()
  return async model=>{
    const prefix='本机 LTspice / '
    if(model.source.url!==ltspiceSourceUrl||!model.source.label.startsWith(prefix))return undefined
    const path=model.source.label.slice(prefix.length)
    if(!/^Contrib\/(?:Wurth|CHEMI-CON)\//i.test(path)||/[\\:\x00-\x1f]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))return undefined
    for(const root of roots){
      let actual:string,canonical:string
      try{[actual,canonical]=await Promise.all([realpath(join(root,path)),realpath(root)])}
      catch{continue}
      if(!symbolPathWithin(canonical,actual))continue
      let sourceText=texts.get(actual)
      if(!sourceText){sourceText=(async()=>{if((await stat(actual)).size>4*1024*1024)throw new Error('原始模型超过核对大小上限');return decodeSpiceLibrary(await readFile(actual))})();texts.set(actual,sourceText)}
      let resolver=resolvers.get(canonical)
      if(!resolver){resolver=createInstalledModelSymbolResolver(canonical);resolvers.set(canonical,resolver)}
      const result=await (await resolver)(actual,model.id,model.pins,await sourceText)
      if(result.symbol)return result.symbol
    }
    return undefined
  }
}

/** Read-only audit: port order, original geometry and functional evidence are
 * different checks. An unresolved connection diagram never counts as verified. */
export async function auditModelSymbol(model:ImportedSpiceModel,key:string,original?:OriginalSymbolResolver):Promise<SymbolAuditRow> {
  const row:SymbolAuditRow={key,id:model.id,library:preferredModelLibrary(model.source)??'other',source:model.source.label,kind:model.kind,family:'',ports:model.pins.join(' | '),symbol:'none',status:'error',reason:''}
  try {
    const restored=parseImportedModels([model])[0]
    if(restored.pins.length!==model.pins.length||restored.pins.some((pin,index)=>pin!==model.pins[index]))throw new Error('保存恢复改变了原始电气端口顺序')
    const symbol=presentedModelSymbol(model),classification=classifyModelFunctionalSymbol(model)
    const restoredSymbol=presentedModelSymbol(restored)
    const savedIdentity=symbol&&parseModelSymbol(symbol,model.kind,model.pins)
    const restoredIdentity=restoredSymbol&&parseModelSymbol(restoredSymbol,restored.kind,restored.pins)
    if(JSON.stringify(savedIdentity)!==JSON.stringify(restoredIdentity))throw new Error('保存恢复改变了当前显示符号、原件来源或引脚锚点')
    row.family=classification.family??''
    row.symbol=symbol?`${symbol.origin??'unspecified'} / ${symbol.shape}`:'connection diagram'
    if(symbol){
      parseModelSymbol(symbol,model.kind,model.pins)
      if(symbol.shape==='ltspice'){
        if(new Set(symbol.pins.map(pin=>`${pin.x},${pin.y}`)).size!==symbol.pins.length)throw new Error('多个电气引脚在同一符号坐标重叠')
        if(!symbol.geometry?.length)throw new Error('图形符号缺少实际几何图元')
      }
    }
    if(symbol?.origin==='imported'){
      if(!original){row.status='original-unverified';row.reason='已验证结构与端口索引，本次未提供该来源的原始图形核对器';return row}
      const expected=await original(model)
      if(!expected)throw new Error('已标为原始符号，但当前原件不能证明确切型号与电气端口配对')
      if(!symbol||geometryIdentity(symbol)!==geometryIdentity(expected))throw new Error('当前显示符号与确切模型的原始图形、端口坐标或标记不一致')
      if(expected.source&&(symbol.source?.label!==expected.source.label||symbol.source?.sha256!==expected.source.sha256))throw new Error('已保存的原符号来源或 SHA-256 与当前原件不一致')
      row.status='original-verified';row.reason='原件 SHA-256、明确模板、确切模型及有序端口与显示图形一致';return row
    }
    if(model.kind==='X'&&original&&await original(model))throw new Error('原库已有可明确配对的符号，当前编译模型却使用标准符号或连接示意；需重新整理导入数据')
    if(model.kind!=='X'||symbol?.shape==='ltspice'&&symbol.origin==='standard'&&classification.mapping==='verified'){
      row.status='standard-verified';row.reason=model.kind==='X'?'器件用途与端口含义有证据，显示明确标为标准功能符号':'原生器件类型规定电气端口顺序，采用标准符号';return row
    }
    row.status='connection-only';row.reason=classification.reason;return row
  }catch(error){row.reason=(error as Error).message;return row}
}

const hash=(text:Uint8Array|string)=>createHash('sha256').update(text).digest('hex')
/** Audit the exact compiled generation users browse; never starts a source
 * scan, rebuilds the library, or changes any saved circuit or model. */
export async function auditCompiledLibrarySymbols(libraryRoot:string) {
  const root=join(libraryRoot,'.cache','device-library-v1')
  const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'))
  if(!/^\d{13}-[a-f0-9-]{36}$/.test(manifest.generation)||!Array.isArray(manifest.chunks)||manifest.chunks.length>1000)throw new Error('本地库清单格式不受支持')
  const indexBytes=await readFile(join(root,manifest.generation,'index.json'))
  if(hash(indexBytes)!==manifest.indexHash)throw new Error('本地库索引校验失败，未使用不可信条目进行审计')
  const index=JSON.parse(indexBytes.toString('utf8'))
  const rows:SymbolAuditRow[]=[],counts:Partial<Record<SymbolAuditStatus,number>>={}
  const installedOriginal=createInstalledAuditResolver()
  for(let chunk=0;chunk<manifest.chunks.length;chunk++){
    const bytes=await readFile(join(root,manifest.generation,`${chunk}.models.json`))
    if(hash(bytes)!==manifest.chunks[chunk].models)throw new Error(`模型分块 ${chunk} 校验失败`)
    const models=JSON.parse(bytes.toString('utf8')) as ImportedSpiceModel[]
    const entries=index.entries.filter((entry:{chunk:number})=>entry.chunk===chunk)
    if(entries.length!==models.length)throw new Error(`模型分块 ${chunk} 数量与索引不一致`)
    for(const model of models){
      const key=hash(JSON.stringify(model))
      if(!entries.some((entry:{key:string;id:string})=>entry.key===key&&entry.id===model.id))throw new Error(`模型 ${model.id} 与编译索引不一致`)
      const pspice=isOwnedPspiceSource(model.source)
      const installed=model.source.url===ltspiceSourceUrl&&model.source.label.startsWith('本机 LTspice / ')
      const resolver:OriginalSymbolResolver|undefined=pspice?m=>readOwnedPspiceSymbolForModel(m.source.label.slice('PSpice 本地库 /'.length).trim(),m.id,m.pins,libraryRoot):installed?installedOriginal:undefined
      const row=await auditModelSymbol(model,key,resolver)
      rows.push(row);counts[row.status]=(counts[row.status]??0)+1
    }
  }
  if(rows.length!==manifest.versions)throw new Error('审计条目数与当前本地库清单不一致')
  return {recordedAt:new Date().toISOString(),generation:manifest.generation,uniqueDevices:manifest.total,versions:rows.length,counts,rows,
    scope:'全部当前可选模型的结构、保存恢复、端口索引与功能证据；PSpice OLB 与本机 LTspice ASY 原厂图形另核对 SHA-256、明确文件关联、模板或 SpiceOrder 及模型接口。不是逐器件人工外观验收或仿真精度认证。'}
}
