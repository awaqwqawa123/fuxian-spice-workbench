import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseProject, projectKey, validateProject, type Project } from '../src/core/circuit'
import { layoutElectricallyEquivalent } from '../src/core/layout-electrical-equivalence'
import { resolveCandidateProject } from '../src/core/candidate-resolution'
import { aiProjectFingerprint, proposalChanges } from '../src/core/ai'
import { circuitAgentInstructions, circuitAgentTools, createCircuitAgentTools } from '../src/core/agent-circuit'
import { desktopCircuitFingerprint, type DesktopCircuitSnapshot, type DesktopCircuitTask, type DesktopCircuitState, type DesktopCircuitStart, type DesktopCircuitSync, type DesktopCircuitEditResult } from '../src/core/desktop-circuit'
import type { AgentSimulation } from '../src/core/agent-client'
import type { AgentModelService } from '../src/core/agent-models'
import type { Result } from '../src/core/results'
import { validWorkbenchProjectId } from '../src/core/codex-workbench-link'
import { createAgentModelService } from './agent-model-service'
import { simulateAgentCircuit } from './agent-simulation'
import { browsePersistentDeviceLibrary, readPersistentDeviceLibraryModel, type PersistentDeviceLibraryOptions } from './persistent-device-library'
import { readAvailableModelCatalog } from './model-library'
import { parseDeviceLibraryBrowseRequest } from '../src/core/device-library-catalog'
import type { LocalModelCatalog } from '../src/core/model-catalog'
import { workbenchMcpCapabilities, workbenchMcpLimits, workbenchTaskStatuses } from './workbench-mcp-runtime'
import { parseCircuitGraphQuery, readCircuitSemanticGraph } from '../src/core/circuit-semantic-graph'
import { parseCandidateEditOperations } from '../src/core/candidate-edit'
import { readCandidateDiff } from '../src/core/candidate-diff'

export class DesktopCircuitError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
export interface DesktopCircuitManagerOptions {
  directory: string
  projectDirectory: string
  simulate?: (project: Project, signal: AbortSignal) => Promise<Result>
  modelService?: AgentModelService
  modelLibraryCache?: PersistentDeviceLibraryOptions
  loadModelCatalog?: () => Promise<LocalModelCatalog>
}
type Runtime = { abort: AbortController; tools: ReturnType<typeof createCircuitAgentTools>; queue: Promise<unknown>; committing?: { candidate: Project; revision: number } }
type Saved = { version: 1; snapshots: DesktopCircuitSnapshot[]; tasks: DesktopCircuitTask[] }
const clone = <T>(value: T): T => structuredClone(value)
function canonicalFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex')
}
function id(value: unknown, field: string): string {
  if (!validWorkbenchProjectId(value)) throw new DesktopCircuitError(400, `${field} 格式不正确`)
  return value
}
function boundedText(value: unknown, field: string, max = workbenchMcpLimits.maxRequestCharacters): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new DesktopCircuitError(400, `${field} 必须是 1–${max} 字符的文本`)
  return value
}
function checkedProject(value: unknown): Project {
  try { parseProject(value, { allowDraft: true }) }
  catch (error) { throw new DesktopCircuitError(400, `工程格式不正确：${(error as Error).message}`) }
  // Keep browser ordering and every original field for rollback. Parsing above only validates.
  return clone(value as Project)
}

