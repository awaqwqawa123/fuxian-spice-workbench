import { CodexRuntimeError, getCodexStatus, runCodexAgent, type CodexRunOptions, type CodexRuntimeOptions } from './codex-runtime'
import type { Project } from '../src/core/circuit'
import { codexProjectBinding, type CodexDesktopState } from './codex-session-native'
import type { CodexWorkbenchLink } from '../src/core/codex-workbench-link'

/** Codex persists a new thread only after its first turn. Creation therefore prepares
 * a workbench record; the first send creates and starts its durable native thread. */
export async function createCodexCircuitSession(options: CodexRuntimeOptions & { workingDirectory: string; projectDirectory?: string }) {
  const status = await getCodexStatus(options)
  if (!status.available || !status.model) throw new CodexRuntimeError(status.message)
  const binding = options.projectDirectory ? await codexProjectBinding(options.projectDirectory, options).catch(() => ({ projectId: null, projectName: null })) : { projectId: null, projectName: null }
  const desktop: CodexDesktopState = { ...binding, syncStatus: 'unverified', message: binding.projectId ? '新对话将保存到对应的 Codex 项目。首轮完成后可在桌面打开。' : '首轮完成后可通过 Thread 链接在 Codex 桌面打开。' }
  return { threadId: '', model: status.model, desktop }
}

export function runCodexCircuitSession(request: { threadId: string; model: string; project: Project; message: string; context?: string; revision?: Project; projectId?: string | null; workbench?: CodexWorkbenchLink }, options: CodexRunOptions & { workingDirectory: string; onThreadStarted?: (thread: { threadId: string; model: string }) => Promise<void> }) {
  return runCodexAgent({ project: request.project, prompt: request.message, model: request.model, revision: request.revision }, {
    ...options, persistentSession: { threadId: request.threadId, effort: 'medium', onStarted: options.onThreadStarted, projectId: request.projectId ?? undefined, name: `伏线 · ${request.project.title}`.slice(0, 100), context: request.context, workbench: request.workbench },
  })
}
