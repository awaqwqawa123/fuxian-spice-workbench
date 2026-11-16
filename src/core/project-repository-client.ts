import type { ProjectCollection } from './project-store'

export interface RepositorySnapshot { collection: ProjectCollection; revision: string | null }
export interface RepositorySelection { activeId: string; revision: string }
export class ProjectRepositoryError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export function repositoryRequest(input: {action:'bootstrap'} | {action:'migrate'; collection:ProjectCollection} | {action:'save'; collection:ProjectCollection; expectedRevision:string|null}, signal?: AbortSignal): Promise<RepositorySnapshot>
export function repositoryRequest(input: {action:'select'; activeId:string; expectedRevision:string}, signal?: AbortSignal): Promise<RepositorySelection>
export async function repositoryRequest(input: object, signal?: AbortSignal) {
  const response = await fetch('/api/project-repository', {
    method:'POST', credentials:'same-origin', cache:'no-store', headers:{'Content-Type':'application/json','x-fuxian-project-repository':'1'},
    body:JSON.stringify(input), signal,
  })
  let result
  try { result = await response.json() }
  catch { throw new ProjectRepositoryError('无法读取本机工程库，请检查工作台服务。', response.status) }
  if (!response.ok) throw new ProjectRepositoryError(typeof result?.error === 'string' ? result.error : '本机工程库暂不可用。', response.status)
  if (!result || typeof result !== 'object' || !(result.revision === null || typeof result.revision === 'string')) throw new Error('本机工程库返回了无法识别的版本。')
  if ('action' in input && input.action === 'select') {
    if (typeof result.revision !== 'string' || typeof result.activeId !== 'string') throw new Error('无法确认已保存的工程选择。')
  } else if (result.collection?.version !== 1 || !Array.isArray(result.collection.entries) || typeof result.collection.activeId !== 'string'
    || (result.collection.entries.length ? !result.collection.entries.some((entry: {id:string}) => entry.id === result.collection.activeId) : result.collection.activeId !== '')) {
    throw new Error('本机工程库返回的项目列表不完整。')
  }
  return result
}
