import { open, readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parseModelSymbol } from '../src/core/model-symbol'
import type { LtspiceAsy } from '../src/core/ltspice-symbol'
import type { LtspiceSymbolPrimitive, SymbolAnnotation } from '../src/core/ltspice-symbol'

export interface ConvertedOlbPart {
  id: string
  name: string
  modelId: string
  modelFile: string
  asy: LtspiceAsy
  physicalPinNumbers: string[]
  electricalOrderVerified: boolean
  pspiceTemplate: string
  issues: string[]
}

/** Resolve only explicit template terminal references through the original
 * pin names and package map. Physical package sorting is never a fallback. */
export function verifiedOlbTemplateOrder(template: string, pins: readonly {name?:unknown;number?:unknown;spiceOrder?:unknown}[], physicalPins = pins): boolean {
  const fields=template.replace(/\\n|\r?\n/g,' ').split(/\s+/).filter(field=>field&&field!=='+')
  const marker=fields.findIndex(field=>/^@(?:MODEL|VALUE)$/i.test(field))
  if(!/^X/i.test(fields[0]??'')||marker<2)return false
  const refs=fields.slice(1,marker).map(field=>field.match(/^%(?:\{([^}]+)\}|([^\s%{}]+))$/))
  if(refs.length!==pins.length||refs.some(ref=>!ref))return false
  const assigned=new Set<(typeof pins)[number]>()
  return refs.every((ref,index)=>{
    const token=ref![1]??ref![2]
    let matches=physicalPins.filter(pin=>pin.name===token)
    if(!matches.length)matches=physicalPins.filter(pin=>typeof pin.number==='string'&&pin.number.trim()===token)
    const pin=pins[index],number=typeof pin.number==='string'?pin.number.trim():''
    // An empty package number is missing metadata, not a shared terminal.
    // Explicit unique names still prove order; actual duplicate numbers do not.
    if(matches.length!==1||matches[0]!==pin||pin.spiceOrder!==index+1||assigned.has(pin))return false
    if(number&&physicalPins.filter(candidate=>typeof candidate.number==='string'&&candidate.number.trim()===number).length!==1)return false
    assigned.add(pin);return true
  })
}

