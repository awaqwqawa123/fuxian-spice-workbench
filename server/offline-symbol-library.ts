import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { decodeSpiceLibrary, type SpiceModelSource } from '../src/core/spice-models'
import { parseLtspiceAsy } from '../src/core/ltspice-symbol'
import type { ModelSymbol } from '../src/core/model-symbol'
import type { OfflineSymbolAsset, OfflineSymbolCatalog, OfflineSymbolDetail, OfflineSymbolSource } from '../src/core/offline-symbol-library'
import type { IndexedSymbol } from './ltspice-symbol-library'
import { inspectOrcadLibrary, readConvertedOlb } from './olb-library'
import { asyModelFile, asyModelNames, createSymbolModelFileIndex, originalSymbolForDeclaration, parseSymbolModelHeaders } from './original-symbol-link'
import { indexOwnedPspiceSymbolAssets } from './owned-pspice-symbols'

export interface OfflineSourceManifestEntry extends OfflineSymbolSource { directory: string }
export interface OfflineSymbolInventory { symbols: IndexedSymbol[]; assets: OfflineSymbolAsset[]; sources: OfflineSymbolSource[]; notices: string[]; paths: Map<string, { path: string; source: SpiceModelSource }> }
export function offlineLibraryRoot(): string { return resolve(process.env.SPICE_MODEL_LIBRARY_DIR || 'E:/spice-workbench-library') }
const within = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) }
const publicSource = ({ key, repo, revision, archiveSha256 }: OfflineSourceManifestEntry): OfflineSymbolSource => ({ key, repo, revision, archiveSha256 })
const MAX_FILES = 100000

export async function readOfflineSourceManifest(root = offlineLibraryRoot()): Promise<OfflineSourceManifestEntry[]> {
  const manifestPath = join(root, 'sources', 'manifest.json'), info = await stat(manifestPath)
  if (info.size > 1024 * 1024) throw new Error('离线来源清单超过 1 MB')
  const input = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: unknown; sources?: unknown }
  if (input.version !== 1 || !Array.isArray(input.sources) || input.sources.length > 64) throw new Error('离线来源清单格式不受支持')
  const allowedRoot = await realpath(join(root, 'sources')), seen = new Set<string>(), result: OfflineSourceManifestEntry[] = []
  for (const value of input.sources) {
    if (!value || typeof value !== 'object' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.key) || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value.repo) || !/^[0-9a-f]{40}$/i.test(value.revision) || !/^[0-9a-f]{64}$/i.test(value.archiveSha256) || typeof value.directory !== 'string' || !isAbsolute(value.directory)) throw new Error('离线来源清单缺少固定仓库、版本、路径或归档哈希')
    if (seen.has(value.key)) throw new Error(`离线来源编号重复：${value.key}`)
    seen.add(value.key)
    const directory = await realpath(value.directory)
    if (!within(allowedRoot, directory) || directory === allowedRoot) throw new Error(`离线来源路径超出 sources 目录：${value.key}`)
    result.push({ key: value.key, repo: value.repo, revision: value.revision, archiveSha256: value.archiveSha256, directory })
  }
  return result
}

async function filesWithin(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [], queue = [root]
  while (queue.length) {
    const directory = queue.pop()!
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children) {
      // Symlinks/reparse links are deliberately not followed into other libraries.
      if (child.isSymbolicLink()) continue
      const path = join(directory, child.name)
      if (child.isDirectory()) queue.push(path)
      else if (child.isFile() && /\.(?:asy|olb|lib|mod|sub|cir|spice|spi|inc)$/i.test(child.name)) { files.push(path); if (files.length >= MAX_FILES) return { files, truncated: true } }
    }
  }
  return { files, truncated: false }
}
async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
function sourceFor(source: OfflineSourceManifestEntry, path: string): SpiceModelSource {
  const rel = relative(source.directory, path).replaceAll('\\', '/')
  return { label: `离线原件 / ${source.repo} / ${rel}`, url: `https://github.com/${source.repo}/blob/${source.revision}/${rel.split('/').map(encodeURIComponent).join('/')}`, license: '本机下载的原件；沿用原作者和厂商条款，工作台不再分发厂商库原文', attribution: `固定版本 ${source.revision}；归档 SHA256 ${source.archiveSha256}；同名文件按来源与路径独立保留。` }
}

