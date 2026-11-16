export interface WorkbenchMcpInfo {
  ready: boolean
  protocol: 'MCP'
  transport: 'stdio'
  config: { mcpServers: { fuxian: { command: string; args: string[] } } }
  toolCount: number
  capabilities: string[]
  applicationMode: 'review'
  message: string
  synchronizedProjectCount?: number
  runningTaskCount?: number
  interruptedTaskCount?: number
  workspaceId?: string | null
  bridgeStatus?: 'linked' | 'unlinked' | 'relink-required'
}

export async function getWorkbenchMcpInfo(signal?: AbortSignal): Promise<WorkbenchMcpInfo> {
  const response = await fetch('/api/desktop-circuit/mcp-info', { headers: { 'x-fuxian-desktop': '1' }, signal })
  return decodeWorkbenchMcpInfo(response)
}

export async function activateWorkbenchMcpBridge(signal?: AbortSignal): Promise<WorkbenchMcpInfo> {
  const response = await fetch('/api/desktop-circuit/mcp-bridge', {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json', 'x-fuxian-desktop': '1' }, body: '{}',
  })
  const info = await decodeWorkbenchMcpInfo(response)
  if (info.bridgeStatus !== 'linked') throw new Error('工作台未确认固定入口已启用，请重新检测。')
  return info
}

async function decodeWorkbenchMcpInfo(response: Response): Promise<WorkbenchMcpInfo> {
  const value = await response.json()
  if (!response.ok) throw new Error(value?.error || '外部助手接口暂不可用，请重试。')
  const server = value?.config?.mcpServers?.fuxian
  const countsValid = ['synchronizedProjectCount', 'runningTaskCount', 'interruptedTaskCount'].every(key =>
    !Object.prototype.hasOwnProperty.call(value ?? {}, key) || Number.isSafeInteger(value[key]) && value[key] >= 0)
  if (typeof value.ready !== 'boolean' || value.protocol !== 'MCP' || value.transport !== 'stdio' || value.applicationMode !== 'review' || !server || typeof server.command !== 'string' || !server.command || !Array.isArray(server.args) || !server.args.every((arg: unknown) => typeof arg === 'string') || !Number.isSafeInteger(value.toolCount) || value.toolCount < 1 || !Array.isArray(value.capabilities) || !value.capabilities.every((item: unknown) => typeof item === 'string') || typeof value.message !== 'string') throw new Error('外部助手接口配置不完整，请更新或重启工作台服务。')
  if (!countsValid) throw new Error('外部助手接口状态不完整，请更新或重启工作台服务。')
  const validId = typeof value.workspaceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.workspaceId)
  if (value.workspaceId != null && !validId || value.bridgeStatus !== undefined && !['linked', 'unlinked', 'relink-required'].includes(value.bridgeStatus)
    || value.bridgeStatus !== undefined && value.bridgeStatus !== 'unlinked' && !validId) throw new Error('固定入口的工作区状态无效，请重新检测。')
  return value as WorkbenchMcpInfo
}
