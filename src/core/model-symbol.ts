import type { ImportedModelKind } from './spice-models'
import type { LtspiceSymbolPin, LtspiceSymbolPrimitive, SymbolAnnotation } from './ltspice-symbol'

export const functionalSymbolFamilyIds=['adjustable-shunt-reference','fixed-shunt-reference','series-voltage-reference','operational-amplifier','comparator','instrumentation-amplifier','fully-differential-amplifier','discrete-bjt','discrete-mosfet','discrete-jfet','diode-subcircuit','passive-subcircuit','resistor','capacitor','inductor','voltage-regulator','phototransistor-optocoupler','transformer','voltage-controlled-switch','diode','zener-diode','schottky-diode','led','photodiode','varactor'] as const
export type FunctionalSymbolFamilyId=typeof functionalSymbolFamilyIds[number]

/** Display metadata only. Electrical pin indices/anchors are never editable here. */
export interface ModelSymbol {
  version: 1
  shape: 'standard' | 'box' | 'ltspice'
  /** Drawing provenance, independent of the electrical model's manufacturer. */
  origin?: 'standard' | 'imported'
  source?: {label:string;sha256?:string}
  family?:FunctionalSymbolFamilyId
  title: string
  pins: (Omit<LtspiceSymbolPin,'x'|'y'> & {x?:number;y?:number})[]
  physicalPins?: Omit<LtspiceSymbolPin,'index'>[]
  geometry?:LtspiceSymbolPrimitive[]
  annotations?:SymbolAnnotation[]
}

