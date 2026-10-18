import type { DeviceLibraryProfile } from '../core/device-library-profile'
import React from 'react'

export function DeviceProfileDetails({profile}:{profile?:DeviceLibraryProfile}) {
  if(!profile)return null
  const {device,symbol,pinMapping,electrical}=profile
  return <details className="device-profile-details" onClick={event=>event.stopPropagation()}>
    <summary>器件资料与核对详情</summary>
    <dl style={{display:'grid',gridTemplateColumns:'max-content minmax(0, 1fr)',gap:'6px 10px',margin:'10px 0',fontSize:'12px',lineHeight:1.6,overflowWrap:'anywhere'}}>
      <dt>器件资料</dt><dd style={{margin:0}}>{device.manufacturer??'厂商待核对'} · {device.categoryLabel}{device.function&&<div>{device.function}</div>}</dd>
      <dt>器件符号</dt><dd style={{margin:0}}>{symbol.status==='original'?'原库图形':symbol.status==='standard'?'标准器件符号':'连接示意，原库图形待核对'}<div>{symbol.source??(symbol.status==='original'?'原符号来源路径待补齐':'工作台标准图形')}</div>{symbol.sha256&&<div>SHA-256：{symbol.sha256}</div>}</dd>
      <dt>引脚对应</dt><dd style={{margin:0}}>{pinMapping.status==='verified'?'已核对显示与电气端口':'已保留电气端口顺序，功能待核对'}<div>{pinMapping.ports.map(port=><span key={port.index} style={{display:'inline-block',marginRight:8}}>端口 {port.index+1}：{port.label}{port.number?`（原脚号 ${port.number}）`:''}{port.label!==port.node?` / ${port.node}`:''}</span>)}</div></dd>
      <dt>仿真模型</dt><dd style={{margin:0}}>静态语法及依赖检查通过 · {electrical.declarations} 项定义<div>尚未验证仿真精度</div>{electrical.engineReview&&<div aria-label="实际引擎审查" data-engine-status={electrical.engineReview.status}><strong>{electrical.engineReview.status==='load-passed'?'引擎加载检查通过':electrical.engineReview.status==='compatibility-error'?'引擎兼容未通过 · 暂不放置':electrical.engineReview.status==='compatibility-warning'?'引擎参数有警告 · 需核对':'需按器件工作条件继续验证'}</strong><p>{electrical.engineReview.reason}</p><small>核对范围：{electrical.engineReview.test==='All ordered ports separately terminated by 1 Mohm; unpowered load test'?'按原始顺序连接所有端口，各用 1 MΩ 接地；未供电，不能代表实际工作性能':'原生器件在 50 mV 下的有限工作点；不代表完整器件特性'}</small></div>}{electrical.dependencies.length>0&&<details><summary>依赖定义（{electrical.dependencies.length}）</summary>{electrical.dependencies.join('、')}</details>}</dd>
    </dl>
    {device.evidence.length>0&&<details><summary>查看原件证据</summary>{device.evidence.map((item,index)=><p key={index} style={{fontSize:12,overflowWrap:'anywhere'}}>{item.text}<br/>{item.source}{item.sha256&&<><br/>SHA-256：{item.sha256}</>}</p>)}</details>}
  </details>
}
