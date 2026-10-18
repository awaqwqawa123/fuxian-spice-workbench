import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const vendors = ['pspice', 'tina', 'ltspice']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const slash = value => value.replaceAll('\\', '/')
const stable = value => JSON.stringify(value, null, 2) + '\n'
const blocked = /(?:^|\/)(?:\.cache|node_modules|\.git|\.desktop-control|\.desktop-circuit|credentials?)(?:\/|$)|\.(?:exe|dll|msi|key|pem)$/i
const within = (root, file) => { const part = relative(root, file); return !isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') }
function safePath(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || /^[a-z]:/i.test(name)) throw new Error('Invalid library-relative path: '+name)
  const file = resolve(root, name)
  if (!within(root, file) || slash(name).split('/').includes('..')) throw new Error('Path escapes library: '+name)
  return file
}
async function exists(file) { try { await stat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function hash(file) {
  const result = createHash('sha256')
  for await (const bytes of createReadStream(file)) result.update(bytes)
  return result.digest('hex')
}
async function actualFile(root, name) {
  const file = await realpath(safePath(root, name))
  if (!within(root, file)) throw new Error('Symlink escapes source: '+name)
  return file
}
async function changedWrite(file, bytes) {
  try { if ((await readFile(file)).equals(Buffer.from(bytes))) return false } catch (error) { if (error.code !== 'ENOENT') throw error }
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes); return true
}
async function walk(root, prefix = '') {
  if (!await exists(root)) return []
  const result = []
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const name = prefix ? prefix+'/'+entry.name : entry.name
    if (entry.isSymbolicLink()) throw new Error('Symlink not permitted in snapshot: '+name)
    if (blocked.test(name)) continue
    if (entry.isDirectory()) result.push(...await walk(join(root, entry.name), name))
    else if (entry.isFile()) result.push(name)
  }
  return result
}
function conflictPath(name, id) {
  // Remain below the original reader root; preserve relative include paths.
  const known = ['tools/pspice/library/', 'pspice/library/', 'tools/capture/library/', 'capture/library/', 'lib/cmp/', 'lib/sub/', 'lib/sym/']
  const prefix = known.find(root => name.toLowerCase().startsWith(root)) ?? ''
  return prefix+'__snapshots/'+id+'/'+name.slice(prefix.length)
}
function readerRoot(name) {
  return ['tools/pspice/library/', 'pspice/library/', 'tools/capture/library/', 'capture/library/', 'lib/cmp/', 'lib/sub/', 'lib/sym/'].find(root => name.toLowerCase().startsWith(root)) ?? ''
}
async function copyPreserving(source, destinationRoot, name, sha256, id, report, category) {
  let output = name
  const existing = safePath(destinationRoot, output)
  if (await exists(existing) && await hash(existing) !== sha256) {
    output = conflictPath(name, id)
    report.conflicts.push({ category, path: name, preservedPath: output, incomingSha256: sha256, retainedSha256: await hash(existing) })
  }
  const destination = safePath(destinationRoot, output)
  if (await exists(destination)) {
    if (await hash(destination) !== sha256) throw new Error('Preserved snapshot collision: '+output)
  } else {
    await mkdir(dirname(destination), { recursive: true }); await copyFile(source, destination)
  }
  if (await hash(destination) !== sha256) throw new Error('Copy hash mismatch: '+output)
  return output
}
function totals(files) {
  const kinds = {}, extensions = {}, collections = new Map()
  for (const file of files) {
    const size = file.bytes ?? file.size ?? 0, kind = file.kind ?? 'original-library-asset', extension = extname(file.path).toLowerCase()
    kinds[kind] = (kinds[kind] ?? 0) + 1; extensions[extension] = (extensions[extension] ?? 0) + 1
    const key = file.collection ?? file.path.split('/')[0]
    const group = collections.get(key) ?? { collection:key, files:0, bytes:0, kinds:{}, extensions:{} }
    group.files++; group.bytes += size; group.kinds[kind] = (group.kinds[kind] ?? 0) + 1; group.extensions[extension] = (group.extensions[extension] ?? 0) + 1; collections.set(key, group)
  }
  return { totals:{ files:files.length, bytes:files.reduce((sum,file) => sum+(file.bytes ?? file.size ?? 0),0), kinds, extensions }, collections:[...collections.values()] }
}
function snapshots(manifest, sha256, manifestPath) {
  if (manifest.schemaVersion === 2 && manifest.mergePolicy === 'byte-preserving-snapshot-union') return manifest.snapshots
  const source = manifest.source ?? { sourceRoot:manifest.sourceRoot, sourceLayout:manifest.sourceLayout, destinationLayout:manifest.destinationLayout, preservation:manifest.preservation }
  return [{ id:sha256, manifestSha256:sha256, manifestPath, source }]
}
function provenance(file, list) {
  if (Array.isArray(file.provenance)) return file.provenance
  return [{ snapshotId:list[0].id, source:list[0].source, originalPath:file.path, originalRecord:file }]
}
function unionRecords(left, right, key) {
  const result = [...left], seen = new Set(left.map(key))
  for (const item of right) if (!seen.has(key(item))) { result.push(item); seen.add(key(item)) }
  return result
}