export const modelPinLabels = (kind: ImportedModelKind,pins?:string[]) => kind === 'X' ? pins??[] : kind === 'D' ? ['A', 'K'] : kind === 'Q' ? ['C', 'B', 'E'] : ['D', 'G', 'S']
export function defaultModelSymbol(kind: ImportedModelKind, title: string, shape: ModelSymbol['shape'] = 'standard',pins?:string[]): ModelSymbol {
  return { version: 1, shape, title: title.slice(0, 32), pins: modelPinLabels(kind,pins).map((label, index) => ({ index, label })) }
}
export function parseModelSymbol(raw: unknown, kind: ImportedModelKind,modelPins?:string[]): ModelSymbol {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('器件符号格式错误')
  const symbol = raw as Partial<ModelSymbol>
  if (symbol.version !== 1 || !['standard', 'box', 'ltspice'].includes(symbol.shape!) || symbol.shape==='ltspice'&&kind!=='X') throw new Error('器件符号版本或形状不受支持')
  if(symbol.origin!==undefined&&!['standard','imported'].includes(symbol.origin))throw new Error('器件符号来源标记不受支持')
  if(symbol.family!==undefined&&!functionalSymbolFamilyIds.includes(symbol.family))throw new Error('器件符号功能家族不受支持')
  const text = (value: unknown, label: string, limit: number) => {
    if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}须为 1～${limit} 个可显示字符`)
    return value.trim()
  }
  const title = text(symbol.title, '符号名称', 32), expected = modelPinLabels(kind,modelPins)
  let source:ModelSymbol['source']
  if(symbol.source!==undefined){
    if(!symbol.source||typeof symbol.source!=='object'||Array.isArray(symbol.source)||Object.keys(symbol.source).some(key=>!['label','sha256'].includes(key)))throw new Error('原符号来源格式错误')
    const label=text(symbol.source.label,'原符号来源',300),sha256=symbol.source.sha256
    if(sha256!==undefined&&(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)))throw new Error('原符号校验值错误')
    source={label,...(sha256?{sha256}:{})}
  }
  if (!Array.isArray(symbol.pins) || symbol.pins.length !== expected.length) throw new Error(`${kind} 符号必须保留 ${expected.length} 个电气引脚`)
  const pins = symbol.pins.map((pin, index) => {
    if (!pin || pin.index !== index) throw new Error(`符号引脚 ${index + 1} 的电气序号不可重排`)
    const label=text(pin.label, `引脚 ${index + 1} 标签`, kind==='X'?40:12)
    if(symbol.shape==='ltspice'){
      if(!Number.isFinite(pin.x)||!Number.isFinite(pin.y)||Math.abs(pin.x!)>2560||Math.abs(pin.y!)>2560)throw new Error(`引脚 ${index+1} 的 LTspice 坐标无效`)
      for(const key of ['labelVisible','numberVisible','labelRotate'] as const)if(pin[key]!==undefined&&typeof pin[key]!=='boolean')throw new Error('原始引脚显隐标记无效')
      if((pin.bodyX===undefined)!==(pin.bodyY===undefined)||[pin.bodyX,pin.bodyY].some(value=>value!==undefined&&(!Number.isFinite(value)||Math.abs(value)>2560)))throw new Error('原始引脚体端坐标无效')
      const number=pin.number===undefined?undefined:text(pin.number,'原始引脚编号',40)
      return {index,label,x:pin.x,y:pin.y,...(number===undefined?{}:{number}),...Object.fromEntries(['labelVisible','numberVisible','bodyX','bodyY','labelRotate'].filter(key=>pin[key as keyof typeof pin]!==undefined).map(key=>[key,pin[key as keyof typeof pin]]))}
    }
    return { index, label }
  })
  const geometry=symbol.shape==='ltspice'?symbol.geometry:undefined
  const physicalPins=symbol.shape==='ltspice'?symbol.physicalPins:undefined
  if(physicalPins&&(!Array.isArray(physicalPins)||physicalPins.length>32))throw new Error('原始物理引脚列表无效')
  // Reuse the exact pin validator, but discard the temporary electrical index.
  // These display-only terminals never enter the SPICE pin array.
  const validatedPhysical=physicalPins?.length?parseModelSymbol({version:1,shape:'ltspice',title,pins:physicalPins.map((pin,index)=>({...pin,index})),geometry:[]},'X',physicalPins.map(pin=>pin.label)).pins.map(({index: _index,...pin})=>pin as Omit<LtspiceSymbolPin,'index'>):physicalPins
  if(symbol.shape==='ltspice'&&(!Array.isArray(geometry)||geometry.length>256||geometry.some(item=>!item||!['line','rectangle','circle','arc','polygon','polyline'].includes(item.type)||!Array.isArray(item.coords)||(['polygon','polyline'].includes(item.type)?item.coords.length<4||item.coords.length>8192||item.coords.length%2!==0:item.coords.length!==(item.type==='arc'?8:4))||item.coords.some(value=>!Number.isFinite(value)||Math.abs(value)>2560))))throw new Error('LTspice 符号图形无效')
  if(geometry?.some(item=>['lineStyle','lineWidth','fillStyle'].some(key=>{const value=item[key as keyof LtspiceSymbolPrimitive];return value!==undefined&&(typeof value!=='number'||!Number.isInteger(value)||value<0||value>65535)})))throw new Error('原始图元样式无效')
  const annotations=symbol.shape==='ltspice'?symbol.annotations:undefined
  if(annotations&&(!Array.isArray(annotations)||annotations.length>128||annotations.some(item=>!item||typeof item.text!=='string'||!item.text.trim()||item.text.length>180||/[\x00-\x1f\x7f]/.test(item.text)||![item.x,item.y,item.size].every(Number.isFinite)||Math.abs(item.x)>2560||Math.abs(item.y)>2560||item.size<2||item.size>48)))throw new Error('原始符号文字标记无效')
  if(annotations?.some(item=>item.fontFamily!==undefined&&(typeof item.fontFamily!=='string'||!item.fontFamily.trim()||item.fontFamily.length>80||/[\x00-\x1f\x7f]/.test(item.fontFamily))||item.fontWeight!==undefined&&(!Number.isInteger(item.fontWeight)||item.fontWeight<0||item.fontWeight>1000)||item.italic!==undefined&&typeof item.italic!=='boolean'||item.rotation!==undefined&&(!Number.isFinite(item.rotation)||Math.abs(item.rotation)>360)||item.anchor!==undefined&&!['start','middle','end'].includes(item.anchor)||item.binding!==undefined&&!['reference','value'].includes(item.binding)))throw new Error('原始文字字体或位置样式无效')
  return { version: 1, shape: symbol.shape!, ...(symbol.origin?{origin:symbol.origin}:{}), ...(source?{source}:{}), ...(symbol.family?{family:symbol.family}:{}), title, pins,...(validatedPhysical?{physicalPins:validatedPhysical}:{}),...(geometry?{geometry:geometry.map(item=>({type:item.type,coords:[...item.coords],...Object.fromEntries(['lineStyle','lineWidth','fillStyle'].filter(key=>item[key as keyof LtspiceSymbolPrimitive]!==undefined).map(key=>[key,item[key as keyof LtspiceSymbolPrimitive]]))}))}:{}),...(annotations?{annotations:annotations.map(item=>({...item}))}:{}) }
}

export function modelSymbolOriginLabel(symbol?:ModelSymbol):string {
  if(symbol?.shape==='ltspice')return symbol.origin==='standard'?'标准器件符号':'导入原始符号'
  return symbol?.shape==='box'?(symbol.origin==='standard'?'连接示意 · 保留已有接线':'引脚连接示意'):'标准器件符号'
}
