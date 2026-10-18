import { ChevronDown, ChevronUp, CircleCheck, CircleAlert, Eye, EyeOff, LoaderCircle, RotateCw, Square, Table2, X } from 'lucide-react'
import type { useDcVoltages } from '../core/use-dc-voltages'

type State=ReturnType<typeof useDcVoltages>

/** Meter lettering and the solid/dashed DC mark remain readable at toolbar size. */
function DcMeterIcon({quantity}:{quantity:'voltage'|'current'}) {
  return <svg className="bias-meter-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="5" stroke="currentColor" strokeWidth="1.5"/>{quantity==='voltage'?<path d="m7.5 6.5 4.5 7 4.5-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>:<path d="m7.5 13.5 4.5-7 4.5 7m-6.9-2.4h4.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>}<path d="M7.5 16h9m-9 2.5h1.5m2.25 0h1.5m2.25 0h1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
}

export function DcVoltageToggle({state}:{state:State}) {
  return <div className="bias-toolbar" role="group" aria-label="直流工作点显示">
    <button type="button" className={`bias-meter-toggle${state.enabled?' active':''}`} aria-label="直流电压" aria-pressed={state.enabled} title="直流电压 · 切换画布电压标注" onClick={()=>state.toggle(!state.enabled)}><DcMeterIcon quantity="voltage"/></button>
    <button type="button" className={`bias-meter-toggle${state.currentsEnabled?' active':''}`} aria-label="直流电流" aria-pressed={state.currentsEnabled} title="直流电流 · 切换有方向的电流标注" onClick={()=>state.toggleCurrents(!state.currentsEnabled)}><DcMeterIcon quantity="current"/></button>
    <button type="button" className={state.tableOpen?'active':''} aria-label="打开直流工作点" aria-expanded={state.tableOpen} aria-controls="bias-inspection-results" title={state.tableOpen?'收起工作点详情 · 保留画布标注':'展开工作点详情'} onClick={()=>state.setTableOpen(!state.tableOpen)}><Table2 size={16}/><span>工作点</span>{state.tableOpen?<ChevronUp size={12}/>:<ChevronDown size={12}/>}</button>
    {(state.displayActive||state.running)&&<button type="button" className="bias-notice-toggle" aria-label={state.noticeHidden?'显示直流工作点提示':'隐藏直流工作点提示'} aria-pressed={!state.noticeHidden} title={state.noticeHidden?'显示计算状态与错误详情':'隐藏提示卡，保留测量标注'} onClick={()=>state.setNoticeHidden(!state.noticeHidden)}>{state.noticeHidden?<Eye size={16}/>:<EyeOff size={16}/>}</button>}
    {state.noticeHidden&&state.running&&<button type="button" aria-label="停止工作点计算" title="停止直流工作点计算" onClick={state.stop}><Square size={14}/></button>}
    {state.displayActive&&<button type="button" className="dc-voltage-refresh" aria-label="重新计算直流电压" title="重新计算电压与电流工作点" disabled={state.running} onClick={state.calculate}>{state.running?<LoaderCircle size={14} className="step-loading-icon"/>:<RotateCw size={14}/>}</button>}
  </div>
}

export function DcVoltageNotice({state}:{state:State}) {
  if(state.noticeHidden||!state.displayActive&&!state.running)return null
  const ready=!state.running&&!state.failure&&!state.stale&&!!state.result
  // Ready results live on the canvas and in the expandable table, not in a second window.
  const compact=ready&&!state.storageWarning&&!state.placingWire
  if(compact&&state.tableOpen)return null
  const StatusIcon=state.running?LoaderCircle:state.failure||state.stale?CircleAlert:CircleCheck
  const title=state.failure.startsWith('计算已停止')?'工作点计算已停止':state.failure?'直流工作点未能计算':state.running?'正在计算直流工作点':state.stale?'电路已修改 · 请重新计算':ready?'直流工作点 · 已更新':'直流工作点 · 尚未计算'
  return <div className={`dc-voltage-notice${compact?' bias-notice-compact':''}`} role={state.failure?'alert':'status'} aria-label="直流电压状态" data-state={state.failure?'error':state.running?'running':state.stale?'stale':ready?'ready':'empty'}>
    <div className="bias-notice-heading">
      <span className="bias-notice-icon"><StatusIcon size={compact?14:18} strokeWidth={1.75} className={state.running?'step-loading-icon':undefined} aria-hidden="true"/></span>
      <div className="bias-notice-title"><strong>{title}</strong>{!compact&&<span>电压与电流{state.running?' · 计算中':''}</span>}</div>
      <div className="bias-notice-actions">
        <button className="canvas-view-action" type="button" onClick={()=>state.setTableOpen(!state.tableOpen)} aria-label={state.tableOpen?'收起工作点详情':'查看工作点结果表'} aria-expanded={state.tableOpen} aria-controls="bias-inspection-results" title={state.tableOpen?'收起详情，保留画布标注':'展开可移动、可调大小的工作点详情'}>{state.tableOpen?<ChevronUp size={16}/>:<ChevronDown size={16}/>}</button>
        {!compact&&(state.running?<button className="canvas-view-action" type="button" aria-label="停止工作点计算" title="停止工作点计算" onClick={state.stop}><Square size={15} strokeWidth={1.75} aria-hidden="true"/></button>:<button className="canvas-view-action" type="button" aria-label="重新计算直流工作点" title="重新计算电压与电流" onClick={state.calculate}><RotateCw size={17} strokeWidth={1.75} aria-hidden="true"/></button>)}
        <button className="canvas-view-action" type="button" aria-label="隐藏直流工作点提示卡" title="隐藏提示卡，可从顶栏重新显示" onClick={()=>state.setNoticeHidden(true)}><X size={15} strokeWidth={1.75} aria-hidden="true"/></button>
      </div>
    </div>
    {(state.failure||state.running||state.stale)&&<p className="bias-notice-message">{state.failure||(state.running?state.progress:'旧电压与电流标注已隐藏。')}</p>}
    {state.storageWarning&&<p className="bias-storage-warning">{state.storageWarning}</p>}
    {state.placingWire&&<p className="bias-wire-hint">点击一段导线，放置工作点电流标记。<button className="canvas-view-action" aria-label="取消工作点导线测量" title="取消导线电流测量" onClick={()=>state.setPlacingWire(false)}><X size={14} aria-hidden="true"/></button></p>}
  </div>
}
