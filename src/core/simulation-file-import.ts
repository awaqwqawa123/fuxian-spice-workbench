import { unzipSync } from 'fflate'
import type { Project } from './circuit'
import { importLtspiceSchematic } from './ltspice-import'
import { importSpiceDeck } from './spice-deck-import'

export interface SimulationImportFile { name: string; size: number; webkitRelativePath?: string; arrayBuffer(): Promise<ArrayBuffer> }
export interface SimulationImportEntry { path: string; format: 'asc' | 'spice' }
export interface SimulationImportBundle { entries: SimulationImportEntry[]; files: Record<string, string>; warnings: string[] }
export interface PreparedSimulationEntry { text: string; modelText: string; symbols: Record<string, string>; warnings: string[]; format: 'asc' | 'spice' }
export const SIMULATION_IMPORT_LIMITS = { files: 512, inputBytes: 32 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, depth: 32, compressionRatio: 1000 } as const
const entryExtensions = new Set(['asc', 'cir', 'net', 'sp', 'spice', 'inp', 'ckt'])
const textExtensions = new Set([...entryExtensions, 'asy', 'lib', 'mod', 'sub', 'inc', 'txt'])
const binaryExtensions = new Set(['dsn', 'opj', 'raw', 'dat'])
const extension = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''
const binaryError = (name: string) => `${name}：不支持原生二进制 Capture .dsn/.opj 或仿真结果 .raw/.dat。请在 Capture/PSpice 中导出 SPICE 文本网表（.cir/.net）并同时选择引用的模型库；LTspice 请选择 .asc。`
const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

/** Paths are virtual bundle paths only. Nothing is opened on the host filesystem. */
function safePath(raw: string): string {
  const path = raw.replace(/\\/g, '/')
  if (!path || /[\u0000-\u001f\u007f]/.test(path) || /^[/~]/.test(path) || /[:?#]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`不安全的导入路径：${raw.slice(0, 160)}`)
  return path
}

export function decodeSimulationText(bytes: Uint8Array, name: string): { text: string; warnings: string[] } {
  if (!bytes.length) throw new Error(`${name}：文件为空`)
  let encoding = 'utf-8', offset = 0, legacy = false
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2 }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2 }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3
  else if (bytes.length >= 8) {
    const sample = bytes.subarray(0, Math.min(bytes.length, 1024))
    let even = 0, odd = 0
    sample.forEach((byte, index) => { if (!byte) { if (index % 2) odd++; else even++ } })
    if (odd > sample.length / 5 && even < sample.length / 20) encoding = 'utf-16le'
    else if (even > sample.length / 5 && odd < sample.length / 20) encoding = 'utf-16be'
  }
  let text: string
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset)) }
  catch {
    if (encoding !== 'utf-8' || offset) throw new Error(`${name}：${encoding} 编码损坏或截断，未替换或丢弃字符；请重新导出文本文件。`)
    // Preserve every legacy byte. UTF-8 errors never turn into replacement characters.
    const windows = new TextDecoder('windows-1252', { fatal: true }).decode(bytes)
    let chinese = ''
    try { chinese = new TextDecoder('gb18030', { fatal: true }).decode(bytes) } catch { /* Not a valid Chinese Windows encoding. */ }
    if ((chinese.match(/[\u3400-\u9fff]/g)?.length ?? 0) >= 2) { text = chinese; encoding = 'GB18030' }
    else { text = windows; encoding = 'Windows-1252' }
    legacy = true
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/.test(text)) throw new Error(`${name}：包含二进制数据、未定义编码字节或损坏字符；请导出 UTF-8/UTF-16 文本，未猜测模型数值。`)
  return { text: text.replace(/\r\n?/g, '\n'), warnings: legacy ? [`${name}：按 ${encoding} 兼容编码读取，未使用替代字符；请核对非 ASCII 字符，若原软件使用其他系统代码页，请先另存为 UTF-8 后重试。`] : [] }
}

interface ZipEntry { name: string; size: number; compressed: number; checksum: number; offset: number }
const crcTable = Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); return crc >>> 0 })
function crc32(bytes: Uint8Array): number { let crc = 0xffffffff; for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]; return (crc ^ 0xffffffff) >>> 0 }

