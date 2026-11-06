import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import type { DesktopControlSetupStage } from '../src/core/desktop-control-client'
import { readAssistantSettings } from '../src/core/assistant-settings'

async function fixture(initialStage: DesktopControlSetupStage, installed = true, restartRequired = true) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost:3032/' })
  dom.window.localStorage.setItem('fuxian-assistant-settings-v1',JSON.stringify({connectionMode:'native'}))
  const previous = new Map<string, PropertyDescriptor | undefined>(), requests: string[] = []
  let stage = initialStage, connected = false, threadId: string | null = null, opened = false, conversationFolder: string | null = null
  const desktopState = () => ({ projectId: 'project-a', threadId, connected, ready: connected, desktopConnected: connected, messages: [], approvals: [] })
  const fetchFixture = async (input: string, init?: RequestInit) => {
    requests.push(input)
    if(input==='/api/codex/installation')return Response.json({configuredPath:null,effectivePath:null,source:'automatic',available:false,message:'未指定路径'})
    if (input === '/api/codex/status') return Response.json({ installed, available: installed, authenticated: null, version: installed ? '0.158' : '', model: installed ? 'gpt-6-sol' : null, message: installed ? '已检测本机 Codex CLI' : '未检测到 Codex' })
    if (input === '/api/cursor/status') return Response.json({ installed: false, available: false, authenticated: null, version: '', model: null, message: '未安装' })
    if (input === '/api/desktop-control/setup') return Response.json({ stage })
    if (input === '/api/desktop-control/conversation-folder') {
      if (init?.method === 'POST') conversationFolder = (JSON.parse(String(init.body)) as { directory: string | null }).directory
      return Response.json({ directory: conversationFolder, defaultDirectory: 'E:\\spice-workbench' })
    }
    if (input === '/api/desktop-control/setup/prepare') { stage = 'prepared'; return Response.json({ stage }) }
    if (input === '/api/desktop-control/setup/activate') { stage = 'activated'; return Response.json({ stage }) }
    if (input === '/api/desktop-control/setup/restore') { stage = 'prepared'; return Response.json({ stage }) }
    if (input === '/api/desktop-control/reconnect') {
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init?.body)), { projectId: 'project-a' })
      assert.equal((init?.headers as Record<string,string>)['X-Fuxian-Desktop-Control'], '1')
      if (!installed) return Response.json({ stage: 'failed', state: desktopState(), setupStage: stage, restartRequired: false, connected: false, message: '未检测到 Codex，请先安装并打开官方桌面。' })
      stage = 'activated'
      return Response.json({ stage: connected ? 'connected' : restartRequired ? 'restart-required' : 'waiting-desktop', state: desktopState(), setupStage: stage, restartRequired: !connected && restartRequired, connected, message: connected ? 'Codex 桌面共享已连接，当前项目对话会自动绑定。' : restartRequired ? '共享配置已修复，请完整退出 Codex 并重开一次；原项目对话会保留。' : '共享配置已就绪，等待 Codex 桌面接入；原项目对话会保留。' })
    }
    if (input.startsWith('/api/desktop-control/state?')) return Response.json(desktopState())
    if (input === '/api/dsh-local/status') return Response.json({ installed: false, available: false, version: '', message: '未安装', providers: [] })
    if (input === '/api/model-library/site-sessions') return Response.json({ available: true, browserName: '专用浏览器', running: false, sites: [{ id: 'semiee', label: '半导小芯', state: 'not-connected', detail: '未连接' }, { id: 'lcsc', label: '立创商城', state: 'not-connected', detail: '未连接' }, { id: 'google', label: 'Google', state: 'not-connected', detail: '未连接' }, { id: 'alldatasheet', label: 'AllDataSheet', state: 'not-connected', detail: '未连接' }] })
    throw new Error(`Unexpected request: ${input}`)
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchFixture })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const { createRoot } = await import('react-dom/client'), { default: SettingsDialog } = await import('../src/components/SettingsDialog')
  const root = createRoot(dom.window.document.getElementById('root')!)
  await act(async () => root.render(createElement(SettingsDialog, { projectId: 'project-a', onClose() {}, onOpenAppearance() {}, onOpenDesktopChat() { opened = true } })))
  const guide = () => dom.window.document.querySelector<HTMLElement>('[aria-label="Codex 桌面连接向导"]')!
  const button = (text: string) => {
    const value = [...guide().querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(text))
    assert.ok(value, text); return value
  }
  return { dom, guide, button, requests, get conversationFolder() { return conversationFolder }, async click(text: string) { await act(async () => button(text).click()) }, async reconnect(id: string | null = null) { connected = true; threadId = id; await this.click('重新连接') }, connectSilently(id: string | null = null) { connected = true; threadId = id }, get opened() { return opened }, async cleanup() {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
  } }
}

