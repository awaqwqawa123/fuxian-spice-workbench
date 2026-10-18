import { DESKTOP_CONTROL_API } from './desktop-control'
import { readLocalService } from './local-service-request'

export interface DesktopConversationFolderSetting { directory: string | null; defaultDirectory: string }

async function request(directory?: string | null, signal?: AbortSignal): Promise<DesktopConversationFolderSetting> {
  const { response, value } = await readLocalService(`${DESKTOP_CONTROL_API}/conversation-folder`, {
    method: directory === undefined ? 'GET' : 'POST', signal,
    headers: { 'X-Fuxian-Desktop-Control': '1', ...(directory === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(directory === undefined ? {} : { body: JSON.stringify({ directory }) }),
  })
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : '无法保存电路对话文件夹')
  if (!value || value.directory !== null && typeof value.directory !== 'string' || typeof value.defaultDirectory !== 'string') throw new Error('工作台返回的电路对话文件夹设置格式不正确')
  return value
}

export const getDesktopConversationFolder = (signal?: AbortSignal) => request(undefined, signal)
export const setDesktopConversationFolder = (directory: string | null, signal?: AbortSignal) => request(directory, signal)
