import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import DeviceLibrary from '../src/components/DeviceLibrary'

test('the actual local-library dialog closes by every exit, cancels reads and restores the canvas without losing filters', async () => {
  const dom = new JSDOM('<div id="root"></div><div id="already-inert" inert></div>', { url: 'http://localhost:3032/' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const requests: { body: Record<string, unknown>; signal: AbortSignal }[] = []
  let pendingNext = false
  const fetch = async (url: unknown, options?: RequestInit) => {
    if (String(url) !== '/api/model-library/browse') return Response.json({ candidates: [] })
    const signal = options!.signal as AbortSignal
    const body = JSON.parse(String(options!.body)) as Record<string, unknown>
    requests.push({ body, signal })
    if (pendingNext) {
      pendingNext = false
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    }
    return Response.json({
      groups: [], total: 0, offset: body.offset, limit: body.limit,
      counts: [{ id: '', label: '全部型号', count: 12 }, { id: 'diode', label: '二极管', count: 12 }],
      subcategories: [{ id: 'diode:schottky', group: 'diode', label: '肖特基二极管', count: 12 }],
      libraries: [{ id: 'ltspice', count: 12 }],
    })
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, fetch })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  function Harness() {
    const [search, onSearch] = useState(''), [category, onCategory] = useState('全部')
    const searchInput = useRef<HTMLInputElement>(null)
    return createElement(DeviceLibrary, { search, onSearch, category, onCategory, searchInput, onPlace: () => assert.fail('closing must not place a component') })
  }
  const doc = dom.window.document
  const dialog = () => doc.querySelector<HTMLElement>('[role="dialog"][aria-label="拓展器件"]')
  const labeled = (label: string) => {
    const node = doc.querySelector<HTMLElement>(`[aria-label="${label}"]`)
    assert.ok(node, label)
    return node
  }
  const click = async (node: Element) => act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 230)) })
  try {
    await act(async () => root.render(createElement(Harness)))
    const toggle = doc.querySelector<HTMLButtonElement>('.library-extension-toggle')!
    toggle.focus()
    await click(toggle); await settle()
    await click(labeled('二极管')); await settle()
    await click(labeled('肖特基二极管')); await settle()
    assert.equal(requests.at(-1)!.body.category, 'diode:schottky')

    const exits = ['header', 'footer', 'focused-search Escape', 'backdrop'] as const
    for (const [index, exit] of exits.entries()) {
      if (index) { toggle.focus(); await click(toggle); await settle() }
      assert.ok(dialog(), exit)
      assert.equal(toggle.getAttribute('aria-expanded'), 'true')
      assert.equal(doc.getElementById('root')!.hasAttribute('inert'), true)
      assert.equal(labeled('肖特基二极管').getAttribute('aria-pressed'), 'true', 'reopening retains the selected local subcategory')
      const input = labeled('搜索本地器件') as HTMLInputElement
      const query = `close-pending-${index}`
      pendingNext = true
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, query)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      await settle()
      const pending = requests.at(-1)!
      assert.equal(pending.body.query, query)
      assert.equal(pending.signal.aborted, false)
      if (exit === 'header') await click(labeled('关闭拓展器件'))
      else if (exit === 'footer') await click(dialog()!.querySelector('.workbench-window-footer button')!)
      else if (exit === 'focused-search Escape') {
        input.focus()
        await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      } else {
        await act(async () => { dialog()!.parentElement!.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })) })
      }
      assert.equal(dialog(), null, `${exit} returns to the canvas even while reading the local library`)
      assert.equal(pending.signal.aborted, true, `${exit} cancels the in-flight page request`)
      assert.equal(toggle.getAttribute('aria-expanded'), 'false')
      assert.equal(doc.getElementById('root')!.hasAttribute('inert'), false)
      assert.equal(doc.getElementById('already-inert')!.hasAttribute('inert'), true, 'pre-existing inert state is preserved')
      assert.equal(doc.activeElement, toggle, `${exit} restores keyboard focus to the opener`)
      toggle.focus(); await click(toggle); await settle()
      assert.equal((labeled('搜索本地器件') as HTMLInputElement).value, query)
      assert.equal(requests.at(-1)!.body.category, 'diode:schottky')
      assert.equal(requests.at(-1)!.body.query, query, 'reopening retries the retained filters')
      await click(labeled('关闭拓展器件'))
    }
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