export async function indexOfflineSymbols(root = offlineLibraryRoot(),sourceKeys?:readonly string[]): Promise<OfflineSymbolInventory> {
  // A targeted remote preview remains source-specific. The complete browser
  // includes software-owned vendor files even without a Git archive manifest.
  const inventory: OfflineSymbolInventory = sourceKeys===undefined
    ? await indexOwnedPspiceSymbolAssets()
    : { symbols: [], assets: [], sources: [], notices: [], paths: new Map() }
  let sources: OfflineSourceManifestEntry[]
  try { sources = await readOfflineSourceManifest(root) }
  catch (reason) { inventory.notices.push((reason as NodeJS.ErrnoException).code === 'ENOENT' ? '尚无已下载的离线来源清单。' : `读取离线来源清单失败：${(reason as Error).message}`); return inventory }
  for (const source of sources) {
    if(sourceKeys&&!sourceKeys.includes(source.key))continue
    inventory.sources.push(publicSource(source))
    let scanned: { files: string[]; truncated: boolean }
    try { scanned = await filesWithin(source.directory) }
    catch (reason) { inventory.notices.push(`${source.key} 文件扫描失败：${(reason as Error).message}`); continue }
    if (scanned.truncated) inventory.notices.push(`${source.key} 超过 ${MAX_FILES} 个支持后缀文件，扫描已达到上限。`)
    const modelPaths = scanned.files.filter(path => !/\.(?:asy|olb)$/i.test(path)), byName = new Map<string, string[]>(), byRelative = new Map<string, string[]>()
    const modelFileIndex=createSymbolModelFileIndex(modelPaths)
    const modelDeclarations = new Map<string, { bytes: number; ports: Map<string, number> }>()
    async function declarationInfo(path: string) {
      const existing = modelDeclarations.get(path)
      if (existing) return existing
      const info = await stat(path), result = { bytes: info.size, ports: new Map<string, number>() }
      if (info.size <= 4 * 1024 * 1024) {
        const text = decodeSpiceLibrary(await readFile(path)).replace(/\r?\n\s*\+/g, ' ')
        for (const match of text.matchAll(/^\s*\.subckt\s+(\S+)\s+([^\r\n]*)/gim)) {
          const ports = match[2].trim().split(/\s+/), boundary = ports.findIndex(port => /^params?:?$/i.test(port) || port.includes('=') || port.startsWith(';'))
          result.ports.set(match[1].toLowerCase(), boundary === -1 ? ports.length : boundary)
        }
      }
      modelDeclarations.set(path, result)
      return result
    }
    for (const path of modelPaths) { const name = basename(path).toLowerCase(), rel = relative(source.directory, path).replaceAll('\\', '/').toLowerCase(); byName.set(name, [...(byName.get(name) ?? []), path]); byRelative.set(rel, [...(byRelative.get(rel) ?? []), path]) }
    for (const path of scanned.files.filter(path => /\.(?:asy|olb)$/i.test(path))) {
      const rel = relative(source.directory, path).replaceAll('\\', '/'), format = /\.olb$/i.test(path) ? 'olb' : 'asy', id = `offline:${source.key}:${rel}`
      const asset: OfflineSymbolAsset = { id, sourceKey: source.key, relativePath: rel, name: basename(path), format, sha256: '', bytes: 0, originalStored: false, symbolsAvailable: false, status: 'unreadable', reason: '' }
      inventory.assets.push(asset)
      try {
        const info = await stat(path); asset.bytes = info.size; asset.sha256 = await sha256(path); asset.originalStored = true
        const provenance = sourceFor(source, path); inventory.paths.set(id, { path, source: provenance })
        if (format === 'olb') {
          Object.assign(asset, await inspectOrcadLibrary(path))
          const converted = await readConvertedOlb(root, source.key, rel, asset.sha256)
          if (converted?.length) {
            asset.status = 'converted'; asset.symbolsAvailable = true; asset.convertedParts = converted.length; asset.reason = `原件实际转换得到 ${converted.length} 个图形；只有真实模板电气引脚映射且关联模型通过检查的器件可放置。`
            for (const part of converted) {
              const requested = part.modelFile || basename(path).replace(/\.olb$/i, '.lib')
              let linked: string[] = [], status: IndexedSymbol['status'] = 'symbol-only', reason = 'OLB 原始图形已转换；尚未找到明确的关联模型文件'
              if (!/[\x00-\x1f{}:$]/.test(requested) && !isAbsolute(requested)) {
                const near = resolve(dirname(path), requested.replaceAll('\\', '/'))
                if (within(source.directory, near)) linked = byRelative.get(relative(source.directory, near).replaceAll('\\', '/').toLowerCase()) ?? []
                if (!linked.length && !/[\/\\]/.test(requested)) linked = byName.get(requested.toLowerCase()) ?? []
              }
              if (!part.electricalOrderVerified) { status = 'unsupported'; reason = '真实图形已转换；未取得 PSpiceTemplate 的物理引脚到电气端口映射，不能按物理引脚号推断 SPICE 顺序' }
              else if (linked.length > 1) { status = 'unsupported'; reason = '关联模型文件存在同名变体，尚不能安全选择电气模型' }
              else if (linked.length === 1) {
                const modelInfo = await declarationInfo(linked[0])
                if (modelInfo.bytes > 4 * 1024 * 1024) { status = 'unsupported'; reason = '关联模型原件超过 4 MB 导入上限' }
                else {
                  const portCount = modelInfo.ports.get(part.modelId.toLowerCase()) ?? 0
                  if (portCount === part.asy.symbol.pins.length) { status = 'linked'; reason = '原始 OLB 图形与物理引脚已转换，PSpiceTemplate 端口顺序与关联 .subckt 端口数已核对；还需模型兼容检查' }
                  else { status = 'unsupported'; reason = '关联文件缺少匹配的 .subckt 声明，或真实符号端口数与模型不一致' }
                }
              }
              inventory.symbols.push({ id: `${id}#${encodeURIComponent(part.id)}`, name: part.name, description: part.asy.description, pinCount: part.asy.symbol.pins.length, prefix: part.asy.prefix, modelFile: requested, status, reason: part.issues.length ? `${reason}；${part.issues.join('；')}` : reason, path, format: 'olb', convertedAsy: part.asy, physicalPinNumbers: part.physicalPinNumbers, source: status === 'linked' ? sourceFor(source, linked[0]) : provenance, symbolSource: provenance, sourceRoot: source.directory, originalSha256: asset.sha256, ...(status === 'linked' ? { modelPath: linked[0] } : {}) })
            }
          }
          continue
        }
        if (info.size > 128 * 1024) throw new Error('原始 ASY 已保留，但超过 128 KB 符号解析上限')
        const asy = parseLtspiceAsy(decodeSpiceLibrary(await readFile(path)), basename(path, '.asy'))
        asset.status = 'parsed'; asset.symbolsAvailable = true; asset.pinCount = asy.symbol.pins.length
        const modelFile = asyModelFile(asy)
        let linked: string[] = [], status: IndexedSymbol['status'] = 'symbol-only', reason = '真实 ASY 图形与电气引脚已读取；未找到明确关联的同来源 SPICE 文件'
        if (modelFile && !/[\x00-\x1f{}:$]/.test(modelFile) && !isAbsolute(modelFile)) {
          linked=modelFileIndex.resolve(modelFile,path,source.directory)
        }
        if (asy.prefix.toUpperCase() !== 'X') { status = 'unsupported'; reason = 'ASY 原始符号已解析；Prefix 不是 X，当前子电路符号入口不能将其作为多引脚 .subckt 导入' }
        else if (linked.length > 1) { status = 'unsupported'; reason = '同一来源的关联模型文件重名；保留全部变体，尚不能自动确定电气模型' }
        else if (linked.length === 1) { status = 'linked'; reason = '真实 ASY 图形与引脚已读取，找到同来源模型原件；导入前仍需模型兼容性及端口顺序检查' }
        asset.modelStatus = status; asset.reason = reason
        inventory.symbols.push({ id, name: asy.value || asy.value2 || basename(path).replace(/\.asy$/i, ''), description: asy.description, pinCount: asy.symbol.pins.length, prefix: asy.prefix, modelFile, status, reason, path, format: 'asy', source: status === 'linked' ? sourceFor(source, linked[0]) : provenance, symbolSource: provenance, sourceRoot: source.directory, originalSha256: asset.sha256, ...(status === 'linked' ? { modelPath: linked[0] } : {}) })
      } catch (reason) { asset.status = asset.originalStored ? 'unsupported' : 'unreadable'; asset.reason = (reason as Error).message || '原件读取失败' }
    }
  }
  inventory.symbols.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  inventory.assets.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }) || a.sourceKey.localeCompare(b.sourceKey))
  return inventory
}