/** No networking, conversion, catalog rebuild or Git operation. Canonical
 * target paths win; differing incoming bytes get stable snapshot paths. */
export async function mergeLocalLibrarySnapshots({ localRoot, targetRoot, reportPath }) {
  localRoot = await realpath(resolve(localRoot)); targetRoot = await realpath(resolve(targetRoot))
  if (localRoot === targetRoot || within(localRoot,targetRoot) || within(targetRoot,localRoot)) throw new Error('Source and target libraries must be separate non-nested directories')
  const report = { schemaVersion:1, policy:'byte-preserving-snapshot-union', vendors:{}, conflicts:[], conversionWarnings:[], blockedFiles:[] }
  const pspicePaths = new Map()
  for (const vendor of vendors) {
    const localVendor = join(localRoot,'vendor',vendor), targetVendor = join(targetRoot,'vendor',vendor)
    const incomingPath = join(localVendor,'paths_manifest.json')
    if (!await exists(incomingPath)) continue
    const incomingBytes = await readFile(incomingPath), incoming = JSON.parse(incomingBytes), incomingSha = digest(incomingBytes)
    if (incoming.vendor !== vendor || !Array.isArray(incoming.files)) throw new Error('Invalid '+vendor+' source manifest')
    const archiveName = '.snapshots/'+incomingSha+'/paths_manifest.json'
    const targetPath = join(targetVendor,'paths_manifest.json')
    let previous = { files:[], snapshots:[] }, previousSnapshots = [], previousSha
    if (await exists(targetPath)) {
      const bytes = await readFile(targetPath); previous = JSON.parse(bytes)
      if (previous.vendor !== vendor || !Array.isArray(previous.files)) throw new Error('Invalid '+vendor+' target manifest')
      const sha256 = digest(bytes), archive = '.snapshots/'+sha256+'/paths_manifest.json'
      previousSha = sha256
      previousSnapshots = snapshots(previous,sha256,archive)
      if (previous.schemaVersion !== 2 || previous.mergePolicy !== 'byte-preserving-snapshot-union') await changedWrite(join(targetVendor,archive),bytes)
    }
    await changedWrite(join(targetVendor,archiveName),incomingBytes)
    const incomingSnapshots = snapshots(incoming,incomingSha,archiveName)
    for (const snapshot of incomingSnapshots) {
      if (snapshot.manifestPath === archiveName) continue
      const source = await actualFile(localVendor,snapshot.manifestPath), bytes = await readFile(source)
      if (digest(bytes) !== snapshot.manifestSha256) throw new Error('Archived manifest hash mismatch: '+snapshot.manifestPath)
      const destination = safePath(targetVendor,snapshot.manifestPath)
      if (await exists(destination) && await hash(destination) !== snapshot.manifestSha256) throw new Error('Archived manifest conflict: '+snapshot.manifestPath)
      await changedWrite(destination,bytes)
    }
    const records = new Map()
    for (const file of previous.files) {
      const source = await actualFile(targetVendor,file.path), sha256 = await hash(source), info = await stat(source)
      if (sha256 !== file.sha256 || info.size !== (file.bytes ?? file.size)) throw new Error('Target original hash/size mismatch: '+vendor+'/'+file.path)
      records.set(file.path.toLowerCase(),{...file,provenance:provenance(file,previousSnapshots)})
    }
    const relocatedRoots = new Set()
    for (const file of incoming.files) {
      const existing = records.get(file.path.toLowerCase())
      if (existing && existing.sha256 !== file.sha256) relocatedRoots.add(readerRoot(file.path))
    }
    for (const file of incoming.files) {
      if (blocked.test(slash(file.path))) { report.blockedFiles.push(vendor+'/'+file.path); continue }
      const original = await actualFile(localVendor,file.path), sha256 = await hash(original), info = await stat(original)
      if (sha256 !== file.sha256 || info.size !== (file.bytes ?? file.size)) throw new Error('Incoming original hash/size mismatch: '+vendor+'/'+file.path)
      const originalPath = slash(file.path), relocated = relocatedRoots.has(readerRoot(originalPath))
      const wanted = relocated ? conflictPath(originalPath,incomingSha.slice(0,16)) : originalPath
      if (relocated) report.conflicts.push({category:'vendor/'+vendor,path:originalPath,preservedPath:wanted,incomingSha256:sha256,retainedSha256:records.get(originalPath.toLowerCase())?.sha256,reason:'Preserve the complete incoming reader-root hierarchy for relative includes'})
      const output = await copyPreserving(original,targetVendor,wanted,sha256,incomingSha.slice(0,16),report,'vendor/'+vendor)
      const key = output.toLowerCase(), existing = records.get(key), added = provenance(file,incomingSnapshots)
      records.set(key,existing ? {...existing,provenance:unionRecords(existing.provenance,added,item => stable(item))} : {...file,path:output,provenance:added})
      if (vendor === 'pspice') pspicePaths.set(slash(file.path),output)
    }
    const files = [...records.values()].sort((a,b) => a.path.localeCompare(b.path)), stats = totals(files)
    const manifest = { schemaVersion:2, vendor, mergePolicy:'byte-preserving-snapshot-union', source:{selectionKind:'merged-local-snapshots',provenancePolicy:'Each file retains its exact original record and source snapshot; no merged installation claim.'}, snapshots:unionRecords(previousSnapshots,incomingSnapshots,item => item.id).sort((a,b) => a.id.localeCompare(b.id)), files, ...stats, notice:'Private user-owned snapshot union. Original bytes and original license/copyright remain unchanged; presence does not imply ngspice compatibility or permission to redistribute.' }
    if (vendor === 'ltspice') Object.assign(manifest,{schema:2,totalFiles:stats.totals.files,bytes:stats.totals.bytes,asy:files.filter(file => /\.asy$/i.test(file.path)).length,groups:Object.fromEntries(['cmp','sub','sym'].map(group => [group,files.filter(file => file.path.startsWith('lib/'+group+'/')).length]))})
    // A first import or byte-identical source retains the exact source manifest.
    // In particular the already-identical TINA snapshot is not rewritten.
    const exactSource=(previousSha === undefined || previousSha === incomingSha)&&files.length===incoming.files.length&&!incoming.files.some(file=>blocked.test(slash(file.path)))
    await changedWrite(targetPath,exactSource ? incomingBytes : stable(manifest))
    report.vendors[vendor] = { snapshots:manifest.snapshots.length, ...stats.totals }
  }
  const localConverted = join(localRoot,'converted-symbols/pspice'), targetConverted = join(targetRoot,'converted-symbols/pspice')
  for (const name of await walk(localConverted)) {
    if (!/\.olb\.json$/i.test(name)) continue
    const bytes = await readFile(await actualFile(localConverted,name)), data = JSON.parse(bytes), originalPath = name.slice(0,-5), mapped = pspicePaths.get(originalPath)
    if (!mapped) throw new Error('Conversion has no original in incoming manifest: '+name)
    const originalHash = await hash(safePath(join(targetRoot,'vendor/pspice'),mapped))
    if (data.originalSha256 !== originalHash) report.conversionWarnings.push({path:name,reason:'conversion-original-hash-mismatch',originalSha256:originalHash,convertedOriginalSha256:data.originalSha256})
    await copyPreserving(join(localConverted,name),targetConverted,mapped+'.json',digest(bytes),digest(bytes).slice(0,16),report,'converted-symbols/pspice')
  }
  // Preserve summaries as evidence; new totals require matching original SHA.
  for (const converted of [targetConverted,localConverted]) {
    const summary = join(converted,'conversion-summary.json')
    if (await exists(summary)) {
      const bytes = await readFile(summary), parsed = JSON.parse(bytes)
      if (parsed.mergePolicy !== 'verified-original-cache-union') await changedWrite(join(targetConverted,'.snapshots',digest(bytes),'conversion-summary.json'),bytes)
    }
  }
  const summary = await summarizeConversions(targetRoot)
  await changedWrite(join(targetConverted,'conversion-summary.json'),stable(summary))
  report.conversions = { files:summary.files, convertedFiles:summary.convertedFiles, parts:summary.parts, mappedParts:summary.mappedParts, invalidCaches:summary.invalidCaches.length }
  if (reportPath) await changedWrite(resolve(reportPath),stable(report))
  return report
}

