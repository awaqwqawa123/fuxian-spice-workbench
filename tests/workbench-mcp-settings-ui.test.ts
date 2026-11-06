import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import SettingsDialog from '../src/components/SettingsDialog'
import { getWorkbenchMcpInfo } from '../src/core/workbench-mcp-client'
import { workbenchMcpConfiguration } from '../src/core/workbench-mcp-config'

const info = { ready: true, protocol: 'MCP', transport: 'stdio', applicationMode: 'review', message: '伏安工具接口已就绪', toolCount: 17, capabilities: ['projects', 'workbench-status', 'simulation'], config: { mcpServers: { fuxian: { command: 'C:/Runtime/node.exe', args: ['E:/伏安/scripts/workbench-mcp.mjs', '--connection', 'E:/伏安/.desktop-circuit/connection.json'] } } } }

test('MCP settings expose ready status and copy/export configuration without model or chat connections', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost:3032/' })
  const doc = dom.window.document, previous = new Map<string, PropertyDescriptor | undefined>()
  const requests: string[] = [], copied: string[] = [], downloads: string[] = []
  let rejectRead = false, rejectClipboard = false, exported: Blob | null = null
  let counts = { synchronizedProjectCount: 0, runningTaskCount: 0, interruptedTaskCount: 0 }
  const fetch = async (path: unknown, init?: RequestInit) => {
    requests.push(String(path))
    if(path==='/api/codex/installation')return Response.json({configuredPath:null,effectivePath:'C:/Codex/codex.exe',source:'automatic',available:true,message:'已找到程序文件'})
    if (path !== '/api/desktop-circuit/mcp-info') return Response.json({ stage: 'unprepared', directory: null, defaultDirectory: 'E:/伏安', connected: false, installed: false, available: false, message: '未连接', providers: [] })
    assert.equal((init?.headers as Record<string, string>)['x-fuxian-desktop'], '1')
    return rejectRead ? Response.json({ error: '接口正在重启，请重试' }, { status: 503 }) : Response.json({ ...info, ...counts })
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: doc, localStorage: dom.window.localStorage, navigator: { userAgent: dom.window.navigator.userAgent, clipboard: { writeText: async (value: string) => { if (rejectClipboard) throw new Error('denied'); copied.push(value) } } }, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, fetch })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL
  URL.createObjectURL = blob => { exported = blob as Blob; return 'blob:config' }; URL.revokeObjectURL = () => {}
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download) }
  const { createRoot } = await import('react-dom/client'), root = createRoot(doc.getElementById('root')!)
  const click = async (label: string) => act(async () => {
    const button = [...doc.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)
    assert.ok(button, label); button.click()
  })
  try {
    await act(async () => root.render(createElement(SettingsDialog, { onClose() {}, onOpenAppearance() {} })))
    assert.deepEqual(new Set(requests),new Set(['/api/codex/installation','/api/desktop-circuit/mcp-info']),'default connection page only reads MCP and program-path metadata')
    assert.equal(doc.querySelector<HTMLSelectElement>('[aria-label="助手连接方式"]')!.value,'mcp')
    assert.ok(doc.querySelector('[aria-label="Codex CLI 安装路径"]'))
    assert.equal(doc.querySelector('[aria-label="Codex 桌面连接向导"]'),null)
    assert.equal([...doc.querySelectorAll('.settings-navigation button')].filter(button=>button.textContent?.includes('外部助手')).length,0,'one AI connection navigation entry replaces duplicate settings')
    assert.match(doc.body.textContent!, /接口已就绪/)
    assert.doesNotMatch(doc.body.textContent!, /助手已连接/)
    assert.match(doc.body.textContent!, /尚无已同步项目。请先打开并保存电路项目/)
    assert.match(doc.body.textContent!, /正在运行的任务：0 个/)
    assert.match(doc.querySelector('[aria-label="可调用的能力"]')!.textContent!, /工作台状态/)
    assert.doesNotMatch(doc.body.textContent!, /保留了 .*中断任务/)
    assert.ok(doc.querySelector('textarea'),'selected client configuration is visible directly')
    await click('复制接入配置')
    assert.equal(copied[0],workbenchMcpConfiguration(info as Awaited<ReturnType<typeof getWorkbenchMcpInfo>>,'codex').text)
    assert.match(copied[0],/^\[mcp_servers\.fuxian\]/)
    assert.doesNotMatch(copied[0], /Bearer|"token"/)
    assert.match(doc.body.textContent!, /接入配置已复制/)
    const client=doc.querySelector<HTMLSelectElement>('[aria-label="MCP 配置客户端"]')!
    await act(async()=>{client.value='cursor';client.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})
    await click('复制接入配置')
    assert.deepEqual(JSON.parse(copied[1]),info.config)
    await click('下载配置')
    assert.deepEqual(downloads, ['fuxian-cursor-mcp.json']); assert.ok(exported)
    assert.deepEqual(JSON.parse(await (exported as Blob).text()), info.config)
    rejectClipboard = true; await click('复制接入配置')
    assert.equal(doc.activeElement, doc.querySelector('textarea'))
    assert.equal((doc.querySelector('textarea') as HTMLTextAreaElement).selectionEnd, JSON.stringify(info.config, null, 2).length+1)
    await act(async()=>{client.value='dsh';client.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})
    assert.match(doc.body.textContent!,/不是所有 DSH 版本都能直接导入/)
    counts = { synchronizedProjectCount: 2, runningTaskCount: 1, interruptedTaskCount: 3 }
    await click('重新检测')
    assert.match(doc.body.textContent!, /已同步 2 个项目/)
    assert.match(doc.body.textContent!, /正在运行的任务：1 个/)
    assert.match(doc.body.textContent!, /保留了 3 个中断任务.*重新发起任务/)
    assert.doesNotMatch(doc.body.textContent!, /尚无已同步项目|助手已连接/)
    rejectRead = true; await click('重新检测')
    assert.match(doc.querySelector('[role="alert"]')!.textContent!, /正在重启/)
    assert.equal(doc.querySelector('textarea'), null, 'failed refresh does not offer an old config as verified')
    assert.equal(doc.querySelector('[aria-label="项目与任务状态"]'), null, 'failed refresh clears previously verified counts')
    assert.equal([...doc.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '复制接入配置')!.disabled, true)
    counts = { synchronizedProjectCount: 0, runningTaskCount: 0, interruptedTaskCount: 0 }
    rejectRead = false; await click('重新检测')
    assert.match(doc.body.textContent!, /接口已就绪/)
    assert.match(doc.body.textContent!, /尚无已同步项目/)
    assert.equal(requests.filter(path=>path==='/api/desktop-circuit/mcp-info').length, 4)
    assert.ok(!requests.some(path=>path.startsWith('/api/desktop-control/')||path==='/api/codex/status'||path==='/api/cursor/status'),'MCP settings never connect to native chat services')
    const navigate = async (label:string) => act(async()=>{
      const button=[...doc.querySelectorAll<HTMLButtonElement>('.settings-navigation button')].find(item=>item.textContent===label)
      assert.ok(button,label);button.click()
    })
    await navigate('模型 API')
    await act(async()=>{
      const input=doc.querySelector<HTMLInputElement>('[aria-label="设置 API 密钥"]')!
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,'unsaved-private-key')
      input.dispatchEvent(new dom.window.Event('input',{bubbles:true}))
    })
    await navigate('AI 连接')
    await act(async()=>{
      const mode=doc.querySelector<HTMLSelectElement>('[aria-label="助手连接方式"]')!
      mode.value='native';mode.dispatchEvent(new dom.window.Event('change',{bubbles:true}))
    })
    assert.ok(requests.includes('/api/codex/status'),'native status checks only start after explicitly choosing advanced mode')
    assert.ok(doc.querySelector('[aria-label="Codex 桌面连接向导"]'))
    await act(async()=>{
      const mode=doc.querySelector<HTMLSelectElement>('[aria-label="助手连接方式"]')!
      mode.value='mcp';mode.dispatchEvent(new dom.window.Event('change',{bubbles:true}))
    })
    assert.equal(doc.querySelector('[aria-label="Codex 桌面连接向导"]'),null)
    assert.equal(JSON.parse(dom.window.localStorage.getItem('fuxian-assistant-settings-v1')!).connectionMode,'mcp')
    await navigate('模型 API')
    assert.equal(doc.querySelector<HTMLInputElement>('[aria-label="设置 API 密钥"]')!.value,'unsaved-private-key','connection-mode switching preserves unsaved API input')
    await navigate('工作区')
    await act(async()=>{
      const input=doc.querySelector<HTMLInputElement>('[aria-label="设置 Codex 电路对话文件夹"]')!
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,'E:/draft-conversation-folder')
      input.dispatchEvent(new dom.window.Event('input',{bubbles:true}))
    })
    await navigate('AI 连接');await navigate('工作区')
    assert.equal(doc.querySelector<HTMLInputElement>('[aria-label="设置 Codex 电路对话文件夹"]')!.value,'E:/draft-conversation-folder','returning to workspace preserves unsaved folder input')
    assert.equal(requests.filter(path=>path==='/api/desktop-control/conversation-folder').length,1,'folder metadata is read lazily once per successful load')
  } finally {
    await act(async () => root.unmount()); dom.window.close(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})

