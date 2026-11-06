import { useEffect, useRef, useState } from 'react'
import { Check, RefreshCw, Save } from 'lucide-react'
import { getCodexInstallation, setCodexInstallation, type CodexInstallationInfo } from '../core/codex-installation-client'

export default function CodexInstallationSettings({ onChanged }: { onChanged?: () => void }) {
  const [info, setInfo] = useState<CodexInstallationInfo | null>(null)
  const [path, setPath] = useState(''), [busy, setBusy] = useState<'read' | 'save' | 'reset' | null>('read'), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => { void load(); return () => request.current?.abort() }, [])
  async function load() {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setBusy('read'); setError('')
    try { const value = await getCodexInstallation(controller.signal); if (!controller.signal.aborted) { setInfo(value); setPath(value.configuredPath ?? '') } }
    catch (cause) { if (!controller.signal.aborted) setError((cause as Error).message) }
    finally { if (!controller.signal.aborted) setBusy(null) }
  }
  async function save(reset: boolean) {
    if (busy) return
    const controller = new AbortController(); request.current = controller; setBusy(reset ? 'reset' : 'save'); setError(''); setNotice('')
    try {
      const value = await setCodexInstallation(reset ? null : path, controller.signal)
      if (controller.signal.aborted) return
      setInfo(value); setPath(value.configuredPath ?? ''); setNotice(reset ? '已恢复自动检测。下次连接时使用新检测到的程序。' : 'Codex 安装路径已保存，下次连接和新任务时生效。'); onChanged?.()
    } catch (cause) { if (!controller.signal.aborted) setError((cause as Error).message) }
    finally { if (!controller.signal.aborted) setBusy(null) }
  }
  return <section className="settings-connection-card" aria-label="Codex 安装路径设置">
    <div className="settings-connection-title"><strong>Codex 程序位置</strong><span>{busy === 'read' ? '读取中' : info?.source === 'manual' ? '手动指定' : '自动检测'}</span></div>
    <label>Codex CLI 安装路径<input aria-label="Codex CLI 安装路径" value={path} maxLength={2048} spellCheck={false} disabled={!!busy} placeholder="例如 C:\程序目录\codex.exe" onChange={event => { setPath(event.target.value); setError(''); setNotice('') }}/></label>
    <div className="settings-native-actions"><button type="button" disabled={!!busy || !path.trim() || path.trim() === info?.configuredPath} onClick={() => void save(false)}><Save size={14}/>{busy === 'save' ? '保存中…' : '保存安装路径'}</button><button type="button" disabled={!!busy} onClick={() => void save(true)}>恢复自动检测</button><button type="button" disabled={!!busy} onClick={() => void load()}><RefreshCw size={14}/>重新检测路径</button></div>
    {info && <><p>当前生效路径：<code>{info.effectivePath ?? '未找到可用程序'}</code></p><p role="status">{info.message}</p></>}
    <small>填写程序完整路径，可粘贴带空格或引号的路径。只校验程序文件位置；登录及协议由实际连接检测。MCP 配置中的 command 仍使用工作台 Node 桥，外部 AI 客户端自行管理它的 Codex 登录与程序。</small>
    {error && <p className="settings-error" role="alert">{error}</p>}{notice && <p className="settings-notice" role="status"><Check size={14}/>{notice}</p>}
  </section>
}
