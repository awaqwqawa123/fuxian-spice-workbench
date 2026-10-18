import type { AiConversationMessage } from './ai'
import type { AiProvider } from './ai-provider'
import type { Project } from './circuit'
import { parseSpiceLibrary, type ImportedSpiceModel } from './spice-models'
import type { ModelReferenceAdjustment } from './model-reference'
import type { ModelReviewFact, ModelReviewPinMapping } from './model-review'
import { AGENT_MODEL_LIMITS, type AgentModelAcquisition } from './agent-models'
import { parseModelAssessment, type ModelAssessment } from './modeling-assessment'
import { matchesPublicModel } from './model-public-identity'
import { parseModelSymbol } from './model-symbol'
import {parseModelDeviceInfo} from './model-device-info'
import type { DatasheetFigure } from './datasheet-curve-evidence'

export type AcquisitionEngine = 'codex' | 'cursor' | 'dsh-local' | 'dsh-api'
export interface ModelReferenceDocument {
  fileName: string
  pages: { number: number; text: string }[]
  url?: string
  figures?:DatasheetFigure[]
}
export interface ModelAcquisitionRequest {
  sessionId: string; projectId: string; project: Project; prompt: string; engine: AcquisitionEngine
  targetPart?: string
  referenceDocument?: ModelReferenceDocument
  history?: AiConversationMessage[]; model?: string; provider?: string; api?: AiProvider
  consent?: 'datasheet' | 'generic' | 'deny'
}
export interface AcquisitionCandidate {
  id: string; model: ImportedSpiceModel; origin: 'downloaded' | 'derived'
  reference?: { id: string; source: ImportedSpiceModel['source'] }
  referenceModel?: ImportedSpiceModel
  adjustments?: ModelReferenceAdjustment[]
  inheritedCount?: number
  facts?: ModelReviewFact[]
  pinMapping?: ModelReviewPinMapping[]
  evidence: string[]; limitations: string[]
  assessment?: ModelAssessment
}
export interface AcquisitionStep { type: 'tool'; name: string; status: 'running' | 'completed' | 'error'; detail: string }
export interface AcquisitionResult {
  type: 'done'; summary: string; candidates: AcquisitionCandidate[]
  /** Complete downloaded source survives unsupported root models and remains reviewable. */
  downloads?: AgentModelAcquisition[]
  /** Orderable variants read from the uploaded document; never inferred from its filename. */
  partChoices?: { part: string; referenceVoltage?: number; evidence: string }[]
  /** Carry the same downloaded evidence into the new, explicitly selected part task. */
  partChoiceDocument?: ModelReferenceDocument
  /** Result of this request; retained candidates may belong to an earlier turn. */
  outcome?: 'updated' | 'unchanged' | 'unavailable'
  assessment?: ModelAssessment
  librarySaves?:{candidateId:string;modelId:string;status:'saved'|'error';message:string}[]
  permission?: { kind: 'datasheet' | 'generic'; part: string; reason: string }
}
/** Restore source as data and reconstruct only the exact target's safe definitions. */
export function modelAcquisitionDownloads(raw: unknown): AgentModelAcquisition[] {
  if (!Array.isArray(raw) || raw.length > AGENT_MODEL_LIMITS.downloads) return []
  let total = 0
  return raw.flatMap(item => {
    if (!item || typeof item.id !== 'string' || item.id.length > 128 || typeof item.query !== 'string' || item.query.length > 48 || typeof item.name !== 'string' || item.name.length > 500 || typeof item.text !== 'string' || item.text.length > AGENT_MODEL_LIMITS.fileCharacters || !item.source || typeof item.source.label !== 'string' || item.source.label.length > 500 || ['url', 'license', 'attribution'].some(key => item.source[key] !== undefined && (typeof item.source[key] !== 'string' || item.source[key].length > 4000))) return []
    if (item.source.url) { try { const url = new URL(item.source.url); if (url.protocol !== 'https:' || url.username || url.password) return [] } catch { return [] } }
    total += item.text.length; if (total > AGENT_MODEL_LIMITS.totalCharacters) return []
    const parsed = parseSpiceLibrary(item.text, item.source)
    // Preserve validated original graphics on the same electrical declaration;
    // source text still determines every model ID and ordered port.
    for(const model of parsed.models){
      const saved=Array.isArray(item.models)?item.models.find((entry:unknown)=>entry&&typeof entry==='object'&&(entry as {id?:unknown}).id===model.id):undefined
      if(saved?.symbol!==undefined)try{model.symbol=parseModelSymbol(saved.symbol,model.kind,model.pins)}catch{/* invalid attachment cannot alter the electrical model */}
      if(saved?.deviceInfo!==undefined)try{
        const info=parseModelDeviceInfo(saved.deviceInfo)
        if(!info.portMapping||JSON.stringify(info.portMapping.ports)===JSON.stringify(model.pins))model.deviceInfo=info
      }catch{/* A malformed property attachment cannot supply terminal meaning. */}
    }
    return [{ id: item.id, query: item.query, name: item.name, source: item.source, text: item.text, origin: item.origin === 'local-library' ? 'local-library' as const : 'online' as const,
      models: parsed.models.filter(model => matchesPublicModel(model.id,item.query,model.source)), diagnostics: parsed.diagnostics, importedModelIds: [] }]
  })
}
export async function requestModelAcquisition(request: ModelAcquisitionRequest, onStep: (event: AcquisitionStep) => void, signal: AbortSignal): Promise<AcquisitionResult> {
  const response = await fetch('/api/model-assistant/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal })
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error ?? `模型助手请求失败（${response.status}）`) }
  if (!response.body) throw new Error('模型助手未返回任务流')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let pending = '', size = 0, result: AcquisitionResult | undefined
  const accept = (line: string) => {
    if (!line.trim()) return
    const event = JSON.parse(line)
    if (event.type === 'error') throw new Error(event.error)
    if (event.type === 'tool') onStep(event)
    if (event.type === 'done') {
      if (!Array.isArray(event.candidates) || event.candidates.length > 24 || typeof event.summary !== 'string') throw new Error('模型助手结果格式错误')
      for (const candidate of event.candidates as AcquisitionCandidate[]) {
        const parsed = parseSpiceLibrary(candidate.model.spice, candidate.model.source)
        const main = parsed.models.filter(model => model.id === candidate.model.id)
        if (main.length !== 1 || main[0].spice !== candidate.model.spice || JSON.stringify(main[0].pins) !== JSON.stringify(candidate.model.pins)) throw new Error('模型候选与兼容代码或端口不一致')
      }
      const assessmentOf = (raw: unknown) => { try { return raw === undefined ? undefined : parseModelAssessment(raw) } catch { return undefined } }
      const candidates = (event.candidates as AcquisitionCandidate[]).map(candidate => {
        const assessment = assessmentOf(candidate.assessment) ?? assessmentOf(candidate.model.assessment)
        return { ...candidate, assessment, model: { ...candidate.model, assessment } }
      })
      result = { ...event, assessment: assessmentOf(event.assessment), candidates, ...(event.downloads ? { downloads: modelAcquisitionDownloads(event.downloads) } : {}) }
    }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break
      size += value.length; if (size > 1_500_000) throw new Error('模型助手结果超过大小限制')
      pending += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) { accept(pending.slice(0, newline)); pending = pending.slice(newline + 1) }
    }
    accept(pending + decoder.decode())
    if (!result) throw new Error('模型助手任务未完整结束；请查看已执行步骤后重试')
    return result
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
