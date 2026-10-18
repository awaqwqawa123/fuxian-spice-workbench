import {createHash} from 'node:crypto'
import {readFile,readdir,writeFile} from 'node:fs/promises'
import {dirname,join,relative,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const args=process.argv.slice(2),root=resolve(args.find(arg=>!arg.startsWith('--'))??join(repo,'model-library'))
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const safePath=path=>typeof path==='string'&&!path.includes('\\')&&!path.includes(':')&&!path.startsWith('/')&&path.split('/').every(piece=>piece&&piece!=='.'&&piece!=='..')
const json=async path=>JSON.parse(await readFile(path,'utf8'))
const included=['vendor','converted-symbols','import-reports','catalog','audits/engine-review.json']
async function collect(path){
 const info=await readdir(path,{withFileTypes:true})
 const result=[]
 for(const entry of info){
  if(entry.isSymbolicLink())throw new Error(`Library symlinks are not portable: ${entry.name}`)
  const file=join(path,entry.name)
  if(entry.isDirectory())result.push(...await collect(file))
  else if(entry.isFile())result.push(file)
 }
 return result
}
async function validateCatalog(){
 const catalog=join(root,'catalog'),manifest=await json(join(catalog,'manifest.json'))
 if(!/^[0-9]{13}-[a-f0-9-]{36}$/.test(manifest.generation)||!Array.isArray(manifest.chunks)||![1,2,3].includes(manifest.schema))throw new Error('Bundled catalog manifest invalid')
 const generation=join(catalog,manifest.generation),indexBytes=await readFile(join(generation,'index.json'))
 if(sha(indexBytes)!==manifest.indexHash)throw new Error('Catalog index checksum mismatch')
 const index=JSON.parse(indexBytes.toString('utf8'))
 if(index.scope!==manifest.scope||index.schema!==manifest.schema||index.entries.length!==manifest.versions)throw new Error('Catalog identities differ from manifest')
  const seen=new Set(),entriesByKey=new Map(index.entries.map(entry=>[entry.key,entry]));let count=0
  if(entriesByKey.size!==index.entries.length)throw new Error('Catalog index contains duplicate model keys')
 for(const [chunk,hashes] of manifest.chunks.entries()){
  const data={}
  for(const suffix of ['models','summaries']){
   const bytes=await readFile(join(generation,`${chunk}.${suffix}.json`))
   if(sha(bytes)!==hashes[suffix])throw new Error(`Catalog ${chunk}.${suffix} checksum mismatch`)
   data[suffix]=JSON.parse(bytes.toString('utf8'))
  }
  if(data.models.length!==data.summaries.length)throw new Error(`Catalog ${chunk} summary count mismatch`)
  const summariesByKey=new Map(data.summaries.map(summary=>[summary.key,summary]))
  if(summariesByKey.size!==data.summaries.length)throw new Error(`Catalog ${chunk} summary keys are duplicated`)
  for(const model of data.models){
   const key=sha(JSON.stringify(model)),entry=entriesByKey.get(key),summary=summariesByKey.get(key)
   if(seen.has(key)||!entry||entry.chunk!==chunk||!summary||entry.id!==model.id||summary.id!==model.id||JSON.stringify(summary.pins)!==JSON.stringify(model.pins))throw new Error(`Catalog model identity mismatch: ${model.id}`)
   seen.add(key);count++
  }
 }
 if(count!==manifest.versions)throw new Error('Catalog version count mismatch')
 const review=await json(join(root,'audits','engine-review.json'))
 if(review.generation!==manifest.generation||review.total!==manifest.versions||review.rows.length!==count||new Set(review.rows.map(row=>row.key)).size!==count||review.rows.some(row=>!seen.has(row.key)))throw new Error('Engine audit does not match bundled library')
 return {generation:manifest.generation,devices:manifest.total,versions:manifest.versions}
}
try{
 const catalog=await validateCatalog(),manifestPath=join(root,'bundle-manifest.json')
 if(args.includes('--record')){
  const paths=(await Promise.all(included.map(path=>path.endsWith('.json')?[join(root,path)]:collect(join(root,path))))).flat().sort()
  const files=[]
  for(const file of paths){const bytes=await readFile(file);files.push({path:relative(root,file).split('\\').join('/'),bytes:bytes.length,sha256:sha(bytes)})}
  const result={schema:1,...catalog,files,totalBytes:files.reduce((sum,file)=>sum+file.bytes,0)}
  await writeFile(manifestPath,JSON.stringify(result,null,2)+'\n','utf8')
 }
 const manifest=await json(manifestPath)
 if(manifest.schema!==1||manifest.generation!==catalog.generation||!Array.isArray(manifest.files))throw new Error('Library bundle manifest invalid')
 const seen=new Set()
 for(const file of manifest.files){
  if(!safePath(file.path)||seen.has(file.path))throw new Error('Unsafe or duplicate bundle path')
  seen.add(file.path);const bytes=await readFile(join(root,file.path))
  if(bytes.length!==file.bytes||sha(bytes)!==file.sha256)throw new Error(`Library asset checksum mismatch: ${file.path}`)
 }
 const actual=(await Promise.all(included.map(path=>path.endsWith('.json')?[join(root,path)]:collect(join(root,path))))).flat().map(path=>relative(root,path).split('\\').join('/'))
 if(actual.length!==seen.size||actual.some(path=>!seen.has(path))||manifest.totalBytes!==manifest.files.reduce((sum,file)=>sum+file.bytes,0)||manifest.devices!==catalog.devices||manifest.versions!==catalog.versions)throw new Error('Library inventory differs from bundled files')
 console.log(JSON.stringify({verified:true,...catalog,files:manifest.files.length,bytes:manifest.totalBytes}))
}catch(error){console.error(error.message);process.exitCode=1}
