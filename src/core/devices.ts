import type { Device, DeviceKind, Pin, XY } from './drawing'
import type { ImportedSpiceModel } from './spice-models'
import { opAmpModels } from './opamp-models'

export const deviceCatalog: Record<DeviceKind, { name: string; prefix: string; value: string; pins: readonly string[]; category: string }> = {
  R: { name: '电阻', prefix: 'R', value: '1k', pins: ['1', '2'], category: '无源' },
  C: { name: '电容', prefix: 'C', value: '100nF', pins: ['1', '2'], category: '无源' },
  L: { name: '电感', prefix: 'L', value: '10mH', pins: ['1', '2'], category: '无源' },
  V: { name: '电压源', prefix: 'V', value: '5V', pins: ['正端 +', '负端 −'], category: '电源' },
  I: { name: '电流源', prefix: 'I', value: '1mA', pins: ['流出端 +', '流入端 −'], category: '电源' },
  D: { name: '二极管', prefix: 'D', value: 'D_SI', pins: ['阳极 A', '阴极 K'], category: '半导体' },
  Q: { name: '三极管', prefix: 'Q', value: 'Q_NPN', pins: ['集电极 C', '基极 B', '发射极 E'], category: '半导体' },
  M: { name: 'MOS 管', prefix: 'M', value: 'M_NMOS', pins: ['漏极 D', '栅极 G', '源极 S'], category: '半导体' },
  J: { name:'JFET 结型场效应管',prefix:'JF',value:'J_NJFET',pins:['漏极 D','栅极 G','源极 S'],category:'半导体' },
  X: { name:'SPICE 子电路',prefix:'X',value:'',pins:[],category:'集成电路' },
  OPA: { name:'供电运放',prefix:'U',value:'100k',pins:['同相 +','反相 −','输出 OUT','正电源 V+','负电源 V−'],category:'放大器' },
  CMP: { name:'电压比较器',prefix:'U',value:'100k',pins:['同相 +','反相 −','输出 OUT','正电源 V+','负电源 V−'],category:'放大器' },
  OP: { name: '理想运放', prefix: 'E', value: '100k', pins: ['同相 +', '反相 −', '输出'], category: '放大器' },
  SW: { name: '手动开关', prefix: 'SW', value: 'OFF', pins: ['触点 1', '触点 2'], category: '开关与机电' },
  VSW: { name: '电压控制开关', prefix: 'S', value: 'SW_GENERIC', pins: ['触点 1', '触点 2', '控制 +', '控制 −'], category: '开关与机电' },
  RELAY: { name: 'SPDT 继电器', prefix: 'K', value: 'RELAY_GENERIC', pins: ['线圈 +', '线圈 −', '公共 COM', '常开 NO', '常闭 NC'], category: '开关与机电' },
  LDO: { name: 'LDO 稳压器', prefix: 'U', value: '3.3V', pins: ['输入 IN', '参考 GND', '输出 OUT'], category: '电源管理' },
  XFMR: { name: '变压器', prefix: 'T', value: '1', pins: ['初级同名端 P+', '初级 P−', '次级同名端 S+', '次级 S−'], category: '磁性器件' },
  GND: { name: '接地', prefix: 'G', value: '', pins: ['GND'], category: '参考' },
}
export const deviceKinds = Object.keys(deviceCatalog) as DeviceKind[]
export const pinsFor = (item: DeviceKind|Device): Pin[] => {
  const kind=typeof item==='string'?item:item.kind
  return (kind==='X'&&typeof item!=='string'?item.pins??[]:deviceCatalog[kind].pins).map((_,i)=>i)
}
export function localPin(kind: DeviceKind, pin: Pin, device?:Device): XY {
  if(kind==='X'){
    const specified=device?.pinPositions?.[pin]
    if(specified)return specified
    const count=device?.pins?.length??0,left=Math.ceil(count/2),row=pin<left?pin:pin-left
    return {x:pin<left?-60:60,y:(row-(Math.max(left,count-left)-1)/2)*20}
  }
  if (kind === 'GND') return { x: 0, y: 0 }
  if (kind === 'Q' || kind === 'M' || kind === 'J') return [{ x: 20, y: -40 }, { x: -40, y: 0 }, { x: 20, y: 40 }][pin]
  if(kind==='OPA'||kind==='CMP')return [{x:-40,y:-20},{x:-40,y:20},{x:60,y:0},{x:0,y:-60},{x:0,y:60}][pin]
  if (kind === 'OP') return [{ x: -40, y: -20 }, { x: -40, y: 20 }, { x: 40, y: 0 }][pin]
  if (kind === 'VSW') return [{ x:-40,y:-20 },{ x:40,y:-20 },{ x:-20,y:40 },{ x:20,y:40 }][pin]
  if (kind === 'RELAY') return [{ x:-60,y:-20 },{ x:-60,y:20 },{ x:60,y:0 },{ x:60,y:-40 },{ x:60,y:40 }][pin]
  if (kind === 'LDO') return [{ x:-60,y:0 },{ x:0,y:60 },{ x:60,y:0 }][pin]
  if (kind === 'XFMR') return [{ x:-40,y:-40 },{ x:-40,y:40 },{ x:40,y:-40 },{ x:40,y:40 }][pin]
  return { x: pin === 0 ? -40 : 40, y: 0 }
}