export class DesktopCircuitManager {
  readonly cliPath: string
  private readonly token = randomBytes(32).toString('hex')
  private readonly snapshots = new Map<string, DesktopCircuitSnapshot>()
  private readonly tasks = new Map<string, DesktopCircuitTask>()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly projectLocks = new Map<string, Promise<unknown>>()
  private readonly ready: Promise<void>
  private writes: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly options: DesktopCircuitManagerOptions) {
    this.cliPath = resolve(options.projectDirectory, 'scripts/desktop-circuit.mjs')
    this.ready = this.restore()
  }
  private async restore() {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    let saved: Saved
    try { saved = JSON.parse(await readFile(join(this.options.directory, 'state.json'), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new DesktopCircuitError(500, '电路工具存储无法读取；未覆盖旧记录') }
    if (saved.version !== 1 || !Array.isArray(saved.snapshots) || !Array.isArray(saved.tasks)) throw new DesktopCircuitError(500, '电路工具存储版本无效；未覆盖旧记录')
    for (const snapshot of saved.snapshots) {
      id(snapshot.projectId, 'projectId'); checkedProject(snapshot.project)
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) throw new DesktopCircuitError(500, '工程版本记录无效')
      this.snapshots.set(snapshot.projectId, snapshot)
    }
    for (const task of saved.tasks) {
      id(task.id, 'taskId'); id(task.projectId, 'projectId'); checkedProject(task.baseline)
      if (!Array.isArray(task.events) || !['running','completed','cancelled','interrupted','failed'].includes(task.status)) throw new DesktopCircuitError(500, '电路任务记录无效')
      task.candidateRevision ??= 1
      if (!Number.isSafeInteger(task.candidateRevision) || task.candidateRevision < 1) throw new DesktopCircuitError(500, '候选版本记录无效')
      if (task.checkpointCandidate) checkedProject(task.checkpointCandidate)
      if (task.editOperations !== undefined && (!Array.isArray(task.editOperations) || task.editOperations.length > workbenchMcpLimits.maxEditReceiptsPerTask ||
        new Set(task.editOperations.map(receipt => receipt.operationId)).size !== task.editOperations.length ||
        task.editOperations.some(receipt => !validWorkbenchProjectId(receipt.operationId) || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
          !receipt.result || receipt.result.taskId !== task.id || receipt.result.operationId !== receipt.operationId ||
          !Number.isSafeInteger(receipt.result.candidateRevision) || receipt.result.candidateRevision < 1 || receipt.result.candidateRevision > task.candidateRevision! ||
          typeof receipt.result.changed !== 'boolean' || !Number.isSafeInteger(receipt.result.operationCount) || receipt.result.operationCount < 1 || receipt.result.operationCount > workbenchMcpLimits.maxAtomicEditOperations ||
          !Array.isArray(receipt.result.issues) || receipt.result.issues.some(issue => typeof issue !== 'string')))) throw new DesktopCircuitError(500, '候选操作记录无效')
      if (task.status === 'running') { task.status = 'interrupted'; task.error = '工作台服务重启，旧任务已中断；画布未改动，请从当前工程重新开始'; task.updatedAt = new Date().toISOString(); task.result = null }
      this.tasks.set(task.id, task)
    }
    await this.persist()
  }
  private persist(commit?: { task: DesktopCircuitTask; next: DesktopCircuitTask; accepted: () => void; rejected: () => void }): Promise<void> {
    const write = async () => {
      // Serialize at the actual write boundary so a queued save cannot overwrite a newer receipt.
      const saved: Saved = { version: 1, snapshots: [...this.snapshots.values()], tasks: [...this.tasks.values()].map(task =>
        commit?.task === task ? { ...task, candidateRevision: commit.next.candidateRevision, checkpointCandidate: commit.next.checkpointCandidate,
          editOperations: commit.next.editOperations, events: commit.next.events,
          ...(task.status === 'running' ? { error: commit.next.error, updatedAt: commit.next.updatedAt } : {}) } : task) }
      const serialized = JSON.stringify(saved)
      const temporary = join(this.options.directory, `state-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, serialized, { mode: 0o600 }); await rename(temporary, join(this.options.directory, 'state.json'))
        if (commit) {
          commit.task.candidateRevision = commit.next.candidateRevision
          commit.task.checkpointCandidate = commit.next.checkpointCandidate
          commit.task.editOperations = commit.next.editOperations
          commit.task.events = commit.next.events
          if (commit.task.status === 'running') { delete commit.task.error; commit.task.updatedAt = commit.next.updatedAt }
          commit.accepted()
        }
      } catch (error) { commit?.rejected(); throw error }
      finally { await unlink(temporary).catch(() => {}) }
    }
    const pending = this.writes.then(write)
    this.writes = pending.catch(() => {})
    return pending
  }
  async connect(url: string): Promise<void> {
    await this.ready
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(parsed.hostname) || !parsed.port || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new DesktopCircuitError(500, '电路工具只能发布本机监听地址')
    await writeFile(join(this.options.directory, 'connection.json'), JSON.stringify({ version: 1, url: parsed.origin, token: this.token }), { mode: 0o600 })
  }
  authenticates(header: string | undefined): boolean {
    const got = Buffer.from(header ?? ''), expected = Buffer.from(`Bearer ${this.token}`)
    return got.length === expected.length && timingSafeEqual(got, expected)
  }
  private async accessible() { await this.ready; if (this.closed) throw new DesktopCircuitError(503, '电路工具服务正在关闭') }
  private lock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.projectLocks.get(key) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(run)
    this.projectLocks.set(key, pending)
    void pending.finally(() => { if (this.projectLocks.get(key) === pending) this.projectLocks.delete(key) }).catch(() => {})
    return pending
  }
  async state(projectId: string): Promise<DesktopCircuitState> {
    await this.accessible(); id(projectId, 'projectId')
    return clone({ snapshot: this.snapshots.get(projectId) ?? null, tasks: [...this.tasks.values()].filter(task => task.projectId === projectId), cliPath: this.cliPath })
  }
  async sync(input: DesktopCircuitSync): Promise<DesktopCircuitState> {
    await this.accessible(); id(input.projectId, 'projectId')
    if (input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) throw new DesktopCircuitError(400, 'expectedRevision 必须为当前版本或 null')
    const project = checkedProject(input.project)
    return this.lock(input.projectId, async () => {
      await this.accessible()
      const current = this.snapshots.get(input.projectId)
      if (current && desktopCircuitFingerprint(current.project) === desktopCircuitFingerprint(project)) return this.state(input.projectId)
      if (current ? input.expectedRevision !== current.revision : input.expectedRevision !== null) throw new DesktopCircuitError(409, '工程已在另一窗口更新；请读取当前版本，不能覆盖更新后的画布')
      this.snapshots.set(input.projectId, { projectId: input.projectId, project, revision: (current?.revision ?? 0) + 1, updatedAt: new Date().toISOString() })
      await this.persist()
      return this.state(input.projectId)
    })
  }
  async list() { await this.accessible(); return { projects: clone([...this.snapshots.values()]) } }
  /** Observational status: never returns project content, requests, errors or paths. */
  async workbenchStatus() {
    await this.accessible()
    const byStatus = Object.fromEntries(workbenchTaskStatuses.map(status => [status, 0])) as Record<typeof workbenchTaskStatuses[number], number>
    const active = new Map<string, string>()
    for (const task of this.tasks.values()) {
      byStatus[task.status] += 1
      if (task.status === 'running') active.set(task.projectId, task.id)
    }
    return {
      projects: { count: this.snapshots.size, items: [...this.snapshots.values()].map(snapshot => ({
        projectId: snapshot.projectId, revision: snapshot.revision, updatedAt: snapshot.updatedAt,
        deviceCount: snapshot.project.drawing?.devices.length ?? 0, modelCount: snapshot.project.models?.length ?? 0,
        activeTaskId: active.get(snapshot.projectId) ?? null,
      })) },
      tasks: { count: this.tasks.size, byStatus },
    }
  }
  /** Stable discovery deliberately omits full drawings and model source text. */
  async projectMetadata() {
    await this.accessible()
    return { projects: [...this.snapshots.values()].map(snapshot => ({ projectId: snapshot.projectId,
      title: snapshot.project.title, revision: snapshot.revision, updatedAt: snapshot.updatedAt,
      analysis: snapshot.project.analysis, deviceCount: snapshot.project.drawing?.devices.length ?? 0,
      modelCount: snapshot.project.models?.length ?? 0,
      activeTaskId: [...this.tasks.values()].find(task => task.projectId === snapshot.projectId && task.status === 'running')?.id ?? null })) }
  }
  async browseLocalModels(input: unknown) {
    await this.accessible()
    let request
    try { request = parseDeviceLibraryBrowseRequest(input) } catch (error) { throw new DesktopCircuitError(400, (error as Error).message) }
    return browsePersistentDeviceLibrary(request, this.options.loadModelCatalog ?? (() => readAvailableModelCatalog()), this.options.modelLibraryCache)
  }
  async getLocalModel(key: string) {
    await this.accessible()
    try { return { model: await readPersistentDeviceLibraryModel(key, this.options.modelLibraryCache) } }
    catch (error) { throw new DesktopCircuitError(422, (error as Error).message) }
  }
  /** Polling is observational: never spends a tool call or alters task events. */
  async inspectTask(taskId: string) {
    await this.accessible()
    const task = this.task(taskId), snapshot = this.snapshot(task.projectId)
    const runtime = this.runtimes.get(taskId)
    const candidate = runtime?.committing?.candidate ?? runtime?.tools.candidate ?? task.result?.proposal.project ?? task.checkpointCandidate ?? null
    return clone({ task, candidate, candidateRevision: candidate ? task.candidateRevision ?? 1 : null, snapshot,
      resolution: candidate ? resolveCandidateProject(task.baseline, candidate, snapshot.project) : null,
      applicationMode: 'review' as const })
  }
  /** A bounded review of an exact durable candidate, including interrupted checkpoints. */
  async diffCandidate(input: Record<string, unknown>) {
    await this.accessible()
    if (Object.keys(input).some(key => !['taskId', 'expectedCandidateRevision'].includes(key))) throw new DesktopCircuitError(400, 'Unknown candidate diff field')
    id(input.taskId, 'taskId')
    if (input.expectedCandidateRevision !== undefined && (!Number.isSafeInteger(input.expectedCandidateRevision) || Number(input.expectedCandidateRevision) < 1)) throw new DesktopCircuitError(400, 'expectedCandidateRevision must be a positive integer')
    const task = this.task(input.taskId as string), snapshot = this.snapshot(task.projectId), runtime = this.runtimes.get(task.id)
    const candidate = runtime?.committing?.candidate ?? runtime?.tools.candidate ?? task.result?.proposal.project ?? task.checkpointCandidate
    if (!candidate) throw new DesktopCircuitError(409, 'No exact candidate or durable checkpoint is available')
    const candidateRevision = runtime?.committing?.revision ?? task.candidateRevision ?? 1
    if (input.expectedCandidateRevision !== undefined && input.expectedCandidateRevision !== candidateRevision) throw new DesktopCircuitError(409, 'Candidate version changed; inspect before reading the diff')
    return { taskId: task.id, projectId: task.projectId, revision: snapshot.revision, baselineRevision: task.baselineRevision,
      candidateRevision, taskStatus: task.status, applicationMode: 'review' as const,
      diff: readCandidateDiff(task.baseline, candidate, snapshot.project) }
  }
  /** Snapshot selection is synchronous after readiness: graph pages never mix revisions or candidates. */
  async circuitGraph(input: Record<string, unknown>) {
    await this.accessible()
    const { projectId, taskId, expectedGraphKey, ...filters } = input
    id(projectId, 'projectId')
    if (taskId !== undefined) id(taskId, 'taskId')
    if (expectedGraphKey !== undefined && (typeof expectedGraphKey !== 'string' || !/^[a-f0-9]{64}$/.test(expectedGraphKey)))
      throw new DesktopCircuitError(400, 'expectedGraphKey must be a SHA256 graph key')
    let query
    try { query = parseCircuitGraphQuery(filters) }
    catch (error) { throw new DesktopCircuitError(400, (error as Error).message) }
    const snapshot = this.snapshot(projectId as string)
    const task = taskId !== undefined ? this.task(taskId as string) : null
    if (task && task.projectId !== projectId) throw new DesktopCircuitError(403, '该电路任务不属于当前工程')
    const selected = task
      ? task.status === 'running' ? (this.runtimes.get(task.id)?.committing?.candidate ?? this.runtimes.get(task.id)?.tools.candidate)
        : task.status === 'completed' ? task.result?.proposal.project : null
      : snapshot.project
    if (!selected) throw new DesktopCircuitError(409, '任务候选不可用，请读取同步工程或重新开始任务')
    // No await between selecting metadata and cloning the exact candidate. Reads consume no task call/events.
    const project = clone(selected)
    const revision = snapshot.revision, synchronizedAt = snapshot.updatedAt, baselineRevision = task?.baselineRevision ?? null
    const taskStatus = task?.status ?? null
    const graphKey = createHash('sha256').update(JSON.stringify(project)).digest('hex')
    if (expectedGraphKey !== undefined && expectedGraphKey !== graphKey)
      throw new DesktopCircuitError(409, '电路图已变化，请从第一页重新读取，不能混用旧图分页')
    let graph
    try { graph = readCircuitSemanticGraph(project, query) }
    catch (error) {
      const message = (error as Error).message
      const code = message.split(':', 1)[0]
      throw new DesktopCircuitError(['graph_query_invalid', 'graph_device_not_found', 'graph_net_not_found'].includes(code) ? 400 : 422, message)
    }
    return { projectId, revision, synchronizedAt, baselineRevision, candidateRevision: task ? task.candidateRevision ?? 1 : null, taskId: task?.id ?? null,
      taskStatus, source: task ? 'candidate' as const : 'synchronized' as const, graphKey, graph }
  }
  mcpConnectionInfo(toolCount: number) {
    return { ready: true, protocol: 'MCP', transport: 'stdio',
      config: { mcpServers: { fuxian: { command: process.execPath,
        args: [resolve(this.options.projectDirectory, 'scripts/workbench-mcp.mjs'), '--connection', resolve(this.options.directory, 'connection.json')] } } },
      toolCount, capabilities: [...workbenchMcpCapabilities],
      applicationMode: 'review', message: '外部助手完成的电路方案会进入工作台审阅，可应用、合并或撤销。' }
  }
  private snapshot(projectId: string): DesktopCircuitSnapshot {
    id(projectId, 'projectId')
    const snapshot = this.snapshots.get(projectId)
    if (!snapshot) throw new DesktopCircuitError(404, '网页尚未同步该工程，请先打开对应画布')
    return snapshot
  }
  private sourceCandidate(projectId: string, taskId: string, current: Project): Project {
    id(taskId, 'sourceTaskId')
    const source = this.tasks.get(taskId)
    if (!source || source.projectId !== projectId || source.status !== 'completed' || !source.result?.changed)
      throw new DesktopCircuitError(409, '重画来源方案已失效，请重新选择可审阅的候选')
    const resolution = resolveCandidateProject(source.baseline, source.result.proposal.project, current)
    if (resolution.status !== 'ready' && resolution.status !== 'mergeable')
      throw new DesktopCircuitError(409, '候选与当前画布存在冲突或已应用，请重新选择方案')
    return clone(resolution.project!)
  }
  async inspect(projectId: string, sourceTaskId?: string) {
    await this.accessible()
    const snapshot = clone(this.snapshot(projectId))
    const tools = createCircuitAgentTools(snapshot.project, { signal: new AbortController().signal, simulate: this.options.simulate ?? simulateAgentCircuit,
      ...(sourceTaskId ? { initialCandidate: this.sourceCandidate(projectId, sourceTaskId, snapshot.project) } : {}) })
    const active = [...this.tasks.values()].find(task => task.projectId === projectId && task.status === 'running')
    const activeTask = active ? { id: active.id, requestId: active.requestId, request: active.request, baselineRevision: active.baselineRevision, layoutOnly: active.layoutOnly, status: active.status, ...(active.error ? { error: active.error } : {}) } : null
    return { snapshot, activeTask, tools: circuitAgentTools, instructions: circuitAgentInstructions, inspection: await tools.execute('inspect_circuit', {}) }
  }
  async start(input: DesktopCircuitStart) {
    await this.accessible(); id(input.projectId, 'projectId'); id(input.requestId, 'requestId'); boundedText(input.request, 'request')
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || typeof input.layoutOnly !== 'boolean') throw new DesktopCircuitError(400, '任务版本或 layoutOnly 格式不正确')
    return this.lock(input.projectId, async () => {
      await this.accessible()
      const previous = [...this.tasks.values()].find(task => task.projectId === input.projectId && task.requestId === input.requestId)
      if (previous) {
        if (previous.request !== input.request || previous.layoutOnly !== input.layoutOnly || previous.baselineRevision !== input.expectedRevision || previous.sourceTaskId !== input.sourceTaskId) throw new DesktopCircuitError(409, 'requestId 已用于不同任务，不能替换原请求')
        return { task: clone(previous) }
      }
      if ([...this.tasks.values()].filter(task => task.projectId === input.projectId && task.status === 'running').length >= workbenchMcpLimits.maxActiveTasksPerProject) throw new DesktopCircuitError(409, '该工程已有运行中的电路任务，请完成或取消后重试')
      const snapshot = this.snapshot(input.projectId)
      if (snapshot.revision !== input.expectedRevision) throw new DesktopCircuitError(409, '工程版本已变化，请重新 inspect 后再开始，不能使用旧画布')
      const now = new Date().toISOString()
      const initialCandidate = input.sourceTaskId ? this.sourceCandidate(input.projectId, input.sourceTaskId, snapshot.project) : undefined
      const task: DesktopCircuitTask = { id: randomUUID(), projectId: input.projectId, requestId: input.requestId, request: input.request, source: 'desktop', status: 'running', baseline: clone(snapshot.project), baselineRevision: snapshot.revision, layoutOnly: input.layoutOnly, candidateRevision: 1, editOperations: [], ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}), events: [], result: null, createdAt: now, updatedAt: now }
      const abort = new AbortController()
      // Tools compare electrical keys. Normalize their private copy so terminal-key
      // ordering/defaults cannot look like an electrical edit; retain raw baseline above.
      const tools = createCircuitAgentTools(parseProject(task.baseline, { allowDraft: true }), { signal: abort.signal, simulate: this.options.simulate ?? simulateAgentCircuit, initialCandidate, layoutOnly: task.layoutOnly, maxToolCalls: workbenchMcpLimits.maxToolCallsPerTask, modelService: this.options.modelService ?? createAgentModelService(), onEvent: event => {
        task.events.push(event); task.updatedAt = new Date().toISOString()
      } })
      task.checkpointCandidate = tools.candidate
      this.tasks.set(task.id, task); this.runtimes.set(task.id, { abort, tools, queue: Promise.resolve() })
      await this.persist()
      return { task: clone(task) }
    })
  }
  private task(taskId: string): DesktopCircuitTask {
    id(taskId, 'taskId'); const task = this.tasks.get(taskId)
    if (!task) throw new DesktopCircuitError(404, '没有该电路任务')
    return task
  }
  private operation<T>(taskId: string, action: (task: DesktopCircuitTask, runtime: Runtime) => Promise<T>): Promise<T> {
    const task = this.task(taskId), runtime = this.runtimes.get(taskId)
    if (task.status !== 'running' || !runtime) return Promise.reject(new DesktopCircuitError(409, '任务已结束或中断，请从当前工程重新开始'))
    const pending = runtime.queue.catch(() => {}).then(async () => {
      await this.accessible()
      if (task.status !== 'running' || runtime.abort.signal.aborted) throw new DesktopCircuitError(409, '任务已停止')
      return action(task, runtime)
    })
    runtime.queue = pending
    return pending
  }
  async call(taskId: string, name: string, input: unknown) {
    await this.accessible()
    if (!circuitAgentTools.some(tool => tool.name === name)) throw new DesktopCircuitError(400, '不支持的电路工具')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DesktopCircuitError(400, '工具参数需要 JSON 对象')
    return this.operation(taskId, async (task, runtime) => {
      try {
        const output = await runtime.tools.execute(name, input)
        task.candidateRevision = runtime.tools.candidateRevision
        task.checkpointCandidate = runtime.tools.candidate
        delete task.error; task.updatedAt = new Date().toISOString(); await this.persist()
        return { output, task: clone(task) }
      } catch (error) {
        task.error = (error as Error).message.slice(0, 2000); task.updatedAt = new Date().toISOString(); await this.persist()
        throw new DesktopCircuitError(422, task.error)
      }
    })
  }
  /** One queued transaction and one durable receipt; retries never spend a second tool call. */
  async editCandidate(input: { taskId: string; expectedCandidateRevision: number; operationId: string; operations: unknown }) {
    await this.accessible()
    id(input.taskId, 'taskId'); id(input.operationId, 'operationId')
    if (!Number.isSafeInteger(input.expectedCandidateRevision) || input.expectedCandidateRevision < 1) throw new DesktopCircuitError(400, 'expectedCandidateRevision must be a positive integer')
    let operations
    try { operations = parseCandidateEditOperations(input.operations) }
    catch (error) { throw new DesktopCircuitError(400, (error as Error).message) }
    const fingerprint = canonicalFingerprint({ taskId: input.taskId, expectedCandidateRevision: input.expectedCandidateRevision, operations })
    const replay = (task: DesktopCircuitTask) => {
      const receipt = task.editOperations?.find(item => item.operationId === input.operationId)
      if (!receipt) return null
      if (receipt.fingerprint !== fingerprint) throw new DesktopCircuitError(409, 'operationId has already committed a different request')
      return clone(receipt.result)
    }
    const recorded = replay(this.task(input.taskId))
    if (recorded) return recorded
    return this.operation(input.taskId, async (task, runtime) => {
      const repeated = replay(task)
      if (repeated) return repeated
      if ((task.candidateRevision ?? 1) !== input.expectedCandidateRevision) throw new DesktopCircuitError(409, 'Candidate version changed; read the current candidate before editing')
      if ((task.editOperations?.length ?? 0) >= workbenchMcpLimits.maxEditReceiptsPerTask) throw new DesktopCircuitError(409, 'Candidate operation receipt limit reached; start a new task')
      const before = runtime.tools.captureCandidateState(), beforeEvents = clone(task.events), beforeUpdatedAt = task.updatedAt
      runtime.committing = { candidate: before.project, revision: before.candidateRevision }
      try {
        const output = await runtime.tools.execute('edit_candidate', { operations }) as { changed: boolean; operationCount: number; issues: string[] }
        if (task.status !== 'running' || runtime.abort.signal.aborted) throw new DesktopCircuitError(409, 'Task stopped before candidate edit was committed')
        const result: DesktopCircuitEditResult = { taskId: task.id, operationId: input.operationId, candidateRevision: runtime.tools.candidateRevision,
          changed: output.changed, operationCount: output.operationCount, issues: output.issues }
        const next = clone(task)
        delete next.error; next.updatedAt = new Date().toISOString()
        next.candidateRevision = result.candidateRevision; next.checkpointCandidate = runtime.tools.candidate
        next.editOperations = [...(task.editOperations ?? []), { operationId: input.operationId, fingerprint, result }]
        task.events = beforeEvents
        task.updatedAt = beforeUpdatedAt
        await this.persist({ task, next, accepted: () => { delete runtime.committing }, rejected: () => {
          runtime.tools.restoreCandidateState(before); delete runtime.committing
        } })
        return clone(result)
      } catch (error) {
        runtime.tools.restoreCandidateState(before); delete runtime.committing
        task.events = beforeEvents
        if (task.status === 'running') task.updatedAt = beforeUpdatedAt
        throw error instanceof DesktopCircuitError ? error : new DesktopCircuitError(422, (error as Error).message.slice(0, 2000))
      }
    })
  }
  async finish(taskId: string, summary: string) {
    await this.accessible(); boundedText(summary, 'summary')
    const existing = this.task(taskId)
    if (existing.status === 'completed') {
      if (existing.result?.summary !== summary) throw new DesktopCircuitError(409, '已完成任务不能替换说明')
      return { task: clone(existing) }
    }
    return this.operation(taskId, async (task, runtime) => {
      try {
        const failure = runtime.tools.lastFailure
        if (failure) throw new DesktopCircuitError(409, `工具 ${failure.name} 尚未修复：${failure.message}`)
        const validation = await runtime.tools.execute('validate_circuit', {}) as { valid: boolean; issues: string[] }
        if (!validation.valid) throw new DesktopCircuitError(409, `候选电路尚未通过校验：${validation.issues.join('；')}`)
        const candidate = runtime.tools.candidate
        const simulation = runtime.tools.simulation as AgentSimulation | null
        const baseline = parseProject(task.baseline, { allowDraft: true })
        const electricalBaseline = task.sourceTaskId ? this.sourceCandidate(task.projectId, task.sourceTaskId, baseline) : baseline
        const electricalChanged = task.layoutOnly ? !layoutElectricallyEquivalent(electricalBaseline, candidate) : projectKey(candidate) !== projectKey(electricalBaseline)
        if (electricalChanged && (!simulation || simulation.stale || simulation.points <= 0 || !/ngspice/i.test(simulation.engine))) throw new DesktopCircuitError(409, '电气修改缺少当前候选的 ngspice 结果，请先调用 simulate_circuit；旧结果不能作为验证')
        if (task.status !== 'running' || runtime.abort.signal.aborted) throw new DesktopCircuitError(409, '任务已停止')
        const changed = desktopCircuitFingerprint(candidate) !== desktopCircuitFingerprint(electricalBaseline)
        task.result = { summary, changed, simulation, proposal: { summary, project: candidate, base: aiProjectFingerprint(task.baseline), changes: proposalChanges(task.baseline, candidate), warnings: validateProject(candidate) }, modelAcquisitions: runtime.tools.modelAcquisitions }
        task.status = 'completed'; delete task.error; task.updatedAt = new Date().toISOString()
        await this.persist(); this.runtimes.delete(task.id)
        return { task: clone(task) }
      } catch (error) {
        task.error = (error as Error).message.slice(0, 2000); task.updatedAt = new Date().toISOString(); await this.persist()
        throw error instanceof DesktopCircuitError ? error : new DesktopCircuitError(422, task.error)
      }
    })
  }
  async cancel(taskId: string) {
    await this.accessible(); const task = this.task(taskId)
    if (task.status !== 'running') return { task: clone(task) }
    const runtime = this.runtimes.get(taskId)
    task.status = 'cancelled'; task.error = '任务已取消；网页画布未改动'; task.updatedAt = new Date().toISOString(); runtime?.abort.abort()
    await runtime?.queue.catch(() => {}); this.runtimes.delete(taskId); await this.persist()
    return { task: clone(task) }
  }
  async cancelProjectTask(projectId: string, taskId: string): Promise<DesktopCircuitState> {
    await this.accessible(); id(projectId, 'projectId')
    if (this.task(taskId).projectId !== projectId) throw new DesktopCircuitError(403, '该电路任务不属于当前工程，未取消其他工程任务')
    await this.cancel(taskId)
    return this.state(projectId)
  }
  async close() {
    await this.ready; if (this.closed) return; this.closed = true
    for (const [taskId, runtime] of this.runtimes) {
      const task = this.tasks.get(taskId)!
      task.status = 'interrupted'; task.error = '服务已关闭；任务未完成，画布未改动'; task.updatedAt = new Date().toISOString(); runtime.abort.abort()
    }
    await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.queue))
    this.runtimes.clear(); await this.persist()
    const path = join(this.options.directory, 'connection.json')
    try { const data = JSON.parse(await readFile(path, 'utf8')); if (data.token === this.token) await unlink(path) } catch { /* Another instance may already own the connection. */ }
  }
}