export function searchOfflineSymbolAssets(inventory: OfflineSymbolInventory, query = '', offset = 0, limit = 40): OfflineSymbolCatalog {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8), all = inventory.assets
  const matches = all.filter(item => terms.every(term => `${item.name} ${item.relativePath} ${item.sourceKey} ${item.format}`.toLowerCase().includes(term)))
  return { total: matches.length, items: matches.slice(offset, offset + limit), sources: inventory.sources, notices: inventory.notices, counts: { originals: all.filter(item => item.originalStored).length, parsedAsy: all.filter(item => item.format === 'asy' && item.status === 'parsed').length, linkedAsy: all.filter(item => item.modelStatus === 'linked').length, olb: all.filter(item => item.format === 'olb').length, convertedOlb: all.filter(item => item.format === 'olb' && item.status === 'converted').length, needsConversion: all.filter(item => item.status === 'needs-conversion').length, unsupported: all.filter(item => item.status === 'unsupported' || item.status === 'unreadable').length } }
}
export async function readOfflineSymbolDetail(inventory: OfflineSymbolInventory, id: string): Promise<OfflineSymbolDetail> {
  const item = inventory.assets.find(asset => asset.id === id), location = inventory.paths.get(id)
  if (!item || !location) throw new Error('该离线原件无法读取，请重新扫描')
  if (await sha256(location.path) !== item.sha256) throw new Error('离线符号原件已变更，请重新扫描后再导入')
  const detail: OfflineSymbolDetail = { item, source: location.source }
  if (item.format === 'asy' && item.status === 'parsed') detail.asy = parseLtspiceAsy(decodeSpiceLibrary(await readFile(location.path)), item.name.replace(/\.asy$/i, ''))
  if (item.format === 'olb' && item.status === 'converted') detail.parts = inventory.symbols.filter(symbol => symbol.id.startsWith(`${id}#`)).map(symbol => ({ id: symbol.id, name: symbol.name, pinCount: symbol.pinCount, status: symbol.status, reason: symbol.reason }))
  return detail
}

