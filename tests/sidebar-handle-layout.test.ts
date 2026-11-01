import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'

test('outer and nested sidebar splitters retain their entire twelve pixel drag surface', () => {
  const dom = new JSDOM(`<!doctype html><div class="workspace-shell"><div class="workspace-body">
    <div id="outer" class="sidebar-resize-handle"><span>↔</span></div>
    <div class="single-page-workspace"><div class="page-workspace-body">
      <div id="nested" class="sidebar-resize-handle"><span>↔</span></div>
      <div id="hidden" class="sidebar-resize-handle" hidden><span>↔</span></div>
    </div></div></div></div>`)
  try {
    for (const file of ['workspace-layout.css', 'waveform-v2-layout.css']) {
      const style = dom.window.document.createElement('style')
      style.textContent = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      dom.window.document.head.append(style)
    }
    for (const id of ['outer', 'nested']) {
      const handle = dom.window.document.getElementById(id)!
      const css = dom.window.getComputedStyle(handle)
      assert.equal(css.width, '12px', `${id} must occupy layout width`)
      assert.equal(css.minWidth, '12px')
      assert.equal(css.maxWidth, '12px')
      assert.equal(css.flexBasis, '12px')
      assert.equal(css.flexShrink, '0')
      assert.equal(css.pointerEvents, 'auto', `${id} must receive drags outside the grip`)
      assert.equal(css.cursor, 'col-resize')
      assert.notEqual(css.display, 'none')
      const grip = dom.window.getComputedStyle(handle.firstElementChild!)
      assert.equal(grip.width, '12px')
      assert.equal(grip.height, '48px')
      assert.equal(grip.display, 'flex')
    }
    assert.equal(dom.window.getComputedStyle(dom.window.document.getElementById('hidden')!).display, 'none')
  } finally { dom.window.close() }
})
