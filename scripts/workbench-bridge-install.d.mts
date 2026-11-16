export class WorkbenchBridgeInstallError extends Error {
  constructor(status: number, message: string)
  status: number
}
export function installWorkbenchBridge(options: {
  connection: string
  expectedWorkspace?: string
  relink?: boolean
  root?: string
  sourceDirectory?: string
}): Promise<{ mcpServers: { fuxian: { command: string; args: string[] } } }>
