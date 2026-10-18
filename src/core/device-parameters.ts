import {parseSubcircuitOverrideValues} from './subcircuit-parameters'
import { parseQuantity, type Quantity } from './circuit'
import type { Device, DeviceKind } from './drawing'
import { isConfiguredSource, sourceValues } from './sources'
import { opAmpParameters } from './opamp-models'

export interface DeviceParameter {
  key: string
  label: string
  defaultValue: string
  quantity: Quantity
  min: number
  max: number
}
const param = (key:string,label:string,defaultValue:string,quantity:Quantity,min:number,max:number):DeviceParameter => ({key,label,defaultValue,quantity,min,max})
const contacts = [param('ron','导通电阻','50m','resistance',1e-5,1e6),param('roff','关断电阻','1G','resistance',1,1e12)]

/** Explicit editable parameters only; values are parsed to numbers before netlist emission. */
export const deviceParameterDefinitions:Partial<Record<DeviceKind,readonly DeviceParameter[]>> = {
  OPA:[param('gbw','增益带宽积','1MHz','frequency',1,1e9),param('inputR','差分输入电阻','1G','resistance',1e3,1e12),param('outputR','输出电阻','50','resistance',.01,1e5),param('headroom','输出距电源轨余量','500mV','voltage',0,10)],
  CMP:[param('bandwidth','小信号响应带宽','1MHz','frequency',1,1e9),param('inputR','差分输入电阻','1G','resistance',1e3,1e12),param('outputR','推挽输出电阻','50','resistance',.01,1e5),param('headroom','输出距电源轨余量','100mV','voltage',0,10)],
  SW: contacts,
  VSW: [...contacts,param('vt','控制阈值','2.5V','voltage',-1000,1000),param('vh','迟滞半宽','0.2V','voltage',0,1000)],
  RELAY: [param('coilR','线圈电阻','100','resistance',.01,1e6),param('coilL','线圈电感','50mH','inductance',1e-9,1e3),param('pickup','吸合电压','3.5V','voltage',.001,1000),param('release','释放电压','1.5V','voltage',0,1000),...contacts],
  LDO: [param('dropout','最小压差','300mV','voltage',0,100),param('currentLimit','输出限流','150mA','current',1e-6,100),param('outputR','输出电阻','50m','resistance',1e-4,1e3),param('quiescent','静态电流','50uA','current',0,1)],
  XFMR: [param('primaryL','初级电感','100mH','inductance',1e-9,1e3),param('coupling','耦合系数','0.999','gain',.001,.999999),param('primaryR','初级绕组电阻','100m','resistance',1e-5,1e6),param('secondaryR','次级绕组电阻','100m','resistance',1e-5,1e6)],
}

export const deviceModelNotes:Partial<Record<DeviceKind,string>> = {
  OPA:'通用五端单极点运放：有限开环增益、增益带宽积、输入/输出电阻与电源轨限幅。需外接 V+/V−；不含转换速率、共模范围、失调、噪声、供电电流或热效应，不能替代厂商模型。',
  CMP:'通用五端推挽比较器：高增益差分比较、单极点响应与电源轨限幅。输出电流由行为电源提供；不含迟滞、开漏输出、过驱动恢复或厂商延迟保证。',
  SW:'手动设定 ON / OFF；以有限接触电阻和漏电电阻仿真，修改状态后重新运行。',
  VSW:'带电压迟滞的双向触点：控制差分电压高于阈值＋半宽导通，低于阈值−半宽关断。',
  RELAY:'通用直流 SPDT 继电器：R/L 线圈、吸合与释放电压、互补常开/常闭触点。不包含机械延时、触点弹跳或热效应；反向线圈电压不吸合。',
  LDO:'通用正电压行为模型，包含压差、限流、输出电阻和静态电流，负载电流取自 IN。不包含控制环带宽、启动、噪声、反向保护器件或热关断。',
  XFMR:'线性耦合电感，变比为 Ns/Np，次级电感为初级电感乘变比平方；含绕组电阻，不含铁芯饱和或铁损。各绕组需要电位参考。',
}

export function deviceParameterValues(part:Pick<Device,'kind'|'value'|'params'>):Record<string,number> {
  if(part.kind==='X'){parseSubcircuitOverrideValues(part.params);return{}}
  if(isConfiguredSource(part)){sourceValues(part);return{}}
  const definitions=deviceParameterDefinitions[part.kind]??[]
  if(part.params!==undefined && (!part.params || typeof part.params!=='object' || Array.isArray(part.params)))throw new Error('器件参数必须是键值对象')
  for(const key of Object.keys(part.params??{}))if(!definitions.some(def=>def.key===key))throw new Error(`不支持的器件参数：${key}`)
  const values:Record<string,number>={}
  const preset = (part.kind === 'OPA' || part.kind === 'CMP') ? opAmpParameters(part.kind, part.value) : undefined
  for(const def of definitions){
    const presetValue = preset?.[def.key as keyof typeof preset]
    const raw=part.params?.[def.key]??(presetValue===undefined?def.defaultValue:String(presetValue))
    if(typeof raw!=='string')throw new Error(`${def.label}必须是数值字符串`)
    const n=parseQuantity(raw,def.quantity)
    if(n<def.min||n>def.max)throw new Error(`${def.label}允许范围 ${def.min}～${def.max}（基本单位）`)
    values[def.key]=n
  }
  if(values.ron!==undefined&&values.roff<=values.ron)throw new Error('关断电阻必须大于导通电阻')
  if(part.kind==='OPA'||part.kind==='CMP'){
    const gain=preset?.gain??parseQuantity(part.value,'gain')
    if(gain<1||gain>1e9)throw new Error('开环增益须在 1～1e9')
  }
  if(part.kind==='SW'&&!['ON','OFF'].includes(part.value))throw new Error('开关状态请选择 ON 或 OFF')
  if(part.kind==='VSW'&&part.value!=='SW_GENERIC')throw new Error('不支持此受控开关模型')
  if(part.kind==='RELAY'){
    if(part.value!=='RELAY_GENERIC')throw new Error('不支持此继电器模型')
    if(values.release>=values.pickup)throw new Error('释放电压必须小于吸合电压')
  }
  if(part.kind==='LDO'){
    const v=parseQuantity(part.value,'voltage')
    if(v<.1||v>100)throw new Error('LDO 输出电压允许范围 0.1～100 V')
  }
  if(part.kind==='XFMR'){
    const ratio=parseQuantity(part.value,'gain')
    if(ratio<.01||ratio>100)throw new Error('变比 Ns/Np 允许范围 0.01～100')
    const secondary=values.primaryL*ratio*ratio
    if(secondary<1e-9||secondary>1e3)throw new Error('变比与初级电感形成的次级电感须在 1 nH～1000 H')
  }
  return values
}

export function validateDeviceParameters(part:Pick<Device,'kind'|'value'|'params'>):Record<string,string>|undefined {
  deviceParameterValues(part)
  if(part.params===undefined)return undefined
  return Object.fromEntries(Object.entries(part.params).map(([key,value])=>[key,value]))
}