test('CLI detection does not confirm desktop sharing; a server-required restart is explained explicitly', async () => {
  const page = await fixture('activated')
  try {
    assert.match(page.dom.window.document.querySelector('[aria-label="Codex CLI 连接设置"]')!.textContent!, /CLI 已检测/)
    assert.equal(page.guide().querySelectorAll('li').length, 4)
    assert.match(page.guide().querySelector('li[aria-current="step"]')!.textContent!, /连接桌面共享/)
    assert.equal(page.guide().querySelector('[role="status"]'), null)
    await page.click('自动检测并连接')
    assert.match(page.guide().querySelector('[role="status"]')!.textContent!, /完整退出 Codex.*重开/)
    assert.match(page.guide().querySelector('li[aria-current="step"]')!.textContent!, /连接桌面共享/)
    assert.equal(page.requests.filter(path => path.includes('/setup/prepare')).length, 0)
  } finally { await page.cleanup() }
})

test('model search engine is configured and saved from settings', async () => {
  const page = await fixture('activated')
  try {
    const select = page.dom.window.document.querySelector<HTMLSelectElement>('[aria-label="设置模型搜索运行方式"]')!
    assert.ok(select)
    await act(async () => {
      Object.getOwnPropertyDescriptor(page.dom.window.HTMLSelectElement.prototype, 'value')!.set!.call(select, 'cursor')
      select.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }))
    })
    const save = [...page.dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('保存设置'))!
    await act(async () => save.click())
    assert.equal(readAssistantSettings(page.dom.window.localStorage).modelEngine, 'cursor')
  } finally { await page.cleanup() }
})

test('source connections load only from the global source settings and include AllDataSheet', async () => {
  const page = await fixture('activated')
  try {
    const sourceRequests = () => page.requests.filter(path => path === '/api/model-library/site-sessions')
    const navigation = [...page.dom.window.document.querySelectorAll<HTMLButtonElement>('.settings-navigation button')]
    assert.equal(sourceRequests().length, 0)
    await act(async () => navigation.find(button => button.textContent?.includes('资料来源'))!.click())
    assert.equal(sourceRequests().length, 1)
    assert.ok(page.dom.window.document.querySelector('[aria-label="搜索站点连接"] [data-site="alldatasheet"]'))
    assert.match(page.dom.window.document.querySelector('[aria-label="搜索站点连接"]')!.textContent!, /AllDataSheet/)
    await act(async () => navigation.find(button => button.textContent?.includes('模型 API'))!.click())
    assert.equal(page.dom.window.document.querySelector('[aria-label="搜索站点连接"]'), null)
    assert.equal(sourceRequests().length, 1)
  } finally { await page.cleanup() }
})

test('workspace settings save a shared folder for future Codex circuit chats', async () => {
  const page = await fixture('activated')
  try {
    await act(async () => [...page.dom.window.document.querySelectorAll<HTMLButtonElement>('.settings-navigation button')].find(button => button.textContent?.includes('工作区'))!.click())
    const input = page.dom.window.document.querySelector<HTMLInputElement>('[aria-label="设置 Codex 电路对话文件夹"]')!
    assert.ok(input)
    assert.match(page.dom.window.document.querySelector('[aria-label="电路对话文件夹设置"]')!.textContent!, /已有项目对话及绑定保持原位置/)
    await act(async () => {
      Object.getOwnPropertyDescriptor(page.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'E:\\Circuit Chats')
      input.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }))
    })
    const save = [...page.dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('保存设置'))!
    await act(async () => save.click())
    assert.equal(page.conversationFolder, 'E:\\Circuit Chats')
    assert.match(page.dom.window.document.querySelector('.settings-notice')!.textContent!, /新工程对话/)
  } finally { await page.cleanup() }
})