/** Only attach a vendor's real symbol to the exact model source file and ID.
 * Same model names from another file/revision remain separate variants. */
export async function readOfflineSymbolForModel(sourceURL: string, id: string, pins: readonly string[], inventory?: OfflineSymbolInventory): Promise<ModelSymbol | undefined> {
  let url: URL
  try { url = new URL(sourceURL) } catch { return undefined }
  let segments: string[]
  try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent) } catch { return undefined }
  let repo: string, revision: string, path: string
  if (url.hostname === 'raw.githubusercontent.com' && segments.length >= 4) { repo = segments.slice(0, 2).join('/'); revision = segments[2]; path = segments.slice(3).join('/') }
  else if (url.hostname === 'github.com' && segments.length >= 5 && segments[2] === 'blob') { repo = segments.slice(0, 2).join('/'); revision = segments[3]; path = segments.slice(4).join('/') }
  else return undefined
  if (url.protocol !== 'https:' || !/^[0-9a-f]{40}$/i.test(revision) || !id || !pins.length) return undefined
  const indexed = inventory ?? await indexOfflineSymbols(), sources = indexed.sources.filter(source => source.repo.toLowerCase() === repo.toLowerCase() && source.revision.toLowerCase() === revision.toLowerCase())
  const eligible = indexed.symbols.filter(entry => {
    if (!entry.modelPath || !entry.sourceRoot || !sources.some(source => entry.id.startsWith(`offline:${source.key}:`))) return false
    if (entry.convertedAsy && !asyModelNames(entry.convertedAsy).includes(id.toLowerCase())) return false
    return relative(entry.sourceRoot, entry.modelPath).replaceAll('\\', '/').toLowerCase() === path.toLowerCase() && entry.pinCount === pins.length
  })
  const exactSymbols: ModelSymbol[] = [], familySymbols: ModelSymbol[] = [], hashes = new Map<string, string>()
  const libraryHeaders = new Map<string,Map<string,string[]>>()
  async function headers(entry: IndexedSymbol): Promise<Map<string, string[]>> {
    const cached=libraryHeaders.get(entry.modelPath!)
    if(cached)return cached
    const declarations = new Map<string, string[]>()
    const info = await stat(entry.modelPath!)
    if (info.size > 4 * 1024 * 1024) return declarations
    const parsed=parseSymbolModelHeaders(decodeSpiceLibrary(await readFile(entry.modelPath!)))
    libraryHeaders.set(entry.modelPath!,parsed)
    return parsed
  }
  for (const entry of eligible) {
    try {
      let asy = entry.convertedAsy
      if (!hashes.has(entry.path) || !asy) {
        const bytes = await readFile(entry.path)
        hashes.set(entry.path, createHash('sha256').update(bytes).digest('hex'))
        if (!asy) asy = parseLtspiceAsy(decodeSpiceLibrary(bytes), entry.name)
      }
      if (hashes.get(entry.path) !== entry.originalSha256) continue
      if (!asy) continue
      const resolved=originalSymbolForDeclaration(asy,id,pins,await headers(entry),entry.format!=='olb'&&!!asyModelFile(asy))
      if(resolved)(resolved.exact?exactSymbols:familySymbols).push(resolved.symbol)
    } catch { /* Reject unsupported geometry, changed originals, or mismatched pins. */ }
  }
  const symbols = exactSymbols.length ? exactSymbols : familySymbols
  if (!symbols.length) return undefined
  const unique = new Map(symbols.map(symbol => [JSON.stringify({ pins: symbol.pins, geometry: symbol.geometry, annotations: symbol.annotations ?? [] }), symbol]))
  return unique.size === 1 ? { ...[...unique.values()][0], title: id.slice(0, 32) } : undefined
}

