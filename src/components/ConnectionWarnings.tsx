import type {ConnectionShort} from '../core/connection-shorts'

export default function ConnectionWarnings({shorts,onLocate}:{shorts:ConnectionShort[];onLocate:(short:ConnectionShort)=>void}) {
  if(!shorts.length)return null
  return <div className="connection-warning-banner" role="alert" aria-label="器件短接警告">{shorts.map(short=><div key={short.deviceId}>
    <span>{short.message}</span><button type="button" onClick={()=>onLocate(short)}>定位 {short.deviceId}</button>
  </div>)}</div>
}