test('MCP info supports legacy discovery and strictly validates optional counts', async () => {
  const before = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json(info)
    assert.equal((await getWorkbenchMcpInfo()).synchronizedProjectCount, undefined)
    for (const key of ['synchronizedProjectCount', 'runningTaskCount', 'interruptedTaskCount']) {
      for (const invalid of [null, '0', -1, 0.5, true, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
        globalThis.fetch = async () => Response.json({ ...info, [key]: invalid })
        await assert.rejects(getWorkbenchMcpInfo(), /接口状态不完整/, `${key}: ${JSON.stringify(invalid)}`)
      }
      for (const valid of [0, 1, Number.MAX_SAFE_INTEGER]) {
        globalThis.fetch = async () => Response.json({ ...info, [key]: valid })
        assert.equal((await getWorkbenchMcpInfo())[key as 'synchronizedProjectCount' | 'runningTaskCount' | 'interruptedTaskCount'], valid)
      }
    }
  } finally { globalThis.fetch = before }
})

test('MCP info rejects malformed configurations instead of advertising a working connection', async () => {
  const before = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({ ...info, config: { mcpServers: { fuxian: { command: '', args: [] } } } })
    await assert.rejects(getWorkbenchMcpInfo(), /配置不完整/)
  } finally { globalThis.fetch = before }
})
