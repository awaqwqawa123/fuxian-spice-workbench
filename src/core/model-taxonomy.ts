import type { ImportedSpiceModel } from './spice-models'
import { classifyModelFunctionalSymbol } from './model-functional-symbol'
import { functionalPinEvidenceForModel } from './model-pin-evidence'

/** Categories describe the model declaration or an explicit source annotation.
 * Electrical parameters alone do not establish a part's intended application. */
export const modelCategoryGroups = [
  { id: 'passive', label: '无源与磁性' },
  { id: 'diode', label: '二极管' },
  { id: 'opto', label: '光电器件' },
  { id: 'bjt', label: '双极晶体管' },
  { id: 'mos', label: 'MOSFET' },
  { id: 'jfet', label: 'JFET' },
  { id: 'analog', label: '放大器与基准' },
  { id: 'power', label: '电源管理' },
  { id: 'control', label: '开关与控制' },
  { id: 'interface', label: '数据转换与接口' },
  { id: 'subcircuit', label: '子电路' },
] as const

export const modelCategories = [
  { id: 'passive:resistor', group: 'passive', label: '电阻宏模型' },
  { id: 'passive:capacitor', group: 'passive', label: '电容宏模型' },
  { id: 'passive:inductor', group: 'passive', label: '电感 / 线圈宏模型' },
  { id: 'passive:ferrite', group: 'passive', label: '铁氧体磁珠模型' },
  { id: 'passive:choke', group: 'passive', label: '共模扼流圈模型' },
  { id: 'passive:transformer', group: 'passive', label: '变压器宏模型' },
  { id: 'diode:schottky', group: 'diode', label: '肖特基二极管' },
  { id: 'diode:zener', group: 'diode', label: '稳压二极管' },
  { id: 'diode:tvs', group: 'diode', label: '瞬态抑制二极管' },
  { id: 'diode:varactor', group: 'diode', label: '变容二极管' },
  { id: 'diode:fast', group: 'diode', label: '快恢复二极管' },
  { id: 'diode:rectifier', group: 'diode', label: '整流二极管' },
  { id: 'diode:switching', group: 'diode', label: '开关二极管' },
  { id: 'diode:silicon', group: 'diode', label: '硅二极管' },
  { id: 'diode:forward-fit', group: 'diode', label: '仅正向 DC 拟合' },
  { id: 'diode:other', group: 'diode', label: '其他二极管' },
  { id: 'opto:led', group: 'opto', label: '发光二极管 / LED 模型' },
  { id: 'opto:laser', group: 'opto', label: '垂直腔激光器模型' },
  { id: 'opto:photodiode', group: 'opto', label: '光电二极管模型' },
  { id: 'opto:optocoupler', group: 'opto', label: '光耦' },
  { id: 'bjt:npn', group: 'bjt', label: 'NPN 晶体管' },
  { id: 'bjt:pnp', group: 'bjt', label: 'PNP 晶体管' },
  { id: 'mos:n-vdmos', group: 'mos', label: 'N 沟道功率 VDMOS' },
  { id: 'mos:p-vdmos', group: 'mos', label: 'P 沟道功率 VDMOS' },
  { id: 'mos:n', group: 'mos', label: 'N 沟道 MOS' },
  { id: 'mos:p', group: 'mos', label: 'P 沟道 MOS' },
  { id: 'jfet:n', group: 'jfet', label: 'N 沟道 JFET' },
  { id: 'jfet:p', group: 'jfet', label: 'P 沟道 JFET' },
  { id: 'analog:opamp', group: 'analog', label: '运算放大器' },
  { id: 'analog:opamp-dual', group: 'analog', label: '双通道运放宏模型' },
  { id: 'analog:opamp-quad', group: 'analog', label: '四通道运放宏模型' },
  { id: 'analog:opamp-multi', group: 'analog', label: '多通道运放宏模型' },
  { id: 'analog:instrumentation', group: 'analog', label: '仪表放大器' },
  { id: 'analog:differential', group: 'analog', label: '全差分放大器' },
  { id: 'analog:comparator', group: 'analog', label: '比较器' },
  { id: 'analog:comparator-dual', group: 'analog', label: '双通道比较器宏模型' },
  { id: 'analog:comparator-quad', group: 'analog', label: '四通道比较器宏模型' },
  { id: 'analog:comparator-multi', group: 'analog', label: '多通道比较器宏模型' },
  { id: 'analog:reference', group: 'analog', label: '可调并联基准' },
  { id: 'analog:fixed-shunt-reference', group: 'analog', label: '固定并联电压基准' },
  { id: 'analog:series-reference', group: 'analog', label: '串联电压基准' },
  { id: 'analog:series-reference-adjustable', group: 'analog', label: '可调串联电压基准' },
  { id: 'power:regulator', group: 'power', label: '电压稳压器' },
  { id: 'power:ldo', group: 'power', label: '低压差线性稳压器' },
  { id: 'power:switching-regulator', group: 'power', label: '开关稳压器' },
  { id: 'power:gate-driver', group: 'power', label: '栅极驱动器' },
  { id: 'power:pwm-controller', group: 'power', label: 'PWM 与电源控制器' },
  { id: 'control:switch', group: 'control', label: '压控开关' },
  { id: 'control:timer', group: 'control', label: '定时器与振荡器宏模型' },
  { id: 'control:logic', group: 'control', label: '逻辑与时序宏模型' },
  { id: 'interface:adc', group: 'interface', label: '模数转换器' },
  { id: 'interface:dac', group: 'interface', label: '数模转换器' },
  { id: 'subcircuit:other', group: 'subcircuit', label: '未分类子电路' },
] as const

