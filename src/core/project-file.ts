import { strToU8, unzipSync, zipSync } from 'fflate'
import { parseProject, validateProject, type Project } from './circuit'
import { modelFor } from './devices'

/** File-level limits are checked again against actual bytes, not just File.size. */
export const MAX_PROJECT_FILE_BYTES = 32 * 1024 * 1024
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024
const entryLimits: Record<string, number> = { 'project.json': MAX_EXPANDED_BYTES - 128 * 1024, 'manifest.json': 64 * 1024, 'README.txt': 64 * 1024 }
const format = 'fuxian-project'
const version = 1
export interface ProjectFileInput { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }
export interface OpenedProjectFile { project: Project; format: string; warnings: string[] }

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  return crc >>> 0
})
function crc32(bytes: Uint8Array): string {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const json = (bytes: Uint8Array, name: string): unknown => {
  try { return JSON.parse(decode(bytes)) } catch { throw new Error(`${name} 不是有效的 UTF-8 JSON，文件可能已损坏` ) }
}

/** Only application project fields survive; local account/chat/runtime state never enters the file. */
function cleanProject(raw: unknown): Project {
  return parseProject(raw, { allowDraft: true })
}
export function projectFileWarnings(project: Project): string[] {
  const missing = (project.drawing?.devices ?? []).filter(device => ['D', 'Q', 'M', 'J', 'X'].includes(device.kind) && !modelFor(device.kind, device.value, project.models))
  const warnings = missing.map(device => `${device.id}：模型 ${device.value || '（未指定）'} 未包含在工程中，也不是当前软件内置模型；请补齐模型后仿真。`)
  const other = validateProject(project).filter(message => !missing.some(device => message.startsWith(`${device.id}：请选择受支持的器件模型`)))
  if (other.length) warnings.push(`工程保留了未完成的设置，运行前请检查：${other.slice(0, 8).join('；')}${other.length > 8 ? `；另有 ${other.length - 8} 项` : ''}`)
  return warnings
}
function assertEmbeddedDependencies(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Project).models)) return
  for (const model of (raw as Project).models!) {
    if (typeof model?.spice === 'string' && /^\s*\.(?:include|inc|lib)\b/im.test(model.spice)) {
      throw new Error(`模型 ${model.id || '（未命名）'} 仍引用外部 SPICE 库；请先将依赖完整导入工程再保存独立文件。`)
    }
  }
}

export function projectFileName(project: Pick<Project, 'title'>): string {
  let name = project.title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 72).replace(/[. ]+$/g, '')
  if (!name) name = '未命名电路'
  if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `工程_${name}`
  return `${name}.fuxian`
}

export function createProjectArchive(project: Project): Uint8Array {
  assertEmbeddedDependencies(project)
  const clean = cleanProject(project), projectBytes = strToU8(JSON.stringify(clean, null, 2)), warnings = projectFileWarnings(clean)
  if (projectBytes.length > entryLimits['project.json']) throw new Error('工程展开后超过 64 MB，请拆分工程或移除未使用的模型。')
  const manifest = {
    format, version, application: 'Fuxian SPICE Workbench', createdAt: new Date().toISOString(), resultPolicy: 'configuration-only',
    project: { path: 'project.json', bytes: projectBytes.length, crc32: crc32(projectBytes) },
    models: { embedded: clean.models?.length ?? 0, symbols: clean.models?.filter(model => model.symbol).length ?? 0 },
    warnings,
  }
  const readme = [
    '伏线独立工程文件 · .fuxian · 格式版本 1',
    '在伏线的“打开工程文件”中选择本文件；打开为新项目，不覆盖已有工程。',
    'project.json 包含电路、探针、仿真配置、波形图配置、报告设置及工程内嵌模型和符号。',
    '此文件不包含求解器采样、历史运行结果、聊天、账号密钥和整份本机模型库。打开后重新运行仿真以生成波形。',
    '模型与符号的来源、许可说明随工程保留；分享时请遵守各自的再分发许可。',
    '内置器件使用接收端伏线提供的内置模型；自定义模型的依赖须已内嵌。',
    'ZIP 条目 CRC32 和 manifest 校验用于发现损坏，并非签名或来源认证。',
    ...warnings.map(warning => `注意：${warning}`),
  ].join('\n')
  const files = { 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)), 'project.json': projectBytes, 'README.txt': strToU8(readme) }
  for (const [name, bytes] of Object.entries(files)) if (bytes.length > entryLimits[name]) throw new Error(`${name} 超过工程格式大小限制`)
  const archive = zipSync(files, { level: 6 })
  if (archive.length > MAX_PROJECT_FILE_BYTES) throw new Error('工程文件超过 32 MB，请拆分工程或移除未使用的模型。')
  return archive
}

