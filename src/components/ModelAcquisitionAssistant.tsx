import { useEffect, useMemo, useRef, useState } from 'react'
import { BookPlus, Check, Download, FileText, History, Info, ListPlus, LoaderCircle, Paperclip, Plus, Send, Sparkles, Square } from 'lucide-react'
import type { Project } from '../core/circuit'
import type { ImportedModelKind, ImportedSpiceModel } from '../core/spice-models'
import { getCodexStatus } from '../core/codex-client'
import { getCursorStatus } from '../core/cursor-client'
import { refreshSharedDshStatus, useAssistantSettings } from '../core/assistant-settings'
import { requestModelAcquisition } from '../core/model-acquisition'
import { appendModelTaskStep, createModelTask, lastUniqueModelPart, mentionedModelParts, modelBatchTasks, modelPlanTasks, modelTaskBoundPart, modelTaskDocumentBoundPart, modelTaskConversationContext, modelTaskResultStatus, modelTaskStatusLabels, modelTaskStorageKey, readModelTaskWorkspace, uniqueModelPart, type ModelTask, type ModelTaskStatus, type ModelTaskReference } from '../core/model-tasks'
import { modelPromptWithReference, modelTaskQuickPrompt } from '../core/model-task-guidance'
import { readDatasheetFile } from '../core/datasheet-text'
import { datasheetEncodingNotices } from '../core/datasheet-encoding'
import { modelTaskReference } from '../core/model-task-reference'
import { bindModelTaskDocument, modelTaskDocumentIdentity, modelTaskHasBackendState, modelPartChoices, modelTaskForPartChoice } from '../core/model-task-target'
import AssistantMarkdown from './AssistantMarkdown'
import ModelReview from './ModelReview'
import AgentModelDownloads from './AgentModelDownloads'
import ModelingScopePanel, { legacyModelingAssessment } from './ModelingScopePanel'
import {refreshPersistentUserLibrary} from '../core/user-library-sync'