/** The wider component vocabulary includes catalog categories and built-in
 * schematic primitives. A missing category ID means zero verified catalog models. */
export const modelCategoryCoverage = [
  { group: '基础元件', items: [{ label: '电阻', builtIn: true }, { label: '电容', builtIn: true }, { label: '电感', builtIn: true }] },
  { group: '无源宏模型', items: [{ label: '电容', category: 'passive:capacitor' }, { label: '电感 / 线圈', category: 'passive:inductor' }, { label: '铁氧体磁珠', category: 'passive:ferrite' }, { label: '共模扼流圈', category: 'passive:choke' }, { label: '变压器', category: 'passive:transformer' }, { label: '晶体与谐振器' }, { label: '滤波器' }] },
  { group: '光电器件', items: [{ label: 'LED', category: 'opto:led' }, { label: '激光器', category: 'opto:laser' }, { label: '光电二极管', category: 'opto:photodiode' }, { label: '光耦' }] },
  { group: '其他半导体', items: [{ label: '晶闸管 / TRIAC' }, { label: 'IGBT' }] },
  { group: '模拟与接口', items: [{ label: '运算放大器' }, { label: '比较器' }, { label: '电压基准' }, { label: 'ADC / DAC' }, { label: '模拟开关' }] },
  { group: '电源管理', items: [{ label: '线性稳压器' }, { label: '开关稳压器' }, { label: '栅极驱动器' }, { label: '电池管理' }] },
  { group: '数字与逻辑', items: [{ label: '逻辑门' }, { label: '计时器' }, { label: '微控制器' }, { label: '存储器' }] },
  { group: '机电与连接', items: [{ label: '继电器' }, { label: '开关' }, { label: '连接器' }, { label: '电机' }] },
] as const

export type ModelCategoryId = typeof modelCategories[number]['id']
export type ModelCategoryGroupId = typeof modelCategoryGroups[number]['id']

const explicitDiodeTypes: Record<string, ModelCategoryId> = {
  schottky: 'diode:schottky',
  zener: 'diode:zener',
  tvs: 'diode:tvs',
  led: 'opto:led',
  photodiode: 'opto:photodiode',
  laser: 'opto:laser',
  varactor: 'diode:varactor',
  varicap: 'diode:varactor',
  fastrecovery: 'diode:fast',
  ultrafastrecovery: 'diode:fast',
  rectifier: 'diode:rectifier',
  switching: 'diode:switching',
  silicon: 'diode:silicon',
  forwarddcfit: 'diode:forward-fit',
}

