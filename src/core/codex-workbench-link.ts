export interface CodexWorkbenchLink { url: string; projectId: string }

export function validWorkbenchProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

/** A project return link, never a generic redirect or a provider-controlled URL. */
export function createCodexWorkbenchLink(origin: string, projectId: string, sessionId: string): CodexWorkbenchLink {
  const base = new URL(origin)
  if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.origin !== origin || !validWorkbenchProjectId(projectId)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sessionId)) throw new Error('工作台项目链接格式不正确')
  base.searchParams.set('project', projectId)
  base.searchParams.set('codexSession', sessionId)
  base.hash = 'editor'
  return { url: base.toString(), projectId }
}

export function parseCodexWorkbenchLink(value: unknown, sessionId: string): CodexWorkbenchLink {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工作台项目链接格式不正确')
  const link = value as Record<string, unknown>
  if (typeof link.url !== 'string' || !validWorkbenchProjectId(link.projectId)) throw new Error('工作台项目链接格式不正确')
  const parsed = new URL(link.url), expected = createCodexWorkbenchLink(parsed.origin, link.projectId, sessionId)
  if (expected.url !== link.url) throw new Error('工作台项目链接格式不正确')
  return expected
}