function normalizedOlbSymbol(raw: Record<string, any>, pins: { number?: unknown; name?: unknown; x?: unknown; y?: unknown; bodyX?: unknown; bodyY?: unknown }[], fonts: unknown[]) {
  if (!Array.isArray(raw.geometry) || raw.geometry.length > 256) throw new Error('OLB 原始图元数超过支持上限')
  const physicalPins = raw.pins as typeof pins
  const xs = physicalPins.map(pin => Number(pin.x)), ys = physicalPins.map(pin => Number(pin.y))
  for (const item of raw.geometry) {
    if (!Array.isArray(item.coords) || !item.coords.every((coordinate: unknown) => typeof coordinate === 'number' && Number.isFinite(coordinate))) throw new Error('OLB 原始图元坐标不合法')
    xs.push(...item.coords.filter((_: number, index: number) => index % 2 === 0)); ys.push(...item.coords.filter((_: number, index: number) => index % 2 === 1))
  }
  const centerX = Math.round((Math.min(...xs) + Math.max(...xs)) / 20) * 10, centerY = Math.round((Math.min(...ys) + Math.max(...ys)) / 20) * 10
  const x = (value: number) => value - centerX, y = (value: number) => value - centerY
  const geometry: LtspiceSymbolPrimitive[] = [], annotations: SymbolAnnotation[] = []
  const fontStyle=(index:unknown):Partial<SymbolAnnotation>=>{
    if(!Number.isInteger(index)||Number(index)<1||Number(index)>fonts.length)return {}
    const font=fonts[Number(index)-1] as Record<string,unknown>
    if(!font||typeof font!=='object')return {}
    return {...(typeof font.family==='string'&&font.family.trim()?{fontFamily:font.family}:{}),...(Number.isInteger(font.weight)&&Number(font.weight)>=0&&Number(font.weight)<=1000?{fontWeight:Number(font.weight)}:{}),...(typeof font.italic==='boolean'?{italic:font.italic}:{}),...(typeof font.escapement==='number'&&Number.isFinite(font.escapement)&&Math.abs(font.escapement)<=3600?{rotation:-font.escapement/10}:{}),...(typeof font.height==='number'&&Math.abs(font.height)>=2&&Math.abs(font.height)<=48?{size:Math.abs(font.height)}:{})}
  }
  for (const item of raw.geometry) {
    const coords = item.coords as number[]
    const style=Object.fromEntries(['lineStyle','lineWidth','fillStyle'].filter(key=>item[key]!==undefined).map(key=>[key,item[key]]))
    if (item.type === 'text') {
      if (coords.length !== 2 || typeof item.text !== 'string') throw new Error('OLB 原始文字标记不合法')
      if (item.text.trim()) annotations.push({ text: item.text, x: x(coords[0]), y: y(coords[1]), size: 8, ...fontStyle(item.fontIndex) })
    } else if (item.type === 'polygon' || item.type === 'polyline') {
      if (coords.length < 4 || coords.length % 2 !== 0) throw new Error('OLB 原始折线坐标不合法')
      geometry.push({type:item.type,coords:coords.map((value,index)=>index%2===0?x(value):y(value)),...style})
    } else {
      const type = item.type === 'ellipse' ? 'circle' : item.type
      if (!['line', 'rectangle', 'circle', 'arc'].includes(type) || coords.length !== (type === 'arc' ? 8 : 4)) throw new Error(`原始 OLB 图元 ${item.type} 尚不兼容，不省略图形后冒充完整符号`)
      geometry.push({ type, coords: coords.map((value, index) => index % 2 === 0 ? x(value) : y(value)), ...style })
    }
  }
  // These bits are specified by StructGeneralProperties in the source parser:
  // bit 0=name visible, bit 1=name rotation, bit 2=number HIDDEN. Never add
  // labels that the original library intentionally suppresses (TL431/TI=44).
  const flags=raw.generalProperties?.visibilityFlags
  const display=Number.isInteger(flags)&&flags>=0&&flags<=63?{labelVisible:!!(flags&1),labelRotate:!!(flags&2),numberVisible:!(flags&4)}:{}
  // Keep missing package numbers out of the display schema; never substitute
  // their SPICE port positions. The raw conversion retains the original value.
  const numberDisplay=(pin:typeof pins[number])=>typeof pin.number==='string'&&pin.number.trim()?{number:pin.number}:{}
  const normalizedPins = pins.map((pin, index) => ({ index, label: pin.name || pin.number, ...numberDisplay(pin), x: x(Number(pin.x)), y: y(Number(pin.y)), ...(typeof pin.bodyX==='number'&&typeof pin.bodyY==='number'?{bodyX:x(pin.bodyX),bodyY:y(pin.bodyY)}:{}), ...display }))
  for(const property of raw.displayProperties??[]){
    // Only the documented value-only mode is emitted. Unknown modes stay in
    // the conversion record instead of acquiring a guessed visible label.
    if(!Array.isArray(property.displayModeBytes)||property.displayModeBytes[1]!==1)continue
    const key=String(property.property??'').toLowerCase()
    const binding=key==='part reference'?'reference':key==='value'?'value':undefined
    const value=binding==='reference'?raw.generalProperties?.referencePrefix:binding==='value'?raw.generalProperties?.partValue:raw.properties?.[property.property]
    if(typeof value!=='string'||!value.trim()||!Number.isFinite(property.x)||!Number.isFinite(property.y))continue
    annotations.push({text:value,x:x(property.x),y:y(property.y),size:8,...fontStyle(property.fontIndex),rotation:property.rotation,anchor:'start',...(binding?{binding}:{})})
  }
  for (let index = 0; index < pins.length; index++) {
    const pin = pins[index]
    if (typeof pin.bodyX === 'number' && typeof pin.bodyY === 'number') geometry.push({ type: 'line', coords: [normalizedPins[index].x, normalizedPins[index].y, x(pin.bodyX), y(pin.bodyY)] })
  }
  const unmodeledPins=physicalPins.filter(pin => !pins.includes(pin))
  for (const pin of unmodeledPins) {
    if (!Number.isFinite(pin.bodyX) || !Number.isFinite(pin.bodyY)) throw new Error('未建模物理引脚缺少原始图形坐标')
    geometry.push({ type: 'line', coords: [x(Number(pin.x)), y(Number(pin.y)), x(Number(pin.bodyX)), y(Number(pin.bodyY))] })
    // Physical terminals keep their original graphics; model coverage belongs
    // in diagnostics, never in added text over the manufacturer's drawing.
  }
  if (new Set(normalizedPins.map(pin => `${pin.x},${pin.y}`)).size !== normalizedPins.length) throw new Error('OLB 原始引脚位置重叠，不能导入')
  const physicalDisplay=unmodeledPins.map(pin=>({label:pin.name||pin.number,...numberDisplay(pin),x:x(Number(pin.x)),y:y(Number(pin.y)),bodyX:x(Number(pin.bodyX)),bodyY:y(Number(pin.bodyY)),...display}))
  return { version: 1, shape: 'ltspice', title: String(raw.name || raw.id).slice(0, 32), pins: normalizedPins, ...(physicalDisplay.length?{physicalPins:physicalDisplay}:{}), geometry, ...(annotations.length ? { annotations } : {}) }
}

