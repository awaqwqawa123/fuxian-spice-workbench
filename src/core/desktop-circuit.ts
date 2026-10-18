import { parseProject, type Project } from './circuit'
import type { AgentResult, AgentToolEvent } from './agent-client'

/** Browser and desktop exchange candidates, never ownership of a Codex chat. */
export interface DesktopCircuitSnapshot {
  projectId: string
  revision: number
  project: Project
  updatedAt: string
}
export interface DesktopCircuitTask {
  id: string
  projectId: string
  requestId: string
  request: string
  source: 'desktop'
  status: 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed'
  baseline: Project
  baselineRevision: number
  layoutOnly: boolean
  /** Monotonic candidate version. Legacy saved tasks default to 1. */
  candidateRevision?: number
  /** Last durable candidate; does not authorize resuming interrupted work. */
  checkpointCandidate?: Project
  editOperations?: DesktopCircuitEditReceipt[]
  sourceTaskId?: string
  events: AgentToolEvent[]
  result: AgentResult | null
  error?: string
  createdAt: string
  updatedAt: string
}
export interface DesktopCircuitEditResult {
  taskId: string
  operationId: string
  candidateRevision: number
  changed: boolean
  operationCount: number
  issues: string[]
}
export interface DesktopCircuitEditReceipt {
  operationId: string
  fingerprint: string
  result: DesktopCircuitEditResult
}
export interface DesktopCircuitState {
  snapshot: DesktopCircuitSnapshot | null
  tasks: DesktopCircuitTask[]
  /** Absolute CLI path only. Never contains the agent authentication token. */
  cliPath: string
}
export interface DesktopCircuitSync {
  projectId: string
  project: Project
  /** null only for first attachment; a different existing snapshot returns 409. */
  expectedRevision: number | null
}
export interface DesktopCircuitStart {
  projectId: string
  expectedRevision: number
  requestId: string
  request: string
  layoutOnly: boolean
  sourceTaskId?: string
}
export const DESKTOP_CIRCUIT_API = '/api/desktop-circuit'

/** Compare validated project data without making key order or parser defaults a conflict. */
export function desktopCircuitFingerprint(project: Project): string {
  const normalized = parseProject(project, { allowDraft: true })
  if (!normalized.probes?.length) delete normalized.probes
  return JSON.stringify(normalized, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value)
}
