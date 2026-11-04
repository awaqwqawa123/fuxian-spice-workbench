import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserLibraryMiddleware } from '../server/user-library-middleware'
import { loadUserLibrary } from '../src/core/user-library'
import type { ImportedSpiceModel } from '../src/core/spice-models'

test('SPICE file picker and drop import directly to durable library, restore/place, and reject conflicts atomically', async () => {
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
  } finally { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) }
})