/** Consume real parser output only when it identifies the exact original bytes.
 * The display shape uses the existing primitive schema, not an invented box. */
export async function readConvertedOlb(root: string, sourceKey: string, originalRelative: string, originalSha256: string): Promise<ConvertedOlbPart[] | undefined> {
  const base = resolve(root, 'converted-symbols', sourceKey), target = resolve(base, `${originalRelative}.json`), rel = relative(base, target)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('OLB 转换缓存路径超出来源目录')
  let input: unknown
  try { const info = await stat(target); if (info.size > 8 * 1024 * 1024) throw new Error('OLB 转换结果超过 8 MB'); input = JSON.parse(await readFile(target, 'utf8')) }
  catch (reason) { if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw reason }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('OLB 转换结果格式错误')
  const data = input as Record<string, unknown>
  if (data.version !== 1 || data.originalSha256 !== originalSha256 || !Array.isArray(data.parts) || data.parts.length > 10000) throw new Error('OLB 转换结果与原件 SHA256 或格式不一致，请重新转换')
  const result: ConvertedOlbPart[] = []
  for (const raw of data.parts) {
    try {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 180 || !Array.isArray(raw.pins) || !raw.pins.length || raw.pins.length > 32) continue
    const pins = raw.pins as { number?: unknown; name?: unknown; x?: unknown; y?: unknown; bodyX?: unknown; bodyY?: unknown; spiceOrder?: unknown }[]
    if (pins.some(pin => pin.number!==undefined&&typeof pin.number !== 'string' || typeof pin.name !== 'string' || !Number.isFinite(pin.x) || !Number.isFinite(pin.y))) continue
    const ordered = pins.filter(pin => pin.spiceOrder !== undefined).sort((a, b) => Number(a.spiceOrder) - Number(b.spiceOrder))
    const verified = ordered.length > 0 && !raw.unsupportedElectricalMapping && ordered.every((pin, index) => pin.spiceOrder === index + 1) && verifiedOlbTemplateOrder(String(raw.pspiceTemplate ?? ''), ordered, pins)
    // Without a template mapping, physical pin listing is for display only and
    // cannot become a .SUBCKT electrical instance.
    const displayPins = verified ? ordered : pins
    const suppliedSymbol = raw.modelSymbol && typeof raw.modelSymbol === 'object' ? { ...raw.modelSymbol, title: String(raw.modelSymbol.title || raw.name || raw.id).slice(0, 32) } : undefined
    if (verified && ordered.length < pins.length && suppliedSymbol) throw new Error('含未建模物理引脚的原件必须从完整原始图元生成符号')
    const symbol = parseModelSymbol(suppliedSymbol ?? normalizedOlbSymbol(raw, displayPins, Array.isArray(data.fonts)?data.fonts:[]), 'X', displayPins.map(pin => String(pin.name || pin.number)))
    if (symbol.shape !== 'ltspice' || !symbol.geometry?.length) continue
    if (verified && suppliedSymbol && symbol.pins.some((pin, index) => pin.x !== ordered[index].x || pin.y !== ordered[index].y || pin.label !== (ordered[index].name || ordered[index].number))) throw new Error(`OLB ${raw.id} 图形端子与已验证的电气引脚映射不一致`)
    const modelId = typeof raw.modelId === 'string' ? raw.modelId : '', modelFile = typeof raw.modelFile === 'string' ? raw.modelFile : ''
    const template = typeof raw.pspiceTemplate === 'string' ? raw.pspiceTemplate.trim() : ''
    const hasElectricalOrder = verified && !!modelId && verifiedOlbTemplateOrder(template,ordered,pins)
    const issues: string[] = Array.isArray(raw.issues) ? raw.issues.filter((item: unknown) => typeof item === 'string') : []
    const unmodeled = verified ? pins.filter(pin => !ordered.includes(pin)) : []
    if (unmodeled.length) issues.push(`原件的 ${unmodeled.map(pin => pin.name || pin.number).join('、')} 未列入 PSpiceTemplate，仅保留图形标记，不提供仿真连接端口`)
    result.push({ id: raw.id, name: typeof raw.name === 'string' ? raw.name : raw.id, modelId, modelFile, pspiceTemplate:template, asy: { symbol: symbol as LtspiceAsy['symbol'], value: modelId || raw.id, value2: '', spiceModel: modelId, modelFile, prefix: hasElectricalOrder ? 'X' : '', description: '由原始 OrCAD OLB 实际转换；图形与物理引脚保留原库特征' }, physicalPinNumbers: displayPins.map(pin => String(pin.number??'')), electricalOrderVerified: hasElectricalOrder, issues })
    } catch { /* Keep the complete original; one unsupported part cannot hide other decoded drawings. */ }
  }
  return result
}