test('visual setup advances through prepare, activate, reconnect and opening the project chat', async () => {
  const page = await fixture('not-prepared')
  try {
    assert.match(page.guide().querySelector('li[aria-current="step"]')!.textContent!, /配置共享入口/)
    await act(async () => page.guide().querySelector<HTMLElement>('.desktop-guide-manual summary')!.click())
    await page.click('准备共享入口')
    assert.match(page.guide().textContent!, /共享文件已准备好/)
    await page.click('启用共享入口')
    assert.match(page.guide().querySelector('li[aria-current="step"]')!.textContent!, /连接桌面共享/)
    await page.reconnect()
    assert.match(page.guide().querySelector('li[aria-current="step"]')!.textContent!, /连接项目对话/)
    await page.click('打开 AI 助手')
    assert.equal(page.opened, true)
    assert.equal(page.requests.filter(path => path === '/api/desktop-control/setup/prepare').length, 1)
    assert.equal(page.requests.filter(path => path === '/api/desktop-control/setup/activate').length, 1)
  } finally { await page.cleanup() }
})

test('one tool button detects Codex, prepares and activates sharing, then explains the required restart', async () => {
  const page = await fixture('not-prepared')
  try {
    await page.click('自动检测并连接')
    assert.equal(page.requests.filter(path => path === '/api/desktop-control/reconnect').length, 1)
    assert.deepEqual(page.requests.filter(path => path.startsWith('/api/desktop-control/setup/')), [], 'the shared reconnect service owns automatic setup; manual actions are separate')
    assert.match(page.guide().querySelector('[role="status"]')!.textContent!, /完整退出 Codex.*重开/)
    await page.reconnect('new-project-thread')
    assert.match(page.guide().querySelector('[role="status"]')!.textContent!, /已连接/)
    await page.click('重新连接')
    assert.equal(page.requests.filter(path => path === '/api/desktop-control/reconnect').length, 3)
    assert.equal(page.requests.filter(path => path.startsWith('/api/desktop-control/setup/')).length, 0)
    assert.match(page.guide().textContent!, /此项目已有专属 Codex 对话/)
  } finally { await page.cleanup() }
})

test('settings confirms the shared connection automatically after Codex reconnects', async () => {
  const page = await fixture('activated')
  try {
    await page.click('自动检测并连接')
    page.connectSilently('new-project-thread')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2700)) })
    assert.match(page.guide().querySelector('[role="status"]')!.textContent!, /已连接/)
    assert.match(page.guide().textContent!, /此项目已有专属 Codex 对话/)
    assert.equal(page.requests.filter(path => path.startsWith('/api/desktop-control/setup/')).length, 0)
  } finally { await page.cleanup() }
})

test('automatic connection stops before installation when Codex is missing', async () => {
  const page = await fixture('not-prepared', false)
  try {
    await page.click('自动检测并连接')
    assert.match(page.guide().querySelector('[role="alert"]')!.textContent!, /未检测到 Codex/)
    assert.equal(page.requests.filter(path => path.startsWith('/api/desktop-control/setup/')).length, 0)
    assert.match(page.guide().querySelector('li[aria-current="step"]')!.textContent!, /安装并打开 Codex/)
  } finally { await page.cleanup() }
})

test('waiting for a desktop without a required restart does not present a mandatory restart', async () => {
  const page = await fixture('activated', true, false)
  try {
    await page.click('自动检测并连接')
    assert.match(page.guide().querySelector('[role="status"]')!.textContent!, /等待 Codex 桌面接入/)
    assert.doesNotMatch(page.guide().querySelector('[role="status"]')!.textContent!, /完整退出|重开/)
    assert.equal(page.guide().querySelector('[role="alert"]'), null)
    await page.reconnect('existing-project-thread')
    assert.match(page.guide().textContent!, /此项目已有专属 Codex 对话/)
    assert.equal(page.requests.filter(path => path.startsWith('/api/desktop-control/setup/')).length, 0)
  } finally { await page.cleanup() }
})
