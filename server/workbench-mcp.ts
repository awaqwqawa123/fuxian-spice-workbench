import { circuitAgentInstructions, circuitAgentTools } from '../src/core/agent-circuit'
import { schematicSvg } from '../src/core/export-svg'
import { DesktopCircuitError, type DesktopCircuitManager } from './desktop-circuit-manager'
import type { DesktopCircuitStart } from '../src/core/desktop-circuit'
import { modelCategories, modelCategoryGroups } from '../src/core/model-taxonomy'
import { workbenchApplicationInfo, workbenchMcpServerInfo, workbenchMcpVersions, workbenchMcpCapabilities, workbenchMcpLimits, workbenchTaskStatuses } from './workbench-mcp-runtime'
import { circuitGraphQueryProperties, circuitGraphOutputSchema, parseCircuitGraphQuery } from '../src/core/circuit-semantic-graph'
import { candidateDiffOutputSchema } from '../src/core/candidate-diff'
import { candidateEditOperationsSchema } from '../src/core/candidate-edit'

export { workbenchMcpVersions } from './workbench-mcp-runtime'
const identifier = { type: 'string', minLength: 1, maxLength: workbenchMcpLimits.maxIdentifierCharacters }
const text = { type: 'string', minLength: 1, maxLength: workbenchMcpLimits.maxRequestCharacters }
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
function schema(properties: Record<string, unknown>, required: string[] = Object.keys(properties)) {
  return { type: 'object', properties, required, additionalProperties: false }
}
const managementTools = [
  { name: 'get_workbench_status', description: 'Read versioned workbench readiness, supported capabilities, enforced task limits, synchronized project metadata and task counts by status. Omits drawings, model source, titles, task requests, credentials and storage paths. Finished candidates require workbench review.',
    inputSchema: schema({}), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: schema({
      schemaVersion: { type: 'integer', const: 1 }, ready: { type: 'boolean', const: true },
      application: schema({ name: { type: 'string', const: workbenchApplicationInfo.name }, version: { type: 'string' } }),
      server: schema({ name: { type: 'string', const: workbenchMcpServerInfo.name }, version: { type: 'string' } }),
      transport: { type: 'string', const: 'stdio' }, scope: { type: 'string', const: 'local' },
      protocolVersions: { type: 'array', items: { type: 'string', enum: [...workbenchMcpVersions] } },
      applicationMode: { type: 'string', const: 'review' },
      toolCount: { type: 'integer', minimum: 1 }, capabilities: { type: 'array', items: { type: 'string', enum: [...workbenchMcpCapabilities] } },
      limits: schema(Object.fromEntries(Object.entries(workbenchMcpLimits).map(([key, value]) => [key, { type: 'integer', const: value }]))),
      projects: schema({ count: { type: 'integer', minimum: 0 }, items: { type: 'array', items: schema({
        projectId: identifier, revision: { type: 'integer', minimum: 1 }, updatedAt: { type: 'string' },
        deviceCount: { type: 'integer', minimum: 0 }, modelCount: { type: 'integer', minimum: 0 },
        activeTaskId: { type: ['string', 'null'] },
      }) } }),
      tasks: schema({ count: { type: 'integer', minimum: 0 }, byStatus: schema(Object.fromEntries(workbenchTaskStatuses.map(status => [status, { type: 'integer', minimum: 0 }]))) }),
    }) },
  { name: 'list_projects', description: 'List synchronized project metadata without full drawings or model source. Open a project in the workbench first if absent.', inputSchema: schema({}) },
  { name: 'get_circuit_graph', description: 'Read bounded electrical components, nets or terminals from the authoritative drawing compiler. Without taskId reads the last synchronized saved snapshot, excluding unsynchronized canvas changes. taskId reads that exact running or completed candidate and must belong to projectId; unavailable candidates fail without saved fallback. Pin indices are drawing terminal indices; only X pins follow ordered subcircuit ports. Physical package numbers are separate; synthesized simulator elements may reorder or expand terminals. Filters combine by intersection. Reuse returned graphKey as expectedGraphKey on subsequent pages to reject edits between reads. Observational; consumes no task call or event.',
    inputSchema: schema({ projectId: identifier, taskId: identifier, expectedGraphKey: { type: 'string', pattern: '^[a-f0-9]{64}$' }, ...circuitGraphQueryProperties }, ['projectId']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: schema({ projectId: identifier, revision: { type: 'integer', minimum: 1 }, synchronizedAt: { type: 'string' },
      baselineRevision: { type: ['integer', 'null'], minimum: 1 }, candidateRevision: { type: ['integer', 'null'], minimum: 1 }, taskId: { type: ['string', 'null'] },
      taskStatus: { type: ['string', 'null'], enum: [...workbenchTaskStatuses, null] },
      source: { type: 'string', enum: ['synchronized', 'candidate'] }, graphKey: { type: 'string', pattern: '^[a-f0-9]{64}$' }, graph: circuitGraphOutputSchema }) },
  { name: 'inspect_project', description: 'Inspect a current synchronized project, revision, active task, circuit geometry and instructions. Optional sourceTaskId inspects an existing review candidate.', inputSchema: schema({ projectId: identifier, sourceTaskId: identifier }, ['projectId']) },
  { name: 'start_circuit_task', description: 'Start one idempotent candidate task bound to a project and exact revision. requestId identifies retries. layoutOnly defaults to false. Never edits the live canvas.', inputSchema: schema({ projectId: identifier, expectedRevision: { type: 'integer', minimum: 1 }, requestId: identifier, request: text, layoutOnly: { type: 'boolean', default: false }, sourceTaskId: identifier }, ['projectId', 'expectedRevision', 'requestId', 'request']) },
  { name: 'get_circuit_task', description: 'Read task status, events, candidate, current snapshot and merge/conflict resolution without consuming a circuit tool call.', inputSchema: schema({ taskId: identifier }) },
  { name: 'diff_candidate', description: 'Read bounded candidate changes, electrical equivalence and conflicts against the latest synchronized canvas. Does not merge or apply edits or spend task calls. Optional expectedCandidateRevision rejects changed candidates. Interrupted/cancelled checkpoints may be reviewed but cannot be edited. Equivalence is conservative, not engineering acceptance; null means unreadable connectivity. Omits drawings, model source and before/after values.',
    inputSchema: schema({ taskId: identifier, expectedCandidateRevision: { type: 'integer', minimum: 1 } }, ['taskId']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: schema({ taskId: identifier, projectId: identifier, revision: { type: 'integer', minimum: 1 },
      baselineRevision: { type: 'integer', minimum: 1 }, candidateRevision: { type: 'integer', minimum: 1 },
      taskStatus: { type: 'string', enum: [...workbenchTaskStatuses] }, applicationMode: { type: 'string', const: 'review' }, diff: candidateDiffOutputSchema }) },
  { name: 'edit_candidate', description: 'Atomically apply 1–32 bounded local operations to a review candidate at expectedCandidateRevision. All operations succeed together or leave the candidate unchanged. Stable operationId retries return the original durable result without consuming another call; reuse with different arguments fails. Successful receipts survive restart, but interrupted tasks cannot accept new edits. Never applies to the live canvas.',
    inputSchema: schema({ taskId: identifier, operationId: identifier, expectedCandidateRevision: { type: 'integer', minimum: 1 }, operations: candidateEditOperationsSchema }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: schema({ taskId: identifier, operationId: identifier, candidateRevision: { type: 'integer', minimum: 1 }, changed: { type: 'boolean' },
      operationCount: { type: 'integer', minimum: 1, maximum: workbenchMcpLimits.maxAtomicEditOperations }, issues: { type: 'array', items: { type: 'string' } } }) },
  { name: 'finish_circuit_task', description: 'Validate and publish the candidate for workbench review. Electrical edits require successful current ngspice results. Does not automatically apply to the canvas.', inputSchema: schema({ taskId: identifier, summary: text }) },
  { name: 'cancel_circuit_task', description: 'Cancel a running task and its simulation; the live canvas remains intact.', inputSchema: schema({ taskId: identifier }) },
  { name: 'get_circuit_preview', description: 'Render the real project schematic with original symbols and probes as SVG. Optional taskId must belong to projectId and shows its validated candidate.', inputSchema: schema({ projectId: identifier, taskId: identifier }, ['projectId']) },
  { name: 'browse_local_models', description: 'Browse paginated local PSpice/LTspice/TINA device summaries. Compatible PSpice versions are recommended first; other libraries remain available when missing. An explicit source filter limits results to that library. Returns status 202 while building an initial index; retry later. Reads the compiled cache, not every model file. Use the selected model key with get_local_model.', inputSchema: schema({ query: { type: 'string', maxLength: 100 }, category: { type: 'string', enum: ['', ...modelCategoryGroups.map(group => group.id), ...modelCategories.map(leaf => leaf.id)] }, source: { type: 'string', enum: ['', 'pspice', 'ltspice', 'tina'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 60 } }, []) },
  { name: 'get_local_model', description: 'Read one complete local model and its verified symbol by key returned from browse_local_models. Read only; use task-scoped search/download/import tools to add models to a candidate.', inputSchema: schema({ key: { type: 'string', pattern: '^[a-f0-9]{64}$' } }) },
]
// SDK clients validate structured error content too. Both outcomes must obey the advertised contract.
const diagnosticSchema = schema({ error: { type: 'string' }, status: { type: 'integer', minimum: 400, maximum: 599 } })
const readOnlyManagementTools = new Set(['list_projects', 'inspect_project', 'get_circuit_task', 'get_circuit_preview', 'browse_local_models', 'get_local_model'])
export const workbenchMcpTools = [...managementTools.map(tool => ({ ...tool,
  ...(readOnlyManagementTools.has(tool.name) ? { annotations: readOnlyAnnotations } : {}),
  ...('outputSchema' in tool && tool.outputSchema ? { outputSchema: { type: 'object', anyOf: [tool.outputSchema, diagnosticSchema] } } : {}),
})), ...circuitAgentTools.map(tool => ({ name: tool.name,
  description: `${tool.description} Requires taskId from start_circuit_task.`,
  inputSchema: { ...tool.parameters, properties: { ...tool.parameters.properties, taskId: identifier },
    required: [...('required' in tool.parameters ? tool.parameters.required : []), 'taskId'] } }))]

class RpcError extends Error { constructor(readonly code: number, message: string) { super(message) } }
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function checkedParams(value: unknown, allowed: string[], required: string[] = []) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => value[key] === undefined)) throw new RpcError(-32602, 'Invalid params')
  return value
}
function checkedProtocolParams(value: unknown, allowed: string[], required: string[] = []) {
  const params = checkedParams(value, [...allowed, '_meta'], required)
  if ('_meta' in params) {
    if (!isObject(params._meta)) throw new RpcError(-32602, 'Invalid protocol metadata')
    const token = params._meta.progressToken
    if (token !== undefined && !(typeof token === 'string' || typeof token === 'number' && Number.isFinite(token))) throw new RpcError(-32602, 'Invalid progress token')
  }
  return params
}
function managementArguments(name: string, input: unknown) {
  const tool = managementTools.find(tool => tool.name === name)!
  const args = checkedParams(input, Object.keys(tool.inputSchema.properties), tool.inputSchema.required)
  if (name === 'browse_local_models') return args // Shared catalog parser validates filters and bounds.
  if (name === 'get_circuit_graph') {
    const { projectId, taskId, expectedGraphKey, ...filters } = args
    if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > workbenchMcpLimits.maxIdentifierCharacters || projectId.includes('\0') ||
      taskId !== undefined && (typeof taskId !== 'string' || !taskId.trim() || taskId.length > workbenchMcpLimits.maxIdentifierCharacters || taskId.includes('\0')) ||
      expectedGraphKey !== undefined && (typeof expectedGraphKey !== 'string' || !/^[a-f0-9]{64}$/.test(expectedGraphKey)))
      throw new RpcError(-32602, 'Invalid graph identity')
    try { parseCircuitGraphQuery(filters) } catch (error) { throw new RpcError(-32602, (error as Error).message) }
    return args
  }
  for (const [key, value] of Object.entries(args)) {
    if (name === 'edit_candidate' && key === 'operations') continue // Shared domain parser supplies bounded operation diagnostics.
    if (key === 'layoutOnly') { if (typeof value !== 'boolean') throw new RpcError(-32602, 'layoutOnly must be boolean') }
    else if (key === 'expectedRevision' || key === 'expectedCandidateRevision') { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new RpcError(-32602, `${key} must be a positive integer`) }
    else if (typeof value !== 'string' || !value.trim() || value.length > (key === 'request' || key === 'summary' ? workbenchMcpLimits.maxRequestCharacters : workbenchMcpLimits.maxIdentifierCharacters)) throw new RpcError(-32602, `${key} must be a bounded nonempty string`)
  }
  return args
}
async function callTool(manager: DesktopCircuitManager, name: string, input: unknown) {
  if (!workbenchMcpTools.some(tool => tool.name === name)) throw new RpcError(-32602, `Unknown tool: ${name.slice(0, 100)}`)
  const args = managementTools.some(tool => tool.name === name) ? managementArguments(name, input) : checkedParams(input,
    [...Object.keys(workbenchMcpTools.find(tool => tool.name === name)!.inputSchema.properties), 'taskId'], ['taskId'])
  try {
    let result: unknown
    if (name === 'get_workbench_status') result = {
      schemaVersion: 1, ready: true, application: { ...workbenchApplicationInfo }, server: { ...workbenchMcpServerInfo },
      transport: 'stdio', scope: 'local', protocolVersions: [...workbenchMcpVersions], applicationMode: 'review',
      toolCount: workbenchMcpTools.length, capabilities: [...workbenchMcpCapabilities], limits: { ...workbenchMcpLimits },
      ...await manager.workbenchStatus(),
    }
    else if (name === 'list_projects') result = await manager.projectMetadata()
    else if (name === 'get_circuit_graph') result = await manager.circuitGraph(args)
    else if (name === 'browse_local_models') result = await manager.browseLocalModels(args)
    else if (name === 'get_local_model') result = await manager.getLocalModel(args.key as string)
    else if (name === 'inspect_project') result = await manager.inspect(args.projectId as string, args.sourceTaskId as string | undefined)
    else if (name === 'start_circuit_task') result = await manager.start({ ...args, layoutOnly: args.layoutOnly ?? false } as unknown as DesktopCircuitStart)
    else if (name === 'get_circuit_task') result = await manager.inspectTask(args.taskId as string)
    else if (name === 'diff_candidate') result = await manager.diffCandidate(args)
    else if (name === 'edit_candidate') result = await manager.editCandidate(args as unknown as Parameters<DesktopCircuitManager['editCandidate']>[0])
    else if (name === 'finish_circuit_task') result = await manager.finish(args.taskId as string, args.summary as string)
    else if (name === 'cancel_circuit_task') result = await manager.cancel(args.taskId as string)
    else if (name === 'get_circuit_preview') {
      const snapshot = (await manager.state(args.projectId as string)).snapshot
      if (!snapshot) throw new DesktopCircuitError(404, '网页尚未同步该工程，请先打开对应画布')
      const task = args.taskId ? await manager.inspectTask(args.taskId as string) : null
      if (task && task.task.projectId !== args.projectId) throw new DesktopCircuitError(403, '该电路任务不属于当前工程')
      const project = task?.candidate ?? snapshot.project
      if (!project.drawing) throw new DesktopCircuitError(422, '工程尚未包含可预览的电路图')
      result = { projectId: args.projectId, taskId: args.taskId ?? null, mimeType: 'image/svg+xml',
        svg: schematicSvg(project.drawing, { title: project.title, models: project.models, probes: project.probes }) }
    } else {
      const { taskId, ...parameters } = args
      result = await manager.call(taskId as string, name, parameters)
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false }
  } catch (error) {
    const diagnostic = { error: error instanceof DesktopCircuitError ? error.message : '本地电路工具服务失败，请检查工作台服务日志',
      status: error instanceof DesktopCircuitError ? error.status : 500 }
    return { content: [{ type: 'text', text: JSON.stringify(diagnostic) }], structuredContent: diagnostic, isError: true }
  }
}

