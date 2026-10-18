import type { LoadedProjectCollection } from './project-store'

/** A desktop link selects an existing local project; it never imports or replaces a drawing. */
export function applyWorkbenchRoute(loaded: LoadedProjectCollection, search: string): LoadedProjectCollection & { sessionId?: string } {
  const query = new URLSearchParams(search), projectId = query.get('project'), sessionId = query.get('codexSession')
  if (!projectId && !sessionId) return loaded
  const problem = !projectId || projectId.length > 128 || !loaded.collection.entries.some(entry => entry.id === projectId)
    ? '此链接的电路工程不在当前浏览器中，已保留当前工程；请在原浏览器打开。'
    : sessionId && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sessionId)
      ? '此链接的会话编号无效，已保留当前工程与对话。' : ''
  if (problem) return { ...loaded, warning: [loaded.warning, problem].filter(Boolean).join(' ') }
  return { ...loaded, collection: { ...loaded.collection, activeId: projectId! }, ...(sessionId ? { sessionId } : {}) }
}
