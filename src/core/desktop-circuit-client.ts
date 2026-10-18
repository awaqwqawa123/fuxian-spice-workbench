import { useEffect, useRef, useState } from 'react'
import type { Project } from './circuit'
import { DESKTOP_CIRCUIT_API, desktopCircuitFingerprint, type DesktopCircuitState, type DesktopCircuitSync, type DesktopCircuitTask } from './desktop-circuit'
import { readLocalService } from './local-service-request'
import { candidateWithWaveformSetup } from './candidate-waveform-setup'

// The service parses snapshots before saving. Compare the same complete schema on both sides.
export const desktopProjectFingerprint = desktopCircuitFingerprint

/** Invalid editing drafts cannot prove equality with any saved snapshot. */
export function desktopProjectsMatch(saved: Project, current: Project): boolean {
  try { return desktopCircuitFingerprint(saved) === desktopCircuitFingerprint(current) }
  catch { return false }
}
const aiProjectFingerprint = desktopProjectFingerprint

export class DesktopCircuitError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
async function request(path: string, signal?: AbortSignal, body?: DesktopCircuitSync | { projectId: string; taskId: string }): Promise<DesktopCircuitState> {
  const { response, value } = await readLocalService(`${DESKTOP_CIRCUIT_API}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'X-Fuxian-Desktop': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    cache: 'no-store', signal, ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new DesktopCircuitError(value?.error || `桌面电路连接失败（${response.status}）`, response.status)
  if (!value || !Array.isArray(value.tasks) || typeof value.cliPath !== 'string' || !('snapshot' in value)) throw new DesktopCircuitError('桌面电路服务返回格式不正确', 502)
  return value
}
export const getDesktopCircuitState = (projectId: string, signal?: AbortSignal) => request(`/state?projectId=${encodeURIComponent(projectId)}`, signal)
export const syncDesktopCircuit = (body: DesktopCircuitSync, signal?: AbortSignal) => request('/sync', signal, body)
export const cancelDesktopCircuitTask = (projectId: string, taskId: string, signal?: AbortSignal) => request('/cancel', signal, { projectId, taskId })

export interface DesktopCircuitConnection {
  state: DesktopCircuitState | null
  status: 'connecting' | 'syncing' | 'ready' | 'conflict' | 'error'
  error: string
  reconnect: () => void
  refresh: () => void
  retry: () => Promise<ConnectionView>
}
type ConnectionView = Omit<DesktopCircuitConnection, 'reconnect' | 'refresh' | 'retry'>

/** Owns only our publisher revision. Polling another tab must never grant write authority. */
export class DesktopCircuitPublisher {
  private revision: number | null = null
  private acknowledged = ''
  private unconfirmed = ''
  private project: Project
  private stopped = false
  private blocked = false
  private writing = false
  private writeGeneration = 0
  private polling = false
  private refreshPromise: Promise<boolean> | null = null
  private writePromise: Promise<void> | null = null
  private reconnectPending = false
  private controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private view: ConnectionView = { state: null, status: 'connecting', error: '' }
  private stateSignature = 'null'
  constructor(readonly projectId: string, project: Project, private emit: (view: ConnectionView) => void) { this.project = project }
  private update(patch: Partial<ConnectionView>) {
    if(this.stopped)return
    // Poll responses are new objects even when no project/task changed. Keep
    // the last published identity so an idle editor does no React work.
    const signature=patch.state===undefined?this.stateSignature:JSON.stringify(patch.state)
    const state=signature===this.stateSignature?this.view.state:patch.state!
    const status=patch.status??this.view.status,error=patch.error??this.view.error
    if(state===this.view.state&&status===this.view.status&&error===this.view.error)return
    this.stateSignature=signature
    this.view={state,status,error};this.emit(this.view)
  }
  private currentFingerprint(): { value: string; error?: never } | { value?: never; error: string } {
    try { return { value: aiProjectFingerprint(this.project) } }
    catch (reason) { return { error: `当前画布尚未通过校验（${(reason as Error).message}），未同步；已有的有效快照未被覆盖。` } }
  }
  start() { void this.refresh(); this.schedule(0) }
  change(project: Project) { this.project = project; this.schedule(220) }
  private schedule(delay: number) { clearTimeout(this.timer); if (!this.stopped && !this.blocked) this.timer = setTimeout(() => void this.flush(), delay) }
  private flush(): Promise<void> {
    if (this.writePromise) return this.writePromise
    const task = this.doFlush()
    this.writePromise = task.finally(() => { this.writePromise = null })
    return this.writePromise
  }
  private async doFlush() {
    if (this.stopped || this.writing || this.blocked) return
    const current = this.currentFingerprint()
    if (current.error) { this.update({ status: 'error', error: current.error }); return }
    if (this.acknowledged === current.value) return
    // Resolve a possibly saved snapshot before publishing any subsequent edit.
    if (this.unconfirmed) { void this.refresh(); return }
    let project: Project
    try { project = structuredClone(this.project) }
    catch (reason) { this.update({ status: 'error', error: `当前画布无法生成同步快照（${(reason as Error).message}）；已有的有效快照未被覆盖。` }); return }
    const fingerprint = current.value!
    this.writing = true; this.writeGeneration++; this.update({ status: 'syncing', error: '' })
    try {
      const state = await syncDesktopCircuit({ projectId: this.projectId, project, expectedRevision: this.revision }, this.controller.signal)
      if (this.stopped) return
      if (!state.snapshot || state.snapshot.projectId !== this.projectId) throw new Error('服务返回了其他项目的画布，已停止同步')
      this.revision = state.snapshot.revision; this.acknowledged = fingerprint; this.unconfirmed = ''
      this.update({ state, status: 'ready', error: '' })
    } catch (reason) {
      if (this.stopped) return
      this.blocked = reason instanceof DesktopCircuitError && reason.status === 409
      if (!(reason instanceof DesktopCircuitError) || reason.status >= 500) this.unconfirmed = fingerprint
      this.update({ status: this.blocked ? 'conflict' : 'error', error: (reason as Error).message })
    } finally {
      this.writing = false; this.writeGeneration++
      if (this.reconnectPending) { this.reconnectPending = false; void this.reconnect() }
      else {
        const latest = this.currentFingerprint()
        if (latest.error) this.update({ status: 'error', error: latest.error })
        else if (!this.blocked && this.view.status !== 'error' && this.acknowledged !== latest.value) this.schedule(0)
      }
    }
  }
  refresh(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    if (this.refreshPromise) return this.refreshPromise
    const task = this.readState()
    this.refreshPromise = task.finally(() => { this.refreshPromise = null })
    return this.refreshPromise
  }
  private async readState(): Promise<boolean> {
    this.polling = true; clearTimeout(this.pollTimer)
    const generation = this.writeGeneration
    try {
      const state = await getDesktopCircuitState(this.projectId, this.controller.signal)
      if (this.stopped) return false
      // A read overlapping any part of a write may describe the pre-write
      // snapshot. It cannot confirm or disprove delivery of that write.
      if (this.writing || generation !== this.writeGeneration) return false
      if (state.snapshot && state.snapshot.projectId !== this.projectId || state.tasks.some(task => task.projectId !== this.projectId)) throw new Error('服务返回了其他项目的数据，已忽略')
      // Ignore a GET that started before our later successful write.
      if (this.revision !== null && state.snapshot && state.snapshot.revision < this.revision) return false
      const current = this.currentFingerprint()
      if (!this.writing && this.unconfirmed) {
        const saved = state.snapshot && aiProjectFingerprint(state.snapshot.project)
        if (state.snapshot && saved === this.unconfirmed) {
          // The complete snapshot of our uncertain POST is persisted. This is
          // the same no-change acknowledgement returned by the idempotent API.
          this.revision = state.snapshot.revision; this.acknowledged = this.unconfirmed; this.unconfirmed = ''
          const changed = this.acknowledged !== current.value
          this.update({ state, status: current.error ? 'error' : changed ? 'syncing' : 'ready', error: current.error ?? '' })
          if (changed && !current.error) this.schedule(0)
          return true
        }
        if (state.snapshot?.revision !== (this.revision ?? undefined) || state.snapshot && saved !== this.acknowledged) {
          this.blocked = true
          this.update({ state, status: 'conflict', error: '另一页面已修改同步画布，请确认以当前画布重新连接。' })
          return true
        }
        // The service still has our last acknowledged version (or no initial
        // snapshot). A later CAS sync may publish the current local edits.
        this.unconfirmed = ''
      }
      if (current.error) { this.update({ state, status: 'error', error: current.error }); return true }
      // An unrelated GET never advances the CAS revision used by this publisher.
      const foreign = !this.writing && this.revision !== null && state.snapshot && state.snapshot.revision !== this.revision && aiProjectFingerprint(state.snapshot.project) !== current.value
      if (foreign) { this.blocked = true; this.update({ state, status: 'conflict', error: '另一页面已修改同步画布，请确认以当前画布重新连接。' }) }
      else this.update({ state, ...(this.view.status === 'error' && this.acknowledged === current.value ? { status: 'ready', error: '' } : {}) })
      if (this.view.status === 'error' && !this.blocked) this.schedule(0)
      return true
    } catch (reason) { if (!this.stopped && !this.writing && generation === this.writeGeneration) this.update({ error: (reason as Error).message, status: this.blocked ? 'conflict' : 'error' }); return false }
    finally { this.polling = false; if (!this.stopped) this.pollTimer = setTimeout(() => void this.refresh(), 1500) }
  }
  /** A user retry joins any automatic read, then finishes reconciliation and safe sync. */
  async retry(): Promise<ConnectionView> {
    if (this.stopped) return this.view
    if (this.writePromise) await this.writePromise
    let read = await this.refresh()
    if (!read && !this.stopped) { if (this.writePromise) await this.writePromise; read = await this.refresh() }
    if (!read || this.stopped || this.blocked) return this.view
    if (this.writePromise) await this.writePromise
    if (this.unconfirmed) {
      read = await this.refresh()
      if (!read || this.stopped || this.blocked) return this.view
    }
    const current = this.currentFingerprint()
    if (current.error) { this.update({ status: 'error', error: current.error }); return this.view }
    if (this.acknowledged !== current.value) await this.flush()
    return this.view
  }
  async reconnect() {
    if (this.stopped) return
    if (this.writing) { this.reconnectPending = true; return }
    const current = this.currentFingerprint()
    if (current.error) { this.update({ status: 'error', error: current.error }); return }
    this.writing = true; this.writeGeneration++; this.update({ status: 'connecting', error: '' })
    try {
      const state = await getDesktopCircuitState(this.projectId, this.controller.signal)
      if (this.stopped) return
      if (state.snapshot && state.snapshot.projectId !== this.projectId) throw new Error('项目不匹配，已停止连接')
      this.revision = state.snapshot?.revision ?? null; this.blocked = false; this.acknowledged = ''; this.unconfirmed = ''
      this.update({ state })
    } catch (reason) { if (!this.stopped) this.update({ status: 'error', error: (reason as Error).message }) }
    finally { this.writing = false; this.writeGeneration++; if (!this.stopped && !this.blocked && this.view.status !== 'error') this.schedule(0) }
  }
  stop() { this.stopped = true; this.controller.abort(); clearTimeout(this.timer); clearTimeout(this.pollTimer) }
}

/** Mounted by EditorWorkbench, so the latest canvas remains available with the assistant closed. */
export function useDesktopCircuit(projectId: string | undefined, project: Project): DesktopCircuitConnection {
  const [view, setView] = useState<ConnectionView>({ state: null, status: 'connecting', error: '' })
  const publisher = useRef<DesktopCircuitPublisher | null>(null)
  const current = useRef(project); current.current = project
  useEffect(() => {
    setView({ state: null, status: 'connecting', error: '' })
    if (!projectId) return
    const active = new DesktopCircuitPublisher(projectId, current.current, setView)
    publisher.current = active; active.start()
    return () => { active.stop(); if (publisher.current === active) publisher.current = null }
  }, [projectId])
  useEffect(() => { publisher.current?.change(project) }, [project, projectId])
  return { ...view, reconnect: () => { void publisher.current?.reconnect() }, refresh: () => { void publisher.current?.refresh() }, retry: () => publisher.current?.retry() ?? Promise.resolve(view) }
}

export function desktopCandidateState(task: DesktopCircuitTask, project: Project): 'ready' | 'applied' | 'conflict' | 'unavailable' {
  if (task.status !== 'completed' || !task.result?.changed) return 'unavailable'
  try {
    const current = aiProjectFingerprint(project)
    if (current === aiProjectFingerprint(candidateWithWaveformSetup(task.baseline, task.result.proposal.project))) return 'applied'
    return current === aiProjectFingerprint(task.baseline) ? 'ready' : 'conflict'
  } catch { return 'conflict' }
}