/** Local authenticated JSON-RPC endpoint behind the standard MCP stdio adapter. */
export async function handleWorkbenchMcp(manager: DesktopCircuitManager, raw: unknown): Promise<{ status: number; body?: unknown }> {
  let id: unknown = null
  try {
    if (!isObject(raw) || raw.jsonrpc !== '2.0' || typeof raw.method !== 'string' ||
      ('id' in raw && !(typeof raw.id === 'string' || typeof raw.id === 'number' && Number.isFinite(raw.id))) ||
      Object.keys(raw).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key)) ||
      ('params' in raw && !isObject(raw.params))) throw new RpcError(-32600, 'Invalid Request')
    if (!('id' in raw)) return { status: 202 }
    id = raw.id
    let result: unknown
    if (raw.method === 'initialize') {
      const params = checkedProtocolParams(raw.params, ['protocolVersion', 'capabilities', 'clientInfo'], ['protocolVersion', 'capabilities', 'clientInfo'])
      if (typeof params.protocolVersion !== 'string' || !isObject(params.capabilities) || !isObject(params.clientInfo) ||
        typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') throw new RpcError(-32602, 'Invalid initialize params')
      result = { protocolVersion: workbenchMcpVersions.includes(params.protocolVersion as typeof workbenchMcpVersions[number]) ? params.protocolVersion : workbenchMcpVersions.at(-1),
        capabilities: { tools: { listChanged: false } }, serverInfo: { ...workbenchMcpServerInfo },
        instructions: `Operate only synchronized projects. Use inspect_project then start_circuit_task with exact revision and stable requestId. All edits are candidates, finished tasks require workbench review. Never claim a candidate is applied. ${circuitAgentInstructions}` }
    } else if (raw.method === 'ping') { checkedProtocolParams(raw.params ?? {}, []); result = {} }
    else if (raw.method === 'tools/list') { checkedProtocolParams(raw.params ?? {}, ['cursor']); result = { tools: workbenchMcpTools } }
    else if (raw.method === 'tools/call') {
      const params = checkedProtocolParams(raw.params, ['name', 'arguments'], ['name'])
      if (typeof params.name !== 'string' || params.name.length > 128) throw new RpcError(-32602, 'Invalid tool name')
      result = await callTool(manager, params.name, params.name === 'get_workbench_status' && 'arguments' in params ? params.arguments : params.arguments ?? {})
    } else throw new RpcError(-32601, 'Method not found')
    return { status: 200, body: { jsonrpc: '2.0', id, result } }
  } catch (error) {
    return { status: 200, body: { jsonrpc: '2.0', id, error: { code: error instanceof RpcError ? error.code : -32603,
      message: error instanceof RpcError ? error.message : 'Internal error' } } }
  }
}
