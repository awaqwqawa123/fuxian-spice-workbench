import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { DESKTOP_CONTROL_API } from '../src/core/desktop-control'
import { DesktopControlError, DesktopControlManager, desktopControlFailure, type DesktopControlManagerOptions } from './desktop-control-manager'
import { changeDesktopControlSetup, readDesktopControlSetup, type DesktopControlSetupAction, type DesktopControlSetupStage } from './desktop-control-setup'
import { DesktopConversationFolder } from './desktop-conversation-folder'
import type { DesktopCircuitManager } from './desktop-circuit-manager'
import { validWorkbenchProjectId } from '../src/core/codex-workbench-link'

const prefix = `${DESKTOP_CONTROL_API}/`
function localRequest(req: IncomingMessage) {
  const host = req.headers.host, origin = req.headers.origin
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') || req.headers['sec-fetch-site'] === 'cross-site' || req.headers['x-fuxian-desktop-control'] !== '1') return false
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return false
  return req.method === 'GET' || !!origin
}
function fields(value: unknown, names: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !names.includes(k))) throw new DesktopControlError(400, '请求字段不正确')
  return value as Record<string, any>
}
function readBody(req: IncomingMessage, timeout: number): Promise<unknown> { return new Promise((accept, reject) => {
  const parts: Buffer[] = []; let size = 0, done = false
  const timer = setTimeout(() => fail(new DesktopControlError(408, '请求接收超时')), timeout)
  function clean() { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', abort) }
  function fail(error: Error) { if (done) return; done = true; clean(); req.pause(); reject(error) }
  function data(part: Buffer | string) { const chunk = Buffer.from(part); size += chunk.length; if (size > 128 * 1024) fail(new DesktopControlError(413, '请求内容过大')); else parts.push(chunk) }
  function end() { if (done) return; done = true; clean(); try { accept(JSON.parse(Buffer.concat(parts).toString('utf8'))) } catch { reject(new DesktopControlError(400, '请求不是有效 JSON')) } }
  function abort() { fail(new DesktopControlError(400, '请求已断开')) }
  if (Number(req.headers['content-length']) > 128 * 1024) { fail(new DesktopControlError(413, '请求内容过大')); return }
  req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', abort)
}) }
export function createDesktopControlMiddleware(options: DesktopControlManagerOptions & { manager?: DesktopControlManager; bodyTimeoutMs?: number; setupAction?: (action: DesktopControlSetupAction) => Promise<{ stage: DesktopControlSetupStage }> }) {
  const folder = new DesktopConversationFolder(options.directory, options.projectDirectory)
  const managerOptions = { ...options, conversationDirectory: options.conversationDirectory ?? (() => folder.effectiveDirectory()) }
  const manager = options.manager ?? new DesktopControlManager(managerOptions)
  let explanationManager: DesktopControlManager | null = null
  const explain = () => explanationManager ??= new DesktopControlManager({ ...managerOptions, explanationOnly: true, directory: join(options.directory, 'explanation') })
  let setupBusy = false
  let repairPromise: Promise<{ stage: DesktopControlSetupStage }> | null = null
  const repair = () => {
    if (repairPromise) return repairPromise
    if (setupBusy) throw new DesktopControlError(409, '桌面共享配置正在进行，请等待当前步骤完成')
    setupBusy = true
    repairPromise = (options.setupAction ?? (step => changeDesktopControlSetup(step, options.projectDirectory)))('repair').finally(() => { setupBusy = false; repairPromise = null })
    return repairPromise
  }
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!(req.url ?? '').split('?')[0].startsWith(prefix)) { next(); return }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    const reply = (status: number, value: unknown) => { if (!res.destroyed) { if (!req.complete) res.setHeader('Connection', 'close'); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) } }
    try {
      if (!localRequest(req)) throw new DesktopControlError(403, '桌面控制只接受本机同源工作台请求')
      const url = new URL(req.url!, 'http://localhost'), route = url.pathname.slice(prefix.length)
      const isExplanation = route.startsWith('explain/'), action = isExplanation ? route.slice('explain/'.length) : route
      const target = isExplanation ? explain() : manager
      if (isExplanation && !['state', 'ensure', 'reconnect', 'handoff', 'send', 'cancel', 'approval'].includes(action)) throw new DesktopControlError(404, '未找到解释子对话接口')
      if (action === 'reconnect') {
        if (req.method !== 'POST') throw new DesktopControlError(405, '连接 Codex 使用 POST')
        if (url.search || !req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new DesktopControlError(400, '连接请求格式不正确')
        const body = fields(await readBody(req, options.bodyTimeoutMs ?? 10000), ['projectId', 'title'])
        if (body.projectId !== undefined && (!validWorkbenchProjectId(body.projectId) || body.projectId === '.' || body.projectId === '..')) throw new DesktopControlError(400, '项目编号格式不正确')
        if (body.title !== undefined && (body.projectId === undefined || typeof body.title !== 'string' || body.title.length > 80)) throw new DesktopControlError(400, '项目标题格式不正确')
        const currentState = () => body.projectId === undefined ? Promise.resolve(null) : target.state(body.projectId)
        const connectProject = async () => {
          if (body.projectId === undefined) return null
          const state = await target.ensure(body.projectId, body.title)
          // Clicking connect on the web asks to continue this project's own chat.
          // Busy desktop work is queued by the broker's existing handoff rules.
          if (state.connected && state.ready && state.desktopConnected && state.owner !== 'web') return target.handoff(body.projectId, 'web')
          return state
        }
        let control: { connected: boolean; ready: boolean; desktopConnected: boolean } | null = null
        try { control = await target.reconnectTransport() } catch { /* A lost launcher requires installation repair, not another writer. */ }
        if (control?.connected && control.desktopConnected && control.ready) {
          try {
            const state = await connectProject()
            const connected = state === null || state.connected && state.ready && state.desktopConnected
            reply(200, { stage: connected ? 'connected' : 'failed', connected, state, restartRequired: false, message: connected ? state?.pendingOwner ? '已连接 Codex，等待当前任务结束后交接到网页。' : state ? '已连接 Codex，项目对话已就绪。' : '已连接 Codex 桌面共享服务。' : state?.error ?? '桌面已连接，当前项目对话尚未就绪。' })
          } catch (error) {
            reply(200, { stage: 'failed', connected: true, state: await currentState(), restartRequired: false, message: desktopControlFailure(error).message })
          }
          return
        }
        if (control?.connected) {
          reply(200, { stage: 'waiting-desktop', connected: false, state: await currentState(), restartRequired: false, message: '已找到桌面共享服务，Codex 正在初始化，请稍后点击连接。' }); return
        }
        let setupStage: DesktopControlSetupStage
        try { setupStage = (await repair()).stage }
        catch (error) {
          const reason = (error as Error).message
          const message = reason === 'entry-changed' ? 'Codex 启动入口已被其他程序配置，自动修复没有覆盖它。请在设置中处理启动入口。' : reason === 'codex-missing' ? '未找到官方 Codex 程序，请先安装并打开 Codex。' : reason === 'windows-only' ? '自动配置桌面共享目前支持 Windows。' : reason === 'timeout' ? '连接配置超时，请稍后再次点击连接；已有项目和对话已保留。' : error instanceof DesktopControlError ? error.message : '桌面共享配置未完成，请在设置中查看配置状态。'
          reply(200, { stage: 'failed', connected: false, state: await currentState(), restartRequired: false, message }); return
        }
        // The desktop may have restarted while configuration was being repaired.
        try { control = await target.reconnectTransport() } catch { control = null }
        if (control?.connected && control.ready && control.desktopConnected) {
          try {
            const state = await connectProject()
            const connected = state === null || state.connected && state.ready && state.desktopConnected
            reply(200, { stage: connected ? 'connected' : 'failed', connected, state, setupStage, restartRequired: false, message: connected ? '已恢复 Codex 连接。' : state?.error ?? '项目对话尚未就绪。' })
          } catch (error) { reply(200, { stage: 'failed', connected: true, state: await currentState(), setupStage, restartRequired: false, message: desktopControlFailure(error).message }) }
        } else {
          reply(200, { stage: 'restart-required', connected: false, state: await currentState(), setupStage, restartRequired: true, message: '共享启动入口已自动修复。请完全退出并重新打开 Codex 一次，再点击连接；现有项目和对话会保留。' })
        }
        return
      }
      if (action === 'conversation-folder') {
        if (url.search) throw new DesktopControlError(400, '文件夹设置不接受查询参数')
        if (req.method === 'GET') { reply(200, await folder.read()); return }
        if (req.method !== 'POST') throw new DesktopControlError(405, '文件夹设置使用 GET 或 POST')
        if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new DesktopControlError(415, '请求必须使用 application/json')
        const body = fields(await readBody(req, options.bodyTimeoutMs ?? 10000), ['directory'])
        if (!Object.hasOwn(body, 'directory')) throw new DesktopControlError(400, '缺少文件夹路径')
        reply(200, await folder.update(body.directory)); return
      }
      if (action === 'setup') {
        if (req.method !== 'GET') throw new DesktopControlError(405, '安装状态查询使用 GET')
        if (url.search) throw new DesktopControlError(400, '安装状态查询不接受参数')
        reply(200, await readDesktopControlSetup()); return
      }
      if (['setup/prepare', 'setup/activate', 'setup/restore'].includes(action)) {
        if (req.method !== 'POST') throw new DesktopControlError(405, '桌面共享配置使用 POST')
        if (url.search || !req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new DesktopControlError(400, '配置请求格式不正确')
        fields(await readBody(req, options.bodyTimeoutMs ?? 10000), [])
        if (setupBusy) throw new DesktopControlError(409, '桌面共享配置正在进行，请等待当前步骤完成')
        setupBusy = true
        try {
          const operation = action.slice('setup/'.length) as DesktopControlSetupAction
          reply(200, await (options.setupAction ?? (step => changeDesktopControlSetup(step, options.projectDirectory)))(operation))
        } catch (error) {
          const reason = (error as Error).message
          const messages: Record<string, string> = {
            'windows-only': '当前版本的桌面共享向导只支持 Windows',
            'codex-missing': '未找到官方 Codex 桌面程序，请先安装并打开 Codex，然后重试',
            'already-active': '共享入口已经启用，请刷新状态；如需重新安装，请先恢复原入口',
            'entry-changed': 'Codex 启动入口已被其他程序修改，向导没有覆盖它；请检查本机配置',
            timeout: '配置步骤超时，请刷新安装状态后再决定是否重试',
            'installer-failed': '配置步骤未完成，请查看工作台后台日志或使用项目中的安装脚本检查原因',
          }
          throw new DesktopControlError(503, messages[reason] ?? messages['installer-failed'])
        } finally { setupBusy = false }
        return
      }
      if (action === 'state') {
        if (req.method !== 'GET') throw new DesktopControlError(405, '状态查询使用 GET')
        if ([...url.searchParams.keys()].some(k => k !== 'projectId') || url.searchParams.getAll('projectId').length !== 1) throw new DesktopControlError(400, '项目查询参数不正确')
        reply(200, await target.state(url.searchParams.get('projectId')!)); return
      }
      if (!['bind', 'ensure', 'handoff', 'send', 'cancel', 'approval'].includes(action)) throw new DesktopControlError(404, '未找到桌面控制接口')
      if (req.method !== 'POST') throw new DesktopControlError(405, '会话操作使用 POST')
      if (url.search) throw new DesktopControlError(400, '会话操作不接受 URL 参数')
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new DesktopControlError(415, '请求必须使用 application/json')
      const raw = await readBody(req, options.bodyTimeoutMs ?? 10000)
      if (action === 'bind') { const b = fields(raw, ['projectId', 'threadId', 'legacySessionId', 'create']); reply(200, await target.bind(b.projectId, { threadId: b.threadId, legacySessionId: b.legacySessionId, create: b.create })) }
      else if (action === 'ensure') { const b = fields(raw, ['projectId', 'title']); reply(200, await target.ensure(b.projectId, b.title)) }
      else if (action === 'handoff') { const b = fields(raw, ['projectId', 'owner']); reply(200, await target.handoff(b.projectId, b.owner)) }
      else if (action === 'send') { const b = fields(raw, ['projectId', 'message', 'requestId', 'redrawTaskId']); reply(200, await target.send(b.projectId, b.message, b.requestId, b.redrawTaskId)) }
      else if (action === 'approval') { const b = fields(raw, ['projectId', 'id', 'decision', 'answers']); reply(200, await target.approval(b.projectId, b.id, b.decision, b.answers)) }
      else { const b = fields(raw, ['projectId']); reply(200, await target.cancel(b.projectId)) }
    } catch (error) { const failure = desktopControlFailure(error); reply(failure.status, { error: failure.message }) }
  }
  return Object.assign(middleware, { manager, close: async () => { await manager.close(); await explanationManager?.close() } })
}
export function desktopControlPlugin(options: Partial<DesktopControlManagerOptions> & { getCircuitManager?: () => DesktopCircuitManager | undefined } = {}): Plugin {
  let root = process.cwd()
  const install = (server: { middlewares: { use: (middleware: ReturnType<typeof createDesktopControlMiddleware>) => unknown }; httpServer?: { once: (event: string, listener: () => void) => unknown } | null }) => {
    const { getCircuitManager, ...managerOptions } = options
    const middleware = createDesktopControlMiddleware({ ...managerOptions, circuitManager: options.circuitManager ?? getCircuitManager?.(), directory: options.directory ?? join(root, '.desktop-control'), projectDirectory: options.projectDirectory ?? root })
    server.middlewares.use(middleware); server.httpServer?.once('close', () => { void middleware.close() })
  }
  return { name: 'official-desktop-control', configResolved(config) { root = config.root }, configureServer: install, configurePreviewServer: install }
}
