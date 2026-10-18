import { readFileSync } from 'node:fs'

/** Server-only metadata shared by discovery and the task manager; no credentials. */
export const workbenchApplicationInfo = {
  name: 'spice-workbench',
  version: (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version,
} as const
export const workbenchMcpServerInfo = { name: 'fuxian-workbench', version: '1.0.0' } as const
export const workbenchMcpVersions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'] as const
export const workbenchMcpCapabilities = ['projects', 'circuit-design', 'circuit-graph', 'atomic-candidate-edit', 'candidate-diff', 'model-search', 'local-model-library', 'simulation', 'task-status', 'cancel', 'schematic-preview', 'workbench-status'] as const
export const workbenchTaskStatuses = ['running', 'completed', 'cancelled', 'interrupted', 'failed'] as const
/** These bounds are enforced by the MCP schemas and DesktopCircuitManager. */
export const workbenchMcpLimits = {
  maxIdentifierCharacters: 128,
  maxRequestCharacters: 8000,
  maxToolCallsPerTask: 128,
  maxActiveTasksPerProject: 1,
  maxAtomicEditOperations: 32,
  maxEditReceiptsPerTask: 128,
} as const
