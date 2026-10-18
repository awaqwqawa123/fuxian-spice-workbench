export type DesktopControlOwner = 'desktop' | 'web'
export interface DesktopControlMessage {
  id: string; role: 'user' | 'assistant'; content: string; createdAt: number
  delivery?: 'sent' | 'unknown' | 'failed'
}
export interface DesktopControlApproval {
  id: string; method: string; title: string; detail: string
  supported: boolean
  canGrantPermissions?: boolean
  questions?: { id: string; question: string; options?: { label: string; description?: string }[]; isSecret?: boolean }[]
}
export interface DesktopControlState {
  projectId: string; threadId: string | null
  connected: boolean; ready: boolean; desktopConnected: boolean
  owner: DesktopControlOwner | null; busy: boolean; pendingOwner: DesktopControlOwner | null
  pendingApprovals: number; approvals: DesktopControlApproval[]
  messages: DesktopControlMessage[]; error: string | null; updatedAt: number
  historyTruncated?: boolean
}
export const DESKTOP_CONTROL_API = '/api/desktop-control'
