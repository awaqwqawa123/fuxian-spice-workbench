import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, createRef } from 'react'
import { JSDOM } from 'jsdom'
import DeviceLibrary from '../src/components/DeviceLibrary'
import { parseSpiceLibrary } from '../src/core/spice-models'
import { createUserLibraryEntry } from '../src/core/user-library'

test('visible custom-library entry opens its existing picker despite a new sidebar search, preserves project and restores focus', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:3032/' }), previous = new Map<string, PropertyDescriptor | undefined>()
  const model = parseSpiceLibrary('.model MY_SAVED_NPN NPN(IS=1f BF=180)', { label: 'Local test fixture' }).models[0]
  const document = { schemaVersion: 1, entries: [createUserLibraryEntry(model)] }
  const projectModels = [model], original = JSON.stringify(projectModels), placed: string[] = [], visibility: boolean[] = []
  const fetch = async (url: unknown) => url === '/api/user-library'
    ? Response.json({ document })
    : Response.json({ groups: [], counts: [], libraries: [], total: 0, offset: 0, limit: 40 })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, fetch })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('root')!), doc = dom.window.document
  const render = (search: string) => createElement(DeviceLibrary, {
    search, onSearch: () => {}, category: '全部', onCategory: () => {}, searchInput: createRef<HTMLInputElement>(),
    projectModels, onPlace: () => assert.fail('browsing must not place a generic device'), onPlaceModel: value => placed.push(value.id), onDialogChange: value => visibility.push(value),
  })
  const dialog = () => doc.querySelector('[role="dialog"][aria-label="拓展器件"]')
  try {
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
    await act(async () => { doc.querySelector<HTMLButtonElement>('[aria-label="关闭拓展器件"]')!.click() })
    assert.equal(dialog(), null)
    assert.equal(doc.activeElement, direct)
    assert.equal(direct.getAttribute('aria-expanded'), 'false')
    await act(async () => root.render(render('ANOTHER_QUERY')))
    await act(async () => { direct.focus(); direct.click() })
    assert.ok(dialog()?.querySelector('[aria-label="自建器件库"]'))
    await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(dialog(), null)
    assert.equal(doc.activeElement, direct)
    assert.deepEqual(visibility, [true, false, true, false])
    assert.equal(JSON.stringify(projectModels), original)
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})
