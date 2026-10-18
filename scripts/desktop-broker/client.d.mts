export interface DesktopControlStatus {
  connected: boolean; ready: boolean; desktopConnected: boolean; loaded: boolean
  threadId: string | null; owner: 'desktop' | 'web'; busy: boolean
  pendingOwner: 'desktop' | 'web' | null; pendingApprovals: number
}
export class DesktopControlClient {
  constructor(options?: {discoveryPath?: string; timeoutMs?: number})
  connected: boolean
  connect(): Promise<this>
  call(method: string, params?: unknown): Promise<any>
  status(threadId?: string | null): Promise<DesktopControlStatus>
  handoff(threadId: string, owner: 'desktop' | 'web'): Promise<DesktopControlStatus>
  registerTools(threadId: string, names: string[]): Promise<Record<string, never>>
  respond(id: string | number, response: {result?: unknown; error?: unknown}): Promise<unknown>
  listen(listener: (event: any) => void): () => void
  close(): void
}
