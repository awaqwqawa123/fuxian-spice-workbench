import { useSyncExternalStore } from 'react'
import { aiProviderPresets, inferProviderId, providerUrls, type AiProvider, type AiProviderId } from './ai-provider'
import { getDshLocalStatus, type DshLocalSelection, type DshLocalStatus } from './dsh-local-client'
import type { AcquisitionEngine } from './model-acquisition'

export type AssistantApiSettings = AiProvider & { preset: AiProviderId }
export interface AssistantSettings {
  api: AssistantApiSettings
  nativeModels: { codex: string; cursor: string }
  modelEngine: AcquisitionEngine
  dshSelection: DshLocalSelection | null
  dshStatus: DshLocalStatus | null
}
export const ASSISTANT_SETTINGS_KEY = 'fuxian-assistant-settings-v1'
export const LEGACY_API_SETTINGS_KEY = 'fuxian.ai-provider.v1'
const defaults = (): AssistantSettings => ({ api: { endpoint: 'https://api.openai.com/v1', model: '', apiKey: '', protocol: 'chat-completions', preset: 'openai' }, nativeModels: { codex: '', cursor: '' }, modelEngine: 'codex', dshSelection: null, dshStatus: null })

/** Only allowlisted preferences are read. Secrets in older storage never migrate. */
export function readAssistantSettings(storage?: Pick<Storage, 'getItem'> | null): AssistantSettings {
  const next = defaults()
  if (!storage) return next
  try {
    const raw = JSON.parse(storage.getItem(ASSISTANT_SETTINGS_KEY) ?? 'null')
    const api = raw?.api ?? JSON.parse(storage.getItem(LEGACY_API_SETTINGS_KEY) ?? 'null')
    if (api && typeof api.endpoint === 'string' && typeof api.model === 'string') {
      providerUrls(api.endpoint)
      next.api = { endpoint: api.endpoint.slice(0, 2048), model: api.model.slice(0, 200), apiKey: '', protocol: api.protocol === 'responses' ? 'responses' : 'chat-completions', preset: aiProviderPresets.some(item => item.id === api.preset) ? api.preset : inferProviderId(api.endpoint) }
    }
    for (const engine of ['codex', 'cursor'] as const) if (typeof raw?.nativeModels?.[engine] === 'string') next.nativeModels[engine] = raw.nativeModels[engine].slice(0, 200)
    if (['codex', 'cursor', 'dsh-local', 'dsh-api'].includes(raw?.modelEngine)) next.modelEngine = raw.modelEngine
    if (typeof raw?.dshSelection?.provider === 'string' && typeof raw?.dshSelection?.model === 'string') next.dshSelection = { provider: raw.dshSelection.provider.slice(0, 100), model: raw.dshSelection.model.slice(0, 200) }
  } catch { /* Unreadable preferences leave safe defaults. */ }
  return next
}

export function persistAssistantSettings(value: AssistantSettings, storage?: Pick<Storage, 'setItem'> | null) {
  if (!storage) return
  try {
    providerUrls(value.api.endpoint)
    const { endpoint, model, protocol, preset } = value.api
    const api = { endpoint, model, protocol, preset }
    storage.setItem(ASSISTANT_SETTINGS_KEY, JSON.stringify({ api, nativeModels: value.nativeModels, modelEngine: value.modelEngine, dshSelection: value.dshSelection }))
    // Keep the old allowlisted shape for clients still open on an earlier version.
    storage.setItem(LEGACY_API_SETTINGS_KEY, JSON.stringify(api))
  } catch { /* Invalid addresses and unavailable storage remain memory-only. */ }
}

let current: AssistantSettings | undefined
let currentStorage: Storage | null | undefined
const listeners = new Set<() => void>()
function browserStorage(): Storage | null { try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null } }
export function getAssistantSettings(): AssistantSettings {
  const storage = browserStorage()
  if (!current || currentStorage !== storage) { currentStorage = storage; current = readAssistantSettings(storage) }
  return current
}
export function updateAssistantSettings(patch: Partial<AssistantSettings>) {
  current = { ...getAssistantSettings(), ...patch }
  persistAssistantSettings(current, browserStorage())
  listeners.forEach(listener => listener())
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useAssistantSettings() { return useSyncExternalStore(subscribe, getAssistantSettings, getAssistantSettings) }

/** Detection is read-only: no message or login operation is performed. */
export async function refreshSharedDshStatus(signal?: AbortSignal): Promise<DshLocalStatus> {
  try {
    const status = await getDshLocalStatus(signal)
    if (signal?.aborted) return status
    const previous = getAssistantSettings().dshSelection
    const provider = status.providers.find(item => item.configured && item.id === previous?.provider) ?? status.providers.find(item => item.configured)
    const model = provider?.models.includes(previous?.model ?? '') ? previous!.model : provider?.models[0]
    updateAssistantSettings({ dshStatus: status, dshSelection: provider && model ? { provider: provider.id, model } : null })
    return status
  } catch (cause) { if (!signal?.aborted) updateAssistantSettings({ dshStatus: null }); throw cause }
}
