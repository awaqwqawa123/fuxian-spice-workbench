import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import SidebarResizeHandle from '../src/components/SidebarResizeHandle'
import { defaultSidebarWidths, sizeWorkspace } from '../src/core/sidebar-sizing'
import { createWorkspaceLayout, workspaceLayoutReducer as reduce } from '../src/core/workspace-layout'

test('splitters capture a drag, clamp widths, support both edges, reset and isolate drawing shortcuts', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>')
  const original = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const captures: number[] = [], releases: number[] = []
  Object.assign(dom.window.HTMLElement.prototype, { setPointerCapture: (id: number) => captures.push(id), hasPointerCapture: () => true, releasePointerCapture: (id: number) => releases.push(id) })
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('root')!)
  function Harness({ direction }: { direction: 1 | -1 }) {
    const [width, setWidth] = useState(300)
    return createElement(SidebarResizeHandle, { label: '调整侧栏', controls: 'sidebar', width, min: 192, max: 480, direction, hidden: false, onResize: setWidth, onReset: () => setWidth(300) })
  }
  let leakedKeys = 0
  dom.window.addEventListener('keydown', () => leakedKeys++)
  try {
    for (const direction of [1, -1] as const) {
      await act(async () => root.render(createElement(Harness, { key: direction, direction })))
      const handle = dom.window.document.querySelector<HTMLElement>('[role="separator"]')!
      const width = () => Number(handle.getAttribute('aria-valuenow'))
      async function pointer(type: string, x: number, pointerId = 7) {
        const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
        Object.defineProperty(event, 'pointerId', { value: pointerId }); await act(async () => handle.dispatchEvent(event))
      }
      async function key(key: string) { await act(async () => handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }))) }
      await pointer('pointerdown', 100)
      await pointer('pointermove', 160, 8); assert.equal(width(), 300, 'another pointer cannot steal this resize')
      await pointer('pointermove', 160); assert.equal(width(), 300 + 60 * direction)
      await pointer('pointermove', 1000); assert.equal(width(), direction === 1 ? 480 : 192)
      await pointer('pointerup', 1000)
      const after = width(); await pointer('pointermove', 0); assert.equal(width(), after, 'released drags stop resizing')
      assert.equal(handle.classList.contains('is-dragging'), false)
      await key('Home'); assert.equal(width(), 192)
      await key('End'); assert.equal(width(), 480)
      await act(async () => handle.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })))
      assert.equal(width(), 300)
      await key('ArrowRight'); assert.equal(width(), 300 + 12 * direction)
      await key('ArrowLeft'); assert.equal(width(), 300)
    }
    assert.deepEqual(captures, [7, 7]); assert.deepEqual(releases, [7, 7]); assert.equal(leakedKeys, 0)
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})

test('assistant splitter drag and keyboard use the available viewport width beyond the old cap', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>')
  const original = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  Object.assign(dom.window.HTMLElement.prototype, { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} })
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('root')!)
  const layout = reduce(reduce(createWorkspaceLayout(), { type: 'panel-right', panel: 'model' }), { type: 'open-ai' })
  function Harness({ viewport }: { viewport: number }) {
    const [preferred, setPreferred] = useState(defaultSidebarWidths)
    const sizing = sizeWorkspace(viewport, preferred, layout)
    return createElement('div', { 'data-canvas-width': sizing.center, 'data-preferred-width': preferred.ai }, createElement(SidebarResizeHandle, {
      label: '调整 AI 助手宽度', controls: 'workspace-ai', width: sizing.widths.ai,
      min: sizing.min.ai, max: sizing.max.ai, direction: -1, hidden: !sizing.visible.ai,
      onResize: ai => setPreferred(current => ({ ...current, ai })), onReset: () => setPreferred(defaultSidebarWidths()),
    }))
  }
  try {
    await act(async () => root.render(createElement(Harness, { viewport: 1920 })))
    const handle = dom.window.document.querySelector<HTMLElement>('[role="separator"]')!
    const width = () => Number(handle.getAttribute('aria-valuenow'))
    async function pointer(type: string, x: number) {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
      Object.defineProperty(event, 'pointerId', { value: 7 }); await act(async () => handle.dispatchEvent(event))
    }
    async function key(key: string) { await act(async () => handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }))) }
    await pointer('pointerdown', 1500)
    await pointer('pointermove', 900)
    await pointer('pointerup', 900)
    assert.equal(width(), 960, 'dragging the left edge expands chat past 900px')
    await key('End')
    assert.equal(width(), 1012)
    assert.equal(handle.getAttribute('aria-valuemax'), '1012')
    assert.equal(dom.window.document.querySelector('[data-canvas-width]')?.getAttribute('data-canvas-width'), '320')
    await act(async () => root.render(createElement(Harness, { viewport: 1280 })))
    assert.ok(width() < 1012)
    assert.equal(dom.window.document.querySelector('[data-preferred-width]')?.getAttribute('data-preferred-width'), '1012')
    await act(async () => root.render(createElement(Harness, { viewport: 1920 })))
    assert.equal(width(), 1012, 'expanding the window restores the actual selected width')
    await key('ArrowRight'); assert.equal(width(), 1000)
    await key('Home'); assert.equal(width(), 300)
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})