export async function summarizeConversions(libraryRoot) {
  const originalRoot = join(libraryRoot,'vendor/pspice'), convertedRoot = join(libraryRoot,'converted-symbols/pspice')
  const summary = { mergePolicy:'verified-original-cache-union',files:(await walk(originalRoot)).filter(name => /\.olb$/i.test(name)&&!name.startsWith('.snapshots/')).length,convertedFiles:0,parts:0,mappedParts:0,unresolvedUnitParts:0,rejectedStreams:0,filesWithIssues:[],invalidCaches:[],originalMappings:[] }
  for (const name of await walk(convertedRoot)) {
    if (!/\.olb\.json$/i.test(name) || name.startsWith('.snapshots/') || name.includes('/__snapshots/') && !await exists(safePath(originalRoot,name.slice(0,-5)))) continue
    const cache = JSON.parse(await readFile(join(convertedRoot,name),'utf8')), original = name.slice(0,-5)
    if (!await exists(safePath(originalRoot,original)) || cache.originalSha256 !== await hash(safePath(originalRoot,original)) || cache.version !== 1 || !Array.isArray(cache.parts)) {
      summary.invalidCaches.push({path:name,reason:'Original missing, cache format invalid, or original SHA-256 differs'}); continue
    }
    summary.convertedFiles += Number(cache.parts.length>0); summary.parts += cache.parts.length
    summary.mappedParts += cache.parts.filter(part => Array.isArray(part.pins) && part.pins.some(pin => pin&&Object.hasOwn(pin,'spiceOrder'))).length
    summary.unresolvedUnitParts += cache.parts.filter(part => part.unsupportedElectricalMapping).length
    const issues = Array.isArray(cache.issues) ? cache.issues : []
    summary.rejectedStreams += issues.length
    if (issues.length) summary.filesWithIssues.push({path:original,issues})
    summary.originalMappings.push({path:original,cachePath:name,originalSha256:cache.originalSha256,cacheSha256:await hash(join(convertedRoot,name)),parts:cache.parts.length})
  }
  summary.note = 'parts counts decoded cached graphics; mappedParts counts candidate mappings, not ready models. Runtime verifies exact template order and actual electrical declarations before import.'
  return summary
}

