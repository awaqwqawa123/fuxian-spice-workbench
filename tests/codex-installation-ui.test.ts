import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { CodexInstallationInfo } from '../src/core/codex-installation-client'

test('Codex path settings save an explicit path, retain rejected drafts and restore automatic discovery', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost:3032/' })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  const install = (key: string, value: unknown) => { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) install(key, value)
  const automatic = 'C:\\Automatic\\codex.exe', chosen = 'D:\\Codex installation\\codex.exe'
  let setting: CodexInstallationInfo = { configuredPath: null, effectivePath: automatic, source: 'automatic', available: true, message: '自动检测程序' }
  let changed = 0
  const posts: unknown[] = []
  install('fetch', async (url: string, init?: RequestInit) => {
    assert.equal(url, '/api/codex/installation')
    assert.equal((init?.headers as Record<string, string>)['X-Fuxian-Codex-Installation'], '1')
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); posts.push(body)
      if (body.executable === 'missing') return Response.json({ error: '程序不存在' }, { status: 400 })
      setting = { configuredPath: body.executable, effectivePath: body.executable ?? automatic, source: body.executable === null ? 'automatic' : 'manual', available: true, message: body.executable === null ? '自动检测程序' : '手动指定程序' }
    }
    return Response.json(setting)
  })
  const { createRoot } = await import('react-dom/client'), { default: Settings } = await import('../src/components/CodexInstallationSettings')
  const root = createRoot(dom.window.document.getElementById('root')!)
  const input = () => dom.window.document.querySelector<HTMLInputElement>('[aria-label="Codex CLI 安装路径"]')!
  const button = (text: string) => { const found = [...dom.window.document.querySelectorAll('button')].find(node => node.textContent?.includes(text)); assert.ok(found); return found }
  const type = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value); input().dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
  try {
    await act(async () => root.render(createElement(Settings, { onChanged: () => changed++ })))
    assert.ok(dom.window.document.body.textContent?.includes(automatic))
    await type(chosen); await act(async () => button('保存安装路径').click())
    assert.equal(setting.configuredPath, chosen); assert.equal(changed, 1)
    await type('missing'); await act(async () => button('保存安装路径').click())
    assert.equal(setting.configuredPath, chosen); assert.equal(input().value, 'missing'); assert.match(dom.window.document.querySelector('[role="alert"]')?.textContent ?? '', /程序不存在/)
    await act(async () => button('恢复自动检测').click())
    assert.equal(input().value, ''); assert.equal(setting.source, 'automatic'); assert.equal(changed, 2)
    assert.deepEqual(posts, [{ executable: chosen }, { executable: 'missing' }, { executable: null }])
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})