/** Validate directory, local headers, sizes, methods and overlapping ranges BEFORE inflation. */
function inspectZip(bytes: Uint8Array): ZipEntry[] {
  const fail = (): never => { throw new Error('ZIP 目录损坏，或使用了不支持的分卷 / ZIP64 / 加密格式。') }
  if (bytes.length < 22) return fail()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.length - 22
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break
  if (end < Math.max(0, bytes.length - 65557)) return fail()
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50)) return fail()
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directory = view.getUint32(end + 16, true)
  if (!count || count > SIMULATION_IMPORT_LIMITS.files) throw new Error(`ZIP 最多支持 ${SIMULATION_IMPORT_LIMITS.files} 个条目。`)
  if (view.getUint16(end + 8, true) !== count || directory + directorySize !== end) return fail()
  let at = directory, total = 0
  const entries: ZipEntry[] = [], ranges: [number, number][] = [], names = new Set<string>()
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) return fail()
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true), compressed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true)
    const length = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true), offset = view.getUint32(at + 42, true)
    if ((flags & ~0x80e) || ![0, 8].includes(method) || view.getUint16(at + 6, true) > 20 || view.getUint16(at + 34, true) || at + 46 + length + extra + comment > end) return fail()
    let name: string
    try { name = utf8(bytes.subarray(at + 46, at + 46 + length)) } catch { throw new Error('ZIP 条目名不是 UTF-8；请用 UTF-8 文件名重新压缩。') }
    const directoryEntry = name.endsWith('/')
    safePath(directoryEntry ? name.slice(0, -1) : name)
    if (names.has(name.toLowerCase())) throw new Error(`ZIP 包含大小写冲突或重复路径：${name}`)
    names.add(name.toLowerCase()); total += size
    if (size > SIMULATION_IMPORT_LIMITS.fileBytes || total > SIMULATION_IMPORT_LIMITS.expandedBytes) throw new Error('ZIP 解压后超过大小限制（单文件 16 MB，总计 64 MB）。')
    if ((size && !compressed) || (size > 1024 * 1024 && size / Math.max(1, compressed) > SIMULATION_IMPORT_LIMITS.compressionRatio)) throw new Error(`ZIP 条目压缩比例过高：${name}`)
    if (offset + 30 > directory || view.getUint32(offset, true) !== 0x04034b50 || view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method) return fail()
    const localLength = view.getUint16(offset + 26, true), localExtra = view.getUint16(offset + 28, true), data = offset + 30 + localLength + localExtra
    if (data + compressed > directory || utf8(bytes.subarray(offset + 30, offset + 30 + localLength)) !== name) return fail()
    if (!(flags & 8) && (view.getUint32(offset + 18, true) !== compressed || view.getUint32(offset + 22, true) !== size || view.getUint32(offset + 14, true) !== view.getUint32(at + 16, true))) return fail()
    if (ranges.some(([start, finish]) => offset < finish && data + compressed > start)) return fail()
    ranges.push([offset, data + compressed])
    if (directoryEntry && size) return fail()
    entries.push({ name, size, compressed, offset, checksum: view.getUint32(at + 16, true) })
    at += 46 + length + extra + comment
  }
  if (at !== end) return fail()
  return entries
}

