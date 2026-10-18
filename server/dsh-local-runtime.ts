import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { parseEnv } from 'node:util'
import { parseDocument } from 'yaml'
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import { resolveAdapterOptions, type Config as DeepSeekConfig } from '@deepseek-ai/dsh-llm-deepseek'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { type DshLocalRequest, type DshLocalStatus, type DshLocalProvider } from '../src/core/dsh-local'
import { runDshAgent, DshRuntimeError, type DshRunOptions, type DshLocalModel } from './dsh-runtime'

const require = createRequire(import.meta.url)
const version: string = require('@deepseek-ai/dsh/package.json').version
const providerId = /^[a-z][a-z0-9-]{0,99}$/
const refName = /^[A-Za-z_][A-Za-z0-9_]*$/
// A credential reference must never become a launch/runtime control variable.
const reservedEnvironment = /^(?:NODE(?:_|$)|DSH(?:_|$)|FUXIAN(?:_|$)|PATH$|PATHEXT$|SYSTEMROOT$|WINDIR$|COMSPEC$|TEMP$|TMP$|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|LD_|DYLD_|PYTHON|BUN_|ELECTRON_|NPM_|SSL_CERT|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i
function safeReference(value: unknown): value is string { return typeof value === 'string' && refName.test(value) && !reservedEnvironment.test(value) }
interface LocalOptions { signal?: AbortSignal; home?: string; environment?: NodeJS.ProcessEnv }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

async function boundedFile(path: string, signal?: AbortSignal, credential = false) {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('DSH 配置文件过大或不是普通文件')
    if (credential && process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('DSH 凭据文件权限必须仅限当前用户')
    return await readFile(path, { encoding: 'utf8', signal })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** Read data documents only: never boot the user's profile or execute its patches. */
async function localSnapshot(options: LocalOptions = {}) {
  options.signal?.throwIfAborted()
  const environment = options.environment ?? process.env
  const home = resolve(options.home ?? environment.DSH_HOME ?? join(homedir(), '.dsh'))
  const credentialsPath = join(home, '.credentials.yaml')
  const [credentialText, settingsText, dotenvText] = await Promise.all([
    boundedFile(credentialsPath, options.signal, true), boundedFile(join(home, 'settings.yaml'), options.signal),
    boundedFile(join(home, '.env'), options.signal, true),
  ])
  const credentials = parseCredentialsDocument(credentialText, 'DSH credentials')
  const document = parseDocument(settingsText, { uniqueKeys: true })
  if (document.errors.length) throw new Error('DSH settings.yaml 语法错误')
  const settings = record(document.toJS({ maxAliasCount: 30 }))
  const dotenv = parseEnv(dotenvText)
  const ref = (name: string) => environment[name] || credentials.refs.get(name) || dotenv[name]
  const catalog = new Map(builtinProviders().map(provider => [provider.id, provider]))
  const profiles = record(record(settings['llm-pi-ai']).providers)
  const ids = new Set([...Object.keys(profiles), ...[...credentials.records.keys()].filter(key => key.startsWith('llm-pi-ai/')).map(key => key.slice(10))])
  const routes: { public: DshLocalProvider; model: DshLocalModel }[] = []
  const secrets = [...credentials.refs.values(), ...Object.values(dotenv)].filter((value): value is string => typeof value === 'string' && !!value)
  const secretStrings = (value: unknown): void => {
    if (typeof value === 'string' && value) secrets.push(value)
    else if (value && typeof value === 'object') for (const item of Object.values(value)) secretStrings(item)
  }
  // OAuth refresh is delegated to the official provider, which owns the token format
  // and atomically updates the original credentials file under its cross-process lock.
  for (const id of ids) {
    if (!providerId.test(id) || id === 'deepseek-official') continue
    const profile = record(profiles[id]) as PiAiProviderProfile
    const stored = credentials.records.get(`llm-pi-ai/${id}`)
    const reference = profile.apiKeyEnv
    if (reference !== undefined && !safeReference(reference)) continue
    const key = reference ? ref(reference) : undefined
    const grant = stored?.kind === 'grant' ? record(stored.payload) : undefined
    const oauth = !reference && grant?.type === 'oauth' && typeof grant.access === 'string' && !!grant.access && typeof grant.refresh === 'string' && !!grant.refresh && typeof grant.expires === 'number'
    const apiKey = !!key || (!reference && stored?.kind === 'api-key' && (!!stored.key || Object.keys(stored.env ?? {}).length > 0))
    const models = profile.models ?? catalog.get(id)?.getModels()
    const names = Array.isArray(models) ? models.map(model => record(model).id).filter((id): id is string => typeof id === 'string' && !!id && id.length <= 200).slice(0, 300) : []
    const configured = (oauth || apiKey) && names.length > 0 && (!!catalog.get(id) || !!profile.api && !!profile.baseURL)
    if (stored?.kind === 'api-key') { secretStrings(stored.key); secretStrings(stored.env) }
    else if (grant) { secretStrings(grant.access); secretStrings(grant.refresh) }
    secretStrings(profile.headers)
    if (key) secrets.push(key)
    routes.push({ public: { id, label: String(profile.displayName ?? catalog.get(id)?.name ?? id).slice(0, 200), configured,
      auth: oauth ? 'oauth' : apiKey ? 'api-key' : 'none', models: names }, model: {
      provider: id, plugin: '@deepseek-ai/dsh-llm-pi-ai',
      config: { providers: { [id]: { ...profile, retryPolicy: { mode: 'normal', maxRetries: 0 } } } },
      credentialsPath, environment: reference && key ? { [reference]: key } : {}, secrets,
    } })
  }
  const deepseek = record(settings['llm-deepseek']) as DeepSeekConfig
  const deepseekRef = deepseek.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  if (!safeReference(deepseekRef)) throw new Error('DSH DeepSeek 凭据引用无效')
  const deepseekKey = ref(deepseekRef)
  const resolved = resolveAdapterOptions(deepseek)
  const deepseekModels = resolved.models.map(model => model.id).filter(id => id.length <= 200).slice(0, 300)
  if (deepseekKey) secrets.push(deepseekKey)
  routes.unshift({ public: { id: 'deepseek-official', label: 'DeepSeek 官方', configured: !!deepseekKey, auth: deepseekKey ? 'api-key' : 'none', models: deepseekModels }, model: {
    provider: 'deepseek-official', plugin: '@deepseek-ai/dsh-llm-deepseek',
    config: { ...deepseek, retryPolicy: { mode: 'normal', maxRetries: 0 } }, credentialsPath,
    environment: deepseekKey ? { [deepseekRef]: deepseekKey } : {}, secrets,
  } })
  options.signal?.throwIfAborted()
  return routes.slice(0, 64)
}

export async function getDshLocalStatus(options: LocalOptions = {}): Promise<DshLocalStatus> {
  try {
    const routes = await localSnapshot(options)
    const available = routes.some(route => route.public.configured)
    return { installed: true, available, version, providers: routes.map(route => route.public), message: available
      ? '检测到本机 DSH 凭据。任务使用所选供应商的官方认证流程；凭据有效性在执行时验证。'
      : '已安装 DSH，尚未检测到可用的本机模型凭据。请先在 DSH 设置的 Models 页面登录供应商或配置密钥，再刷新。' }
  } catch {
    options.signal?.throwIfAborted()
    return { installed: true, available: false, version, providers: [], message: '无法读取 DSH 本机配置。请在官方 DSH 中检查 settings.yaml 与凭据文件格式和权限，再刷新。' }
  }
}

export async function runDshLocalAgent(request: DshLocalRequest, options: DshRunOptions & LocalOptions) {
  let routes: Awaited<ReturnType<typeof localSnapshot>>
  try { routes = await localSnapshot(options) }
  catch { options.signal.throwIfAborted(); throw new DshRuntimeError('DSH 本机配置读取失败，请在官方 DSH 中检查配置后重试') }
  const route = routes.find(route => route.public.id === request.provider)
  if (!route?.public.configured) throw new DshRuntimeError('所选 DSH 供应商尚未登录或配置已失效，请完成本机配置后刷新')
  if (!route.public.models.includes(request.model)) throw new DshRuntimeError('所选模型已不在 DSH 本机配置中，请刷新后重新选择')
  return runDshAgent({ ...request, endpoint: 'http://127.0.0.1', apiKey: '', protocol: 'chat-completions', mode: 'propose' }, { ...options, localModel: route.model })
}

/** A real SDK initialize/shutdown check, without a session prompt or paid model request. */
export async function getDshLocalConnectionStatus(options: LocalOptions = {}): Promise<DshLocalStatus> {
  const status = await getDshLocalStatus(options), signal = options.signal ?? AbortSignal.timeout(20000)
  signal.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), 'fuxian-dsh-connect-'))
  const workspace = join(directory, 'workspace'); await mkdir(workspace)
  const environment: NodeJS.ProcessEnv = { ...process.env, ...options.environment, DSH_HOME: directory }
  delete environment.NODE_OPTIONS
  const runtime = new DeepSeekHarness({ profile: 'sdk-minimal', dshHome: directory, cwd: workspace, processCwd: workspace, env: environment, initializeTimeoutMs: 15000 })
  const abort = () => { void runtime.close().catch(() => {}) }; signal.addEventListener('abort', abort, { once: true })
  try {
    await runtime.start(); signal.throwIfAborted()
    return { ...status, message: status.available ? 'DSH 官方 SDK 初始化通过，本机供应商配置已就绪；凭据有效性在实际任务时验证。' : 'DSH 官方 SDK 初始化通过；尚未配置供应商，请在官方模型设置登录或填写密钥，再连接。' }
  } catch { signal.throwIfAborted(); return { ...status, available: false, message: 'DSH 官方运行时初始化失败，请检查本机 DSH 与依赖；本次未发送模型任务。' } }
  finally { signal.removeEventListener('abort', abort); await runtime.close().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {}) }
}
