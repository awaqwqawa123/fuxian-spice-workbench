import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserLibraryMiddleware } from '../server/user-library-middleware'
import { UserLibraryStore } from '../server/user-library-store'
import { createUserLibraryEntry, exportUserLibrary, loadUserLibrary } from '../src/core/user-library'
import { parseSpiceLibrary, type ImportedSpiceModel } from '../src/core/spice-models'
import type { ModelSymbol } from '../src/core/model-symbol'

test('SPICE import and JSON backup use durable storage and preserve each workflow’s conflict rules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fuxian-spice-user-import-')), middleware = createUserLibraryMiddleware({ directory })
  const server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404).end() }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, nativeFetch = globalThis.fetch
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:3035/' }), old = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, fetch: (url: string, init: RequestInit = {}) => nativeFetch(new URL(url, origin), { ...init, headers: { ...init.headers, Origin: origin } }) })) { old.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
  const { createRoot } = await import('react-dom/client'), { default: UserLibrary } = await import('../src/components/UserLibrary')
  const root = createRoot(dom.window.document.getElementById('root')!), placed: ImportedSpiceModel[] = []
  const button = (text: string) => { const element = [...dom.window.document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === text || item.textContent === text); assert.ok(element, text); return element }
  const click = async (text: string) => { await act(async () => button(text).click()) }
  const settle = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); assert.ok(condition(), dom.window.document.body.textContent ?? '') }
  const text = '.model LIB_DIO D(IS=2n N=1.1)\n.subckt LIB_RC INPUT OUTPUT REF\nR1 INPUT OUTPUT 2k\nC1 OUTPUT REF 2n\n.ends LIB_RC'
  const file = (name: string, content: string) => { const bytes = new TextEncoder().encode(content); const item = new dom.window.File([content], name); Object.defineProperty(item, 'arrayBuffer', { value: async () => bytes.buffer }); return item }
  async function picker(name: string, content: string) { await act(async () => { const input = dom.window.document.querySelector<HTMLInputElement>('[aria-label="选择自建库 SPICE 模型文件"]')!; Object.defineProperty(input, 'files', { configurable: true, value: [file(name, content)] }); input.dispatchEvent(new dom.window.Event('change', { bubbles: true })) }) }
  async function drop(name: string, content: string, count = 1) { await act(async () => { const event = new dom.window.Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: { files: Array.from({ length: count }, () => file(name, content)), types: ['Files'] } }); dom.window.document.querySelector('[aria-label="导入 SPICE 模型到自建库"]')!.dispatchEvent(event) }) }
  try {
    await act(async () => root.render(createElement(UserLibrary, { onPlace: model => placed.push(model) })))
    await click('导入与管理')
    await settle(() => !button('导入 SPICE 模型').disabled)
    assert.ok(dom.window.document.querySelector('[aria-label="导入自建库备份"]'), 'JSON backup stays separate')
    await picker('manufacturer.lib', text)
    await settle(() => !!dom.window.document.querySelector('[aria-label="选择自建库导入模型 LIB_RC"]'))
    assert.match(dom.window.document.body.textContent!, /1=INPUT \/ 2=OUTPUT \/ 3=REF/)
    assert.match(dom.window.document.querySelector('.user-spice-candidates')!.textContent!, /\.subckt LIB_RC INPUT OUTPUT REF/)
    assert.equal(loadUserLibrary().entries.length, 0, 'preview does not persist or place')
    await click('保存所选到自建库（2）')
    await settle(() => dom.window.document.querySelectorAll('.user-library-card').length === 2)
    assert.equal(placed.length, 0, 'import cannot change current circuit')
    let disk = JSON.parse(await readFile(join(directory, 'user-library.json'), 'utf8'))
    assert.equal(disk.entries.length, 2)
    assert.equal(disk.entries[0].model.source.label, 'manufacturer.lib')
    await act(async () => root.render(null)); dom.window.localStorage.clear()
    await act(async () => root.render(createElement(UserLibrary, { onPlace: model => placed.push(model) })))
    await click('导入与管理')
    await settle(() => dom.window.document.querySelectorAll('.user-library-card').length === 2 && !button('导入 SPICE 模型').disabled)
    await click('放置自建器件 LIB_RC')
    assert.deepEqual(placed[0].pins, ['INPUT', 'OUTPUT', 'REF']); assert.match(placed[0].spice, /R1 INPUT OUTPUT 2k/)
    assert.equal(placed[0].symbol!.pins.length, 3)
    await drop('manufacturer.lib', text)
    await settle(() => !!dom.window.document.querySelector('[aria-label="选择自建库导入模型 LIB_RC"]'))
    await click('保存所选到自建库（2）')
    await settle(() => /保留 2 个相同条目/.test(dom.window.document.body.textContent!))
    await drop('bad.lib', text, 2)
    assert.match(dom.window.document.body.textContent!, /每次请拖入一个模型文件/)
    assert.doesNotMatch(dom.window.document.body.textContent!, /已保存 0 个模型|保留 2 个相同条目/, 'new failed drop clears the previous saved notice')
    const before = await readFile(join(directory, 'user-library.json'), 'utf8')
    await picker('manufacturer.lib', '.model LIB_NEW D(IS=1n)\n.model lib_dio D(IS=9n N=2)')
    await settle(() => !!dom.window.document.querySelector('[aria-label="选择自建库导入模型 LIB_NEW"]'))
    await drop('bad.lib', text, 2)
    assert.equal(dom.window.document.querySelectorAll('.user-spice-candidates article').length, 0, 'invalid new drop cannot leave previous file selectable')
    assert.doesNotMatch(dom.window.document.body.textContent!, /保存所选到自建库/, 'old file cannot be submitted under a new file error')
    await picker('manufacturer.lib', '.model LIB_NEW D(IS=1n)\n.model lib_dio D(IS=9n N=2)')
    await settle(() => !!dom.window.document.querySelector('[aria-label="选择自建库导入模型 LIB_NEW"]'))
    await click('保存所选到自建库（2）')
    await settle(() => /冲突；未覆盖/.test(dom.window.document.body.textContent!))
    assert.equal(await readFile(join(directory, 'user-library.json'), 'utf8'), before, 'no partial LIB_NEW save when case-insensitive existing name conflicts')
    await drop('encrypted.mod', '.protect\n.model SECRET D(IS=1n)\n.unprotect')
    await settle(() => /二进制、加密或受保护/.test(dom.window.document.body.textContent!))
    assert.equal(dom.window.document.querySelectorAll('.user-spice-candidates article').length, 0)
    await drop('dependent.inc', '.include missing.lib\n.model DEP D(IS=1n)')
    await settle(() => /外部依赖/.test(dom.window.document.body.textContent!))
    disk = JSON.parse(await readFile(join(directory, 'user-library.json'), 'utf8')); assert.equal(disk.entries.length, 2)

    const changed = parseSpiceLibrary('.subckt LIB_RC INPUT OUTPUT REF\nR1 INPUT OUTPUT 4k\nC1 OUTPUT REF 2n\n.ends LIB_RC', { label: '旧安装模型', license: 'MIT', attribution: '测试制造商' }).models[0]
    const symbol: ModelSymbol = { version: 1, shape: 'ltspice', origin: 'imported', title: '原始符号', source: { label: 'LIB_RC.asy', sha256: 'e'.repeat(64) },
      pins: [{ index: 0, label: 'INPUT', number: '3', x: -40, y: 0 }, { index: 1, label: 'OUTPUT', number: '1', x: 40, y: 0 }, { index: 2, label: 'REF', number: '2', x: 0, y: 40 }],
      geometry: [{ type: 'rectangle', coords: [-20, -20, 20, 20] }, { type: 'line', coords: [-40, 0, -20, 0] }, { type: 'line', coords: [20, 0, 40, 0] }],
      annotations: [{ text: '原始文字', x: 0, y: -30, size: 10 }],
    }
    const incoming = createUserLibraryEntry({ ...changed, symbol })
    const backup = exportUserLibrary({ schemaVersion: 1, entries: [incoming, disk.entries.find((entry: { id: string }) => entry.id === 'user-lib_dio')] })
    const chooseBackup = async (content: string) => act(async () => {
      const input = dom.window.document.querySelector<HTMLInputElement>('[aria-label="导入自建库备份"]')!
      const selected = new dom.window.File([content], 'user-library.json')
      Object.defineProperty(selected, 'text', { value: async () => content })
      Object.defineProperty(input, 'files', { configurable: true, value: [selected] })
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    await chooseBackup(backup)
    const preview = () => dom.window.document.querySelector('[aria-label="自建库备份预览"]')
    await settle(() => !!preview())
    assert.match(preview()!.textContent!, /2 个模型 · 2 个符号/)
    assert.match(preview()!.textContent!, /LIB_RC_backup2/)
    assert.equal(await readFile(join(directory, 'user-library.json'), 'utf8'), before, 'preview has no write side effects')
    await click('取消导入备份')
    assert.equal(preview(), null)
    assert.equal(await readFile(join(directory, 'user-library.json'), 'utf8'), before)

    const concurrent = createUserLibraryEntry(parseSpiceLibrary('.model LIB_RC_backup2 D(IS=5n)', { label: '另一窗口' }).models[0])
    await chooseBackup(backup)
    const other = new UserLibraryStore(directory)
    await other.merge({ schemaVersion: 1, entries: [concurrent] })
    const concurrentDisk = await readFile(join(directory, 'user-library.json'), 'utf8')
    await click('确认合并备份')
    await settle(() => /在预览后已有变化/.test(dom.window.document.body.textContent!) && /LIB_RC_backup3/.test(preview()?.textContent ?? ''))
    assert.equal(await readFile(join(directory, 'user-library.json'), 'utf8'), concurrentDisk, 'stale preview does not write')
    await click('取消导入备份')
    await other.remove(concurrent.id)
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')))
    await settle(() => dom.window.document.querySelectorAll('.user-library-card').length === 2)

    await chooseBackup(backup)
    await click('确认合并备份')
    await settle(() => preview() === null && dom.window.document.querySelectorAll('.user-library-card').length === 3)
    disk = JSON.parse(await readFile(join(directory, 'user-library.json'), 'utf8'))
    const restored = disk.entries.find((entry: { id: string }) => entry.id === 'user-lib_rc_backup2')
    assert.match(restored.model.spice, /\.subckt LIB_RC_backup2 INPUT OUTPUT REF[\s\S]*4k[\s\S]*\.ends LIB_RC_backup2/)
    assert.deepEqual(restored.model.symbol, incoming.model.symbol)
    assert.deepEqual(restored.model.source, incoming.model.source)
    assert.match(disk.entries.find((entry: { id: string }) => entry.id === 'user-lib_rc').model.spice, /2k/)
    await chooseBackup(backup)
    await click('确认合并备份')
    await settle(() => preview() === null && [...dom.window.document.querySelectorAll('[role="status"]')].some(node => /已存在 2 个/.test(node.textContent ?? '')))
    assert.equal(dom.window.document.querySelectorAll('.user-library-card').length, 3, 'reimport does not duplicate a kept version')
    await chooseBackup('{"schemaVersion":1,"entries":[{"model":"broken"}]}')
    await settle(() => /导入模型数据格式错误/.test(dom.window.document.body.textContent!))
    assert.equal(preview(), null, 'invalid selection clears any previous preview')
  } finally { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) }
})
