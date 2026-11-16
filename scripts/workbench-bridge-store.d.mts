export const WORKSPACE_HEADER: 'x-fuxian-workspace'
export function workspaceIdIsValid(value: unknown): value is string
export function workbenchBridgeDirectory(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string
export function bridgePaths(root: string, platform?: NodeJS.Platform): { bin: string; command: string; script: string; helper: string }
export function publishBridgeFile(path: string, value: unknown, create: boolean): Promise<void>
export function workspaceIdentity(directory: string): Promise<string>
export function bridgeBinding(root: string, workspaceId: string): Promise<{ connection: string }>
export function bridgeHasAssets(root: string): Promise<boolean>
