import type { CSSProperties } from 'react'
import { Activity, X } from 'lucide-react'
import { formatSI } from '../core/circuit'
import { terminalKey, type Terminal } from '../core/drawing'
import { MAX_MEASUREMENT_PROBES, measurementType, probeColors, probeTypes, resolveMeasurement, type Measurement, type ProbeType } from '../core/probes'
import type { Result } from '../core/results'
import { wireCurrentName, wireCurrentUnavailableReason } from '../core/wire-currents'
import ProbeIcon from './ProbeIcon'

export type ProbeMode = ProbeType
const modeOrder:ProbeMode[]=['voltage','current','differential']

export default function ProbeTray({mode,onMode,active,onActivate,measurements,selected,onSelect,onRemove,onClear,pending,onCancelPending,result,stale,onViewResults}:{mode:ProbeMode;onMode:(mode:ProbeMode)=>void;active:boolean;onActivate:()=>void;measurements:Measurement[];selected?:string;onSelect:(id:string)=>void;onRemove:(id:string)=>void;onClear:()=>void;pending:Terminal|null;onCancelPending:()=>void;result:Result|null;stale:boolean;onViewResults:()=>void}) {
  return <div className={`probe-tray typed-probe-tray ${active?'is-measuring':''}`} aria-label="测量探针">
    <div className="probe-tray-tools"><strong><Activity size={15}/>测量探针</strong><span className="probe-count">{measurements.length}/{MAX_MEASUREMENT_PROBES}</span><button onClick={onViewResults}>查看波形 ↓</button>{measurements.length>0&&<button className="clear-probes" onClick={onClear}>清空测量</button>}</div>
    <div className="probe-mode-buttons" role="group" aria-label="探针类型">{modeOrder.map(type=><button key={type} className={`probe-mode-button probe-mode-${type}`} data-probe-mode={type} aria-label={`${probeTypes[type].name}探针`} aria-pressed={active&&mode===type} onClick={()=>onMode(type)}><b aria-hidden="true"><ProbeIcon type={type}/></b><span><strong>{probeTypes[type].name}<em>{probeTypes[type].symbol}</em></strong><small>{probeTypes[type].target}</small></span>{active&&mode===type&&<i aria-hidden="true"/>}</button>)}</div>
    <div className={`probe-instruction ${pending?'has-pending':''}`} aria-live="polite">
      {pending?<><span className="probe-step-sign">+</span><span><strong>正端已选：{terminalKey(pending)}</strong>点击负端完成 V(+) − V(−)。</span><button onClick={onCancelPending}>取消正端</button></>:<><span className="probe-instruction-symbol" aria-hidden="true">{probeTypes[mode].symbol}</span><span>{mode==='differential'?'从正端拖到负端，或依次点击两端，测量 V(+) − V(−)。':mode==='current'?'点击导线上的一段，测量该支路电流；也可点击 R/C/L/V/I/D 器件，正方向为 1 → 2。二极管及电流源暂不支持 AC 电流。':'点击导线任意位置或器件引脚，测量该点相对地的电压。'}<small>拖标牌调整位置；{mode==='current'?'导线电流钳可拖动换线，双击反向；':'拖测量端点换节点；'}Esc 退出测量{mode==='differential'?'并取消未完成正端':''}。</small></span>{!active&&<button onClick={onActivate}>开始测量</button>}</>}
    </div>
    {!!measurements.length&&<div className="probe-chips">{measurements.map((m,index)=>{
      const type=measurementType(m),trace=result&&!stale?resolveMeasurement(result,m):null
      const name=trace?.name??(m.kind==='current'?m.wire?wireCurrentName(m.wire):`I(${m.device})`:`${terminalKey(m.positive)}${m.negative?' − '+terminalKey(m.negative):''}`)
      const unavailable=!!result&&!stale&&!trace
      const unavailableReason=unavailable&&m.kind==='current'&&m.wire?wireCurrentUnavailableReason(result!,m.wire):'当前仿真没有此探针的有效数据；部分器件的 AC 电流尚不支持。'
      const color=probeColors[(Number(m.id.slice(1))-1||index)%probeColors.length]
      return <div key={m.id} className={`probe-chip probe-chip-${type} ${selected===m.id?'active':''} ${unavailable?'unavailable':''}`} style={{'--probe-color':color} as CSSProperties}><button aria-label={`查看${probeTypes[type].name}测量 ${m.id}`} onClick={()=>onSelect(m.id)}><b className="probe-chip-type" title={`${probeTypes[type].name}探针`}>{probeTypes[type].symbol}</b>{m.id}<span>{name}</span>{trace&&result?.analysis==='op'&&<strong>{formatSI(trace.values[0],m.kind==='current'?'A':'V',5)}</strong>}{unavailable&&<em title={unavailableReason??undefined}>无可用数据</em>}</button><button aria-label={`移除测量 ${m.id}`} title="移除测量" onClick={()=>onRemove(m.id)}><X size={13}/></button></div>
    })}</div>}
    {!!measurements.length&&(!result||stale)&&<small className="probe-pending">{stale?'电路已修改，运行后更新测量。':'探针已就绪，运行仿真查看读数。'}</small>}
  </div>
}
