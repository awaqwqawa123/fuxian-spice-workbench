import { readAgentResponse, type AgentProgressEvent, type AgentResult } from './agent-client'
import type { CodexStatus } from './codex'
import { parseCursorRequest, type CursorRequest } from './cursor'
export type { CursorRequest } from './cursor'
export type { CodexStatus as CursorStatus } from './codex'

async function readStatusBody(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('本机 Cursor 未返回状态')
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0, body = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 16000) throw new Error('Cursor 状态响应超过上限')
      body += decoder.decode(value, { stream: true })
    }
    return JSON.parse(body + decoder.decode())
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function getCursorStatus(signal?: AbortSignal): Promise<CodexStatus> {
  const response = await fetch('/api/cursor/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal })
  const raw: unknown = await readStatusBody(response)
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  if (!response.ok) throw new Error(typeof data.error === 'string' && data.error.length <= 8000 ? data.error : `本机 Cursor 状态请求失败（${response.status}）`)
  if (typeof data.installed !== 'boolean' || typeof data.available !== 'boolean' || !(data.authenticated === null || typeof data.authenticated === 'boolean')
    || typeof data.version !== 'string' || data.version.length > 200 || !(data.model === null || typeof data.model === 'string' && data.model.length <= 200)
    || typeof data.message !== 'string' || data.message.length > 8000) throw new Error('本机 Cursor 状态格式不正确')
  return { installed: data.installed, available: data.available, authenticated: data.authenticated, version: data.version, model: data.model, message: data.message }
}

export async function requestCursorAgent(request: CursorRequest, onProgress: (event: AgentProgressEvent) => void, signal?: AbortSignal, onText?: (text: string) => void): Promise<AgentResult> {
  let payload: CursorRequest
  try { payload = parseCursorRequest(request) }
  catch (error) { throw new Error(error instanceof Error ? error.message.replaceAll('Codex', 'Cursor') : 'Cursor 请求格式错误') }
  const response = await fetch('/api/cursor/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(payload), signal })
  if (!response.ok || !response.body) return readAgentResponse(response, { project: request.project, baseline: payload.project }, onProgress, signal)
  let buffer = '', bytes = 0, started = false, finished = false
  const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder()
  const forward = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!line.trim()) return
    const event: unknown = JSON.parse(line)
    if (event && typeof event === 'object' && 'type' in event && event.type === 'message') {
      if (!started || finished) throw new Error('Cursor 对话消息不在有效回合内')
      if (!('text' in event) || typeof event.text !== 'string' || event.text.length > 8000) throw new Error('Cursor 对话流格式不正确')
      onText?.(event.text)
    } else {
      if (event && typeof event === 'object' && 'type' in event) {
        if (event.type === 'started') started = true
        if (event.type === 'done' || event.type === 'interrupted' || event.type === 'error') finished = true
      }
      controller.enqueue(encoder.encode(line + '\n'))
    }
  }
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if ((bytes += chunk.length) > 2 * 1024 * 1024) throw new Error('Cursor 对话流超过上限')
      buffer += decoder.decode(chunk, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) { forward(buffer.slice(0, end), controller); buffer = buffer.slice(end + 1) }
      if (buffer.length > 512 * 1024) throw new Error('Cursor 对话流行超过上限')
    },
    flush(controller) { buffer += decoder.decode(); if (buffer.trim()) forward(buffer, controller) },
  }))
  return readAgentResponse(new Response(stream, { status: response.status, headers: response.headers }), { project: request.project, baseline: payload.project }, onProgress, signal)
}