// The source directory and these exact file stems were checked against their
// LTspice Contrib file headers. Do not infer function from a subcircuit ID.
const wurthInductorFiles = new Set('WE-ACHC WE-CAIR WE-HIDA_DUAL WE-KI WE-KI_HC WE-LHMD WE-MCI WE-MK WE-TCI'.split(' '))
const wurthFerriteFiles = new Set('WE-RFH WE-RFI'.split(' '))
const wurthChokeFiles = new Set('WE-CCMF WE-TPB WE-UCF'.split(' '))
const wurthTransformerFiles = new Set('WE-GDT WE-GDTI'.split(' '))
const wurthLedFiles = new Set('WL-SBCC WL-SBCD WL-SBCW WL-SBRW WL-SBSW WL-SBTW WL-SFCC WL-SFCD WL-SFRW WL-SFSW WL-SFTD WL-SFTW WL-SICW WL-SIMW WL-SIQW WL-SIRW WL-SISW WL-SITW WL-SMCC WL-SMCD WL-SMCW WL-SMDC WL-SMRD WL-SMRW WL-SMSW WL-SMTD WL-SMTW WL-SUMW WL-SUTW WL-SWTC WL-SWTP WL-TIRC WL-TIRW WL-TMRC WL-TMRW'.split(' '))

