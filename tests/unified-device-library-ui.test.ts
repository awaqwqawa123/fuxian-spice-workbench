import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import DeviceLibrary from '../src/components/DeviceLibrary'
import SpiceLibrary from '../src/components/SpiceLibrary'
import { blankProject } from '../src/core/editor'
import { parseSpiceLibrary, type ImportedSpiceModel } from '../src/core/spice-models'
import { createUserLibraryEntry } from '../src/core/user-library'

test('one extension dialog retains import drafts across modes, saves exact source, opens editing and restores the custom library', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost:3032/' })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  const custom = parseSpiceLibrary('.model MY_LIBRARY_D D(IS=2n RS=.4)', { label: 'User supplied reference' }).models[0]
  const document = { schemaVersion: 1, entries: [createUserLibraryEntry(custom, '已保存的自建二极管')] }
  const fetch = async (url: unknown) => {
    if (url === '/api/user-library') return Response.json({ document })
    if (url === '/api/model-library/browse') return Response.json({ groups: [], counts: [], libraries: [], total: 0, offset: 0, limit: 40 })
    return Response.json({ models: [], files: [], candidates: [], symbols: [] })
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, fetch })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('root')!)
  let project = blankProject(), edited = '', rejectPlacement = false
  const placed: ImportedSpiceModel[] = []
  function Harness() {
    const [current, update] = useState(project), [search, onSearch] = useState(''), [category, onCategory] = useState('全部')
    const searchInput = useRef<HTMLInputElement>(null)
    project = current
    return createElement(DeviceLibrary, {
      search, onSearch, category, onCategory, searchInput, projectModels: current.models,
      onPlace: () => assert.fail('this task selects concrete models'), onPlaceModel: model => { if(rejectPlacement)throw new Error('同名模型定义冲突，请先另存名称'); placed.push(model) },
      renderModelManager: onClose => createElement(SpiceLibrary, {
        embedded: true, initialPage: 'project', project: current,
        onChange: models => update(value => ({ ...value, models })),
        onPlace: model => { placed.push(model); onClose() },
        onEditModel: id => { edited = id; onClose() }, onClose,
      }),
    })
  }
  const doc = dom.window.document
  const dialog = () => doc.querySelector('[role="dialog"][aria-label="拓展器件"]')
  const button = (name: string) => {
    const node = [...doc.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === name || item.textContent?.trim() === name)
    assert.ok(node, name); return node
  }
  const click = async (name: string) => act(async () => { button(name).click() })
  const input = async (label: string, value: string) => act(async () => {
    const node = doc.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
    Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  try {
    await act(async () => root.render(createElement(Harness)))
    assert.equal(doc.querySelector('.common-device-library input'), null, 'left panel has no duplicate model search')
    await act(async () => { doc.querySelector<HTMLButtonElement>('.library-extension-toggle')!.click() })
    await click('工程模型与导入页面'); await click('导入模型')
    const source = '.model IMPORTED_NPN NPN(IS=1f BF=240 VAF=85)'
    await input('SPICE 模型文本', source)
    const draft = doc.querySelector<HTMLTextAreaElement>('[aria-label="SPICE 模型文本"]')!
    await click('自建库')
    assert.ok(button('放置自建器件 已保存的自建二极管'), 'durable custom entries remain reachable')
    await click('工程模型与导入页面')
    assert.equal(doc.querySelector('[aria-label="SPICE 模型文本"]'), draft, 'same mounted importer survives a mode switch')
    assert.equal(draft.value, source)
    assert.equal(doc.querySelectorAll('[role="dialog"]').length, 1, 'import never opens a competing library dialog')
    await click('解析并预览'); await click('导入所选模型（1）')
    assert.equal(project.models?.[0].id, 'IMPORTED_NPN')
    assert.equal(project.models?.[0].spice, parseSpiceLibrary(source,{label:'用户导入'}).models[0].spice)
    assert.match(dialog()!.textContent!, /BF.*240/)
    await click('编辑模型 IMPORTED_NPN')
    assert.equal(edited, 'IMPORTED_NPN'); assert.equal(dialog(), null, 'editing hands off after closing the library')
    await act(async () => { doc.querySelector<HTMLButtonElement>('.library-extension-toggle')!.click() })
    await click('自建库')
    rejectPlacement=true
    await click('放置自建器件 已保存的自建二极管')
    assert.ok(dialog(),'a failed placement keeps the picker open')
    assert.match(dialog()!.textContent!,/同名模型定义冲突/)
    assert.equal(placed.length,0,'the failed handoff never claims placement succeeded')
    rejectPlacement=false
    await click('放置自建器件 已保存的自建二极管')
    assert.equal(placed.at(-1)?.id, custom.id)
    assert.equal(placed.at(-1)?.spice, custom.spice)
    assert.deepEqual(placed.at(-1)?.source, custom.source)
    assert.equal(dialog(), null, 'custom model placement returns to the canvas')
    assert.equal(project.models?.[0].id, 'IMPORTED_NPN', 'browsing another library does not replace saved project models')
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})
