import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import { findManagedCursorExecutable, resolveCursorLaunch } from './cursor-launch'
const VERSION = /^\d{4}\.\d{2}\.\d{2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]{5,40}$/
export interface CursorInstallOptions { directory?: string; signal: AbortSignal; fetch?: typeof fetch; platform?: string; arch?: string }
/** Official installer metadata is data, never executed. Install is confined to runtime/cursor-agent. */
export async function installManagedCursor(options: CursorInstallOptions): Promise<string> {
  const directory = options.directory ?? process.cwd(), existing = await findManagedCursorExecutable(directory)
  if (existing) { await resolveCursorLaunch(existing); return existing }
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('本机自动安装目前支持 Cursor 官方 Windows 原生包；其它系统请使用官方安装入口')
  const arch = options.arch ?? process.arch
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Cursor 官方包不支持本机 CPU 架构')
  const request = options.fetch ?? fetch
  const metadataResponse = await request('https://cursor.com/install?win32=true', { signal: options.signal })
  if (!metadataResponse.ok || new URL(metadataResponse.url || 'https://cursor.com').hostname !== 'cursor.com') throw new Error('Cursor 官方安装元数据下载失败')
  const metadata = await metadataResponse.text()
  if (metadata.length > 64000) throw new Error('Cursor 官方安装信息超过上限')
  const version = metadata.match(/\$version\s*=\s*'([^']+)'/)?.[1], base = metadata.match(/\$downloadUrl\s*=\s*'([^']+)'/)?.[1]
  if (!version || !VERSION.test(version) || base !== 'https://downloads.cursor.com/lab/' + version + '/') throw new Error('Cursor 官方安装元数据格式变化，请通过官方入口安装')
  const url = base + 'windows/' + arch + '/agent-cli-package.zip'
  const head = await request(url, { method: 'HEAD', signal: options.signal })
  const total = Number(head.headers.get('content-length'))
  if (!head.ok || !Number.isSafeInteger(total) || total < 1 || total > 128 * 1024 * 1024) throw new Error('Cursor 官方安装包大小无效')
  const chunkSize = Math.ceil(total / 8)
  const pieces = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const start = index * chunkSize, end = Math.min(total - 1, start + chunkSize - 1)
    if (start >= total) return new Uint8Array()
    const response = await request(url, { headers: { Range: 'bytes=' + start + '-' + end }, signal: options.signal })
    if (response.status !== 206 || new URL(response.url || url).hostname !== 'downloads.cursor.com') throw new Error('Cursor 官方安装包分段下载失败，请重试')
    if (response.headers.get('content-range') !== 'bytes ' + start + '-' + end + '/' + total) throw new Error('Cursor 安装包分段校验失败')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length !== end - start + 1) throw new Error('Cursor 安装包未完整下载')
    return bytes
  }))
  options.signal.throwIfAborted()
  const archive = new Uint8Array(total); let offset = 0
  for (const piece of pieces) { archive.set(piece, offset); offset += piece.length }
  let entries = 0, unpacked = 0
  const files = unzipSync(archive, { filter(file) {
    if (++entries > 8000 || (unpacked += file.originalSize) > 512 * 1024 * 1024 || file.originalSize > 150 * 1024 * 1024) throw new Error('Cursor 安装包解压超过上限')
    if (!file.name.startsWith('dist-package/') || file.name.includes('\\') || file.name.split('/').includes('..') || file.name.includes('\0')) throw new Error('Cursor 安装包包含不安全路径')
    return !file.name.endsWith('/')
  } })
  const root = resolve(directory, 'runtime', 'cursor-agent'); await mkdir(root, { recursive: true })
  const pending = await mkdtemp(join(root, '.install-'))
  try {
    for (const [name, bytes] of Object.entries(files)) {
      options.signal.throwIfAborted()
      const relative = name.slice('dist-package/'.length), destination = join(pending, relative)
      await mkdir(resolve(destination, '..'), { recursive: true }); await writeFile(destination, bytes)
    }
    await resolveCursorLaunch(join(pending, 'cursor-agent.cmd'))
    const destination = join(root, version)
    await rename(pending, destination).catch(async error => {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await resolveCursorLaunch(join(destination, 'cursor-agent.cmd'))
    })
    await writeFile(join(root, 'active.json'), JSON.stringify({ version, origin: url }), { mode: 0o600 })
    return join(destination, 'cursor-agent.cmd')
  } finally { await rm(pending, { recursive: true, force: true }).catch(() => {}) }
}
