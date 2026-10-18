import { deviceCatalog, deviceKinds, models } from './devices'
import type { DeviceKind,GroundStyle } from './drawing'
import { sourceDefaults } from './sources'

export interface LibraryPart { id:string; kind:DeviceKind; name:string; detail:string; value:string; category:string; base?:boolean; modelIds?:readonly string[]; keywords?:string; params?:Record<string,string>;groundStyle?:GroundStyle }

// Entries represent circuit functions; numeric values and model variants belong
// to the inspector. Changing 1 kΩ to 10 kΩ does not create another device type.
const descriptions:Partial<Record<DeviceKind,string>>={
  R:'两端 · 线性电阻', C:'两端 · 储能 / 耦合 / 滤波', L:'两端 · 储能电感',
  V:'独立电压源 · 可编辑 DC / AC / 波形', I:'独立电流源 · 可编辑 DC / AC / 波形', OPA:'五端供电 · 单极点带宽 / 电源轨限幅',CMP:'五端供电 · 推挽比较 / 响应带宽',OP:'同相 / 反相 / 输出 · 理想增益', GND:'零电位参考',
  SW:'双端触点 · 手动开合', VSW:'四端 · 电压控制触点', RELAY:'五端 · 线圈 + 常开 / 常闭触点',
  LDO:'三端 · 输入 / 地 / 稳压输出', XFMR:'四端 · 原边 / 副边磁耦合',
}
const semiconductorFamilies:LibraryPart[]=[
  {id:'base-D',kind:'D',name:'普通二极管',detail:'PN 结 · 单向导电 / 整流',value:'D_SI',category:'半导体',base:true,modelIds:['D_SI'],keywords:'diode rectifier'},
  {id:'diode-schottky',kind:'D',name:'肖特基二极管',detail:'低正向压降 · 快速整流',value:'D_SCHOTTKY',category:'半导体',modelIds:['D_SCHOTTKY'],keywords:'schottky'},
  {id:'diode-zener',kind:'D',name:'稳压二极管',detail:'反向击穿 · 钳位 / 稳压',value:'D_ZENER',category:'半导体',modelIds:['D_ZENER_3V3','D_ZENER','D_ZENER_12V'],keywords:'zener'},
  {id:'diode-fast',kind:'D',name:'快恢复二极管',detail:'快速恢复 · 开关整流',value:'D_FAST',category:'半导体',modelIds:['D_FAST'],keywords:'fast recovery'},
  {id:'diode-led',kind:'D',name:'LED 发光二极管',detail:'红 / 绿 / 蓝 · 电气模型',value:'D_LED_RED',category:'光电',modelIds:['D_LED_RED','D_LED_GREEN','D_LED_BLUE'],keywords:'light emitting diode 发光'},
  {id:'base-Q',kind:'Q',name:'NPN 三极管',detail:'电流控制 · 放大 / 开关',value:'Q_NPN',category:'半导体',base:true,modelIds:['Q_NPN','Q_NPN_HIGH_GAIN'],keywords:'bjt transistor'},
  {id:'transistor-pnp',kind:'Q',name:'PNP 三极管',detail:'互补极性 · 放大 / 开关',value:'Q_PNP',category:'半导体',modelIds:['Q_PNP','Q_PNP_HIGH_GAIN'],keywords:'bjt transistor'},
  {id:'transistor-npn-switch',kind:'Q',name:'NPN 开关三极管',detail:'低存储电荷 · 数字开关 / 驱动',value:'Q_NPN_SWITCH',category:'半导体',modelIds:['Q_NPN_SWITCH'],keywords:'bjt transistor switching'},
  {id:'transistor-pnp-switch',kind:'Q',name:'PNP 开关三极管',detail:'互补开关 · 反向存储时间',value:'Q_PNP_SWITCH',category:'半导体',modelIds:['Q_PNP_SWITCH'],keywords:'bjt transistor switching'},
  {id:'transistor-npn-power',kind:'Q',name:'NPN 功率三极管',detail:'高注入 / 寄生电阻 · 推挽输出级',value:'Q_NPN_POWER',category:'半导体',modelIds:['Q_NPN_POWER'],keywords:'bjt transistor power'},
  {id:'transistor-pnp-power',kind:'Q',name:'PNP 功率三极管',detail:'互补功率级 · 无热效应模型',value:'Q_PNP_POWER',category:'半导体',modelIds:['Q_PNP_POWER'],keywords:'bjt transistor power'},
  {id:'jfet-n',kind:'J',name:'N 沟道 JFET',detail:'结型场效应管 · 高输入阻抗 / 恒流',value:'J_NJFET',category:'半导体',modelIds:['J_NJFET'],keywords:'junction fet njfet 场效应管'},
  {id:'jfet-p',kind:'J',name:'P 沟道 JFET',detail:'互补结型场效应管 · 正栅压关断',value:'J_PJFET',category:'半导体',modelIds:['J_PJFET'],keywords:'junction fet pjfet 场效应管'},
  {id:'mosfet-n-depletion',kind:'M',name:'N 沟道耗尽型 MOS',detail:'默认导通 · 负栅压关断',value:'M_NMOS_DEPLETION',category:'半导体',modelIds:['M_NMOS_DEPLETION'],keywords:'depletion nmos 耗尽'},
  {id:'mosfet-p-depletion',kind:'M',name:'P 沟道耗尽型 MOS',detail:'默认导通 · 正栅压关断',value:'M_PMOS_DEPLETION',category:'半导体',modelIds:['M_PMOS_DEPLETION'],keywords:'depletion pmos 耗尽'},
  {id:'mosfet-n-power',kind:'M',name:'N 沟道功率 MOS',detail:'VDMOS · 体二极管 / 非线性栅电容',value:'M_NMOS_POWER',category:'半导体',modelIds:['M_NMOS_POWER'],keywords:'vdmos power nmos 功率'},
  {id:'mosfet-p-power',kind:'M',name:'P 沟道功率 MOS',detail:'互补 VDMOS · 体二极管 / 栅电荷',value:'M_PMOS_POWER',category:'半导体',modelIds:['M_PMOS_POWER'],keywords:'vdmos power pmos 功率'},
  {id:'base-M',kind:'M',name:'N 沟道 MOSFET',detail:'电压控制 · N 沟道',value:'M_NMOS',category:'半导体',modelIds:['M_NMOS','M_NMOS_LOGIC'],keywords:'nmos 场效应管'},
  {id:'mosfet-pmos',kind:'M',name:'P 沟道 MOSFET',detail:'电压控制 · P 沟道',value:'M_PMOS',category:'半导体',modelIds:['M_PMOS','M_PMOS_LOGIC'],keywords:'pmos 场效应管'},
]
const keywords:Partial<Record<DeviceKind,string>>={R:'resistor',C:'capacitor',L:'inductor',V:'voltage source',I:'current source',OPA:'opamp operational amplifier 供电 运算放大器 带宽 饱和',CMP:'comparator 比较器 推挽',OP:'opamp amplifier 运算放大器',GND:'ground',SW:'switch 开关',VSW:'voltage controlled switch 压控开关',RELAY:'relay 继电器 coil SPDT',LDO:'regulator 低压差 线性稳压器',XFMR:'transformer 变压器'}
const sourceParts:LibraryPart[]=(['V','I'] as const).flatMap(kind=>{
  const label=kind==='V'?'电压':'电流',unit=kind==='V'?'V':'mA'
  return [
    {id:`source-${kind}-expression`,kind,name:`代码自定义${label}源`,detail:'f(time) · 调制 / 衰减 / 条件波形',value:`0${unit}`,category:'电源',params:sourceDefaults(kind,'expression'),keywords:'behavioral expression code 任意 数学 代码 波形 激励'},
    {id:`source-${kind}-sine`,kind,name:`正弦${label}源`,detail:'SIN · 幅度 / 频率 / 相位 / 延时',value:`0${unit}`,category:'电源',params:sourceDefaults(kind,'sine'),keywords:'sine sinusoidal 正弦 信号 激励'},
    {id:`source-${kind}-pulse`,kind,name:`脉冲${label}源`,detail:'PULSE · 电平 / 边沿 / 宽度 / 周期',value:`0${unit}`,category:'电源',params:sourceDefaults(kind,'pulse'),keywords:'pulse square pwm clock 脉冲 方波 时钟 激励'},
    {id:`source-${kind}-triangle`,kind,name:`三角${label}源`,detail:'对称斜坡 · 1 ps 顶部停留',value:`0${unit}`,category:'电源',params:{...sourceDefaults(kind,'pulse'),rise:'499.9999995us',fall:'499.9999995us',width:'1ps'},keywords:'triangle sawtooth ramp 三角 锯齿 斜坡 激励'},
    {id:`source-${kind}-pwl`,kind,name:`PWL ${label}源`,detail:'任意时间点 · 分段线性波形',value:`0${unit}`,category:'电源',params:sourceDefaults(kind,'pwl'),keywords:'piecewise linear pwl 任意 波形 分段线性 激励'},
  ]
})
export const libraryParts:LibraryPart[]=[
  ...deviceKinds.filter(kind=>!['D','Q','M','J','X'].includes(kind)).map(kind=>({id:`base-${kind}`,kind,name:kind==='V'?'直流电压源':kind==='I'?'直流电流源':deviceCatalog[kind].name,value:deviceCatalog[kind].value,category:deviceCatalog[kind].category,detail:descriptions[kind]??`${deviceCatalog[kind].pins.length} 引脚`,base:['R','C','L','V','I','GND'].includes(kind),keywords:keywords[kind],...((kind==='V'||kind==='I')?{params:{...sourceDefaults(kind),acAmplitude:kind==='V'?'0V':'0A'}}:{})})),
  ...semiconductorFamilies,
  ...sourceParts,
  {id:'ground-signal',kind:'GND',name:'信号地',detail:'三角接地 · 零电位参考',value:'',category:'参考',groundStyle:'signal',keywords:'ground signal gnd 地 接地'},
  {id:'ground-chassis',kind:'GND',name:'机壳地',detail:'机壳接地 · 零电位参考',value:'',category:'参考',groundStyle:'chassis',keywords:'ground chassis gnd 地 接地'},
]
export const basicLibraryParts=libraryParts.filter(part=>part.base)
export const extendedLibraryParts=libraryParts.filter(part=>!part.base)
/** A small placement palette: one entry per function, backed by existing presets. */
export const commonLibraryPartIds=[
  'base-R','base-C','base-L','base-V','base-I','base-D',
  'diode-schottky','diode-zener','diode-led','base-Q','transistor-pnp','base-M',
  'mosfet-pmos','base-OPA','base-CMP','base-SW','source-V-sine','source-V-pulse',
] as const
export const commonLibraryParts=commonLibraryPartIds.map(id=>{
  const part=libraryParts.find(item=>item.id===id)
  if(!part)throw new Error(`Missing common-device preset: ${id}`)
  return part
})
/** Drag carries an allowlisted preset id, never arbitrary executable model text. */
export const libraryPartById=(id:string)=>libraryParts.find(part=>part.id===id)
export const libraryCategories=['全部','无源','磁性器件','电源','电源管理','开关与机电','半导体','光电','放大器','参考'].filter(category=>category==='全部'||libraryParts.some(part=>part.category===category))
for(const category of new Set(libraryParts.map(part=>part.category)))if(!libraryCategories.includes(category))libraryCategories.push(category)
export const librarySymbolCount=deviceKinds.length
export const libraryModelCount=models.length
export function findLibraryParts(search:string,category='全部') {
  const words=search.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return libraryParts.filter(part=>{
    const modelText=models.filter(model=>part.modelIds?.includes(model.id)).map(model=>`${model.id} ${model.name} ${model.detail}`).join(' ')
    return(category==='全部'||part.category===category)&&words.every(word=>`${part.name} ${part.kind} ${part.detail} ${part.category} ${part.keywords??''} ${modelText}`.toLowerCase().includes(word))
  })
}
