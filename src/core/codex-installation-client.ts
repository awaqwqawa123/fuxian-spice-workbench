import { readLocalService } from './local-service-request'

export interface CodexInstallationInfo {
  configuredPath: string | null
  effectivePath: string | null
  source: 'manual' | 'automatic'
  available: boolean
  message: string
}
async function request(executable?: string | null, signal?: AbortSignal): Promise<CodexInstallationInfo> {
  const { response, value } = await readLocalService('/api/codex/installation', {
    method: executable === undefined ? 'GET' : 'POST', signal,
    headers: { 'X-Fuxian-Codex-Installation': '1', ...(executable === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(executable === undefined ? {} : { body: JSON.stringify({ executable }) }),
  })
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : '无法读取或保存 Codex 安装路径')
  const path = (value: unknown) => value === null || typeof value === 'string' && value.length <= 2048
  if (!value || !path(value.configuredPath) || !path(value.effectivePath) || !['manual', 'automatic'].includes(value.source) || typeof value.available !== 'boolean' || typeof value.message !== 'string' || value.message.length > 4000) throw new Error('Codex 安装路径响应格式不正确，请更新或重启工作台服务')
  return value as CodexInstallationInfo
}
export const getCodexInstallation = (signal?: AbortSignal) => request(undefined, signal)
export const setCodexInstallation = (executable: string | null, signal?: AbortSignal) => request(executable, signal)
