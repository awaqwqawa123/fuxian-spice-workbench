import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, createRef } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DeviceLibrary from '../src/components/DeviceLibrary'
import { parseSpiceLibrary, type ImportedSpiceModel } from '../src/core/spice-models'
import { saveGeneratedModels } from '../server/generated-model-library'
import { createUserLibraryMiddleware } from '../server/user-library-middleware'
import { UserLibraryStore } from '../server/user-library-store'

test('opening the self-built library shows models saved by the assistant without opening import tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fuxian-model-library-picker-'))
  const store = new UserLibraryStore(directory), middleware = createUserLibraryMiddleware({ directory })
  const server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404).end() }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, nativeFetch = globalThis.fetch
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:3032/' }), previous = new Map<string, PropertyDescriptor | undefined>()
  const parsed = parseSpiceLibrary('.subckt MY_SAVED_MODEL VIN VOUT\nR1 VIN VOUT 1k\n.ends MY_SAVED_MODEL', { label: '从规格书建模' }).models[0]
  const model: ImportedSpiceModel = { ...parsed, symbol: { version: 1, shape: 'ltspice', origin: 'imported', title: '原始器件符号',
    pins: [{ index: 0, label: 'VIN', number: '5', x: -40, y: 0 }, { index: 1, label: 'VOUT', number: '2', x: 40, y: 0 }],
    geometry: [{ type: 'rectangle', coords: [-25, -15, 25, 15] }, { type: 'line', coords: [-40, 0, -25, 0] }, { type: 'line', coords: [25, 0, 40, 0] }],
  } }
  const projectModels = [model], original = JSON.stringify(projectModels), placed: ImportedSpiceModel[] = [], visibility: boolean[] = []
  let simulateUnavailable = true, rejectRead: (() => void) | undefined
  const fetch = async (url: string, init: RequestInit = {}) => {
    if (url !== '/api/user-library') return Response.json({ groups: [], counts: [], libraries: [], total: 0, offset: 0, limit: 40 })
    if (simulateUnavailable) await new Promise<void>((_resolve, reject) => { rejectRead = () => reject(new Error('test connection closed')) })
    return nativeFetch(new URL(url, origin), { ...init, headers: { ...init.headers, Origin: origin } })
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, fetch })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('root')!), doc = dom.window.document
  const render = (search: string) => createElement(DeviceLibrary, {
    search, onSearch: () => {}, category: '全部', onCategory: () => {}, searchInput: createRef<HTMLInputElement>(),
    projectModels, onPlace: () => assert.fail('browsing must not place a generic device'), onPlaceModel: value => placed.push(value), onDialogChange: value => visibility.push(value),
  })
  const dialog = () => doc.querySelector('[role="dialog"][aria-label="拓展器件"]')
  const settle = async (condition: () => boolean) => {
    for (let count = 0; count < 200 && !condition(); count++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.ok(condition(), dialog()?.textContent ?? 'library dialog closed')
  }
  const close = async () => act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="关闭拓展器件"]')!.click())
  const card = () => dialog()?.querySelector<HTMLButtonElement>('[aria-label="放置自建器件 MY_SAVED_MODEL"]')
  try {
    const result = await saveGeneratedModels([{ id: 'derived-example', origin: 'derived', model, evidence: ['datasheet'], limitations: [] }], store)
    assert.equal(result[0].status, 'saved', result[0].message)
    const stored = (await store.load()).entries[0].model
    await act(async () => root.render(render('NEW_QUERY')))
    const direct = doc.querySelector<HTMLButtonElement>('button[aria-label="打开自建库"]')!
    assert.ok(direct && !direct.closest('[hidden], [role="dialog"]'), 'self-built library is directly discoverable in the sidebar')
    assert.ok(doc.querySelector('.common-device-grid'))
    assert.ok(doc.querySelector('.library-extension-toggle:not(.library-user-toggle)'))
    await act(async () => { direct.focus(); direct.click() })
    assert.ok(dialog()?.querySelector('[aria-label="自建器件库"]'))
    assert.ok(dialog()?.querySelector('[aria-label="搜索自建器件"]'))
    assert.equal(dialog()?.querySelector('[aria-label="搜索本地器件"]'), null, 'new sidebar query cannot reset an explicit user-library request')
    assert.equal(doc.querySelectorAll('[role="dialog"]').length, 1)
    assert.equal(direct.getAttribute('aria-expanded'), 'true')
    assert.equal(placed.length, 0)
    assert.equal(JSON.stringify(projectModels), original)
    assert.match(dialog()!.textContent!, /正在读取本机自建库/)
    assert.equal(dialog()?.querySelector('.user-library-empty'), null)
    await act(async () => rejectRead!())
    assert.match(dialog()!.querySelector('[role="alert"]')!.textContent!, /无法连接本机自建库/)
    assert.equal(dialog()?.querySelector('.user-library-empty'), null, 'read error cannot claim this installation is empty')
    simulateUnavailable = false
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('.user-library-load-error button')!.click())
    await settle(() => Boolean(card()))
    assert.ok(dialog()?.querySelector('.user-library-manage-panel[hidden]'), 'opening shows devices, not library management')
    assert.ok(card()?.querySelector('svg'), 'the stored original symbol is visible on the card')
    await close()
    assert.equal(dialog(), null)
    assert.equal(doc.activeElement, direct)
    assert.equal(direct.getAttribute('aria-expanded'), 'false')
    dom.window.localStorage.clear()
    await act(async () => root.render(render('ANOTHER_QUERY')))
    await act(async () => { direct.focus(); direct.click() })
    assert.ok(dialog()?.querySelector('[aria-label="自建器件库"]'))
    await settle(() => Boolean(card()))
    await act(async () => card()!.click())
    assert.deepEqual(placed[0], stored, 'reopening with no browser cache preserves code, geometry and original pin order')
    assert.equal(dialog(), null)
    await act(async () => direct.click())
    await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(dialog(), null)
    assert.equal(doc.activeElement, direct)
    assert.deepEqual(visibility, [true, false, true, false, true, false])
    assert.equal(JSON.stringify(projectModels), original)
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true })
  }
})
