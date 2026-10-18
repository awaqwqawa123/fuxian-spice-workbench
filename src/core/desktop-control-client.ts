import { DESKTOP_CONTROL_API, type DesktopControlOwner, type DesktopControlState } from './desktop-control'
import { readLocalService } from './local-service-request'

export class DesktopControlRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'DesktopControlRequestError' }
}

async function request(action: string, body: unknown, signal?: AbortSignal): Promise<DesktopControlState> {
  const { response, value: result } = await readLocalService(`${DESKTOP_CONTROL_API}/${action}`, {
    method: body === undefined ? 'GET' : 'POST', signal,
    headers: { 'X-Fuxian-Desktop-Control': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new DesktopControlRequestError(response.status, typeof result?.error === 'string' ? result.error : `工作台共享会话服务返回错误（${response.status}）`)
  if (!result || typeof result.projectId !== 'string' || typeof result.connected !== 'boolean' || !Array.isArray(result.messages) || !Array.isArray(result.approvals)) throw new DesktopControlRequestError(502, '工作台共享会话服务返回格式不正确，请检查后台版本。')
  return result
}
export const getDesktopControlState = (projectId: string, signal?: AbortSignal) => request(`state?projectId=${encodeURIComponent(projectId)}`, undefined, signal)
export type DesktopControlSetupStage = 'not-prepared' | 'prepared' | 'activated' | 'broken'
export type DesktopControlSetupAction = 'prepare' | 'activate' | 'restore'
export interface DesktopControlReconnectResult {
  stage: 'connected' | 'restart-required' | 'waiting-desktop' | 'failed'
  state: DesktopControlState | null
  setupStage?: DesktopControlSetupStage
  restartRequired: boolean
  connected: boolean
  message: string
}
async function reconnect(action: string, projectId?: string, title?: string, signal?: AbortSignal): Promise<DesktopControlReconnectResult> {
  const { response, value } = await readLocalService(`${DESKTOP_CONTROL_API}/${action}`, {
    method: 'POST', signal,
    headers: { 'X-Fuxian-Desktop-Control': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(projectId ? { projectId } : {}), ...(title === undefined ? {} : { title }) }),
  }, 180_000)
  if (!response.ok) throw new DesktopControlRequestError(response.status, typeof value?.error === 'string' ? value.error : `桌面重连服务返回错误（${response.status}）`)
  const state = value?.state
  if (!['connected', 'restart-required', 'waiting-desktop', 'failed'].includes(value?.stage) || typeof value?.message !== 'string' || typeof value?.restartRequired !== 'boolean' || typeof value?.connected !== 'boolean'
    || (projectId ? !state || state.projectId !== projectId || typeof state.connected !== 'boolean' || !Array.isArray(state.messages) || !Array.isArray(state.approvals) : state !== null)) {
    throw new DesktopControlRequestError(502, '桌面重连服务返回格式不正确，请重新启动工作台后台。')
  }
  return value
}
/** Repair and reconnect the official shared desktop service, preserving this project's chat. */
export const reconnectDesktopControl = (projectId?: string, title?: string, signal?: AbortSignal) => reconnect('reconnect', projectId, title, signal)
export const reconnectExplanationControl = (projectId: string, title?: string, signal?: AbortSignal) => reconnect('explain/reconnect', projectId, title, signal)
export async function getDesktopControlSetup(signal?: AbortSignal): Promise<DesktopControlSetupStage> {
  const { response, value } = await readLocalService(`${DESKTOP_CONTROL_API}/setup`, { method: 'GET', signal, headers: { 'X-Fuxian-Desktop-Control': '1' } })
  if (!response.ok || !['not-prepared', 'prepared', 'activated', 'broken'].includes(value?.stage)) throw new DesktopControlRequestError(response.status, '无法读取桌面共享安装状态')
  return value.stage
}
export async function changeDesktopControlSetup(action: DesktopControlSetupAction, signal?: AbortSignal): Promise<DesktopControlSetupStage> {
  const { response, value } = await readLocalService(`${DESKTOP_CONTROL_API}/setup/${action}`, {
    method: 'POST', signal, headers: { 'X-Fuxian-Desktop-Control': '1', 'Content-Type': 'application/json' }, body: '{}',
  }, 125_000)
  if (!response.ok) throw new DesktopControlRequestError(response.status, typeof value?.error === 'string' ? value.error : '桌面共享配置失败')
  if (!['not-prepared', 'prepared', 'activated', 'broken'].includes(value?.stage)) throw new DesktopControlRequestError(502, '桌面共享配置状态格式不正确')
  return value.stage
}
export const bindDesktopControl = (projectId: string, threadId?: string, signal?: AbortSignal, legacySessionId?: string) => request('bind', { projectId, ...(threadId ? { threadId } : {}), ...(legacySessionId ? { legacySessionId } : {}) }, signal)
export const createDesktopControlThread = (projectId: string, signal?: AbortSignal) => request('bind', { projectId, create: true }, signal)
export const ensureDesktopControlThread = (projectId: string, title: string, signal?: AbortSignal) => request('ensure', { projectId, title }, signal)
export const handoffDesktopControl = (projectId: string, owner: DesktopControlOwner, signal?: AbortSignal) => request('handoff', { projectId, owner }, signal)
export const sendDesktopControlMessage = (projectId: string, message: string, requestId: string, signal?: AbortSignal, redrawTaskId?: string) => request('send', { projectId, message, requestId, ...(redrawTaskId ? { redrawTaskId } : {}) }, signal)
export const cancelDesktopControlTurn = (projectId: string, signal?: AbortSignal) => request('cancel', { projectId }, signal)
export const approveDesktopControlRequest = (projectId: string, id: string, decision: 'approve' | 'deny', answers?: Record<string, string[]>, signal?: AbortSignal) => request('approval', { projectId, id, decision, ...(answers ? { answers } : {}) }, signal)
export const getExplanationState = (projectId: string, signal?: AbortSignal) => request(`explain/state?projectId=${encodeURIComponent(projectId)}`, undefined, signal)
export const ensureExplanationThread = (projectId: string, title: string, signal?: AbortSignal) => request('explain/ensure', { projectId, title }, signal)
export const handoffExplanationThread = (projectId: string, owner: DesktopControlOwner, signal?: AbortSignal) => request('explain/handoff', { projectId, owner }, signal)
export const sendExplanationMessage = (projectId: string, message: string, requestId: string, signal?: AbortSignal) => request('explain/send', { projectId, message, requestId }, signal)
export const cancelExplanationTurn = (projectId: string, signal?: AbortSignal) => request('explain/cancel', { projectId }, signal)