export async function readSimulationBundle(selected: readonly SimulationImportFile[]): Promise<SimulationImportBundle> {
  if (!selected.length || selected.length > SIMULATION_IMPORT_LIMITS.files) throw new Error(`请选择 1–${SIMULATION_IMPORT_LIMITS.files} 个仿真文件或 ZIP。`)
  let inputSize = 0, expandedSize = 0, count = 0
  for (const file of selected) {
    if (!Number.isFinite(file.size) || file.size < 0) throw new Error(`${file.name}：无效的文件大小`)
    inputSize += file.size
  }
  if (inputSize > SIMULATION_IMPORT_LIMITS.inputBytes) throw new Error('所选文件合计超过 32 MB。')
  const bundle: SimulationImportBundle = { entries: [], files: Object.create(null) as Record<string, string>, warnings: [] }, paths = new Set<string>()
  const add = (raw: string, bytes: Uint8Array, archived: boolean) => {
    const path = safePath(raw), ext = extension(path)
    if (++count > SIMULATION_IMPORT_LIMITS.files) throw new Error(`导入文件总数超过 ${SIMULATION_IMPORT_LIMITS.files}。`)
    expandedSize += bytes.length
    if (bytes.length > SIMULATION_IMPORT_LIMITS.fileBytes || expandedSize > SIMULATION_IMPORT_LIMITS.expandedBytes) throw new Error('导入内容超过大小限制（单文件 16 MB，总计 64 MB）。')
    if (paths.has(path.toLowerCase())) throw new Error(`文件路径重复或大小写冲突：${path}；无法确定依赖引用。`)
    paths.add(path.toLowerCase())
    if (binaryExtensions.has(ext)) { if (!archived) throw new Error(binaryError(path)); bundle.warnings.push(binaryError(path)); return }
    if (!textExtensions.has(ext)) { if (!archived) throw new Error(`${path}：不支持此扩展名；请选择 .asc、.cir、.net、.sp、.spice、.inp、.ckt 或 ZIP，并附带 .asy/.lib/.mod/.sub/.inc 文本依赖。`); bundle.warnings.push(`${path}：不是受支持的电路或模型文本，已跳过。`); return }
    const decoded = decodeSimulationText(bytes, path)
    bundle.files[path] = decoded.text; bundle.warnings.push(...decoded.warnings)
    if (entryExtensions.has(ext)) bundle.entries.push({ path, format: ext === 'asc' ? 'asc' : 'spice' })
  }
  let actualInput = 0
  for (const file of selected) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    actualInput += bytes.length
    if (actualInput > SIMULATION_IMPORT_LIMITS.inputBytes) throw new Error('实际读取内容超过 32 MB。')
    if (extension(file.name) !== 'zip') { add(file.webkitRelativePath || file.name, bytes, false); continue }
    const entries = inspectZip(bytes)
    if (expandedSize + entries.reduce((total, entry) => total + entry.size, 0) > SIMULATION_IMPORT_LIMITS.expandedBytes || count + entries.length > SIMULATION_IMPORT_LIMITS.files) throw new Error('ZIP 与其他所选文件合计超过导入限制。')
    let unpacked: Record<string, Uint8Array>
    try { unpacked = unzipSync(bytes) } catch { throw new Error(`${file.name}：ZIP 解压失败。`) }
    for (const entry of entries) {
      const data = unpacked[entry.name]
      if (!data || data.length !== entry.size || crc32(data) !== entry.checksum) throw new Error(`${file.name}：ZIP 条目校验失败：${entry.name}`)
      if (!entry.name.endsWith('/')) add(entry.name, data, true)
    }
  }
  if (!bundle.entries.length) throw new Error('没有找到可打开的 .asc、.cir、.net、.sp、.spice、.inp 或 .ckt 电路入口。')
  return bundle
}

function tokens(line: string): string[] {
  const result: string[] = []
  let at = 0
  while (at < line.length) {
    while (/\s/.test(line[at] ?? '') && at < line.length) at++
    if (at === line.length || line[at] === ';' || line[at] === '$') break
    const quote = line[at] === '"' || line[at] === "'" ? line[at++] : ''
    const start = at
    if (quote) { while (at < line.length && line[at] !== quote) at++; if (at === line.length) throw new Error(`依赖路径缺少结束引号：${line}`); result.push(line.slice(start, at++)) }
    else { while (at < line.length && !/\s/.test(line[at])) at++; result.push(line.slice(start, at)) }
  }
  return result
}