/** Read-only verification, independent of copying and summary production. */
export async function verifyMergedLibrarySnapshots(libraryRoot) {
  libraryRoot=await realpath(resolve(libraryRoot))
  const result={verified:true,vendors:{},failures:[]}
  const fail=(vendor,path,reason)=>result.failures.push({vendor,path,reason})
  for(const vendor of vendors) {
    const root=join(libraryRoot,'vendor',vendor),manifestPath=join(root,'paths_manifest.json')
    if(!await exists(manifestPath))continue
    const manifest=JSON.parse(await readFile(manifestPath,'utf8')),seen=new Set(),snapshotsById=new Map(),sourcesById=new Map()
    if(manifest.vendor!==vendor||!Array.isArray(manifest.files))throw new Error('Invalid vendor manifest: '+vendor)
    for(const snapshot of manifest.snapshots??[]) {
      const bytes=await readFile(await actualFile(root,snapshot.manifestPath))
      if(digest(bytes)!==snapshot.id||digest(bytes)!==snapshot.manifestSha256)fail(vendor,snapshot.manifestPath,'source-manifest-hash-mismatch')
      const source=JSON.parse(bytes)
      const originalSource=source.source??{sourceRoot:source.sourceRoot,sourceLayout:source.sourceLayout,destinationLayout:source.destinationLayout,preservation:source.preservation}
      if(stable(originalSource)!==stable(snapshot.source))fail(vendor,snapshot.manifestPath,'snapshot-source-evidence-mismatch')
      sourcesById.set(snapshot.id,originalSource)
      snapshotsById.set(snapshot.id,new Map((source.files??[]).map(file=>[file.path,file])))
    }
    for(const file of manifest.files) {
      if(blocked.test(file.path))fail(vendor,file.path,'prohibited-file')
      if(seen.has(file.path.toLowerCase()))fail(vendor,file.path,'duplicate-path')
      seen.add(file.path.toLowerCase())
      try {
        const actual=await actualFile(root,file.path),info=await stat(actual)
        if(info.size!==(file.bytes??file.size)||await hash(actual)!==file.sha256)fail(vendor,file.path,'original-hash-or-size-mismatch')
      }catch(error){fail(vendor,file.path,error.message)}
      for(const entry of file.provenance??[]) {
        const original=snapshotsById.get(entry.snapshotId)?.get(entry.originalPath)
        if(!original||original.sha256!==file.sha256||stable(original)!==stable(entry.originalRecord))fail(vendor,file.path,'source-record-does-not-match-original-manifest')
        if(stable(entry.source)!==stable(sourcesById.get(entry.snapshotId)))fail(vendor,file.path,'entry-source-evidence-mismatch')
      }
      if(manifest.schemaVersion===2&&!file.provenance?.length)fail(vendor,file.path,'missing-entry-provenance')
    }
    if(manifest.schemaVersion===2&&stable(totals(manifest.files).totals)!==stable(manifest.totals))fail(vendor,'paths_manifest.json','totals-mismatch')
    const stored=(await walk(root)).filter(name=>name!=='paths_manifest.json'&&!name.startsWith('.snapshots/'))
    for(const name of stored)if(!seen.has(name.toLowerCase()))fail(vendor,name,'unmanifested-vendor-original')
    result.vendors[vendor]={files:seen.size,snapshots:snapshotsById.size}
  }
  const convertedRoot=join(libraryRoot,'converted-symbols/pspice'),summaryFile=join(convertedRoot,'conversion-summary.json')
  if(await exists(summaryFile)) {
    const summary=JSON.parse(await readFile(summaryFile,'utf8'))
    const actual={convertedFiles:0,parts:0,mappedParts:0,unresolvedUnitParts:0,rejectedStreams:0},mappedPaths=new Set()
    for(const mapping of summary.originalMappings??[]) {
      const cache=await actualFile(convertedRoot,mapping.cachePath),original=await actualFile(join(libraryRoot,'vendor/pspice'),mapping.path)
      if(await hash(cache)!==mapping.cacheSha256||await hash(original)!==mapping.originalSha256)fail('pspice',mapping.cachePath,'conversion-original-mapping-hash-mismatch')
      if(mappedPaths.has(mapping.cachePath))fail('pspice',mapping.cachePath,'duplicate-conversion-mapping')
      mappedPaths.add(mapping.cachePath)
      const raw=JSON.parse(await readFile(cache,'utf8'))
      if(raw.version!==1||raw.originalSha256!==mapping.originalSha256||!Array.isArray(raw.parts)){fail('pspice',mapping.cachePath,'invalid-conversion-mapping');continue}
      actual.convertedFiles+=Number(raw.parts.length>0);actual.parts+=raw.parts.length
      actual.mappedParts+=raw.parts.filter(part=>Array.isArray(part.pins)&&part.pins.some(pin=>pin&&Object.hasOwn(pin,'spiceOrder'))).length
      actual.unresolvedUnitParts+=raw.parts.filter(part=>part.unsupportedElectricalMapping).length
      actual.rejectedStreams+=Array.isArray(raw.issues)?raw.issues.length:0
    }
    if(summary.mergePolicy==='verified-original-cache-union') {
      for(const [field,value] of Object.entries(actual))if(summary[field]!==value)fail('pspice','conversion-summary.json','conversion-'+field+'-mismatch')
      for(const name of await walk(convertedRoot))if(/\.olb\.json$/i.test(name)&&await exists(safePath(join(libraryRoot,'vendor/pspice'),name.slice(0,-5)))&&!mappedPaths.has(name))fail('pspice',name,'missing-conversion-mapping')
    }
    if(summary.invalidCaches?.length)for(const issue of summary.invalidCaches)fail('pspice',issue.path,'unverified-cache')
  }
  result.verified=result.failures.length===0
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index+1] }
  if (!value('--target-root') || (!args.includes('--verify')&&!value('--local-root'))) throw new Error('Usage: node scripts/merge-local-library-snapshots.mjs --target-root <library> (--verify | --local-root <library> [--report <json>])')
  const result=args.includes('--verify')?await verifyMergedLibrarySnapshots(value('--target-root')):await mergeLocalLibrarySnapshots({localRoot:value('--local-root'),targetRoot:value('--target-root'),reportPath:value('--report')})
  console.log(JSON.stringify(result,null,2))
  if(result.verified===false)process.exitCode=1
}
