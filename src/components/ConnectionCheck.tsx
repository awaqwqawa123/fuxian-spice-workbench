import { useRef } from 'react'
import { Check, X } from 'lucide-react'
import { useWorkbenchDialog } from './AssistantWindow'

export default function ConnectionCheck({errors,onClose}:{errors:string[];onClose:()=>void}) {
  const panel=useRef<HTMLElement>(null)
  useWorkbenchDialog(panel,true,onClose)
  return <div className="workbench-window-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
    <section ref={panel} className="workbench-window connection-check-window" role="dialog" aria-modal="true" aria-label="连接与参数检查" tabIndex={-1}>
      <header className="workbench-window-heading"><h2>{errors.length?`连接与参数待完成 · ${errors.length} 项`:'连接检查通过'}</h2><button aria-label="关闭连接检查" onClick={onClose}><X size={18}/></button></header>
      <div className="editor-issues" role={errors.length?'alert':'status'}>{errors.length?errors.map((error,index)=><p key={`${index}-${error}`}><span>{String(index+1).padStart(2,'0')}</span>{error}</p>):<p><Check size={14}/>器件已连接到接地电路，可以运行仿真。</p>}</div>
    </section>
  </div>
}