function subcircuitCategory(model: ImportedSpiceModel): ModelCategoryId {
  const sourceFunction=model.deviceInfo?.function??''
  if(model.pins.length===2&&/\b(?:bidirectional\s+(?:suppressor|supressor)|transient\s+(?:voltage\s+)?suppressor|TVS)\b/i.test(sourceFunction))return 'diode:tvs'
  const classification=classifyModelFunctionalSymbol(model),family=classification.family??model.symbol?.family
  const channels=new Set((classification.roles??[]).filter(role=>/^input-plus(?::[A-H1-8])?$/.test(role)).map(role=>role.split(':')[1]??'')).size
  if(family==='operational-amplifier'||family==='comparator'){
    const base=family==='operational-amplifier'?'analog:opamp':'analog:comparator'
    return channels===2?`${base}-dual`:channels===4?`${base}-quad`:channels>1?`${base}-multi`:base
  }
  if(family==='series-voltage-reference')return classification.roles?.includes('reference')?'analog:series-reference-adjustable':'analog:series-reference'
  const familyCategories: Readonly<Record<string, ModelCategoryId>> = {
    'operational-amplifier':'analog:opamp', comparator:'analog:comparator',
    'adjustable-shunt-reference':'analog:reference', 'voltage-regulator':'power:regulator',
    'fixed-shunt-reference':'analog:fixed-shunt-reference', 'series-voltage-reference':'analog:series-reference',
    'instrumentation-amplifier':'analog:instrumentation', 'fully-differential-amplifier':'analog:differential',
    'discrete-bjt':model.spice.match(/^\s*\.model\s+\S+\s+PNP\b/im)?'bjt:pnp':'bjt:npn',
    'discrete-mosfet':model.spice.match(/^\s*\.model\s+\S+\s+PMOS\b/im)?'mos:p':'mos:n',
    'discrete-jfet':model.spice.match(/^\s*\.model\s+\S+\s+PJF\b/im)?'jfet:p':'jfet:n',
    'phototransistor-optocoupler':'opto:optocoupler', transformer:'passive:transformer',
    'voltage-controlled-switch':'control:switch', resistor:'passive:resistor',
    capacitor:'passive:capacitor', inductor:'passive:inductor', 'diode-subcircuit':'diode:other',
    diode:'diode:other','zener-diode':'diode:zener','schottky-diode':'diode:schottky',led:'opto:led',photodiode:'opto:photodiode',varactor:'diode:varactor',
  }
  const functionText=`${model.metadata.type??''}\n${sourceFunction}\n${functionalPinEvidenceForModel(model)?.text??''}`
  if(family==='voltage-regulator'&&/\b(?:LDO|low[- ]dropout)\b/i.test(functionText))return 'power:ldo'
  const functionalCategory=family&&familyCategories[family]
  if(functionalCategory)return functionalCategory
  // These explicit source descriptions classify a macro's purpose without
  // claiming that its still-unmapped ports have a verified functional drawing.
  if(/\b(?:gate driver|MOSFET driver|IGBT driver)\b/i.test(functionText))return 'power:gate-driver'
  if(/\b(?:switching regulator|buck converter|boost converter|buck[- ]boost converter)\b/i.test(functionText))return 'power:switching-regulator'
  if(/\b(?:PWM controller|pulse[- ]width modulation controller)\b/i.test(functionText))return 'power:pwm-controller'
  if(/\b(?:analog[- ]to[- ]digital|ADC converter)\b/i.test(functionText))return 'interface:adc'
  if(/\b(?:digital[- ]to[- ]analog|DAC converter)\b/i.test(functionText))return 'interface:dac'
  if(/\b(?:timer|astable multivibrator)\b/i.test(functionText)||/^(?:NE|SE|LM|TLC|LMC)555(?:[A-Z0-9_.-]*)(?:\/[A-Z0-9_-]+)?$/i.test(model.id))return 'control:timer'
  if(/\b(?:logic gate|NAND gate|NOR gate|AND gate|OR gate|flip[- ]flop|digital counter)\b/i.test(functionText))return 'control:logic'
  const source = model.source.label.replaceAll('\\', '/')
  if (/^本机 LTspice \/ Contrib\/CHEMI-CON\/Capacitors\//i.test(source)) return 'passive:capacitor'
  if (/^本机 LTspice \/ Contrib\/CHEMI-CON\/Inductors\//i.test(source)) return 'passive:inductor'
  const wurth = source.match(/^本机 LTspice \/ Contrib\/Wurth\/([^/]+)\.lib$/i)?.[1].toUpperCase()
  if (!wurth) return 'subcircuit:other'
  if (wurthInductorFiles.has(wurth)) return 'passive:inductor'
  if (wurthFerriteFiles.has(wurth)) return 'passive:ferrite'
  if (wurthChokeFiles.has(wurth)) return 'passive:choke'
  if (wurthTransformerFiles.has(wurth)) return 'passive:transformer'
  if (wurthLedFiles.has(wurth)) return 'opto:led'
  return wurth === 'WL-VCSL' ? 'opto:laser' : 'subcircuit:other'
}

export function modelCategory(model: ImportedSpiceModel): ModelCategoryId {
  switch (model.type) {
    case 'D': {
      const annotation = (model.metadata.type ?? '').toLowerCase().replace(/[^a-z]/g, '')
      return explicitDiodeTypes[annotation] ?? 'diode:other'
    }
    case 'NPN': return 'bjt:npn'
    case 'PNP': return 'bjt:pnp'
    case 'NMOS': return model.technology === 'VDMOS' ? 'mos:n-vdmos' : 'mos:n'
    case 'PMOS': return model.technology === 'VDMOS' ? 'mos:p-vdmos' : 'mos:p'
    case 'NJF': return 'jfet:n'
    case 'PJF': return 'jfet:p'
    case 'SUBCKT': return subcircuitCategory(model)
  }
}

export function modelCategoryLabel(model: ImportedSpiceModel): string {
  return modelCategories.find(item => item.id === modelCategory(model))!.label
}

export function filterCatalogByCategory(models: ImportedSpiceModel[], category: string): ImportedSpiceModel[] {
  if (!category) return models
  return models.filter(model => {
    const leaf = modelCategory(model)
    return leaf === category || leaf.startsWith(`${category}:`)
  })
}

export function categoryCounts(models: ImportedSpiceModel[]): Map<string, number> {
  const counts = new Map<string, number>([['', models.length]])
  for (const model of models) {
    const leaf = modelCategory(model), group = leaf.split(':')[0]
    counts.set(leaf, (counts.get(leaf) ?? 0) + 1)
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  return counts
}