export const ORCAD_CONVERSION_REFERENCES = [
  { label: 'OpenOrCadParser：原生 OrCAD 二进制解析库', url: 'https://github.com/Werni2A/OpenOrCadParser', detail: 'C++20 解析器；当前 CLI 的文本日志不是可导入符号，XML 导出器已弃用。工作台未捆绑该解析器或冒充转换成功。' },
  { label: 'pyorlib2ki：OrCAD XML 转 KiCad 符号', url: 'https://github.com/fjullien/pyorlib2ki', detail: '要求先用 OrCAD Capture File → Export → Library XML 导出；不能直接读取二进制 OLB。' },
] as const

/** Container detection only: an OLB is never treated as a .MODEL/.SUBCKT file,
 * and strings inside its binary container are not guessed into pins. */
export async function inspectOrcadLibrary(path: string): Promise<{ status: 'needs-conversion' | 'unsupported'; reason: string }> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(512), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead < 512 || !buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) return { status: 'unsupported', reason: '原始 OLB 文件已保留；不是受识别的 OrCAD CFBF 二进制容器，尚不能读取符号或引脚。' }
    const version = buffer.readUInt16LE(26), byteOrder = buffer.readUInt16LE(28), sectorShift = buffer.readUInt16LE(30)
    if (byteOrder !== 0xfffe || !((version === 3 && sectorShift === 9) || (version === 4 && sectorShift === 12))) return { status: 'unsupported', reason: '原始 OLB 文件已保留；CFBF 容器版本或扇区头不受支持，尚不能读取符号或引脚。' }
    return { status: 'needs-conversion', reason: '原始二进制 OLB 已下载并登记 SHA256；需要转换，二进制符号尚不兼容。OLB 不包含可直接执行的 SPICE 模型，未推断任何引脚。可使用 OrCAD 导出 Library XML，再由真实转换器转换。' }
  } finally { await handle.close() }
}