// Original, deliberately generic teaching models. These are not vendor-qualified parts.
export const models = [
  { id: 'D_SI', kind: 'D', name: '硅二极管 · 通用', detail: '通用硅 PN 结，包含结电容和串联电阻。', spice: '.model D_SI D(IS=2n N=1.8 RS=0.5 CJO=4p TT=4n BV=100 IBV=1u)' },
  { id: 'D_SCHOTTKY', kind: 'D', name: '肖特基 · 通用', detail: '低正向压降通用模型；不是具体型号。', spice: '.model D_SCHOTTKY D(IS=10u N=1.05 RS=0.3 CJO=80p BV=40 IBV=1m)' },
  { id: 'D_ZENER', kind: 'D', name: '稳压二极管 · 5.1 V', detail: '5.1 V 反向击穿教学模型，需串联限流电阻。', spice: '.model D_ZENER D(IS=1n N=1.5 RS=2 BV=5.1 IBV=1m CJO=100p)' },
  { id: 'Q_NPN', kind: 'Q', name: 'NPN · 通用 β≈100', detail: '通用小信号 NPN，包含 Early 效应和结电容。', spice: '.model Q_NPN NPN(IS=1e-14 BF=100 VAF=100 CJE=5p CJC=3p TF=0.3n)' },
  { id: 'Q_PNP', kind: 'Q', name: 'PNP · 通用 β≈100', detail: '通用小信号 PNP，包含 Early 效应和结电容。', spice: '.model Q_PNP PNP(IS=1e-14 BF=100 VAF=100 CJE=5p CJC=3p TF=0.3n)' },
  { id: 'M_NMOS', kind: 'M', name: 'NMOS · 通用 Vth≈2 V', detail: 'Level 1 教学模型，W/L=100u/10u，体端内部接源极。', spice: '.model M_NMOS NMOS(LEVEL=1 VTO=2 KP=2m LAMBDA=0.02)' },
  { id: 'M_PMOS', kind: 'M', name: 'PMOS · 通用 Vth≈−2 V', detail: 'Level 1 教学模型，W/L=100u/10u，体端内部接源极。', spice: '.model M_PMOS PMOS(LEVEL=1 VTO=-2 KP=2m LAMBDA=0.02)' },
  { id: 'D_ZENER_3V3', kind: 'D', name: '稳压二极管 · 3.3 V', detail: '3.3 V 反向击穿教学模型；需要限流。', spice: '.model D_ZENER_3V3 D(IS=1n N=1.5 RS=3 BV=3.3 IBV=1m CJO=150p)' },
  { id: 'D_ZENER_12V', kind: 'D', name: '稳压二极管 · 12 V', detail: '12 V 钳位教学模型；需要限流。', spice: '.model D_ZENER_12V D(IS=1n N=1.5 RS=2 BV=12 IBV=1m CJO=60p)' },
  { id: 'D_FAST', kind: 'D', name: '快恢复二极管 · 通用', detail: '20 ns 渡越时间、低结电容的通用模型。', spice: '.model D_FAST D(IS=5n N=1.6 RS=0.2 CJO=8p TT=20n BV=200 IBV=10u)' },
  { id: 'D_LED_RED', kind: 'D', name: '红色 LED · 通用', detail: '20 mA、27℃ 下模型正向压降约 2.10 V；仅电气模型，不模拟发光或温升。', spice: '.model D_LED_RED D(IS=1e-18 N=2 RS=8 CJO=15p BV=5 IBV=10u)' },
  { id: 'D_LED_GREEN', kind: 'D', name: '绿色 LED · 通用', detail: '20 mA、27℃ 下模型正向压降约 2.50 V；需外部限流。', spice: '.model D_LED_GREEN D(IS=1e-21 N=2 RS=10 CJO=15p BV=5 IBV=10u)' },
  { id: 'D_LED_BLUE', kind: 'D', name: '蓝色 LED · 通用', detail: '20 mA、27℃ 下模型正向压降约 3.37 V；需外部限流，压降随电流变化。', spice: '.model D_LED_BLUE D(IS=1e-28 N=2 RS=12 CJO=12p BV=5 IBV=10u)' },
  { id: 'Q_NPN_HIGH_GAIN', kind: 'Q', name: 'NPN · 高增益 β≈250', detail: '高增益小信号教学模型；不对应厂商型号。', spice: '.model Q_NPN_HIGH_GAIN NPN(IS=1e-14 BF=250 VAF=100 CJE=8p CJC=4p TF=0.4n)' },
  { id: 'Q_PNP_HIGH_GAIN', kind: 'Q', name: 'PNP · 高增益 β≈250', detail: '高增益小信号教学模型；不对应厂商型号。', spice: '.model Q_PNP_HIGH_GAIN PNP(IS=1e-14 BF=250 VAF=100 CJE=8p CJC=4p TF=0.4n)' },
  { id: 'M_NMOS_LOGIC', kind: 'M', name: 'NMOS · 低阈值 1 V', detail: 'Level 1 低阈值教学模型，W/L=100u/10u；无功率器件热模型。', spice: '.model M_NMOS_LOGIC NMOS(LEVEL=1 VTO=1 KP=5m LAMBDA=0.025)' },
  { id: 'M_PMOS_LOGIC', kind: 'M', name: 'PMOS · 低阈值 −1 V', detail: 'Level 1 低阈值教学模型，W/L=100u/10u；无功率器件热模型。', spice: '.model M_PMOS_LOGIC PMOS(LEVEL=1 VTO=-1 KP=5m LAMBDA=0.025)' },
  { id:'Q_NPN_SWITCH',kind:'Q',name:'NPN · 快速开关',detail:'低存储电荷、含反向渡越时间的通用开关模型；非厂商型号。',spice:'.model Q_NPN_SWITCH NPN(IS=8f BF=150 VAF=80 IKF=.15 RB=20 RC=.2 RE=.1 CJE=8p CJC=3p TF=.15n TR=10n)' },
  { id:'Q_PNP_SWITCH',kind:'Q',name:'PNP · 快速开关',detail:'互补 PNP 开关教学模型，包含高注入增益下降和存储电荷。',spice:'.model Q_PNP_SWITCH PNP(IS=8f BF=150 VAF=80 IKF=.15 RB=20 RC=.2 RE=.1 CJE=8p CJC=3p TF=.15n TR=10n)' },
  { id:'Q_NPN_POWER',kind:'Q',name:'NPN · 功率级',detail:'含串联电阻、高注入与较大结电容的通用功率级；不模拟热效应/安全工作区。',spice:'.model Q_NPN_POWER NPN(IS=50f BF=60 VAF=60 IKF=2 RB=2 RC=.05 RE=.05 CJE=300p CJC=150p TF=20n TR=1u)' },
  { id:'Q_PNP_POWER',kind:'Q',name:'PNP · 功率级',detail:'互补 PNP 功率级，适合学习推挽输出；不模拟热效应/安全工作区。',spice:'.model Q_PNP_POWER PNP(IS=50f BF=60 VAF=60 IKF=2 RB=2 RC=.05 RE=.05 CJE=300p CJC=150p TF=20n TR=1u)' },
  { id:'M_NMOS_DEPLETION',kind:'M',name:'N 沟道 · 耗尽型',detail:'VGS=0 时导通，负栅压关断；Level 1、体端接源极的教学模型。',spice:'.model M_NMOS_DEPLETION NMOS(LEVEL=1 VTO=-2 KP=1m LAMBDA=.02)' },
  { id:'M_PMOS_DEPLETION',kind:'M',name:'P 沟道 · 耗尽型',detail:'VGS=0 时导通，正栅压关断；Level 1、体端接源极的教学模型。',spice:'.model M_PMOS_DEPLETION PMOS(LEVEL=1 VTO=2 KP=1m LAMBDA=.02)' },
  { id:'M_NMOS_POWER',kind:'M',technology:'VDMOS',name:'N 沟道 · 功率 VDMOS',detail:'含体二极管和非线性栅漏电容的通用 VDMOS；不含热模型或厂商额定保证。',spice:'.model M_NMOS_POWER VDMOS(nchan VTO=3 KP=4 RD=.03 RS=.02 RG=2 CGS=600p CGDMIN=20p CGDMAX=200p CJO=300p IS=1n RB=.1)' },
  { id:'M_PMOS_POWER',kind:'M',technology:'VDMOS',name:'P 沟道 · 功率 VDMOS',detail:'互补功率 VDMOS，含体二极管与栅电容；不含热模型。',spice:'.model M_PMOS_POWER VDMOS(pchan VTO=-3 KP=4 RD=.03 RS=.02 RG=2 CGS=600p CGDMIN=20p CGDMAX=200p CJO=300p IS=1n RB=.1)' },
  { id:'J_NJFET',kind:'J',name:'N 沟道 JFET · 通用',detail:'结型场效应管，栅极 PN 结反偏控制；VTO=-2 V，IDSS 约 4 mA。',spice:'.model J_NJFET NJF(VTO=-2 BETA=1m LAMBDA=.01 RD=2 RS=2 CGS=4p CGD=2p IS=1p)' },
  { id:'J_PJFET',kind:'J',name:'P 沟道 JFET · 通用',detail:'互补 P 沟道结型场效应管；外部 VGS 约 +2 V 截止（ngspice VTO=-2），IDSS 约 4 mA。',spice:'.model J_PJFET PJF(VTO=-2 BETA=1m LAMBDA=.01 RD=2 RS=2 CGS=4p CGD=2p IS=1p)' },
] as const
export function availableModels(kind:DeviceKind, imported:ImportedSpiceModel[] = []) {
  const builtIns = kind === 'OPA' || kind === 'CMP' ? opAmpModels : models
  return [...builtIns,...imported].filter(model=>model.kind===kind)
}
export const modelFor = (kind: DeviceKind, id: string, imported:ImportedSpiceModel[] = []) => availableModels(kind,imported).find(model=>model.id.toLowerCase()===id.toLowerCase())
