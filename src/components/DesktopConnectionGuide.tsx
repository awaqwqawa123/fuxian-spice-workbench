import { Check, ExternalLink, LoaderCircle, RefreshCw, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import type { CodexStatus } from '../core/codex-client'
import type { DesktopControlSetupAction, DesktopControlSetupStage } from '../core/desktop-control-client'

interface Props {
  codex: CodexStatus | null
  stage: DesktopControlSetupStage | null
  connected: boolean
  threadId: string | null
  checking: boolean
  statusError: string
  actionError: string
  busy: DesktopControlSetupAction | 'auto' | null
  autoStatus: string
  onAutoConnect: () => void
  onAction: (action: DesktopControlSetupAction) => void
  onRefresh: () => void
  onOpenChat?: () => void
}

export default function DesktopConnectionGuide({ codex, stage, connected, threadId, checking, statusError, actionError, autoStatus, busy, onAutoConnect, onAction, onRefresh, onOpenChat }: Props) {
  const installed = !!codex?.installed
  const activated = stage === 'activated' || connected
  const steps = [installed, activated, connected, connected && !!threadId]
  const current = steps.findIndex(done => !done)
  const step = (number: number, title: string, description: string, children?: ReactNode) => {
    const state = steps[number - 1] ? 'done' : current === number - 1 ? 'current' : 'waiting'
    return <li data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
      <span className="desktop-guide-number" aria-hidden="true">{state === 'done' ? <Check size={15}/> : number}</span>
      <div className="desktop-guide-step"><div className="desktop-guide-heading"><strong>{title}</strong><span>{state === 'done' ? '完成' : state === 'current' ? '当前步骤' : '待完成'}</span></div><p>{description}</p>{children}</div>
    </li>
  }
  return <section className="desktop-connection-guide" aria-label="Codex 桌面连接向导">
    <div className="desktop-guide-intro"><div><h4>连接 Codex 桌面共享</h4><p>一键检查并修复共享连接，继续对应项目的对话。</p></div><button type="button" className="primary desktop-guide-auto" disabled={checking || !!busy} onClick={onAutoConnect}>{busy === 'auto' ? <LoaderCircle className="desktop-control-spinner" size={16}/> : <Wrench size={16}/>} {busy === 'auto' ? '正在连接…' : connected ? '重新连接' : '自动检测并连接'}</button></div>
    {autoStatus && <p className="desktop-guide-progress" role="status" aria-live="polite">{busy === 'auto' && <LoaderCircle className="desktop-control-spinner" size={14}/>} {autoStatus}</p>}
    <div className="desktop-guide-map" aria-label="桌面共享连接路径"><span>Codex 桌面</span><b aria-hidden="true">→</b><span>本机共享入口</span><b aria-hidden="true">→</b><span>工作台网页</span></div>
    <ol>
      {step(1, '安装并打开 Codex', checking ? '正在检查本机 Codex…' : installed ? codex?.authenticated === false ? '已找到 Codex，但尚未登录。请在官方桌面完成登录。' : codex?.authenticated === null ? '已找到 Codex；登录状态未确认，发送对话时再验证。' : '已找到本机 Codex 并检测到登录。' : '请先安装官方 Codex 桌面应用，并打开一次。')}
      {step(2, '配置共享入口', checking ? '正在检查安装状态…' : stage === 'activated' || connected ? '共享入口已配置。重新连接会自动处理失效路径与连接缓存。' : stage === 'prepared' ? '共享文件已准备好；点击自动连接会继续启用。' : stage === 'broken' ? '共享配置需要修复。点击自动连接恢复入口。' : '点击自动连接会准备并启用共享入口。',
        <details className="desktop-guide-manual"><summary>手动安装或修复</summary><div className="desktop-guide-actions">
          {!checking && installed && stage === 'not-prepared' && <button type="button" disabled={!!busy} onClick={() => onAction('prepare')}>{busy === 'prepare' ? '准备中…' : '准备共享入口'}</button>}
          {!checking && installed && stage === 'prepared' && <button type="button" disabled={!!busy} onClick={() => onAction('activate')}>{busy === 'activate' ? '启用中…' : '启用共享入口'}</button>}
          {!checking && stage === 'broken' && <><button type="button" disabled={!!busy} onClick={() => onAction('restore')}>{busy === 'restore' ? '恢复中…' : '恢复原入口'}</button><button type="button" disabled={!!busy} onClick={() => onAction('prepare')}>{busy === 'prepare' ? '准备中…' : '重新准备'}</button></>}
          {!checking && !installed && <small>安装后点“重新检查”。</small>}
        </div></details>)}
      {step(3, '连接桌面共享', connected ? '网页已连接到官方桌面的共享服务。' : activated ? '点击重新连接恢复桌面共享。如本次修复需要重新打开 Codex，上方会显示具体说明。' : '配置入口后会继续检查桌面连接。',
        !checking && activated && !connected && <div className="desktop-guide-actions"><button type="button" disabled={!!busy} onClick={onAutoConnect}><RefreshCw size={14}/>重新连接</button></div>)}
      {step(4, '连接项目对话', connected && threadId ? '此项目已有专属 Codex 对话；切换项目时会继续对应的聊天。' : connected ? '桌面已接通。切换到未绑定的项目时，工作台会自动新建并绑定它的专属对话。' : '桌面接通后，工作台会自动为未绑定的项目新建对话。',
        connected && onOpenChat && <div className="desktop-guide-actions"><button type="button" onClick={onOpenChat}>打开 AI 助手 <ExternalLink size={13}/></button></div>)}
    </ol>
    {statusError && <p className="desktop-guide-error" role="alert">状态检查失败：{statusError}</p>}
    {actionError && <p className="desktop-guide-error" role="alert">配置失败：{actionError}</p>}
    {stage === 'activated' && !connected && <details className="desktop-guide-recovery"><summary>连接与恢复详情</summary><p>重新连接会检查安装目录、共享服务和项目对话。桌面更新导致配置失效时会自动修复；只有桌面需要重新加载入口时，才会提示完整退出并重开一次。原对话关联会保留。</p><button type="button" disabled={!!busy} onClick={onRefresh}>刷新状态</button><button type="button" disabled={!!busy} onClick={() => onAction('restore')}>恢复原入口</button></details>}
  </section>
}
