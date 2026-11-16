import type { ProjectEntry } from './project-store'

export interface ProjectBackupSummary { id: string; updatedAt: number; title: string }
export interface ProjectBackupPage { backups: ProjectBackupSummary[]; more: boolean }

async function request(input: object, signal?: AbortSignal) {
  const response = await fetch('/api/project-repository', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'x-fuxian-project-repository': '1' },
    body: JSON.stringify(input), signal,
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result || typeof result !== 'object') {
    throw new Error(typeof result?.error === 'string' ? result.error : '暂时无法读取本机备份，请检查工作台服务。')
  }
  return result
}

export async function listProjectBackups(offset: number, signal?: AbortSignal): Promise<ProjectBackupPage> {
  const result = await request({ action: 'list-backups', offset }, signal)
  if (!Array.isArray(result.backups) || typeof result.more !== 'boolean' || result.backups.some((row: ProjectBackupSummary) =>
    !row || typeof row.id !== 'string' || typeof row.title !== 'string' || !Number.isSafeInteger(row.updatedAt))) {
    throw new Error('工作台返回的备份列表无法识别。')
  }
  return result
}

export async function readProjectBackup({ id, updatedAt }: ProjectBackupSummary, signal?: AbortSignal): Promise<ProjectEntry> {
  const { backup } = await request({ action: 'read-backup', id, updatedAt }, signal)
  if (backup?.id !== id || backup?.updatedAt !== updatedAt || typeof backup.project?.title !== 'string') {
    throw new Error('工作台返回的备份内容无法识别。')
  }
  return backup
}