interface Props { projectId?: string; project: Project; visible?: boolean; selectedKind?: ImportedModelKind; onImport: (model: ImportedSpiceModel) => void; onSaveToUserLibrary?: (model: ImportedSpiceModel) => void | boolean | Promise<void | boolean>; onOpenSearch?: (part?: string, requestId?: string) => void; droppedFile?: { file: File; requestId: number }; suggestedPart?: { part: string; requestId: string; reference?: ModelTaskReference } }
const names: Record<string, string> = {view_datasheet_curve:'读取原始曲线图片与坐标',propose_curve_model:'按方案工作区拟合原图曲线',save_generated_models:'自动保存模型到自建库', search_spice_models: '查找准确型号', download_spice_model: '下载并检查源码', list_reference_models: '选择厂商相似模型', inspect_reference_document: '读取已添加的规格书', request_datasheet_permission: '自动批准规格书检索', search_datasheets: '检索厂商规格书', download_datasheet: '下载并解析规格书', request_generic_permission: '自动批准通用参考', list_generic_references: '读取已批准的通用参考', propose_derived_model: '生成可审阅的近似模型', propose_datasheet_model: '按规格书核对并调整模型参数', list_opamp_reference_templates: '选择库内相似运放模型', propose_opamp_reference_model: '按规格书生成运放近似模型', list_shunt_reference_templates: '查找厂商基准模型', propose_shunt_reference_model: '基于厂商模型生成候选', propose_shunt_reference_draft: '生成三端基准近似候选' }
const internalSteps = new Set(['request_datasheet_permission', 'request_generic_permission'])
/** Each part owns its session, permission, candidates and draft. Switching rows never starts a request. */
export default function ModelAcquisitionAssistant(props: Props) {
  return <AcquisitionSession key={props.projectId ?? 'unassigned'} {...props} projectId={props.projectId ?? 'unassigned'}/>
}
function AcquisitionSession({ projectId, project, visible = true, onImport, onSaveToUserLibrary, droppedFile, suggestedPart }: Props & { projectId: string }) {
  const [workspace, setWorkspace] = useState(() => readModelTaskWorkspace(localStorage, projectId))
  const latestWorkspace = useRef(workspace); latestWorkspace.current = workspace
  const { api, nativeModels, dshSelection, dshStatus, modelEngine } = useAssistantSettings()
  const [nativeStatus, setNativeStatus] = useState<Awaited<ReturnType<typeof getCodexStatus>> | null>(null), [checking, setChecking] = useState(false), [refresh, setRefresh] = useState(0)
  const [filter, setFilter] = useState(''), [statusFilter, setStatusFilter] = useState<ModelTaskStatus | 'all'>('all'), [batchOpen, setBatchOpen] = useState(false)
  const [fileReads, setFileReads] = useState<Record<string, { state: 'reading' | 'error'; fileName: string; detail: string }>>({})
  const fileInput = useRef<HTMLInputElement>(null), fileVersions = useRef(new Map<string, number>()), mounted = useRef(true), lastDrop = useRef<number | undefined>(undefined)
  const sourceFiles=useRef(new Map<string,File>())
  const sourceDocuments=useRef(new Map<string,ModelTaskReference['document']>())
  const [curvePage,setCurvePage]=useState(1)
  const [storageError, setStorageError] = useState(''), [connectionError, setConnectionError] = useState(''), [batchError, setBatchError] = useState('')
  const pending = useRef(new Map<string, AbortController>()), current = useRef(project)
  const resumedPermissions = useRef(new Set<string>())
  const choosingParts = useRef(new Set<string>())
  const lastSuggestion = useRef('')
  const plan = useRef<{ ids: string[]; cancelled: boolean; drafts: Record<string, string> } | null>(null)
  const [planProgress, setPlanProgress] = useState<{ total: number; completed: number; part: string } | null>(null)
  current.current = project
  const engine = modelEngine, task = workspace.tasks.find(item => item.id === workspace.selectedId) ?? workspace.tasks[0]
  const documentIdentity = useMemo(() => modelTaskDocumentIdentity(task), [task.reference?.document])
  const selectedCurvePage=task.reference?.document?.pages.some(page=>page.number===curvePage)?curvePage:task.reference?.document?.pages[0]?.number??1
  useEffect(()=>{setCurvePage(previous=>task.reference?.document?.pages.some(page=>page.number===previous)?previous:task.reference?.document?.pages[0]?.number??1)},[task.id,task.reference?.document])
  useEffect(() => {
    setWorkspace(previous => {
      let changed = false
      const tasks = previous.tasks.map(item => {
        if (!item.reference?.document || item.targetPart || modelTaskHasBackendState(item)) return item
        const resolved = bindModelTaskDocument(item)
        if (resolved.error) return item
        changed = true
        return resolved.task
      })
      return changed ? { ...previous, tasks } : previous
    })
  }, [])
  const statusEngine = useRef(engine)
  useEffect(() => { setWorkspace(previous => previous.engine === engine ? previous : { ...previous, engine }) }, [engine])
  useEffect(() => {
    if (!suggestedPart?.part || !suggestedPart.requestId || lastSuggestion.current === suggestedPart.requestId) return
    lastSuggestion.current = suggestedPart.requestId
    const part = suggestedPart.part.trim()
    setWorkspace(previous => {
      const existing = previous.tasks.find(item => {
        const historyParts = [...new Set(item.history.filter(message => message.role === 'user').map(message => uniqueModelPart(message.content)).filter((value): value is string => Boolean(value)))]
        if (historyParts.length > 1 && !item.planContext) return false
        const boundPart = item.targetPart ?? historyParts[0] ?? item.reference?.part ?? item.fallback?.part ?? (!item.history.length ? uniqueModelPart(item.draft) ?? uniqueModelPart(item.title) : undefined)
        return boundPart?.toUpperCase() === part.toUpperCase()
      })
      const reference = suggestedPart.reference ? { ...suggestedPart.reference, part: uniqueModelPart(part) } : undefined
      const referenceDraft = uniqueModelPart(part) ? modelTaskQuickPrompt(part, 'datasheet') : '请为 [填写器件型号] 根据这份规格书建立 SPICE 模型。'
      if (existing) return { ...previous, selectedId: existing.id, tasks: reference ? previous.tasks.map(item => item.id === existing.id ? { ...item, reference, draft: item.draft || referenceDraft } : item) : previous.tasks }
      const empty = previous.tasks.find(item => item.status === 'queued' && !item.history.length && !item.draft.trim())
      if (empty) return { ...previous, tasks: previous.tasks.map(item => item.id === empty.id ? { ...item, title: part, targetPart: uniqueModelPart(part), draft: reference ? referenceDraft : part, reference, updatedAt: Date.now() } : item), selectedId: empty.id }
      const created = { ...createModelTask(part), reference, ...(reference ? { draft: referenceDraft } : {}) }
      return { ...previous, tasks: [...previous.tasks, created], selectedId: created.id }
    })
  }, [suggestedPart?.part, suggestedPart?.requestId])
  const busy = task.status === 'running', prompt = task.draft, result = task.result, history = task.history, steps = task.steps
  const fileRead = fileReads[task.id], readingFile = fileRead?.state === 'reading'
  function rememberSource(id: string, file: File, document: ModelTaskReference['document']) {
    sourceFiles.current.delete(id); sourceFiles.current.set(id, file); sourceDocuments.current.set(id, document)
    while (sourceFiles.current.size > 8) { const oldest = sourceFiles.current.keys().next().value!; sourceFiles.current.delete(oldest); sourceDocuments.current.delete(oldest) }
  }
  function updateTask(id: string, update: (previous: ModelTask) => ModelTask) {
    if (!mounted.current) return
    setWorkspace(previous => ({ ...previous, tasks: previous.tasks.map(item => item.id === id ? update(item) : item) }))
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; if (plan.current) plan.current.cancelled = true; for (const controller of pending.current.values()) controller.abort() }
  }, [])
  useEffect(() => {
    if (!droppedFile || lastDrop.current === droppedFile.requestId) return
    lastDrop.current = droppedFile.requestId
    void attachDatasheet(droppedFile.file, task)
  }, [droppedFile?.requestId])
  async function attachDatasheet(file: File, target: ModelTask,curvePages?:number[]) {
    if(curvePages&&sourceDocuments.current.get(target.id)!==target.reference?.document){updateTask(target.id,previous=>({...previous,error:'原 PDF 与当前资料引用不一致，请重新添加当前规格书；已有资料不被替换。'}));return}
    if(curvePages)curvePages=curvePages.map(page=>target.reference?.document?.pages.some(item=>item.number===page)?page:selectedCurvePage)
    if (plan.current?.ids.includes(target.id)) {
      updateTask(target.id, previous => ({ ...previous, error: '方案正在执行，请停止全部任务后再添加或替换规格书；原资料已保留。' }))
      return
    }
    const requestedPart = uniqueModelPart(target.draft)
    const historyParts = [...new Set(target.history.filter(message => message.role === 'user').flatMap(message => mentionedModelParts(message.content)))]
    const referencePart = target.reference?.part ?? (target.reference ? uniqueModelPart(target.title) : undefined)
    const boundPart = modelTaskBoundPart(target) ?? (historyParts.length === 1 ? historyParts[0] : !historyParts.length ? referencePart?.toUpperCase() : undefined)
    if (requestedPart && ((target.targetPart && requestedPart !== target.targetPart) || (target.history.length && requestedPart !== boundPart) || (referencePart && requestedPart !== referencePart.toUpperCase()))) {
      // Attach to the new part before reading; otherwise send() would fork later
      // and leave this document on the prior part's task.
      target = createModelTask(target.draft)
      const created = target
      setWorkspace(previous => ({ ...previous, tasks: [...previous.tasks, created], selectedId: created.id }))
    }
    const taskId = target.id
    if (pending.current.has(taskId)) {
      updateTask(taskId, previous => ({ ...previous, error: '当前模型仍在生成。请停止或等待完成后，再替换规格书；原资料已保留。' }))
      return
    }
    const documentAtStart = target.reference?.document
    const version = (fileVersions.current.get(taskId) ?? 0) + 1
    fileVersions.current.set(taskId, version)
    const currentRead = () => mounted.current && fileVersions.current.get(taskId) === version
    const part = requestedPart ?? target.targetPart ?? target.reference?.part ?? lastUniqueModelPart(target.history)
    setFileReads(previous => ({ ...previous, [taskId]: { state: 'reading', fileName: file.name, detail: `正在读取 ${file.name}…` } }))
    try {
      const document = await readDatasheetFile(file, (page, total) => {
        if (currentRead()) setFileReads(previous => ({ ...previous, [taskId]: { state: 'reading', fileName: file.name, detail: `正在读取第 ${page} / ${total} 页…` } }))
      },{requirements:target.planContext||target.draft,curvePages})
      if (!currentRead()) return
      if (latestWorkspace.current.tasks.find(item => item.id === taskId)?.reference?.document !== documentAtStart) {
        setFileReads(previous => { const next = { ...previous }; delete next[taskId]; return next }); return
      }
      const reference = modelTaskReference(document, part)
      setWorkspace(previous => {
        const original = previous.tasks.find(item => item.id === taskId)
        if (!original || !currentRead() || original.reference?.document !== documentAtStart) return previous
        // Read against the latest draft. A user may change the request while PDF pages are loading.
        const attached = { ...original, reference: { ...reference, part: undefined } }
        const resolved = bindModelTaskDocument(attached)
        // A conflicting new document belongs to a separate draft. The old backend session
        // and its evidence must remain intact even before a new target is selected.
        const conflictTask = resolved.error && modelTaskHasBackendState(original)
          ? { ...createModelTask(original.draft, original.targetPart), ...(original.planContext ? { planContext: original.planContext } : {}), reference: attached.reference }
          : attached
        const next = resolved.error ? { ...conflictTask, error: resolved.error, notice: `${document.fileName} 已添加，完整页码与曲线已保留。${conflictTask.id !== taskId ? '旧任务的规格书与结果保留在历史任务中。' : ''}` } : { ...resolved.task, notice: `${document.fileName} 已添加，已从规格书识别 ${resolved.task.targetPart}。可直接生成模型，也可补充用途。` }
        rememberSource(next.id, file, next.reference?.document)
        return next.id === taskId ? { ...previous, tasks: previous.tasks.map(item => item.id === taskId ? next : item) } : { ...previous, tasks: [...previous.tasks, next], selectedId: next.id }
      })
      setFileReads(previous => { const next = { ...previous }; delete next[taskId]; return next })
    } catch (cause) {
      if (!currentRead()) return
      setFileReads(previous => ({ ...previous, [taskId]: { state: 'error', fileName: file.name, detail: `「${file.name}」读取失败：${cause instanceof Error ? cause.message : String(cause)}${target.reference ? ` 原规格书「${target.reference.label}」已保留。` : ''}` } }))
    }
  }
  useEffect(() => {
    try { localStorage.setItem(modelTaskStorageKey(projectId), JSON.stringify(workspace)); setStorageError('') }
    catch { setStorageError('浏览器存储空间不足，当前任务仍在页面中；请先导出或保存候选模型。') }
  }, [projectId, workspace])
  useEffect(() => {
    if (!visible) return
    const refreshConnection = () => setRefresh(value => value + 1)
    window.addEventListener('focus', refreshConnection)
    return () => window.removeEventListener('focus', refreshConnection)
  }, [visible])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController(); setConnectionError('')
    if (statusEngine.current !== engine) { statusEngine.current = engine; setNativeStatus(null) }
    if (engine === 'codex' || engine === 'cursor') {
      setChecking(true)
      void (engine === 'codex' ? getCodexStatus : getCursorStatus)(controller.signal).then(status => { if (!controller.signal.aborted) setNativeStatus(status) }).catch((cause: unknown) => { if (!controller.signal.aborted) { setNativeStatus(null); setConnectionError(cause instanceof Error ? cause.message : String(cause)) } }).finally(() => { if (!controller.signal.aborted) setChecking(false) })
    } else if (engine === 'dsh-local') {
      setChecking(true)
      void refreshSharedDshStatus(controller.signal).catch((cause: unknown) => { if (!controller.signal.aborted) setConnectionError(cause instanceof Error ? cause.message : String(cause)) }).finally(() => { if (!controller.signal.aborted) setChecking(false) })
    } else setChecking(false)
    return () => controller.abort()
  }, [engine, nativeModels.codex, nativeModels.cursor, visible, refresh])
  async function send(text = prompt, consent?: 'datasheet' | 'generic' | 'deny', source = task) {
    if (plan.current) return
    if (source.reference?.document) {
      const resolved = bindModelTaskDocument(source)
      if (resolved.error) { updateTask(source.id, previous => ({ ...previous, error: resolved.error! })); return }
      if (resolved.task.id !== source.id) {
        const file = sourceFiles.current.get(source.id)
        if (file) { rememberSource(resolved.task.id, file, resolved.task.reference?.document) }
        setWorkspace(previous => ({ ...previous, tasks: [...previous.tasks, resolved.task], selectedId: resolved.task.id }))
      } else updateTask(source.id, () => resolved.task)
      source = resolved.task
      if (!text.trim()) text = modelTaskQuickPrompt(source.targetPart!, 'datasheet')
    }
    if (!consent && !modelTaskDocumentBoundPart(source) && mentionedModelParts(text).length > 1 && !(source.targetPart && text.trim() === source.planContext)) {
      if (!ready || pending.current.size || fileReads[source.id]?.state === 'reading') {
        updateTask(source.id, previous => ({ ...previous, error: '请等待当前任务完成和助手连接就绪后再发送方案；输入已保留。' }))
        return
      }
      try { await runPlan(modelPlanTasks(text)) }
      catch (cause) { updateTask(source.id, previous => ({ ...previous, error: cause instanceof Error ? cause.message : String(cause) })) }
      return
    }
    await executeTask(text, consent, source)
  }
  function stopPlan() {
    const active = plan.current
    if (!active) return
    active.cancelled = true
    for (const id of active.ids) pending.current.get(id)?.abort(new Error('方案任务已停止；需求和已有结果保留。'))
    setWorkspace(previous => ({ ...previous, tasks: previous.tasks.map(item => active.ids.includes(item.id) && ['queued', 'running', 'permission'].includes(item.status) ? { ...item, draft: item.draft || active.drafts[item.id], status: 'stopped', error: '方案任务已停止；需求和已有结果保留。' } : item) }))
  }
  async function runPlan(tasks: ModelTask[]) {
    if (!tasks.length) return
    const active = { ids: tasks.map(item => item.id), cancelled: false, drafts: Object.fromEntries(tasks.map(item => [item.id, item.draft])) }
    plan.current = active
    addTasks(tasks)
    for (const target of tasks) resumedPermissions.current.add(target.id)
    try {
      for (let index = 0; index < tasks.length; index++) {
        if (!mounted.current || active.cancelled) break
        const target = tasks[index]
        setPlanProgress({ total: tasks.length, completed: index, part: target.targetPart! })
        setWorkspace(previous => ({ ...previous, selectedId: target.id }))
        let finished = await executeTask(target.draft, undefined, target)
        const continued = new Set<string>()
        // Each automatic fallback completes before the next device starts.
        while (finished?.result?.permission && !active.cancelled && mounted.current) {
          const permission = finished.result.permission
          if (continued.has(permission.kind) || permission.part.toUpperCase() !== target.targetPart) {
            updateTask(target.id, previous => ({ ...previous, status: 'error', draft: previous.draft || target.draft, error: '自动继续未完成，请核对当前器件的资料后重试；方案已保留。' }))
            break
          }
          continued.add(permission.kind)
          const text = permission.kind === 'datasheet' ? `继续为 ${target.targetPart} 检索下载规格书，核对库内相似模型并提出可审阅的近似模型。` : `继续为 ${target.targetPart} 使用明确标注的通用教学参考。`
          finished = await executeTask(text, permission.kind, finished)
        }
        if (!finished) updateTask(target.id, previous => ({ ...previous, draft: previous.draft || target.draft }))
      }
    } finally {
      plan.current = null
      if (mounted.current) setPlanProgress(null)
    }
  }
  async function executeTask(text: string, consent: 'datasheet' | 'generic' | 'deny' | undefined, source: ModelTask): Promise<ModelTask | undefined> {
    if (pending.current.has(source.id) || fileReads[source.id]?.state === 'reading' || !text.trim()) return
    if (!ready) {
      updateTask(source.id, previous => ({ ...previous, error: '助手尚未连接，问题已保留在输入框；连接恢复后请再次发送。' }))
      return
    }
    // A different explicit part must have a new task and backend session. The
    // backend remembers approved sources by session ID, so reusing it can mix parts.
    const requestedPart = consent ? undefined : uniqueModelPart(text)
    const historyParts = [...new Set(source.history.filter(message => message.role === 'user').flatMap(message => mentionedModelParts(message.content)))]
    const referencePart = source.reference?.part ?? (source.reference ? uniqueModelPart(source.title) : undefined)
    const historyBoundPart = modelTaskBoundPart(source) ?? (historyParts.length === 1 ? historyParts[0] : !historyParts.length ? referencePart?.toUpperCase() : undefined)
    if (!consent && !source.planContext && !modelTaskDocumentBoundPart(source) && historyParts.length > 1 && !requestedPart) {
      updateTask(source.id,previous=>({...previous,error:'此旧任务包含不明确或多个型号。请输入一个完整型号，新请求会自动建立独立任务。'}))
      return
    }
    const differentPart = Boolean(requestedPart && ((source.targetPart && requestedPart !== source.targetPart) || (source.history.length && requestedPart !== historyBoundPart) || (referencePart && requestedPart !== referencePart.toUpperCase())))
    const target = differentPart ? createModelTask(text.trim()) : source
    const targetPart = requestedPart ?? historyBoundPart
    if (target.reference?.document && !targetPart) {
      updateTask(source.id, previous => ({ ...previous, error: '请先从规格书识别结果选择目标型号，再生成模型。' }))
      return
    }
    if (differentPart) setWorkspace(previous => ({ ...previous, tasks: [...previous.tasks, target], selectedId: target.id }))
    const taskId = target.id
    const controller = new AbortController(); pending.current.set(taskId, controller)
    const submittedDraft = target.draft
    updateTask(taskId, previous => ({ ...previous, targetPart, status: 'running', error: '', notice: '', steps: [], updatedAt: Date.now(), ...(previous.reference && targetPart ? { reference: { ...previous.reference, part: targetPart } } : {}), title: ['新模型任务', '待定器件'].includes(previous.title) ? text.trim().split('\n')[0].slice(0, 72) : previous.title }))
    const timeout = setTimeout(() => controller.abort(new Error('模型任务等待超时，请查看已执行步骤后继续')), 190000)
    try {
      const next = await requestModelAcquisition({ projectId, sessionId: taskId, project: current.current, prompt: modelPromptWithReference(text.trim(), target.reference), targetPart, ...(target.reference?.document ? { referenceDocument: target.reference.document } : {}), engine, history: modelTaskConversationContext(target),
        ...((engine === 'codex' || engine === 'cursor') && nativeModels[engine] ? { model: nativeModels[engine] } : {}),
        ...(engine === 'dsh-api' ? { api } : engine === 'dsh-local' && dshSelection ? dshSelection : {}), ...(consent ? { consent } : {}) }, event => updateTask(taskId, previous => ({ ...previous, steps: appendModelTaskStep(previous.steps, event) })), controller.signal)
      if (controller.signal.aborted || !mounted.current) return
      if(next.librarySaves?.some(item=>item.status==='saved'))void refreshPersistentUserLibrary().catch(()=>{})
      updateTask(taskId, previous => {
        const history = [...previous.history, { role: 'user' as const, content: text.trim() }, { role: 'assistant' as const, content: next.summary }]
        const answer = !next.candidates.length && previous.result?.candidates.length
          ? { ...next, candidates: previous.result.candidates, outcome: 'unchanged' as const }
          : next
        return { ...previous, history, result: { ...answer, ...(answer.downloads ? {} : previous.result?.downloads ? { downloads: previous.result.downloads } : {}) },notice:next.librarySaves?.map(item=>item.message).join('；')??'', status: modelTaskResultStatus(answer), fallback: undefined, draft: !consent && previous.draft === submittedDraft ? '' : previous.draft, updatedAt: Date.now() }
      })
      return { ...target, targetPart, history: [...target.history, { role: 'user', content: text.trim() }, { role: 'assistant', content: next.summary }], result: next, status: modelTaskResultStatus(next) }
    } catch (cause: unknown) {
      updateTask(taskId, previous => ({ ...previous, status: controller.signal.aborted ? 'stopped' : 'error', error: controller.signal.aborted ? (controller.signal.reason?.message === 'This operation was aborted' ? '任务已停止；已完成步骤保留。' : controller.signal.reason?.message ?? '任务已停止') : cause instanceof Error ? cause.message : String(cause) }))
    } finally { clearTimeout(timeout); pending.current.delete(taskId) }
  }
  async function choosePart(part: string) {
    if (!ready || busy || readingFile || choosingParts.current.has(task.id)) return
    const sourceId = task.id
    choosingParts.current.add(sourceId)
    try {
      const target = modelTaskForPartChoice(task, part)
      addTasks([target])
      await send(target.draft, undefined, target)
    } catch (cause) {
      updateTask(sourceId, previous => ({ ...previous, error: cause instanceof Error ? cause.message : String(cause) }))
    } finally { choosingParts.current.delete(sourceId) }
  }
  async function acceptModel(model: ImportedSpiceModel, library: boolean) {
    const taskId = task.id
    updateTask(taskId, previous => ({ ...previous, error: '', notice: '' }))
    try {
      if (library) { if ((await onSaveToUserLibrary?.(model)) === false) return }
      else await onImport(model)
      updateTask(taskId, previous => ({ ...previous, notice: `${model.id} 已${library ? '保存到自建库' : '导入工程'}。` }))
    } catch (cause) { updateTask(taskId, previous => ({ ...previous, error: (cause as Error).message || '模型未保存，请检查模型名称与库容量。' })) }
  }
  function addTasks(tasks: ModelTask[]) {
    if (!tasks.length) return
    setWorkspace(previous => ({ ...previous, tasks: [...previous.tasks, ...tasks], selectedId: tasks[0].id }))
    setFilter(''); setStatusFilter('all')
  }
  const ready = engine === 'codex' || engine === 'cursor' ? nativeStatus?.available : engine === 'dsh-local' ? Boolean(dshStatus?.available && dshSelection) : Boolean(api.endpoint.trim() && api.model.trim())
  useEffect(() => {
    const permission = task.result?.permission
    if (!visible || !ready || plan.current || readingFile || task.status !== 'permission' || !permission || resumedPermissions.current.has(task.id)) return
    resumedPermissions.current.add(task.id)
    const text = permission.kind === 'datasheet'
      ? `继续为 ${permission.part} 检索下载规格书，核对参考模型并提出可审阅的近似模型。`
      : `继续为 ${permission.part} 使用明确标注的通用教学参考。`
    void send(text, permission.kind)
  }, [visible, ready, readingFile, task.id, task.status, task.result?.permission?.kind, task.result?.permission?.part])
  const displayed = workspace.tasks.filter(item => (statusFilter === 'all' || statusFilter === item.status) && `${item.title} ${item.result?.candidates.map(candidate => candidate.model.id).join(' ') ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
  const mainSteps = steps.map((step, index) => ({ step, index })).filter(({ step }) => !internalSteps.has(step.name))
  const activeStep = [...mainSteps].reverse().find(({ step }) => step.status === 'running')?.step
  const currentBlockedResult = Boolean(result?.assessment?.status === 'blocked' && !busy && task.status !== 'stopped')
  const previousResult = Boolean(result && (busy || task.status === 'error' && !currentBlockedResult || task.status === 'stopped'))
  const previousResultState = busy ? '本次正在生成' : task.status === 'stopped' ? '本次已停止' : '本次未生成新结果'
  const encodingNotices = task.reference?.document ? datasheetEncodingNotices(task.reference.document.pages) : []
  const unchangedResult = result?.outcome === 'unchanged'
  const partChoices = modelPartChoices(result)
  const emptyResult = !partChoices.length && (task.status === 'completed' || result?.assessment?.status === 'blocked') && Boolean(result && !result.candidates.length && !result.permission)
  const latestPart = task.targetPart ?? lastUniqueModelPart(history)
  const historyParts = [...new Set(history.filter(message => message.role === 'user').map(message => uniqueModelPart(message.content)).filter((part): part is string => Boolean(part)))]
  const mixedHistory = !task.planContext && !modelTaskDocumentBoundPart(task) && historyParts.length > 1
  const retryPrompt = latestPart ? `请继续为 ${latestPart} 查找原厂 SPICE 模型；没有原模型时，自动查规格书与厂商参考模型，提出有依据的模型候选，并明确未能生成的原因。` : [...history].reverse().find(message => message.role === 'user')?.content
  const visibleSteps = mainSteps.filter(({ step }, index) => index >= mainSteps.length - 5 || (busy && step.status === 'running'))
  return <section className="model-agent model-task-workspace model-generation-workspace" aria-label="模型搜索与建模助手">
    {planProgress && <div className="model-generation-progress" role="status" aria-label="方案器件执行进度"><LoaderCircle size={18} className="step-loading-icon"/><div><strong>正在处理 {planProgress.part} · 第 {planProgress.completed + 1} / {planProgress.total} 个器件</strong><p>逐个搜索官网模型；没有模型时自动查规格书并核对库内相似器件。每个器件的结果独立保存。</p></div><button type="button" onClick={stopPlan}><Square size={14}/>停止全部</button></div>}
    <div className="model-generation-utilities">
      <details className="model-generation-history">
        <summary><History size={15}/>历史任务 <span>{workspace.tasks.length}</span></summary>
        <section className="model-task-index" aria-label="器件模型任务">
      <div className="model-task-index-heading"><strong>已保存的任务</strong><button type="button" onClick={() => addTasks([createModelTask()])}><Plus size={13}/>新模型任务</button><button type="button" aria-expanded={batchOpen} onClick={() => setBatchOpen(value => !value)}><ListPlus size={14}/>批量添加</button></div>
      {batchOpen && <form className="model-task-batch" onSubmit={event => { event.preventDefault(); try { const tasks = modelBatchTasks(workspace.batchDraft); addTasks(tasks); if (tasks.length) { setWorkspace(previous => ({ ...previous, batchDraft: '' })); setBatchOpen(false) }; setBatchError('') } catch (cause) { setBatchError((cause as Error).message) } }}><label>器件清单<textarea aria-label="批量器件清单" rows={3} placeholder={'每行一个型号或需求，例如：\n2N7002 Nexperia\nLM358 TI'} value={workspace.batchDraft} onChange={event => setWorkspace(previous => ({ ...previous, batchDraft: event.target.value }))}/></label><small>每行建立独立任务，最多 50 项；添加后逐项执行，不自动联网。</small><button type="submit" disabled={!workspace.batchDraft.trim()}>添加到任务列表</button>{batchError && <p role="alert">{batchError}</p>}</form>}
      <div className="model-task-filters"><input aria-label="筛选器件模型任务" placeholder="搜索任务 / 型号" value={filter} onChange={event => setFilter(event.target.value)}/><select aria-label="模型任务状态筛选" value={statusFilter} onChange={event => setStatusFilter(event.target.value as ModelTaskStatus | 'all')}><option value="all">全部状态</option>{Object.entries(modelTaskStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="model-task-list" aria-label="器件任务列表">{displayed.map(item => <button type="button" key={item.id} className="model-task-row" aria-label={`选择模型任务 ${item.title}`} aria-pressed={item.id === task.id} onClick={() => setWorkspace(previous => ({ ...previous, selectedId: item.id }))}><span className="model-task-row-title">{item.title}</span><span className="model-task-status" data-status={item.status}>{modelTaskStatusLabels[item.status]}</span><small>{item.result?.candidates.length ? `${item.result.candidates.length} 个候选` : item.result?.permission ? '正在自动继续模型任务' : item.status === 'running' ? '正在执行工具' : item.history.length ? `${item.history.length / 2} 轮记录` : '尚未联网执行'}</small></button>)}{!displayed.length && <p className="model-task-empty">没有匹配任务；当前任务的内容仍保留在下方。</p>}</div>

        </section>
      </details>
      <button type="button" className="model-generation-new" onClick={() => addTasks([createModelTask()])}><Plus size={15}/>新建</button>
    </div>
    <section className="model-task-detail" aria-label="当前器件模型任务" key={task.id}>
      <form className="model-agent-composer model-generation-composer" onSubmit={event => { event.preventDefault(); void send() }}>
        <label htmlFor={`model-agent-prompt-${task.id}`}>{history.length ? '继续完善模型或追问结果' : '描述你要生成的模型'}</label>
        <textarea id={`model-agent-prompt-${task.id}`} aria-label="模型搜索与建模需求" value={prompt} maxLength={8000} rows={5} placeholder="输入一句话或完整方案，例如：用 OPA2376 和 2N7002 做 3.3 V 采集电路，帮我找 SPICE 模型；没有官网模型就按规格书调整库内相似器件。" onChange={event => updateTask(task.id, previous => ({ ...previous, draft: event.target.value }))} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }}/>
        {!history.length && <small>可以一次描述多个型号，助手会自动拆成独立任务逐个处理；近似模型会列出修改依据和适用限制，供你审阅。</small>}
        <small className="model-generation-scope-help">建模需要已核对的器件类型、参考模型和端口对应关系。指标缺少测试条件或尚无可校准模板时，会列出具体缺项；提取数据和检查语法通过都不代表完整建模。</small>
        <div className="model-generation-composer-actions"><div className="model-generation-attachment"><input ref={fileInput} type="file" accept=".pdf,.txt,application/pdf,text/plain" aria-label="添加规格书文件" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void attachDatasheet(file, task) }}/><button type="button" disabled={busy || readingFile || !!planProgress} onClick={() => fileInput.current?.click()}><Paperclip size={16}/>添加规格书</button><span>可选 · 支持拖入 PDF / TXT</span></div>{busy ? <button type="button" className="model-generation-stop" onClick={() => plan.current ? stopPlan() : pending.current.get(task.id)?.abort()}><Square size={14}/>{planProgress ? '停止全部' : '停止生成'}</button> : <button type="submit" className="model-search-primary" disabled={!ready || readingFile || !!planProgress || (!prompt.trim() && !task.reference?.document)}><Send size={15}/>生成模型</button>}</div>
        {task.reference && <details className="model-task-reference"><summary><FileText size={15}/><span>{task.reference.label}</span><small>{task.reference.document ? `已添加 · ${task.reference.document.pages.length} 页${task.reference.document.figures?.length?` · ${task.reference.document.figures.length} 张曲线`:''}` : '仅保留摘录'}</small></summary>{!task.reference.document && <p>这条旧记录仅保存了摘要。请重新添加规格书，以使用完整页码和参数依据。</p>}<pre>{task.reference.text}</pre>{task.reference.document?.figures?.map(figure=><details key={figure.page}><summary>原始曲线第 {figure.page} 页 · {figure.width} × {figure.height}</summary><img loading="lazy" alt={`第 ${figure.page} 页原始规格书曲线`} src={`data:${figure.mimeType};base64,${figure.dataBase64}`} style={{maxWidth:'100%',height:'auto'}}/></details>)}{task.reference.document&&/\.pdf$/i.test(task.reference.label)&&<div><label>读取指定曲线页<select aria-label="指定曲线页" value={curvePage} onChange={event=>setCurvePage(Number(event.target.value))}>{task.reference.document.pages.map(page=><option key={page.number} value={page.number}>第 {page.number} 页</option>)}</select></label><button type="button" disabled={busy||readingFile} onClick={()=>{const file=sourceFiles.current.get(task.id);if(file)void attachDatasheet(file,task,[curvePage]);else updateTask(task.id,previous=>({...previous,error:'请重新添加原 PDF 后再读取指定图页；已保存文字与曲线不丢失。'}))}}>读取这一页曲线</button></div>}<button type="button" disabled={busy || readingFile} onClick={() => { fileVersions.current.set(task.id, (fileVersions.current.get(task.id) ?? 0) + 1); sourceFiles.current.delete(task.id); sourceDocuments.current.delete(task.id); updateTask(task.id, previous => ({ ...previous, reference: undefined })) }}>移除本任务引用</button></details>}
        {documentIdentity && <section className="model-agent-part-choices" aria-label="规格书识别型号"><h3>{task.reference?.part ? `规格书目标：${task.reference.part}` : '从规格书选择目标型号'}</h3>{documentIdentity.candidates.length ? <div className="model-agent-part-choice-grid">{documentIdentity.candidates.map(choice => <article key={choice.part}><strong>{choice.part}</strong><small>第 {choice.page} 页</small><p>{choice.evidence}</p><button type="button" disabled={busy || readingFile || !!planProgress} aria-pressed={task.reference?.part?.toUpperCase() === choice.part.toUpperCase()} aria-label={`选择规格书型号 ${choice.part}`} onClick={() => {
          const resolved = bindModelTaskDocument(task, choice.part)
          if (resolved.error) { updateTask(task.id, previous => ({ ...previous, error: resolved.error! })); return }
          if (resolved.task.id === task.id) updateTask(task.id, () => resolved.task)
          else { const file = sourceFiles.current.get(task.id); if (file) { rememberSource(resolved.task.id, file, resolved.task.reference?.document) }; addTasks([resolved.task]) }
        }}>{task.reference?.part?.toUpperCase() === choice.part.toUpperCase() ? '已选择' : '选择此型号'}</button></article>)}</div> : <p>{documentIdentity.reason ?? '未找到可确认的完整型号，请核对标题页。'}</p>}</section>}
        {!!encodingNotices.length && <div className="model-agent-encoding-notices" role="note" aria-label="规格书文字提取提示"><Info size={16}/><div><strong>规格书文字提取提示</strong>{encodingNotices.map(notice => <p key={notice}>{notice}</p>)}</div></div>}
      </form>
      {fileRead && <p className={`model-agent-file-status${fileRead.state === 'error' ? ' is-error' : ''}`} role={fileRead.state === 'error' ? 'alert' : 'status'}>{readingFile && <LoaderCircle size={15} className="step-loading-icon"/>}{fileRead.detail}</p>}
      {!ready && <p className="model-generation-connect-note" role="status">{checking ? <><LoaderCircle size={14} className="step-loading-icon"/>正在检查助手连接…</> : <span>助手尚未连接，草稿已保留；请到软件设置检查连接，恢复后即可发送。{connectionError || nativeStatus?.message ? ` ${connectionError || nativeStatus?.message}` : ''}</span>}</p>}
      {mixedHistory && <p className="model-search-error" role="status">此旧任务包含多个型号；最近一次请求是 {latestPart}。新型号会建立独立任务。</p>}
      {!!partChoices.length && <section className="model-agent-part-choices" aria-label="选择规格书具体型号"><div><h3>选择具体型号后继续建模</h3><p>这份规格书包含多个订货型号。请按器件上的型号选择，助手会保留完整规格书并继续建模。</p></div><div className="model-agent-part-choice-grid">{partChoices.map(choice => <article key={choice.part}><strong>{choice.part}</strong>{typeof choice.referenceVoltage === 'number' && <span><b>{choice.referenceVoltage.toLocaleString('en-US', { maximumFractionDigits: 6 })}</b> V <small>基准电压</small></span>}<p>{choice.evidence}</p><button type="button" disabled={!ready || busy || readingFile} aria-label={`使用型号 ${choice.part}`} onClick={() => void choosePart(choice.part)}>使用此型号<Send size={14}/></button></article>)}</div></section>}
      {task.error && <p className="model-search-error" role="alert">{task.error}</p>}{task.notice && <p className="model-search-notice" role="status">{task.notice}</p>}
      {(busy || task.status === 'permission') && <div className="model-generation-progress" role="status"><LoaderCircle className="step-loading-icon" size={18}/><div><strong>{busy ? activeStep ? names[activeStep.name] ?? activeStep.name : '正在生成模型…' : '等待连接后继续生成'}</strong><p>{busy ? activeStep?.detail || '助手正在处理需求，结果会显示在下方。' : '已允许继续检索资料，连接就绪后自动执行。'}</p></div></div>}
      {(steps.length > 0 || busy) && <details className="model-task-step-details"><summary>查看处理过程 · {steps.filter(step => step.status === 'completed').length}/{steps.length} 完成</summary><ol className="model-agent-steps" aria-label="模型助手执行步骤">{steps.map((step, index) => <li key={index} data-status={step.status}><span>{step.status === 'completed' ? <Check size={13}/> : step.status === 'running' && busy ? <LoaderCircle className="step-loading-icon" size={13}/> : index + 1}</span><div><strong>{names[step.name] ?? step.name}</strong><small>{step.status === 'running' && !busy ? '本轮已停止' : step.detail}</small></div></li>)}</ol></details>}
      {visibleSteps.length > 0 && <ol className="model-agent-step-trail" aria-label="已执行的建模步骤">{visibleSteps.map(({ step, index }) => <li key={`${step.name}-${index}`} data-status={step.status === 'running' && !busy ? 'stopped' : step.status}><span>{step.status === 'completed' ? <Check size={14}/> : step.status === 'running' && busy ? <LoaderCircle size={14} className="step-loading-icon"/> : index+1}</span><strong>{names[step.name] ?? step.name}</strong><small>{step.status === 'completed' ? '已完成' : step.status === 'error' ? '未完成' : busy ? '进行中' : '已停止'}</small></li>)}</ol>}
      {result && <section className={`model-agent-reply${previousResult ? ' is-previous' : ''}`} aria-label="模型助手回答"><header><span className="model-agent-reply-icon">{previousResult ? <History size={17}/> : <Sparkles size={17}/>}</span><strong>{previousResult ? '上次结果' : '模型助手'}</strong><span className="model-agent-reply-state">{previousResult ? previousResultState : partChoices.length ? '请选择具体型号' : result.permission ? '继续处理中' : unchangedResult ? '本轮未生成新版本 · 保留已有模型' : currentBlockedResult ? '本次建模需处理' : result.candidates.length ? '模型已生成 · 待审阅' : '尚未生成模型'}</span></header>{previousResult && <p className="model-agent-previous-note">以下内容来自上次完成的请求。{busy ? '本次结果返回后会更新这里。' : '本次需求已保留，可以修改后重试。'}</p>}<AssistantMarkdown>{result.summary || (result.candidates.length ? '模型候选已列在下方，请核对引脚和参数后使用。' : '本次没有得到可导入的模型。可以补充用途，或让助手继续查找。')}</AssistantMarkdown>{emptyResult && <div className="model-agent-no-model"><p>当前只有查找说明，尚无可导入模型。</p><button type="button" disabled={!ready || busy || readingFile || !retryPrompt} onClick={() => void send(retryPrompt)}><Send size={14}/>继续由助手查找</button></div>}</section>}
      {result && !result.permission && !partChoices.length && (!result.candidates.length || result.assessment?.status === 'blocked') && <div className="model-generation-blocked-assessment">{previousResult && <p className="model-review-caption">以下覆盖说明来自上次保留结果 · {previousResultState}</p>}<ModelingScopePanel assessment={result.assessment ?? legacyModelingAssessment()}/></div>}
      {!!result?.candidates.length && <section className="model-agent-candidates" aria-label="模型候选审阅"><div className="model-generation-result-heading"><h3>{currentBlockedResult ? '保留的旧候选' : previousResult ? '上次生成的模型' : unchangedResult ? '保留的模型' : '模型结果'}</h3><span>{currentBlockedResult ? '本次未生成新版本，以下是先前候选' : previousResult ? `${result.candidates.length} 个已保留模型 · ${previousResultState}` : unchangedResult ? '本次修改尚未形成新版本' : `${result.candidates.length} 个模型 · 请核对后使用`}</span></div>{result.candidates.map(candidate => <ModelReview display="assistant" key={candidate.id} model={candidate.model} origin={candidate.origin} assessment={candidate.assessment} reference={candidate.reference} referenceModel={candidate.referenceModel} adjustments={candidate.adjustments} inheritedCount={candidate.inheritedCount} facts={candidate.facts} pinMapping={candidate.pinMapping} evidence={[...candidate.evidence, ...(candidate.reference ? [`参考模型：${candidate.reference.id} · ${candidate.reference.source.label}`] : [])]} limitations={candidate.limitations}><div className="model-agent-candidate-actions"><button type="button" disabled={busy || project.models?.some(model => model.id.toLowerCase() === candidate.model.id.toLowerCase())} onClick={() => void acceptModel(candidate.model, false)}><Download size={14}/>审阅后导入工程</button>{onSaveToUserLibrary && <button type="button" disabled={busy} onClick={() => void acceptModel(candidate.model, true)}><BookPlus size={14}/>保存到自建库</button>}</div></ModelReview>)}</section>}
      {!!result?.downloads?.length && <AgentModelDownloads items={result.downloads} models={project.models ?? []} onImport={model => { void acceptModel(model, false) }}/>}
      {!!history.length && <details className="model-agent-inline-history"><summary><History size={14}/>对话记录 · {history.length / 2} 轮</summary><div className="model-agent-conversation" aria-label="独立模型任务记录">{history.map((message, index) => <article className={`model-agent-message ${message.role}`} key={index}><small>{message.role === 'user' ? '你的需求' : '模型助手'}</small><AssistantMarkdown>{message.content}</AssistantMarkdown></article>)}</div></details>}
    </section>
    {storageError && <p className="model-search-error" role="alert">{storageError}</p>}
  </section>
}