interface ZipEntry { name: string; size: number; compressed: number; checksum: string; offset: number; flags: number; method: number }
/** Inspect central AND local records before allocating decompressed output. Never extract paths to disk. */
function inspectArchive(bytes: Uint8Array): ZipEntry[] {
  const fail = (): never => { throw new Error('工程包目录损坏或使用了不受支持的 ZIP 格式') }
  if (bytes.length < 22) return fail()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // Version 1 never writes a ZIP comment. Requiring the fixed final record also
  // prevents another EOCD signature inside a comment from fooling the inflater.
  const end = bytes.length - 22
  if (view.getUint32(end, true) !== 0x06054b50 || view.getUint16(end + 20, true) || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) return fail()
  if (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) return fail()
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directory = view.getUint32(end + 16, true)
  if (count !== 3 || view.getUint16(end + 8, true) !== count || directory + directorySize !== end) return fail()
  const entries: ZipEntry[] = [], names = new Set<string>(), ranges: [number, number][] = []
  let at = directory, total = 0
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) return fail()
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true), length = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true)
    const offset = view.getUint32(at + 42, true)
    if ((flags & ~0x80e) || ![0, 8].includes(method) || extra || comment || view.getUint16(at + 6, true) > 20 || view.getUint16(at + 34, true) || at + 46 + length > end) return fail()
    const name = decode(bytes.subarray(at + 46, at + 46 + length))
    if (!Object.hasOwn(entryLimits, name) || names.has(name)) throw new Error(`工程包含不支持或重复的条目：${name.slice(0, 100)}`)
    names.add(name); total += size
    if (size > entryLimits[name] || total > MAX_EXPANDED_BYTES) throw new Error('工程包解压后超过大小限制，已拒绝加载。')
    if (offset + 30 > directory || view.getUint32(offset, true) !== 0x04034b50 || view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method) return fail()
    const localLength = view.getUint16(offset + 26, true), localExtra = view.getUint16(offset + 28, true), data = offset + 30 + localLength + localExtra
    if (data + compressed > directory || decode(bytes.subarray(offset + 30, offset + 30 + localLength)) !== name) return fail()
    if (!(flags & 8) && (view.getUint32(offset + 18, true) !== compressed || view.getUint32(offset + 22, true) !== size || view.getUint32(offset + 14, true) !== view.getUint32(at + 16, true))) return fail()
    if (ranges.some(([start, end]) => offset < end && data + compressed > start)) return fail()
    ranges.push([offset, data + compressed])
    entries.push({ name, size, compressed, offset, flags, method, checksum: view.getUint32(at + 16, true).toString(16).padStart(8, '0') })
    at += 46 + length + extra + comment
  }
  if (at !== end || names.size !== 3) return fail()
  return entries
}

export async function readProjectFile(file: ProjectFileInput): Promise<OpenedProjectFile> {
  if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_PROJECT_FILE_BYTES) throw new Error('工程文件最多支持 32 MB')
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (!['fuxian', 'json'].includes(extension ?? '')) throw new Error('请选择 .fuxian 独立工程文件或旧版 .json 工程。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!bytes.length || bytes.length > MAX_PROJECT_FILE_BYTES) throw new Error('工程文件为空或超过 32 MB')
  if (extension === 'json') {
    const raw = json(bytes, 'JSON 工程'); assertEmbeddedDependencies(raw)
    const project = cleanProject(raw)
    return { project, format: 'JSON 工程', warnings: projectFileWarnings(project) }
  }
  const entries = inspectArchive(bytes)
  let files: Record<string, Uint8Array>
  try { files = unzipSync(bytes) } catch { throw new Error('工程包解压失败，文件可能已损坏') }
  for (const entry of entries) {
    const data = files[entry.name]
    if (!data || data.length !== entry.size || crc32(data) !== entry.checksum) throw new Error(`工程包校验失败：${entry.name} 已损坏。`)
  }
  const rawManifest = json(files['manifest.json'], 'manifest.json')
  if (!rawManifest || typeof rawManifest !== 'object' || Array.isArray(rawManifest)) throw new Error('工程包缺少有效清单')
  const manifest = rawManifest as Record<string, unknown>
  if (manifest.format !== format || manifest.version !== version) throw new Error('不支持此工程包格式或版本，请更新伏线后重试。')
  const record = manifest.project as Record<string, unknown> | undefined
  if (manifest.resultPolicy !== 'configuration-only' || !record || record.path !== 'project.json' || record.bytes !== files['project.json'].length || record.crc32 !== crc32(files['project.json'])) throw new Error('工程包项目清单与实际内容不一致，文件可能已损坏。')
  const raw = json(files['project.json'], 'project.json'); assertEmbeddedDependencies(raw)
  const project = cleanProject(raw)
  return { project, format: '伏线工程包', warnings: projectFileWarnings(project) }
}