/** Flatten only explicit bounded same-source dependencies. Original files are unchanged. */
export async function readOfflineSymbolModel(path: string, root: string): Promise<string> {
  const visited = new Set<string>(); let bytes = 0
  const sourceRoot = await realpath(root)
  async function read(current: string, depth: number): Promise<string> {
    const canonical = await realpath(current)
    if (!within(sourceRoot, canonical)) throw new Error('关联模型依赖超出原件来源目录')
    if (depth > 8 || visited.size >= 32) throw new Error('关联模型依赖超过 8 层或 32 个文件限制')
    if (visited.has(canonical.toLowerCase())) throw new Error('关联模型存在重复或循环 include；不能自动合并')
    visited.add(canonical.toLowerCase())
    const info = await stat(canonical); bytes += info.size
    if (bytes > 4 * 1024 * 1024) throw new Error('关联模型及依赖文件超过 4 MB')
    const text = decodeSpiceLibrary(await readFile(canonical))
    if (/<binary file>|\x00|\.protect\b|BEGIN\s+ENCRYPTED/i.test(text)) throw new Error('关联模型或依赖受保护、加密或是二进制，不能导入 ngspice')
    const lines: string[] = []
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*\.(?:include|inc)\b/i.test(line)) { lines.push(line); continue }
      const include = line.match(/^\s*\.(?:include|inc)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;]+))\s*(?:[;$].*)?$/i)
      const target = include?.[1] ?? include?.[2] ?? include?.[3]
      if (!target || /[\x00-\x1f{}:$]/.test(target) || isAbsolute(target)) throw new Error('关联模型依赖包含动态或绝对路径，不能自动合并')
      lines.push(await read(resolve(dirname(canonical), target.replaceAll('\\', '/')), depth + 1))
    }
    return lines.join('\n')
  }
  return read(path, 0)
}

function localOrigin(req: IncomingMessage): boolean { const host = req.headers.host; return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') && !!host && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host) && req.headers.origin === `http://${host}` && req.headers['sec-fetch-site'] !== 'cross-site' }
export function createOfflineSymbolMiddleware(root = offlineLibraryRoot()) {
  let cache: Promise<OfflineSymbolInventory> | undefined, readAt = 0
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split('?')[0]
    if (path !== '/api/offline-symbols/catalog' && path !== '/api/offline-symbols/detail') { next(); return }
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    const send = (code: number, value: unknown) => { res.statusCode = code; res.end(JSON.stringify(value)) }
    if (!localOrigin(req)) { send(403, { error: '离线符号库仅接受本机工作台同源请求' }); return }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(405, { error: '只接受 POST 请求' }); return }
    if (req.url?.includes('?') || Number(req.headers['content-length'] ?? 0) > 2048) { send(400, { error: '请求参数不合法' }); return }
    let input: Record<string, unknown>
    try { let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 2048) throw new Error() } input = JSON.parse(body || '{}'); if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error() }
    catch { send(400, { error: '请求内容不合法' }); return }
    try {
      if (!cache || Date.now() - readAt > 5 * 60_000 || input.refresh === true) { readAt = Date.now(); cache = indexOfflineSymbols(root); cache.catch(() => { cache = undefined }) }
      const inventory = await cache
      if (path.endsWith('/catalog')) {
        if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 100)) { send(400, { error: '搜索词最多 100 字' }); return }
        const offset = typeof input.offset === 'number' && Number.isInteger(input.offset) && input.offset >= 0 && input.offset <= MAX_FILES ? input.offset : 0
        send(200, searchOfflineSymbolAssets(inventory, typeof input.query === 'string' ? input.query : '', offset))
      } else {
        if (typeof input.id !== 'string' || input.id.length > 1200) { send(400, { error: '原件编号不合法' }); return }
        send(200, await readOfflineSymbolDetail(inventory, input.id))
      }
    } catch (reason) { send(422, { error: (reason as Error).message || '读取离线符号原件失败' }) }
  }
}