/** Resolve dependencies deterministically from selected files, then call either importer. */
export function prepareSimulationEntry(bundle: SimulationImportBundle, entryPath: string): PreparedSimulationEntry {
  const entry = bundle.entries.find(candidate => candidate.path === entryPath)
  if (!entry || !Object.hasOwn(bundle.files, entryPath)) throw new Error(`未找到所选电路入口：${entryPath}`)
  const warnings = [...bundle.warnings], missing = new Set<string>(), symbols: Record<string, string> = Object.create(null) as Record<string, string>
  const paths = Object.keys(bundle.files), lookup = new Map(paths.map(path => [path.toLowerCase(), path]))
  if (lookup.size !== paths.length) throw new Error('导入包存在大小写冲突的文件路径。')
  let outputSize = 0
  const expandedDependencies = new Set<string>()
  const explicitDependencies = new Map<string, string>()
  const bounded = (text: string) => { outputSize += text.length * 2; if (outputSize > SIMULATION_IMPORT_LIMITS.expandedBytes) throw new Error('依赖展开后超过 64 MB，已停止递归加载。'); return text }
  const resolve = (reference: string, source: string, required = true): string | undefined => {
    const normalized = reference.replace(/\\/g, '/')
    if (!normalized || /^[/~]/.test(normalized) || /[:?#\u0000-\u001f]/.test(normalized)) throw new Error(`${source}：不支持外部、绝对或 URL 依赖路径 ${reference}；请改成包内相对路径。`)
    const parts = source.split('/').slice(0, -1)
    for (const part of normalized.split('/')) { if (!part || part === '.') continue; if (part === '..') { if (!parts.length) throw new Error(`${source}：依赖路径越出所选文件范围：${reference}`); parts.pop() } else parts.push(part) }
    const relative = lookup.get(parts.join('/').toLowerCase()), root = lookup.get(normalized.toLowerCase())
    if (relative || root) return relative ?? root
    const basename = normalized.split('/').pop()!.toLowerCase(), matches = paths.filter(path => path.split('/').pop()!.toLowerCase() === basename)
    if (matches.length > 1) throw new Error(`${source}：依赖 ${reference} 存在多个同名候选，无法确定：${matches.join('、')}`)
    if (matches.length === 1) { warnings.push(`${source}：依赖 ${reference} 按唯一文件名匹配到 ${matches[0]}；建议用 ZIP 保留原目录。`); return matches[0] }
    if (required) missing.add(`${source} → ${reference}`)
    return undefined
  }
  const sectionText = (text: string, section: string, path: string): string => {
    const lines = text.split('\n'), result: string[] = []
    let active = false, found = false
    for (const line of lines) {
      const open = line.match(/^\s*\.lib\s+(\S+)\s*(?:[$;].*)?$/i), close = line.match(/^\s*\.endl\b(?:\s+(\S+))?/i)
      if (open && !/[/.\\]/.test(open[1])) {
        if (active) throw new Error(`${path}：不支持嵌套 .lib 库段。`)
        if (open[1].toLowerCase() === section.toLowerCase()) { if (found) throw new Error(`${path}：库段 ${section} 重复。`); active = found = true }
        continue
      }
      if (close && active) { if (close[1] && close[1].toLowerCase() !== section.toLowerCase()) throw new Error(`${path}：.endl ${close[1]} 与库段 ${section} 不匹配。`); active = false; continue }
      if (active) result.push(line)
    }
    if (!found || active) throw new Error(`${path}：${found ? '库段未闭合' : '未找到库段'} ${section}。`)
    return result.join('\n')
  }
  const expand = (text: string, path: string, stack: string[], section?: string): string => {
    const key = `${path.toLowerCase()}#${section?.toLowerCase() ?? ''}`
    if (stack.includes(key)) throw new Error(`模型依赖循环：${[...stack, key].join(' → ')}`)
    if (stack.length >= SIMULATION_IMPORT_LIMITS.depth) throw new Error(`模型依赖递归超过 ${SIMULATION_IMPORT_LIMITS.depth} 层：${path}`)
    if (/^\s*(?:\.(?:protect|prot|unprotect)\b|\$CDNENC|\*?\$?BEGIN_ENCRYPTED)/im.test(text)) throw new Error(`${path}：包含加密或受保护模型，无法作为可验证 SPICE 文本导入；请取得明文、兼容 ngspice 的模型。`)
    const selectedText = section ? sectionText(text, section, path) : text
    const sectionEnds = selectedText.split('\n').filter(line => /^\s*\.endl\b/i.test(line)).map(line => tokens(line)[1]?.toLowerCase() ?? '')
    return selectedText.split('\n').map((line, index) => {
      if (!/^\s*\.(?:include|inc|lib)\b/i.test(line)) return bounded(line)
      const args = tokens(line), command = args.shift()!.toLowerCase()
      if (command === '.lib' && args.length === 1 && !/[.\\/]/.test(args[0]) && (sectionEnds.includes('') || sectionEnds.includes(args[0].toLowerCase()))) return bounded(line)
      if (!args.length || args.length > (command === '.lib' ? 2 : 1)) throw new Error(`${path}:${index + 1}：无效的 ${command} 依赖语法：${line}`)
      const dependency = resolve(args[0], `${path}`)
      if (!dependency) return ''
      if (!['lib', 'mod', 'sub', 'inc', 'txt', 'cir', 'net', 'sp', 'spice', 'inp', 'ckt'].includes(extension(dependency))) throw new Error(`${path}:${index + 1}：${args[0]} 不是支持的 SPICE 文本依赖。`)
      const dependencyKey = `${dependency.toLowerCase()}#${args[1]?.toLowerCase() ?? ''}`, source = `${path}:${index + 1}`
      // A dependency cycle has a more useful diagnostic than a duplicate include.
      if (explicitDependencies.has(dependencyKey) && ![...stack, key].includes(dependencyKey)) throw new Error(`${source}：重复引用依赖 ${dependency}${args[1] ? ` 库段 ${args[1]}` : ''}（首次引用 ${explicitDependencies.get(dependencyKey)}）；请移除重复 .include/.lib，未静默重复或合并模型定义。`)
      explicitDependencies.set(dependencyKey, source)
      expandedDependencies.add(dependencyKey)
      return expand(bundle.files[dependency], dependency, [...stack, key], args[1])
    }).join('\n')
  }
  let text = bundle.files[entryPath], modelText = ''
  if (entry.format === 'asc') {
    const dependencies: string[] = []
    const addModelFile = (reference: string, source: string) => {
      const args = tokens(reference)
      if (args.length !== 1) throw new Error(`${source}：无效的 ModelFile 路径 ${reference}`)
      const dependency = resolve(args[0], source)
      if (dependency && !expandedDependencies.has(`${dependency.toLowerCase()}#`)) {
        expandedDependencies.add(`${dependency.toLowerCase()}#`)
        dependencies.push(expand(bundle.files[dependency], dependency, []))
      }
    }
    text = text.split('\n').flatMap(line => {
      const directive = line.match(/^(\s*TEXT\s+\S+\s+\S+\s+\S+\s+\S+\s+!)([\s\S]*)$/i)
      if (!directive) return [line]
      const retained: string[] = []
      let changed = false
      for (const statement of directive[2].split(/\\n/g)) {
        if (/^\s*\.(?:include|inc|lib)\b/i.test(statement)) { dependencies.push(expand(statement, entryPath, [])); changed = true }
        else retained.push(statement)
      }
      return !changed ? [line] : retained.length ? [`${directive[1]}${retained.join('\\n')}`] : []
    }).join('\n')
    for (const line of text.split('\n')) {
      const modelFile = line.match(/^SYMATTR\s+ModelFile\s+(.+)$/i)
      if (modelFile) addModelFile(modelFile[1], entryPath)
      const symbol = line.match(/^SYMBOL\s+(\S+)\s+/i)
      if (!symbol) continue
      const reference = /\.asy$/i.test(symbol[1]) ? symbol[1] : `${symbol[1]}.asy`, path = resolve(reference, entryPath, false)
      if (!path) continue
      symbols[reference.replace(/\\/g, '/')] = bundle.files[path]
      // ASY can carry a model filename independently of ASC directives.
      for (const attribute of bundle.files[path].split('\n')) {
        const modelFile = attribute.match(/^SYMATTR\s+ModelFile\s+(.+)$/i)
        if (!modelFile) continue
        addModelFile(modelFile[1], path)
      }
    }
    modelText = dependencies.join('\n')
  } else text = expand(text, entryPath, [])
  if (missing.size) throw new Error(`缺少引用的 SPICE 依赖（仅从所选文件读取）：\n${[...missing].map(item => `• ${item}`).join('\n')}\n请同时选择这些文件，或将电路及依赖按原目录压缩为 ZIP。`)
  return { text, modelText, symbols, warnings: [...new Set(warnings)], format: entry.format }
}

export function importSimulationEntry(bundle: SimulationImportBundle, entryPath: string): { project: Project; warnings: string[]; format: string } {
  const prepared = prepareSimulationEntry(bundle, entryPath)
  const result = prepared.format === 'asc'
    ? importLtspiceSchematic(prepared.text, { sourceName: entryPath, symbols: prepared.symbols, modelText: prepared.modelText })
    : importSpiceDeck(prepared.text, { sourceName: entryPath, title: entryPath.split('/').pop()?.replace(/\.[^.]+$/, '') })
  return { ...result, warnings: [...new Set([...prepared.warnings, ...result.warnings])], format: prepared.format === 'asc' ? 'LTspice 原理图' : 'SPICE 文本网表' }
}
